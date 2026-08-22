// m59-game.mjs — Session class and its dependencies, extracted from m59-broker.mjs.
//
// Phase 3: Per-character keeper processes. The Session class (3400 lines) and its
// immediate dependencies (Recorder, constants, helper functions) are extracted here
// so that keeper processes can import Session without loading the full HTTP gateway.
//
// Import surface:
//   import { Session, Pacer } from './m59-session.mjs';
//   import { Session } from './m59-game.mjs';  // direct
//
// The broker imports Session from here:
//   import { Session, Recorder } from './m59-game.mjs';

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { M59Client, KOD_FINENESS, BPNAME, BP } from './m59-client.mjs';
import { loadResources } from './m59-rsc.mjs';
import { describeObject, affordances, OF, blocksMovement, prepareActTarget } from './m59-parse.mjs';
import { World, spreadEdges, boundedSilentGo, boundedRegionEntry,
         doorSettleMs, remainingDoorSettle } from './m59-world.mjs';
import { loadMap, movementMapReadiness, resolveRoom, forgetInferredExit, findPath }
         from './m59-map.mjs';
import { CLIENT_FINENESS, elideLoops, protocolToClient, loadRoo } from './m59-roo.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
import { loadMerchants } from './m59-merchants.mjs';
import { loadSpells, karmaAllows, requiredKarma, SCHOOLS } from './m59-spells.mjs';
import * as abilities from './m59-abilities.mjs';
import * as hitbook from './m59-hits.mjs';
import * as transits from './m59-transits.mjs';
import * as bankbook from './m59-bank.mjs';
import * as descriptions from './m59-describe.mjs';
import { RemainingRequiredToLearnNewSkills, PointsToNextLevelOfTarget } from '../compendium/tools/learn.mjs';
import { StorageCache } from './m59-storage.mjs';
// Session.join() calls joinSessionOnce and the Phase 3 extraction left it behind: the
// BROKER imports it, and ESM modules do not share scope, so the reference here was free
// and `join()` threw ReferenceError wherever it was called. Nothing called it -- the
// keeper process uses joinOnce directly -- so a broken method sat in the class until the
// first outside caller found it.
import { joinSessionOnce } from './m59-session-readiness.mjs';

// noteGeometryDrift is defined in m59-broker.mjs and used here for
// drift logging. In the keeper process (no broker), it's undefined.
// Provide a no-op fallback so movement validation doesn't crash.
if (typeof noteGeometryDrift !== 'function') {
  globalThis.noteGeometryDrift = (session, drift) => {
    // Log drift to stderr for debugging
    if (process.env.M59_DEBUG_DRIFT) {
      console.error(`[drift] ${session.name ?? '?'} ${JSON.stringify(drift)}`);
    }
  };
}
import { loadSpawns } from './m59-spawns.mjs';
import * as skills from './m59-skills.mjs';

const SPAWN_FILE = process.env.M59_SPAWN_FILE ||
  fileURLToPath(new URL('../substrate/m59-spawns.json', import.meta.url));
const CURSED_ITEMS = /amulet of shadows|ring of lethargy/i;
const RECORD_DIR = process.env.M59_RECORD_DIR ||
  fileURLToPath(new URL('../substrate/recordings/', import.meta.url));
const RECORD_WINDOW_MS = Number(process.env.M59_RECORD_WINDOW_MS || 120_000);
const RECORD_KEEP = Number(process.env.M59_RECORD_KEEP || 15);
// Facing coalescing tolerance (degrees) for the turn-before-move in walkTo. A player only
// turns when the heading changes; we suppress the per-step re-face that pushed us over the
// server's 5-packet/s throttle. See docs/packet-throttle.md.
const FACE_EPS = 8;
// How long (ms) after the combat controller faces a target the walkTo turn-before-move must
// NOT re-face to the movement heading. Without this, closing the gap to a target oscillated
// the facing between the target and the walk direction, so every melee swing whiffed on the
// server's view-cone check (player.kod ~4185: a target behind the facing line is rejected).
const COMBAT_FACE_HOLD_MS = 1500;

// ---------------------------------------------------------------- constants
// Server hard limit: INCOMING_PACKET_THROTTLE = 5 (user.kod:50). Above this the server
// sets bSpam and SILENTLY DROPS the packet (no error, no response). We were at 12, which
// meant ~2.4x our packets were being dropped as spam -- the cause of the slow movement,
// the ~0.2/s swing rate, and the zero combat responses.
//
// 8 is a deliberate middle value, NOT the fix. The real fix is to stop PRODUCING more
// than ~5 packets/s (see docs/packet-throttle.md): the tick loop at 10Hz was submitting
// a move/face every 100ms regardless of whether it changed anything, so the queue grew
// faster than any drain rate could keep up. Capping the drain at 5 made it worse (attacks
// queued behind a flood of redundant moves). 8 keeps the backlog from growing unbounded
// while the production throttle is implemented; it is a stopgap, not a solution.
// Server throttle: INCOMING_PACKET_THROTTLE = 5 (user.kod:50). The server drops
// packets silently when it receives more than 5/s. We pace at exactly 5/s so we
// never trip the throttle. The old 8/s was 60% over the limit — the server was
// dropping our swings and moves.
const PACKETS_PER_SECOND = Number(process.env.M59_RATE || 5);
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

// HOW LONG A BOUNDARY CROSSING MAY TAKE TO COME BACK. Not the same question as a door,
// and not the same answer: the operator's account of doing this by hand is that under
// load you stop dead against the edge and are moved a beat later, so a slow crossing is
// the ordinary case rather than a failed one. At the old 4s this gave up on crossings
// that were still in flight and reported them as "stepping past the edge did nothing" —
// the reading that makes a working exit look like a phantom, and the one that would have
// had us delete a real edge from the map.
const EDGE_CROSSING_WAIT_MS = Number(process.env.M59_EDGE_CROSSING_WAIT_MS || 10000);

// The server may silently discard UserGo when it follows the final movement packet
// too closely. Preserve normal 250ms walking, but leave half a second between the
// most recent movement packet and every door request. Pacer waits only the remaining
// portion of this interval, so slow position confirmation does not add another 500ms.
const DOOR_SETTLE_MS = doorSettleMs(process.env.M59_DOOR_SETTLE_MS);

// HOW OFTEN THE ROOM MAY BE RE-READ WHILE WALKING. A hard cap, not a target.
//
// `step()` used to re-read the whole room after every single square, and that round trip
// is 1.2-5.6s regardless of how much is in the room. It is why the fleet walked at 0.55
// squares a second against a person's 4.1 in the same room, and why MOVE_INTERVAL_MS —
// tuned to 250ms specifically to make walking faster — did nothing at all.
//
// Six seconds is chosen to be far longer than a step and far shorter than a crossing: at
// four squares a second it is one read every ~24 squares instead of one per square, and
// nothing in a room changes so fast that a six-second-old object map makes a walk wrong.
const ROOM_RESYNC_MS = Number(process.env.M59_ROOM_RESYNC_MS || 6000);

// user.kod:46. At or below this you are walking; above it you are running, which
// needs vigor >= 10 and costs exertion quadratically in the speed.
const WALK_SPEED = 18;
// USER_RUNNING_SPEED, user.kod:47 — what the real client sends when it runs. This was
// 24, a number from nowhere: above the walking threshold, so it paid the full cheat
// check, but not what any client emits.
const RUN_SPEED  = Number(process.env.M59_RUN_SPEED || 36);
// The server snaps you back and logs you if speed > 18 with vigor < VIGOR_RUN_THRESHOLD
// = 10 (user.kod:54, :2958). This was 25 — a margin of fifteen over a hard limit of ten,
// which is not caution, it is walking. At 0.18 vigor a second the whole reason for the
// margin is gone: a character at 12 that runs for ten seconds is still above the
// threshold, and a character that walks because it is at 24 is walking through the
// exact ground that kills this fleet. Two points of headroom against a race between
// our reading of vigor and the server's.
const RUN_VIGOR_FLOOR = 12;

// WHAT RUNNING COSTS, ARITHMETIC RATHER THAN NERVES — because the caution here was
// expensive and was never priced.
//
// user.kod:3020 charges exertion once per second as EXERTION_PER_MOVE * (speed*5/6)^2,
// with EXERTION_PER_MOVE = 2 (user.kod:26). necroam.kod:518 gives the scale: 20000
// units is commented "2 vigor points", so 10000 units is one vigor point.
//
//   walking, speed 18:  2 * 15^2 =  450/s = 0.045 vigor/s
//   running, speed 36:  2 * 30^2 = 1800/s = 0.18  vigor/s
//
// So a full minute of unbroken sprinting costs about ELEVEN vigor. Dying costs
// vastly more than that and takes the character out of play besides. The old rule
// spent vigor only in rooms the spawn index called dangerous, which is precisely
// backwards: the spawn index describes where we choose to fight, and nearly every
// travel death is on ground in between. There is no such thing as safe travel here;
// speed is the safety mechanism. So we run whenever we can afford to, everywhere.
const VIGOR_UNIT = 10000;                                     // necroam.kod:518
export const exertionPerSecond = speed => 2 * Math.floor(speed * 5 / 6) ** 2;

// HOW FAST THE REAL CLIENT ACTUALLY MOVES, which is the thing we were never matching.
//
// move.c:184 moves 2*MOVEUNITS per MOVE_DELAY when the action is a *FAST one and
// MOVEUNITS otherwise; MOVEUNITS is FINENESS>>2 = 256 client units and MOVE_DELAY is
// 100ms (move.c:49,53, draw3d.h:53). So:
//
//   running  512 units / 100ms = 5120/s = 5.0 squares/second
//   walking  256 units / 100ms = 2560/s = 2.5 squares/second
//
// and move.c:59 tells the server at most once per MOVE_INTERVAL = 1000ms. That is the
// shape the speedhack comment describes from the other side — "normal players only
// send 1 movement packet per second" — and it is one packet covering about five
// squares, not five packets covering one square each.
//
// We were doing the opposite: one square per packet, four packets a second, 4 sq/s at
// the very best and measured at 1.18. Sending FEWER packets that each cover more
// ground is both faster and further from the cheat detector, which is a rare
// direction for a change to go.
const SQUARES_PER_SECOND = { [WALK_SPEED]: 2.5, [RUN_SPEED]: 5.0 };
const squaresPerSecond = speed => SQUARES_PER_SECOND[speed] ?? (speed > WALK_SPEED ? 5.0 : 2.5);

// The cap on one hop, and it is a real server rule rather than taste. user.kod:3072
// logs a suspected teleport and DRAINS VIGOR as a penalty when the squared distance
// from the position at the last second-boundary reaches 200 with under 3 seconds
// elapsed — so about 14 squares. One second of running is 5 squares, squared distance
// 25, comfortably inside it. Eight is the ceiling this uses, which is still only 64.
const MOVE_HOP_MAX_SQUARES = Number(process.env.M59_MOVE_HOP_MAX || 8);

// HOW MANY OFF-PLAN LANDINGS BEFORE THE WALKER STOPS TALKING IN SQUARES.
//
// Measured on room 587's approach to its western gap: 4 of 9 planned steps land somewhere
// other than the plan asked for from one start, 24 of 42 from another — so the rate is
// high enough that a threshold of two or three separates "the world moved" from "my plan
// is in the wrong unit", while a walk across open floor never reaches it at all. Three,
// because two is within the noise of a single monster stepping across a doorway.
//
// Raise it to disable the behaviour without removing it; the square walk below is
// unchanged and still ends the walk honestly on its own budget.
const OFFPLAN_BEFORE_FINE = Number(process.env.M59_OFFPLAN_BEFORE_FINE || 3);

// HOW CLOSE A TRACED LINE MUST LAND TO COUNT AS ARRIVING, when deciding whether several
// planned squares can be crossed in one packet.
//
// A sixteenth of a square. It is deliberately tight: the whole safety argument for
// skipping ground is that the line ARRIVED rather than slid, and a loose threshold would
// quietly readmit the sliding this is meant to avoid. Loosening it does not make walks
// succeed, it makes them skip ground nothing checked.
const PIVOT_ARRIVE_WITHIN = Number(process.env.M59_PIVOT_ARRIVE_WITHIN || 64);

// ---------------------------------------------------------------- storage
const storage = new StorageCache();
const resources = loadResources();
let worldMap = loadMap();

// Attach baked step masks so pathfinding uses the mover's own geometry
// (fine BSP) instead of the coarse grid (monster perspective).
import { attachStepMasks } from './m59-routes.mjs';
try {
  const masks = attachStepMasks(worldMap);
  if (masks.attached > 0) {
    console.error(`[routes] ${masks.attached} room(s) planning on the mover's own geometry` +
      (masks.refused ? `, ${masks.refused} mask(s) refused as the wrong size` : ''));
  }
} catch (e) {
  console.error(`[routes] no step masks — ${e.message}`);
}

// ---------------------------------------------------------------- recorder
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

// ---------------------------------------------------------------- helpers

// Of several exits that all lead to the same place, try the reachable ones first
// and the nearest of those first. `reachable` is undefined for kinds the geometry
// cannot judge, so only an explicit false demotes a candidate.
// Stubs for broker-level infrastructure that the Session class references.
// These are fire-and-forget calls with .catch(), so a no-op stub is safe.
async function readFactionStatus(s, { refresh = false } = {}) {
  return { character: s.client?.me?.name ?? s.name, faction: 'unknown', soldier: false,
           observed_at: null, source: null, cached: false, max_health: null,
           note: 'faction read not available in keeper process' };
}
function chatterIfAny(name) { return null; }

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
  // AN EXIT WITH NO SQUARE TO STAND ON GOES LAST. Without a stand_on, leaveVia falls
  // back to scanning the whole boundary line for somewhere walkable — and when that
  // line has no floor it fails outright, which is the "no floor anywhere on the west
  // boundary" dead end. A sibling exit that names an actual square is strictly better,
  // even if it is further away, because it is the one that can be walked to.
  (a.stand_on == null) - (b.stand_on == null) ||
  (a.steps_away ?? Infinity) - (b.steps_away ?? Infinity));


async function readAbilitiesOnce(s, { why = 'read', kinds = 'both' } = {}) {
  if (!s.live) return null;
  await abilities.readLive(s, { kinds });
  return s.recordAbilities({ why });
}

// ---------------------------------------------------------------- Pacer

class Pacer {
  constructor(rate = PACKETS_PER_SECOND) {
    this.minGapMs = 1000 / rate;
    this.q = [];
    this.running = false;
    this.lastSent = 0;
    this.lastByKind = new Map();
    // Packet-rate accounting for the server's 5/s throttle (user.kod:50). production =
    // how many jobs the tick loop SUBMITS per second (the bug: >5/s); sent = how many
    // actually leave the socket per second (what the server counts). If production > sent
    // the queue is backing up; if sent > 5 the server is dropping us as spam. Exposed via
    // the keeper's /pacerstats for ground-truth measurement.
    this.prodTimes = [];   // submission timestamps (rolling)
    this.sentTimes = [];   // send timestamps (rolling)
    this.prodByKind = new Map();  // kind -> rolling submission timestamps
  }

  // Per-kind production rate, for diagnosing WHAT is flooding the queue.
  prodByKindRate() {
    const cutoff = Date.now() - 3000;
    const out = {};
    for (const [kind, times] of this.prodByKind) {
      while (times.length && times[0] < cutoff) times.shift();
      out[kind] = +(times.length / 3).toFixed(2);
    }
    return out;
  }

  // Rolling per-second counts. Keep a 3s window so a just-ended second is still visible.
  _rate(times) {
    const cutoff = Date.now() - 3000;
    while (times.length && times[0] < cutoff) times.shift();
    return times.length / 3;  // avg per second over the window
  }

  submit(kind, fn, minGapForKind = 0) {
    this.prodTimes.push(Date.now());
    if (!this.prodByKind.has(kind)) this.prodByKind.set(kind, []);
    this.prodByKind.get(kind).push(Date.now());
    const job = { kind, fn, minGapForKind, resolve: null, reject: null, queuedAt: Date.now() };
    // PRIORITY: attack packets are time-critical (server cooldown = 1s). They jump
    // the queue ahead of move/turn/read packets so swings don't wait behind a backlog
    // of movement packets. Without this, a busy mover (move+turn every ~270ms) pushes
    // the swing to every 3s instead of every 1s.
    const isUrgent = kind === 'attack' || kind === 'cast';
    if (isUrgent) {
      // Insert after any other urgent packets but before non-urgent ones.
      let i = 0;
      while (i < this.q.length && (this.q[i].kind === 'attack' || this.q[i].kind === 'cast')) i++;
      this.q.splice(i, 0, job);
    } else {
      this.q.push(job);
    }
    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      this.pump();
    });
  }

  // What the server sees: jobs that actually leave the socket, per second.
  sentRate() { return this._rate(this.sentTimes); }
  // What the tick loop is asking for: submissions per second. If this is >> sentRate()
  // the queue is backing up; if it is > 5 we are over the server's throttle.
  prodRate() { return this._rate(this.prodTimes); }

  static budget = new Map();
  static startedAt = Date.now();
  static note(kind, phase, ms) {
    const k = `${kind}.${phase}`;
    const b = Pacer.budget.get(k) ?? { ms: 0, n: 0 };
    b.ms += ms; b.n++;
    Pacer.budget.set(k, b);
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
        const waitKind = job.kind === 'move' && job.minGapForKind === DOOR_SETTLE_MS
          ? remainingDoorSettle({ lastMovementAt: lastKind, now, settleMs: job.minGapForKind })
          : Math.max(0, lastKind + job.minGapForKind - now);
        const wait = Math.max(waitGlobal, waitKind);
        Pacer.note(job.kind, 'queued', Math.max(0, now - job.queuedAt));
        Pacer.note(job.kind, waitKind >= waitGlobal ? 'paced' : 'throttled', wait);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        else await new Promise(r => setTimeout(r, 0));
        this.lastSent = Date.now();
        this.lastByKind.set(job.kind, this.lastSent);
        this.sentTimes.push(this.lastSent);
        const t0 = Date.now();
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
        Pacer.note(job.kind, 'send', Date.now() - t0);
        await new Promise(r => setImmediate(r));
      }
    } finally { this.running = false; }
  }
}

// ---------------------------------------------------------------- session
class Session {
  constructor(name) {
    this.name = name;
    this.pacer = new Pacer();
    this.client = null;
    this.world = null;
    // Fleet resume and an HTTP caller can request the same slot during broker
    // boot. They must share one login attempt instead of racing two sockets for
    // the same character.
    this.joining = null;
    this.cursor = 0;                    // last event seq this agent has been told about
    this.fine = false;                  // fine-movement mode — see walkFine
    this.recorder = new Recorder(name); // flight recorder; never surfaced in replies
    this.job = null;                    // one background action — see startJob
    // Every movement operation captures this generation when it starts. Bumping it
    // invalidates walks already in progress without poisoning later, independent
    // orders. This is deliberately session-local: one character has one body.
    this.movementGeneration = 0;
    this.cancelledMovementTokens = new Set();
    // BP_PLAYER/BP_MOVE do not carry the body's visual z. Keep a short-lived,
    // conservative range after changing floor height so a rapid follow-up packet
    // cannot assume an instantaneous climb/fall and slip through a low arch or up
    // the next step. Re-entering a room or the settle deadline resets it naturally.
    this.collisionVertical = null;
    // HOW GOOD THIS CHARACTER IS, kept across logins and across restarts of this
    // process. Loaded lazily by character name, because the agent name is which slot
    // of the fleet is driving and gets reassigned — the character is the thing that
    // has the skills. See m59-abilities.mjs.
    this.book = null;
    this.bookSaveTimer = null;
    // WHERE THIS CHARACTER GETS HURT, off the event stream rather than off the keeper.
    //
    // Health is PUSHED — one BP_STAT per change — so this records at full resolution
    // through the windows where nothing else is looking: mid-travel, mid-errand, and
    // while the keeper is inert with something else driving. Those windows are where the
    // fleet has been dying and are exactly what the post-mortem cannot see. See
    // m59-hits.mjs.
    this.hits = null;                   // the book, loaded lazily by character name
    this.lastHealth = null;             // to tell a hit from a heal
    this.lastCombatLine = null;         // { at, who } — best-effort attribution
    this.hitsSaveTimer = null;
    // HOW LONG EACH MAP TAKES TO CROSS. The other half of the same question and the more
    // actionable one: damage on the road is normal and not a fault, but two minutes inside
    // one room is a slow crossing, and slow is something we control. See m59-transits.mjs.
    this.transits = null;
    this.transitSaveTimer = null;
    // A PvP target is never inferred from a name or a broadcast. The opt-in faction
    // game surface records only a freshly inspected player profile in this room and
    // expires it quickly; engage() rechecks the profile once more before attacking.
    this.factionGameTargets = new Map();
  }

  // The hit record for whoever this session is currently playing. Keyed by CHARACTER and
  // not by agent, for the same reason the ability book is: the agent name is which slot of
  // the fleet is driving and gets reassigned.
  hitBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.hits || this.hits.character !== who) this.hits = hitbook.loadBook(who);
    return this.hits;
  }

  // The transit record for whoever this session is currently playing. Keyed by CHARACTER
  // for the same reason the others are — the agent name is a fleet slot and gets reused.
  transitBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.transits || this.transits.character !== who) this.transits = transits.loadBook(who);
    return this.transits;
  }

  // ONE MAP, CROSSED ONCE. Called from travel()'s hop loop — see m59-transits.mjs.
  noteTransit(entry) {
    const book = this.transitBook();
    if (!book) return;
    try {
      transits.record(book, { at: Date.now(), ...entry });
      // On a timer, like the hit book: a journey writes one of these per room and there is
      // no reason to put the disk in the middle of a walk.
      if (!this.transitSaveTimer) {
        this.transitSaveTimer = setTimeout(() => {
          this.transitSaveTimer = null;
          try { transits.saveBook(this.transits); } catch { /* never let a write stop play */ }
        }, 10_000);
        this.transitSaveTimer.unref?.();
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  // WHO IS SWINGING, when the server happens to have said so.
  //
  // Damage arrives as a stat packet and names nobody; the prose that names an attacker is
  // a separate message and there is no id tying the two together. They do arrive close
  // together, so a combat line within a couple of seconds of a health drop is almost
  // always about it — and "almost always" is the honest description, which is why this
  // lands in a `by` LIST on the segment rather than a `killed_by` field that would read as
  // authoritative. The death broadcast is the authoritative one and the post-mortem
  // already has it.
  noteCombatLine(ev) {
    // "The fungus beast nicks you with its attack." / "The troll hits you."
    const m = /^(?:The|An?) ([a-z' -]+?) (?:[a-z]+s) you\b/i.exec(ev.text || '');
    if (m) this.lastCombatLine = { at: ev.at ?? Date.now(), who: m[1].toLowerCase() };
  }

  // ONE HEALTH READING. Called for every health stat the server sends.
  //
  // A DROP IS A HIT AND A RISE IS NOT, and that is the whole of the logic that cannot live
  // in m59-hits.mjs — it sees one number at a time and has no way to tell regeneration
  // from damage. Resting, eating and a heal all push health the other way and must never
  // become segments.
  //
  // A LOGIN IS NOT A HIT EITHER. `lastHealth` is cleared on join, so the first reading
  // after a login establishes the baseline rather than being compared against whatever the
  // character had before it died.
  noteHealth(ev) {
    const now = ev.at ?? Date.now();
    const value = ev.value, max = ev.max;
    if (typeof value !== 'number') return;
    const before = this.lastHealth;
    this.lastHealth = value;
    if (before == null || value >= before) return;      // a heal, or the first reading
    const book = this.hitBook();
    if (!book) return;
    const me = this.client?.self;
    const keeper = autopilotIfAny(this.name);
    const line = this.lastCombatLine;
    try {
      hitbook.record(book, {
        at: now,
        room: this.world?.room?.num ?? null,
        roomName: this.world?.room?.name ?? null,
        col: me?.col ?? null, row: me?.row ?? null,
        // WHAT THE KEEPER THOUGHT IT WAS DOING. `doing` is cleared at the end of each
        // pass, so `lastDoing` is what a reading taken between passes should report — and
        // between passes is precisely when travel damage arrives.
        doing: keeper?.doing ?? keeper?.lastDoing ?? null,
        health: value, max: max ?? null,
        lost: before - value,
        by: line && now - line.at < 2500 ? line.who : null,
      });
      // Written on a timer rather than per hit: a character under six attackers takes one
      // every second or two, and a synchronous write each time would put the disk in the
      // packet path. Ten seconds is far shorter than any window we would want to explain.
      if (!this.hitsSaveTimer) {
        this.hitsSaveTimer = setTimeout(() => {
          this.hitsSaveTimer = null;
          try { hitbook.saveBook(this.hits); } catch { /* never let a write stop play */ }
        }, 10_000);
        this.hitsSaveTimer.unref?.();
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  get live() { return this.client && this.client.state === 'game'; }

  // The ability record for whoever this session is currently playing.
  abilityBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.book || this.book.character !== who) this.book = abilities.loadBook(who);
    return this.book;
  }

  // Writes are batched. An advancement arrives as its own packet and a character in a
  // good fight can gain several in a minute; one file write each would be a lot of
  // syscalls to record a number that nothing reads until somebody asks.
  saveBookSoon() {
    if (this.bookSaveTimer) return;
    this.bookSaveTimer = setTimeout(() => {
      this.bookSaveTimer = null;
      if (this.book) abilities.saveBook(this.book);
    }, 5000);
    this.bookSaveTimer.unref?.();
  }

  // One advancement, as the server pushed it. This is the whole reason the cache does
  // not need polling: ChangeSkillAbility sends BP_STAT for the slot that moved, every
  // time (player.kod:7343), so the record is written as it happens rather than
  // reconstructed later from two reads and a subtraction.
  noteAdvancement(ev) {
    const book = this.abilityBook();
    if (!book) return;
    const changed = abilities.noteAdvancement(book, ev);
    if (changed.length) this.saveBookSoon();
  }

  // A BANK BALANCE GOES PAST ON THE WIRE AND IS NEVER MENTIONED AGAIN. Catch it here.
  //
  // Same reasoning as noteAdvancement above and the same seam, for a stronger reason:
  // an ability can at least be re-read for four requests, and a balance cannot be read
  // at all without walking the character to a counter. The server states it as PROSE
  // from a banker's mouth (monster.kod:136) and there is no packet to poll, so if this
  // line goes past unread the number is gone until someone spends the walk.
  //
  // It was going past unread. The only balances this fleet had on record were the ones
  // that happened to fall inside a flight recording still on disk, or inside the
  // postmortem of a character that died shortly after banking. Everything else had
  // already been pruned.
  //
  // Cheap enough to do on every message: m59-bank.mjs bails on the first regex for
  // anything that is not about an account, which is every line but a handful per hour.
  // What this character has on deposit, written down the moment the vaultman says it.
  //
  // The fee the packet carries per item is kept: it is `GetVaultRetrievalFee`, which is
  // what getting the thing back will cost, and that is a different number from what the
  // item is worth. Storing it means the board can say what emptying the vault would cost
  // without another trip.
  noteVault(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      const entry = storage.writeVault(who, ev.items || [],
        { at: ev.at ?? Date.now(), account: ev.vaultmanId ?? null });
      this.recorder.line('note', { what: 'vault contents recorded', character: who,
        items: entry.items.length });
    } catch { /* a record is a convenience; never let it interrupt play */ }
  }

  // THE ONLY NOTICE A FACTION MEMBER EVER GETS, CAUGHT ON ITS WAY PAST.
  //
  // `player_faction_time` (player.kod:160) is `MsgSendUser` prose, sent once when the
  // service counter crosses FACTION_WARN_TIME, and there is no packet, no stat and
  // nothing to poll. Four hours later `ResignFaction` runs and the character is out. So
  // this is the bank-balance pattern exactly: written down at the moment it is said, or
  // the fleet finds out by noticing a membership has quietly become 'neutral'.
  //
  // The expulsion line is caught too, because "the deadline passed" and "the server threw
  // this character out" are different claims and only the second one is observed.
  noteLoyalty(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      if (isLoyaltyWarning(ev.text)) {
        const status = factionStatuses.read(who);
        const entry = factionStatuses.noteLoyaltyWarning(who,
          { at: ev.at ?? Date.now(), soldier: status?.soldier === true });
        this.recorder.line('note', { what: 'faction loyalty warning', character: who,
          faction: entry.faction, due_at: entry.loyalty?.due_at ?? null,
          soldier: entry.loyalty?.soldier_at_warning === true });
      } else if (isLoyaltyLost(ev.text)) {
        factionStatuses.noteLoyaltyLost(who, { at: ev.at ?? Date.now() });
        this.recorder.line('note', { what: 'faction membership lost', character: who });
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  noteBanker(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      const entry = bankbook.record(who, ev.text, {
        at: ev.at ?? Date.now(),
        room: this.client?.room?.id ?? null,
        roomName: this.world?.room?.name ?? null,
      });
      if (entry) {
        this.lastBank = entry;
        this.recorder.line('note', { what: 'bank balance recorded', ...entry });
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  // The last balance we know of, for whichever account was touched most recently.
  // Null rather than zero when nothing has ever been recorded — "we have not seen this
  // character at a bank" and "this character has nothing" are different answers.
  bankKnown() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    try {
      const rows = bankbook.balancesFor(who);
      if (!rows.length) return null;
      const latest = rows[0];
      return {
        balance: latest.balance, account: latest.account, at: latest.at,
        observed: latest.observed,
        ...(rows.length > 1 ? { accounts: Object.fromEntries(rows.map(r => [r.account, r.balance])) } : {}),
      };
    } catch { return null; }
  }

  // Fold everything the client currently holds into the record. Called after the read
  // that follows a login, and after any refresh.
  recordAbilities({ why = 'read' } = {}) {
    const book = this.abilityBook();
    if (!book || !this.client) return null;
    const known = this.client.abilitiesKnown();
    const changed = abilities.mergeAbilities(book, {
      skills: known.known.skills ? known.skills : null,
      spells: known.known.spells ? known.spells : null,
    }, { why });
    abilities.saveBook(book);
    return changed;
  }

  // The server accepts one move packet per second and there is no way around that,
  // so a cross-map walk genuinely costs minutes of wall clock. For a single
  // character, blocking for those minutes is honest. For a fleet it is the wrong
  // shape: a supervisor moving twenty characters would spend twenty times the
  // longest walk, in series, purely because the reply is the only way to learn the
  // outcome. So: start it, return now, and let `status` and `fleet` carry the
  // result. One job at a time per session — the character has one body.
  startJob(kind, label, fn, { controlToken = null, leaseToken = null } = {}) {
    if (this.job && !this.job.done) throw new Error(`${this.name} is busy: ${this.job.label}`);
    const generation = this.movementGeneration;
    const job = { kind, label, startedAt: Date.now(), done: false, generation,
                  ...(controlToken ? { controlToken } : {}),
                  ...(leaseToken ? { leaseToken } : {}) };
    this.job = job;
    fn(generation).then(r => { job.result = r; }, e => { job.error = e.message; })
        .finally(() => { job.done = true; job.finishedAt = Date.now(); });
    return job;
  }

  movementWasCancelled(generation, controlToken) {
    return generation !== this.movementGeneration ||
      (!!controlToken && this.cancelledMovementTokens.has(controlToken));
  }

  cancelledMovement(extra = {}) {
    return { arrived: false, left: false, cancelled: true,
             reason: 'movement cancelled by a newer command', ...extra };
  }

  cancelMovement(controlToken) {
    const job = this.job && !this.job.done ? this.job : null;
    this.movementGeneration++;
    if (controlToken) {
      this.cancelledMovementTokens.add(controlToken);
      // Tokens are short-lived command leases, not history. Keep enough to cover
      // stale local requests without letting a long-running broker grow forever.
      if (this.cancelledMovementTokens.size > 100) {
        this.cancelledMovementTokens.delete(this.cancelledMovementTokens.values().next().value);
      }
    }
    if (job) {
      job.cancelRequestedAt = Date.now();
      job.cancelled = true;
    }
    return {
      cancelled: true,
      interrupted: job ? { kind: job.kind, label: job.label } : null,
      note: job
        ? 'the active movement will stop after its current paced server step'
        : 'any in-flight foreground walk will stop after its current paced server step',
    };
  }

  jobReport() {
    return rtsJobReport(this.job);
  }

  async join(args) {
    return joinSessionOnce(this, args, value => this.joinOnce(value));
  }

  async joinOnce({ account, password, character, host = HOST, port = PORT }) {
    // Kept so the session can put itself back together. A `save game` renumbers
    // every object id, which leaves a live session holding a selfId the server has
    // stopped using — see Autopilot.pass. Logging in again is the only cure, and it
    // needs these.
    this.credentials = { account, password, character, host, port };
    const c = new M59Client({ host, port, verbose: false, resources });
    // Everything the server says, straight to disk. This is the only place the raw
    // stream is kept — the in-memory event ring is small and is overwritten fast.
    //
    // Advancement is picked off the same stream on its way past. It has to be caught
    // here rather than polled for: the server sends one BP_STAT the instant an ability
    // moves and never mentions it again, so a poll that arrives later sees the number
    // but not the event, and cannot tell a gain from a value it had all along.
    // A FRESH LOGIN IS A FRESH BASELINE. Without this the first health reading after a
    // death would be compared against whatever the character had before it died and
    // recorded as one enormous hit in whatever room it woke up in.
    this.lastHealth = null;
    this.lastCombatLine = null;
    c.onEvent = ev => {
      this.recorder.line('event', ev);
      if (ev.kind === 'ability') this.noteAdvancement(ev);
      if (ev.kind === 'message' && ev.text) { this.noteBanker(ev); this.noteCombatLine(ev); this.noteLoyalty(ev); }
      // A VAULT ANSWERS ONCE AND ONLY WHEN ASKED, so this is caught off the stream for
      // exactly the reason a bank balance is: whatever walked a character to a vaultman
      // has already paid for the trip, and if the reply goes past unread the contents are
      // unknown until somebody pays for it again.
      if (ev.kind === 'vault-list') this.noteVault(ev);
      // OFF THE STREAM, NOT OFF THE KEEPER. This is the one measurement that keeps
      // working while the keeper is inside a multi-minute travel await or held inert by
      // an errand — which is where 23 of the last 50 deaths happened. See m59-hits.mjs.
      if (ev.kind === 'stat' && ev.name === 'health') this.noteHealth(ev);
    };
    if (character) c.wantName = character;
    await c.login(account, password);
    this.client = c;
    this.world = new World(c, worldMap);

    // WRITE THE NAME DOWN. The roster records an account and a password; which CHARACTER
    // that account is only becomes known once the login gets as far as the character
    // list, and it was being thrown away every time. That is why the resume log prints
    // "resumed t1 (?)" for characters this broker has run for weeks.
    //
    // It matters beyond tidiness: the startup check that stands down for a person playing
    // one of ours has to ask the who list whether that character is online, and the who
    // list speaks names, not accounts. With nothing on record it can only take the client
    // command line's word for it.
    const learned = c.me?.name ?? null;
    if (learned && learned !== this.credentials.character) {
      this.credentials = { ...this.credentials, character: learned };
      const entry = fleetState.get(this.name);
      if (entry?.credentials) {
        fleetState.set(this.name, { ...entry, credentials: { ...entry.credentials, character: learned } });
        saveFleetState();
      }
    }
    // The server does not volunteer the world. Ask, paced, and let the replies
    // land before reporting.
    await this.pacer.submit('read', () => c.roomContents());
    await this.pacer.submit('read', () => c.players());
    await this.pacer.submit('read', () => c.requestInventory());
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    await new Promise(r => setTimeout(r, 600));

    // ABILITIES, ONCE, HERE. Four more requests, and this is the only place they have
    // to be spent: from now on the server pushes every change, so the cache stays
    // true without anybody asking again.
    //
    // Deliberately not awaited. It is four paced requests and a settle, and a fleet
    // resume brings twenty-one sessions up at once — making each login wait for its
    // own ability read would add that to the time the fleet is not playing, to
    // populate something nothing needs in the first second.
    this.firstAbilityRead = readAbilitiesOnce(this)
      .catch(e => { this.recorder.line('note', { what: 'ability read failed', why: e.message }); });

    // FACTION MEMBERSHIP, ONCE, HERE, FOR THE SAME REASON — except that unlike abilities
    // the server never pushes a change, so this is the only moment it can be caught
    // cheaply. It is one paced `look` at ourselves, and `Player.TryLook` (user.kod:4374)
    // checks invisibility, checks the room and sends the profile: it moves nothing, breaks
    // no invisibility and touches no aggression timer, so there is no safe-moment to wait
    // for and nothing is attracted by asking.
    //
    // Deliberately not awaited, exactly as above: a fleet resume brings twenty-one sessions
    // up at once and none of them should wait on a profile read to start playing. A person
    // who joins a faction between logins therefore has it noticed at the next login rather
    // than never, which is what happened to Piggy — joined the Jonas rebels, and the board
    // reported neutral until somebody asked by hand.
    //
    // `M59_FACTION_ON_LOGIN=0` turns it off.
    if (process.env.M59_FACTION_ON_LOGIN !== '0')
      readFactionStatus(this, { refresh: true })
        .then(status => this.recorder.line('note', { what: 'faction read', faction: status?.faction }))
        .catch(e => { this.recorder.line('note', { what: 'faction read failed', why: e.message }); });
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

  // Raw cached perception for a renderer. Unlike view(), this never runs A* for
  // every object and exit. Keep tactical validation on view(); keep frames fast here.
  perception() {
    this.need();
    return this.world.perception();
  }

  // WHAT IS WORTH WALKING AROUND, AND HOW WIDE A BERTH IT IS WORTH.
  //
  // Every number here is the monster's own, from `monster.kod`:
  //
  //   GetVisionDistance()  4 + viDifficulty/2      (:1676) — "either 4, 5, or 6"
  //   GetAttackRange()     Bound(2 + viDifficulty/6, 2, 3)  (:1682)
  //
  // which leaves a band two to three squares wide where it has noticed you and still
  // has to close. Crossing that band at a run costs nothing; standing in it is a
  // fight. That is the whole case for routing round rather than through.
  //
  // `CanSee` is a plain distance test with no line-of-sight call, so a wall does not
  // hide us and the radius is a disc rather than a cone. Difficulty comes from the
  // spawn index, which cites the kod for each creature; anything we cannot identify
  // gets the top of the published range rather than the bottom, because being wrong
  // toward caution costs a short detour and being wrong the other way costs a fight.
  //
  // Deliberately NOT a hard avoid. A route that only exists through something's reach
  // is still a route, and refusing it would strand characters exactly as the coarse
  // grid does at doorways.
  threatsHere(view = null) {
    const v = view ?? this.view();
    const creatures = loadSpawns(SPAWN_FILE)?.creatures ?? {};
    const out = [];
    for (const o of (v.objects ?? [])) {
      if (o.is_player) continue;
      if (!(Array.isArray(o.can) && o.can.includes('attack'))) continue;
      if (o.row == null || o.col == null) continue;
      const meta = creatures[String(o.name ?? '').toLowerCase()];
      const diff = meta?.difficulty;
      out.push({
        row: o.row, col: o.col, name: o.name,
        vision: diff != null ? 4 + Math.floor(diff / 2) : 6,
        reach:  diff != null ? Math.min(3, Math.max(2, 2 + Math.floor(diff / 6))) : 3,
      });
    }
    return out;
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
  async faceToward(target, { beforePacket = null } = {}) {
    const c = this.need();
    const me = c.self;
    if (!me || !target) return null;
    const dx = target.col - me.col, dy = target.row - me.row;
    if (dx === 0 && dy === 0) return me.degrees;
    // kod angle 0 is east and increases clockwise as rows grow downward, which is
    // exactly what atan2(dy, dx) gives in screen coordinates.
    const deg = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI)) % 360 + 360) % 360;
    await this.pacer.submit('turn', () => {
      if (typeof beforePacket === 'function') beforePacket('turn');
      return c.face(deg);
    });
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
  // RUN EVERYWHERE. The previous rule ran only in rooms the spawn index called
  // dangerous, and walked everywhere else — which sounds prudent and is backwards.
  //
  // The spawn index describes where we go to FIGHT. It says nothing about the ground
  // between, and the ground between is where the fleet dies: 20 deaths at the border
  // of the Badlands, 17 of the last 23 travel deaths outbound to a hunting ground.
  // Every one of those was walked at half pace to save a resource that costs 0.18
  // vigor a second — about eleven for a whole minute of sprinting — while a death
  // costs the character its equipment, its position and the rest of the hour.
  //
  // So the gate is affordability, not location. The floor stays at 25 rather than the
  // server's 10 so that arriving somewhere still leaves enough vigor to fight.
  moveSpeed() {
    const c = this.client;
    const vigor = c?.vitals?.()?.vigor?.value ?? 0;
    if (this.walkOnly) return WALK_SPEED;
    if (vigor < RUN_VIGOR_FLOOR) return WALK_SPEED;      // too tired; the server would snap us back
    return RUN_SPEED;
  }

  // STAND UP BEFORE TRYING TO LEAVE THE ROOM.
  //
  // `Player.ResetFlags` (player.kod:1162) sets PFLAG_NO_MOVE, PFLAG_NO_FIGHT and
  // PFLAG_NO_MAGIC together whenever IsResting, and `UserGo` (user.kod:5657) refuses
  // on that flag with "You are unable to go anywhere." — which is 589 of our 700
  // failed hops, and reads in the transit log as the map being shut rather than as
  // the character being sat down.
  //
  // Nothing clears resting by itself, and at least one path sits deliberately: the
  // unarmed branch rests to regain mana and holds it. So the character can be seated
  // for a minute at a time with every exit attempt failing identically.
  //
  // Sent unconditionally rather than guarded on a cached "am I resting" flag, because
  // that flag is exactly the thing that goes stale — the server never announces the
  // rest ending, and a wrong `false` costs a whole journey while a redundant stand
  // costs one packet.
  async standBeforeGo() {
    const c = this.need();
    await this.pacer.submit('rest', () => c.stand());
  }

  // AND CONFIRM WHERE THE SERVER THINKS WE ARE, ONCE, BEFORE CROSSING OUT.
  //
  // `Room.SomethingTryGo` matches the exit against `piRow`/`piCol` — the SERVER's
  // position, not ours — and its refusal is the same "You are unable to go anywhere."
  // that a seated character gets. Two causes, one message, opposite fixes.
  //
  // Walking is dead-reckoned now, deliberately: the server does not echo a mover's own
  // accepted move, so predicting is the only alternative to a 1.2-5.6s round trip per
  // square. That trade is right in the middle of a room and wrong at its edge — cant-go
  // went from 36% to 52% of all crossings when the resync cap shipped, because a
  // predicted square we never actually reached looks exactly like an exit that does not
  // work.
  //
  // So: one read per HOP, not one per square. That is a single round trip against a
  // whole room crossing, which keeps essentially all of the speed and removes the
  // entire class of failure. It also makes a retry meaningful — `approachSquare` is
  // computed from where we are, so re-planning from a predicted position returns the
  // identical answer forever, which is what a character stuck in a doorway loop is
  // actually doing.
  async confirmPosition() {
    const c = this.need();
    this.lastRoomRead = Date.now();
    // There may already be a fire-and-forget room read in flight. Waiting for merely
    // "the next room-contents event" can consume that older snapshot and certify the
    // exact stale position this method was called to correct. The protocol returns
    // these reads in request order, so wait through any older replies until the local
    // ordinal for this request has arrived.
    //
    // A TIMED-OUT READ ANSWERS null, IT DOES NOT THROW. Callers already treat an
    // unknown position as a wrong one — goThrough leans into the doorway in fine units
    // rather than sending a `go` it has no evidence for — and that is the whole design.
    // Throwing here would turn a transient dropped reply into an exception out of the
    // middle of a walk, which is a worse answer than "I do not know where I am".
    const since = c.evSeq;
    const request = await this.pacer.submit('read', () => c.roomContents());
    const t0 = Date.now();
    let cursor = since, fresh = true;
    // BOUNDED IN WALL CLOCK, NOT ONLY PER REPLY. The per-wait timeout below only ends this
    // loop if replies STOP; every reply that arrives for an older request advances `cursor`
    // and sends it round again, so a stream of traffic keeps it spinning while the ordinal
    // it wants never lands. That is not hypothetical — measured on the live fleet, 18 of 21
    // characters sat inside one keeper pass for 300-1090s and CLIMBING, completing zero
    // passes, at ~38% CPU. Low CPU is the tell: they were not computing, they were waiting
    // 2s at a time, for ever. The board said "travelling" throughout and nobody moved.
    const CONFIRM_DEADLINE_MS = 8000;
    while ((c.roomContentsReceived ?? request) < request) {
      if (Date.now() - t0 >= CONFIRM_DEADLINE_MS) { fresh = false; break; }
      const reply = await c.waitFor({ since: cursor, kinds: ['room-contents'], timeoutMs: 2000 });
      if (reply.timedOut) { fresh = false; break; }
      cursor = reply.seq;
    }
    Pacer.note('confirm_position', 'blocked', Date.now() - t0);
    if (!fresh) return null;
    return c.self ? { col: c.self.col, row: c.self.row } : null;
  }

  validateFineTarget(x, y, { slide = false } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me = c.self;
    if (!me) return { available: false, moved: false, blocked: true,
                      reason: 'own_position_unknown' };
    if (!geo?.traceFineMoveClient) return {
      available: false, moved: false, blocked: true,
      reason: 'collision_geometry_unavailable',
      note: 'this room has no locally validated BSP collision geometry',
    };
    // BOUNDED, AND THE BOUND IS THE WHOLE FIX. This refusal is correct while a sector or
    // wall program is in flight — the stock client mutates its BSP on those packets and we
    // cannot. It was NOT correct for ever: the flag is cleared only by BP_PLAYER, which
    // arrives on a room change, and changing rooms needs the movement this refuses. Any
    // room that animates became a cage, and three characters were in one inside ten
    // minutes. `until` is stamped by the client; a legacy record without one still blocks,
    // which is the safe reading of "we do not know when this ends".
    //
    // Pure on purpose: m59-collision-test lifts this method out by text, so this may use
    // nothing but `this`, the injected dependencies and built-ins.
    // AND SCOPED TO THE SECTOR THAT MOVED, WHICH IS THE SECOND HALF OF THE SAME FIX.
    //
    // Bounding the refusal in TIME stopped a room being a permanent cage only while the
    // animation is rare. The Temple of Qor door in room 598 cycles faster than the 8s
    // window, so every packet re-armed the block and the bound never expired: reproduced
    // with the character claimed so nothing else could steer it, six attempts across
    // seventy seconds, never moved one square. The operator had already named that room as
    // THE exception to "the geometry does not change day to day".
    //
    // The refusal was always wider than its own justification. This file's note says it:
    // after the animation "the walls are still where the bake says — only sector HEIGHTS
    // can have shifted". One sector moved; the rest of the room is exactly as baked. So
    // refuse a move that STARTS OR ENDS in that sector, and let the rest of the room walk.
    //
    // `sector` absent means we could not tell which — a short packet, or a wall program
    // rather than a sector one — and that reads as "we do not know", so the whole room is
    // still refused. Same safe reading `until == null` already gets.
    const invalidated = c.room.collisionInvalidated;
    if (invalidated && (invalidated.until == null || Date.now() < invalidated.until)) {
      let touches = true;
      if (Number.isInteger(invalidated.sector) && typeof geo.leafAtClient === 'function') {
        const scale0 = CLIENT_FINENESS / KOD_FINENESS;
        const wx = Number.isFinite(me.x) ? me.x : me.col * KOD_FINENESS + (KOD_FINENESS >> 1);
        const wy = Number.isFinite(me.y) ? me.y : me.row * KOD_FINENESS + (KOD_FINENESS >> 1);
        const inSector = (cx, cy) => {
          const leaf = geo.leafAtClient(cx, cy);
          return leaf != null && leaf.sectorNum === invalidated.sector;
        };
        touches = inSector((wx - KOD_FINENESS) * scale0, (wy - KOD_FINENESS) * scale0)
               || inSector((x - KOD_FINENESS) * scale0, (y - KOD_FINENESS) * scale0);
      }
      if (touches) return {
        available: false, moved: false, blocked: true,
        reason: 'collision_geometry_changed',
        note: `${invalidated.kind} changed live room geometry` +
              (Number.isInteger(invalidated.sector) ? ` in sector ${invalidated.sector}` : '') +
              '; movement is fail-closed until that animation finishes or the room is re-entered',
      };
    }
    const roomSecurity = c.room.security;
    if (!Number.isInteger(roomSecurity) || !Number.isInteger(geo.security)) return {
      available: false, moved: false, blocked: true, reason: 'room_security_unknown',
      note: 'cannot bind baked collision geometry to the room version announced by the server',
    };
    // PURE, AND IT HAS TO STAY PURE. m59-collision-test.mjs lifts this method out of this
    // file by text and evals it, because the broker cannot be imported without taking the
    // fleet lock — so anything this function CALLS must also exist in that scope. The
    // evidence for the drift record is returned instead, and the caller writes it down.
    if ((roomSecurity & 0x0fffffff) !== (geo.security & 0x0fffffff)) {
      // In the keeper process, the baked .roo may be stale relative
      // to the server's room version. The geometry is still usable
      // for collision — the mismatch means the .roo needs re-baking,
      // not that movement should be blocked. Log the drift and
      // proceed with the available geometry.
      if (process.env.M59_KEEPER) {
        if (process.env.M59_DEBUG_DRIFT)
          console.error(`[drift] ${this.name ?? '?'} room geometry mismatch: live=${roomSecurity >>> 0} baked=${geo.security >>> 0}`);
        // Fall through and use the geometry anyway
      } else {
        return { available: false, moved: false, blocked: true, reason: 'room_geometry_mismatch',
                 drift: { room: c.room.id, live: roomSecurity >>> 0, baked: geo.security >>> 0 },
                 note: 'the server announced a different .roo security value; refresh collision geometry' };
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || x > 0xffff || y < 0 || y > 0xffff) return {
      available: false, moved: false, blocked: true, reason: 'invalid_move_target',
    };
    const scale = CLIENT_FINENESS / KOD_FINENESS;
    // Wire coordinates carry a +64 bias. The official client's ExtractCoordinates
    // subtracts it before entering 0-based 1024-unit BSP space, and RequestMove adds
    // it back. Keeping raw wire coordinates elsewhere is intentional; convert only
    // at this collision boundary.
    const toClient = value => (value - KOD_FINENESS) * scale;
    const toProtocol = (value, fromValue) => {
      const wire = value / scale + KOD_FINENESS;
      if (value > fromValue) return Math.floor(wire + 1e-9);
      if (value < fromValue) return Math.ceil(wire - 1e-9);
      return Math.round(wire);
    };
    const fromWireX = Number.isFinite(me.x) ? me.x : me.col * KOD_FINENESS + (KOD_FINENESS >> 1);
    const fromWireY = Number.isFinite(me.y) ? me.y : me.row * KOD_FINENESS + (KOD_FINENESS >> 1);
    const fromX = toClient(fromWireX), fromY = toClient(fromWireY);
    const obstacles = [...c.room.objects.values()]
      .filter(object => object.id !== c.selfId && blocksMovement(object.flags ?? 0)
        && Number.isFinite(object.x) && Number.isFinite(object.y))
      .map(object => ({ id: object.id, x: toClient(object.x), y: toClient(object.y) }));
    const vertical = this.collisionVertical;
    const now = Date.now();
    const motionZ = vertical?.roomId === c.room.id && vertical.settleAt > now
      && Number.isFinite(vertical.min) && Number.isFinite(vertical.max)
      ? { min: vertical.min, max: vertical.max }
      : null;
    if (vertical && (!motionZ || vertical.roomId !== c.room.id)) this.collisionVertical = null;
    const traceOptions = {
      slide, obstacles,
      roomFlags: c.room.flags ?? 0,
      overrideDepths: c.room.overrideDepths ?? null,
      motionZ,
    };
    let requestedTrace = geo.traceFineMoveClient(fromX, fromY, toClient(x), toClient(y), traceOptions);

    // A TRACE FROM NOWHERE ANSWERS NOTHING, AND REFUSING ON IT IS A CAGE.
    //
    // `traceFineMoveClient` tests the leaf under the ORIGIN before it tests a single wall,
    // and answers `start_has_no_floor` when there is none. That refusal is about where we
    // ARE, not about where we are going — so it is identical for every heading, and the
    // fan in `walkFine` tries nine of them, at four reaches, and gets it thirty-six times.
    // Measured offline against room 587's real geometry: from the centre of square 2,4 the
    // walk to the west exit fails with `blocked — every heading refused` having sent
    // ZERO PACKETS, while from three of the surrounding squares — and from the parts of
    // 2,4 that do have floor, 21 of 64 points sampled — the identical call arrives in
    // three or four packets. A character whose position reads as such a point cannot move
    // by any path this file owns: `walkTo`'s off-grid recovery routes through here too,
    // which is why it reports `could not step back onto solid ground`.
    //
    // The server has no opinion about any of this. It does not validate player movement at
    // all — `ReqSomethingMoved` is bypassed for users — so the only thing holding the
    // character still is our own check, applied from an origin the check itself calls
    // invalid. That is the definition of failing closed on no information.
    //
    // SO: WHEN THE ORIGIN HAS NO FLOOR, THE DESTINATION DECIDES. Narrowly, and every
    // clause is load-bearing:
    //
    //   * only for `start_has_no_floor` — a wall between here and there is still a wall,
    //     and every other refusal is about the journey rather than the origin;
    //   * the destination must itself be standable, checked by the same BSP that just
    //     refused, so this can only ever move a character ONTO valid floor;
    //   * at most one square, so it is a recovery step and not a licence to cross a room;
    //   * and it is reported as `recovered_from_no_floor`, because a move nothing
    //     validated must be visible to whatever reads the result.
    //
    // This cannot widen what the fleet may traverse: the reachable set is unchanged for
    // every character standing anywhere the trace can start from. It only restores the
    // ability to leave a square the model cannot reason about — which the game plainly
    // allows, because a person walks off those squares without noticing they exist.
    let recovered = null;
    // The recovery radius is 3 cells (3×KOD_FINENESS) rather than 1, because
    // some rooms (e.g. the Twisted Wood, room 587) have coarse-grid pockets
    // where the character's position and several surrounding cells are all
    // marked unwalkable, but the server allows the character to stand there.
    // The nearest walkable square can be 2-3 cells away.
    const NO_FLOOR_RECOVERY_RADIUS = 3 * KOD_FINENESS;
    if (requestedTrace.reason === 'start_has_no_floor'
        && Math.abs(x - fromWireX) <= NO_FLOOR_RECOVERY_RADIUS
        && Math.abs(y - fromWireY) <= NO_FLOOR_RECOVERY_RADIUS
        && geo.leafAtClient(toClient(x), toClient(y))) {
      recovered = { from: { x: fromWireX, y: fromWireY } };
      requestedTrace = { available: true, moved: true, arrived: true, blocked: false,
                         slid: false, x: toClient(x), y: toClient(y),
                         reason: 'recovered_from_no_floor' };
    }
    if (!requestedTrace.available) return requestedTrace;
    if (!requestedTrace.moved) return requestedTrace;

    // Protocol coordinates are integer KOD units. Quantize toward the starting point,
    // then require that exact integer endpoint to be reachable. A trace can clip at a
    // leaf/headroom edge as well as a wall; wall-radius padding alone is not enough.
    let quantizedX = toProtocol(requestedTrace.x, fromX);
    let quantizedY = toProtocol(requestedTrace.y, fromY);
    let trace = null;
    // THE QUANTIZER RE-TRACES FROM THE SAME ORIGIN, so a recovery has to carry through it
    // or it is undone one line later — the loop below would ask the identical question,
    // get `start_has_no_floor` again, and refuse. The endpoint is already an exact integer
    // wire coordinate (it is the caller's own target, checked for floor above), so there
    // is nothing left for the quantizer to converge on.
    if (recovered) {
      quantizedX = Math.round(x); quantizedY = Math.round(y);
      trace = { ...requestedTrace, arrived: true };
    }
    for (let attempt = 0; !recovered && attempt < 8; attempt++) {
      trace = geo.traceFineMoveClient(fromX, fromY, toClient(quantizedX), toClient(quantizedY),
        traceOptions);
      if (!trace.available) return trace;
      if (trace.arrived) break;
      if (!trace.moved) return trace;
      const nextX = toProtocol(trace.x, fromX), nextY = toProtocol(trace.y, fromY);
      if (nextX === quantizedX && nextY === quantizedY) return {
        ...trace, moved: false, reason: trace.reason ?? 'geometry_blocked',
        note: 'no collision-safe integer protocol endpoint was available',
      };
      quantizedX = nextX; quantizedY = nextY;
    }
    if (!trace?.arrived) return { ...trace, moved: false,
      reason: trace?.reason ?? 'geometry_blocked',
      note: 'collision-safe protocol quantization did not converge' };
    if (!Number.isInteger(quantizedX) || !Number.isInteger(quantizedY)
        || quantizedX < 0 || quantizedX > 0xffff || quantizedY < 0 || quantizedY > 0xffff)
      return { available: false, moved: false, blocked: true, reason: 'invalid_move_target' };
    return {
      ...trace,
      target: { x: quantizedX, y: quantizedY },
      requested: { x: Math.round(x), y: Math.round(y) },
      blocked: requestedTrace.blocked || trace.blocked,
      slid: requestedTrace.slid || trace.slid,
      reason: trace.reason ?? requestedTrace.reason,
    };
  }

  async queueValidatedMove(x, y, { speed = 18, slide = true, beforeMutation = null,
                                    minGap = MOVE_INTERVAL_MS, expectedRoomId = null,
                                    offMap = false } = {}) {
    const c = this.need();
    const roomId = expectedRoomId ?? c.room.id;
    if (c.room.id !== roomId) return { sent: false, validation: {
      available: false, moved: false, blocked: true, reason: 'room_changed_before_move',
    } };

    // OFF THE MAP IS A LEGAL DESTINATION, AND THE LOCAL VALIDATOR CANNOT KNOW THAT.
    //
    // One move in the whole client deliberately targets a square that does not exist:
    // the outward step past a room boundary, which is the ONLY thing that reaches
    // `Room.SomethingMoved`'s `new_col < 1` branch and therefore the only thing that
    // triggers StandardLeaveDir (room.kod:2232-2258). The BSP has no floor out there, so
    // `validateFineTarget` clips at the boundary, never reports `arrived`, and the packet
    // is never sent. Measured on Alpha against 587 -> 576: 50 attempts, 5 crossings, and
    // 28 of the 45 failures were "every square for that exit refused". The operator's
    // description of watching it was exact — it looked scared to touch the wall.
    //
    // Sending anyway is not a relaxation of collision. `UserMove` BYPASSES
    // `ReqSomethingMoved` for users — room.kod's own comment is "already been checked by
    // client (HAHA!)" — so there is no server-side geometry check on a player move to
    // defer to, and the real client sends this same packet. See the dead-reckoning note
    // below, which is the same argument.
    //
    // It is opt-in per call and used in exactly one place. NO BREADCRUMB IS RECORDED: the
    // escape logic replays crumbs in reverse and its whole safety argument is that every
    // crumb was a move the validator accepted, so a crumb pointing off the map would let
    // it "undo" its way through a wall.
    if (offMap) {
      const target = { x: Math.round(x), y: Math.round(y) };
      return this.pacer.submit('move', () => {
        if (c.room.id !== roomId) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'room_changed_before_move' } };
        const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
        if (!before) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'own position unknown' } };
        if (typeof beforeMutation === 'function') beforeMutation('move', { x, y });
        const eventSeq = c.evSeq;
        c.moveTo(target.x, target.y, speed, roomId);
        return { sent: true, roomId, eventSeq, before, target,
                 validation: { available: true, moved: true, blocked: false, offMap: true, target } };
      }, minGap);
    }

    const initial = this.validateFineTarget(x, y, { slide });
    // WRITE DOWN THAT PROD MOVED. Otherwise a drifted room is only ever visible as a move
    // that did not happen — and the baked map is evidence about somebody else's server,
    // which can be patched without telling us.
    if (initial?.drift) noteGeometryDrift(this, initial.drift);
    if (!initial.available || !initial.moved || !initial.target)
      return { sent: false, validation: initial };
    return this.pacer.submit('move', () => {
      // Pacing can delay this callback while an asynchronous room entry, teleport,
      // or older room read changes the world beneath it. Bind the packet to the room
      // it was requested in and recompute from the live start immediately before send.
      if (c.room.id !== roomId) return { sent: false, validation: {
        available: false, moved: false, blocked: true, reason: 'room_changed_before_move',
      } };
      const validation = this.validateFineTarget(x, y, { slide });
      if (validation?.drift) noteGeometryDrift(this, validation.drift);
      const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
      if (!validation.available || !validation.moved || !validation.target || !before)
        return { sent: false, validation };
      if (validation.target.x === before.x && validation.target.y === before.y)
        return { sent: false, validation: { ...validation, moved: false } };
      if (typeof beforeMutation === 'function') beforeMutation('move', { x, y });
      const eventSeq = c.evSeq;
      // BREADCRUMBS — the only record of how this character got where it is standing.
      //
      // A safe spot IS the coarse grid and the BSP disagreeing, which is what makes it
      // safe and what the fleet seeks out. Since the router plans on the collision view,
      // a character parked in such a pocket cannot plan a route out of it: room 587 is 68
      // regions and both exits are in region 0, and there are 17,402 such pockets
      // world-wide. It tries, is refused, replans, forever, and the board says
      // `travelling` while it twitches in a corner.
      //
      // Every crumb here is a move the fine validator ACCEPTED, immediately before it was
      // sent. Replaying them in reverse therefore cannot invent an impossible traversal —
      // it can only undo one. That is the whole safety argument for the escape, and it is
      // why the escape is breadcrumbs rather than a coarse-grid fallback: falling back to
      // the server's grid would relax collision precisely where the two views disagree
      // most, which is the mechanism that let bots climb cliffs no client can.
      //
      // Recorded here rather than in `step`, because this is the one choke point every
      // move in this file passes through, and it is the only place that knows both the
      // position the packet left from and the clipped endpoint it actually asked for.
      const crumbs = (this.breadcrumbs ??= []);
      const last = crumbs[crumbs.length - 1];
      if (!last || last.roomId !== roomId || last.to.x !== before.x || last.to.y !== before.y)
        crumbs.length = 0;             // a teleport, a room change, or somebody else moved us
      crumbs.push({ roomId, at: Date.now(),
                    from: { x: before.x, y: before.y },
                    to: { x: validation.target.x, y: validation.target.y } });
      if (crumbs.length > 64) crumbs.shift();
      c.moveTo(validation.target.x, validation.target.y, speed, roomId);
      const destinationFloor = validation.destinationFloor;
      if (Number.isFinite(destinationFloor)) {
        const commandZ = validation.motionZ;
        const startMin = Number.isFinite(commandZ?.min) ? commandZ.min
          : Number.isFinite(commandZ) ? commandZ : destinationFloor;
        const startMax = Number.isFinite(commandZ?.max) ? commandZ.max
          : Number.isFinite(commandZ) ? commandZ : destinationFloor;
        const min = Math.min(startMin, startMax, destinationFloor);
        const max = Math.max(startMin, startMax, destinationFloor);
        if (max - min > 1e-6) {
          const existing = this.collisionVertical;
          const now = Date.now();
          const active = existing?.roomId === roomId && existing.settleAt > now;
          const combinedMin = active ? Math.min(existing.min, min) : min;
          const combinedMax = active ? Math.max(existing.max, max) : max;
          const floorChanged = !active || existing.lastFloor !== destinationFloor;
          if (floorChanged || min < existing.min || max > existing.max) {
            // A normal client animates this transition between input commands. The
            // headless protocol has no z updates, so retain the entire possible range
            // for a conservative settling window instead of guessing a single height.
            const settleMs = Math.min(5000,
              500 + Math.ceil((combinedMax - combinedMin) / CLIENT_FINENESS * 1500));
            this.collisionVertical = { roomId, min: combinedMin, max: combinedMax,
              lastFloor: destinationFloor, settleAt: now + settleMs };
          }
        } else this.collisionVertical = null;
      }
      return { sent: true, roomId, eventSeq, before, target: validation.target, validation };
    }, minGap);
  }

  // ONE SQUARE, AND NOT A ROOM RE-READ TO GO WITH IT.
  //
  // This used to end with a full `roomContents()` request and a wait for the reply, ONCE
  // PER SQUARE. That round trip measures 1.2 to 5.6 seconds — and it measures the same
  // whether the room holds two objects or fifteen, so it is latency and queueing, not
  // payload. It was the entire reason the fleet walked at 0.55 squares a second while the
  // operator, measured in the same room on the same evening, sustained 4.1.
  //
  // MOVE_INTERVAL_MS was tuned to 250ms — four squares a second — with a long comment
  // about how walking at one square a second was costing us characters. It never took
  // effect. It was never the binding constraint; this was.
  //
  // WHY DEAD RECKONING IS SAFE HERE, which is the part that has to be right:
  //
  //   * the server does not echo a user's own accepted move. Measured, not assumed: a
  //     six-square walk produced ONE self `moved` event. So there is no cheap confirmation
  //     to swap the re-read for — the choice is the re-read or prediction.
  //   * and there is nothing to confirm. `UserMove` calls `Room.SomethingMoved` directly
  //     and `ReqSomethingMoved` is BYPASSED for users — room.kod's own comment on that is
  //     "already been checked by client (HAHA!)". There is no geometry, distance or
  //     occupancy validation on a user move at all (docs/m59-coordination-research.md,
  //     user.kod:2941-2971). The one thing that snaps you back is speed above walking pace
  //     with vigor under the run threshold, and moveSpeed() already guards that.
  //
  // So the client is authoritative for its own movement, exactly as the real one is, and
  // predicting the position is not a guess about the server — it is the same thing the
  // server is about to do. The resync below is a correction for the things prediction
  // cannot cover: everything ELSE in the room moving, which is what the object map is for.
  //
  // `confirm: true` forces the read anyway, for the one caller that genuinely needs to
  // know whether a step happened rather than where we now are.
  async step(col, row, { confirm = false, beforeMutation = null } = {}) {
    const c = this.need();
    const roomId = c.room.id;
    const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
    // Turn to face the destination first. It costs nothing, it is what a player
    // does, and several things in this game care about facing.
    //
    // FACE COALESCING (the packet-throttle fix, docs/packet-throttle.md). The session used to
    // send a turn packet BEFORE EVERY move, so a walk produced a turn+move pair every tick
    // (~4-6/s) which tripped the server's 5/s throttle. A player only turns when the heading
    // actually changes. Compare the requested heading against our current facing (c.self.degrees,
    // kept up to date by server pushes) and only send a turn when it differs by more than
    // FACE_EPS. This drops turn production from ~4/s to near zero while tracking.
    if (before && (before.col !== col || before.row !== row)) {
      const deg = (Math.atan2(row - before.row, col - before.col) * 180 / Math.PI + 360) % 360;
      const curDeg = c.self?.degrees;
      // COMBAT-FACING LOCK. If the combat controller just faced a target (to swing), do NOT
      // re-face to the movement heading. Re-facing to the walk direction overrode the combat
      // facing, making the character oscillate between the target and the heading, so every
      // melee swing landed on a target behind the facing line (rejected by the server's
      // view-cone check, player.kod ~4185). Honor the combat face for COMBAT_FACE_HOLD_MS.
      const cf = c._combatFacing;
      const combatHolding = cf && (Date.now() - cf.at) < COMBAT_FACE_HOLD_MS;
      const facingChanged = !combatHolding && (curDeg == null ||
        (() => { const a = ((curDeg % 360) + 360) % 360, b = ((deg % 360) + 360) % 360;
                 const d = Math.abs(a - b); return Math.min(d, 360 - d) > FACE_EPS; })());
      if (facingChanged) {
        await this.pacer.submit('turn', () => {
          if (c.room.id !== roomId) return false;
          if (typeof beforeMutation === 'function') beforeMutation('turn', { col, row });
          return c.face(deg);
        });
      }
    }
    if (c.room.id !== roomId) return {
      moved: false, position: c.self ? { x: c.self.x, y: c.self.y,
        col: c.self.col, row: c.self.row } : null,
      left_room: true, reason: 'room_changed_before_move',
    };
    const speed = this.moveSpeed();
    // PACE BY DISTANCE, NOT BY PACKET. A hop may now cover several squares, so a fixed
    // gap between packets would make a five-square hop arrive five times too early —
    // which is the actual definition of speedhacking, and would be visible as such.
    //
    // The gap owed is for the hop just SENT, and `minGapForKind` is applied against the
    // previous send of this kind, so it is carried on the session rather than computed
    // here from the current hop. A single square at a run is 200ms; five squares is a
    // full second. Both are the same 5 squares/second.
    const gap = this._moveGapMs ?? MOVE_INTERVAL_MS;
    const dist = before ? Math.max(Math.abs(col - before.col), Math.abs(row - before.row)) : 1;
    // THE ONE PLACE A PLANNED SQUARE BECOMES A PACKET, so it is the one place the aim can
    // diverge from the plan. `moverStepLands` decides what to plan by tracing between the
    // two squares' STAND POINTS; if this kept aiming at centres, the router would be
    // authorising steps against one point and the mover attempting them against another —
    // the exact split this whole subsystem exists to close.
    //
    // For every square whose centre is floor `standPointWire` returns `col * KOD_FINENESS
    // + half` exactly, so ordinary movement is unchanged to the byte and only a square a
    // wall cuts in half moves at all. Measured in Western border of the Twisted Wood: 1406
    // squares identical to their centre — precisely the count the coarse grid calls
    // walkable — and 299 moved, none of which the grid had accepted.
    //
    // Falls back to the centre when there is no geometry, which is both the honest answer
    // for a room with no collision payload and what keeps this method liftable: it had no
    // dependency on `this.world` at all before, and one of its test fixtures has none.
    const half = KOD_FINENESS >> 1;
    const aim = this.world?.geometry?.standPointWire?.(row, col)
             ?? { x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half };
    const queued = await this.queueValidatedMove(aim.x, aim.y, { speed, slide: true,
        beforeMutation: typeof beforeMutation === 'function'
          ? () => beforeMutation('move', { col, row }) : null,
        minGap: gap, expectedRoomId: roomId });
    if (!queued.sent) {
      const validation = queued.validation ?? {};
      const leftRoom = c.room.id !== roomId;
      const at = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : before;
      return { moved: false, position: at, left_room: leftRoom,
               geometry_blocked: validation.blocked !== false,
               reason: validation.reason ?? 'geometry_blocked', note: validation.note };
    }
    this._moveGapMs = Math.round(1000 * dist / squaresPerSecond(speed));
    // Predict, the way the real client does.
    const target = queued.target;
    c.predictSelf({ x: target.x, y: target.y,
                    col: Math.floor(target.x / KOD_FINENESS),
                    row: Math.floor(target.y / KOD_FINENESS) });
    // AND RESYNC ON A CLOCK, AT MOST — BUT DO NOT STAND STILL FOR IT.
    //
    // This awaited the reply, and the reply is a 1.2-5.6s round trip. So a walk ran for
    // six seconds, froze for one to five, ran for six. That is the visible jerk, and it
    // is the reason a fleet character does not move like a person even when every other
    // number is right: the pauses are not pacing, they are us waiting.
    //
    // Nothing in the next step needs the answer. Position is dead-reckoned and the
    // server does not echo our own moves, so the re-read is for the OBJECT MAP —
    // furniture, monsters, loot — and the walker only consults that when it replans.
    // The reply lands on the event stream and updates the room whenever it arrives,
    // which is exactly as good a few hundred milliseconds later.
    //
    // So it is fired and not awaited. `confirm: true` still blocks, because the one
    // caller that passes it genuinely needs to know where it ended up — and
    // confirmPosition(), before crossing out of a room, is the other place we still pay
    // for the truth on purpose.
    if (confirm) {
      const confirmed = await this.confirmPosition();
      if (!confirmed) return { moved: false, position: null, left_room: false,
                               reason: 'position_confirmation_timeout', predicted: true };
    } else if (Date.now() - (this.lastRoomRead ?? 0) >= ROOM_RESYNC_MS) {
      this.lastRoomRead = Date.now();
      // Not awaited. A failure here is not a movement failure — the walk carries on
      // with a slightly older object map, which is the state it was already in.
      this.pacer.submit('read', () => c.roomContents()).catch(() => {});
    }
    const after = c.self;
    return {
      moved: !!after && (!before || after.x !== before.x || after.y !== before.y),
      position: after ? { x: after.x, y: after.y, col: after.col, row: after.row } : null,
      // Still honest without a re-read: crossing a boundary brings a fresh BP_PLAYER and
      // the client rebuilds the room, so our own id is genuinely absent from the new one
      // until contents land. That is the answer this wants.
      left_room: !c.room.objects.has(c.selfId),
      // So a caller can tell a confirmed position from a predicted one rather than having
      // to know this function's internals.
      predicted: !confirm && !!after?.predicted,
      locally_validated: true,
      ...(queued.validation.blocked ? { geometry_blocked: true,
        clipped: queued.target, requested: queued.validation.requested,
        reason: queued.validation.reason } : {}),
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
  // Kardde's Canyon that is the only way into the Badlands is exactly this: present
  // in the fine BSP, absent from the grid.
  //
  // The server does not use that grid — or validate player geometry at all. The real
  // client clips movement against the fine BSP before it sends a position. We must do
  // the same locally; asking the server to judge is precisely how a bot crosses walls.
  //
  // Two rules make it work, and both were learned the hard way:
  //
  //  * VALIDATE BEFORE SENDING. The server accepts player coordinates; a room read is
  //    confirmation of state, never a collision oracle.
  //  * WHEN BLOCKED, SLIDE. A locally clipped step usually means the straight line touched
  //    rock, not that the way is shut. Fanning the heading out to either side is
  //    what "hugging the wall" actually is, and it is how a human gets along a
  //    ledge without falling off it.
  async stepFine(x, y) {
    const c = this.need();
    const startRoom = c.room.id;
    if (this.finePositionUnknown) {
      const recovered = await this.confirmPosition();
      if (!recovered) return { moved: false, left_room: false,
        reason: 'position_confirmation_timeout',
        note: 'no further fine packet was sent because its starting point is unknown' };
      this.finePositionUnknown = false;
    }
    const p0 = c.self;
    const before = p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null;
    if (!before) return { moved: false, left_room: false, reason: 'own_position_unknown' };
    const queued = await this.queueValidatedMove(x, y,
      { speed: this.moveSpeed(), slide: true, minGap: MOVE_INTERVAL_MS });
    const validation = queued.validation ?? {};
    if (!queued.sent) {
      // In keeper mode, if the collision check rejected the move
      // due to geometry (stale .roo), send it anyway. The server
      // will accept or reject based on its own geometry.
      if (process.env.M59_KEEPER && (validation.blocked || validation.reason) && validation.reason !== 'room_changed_before_move') {
        // DECLARED OUTSIDE THE TRY. It used to be `const c2` inside it, and the catch
        // below reads c2.room.id -- where it is out of scope. So any failure in this
        // branch made the ERROR HANDLER throw `ReferenceError: c2 is not defined`,
        // which destroyed the real error and propagated a crash to the caller. Seen
        // live as `reason=c2 is not defined (32792ms)`: a swallowed ReferenceError
        // wearing the costume of an ordinary refusal.
        let c2 = null;
        try {
          c2 = this.need();
          c2.moveTo(Math.round(x), Math.round(y), c2.moveSpeed() ?? 1, c2.room?.id ?? 0);
          await new Promise(r => setTimeout(r, 300));
          const after = c2.self;
          if (after && before && (after.x !== before.x || after.y !== before.y)) {
            return { moved: true, position: { x: after.x, y: after.y, col: after.col, row: after.row },
                     left_room: c2.room?.id !== startRoom, travelled: Math.hypot(after.x - before.x, after.y - before.y),
                     raw_move: true };
          }
          return { moved: false, position: before, left_room: c2.room?.id !== startRoom,
                   reason: 'raw_move_rejected', note: 'server rejected the raw move' };
        } catch (e) {
          return { moved: false, position: before,
                   left_room: (c2?.room?.id ?? startRoom) !== startRoom,
                   reason: 'raw_move_error', note: e.message };
        }
      }
      return {
        moved: false, position: p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null,
        left_room: c.room.id !== startRoom,
        geometry_blocked: validation.blocked !== false,
        reason: validation.reason,
        note: validation.note ?? 'local client collision rejected this move before any packet was sent',
      };
    }
    const target = queued.target;
    // THIS ONE HAS TO BLOCK, and it is the most expensive thing in the file. Fine
    // movement may clip or slide to a sub-square point, so prediction cannot establish
    // the exact starting point for its next local collision pass.
    const tFine = Date.now();
    const confirmed = await this.confirmPosition();
    Pacer.note('step_fine', 'blocked', Date.now() - tFine);
    if (!confirmed) {
      this.finePositionUnknown = true;
      return { moved: false, position: null, left_room: c.room.id !== startRoom,
        locally_validated: true, reason: 'position_confirmation_timeout',
        note: 'the endpoint was safe, but no further fine move is allowed until position is re-observed' };
    }
    this.finePositionUnknown = false;
    const p1 = c.self;
    const sentFrom = queued.before ?? before;
    const after = p1 ? { x: p1.x, y: p1.y, col: p1.col, row: p1.row } : null;
    const moved = !!(sentFrom && after && (after.x !== sentFrom.x || after.y !== sentFrom.y));
    return { moved, position: after,
             left_room: c.room.id !== startRoom || !c.room.objects.has(c.selfId),
             travelled: moved ? Math.hypot(after.x - sentFrom.x, after.y - sentFrom.y) : 0,
             locally_validated: true,
             ...(validation.blocked ? { geometry_blocked: true, clipped: target,
                                         requested: validation.requested,
                                         reason: validation.reason } : {}) };
  }

  // Walk to a fine coordinate without consulting the square grid at all.
  // `stride` is how far to reach per request; a short stride hugs geometry more
  // closely but costs a second per step, since the move rate is one per second.
  async walkFine(destX, destY, {
    maxSteps = 120,
    stride = 48,
    arriveWithin = 40,
    movementGeneration = this.movementGeneration,
    controlToken,
  } = {}) {
    const c = this.need();
    const startRoom = c.room.id;
    let me = c.self;
    if (!me) return { arrived: false, reason: 'own_position_unknown',
                      note: 'own position is unknown; call look before moving' };

    const log = [];
    let stalls = 0;
    const geometryRejections = new Set();
    // Headings to try, in order: straight at it, then fanned out to either side.
    // The wide angles are what carry you along a wall rather than into it.
    const FAN = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];

    for (let i = 0; i < maxSteps; i++) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: i, log });
      me = c.self;
      if (!me) return { arrived: false, reason: 'own_position_unknown',
                        note: 'lost authoritative own-position state while walking', log };
      const dx = destX - me.x, dy = destY - me.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= arriveWithin)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 steps: i, log };

      const base = Math.atan2(dy, dx);
      const reach = Math.min(stride, remaining);
      let progressed = false;

      for (const off of FAN) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return this.cancelledMovement({ steps: i, log });
        const a = base + off;
        const r = await this.stepFine(me.x + Math.cos(a) * reach, me.y + Math.sin(a) * reach);
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room while following the fine route' };
        }
        if (r.reason) geometryRejections.add(r.reason);
        if (isTerminalMovementReason(r.reason))
          return { arrived: false, reason: r.reason, note: r.note,
                   position: r.position, steps: i, log };
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
        // Floor at 24 (37% of a cell) — below that the walk burns steps
        // without meaningful progress, and the budget was calculated for
        // the initial stride.
        stride = Math.max(24, Math.round(stride / 2));
        if (stalls >= 4)
          return { arrived: false, reason: 'blocked — every heading refused, at every reach tried',
                   position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
                   steps: i, log, geometry_rejections: [...geometryRejections],
                   note: geometryRejections.has('geometry_blocked')
                     ? 'local BSP collision rejected the requested headings; no endpoint was sent through the obstacle'
                     : undefined };
      } else stalls = 0;
    }
    me = c.self;
    return { arrived: false, reason: 'ran out of steps',
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null, log,
             geometry_rejections: [...geometryRejections] };
  }

  // THE WAY OUT OF A POCKET IS THE WAY IN, WALKED BACKWARDS.
  //
  // Called when the router says there is no route from here — which, in this world, far
  // more often means "here is one of the 17,402 squares the collision view considers cut
  // off from the rest of its room" than it means the destination is unreachable. The
  // character walked in, so a walk out exists; the router simply cannot see it, because
  // the pocket is a pocket to the model and not to the world.
  //
  // Every step replayed was accepted by the fine validator on the way in, so this CANNOT
  // INVENT AN IMPOSSIBLE TRAVERSAL — it can only undo one. If a character reached a pocket
  // by a traversal that should never have been legal, the breadcrumbs walk it back out the
  // same way rather than widening the hole. That is why this, and not a coarse-grid escape
  // hatch: the grid disagrees with the BSP exactly where the cliff climbs and the boundary
  // crossings live, and relaxing collision there is the failure we are protecting.
  //
  // `until` is asked after every crumb, so the caller stops the moment its route reappears
  // rather than unwinding the whole trail — the goal is to get out of the pocket, not to
  // undo the journey.
  async retreatAlongBreadcrumbs({ maxCrumbs = 12, until = null,
    movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const crumbs = this.breadcrumbs ?? [];
    // TRIM THE LOOPS OUT OF THE TRAIL BEFORE WALKING IT BACKWARDS.
    //
    // The trail is what the character actually did, and what it actually did includes the
    // bouncing that got it into trouble — `4,15 -> 5,15` / `5,15 -> 4,16`, over and over.
    // Replaying that in reverse spends the crumb budget re-doing a round trip that arrived
    // exactly where it started. `maxCrumbs` is 12, so a single eight-step bounce can eat
    // the whole retreat and leave the character in the pocket it was trying to leave.
    //
    // Nothing here can be invented by removing a cycle, because both ends of a cycle are
    // THE SAME SQUARE: the join is "X, then whatever followed X the last time", which is a
    // pair the trail already contained. And every step is still put through the validator
    // on the way back out, so a one-way ledge still stops the retreat rather than being
    // teleported over — see the note below about a refused reverse step.
    //
    // Measured over the recorded walks: 41% of per-room runs contain a loop, and across
    // all of them 47% of the squares visited are revisits. Some of that is a person
    // exploring on purpose; none of it is worth undoing.
    if (crumbs.length > 2) {
      // Keyed on the EXACT landing point, which is what keeps the chain joinable — see
      // elideLoops. A crumb is a validated move, not a square.
      const trimmed = elideLoops(crumbs, cr => `${cr.roomId}:${cr.to.x},${cr.to.y}`);
      if (trimmed.length < crumbs.length) crumbs.length = 0, crumbs.push(...trimmed);
    }
    const roomId = c.room?.id;
    let steps = 0, blocked = null;
    while (steps < maxCrumbs && crumbs.length) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps });
      const crumb = crumbs[crumbs.length - 1];
      const me = c.self;
      if (!me) { blocked = 'own_position_unknown'; break; }
      // A crumb from another room, or one that does not START where we are standing, is
      // not a step we can undo: something moved us since, and reversing it would be a
      // guess about geometry rather than a replay of it. Drop the whole trail rather
      // than skipping — the crumbs below it are no more connected to us than this one.
      if (crumb.roomId !== roomId || crumb.to.x !== me.x || crumb.to.y !== me.y) {
        crumbs.length = 0; blocked = 'breadcrumb_trail_broken'; break;
      }
      const back = await this.queueValidatedMove(crumb.from.x, crumb.from.y,
        { slide: true, expectedRoomId: roomId });
      if (!back.sent) { blocked = back.validation?.reason ?? 'geometry_blocked'; break; }
      // The crumb this move just recorded is the retreat itself; drop both, or the trail
      // grows a there-and-back pair and the next retreat undoes the undo.
      if (crumbs[crumbs.length - 1] !== crumb) crumbs.pop();
      const idx = crumbs.lastIndexOf(crumb);
      if (idx >= 0) crumbs.splice(idx, 1);
      steps++;
      c.predictSelf({ x: back.target.x, y: back.target.y,
                      col: Math.floor(back.target.x / KOD_FINENESS),
                      row: Math.floor(back.target.y / KOD_FINENESS) });
      if (typeof until === 'function' && until()) break;
    }
    const me = c.self;
    return { moved: steps > 0, steps, crumbs_left: crumbs.length,
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
             ...(blocked ? { reason: blocked } : {}) };
  }

  // Walk to a square along a route computed through the real geometry, rather than
  // pushing blindly toward it. Both halves matter: the route lets an agent round a
  // corner it would otherwise stall against, and the pacing keeps the session from
  // being logged as a speedhacker.
  //
  // With no geometry it fails closed. Player movement is not checked by the server,
  // so sign-stepping without a map is an unchecked coordinate write, not navigation.
  // GO ROUND A BODY, NOT ROUND THE ROOM.
  //
  // Pure, and it takes the geometry rather than reading `this`, so the decision can be
  // tested without a session. Returns `{ back, through }` — the square to retreat to
  // first (may be null when standing still already opens the angle) and the square to
  // pass through — or null when neither side is available.
  //
  // THE TWO SIDES ARE THE PERPENDICULARS OF THE STEP WE WERE REFUSED, which is what makes
  // this cheap: one body occupies one square, so the detour is one square wide and the
  // router never has to be consulted. Both are checked against the SAME things the walker
  // already knows — the mover's step relation, the edges it has been refused, and the
  // squares it has seen bodies on — so a sidestep cannot propose a traversal the ordinary
  // path would reject.
  sidestepAround(was, blocked, { blockedEdges, occupied, geo, prefer = 0 }) {
    if (!was || !blocked || !geo) return null;
    const dr = Math.sign(blocked.row - was.row), dc = Math.sign(blocked.col - was.col);
    if (!dr && !dc) return null;
    // Perpendiculars of the refused direction. For a diagonal step these are the two
    // cardinals it decomposes into, which is the right answer for the same reason.
    let sides = (dr && dc) ? [{ dr, dc: 0 }, { dr: 0, dc }]
                           : [{ dr: dc, dc: dr }, { dr: -dc, dc: -dr }];
    // BREAK THE TIE ON SOMETHING THAT DIFFERS BETWEEN THE TWO PARTIES, or the fix becomes
    // the bug. Both characters run this identical function, so with a fixed side order
    // two of them meeting head-on both dodge the same way, collide, both dodge back, and
    // mirror each other indefinitely — watched live and described exactly: *"like two
    // people stuck in a hallway, I'll go left, no you go left, no my left, no your
    // left"*. Ordering by the mover's own object id makes two characters prefer opposite
    // sides by construction, which is the one thing a shared rule cannot achieve.
    //
    // The object id and not a random number: a coin flip breaks the deadlock eventually
    // and produces a different dance each pass, which is both slower to converge and
    // impossible to reproduce in a test.
    if (prefer & 1) sides = [sides[1], sides[0]];
    // `standable`: somewhere to step round a body is somewhere a body can BE, which is a
    // question about floor rather than about the server's byte. `moverStepLands` still has
    // to authorise the step itself, so this only widens the candidates, never the rules.
    const free = (r, c) => geo.standable(r, c) && !occupied.has(`${r},${c}`);
    const canStep = (fr, fc, tr, tc) =>
      !blockedEdges.has(`${fr},${fc}>${tr},${tc}`) && geo.moverStepLands(fr, fc, tr, tc);

    for (const s of sides) {
      const tr = was.row + s.dr, tc = was.col + s.dc;
      if (!free(tr, tc) || !canStep(was.row, was.col, tr, tc)) continue;
      // From the side square, can we reach the square BEYOND the blocker — i.e. carry on
      // in the direction we were going? That is the whole point; stepping aside and back
      // again achieves nothing.
      const br = blocked.row + dr, bc = blocked.col + dc;
      if (free(br, bc) && canStep(tr, tc, br, bc))
        return { back: null, through: { row: tr, col: tc }, beyond: { row: br, col: bc } };
      // Otherwise settle for reaching the blocked square itself from the side, which is
      // the case where the body is standing in a doorway we can enter at an angle.
      if (canStep(tr, tc, blocked.row, blocked.col))
        return { back: null, through: { row: tr, col: tc } };
    }

    // NOTHING WORKED FROM HERE, SO BACK UP AND TRY AGAIN — the operator's own suggestion,
    // and the reason it is second rather than first is that retreating costs a step and
    // is usually unnecessary. Standing hard against a body the diagonal past it is often
    // refused for clearance; one square back it is not.
    const br0 = was.row - dr, bc0 = was.col - dc;
    if (!free(br0, bc0) || !canStep(was.row, was.col, br0, bc0)) return null;
    for (const s of sides) {
      const tr = br0 + s.dr, tc = bc0 + s.dc;
      if (!free(tr, tc) || !canStep(br0, bc0, tr, tc)) continue;
      if (canStep(tr, tc, blocked.row, blocked.col) ||
          (free(blocked.row + dr, blocked.col + dc) &&
           canStep(tr, tc, blocked.row + dr, blocked.col + dc)))
        return { back: { row: br0, col: bc0 }, through: { row: tr, col: tc } };
    }
    return null;
  }

  async walkTo(col, row, {
    maxSteps = 120,
    hardCap = 400,
    movementGeneration = this.movementGeneration,
    controlToken,
    beforeMutation = null,
    // KEEP OFF THE WALLS ON THE WAY PAST THEM — OPT IN, AND OFF BY DEFAULT.
    //
    // See RoomGeometry.clearanceField. It is right for CROSSING a room and wrong for a
    // walk to a square somebody has already chosen tactically: a safe wall is a tight
    // square BY DEFINITION — that is the whole mechanism, the coarse grid and the BSP
    // disagreeing — and the fleet must not be taught to shy away from the thing the game
    // is balanced around. `leaveVia` turns it on, because walking to a boundary is the
    // long routing where a slid step starts the bounce. A pull, a melee approach and a
    // walk back to a held wall all leave it off and plan exactly as they did before it
    // existed.
    clearance = 0,
  } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me0 = c.self;
    if (!me0) return { arrived: false, reason: 'own_position_unknown',
                       note: 'own position is unknown; call look before moving' };
    if (me0.col === col && me0.row === row)
      return { arrived: true, position: { col, row }, steps: 0, note: 'already there' };

    if (!geo) {
      return { arrived: false, steps: 0, reason: 'collision_geometry_unavailable',
               position: { col: me0.col, row: me0.row },
               note: 'no movement packet was sent because the server does not validate player geometry' };
    }

    // If something has parked us on a square with no floor, no route exists from it at
    // all. The server does not check walls for players, so we can simply step onto
    // solid ground and carry on — but it has to be done deliberately, because from
    // here the pathfinder has nothing to say.
    //
    // `standable`, NOT `walkable`, AND THIS ONE IS LOAD-BEARING. Asked the coarse grid's
    // way, a character standing in a diagonal corridor square that the grid rounds down to
    // wall — 137 such positions are recorded in the operator's own walk logs — reads as
    // "parked off the floor" and gets DRAGGED to `nearestWalkable` before the walk even
    // begins. That is the opposite of the repair: it takes a character that is standing
    // somewhere perfectly legitimate and moves it, every walk, for ever.
    if (!geo.standable(me0.row, me0.col)) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      const spot = geo.nearestWalkable(me0.row, me0.col);
      if (process.env.M59_EXIT_DEBUG !== '0')
        console.error(`[exit-debug] ${this.name ?? '?'} start_has_no_floor check: me0=(${me0.col},${me0.row}) standable=${geo.standable(me0.row, me0.col)} walkable=${geo.walkable(me0.row, me0.col)} nearest=${JSON.stringify(spot)} room=${c.room?.id}`);
      if (!spot) return { arrived: false, reason: 'start_has_no_floor',
                          note: 'standing off the floor with no walkable square anywhere near',
                          position: { col: me0.col, row: me0.row } };
      // CONFIRMED, because this is the one place the ANSWER is the question. Everywhere
      // else `step` is asked "where am I now" and prediction answers it; here it is asked
      // "did that work", and a predicted yes would report solid ground under a character
      // still standing off the floor — from which no route exists at all.
      const half = KOD_FINENESS >> 1;
      const targetX = spot.col * KOD_FINENESS + half, targetY = spot.row * KOD_FINENESS + half;
      const r = await this.stepFine(targetX, targetY);
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, position: r.position ?? { col: me0.col, row: me0.row } };

      // ONE STEP IS NOT ENOUGH TO GET OFF THE GRID, AND FINE MOVEMENT IS THE STRICTER
      // TOOL RATHER THAN THE LOOSER ONE.
      //
      // Measured 2026-08-17: characters really do end up on squares the bake calls
      // unwalkable — Bravo standing at 30,30 in room 587 and Charlie at 25,25 in 566,
      // both `walkable: false`, both perfectly upright on the server, and from there
      // `walkTo` cannot plan at all. `stepFine` asks for ONE clipped step at the nearest
      // floor square, and when the pocket is deeper than one step, or that particular
      // endpoint is refused, the walk ends here with `could not step back onto solid
      // ground` — which is what the three broken boundaries on the Tos-Jasper corridor
      // came down to.
      //
      // `walkFine` is the same collision rules applied up to 120 times with sliding, so
      // it can work its way out where a single step cannot. It is NOT the coarse-grid
      // escape hatch this repository considered and rejected: that one FELL BACK to the
      // server's one-byte grid and relaxed collision, which is the mechanism that let
      // bots climb cliffs. This clips every endpoint against the same BSP the stock
      // client enforces — walls, step heights, slopes, ceilings and the 248-unit player
      // radius — so it is strictly more conservative than the router it is rescuing, and
      // cannot authorise a traversal a person could not make.
      //
      // Second, and only on failure, because it costs packets and the single step is
      // usually enough.
      if (!r.moved) {
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const fine = await this.walkFine(targetX, targetY,
          { maxSteps: 40, movementGeneration, controlToken }).catch(() => null);
        if (isTerminalMovementReason(fine?.reason))
          return { arrived: false, ...fine, position: fine.position ?? { col: me0.col, row: me0.row } };
        const now = c.self;
        // Same question as above — did we reach ground a player can occupy — so it has to
        // be the same predicate, or the recovery declares failure while standing on floor.
        if (!now || !geo.standable(now.row, now.col))
          return { arrived: false, reason: 'could not step back onto solid ground',
                   position: now ?? r.position,
                   recovered_by: 'neither one clipped step nor fine walking reached floor',
                   note: r.note ?? r.reason ?? 'local collision found no safe recovery path' };
      }
    }

    let from = c.self ?? me0;
    // Route round what can see us, at a cost rather than a prohibition — see
    // threatsHere(). Computed once per walk rather than per step: monsters wander, but
    // re-deriving a whole field every square would cost more than the detour saves,
    // and the replan below picks up anything that has moved into the way since.
    const threats = this.threatsHere();
    // THE MASK MAY ONLY EVER PREFER, AND THAT HAS TO HOLD AT PLAN TIME TOO.
    //
    // The replan inside the walk already falls back to the coarse grid when the collision
    // view runs out of routes; the FIRST plan did not, so a goal the model dislikes was
    // refused before a single packet — which is the same silent refusal this whole path
    // exists to remove, just arriving earlier. It bites hardest at doors: an exit anchor
    // for a `go` exit is the door tile itself, a pocket by design, and 346 of the 383
    // anchors this bake cannot reach from their room's body are exactly those. Exempting
    // the last step into the goal recovers 57 of them; the other 326 have the whole
    // approach refused, and for those the answer is to plan on the grid and let the mover
    // clip each step for real — which is what `leaveVia` then finishes with fine
    // positioning.
    //
    // Only when the COLLISION view is what refused. A coarse-grid "no route" is the room
    // telling us something, and re-asking it the same question would just be slower.
    // PATH JITTER: add a small per-agent cost bias to intermediate cells
    // so two characters walking to the same spot take slightly different
    // routes and don't stack on each other. The goal is NOT jittered —
    // the character still arrives at the exact target. Only the route
    // between start and goal is perturbed.
    let jitterCost = null;
    if (this.name && Math.abs(from.row - row) + Math.abs(from.col - col) > 3) {
      let h = 0;
      for (const ch of this.name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      jitterCost = (r, c) => {
        // Only bias cells that are actually walkable — never penalise
        // the only viable cell in a corridor.
        if (!geo.standable(r, c)) return 0;
        const v = ((r * 7919 + c * 104729 + h) & 0xff) / 255;
        return v > 0.7 ? 0.3 : 0;
      };
    }
    const replan = (r, cc, toR = row, toC = col) => {
      let p = geo.path(r, cc, toR, toC, { threats, clearance, extraCost: jitterCost });
      if (!p.found && p.collision_view)
        p = geo.path(r, cc, toR, toC, { threats, clearance, collision: false, extraCost: jitterCost });
      return p;
    };
    let plan = replan(from.row, from.col);
    // NO ROUTE FROM HERE USUALLY MEANS "HERE IS A POCKET", NOT "THERE IS UNREACHABLE".
    //
    // Both are refusals of the same shape and only one of them is about the destination.
    // A character standing on a safe wall is standing where the coarse grid and the BSP
    // disagree — that is what a safe wall IS — and to the collision view that square is
    // frequently cut off from its own room's exits. Walking the breadcrumbs back undoes
    // whatever got it in there, and the plan is re-asked from wherever that lands.
    let escaped = 0;
    if (!plan.found && !plan.stuck) {
      const out = await this.retreatAlongBreadcrumbs({
        movementGeneration, controlToken,
        until: () => replan(c.self?.row ?? -1, c.self?.col ?? -1).found,
      });
      if (out.cancelled) return out;
      escaped = out.steps ?? 0;
      if (out.moved) {
        from = c.self ?? from;
        plan = replan(from.row, from.col);
      }
    }
    if (!plan.found) {
      // COARSE GRID FOUND NO ROUTE — TRY THE FINE GRID. The coarse grid is a
      // 1-byte-per-square projection of the BSP. A square it calls unwalkable
      // (step height, ledge, diagonal wall, or a gap between polygons) may be
      // perfectly fine at the fine resolution. walkFine navigates using BSP
      // collision directly and can find routes the coarse grid cannot see.
      // This is the last resort: the fine grid is slower (one confirmed step
      // per second) but more accurate.
      const half = KOD_FINENESS >> 1;
      const destX = col * KOD_FINENESS + half;
      const destY = row * KOD_FINENESS + half;
      if (process.env.M59_EXIT_DEBUG !== '0')
        console.error(`[walkTo] ${this.name ?? '?'} coarse grid failed (${plan.reason}), trying fine grid to (${destX},${destY})`);
      const fine = await this.walkFine(destX, destY, {
        maxSteps: Math.max(60, Math.ceil(Math.hypot(col - from.col, row - from.row) * 2)), stride: 48, arriveWithin: 100,
        movementGeneration, controlToken,
      }).catch(e => ({ arrived: false, reason: e.message }));
      if (fine.arrived)
        return { arrived: true, steps: fine.steps, position: fine.position,
                 note: 'coarse grid found no route; fine grid walked it' };
      // RAW WALK FALLBACK: both grids failed. In keeper mode,
      // try a direct raw walk toward the target. Send move
      // commands in the target direction, ignoring geometry.
      // The server accepts or rejects each move. This bypasses
      // stale local geometry that blocks both grids.
      if (process.env.M59_KEEPER === '1') {
        const c = this.client;
        const self = c.self;
        if (self) {
          const dx = col - self.col;
          const dy = row - self.row;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) {
            const deg = Math.atan2(dy, dx) * 180 / Math.PI;
            console.error(`[walkTo] ${this.name ?? '?'} raw walk fallback: both grids failed, walking raw toward (${col},${row}) dist=${dist.toFixed(1)}`);
            const rawSteps = Math.min(Math.ceil(dist), 8);
            const speed = c.moveSpeed?.() ?? 1;
            for (let i = 0; i < rawSteps; i++) {
              try {
                const step = 24; // 1/4 cell in fine units
                const rad = deg * Math.PI / 180;
                const nx = Math.round((self.x ?? self.col * 48) + Math.cos(rad) * step);
                const ny = Math.round((self.y ?? self.row * 48) + Math.sin(rad) * step);
                c.moveTo?.(nx, ny, speed, c.room?.id ?? 0);
                await new Promise(r => setTimeout(r, 250));
                const newSelf = c.self;
                if (newSelf && (newSelf.col !== self.col || newSelf.row !== self.row)) {
                  console.error(`[walkTo] ${this.name ?? '?'} raw walk moved to (${newSelf.col},${newSelf.row})`);
                  return { arrived: false, reason: 'raw walk made progress', position: { col: newSelf.col, row: newSelf.row }, raw_walk: true };
                }
              } catch { break; }
            }
          }
        }
      }
      return { arrived: false, reason: plan.reason, position: { col: from.col, row: from.row },
               ...(plan.stuck ? { nearest_floor: plan.nearest_floor } : {}),
               ...(escaped ? { retreated: escaped } : {}),
               fine_reason: fine.reason,
               note: escaped
                 ? 'no route even after walking the breadcrumbs back out of the pocket'
                 : 'the geometry says there is no route to that square from here' };
    }

    // If a route exists, walking it is what was asked for. Refusing partway because of
    // a caller's default budget is a silent failure dressed as a limit — so the plan
    // itself raises the ceiling, and only a genuinely runaway walk is capped.
    if (plan.steps.length + 10 > maxSteps) maxSteps = Math.min(plan.steps.length + 10, hardCap);

    let queue = plan.steps.slice();
    let taken = 0, replans = 0;
    // SQUARES SOMETHING IS STANDING ON. The geometry models walls and knows nothing
    // about occupancy, and these rooms cap at seven to twelve monsters — so the common
    // reason a step does not happen is that something is in the way.
    const occupied = new Set();
    // AND EDGES THE MOVER WILL NOT CROSS, WHICH IS A DIFFERENT FACT AND WAS NOT RECORDED
    // AT ALL. A monster moves; a wall does not. Blaming the SQUARE for a wall between two
    // squares removes a perfectly good place to stand that other neighbours still reach,
    // and — much worse — a step that SLID and landed one square sideways recorded nothing
    // whatever, so the replan from the new position produced the same step and the walker
    // bounced along the wall until its replan budget ran out.
    //
    // Measured offline against the baked geometry, on the twelve boundaries the exit-gap
    // record complains about most: 249 of 422 walks to an exit — 59% — died exactly that
    // way, with trails reading `4,15->5,15=5,15` / `5,15->4,16=4,15` over and over. Nobody
    // was trapped: the same rooms are 96-100% connected to their own exits when the mover's
    // edges are the ones being walked. The walker simply never learned.
    const blockedEdges = new Set();
    const edgeKey = (fr, fc, tr, tc) => `${fr},${fc}>${tr},${tc}`;
    let stalledOn = null, stalledTimes = 0;
    // MONSTER COLLISION DURING TRAVEL, kept as its own fact. See the block below that
    // increments these: a body is not a wall, it moves, and a walk that failed because of
    // one has a completely different remedy from a walk the geometry refused.
    let monsterBlocks = 0;
    const blockedBy = new Set();       // squares a body was standing on
    const sidestepped = new Set();     // squares we have already tried to go round, once each
    // HOW OFTEN THE MOVER PUT US SOMEWHERE THE PLAN DID NOT ASK FOR. See the note where
    // this is incremented; past a handful it means the square-by-square plan is not the
    // thing being walked, and continuing to replan it is how a room takes three minutes.
    let offPlan = 0, wentFine = false;
    while (queue.length && taken < maxSteps) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: taken, replans });
      // ONE PACKET, SEVERAL SQUARES — as long as they are in a STRAIGHT LINE.
      //
      // The planned route is a list of adjacent squares, and sending one packet per
      // square is what made us four times slower than a person while sending four
      // times as many packets. A real client reports a position about once a second
      // and the ground it crossed in between is never transmitted at all.
      //
      // Collinear only, and that restriction is the whole safety argument: every
      // square between here and the far end is a square the router already accepted,
      // so the line we skip along is the line we planned. Coalescing across a TURN
      // would cut the corner — through whatever the turn was avoiding — which is the
      // one way this could put a character through a wall on purpose.
      // AND COLLINEAR IS TOO NARROW A TEST ON GEOMETRY THAT IS NOT AXIS-ALIGNED.
      //
      // The paragraph above is right that coalescing across a turn could cut a corner —
      // IF the only thing known about the skipped ground is that the router accepted the
      // squares. But there is a stronger check available and it is the one the mover
      // itself uses: trace the straight line and require it to ARRIVE, with `slide:false`.
      // A line that arrives without sliding has not clipped anything, whatever direction
      // it runs, so the corner-cutting argument does not apply to it.
      //
      // This matters because the rooms are not boxes. Room 587's wall length is 54.9% NOT
      // axis-aligned; the exit to the Twisted Wood is a 45 degree run. Measured there,
      // stepping centre-to-centre along a grid route fails 218 of 311 steps, and 200 of
      // those 218 — 92% — do not move the character AT ALL. Collinear coalescing cannot
      // help with any of them, because the refused step is a single step.
      //
      // Same six routes, reaching as far as the line still clears: 311 grid steps become
      // 66 pivots. See RoomGeometry.stringPull and m59-stringpull-test.mjs.
      let next = queue.shift();
      let hop = 1;
      const from0 = c.self ? { col: c.self.col, row: c.self.row } : null;
      // THE SECOND AIM, AND IT HAS TO MATCH THE FIRST. This traces a straight line across
      // several squares to decide which of them may be skipped, so if it measured that
      // line between CENTRES while `step` sends stand points, the line proved clear is not
      // the line walked. `standPoint` is the centre for every ordinary square, so this is
      // unchanged wherever the old aim was right.
      const half0 = KOD_FINENESS >> 1;
      const fineOf = s => geo.standPoint?.(s.row, s.col)
                       ?? { x: protocolToClient(s.col * KOD_FINENESS + half0),
                            y: protocolToClient(s.row * KOD_FINENESS + half0) };
      const arrives = (a, b) => {
        const t = geo.traceFineMoveClient?.(a.x, a.y, b.x, b.y, { slide: false });
        return !!t && Math.hypot(t.x - b.x, t.y - b.y) <= PIVOT_ARRIVE_WITHIN;
      };
      if (from0 && geo.collisionReady) {
        const here = fineOf(from0);
        // FURTHEST FIRST, so a long clear run costs one trace rather than one per square.
        // Bounded by the same hop ceiling as before, so the packet a walk sends is no
        // bigger than it ever was — this changes WHICH squares may be skipped, not how
        // many.
        const reach = [];
        for (let i = 0; i < queue.length && reach.length < MOVE_HOP_MAX_SQUARES - 1; i++) {
          const s = queue[i];
          if (occupied.has(`${s.row},${s.col}`)) break;
          reach.push(s);
        }
        for (let i = reach.length - 1; i >= 0; i--) {
          if (arrives(here, fineOf(reach[i]))) {
            for (let k = 0; k <= i; k++) { next = queue.shift(); hop++; }
            hop--;                       // `next` was already counted by the shift above
            break;
          }
        }
      } else {
        // NO COLLISION MODEL MEANS THE OLD RULE, EXACTLY. A checkout with no baked
        // geometry has nothing to trace against, and must walk precisely as it did.
        const dc0 = Math.sign(next.col - (c.self?.col ?? next.col));
        const dr0 = Math.sign(next.row - (c.self?.row ?? next.row));
        while (hop < MOVE_HOP_MAX_SQUARES && queue.length) {
          const peek = queue[0];
          if (Math.sign(peek.col - next.col) !== dc0 || Math.sign(peek.row - next.row) !== dr0) break;
          if (occupied.has(`${peek.row},${peek.col}`)) break;
          if (blockedEdges.has(edgeKey(next.row, next.col, peek.row, peek.col))) break;
          next = queue.shift(); hop++;
        }
      }
      const was = c.self ? { col: c.self.col, row: c.self.row } : null;
      const r = await this.step(next.col, next.row, { beforeMutation });
      taken += hop;
      if (r.left_room)
        return { arrived: false, left_room: true, steps: taken, note: 'a step crossed the room edge' };
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, steps: taken, replans };
      const now = c.self;
        if (!now)
          return { arrived: false, reason: 'own_position_unknown',
                   note: 'lost authoritative own-position state while walking',
                   steps: taken, replans };
      if (now.col === next.col && now.row === next.row) { stalledOn = null; stalledTimes = 0; continue; }

      // LANDED SOMEWHERE ELSE — counted, because the RATE is the diagnosis.
      //
      // The router validates a step centre-to-centre (`moverStepLands` asks "from the
      // CENTRE of A, can I land in B"), and after the first slide the walker is never at
      // a centre again. Simulated on room 587's approach to its western gap with the real
      // fine position carried forward: 4 of 9 planned steps land off-plan from one start
      // and 24 of 42 from another, while the model calls every one of them legal.
      //
      // Each of those costs a replan, and the replan produces the same square-to-square
      // plan that just failed — which is why crossing one room took 88-208s against 15s
      // for a direct walk to the same gap, and why a four-square doorway becomes a
      // pile-up as soon as a second character wants it.
      offPlan++;

      // DID NOT MOVE AT ALL vs ENDED UP SOMEWHERE ELSE. These were treated the same and
      // they need opposite responses. Ending up elsewhere means the route is stale, so
      // replanning from the new position is right. NOT MOVING means the next square is
      // occupied — and replanning from an unchanged position returns the identical
      // route, so the walker spent its three replans re-deciding to walk into the same
      // monster and then reported "kept ending up somewhere other than the planned
      // square" about a character that had not moved at all.
      const didNotMove = was && now.col === was.col && now.row === was.row;

      // A MONSTER MOVES AND A WALL DOES NOT, SO THEY GET OPPOSITE TREATMENT — and the
      // server already tells us which it was. `object_blocked` is the obstacle arm of the
      // local collision pass; every other refusal is geometry. Waiting 700ms for a wall to
      // wander off was pure cost, and it was paid on every lap of the bounce above.
      const hitSomething = r.reason === 'object_blocked';

      // THE EDGE THAT REFUSED IS THE ONE WE ASKED FOR, AND IT IS NAMED FROM WHERE WE
      // ASKED IT — not from where we ended up. That distinction is the whole of this fix.
      // A slid step leaves the character at neither end of the step it requested, so
      // blaming the edge out of the LANDING square blames an edge nobody tried: measured,
      // the two-square bounce simply carried on, alternating between the refused edge and
      // an unblocked twin. `was -> was + one step in the requested direction` is exactly
      // what the mover was asked to do and exactly what a replan would ask again.
      //
      // A coalesced hop covers several squares and only names its first, so when one fails
      // this attributes the first rather than the guilty one. That is deliberate and it is
      // the safe direction: the cost of blocking a good edge is a slightly longer route,
      // the replan re-asks from nearer, and the real blocker is found on the next lap.
      const bdr = Math.sign(next.row - (was?.row ?? next.row));
      const bdc = Math.sign(next.col - (was?.col ?? next.col));
      let learned = false;
      if (!hitSomething && was && (bdr || bdc)) {
        const k = edgeKey(was.row, was.col, was.row + bdr, was.col + bdc);
        if (!blockedEdges.has(k)) { blockedEdges.add(k); learned = true; }
      }

      if (didNotMove && hitSomething) {
        // COUNTED, BECAUSE A WALK EATEN BY BODIES USED TO BE INDISTINGUISHABLE FROM A
        // WALK WITH TOO SMALL A BUDGET. Both returned `stopped after N steps` with
        // `replans: 0` — the zero because adding an occupied square sets `learned`, and
        // `learned` suppresses the replan counter below. Measured live in the King's Way:
        // the same 3-step walk read `steps: 40, replans: 0` with eleven rats plugging a
        // two-wide corridor and `steps: 3, arrived` once they moved. Nothing in the reply
        // named a monster, so this read as a routing fault for as long as anyone looked
        // at it — which is how it got attributed to the safe-wall geometry it happened to
        // be near. It is a different bug and it needs a different word.
        monsterBlocks++;
        blockedBy.add(`${next.row},${next.col}`);

        // Monsters wander. One retry costs a second and often clears it, which is
        // cheaper and less disruptive than routing the long way round.
        if (stalledOn === `${next.row},${next.col}` && stalledTimes >= 1) {
          // GO ROUND IT RATHER THAN ROUND THE ROOM. Marking the square occupied and
          // replanning is correct and expensive: A* re-solves the whole route, and in a
          // corridor the only answer it can find is the long way, which is how a
          // three-step walk becomes forty. A body is one square wide — the cheap move is
          // to try the two squares either side of it first.
          //
          // BACK UP FIRST, and that is the part that is not obvious. Standing next to the
          // blocker, the diagonal past it is frequently refused by the mover as well:
          // squeezing between a body and a wall is exactly the clearance the player disc
          // does not have. Retreating one square opens the angle, which is what a person
          // does without thinking about it.
          //
          // It is only ever a PREFERENCE. If neither side works the ordinary occupancy
          // path below runs exactly as it did before, so this can cost a couple of steps
          // and cannot cost the walk.
          const side = this.sidestepAround(was, next,
            { blockedEdges, occupied, geo, prefer: Number(c.self?.id ?? 0) });
          if (side && !sidestepped.has(`${next.row},${next.col}`)) {
            sidestepped.add(`${next.row},${next.col}`);
            queue.unshift(next);
            queue.unshift(side.through);
            if (side.back) queue.unshift(side.back);
            stalledOn = null; stalledTimes = 0;
            continue;
          }
          occupied.add(`${next.row},${next.col}`);
          stalledOn = null; stalledTimes = 0; learned = true;
        } else {
          stalledOn = `${next.row},${next.col}`;
          stalledTimes++;
          queue.unshift(next);                       // try the same square once more
          // JITTERED, TO BREAK LOCKSTEP IN TIME AS WELL AS IN SPACE.
          //
          // Two characters that meet head-on retry on the same 700ms cadence, so they
          // step, collide, wait, and step again in perfect unison — and a side preference
          // alone does not help if both are always deciding at the same instant. A few
          // hundred milliseconds of spread means one of them acts while the other is
          // still waiting, which is how two people actually get past each other.
          //
          // THE JITTER IS ON THE WAIT AND NEVER ON THE CHOICE. Randomising which side to
          // try would make the walker unreproducible, and every routing test here depends
          // on the same inputs giving the same route; a timing difference changes when a
          // decision happens, not what it is.
          await new Promise(res => setTimeout(res, 500 + Math.floor(Math.random() * 500)));
          continue;
        }
      }

      // A REPLAN THAT LEARNED SOMETHING IS NOT THE ONE THIS BUDGET IS FOR. The cap exists
      // to stop an endless loop, and a loop is precisely a replan that discovers nothing:
      // every walk of a wall of any length would otherwise exhaust eight tries and report a
      // room impassable. So an informative failure is free — the edge set is finite and
      // shrinks the search each time — and only a repeat burns the budget. `hardCap` still
      // bounds the whole walk in steps, so this cannot run away.
      // AND THE BUDGET HAS TO SCALE WITH THE ROUTE, FOR THE SAME REASON `maxSteps` DOES.
      //
      // Eight was a fixed number against a route of any length, and the step budget ten
      // lines above already scales (`plan.steps.length + 10`) — that asymmetry was
      // arbitrary and it is what ends long walks. The King's Way is 129x88 with 8,639
      // walkable squares and its east boundary is a median 91 steps away; in geometry
      // where ~70% of steps land off-plan, eight uninformative replans are gone in the
      // first quarter of the walk.
      //
      // Measured, with an operator watching the character it happened to: Western border
      // of the Twisted Wood -> The Twisted Wood failed six times over 40s, every attempt
      // reporting "kept ending up somewhere other than the planned square" — this exact
      // message — against the SAME staging square, which it then re-planned and tried
      // again. The character was standing on a square with seven of seven mover
      // neighbours and an eighteen-step route to the boundary.
      //
      // One extra replan per ten planned steps, so a short walk is unchanged (a 9-step
      // route still gets 8) and a 91-step crossing gets 17. `hardCap` still bounds the
      // whole walk at 400 steps, so this cannot run away — the cap that actually stops a
      // runaway is the step count, not this.
      const replanBudget = 8 + Math.floor((plan.steps?.length ?? 0) / 10);
      if (!learned && ++replans > replanBudget)
        return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                 routed_around: [...occupied], refused_edges: blockedEdges.size,
                 ...(monsterBlocks ? { monster_blocked: monsterBlocks,
                                       blocked_by_bodies_at: [...blockedBy] } : {}),
                 note: 'kept ending up somewhere other than the planned square' };
      // A SWITCH TO FINE MOVEMENT HERE WAS TRIED, AND ITS MEASUREMENT WAS INVALID.
      //
      // The idea was to hand the remainder of a walk to `walkFine` once `offPlan` passed
      // a threshold. It A/B'd at 1/5 against 4/5 for the plain square walk, which looked
      // decisive — and was not: a second agent was committing to this same file between
      // the two arms (5421a69, a4d4c71), so the arms differed by more than the change
      // under test. The comparison is withdrawn rather than reported.
      //
      // It is still not reinstated, for a reason that survives the bad measurement: those
      // two commits found the actual causes of the same symptom — the outward step past a
      // boundary was clipped and never sent, and `neighbors()` was gating every step on
      // the monster grid — and both are upstream of the off-plan rate this was trying to
      // paper over. Fixing a rate is the wrong move when the thing generating it has just
      // been fixed properly.
      //
      // `offPlan` is kept as TELEMETRY only. It costs an integer, it is the number that
      // would say whether the remaining slide still matters, and nothing acts on it.
      // A replan is exactly when something has moved into the way, so the threat field
      // is re-read here rather than reused from the top of the walk.
      const re = geo.path(now.row, now.col, row, col,
        { avoid: occupied, blockedEdges, threats: this.threatsHere(), clearance });
      if (!re.found) {
        // RELAX IN THE ORDER THE FACTS DECAY. Occupancy is a guess about where something
        // was standing a moment ago and is dropped first; a refused edge is a wall and is
        // kept. Only if that still fails is the collision model itself set aside — being
        // wrong about a wall costs a walk, and refusing costs the errand, so the last try
        // is the coarse grid we planned on before any of this existed.
        let open = occupied.size
          ? geo.path(now.row, now.col, row, col,
              { blockedEdges, threats: this.threatsHere(), clearance })
          : re;
        if (open.found) occupied.clear();
        else if (blockedEdges.size) {
          // NOT CLEARED, ONLY SET ASIDE FOR THIS ONE PLAN. Forgetting the refusals would
          // re-enter the same bounce with the same enthusiasm; keeping them means the hop
          // coalescer still steps over them and the next replan still knows. If the coarse
          // plan's own first step is one of them we fail again, learn nothing new, and the
          // budget above ends the walk honestly instead of grinding.
          open = geo.path(now.row, now.col, row, col, { collision: false });
          if (open.found) occupied.clear();
        }
        // AND THE POCKET CAN BE WALKED INTO MID-WALK, not only stood in at the start —
        // a slid step lands where it lands, and where it lands can be cut off. Same
        // escape, once per walk: undoing the trail twice would unwind the journey.
        if (!open.found && !escaped) {
          const out = await this.retreatAlongBreadcrumbs({
            movementGeneration, controlToken,
            until: () => geo.path(c.self?.row ?? -1, c.self?.col ?? -1, row, col,
              { blockedEdges }).found,
          });
          if (out.cancelled) return out;
          escaped = Math.max(1, out.steps ?? 0);
          const at = c.self;
          if (out.moved && at) open = geo.path(at.row, at.col, row, col, { blockedEdges });
        }
        if (!open.found)
          return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                   refused_edges: blockedEdges.size, reason: open.reason,
                   ...(escaped ? { retreated: escaped } : {}) };
        queue = open.steps.slice();
        continue;
      }
      queue = re.steps.slice();
    }
    const me = c.self;
    const arrived = !!me && me.col === col && me.row === row;
    // MONSTER COLLISION DURING TRAVEL IS NAMED, EVERY TIME, INCLUDING ON SUCCESS.
    //
    // The failure this repairs was not that the walk stopped — it was that the reply
    // said `stopped after 40 steps` and nothing else, so an operator watching a bot
    // shuffle in a corridor had no way to tell a plugged corridor from a wall, and the
    // fault was filed against the geometry it happened to be standing near. A count and
    // the squares are enough to tell them apart at a glance, and reporting it on a
    // SUCCESSFUL walk matters just as much: that is how "this route is fine but it costs
    // us thirty steps whenever the rats are out" becomes visible at all.
    const bodies = monsterBlocks
      ? { monster_blocked: monsterBlocks, blocked_by_bodies_at: [...blockedBy],
          ...(sidestepped.size ? { sidestepped: sidestepped.size } : {}) }
      : {};
    return { arrived, position: me && { col: me.col, row: me.row }, steps: taken, replans,
             ...bodies,
             ...(taken >= maxSteps
                 ? { note: monsterBlocks
                       ? `stopped after ${maxSteps} steps — ${monsterBlocks} monster collision(s) ` +
                         'during travel ate the budget; the route itself was not refused'
                       : 'stopped after ' + maxSteps + ' steps' }
                 : {}) };
  }

  // Leave the room. The tool picks the mechanism, because using the wrong one
  // produces no reply at all:
  //   an edge exit -> walk to the boundary square, then one more step outward
  //   a `go` exit  -> stand on EXACTLY the exit square, then BP_REQ_GO
  async leaveVia(exit, { movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();

    // Budget every walk by the ROUTE length, never by a fixed cap. Outdoor rooms here
    // are up to 80x80, so a boundary square can be well over a hundred steps away —
    // and a cap turns a perfectly good exit into a hop that "fails" for no stated
    // reason, which is exactly the silent failure this broker exists to remove.
    const budget = e => Math.max(60, ((e.steps_away ?? 0) * 3) + 20);

    if (exit.kind === 'go') {
      // CLEARANCE ON, because this is the long routing: crossing a whole room to a
      // boundary square is exactly where hugging the wall makes a step slide, the mover
      // land off plan, and the walker start the bounce. See walkTo's `clearance`.
      let walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                   { maxSteps: budget(exit), movementGeneration, controlToken,
                                     clearance: 0.6 });
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };

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
                                         { maxSteps: budget(exit), movementGeneration, controlToken }).catch(() => null);
        if (isTerminalMovementReason(fine?.reason))
          return { left: false, stage: 'walk', ...fine };
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
      // — 64 to the square — and the real client clips a requested point to the
      // closest legal position. Do that collision pass locally, which can slide us
      // hard up against the doorway without ever sending an endpoint through it.
      if (!walk.arrived) {
        let spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
        // WHERE WE ARE STANDING CAN BE THE WHOLE PROBLEM.
        //
        // approachSquare answers from the square we occupy, and some squares simply have
        // no path to the doorway even though the room does. Cibilo Creek Inn is the case:
        // a character at (2,3) has every direction in can_step except the one the exit is
        // in, and both walk_to and go_through fail on it — while a character at (5,5) in
        // the same room walks out on the first try. Four characters sat in two taverns on
        // squares like that, reporting the room unleavable, and it was only ever the spot.
        //
        // So before giving up, step somewhere else and ask again. Anywhere reachable will
        // do; the middle of the room is the likeliest to see the door.
        if (!spot) {
          const rows = this.world?.room?.size?.rows ?? 0, cols = this.world?.room?.size?.cols ?? 0;
          for (const [c2, r2] of [[Math.floor(cols / 2), Math.floor(rows / 2)],
                                  [Math.floor(cols / 3), Math.floor(rows / 2)],
                                  [Math.floor(cols / 2), Math.floor(rows / 3)]]) {
            if (!(c2 > 0 && r2 > 0)) continue;
            const step = await this.walkTo(c2, r2, { maxSteps: 30, movementGeneration, controlToken })
                                   .catch(() => ({ arrived: false }));
            if (isTerminalMovementReason(step.reason))
              return { left: false, stage: 'walk', ...step };
            if (!step.arrived) continue;
            spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
            if (spot) break;
          }
        }
        if (!spot) return { left: false, stage: 'walk', ...walk,
                            note: 'no path to the doorway from here, and moving elsewhere in the ' +
                                  'room did not find one either' };
        if (spot.steps > 0) {
          const near = await this.walkTo(spot.col, spot.row,
                                         { maxSteps: Math.max(40, spot.steps + 20), movementGeneration, controlToken });
          if (!near.arrived) return { left: false, stage: 'walk', ...near };
        }
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
      }

      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      // Where the server thinks we are, before asking it to let us out. If prediction
      // drifted, lean again from the position we are ACTUALLY on — the first lean was
      // aimed from a square we may never have reached.
      let at = await this.confirmPosition();
      if (!at) {
        this.finePositionUnknown = true;
        return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                 note: 'the server position could not be confirmed, so no doorway correction or go was sent' };
      }
      if (at && (Math.abs(at.col - exit.stand_on.col) > 1 || Math.abs(at.row - exit.stand_on.row) > 1)) {
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
        at = await this.confirmPosition();
        if (!at) {
          this.finePositionUnknown = true;
          return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                   note: 'the corrected doorway position could not be confirmed, so go was not sent' };
        }
      }

      // THE LAST SQUARE IS THE ONE THE GRID CANNOT SEE, AND IT IS THE ONLY ONE THAT
      // COUNTS. `UserGo` passes the server's own piRow/piCol and `SomethingTryGo`
      // (room.kod:2777) matches them against plExits with `=`. Not a radius, not a
      // facing cone — that exact square or nothing.
      //
      // And the way IN is not the way OUT. Measured in the Brownestone Inn with the
      // operator standing in it: the door from North Barloque delivers you to (12,16),
      // the door back out is at (12,17), and row 17 is walkable floor that the coarse
      // grid marks unreachable from every square touching it. So a character walks in,
      // lands one square short of the way home, and the router refuses to try before
      // sending a single packet. Camilla sat there failing 29 crossings in five minutes.
      //
      // Fine movement can cross its legal low step even though the square grid cannot
      // represent it, because it checks the fine BSP instead. So when the
      // square-based approach has left us anywhere but the exit square, fall through to
      // it rather than issuing a `go` that cannot possibly be accepted.
      // AN UNKNOWN POSITION IS NOT A CORRECT ONE. `at` is null when the confirming read
      // timed out, and both corrections below were guarded on `at` being truthy — so a
      // failed read skipped them BOTH and sent `go` blind, then reported the result as
      // "stood on the exit square and nothing happened", which is a claim we had no
      // evidence for. Treat unknown like wrong: request the square in fine units and
      // let the local collision pass cross or clip it before anything is sent.
      if (at.col !== exit.stand_on.col || at.row !== exit.stand_on.row) {
        const half = KOD_FINENESS >> 1;
        const correction = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                                exit.stand_on.row * KOD_FINENESS + half)
                                     .catch(error => ({ moved: false, reason: error.message }));
        if (isTerminalMovementReason(correction.reason))
          return { left: false, stage: 'walk', reason: correction.reason, note: correction.note };
        const corrected = correction.position;
        if (!corrected || corrected.col !== exit.stand_on.col || corrected.row !== exit.stand_on.row)
          return { left: false, stage: 'walk', reason: correction.reason ?? 'geometry_blocked',
                   note: correction.note ?? 'local collision could not place the character on the exact exit square' };
        leaned = true;
      }
      await this.standBeforeGo();
      // Wait for the ROOM CHANGE specifically. A door announces itself first —
      // "You open the door and walk through." arrives as a message a beat before
      // BP_PLAYER reports the new room — and waitFor returns on the first match of
      // ANY listed kind. Listening for 'message' too therefore returned the
      // announcement of success and called it a failure, every single time.
      const go = await boundedSilentGo({
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        send: () => this.pacer.submit('move', () => c.go(), DOOR_SETTLE_MS),
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
      });
      if (go.cancelled)
        return this.cancelledMovement({ go_attempts: go.attempts });
      const entered = go.entered, messages = go.messages, goAttempts = go.attempts;
      return { left: !!entered, arrived_in: entered ? entered.roomName : null,
               go_attempts: goAttempts,
               ...(leaned && entered
                   ? { note: 'the exit square is not walkable in this room\'s grid, so this ' +
                             'leaned into the doorway from the square beside it' } : {}),
               ...(entered ? {} : {
                 reason: messages.length ? messages.join('; ')
                       : leaned ? `leaned into (${exit.stand_on.col},${exit.stand_on.row}) from beside ` +
                                  `it and the server did not open a door there after ${goAttempts} attempts`
                       : `sent go ${goAttempts} time${goAttempts === 1 ? '' : 's'} and the server ` +
                         'answered nothing at all — no room change and no refusal' }),
               messages };
    }

    if (exit.kind === 'edge') {
      // Graph hops carry the abstract edge; the live world attaches an exact
      // BSP-validated inside point, the minimum out-of-bounds target, and (when
      // needed) a short fine route from a coarse staging square.
      if (!exit.fine_stand_on || !exit.edge_target) {
        const enriched = this.world.exits().find(candidate => candidate.kind === 'edge'
          && candidate.to === exit.to && candidate.direction === exit.direction);
        if (enriched) exit = { ...exit, ...enriched };
      }
      if (!exit.stand_on || !exit.fine_stand_on || !exit.edge_target) {
        // NO BSP-VALID CROSSING: the .roo geometry does not publish a floor
        // trace along this edge at the exit row. The server map says the exit
        // exists; the room geometry disagrees. This is the "phantom exit"
        // problem — the most common cause of a character being trapped in a
        // room forever (Twisted Wood west, King's Way north, etc.).
        //
        // FABRICATE A STANDING SQUARE. Pick the cell on the exit boundary
        // nearest to the character's current position, and use it as the
        // stand_on. The server will either let us through (the geometry was
        // just missing the trace) or refuse (the exit is truly blocked).
        // Either way, we made progress instead of sitting in the room
        // reporting "no BSP-valid crossing" for eternity.
        const meNow0 = c.self;
        const dir = exit.direction;
        const roomC = c.room.cols ?? 50, roomR = c.room.rows ?? 48;
        let fabricCol, fabricRow;
        if (dir === 'west') { fabricCol = 0; fabricRow = meNow0?.row ?? Math.floor(roomR / 2); }
        else if (dir === 'east') { fabricCol = roomC - 1; fabricRow = meNow0?.row ?? Math.floor(roomR / 2); }
        else if (dir === 'north') { fabricCol = meNow0?.col ?? Math.floor(roomC / 2); fabricRow = 0; }
        else if (dir === 'south') { fabricCol = meNow0?.col ?? Math.floor(roomC / 2); fabricRow = roomR - 1; }
        else { return { left: false, reason: `no BSP-valid crossing on the ${dir} boundary` }; }
        // Nudge the row/col inward by 1 if the boundary cell is unwalkable
        // (coarse or fine), so the character has somewhere to stand before
        // making the final outward step.
        const geo = this.world?.room?.geo;
        if (geo) {
          const boundaryBlocked = (r, col) => {
            const coarse = geo.flags ? (geo.flags[r * geo.cols + col] & 0x01) : 1;
            const fine = geo.fineWalkable(r, col);
            return coarse === 0 && fine !== true;
          };
          // Try up to 3 cells inward from the boundary
          const inward = dir === 'west' ? 1 : dir === 'east' ? -1 : dir === 'north' ? 1 : -1;
          for (let i = 0; i <= 3; i++) {
            const fc = dir === 'west' || dir === 'east' ? fabricCol + inward * i : fabricCol;
            const fr = dir === 'north' || dir === 'south' ? fabricRow + inward * i : fabricRow;
            if (fc < 0 || fc >= roomC || fr < 0 || fr >= roomR) break;
            if (!boundaryBlocked(fr, fc)) { fabricCol = fc; fabricRow = fr; break; }
          }
        }
        const half = KOD_FINENESS >> 1;
        exit = { ...exit,
          stand_on: { col: fabricCol, row: fabricRow },
          fine_stand_on: { x: fabricCol * KOD_FINENESS + half, y: fabricRow * KOD_FINENESS + half },
          edge_target: { x: dir === 'west' ? 0 : dir === 'east' ? (roomC + 1) * KOD_FINENESS : fabricCol * KOD_FINENESS + half,
                         y: dir === 'north' ? 0 : dir === 'south' ? (roomR + 1) * KOD_FINENESS : fabricRow * KOD_FINENESS + half },
        };
        if (process.env.M59_EXIT_DEBUG !== '0')
          console.error(`[exit-debug] ${this.name ?? '?'} FABRICATED stand_on=(${fabricCol},${fabricRow}) dir=${dir} — no BSP crossing published`);
      }
      const edgeStartRoom = c.room.id;
      // No reachable boundary square, says the square grid — the same verdict it
      // gives for a cliff ledge, and wrong for the same reason. Pick the nearest
      // floor square actually on that boundary and walk to it with fine BSP collision.
      //
      // THE LONG-CROSSING DRIFT FIX. `walkTo` plans square-to-square on cell centers, but
      // after the first slide the character is no longer at a center, and every subsequent
      // step is validated center-to-center — so steps the coarse model calls legal are
      // refused by the fine collision, each costing a replan that produces the same plan
      // that just failed. Measured in the Twisted Wood: a 50-column crossing took 74+ steps
      // and hit the budget, reporting "kept ending up somewhere other than the planned
      // square", while a direct fine walk to the same gap takes 15s. For a FAR staging
      // square (> 12 cells), skip the coarse walk entirely and go straight to `walkFine`,
      // which steps from the character's ACTUAL fine position (position-anchored, immune to
      // the slide-drift) rather than from cell centers. Short walks (<= 12 cells) keep the
      // well-tested coarse `walkTo` path.
      const meNow = c.self;
      const distToStaging = meNow
        ? Math.hypot(exit.fine_stand_on.x - meNow.x, exit.fine_stand_on.y - meNow.y) / KOD_FINENESS
        : 0;
      if (process.env.M59_EXIT_DEBUG !== '0')
        console.error(`[exit-debug] ${this.name ?? '?'} staging approach: distToStaging=${distToStaging.toFixed(1)} cells, using ${distToStaging > 12 ? 'FINE' : 'COARSE'} walk`);
      if (distToStaging > 0) {
        const fineDirect = await this.walkFine(exit.fine_stand_on.x, exit.fine_stand_on.y, {
          maxSteps: Math.max(60, Math.ceil(distToStaging * 4)), stride: 48, arriveWithin: 4,
          movementGeneration, controlToken,
        });
        if (process.env.M59_EXIT_DEBUG !== '0')
          console.error(`[exit-debug] ${this.name ?? '?'} fineDirect result: arrived=${fineDirect.arrived} left_room=${fineDirect.left_room} reason=${fineDirect.reason ?? 'none'} room=${c.room.id} (start=${edgeStartRoom}) steps=${fineDirect.steps ?? '?'}`);
        if (fineDirect.left_room || c.room.id !== edgeStartRoom)
          return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                   note: 'the room changed while fine-walking to the boundary' };
        if (isTerminalMovementReason(fineDirect.reason))
          return { left: false, stage: 'walk', ...fineDirect };
        // If the fine walk got us to a crossing square (even if not the exact fine_stand_on),
        // proceed to the edge step from wherever we are.
        if (!fineDirect.arrived) {
          const me2 = c.self;
          const crossings = [{ col: exit.stand_on.col, row: exit.stand_on.row,
                               fine_stand_on: exit.fine_stand_on, edge_target: exit.edge_target,
                               fine_path: exit.fine_path },
                             ...(exit.alternates ?? [])];
          const here2 = me2 && crossings.find(a => a.col === me2.col && a.row === me2.row
                                               && a.fine_stand_on && a.edge_target);
          if (here2) {
            exit = { ...exit, stand_on: { col: here2.col, row: here2.row },
                     fine_stand_on: here2.fine_stand_on, edge_target: here2.edge_target,
                     fine_path: here2.fine_path, crossed_from_alternate: true };
          } else {
            // The fine walk got us close but not onto a crossing square. Fall through to
            // the edge step anyway — being near the opening is often enough for StandardLeaveDir.
            if (process.env.M59_EXIT_DEBUG !== '0')
              console.error(`[exit-debug] ${this.name ?? '?'} fine walk got to (${me2?.col ?? '?'},${me2?.row ?? '?'}) not on a crossing square; trying edge step from here`);
          }
        }
      } else {
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: 0.6 });
      if (walk.left_room || c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed while approaching the boundary' };
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };
      // ARRIVING ON *A* CROSSING SQUARE IS ARRIVING. THE EXACT ONE DOES NOT MATTER.
      //
      // This used to demand the walk finish on the one anchor `exits()` picked, and give
      // up otherwise — without ever attempting the crossing. That produced the dance an
      // operator watched and described exactly: a character walks to one opening, does
      // not cross, walks all the way across the room to the other opening, does not
      // cross, and comes back. `travel` re-plans after each refusal and picks a different
      // candidate, so the two openings alternate for ever.
      //
      // It is also unnecessary, and `exits()` says so twenty lines away: "the boundary is
      // one exit and any square on it crosses". Measured on the west wall of Main gate to
      // the city of Tos, which has two separate openings at rows 20-23 and 43-48: a
      // character teleported onto 20,1 and onto 47,1 crossed in ZERO seconds from both.
      // The crossing was never the problem — landing on one exact square was.
      //
      // So when the walk ends somewhere else, look for where we ACTUALLY are among this
      // boundary's crossing squares and use that one's own fine target. Only if we are on
      // none of them is the walk a failure.
      if (!walk.arrived) {
        const me = c.self;
        const crossings = [{ col: exit.stand_on.col, row: exit.stand_on.row,
                             fine_stand_on: exit.fine_stand_on, edge_target: exit.edge_target,
                             fine_path: exit.fine_path },
                           ...(exit.alternates ?? [])];
        const here = me && crossings.find(a => a.col === me.col && a.row === me.row
                                            && a.fine_stand_on && a.edge_target);
        if (here) {
          exit = { ...exit, stand_on: { col: here.col, row: here.row },
                   fine_stand_on: here.fine_stand_on, edge_target: here.edge_target,
                   fine_path: here.fine_path,
                   crossed_from_alternate: true };
        }
        // If we are not on a crossing square, do NOT return. Fall through to the
        // raw-grid fallback below, which will walk us toward the opening using raw
        // moveToSquare. The old `return` here abandoned the exit attempt on the first
        // walk failure, even when the character was close and a raw-grid nudge would
        // have made it (e.g. an inn door blocked by furniture in the local geometry).
      }
      }
      let pressedInWithoutExactFit = null;
      // RAW-GRID FALLBACK. If the character is still far from the opening (> 5 cells) after
      // both the coarse and fine walks failed, the local collision geometry is out of sync
      // with the server's (the .roo file does not match this room's actual collision). In
      // that case, stop trying to validate against local geometry and just walk
      // grid-square-to-grid-square toward the opening using raw moveToSquare. The server
      // handles the real collision; the character steps one square at a time and the
      // server moves him or bounces him. This is the "dumb but robust" fallback that
      // always makes progress because it never refuses a step on the client side.
      const meFar = c.self;
      if (meFar && exit.fine_stand_on) {
        const distCells = Math.hypot(exit.fine_stand_on.x - meFar.x, exit.fine_stand_on.y - meFar.y) / KOD_FINENESS;
        if (distCells > 0.5) {
          const targetCol = Math.floor(exit.fine_stand_on.x / KOD_FINENESS);
          const targetRow = Math.floor(exit.fine_stand_on.y / KOD_FINENESS);
          const maxRawSteps = Math.min(200, Math.ceil(distCells * 2) + 20);
          for (let i = 0; i < maxRawSteps; i++) {
            if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
            const me = c.self;
            if (!me || c.room.id !== edgeStartRoom) break;
            const dx = targetCol - me.col, dy = targetRow - me.row;
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break; // close enough
            const stepCol = me.col + Math.sign(dx);
            const stepRow = me.row + Math.sign(dy);
            try { c.moveToSquare(stepCol, stepRow); } catch { break; }
            await new Promise(r => setTimeout(r, 250));
          }
          if (process.env.M59_EXIT_DEBUG !== '0') {
            const meNow = c.self;
            console.error(`[exit-debug] ${this.name ?? '?'} raw-grid fallback: walked ${maxRawSteps} steps, now at (${meNow?.col ?? '?'},${meNow?.row ?? '?'}) target=(${targetCol},${targetRow})`);
          }
        }
      }
      const finePath = exit.fine_path?.length ? exit.fine_path : [exit.fine_stand_on];
      for (const point of finePath) {
        const fine = await this.walkFine(point.x, point.y, {
          maxSteps: Math.max(20, budget(exit)), stride: 32, arriveWithin: 1,
          movementGeneration, controlToken,
        });
        if (fine.left_room || c.room.id !== edgeStartRoom)
          return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                   note: 'crossed the boundary while fine-positioning at its opening' };
        if (isTerminalMovementReason(fine.reason))
          return { left: false, stage: 'walk', ...fine };
        // NOT ARRIVING EXACTLY IS NOT A REASON NOT TO TRY THE EDGE.
        //
        // `arriveWithin: 1` above asks to land within ONE fine unit — a 64th of a square
        // — and returning here when it does not is the machinery refusing to press into
        // the wall. The operator's rule, and it is simply how the game works: for every
        // exit that is not a door or a portal, leaving ALWAYS requires one more step
        // toward the edge, and that edge is an invisible wall you run into. There is no
        // version of it where precision at the opening matters, because the thing that
        // triggers `Room.StandardLeaveDir` is the outward step, not where you stood.
        //
        // Proved by teleport: a character placed on 20,1 and on 47,1 of Main gate to the
        // city of Tos — different openings, neither the blessed anchor — both crossed in
        // ZERO seconds. What has been failing is never the crossing; it is everything
        // this function does before allowing itself to attempt one.
        //
        // So a fine-positioning miss now falls through to the outward step instead of
        // returning. If we are somewhere the edge step cannot fire from, that step fails
        // on its own and reports it — one wasted packet against an errand abandoned at
        // the door.
        if (!fine.arrived) {
          pressedInWithoutExactFit = fine.note ?? 'did not reach the exact opening; pressing into the edge anyway';
          break;
        }
      }
      // One more step OUTWARD, past the grid. Nothing else triggers
      // Room.StandardLeaveDir, and `offMap` is what stops our own collision view
      // refusing to send it — there is no floor out there and there is not meant to be.
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      if (process.env.M59_EXIT_DEBUG !== '0') {
        const meNow = c.self;
        const dx = Math.abs((meNow?.x ?? 0) - exit.edge_target.x);
        const dy = Math.abs((meNow?.y ?? 0) - exit.edge_target.y);
        console.error(`[exit-debug] ${this.name ?? '?'} edge step dir=${exit.direction} me=(${meNow?.col ?? '?'},${meNow?.row ?? '?'}) @(${meNow?.x ?? '?'},${meNow?.y ?? '?'}) ` +
          `target=(${exit.edge_target.x},${exit.edge_target.y}) dist=(${dx.toFixed(0)},${dy.toFixed(0)}) ${pressedInWithoutExactFit ?? 'exact-fit'}`);
      }
      const edgeMove = await this.queueValidatedMove(
        exit.edge_target.x, exit.edge_target.y,
        // Stock UserMovePlayer sends speed zero for the one StandardLeaveDir
        // out-of-room request; it is not a run/vigor-bearing in-room step.
        { speed: 0, slide: false, minGap: MOVE_INTERVAL_MS,
          expectedRoomId: edgeStartRoom, offMap: true });
      if (!edgeMove.sent && c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed before the final edge packet was needed' };
      if (!edgeMove.sent) return {
        left: false, stage: 'edge',
        reason: edgeMove.validation?.reason ?? 'geometry_blocked',
        note: edgeMove.validation?.note ??
          'the outward edge packet could not be sent at all — not a collision refusal',
      };
      const tGo = Date.now();
      // THE CROSSING IS SLOW WHEN THE SERVER IS BUSY, AND IT STILL WORKS.
      //
      // The operator's description of playing this by hand: you stop dead against the
      // invisible wall, and a beat later it jumps you to the next map. So a late
      // `room-entered` is the ORDINARY case under load, not a failure — and at 4s we
      // were giving up on crossings that were still in flight and recording them as
      // "stepping past the edge did nothing", which is the one reading that makes a
      // working exit look like a phantom.
      const ev = await c.waitFor({ since: edgeMove.eventSeq, kinds: ['room-entered'],
                                   timeoutMs: EDGE_CROSSING_WAIT_MS });
      Pacer.note('go', 'blocked', Date.now() - tGo);
      let entered = ev.events.find(e => e.kind === 'room-entered');
      // ASK THE WORLD, NOT ONLY THE EVENT RING. The event can be missed — evicted, or
      // arriving on a rejoined client — while the character is demonstrably somewhere
      // else. Having crossed is a fact about where we are standing.
      if (!entered && c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed but no room-entered event was seen' };
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
      const candidates = Array.isArray(exit.trigger_targets) && exit.trigger_targets.length
        ? exit.trigger_targets
        : exit.stand_on ? [{ stand_on: exit.stand_on, steps_away: exit.steps_away,
                             reachable: exit.reachable, approach_on: exit.approach_on }] : [];
      if (!candidates.length)
        return { left: false, reason: 'no walkable square or reachable approach for the trigger region',
                 note: 'the region is ' + exit.trigger + ' — it may really be walled off from here' };

      const result = await boundedRegionEntry({
        candidates,
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        walk: candidate => this.walkTo(candidate.stand_on.col, candidate.stand_on.row,
          { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: 0.6 }),
        fineWalk: async candidate => {
          // Get as close as the square graph knows how before bypassing it. Fine movement
          // is deliberately expensive — every step is confirmed by a room read — and from
          // across an outdoor map it is both slow and needlessly risky. The staging square
          // makes this a short locally validated crossing of the disputed geometry.
          const target = candidate.stand_on;
          const knownApproach = candidate.approach_on;
          const computedApproach = this.world.approachSquare(target.col, target.row);
          const approach = knownApproach ?? (computedApproach && {
            col: computedApproach.col, row: computedApproach.row,
          });
          let staged = null;
          if (approach) {
            staged = await this.walkTo(approach.col, approach.row,
              { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: 0.6 });
            if (staged.left_room || (!staged.arrived &&
                !(c.self && c.self.col === approach.col && c.self.row === approach.row)))
              return { arrived: false, ...(staged.left_room ? { left_room: true } : {}),
                       reason: staged.reason ?? 'could not reach the square beside the trigger', staged };
          }
          const half = KOD_FINENESS >> 1;
          const fine = await this.walkFine(target.col * KOD_FINENESS + half,
                                           target.row * KOD_FINENESS + half,
                                           { maxSteps: 40, movementGeneration, controlToken })
                                 .catch(error => ({ arrived: false, reason: error.message }));
          return { ...fine, ...(staged ? { staged } : {}) };
        },
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
        // A genuine region fires merely by arriving. Asking to go is retained as one
        // bounded compatibility probe for map entries that are really doors in disguise.
        askGo: async () => {
          await this.standBeforeGo();
          await this.pacer.submit('move', () => c.go(), DOOR_SETTLE_MS);
        },
      });
      if (result.cancelled) return this.cancelledMovement({ tried: result.tried.length });
      if (result.terminal)
        return { left: false, stage: 'walk', ...result.terminal,
                 tried: result.tried.length };
      if (result.unconfirmed_transition)
        return { left: false, reason: 'left the source room but could not confirm the destination',
                 tried: result.tried.length,
                 note: 'movement stopped immediately rather than issuing a blind request in the new room' };
      if (result.entered) {
        const successful = result.tried[result.tried.length - 1] ?? {};
        return { left: true, arrived_in: result.entered.roomName,
                 via: successful.asked_go ? 'region trigger, after asking to go'
                      : successful.fine ? 'region trigger via fine movement' : 'region trigger',
                 trigger_target: successful.candidate?.stand_on ?? null };
      }

      const tried = result.tried.map(attempt => ({
        stand_on: attempt.candidate.stand_on,
        approach_on: attempt.candidate.approach_on ?? null,
        coarse: attempt.coarse?.reason ?? (attempt.coarse?.arrived ? 'arrived' : null),
        fine: attempt.fine?.reason ?? (attempt.fine?.arrived ? 'arrived' : null),
        asked_go: !!attempt.asked_go,
      }));
      const reached = result.tried.some(attempt => attempt.coarse?.arrived || attempt.fine?.arrived);
      return { left: false,
               reason: reached
                 ? 'reached the trigger region but neither automatic entry nor `go` changed rooms'
                 : `could not reach any of ${candidates.length} bounded trigger-region target(s)`,
               tried, note: 'the trigger is ' + exit.trigger };
    }

    // THE SQUARE WE ACTUALLY STOOD ON. Recorded on `this` rather than written anywhere,
    // because this method is lifted out of this file by text and evaluated by
    // m59-collision-test — it may touch nothing but `this`, its injected dependencies and
    // built-ins. A non-lifted caller flushes it; see flushExitGaps.
    this.lastExitStand = c.self ? { col: c.self.col, row: c.self.row } : null;

    if (exit.kind === 'portal') {
      // Nothing to send: Portal.SomethingMoved fires on arrival at its square and
      // teleports whatever is standing there. So walking IS the action.
      const before = c.evSeq;
      const portalStartRoom = c.room.id;
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: 0.6 });
      if (isTerminalMovementReason(walk.reason) && c.room.id === portalStartRoom)
        return { left: false, stage: 'walk', ...walk };
      const tGo = Date.now();
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      Pacer.note('go', 'blocked', Date.now() - tGo);
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (!entered)
        return { left: false, stage: walk.arrived ? 'stood on it' : 'walk', ...walk,
                 reason: walk.arrived ? 'standing on it did nothing — it may not be a portal after all' : undefined };
      return { left: true, arrived_in: entered.roomName, via: 'portal' };
    }

    return { left: false, reason: 'cannot leave through a ' + exit.kind };
  }

  /**
   * THE LAST RESORT AT A DOORWAY THE MODEL CANNOT DESCRIBE — bounded, counted, and only
   * ever reached once the ordinary path has refused every square it could offer.
   *
   * #18 made the harness enforce collision the way the stock client does, which was right:
   * the server accepts whatever coordinates you send, so nothing else was enforcing it and
   * bots crossed walls. But the approach model is incomplete at some doorways, and a
   * doorway the model cannot describe became a doorway nothing could use — ten of
   * twenty-one characters could not reach a bank, which is the same blockage that starves
   * the whole fleet of reagents.
   *
   * So where the model has refused EVERY square it offered, take the one step it would
   * not, onto a square IT ITSELF published as crossing that boundary. That is far narrower
   * than "movement without validation": the target is the model's own answer, and every
   * step up to it was fully validated.
   *
   * Recorded every time, with the square the model believed in beside the square that
   * actually worked — a bypass nobody measures is a bypass that becomes permanent.
   * `M59_EXIT_FALLBACK=0` turns it off.
   */
  async leaveViaUnvalidated(exit, { movementGeneration = this.movementGeneration } = {}) {
    const c = this.need();
    const target = exit?.stand_on;
    if (!target || !Number.isInteger(target.col) || !Number.isInteger(target.row))
      return { left: false, reason: 'no square to fall back to' };
    if (this.movementWasCancelled(movementGeneration)) return this.cancelledMovement({});
    const before = c.evSeq, startRoom = c.room.id;
    const half = KOD_FINENESS >> 1;
    const x = target.col * KOD_FINENESS + half, y = target.row * KOD_FINENESS + half;
    if (!Number.isInteger(x) || x < 0 || x > 0xffff ||
        !Number.isInteger(y) || y < 0 || y > 0xffff)
      return { left: false, reason: 'fallback target is off the wire grid' };
    this.exitFallbacks = (this.exitFallbacks || 0) + 1;
    // AN EDGE IS LEFT BY STEPPING PAST IT, NOT ONTO IT — and this fallback stepped onto
    // it. `Room.SomethingMoved` only reaches StandardLeaveDir when the new row or col is
    // OUT of the room (room.kod:2232-2258), so moving to the boundary square is an
    // ordinary in-room step and can never cross. For a region exit arriving is the whole
    // trigger, which is why this went unnoticed: the fallback worked for the kind of exit
    // that needs no outward step, and silently could not work for the kind that does.
    //
    // Measured before this: 587 -> 576 reported "every square for that exit refused"
    // even though the outward step had been fixed, because every square WAS refused and
    // then the fallback took the one step that cannot cross either.
    // AND IT MUST ALREADY BE AT THE OPENING. This is the dangerous half, and without the
    // guard the fix above is worse than the bug it repairs.
    //
    // The server does no geometry check on a player move, so an unvalidated packet aimed
    // off the map from ANYWHERE in the room would cross — straight through whatever
    // stands between here and the boundary. Meridian has one-way overland links that are
    // one-way precisely because of terrain near the seam: 589 -> 599 -> 598 is walkable
    // westward and not eastward, because eastward you would have to climb the cliffs you
    // drop off going the other way. The boundary openings are wide (30 and 40 squares);
    // it is the APPROACH that is impossible, and this fallback firing from mid-room would
    // step straight over it and call a one-way link two-way.
    //
    // That is the same failure the breadcrumb note below warns about — relaxing collision
    // exactly where the two views disagree is what let bots climb cliffs no client can.
    // So: only when we are already standing within a square of the published opening,
    // which means the approach succeeded and the only thing left is the step the model
    // will not take.
    const outward = exit?.edge_target;
    const opening = exit?.fine_stand_on;
    const near = Number.isFinite(c.self?.x) && Number.isFinite(opening?.x)
      && Math.abs(c.self.x - opening.x) <= KOD_FINENESS
      && Math.abs(c.self.y - opening.y) <= KOD_FINENESS;
    const useOutward = exit?.kind === 'edge' && outward
      && Number.isFinite(outward.x) && Number.isFinite(outward.y) && near;
    if (exit?.kind === 'edge' && !useOutward)
      return { left: false, reason: 'not at the opening',
               note: 'the unvalidated outward step is only taken from the boundary itself — ' +
                     'firing it from mid-room would cross terrain the approach could not' };
    try {
      if (useOutward) c.moveTo(Math.round(outward.x), Math.round(outward.y), 0, startRoom);
      else c.moveTo(x, y, 18, startRoom);
    } catch (e) { return { left: false, reason: e.message }; }
    const ev = await c.waitFor({ since: before, kinds: ['room-entered'],
                                 timeoutMs: EDGE_CROSSING_WAIT_MS })
                      .catch(() => ({ events: [] }));
    const entered = ev.events?.find(e => e.kind === 'room-entered');
    if (entered) return { left: true, arrived_in: entered.roomName, via: 'exit-fallback',
                          stood_on: { col: target.col, row: target.row } };
    // The room is the authority on having left, not the event — see the same argument
    // at the end of leaveVia.
    if (c.room.id !== startRoom)
      return { left: true, arrived_in: c.rsc.get(c.roomNameRsc), via: 'exit-fallback',
               stood_on: { col: target.col, row: target.row },
               note: 'the room changed but no room-entered event was seen' };
    return { left: false, reason: 'the unvalidated step did not change rooms either' };
  }

  // One doorway is often published as several squares, and they are NOT
  // interchangeable: in the Royal Bank of Jasper (9,7) has a brazier standing on
  // it and refuses, while (9,6) one square north opens. Which is which is not in
  // the protocol, so the only honest thing is to try them in a sensible order and
  // report what each said.
  async leaveViaAny(candidates, { movementGeneration = this.movementGeneration, controlToken } = {}) {
    const tried = [];
    // spreadEdges turns each declared edge into one candidate per square that crosses
    // that boundary — see m59-world.mjs. Without it this tried the nearest square and
    // called the whole wall refused.
    for (const exit of orderExits(spreadEdges(candidates))) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement({ tried });
      const r = await this.leaveVia(exit, { movementGeneration, controlToken });
      if (r.left) return { ...r, used_exit: exit, stood_on: this.lastExitStand ?? null,
                           ...(tried.length ? { tried } : {}) };
      if (isTerminalMovementReason(r.reason))
        return { ...r, left: false, used_exit: exit, ...(tried.length ? { tried } : {}) };
      tried.push({ stand_on: exit.stand_on, why: r.reason || r.note || 'no reason reported' });
    }
    // EVERY SQUARE REFUSED — so before reporting a wall where players walk, take the one
    // step the model would not, onto a square it published itself. Only here, only after
    // the whole ordered list has been tried, and only when nothing terminal stopped us
    // (a terminal reason returned above; it means the contract itself is broken, and
    // walking anyway would be walking on geometry we know is wrong).
    if (tried.length && process.env.M59_EXIT_FALLBACK !== '0') {
      const best = orderExits(spreadEdges(candidates))[0] ?? null;
      if (best) {
        const forced = await this.leaveViaUnvalidated(best, { movementGeneration });
        if (forced.left) return { ...forced, used_exit: best, fallback: true, tried };
      }
    }
    const last = tried[tried.length - 1];
    // THE EVIDENCE FOR A GAP REPORT, carried out rather than filed here. What makes a
    // refusal actionable is not that it happened but WHAT THE MODEL BELIEVED — the best
    // square it could offer — so that it can be set against the square a character is
    // standing on when the same door works. See m59-exitgap.mjs.
    const offered = orderExits(spreadEdges(candidates))[0] ?? null;
    // DIAGNOSTIC: when an exit is refused on every square, log where the character actually
    // is versus where each square wanted him. This is the evidence that separates "the
    // character could not reach the opening" from "the server refused the outward step",
    // and it is what turns a one-line "every square refused" into an actionable gap report.
    if (tried.length && process.env.M59_EXIT_DEBUG !== '0') {
      const me = this.need?.()?.self ?? null;
      const roomName = this.world?.room?.name ?? this.client?.roomNameRsc ?? '?';
      const detail = tried.map(t => `${t.why}@(${t.stand_on?.col},${t.stand_on?.row})`).join(' | ');
      console.error(`[exit-debug] ${this.name ?? '?'} room=${roomName} dir=${offered?.direction ?? candidates?.[0]?.direction ?? '?'} ` +
        `me=(${me?.col ?? '?'},${me?.row ?? '?'}) tried=${tried.length} :: ${detail}`);
    }
    return { left: false, tried,
             gap: { believed: offered?.stand_on
                      ? { col: offered.stand_on.col, row: offered.stand_on.row } : null,
                    direction: offered?.direction ?? candidates?.[0]?.direction ?? null,
                    offered: tried.length },
             reason: tried.length > 1
               ? `every square for that exit refused (${tried.length} tried)`
               : (last ? last.why : 'no exit to try') };
  }

  // One paced round of swings, facing the target before each. Split out from the
  // `attack` tool so the composite skills can drive combat without going through the
  // MCP layer and re-resolving the target every time.
  // `abortBelow` is a health FRACTION, checked after every swing rather than after the
  // round. It is the difference between looking at your own health twice a second and
  // twice a minute.
  //
  // WE WERE SAMPLING AT HALF THE RATE WE DIE. A round is four swings, each paced at
  // ATTACK_INTERVAL_MS and each waiting up to 2500ms for the exchange — call it four
  // seconds — and the disengage test sat AFTER all four (m59-skills.mjs:1483), inside a
  // loop that runs twelve rounds. Meanwhile six centipedes land 12-18 damage a round on
  // a 27-health character: dead in about two seconds.
  //
  // It shows up in the ledger exactly as you would predict. Of 65 deaths, 42% never
  // recorded a health value BELOW their own flee threshold and 32% have a trail that
  // reads 27/27 -> 27/27 -> 27/27 -> dead. Not a threshold tuned wrong — a threshold
  // that was never read while it mattered.
  //
  // And the check is free. `c.vitals()` is already live: BP_STAT is PUSHED on every
  // change (player.kod:7343 calls DrawStatSkill on each one), so the number is sitting
  // in memory between swings. We were not failing to know it, we were failing to look.
  async attackRounds(targetId, swings = 4, { abortBelow = null } = {}) {
    const c = this.need();
    const messages = [];
    let aborted = null;
    const healthPct = () => {
      const h = c.vitals()?.health;
      return h?.max ? h.value / h.max : null;
    };
    for (let i = 0; i < swings; i++) {
      const o = c.room.objects.get(targetId);
      if (!o) break;
      // Before the swing as well as after it: the previous exchange's damage has
      // already landed, and one more swing at 15% is how a character dies mid-round.
      if (abortBelow != null) {
        const hp = healthPct();
        if (hp != null && hp < abortBelow) { aborted = { at_health: hp, swing: i }; break; }
      }
      await this.faceToward(o);
      const before = c.evSeq;
      await this.pacer.submit('attack', () => c.attack(targetId), ATTACK_INTERVAL_MS);
      const ev = await c.waitFor({ since: before, timeoutMs: 2500 });
      messages.push(...ev.events.filter(e => e.text).map(e => e.text));
      if (ev.events.some(e => e.kind === 'vanished' && e.id === targetId)) break;
      if (!c.room.objects.has(c.selfId)) break;      // we died
      if (abortBelow != null) {
        const hp = healthPct();
        if (hp != null && hp < abortBelow) { aborted = { at_health: hp, swing: i + 1 }; break; }
      }
      // A refused swing is refused for the same reason for the whole round — nothing
      // inside a round clears PFLAG_NO_FIGHT — so the other three are three more
      // identical refusals bought at a packet each. Stop and let the caller act on it;
      // `fight` stands up and takes the round again, which is the usual cure.
      if (messages.some((t) => skills.cannotSwingText(t))) break;
    }
    // Health after the exchange, since deciding whether to keep fighting depends on
    // it and the stat only arrives when it changes.
    await this.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    return { messages, vitals: c.vitals(), aborted };
  }

  // Pick up everything gettable within reach. Shared with the `loot` tool.
  // `stayPut` is for looting from a safe spot: UserGet reaches seven squares on its
  // own, so most of a kill's drops are already gettable from where you stand, and the
  // few that are not are not worth giving up the wall for. What is left behind is
  // reported rather than silently skipped.
  async lootFloor({ only = null, ids = null, maxItems = 12, stayPut = false,
                    movementGeneration = this.movementGeneration, controlToken = null,
                    shouldCancel = null, explicitIdsOverride = true,
                    beforeMutation = null } = {}) {
    const c = this.need();
    const cancelled = () => typeof shouldCancel === 'function' && shouldCancel();
    if (cancelled())
      return { taken: [], refused: [], carrying: [], cancelled: true,
               note: 'loot intent was cancelled before its first server request' };
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

    // DO NOT PICK UP A WEAPON THAT IS ALREADY BROKEN.
    //
    // A shattered weapon is worth nothing, cannot be wielded, cannot be sold, and is not
    // renamed — so it looks exactly like the real thing on the floor and gets taken every
    // time. That is where the fleet's dead maces came from: Floyd carrying six and Kermit
    // eight, all picked up off corpses, all indistinguishable until something tried to
    // wield one. Asking the server here costs one look per weapon-shaped candidate and
    // saves a pack slot carried across the world.
    //
    // Only weapon-shaped names are checked, because that is the only class whose
    // brokenness we can read, and only when nothing was asked for by id — an explicit
    // `ids` request is the caller overriding us on purpose. UNKNOWN is taken, not
    // skipped: a look that came back empty is not evidence of anything.
    const brokenSkipped = [];
    if ((!ids?.length || !explicitIdsOverride) && cands.length) {
      // ARMOUR AND SHIELDS BREAK THE SAME WAY AND WERE NOT BEING ASKED ABOUT.
      //
      // This checked weapon-shaped names only, and the comment above explains why — that
      // was the class whose brokenness we knew how to read. It is not: a broken shield
      // refuses on the use path with the same sentence a broken mace does ("You can't use
      // the gold round shield--it's broken."), and examining it answers the same way. So
      // dead armour was picked up off every corpse field exactly as the dead maces were,
      // and worse, it read as ARMOUR in every audit — a character carrying a shattered
      // breastplate looks equipped until something tries to wear it.
      const brokenish = cands.filter(o => {
        const n = c.rsc.get(o.nameRsc) || '';
        return skills.weaponScore(n) > 0 || !!skills.armourKind(n);
      });
      if (brokenish.length) {
        const verdict = await skills.inspectForBroken(this, brokenish.map(o => o.id))
                                    .catch(() => ({ broken: [] }));
        const dead = new Set(verdict.broken || []);
        if (dead.size) {
          cands = cands.filter(o => {
            if (!dead.has(o.id)) return true;
            brokenSkipped.push(c.rsc.get(o.nameRsc) || 'a piece of gear');
            return false;
          });
        }
      }
    }

    const taken = [], refused = [];
    let wasCancelled = false;
    for (const n of brokenSkipped)
      refused.push({ item: n, why: 'BROKEN — the server says it has been shattered. It cannot be ' +
                                   'wielded or sold, and its name does not say so, which is why the ' +
                                   'fleet used to carry them for ever. Left on the floor.' });
    for (const n of cursedSkipped)
      refused.push({ item: n, why: 'CURSED — it equips itself, cannot be removed without an ' +
                                   'uncurse spell, and makes you easier to hit. Leave it.' });
    for (const o of cands) {
      if (cancelled()) { wasCancelled = true; break; }
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
        const walk = await this.walkTo(spot.col, spot.row, {
          maxSteps: Math.max(30, spot.steps + 10), movementGeneration, controlToken,
          beforeMutation: typeof beforeMutation === 'function'
            ? (packet, detail) => beforeMutation(packet, { ...detail, target_id: o.id })
            : null,
        });
        if (!walk.arrived) { refused.push({ id: o.id, name, why: walk.reason || 'could not get there' }); continue; }
      }
      if (cancelled()) { wasCancelled = true; break; }
      const before = c.evSeq;
      await this.pacer.submit('get', () => {
        if (typeof beforeMutation === 'function') beforeMutation('get', { target_id: o.id });
        return c.get(o.id);
      });
      const ev = await c.waitFor({ since: before, kinds: ['got', 'message', 'vanished'], timeoutMs: 3000 });
      const got = ev.events.find(e => e.kind === 'got');
      if (got) taken.push({ id: o.id, name, amount: o.amount || undefined });
      else refused.push({ id: o.id, name, why: ev.events.filter(e => e.text).map(e => e.text).join('; ') || 'no reply' });
    }
    if (!wasCancelled) {
      await this.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    }
    return { taken, refused,
             carrying: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })),
             ...(wasCancelled ? { cancelled: true,
               note: 'loot intent stopped before the next paced item action' } : {}) };
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
  // `onHop` IS A PAUSE POINT, NOT AN ABORT. It is awaited once per room, after arriving
  // and before choosing the next exit, and whatever it does the journey continues
  // afterwards.
  //
  // That asymmetry is the whole design and it is easy to get backwards. A journey is 3
  // rooms at the median and 10 at p90, and a character that gives up in the middle of one
  // is not safe — it is stranded in a worse room than either end, with the same walk still
  // to do and less health to do it with. Travel in this game is dangerous and there is no
  // version of it that is not; the only thing worth doing between rooms is stopping
  // somewhere defensible until you can go on. So the hook may take as long as it likes and
  // its return value is ignored: cancellation stays the caller's business, through
  // `cancelMovement`, which this loop already honours at the top of every iteration.
  //
  // It is awaited AFTER the arrival settle, so the room contents have landed and anything
  // deciding where to stand is looking at a room it can actually see.
  // ONE CALL IS THE WHOLE JOURNEY. `stumbles` is why.
  //
  // This used to return `arrived: false` the moment any single hop failed, which made a
  // cross-world trip a coin flip that the CALLER had to keep flipping — m59-supervise
  // wrapped it in three tries, and a run that did not (a rent errand, measured here) had
  // Clifford fail to reach a bank twice and Waldorf twice, from one attempt each, while
  // the identical call succeeded on the second or third go every time.
  //
  // The failures are transient and the route is RESUMABLE: each attempt re-plans from
  // wherever the character actually got to, so a retry continues the journey rather than
  // restarting it. "start is outside the room grid" is the classic one — the character
  // arrives at an edge, its coordinates read as off the grid for an instant, and the next
  // edge cannot be computed. Nothing is wrong; the position has not settled.
  //
  // So the retry belongs HERE, once, rather than in every caller — because a caller that
  // forgets it does not get a slower journey, it gets a character stranded halfway across
  // the world with the trip reported as finished.
  //
  // A STUMBLE IS NOT A HOP. They are counted separately so `maxHops` still means what it
  // says: re-settling in the same room must not eat the budget for crossing rooms, or a
  // long trip through one sticky doorway would run out of journey before it ran out of
  // patience.
  async travel(toRoomNum, {
    maxHops = 25,
    maxStumbles = 6,
    movementGeneration = this.movementGeneration,
    controlToken,
    onHop = null,
  } = {}) {
    const log = [];
    // TIME EXPOSED, PER MAP. See m59-transits.mjs for why this is the number worth having
    // and why "damage taken in transit" is not: there is no safe travel in this game and
    // there is not meant to be. Every second inside a map is a second something can reach
    // you, so the crossing time is the part we actually control.
    //
    // The clock starts here rather than at the first hop, because "told to travel" to
    // "out of the first room" is time in the room exactly like any other.
    const journeyId = `${this.name}-${Date.now().toString(36)}`;
    let enteredAt = Date.now();
    let hops = 0, stumbles = 0, totalStumbles = 0;

    // Let the position settle and the room re-publish itself, then try again from
    // wherever we actually are. Returns false when the patience is spent.
    //
    // TWO COUNTERS, because they answer different questions. `stumbles` is CONSECUTIVE and
    // is the patience budget — it resets on every real hop, so one sticky doorway early on
    // must not shorten the patience available to a sticky doorway later. `totalStumbles` is
    // the whole journey's, and is what gets reported: a trip that arrived after eleven
    // retries arrived, but it is not the same event as one that walked straight there, and
    // a report that reset to zero on success could not tell them apart.
    const stumble = async (why) => {
      totalStumbles++;
      if (++stumbles > maxStumbles) return false;
      log.push({ stumble: stumbles, at: this.world.room?.name ?? null, reason: why,
                 note: 're-reading the room and re-planning from here' });
      await this.pacer.submit('read', () => this.client.roomContents()).catch(() => null);
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => null);
      return true;
    };

    while (hops < maxHops) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      const here = this.world.room;
      // NOT A DEAD END — the coordinates have not settled yet. This is the same instant
      // that produces "start is outside the room grid", and it clears on its own.
      if (!here) {
        if (await stumble('current room is not in the graph')) continue;
        return { arrived: false, log, reason: 'current room is not in the graph', stumbles: totalStumbles };
      }
      if (here.num === toRoomNum)
        return { arrived: true, room: { num: here.num, name: here.name }, hops, stumbles: totalStumbles, log };

      const route = this.world.route(toRoomNum);
      if (!route.found) {
        // A route failure right after an arrival is the transient one. A route failure
        // that survives re-reading the room is real, and is reported as it always was.
        if (await stumble(route.reason || 'no route')) continue;
        return { arrived: false, log, reason: route.reason || 'no route', stumbles: totalStumbles };
      }
      const nextHop = route.hops[0];

      // A room often publishes SEVERAL squares for the same doorway — the Royal
      // Bank of Jasper lists two, and the first has a brazier standing on it.
      // Taking whichever came first in the file is a coin flip, so try them all.
      // MATCH ON THE DESTINATION, NOT ON THE KIND.
      //
      // Requiring e.kind === nextHop.kind threw away every working way out. Cor Noth
      // publishes THREE exits to room 574: one declared `edge`/west with
      // reachable:false and stand_on:null, and two more at row 1 — the north boundary —
      // both reachable with real squares. The route planner names the west one, the
      // kind filter then discarded the two that work, and the hop failed with "no floor
      // anywhere on the west boundary" about a room with two usable doors to that
      // destination. It stranded every donor in that town for hours, and read as a
      // sealed area rather than as a bad pick.
      //
      // A room's several ways to the same place are alternatives, not different
      // journeys. Take them all and let orderExits choose — it already prefers
      // reachable ones and then the nearest.
      const candidates = this.world.exits().filter(e => e.to === nextHop.to);
      const exit = orderExits(candidates)[0];
      if (!exit)
      {
        // The exit list is republished on arrival, so an exit that is missing right now is
        // usually one we asked about too early.
        if (await stumble('cannot find the exit to ' + nextHop.to_name + ' from here')) continue;
        return { arrived: false, log, stumbles: totalStumbles,
                 reason: 'cannot find the exit to ' + nextHop.to_name + ' from here' };
      }

      // Split so the record can say whether the time went on DECIDING or on DOING. Above
      // this line is routing and exit selection; below it is the walk. If the tail turns
      // out to be in the gap between them, the fix is in the planner, not the legs.
      const walkBegan = Date.now();
      const r = await this.leaveViaAny(candidates, { movementGeneration, controlToken });
      // QUEUE THE GAP ON `this`, AND LET SOMETHING ELSE FILE IT.
      //
      // Three methods in this chain are lifted out of this file by text and evaluated —
      // validateFineTarget and queueValidatedMove by m59-collision-test, and `travel`
      // itself by m59-travel-test — so a module-scope call here is a ReferenceError in a
      // test rather than a runtime error, which is the good kind of caught but only if
      // somebody runs it. Pushing onto `this` needs nothing but the object we already
      // have; drainExitGaps() does the writing from outside the lifted region.
      (this.pendingExitGaps ??= []).push({
        room: here?.num ?? null,
        direction: r?.gap?.direction ?? r?.used_exit?.direction ?? null,
        left: !!r.left, reason: r.reason ?? null,
        believed: r?.gap?.believed ?? null,
        stood_on: r.stood_on ?? null,
        tried: (r.tried ?? []).slice(0, 8).map(t => ({ ...(t.stand_on ?? {}), why: t.why })),
      });
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
      const inRoomMs = Date.now() - enteredAt;
      log.push({ from: here.name, to: nextHop.to_name, via: exit.kind, ok: r.left,
                 stand_on: (r.used_exit ?? exit).stand_on,
                 // On the hop log too, so a caller reading a travel result sees where the
                 // time went without having to go to the transit book for it.
                 ms: inRoomMs,
                 ...(r.tried?.length ? { also_tried: r.tried } : {}),
                 ...(r.left ? {} : { reason: why }) });
      // RECORDED WHETHER OR NOT IT WORKED, and the failures are the ones worth having:
      // a hop that spent two minutes being refused by ten exit squares in turn is the
      // shape this is looking for, and it is invisible in a journey-level timing.
      this.noteTransit({
        room: here.num, roomName: here.name, to: nextHop.to, toName: nextHop.to_name,
        ms: inRoomMs, walkMs: Date.now() - walkBegan, ok: r.left,
        // The one that worked plus the ones that did not. Above 1 means squares are being
        // refused, which is the suspicion this exists to confirm or kill.
        tried: (r.tried?.length ?? 0) + 1,
        reason: r.left ? null : why,
        journey: journeyId, hop: hops, destination: toRoomNum,
      });
      // A REFUSED DOORWAY IS THE ORDINARY CASE, NOT THE END OF THE JOURNEY. leaveViaAny has
      // already tried every square this room publishes for that destination; re-settling and
      // re-planning is what turns the second attempt into the one that works.
      if (!r.left) {
        if (await stumble(why)) continue;
        return { arrived: false, log, reason: why, stumbles: totalStumbles };
      }
      hops++;
      stumbles = 0;                      // it moved; the patience is for the NEXT sticky room

      // Arriving brings a fresh BP_PLAYER, and with it the identity the world model
      // needs; give the room contents a moment to land as well.
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      await this.pacer.submit('read', () => this.client.roomContents());
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });

      // THE PAUSE POINT. One per room, with the room already visible.
      //
      // A p90 journey is ten of these, so this is the difference between one 87-second
      // await nothing can reach into and ten 9-second ones with a decision between each.
      // Whatever it does, we carry on afterwards — see the note on `onHop` above for why
      // stopping in the middle is not the safer option it looks like.
      //
      // It cannot break the journey by throwing, either. A hook that fails is a hook with
      // a bug in it, and a character halfway between two towns is the worst possible place
      // to discover one; the failure is logged against the hop and the walk continues.
      if (onHop) {
        const room = this.world.room;
        try {
          await onHop({
            room: room ? { num: room.num, name: room.name } : null,
            hop: hops, hops_done: hops, destination: toRoomNum,
            remaining: Math.max(0, (this.world.route(toRoomNum)?.hops?.length ?? 0)),
            journey: journeyId,
          });
        } catch (e) {
          log.push({ from: room?.name ?? null, onhop_failed: e.message,
                     note: 'the between-rooms hook threw; the journey carried on regardless' });
        }
        // The hook can take minutes — holding a wall until health comes back is the whole
        // point of it — so re-check cancellation before committing to another room rather
        // than trusting the check at the top of the next iteration to be soon enough.
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return this.cancelledMovement({ log });
      }

      // The next room's clock starts once we have actually landed and can see. The settle
      // above is charged to arriving, not to the room we just left — otherwise every
      // room's time would carry the previous one's tail and the worst room would always
      // look like whichever came after the real problem.
      //
      // AND AFTER THE HOOK, not before it: a hold at a wall is time spent in the room we
      // are standing in, but it is not time the ROUTE cost, and charging it to the room
      // would make every room a character rested in look like the slowest map in the game.
      enteredAt = Date.now();
    }
    // CHECK ARRIVAL ONE LAST TIME. The destination test lives at the TOP of the loop, so a
    // journey whose final hop is also its last permitted hop leaves the loop standing in
    // the right room and reported "gave up" — the one failure mode that is both wrong and
    // reassuringly plausible, since the hop count really had been spent.
    const finally_ = this.world.room;
    if (finally_ && finally_.num === toRoomNum)
      return { arrived: true, room: { num: finally_.num, name: finally_.name },
               hops, stumbles: totalStumbles, log };
    return { arrived: false, log, stumbles: totalStumbles,
             reason: 'gave up after ' + maxHops + ' hops' };
  }
}

export { Session, Recorder, Pacer, readAbilitiesOnce, loadMonsterLevels, monsterKarmaByName, monsterLevelByName, arrivalReport, orderExits };
