#!/usr/bin/env node
// The MCP broker: one process, N player characters, arbitrary agents driving them.
//
//   node tools/m59-broker.mjs                    MCP over stdio
//   node tools/m59-broker.mjs --http 8899        MCP over HTTP, many clients
//   node tools/m59-broker.mjs --selftest         drive it without an agent
//
// Agents and humans are peers. A character here holds a real session on the same
// port meridian.exe uses, so the server validates its actions, `who` lists it
// beside the humans, and nothing about it is privileged. The admin socket is not
// used at all.
//
// What the broker adds beyond a thin protocol wrapper is PACING, and that is not
// a nicety. Three separate server-side rules punish a client that acts as fast as
// it can think, and all three fail silently:
//
//   * INCOMING_PACKET_THROTTLE = 5 (user.kod:50). More than five packets in one
//     second and the server marks the session a spammer and DISCARDS attack,
//     cast, use, look, get, activate, apply, offer, rest and stand for the rest
//     of that second. No error is sent. An agent that fires ten requests gets one
//     answer and nine silences.
//   * IsOkayAttackTime (player.kod:5305). One attack or cast per second, dropped
//     silently over that.
//   * MOVEMENT_COUNT_THRESHOLD = 2 with a one-per-second decay (user.kod:61).
//     Move faster and the server logs the session as a possible speedhacker.
//
// So every outbound request goes through a queue that respects all three. An
// agent calling `attack` ten times in a row gets ten attacks a second apart
// rather than one attack and nine discards. Tools return only after their request
// has actually gone out, which turns an invisible failure into visible latency —
// the trade this whole file exists to make.

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { M59Client, KOD_FINENESS } from './m59-client.mjs';
import { loadResources } from './m59-rsc.mjs';
import { describeObject, affordances, OF } from './m59-parse.mjs';
import { World, sharedWorldMap } from './m59-world.mjs';
import { loadMap, resolveRoom, forgetInferredExit } from './m59-map.mjs';
import { loadMerchants } from './m59-merchants.mjs';
import { loadSpells, karmaAllows, requiredKarma, SCHOOLS } from './m59-spells.mjs';
import * as skills from './m59-skills.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { autopilotFor, dropAutopilot, allAutopilots, autopilotIfAny, MODES, STRATEGIES } from './m59-autopilot.mjs';
import { dropChatter, chatterIfAny, chatterFor } from './m59-chatter.mjs';
import { loadSpawns, huntingGrounds, roomThreats, preyFor } from './m59-spawns.mjs';
import { safeSpots, safeSpotBook } from './m59-safespots.mjs';
import { planRuns, planProvisioning } from './m59-lootrun.mjs';
import { planCharacter, STAT_ORDER, STAT_PRESETS } from './m59-newchar.mjs';
import { recordSample, recordEvent, summarise as ledgerSummary, readLedger, deathReport, timeReport } from './m59-ledger.mjs';
import { renderDashboard } from './m59-dashboard.mjs';
import { renderHero, startScript } from './m59-hero-page.mjs';
import { inboxIfAny, dropInbox } from './m59-inbox.mjs';
import { chatTools } from './m59-chat-tools.mjs';

const HOST = process.env.M59_HOST || '127.0.0.1';
const PORT = Number(process.env.M59_PORT || 5959);

// The global throttle across every packet kind. It was four a second, which quietly
// capped movement no matter what MOVE_INTERVAL_MS said — four packets a second is four
// squares a second at the very best, and every read, turn and attack competes for the
// same budget. The per-kind gaps are what actually enforce the server's rules
// (ATTACK_INTERVAL_MS for IsOkayAttackTime, and moveSpeed() for the run threshold), so
// this only needs to be loose enough not to be the binding constraint.
const PACKETS_PER_SECOND = Number(process.env.M59_RATE || 12);
const ATTACK_INTERVAL_MS = 1050;     // IsOkayAttackTime, plus a little

// WALKING AT ONE SQUARE A SECOND WAS COSTING US CHARACTERS.
//
// This was 1050ms — one move packet per second — and it was never a server rule. It
// was caution, and the caution was aimed at the wrong thing. What the kod actually
// does with movement (docs/m59-coordination-research.md, user.kod:2941-2971):
//
//   * every BP_REQ_MOVE bumps an anti-speedhack counter that decays one per second,
//     and exceeding MOVEMENT_COUNT_THRESHOLD **only writes a log line**. It does not
//     block the move, reject the packet, or snap you back.
//   * there is NO geometry or distance validation on a user move at all. UserMove
//     calls Room.SomethingMoved directly and ReqSomethingMoved is bypassed for users
//     — room.kod's own comment is "already been checked by client (HAHA!)".
//   * the ONE thing that does snap you back is speed above USER_WALKING_SPEED with
//     vigor under the run threshold, which moveSpeed() already guards.
//
// So the rate was self-imposed, and it was expensive: crossing a monster field at a
// square a second means standing next to every creature on the way for a full second
// each, taking a swing from each one, which is where nearly all of our travel deaths
// come from. A real player crosses the same ground several times faster and is hit a
// fraction as often.
//
// 250ms is four squares a second — still a walk rather than a teleport, still one
// square per packet with the server tracking every step, but fast enough that walking
// past something is walking past it rather than standing beside it.
const MOVE_INTERVAL_MS = Number(process.env.M59_MOVE_INTERVAL_MS || 250);

// user.kod:46. At or below this you are walking; above it you are running, which
// needs vigor >= 10 and costs exertion quadratically in the speed.
const WALK_SPEED = 18;
const RUN_SPEED  = Number(process.env.M59_RUN_SPEED || 24);
const RUN_VIGOR_FLOOR = 25;          // well clear of the server's threshold of 10

// ---------------------------------------------------------------- pacing

// A serial queue per session. Each entry declares how long the session must be
// idle for THAT KIND of request before it may go out, so attacks pace themselves
// against attacks without slowing down a `look`.
class Pacer {
  constructor(rate = PACKETS_PER_SECOND) {
    this.minGapMs = 1000 / rate;
    this.q = [];
    this.running = false;
    this.lastSent = 0;
    this.lastByKind = new Map();
  }

  // kind: 'attack' | 'move' | other. minGapForKind is the server rule; minGapMs
  // is the global throttle. Both must be satisfied.
  submit(kind, fn, minGapForKind = 0) {
    return new Promise((resolve, reject) => {
      this.q.push({ kind, fn, minGapForKind, resolve, reject });
      this.pump();
    });
  }

  get depth() { return this.q.length; }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length) {
        const job = this.q.shift();
        const now = Date.now();
        const waitGlobal = Math.max(0, this.lastSent + this.minGapMs - now);
        const lastKind = this.lastByKind.get(job.kind) || 0;
        const waitKind = Math.max(0, lastKind + job.minGapForKind - now);
        const wait = Math.max(waitGlobal, waitKind);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastSent = Date.now();
        this.lastByKind.set(job.kind, this.lastSent);
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      }
    } finally { this.running = false; }
  }
}

// ---------------------------------------------------------------- sessions

const resources = loadResources();      // one table, shared by every character

// The room graph and the baked walkability geometry, loaded once for every session.
// Absent, the broker still plays — it just cannot plan, so movement degrades to
// stepping and checking. Missing it is a degraded mode, not a failure.
const worldMap = sharedWorldMap(loadMap);

// Who buys what, who sells what, who teaches what, and where they stand. Built once
// from the running world plus the source tree — a merchant's buying rule is a kod
// METHOD, not data, so the catalogue carries the rule verbatim rather than pretending
// to have reduced it to a flag.
let merchantCatalogue = null;
try { merchantCatalogue = loadMerchants(); } catch { merchantCatalogue = null; }

// What every spell costs and requires. None of it is on the wire — BP_SPELLS carries
// only a name, a target count and a school — so this is compiled from kod.
let spellCatalogue = null;
try { spellCatalogue = loadSpells(); } catch { spellCatalogue = null; }
if (!worldMap) {
  console.error('WARNING: substrate/m59-map.json not found — no map, no geometry, no travel.');
  console.error('  build it with: node tools/m59-map.mjs build');
}

const sessions = new Map();             // agent name -> Session

// --------------------------------------------------------------- recording
//
// A FLIGHT RECORDER PER CHARACTER, DELIBERATELY NOT SHOWN TO THE AGENT.
//
// Almost everything that went wrong with a keeper was invisible while it was
// happening and unreconstructable afterwards: it hit a carry cap and spun, it
// wandered into a town, it lost its object id to a save-game renumber and read
// that as death. In each case the evidence — the raw event stream and the exact
// order of calls — existed for a moment and was gone.
//
// So every session writes everything it sees to disk: each perceived event, each
// tool call and how long it took. None of it goes into a tool reply, because it is
// enormous and an agent has no use for the ninety stat updates behind one fight.
// It is for the human, or for a later model, working out why a character has been
// standing still for twenty minutes.
//
// Rotated by wall clock and capped, so an overnight fleet does not fill a disk.
const RECORD_DIR = process.env.M59_RECORD_DIR ||
  new URL('../substrate/recordings/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const RECORD_WINDOW_MS = Number(process.env.M59_RECORD_WINDOW_MS || 120_000);   // 2 minutes
const RECORD_KEEP = Number(process.env.M59_RECORD_KEEP || 15);                  // ~30 minutes

// ---------------------------------------------------------------- fleet state
// A broker restart used to cost the entire fleet: every session is a live socket,
// so stopping the process logged twenty-five characters out, and each one then had
// to be walked back to its hunting ground by hand — minutes of real walking per
// character, for a one-line code change. That made the broker effectively
// un-redeployable while anything was running, which is backwards.
//
// So the two facts needed to rebuild a session — how to log in, and what the keeper
// was told to do — are written to disk as they are set, and replayed on boot. The
// characters keep playing across a restart; only the process is new.
// WHICH FLEET THIS BROKER HOLDS.
//
// A roster is per-server, not per-machine. Characters on one server share nothing
// with characters on another — not accounts, not object ids, not the world — so
// putting two servers' characters in one file gives you a roster whose entries are
// only meaningful next to a host you have to remember separately.
//
// That was survivable while there was one server. It stops being survivable the
// moment M59_HOST is repointed: every entry that predates the change has no host of
// its own, silently inherits the new one, and the broker spends its boot trying
// yesterday's passwords against today's server. Twenty failed logins look exactly
// like a server that is refusing connections.
//
// So each fleet gets its own file, and the file *is* the fleet's identity. Naming
// one selects it; naming none keeps the original path, so an existing checkout that
// has never heard of fleets behaves exactly as it did.
//
//   node tools/m59-broker.mjs --fleet prod        substrate/fleets/prod.json
//   M59_FLEET=prod node tools/m59-broker.mjs      the same
//   node tools/m59-broker.mjs                     substrate/fleet-state.json
//
// The lock is derived from this path, so two brokers on two fleets no longer
// contend — which is the point. Two brokers on the SAME fleet still cannot, and
// that check is unchanged.
const { fleet: FLEET, stateFile: STATE_FILE } = (() => {
  try { return resolveFleet(); }
  catch (e) { console.error(`[state] ${e.message}`); process.exit(2); }
})();

// Which checkout this broker belongs to. Reported by /health so a tool can tell
// one broker from another BEFORE acting on it. More than one checkout can be
// running at once, and "a node process with m59-broker in its command line" is
// not an identity — treating it as one let a shutdown in one repository log out
// another repository's whole fleet.
const BROKER_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Which rooms generate which creatures. Built by: node tools/m59-spawns.mjs
// The Grand Museum of Raza. The map labels it "Tutorial Exit Inside"; the portal is
// at (11,2) and takes two touches. This is THE way out of the newbie zone.
const MUSEUM_ROOM = Number(process.env.M59_MUSEUM_ROOM || 1018);

// The two items in the game whose IsCursed returns TRUE. See lootFloor.
const CURSED_ITEMS = /amulet of shadows|ring of lethargy/i;

const SPAWN_FILE = process.env.M59_SPAWN_FILE ||
  new URL('../substrate/m59-spawns.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Which squares have actually held under attack, learned by standing in them. Shared
// with the keeper, which is what writes it — one character's experiment is every
// character's knowledge.
const SAFESPOT_FILE = process.env.M59_SAFESPOT_FILE ||
  new URL('../substrate/m59-safespots.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const fleetState = new Map();   // agent -> { credentials, autopilot }

// KEEP THE LAST VERSION THAT HAD MORE IN IT.
//
// This file is the ONLY record of how to log the fleet back in — the passwords live
// nowhere else this side of the server's account store — so a write that shrinks it is
// the one write worth being afraid of. Logging every character off to restart them on
// new code empties it completely, and the next thing you discover is that "log them
// all back in" is not a thing you can do any more.
//
// So: any write that drops agents copies the old file aside first. Growing writes and
// same-size writes leave the backup alone, which means the backup is always the last
// state that knew about more characters than the current one does.
function saveFleetState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const next = Object.fromEntries(fleetState);
    try {
      const now = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (Object.keys(now).length > Object.keys(next).length) {
        writeFileSync(STATE_FILE + '.prev', JSON.stringify(now, null, 2));
        console.error(`[state] roster shrank ${Object.keys(now).length} -> ` +
                      `${Object.keys(next).length}; previous kept at ${STATE_FILE}.prev`);
      }
    } catch { /* no current file, or unreadable — nothing worth preserving */ }
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch (e) { console.error(`[state] could not save: ${e.message}`); }
}

function rememberJoin(agent, credentials) {
  fleetState.set(agent, { ...(fleetState.get(agent) || {}), credentials });
  saveFleetState();
}
function rememberAutopilot(agent, config) {
  const e = fleetState.get(agent);
  if (!e) return;                       // never joined through us; nothing to rebuild
  e.autopilot = config;
  saveFleetState();
}
function forgetAgent(agent) { fleetState.delete(agent); saveFleetState(); }

// MAKE EVERY CHARACTER LISTEN, from the moment it is in game.
//
// The conversational machinery was all present and none of it was switched on. The
// tools were registered, the Chatter class was complete, the inbox was ready — and
// nothing ever called chatterFor, so every character in the fleet was deaf. `fleet`
// dutifully reported `listening: false` for all twenty-five and it read as a field
// rather than a fault.
//
// Attaching on join rather than by hand is the fix: a character that is in the world
// should be able to hear, and it should still be able to hear after a broker restart
// without anyone remembering to turn it back on. Peers are not answered by default —
// two auto-responders greeting each other do so for ever, and the server does not
// rate limit speech.
function listen(name, s) {
  try {
    const ch = chatterFor(s, {
      // Only the fields DEFAULT_CHATTER_POLICY actually defines — passing invented
      // ones would be silently ignored and would read as configuration that exists.
      policy: { ack: true, smallTalk: true, faceSpeaker: true, escalate: true },
      hooks: {
        isPeer: (id) => [...sessions.values()]
          .some(o => o !== s && o.client?.selfId === id),
        autopilotStatus: () => autopilotIfAny(name)?.status() ?? null,
        // Speech from a character the operator is currently playing is direction, not
        // conversation. Returns true when it consumed the message.
        operatorInstruction: (said) => routeOperatorInstruction(name, said),
      },
    });
    ch.reattach();
  } catch (e) { console.error(`[chat] ${name} could not listen: ${e.message}`); }
}

// Sample the whole fleet into the long ledger on a timer. Five minutes is chosen so
// that a level gain — which takes many minutes at these levels — cannot slip between
// two samples unseen, while a day of it stays a file you can read.
const LEDGER_INTERVAL_MS = Number(process.env.M59_LEDGER_INTERVAL_MS || 5 * 60 * 1000);
function startLedger() {
  const tick = async () => {
    try {
      const tool = TOOLS.find(t => t.name === 'fleet');
      const out = await tool.run({});
      recordSample(out.fleet || []);
    } catch (e) { console.error('[ledger] sample failed: ' + e.message); }
  };
  // Not immediately: at boot the sessions are still logging themselves back in, so
  // an instant first sample records an empty fleet and the ledger's very first line
  // says everyone vanished. Give resumeFleet time to finish.
  const first = setTimeout(tick, 90_000);
  first.unref?.();
  const t = setInterval(tick, LEDGER_INTERVAL_MS);
  t.unref?.();
}

// Rejoining is a login plus a walk, so it is slow and it can fail; nothing waits on
// it. Characters come back one at a time and the fleet fills in over a minute or so.
// ONLY ONE BROKER MAY OWN THE FLEET.
//
// Every broker that starts resumes all twenty-five characters, and nothing stopped two
// of them doing it at once — the one this project's .mcp.json spawns for the MCP
// client, and any run by hand for the dashboard. The game server allows one session
// per account, so the second login kicks the first, and then both brokers keep
// reconnecting over the top of each other.
//
// It is quiet, and it is expensive. Every keeper sees its character teleported and
// half-dead for reasons its own journal cannot explain; twenty-five characters
// accumulate deaths nobody caused. This fleet ran at 273 deaths against 8 kills with
// four brokers up, which read as "the survival logic is broken" for hours.
//
// A pid in a file is enough to stop it. Not a real lock — a real lock would have to
// survive a kill -9, and this does not need to: if the pid is gone the fleet is
// unowned and the next broker takes it.
const LOCK_FILE = STATE_FILE + '.lock';

function fleetOwnedByAnotherProcess() {
  let held;
  try { held = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
  if (!held?.pid || held.pid === process.pid) return null;
  try { process.kill(held.pid, 0); } catch { return null; }   // stale: owner is gone
  return held;
}

function claimFleet() {
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const drop = () => { try { unlinkSync(LOCK_FILE); } catch { /* already gone */ } };
    process.on('exit', drop);
    process.on('SIGINT', () => { drop(); process.exit(0); });
    process.on('SIGTERM', () => { drop(); process.exit(0); });
  } catch (e) { console.error(`[state] could not claim the fleet: ${e.message}`); }
}

async function resumeFleet() {
  const owner = fleetOwnedByAnotherProcess();
  if (owner) {
    console.error(
      `[state] NOT resuming: process ${owner.pid} already has the fleet logged in ` +
      `(claimed ${Math.round((Date.now() - owner.at) / 1000)}s ago).\n` +
      `[state] Two brokers sharing one fleet log each other out repeatedly and the ` +
      `damage shows up as unexplained deaths. This broker will serve tools against ` +
      `whatever you join by hand.\n` +
      `[state] If ${owner.pid} is not really running the fleet, delete ${LOCK_FILE}.`);
    return;
  }
  let saved;
  try { saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return; }
  const names = Object.keys(saved);
  if (!names.length) return;
  claimFleet();
  console.error(`[state] resuming ${names.length} session(s) from ${STATE_FILE}`);
  for (const agent of names) {
    const { credentials, autopilot } = saved[agent] || {};
    if (!credentials) continue;
    try {
      const s = session(agent);
      await s.join(credentials);
      listen(agent, s);
      fleetState.set(agent, { credentials, autopilot });
      let keeper = null;
      if (autopilot) {
        // autopilotFor takes the SESSION, not the agent name — it keys off
        // session.name itself. Passing the name here silently registers a keeper
        // under `undefined` and leaves the real character with none, which is
        // indistinguishable from a healthy resume until you notice that nothing has
        // killed anything for half an hour.
        const p = autopilotFor(s);
        p.mode = autopilot.mode || p.mode;
        Object.assign(p.policy, autopilot.policy || {});
        p.start();
        keeper = p.running ? `${p.mode}/${p.policy.hunt || '-'}` : 'FAILED TO START';
      }
      console.error(`[state] resumed ${agent} (${credentials.character || '?'})` +
                    (keeper ? ` keeper=${keeper}` : ' no keeper'));
    } catch (e) { console.error(`[state] ${agent} did not resume: ${e.message}`); }
  }
  saveFleetState();
}

// ------------------------------------------------------------------ reconnecting

// PUT BACK WHAT FELL OUT, WITHOUT PUTTING BACK WHAT WAS TAKEN OUT.
//
// The broker resumed the fleet at boot and then never looked again. Twenty-one
// characters dropped out of the game and sat logged out for twenty-five minutes while
// this process reported itself healthy, holding twenty-one sessions, every one of them
// answering "not in game". The server was fine throughout and the credentials were on
// disk the whole time. Nothing was watching.
//
// Three things this must not do:
//
//   * Undo a deliberate `leave`. Without `forget` that means "logged out until a
//     restart", which is documented and is a thing people rely on. Agents left on
//     purpose are remembered here and skipped until something joins them again.
//   * Fight a human. Meridian allows ONE connection per character, so a person opening
//     a click-to-play shortcut bumps the broker off — and rejoining would bump them
//     straight back, forever, from a process with no hands. A rejoin that drops again
//     within CONTENTION_MS is read as exactly that and backs off hard.
//   * Hammer a server that is refusing us. Every failure doubles the wait.
//
// This is a SHARED server. Backoff is not politeness here, it is the difference
// between a reconnect and a login flood.
const REJOIN = process.env.M59_REJOIN !== '0' && !process.argv.includes('--no-rejoin');
const RECONCILE_MS = Number(process.env.M59_RECONCILE_MS || 45_000);
const CONTENTION_MS = 90_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

const leftOnPurpose = new Set();          // agent -> do not rejoin until asked
const rejoinState = new Map();            // agent -> { failures, nextTryAt, lastJoinAt }

function backoffFor(failures) {
  return Math.min(BACKOFF_BASE_MS * (2 ** Math.max(0, failures - 1)), BACKOFF_MAX_MS);
}

async function reconcileFleet() {
  // Someone else owns this roster. Rejoining its characters would be the two-brokers
  // failure the lock exists to prevent, arriving one character at a time.
  if (fleetOwnedByAnotherProcess()) return;

  for (const [agent, entry] of [...fleetState]) {
    const credentials = entry?.credentials;
    if (!credentials) continue;
    if (leftOnPurpose.has(agent)) continue;
    // Being played by a person. Not missing — occupied. Rejoining would take the
    // character out from under a hand that is on the keys, and the login would bump
    // them straight out of the world.
    if (pilotOf(agent)) continue;

    const existing = sessions.get(agent);
    if (existing?.live) {
      // Healthy. Clear the backoff, remember WHEN it came back so a drop shortly after
      // a rejoin can be told apart from a drop out of the blue, and — the important
      // one — remember whether its keeper was actually running.
      //
      // WHAT WAS RUNNING WHEN IT DROPPED, NOT WHAT THE ROSTER REMEMBERS. Stopping a
      // keeper does not clear the orders saved on disk, so restoring them blindly
      // resurrects work somebody deliberately stopped. Fozzie was walked out of the
      // newbie zone with his keeper switched off; the roster still said "farm mummy",
      // and a rejoin would have set him hunting mummies in an inn that has none.
      const st = rejoinState.get(agent) || { failures: 0, nextTryAt: 0, lastJoinAt: null };
      if (!st.lastJoinAt) st.lastJoinAt = Date.now();
      st.keeperWasRunning = !!autopilotIfAny(agent)?.running;
      rejoinState.set(agent, st);
      continue;
    }

    const st = rejoinState.get(agent) || { failures: 0, nextTryAt: 0, lastJoinAt: null };
    if (Date.now() < st.nextTryAt) continue;

    // Dropped again almost immediately after we put it back: something else wants this
    // character. Treat it as a failure so the wait grows, rather than as a fresh
    // problem to solve at full speed.
    const contended = st.lastJoinAt && (Date.now() - st.lastJoinAt) < CONTENTION_MS;
    if (contended) {
      st.failures++;
      st.nextTryAt = Date.now() + backoffFor(st.failures);
      st.lastJoinAt = null;
      rejoinState.set(agent, st);
      console.error(`[rejoin] ${agent} dropped again ${Math.round((Date.now() - (st.lastJoinAt || Date.now())) / 1000)}s ` +
                    `after rejoining — something else may be holding this character; ` +
                    `waiting ${Math.round(backoffFor(st.failures) / 1000)}s`);
      continue;
    }

    try {
      const s = session(agent);
      await s.join(credentials);
      listen(agent, s);
      let keeper = null;
      // `undefined` means we never saw this session live in this process — a drop
      // during boot, say — and the roster is then the best evidence we have, which is
      // the resume behaviour. `false` means we watched its keeper be stopped, and that
      // is a decision to respect rather than an outage to repair.
      const restoreKeeper = entry.autopilot && st.keeperWasRunning !== false;
      if (restoreKeeper) {
        const p = autopilotFor(s);
        p.mode = entry.autopilot.mode || p.mode;
        Object.assign(p.policy, entry.autopilot.policy || {});
        p.start();
        keeper = p.running ? `${p.mode}/${p.policy.hunt || '-'}` : 'FAILED TO START';
      } else if (entry.autopilot) {
        keeper = 'left stopped — it was not running when it dropped';
      }
      rejoinState.set(agent, { failures: 0, nextTryAt: 0, lastJoinAt: Date.now(),
                               keeperWasRunning: st.keeperWasRunning });
      console.error(`[rejoin] ${agent} (${credentials.character || '?'}) is back` +
                    (keeper ? ` keeper=${keeper}` : ' no keeper'));
    } catch (e) {
      st.failures++;
      st.nextTryAt = Date.now() + backoffFor(st.failures);
      st.lastJoinAt = null;
      rejoinState.set(agent, st);
      console.error(`[rejoin] ${agent} failed (${st.failures}): ${e.message} — ` +
                    `next try in ${Math.round(backoffFor(st.failures) / 1000)}s`);
    }
  }
}

// ------------------------------------------------------------------ piloting

// WHEN THE OPERATOR IS PLAYING ONE OF THEM HIMSELF.
//
// Meridian allows ONE connection per character, so a person opening a client as Kermit
// takes Kermit away from us — and everything this broker does next is a fight it should
// not be having: the reconciler rejoins and bumps the human out, the keeper resumes and
// walks the character somewhere while a hand is on the keys.
//
// So a character can be CLAIMED. While claimed:
//
//   * the reconciler ignores it entirely — it is not missing, it is being played
//   * its keeper stays stopped
//   * speech FROM it is treated as instruction rather than as chat (see below)
//
// THE CLAIM IS BOUND TO A LOCAL PROCESS, and that is the whole security argument. Not
// "a message said it was Kermit" — anyone who guesses a password can be Kermit, and on
// this server the passwords are weak. What is trusted is narrower and local: WE spawned
// this client, on this machine, its pid is still alive, and one-connection-per-character
// means it therefore holds the only session permitted for that character. Nothing in
// that chain travels over the wire.
//
// When the pid dies the claim is released and the character goes back to work, which is
// the whole of requirement B.
const piloted = new Map();     // agent -> { pid, since, objectId, character, keeperWasRunning }
const PILOT_POLL_MS = Number(process.env.M59_PILOT_POLL_MS || 4000);

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The claim, and the only thing that may promote speech to instruction. A stale entry
// whose process has gone is not a claim, so this checks liveness rather than trusting
// the map — the poller is a convenience, not the authority.
function pilotOf(agent) {
  const p = piloted.get(agent);
  if (!p) return null;
  if (!pidAlive(p.pid)) { releasePilot(agent, 'the client process is gone'); return null; }
  return p;
}

// Which piloted agent is speaking, by OBJECT ID. Object ids are reissued by `save game`,
// so a renumber makes this stop matching — and that fails CLOSED, back to ordinary
// untrusted chat, which is the right direction to fail in.
function pilotedSpeaker(objectId) {
  for (const agent of [...piloted.keys()]) {
    const p = pilotOf(agent);
    if (p && p.objectId != null && p.objectId === objectId) return { agent, pilot: p };
  }
  return null;
}

function claimPilot(agent, pid, { character = null } = {}) {
  const s = sessions.get(agent);
  const objectId = s?.client?.selfId ?? null;
  const keeper = autopilotIfAny(agent);
  const keeperWasRunning = !!keeper?.running;
  if (keeper?.running) keeper.stop();
  piloted.set(agent, { pid, since: Date.now(), objectId,
                       character: character ?? s?.client?.me?.name ?? null, keeperWasRunning });
  console.error(`[pilot] ${agent} claimed by pid ${pid}` +
                ` (object ${objectId ?? '?'}, keeper ${keeperWasRunning ? 'was running' : 'was stopped'})`);
  return { agent, pid, object_id: objectId, keeper_was_running: keeperWasRunning };
}

function releasePilot(agent, why = 'released') {
  const p = piloted.get(agent);
  if (!p) return null;
  piloted.delete(agent);
  console.error(`[pilot] ${agent} released — ${why}. ` +
                (p.keeperWasRunning ? 'the keeper will start again once it is back in game'
                                    : 'its keeper was stopped before, so it stays stopped'));
  const st = rejoinState.get(agent) || { failures: 0, nextTryAt: 0, lastJoinAt: null };
  st.failures = 0; st.nextTryAt = 0; st.lastJoinAt = null;
  st.keeperWasRunning = p.keeperWasRunning;
  rejoinState.set(agent, st);

  // TWO WAYS A CLAIM ENDS, and only one of them goes through the reconciler.
  //
  // Usually the human's client took the character from us when it logged in, so our
  // session is dead and the reconciler does the whole job: rejoin, then restore the
  // keeper that was running. But a claim can also end while our session is still up —
  // released by hand, or a launch that never reached the login screen — and then there
  // is nothing for the reconciler to notice. The character would sit in the world doing
  // nothing, which looks exactly like a keeper that crashed.
  const s = sessions.get(agent);
  if (s?.live && p.keeperWasRunning) {
    try {
      const keeper = autopilotFor(s);
      const saved = fleetState.get(agent)?.autopilot;
      if (saved) {
        keeper.mode = saved.mode || keeper.mode;
        Object.assign(keeper.policy, saved.policy || {});
      }
      keeper.start();
      console.error(`[pilot] ${agent} still in game — keeper restarted here rather than ` +
                    `waiting for a rejoin that is not coming`);
    } catch (e) { console.error(`[pilot] ${agent} keeper did not restart: ${e.message}`); }
  }
  return p;
}

// WHAT THE OPERATOR CAN SAY TO A CHARACTER WHILE PLAYING BESIDE IT.
//
// A deliberately small, deterministic table — not a language model. Two reasons. This
// runs with no confirmation step, so a misreading spends real items on a shared server;
// and a table can be read in one screen and argued with, which a prompt cannot.
//
// Anything not matched here falls through to ordinary chat handling, so an unrecognised
// sentence is answered by the chatter rather than silently swallowed.
//
// Deliberately absent, and not merely gated: rerolling, leaving, anything touching
// credentials. There is no phrasing that reaches them.
const OPERATOR_VERBS = [
  { re: /\b(give|hand)\s+(me\s+)?(your\s+)?(money|coins?|shillings?|gold)\b|\bpay\s+me\b/i,
    what: 'give money', run: async (a, me) => await callTool('give', { agent: a, to: me, money: 'all' }) },
  { re: /\b(heal|cure)\s+me\b|\bcast\s+heal\s+(on\s+)?me\b/i,
    what: 'cast heal on the operator', run: async (a, me) => await callTool('cast', { agent: a, spell: 'heal', target: me }) },
  { re: /\bfollow\s+me\b/i,
    what: 'follow', run: async (a, me) => await callTool('act', { agent: a, follow: me }) },
  { re: /\b(come|get)\s+(here|to\s+me)\b/i,
    what: 'come to the operator', run: async (a, me, ctx) => await callTool('travel', { agent: a, to: ctx.room, background: true }) },
  { re: /\bdrop\s+(all|everything)\b/i,
    what: 'drop everything', run: async (a) => await callTool('act', { agent: a, drop: 'all' }) },
  { re: /\b(stop|halt|wait|hold)\b/i,
    what: 'stop the keeper', run: async (a) => await callTool('autopilot', { agent: a, action: 'stop' }) },
  { re: /\b(resume|carry on|continue|back to work)\b/i,
    what: 'restart the keeper', run: async (a) => await callTool('autopilot', { agent: a, action: 'start' }) },
  { re: /\brest\b|\bsit\b/i,
    what: 'rest', run: async (a) => await callTool('rest_up', { agent: a }) },
];

// Returns true when the message was consumed as an instruction. False means "this was
// not from a piloted character, or said nothing I understand" — and it goes back to
// being ordinary, untrusted chat.
function routeOperatorInstruction(targetAgent, said) {
  const from = pilotedSpeaker(said?.speaker);
  if (!from) return false;                       // not the operator: not privileged
  if (from.agent === targetAgent) return false;  // talking to itself
  const text = String(said?.text ?? '');
  const hit = OPERATOR_VERBS.find(v => v.re.test(text));
  if (!hit) return false;
  const me = from.pilot.character || from.agent;
  const room = sessions.get(targetAgent)?.client?.room?.num ?? null;
  console.error(`[operator] ${from.agent} -> ${targetAgent}: ${hit.what}  ("${text.slice(0, 60)}")`);
  Promise.resolve()
    .then(() => hit.run(targetAgent, me, { room, speaker: said.speaker }))
    .then(r => console.error(`[operator] ${targetAgent} ${hit.what}: ` +
                             `${typeof r === 'object' ? JSON.stringify(r).slice(0, 140) : r}`))
    .catch(e => console.error(`[operator] ${targetAgent} ${hit.what} FAILED: ${e.message}`));
  return true;
}

function startPilotWatch() {
  const t = setInterval(() => {
    for (const [agent, p] of [...piloted]) {
      if (!pidAlive(p.pid)) releasePilot(agent, `client pid ${p.pid} exited`);
    }
  }, PILOT_POLL_MS);
  t.unref?.();
}

function startReconciling() {
  if (!REJOIN) {
    console.error('[rejoin] disabled — characters that drop will stay out until something joins them');
    return;
  }
  const t = setInterval(() => { reconcileFleet().catch(() => {}); }, RECONCILE_MS);
  t.unref?.();
  console.error(`[rejoin] watching every ${Math.round(RECONCILE_MS / 1000)}s`);
}

class Recorder {
  constructor(name) {
    this.name = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
    this.enabled = true;
    this.buf = [];
    this.window = null;
    this.file = null;
    this.written = 0;
    this.dropped = 0;
    try { mkdirSync(RECORD_DIR, { recursive: true }); } catch { this.enabled = false; }
    this.timer = setInterval(() => this.flush(), 2000);
    this.timer.unref?.();
  }

  line(kind, data) {
    if (!this.enabled) return;
    // Bound the in-memory buffer: a fight produces a burst, and a stalled disk
    // must never become a memory leak.
    if (this.buf.length > 5000) { this.dropped++; return; }
    this.buf.push(JSON.stringify({ at: Date.now(), kind, ...data }));
  }

  currentFile() {
    const w = Math.floor(Date.now() / RECORD_WINDOW_MS);
    if (w !== this.window) {
      this.window = w;
      this.file = join(RECORD_DIR, `${this.name}-${w}.jsonl`);
      this.prune();
    }
    return this.file;
  }

  // Keep only the most recent RECORD_KEEP windows for this character.
  prune() {
    try {
      const mine = readdirSync(RECORD_DIR)
        .filter(f => f.startsWith(this.name + '-') && f.endsWith('.jsonl'))
        .sort();
      for (const f of mine.slice(0, Math.max(0, mine.length - RECORD_KEEP)))
        try { unlinkSync(join(RECORD_DIR, f)); } catch { /* raced with another prune */ }
    } catch { /* directory vanished; next write recreates it */ }
  }

  flush() {
    if (!this.enabled || !this.buf.length) return;
    const lines = this.buf.splice(0, this.buf.length).join('\n') + '\n';
    try { appendFileSync(this.currentFile(), lines); this.written += lines.length; }
    catch { this.enabled = false; }
  }

  stop() { this.flush(); if (this.timer) clearInterval(this.timer); }

  // The tail, for debugging. Reads back across windows, newest last.
  tail(limit = 200, kinds = null) {
    this.flush();
    const want = kinds?.length ? new Set(kinds) : null;
    let out = [];
    try {
      const mine = readdirSync(RECORD_DIR)
        .filter(f => f.startsWith(this.name + '-') && f.endsWith('.jsonl')).sort();
      for (const f of mine.slice(-4)) {
        for (const l of readFileSync(join(RECORD_DIR, f), 'utf8').split('\n')) {
          if (!l) continue;
          try { const e = JSON.parse(l); if (!want || want.has(e.kind)) out.push(e); } catch { /* torn line */ }
        }
      }
    } catch { /* nothing recorded yet */ }
    return out.slice(-limit);
  }
}

// Of several exits that all lead to the same place, try the reachable ones first
// and the nearest of those first. `reachable` is undefined for kinds the geometry
// cannot judge, so only an explicit false demotes a candidate.
// Monster levels, from the catalogue the repo already builds. viLevel is what
// AdvancementCheck compares against your max health, and the display name lives in
// the class's own resource block rather than anywhere on the wire, so the join is
// name -> level and has to be done here.
let _monsterLevels = null, _monsterKarma = null;
function loadMonsterLevels() {
  if (_monsterLevels) return _monsterLevels;
  _monsterLevels = new Map(); _monsterKarma = new Map();
  try {
    const raw = JSON.parse(readFileSync(new URL('./monsters.json', import.meta.url), 'utf8'));
    for (const m of Object.values(raw)) {
      const lvl = Number(m.viLevel);
      const krm = Number(m.viKarma);
      const put = (k) => {
        if (Number.isFinite(lvl)) _monsterLevels.set(k, lvl);
        if (Number.isFinite(krm)) _monsterKarma.set(k, krm);
      };
      if (m.class) put(String(m.class).toLowerCase());
      for (const v of Object.values(m._res || {}))
        if (Array.isArray(v) && typeof v[0] === 'string') put(v[0].toLowerCase());
    }
  } catch { /* catalogue missing — progress still reports the rule, just not levels */ }
  return _monsterLevels;
}
const monsterKarmaByName = (_, name) => {
  if (!_monsterKarma || !name) return null;
  const q = String(name).toLowerCase();
  if (_monsterKarma.has(q)) return _monsterKarma.get(q);
  let best = null, len = -1;
  for (const [k, v] of _monsterKarma)
    if ((k.includes(q) || q.includes(k)) && k.length > len) { best = v; len = k.length; }
  return best;
};

// Names on the wire are the display names ("giant rat"), and a caller may pass a
// partial. Exact first, then the longest containing match so "rat" does not win
// over "giant rat" by accident.
function monsterLevelByName(map, name) {
  if (!name) return null;
  const q = String(name).toLowerCase();
  if (map.has(q)) return map.get(q);
  let best = null, bestLen = -1;
  for (const [k, v] of map)
    if ((k.includes(q) || q.includes(k)) && k.length > bestLen) { best = v; bestLen = k.length; }
  return best;
}

// What arriving somewhere is worth saying. `travel` used to answer a request to
// MOVE with the entire destination room — every object, both map renderings — which
// is the single largest reply the broker produces and almost never what was asked
// for. A move should report that it moved, and what is worth knowing on arrival:
// is anything here hostile, is there loot, who else is standing about. Call `look`
// when the answer is yes.
const arrivalReport = (s) => {
  const v = s.view();
  const has = (o, verb) => Array.isArray(o.can) && o.can.includes(verb);
  return {
    room: v.room,
    you: v.you,
    vitals: v.vitals,
    here: {
      attackable: v.objects.filter(o => has(o, 'attack') && !o.is_player).length,
      players: v.objects.filter(o => o.is_player).length,
      on_the_floor: v.objects.filter(o => has(o, 'get')).length,
      merchants: v.objects.filter(o => has(o, 'buy')).length,
      other: v.objects.filter(o => !has(o, 'attack') && !has(o, 'get') && !has(o, 'buy') && !o.is_player).length,
      scenery: v.scenery?.total ?? 0,
    },
    exits: v.exits.length,
    note: 'arrival summary — call look for the full contents, or look with minimap:true for the picture',
  };
};

const orderExits = (candidates) => candidates.slice().sort((a, b) =>
  (a.reachable === false) - (b.reachable === false) ||
  (a.steps_away ?? Infinity) - (b.steps_away ?? Infinity));

class Session {
  constructor(name) {
    this.name = name;
    this.pacer = new Pacer();
    this.client = null;
    this.world = null;
    this.cursor = 0;                    // last event seq this agent has been told about
    this.fine = false;                  // fine-movement mode — see walkFine
    this.recorder = new Recorder(name); // flight recorder; never surfaced in replies
    this.job = null;                    // one background action — see startJob
  }

  get live() { return this.client && this.client.state === 'game'; }

  // The server accepts one move packet per second and there is no way around that,
  // so a cross-map walk genuinely costs minutes of wall clock. For a single
  // character, blocking for those minutes is honest. For a fleet it is the wrong
  // shape: a supervisor moving twenty characters would spend twenty times the
  // longest walk, in series, purely because the reply is the only way to learn the
  // outcome. So: start it, return now, and let `status` and `fleet` carry the
  // result. One job at a time per session — the character has one body.
  startJob(kind, label, fn) {
    if (this.job && !this.job.done) throw new Error(`${this.name} is busy: ${this.job.label}`);
    const job = { kind, label, startedAt: Date.now(), done: false };
    this.job = job;
    fn().then(r => { job.result = r; }, e => { job.error = e.message; })
        .finally(() => { job.done = true; job.finishedAt = Date.now(); });
    return job;
  }

  jobReport() {
    const j = this.job;
    if (!j) return undefined;
    const secs = Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000);
    return j.done
      ? { last_action: j.label, took_s: secs, ...(j.error ? { failed: j.error } : { ok: true }) }
      : { busy: j.label, running_for_s: secs };
  }

  async join({ account, password, character, host = HOST, port = PORT }) {
    if (this.live) return this.snapshot('already in game');
    // Kept so the session can put itself back together. A `save game` renumbers
    // every object id, which leaves a live session holding a selfId the server has
    // stopped using — see Autopilot.pass. Logging in again is the only cure, and it
    // needs these.
    this.credentials = { account, password, character, host, port };
    const c = new M59Client({ host, port, verbose: false, resources });
    // Everything the server says, straight to disk. This is the only place the raw
    // stream is kept — the in-memory event ring is small and is overwritten fast.
    c.onEvent = ev => this.recorder.line('event', ev);
    if (character) c.wantName = character;
    await c.login(account, password);
    this.client = c;
    this.world = new World(c, worldMap);
    // The server does not volunteer the world. Ask, paced, and let the replies
    // land before reporting.
    await this.pacer.submit('read', () => c.roomContents());
    await this.pacer.submit('read', () => c.players());
    await this.pacer.submit('read', () => c.requestInventory());
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    await new Promise(r => setTimeout(r, 600));
    // A chatter binds to the CLIENT, not to the session, so a rejoin after a save-game
    // renumber leaves it listening to a socket that no longer exists. Rebind here rather
    // than making every caller remember to.
    chatterIfAny(this.name)?.reattach();
    return this.snapshot('joined');
  }

  // MAKE A NEW CHARACTER ON THIS ACCOUNT, at the one moment the server will accept
  // one: the character list, before anything has been taken into the world.
  //
  // The client already exposes the seam — `onCharacters` fires exactly there — so
  // this is the ordinary login with BP_NEW_CHARINFO substituted for BP_USE_CHARACTER,
  // then a USE of whatever id comes back in BP_CHARINFO_OK.
  //
  // The `user` field is the one part not documented anywhere in this repository, and
  // the server's habit of accepting bad input silently means a wrong value would look
  // like success and produce a junk character. So the caller is expected to have
  // verified this against a throwaway account before pointing it at anything real,
  // and `verify` below is what does that checking.
  // The `user` field is the OBJECT ID OF THE CHARACTER BEING REPLACED, and this is
  // not a guess any more — kod/util/system.kod:3719 reads it straight off the wire:
  //
  //     oUser = Nth(client_msg,2);
  //     if NOT Send(oUser, @IsFirstTime) { bLegal = FALSE; }
  //
  // BP_NEW_CHARINFO is a RECREATE, not a create-from-nothing: the server deletes the
  // old user, recycles the object, renames it and re-rolls it in place. So the id has
  // to name an existing character on this account, and that character has to be
  // first-time — which is what the suicide arranges (PerformSuicide sets
  // piLastLoginTime = 0, and IsFirstTime is exactly that test).
  //
  // Passing 0 is the failure we actually hit: Send(0,@IsFirstTime) does not throw, so
  // bLegal stays true, the handler runs on a null object, and AddPacket(4,oUser) sends
  // CHARINFO_OK carrying 0. It looks like success and produces nothing.
  async joinAsNewCharacter(plan, { userField = null } = {}) {
    if (!this.credentials) throw new Error('nothing to create against — this session never joined');
    const { account, password, host = HOST, port = PORT } = this.credentials;
    try { this.client?.sock?.destroy(); } catch { /* already gone */ }
    this.client = null;
    await new Promise(r => setTimeout(r, 900));

    const c = new M59Client({ host, port, verbose: false, resources });
    c.onEvent = ev => this.recorder.line('event', ev);
    let asked = false, newId = null, refused = false, replaced = null, notFirstTime = null;
    c.onCharacters = (list) => {
      if (asked) return;
      asked = true;
      // PICK THE ONE THE SERVER WILL ACCEPT.
      //
      // system.kod:3725 refuses any character that is not IsFirstTime, and the
      // character list already says which one that is: the low bit of `flags` is set
      // on exactly the character a suicide has made available. Choosing by name or by
      // position instead sends a perfectly valid id for a character the server will
      // not re-roll, and the refusal is silent — no CHARINFO_OK, no CHARINFO_NOT_OK,
      // just a login that never completes.
      const want = String(this.credentials.character || '').toLowerCase();
      const firstTime = list.filter(x => x.flags & 1);
      // NO FIRST-TIME CHARACTER MEANS THE SUICIDE DID NOT LAND — AND THE USUAL REASON
      // IS THE COOLDOWN. user.kod:32 sets SUICIDE_REPEAT_TIME = 600, and :1520 refuses
      // a second suicide within ten minutes of the last one, per character. The
      // refusal is a message to the user, not an error, so a client that does not read
      // it carries on and sends a creation request for a character the server will
      // never re-roll.
      //
      // Sending it anyway is worse than useless: it burns the attempt and produces a
      // result that looks like a protocol bug. Refuse here instead, and say which of
      // the two it is.
      const pick = (want && firstTime.find(x => x.name.toLowerCase() === want)) || firstTime[0];
      if (!pick) {
        notFirstTime = list.map(x => x.name);
        return;   // leaves `asked` false; the caller reports why
      }
      replaced = pick ? { id: pick.id, name: pick.name } : null;
      const user = userField ?? pick?.id ?? 0;
      c.newCharInfo({
        user, name: plan.name, gender: plan.gender ?? 1,
        stats: plan.stat_list, spells: plan.spell_nums, skills: plan.skills ?? [],
      });
    };
    const priorEmit = c.emit?.bind(c);
    c.emit = (kind, data) => {
      // CHARINFO_OK carries the new object id, and taking it into the world is the
      // ordinary USE — the same call the normal login path makes once it has picked a
      // character off the list.
      if (kind === 'charinfo-ok' && data?.id != null) {
        newId = data.id;
        c.useCharacter(data.id);
        c.me = { id: data.id, name: plan.name };
      }
      if (kind === 'charinfo-not-ok') refused = true;
      return priorEmit(kind, data);
    };

    await c.login(account, password).catch(e => { throw new Error(`creation login failed: ${e.message}`); });
    this.client = c;
    this.world = new World(c, worldMap);
    this.credentials = { ...this.credentials, character: plan.name };
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    await new Promise(r => setTimeout(r, 800));
    return {
      created: !refused && !!c.selfId, refused, object_id: newId ?? c.selfId,
      name: plan.name, asked, replaced,
      ...(notFirstTime ? {
        blocked: 'no character on this account is available for creation',
        characters: notFirstTime,
        why: 'a character only becomes available after a suicide, and user.kod:32 sets ' +
             'SUICIDE_REPEAT_TIME = 600 — one suicide per character per ten minutes. Either ' +
             'the suicide was refused by that cooldown, or it never ran. Nothing was sent.',
      } : {}),
    };
  }

  // Drop the connection and log in again with the same credentials. The object id
  // is reissued at login, so this is what repairs a session whose selfId the server
  // renumbered underneath it.
  async rejoin() {
    if (!this.credentials) throw new Error('nothing to rejoin with — this session never joined');
    try { this.client?.sock?.destroy(); } catch { /* already gone */ }
    this.client = null;
    await new Promise(r => setTimeout(r, 800));
    return this.join(this.credentials);
  }

  need() {
    if (!this.live) throw new Error(`agent "${this.name}" is not in game — call join first`);
    return this.client;
  }

  snapshot(note) {
    const c = this.client;
    if (!c) return { note, in_game: false };
    const me = c.self;
    return {
      note,
      in_game: true,
      agent: this.name,
      character: c.me?.name,
      object_id: c.selfId,
      room: { id: c.room.id, name: c.rsc.get(c.roomNameRsc) },
      position: me ? { col: me.col, row: me.row, facing_degrees: me.degrees } : null,
      vitals: c.vitals(),
      queued_requests: this.pacer.depth,
    };
  }

  // Everything known about where we are standing, joined into one thing: perception,
  // the room graph, and the walkability geometry the minimap is drawn from. This is
  // the call an agent should make at the start of every turn.
  view(opts = {}) {
    this.need();
    return this.world.snapshot(opts);
  }

  // Re-read, then view. Perception is pull-only for room contents: the server sends
  // incremental BP_CREATE/BP_MOVE for things it already told you about, but never
  // volunteers a fresh list.
  async refresh(opts = {}) {
    const c = this.need();
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
    return this.view(opts);
  }

  // BP_PLAYER is the only message that NAMES the room, and its name resource is what
  // lets the world model find the room in the graph. It arrives on entering a room,
  // but after an admin teleport or a reconnect the broker can be holding a stale
  // name, so it is worth asking outright.
  async refreshRoomIdentity() {
    const c = this.need();
    const before = c.evSeq;
    await this.pacer.submit('read', () => c.send(BP_SEND_PLAYER));
    await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 2500 });
  }

  // Turn to face a target. Skipping this is the single most common way for an agent's
  // attacks to vanish: TargetWithinSightAndRange (player.kod:4115) rejects anything
  // behind you at distance > 1, and the refusal message is about view, not range, so
  // it reads like a different problem.
  async faceToward(target) {
    const c = this.need();
    const me = c.self;
    if (!me || !target) return null;
    const dx = target.col - me.col, dy = target.row - me.row;
    if (dx === 0 && dy === 0) return me.degrees;
    // kod angle 0 is east and increases clockwise as rows grow downward, which is
    // exactly what atan2(dy, dx) gives in screen coordinates.
    const deg = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI)) % 360 + 360) % 360;
    await this.pacer.submit('turn', () => c.face(deg));
    return deg;
  }

  // One paced step, then read back where we ended up. Reading back is not optional:
  // the server never confirms the mover's own move, because Room.SomethingMoved
  // builds the move packet for everyone else in the room and skips the mover.
  // FACE WHERE YOU ARE GOING, AND RUN WHEN IT MATTERS.
  //
  // Neither was being done. Every move went out at speed 18 — USER_WALKING_SPEED
  // exactly — with whatever angle the character happened to be left on, which is a
  // character strolling backwards through a field of groundworms.
  //
  // Running is the right default OUTDOORS and the wrong one indoors: exertion is
  // charged as (speed * 5/6)^2, so it is quadratic, and vigor is what sets the
  // health regeneration rate. Burning it in a town buys nothing; burning it crossing
  // a monster field buys the difference between arriving and not.
  moveSpeed() {
    const c = this.client;
    const room = this.world?.room;
    const vigor = c?.vitals?.()?.vigor?.value ?? 0;
    if (this.walkOnly) return WALK_SPEED;
    if (vigor < RUN_VIGOR_FLOOR) return WALK_SPEED;      // too tired; the server would snap us back
    // Run where there is something to outrun, walk where there is not. The spawn
    // index answers that directly and correctly — a room with no generator has
    // nothing in it worth spending vigor on — which is better than guessing from a
    // room flag I have not verified. (piRoom_Flags 4096 is set on the Underworld as
    // well as on open fields, so it is not the outdoors bit it looks like.)
    if (!room) return WALK_SPEED;
    const spawns = loadSpawns(SPAWN_FILE);
    const dangerous = !!(spawns?.rooms?.[room.num]?.length);
    return dangerous ? RUN_SPEED : WALK_SPEED;
  }

  async step(col, row) {
    const c = this.need();
    const before = c.self;
    // Turn to face the destination first. It costs nothing, it is what a player
    // does, and several things in this game care about facing.
    if (before && (before.col !== col || before.row !== row)) {
      const deg = (Math.atan2(row - before.row, col - before.col) * 180 / Math.PI + 360) % 360;
      await this.pacer.submit('turn', () => c.face(deg));
    }
    const speed = this.moveSpeed();
    await this.pacer.submit('move', () => c.moveToSquare(col, row, speed), MOVE_INTERVAL_MS);
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
    const after = c.self;
    return {
      moved: !!after && (!before || after.col !== before.col || after.row !== before.row),
      position: after ? { col: after.col, row: after.row } : null,
      left_room: !c.room.objects.has(c.selfId),
    };
  }

  // ------------------------------------------------------- fine movement
  //
  // THE SQUARE GRID CANNOT DESCRIBE A LEDGE, AND MERIDIAN HAS MANY.
  //
  // The .roo carries movement as one byte per SQUARE — eight direction bits, 64
  // fine units to the square. A walkable strip narrower than one square has
  // nowhere to live in that structure, so the square reads solid and the ordinary
  // pathfinder refuses the route before sending a packet. The cliff path in
  // Kardde's Canyon that is the only way into the Badlands is exactly this: real
  // on the server, absent from the grid.
  //
  // The server does not use that grid. It validates against the fine BSP geometry,
  // so the fix is to stop asking the grid and walk in fine coordinates, letting the
  // SERVER be the judge of each step.
  //
  // Two rules make it work, and both were learned the hard way:
  //
  //  * CONFIRM EVERY STEP BY RE-READING. The server does not echo your own accepted
  //    move, so cached position goes stale and a move that WORKED is indistinguish-
  //    able from one that was refused. Dead reckoning here does not merely drift,
  //    it inverts the result.
  //  * WHEN BLOCKED, SLIDE. A refused step usually means the straight line clipped
  //    rock, not that the way is shut. Fanning the heading out to either side is
  //    what "hugging the wall" actually is, and it is how a human gets along a
  //    ledge without falling off it.
  async stepFine(x, y) {
    const c = this.need();
    const p0 = c.self;
    const before = p0 ? { x: p0.x, y: p0.y } : null;
    await this.pacer.submit('move', () => c.moveTo(Math.round(x), Math.round(y)), MOVE_INTERVAL_MS);
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
    const p1 = c.self;
    const after = p1 ? { x: p1.x, y: p1.y, col: p1.col, row: p1.row } : null;
    const moved = !!(before && after && (after.x !== before.x || after.y !== before.y));
    return { moved, position: after, left_room: !c.room.objects.has(c.selfId),
             travelled: moved ? Math.hypot(after.x - before.x, after.y - before.y) : 0 };
  }

  // Walk to a fine coordinate without consulting the square grid at all.
  // `stride` is how far to reach per request; a short stride hugs geometry more
  // closely but costs a second per step, since the move rate is one per second.
  async walkFine(destX, destY, { maxSteps = 120, stride = 48, arriveWithin = 40 } = {}) {
    const c = this.need();
    const startRoom = c.room.id;
    let me = c.self;
    if (!me) return { arrived: false, reason: 'own position unknown — call look first' };

    const log = [];
    let stalls = 0;
    // Headings to try, in order: straight at it, then fanned out to either side.
    // The wide angles are what carry you along a wall rather than into it.
    const FAN = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];

    for (let i = 0; i < maxSteps; i++) {
      me = c.self;
      if (!me) return { arrived: false, reason: 'lost track of own position', log };
      const dx = destX - me.x, dy = destY - me.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= arriveWithin)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 steps: i, log };

      const base = Math.atan2(dy, dx);
      const reach = Math.min(stride, remaining);
      let progressed = false;

      for (const off of FAN) {
        const a = base + off;
        const r = await this.stepFine(me.x + Math.cos(a) * reach, me.y + Math.sin(a) * reach);
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room — for an edge exit that IS arriving' };
        }
        if (r.moved) {
          progressed = true;
          if (off !== 0) log.push({ step: i, slid: Number(off.toFixed(2)), to: r.position });
          break;
        }
      }

      if (!progressed) {
        stalls++;
        // Halve the reach and try again: a tight gap may only admit a short step.
        stride = Math.max(12, Math.round(stride / 2));
        if (stalls >= 4)
          return { arrived: false, reason: 'blocked — every heading refused, at every reach tried',
                   position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
                   steps: i, log };
      } else stalls = 0;
    }
    me = c.self;
    return { arrived: false, reason: 'ran out of steps',
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null, log };
  }

  // Walk to a square along a route computed through the real geometry, rather than
  // pushing blindly toward it. Both halves matter: the route lets an agent round a
  // corner it would otherwise stall against, and the pacing keeps the session from
  // being logged as a speedhacker.
  //
  // With no geometry it degrades to sign-stepping, so the broker still works against
  // a world it has no map for — just worse.
  async walkTo(col, row, { maxSteps = 60, hardCap = 400 } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me0 = c.self;
    if (!me0) return { arrived: false, reason: 'own position unknown — call look first' };
    if (me0.col === col && me0.row === row)
      return { arrived: true, position: { col, row }, steps: 0, note: 'already there' };

    if (!geo) {
      const steps = [];
      for (let i = 0; i < maxSteps; i++) {
        const me = c.self;
        if (!me || (me.col === col && me.row === row)) break;
        const r = await this.step(me.col + Math.sign(col - me.col), me.row + Math.sign(row - me.row));
        steps.push(r.position);
        if (r.left_room) return { arrived: false, left_room: true, steps: steps.length };
        if (!r.moved) return { arrived: false, blocked_at: r.position, steps: steps.length,
                               note: 'blocked, and there is no geometry to route around it' };
      }
      const me = c.self;
      return { arrived: !!me && me.col === col && me.row === row,
               position: me && { col: me.col, row: me.row }, steps: steps.length };
    }

    // If something has parked us on a square with no floor, no route exists from it at
    // all. The server does not check walls for players, so we can simply step onto
    // solid ground and carry on — but it has to be done deliberately, because from
    // here the pathfinder has nothing to say.
    if (!geo.walkable(me0.row, me0.col)) {
      const spot = geo.nearestWalkable(me0.row, me0.col);
      if (!spot) return { arrived: false, reason: 'standing off the floor with no walkable square anywhere near',
                          position: { col: me0.col, row: me0.row } };
      const r = await this.step(spot.col, spot.row);
      if (!r.moved) return { arrived: false, reason: 'could not step back onto solid ground',
                             position: r.position, note: 'the server accepted the move but nothing changed' };
    }

    const from = c.self ?? me0;
    const plan = geo.path(from.row, from.col, row, col);
    if (!plan.found)
      return { arrived: false, reason: plan.reason, position: { col: from.col, row: from.row },
               ...(plan.stuck ? { nearest_floor: plan.nearest_floor } : {}),
               note: 'the geometry says there is no route to that square from here' };

    // If a route exists, walking it is what was asked for. Refusing partway because of
    // a caller's default budget is a silent failure dressed as a limit — so the plan
    // itself raises the ceiling, and only a genuinely runaway walk is capped.
    if (plan.steps.length + 10 > maxSteps) maxSteps = Math.min(plan.steps.length + 10, hardCap);

    let queue = plan.steps.slice();
    let taken = 0, replans = 0;
    while (queue.length && taken < maxSteps) {
      const next = queue.shift();
      const r = await this.step(next.col, next.row);
      taken++;
      if (r.left_room)
        return { arrived: false, left_room: true, steps: taken, note: 'a step crossed the room edge' };
      const now = c.self;
      if (!now) break;
      if (now.col !== next.col || now.row !== next.row) {
        // The server put us somewhere other than the plan said. Something the
        // geometry does not model is in the way, so replan from where we actually
        // are rather than walking on down a stale route.
        if (++replans > 3)
          return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                   note: 'kept ending up somewhere other than the planned square' };
        const re = geo.path(now.row, now.col, row, col);
        if (!re.found)
          return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken, reason: re.reason };
        queue = re.steps.slice();
      }
    }
    const me = c.self;
    return { arrived: !!me && me.col === col && me.row === row,
             position: me && { col: me.col, row: me.row }, steps: taken, replans,
             ...(taken >= maxSteps ? { note: 'stopped after ' + maxSteps + ' steps' } : {}) };
  }

  // Leave the room. The tool picks the mechanism, because using the wrong one
  // produces no reply at all:
  //   an edge exit -> walk to the boundary square, then one more step outward
  //   a `go` exit  -> stand on EXACTLY the exit square, then BP_REQ_GO
  async leaveVia(exit) {
    const c = this.need();

    // Budget every walk by the ROUTE length, never by a fixed cap. Outdoor rooms here
    // are up to 80x80, so a boundary square can be well over a hundred steps away —
    // and a cap turns a perfectly good exit into a hop that "fails" for no stated
    // reason, which is exactly the silent failure this broker exists to remove.
    const budget = e => Math.max(40, (e.steps_away ?? 0) + 20);

    if (exit.kind === 'go') {
      let walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row, { maxSteps: budget(exit) });

      // COARSE "UNREACHABLE" IS NOT THE SAME AS IMPOSSIBLE.
      //
      // The movement grid is one byte per square; the world underneath it is BSP
      // geometry at 64 fine units to the square. Anything narrower than a square —
      // a ledge, a gap between pillars, the diagonal slot through a crypt — exists
      // in the geometry and simply cannot be represented in the grid, so the
      // pathfinder reports no route to somewhere you can plainly walk.
      //
      // Six characters sat in the Marion crypt for half an hour because of this.
      // The grid said the way back was unreachable; stepping there in fine units
      // worked first time. So when coarse pathing fails, try fine before believing
      // it — the cost is one more attempt and the alternative is a permanent trap.
      if (!walk.arrived) {
        // walkFine works in fine units, not squares — the centre of a square is
        // col*64 + 32. Passing square coordinates walks to the top-left corner of
        // the map instead, which looks like a wildly broken pathfinder.
        const half = KOD_FINENESS >> 1;
        const fine = await this.walkFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half,
                                         { maxSteps: budget(exit) }).catch(() => null);
        if (fine?.arrived) walk = { ...fine, via: 'fine movement after coarse pathing failed' };
      }
      let leaned = false;

      // A DOORWAY IS USUALLY NOT WALKABLE IN THE ROOM'S OWN GRID.
      //
      // The square Room.SomethingTryGo matches on is frequently drawn as wall, and
      // the direction bits of the square beside it do not open onto it — so the
      // pathfinder correctly reports "no route" to a square that is nonetheless
      // the only way out. The Royal Bank of Jasper is the clean example: its exit
      // sits at (9,6) in a column the grid seals off completely, and an agent that
      // trusts the route planner is simply stuck in the bank forever.
      //
      // The server does not require you to STAND on it. Movement is in fine units
      // — 64 to the square — and a REQ_MOVE the walls forbid is not discarded, it
      // is CLAMPED to the closest legal fine position. Asking for the exit square
      // from the square next door therefore slides us hard up against the doorway,
      // close enough for REQ_GO to find the door, while our square never changes.
      // Verified against a live server: the move is refused as a move, and the very
      // next REQ_GO answers "You open the door and walk through."
      if (!walk.arrived) {
        const spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
        if (!spot) return { left: false, stage: 'walk', ...walk };
        if (spot.steps > 0) {
          const near = await this.walkTo(spot.col, spot.row, { maxSteps: Math.max(40, spot.steps + 20) });
          if (!near.arrived) return { left: false, stage: 'walk', ...near };
        }
        await this.pacer.submit('move',
          () => c.moveToSquare(exit.stand_on.col, exit.stand_on.row), MOVE_INTERVAL_MS);
        leaned = true;
      }

      const before = c.evSeq;
      await this.pacer.submit('move', () => c.go(), MOVE_INTERVAL_MS);
      // Wait for the ROOM CHANGE specifically. A door announces itself first —
      // "You open the door and walk through." arrives as a message a beat before
      // BP_PLAYER reports the new room — and waitFor returns on the first match of
      // ANY listed kind. Listening for 'message' too therefore returned the
      // announcement of success and called it a failure, every single time.
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      const entered = ev.events.find(e => e.kind === 'room-entered');
      const messages = c.eventsSince(before).filter(e => e.text).map(e => e.text);
      return { left: !!entered, arrived_in: entered ? entered.roomName : null,
               ...(leaned && entered
                   ? { note: 'the exit square is not walkable in this room\'s grid, so this ' +
                             'leaned into the doorway from the square beside it' } : {}),
               ...(entered ? {} : {
                 reason: messages.length ? messages.join('; ')
                       : leaned ? `leaned into (${exit.stand_on.col},${exit.stand_on.row}) from beside ` +
                                  'it and the server did not open a door there'
                       : 'stood on the exit square and nothing happened' }),
               messages };
    }

    if (exit.kind === 'edge') {
      // No reachable boundary square, says the square grid — the same verdict it
      // gives for a cliff ledge, and wrong for the same reason. Pick the nearest
      // floor square actually on that boundary and walk to it in fine coordinates,
      // letting the server judge the steps.
      if (!exit.stand_on) {
        const geo = this.world.geometry, me = c.self;
        if (!geo || !me) return { left: false, reason: 'no reachable square on that edge' };
        const line = [];
        if (exit.direction === 'north' || exit.direction === 'south') {
          const row = exit.direction === 'north' ? 1 : geo.rows;
          for (let col = 1; col <= geo.cols; col++) if (geo.walkable(row, col)) line.push({ col, row });
        } else {
          const col = exit.direction === 'west' ? 1 : geo.cols;
          for (let row = 1; row <= geo.rows; row++) if (geo.walkable(row, col)) line.push({ col, row });
        }
        if (!line.length)
          return { left: false, reason: `no floor anywhere on the ${exit.direction} boundary` };
        line.sort((a, b) => Math.hypot(a.col - me.col, a.row - me.row) -
                            Math.hypot(b.col - me.col, b.row - me.row));
        const target = line[0];
        const half = KOD_FINENESS >> 1;
        const fine = await this.walkFine(target.col * KOD_FINENESS + half,
                                         target.row * KOD_FINENESS + half,
                                         { maxSteps: 220, stride: 40 });
        if (fine.left_room)
          return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                   note: 'crossed the boundary while walking to it in fine coordinates' };
        if (!fine.arrived)
          return { left: false, stage: 'walk', reason: fine.reason,
                   note: 'the grid had no reachable square on that edge and fine movement could not ' +
                         'reach one either' };
        exit = { ...exit, stand_on: target };
      }
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row, { maxSteps: budget(exit) });
      if (!walk.arrived && !(c.self && c.self.col === exit.stand_on.col && c.self.row === exit.stand_on.row))
        return { left: false, stage: 'walk', ...walk };
      // One more step OUTWARD, past the grid. Nothing else triggers
      // Room.StandardLeaveDir.
      const out = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[exit.direction];
      if (!out) return { left: false, reason: 'unknown edge direction ' + exit.direction };
      const before = c.evSeq;
      await this.pacer.submit('move',
        () => c.moveToSquare(exit.stand_on.col + out[0], exit.stand_on.row + out[1]), MOVE_INTERVAL_MS);
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (!entered) {
        // If this was an edge we INFERRED rather than one the room declared, the
        // inference was simply wrong — drop it so neither the planner nor anything
        // else keeps routing through a boundary that does not exist.
        if (exit.inferred && this.world?.room?.num != null && exit.to != null) {
          forgetInferredExit(this.world.room.num, exit.to);
          return { left: false, reason: 'stepping past the edge did nothing',
                   note: 'this exit was inferred from the other room declaring an edge into here, and the ' +
                         'server refused it — the inference is now dropped and routes will avoid it' };
        }
        return { left: false, reason: 'stepping past the edge did nothing',
                 note: 'that boundary may have no plEdge_Exits entry, or a condition on it excludes where we crossed' };
      }
      return { left: true, arrived_in: entered.roomName };
    }

    // A region exit needs nothing but arriving on the square: the room's own
    // SomethingMoved fires as we land and moves us across. So walk, then confirm by
    // the room having changed rather than by any reply, because there is not one.
    if (exit.kind === 'region') {
      if (!exit.stand_on)
        return { left: false, reason: 'no reachable square inside the trigger region',
                 note: 'the region is ' + exit.trigger + ' — it may be walled off from here' };
      const before = c.evSeq;
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row, { maxSteps: budget(exit) });
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (entered) return { left: true, arrived_in: entered.roomName, via: 'region trigger' };
      return { left: false, reason: 'reached the square but the room did not move us',
               walk, note: 'the trigger is ' + exit.trigger + '; the walk may have stopped short' };
    }

    if (exit.kind === 'portal') {
      // Nothing to send: Portal.SomethingMoved fires on arrival at its square and
      // teleports whatever is standing there. So walking IS the action.
      const before = c.evSeq;
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row, { maxSteps: budget(exit) });
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (!entered)
        return { left: false, stage: walk.arrived ? 'stood on it' : 'walk', ...walk,
                 reason: walk.arrived ? 'standing on it did nothing — it may not be a portal after all' : undefined };
      return { left: true, arrived_in: entered.roomName, via: 'portal' };
    }

    return { left: false, reason: 'cannot leave through a ' + exit.kind };
  }

  // One doorway is often published as several squares, and they are NOT
  // interchangeable: in the Royal Bank of Jasper (9,7) has a brazier standing on
  // it and refuses, while (9,6) one square north opens. Which is which is not in
  // the protocol, so the only honest thing is to try them in a sensible order and
  // report what each said.
  async leaveViaAny(candidates) {
    const tried = [];
    for (const exit of orderExits(candidates)) {
      const r = await this.leaveVia(exit);
      if (r.left) return { ...r, used_exit: exit, ...(tried.length ? { tried } : {}) };
      tried.push({ stand_on: exit.stand_on, why: r.reason || r.note || 'no reason reported' });
    }
    const last = tried[tried.length - 1];
    return { left: false, tried,
             reason: tried.length > 1
               ? `every square for that exit refused (${tried.length} tried)`
               : (last ? last.why : 'no exit to try') };
  }

  // One paced round of swings, facing the target before each. Split out from the
  // `attack` tool so the composite skills can drive combat without going through the
  // MCP layer and re-resolving the target every time.
  async attackRounds(targetId, swings = 4) {
    const c = this.need();
    const messages = [];
    for (let i = 0; i < swings; i++) {
      const o = c.room.objects.get(targetId);
      if (!o) break;
      await this.faceToward(o);
      const before = c.evSeq;
      await this.pacer.submit('attack', () => c.attack(targetId), ATTACK_INTERVAL_MS);
      const ev = await c.waitFor({ since: before, timeoutMs: 2500 });
      messages.push(...ev.events.filter(e => e.text).map(e => e.text));
      if (ev.events.some(e => e.kind === 'vanished' && e.id === targetId)) break;
      if (!c.room.objects.has(c.selfId)) break;      // we died
    }
    // Health after the exchange, since deciding whether to keep fighting depends on
    // it and the stat only arrives when it changes.
    await this.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    return { messages, vitals: c.vitals() };
  }

  // Pick up everything gettable within reach. Shared with the `loot` tool.
  // `stayPut` is for looting from a safe spot: UserGet reaches seven squares on its
  // own, so most of a kill's drops are already gettable from where you stand, and the
  // few that are not are not worth giving up the wall for. What is left behind is
  // reported rather than silently skipped.
  async lootFloor({ only = null, ids = null, maxItems = 12, stayPut = false } = {}) {
    const c = this.need();
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
    const me0 = c.self;
    if (!me0) return { taken: [], refused: [], carrying: [], reason: 'own position unknown' };
    const manhattan = o => Math.abs(o.col - me0.col) + Math.abs(o.row - me0.row);

    let cands = [...c.room.objects.values()].filter(o => o.id !== c.selfId && (o.flags & OF.GETTABLE));

    // NEVER PICK THESE UP.
    //
    // Two items in the game return TRUE from IsCursed, and picking one up is not a
    // mistake you can undo by dropping it. The Amulet of Shadows equips itself, costs
    // you light, applies a defence PENALTY so everything hits you more often, and
    // cannot be taken off without an uncurse spell — and shadowam.kod can call
    // @Killed on its owner outright. Its own source comments that handing them to
    // people is a known griefing tactic. The ring of lethargy is the other.
    //
    // A keeper looting a corpse field will happily take one, so this is not caution,
    // it is the difference between scavenging being profitable and being a trap. They
    // are REFUSED rather than silently skipped, so the reason is visible.
    const cursedSkipped = [];
    cands = cands.filter(o => {
      const n = c.rsc.get(o.nameRsc) || '';
      if (CURSED_ITEMS.test(n)) { cursedSkipped.push(n); return false; }
      return true;
    });

    if (ids?.length) { const w = new Set(ids.map(Number)); cands = cands.filter(o => w.has(o.id)); }
    else if (only) { const q = String(only).toLowerCase(); cands = cands.filter(o => c.rsc.get(o.nameRsc).toLowerCase().includes(q)); }
    cands.sort((a, b) => manhattan(a) - manhattan(b));
    cands = cands.slice(0, maxItems);

    const taken = [], refused = [];
    for (const n of cursedSkipped)
      refused.push({ item: n, why: 'CURSED — it equips itself, cannot be removed without an ' +
                                   'uncurse spell, and makes you easier to hit. Leave it.' });
    for (const o of cands) {
      const name = c.rsc.get(o.nameRsc);
      const me = c.self;
      // UserGet measures MANHATTAN distance and refuses past 7, so only walk when
      // we actually have to — most drops are already in reach.
      if (me && (Math.abs(o.col - me.col) + Math.abs(o.row - me.row)) > 7) {
        if (stayPut) {
          refused.push({ id: o.id, name,
                         why: 'more than seven squares away, and we are holding a safe spot — ' +
                              'walking over to it would give up the wall' });
          continue;
        }
        const spot = this.world.approachSquare(o.col, o.row);
        if (!spot) { refused.push({ id: o.id, name, why: 'cannot reach it through the geometry' }); continue; }
        const walk = await this.walkTo(spot.col, spot.row, { maxSteps: Math.max(30, spot.steps + 10) });
        if (!walk.arrived) { refused.push({ id: o.id, name, why: walk.reason || 'could not get there' }); continue; }
      }
      const before = c.evSeq;
      await this.pacer.submit('get', () => c.get(o.id));
      const ev = await c.waitFor({ since: before, kinds: ['got', 'message', 'vanished'], timeoutMs: 3000 });
      const got = ev.events.find(e => e.kind === 'got');
      if (got) taken.push({ id: o.id, name, amount: o.amount || undefined });
      else refused.push({ id: o.id, name, why: ev.events.filter(e => e.text).map(e => e.text).join('; ') || 'no reply' });
    }
    await this.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    return { taken, refused,
             carrying: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })) };
  }

  // Offer one item to a merchant and either read the price or complete the sale.
  // Selling is the trade protocol, so this is offer -> wait for the money
  // counteroffer -> accept (or cancel, when we only wanted the quote).
  async sellOne(merchantRef, item, confirm) {
    const c = this.need();
    const t = typeof merchantRef === 'object' && merchantRef !== null ? merchantRef : { id: Number(merchantRef) };
    const before = c.evSeq;
    await this.pacer.submit('trade', () => c.offer(t.id, [item.amount > 1 ? { id: item.id, amount: item.amount } : item.id]));
    // Wait for the COUNTEROFFER specifically: our own echo always lands first, and
    // listening for both makes every sale look like a refusal.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 });
    const countered = ev.events.find(e => e.kind === 'countered');
    const all = c.eventsSince(before);
    const said = all.filter(e => e.kind === 'said' && e.speaker === t.id).map(e => e.text);
    if (!countered) {
      await this.pacer.submit('trade', () => c.cancelOffer());
      return { sold: false, offered_price: null, merchant_said: said,
               note: said.length ? 'the merchant refused out loud' : 'no counteroffer came back' };
    }
    const price = (c.trade?.theirs || []).reduce((n, i) => n + (i.amount || 1), 0);
    if (!confirm) {
      await this.pacer.submit('trade', () => c.cancelOffer());
      return { sold: false, offered_price: price, merchant_said: said, note: 'quote only' };
    }
    await this.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(r => setTimeout(r, 1400));
    await this.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 4000 });
    return { sold: true, offered_price: price, merchant_said: said };
  }

  // Travel to another room, hop by hop, replanning at each arrival. Replanning per
  // hop rather than trusting the whole route up front matters because a conditional
  // edge exit's destination depends on where along the boundary we crossed, so the
  // room we actually land in is not always the one the plan named.
  async travel(toRoomNum, { maxHops = 25 } = {}) {
    const log = [];
    for (let i = 0; i < maxHops; i++) {
      const here = this.world.room;
      if (!here) return { arrived: false, log, reason: 'current room is not in the graph' };
      if (here.num === toRoomNum)
        return { arrived: true, room: { num: here.num, name: here.name }, hops: log.length, log };

      const route = this.world.route(toRoomNum);
      if (!route.found) return { arrived: false, log, reason: route.reason || 'no route' };
      const nextHop = route.hops[0];

      // A room often publishes SEVERAL squares for the same doorway — the Royal
      // Bank of Jasper lists two, and the first has a brazier standing on it.
      // Taking whichever came first in the file is a coin flip, so try them all.
      const candidates = this.world.exits().filter(e =>
        e.to === nextHop.to && e.kind === nextHop.kind);
      const exit = orderExits(candidates)[0];
      if (!exit)
        return { arrived: false, log, reason: 'cannot find the exit to ' + nextHop.to_name + ' from here' };

      const r = await this.leaveViaAny(candidates);
      // Never log an empty reason: a hop that fails without saying why is exactly the
      // silent failure this whole broker exists to avoid, so surface whatever stage
      // it got to.
      const why = r.reason || r.note ||
        (r.stage ? `failed while trying to ${r.stage}` +
                   (r.blocked_at ? ` (blocked at ${r.blocked_at.col},${r.blocked_at.row})` : '')
                 : 'no reason reported');
      // Log the square that actually worked, not the one we happened to try first —
      // otherwise a hop that succeeded on the second candidate reports the square
      // that refused.
      log.push({ from: here.name, to: nextHop.to_name, via: exit.kind, ok: r.left,
                 stand_on: (r.used_exit ?? exit).stand_on,
                 ...(r.tried?.length ? { also_tried: r.tried } : {}),
                 ...(r.left ? {} : { reason: why }) });
      if (!r.left) return { arrived: false, log, reason: why };

      // Arriving brings a fresh BP_PLAYER, and with it the identity the world model
      // needs; give the room contents a moment to land as well.
      await this.pacer.submit('read', () => this.client.roomContents());
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
    }
    return { arrived: false, log, reason: 'gave up after ' + maxHops + ' hops' };
  }
}

const session = name => {
  if (!sessions.has(name)) sessions.set(name, new Session(name));
  return sessions.get(name);
};

// ---------------------------------------------------------------- tools
//
// Shaped by what perception actually returns: every tool that acts on something
// takes the numeric object id that `look` reported, or a name to resolve against
// the room, because an agent thinks in names and the protocol only knows ids.

const num = (v, d) => (v === undefined || v === null ? d : Number(v));

function resolveTarget(s, arg) {
  const c = s.need();
  if (arg === undefined || arg === null) throw new Error('need a target id or name');
  if (typeof arg === 'number' || /^\d+$/.test(String(arg))) {
    const o = c.room.objects.get(Number(arg));
    // Not being in the room list is fine for inventory items.
    return o || c.inventory.find(i => i.id === Number(arg)) || { id: Number(arg) };
  }
  const hits = c.find(arg);
  if (!hits.length) {
    const inv = c.inventory.find(i => c.rsc.get(i.nameRsc).toLowerCase().includes(String(arg).toLowerCase()));
    if (inv) return inv;
    throw new Error(`nothing here matches "${arg}"`);
  }
  const me = c.self;
  if (me) hits.sort((a, b) => Math.hypot(a.col - me.col, a.row - me.row) - Math.hypot(b.col - me.col, b.row - me.row));
  return hits[0];
}

const TOOLS = [
  {
    name: 'join',
    description: 'Log a character into Meridian 59 and return where it is. Call this first. ' +
      'The character holds an ordinary player session — humans see it in `who` and the server ' +
      'validates everything it does.\n' +
      'WORKS AGAINST ANY SERVER, not just one on this machine. Everything this broker does is the ' +
      'ordinary client protocol on one TCP port, so pass host/port to play on someone else\'s ' +
      'server — or set M59_HOST/M59_PORT to point the whole broker at it. Each session may target a ' +
      'DIFFERENT host, so one broker can drive characters across several servers at once.\n' +
      'The one thing that is NOT remote is creating the account itself: the server\'s own ' +
      'registration opcode only files a form for a human to read, and accounts are made on the ' +
      'maintenance socket, which is unauthenticated and IP-restricted. So an operator has to issue ' +
      'you accounts; everything after that — building the character, playing it, all of it — is ' +
      'this protocol and needs nothing but the game port.',
    schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'name for this session in the broker; use the same one for every later call' },
        account: { type: 'string' },
        password: { type: 'string' },
        character: { type: 'string', description: 'which character on the account; defaults to the first' },
        host: { type: 'string', description: 'game server address; defaults to M59_HOST or 127.0.0.1' },
        port: { type: 'number', description: 'game server port; defaults to M59_PORT or 5959' },
      },
      required: ['agent', 'account', 'password'],
    },
    run: async (a) => {
      const s = session(a.agent);
      const r = await s.join(a);
      // Recorded only after the login actually succeeded, so a bad password never
      // ends up in the resume file to be retried on every future boot.
      //
      // The SESSION's credentials, not the ones we were handed: those have the host
      // and port resolved against M59_HOST/M59_PORT already. Persisting the caller's
      // undefined leaves an entry with no server of its own, which resumes against
      // whatever the environment happens to say months later — the failure this and
      // the per-fleet state file exist to prevent.
      rememberJoin(a.agent, s.credentials);
      // Asked for by name, so it is wanted again — clear any deliberate `leave` and
      // any accumulated backoff, or the reconciler would keep ignoring it.
      leftOnPurpose.delete(a.agent);
      rejoinState.delete(a.agent);
      listen(a.agent, s);
      return r;
    },
  },
  {
    name: 'look',
    description: 'THE call to make at the start of a turn. Returns everything known about where you ' +
      'are standing, joined into one state: your position and facing; health/mana/vigor; every object ' +
      'with its id, name, square, distance, and a "can" list of what the server will actually accept ' +
      'for it; whether each is reachable and how many steps away; every exit and which square to stand ' +
      'on to use it. Re-reads from the server unless cached=true.\n' +
      'PASS minimap:true FOR THE ROOM PICTURE — the walkability grid and wall map the human client ' +
      'draws. It is the only thing that answers "is that behind a wall" and "which way is out", but ' +
      'it is also two full ASCII renderings and runs to several thousand tokens in a big outdoor ' +
      'room, so it is off unless you ask.\n' +
      'Inert scenery — trees, dung, crop plants: things with no affordances at all — is tallied under ' +
      '`scenery` rather than listed. Everything you can act on, every player, and everything holding ' +
      'a quantity stays in `objects` IN FULL, however many there are, because a floor thick with ' +
      'corpse loot is exactly where a short list would get you killed.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      cached: { type: 'boolean', description: 'skip the server round-trip and report the last known state' },
      minimap: { type: 'boolean', description: 'default FALSE; set true for the room picture' } },
      required: ['agent'] },
    run: (a) => {
      const opts = { includeMinimap: a.minimap === true };
      return a.cached ? session(a.agent).view(opts) : session(a.agent).refresh(opts);
    },
  },
  {
    name: 'map',
    description: 'The room graph beyond what you can see: where you are in the world, every room this ' +
      'one connects to, and optionally a route to somewhere far away. Rooms can be named or numbered. ' +
      'Use this to decide where to go; use travel to actually go there.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      to: { type: ['string', 'number'], description: 'room name or number to route to' },
      search: { type: 'string', description: 'list rooms whose name matches this' } },
      required: ['agent'] },
    run: (a) => {
      const s = session(a.agent);
      s.need();
      if (!worldMap) throw new Error('no room graph loaded — build it with: node tools/m59-map.mjs build');
      if (a.search) {
        const low = String(a.search).toLowerCase();
        return { matches: Object.values(worldMap.rooms)
          .filter(r => r.name.toLowerCase().includes(low))
          .map(r => ({ num: r.num, name: r.name, size: { rows: r.rows, cols: r.cols } })).slice(0, 40) };
      }
      const here = s.world.room;
      const out = {
        here: here ? { num: here.num, name: here.name, size: { rows: here.rows, cols: here.cols } } : null,
        exits: s.world.exits(),
        world_rooms: Object.keys(worldMap.rooms).length,
      };
      if (a.to !== undefined) {
        const dest = resolveRoom(worldMap, a.to);
        if (dest == null) throw new Error(`no room matches "${a.to}"`);
        out.destination = { num: dest, name: worldMap.rooms[dest].name };
        out.route = s.world.route(dest);
      }
      return out;
    },
  },
  {
    name: 'travel',
    description: 'Go to another room, hop by hop, picking the right exit mechanism for each hop and ' +
      'replanning on arrival. Walking off a room edge and using a door are DIFFERENT actions and the ' +
      'wrong one produces silence, which is why this exists rather than leaving it to walk_to. ' +
      'Expect roughly one second per square walked, so a long trip genuinely takes minutes. ' +
      'Moving several characters? Pass background:true to each and poll `fleet` — otherwise you ' +
      'wait out every walk end to end, in series, for no reason.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      to: { type: ['string', 'number'], description: 'room name or number' },
      max_hops: { type: 'number' },
      background: { type: 'boolean', description: 'return at once and walk in the background; ' +
        'watch for it under `busy` in status/fleet, and the outcome under `last_action`' },
    }, required: ['agent', 'to'] },
    run: async (a) => {
      const s = session(a.agent);
      s.need();
      if (!worldMap) throw new Error('no room graph loaded — build it with: node tools/m59-map.mjs build');
      const dest = resolveRoom(worldMap, a.to);
      if (dest == null) throw new Error(`no room matches "${a.to}"`);
      const where = { num: dest, name: worldMap.rooms[dest].name };
      if (a.background) {
        s.startJob('travel', `walk to ${where.name}`,
                   () => s.travel(dest, { maxHops: num(a.max_hops, 25) }));
        const hops = s.world.route(dest)?.length ?? null;
        return { started: true, destination: where, hops,
                 note: 'walking now; poll `fleet` or `status` — do not re-issue while busy' };
      }
      const r = await s.travel(dest, { maxHops: num(a.max_hops, 25) });
      return { destination: { num: dest, name: worldMap.rooms[dest].name }, ...r, now: arrivalReport(s) };
    },
  },
  {
    name: 'go_through',
    description: 'Use ONE exit from this room — the neighbouring-room version of travel. Name the exit ' +
      'by its destination room, or by direction for an edge exit.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      to: { type: ['string', 'number'], description: 'destination room name or number' },
      direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      portal: { type: ['boolean', 'number'], description: 'use a portal object — true for the nearest, or its id. Where it leads is not knowable in advance.' } },
      required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent);
      s.need();
      const exits = s.world.exits();
      let candidates = [];
      if (a.to !== undefined && worldMap) {
        const dest = resolveRoom(worldMap, a.to);
        candidates = exits.filter(e => e.to === dest);
      }
      if (!candidates.length && a.direction) candidates = exits.filter(e => e.direction === a.direction);
      if (!candidates.length && a.portal)
        candidates = exits.filter(e => e.kind === 'portal' && (a.portal === true || e.id === Number(a.portal)));
      if (!candidates.length) return { left: false, reason: 'no such exit from here', exits };
      const r = await s.leaveViaAny(candidates);
      return { ...r, now: arrivalReport(s) };
    },
  },
  {
    name: 'look_at',
    description: 'The description of one object, by id or name — the prose a human would read.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, target: { type: ['string', 'number'] } }, required: ['agent', 'target'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const t = resolveTarget(s, a.target);
      await s.pacer.submit('look', () => c.look(t.id));
      const { events, timedOut } = await c.waitFor({ kinds: ['look'], timeoutMs: 4000 });
      const hit = events.find(e => e.id === t.id) || events[0];
      if (!hit) return { id: t.id, description: null,
                         note: timedOut ? 'no reply — the object may not be examinable (OF_NOEXAMINE)' : 'no description' };
      return { id: hit.id, what: hit.what, description: hit.description, inscription: hit.inscription };
    },
  },
  {
    name: 'say',
    description: 'TALK TO PEOPLE — every channel the game has, including private tells. Agents and ' +
      'humans share one world and this is the whole of how they reach each other.\n' +
      'Pick a channel with `type`:\n' +
      '  say        the room. The default.\n' +
      '  emote      the room, phrased as an action rather than speech.\n' +
      '  yell       the room AND the adjacent rooms in its yell zone — how you raise someone you ' +
      'cannot see.\n' +
      '  tell       ONE named player, privately, anywhere in the world. Set `to`.\n' +
      '  send       several named players at once, privately. Set `to` to a list.\n' +
      '  guild      everyone in your guild, wherever they are.\n' +
      '  broadcast  the entire server.\n' +
      'THE COSTS ARE REAL AND ARE PAID IN MANA: a tell or send costs one mana PER RECIPIENT and is ' +
      'refused outright if you have less than that; a broadcast costs a percentage of your maximum ' +
      'mana; the rest are free. Refusals arrive as PROSE, never as an error, so this tool reports ' +
      '`echoed` — the server\'s own echo of your line. echoed:null means it may not have gone out, ' +
      'and `messages` will usually say why.\n' +
      'To LISTEN, call wait_for_event: other people\'s speech arrives there as "said" events.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, text: { type: 'string' },
      type: { type: 'string',
              enum: ['say', 'yell', 'broadcast', 'emote', 'tell', 'send', 'guild'] },
      to: { description: 'recipient(s) for tell/send — player name or object id, or a list of them',
            type: ['string', 'number', 'array'], items: { type: ['string', 'number'] } },
    }, required: ['agent', 'text'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const type = a.type || 'say';
      const before = c.evSeq;

      // tell and send go out on a different opcode from the rest, and it carries
      // object ids rather than names, so the names have to be resolved first.
      if (type === 'tell' || type === 'send') {
        const wanted = [].concat(a.to ?? []);
        if (!wanted.length)
          throw new Error(`"${type}" needs \`to\` — who is it for? Use who to list everyone online.`);
        if (type === 'tell' && wanted.length > 1)
          throw new Error('"tell" is for one person; use type "send" for several');

        // Refresh the roster first: a name typed by an agent means nothing until
        // it is matched against who is actually logged on right now.
        await s.pacer.submit('read', () => c.players());
        await c.waitFor({ kinds: ['who'], timeoutMs: 3000 });
        const online = [...c.playersOnline.values()];
        const ids = [], unknown = [];
        for (const w of wanted) {
          const n = Number(w);
          const hit = Number.isFinite(n) && String(w).trim() !== ''
            ? online.find(p => p.id === n)
            : online.find(p => p.name && p.name.toLowerCase() === String(w).toLowerCase())
              ?? online.find(p => p.name && p.name.toLowerCase().includes(String(w).toLowerCase()));
          if (hit) ids.push(hit.id); else unknown.push(w);
        }
        if (!ids.length)
          return { spoken: null, as: type, echoed: null, unknown,
                   online: online.map(p => ({ id: p.id, name: p.name })),
                   note: 'nobody by that name is logged on, so there was nothing to send to' };

        // Re-read the cursor: the roster refresh above sat on the wire for a
        // moment, and anything that arrived during it is not a reply to this line.
        const sent = c.evSeq;
        await s.pacer.submit('say', () => c.sayGroup(ids, a.text));
        const { events } = await c.waitFor({ since: sent, kinds: ['said', 'message'],
                                            timeoutMs: 2500 });
        const mine = events.find(e => e.kind === 'said' && e.speaker === c.selfId);
        return { spoken: a.text, as: type,
                 to: ids.map(id => ({ id, name: c.playersOnline.get(id)?.name })),
                 ...(unknown.length ? { unknown } : {}),
                 echoed: mine ? mine.text : null,
                 messages: events.filter(e => e.text).map(e => e.text),
                 mana_cost: ids.length };
      }

      const kind = { say: 1, yell: 2, broadcast: 3, emote: 6, guild: 10 }[type];
      if (!kind) throw new Error(`unknown say type "${type}"`);
      await s.pacer.submit('say', () => c.say(a.text, kind));
      const { events } = await c.waitFor({ since: before, kinds: ['said', 'message'],
                                          timeoutMs: 2500 });
      const mine = events.find(e => e.kind === 'said' && e.speaker === c.selfId);
      return { spoken: a.text, as: type, say_type: kind, echoed: mine ? mine.text : null,
               messages: events.filter(e => e.text).map(e => e.text) };
    },
  },
  {
    name: 'walk_to',
    description: 'Walk to a square, routing around walls through the room geometry, one step per ' +
      'second — the pace a human client moves at. Coordinates are the col/row that look reports. ' +
      'Replans if a step lands somewhere unexpected, and returns arrived:false with a reason if the ' +
      'geometry says the square cannot be reached at all, which is cheaper than finding out by walking.\n' +
      'If it answers "no route through the geometry" for somewhere you can SEE a way to — a ledge, a ' +
      'narrow shelf, a cliff path — that is the square grid being too coarse to hold it, not the ' +
      'server refusing. Set fine:true (or turn on `movement_mode`) and it walks in fine coordinates ' +
      'instead, letting the server judge each step.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, col: { type: 'number' }, row: { type: 'number' },
      max_steps: { type: 'number' },
      fine: { type: 'boolean',
              description: 'ignore the square grid for this one call and walk in fine coordinates' },
      stride: { type: 'number', description: 'fine units to reach per step, default 48 of 64' },
    }, required: ['agent', 'col', 'row'] },
    run: (a) => {
      const s = session(a.agent);
      const fine = a.fine ?? s.fine;
      if (!fine) return s.walkTo(num(a.col), num(a.row), { maxSteps: num(a.max_steps, 30) });
      const half = KOD_FINENESS >> 1;
      return s.walkFine(num(a.col) * KOD_FINENESS + half, num(a.row) * KOD_FINENESS + half,
                        { maxSteps: num(a.max_steps, 120), stride: num(a.stride, 48) });
    },
  },
  {
    name: 'movement_mode',
    description: 'Turn FINE MOVEMENT on or off for this session.\n' +
      'Normally the broker paths on the room\'s square grid: one byte per square, eight direction ' +
      'bits, 64 fine units to the square. That grid cannot represent a walkable strip NARROWER than ' +
      'a square, so every ledge and cliff shelf in the world reads as solid rock and walk_to refuses ' +
      'without sending anything. Meridian has many such places — the only way into the Badlands is ' +
      'one of them.\n' +
      'With fine movement ON, walk_to stops consulting the grid and walks in fine coordinates, ' +
      'confirming each step against the server and sliding along the wall when a step is refused. ' +
      'That is what walking a ledge actually is.\n' +
      'The cost is that it is slower and dumber: no route planning, so it can walk into a dead end a ' +
      'map would have avoided, and on a cliff a refused step is the only thing between you and the ' +
      'drop. Leave it OFF for ordinary travel and turn it on for the hard yard.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      fine: { type: 'boolean', description: 'true to walk in fine coordinates from now on' },
    }, required: ['agent', 'fine'] },
    run: (a) => {
      const s = session(a.agent);
      s.need();
      s.fine = !!a.fine;
      return { fine_movement: s.fine,
               note: s.fine
                 ? 'walk_to now ignores the square grid and lets the server judge each step'
                 : 'walk_to now routes through the square grid again' };
    },
  },
  {
    name: 'approach',
    description: 'Walk to within `distance` squares of a target and turn to face it. This is the ' +
      'setup every melee action needs: out of range is refused with a message, and facing the wrong ' +
      'way is refused too.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, target: { type: ['string', 'number'] },
      distance: { type: 'number', description: 'squares; 1 is adjacent and safe for any weapon' },
      max_steps: { type: 'number', description: 'walk budget; defaults to the route length plus slack' } },
      required: ['agent', 'target'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const t = resolveTarget(s, a.target);
      const want = num(a.distance, 1);
      const away = () => { const me = c.self, o = c.room.objects.get(t.id);
                           return me && o ? Math.hypot(o.col - me.col, o.row - me.row) : Infinity; };

      let walk = null;
      if (away() > want) {
        const o = c.room.objects.get(t.id);
        if (!o) return { reason: 'target is not in the room' };
        // Route to a square ADJACENT to the target through the real geometry. You
        // cannot stand where a monster stands, and pushing straight at it stalls on
        // any wall between — which the geometry knows about and a sign-step does not.
        const spot = s.world.approachSquare(o.col, o.row);
        if (!spot) {
          walk = { arrived: false, reason: 'no walkable square next to the target is reachable from here' };
        } else {
          // Budget the walk by the ROUTE length, not by straight-line distance. A
          // target ten squares away can be seventy-five steps around a wall, and a
          // fixed cap turns that into a silent failure to move at all — which then
          // shows up as "too far away to hit" and looks like a range problem.
          walk = await s.walkTo(spot.col, spot.row, { maxSteps: num(a.max_steps, Math.max(30, spot.steps + 10)) });
        }
      }

      const o = c.room.objects.get(t.id);
      const faced = o ? await s.faceToward(o) : null;
      const d = away();
      return {
        target: o ? describeObject(o, c.lookup) : null,
        distance: d === Infinity ? null : Math.round(d),
        in_position: d !== Infinity && d <= Math.max(want, 1.5),
        facing_degrees: faced,
        walk,
      };
    },
  },
  {
    name: 'face',
    description: 'Turn to a compass bearing in degrees (0 east, 90 south, 180 west, 270 north) or ' +
      'toward a target. Facing matters: an attack on something behind you is refused.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, degrees: { type: 'number' }, target: { type: ['string', 'number'] } },
      required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      if (a.target !== undefined) {
        const deg = await s.faceToward(resolveTarget(s, a.target));
        return { facing_degrees: deg };
      }
      await s.pacer.submit('turn', () => c.face(num(a.degrees, 0)));
      return { facing_degrees: num(a.degrees, 0) };
    },
  },
  {
    name: 'attack',
    description: 'Swing at a target. Turns to face it first, then attacks, then reports what the ' +
      'server said. One attack per second is the server maximum, and this tool waits rather than ' +
      'letting a second swing be discarded. Only objects whose "can" list includes "attack" are ' +
      'legal targets.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, target: { type: ['string', 'number'] },
      swings: { type: 'number', description: 'repeat this many times, one per second' } },
      required: ['agent', 'target'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const t = resolveTarget(s, a.target);
      const rounds = Math.max(1, Math.min(num(a.swings, 1), 20));
      const log = [];
      for (let i = 0; i < rounds; i++) {
        const o = c.room.objects.get(t.id);
        if (!o) { log.push({ swing: i + 1, result: 'target is no longer here' }); break; }
        await s.faceToward(o);
        const before = c.evSeq;
        await s.pacer.submit('attack', () => c.attack(t.id), ATTACK_INTERVAL_MS);
        const { events } = await c.waitFor({ since: before, timeoutMs: 2500 });
        log.push({ swing: i + 1,
                   messages: events.filter(e => e.text).map(e => e.text),
                   events: events.filter(e => !e.text).map(e => e.kind) });
        if (events.some(e => e.kind === 'vanished' && e.id === t.id)) {
          log.push({ note: 'target vanished — killed, or it left' });
          break;
        }
      }
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
      return { target: t.id, swings: log, vitals: c.vitals() };
    },
  },
  {
    name: 'shop',
    description: 'Ask a seller what it sells, and optionally buy. Sellers have "buy" in their "can" ' +
      'list. Returns item ids and prices; pass buy_ids to purchase.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, seller: { type: ['string', 'number'] },
      buy_ids: { type: 'array', items: { type: 'number' } } }, required: ['agent', 'seller'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const t = resolveTarget(s, a.seller);
      await s.pacer.submit('buy', () => c.buy(t.id));
      const { events, timedOut } = await c.waitFor({ kinds: ['shop', 'message'], timeoutMs: 4000 });
      const shop = events.find(e => e.kind === 'shop');
      if (!shop) return { seller: t.id, items: [],
                          note: timedOut ? 'no reply' : events.map(e => e.text).filter(Boolean).join('; ') };
      if (!a.buy_ids?.length) return { seller: shop.sellerId, items: shop.items };
      const before = c.evSeq;
      await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, a.buy_ids));
      const after = await c.waitFor({ since: before, timeoutMs: 4000 });
      return { seller: shop.sellerId, bought: a.buy_ids,
               messages: after.events.filter(e => e.text).map(e => e.text),
               got: after.events.filter(e => e.kind === 'got').flatMap(e => e.items) };
    },
  },
  {
    name: 'trade',
    description:
      'Hand items or money to another PLAYER, or take what they are handing you. There is no ' +
      'one-sided give in this game — every transfer is a two-sided offer, and the sequence is ' +
      'fixed:\n' +
      '  offer     you propose. The other side then sees an "offered-to-us" event.\n' +
      '  counter   they reply, POSSIBLY WITH NOTHING — an empty counter is how a gift is accepted. ' +
      'Countering is what grants the OTHER side permission to accept, so a trade cannot complete ' +
      'until someone counters.\n' +
      '  accept    legal only after you have received a counteroffer. Accepting early is logged by ' +
      'the server as cheating and cancels the trade.\n' +
      '  cancel    either side, any time.\n' +
      '  status    what is currently on the table.\n' +
      'Both players must be in the SAME ROOM. Pass items as ids, or as {id, amount} to hand over ' +
      'PART of a stack — which is the only way to split money.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      action: { type: 'string', enum: ['offer', 'counter', 'accept', 'cancel', 'status'] },
      to: { type: ['string', 'number'], description: 'the other player, for action=offer' },
      items: { type: 'array', description: 'ids, or {id, amount} objects to give part of a stack',
               items: { type: ['number', 'object'] } },
    }, required: ['agent', 'action'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const items = (a.items || []).map(x =>
        (typeof x === 'object' && x !== null) ? { id: Number(x.id), amount: x.amount } : Number(x));

      if (a.action === 'status')
        return { trade: c.trade, note: c.trade ? undefined : 'no trade is open' };

      if (a.action === 'cancel') {
        await s.pacer.submit('trade', () => c.cancelOffer());
        return { cancelled: true };
      }

      if (a.action === 'offer') {
        const t = resolveTarget(s, a.to);
        if (t.id === c.selfId) throw new Error('cannot offer to yourself — the server refuses it');
        const before = c.evSeq;
        await s.pacer.submit('trade', () => c.offer(t.id, items));
        // BP_OFFERED coming back is the ONLY positive confirmation the offer landed;
        // every refusal path either says nothing or sends a plain message.
        const ev = await c.waitFor({ since: before, kinds: ['offer-sent', 'message', 'trade-ended'], timeoutMs: 4000 });
        const sent = ev.events.find(e => e.kind === 'offer-sent');
        return {
          offered: !!sent,
          on_the_table: sent ? sent.ours : [],
          messages: ev.events.filter(e => e.text).map(e => e.text),
          note: sent
            ? 'quantities here are what the server ACCEPTED — it silently clamps a stack amount to what you actually hold. Now wait for them to counter.'
            : 'no confirmation came back. Same room? Are either of you already in a trade?',
        };
      }

      if (a.action === 'counter') {
        const before = c.evSeq;
        await s.pacer.submit('trade', () => c.counterOffer(items));
        const ev = await c.waitFor({ since: before, kinds: ['counter-sent', 'trade-ended', 'message'], timeoutMs: 4000 });
        const sent = ev.events.find(e => e.kind === 'counter-sent');
        const ended = ev.events.find(e => e.kind === 'trade-ended');
        return {
          countered: !!sent && !ended,
          on_your_side: sent ? sent.ours : [],
          trade_ended: !!ended,
          messages: ev.events.filter(e => e.text).map(e => e.text),
          note: ended
            ? 'the trade ended instead — a duplicate item or an over-large stack amount in a counteroffer cancels it outright'
            : 'the other side may now accept',
        };
      }

      if (a.action === 'accept') {
        if (!c.trade?.mayAccept)
          return { accepted: false,
                   reason: 'you have not received a counteroffer, so accepting now would be rejected and would cancel the trade',
                   trade: c.trade };
        const before = c.evSeq;
        const carriedBefore = c.inventory.length;
        await s.pacer.submit('trade', () => c.acceptOffer());
        await new Promise(r => setTimeout(r, 1400));
        await s.pacer.submit('read', () => c.requestInventory());
        const ev = await c.waitFor({ since: before, kinds: ['inventory'], timeoutMs: 4000 });
        return {
          accepted: true,
          carried_before: carriedBefore,
          carried_after: c.inventory.length,
          inventory: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })),
          messages: ev.events.filter(e => e.text).map(e => e.text),
          note: 'the accepting side is told nothing on success — the inventory above is the evidence',
        };
      }

      throw new Error(`unknown trade action "${a.action}"`);
    },
  },
  {
    name: 'supply',
    description:
      'MOVE SUPPLIES FROM WHOEVER HAS THEM TO WHOEVER NEEDS THEM, in one call, between two characters ' +
      'this broker is driving.\n' +
      'This exists because `trade` is a two-sided protocol and both sides here are ours. Doing it by ' +
      'hand is four calls that must interleave correctly across two sessions — offer, counter, accept, ' +
      'and a read to prove it landed — and getting the order wrong is logged by the server as ' +
      'cheating. Worse, a half-finished trade is SILENT: the goods sit on the table looking handed ' +
      'over. This drives both ends and verifies the receiver actually holds them afterwards.\n' +
      'THE MOTIVATING CASE IS REAGENTS. `create food` consumes 2 ElderBerry and 2 Herbs FROM THE ' +
      'CASTER, and casting without them fails silently — so a quartermaster who knows the spell is ' +
      'useless until somebody hands it the ingredients. Farmers pick both up all day. `what=reagents` ' +
      'is the default for exactly that reason.\n' +
      'Someone has to walk: by default the GIVER does, because the receiver is usually mid-errand and ' +
      'the giver is usually a farmer with a full pack. Both must end up in the same room.',
    schema: { type: 'object', properties: {
      from: { type: 'string', description: 'agent handing things over' },
      to: { type: 'string', description: 'agent receiving them' },
      what: { type: ['string', 'array'],
              description: '"reagents" (default), "food", "all", or an array of object ids',
              items: { type: 'number' } },
      amount: { type: 'number', description: 'per reagent kind, default 2 of each — one casting' },
      who_travels: { type: 'string', enum: ['from', 'to', 'neither'],
                     description: 'default "from"' },
    }, required: ['from', 'to'] },
    run: async (a) => supplyBetween(a),
  },
  {
    name: 'split',
    description:
      'Work out a fair division of a pile of items between agents, and say who should end up with ' +
      'what. This computes the split only — carry it out with trade. Money stacks can be divided to ' +
      'the coin because an offer can name a partial amount; ordinary items cannot be cut, so they are ' +
      'dealt out to even the totals. Pass valuations if you know them (shop reports prices); with no ' +
      'values, items are treated as equal and dealt round-robin.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      between: { type: 'array', items: { type: 'string' },
                 description: 'names for the parties, e.g. ["alpha","beta"]. Defaults to two.' },
      items: { type: 'array', description: '{id, name?, amount?, value?} — amount marks a divisible stack',
               items: { type: 'object' } },
      weights: { type: 'array', items: { type: 'number' },
                 description: 'relative shares, default equal' },
    }, required: ['agent', 'items'] },
    run: (a) => {
      session(a.agent).need();
      const who = a.between?.length ? a.between : ['a', 'b'];
      const w = (a.weights?.length === who.length ? a.weights : who.map(() => 1));
      const wsum = w.reduce((x, y) => x + y, 0);
      const shares = who.map((n, i) => ({ who: n, share: w[i] / wsum, items: [], value: 0 }));

      // Divisible stacks first: these can be split exactly, so they are the free
      // variable that absorbs whatever unfairness the indivisible items create.
      const stacks = a.items.filter(i => i.amount > 1);
      const singles = a.items.filter(i => !(i.amount > 1));

      // Indivisible items: largest first into whoever is furthest below their share.
      // Not optimal — that is NP-hard — but it is stable, explainable, and an agent
      // can audit it, which matters more than optimality when the other party is
      // another agent deciding whether the deal was honest.
      const valued = singles.map(i => ({ ...i, value: Number(i.value ?? 1) }))
                            .sort((x, y) => y.value - x.value);
      const total = valued.reduce((n, i) => n + i.value, 0) +
                    stacks.reduce((n, i) => n + Number(i.value ?? 1) * i.amount, 0);
      for (const item of valued) {
        const target = shares.map(sh => ({ sh, deficit: sh.share * total - sh.value }))
                             .sort((x, y) => y.deficit - x.deficit)[0];
        target.sh.items.push({ id: item.id, name: item.name, value: item.value });
        target.sh.value += item.value;
      }
      // Now use the divisible stacks to close the remaining gaps.
      for (const st of stacks) {
        const unit = Number(st.value ?? 1);
        let left = st.amount;
        const order = shares.map(sh => ({ sh, deficit: sh.share * total - sh.value }))
                            .sort((x, y) => y.deficit - x.deficit);
        for (const { sh, deficit } of order) {
          if (left <= 0) break;
          const want = Math.max(0, Math.min(left, Math.round(deficit / unit)));
          if (want > 0) { sh.items.push({ id: st.id, name: st.name, amount: want, value: unit * want }); sh.value += unit * want; left -= want; }
        }
        // Anything still undealt goes proportionally, largest share first.
        let i = 0;
        while (left > 0) {
          const sh = shares[i % shares.length];
          sh.items.push({ id: st.id, name: st.name, amount: 1, value: unit });
          sh.value += unit; left--; i++;
        }
      }

      return {
        total_value: total,
        allocation: shares.map(sh => ({
          who: sh.who, target_share: Math.round(sh.share * 100) + '%',
          got_value: sh.value,
          got_share: total ? Math.round(100 * sh.value / total) + '%' : '0%',
          items: sh.items,
        })),
        note: 'to carry this out, whoever is holding an item uses trade with action=offer and the ' +
              'ids above; a partial stack goes as {id, amount}. Everything must happen in one room.',
      };
    },
  },
  {
    name: 'loot',
    description:
      'Pick up what is lying on the ground. When anything dies its treasure drops INTO THE ROOM at the ' +
      'square it died on, along with whatever it was carrying — there is no container to open, the items ' +
      'are simply on the floor and carry "get" in their "can" list. This walks into range of each and ' +
      'takes it.\n' +
      'Pickup range is Manhattan distance 7 (|drow| + |dcol| <= 7), far more generous than melee, so you ' +
      'rarely have to stand on a thing to take it. Two refusals to expect: a freshly killed PLAYER\'s ' +
      'belongings are reserved to the killer for 25 seconds, and you can only carry so much.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      only: { type: 'string', description: 'take only items whose name contains this' },
      ids: { type: 'array', items: { type: 'number' }, description: 'take exactly these; overrides only' },
      max_items: { type: 'number', description: 'default 12' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent);
      s.need();
      const r = await s.lootFloor({ only: a.only, ids: a.ids, maxItems: num(a.max_items, 12) });
      return { ...r, note: r.taken.length ? undefined
        : 'nothing on the floor here carries "get" — check look for objects whose can list includes get' };
    },
  },
  {
    name: 'sell',
    description:
      'Sell items to an NPC merchant. Selling is not a separate command — it IS the trade protocol: ' +
      'you offer the merchant your items, it counteroffers with MONEY, and you accept. That means you ' +
      'see the price BEFORE committing, so call with confirm=false to get a quote and nothing else.\n' +
      'A merchant only buys what it deals in, and it refuses by SPEAKING, so the reason arrives as ' +
      'said-text rather than as a system message. Both of you must be in the same room, and a merchant ' +
      'already serving another customer will say so.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      to: { type: ['string', 'number'], description: 'the merchant — one whose "can" list includes buy' },
      items: { type: 'array', items: { type: ['number', 'object'] },
               description: 'inventory ids, or {id, amount} for part of a stack' },
      confirm: { type: 'boolean', description: 'default true; false quotes the price and cancels' },
    }, required: ['agent', 'to', 'items'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const t = resolveTarget(s, a.to);
      const items = (a.items || []).map(x =>
        (typeof x === 'object' && x !== null) ? { id: Number(x.id), amount: x.amount } : Number(x));
      if (!items.length) throw new Error('nothing to sell');

      const before = c.evSeq;
      await s.pacer.submit('trade', () => c.offer(t.id, items));
      // Wait for the COUNTEROFFER specifically. waitFor resolves on the first
      // matching event, and our own `offer-sent` echo always arrives before the
      // merchant's reply — so listening for both together returns the echo and looks
      // exactly like a refusal. A merchant that declines does so by SPEAKING, so a
      // refusal is a `said` from that object, not a system message.
      const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 });
      const countered = ev.events.find(e => e.kind === 'countered');
      // Everything that landed in the meantime, for the report.
      const all = c.eventsSince(before);
      const speech = all.filter(e => e.kind === 'said' && e.speaker === t.id).map(e => e.text);
      const messages = all.filter(e => e.text && e.kind !== 'said').map(e => e.text);

      if (!countered) {
        // No money on the table means it declined. Leave nothing hanging.
        await s.pacer.submit('trade', () => c.cancelOffer());
        return { sold: false, offered_price: null,
                 merchant_said: speech, messages,
                 note: speech.length
                   ? 'the merchant refused — it only buys what it deals in, and it says so out loud'
                   : 'no counteroffer came back. Same room? Is it a buyer (can includes "buy")? Is it busy with someone else?' };
      }

      const price = (c.trade?.theirs || []).reduce((n, i) => n + (i.amount || 1), 0);
      if (a.confirm === false) {
        await s.pacer.submit('trade', () => c.cancelOffer());
        return { sold: false, quoted: c.trade?.theirs || [], offered_price: price,
                 merchant_said: speech,
                 note: 'quote only — the offer was cancelled and you still have the items' };
      }

      const carriedBefore = c.inventory.length;
      const b2 = c.evSeq;
      await s.pacer.submit('trade', () => c.acceptOffer());
      // The items move a beat after the accept lands. Reading inventory too early
      // reports the pre-sale stack, which makes a correct sale look like a no-op.
      await new Promise(r => setTimeout(r, 1400));
      await s.pacer.submit('read', () => c.requestInventory());
      const after = await c.waitFor({ since: b2, kinds: ['inventory'], timeoutMs: 4000 });
      return {
        sold: true,
        offered_price: price,
        received: c.trade?.theirs || [],
        carried_before: carriedBefore,
        carrying: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })),
        merchant_said: [...speech, ...after.events.filter(e => e.kind === 'said').map(e => e.text)],
        note: 'the accepting side is told nothing on success — the inventory above is the evidence',
      };
    },
  },
  {
    name: 'fight',
    description:
      'FIGHT SOMETHING, start to finish, in one call. Give it a creature name — a partial name is fine, ' +
      '"spider" finds "baby spider" — and it will: pick the nearest match, wield the best weapon you are ' +
      'carrying, walk to a square beside it through the real geometry, turn to face it (an attack on ' +
      'something behind you is REFUSED), swing on the server\'s one-per-second clock, read your health ' +
      'between every round, break off if you drop below the threshold, and pick up the drops if it dies.\n' +
      'This is the tool to use unless you specifically want to control the fight yourself. It reports ' +
      'every stage, so you can see what it did and do it differently next time.\n' +
      'It will NOT fight to the death: it disengages at 35% health by default and says so. Lower ' +
      'disengage_at only if you mean it — dying drops everything you carry.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      target: { type: 'string', description: 'creature name, partial is fine. Omit to take the nearest attackable thing.' },
      rounds: { type: 'number', description: 'max rounds of swings, default 12' },
      swings_per_round: { type: 'number', description: 'default 4; health is checked between rounds, not swings' },
      disengage_at: { type: 'number', description: 'health fraction to break off at, default 0.35' },
      loot: { type: 'boolean', description: 'pick up the drops afterwards, default true' },
      equip: { type: 'boolean', description: 'wield the best weapon first, default true' },
    }, required: ['agent'] },
    run: (a) => skills.fight(session(a.agent), {
      target: a.target,
      rounds: num(a.rounds, 12),
      swingsPerRound: num(a.swings_per_round, 4),
      disengageAt: a.disengage_at === undefined ? undefined : Number(a.disengage_at),
      loot: a.loot !== false,
      equip: a.equip !== false,
    }),
  },
  {
    name: 'rest_up',
    description:
      'Sit down and recover, then stand. Blocks until health and vigor come back or nothing is improving ' +
      'any more. Resting is SILENT in this game — no message confirms it is working — so this watches the ' +
      'numbers instead, and tells you if they stop moving (some rooms prevent rest, and you may simply be ' +
      'at your ceiling). Do this away from whatever you were fighting; a monster you broke off from is ' +
      'still hostile and will keep hitting you while you sit.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      to: { type: 'number', description: 'fraction of max to reach, default 0.9' },
      max_seconds: { type: 'number', description: 'default 120' },
    }, required: ['agent'] },
    run: (a) => skills.restUntil(session(a.agent), {
      health: num(a.to, 0.9), vigor: num(a.to, 0.9), maxSeconds: num(a.max_seconds, 120),
    }),
  },
  {
    name: 'equip_best',
    description:
      'Wield the best weapon in your inventory. An empty hand still fights — the game falls back to ' +
      'punching — but badly, so this is worth doing before anything dangerous. Reports what it considered.',
    schema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    run: (a) => skills.equipBest(session(a.agent)),
  },
  {
    name: 'escape_underworld',
    description:
      'Get out of the Underworld, which is where you wake up after dying and which has NO exits in the ' +
      'room graph. The way out is a portal you walk onto.\n' +
      'Five portals stand in a pentagram with fixed destinations, each DEAD until its brazier is lit. A ' +
      'sixth, the "rip in space", changes destination every 5-10 seconds and only tells you where it ' +
      'currently leads if you LOOK at it — in prose naming an inn, not a city ("the bustling bar of ' +
      'Familiars" is Tos).\n' +
      'Pass a city to wait by the shifting portal for that destination and step on at the right moment. ' +
      'Pass nothing to take whichever portal works.\n' +
      'THIS IS FOR GETTING OUT OF THE UNDERWORLD AFTER DYING. IT IS NOT A WAY TO LEAVE ANYWHERE ELSE. ' +
      'Dying is never a travel mechanism and never a solution to being stuck: it costs a point of ' +
      'maximum health permanently (player.kod:8247) and drops everything you carry on a corpse. In ' +
      'particular it has NOTHING to do with leaving the newbie zone — see `leave_raza`.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      city: { type: 'string', enum: ['Tos', 'Marion', 'Jasper', 'Cornoth', 'Barloque', "Ko'catan"],
              description: 'wait for this destination on the shifting portal' },
      max_seconds: { type: 'number', description: 'how long to wait for it, default 180' },
    }, required: ['agent'] },
    run: (a) => skills.escapeUnderworld(session(a.agent), { city: a.city, maxSeconds: num(a.max_seconds, 180) }),
  },
  {
    name: 'sell_all',
    description:
      'Sell everything a merchant will take, keeping your money and anything weapon-like. Quotes each ' +
      'item first and skips the ones the merchant refuses, so a refusal costs you nothing. Merchants only ' +
      'deal in certain things — use the merchants tool to find one that wants what you are carrying.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      merchant: { type: ['string', 'number'], description: 'the merchant, by id or name' },
      keep: { type: 'array', items: { type: 'string' }, description: 'name fragments to hold back' },
      min_price: { type: 'number', description: 'skip anything worth less than this, default 1' },
    }, required: ['agent', 'merchant'] },
    run: async (a) => {
      const s = session(a.agent);
      const t = resolveTarget(s, a.merchant);
      return skills.sellAll(s, { merchant: t, keep: a.keep || [], minPrice: num(a.min_price, 1) });
    },
  },
  {
    name: 'autopilot',
    description:
      'Hand baseline upkeep to a background loop so the character stays alive between your calls.\n' +
      'The server runs at one action per second and a fight takes half a minute; you think in bursts and ' +
      'then are gone. The autopilot fills the gap. It contains no language model — it makes only the ' +
      'mechanical decisions — and it journals everything with a reason, so you can read what happened and ' +
      'take over whenever you like.\n' +
      'Modes:\n' +
      '  survive  rest when hurt and safe, withdraw when losing, escape the Underworld if killed. ' +
      'Never starts a fight.\n' +
      '  farm     the above, plus repeatedly hunt ONE named creature and loot it. Set policy.hunt.\n' +
      '  idle     upkeep only, no work.\n' +
      'SAFE SPOTS ARE THE DEFAULT, not an emergency measure. In a working safe spot nothing can hit ' +
      'the character unless it swings first, so it takes one before any fight worth fighting — the ' +
      'test being the game\'s own advancement rule, that a kill only pays when the creature is at or ' +
      'above your level. It proves the spot by standing in it (status.safe_spot.works is evidence, not ' +
      'geometry), remembers which squares held and which did not across sessions, breaks off by ' +
      'STOPPING rather than running, rests to full with monsters standing next to it, and reconnects ' +
      'before stepping out of a crowded one so the swarm has to notice it one at a time.\n' +
      'Call with action=status to read the journal. It will not fight anything you did not name.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      action: { type: 'string', enum: ['start', 'stop', 'status', 'list'] },
      mode: { type: 'string', enum: ['survive', 'farm', 'idle'] },
      hunt: { type: 'string', description: 'creature name for farm mode — required, never guessed' },
      rest_below: { type: 'number', description: 'rest when a vital drops under this fraction, default 0.7' },
      flee_below: { type: 'number', description: 'withdraw under this fraction, default 0.4' },
      max_carry: { type: 'number', description: 'stop farming at this many items, default 14' },
      roam: { type: 'boolean', description: 'when the room is cleared, move to a neighbouring one instead of waiting for respawns. Off by default because it changes where the character is.' },
      roam_limit: { type: 'number', description: 'how many rooms it may wander before stopping, default 6' },
      strategy: { type: 'string', enum: ['baseline', 'wellfed', 'fieldrest', 'trader', 'coop'],
        description: 'which farming pattern to run. These exist to be compared against each other: ' +
          'the ledger records the strategy with every sample, so `history` reports max health gained ' +
          'per hour by strategy rather than anyone having to argue about which ought to work. ' +
          'baseline is the control' },
      fight_above_vigor: { type: 'number',
        description: 'eat until vigor reaches this before picking a fight. Resting alone tops out at ' +
          'the rest threshold of 80 out of 200; above that only food will do it, and vigor is what ' +
          'sets the health regeneration rate' },
      use_safe_spots: { type: 'boolean',
        description: 'fight from a wall whenever the kill would pay (default true). Turning this off ' +
          'gives up the largest survival advantage in the game and is almost never right' },
      hold_resume_above: { type: 'number',
        description: 'in a safe spot, top up to this fraction of health before swinging again, ' +
          'default 0.9. Stopping costs nothing there, so there is no reason to fight hurt' },
      pull_within: { type: 'number',
        description: 'how many steps it may go to fetch a monster that will not come to the wall, ' +
          'default 8. It hits it once and walks straight back' },
      break_out_via_logoff: { type: 'boolean',
        description: 'reconnect before stepping off a crowded safe spot, default true. The entry ' +
          'grace period means the swarm has to notice you one at a time instead of all at once' },
      full_journal: { type: 'boolean', description: 'return the whole journal, not just the tail' },
    }, required: ['agent', 'action'] },
    run: (a) => {
      if (a.action === 'list') return { autopilots: allAutopilots() };
      const s = session(a.agent);
      s.need();
      const p = autopilotFor(s);
      if (a.action === 'status') return p.status({ full: !!a.full_journal });
      if (a.action === 'stop') return p.stop();
      if (a.mode) {
        if (!MODES.includes(a.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
        p.mode = a.mode;
      }
      if (a.hunt !== undefined) p.policy.hunt = a.hunt;
      if (a.rest_below !== undefined) p.policy.restBelow = Number(a.rest_below);
      if (a.flee_below !== undefined) p.policy.fleeBelow = Number(a.flee_below);
      if (a.max_carry !== undefined) p.policy.maxCarry = Number(a.max_carry);
      if (a.roam !== undefined) p.policy.roam = !!a.roam;
      if (a.roam_limit !== undefined) p.policy.roamLimit = Number(a.roam_limit);
      if (a.strategy !== undefined) {
        if (!STRATEGIES[a.strategy])
          throw new Error(`strategy must be one of ${Object.keys(STRATEGIES).join(', ')}`);
        p.policy.strategy = a.strategy;
        // Adopt the pattern's own settings, but never override something the caller
        // asked for explicitly in the same call — an explicit argument is a decision
        // and the strategy is only a default.
        const plan = STRATEGIES[a.strategy];
        if (a.fight_above_vigor === undefined) p.policy.fightAboveVigor = plan.fightAboveVigor ?? 0;
        if (a.max_carry === undefined && plan.maxCarry) p.policy.maxCarry = plan.maxCarry;
      }
      if (a.fight_above_vigor !== undefined) p.policy.fightAboveVigor = Number(a.fight_above_vigor);
      if (a.use_safe_spots !== undefined) p.policy.useSafeSpots = !!a.use_safe_spots;
      if (a.hold_resume_above !== undefined) p.policy.holdResumeAbove = Number(a.hold_resume_above);
      if (a.pull_within !== undefined) p.policy.pullWithin = Number(a.pull_within);
      if (a.break_out_via_logoff !== undefined) p.policy.breakOutViaLogoff = !!a.break_out_via_logoff;
      if (p.mode === 'farm' && !p.policy.hunt)
        return { started: false, reason: 'farm mode needs something to hunt — pass hunt with a creature name' };
      // Persist the instruction, not the running object: on the far side of a
      // restart the keeper is rebuilt from these fields alone.
      rememberAutopilot(a.agent, { mode: p.mode, policy: { ...p.policy } });
      return p.start();
    },
  },
  {
    name: 'spells',
    description:
      'What you can cast, what it costs, and — when you cannot — WHY.\n' +
      'Almost none of this is in the protocol. The server tells you a spell\'s name, how many targets ' +
      'it takes and which school it belongs to, and nothing else: not the mana, not the reagents it ' +
      'consumes, not the karma it demands. Those are compiled from the game\'s source and joined here ' +
      'with what your character actually knows and carries.\n' +
      'KARMA IS THE TRAP. Qor spells require karma at or BELOW level x -10; Shal\'ille spells require ' +
      'karma at or ABOVE level x +10. Karma runs -100..+100. So a neutral character at karma 0 can cast ' +
      'NEITHER school at all, and moving toward one locks the other harder — what you fight is what ' +
      'you become.\n' +
      'HOW KARMA ACTUALLY MOVES, because the obvious reading is wrong. A kill is scored as an ACT ' +
      'worth the NEGATIVE of the victim\'s karma, and CalculateKarmaChangeFromAct (player.kod:6491) ' +
      'then returns ZERO whenever you are already further from neutral than the act is: a good ' +
      'character doing a lesser good, or an evil one doing a lesser evil, changes nothing at all. So ' +
      'killing karma -30 spiders moves you toward +30 and NO FURTHER — at karma 50 they are worth ' +
      'exactly nothing. To keep climbing you need acts worth more than your current karma: nastier ' +
      'victims, or the Shal\'ille healing spells, which score as good acts too. Two more gates: the ' +
      'change is 0 for NEUTRAL monsters, in arenas, and in the newbie region, and it is scaled by a ' +
      'swing factor that is deliberately SMALLER (2 rather than 6) while you are moving back toward ' +
      'neutral.\n' +
      'With no arguments this lists what you know and marks each castable or not, with the reason.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      show: { type: 'string', description: 'one spell by name or number, whether or not you know it' },
      reagent: { type: 'string', description: 'which spells consume an item matching this' },
      school: { type: 'string', description: 'filter to a school: shalille, qor, kraanan, faren, riija, jala' },
      all: { type: 'boolean', description: 'every spell in the game, not just the ones you know' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      if (!spellCatalogue)
        throw new Error('no spell catalogue — build it with: node tools/m59-spells.mjs build');
      const all = spellCatalogue.spells;
      const byNum = new Map(all.map(x => [x.num, x]));

      if (a.reagent) {
        const q = String(a.reagent).toLowerCase();
        return { spells: all.filter(x => x.reagents.some(r => r.item.toLowerCase().includes(q)))
          .map(x => ({ name: x.name, school: x.school_name, level: x.level, mana: x.mana,
                       reagents: x.reagents.map(r => `${r.count} x ${r.item}`), required_karma: x.required_karma })) };
      }

      if (a.show) {
        const q = String(a.show).toLowerCase();
        const hit = all.find(x => x.name === q) ||
                    all.find(x => x.name.includes(q) || x.cls.toLowerCase().includes(q) || String(x.num) === q);
        if (!hit) return { found: false, note: `no spell matches "${a.show}"` };
        return {
          name: hit.name, number: hit.num, school: hit.school_name, level: hit.level,
          mana: hit.mana, min_hit_points: hit.min_hit_points || undefined,
          reagents: hit.reagents.map(r => `${r.count} x ${r.item}`),
          required_karma: hit.required_karma,
          karma_note: hit.required_karma === 0 ? 'no karma requirement'
            : hit.required_karma > 0 ? `you must be at least +${hit.required_karma} karma (good)`
                                     : `you must be at most ${hit.required_karma} karma (evil)`,
          prerequisites: hit.prerequisites,
          // A per-spell CanPayCosts is an arbitrary extra rule, like a merchant's
          // ObjectDesired. No table can hold it, so it is handed over as source.
          extra_rule: hit.extra_cost_rule ? { source: hit.file, kod: hit.extra_cost_rule } : null,
        };
      }

      // Refresh what the character knows and is carrying, plus karma, which lives in
      // stat group 2 slot 7 and does arrive over the wire.
      await s.pacer.submit('read', () => c.requestSpells());
      await s.pacer.submit('read', () => c.requestInventory());
      await s.pacer.submit('read', () => c.stats(2));
      await new Promise(r => setTimeout(r, 700));

      const karma = c.stat('karma');
      const mana = c.vitals().mana;
      const carrying = new Map();
      for (const o of c.inventory) {
        const n = c.rsc.get(o.nameRsc).toLowerCase();
        carrying.set(n, (carrying.get(n) || 0) + (o.amount || 1));
      }
      // Reagent classes are kod class names (Herbs, ShamanBlood); inventory gives
      // display names ("herb", "shaman blood"). Match loosely and say when unsure.
      const haveReagent = cls => {
        const want = cls.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        for (const [name, n] of carrying)
          if (name.includes(want) || want.includes(name)) return n;
        return 0;
      };

      // JOINING THE TWO HALVES. BP_SPELLS carries the spell's runtime OBJECT id, not
      // its SID_ number, so the catalogue cannot be looked up by id at all. Names are
      // the only shared key, and they do not all agree — the Jala buffs are called
      // "vigor effect" on the wire and something else in the constants — so the join
      // is layered and says plainly when it fails rather than dropping the spell.
      const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
      const byName = new Map(), byNorm = new Map();
      for (const x of all) {
        byName.set(x.name.toLowerCase(), x);
        byNorm.set(norm(x.name), x);
        byNorm.set(norm(x.cls), x);
      }
      const mineJoined = (c.spells || []).map(o => {
        const name = c.rsc.get(o.nameRsc);
        const info = byName.get(name.toLowerCase()) ?? byNorm.get(norm(name)) ?? null;
        return { objId: o.id, name, wireTargets: o.numTargets, wireSchool: o.school + 1, info };
      });
      const knownNums = new Set(mineJoined.filter(m => m.info).map(m => m.info.num));

      let list = a.all ? all : all.filter(x => knownNums.has(x.num));
      if (a.school) list = list.filter(x => (x.school_name || '').toLowerCase().includes(String(a.school).toLowerCase()));

      const rows = list.map(x => {
        const reasons = [];
        // The wire's school is authoritative where the source did not resolve one —
        // several DM spells declare theirs in a way the compile step cannot read.
        const live = mineJoined.find(m => m.info?.num === x.num);
        const school = x.school ?? live?.wireSchool ?? null;
        if (karma != null && school != null && !karmaAllows(school, x.level ?? 0, karma))
          reasons.push(`karma ${karma}, needs ${x.required_karma > 0 ? '>= +' : '<= '}${x.required_karma}`);
        if (x.mana != null && mana && mana.value < x.mana) reasons.push(`mana ${mana.value}/${x.mana}`);
        for (const r of x.reagents) {
          const got = haveReagent(r.item);
          if (got < r.count) reasons.push(`needs ${r.count} x ${r.item}, carrying ${got}`);
        }
        if (!a.all && !knownNums.has(x.num)) reasons.push('not learned');
        return {
          name: x.name, number: x.num,
          school: x.school_name ?? (school != null ? SCHOOLS[school] : null),
          level: x.level, mana: x.mana,
          targets: live?.wireTargets,
          reagents: x.reagents.map(r => `${r.count} x ${r.item}`),
          required_karma: x.required_karma || undefined,
          castable: reasons.length === 0,
          blocked_by: reasons.length ? reasons : undefined,
          has_extra_rule: x.extra_cost_rule ? true : undefined,
        };
      });

      // Spells the server says you have but the catalogue could not identify. Listed
      // rather than hidden: an agent should know its knowledge has a hole in it.
      const unmatched = mineJoined.filter(m => !m.info)
        .map(m => ({ name: m.name, school: SCHOOLS[m.wireSchool] ?? m.wireSchool, targets: m.wireTargets }));

      return {
        your_karma: karma, your_mana: mana,
        known_spells: mineJoined.length,
        identified: mineJoined.length - unmatched.length,
        castable_now: rows.filter(r => r.castable).length,
        spells: rows.sort((x, y) => (y.castable ? 1 : 0) - (x.castable ? 1 : 0) || (x.level ?? 9) - (y.level ?? 9)),
        ...(unmatched.length ? { costs_unknown: unmatched,
          note_unmatched: 'the server says you know these but the catalogue has no cost data for them — ' +
                          'their names differ between the wire and the source. Casting them still works; ' +
                          'you just cannot be told in advance what they need.' } : {}),
        note: 'castable means karma, mana and reagents all check out. A spell may still refuse for a ' +
              'reason of its own — many override CanPayCosts; ask with show to read that rule.',
      };
    },
  },
  {
    name: 'cast',
    description:
      'Cast a spell you know, by name. Checks first whether you can actually afford it — karma, mana ' +
      'and reagents — and refuses with the reason rather than spending the attempt, because a refused ' +
      'cast is often SILENT. Reagents are consumed on a successful cast.\n' +
      'Spells with one target need one; pass a creature or player name and it will be resolved and ' +
      'faced first, since a single-target spell obeys the same view rule as a melee swing.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      spell: { type: 'string', description: 'spell name, partial is fine' },
      target: { type: ['string', 'number'], description: 'who or what to aim it at' },
      force: { type: 'boolean', description: 'send it even if the affordability check says no' },
    }, required: ['agent', 'spell'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      await s.pacer.submit('read', () => c.requestSpells());
      await new Promise(r => setTimeout(r, 500));
      const q = String(a.spell).toLowerCase();
      const cat = spellCatalogue?.spells ?? [];
      const known = (c.spells || []).map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), targets: o.numTargets }));
      const mine = known.find(k => k.name.toLowerCase() === q) || known.find(k => k.name.toLowerCase().includes(q));
      if (!mine)
        return { cast: false, reason: `you do not know a spell matching "${a.spell}"`,
                 you_know: known.map(k => k.name) };
      // mine.id is the runtime OBJECT id — which is exactly what BP_REQ_CAST wants —
      // but the catalogue is keyed by SID, so the cost lookup goes by name.
      const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
      const info = cat.find(x => x.name.toLowerCase() === mine.name.toLowerCase())
                ?? cat.find(x => norm(x.name) === norm(mine.name) || norm(x.cls) === norm(mine.name))
                ?? null;

      if (!a.force && info) {
        const karma = c.stat('karma');
        if (karma != null && !karmaAllows(info.school, info.level ?? 0, karma))
          return { cast: false, reason: `your karma is ${karma}; ${info.name} needs ` +
                   `${info.required_karma > 0 ? '>= +' : '<= '}${info.required_karma}`,
                   note: 'karma is not something you can set — it moves when you kill, by the negative of your victim\'s karma' };
        const mana = c.vitals().mana;
        if (info.mana != null && mana && mana.value < info.mana)
          return { cast: false, reason: `${info.name} costs ${info.mana} mana, you have ${mana.value}` };
      }

      let targets = [];
      if (a.target !== undefined) {
        const t = resolveTarget(s, a.target);
        targets = [t.id];
        const o = c.room.objects.get(t.id);
        if (o) await s.faceToward(o);
      } else if (mine.targets > 0) {
        return { cast: false, reason: `${mine.name} needs ${mine.targets} target(s) — pass one`,
                 note: 'target counts come from the server, in BP_SPELLS' };
      }

      const before = c.evSeq;
      await s.pacer.submit('cast', () => c.cast(mine.id, targets), ATTACK_INTERVAL_MS);
      const unpriced = !info;
      const ev = await c.waitFor({ since: before, timeoutMs: 4000 });
      const messages = ev.events.filter(e => e.text).map(e => e.text);
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
      return {
        cast: true, spell: mine.name, targets,
        messages,
        vitals: c.vitals(),
        ...(unpriced ? { costs_unknown: true,
          note_costs: 'the catalogue has no entry for this one, so it was sent without an affordability check' } : {}),
        // Silence is genuinely ambiguous here: `create weapon` succeeds and says
        // nothing at all, putting a sword in your hands without comment, while a
        // refusal the spell decided for itself is equally quiet. So do not guess —
        // say what to look at.
        note: messages.length ? undefined
          : 'no message came back, which does NOT mean it failed — several spells succeed silently ' +
            '(create weapon just adds the sword). Compare inventory and vitals before and after. ' +
            'A cast also shares the one-per-second timer with attacks.',
      };
    },
  },
  {
    name: 'merchants',
    description:
      'Find a merchant: who sells a thing, who teaches a spell or skill, who might buy your loot, ' +
      'and which room each is in. Merchants are picky and the pickiness is NOT in the protocol — ' +
      'each one decides in a kod method called ObjectDesired, so this returns that rule as source ' +
      'text rather than pretending it is a flag. Read it: "buys reagents but not gems" is a thing a ' +
      'rule can say and a flag cannot.\n' +
      'Buying a spell or skill is the same shop transaction as buying an item — that is how a ' +
      'character learns anything.\n' +
      'The catalogue narrows the search; it is not an oracle. The certain test is sell with ' +
      'confirm:false, which quotes a real price without committing.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      sells: { type: 'string', description: 'find merchants stocking items matching this' },
      teaches: { type: 'string', description: 'find merchants teaching a spell or skill matching this' },
      buys: { type: 'string', description: 'find merchants whose buying RULE mentions this (may be an exclusion)' },
      show: { type: ['string', 'number'], description: 'one merchant by class name or room number' },
      here: { type: 'boolean', description: 'just the merchants in this room' },
    }, required: ['agent'] },
    run: (a) => {
      const s = session(a.agent), c = s.need();
      if (!merchantCatalogue)
        throw new Error('no merchant catalogue — build it with: node tools/m59-merchants.mjs build');
      const all = merchantCatalogue.merchants;
      const roomName = n => worldMap?.rooms?.[n]?.name ?? null;
      const brief = m => ({
        merchant: m.cls, room: m.room, room_name: roomName(m.room),
        sells: m.sells.map(x => x.cls + (x.quantity > 1 ? ` x${x.quantity}` : '')),
        teaches: m.teaches.map(t => t.spell || t.skill || `#${t.num}`),
      });

      if (a.here) {
        const room = s.world.room;
        const inRoom = room ? all.filter(m => m.room === room.num) : [];
        // The catalogue is keyed by room; the ids in it are from build time and a
        // `save game` renumbers objects, so take live ids from what we can see.
        const visible = [...c.room.objects.values()].filter(o => o.flags & OF.BUYABLE);
        return {
          room: room ? { num: room.num, name: room.name } : null,
          here: visible.map(o => {
            const cat = inRoom.find(m => c.rsc.get(o.nameRsc) && true) || inRoom[0];
            return { id: o.id, name: c.rsc.get(o.nameRsc), ...(cat ? brief(cat) : {}) };
          }),
          note: visible.length ? 'ids above are live and usable with shop and sell' : 'nobody here buys or sells',
        };
      }

      if (a.show !== undefined) {
        const q = String(a.show).toLowerCase();
        const m = all.find(x => x.cls.toLowerCase().includes(q) || String(x.room) === q);
        if (!m) return { found: false, note: `no merchant matches "${a.show}"` };
        return {
          ...brief(m),
          markup: m.markup,
          buying_rule: m.buying_rule
            ? { source: m.buying_rule.source, kod: m.buying_rule.kod }
            : null,
          buys_anything: m.buys_anything,
          note: m.buying_rule
            ? 'the rule above is the actual code that decides; read it rather than guessing'
            : 'no override — inherits the default, which considers anything',
        };
      }

      if (a.teaches) {
        const q = String(a.teaches).toLowerCase();
        const hits = all.filter(m => m.teaches.some(t =>
          (t.spell || '').includes(q) || (t.skill || '').includes(q) || String(t.num) === q));
        return { matches: hits.map(m => ({ ...brief(m),
          teaching: m.teaches.filter(t => (t.spell || '').includes(q) || (t.skill || '').includes(q) || String(t.num) === q) })),
          note: 'buy it the same way you would buy an item — shop, then buy_ids' };
      }

      if (a.sells) {
        const q = String(a.sells).toLowerCase();
        const hits = all.filter(m => m.sells.some(x => (x.cls || '').toLowerCase().includes(q)));
        return { matches: hits.map(brief) };
      }

      if (a.buys) {
        const q = String(a.buys).toLowerCase();
        const hits = all.filter(m => m.buying_rule?.kod.toLowerCase().includes(q));
        return {
          rules_mentioning: hits.map(m => {
            const line = (m.buying_rule.kod.split(/\r?\n/).find(l => l.toLowerCase().includes(q)) || '').trim();
            return { merchant: m.cls, room: m.room, room_name: roomName(m.room),
                     line, excludes_it: /\bNOT\b/i.test(line) };
          }),
          buys_anything: all.filter(m => m.buys_anything).slice(0, 20).map(m =>
            ({ merchant: m.cls, room: m.room, room_name: roomName(m.room) })),
          note: 'MENTIONING is not accepting — a rule often names a thing in order to refuse it, ' +
                'so check excludes_it. The certain test is sell with confirm:false.',
        };
      }

      return { merchants: all.length,
               with_stock: all.filter(m => m.sells.length).length,
               teaching: all.filter(m => m.teaches.length).length,
               note: 'pass sells, teaches, buys, show, or here' };
    },
  },
  {
    name: 'inventory',
    description: 'What the character is carrying, with ids usable by use/drop/offer/apply.',
    schema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
      return { items: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc),
                                              amount: o.amount || undefined, can: affordances(o.flags) })) };
    },
  },
  {
    name: 'act',
    description: 'One-shot object interactions: use (wield/wear), unuse, get (pick up), drop, ' +
      'activate, or go (take the exit under your feet — doors and stairs need this, walking off the ' +
      'edge of an outdoor room does not).',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      verb: { type: 'string', enum: ['use', 'unuse', 'get', 'drop', 'activate', 'go'] },
      target: { type: ['string', 'number'] } }, required: ['agent', 'verb'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const before = c.evSeq;
      if (a.verb === 'go') {
        await s.pacer.submit('move', () => c.go(), MOVE_INTERVAL_MS);
      } else {
        const t = resolveTarget(s, a.target);
        const fn = { use: () => c.use(t.id), unuse: () => c.unuse(t.id), get: () => c.get(t.id),
                     drop: () => c.drop([t.id]), activate: () => c.activate(t.id) }[a.verb];
        if (!fn) throw new Error(`unknown verb "${a.verb}"`);
        await s.pacer.submit(a.verb, fn);
      }
      const { events } = await c.waitFor({ since: before, timeoutMs: 3000 });
      return { verb: a.verb, messages: events.filter(e => e.text).map(e => e.text),
               events: events.map(e => e.kind) };
    },
  },
  {
    name: 'rest',
    description: 'Sit down to recover vigor, or stand up again. Vigor gates running and some skills; ' +
      'the server snaps a character back if it tries to run without it.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' }, stand: { type: 'boolean' } }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      await s.pacer.submit('rest', () => (a.stand ? c.stand() : c.rest()));
      await new Promise(r => setTimeout(r, 400));
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
      return { resting: !a.stand, vitals: c.vitals() };
    },
  },
  {
    name: 'status',
    description: 'Health, mana, vigor, attributes, position, what spells and skills you know, and how ' +
      'many requests the broker still has queued for this session.\n' +
      'max_health IS your level — every other system compares monsters against it (AdvancementCheck, ' +
      'player.kod:7736). The six attributes run 1..50 and are fixed at character creation; they never ' +
      'improve from play, so a character that starts with nothing stays that way.\n' +
      'This lists what you KNOW. For HOW GOOD you are at each one, call `abilities` — those numbers are ' +
      'the progress signal, and they are not here.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      brief: { type: 'boolean', description: 'omit the spell and skill name lists, which are long' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      await s.pacer.submit('read', () => c.stats(1));
      await s.pacer.submit('read', () => c.stats(2));
      // Ask for these even when brief. `brief` shortens the OUTPUT — it is there
      // because the name lists run to hundreds of entries — but skipping the
      // request meant brief reported whatever happened to be cached, and the
      // server does not push the skill list at login. So a character with 19
      // skills reported "skills_known: 0", which is not a shorter truth, it is a
      // wrong one.
      await s.pacer.submit('read', () => c.requestSpells());
      await s.pacer.submit('read', () => c.requestSkills());
      await new Promise(r => setTimeout(r, 700));

      // Attributes are reported against their real ceiling. kod bounds each to
      // (1, MAXIMUM_STAT) on the way out (player.kod:6371), so a character whose
      // attributes were never allocated reads as 1 rather than 0 — which looks
      // like a low stat instead of an unbuilt character. Say which it is.
      // The wire's `max` for an attribute is 50, but that is a display scale like
      // health's 100 — the real bound is MAXIMUM_STAT = 70 (player.kod:116), which
      // is what GetMight clamps to and what buffs can reach.
      const ATTRS = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
      const attributes = {};
      for (const k of ATTRS) {
        const st = c.statsById.get(k);
        if (st) attributes[k] = { value: st.value, display_scale: st.max ?? 50, hard_cap: 70 };
      }
      const karma = c.statsById.get('karma');
      const vals = ATTRS.map(k => attributes[k]?.value).filter(v => v != null);
      const unbuilt = vals.length === ATTRS.length && vals.every(v => v <= 1);

      const vitals = c.vitals();
      const notes = [];
      if (unbuilt)
        notes.push('every attribute is at the floor of 1, which is what an UNALLOCATED ' +
                   'character looks like — the kod bounds a raw 0 up to 1 on the way out. A character ' +
                   'made by the admin socket\'s "create automated" has no attributes at all, and no ' +
                   'amount of play will raise them. Expect it to be bad at everything, permanently. ' +
                   'STAMINA IS THE ONE THAT MATTERS MOST: the max-health ceiling is 101 + stamina ' +
                   '(player.kod:7827), so this character can never exceed 102 max health.');
      for (const k of ['health_over_max', 'mana_over_max', 'vigor_over_max'])
        if (vitals[k]) notes.push(vitals[k]);
      if (!vitals.vigor)
        notes.push('no vigor reading arrived — vigor gates running and some skill costs');

      return { ...s.snapshot('status'), where: s.world.room
                 ? { num: s.world.room.num, name: s.world.room.name } : null,
               level_note: vitals.health
                 ? `max_health ${vitals.health.max} is what the game treats as your level`
                 : undefined,
               attributes, karma: karma ? { value: karma.value, min: -100, max: 100 } : undefined,
               attributes_unallocated: unbuilt || undefined,
               ...(s.jobReport() ?? {}),
               ...(a.brief ? { spells_known: (c.spells || []).length, skills_known: (c.skills || []).length }
                           : { spells: c.spells.map(x => ({ id: x.id, name: c.rsc.get(x.nameRsc), targets: x.numTargets })),
                               skills: c.skills.map(x => ({ id: x.id, name: c.rsc.get(x.nameRsc) })) }),
               abilities_note: 'these are the names only; `abilities` gives the 0-100 number for each',
               notes: notes.length ? notes : undefined };
    },
  },
  {
    name: 'progress',
    description:
      'WHY YOUR HEALTH IS OR IS NOT GOING UP, and what to fight next. Health points are the only real ' +
      'advancement in this game and the rule behind them is in the game\'s source, not on the wire — ' +
      'so without this you have to derive it, which is expensive and easy to get wrong.\n' +
      'THE RULE (AdvancementCheck, player.kod:7736). Your max health IS your level. On a kill the ' +
      'server compares the victim\'s level to yours:\n' +
      '  victim level > yours   -> you bank 3 points of gain_chance (2 if you took no damage or did ' +
      'not land the killing blow), and IT ROLLS: random(1,highmark) must come in under your banked ' +
      'gain_chance plus a bonus of (victim_level - yours)/5, capped at 10.\n' +
      '  victim level <= yours  -> NO ROLL HAPPENS AT ALL. You bank a consolation point and that is ' +
      'the end of it. This is the trap: a monster that was teaching you yesterday teaches you nothing ' +
      'today, silently, the moment your level reaches its own.\n' +
      'HIGHMARK is (i+1)*i for i = your_level * (100 - stamina) / 100, so STAMINA IS ENORMOUS — at ' +
      'level 20 it is 380 with stamina 1 and 110 with stamina 50, nearly four times easier per roll — ' +
      'and it also sets the lifetime ceiling of 101 + stamina.\n' +
      'Every gain resets your banked chance to minus half your level, so gains get further apart as ' +
      'you climb. Pass `monster` to ask about one by name; otherwise this reports on whatever is in ' +
      'the room with you.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      monster: { type: 'string', description: 'ask whether this creature still teaches you anything' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      // Attributes arrive in stat group 2 and are not pushed at login, so ask.
      await s.pacer.submit('read', () => c.stats(2));
      await new Promise(r => setTimeout(r, 400));
      const v = c.vitals();
      const level = v.health?.max ?? 0;
      const stamina = c.statsById.get('stamina')?.value;
      const stam = Number.isFinite(stamina) && stamina > 0 ? stamina : 1;
      const i = Math.floor(level * (100 - stam) / 100);
      const highmark = (i + 1) * i;
      const bonusFor = lvl => Math.max(0, Math.min(10, Math.floor((lvl - level) / 5)));

      const monsters = loadMonsterLevels();
      const karmaRaw = c.statsById.get('karma')?.value;
      const karma = Number.isFinite(karmaRaw) ? karmaRaw : null;
      const inNewbie = /raza|mausoleum/i.test(s.world?.room?.name || '');

      // WHAT YOU KILL DECIDES WHAT YOU CAN CAST. A kill is scored as an act worth
      // the NEGATIVE of the victim's karma, so killing an evil thing makes you
      // good — and a Qor caster who grinds rats will quietly lose Qor. The game
      // guards new characters from this (karma is frozen in the newbie region,
      // player.kod:6539, whose comment says exactly why) and stops guarding the
      // moment they leave.
      const karmaNote = (victimKarma) => {
        if (victimKarma == null || karma == null) return undefined;
        const act = -victimKarma;
        if (inNewbie) return 'no karma change here — the newbie region freezes it';
        if (act === 0) return 'neutral: no karma change';
        // CalculateKarmaChangeFromAct returns 0 when you are already further from
        // neutral than the act is.
        const sameSign = (karma > 0) === (act > 0);
        if (sameSign && Math.abs(karma) > Math.abs(act))
          return `no change — you are already further from neutral than this act (${act})`;
        return act > 0
          ? `pushes your karma UP (act ${act}) — good for Shal'ille, erodes Qor`
          : `pushes your karma DOWN (act ${act}) — good for Qor, erodes Shal'ille`;
      };

      const describe = (name, lvl) => {
        if (lvl == null) return { name, level: null, teaches: null, why: 'level unknown to the catalogue' };
        const ok = lvl > level;
        return {
          name, level: lvl, teaches: ok,
          roll_bonus: ok ? bonusFor(lvl) : 0,
          karma_effect: karmaNote(monsterKarmaByName(monsters, name)),
          why: ok ? `level ${lvl} is above your ${level}, so killing it rolls for a health point`
                  : `level ${lvl} is not above your ${level} — NO roll happens, this can never raise you again`,
        };
      };

      // What is standing here right now.
      const here = (s.world?.objects() ?? [])
        .filter(o => Array.isArray(o.can) && o.can.includes('attack') && !o.is_player)
        .map(o => describe(o.name, monsterLevelByName(monsters, o.name)));

      return {
        level: { value: level, note: 'your max health IS your level — everything compares against it' },
        stamina: stam,
        ceiling: { max_health_reachable: 101 + stam,
                   note: 'hard lifetime cap, 101 + stamina (player.kod:7827)' },
        roll: {
          highmark,
          formula: 'random(1, highmark) < banked_gain_chance + bound((victim_level - your_level)/5, 0, 10)',
          note: 'banked gain_chance is server-side only and never sent to a client, so it cannot be ' +
                'reported here — but it rises ~3-4 per qualifying kill and resets to -' +
                Math.floor(level / 2) + ' the moment you gain.',
        },
        need_victim_level_above: level,
        karma: karma == null ? undefined : {
          value: karma,
          qor_castable_to_level: karma <= -10 ? Math.floor(-karma / 10) : 0,
          shalille_castable_to_level: karma >= 10 ? Math.floor(karma / 10) : 0,
          frozen_here: inNewbie || undefined,
          note: 'Qor needs karma <= level*-10, Shal\'ille needs >= level*+10. A kill is an act worth ' +
                'the NEGATIVE of the victim\'s karma, so grinding evil monsters makes you good — the ' +
                'commonest way to lose a school is to farm the wrong prey.',
        },
        here: here.length ? here : undefined,
        asked_about: a.monster ? describe(a.monster, monsterLevelByName(monsters, a.monster)) : undefined,
        best_nearby: here.filter(h => h.teaches).sort((x, y) => y.roll_bonus - x.roll_bonus)[0] || undefined,
        advice: here.length && !here.some(h => h.teaches)
          ? 'NOTHING IN THIS ROOM CAN RAISE YOU ANY FURTHER. Every creature here is at or below your ' +
            'level, so no roll is even attempted. Move somewhere with tougher prey.'
          : 'fight things above your level, take a hit, and land the killing blow — that is the ' +
            'combination worth 3 rather than 2.',
      };
    },
  },
  {
    name: 'abilities',
    description:
      'HOW GOOD YOU ACTUALLY ARE at each skill and spell, as a number from 0 to 100 — and the only way ' +
      'to tell whether practice is working.\n' +
      'These numbers were on the wire all along. `status` lists what you KNOW; this lists how WELL. ' +
      'They arrive in stat groups 3 and 4, one slot per entry, positionally matched to the spell and ' +
      'skill lists (user.kod:2694 SendStatSpell / SendStatSkill).\n' +
      'Abilities rise by USE, not by killing: every successful use rolls to improve, and the roll is ' +
      'weighted by how hard the target was (ImproveAbility, skill.kod:294). Practising on something ' +
      'trivial is close to worthless, and a town or other ROOM_HARD_LEARN room divides the chance by ' +
      'ten. What you stop using ATROPHIES when the advancement window rolls over.\n' +
      'So: record these numbers, fight something difficult, read them again. If nothing moved, you are ' +
      'either throttled (10 points per 15-22 minute window), in a hard-learn room, or fighting prey too weak ' +
      'to teach you anything.\n' +
      'Weapon proficiencies and strokes improve from ORDINARY ATTACKS with the matching weapon, so `fight` ' +
      'and `attack` are the practice loop for them. In this fork the other skills are passive — the server ' +
      'invokes them for you, and there is no way for any client to invoke one directly.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      kind: { type: 'string', enum: ['skills', 'spells', 'both'], description: 'default both' },
      known_only: { type: 'boolean', description: 'default true — hide entries still at 0' },
      name: { type: 'string', description: 'just the ones matching this' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const kind = a.kind || 'both';
      const wantSpells = kind !== 'skills', wantSkills = kind !== 'spells';

      // The lists must be re-requested before the ability groups: a group-3 packet
      // carries one slot per entry of plSpells and nothing that identifies which
      // spell a slot is, so a stale list mislabels every number.
      if (wantSpells) await s.pacer.submit('read', () => c.requestSpells());
      if (wantSkills) await s.pacer.submit('read', () => c.requestSkills());
      await new Promise(r => setTimeout(r, 500));
      if (wantSpells) await s.pacer.submit('read', () => c.stats(3));
      if (wantSkills) await s.pacer.submit('read', () => c.stats(4));
      await new Promise(r => setTimeout(r, 700));

      // Join on the object id the stat carries rather than on slot order. The
      // order does match, but an id is checkable and a position is not.
      const group = n => [...c.statsById.entries()]
        .filter(([k]) => k.startsWith(`${n}.`)).map(([, v]) => v);
      const build = (list, n, label) => {
        const stats = group(n);
        const byId = new Map(stats.filter(x => x.id != null).map(x => [x.id, x]));
        const rows = list.map((o, i) => {
          const st = byId.get(o.id) || stats[i];
          return { name: c.rsc.get(o.nameRsc), id: o.id,
                   ability: st ? st.value : null,
                   ...(label === 'spells' ? { targets: o.numTargets } : {}) };
        });
        return { rows, missing: rows.filter(r => r.ability == null).length,
                 slots: stats.length, entries: list.length };
      };

      const out = { note: undefined };
      const filt = rows => {
        let r = rows;
        if (a.name) { const q = String(a.name).toLowerCase();
                      r = r.filter(x => (x.name || '').toLowerCase().includes(q)); }
        if (a.known_only !== false) r = r.filter(x => x.ability == null || x.ability > 0);
        return r.sort((x, y) => (y.ability ?? -1) - (x.ability ?? -1));
      };

      if (wantSkills) {
        const b = build(c.skills || [], 4, 'skills');
        out.skills = filt(b.rows);
        out.skills_hidden_at_zero = a.known_only === false ? 0 : b.rows.length - b.rows.filter(r => r.ability == null || r.ability > 0).length;
        if (b.slots !== b.entries)
          out.skills_warning = `the server sent ${b.slots} ability slot(s) for ${b.entries} skill(s) — numbers may be mislabelled`;
      }
      if (wantSpells) {
        const b = build(c.spells || [], 3, 'spells');
        const cat = spellCatalogue?.spells ?? [];
        const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const r of b.rows) {
          const info = cat.find(x => norm(x.name) === norm(r.name));
          if (info) { r.school = info.school_name; r.level = info.level; r.mana = info.mana; }
        }
        out.spells = filt(b.rows);
        out.spells_hidden_at_zero = a.known_only === false ? 0 : b.rows.length - b.rows.filter(r => r.ability == null || r.ability > 0).length;
        if (b.slots !== b.entries)
          out.spells_warning = `the server sent ${b.slots} ability slot(s) for ${b.entries} spell(s) — numbers may be mislabelled`;
      }

      const all = [...(out.skills || []), ...(out.spells || [])].filter(x => x.ability != null);
      if (all.length) {
        const vals = all.map(x => x.ability);
        out.summary = {
          entries_with_a_number: all.length,
          best: all.reduce((m, x) => (x.ability > (m?.ability ?? -1) ? x : m), null),
          mean: Math.round(vals.reduce((p, q) => p + q, 0) / vals.length),
          all_identical: new Set(vals).size === 1
            ? `every ability is exactly ${vals[0]} — that is not something play produces, so this ` +
              `character was granted its abilities rather than earning them`
            : undefined,
        };
      }
      out.note = 'record these, do something difficult, read them again — the delta is the only ' +
                 'progress signal the game gives you for skills and spells';
      return out;
    },
  },
  {
    name: 'bank',
    description:
      'Deposit, withdraw, or check money at a bank. THIS IS WHAT MAKES PROGRESS SURVIVE DYING: ' +
      'everything you carry drops on the floor where you die, but a bank balance does not.\n' +
      'You must be standing in a bank with the banker in the room — the request is relayed to whatever ' +
      'is in the room with you (holder.kod:828), so anywhere else it fails and the failure is a message ' +
      'rather than an error. The banker answers in prose, which is returned here verbatim; there is no ' +
      'structured balance on the wire, so the number is parsed out of what it says.\n' +
      'Each town keeps a SEPARATE account: Jasper and Tos share one, Ko\'catan has its own. Money put in ' +
      'at one is not available at another.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      action: { type: 'string', enum: ['balance', 'deposit', 'withdraw'] },
      amount: { type: 'number', description: 'shillings; required for deposit and withdraw' },
    }, required: ['agent', 'action'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      if (a.action !== 'balance' && !(num(a.amount, 0) > 0))
        throw new Error(`${a.action} needs a positive amount`);
      const before = c.evSeq;
      const amount = Math.floor(num(a.amount, 0));
      const fn = { balance: () => c.balance(),
                   deposit: () => c.deposit(amount),
                   withdraw: () => c.withdraw(amount) }[a.action];
      await s.pacer.submit('bank', fn);
      const { events } = await c.waitFor({ since: before, timeoutMs: 4000 });
      const said = events.filter(e => e.text).map(e => String(e.text));
      // "You have 500 shillings in your account." / "You now have 500 shillings in
      // your account." — the balance is only ever prose, so read it out of the prose.
      let balance = null;
      for (const t of said) {
        const m = /have\s+([\d,]+)\s+shillings?\s+in\s+your\s+account/i.exec(t);
        if (m) balance = Number(m[1].replace(/,/g, ''));
      }
      return {
        action: a.action, amount: a.action === 'balance' ? undefined : amount,
        banker_said: said,
        balance,
        ...(said.length ? {} : { note:
          'the banker said nothing, which almost always means there is no banker in this room. ' +
          'Banks: "The Royal Bank of Jasper", "The Bank of Tos", "The Bank of Ko\'catan" — travel to one first.' }),
      };
    },
  },
  {
    name: 'safety',
    description:
      'Turn your safety flag on or off. With safety ON the server refuses to let you strike an innocent, ' +
      'which is the protection against accidentally becoming a murderer — murder costs karma, and lawful ' +
      'merchants refuse to trade with murderers, so it can strand a character economically.\n' +
      'The cost is that you cannot fight other players at all while it is on. Monsters are unaffected ' +
      'either way, so a character that only fights monsters should leave it ON.\n' +
      'The server confirms the new setting in a message, which is returned here. There is no way to READ ' +
      'the flag without setting it, so this tool always sets.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      on: { type: 'boolean', description: 'true to protect innocents, false to allow striking them' },
    }, required: ['agent', 'on'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const before = c.evSeq;
      await s.pacer.submit('safety', () => c.safety(!!a.on));
      const { events } = await c.waitFor({ since: before, timeoutMs: 3000 });
      const said = events.filter(e => e.text).map(e => String(e.text));
      return { requested: !!a.on, server_said: said,
               ...(said.length ? {} : { note: 'no confirmation came back, so the setting is unverified' }) };
    },
  },
  {
    name: 'recording',
    description:
      'THE FLIGHT RECORDER — for debugging, not for playing. Every session writes every perceived ' +
      'event and every tool call to disk continuously, and NONE of it appears in normal replies, ' +
      'because it is enormous: one fight is ninety stat updates.\n' +
      'Reach for this when a character has been doing nothing and you want to know why, or when a ' +
      'keeper reports something that does not match what you expected. It answers "what actually ' +
      'happened, in what order", which neither the world snapshot nor the keeper journal can.\n' +
      'Files rotate every couple of minutes and only the last few windows are kept, so this is recent ' +
      'history, not an archive — long enough to catch a stall, short enough not to fill a disk.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      limit: { type: 'number', description: 'how many lines, newest last. Default 120.' },
      kinds: { type: 'array', items: { type: 'string' },
               description: 'filter, e.g. ["call"] for just tool calls or ["event"] for just the wire' },
      action: { type: 'string', enum: ['tail', 'status', 'off', 'on'] },
    }, required: ['agent'] },
    run: (a) => {
      const s = sessions.get(a.agent);
      if (!s) return { error: `no session named "${a.agent}"`, known: [...sessions.keys()] };
      const r = s.recorder;
      if (a.action === 'off') { r.stop(); r.enabled = false; return { recording: false }; }
      if (a.action === 'on') { r.enabled = true; return { recording: true }; }
      if (a.action === 'status') {
        return { recording: r.enabled, directory: RECORD_DIR,
                 window_seconds: RECORD_WINDOW_MS / 1000, windows_kept: RECORD_KEEP,
                 bytes_written: r.written, dropped_lines: r.dropped, buffered: r.buf.length };
      }
      const lines = r.tail(num(a.limit, 120), a.kinds);
      return { agent: a.agent, lines: lines.length, recording: r.enabled, tail: lines };
    },
  },
  {
    name: 'history',
    description:
      'WHAT HAS ACTUALLY HAPPENED TO THESE CHARACTERS, over hours and days rather than minutes.\n' +
      'One row per character: the level it is at now, how many it GAINED in the window, its peak, ' +
      'kills, deaths, how many times it stalled, whether it has left the newbie zone, and where it is. ' +
      'Plus the notable events in order — every level gained or lost, every death, every stall and ' +
      'recovery.\n' +
      'This is not the flight recorder. `recording` keeps two-minute windows and discards anything ' +
      'older than about half an hour, which answers "why is this one standing still right now" and ' +
      'cannot answer "how far did the fleet get overnight". This file is appended and never rotated, ' +
      'and it is keyed by CHARACTER NAME — agent names get reused and object ids are renumbered by ' +
      'every save, so neither survives the question being asked a day later.\n' +
      'The number to read first is `gained`. A character can be alive, unstalled, in a sensible room ' +
      'and killing things steadily while gaining nothing at all, which is what happens the moment its ' +
      'prey stops being above its level.',
    schema: { type: 'object', properties: {
      hours: { type: 'number', description: 'how far back to look, default 24' },
      character: { type: 'string', description: 'just this one, with its full event list' },
      events_only: { type: 'boolean' },
      deaths: { type: 'boolean', description: 'post-mortem instead of the summary: the last N deaths ' +
        'with the health trail leading into each, grouped by character, room, killer and strategy. A ' +
        'death costs a point of max health outright, so it is worth about an hour of the work that ' +
        'caused it — which makes "what do these have in common" the highest-value question here' },
      time: { type: 'boolean', description: 'where the time goes: active vs stalled, split by ' +
        'fighting / recovering / travelling, plus what each stall was and what ended it. Resting and ' +
        'eating count as ACTIVE — a character regenerating is working, and counting that as a stall ' +
        'made a working fleet look broken' },
      limit: { type: 'number' },
    } },
    run: async (a) => {
      const sinceMs = (Number(a.hours) > 0 ? Number(a.hours) : 24) * 3600 * 1000;
      if (a.character) {
        const { samples, events } = readLedger({ sinceMs });
        const mine = samples.filter(x => x.character?.toLowerCase() === a.character.toLowerCase());
        const ev = events.filter(x => x.character?.toLowerCase() === a.character.toLowerCase());
        if (!mine.length && !ev.length)
          return { character: a.character, note: 'nothing recorded for that name in this window' };
        const first = mine[0], last = mine[mine.length - 1];
        return {
          character: a.character,
          level: { started: first?.level ?? null, now: last?.level ?? null,
                   gained: (last?.level ?? 0) - (first?.level ?? 0) },
          kills: last?.kills ?? null, room: last?.room ?? null,
          samples: mine.length,
          events: ev.map(e => ({ at: e.iso || new Date(e.t).toISOString(), kind: e.kind,
                                 ...Object.fromEntries(Object.entries(e)
                                   .filter(([k]) => !['t', 'iso', 'type', 'character', 'kind'].includes(k))) })),
        };
      }
      if (a.deaths) return deathReport({ sinceMs, limit: num(a.limit, 20) });
      if (a.time) return timeReport({ sinceMs });
      const sum = ledgerSummary({ sinceMs });
      return a.events_only ? { window_hours: sum.window_hours, recent_events: sum.recent_events } : sum;
    },
  },
  {
    name: 'leave_raza',
    description:
      'LEAVE THE NEWBIE ZONE. Walk into the Grand Museum of Raza and step on the portal inside — TWICE.\n' +
      'The first touch only warns you and bounces you back off it; the second actually takes you. That ' +
      'is the whole mechanism, and it is one-way. There is no door out of Raza, no key, and no quest: ' +
      'the museum is signposted on the map as the tutorial exit and the portal is standing in it.\n' +
      'DYING IS NOT PART OF THIS AND NEVER WAS. Being killed puts you in the Underworld, costs a point ' +
      'of maximum health for ever, and drops everything you are carrying — it is not an exit from ' +
      'anywhere except the Underworld itself.\n' +
      'Worth doing the moment your max health reaches 25: the only creatures Raza generates are ' +
      'level-25 mummies, and advancement needs monster_level > base_max_health, so from 25 onward the ' +
      'entire newbie zone pays nothing at all.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      then_travel_to: { type: ['string', 'number'], description: 'room to head for once outside' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent);
      s.need();
      const inRaza = () => /Raza|Mausoleum|Museum/i.test(s.client.rsc.get(s.client.roomNameRsc) || '');
      if (!inRaza()) return { left: false, note: 'not in the newbie zone — nothing to leave' };

      const log = [];
      let out = false;
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        const t = await s.travel(MUSEUM_ROOM, { maxHops: 8 }).catch(e => ({ arrived: false, reason: e.message }));
        log.push({ step: 'to the Grand Museum', ...t });
        // The bounce does not always put you back on the square you left, so step
        // off and on again rather than assuming position.
        for (const [col, row] of [[11, 2], [11, 3], [11, 2], [11, 2]]) {
          await s.walkTo(col, row).catch(() => {});
          await new Promise(r => setTimeout(r, 900));
          if (!inRaza()) { out = true; break; }
        }
        log.push({ step: 'touched the portal', still_in_raza: !out });
      }

      if (out && a.then_travel_to != null && worldMap) {
        const dest = resolveRoom(worldMap, a.then_travel_to);
        if (dest != null) log.push({ step: 'onward', ...(await s.travel(dest, { maxHops: 18 }).catch(e => ({ arrived: false, reason: e.message }))) });
      }
      return { left: out, log, now: arrivalReport(s),
               note: out ? 'one-way — you cannot walk back into Raza'
                         : 'still inside; the portal is in the Grand Museum at (11,2) and needs two touches' };
    },
  },
  {
    name: 'reroll',
    description:
      'MAKE A CHARACTER WORTH GROWING, or check that we can before betting a real one on it.\n' +
      '`create automated` produces a character with ZERO in every attribute. Attributes are fixed at ' +
      'creation and never move, and stamina IS the max-health ceiling (101 + stamina), so such a ' +
      'character is capped at 102 max health for ever and bad at everything. The ordinary protocol can ' +
      'do better: six stats of 1..50 summing to 200, plus spells and skills costing up to 45 points.\n' +
      'THE SERVER NEVER SAYS NO. Over budget, out of range, wrong list length — none of it is refused. ' +
      'It silently stamps 3/1/4/1/5/9 and the default face on you, and you discover it weeks later when ' +
      'the character cannot get past level 15. Everything here is therefore validated before sending, ' +
      'and `verify` exists so the whole path can be proved on a throwaway account first.\n' +
      'action=plan shows exactly what would be asked for and changes nothing. action=verify creates a ' +
      'character on a SPARE account and reports the stats it actually came back with — run this before ' +
      'trusting any of it. action=reroll is destructive and has no undo: it suicides the character ' +
      '(which is what sets IsFirstTime and lets a new one be made) and replaces it.',
    schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['plan', 'verify', 'reroll'] },
      agent: { type: 'string', description: 'the session to re-roll, or the spare to verify on' },
      name: { type: 'string', description: 'name for the new character' },
      stats: { type: 'string', description: 'preset: melee, caster, archer, balanced. Default melee.' },
      loadout: { type: 'string', description: 'spells: selfSufficient, healer, none. Default selfSufficient — ' +
        'create weapon needs no reagents so the character can never be unarmed, and create food needs ' +
        'elderberries and herbs, which is what it will be picking up anyway' },
      user_field: { type: 'number', description: 'the `user` field on BP_NEW_CHARINFO — the OBJECT ID ' +
        'of the character being replaced, which the server asks @IsFirstTime. Defaults to the id of the ' +
        'first-time character in the login list, which is what you want; override only to test the wire ' +
        'format. Sending 0 gets CHARINFO_OK with id 0 — an acknowledgement that creates nothing' },
      confirm: { type: 'boolean', description: 'required for action=reroll. There is no undo.' },
    }, required: ['action'] },
    run: async (a) => {
      const plan = planCharacter({
        name: a.name, stats: a.stats || 'melee', loadout: a.loadout || 'selfSufficient' });
      if (a.action === 'plan') return plan;
      if (!plan.ok) return { done: false, plan, note: 'the plan is invalid; nothing was sent' };

      const s = session(a.agent);
      const before = (() => {
        const c = s.client; if (!c) return null;
        const st = {};
        for (const [k, v] of (c.statsById ?? new Map()))
          if (!/^\d+\.\d+$/.test(k)) st[k] = v?.text !== undefined ? v.text : v?.value;
        return { character: c.me?.name, stamina: st.stamina, max_health: c.vitals?.()?.health?.max };
      })();

      if (a.action === 'reroll' && !a.confirm)
        return { done: false, plan, before,
                 note: 'this deletes the existing character and cannot be undone — pass confirm:true' };

      // THE SUICIDE IS PART OF THE PATH, so `verify` has to do it too or it is not
      // verifying anything. The server only accepts BP_NEW_CHARINFO when IsFirstTime()
      // holds, and PerformSuicide (user.kod:1447) setting piLastLoginTime = 0 is what
      // makes that true. Skipping it on the spare account would test a state the real
      // re-roll never reaches.
      const made = await (async () => {
        try {
          if (s.client) {
            await s.pacer.submit('suicide', () => s.client.suicide());
            await new Promise(r => setTimeout(r, 1500));
          }
          // NOT num(..., 0). The `user` field is BP_NEW_CHARINFO's first parameter and
          // sprocket.c:87 types it {4, TAG_OBJECT} — it is the object being replaced,
          // which system.kod:3719 reads back as oUser before asking it @IsFirstTime.
          // Defaulting it to 0 asked the server whether object zero was first-time, and
          // the answer is a refusal reported as CHARINFO_OK with id 0 — an ack that
          // creates nothing. Leave it null so joinAsNewCharacter falls through to the
          // id of the character the list actually offered.
          return await s.joinAsNewCharacter(plan,
            { userField: a.user_field == null ? null : Number(a.user_field) });
        } catch (e) { return { created: false, error: e.message }; }
      })();
      if (a.action === 'reroll' && made.created === false && !made.error) { /* fall through to report */ }

      // The only answer that matters: did the stats we asked for actually land, or did
      // the server quietly substitute junk?
      const c = s.client;
      const got = {};
      for (const [k, v] of (c?.statsById ?? new Map()))
        if (!/^\d+\.\d+$/.test(k)) got[k] = v?.text !== undefined ? v.text : v?.value;
      const asked = plan.stats;
      // ABSENCE IS NOT AGREEMENT. The first version of this treated a missing stat as
      // a match, so a run that never got into the world at all — no character, no
      // stats, nothing — reported "the stats came back exactly as asked" and told the
      // caller the path was safe to use. That is the precise failure this whole tool
      // exists to prevent, reproduced inside the tool. A verdict needs readings.
      const known = STAT_ORDER.filter(k => got[k] != null);
      const haveReadings = known.length === STAT_ORDER.length;
      const matched = !!asked && haveReadings && STAT_ORDER.every(k => Number(got[k]) === asked[k]);
      const junk = haveReadings &&
        STAT_ORDER.map(k => Number(got[k])).join('/') === '3/1/4/1/5/9';

      return {
        done: !!made.created, ...made, plan_summary: {
          name: plan.name, stats: asked, ceiling: plan.max_health_ceiling,
          spells: plan.spells.map(x => x.name) },
        before,
        stats_now: Object.fromEntries(STAT_ORDER.map(k => [k, got[k] ?? null])),
        stamina_now: got.stamina ?? null,
        max_health_now: c?.vitals?.()?.health?.max ?? null,
        stats_as_asked: matched,
        stats_readable: haveReadings,
        looks_like_the_junk_default: junk,
        verdict: !made.created
          ? 'NOT CREATED — no character came back, so nothing is proven either way. Read the ' +
            'broker log for what the server did or did not send after BP_NEW_CHARINFO.'
          : !haveReadings
          ? 'INCONCLUSIVE — a character exists but its stats did not come back, so there is ' +
            'nothing to compare. Do not treat this as a pass.'
          : junk
          ? 'THE SERVER SUBSTITUTED ITS JUNK CHARACTER — the request was rejected silently. Do not ' +
            'reroll anything real until the user field or the encoding is right.'
          : matched ? 'the stats came back exactly as asked; this path is safe to use'
                    : 'the stats do not match what was asked — treat as unproven',
      };
    },
  },
  {
    name: 'loot_run',
    description:
      'PAIR A CHARACTER THAT HAS TOO MUCH WITH ONE THAT HAS NOTHING.\n' +
      'A farmer going well drops more than a fourteen-slot pack holds, and cannot leave to sell it ' +
      'without giving up a safe wall it spent twenty minutes proving. At the same time the bottom of ' +
      'the fleet is stuck the other way round: no food, so vigor is pinned at the resting cap of 80 ' +
      'for ever; no money, so no food; and no safe way to earn any, because earning means fighting ' +
      'and fighting at 80 vigor is thirty seconds of swinging and an hour of recovery.\n' +
      'Those are the same problem from two ends, and the game already has the mechanism: walk over ' +
      'and pick it up. The bargain players actually strike is LOOT FOR THE POOR, FOOD FOR THE FARMER ' +
      '— the runner keeps what it can sell, and hands over any food it has, because a fed farmer ' +
      'earns back the value of a loaf many times over. With no food to give it becomes a debt, ' +
      'settled in a town afterwards.\n' +
      'NEVER CARRY THE MONEY OUT TO SETTLE UP. Death drops your whole inventory, and the runner is ' +
      'chosen for being fragile — taking coin into the field to pay a debt puts the one thing death ' +
      'takes into the one place death happens.\n' +
      'action=plan proposes pairings and changes nothing. action=start dispatches them: each runner ' +
      'gets an errand that outranks its farming but not its own survival, so it will still rest, ' +
      'flee or log off on the way if it has to.\n' +
      'THE OTHER HALF IS PROVISIONING. A character that knows create weapon or create food can fix ' +
      'the two failures money cannot reach quickly — no weapon, and no food — but BOTH SPELLS ARE ' +
      'SELF-ONLY (creaweap.kod:117 holds the result to the caster; the target list is never read). ' +
      'So the quartermaster walks over, casts for itself, and hands the result across as a gift. ' +
      'action=services lists who could serve whom and changes nothing; action=provision sends them.\n' +
      'action=resupply is the step before that, and the fleet usually needs it: create food burns two ' +
      'elderberries and two herbs from the CASTER, the reagents are never scarce but they are always ' +
      'in the wrong pockets, and a cast without them fails silently. It walks surplus reagents from ' +
      'whoever is sitting on them to the quartermasters that are short, then provision can dispatch.',
    schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['plan', 'start', 'status', 'cancel', 'services', 'provision', 'resupply'] },
      agent: { type: 'string', description: 'for cancel, or to force one particular runner' },
      farmer: { type: 'string', description: 'agent name of the farmer to visit, for a hand-picked run' },
      min_kills: { type: 'number', description: 'how many kills make a farmer worth visiting, default 3' },
      full_at: { type: 'number', description: 'how full a farmer\'s pack must be, 0-1, default 0.75' },
    }, required: ['action'] },
    run: async (a) => {
      const fleetTool = TOOLS.find(t => t.name === 'fleet');
      const snap = await fleetTool.run({});
      const rows = snap.fleet || [];
      const opts = { minKills: num(a.min_kills, 3), fullAt: num(a.full_at, 0.75) };

      // Who can cast the fleet out of its two silent failures, and for whom.
      //
      // `services` proposes and changes nothing, which is what it has always done.
      // `provision` is the half that was missing: it puts each job on the CASTER as
      // an errand, so a quartermaster actually walks over, casts, and hands the
      // result across. One job per caster per dispatch — an errand is a journey, and
      // queueing five onto one character just means four of them expire unstarted.
      // STOCK THE QUARTERMASTERS BEFORE ASKING THEM TO COOK.
      //
      // create food burns 2 ElderBerry and 2 Herbs out of the CASTER's pack, and casting
      // without them fails silently — the errand completes having produced nothing. The
      // fleet's reagents are not scarce, they are in the wrong pockets: four casters were
      // each holding twenty-odd elderberries and no herbs at all while a farmer stood on
      // a hundred and one herbs. This walks the surplus to the casters that are short.
      //
      // Deliberately a separate action rather than a step inside `provision`: each pairing
      // may involve a walk across the map, and hiding minutes of travel inside a call that
      // looks like planning is how a tool becomes untrustworthy.
      if (a.action === 'resupply') {
        await Promise.all([...sessions].map(async ([, s]) => {
          const c = s.client;
          if (!c || s.live !== true || (c.spells || []).length) return;
          await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
        }));
        await new Promise(r => setTimeout(r, 900));
        const fresh = (await fleetTool.run({})).fleet || rows;

        const NEED = 2;      // create food consumes exactly two of each, per casting
        const KEEP = 6;      // a holder must have a real surplus; do not strip a farmer bare
        const zone = r => /Raza|Mausoleum|Museum/i.test(r.room || '') ? 'raza' : 'world';
        const short = fresh.filter(r => r.in_game !== false &&
          (r.provides || []).includes('create food') &&
          (((r.reagents?.elderberry ?? 0) < NEED) || ((r.reagents?.herbs ?? 0) < NEED)));

        const moved = [], failed = [];
        for (const caster of short) {
          for (const kind of ['elderberry', 'herbs']) {
            if ((caster.reagents?.[kind] ?? 0) >= NEED) continue;
            const holder = fresh.find(h => h.in_game !== false && h.agent !== caster.agent &&
              zone(h) === zone(caster) && (h.reagents?.[kind] ?? 0) >= KEEP &&
              !/loot run|create /i.test(h.activity || ''));
            if (!holder) {
              failed.push(`${caster.character} needs ${kind} and nobody spare in ${zone(caster)} has ${KEEP}+`);
              continue;
            }
            const out = await supplyBetween({
              from: holder.agent, to: caster.agent, what: 'reagents', amount: NEED,
              who_travels: 'from',
            }).catch(e => ({ supplied: false, reason: e.message }));
            (out.supplied ? moved : failed).push(
              out.supplied ? `${holder.character} -> ${caster.character}: ${out.handed_over.join(', ')}`
                           : `${holder.character} -> ${caster.character}: ${out.reason}`);
            if (out.supplied) holder.reagents[kind] = (holder.reagents[kind] ?? 0) - NEED;
          }
        }
        return { resupplied: moved.length, moved, failed: failed.length ? failed : undefined,
                 note: moved.length
                   ? 'call action=provision next — create food jobs will now be dispatchable'
                   : 'nothing moved; every caster is already stocked or nobody has a surplus' };
      }

      if (a.action === 'services' || a.action === 'provision') {
        // ASK FOR THE SPELLS FIRST. `provides` reads c.spells straight off the client,
        // and c.spells is empty until requestSpells() has been called at least once —
        // so on a freshly resumed fleet every character looks like it knows nothing.
        // The plan then reports "nobody in the fleet knows create food or create
        // weapon — reroll someone", which is both false and expensive advice: it sends
        // you to re-roll characters you already have. Populate, then plan.
        await Promise.all([...sessions].map(async ([, s]) => {
          const c = s.client;
          if (!c || s.live !== true || (c.spells || []).length) return;
          await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
        }));
        await new Promise(r => setTimeout(r, 900));
        const fresh = (await fleetTool.run({})).fleet || rows;
        const plan = planProvisioning(fresh);
        if (a.action === 'services')
          return { ...plan, would_dispatch: plan.jobs.length,
                   note: plan.note ?? 'call again with action=provision to send the casters' };

        const busy = new Set();
        for (const [name] of sessions) if (autopilotIfAny(name)?.errand) busy.add(name);

        const sent = [];
        for (const j of plan.jobs) {
          if (busy.has(j.caster)) continue;               // already on an errand
          if (a.agent && j.caster !== a.agent) continue;  // caller pinned one caster
          const p = autopilotIfAny(j.caster);
          if (!p) continue;
          p.errand = { kind: 'provision', ...j, at: Date.now(), expires: Date.now() + 20 * 60 * 1000 };
          busy.add(j.caster);
          sent.push(j);
        }
        return {
          dispatched: sent.length, jobs: sent,
          skipped: plan.jobs.length - sent.length,
          casters: plan.casters,
          note: sent.length
            ? 'each caster will finish what it is doing, walk over, cast for itself and hand the ' +
              'result across — a made weapon is temporary, so it buys the walk to a shop'
            : 'nothing to dispatch — every able caster is already on an errand',
        };
      }

      if (a.action === 'status') {
        const out = [];
        for (const [name] of sessions) {
          const p = autopilotIfAny(name);
          if (p?.errand) out.push({ runner: name, ...p.errand });
        }
        return { running: out, note: out.length ? undefined : 'no loot runs in progress' };
      }
      if (a.action === 'cancel') {
        const p = a.agent ? autopilotIfAny(a.agent) : null;
        if (!p) return { cancelled: false, note: 'pass the runner\'s agent name' };
        const had = !!p.errand;
        p.errand = null;
        return { cancelled: had, agent: a.agent };
      }

      // NO ROOM IS OFF LIMITS TO A RUNNER.
      //
      // This used to refuse any destination whose spawn table rolled something four
      // levels over the runner, which reads as prudent and was solving the wrong
      // problem. Runners were not dying to the room they were sent to — a loot run
      // ends on a safe spot next to a farmer who has already cleared the place. They
      // were dying on the WAY, to things they walked past at one square a second,
      // taking a swing from each one. That is a movement-speed problem and it is fixed
      // where movement is paced. Refusing the destination just meant the poorest
      // characters never got the delivery that would have fixed them.
      const plan = planRuns(rows, opts);
      const usable = plan.runs;
      if (a.action === 'plan')
        return { ...plan, would_dispatch: usable.length,
                 note: plan.note ?? 'call again with action=start to send them' };

      const sent = [];
      for (const r of usable) {
        const p = autopilotIfAny(r.runner);
        if (!p) continue;
        p.errand = { ...r, at: Date.now(), expires: Date.now() + 20 * 60 * 1000 };
        sent.push(r);
      }
      return { dispatched: sent.length, runs: sent,
               note: sent.length
                 ? 'each runner will finish what it is doing, travel, hand over any food, and clear the floor'
                 : 'nothing to dispatch' };
    },
  },
  {
    name: 'safe_spots',
    description:
      'WHERE TO STAND SO THAT NOTHING CAN HIT YOU. Players call these safe walls, and they are the ' +
      'single largest advantage available to a character in this game.\n' +
      'In a working one NO MONSTER CAN HIT YOU UNLESS YOU SWING AT IT FIRST. That changes what losing ' +
      'a fight means: you do not flee, you simply stop swinging, and the damage stops. You can then ' +
      'rest to full IN A MONSTER ROOM with three things standing next to you, and take the fight ' +
      'again from the top — or leave, at full health, having decided to. A fight you were going to ' +
      'die in becomes a draw.\n' +
      'Two things this returns, and the difference between them is the whole point:\n' +
      '  GUESSES   the most defensible squares by geometry, best first, with how many sides are open ' +
      '(`can_reach_you`) and the longest unbroken wall arc behind you (`back_cover`). This is what ' +
      'the one-byte-per-square movement grid can see, and the real mechanic is finer than that — it ' +
      'lives in the BSP walls and probably the angles, which is why players learn specific spots by ' +
      'experiment. Treat a high score as a hypothesis.\n' +
      '  PROVEN    `known` is what has actually been tested here, by standing in it while something ' +
      'tried to kill us: `holds` means nothing landed, `does not work` means something did. This ' +
      'outranks the geometry in both directions and persists across sessions, so one character\'s ' +
      'experiment is every character\'s knowledge.\n' +
      'Squares on the outer ring are excluded: stepping past row 1 or piRows triggers ' +
      'StandardLeaveDir, so a corner on the boundary is one that ejects you from the room mid-fight.\n' +
      'To USE one: walk_to it, then fight from it without moving, and pull anything that will not come ' +
      'to you (hit it once, walk back). Before stepping out of a crowded one, log off and back on — ' +
      'the entry grace period makes the swarm notice you one at a time.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      limit: { type: 'number' },
      reachable_only: { type: 'boolean', description: 'only spots you can actually path to from here' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent);
      s.need();
      const geo = s.world?.geometry;
      const room = s.world?.room;
      if (!geo) return { spots: [], note: 'no geometry for this room' };
      const book = safeSpotBook(SAFESPOT_FILE);
      const known = room ? book.list(room.num) : [];
      const spots = safeSpots(geo, {
        limit: num(a.limit, 8),
        mustReach: a.reachable_only ? ((col, row) => s.world.reach(col, row)) : null,
      });
      const me = s.world.self;
      const rec = me && room ? book.get(room.num, me.col, me.row) : null;
      const pilot = autopilotIfAny(a.agent);
      return {
        room: room ? { num: room.num, name: room.name } : null,
        standing_at: me ? { col: me.col, row: me.row } : null,
        // The question worth asking first, and the one the keeper answers from
        // evidence rather than from the grid.
        in_a_safe_spot_now: pilot?.status?.().safe_spot ??
          (rec ? { at: { col: rec.col, row: rec.row }, works: rec.held > 0 && !book.discredited(rec),
                   evidence: `held ${rec.held} time(s), hit in it ${rec.failed} time(s)` }
               : false),
        spots: spots.map(x => {
          const k = book.get(room?.num, x.col, x.row);
          return { ...x,
            distance: me ? Math.max(Math.abs(x.col - me.col), Math.abs(x.row - me.row)) : null,
            tested: k ? (k.held > 0 ? 'holds' : book.discredited(k) ? 'does not work' : 'inconclusive') : 'untested',
            ...(k?.x != null ? { exact: { x: k.x, y: k.y },
                                 note: 'stand HERE, not at the middle of the square — walk_to aims at ' +
                                       'the centre and this spot works from a specific place in it' } : {}) };
        }),
        known,
        note: 'walk_to one of these before any fight worth having. `can_reach_you` is how many of the ' +
              'eight surrounding squares a monster can stand on — in the open it is eight — but ' +
              '`tested` is worth more than any of the scores.',
      };
    },
  },
  {
    name: 'hunting_grounds',
    description:
      'WHERE A CREATURE ACTUALLY LIVES, and what else lives there. Ask this before walking anywhere ' +
      'to hunt.\n' +
      'Monsters in this world do not wander. Every room has a generator with a fixed spawn table, and ' +
      'a creature appears in a room if and only if that room table names it — so this is a lookup, not ' +
      'a search, and exploring to find prey is looking for something that was never going to move. ' +
      'Rooms come back best-chance-first with the spawn percentage and the population cap.\n' +
      'THE FIELD THAT MATTERS MOST IS also_here, and the reason is that two rooms can both list ' +
      'giant rats at 60-70% while only one of them also rolls a level-35 groundworm larva. Pass ' +
      'max_danger — normally your own level plus about six — and rooms above it come back under ' +
      'rejected WITH THE REASON rather than being dropped, so you can see why the obvious room was ' +
      'skipped instead of trying it again.\n' +
      'Give a room number instead of a creature to ask the reverse: everything that room generates, ' +
      'worst first.\n' +
      'Give for_level instead to ask WHAT TO HUNT NEXT. Advancement only rolls when the monster is ' +
      'above your level (max health IS your level), so prey at or below it pays nothing at all — ' +
      'fifteen characters of mine ground level-25 mummies at level 25 for an hour and gained not one ' +
      'point. Pass karma to respect a school: evil for Qor (kill positive-karma creatures), good for ' +
      'Shal\'ille, neutral for prey that moves no karma at all and therefore suits anyone. Some bands ' +
      'have no clean answer — between about 35 and 45 every room with the right prey also spawns ' +
      'level-50 spiders — and those come back marked `compromise` with the specific threat under ' +
      '`risk`, rather than as an empty list that would read as "no prey exists".',
    schema: { type: 'object', properties: {
      creature: { type: 'string', description: 'name or part of one, e.g. "giant rat"' },
      room: { type: 'number', description: 'ask what THIS room spawns, instead of where a creature is' },
      for_level: { type: 'number', description: 'ask what a character of this level should hunt next' },
      karma: { type: 'string', enum: ['evil', 'good', 'neutral'],
               description: 'restrict to prey whose death pushes karma this way (Qor: evil, Shal\'ille: good)' },
      max_danger: { type: 'number', description: 'skip rooms that can generate something above this level' },
      limit: { type: 'number' },
    } },
    run: async (a) => {
      const spawns = loadSpawns(SPAWN_FILE);
      if (!spawns)
        throw new Error('no spawn index — build it with: node tools/m59-spawns.mjs');
      if (a.for_level != null) {
        const opts = { want: a.karma || null, limit: num(a.limit, 6) };
        const prey = preyFor(spawns, Number(a.for_level), opts);
        return {
          for_level: Number(a.for_level), karma: a.karma || 'any', prey,
          rule: 'AdvancementCheck rolls only when monster_level > base_max_health ' +
                '(player.kod:7736), so anything at or below your level pays nothing',
          note: prey.length ? undefined
            : `nothing between level ${Number(a.for_level) + 1} and ${Number(a.for_level) + 6} ` +
              `matches that karma requirement — try karma:"neutral", which moves no karma at all`,
        };
      }
      if (a.room != null) {
        const threats = roomThreats(spawns, a.room);
        return threats
          ? { room: a.room, generates: threats,
              toughest: spawns.danger[a.room],
              note: 'chance is that entry\'s share of the room table; cap is how many can be alive at once' }
          : { room: a.room, generates: [], note: 'no generator declares anything for this room' };
      }
      if (!a.creature) throw new Error('pass creature, or room');
      const rows = huntingGrounds(spawns, a.creature,
        { maxDanger: a.max_danger != null ? Number(a.max_danger) : null, limit: num(a.limit, 12) });
      const ok = rows.filter(r => !r.rejected);
      return {
        creature: a.creature,
        rooms: ok,
        rejected: rows.filter(r => r.rejected),
        note: ok.length ? undefined
          : 'nothing generates that; check the name, or it may be summoned rather than spawned',
      };
    },
  },
  {
    name: 'fleet',
    description:
      'EVERY CHARACTER YOU ARE RUNNING, IN ONE CALL. One line each: where it is, health, its level ' +
      '(max health IS the level), kills, and — the field to read first — whether it is STALLED.\n' +
      'This exists because supervising N characters one at a time is both expensive and unreliable. ' +
      'Every way the keeper failed in practice was silent: bags full, wandered into a town, lost its ' +
      'own object id to a save-game renumber. In each case it kept running and kept journalling and ' +
      'did no work, and the only way to notice was to poll each character and spot a number that had ' +
      'not moved. `stalled` makes that a field instead of an inference, and reading it for ten ' +
      'characters costs one call rather than ten.\n' +
      'Characters are keyed by the agent name you joined with, and each row carries the character ' +
      'name too — never an object id, because ids are reissued on every save.',
    schema: { type: 'object', properties: {
      verbose: { type: 'boolean', description: 'include each keeper\'s recent journal' },
    } },
    run: async (a) => {
      const rows = [];
      for (const [name, s] of sessions) {
        const c = s.client;
        const ap = autopilotIfAny(name);
        const st = ap ? ap.status() : null;
        if (!c || s.client?.state !== 'game') {
          rows.push({ agent: name, character: c?.me?.name ?? null, in_game: false,
                      stalled: 'not in game' });
          continue;
        }
        const v = c.vitals();
        rows.push({
          agent: name,
          character: c.me?.name ?? null,
          room: c.rsc.get(c.roomNameRsc) ?? null,
          // The NUMBER as well as the name, because names are not unique — twenty-two
          // of them name more than one room, so anything that wants to look a room up
          // (the compendium link on the dashboard) needs the number to be exact.
          room_num: s.world?.room?.num ?? null,
          health: v.health ? `${v.health.value}/${v.health.max}` : null,
          mana: v.mana ? `${v.mana.value}/${v.mana.max}` : null,
          level: v.health?.max ?? null,          // max health IS the level
          vigor: v.vigor?.value ?? null,
          // VIGOR AS A FRACTION, because it is the combat-readiness number and the
          // raw value hides that. Farming is combat over time: vigor is what swinging
          // costs (0.5 a swing, 30 a minute) and what sets the health regeneration
          // rate between fights, so a character at 40 of 200 is not "a bit tired", it
          // is out of the fight until it eats. Its ceiling is fixed at 200 rather than
          // scaling with level, so unlike health it needs saying explicitly.
          vigor_of: v.vigor ? `${v.vigor.value}/${skills.VIGOR_MAX}` : null,
          // CAN IT FIGHT, AND CAN IT KEEP FIGHTING. Neither is a stat the server
          // reports — both are facts about the pack — and both fail silently: an
          // unarmed character punches monsters instead of erroring, and one with no
          // food simply never gets its vigor back above what resting gives.
          has_weapon: skills.weaponsOf(c).length > 0,
          has_food: skills.larderOf(c).length > 0,
          // WHAT THIS CHARACTER CAN DO FOR THE OTHERS.
          //
          // Both Kraanan level-1 creation spells are services rather than personal
          // conveniences, and they answer the two things that silently stop a
          // character working. `create weapon` needs NO reagents, so one caster can
          // arm the whole fleet for nothing; `create food` needs elderberries and
          // herbs, which is exactly what a farmer picks up all day. Neither is karma
          // gated, so anyone can cast them from the day they are made.
          provides: (c.spells || [])
            .map(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase())
            .filter(n => n === 'create food' || n === 'create weapon'),
          mana_now: v.mana?.value ?? null,
          // What it is up to, in the words a person would use. `time` says which
          // bucket the seconds landed in; this says what is happening.
          activity: ap ? ap.activity() : 'no keeper',
          // The safe-spot thesis is a survival claim, so it has to be scored as one.
          // Deaths while standing in a square we believed in are the number that
          // falsifies it, and they are worth separating from deaths in the open.
          deaths_in_safe_spot: st?.did?.deaths_in_safe_spot ?? 0,
          deaths_in_proven_safe_spot: st?.did?.deaths_in_proven_safe_spot ?? 0,
          mulligans: st?.did?.mulligans ?? 0,
          logoffs: st?.did?.logoffs ?? 0,
          carrying: c.inventory?.length ?? null,
          // WHAT THIS ONE COULD ACTUALLY CAST, not merely what it knows.
          //
          // `create weapon` needs nothing, but `create food` needs 2 ElderBerry and
          // 2 Herbs FROM THE CASTER — and a cast without them fails SILENTLY. Three
          // quartermasters walked across the world, cast into thin air, and journalled
          // "the cast produced nothing we can see", which reads as a protocol fault
          // rather than an empty pack. Counting the reagents here lets the planner
          // refuse the errand instead of spending the journey to discover it.
          reagents: (() => {
            const n = re => (c.inventory || [])
              .filter(o => re.test(c.rsc.get(o.nameRsc) || ''))
              .reduce((t, o) => t + (o.amount || 1), 0);
            return { elderberry: n(/elder\s*berry|elderberry/i), herbs: n(/herb/i) };
          })(),
          autopilot: st ? { mode: st.mode, running: st.running, kills: st.did?.kills ?? 0 } : null,
          // Which farming pattern this one is running, so the ledger can compare them.
          strategy: st?.policy?.strategy ?? null,
          // Time by activity. `stalled_pct` is the honest health metric: recovering
          // is active, and a character sitting down regenerating is working.
          time: st?.time ?? null,
          last_death: st?.last_death ?? null,
          vigor_target: st?.policy?.fightAboveVigor || null,
          // No keeper, or a keeper that is not running, IS a stall. It used to report
          // as `autopilot: null` next to a full health bar and a sensible room name,
          // which reads as a healthy character — and twenty-five of them sat like
          // that for half an hour after a restart quietly restored the sessions and
          // silently failed to restore the keepers.
          stalled: !st ? 'no keeper — nothing is driving this character'
                 : !st.running ? `keeper stopped (mode ${st.mode})`
                 : st.stalled,
          ...(s.jobReport() ?? {}),
          // Whether anyone has been talking to this character, and whether anything is
          // waiting on an answer. This used to be unrepresentable here, which made the
          // one call built for supervising a fleet structurally deaf: a character could
          // be stood in a room being addressed for ten minutes and every field above
          // would look perfectly healthy.
          ...(() => {
            const box = inboxIfAny(name);
            if (!box) return { listening: false };
            const st2 = box.stats();
            return {
              listening: !!chatterIfAny(name)?.attached,
              heard: st2.heard_total,
              waiting: st2.escalated,
              needs_operator: st2.needs_operator,
              ...(st2.dropped_total ? { inbox_dropped: st2.dropped_total } : {}),
              ...(st2.refused_total ? { inbox_refused: st2.refused_total } : {}),
            };
          })(),
          ...(a.verbose && st ? { recent: st.recent } : {}),
        });
      }
      const stuck = rows.filter(r => r.stalled && r.stalled !== false);
      return {
        agents: rows.length,
        stalled_count: stuck.length,
        needs_attention: stuck.map(r => r.agent),
        fleet: rows,
        note: rows.length ? undefined : 'no sessions — join some characters first',
      };
    },
  },
  {
    name: 'who',
    description: 'Everyone logged in, agents and humans alike, with their object ids.',
    schema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      await s.pacer.submit('read', () => c.players());
      await c.waitFor({ kinds: ['who'], timeoutMs: 3000 });
      return { players: [...c.playersOnline.values()].map(p => ({ id: p.id, name: p.name })),
               here: [...c.room.objects.values()].filter(o => o.flags & OF.PLAYER)
                       .map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc) })) };
    },
  },
  {
    name: 'wait_for_event',
    description: 'Block until something happens, or until timeout. THIS IS HOW AN AGENT LISTENS: ' +
      'MCP is request/response, so the world can only reach an agent that asks. Speech from other ' +
      'players, things appearing or vanishing, damage taken, and shop replies all arrive here. ' +
      'Returns a cursor; pass it back as `since` next call and no event is seen twice or missed.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      since: { type: 'number', description: 'cursor from the previous call; omit to continue from wherever this agent last read, which on the first call is the start of the session' },
      kinds: { type: 'array', items: { type: 'string' },
               description: 'filter, e.g. ["said","appeared","vanished","message","stat"]' },
      timeout_ms: { type: 'number' } }, required: ['agent'] },
    run: async (a) => {
      const s = session(a.agent), c = s.need();
      const since = a.since === undefined ? s.cursor : num(a.since);
      // Anything already queued when we were called is a BACKLOG — it happened
      // while the agent was busy doing something else, and it returns instantly.
      // Saying so matters: an agent that has been acting for a minute and then
      // polls gets a minute of history in one gulp, and without this flag it looks
      // like all of it just happened.
      const buffered = c.eventsSince(since).length;
      // The event log is a 500-entry ring (m59-client.mjs), and a character in a fight
      // emits an event per point of health it loses. So a cursor left alone while the
      // character was busy can point at a sequence number that has already been evicted,
      // and `eventsSince` — a plain `seq > since` filter — would return the survivors
      // with no indication that anything was missing. Say how many.
      const oldest = c.events.length ? c.events[0].seq : c.evSeq + 1;
      const missed = Math.max(0, oldest - 1 - since);
      const { events, seq, timedOut } = await c.waitFor({
        since, kinds: a.kinds, timeoutMs: Math.min(num(a.timeout_ms, 30000), 120000) });
      s.cursor = seq;
      return { cursor: seq, timed_out: timedOut,
               backlog: buffered > 0 && !timedOut,
               ...(missed ? { dropped: missed,
                              dropped_note: `${missed} event(s) fell out of the 500-entry ring before this poll. ` +
                                            'Speech is also kept in the inbox, which is not evicted by combat — call `inbox`.' }
                          : {}),
               note: buffered > 0 ? 'these were already waiting; poll again with the returned cursor to hear what happens next'
                                  : undefined,
               events };
    },
  },
  {
    name: 'pilot',
    description:
      'HAND A CHARACTER OVER TO THE PERSON AT THE KEYBOARD, or take it back.\n' +
      'Meridian allows one connection per character, so a human opening a client as Kermit takes ' +
      'Kermit away from this broker. Claiming says that is deliberate: the keeper stops, the ' +
      'reconciler stops trying to rejoin, and the character is left alone until the client exits.\n' +
      'THE CLAIM IS BOUND TO A LOCAL PROCESS ID, and that is what makes it trustworthy. Not the ' +
      'character name, which anyone who guesses a password can wear — but a client this machine ' +
      'spawned, still running, holding the only session the server permits for that character. ' +
      'The broker polls that pid and releases the claim by itself when it exits, so B needs no ' +
      'second call; `release` is for giving the character back early.\n' +
      'While claimed, speech FROM that character to other fleet members is treated as instruction ' +
      'rather than as chat — see the operator verb table. That privilege lasts exactly as long as ' +
      'the pid does.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'release', 'status'] },
        agent: { type: 'string', description: 'the character being played; required for claim/release' },
        pid: { type: 'number', description: 'process id of the client that was launched, required for claim' },
        character: { type: 'string', description: 'name to expect in speech; defaults to the session\'s' },
      },
      required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'status') {
        return {
          piloted: [...piloted.entries()].map(([agent, p]) => ({
            agent, character: p.character, pid: p.pid, object_id: p.objectId,
            alive: pidAlive(p.pid), held_s: Math.round((Date.now() - p.since) / 1000),
            keeper_resumes_on_release: p.keeperWasRunning })),
          note: piloted.size ? undefined : 'nobody is being played by hand right now',
        };
      }
      if (!a.agent) return { error: 'agent is required' };
      if (a.action === 'release') {
        const p = releasePilot(a.agent, 'released by request');
        return p ? { released: true, agent: a.agent,
                     note: 'the reconciler will log it back in and restore the keeper it had' }
                 : { released: false, note: 'that character was not claimed' };
      }
      if (!a.pid) return { error: 'pid is required for claim — the claim is the process, not the name' };
      if (!pidAlive(a.pid)) return { error: `pid ${a.pid} is not running; refusing to claim on a dead process` };
      const r = claimPilot(a.agent, a.pid, { character: a.character });
      return { ...r, claimed: true,
               note: 'keeper stopped and the reconciler will leave it alone. Speech from this ' +
                     'character now counts as instruction, until pid ' + a.pid + ' exits.' };
    },
  },
  {
    name: 'leave',
    description:
      'Log the character out and free the session. It STAYS IN THE ROSTER by default, so a broker ' +
      'restart logs it back in — which is what you want when taking the fleet down for a minute to ' +
      'restart it on new code. Pass forget:true to retire the character instead, which drops its ' +
      'credentials from substrate/fleet-state.json and is not undoable from here.',
    schema: { type: 'object', properties: {
      agent: { type: 'string' },
      forget: { type: 'boolean',
        description: 'also drop it from the roster, so it is not logged back in on a restart. ' +
          'The roster is the only record of how to log this character in — there is no other copy' },
    }, required: ['agent'] },
    run: async (a) => {
      const s = sessions.get(a.agent);
      if (!s?.client) return { left: false, note: 'no such session' };
      // Stop the keeper first: a background loop still driving a socket we are about
      // to destroy produces a stream of confusing failures.
      dropAutopilot(a.agent);
      dropChatter(a.agent);
      if (a.forget) forgetAgent(a.agent);
      // Deliberate. The reconciler puts back characters that FELL out; this one was
      // taken out, and without `forget` it stays out until a restart or an explicit
      // join — which is what this tool has always promised.
      leftOnPurpose.add(a.agent);
      try { s.client.send(20 /* BP_LOGOFF */); } catch {}
      s.client.sock?.destroy();
      // Flush the recorder before dropping the session, or the last few seconds —
      // usually the interesting ones — never reach disk.
      try { s.recorder?.stop(); } catch {}
      sessions.delete(a.agent);
      // The inbox deliberately outlives the session: what somebody said is still worth
      // reading after the character it was said to has logged out.
      return { left: true, forgotten: !!a.forget,
               note: a.forget
                 ? 'autopilot and conversation stopped, and this character is out of the roster — ' +
                   'a restart will NOT log it back in. The inbox is kept.'
                 : 'autopilot and conversation stopped; still in the roster, so a broker restart ' +
                   'logs it back in. The inbox is kept.' };
    },
  },

  // Listening and answering. Kept in their own module so that the surface a responder
  // holds — `inbox` and nothing else — is one file you can read end to end.
  ...chatTools({ session, sessions, num, autopilotIfAny }),
];

const byName = new Map(TOOLS.map(t => [t.name, t]));

async function callTool(name, args) {
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tool "${name}"`);
  // Record the call against the character it was for, with how long it took and
  // whether it threw. Reconstructing "what did this agent actually do" from the
  // event stream alone is guesswork; the call order is the other half.
  const rec = args?.agent ? sessions.get(args.agent)?.recorder : null;
  const t0 = Date.now();
  try {
    const out = await t.run(args || {});
    rec?.line('call', { tool: name, args, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    rec?.line('call', { tool: name, args, ms: Date.now() - t0, error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------------- MCP

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'meridian59', version: '1.0.0' };

// One JSON-RPC handler, shared by both transports. Notifications (no id) get no
// reply, which matters: answering `notifications/initialized` with a result is a
// protocol error some clients reject the connection over.
async function handleRpc(msg) {
  const { id, method, params } = msg;
  const reply = result => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
    case 'tools/call': {
      const { name, arguments: args } = params || {};
      try {
        const out = await callTool(name, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // A tool failure is a result with isError, not a JSON-RPC error: the agent
        // needs to read the reason and try something else, and a transport-level
        // error is not shown to the model by most clients.
        return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list':   return reply({ prompts: [] });
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

function serveStdio() {
  let buf = '';
  process.stdin.on('data', async chunk => {
    buf += chunk;
    // Line-delimited JSON, which is what the stdio transport specifies.
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const out = await handleRpc(msg);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // Logging goes to stderr forever: stdout is the protocol channel, and one
  // stray console.log there corrupts the stream.
  console.error(`m59 broker on stdio — ${TOOLS.length} tools, ${resources.size} resources loaded`);
}

// HTTP is what lets heterogeneous agents share ONE broker process, which is the
// point of a broker: one resource table, one client per character, and every
// agent a peer of every human on the same game port.
function serveHttp(port) {
  const server = http.createServer(async (req, res) => {
    // A page for the human, on the same port everything else runs on. Read-only: it
    // renders the ledger and drives nothing, so it is safe to leave open in a tab.
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/fleet'))) {
      const hours = Number(new URL(req.url, 'http://x').searchParams.get('hours')) || 24;
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(renderDashboard({ hours }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('dashboard failed: ' + e.message);
      }
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, pid: process.pid, root: BROKER_ROOT,
                                      fleet: FLEET || 'default', state: STATE_FILE,
                                      sessions: [...sessions.keys()], tools: TOOLS.length }));
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      const outs = (await Promise.all(batch.map(handleRpc))).filter(Boolean);
      if (!outs.length) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(msg) ? outs : outs[0]));
    });
  });
  // Loopback by default, because this transport has no authentication of its own
  // and anyone who can reach it can drive every character. Set M59_BIND=0.0.0.0 to
  // expose it deliberately — behind something that does authenticate.
  const bind = process.env.M59_BIND || '127.0.0.1';
  server.listen(port, bind, () =>
    console.error(`m59 broker on http://${bind}:${port} — ${TOOLS.length} tools, ` +
                  `${resources.size} resources; game server ${HOST}:${PORT}` +
                  (bind === '127.0.0.1' ? '' : '  [WARNING: bound beyond loopback and UNAUTHENTICATED]')));
}

// ---------------------------------------------------------------- dashboard

// The status page on its own port, serving GET and nothing else.
//
// The obvious way to read the dashboard from a phone is to bind the broker itself to
// the LAN, and it is the wrong way: the broker's HTTP transport is the full JSON-RPC
// control surface with NO authentication, so anything that can reach it can log in,
// walk, fight, sell, and empty the bank of all twenty-five characters. Putting a
// read-only page on the same socket as that means exposing the second to see the
// first.
//
// So this is a separate server that can only render the ledger. It has no access to
// the tool dispatcher at all — there is no code path from here to a session — which
// is what makes it safe to point at a home network. Everything it can possibly do is
// return HTML about what already happened.
// WHAT ONE CHARACTER LOOKS LIKE, read out of state we already hold.
//
// Deliberately not a tool call: it submits nothing to the pacer, sends no packets and
// cannot act. Everything here is the client's own cache, which is what keeps the
// dashboard's "no code path to a session" property true in the sense that matters —
// it can look, and it can do nothing at all.
function heroSnapshot(name) {
  const wanted = String(name || '').toLowerCase();
  for (const [agent, s] of sessions) {
    const c = s.client;
    if (!c || (c.me?.name || '').toLowerCase() !== wanted) continue;
    const ap = autopilotIfAny(agent);
    const st = ap?.status({ full: true }) ?? null;
    const me = c.self;
    const room = s.world?.room;
    // Every stat the server has told us about, by the name it uses. This is the part
    // the agent tools filter out and a person actually wants.
    const stats = {};
    for (const [k, v] of (c.statsById ?? new Map()))
      if (!/^\d+\.\d+$/.test(k)) stats[k] = v?.text !== undefined ? v.text : v?.value;
    return {
      name: c.me?.name ?? name, agent,
      in_game: s.live === true,
      room: room ? { num: room.num, name: room.name } : null,
      position: me ? { col: me.col, row: me.row } : null,
      vitals: c.vitals?.() ?? {},
      stats,
      stamina: stats.stamina ?? null,
      ceiling: stats.stamina != null ? 101 + Number(stats.stamina) : null,
      inventory: (c.inventory || []).map(o => ({
        name: c.rsc.get(o.nameRsc), amount: o.amount || undefined, can: affordances(o.flags) })),
      max_carry: st?.policy?.maxCarry ?? null,
      skills: (c.skills || []).map(x => ({ name: c.rsc.get(x.nameRsc), ability: x.ability })),
      spells: (c.spells || []).map(x => ({
        name: c.rsc.get(x.nameRsc), ability: x.ability, school: x.school })),
      activity: ap ? ap.activity() : 'no keeper',
      strategy: st?.policy?.strategy ?? null,
      safe_spot: st?.safe_spot ?? false,
      threat: st?.threat ?? null,
      trials: st?.all_trials ?? st?.trials ?? [],
      journal: st?.journal ?? st?.recent ?? [],
      deaths: st?.did?.deaths ?? 0,
      deaths_in_safe_spot: st?.did?.deaths_in_safe_spot ?? 0,
      deaths_in_proven_safe_spot: st?.did?.deaths_in_proven_safe_spot ?? 0,
      mulligans: st?.did?.mulligans ?? 0,
      logoffs: st?.did?.logoffs ?? 0,
      credentials: fleetState.get(agent)?.credentials ?? null,
      client_path: process.env.M59_CLIENT_EXE || null,
    };
  }
  return null;
}

// Is this browser on the same machine as the broker? The launcher carries a password
// in plain text and this page is deliberately reachable from the LAN, so the two
// cannot both be true for the same request.
const isLocal = (req) => {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

// STOPPING AND RESTARTING HAVE TO BE DONE BY SOMEBODY ELSE.
//
// A process can stop itself but it cannot start itself afterwards, so restart is handed
// to a DETACHED m59-service.mjs, which outlives the broker it is about to kill and then
// brings the replacement up. Doing it in-process would kill the thing doing it halfway.
//
// Rejoin is different — it is just the reconciler, running now instead of at the next
// tick — so it is answered here and needs nothing external.
function handleControl(action, res) {
  const reply = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (action === 'rejoin') {
    if (!REJOIN) return reply(409, { ok: false, note: 'rejoining is disabled on this broker (--no-rejoin)' });
    // Kick it off and answer immediately: joining twenty characters takes longer than
    // any browser is willing to wait, and the page polls anyway.
    reconcileFleet().catch(e => console.error(`[rejoin] sweep failed: ${e.message}`));
    const out = [...fleetState].filter(([a]) => !sessions.get(a)?.live && !leftOnPurpose.has(a)).length;
    return reply(200, { ok: true, note: out ? `rejoining ${out} character(s) — watch the log` : 'everyone is already in game' });
  }
  if (action === 'restart' || action === 'stop') {
    const svc = new URL('./m59-service.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const args = [svc, action];
    if (FLEET) args.push('--fleet', FLEET);
    try {
      const child = spawn(process.execPath, args,
        { detached: true, stdio: 'ignore', cwd: BROKER_ROOT });
      child.unref();
    } catch (e) {
      return reply(500, { ok: false, note: `could not spawn the service: ${e.message}` });
    }
    // Answered before we are killed, which is the last useful thing this process does.
    return reply(200, { ok: true,
      note: action === 'restart'
        ? 'restarting — every character logs out and back in; this page returns in a few seconds'
        : 'stopping — start it again with: node tools/m59-service.mjs start' +
          (FLEET ? ` --fleet ${FLEET}` : '') });
  }
  return reply(404, { ok: false, note: `no such control "${action}"` });
}

function serveDashboard(port) {
  const server = http.createServer((req, res) => {
    const url0 = new URL(req.url, 'http://x');
    // THE ONLY WRITES THIS SERVER ACCEPTS, and only from the machine it runs on.
    //
    // This port binds to every interface so the page can be read from a phone, and the
    // argument for that is that there is nothing here to abuse. Controls are a write,
    // so they are refused for anything that is not loopback — checked here, at the
    // socket, not merely hidden in the markup.
    if (req.method === 'POST' && url0.pathname.startsWith('/control/')) {
      if (!isLocal(req)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false,
          note: 'controls are served only to 127.0.0.1 — open this page on the broker machine' }));
      }
      return handleControl(url0.pathname.slice('/control/'.length), res);
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end('read-only'); }
    const url = url0;
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, view: 'dashboard', readonly: true }));
    }
    // /hero/<name> and /hero/<name>/start.ps1
    if (url.pathname.startsWith('/hero/')) {
      const parts = url.pathname.slice('/hero/'.length).split('/');
      const who = decodeURIComponent(parts[0] || '');
      const h = heroSnapshot(who);
      if (parts[1] === 'start.ps1') {
        if (!isLocal(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('The launcher carries an account password, so it is only served to a ' +
                         'browser on the broker machine. Open this page on 127.0.0.1.');
        }
        if (!h?.credentials) { res.writeHead(404); return res.end('no credentials on file'); }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="start-${who.replace(/[^A-Za-z0-9]/g, '')}.ps1"`,
        });
        return res.end(startScript(h, {
          repo: process.cwd(),
          host: process.env.M59_HOST || '127.0.0.1',
          port: process.env.M59_PORT || '5959',
        }));
      }
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(renderHero(h, { localhost: isLocal(req) }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('hero page failed: ' + e.message);
      }
    }
    if (url.pathname !== '/' && !url.pathname.startsWith('/fleet')) {
      res.writeHead(404); return res.end('not found');
    }
    try {
      const hours = Number(url.searchParams.get('hours')) || 24;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderDashboard({ hours, localhost: isLocal(req) }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('dashboard failed: ' + e.message);
    }
  });
  // Bound to every interface ON PURPOSE. Unlike the broker port there is nothing
  // here to abuse: no tools, no sessions, no writes.
  const bind = process.env.M59_DASHBOARD_BIND || '0.0.0.0';
  server.listen(port, bind, () => {
    const nets = os.networkInterfaces();
    const lan = Object.values(nets).flat()
      .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.error(`m59 dashboard (read-only) on http://${bind}:${port}` +
                  (lan.length ? ` — reachable at ${lan.map(a => `http://${a}:${port}/fleet`).join(' ')}` : ''));
  });
}

// ---------------------------------------------------------------- selftest

async function selftest(account, password) {
  const call = async (name, args) => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
    const text = r.result.content[0].text;
    console.log(`\n== ${name} ${JSON.stringify(args)}`);
    console.log(text.length > 1400 ? text.slice(0, 1400) + '\n   ...' : text);
    if (r.result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  };

  const list = await handleRpc({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  console.log(`tools: ${list.result.tools.map(t => t.name).join(', ')}`);

  await call('join', { agent: 'test', account, password });
  const view = await call('look', { agent: 'test' });
  await call('status', { agent: 'test' });
  await call('who', { agent: 'test' });
  await call('inventory', { agent: 'test' });

  const foe = view.objects?.find(o => o.can?.includes('attack'));
  const seller = view.objects?.find(o => o.can?.includes('buy'));
  const anything = view.objects?.[0];

  if (anything) await call('look_at', { agent: 'test', target: anything.id });
  await call('say', { agent: 'test', text: 'the broker is up' });

  if (foe) {
    await call('approach', { agent: 'test', target: foe.id, distance: 1 });
    await call('attack', { agent: 'test', target: foe.id, swings: 3 });
  } else console.log('\n(nothing attackable in this room — skipping combat)');

  if (seller) await call('shop', { agent: 'test', seller: seller.id });
  else console.log('\n(nobody selling here — skipping shop)');

  // The progression surface. `abilities` is the one that matters: the numbers were
  // arriving and being thrown away, so the assertion is that a number came back at
  // all, not what it is.
  const ab = await call('abilities', { agent: 'test', known_only: false });
  const rows = [...(ab.skills || []), ...(ab.spells || [])];
  const graded = rows.filter(x => x.ability != null);
  if (!rows.length) {
    // Not a failure. A character made by "create automated" has plSpells and
    // plSkills both empty — it knows nothing at all, so there is nothing to grade
    // and it cannot improve any ability until it buys one from a teacher.
    console.log('\n   -> this character knows no skills or spells, so there is nothing to grade');
  } else if (!graded.length) {
    throw new Error(`abilities returned ${rows.length} entries and not one number — ` +
                    'stat groups 3/4 are not arriving, or the join by object id broke');
  } else {
    console.log(`\n   -> ${graded.length}/${rows.length} entries carry an ability number`);
  }

  // Every one of these goes out as BP_USERCOMMAND (opcode 155), which is the only
  // opcode >= 128 this client sends. Before the sign-extension fix in gameSecurity
  // they each hung the session up silently, so the real assertion is that the
  // session is still alive on the far side of them.
  await call('rest', { agent: 'test' });
  await call('rest', { agent: 'test', stand: true });
  await call('safety', { agent: 'test', on: true });
  await call('bank', { agent: 'test', action: 'balance' });
  const alive = await call('status', { agent: 'test', brief: true });
  if (!alive.in_game)
    throw new Error('session died during the user-command block — the BP_USERCOMMAND ' +
                    'checksum regressed (see gameSecurity in m59-client.mjs)');
  console.log('\n   -> session survived every BP_USERCOMMAND');

  await call('wait_for_event', { agent: 'test', timeout_ms: 2500 });
  await call('leave', { agent: 'test' });
  console.log('\nselftest finished');
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  const i = argv.indexOf('--selftest');
  const [acct, pw] = argv.slice(i + 1);
  if (!acct || !pw) { console.error('usage: m59-broker.mjs --selftest <account> <password>'); process.exit(1); }
  try { await selftest(acct, pw); process.exit(0); }
  catch (e) { console.error(`selftest failed: ${e.message}`); process.exit(1); }
} else if (argv.includes('--http')) {
  serveHttp(Number(argv[argv.indexOf('--http') + 1] || 8899));
  if (!argv.includes('--no-resume')) resumeFleet();
  startLedger();
  startReconciling();
  startPilotWatch();
  const di = argv.indexOf('--dashboard');
  if (di >= 0) serveDashboard(Number(argv[di + 1] || 8902));
} else {
  serveStdio();
  if (!argv.includes('--no-resume')) resumeFleet();
  startLedger();
  startReconciling();
  startPilotWatch();
}


// The whole hand-over, driven from both ends, because both ends are ours.
//
// Shared by the `supply` tool and by the quartermaster resupply pass. It is one
// function because the ORDER is the part that is easy to get wrong: accepting before a
// counteroffer has arrived is logged by the server as cheating and cancels the trade,
// and a trade that never completed looks exactly like one that did unless somebody
// reads the receiver's inventory afterwards.
async function supplyBetween(a) {
  const gs = session(a.from), rs = session(a.to);
  const g = gs.need(), r = rs.need();
  if (a.from === a.to) throw new Error('a character cannot supply itself');
      await gs.pacer.submit('read', () => g.requestInventory());
      await g.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});

      // What to hand over. Reagents are matched by name because the server gives us
      // names, not classes, and the two the creation spells need are the only ones
      // worth naming here.
      const nameOf = o => g.rsc.get(o.nameRsc) || '';
      let items;
      if (Array.isArray(a.what)) {
        items = (g.inventory || []).filter(o => a.what.includes(o.id));
      } else if (a.what === 'all') {
        items = [...(g.inventory || [])];
      } else if (a.what === 'food') {
        items = skills.larderOf(g).map(x => x.o);
      } else {
        const per = num(a.amount, 2);
        const take = re => (g.inventory || []).filter(o => re.test(nameOf(o))).slice(0, per);
        items = [...take(/elder\s*berry/i), ...take(/herb/i)];
      }
      if (!items.length)
        return { supplied: false, reason: `${g.me?.name} is carrying nothing matching ` +
                 `${Array.isArray(a.what) ? 'those ids' : (a.what || 'reagents')}`,
                 carrying: (g.inventory || []).map(nameOf) };

      // Get them into one room. Whoever walks, walks to the other.
      const who = a.who_travels || 'from';
      const groom = gs.world?.room?.num, rroom = rs.world?.room?.num;
      if (groom !== rroom && who !== 'neither') {
        const [mover, dest] = who === 'to' ? [rs, groom] : [gs, rroom];
        if (dest == null) return { supplied: false, reason: 'cannot see which room the other one is in' };
        const t = await mover.travel(dest, { maxHops: 14 }).catch(e => ({ arrived: false, reason: e.message }));
        if (!t.arrived)
          return { supplied: false, reason: `${who === 'to' ? r.me?.name : g.me?.name} could not get there: ${t.reason}`,
                   note: 'the newbie zone is not connected to the rest of the map — the museum portal is one-way' };
      }

      // The receiver has to be visible to the giver for the offer to resolve.
      const them = [...g.room.objects.values()]
        .find(o => (o.flags & OF.PLAYER) && (g.rsc.get(o.nameRsc) || '') === (r.me?.name || ''));
      if (!them) return { supplied: false, reason: `${r.me?.name} is not in the room with ${g.me?.name}` };

      const handed = items.map(nameOf);
      const before = (r.inventory || []).length;

      // offer -> counter with NOTHING (that is how a gift is accepted, and it is what
      // grants the giver permission to accept) -> giver accepts.
      await gs.pacer.submit('trade', () => g.offer(them.id, items.map(o => o.id)));
      const sawIt = await r.waitFor({ kinds: ['offered-to-us'], timeoutMs: 6000 }).catch(() => ({ events: [] }));
      if (!sawIt.events?.length) {
        await gs.pacer.submit('trade', () => g.cancelOffer()).catch(() => {});
        return { supplied: false, reason: 'the offer never reached them' };
      }
      await rs.pacer.submit('trade', () => r.counterOffer([]));
      await g.waitFor({ kinds: ['countered'], timeoutMs: 6000 }).catch(() => ({ events: [] }));
      await gs.pacer.submit('trade', () => g.acceptOffer());

      // Prove it. A trade that did not complete looks exactly like one that did.
      await new Promise(x => setTimeout(x, 1400));
      await rs.pacer.submit('read', () => r.requestInventory());
      await r.waitFor({ kinds: ['inventory'], timeoutMs: 4000 }).catch(() => {});
      const now = (r.inventory || []).map(o => r.rsc.get(o.nameRsc) || '');
      const got = handed.filter(n => now.includes(n));

      return {
        supplied: got.length > 0,
        from: g.me?.name, to: r.me?.name,
        handed_over: got,
        not_received: handed.filter(n => !got.includes(n)),
        receiver_carrying: now.length, was_carrying: before,
        note: got.length
          ? 'confirmed in the receiver\'s inventory, not merely offered'
          : 'the trade did not complete — nothing moved',
      };
}
