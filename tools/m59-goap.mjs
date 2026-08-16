#!/usr/bin/env node
// m59-goap.mjs -- GOAP supervisor for the Meridian 59 fleet.
//
// The simple version (eval-condition, set-hunt) is gone. This file is now a proper
// Goal-Oriented Action Planner: a library of typed actions, per-character goals, a
// planner that finds the lowest-cost action path, and an executor that calls MCP
// tools on the running broker over HTTP.
//
// The planner is deliberately EXTERNAL: it never imports m59-broker.mjs or
// m59-autopilot.mjs. It reads fleet state from `broker.fleet()` over HTTP and issues
// its effects the same way -- by calling `autopilot` and `travel` MCP tools.
//
// What this buys:
//   - stop_and_travel: bypasses the keeper ladder. When a character is stalled (or its
//     vitals are unknown after a restart and it is in the wrong room), the planner
//     stops the keeper and walks the character to its assigned_room in the background.
//   - set_prey: retargets when yieldCheck would return paying=false.
//   - set_purpose: ensures purpose+goals are set when null.
//   - rest_in_inn: claims an inn room when health is critically low and none is held.
//
// The action library is exported (buildActionLibrary) so the test can run the planner
// against fixture states without touching the broker.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  brokerDriver, relocateThenRevive, runAtomic, innDest,
} from './m59-atomics.mjs';

const HERE         = dirname(fileURLToPath(import.meta.url));
const LOADOUT_DIR  = join(HERE, '..', 'substrate', 'loadouts');

// Inn rooms by city — nearest safe haven for a hurt character.
const CITY_INNS = { Tos: 52, Barloque: 106, Cornoth: 153, Marion: 202, Jasper: 370, Kocatan: 2001 };
const INN_ROOMS = new Set(Object.values(CITY_INNS));

const GOALS_PATH          = new URL('../substrate/goap-goals.json', import.meta.url);
const NEEDS_OPERATOR_PATH = join(HERE, '..', 'substrate', 'needs-operator.json');
const BROKER_URL  = 'http://127.0.0.1:8901/';
const INTERVAL_MS = 60_000;

// Per-agent cooldowns (action name -> Map<agent, cooldown_until_ms>). Prevents
// re-firing an action while a spawned subprocess errand is still in-flight.
const _cooldowns = new Map();
function setCooldown(action, agent, durationMs) {
  if (!_cooldowns.has(action)) _cooldowns.set(action, new Map());
  _cooldowns.get(action).set(agent, Date.now() + durationMs);
}
function onCooldown(action, agent) {
  const until = _cooldowns.get(action)?.get(agent) ?? 0;
  return Date.now() < until;
}

// ============================================================================
// BROKER I/O -- HTTP only. No imports of broker or autopilot modules.
// ============================================================================

let _id = 0;
export async function callTool(name, args = {}) {
  const r = await fetch(BROKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// The broker driver for the atomic layer -- one HTTP implementation, shared
// with m59-atomics.mjs. GOAP actions delegate their mechanical tool calls to
// runAtomic / relocateThenRevive; this driver is the mechanism that reaches the
// broker. Planning decisions (which prey, which room) stay in the actions.
const _ctx = brokerDriver(BROKER_URL, callTool);

async function fetchFleet() {
  const data = await callTool('fleet', {});
  return data?.fleet ?? [];
}

// ============================================================================
// GOALS FILE
// ============================================================================

// substrate/goap-goals.json holds one entry per character:
//   { "Kage": [ { kind:"advance", target:"zombie", priority: 10 }, ... ] }
// A `kind` is `advance` (level the character) or `equip` (gear them). `target` is
// either a creature name (for advance) or an item (for equip). `priority` is a
// positive integer; the planner picks the highest-priority unsatisfied goal first.

let _goalsMtime = 0;
let _goalsCache = {};
export function loadGoals() {
  const path = new URL(GOALS_PATH).pathname;
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf8');
    console.log('[goap] created empty goals file at', path);
    _goalsMtime = Date.now();
    return (_goalsCache = {});
  }
  const mtime = statSync(path).mtimeMs;
  if (mtime === _goalsMtime) return _goalsCache;
  _goalsMtime = mtime;
  return (_goalsCache = JSON.parse(readFileSync(path, 'utf8')));
}

// ============================================================================
// WORLD STATE -- derived from a /fleet row. Every precondition reads from here.
// ============================================================================

// The planner never touches the broker; everything it needs is on the row.
//   assigned_room / room_num   -- location targets vs current
//   health                     -- "value/max" string, or null when vitals are unknown
//   stalled                    -- broker's own computation (idle_pass >= 5)
//   parked / committed / busy  -- "is this character doing something else right now"
//   policy                     -- { hunt, purpose, goals, assignedRoom, mode }
//   yield_check                -- what the keeper thinks of the current prey/purpose
//   level                      -- max health == level in Meridian 59
//   keeper_running             -- false when no autopilot has ever been started
export function deriveWorldState(row, fleetNames = new Set()) {
  const policy = row.policy ?? {};
  const healthStr = row.health;                  // "42/50" or null
  const healthCurrent = healthStr ? Number(healthStr.split('/')[0]) : null;
  const healthMax     = healthStr ? Number(healthStr.split('/')[1]) : healthStr;
  const stalledObj    = row.stalled && row.stalled !== false ? row.stalled : null;
  // stalledSince carries ms since stall began when the broker publishes the object
  // form; older rows publish `stalled === false` or `'not in game'`.
  const stalledSeconds = stalledObj?.since_seconds ?? null;
  return {
    character:     row.character ?? row.agent ?? null,
    agent:         row.agent ?? null,
    level:         row.level ?? null,
    room:          row.room_num ?? null,
    assignedRoom:  row.assigned_room ?? null,
    health:        healthCurrent,                 // null means vitals unknown
    healthMax,
    hunt:          policy.hunt ?? null,
    mode:          row.mode ?? policy.mode ?? null,
    purpose:       policy.purpose ?? null,
    goals:         policy.goals ?? null,
    keeperRunning: !!(row.autopilot?.running ?? row.keeper_running),
    // The fleet row does NOT publish an `inert` field: its `autopilot` is a deliberate
    // subset (mode/running/kills/hunt). The keeper's inert state surfaces instead as
    // `committed.kind === 'driven'` (describeCommitment returns 'driven' exactly when
    // inert is set) and as the activity string "inert -- <why>". Without this the
    // revive_inert action could never fire on a live fleet.
    inert: !!((row.autopilot?.inert ?? row.inert) ||
              (row.committed?.kind === 'driven') ||
              (typeof row.activity === 'string' && row.activity.startsWith('inert'))),
    // Why the keeper is inert, when it is: the 'driven' commitment's label is the inert
    // reason, and the activity string is "inert -- <why>". Used to tell a post-restart
    // inert (revive fixes it) from an unarmed inert (revive just re-inerts -- it needs
    // a weapon, so send_to_town_for_gear must handle it instead).
    inertWhy: (row.committed?.kind === 'driven'
               ? (row.committed?.label ?? null) : null) ||
              (typeof row.activity === 'string' && row.activity.startsWith('inert')
               ? row.activity.replace(/^inert\s*--?\s*/, '') : null),
    // Which commitment, if any: 'errand' | 'parked' | 'partner' | 'bot' | 'driven' | null.
    // 'driven' IS the inert keeper (awake, not steering) and is not a real operation.
    committedKind: row.committed?.kind ?? null,
    stalled:       !!stalledObj,
    stalledSeconds,
    stalledWhy:    stalledObj?.why ?? null,
    hasWeapon:     !!(row.has_weapon),
    unarmedStall:  !!(stalledObj && stalledObj.why && stalledObj.why.startsWith('unarmed')),
    // Specific stall reasons — each drives a targeted GOAP action.
    stallRoomCapped:    !!(stalledObj?.why?.includes('room capped')),
    stallNoSafeWall:    !!(stalledObj?.why?.includes('no safe wall')),
    stallTrapped:       !!(stalledObj?.why?.includes('trapped')),
    stallBagsFull:      !!(stalledObj?.why?.includes('bags full')),
    stallCannotReach:   !!(stalledObj?.why?.includes('cannot reach anywhere')),
    stallRoamLimit:     !!(stalledObj?.why?.includes('roam limit')),
    stallTooHurt:       !!(stalledObj?.why?.includes('too hurt to fight')),
    // "busy" is the union of the four ways a character can be off-limits.
    busy: !!(
      row.parked  ||
      row.committed ||
      (row.busy && row.busy.busy) ||
      // keeper claimed externally -- not in our possession
      (row.faculties && Object.values(row.faculties).some(f => f !== 'keeper'))
    ),
    yieldPaying:   row.yield_check ? row.yield_check.paying !== false : true,
    yieldCheck:    row.yield_check ?? null,
    // "busyErrand" -- busy from a REAL operation, as opposed to the inert-driven state.
    // committed.kind === 'driven' is the inert keeper (awake, not steering), which is
    // not an errand and must not block revive_inert; parked/busy.busy/errand-kind and
    // an external faculty claim are real and do block it.
    busyErrand: !!(
      row.parked ||
      (row.busy && row.busy.busy) ||
      (row.faculties && Object.values(row.faculties).some(f => f !== 'keeper')) ||
      (row.committed?.kind != null && row.committed?.kind !== 'driven')
    ),
    inGame:        row.character != null && row.activity != null,
    parked_at_inn: !!(row.parked && row.parked_room != null),
    inn_room:      INN_ROOMS.has(row.room_num),
    // Skill purchasing: cost of next planned skill, null when none queued.
    // We pass an empty known-set and rely on the tool itself to skip already-owned
    // skills — the queue is ordered and the tool re-checks after each purchase.
    nextSkillCost: nextPlannedSkillCost(row.character ?? row.agent, new Set()),
    totalFunds: (row.purse ?? 0) + (row.banked?.balance ?? 0),
    // True while the buy_next_skill action is cooling down after queuing an errand.
    learningCooldown: onCooldown('buy_next_skill', row.agent ?? null),
    // True while the send_to_town_for_gear action is cooling down after a trip.
    gearTripCooldown: onCooldown('gear_trip', row.agent ?? null),
    // Karma filter for this character — 'good', 'evil', 'neutral', or null.
    // Passed to the prey tool so retarget actions respect the alignment constraint.
    karma: policy.karma ?? null,
    // Names of all fleet characters — used to distinguish outsiders in the same room.
    fleetNames,
  };
}

// ============================================================================
// LOADOUT READER -- reads substrate/loadouts/<character>.json on mtime.
// Returns the cost in shillings of the next unlearned skill in the queue,
// or null when there is nothing planned or the file does not exist.
// Skill cost formula: 250 * 2^level  (level 1 = 500, level 2 = 1000, ...)
// ============================================================================

const _loadoutCache = new Map(); // character -> { mtime, data }

export function nextPlannedSkillCost(character, abilitiesKnown = new Set()) {
  const path = join(LOADOUT_DIR, `${character}.json`);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  const cached = _loadoutCache.get(character);
  let loadout;
  if (cached && cached.mtime === mtime) {
    loadout = cached.data;
  } else {
    try { loadout = JSON.parse(readFileSync(path, 'utf8')); }
    catch { return null; }
    _loadoutCache.set(character, { mtime, data: loadout });
  }
  const queue = loadout?.plan?.learning_queue ?? [];
  for (const entry of queue) {
    const key = `${entry.track} ${entry.level}`.toLowerCase();
    if (!abilitiesKnown.has(key)) {
      return 250 * Math.pow(2, entry.level);
    }
  }
  return null; // queue complete
}

// ============================================================================
// OPERATOR ESCALATION
// Writes/updates substrate/needs-operator.json — a map of character -> issue.
// The dashboard reads this file and flags it red. Cleared by the operator
// (delete the entry) or automatically when the character is no longer stalled.
// ============================================================================

function escalateToOperator(character, reason, detail = {}) {
  let current = {};
  if (existsSync(NEEDS_OPERATOR_PATH)) {
    try { current = JSON.parse(readFileSync(NEEDS_OPERATOR_PATH, 'utf8')); } catch { /* ok */ }
  }
  current[character] = {
    at: new Date().toISOString(),
    reason,
    ...detail,
  };
  writeFileSync(NEEDS_OPERATOR_PATH, JSON.stringify(current, null, 2), 'utf8');
  console.log(`[goap] ESCALATE ${character}: ${reason}`);
}

function clearEscalation(character) {
  if (!existsSync(NEEDS_OPERATOR_PATH)) return;
  try {
    const current = JSON.parse(readFileSync(NEEDS_OPERATOR_PATH, 'utf8'));
    if (!current[character]) return;
    delete current[character];
    writeFileSync(NEEDS_OPERATOR_PATH, JSON.stringify(current, null, 2), 'utf8');
  } catch { /* ok */ }
}

// ============================================================================
// PRECONDITION EVALUATOR -- each action and each goal declares a JS expression
// that reads from the world-state object above. The expression is compiled once
// and reused.
// ============================================================================

export function compileExpr(expr) {
  const fn = new Function('s', 'with (s) { return (' + expr + '); }');
  return (state) => {
    try { return Boolean(fn(state)); } catch { return false; }
  };
}

// ============================================================================
// ACTION LIBRARY
//
// Each action is:
//   name         -- string
//   cost         -- positive number, lower is preferred
//   pre          -- JS expression against the world state
//   effect       -- short string description, used for logs and cycle detection
//   run(state)   -- async, performs the action via MCP tools and returns the new
//                  state fragment to merge back into the planner's view
//
// The library is data: the planner never imports it as code, only reads it.
// ============================================================================

// We pre-compile the preconditions so the planner runs them cheaply on every pass.
// A character cycle is impossible by construction: stop_and_travel sets
// `vitalsKnown: true` in its effect (vitals will be readable once it lands), and
// `not_stalled` excludes characters the broker already considers working. The only
// way to loop would be an action whose effect does not weaken its own precondition,
// and that is part of the discipline below.
export function buildActionLibrary() {
  const mk = (action) => ({ ...action, preFn: compileExpr(action.pre) });
  return [
    mk({
      name:   'revive_inert',
      // Fires when the keeper loop is running but the keeper is in the inert state —
      // the typical result of a broker restart or a stop that was never followed by a
      // revive. Cost 0 so it wins over everything else when applicable.
      // Excluded: an inert keeper whose reason is "unarmed" -- reviving it just makes it
      // re-inert the moment it resumes (it wants a weapon it does not have), so this
      // would loop every pass. That case belongs to send_to_town_for_gear instead.
      cost:   0,
      pre:    'inGame && keeperRunning && inert && !busyErrand && !(inertWhy && inertWhy.startsWith("unarmed"))',
      effect: 'revive_inert',
      run:    async (state) => {
        await runAtomic('revive_keeper', _ctx, { agent: state.agent,
          why: 'goap: clearing inert state (post-restart or missed revive)' });
        console.log(`[goap] ${state.character} revive_inert: cleared`);
        return { note: 'revive_inert: keeper un-inerted' };
      },
    }),
    mk({
      name:   'stop_and_travel',
      // cheapest because every other action is unsafe while stalled
      cost:   1,
      // precondition: stalled OR vitals_unknown with wrong room.
      // Restarts the keeper in farm mode after travel so the character is not left inert.
      // !unarmedStall: if the character is unarmed, send_to_town_for_gear takes priority
      // (travelling to the assigned room while unarmed keeps the character unarmed there).
      pre:    '!unarmedStall && ((stalled && !busy && assignedRoom !== null && room !== assignedRoom) || (health === null && assignedRoom !== null && room !== assignedRoom && inGame))',
      effect: 'stop_and_travel',
      run:    async (state) => {
        // `autopilot stop` = goInert (soft stop — keeps the loop running but idle).
        // Travel, then revive to un-inert the keeper on arrival.
        const result = await relocateThenRevive(_ctx, {
          agent: state.agent, to: state.assignedRoom,
          stopWhy:  'goap: stalled or vitals unknown -- relocate',
          reviveWhy: 'goap: arrived at assigned room — resuming keeper',
        });
        console.log(`[goap] ${state.character} stop_and_travel: arrived=${result?.arrived} room=${state.assignedRoom}`);
        return { note: `stop_and_travel to room ${state.assignedRoom}` };
      },
    }),
    mk({
      name:   'set_purpose',
      // fires when purpose or goals are missing entirely.
      cost:   2,
      pre:    'inGame && keeperRunning && purpose !== "advance" && purpose !== "equip"',
      effect: 'set_purpose',
      run:    async (state) => {
        await runAtomic('set_policy', _ctx, { agent: state.agent,
          fields: { purpose: 'advance', goals: [{ kind: 'hp' }] } });
        return { purpose: 'advance', goals: [{ kind: 'hp' }] };
      },
    }),
    mk({
      name:   'set_prey',
      // retarget when yieldCheck says paying=false, OR no prey set at all.
      cost:   3,
      pre:    'inGame && keeperRunning && (hunt === null || (yieldCheck && yieldPaying === false))',
      effect: 'set_prey',
      run:    async (state) => {
        // The planner is told the target through the goal; the executor reads it
        // from the goal passed into `run`. Action library stays pure.
        const target = state.goalTarget ?? state.hunt ?? 'giant rat';
        const room   = state.assignedRoom ?? state.room ?? null;
        await runAtomic('set_policy', _ctx, { agent: state.agent,
          fields: { hunt: target, assigned_room: room } });
        return { hunt: target };
      },
    }),
    mk({
      name:   'rest_in_inn',
      // only when health is critically low AND the character is not already parked
      // in a town (no inn claimed == nothing is being done about it).
      cost:   5,
      pre:    'inGame && health !== null && healthMax !== null && healthMax > 0 && ' +
              '(health / healthMax) < 0.35 && !parked_at_inn',
      effect: 'rest_in_inn',
      run:    async (state) => {
        // In the real fleet this would call `inn` (claim an inn room); the broker
        // exposes that tool. For the planner we record the intent.
        await runAtomic('claim_inn', _ctx, { agent: state.agent, character: state.character });
        return { parked_at_inn: true };
      },
    }),
    mk({
      name:   'retarget_on_stall',
      // Stalled, healthy, no assigned room (so stop_and_travel won't help), and the
      // current prey is theoretically paying — the problem is this room/spawn combo.
      // Pick the next best candidate from the prey tool and switch.
      cost:   6,
      pre:    'inGame && keeperRunning && stalled && !busy && assignedRoom === null && ' +
              'health !== null && healthMax !== null && (health / healthMax) >= 0.7',
      effect: 'retarget_on_stall',
      run:    async (state) => {
        const result = await runAtomic('pick_prey', _ctx, {
          agent: state.agent, goals: [{ kind: 'hp' }], karma: state.karma });
        const candidates = result?.candidates ?? [];
        // Pick the first candidate that differs from what we are already hunting.
        const next = candidates.find(c => c.creature !== state.hunt);
        if (!next) {
          console.log(`[goap] ${state.character} retarget_on_stall: no alternative prey found`);
          return null;
        }
        await runAtomic('set_policy', _ctx, { agent: state.agent,
          fields: { hunt: next.creature, assigned_room: next.best_room ?? null } });
        return { note: `retarget_on_stall: ${state.hunt} -> ${next.creature} room ${next.best_room}` };
      },
    }),
    mk({
      name:   'avoid_crowded_room',
      // Stalled, healthy, and a non-fleet player is in the same room competing for spawns.
      // The `who` tool is called inside run() to check — the precondition is cheap
      // (stalled + healthy + assignedRoom null) and the actual player check is deferred.
      // Cost 5: cheaper than retarget_on_stall (6) so crowding is tried first when stalled.
      cost:   5,
      pre:    'inGame && keeperRunning && stalled && !busy && assignedRoom === null && ' +
              'health !== null && healthMax !== null && (health / healthMax) >= 0.7',
      effect: 'avoid_crowded_room',
      run:    async (state) => {
        const whoResult = await runAtomic('who_in_room', _ctx, { agent: state.agent });
        const here = whoResult?.here ?? [];
        const outsiders = here.filter(p => !state.fleetNames.has(p.name));
        if (outsiders.length === 0) {
          // No outsiders — let retarget_on_stall handle it next pass.
          console.log(`[goap] ${state.character} avoid_crowded_room: no outsiders in room ${state.room}`);
          return null;
        }
        console.log(`[goap] ${state.character} avoid_crowded_room: ${outsiders.length} outsider(s) in room ${state.room}: ${outsiders.map(p => p.name).join(', ')}`);
        const result = await runAtomic('pick_prey', _ctx, {
          agent: state.agent, goals: [{ kind: 'hp' }], karma: state.karma });
        const candidates = result?.candidates ?? [];
        // Pick the first candidate in a DIFFERENT room from where we are now.
        const next = candidates.find(c => c.best_room != null && c.best_room !== state.room);
        if (!next) {
          console.log(`[goap] ${state.character} avoid_crowded_room: no alternative room found`);
          return null;
        }
        await runAtomic('set_policy', _ctx, { agent: state.agent,
          fields: { hunt: next.creature, assigned_room: next.best_room } });
        console.log(`[goap] ${state.character} avoid_crowded_room: ${state.hunt} room ${state.room} -> ${next.creature} room ${next.best_room}`);
        return { note: `avoid_crowded_room: moved to room ${next.best_room} (${outsiders.length} outsider(s) in ${state.room})` };
      },
    }),
    mk({
      name:   'retreat_to_inn',
      // Stalled AND hurt — the character needs to rest but has no assigned inn.
      // Travel to the nearest inn and rest up. Only fires when not already in an inn.
      cost:   3,  // cheaper than retarget — health is the priority
      pre:    'inGame && keeperRunning && stalled && !busy && ' +
              'health !== null && healthMax !== null && (health / healthMax) < 0.7 && ' +
              '!inn_room',
      effect: 'retreat_to_inn',
      run:    async (state) => {
        // Pick any inn — the travel tool will route to whichever is reachable.
        // Prefer Tos (52) when west of room 400, Jasper (370) when east.
        const dest = innDest(state.room);
        const result = await relocateThenRevive(_ctx, {
          agent: state.agent, to: dest,
          stopWhy:  'goap: hurt and stalled — retreating to inn',
          reviveWhy: 'goap: arrived at inn — resuming keeper to rest',
        });
        console.log(`[goap] ${state.character} retreat_to_inn: arrived=${result?.arrived} room=${dest}`);
        return { note: `retreat_to_inn: arrived at inn room ${dest}` };
      },
    }),
    mk({
      name:   'buy_next_skill',
      // Fires when the character has a skill plan and enough funds to buy the next level.
      // One purchase per pass is deliberate (matches the tool's own design): each buy
      // changes the learn-point calculation so the next level must be re-evaluated fresh.
      // A 5-minute cooldown (learningCooldown) prevents re-firing while the spawned
      // outfit subprocess runs — the subprocess does not set the broker `busy` flag.
      cost:   4,
      pre:    'inGame && keeperRunning && !busy && nextSkillCost !== null && totalFunds >= nextSkillCost && !learningCooldown',
      effect: 'buy_next_skill',
      run:    async (state) => {
        const result = await runAtomic('buy_skills', _ctx, { agents: [state.agent] });
        const row = result?.results?.[0];
        if (row?.queued) {
          setCooldown('buy_next_skill', state.agent, 5 * 60 * 1000);
          console.log(`[goap] ${state.character} buy_next_skill: queued ${row.ability} for ~${row.price}sh`);
        } else {
          // Not enough learn points yet — cool down for 5 min to avoid spamming
          // the log every 60s while waiting for the character to level.
          setCooldown('buy_next_skill', state.agent, 5 * 60 * 1000);
          console.log(`[goap] ${state.character} buy_next_skill: refused — ${row?.reason ?? 'unknown'}`);
        }
        return { note: `buy_next_skill: ${row?.queued ? `queued ${row.ability}` : row?.reason ?? 'refused'}` };
      },
    }),
    mk({
      name:   'send_to_town_for_gear',
      // Fires when the keeper is stalled because it is unarmed and has no food spell,
      // OR is inert for the same reason (an unarmed keeper re-inerts the moment it is
      // revived, so revive_inert deliberately steps aside and this is the only path to
      // arm it). The keeper's buyWeapons/buyFood flags will handle the purchase once it
      // reaches town — this just gets it there and un-inerts it so the town trip fires.
      // A 10-minute cooldown prevents looping if the town trip also fails.
      cost:   6,
      pre:    'inGame && keeperRunning && !gearTripCooldown && !busyErrand && ' +
              '(unarmedStall || (inert && inertWhy && inertWhy.startsWith("unarmed")))',
      effect: 'send_to_town_for_gear',
      run:    async (state) => {
        setCooldown('gear_trip', state.agent, 10 * 60 * 1000);
        // Pick the nearest town inn as destination.
        const dest = innDest(state.room ?? 0);
        console.log(`[goap] ${state.character} send_to_town_for_gear: unarmed stall — travelling to inn ${dest}`);
        const result = await relocateThenRevive(_ctx, {
          agent: state.agent, to: dest,
          stopWhy:  'goap: unarmed — sending to town to buy gear',
          reviveWhy: 'goap: arrived at town — keeper will buy gear on next pass',
        });
        console.log(`[goap] ${state.character} send_to_town_for_gear: arrived=${result?.arrived}`);
        return { note: `send_to_town_for_gear: travelled to inn ${dest}` };
      },
    }),
    mk({
      name:   'relocate_no_safe_wall',
      // No safe wall in this room and nowhere better to go. Clearing the assigned room
      // lets the keeper's own room-selection pick somewhere with a usable wall.
      // Requires assignedRoom !== null so the effect (clearing it) weakens the
      // precondition: when the assignment is already null there is nothing to clear and
      // the no-op would fire every pass -- and a hurt character in that state belongs
      // in retreat_to_inn, not in a useless clear.
      cost:   4,
      pre:    'inGame && keeperRunning && stallNoSafeWall && !busy && assignedRoom !== null',
      effect: 'relocate_no_safe_wall',
      run:    async (state) => {
        console.log(`[goap] ${state.character} relocate_no_safe_wall: room ${state.room} — clearing assignment`);
        await runAtomic('set_policy', _ctx, { agent: state.agent, fields: { assigned_room: null } });
        return { note: `relocate_no_safe_wall: cleared assigned_room ${state.room}` };
      },
    }),
    mk({
      name:   'leave_capped_room',
      // Stall: the assigned room is capped by creatures we will not fight (all spawns
      // above the engagement ceiling). Clearing the assignment lets the keeper's own
      // room-selection pick a room that actually generates huntable prey.
      // Same monotone guard as relocate_no_safe_wall: clear is only useful while
      // assignedRoom !== null, so require it to avoid a no-op loop.
      cost:   4,
      pre:    'inGame && keeperRunning && stallRoomCapped && !busy && assignedRoom !== null',
      effect: 'leave_capped_room',
      run:    async (state) => {
        console.log(`[goap] ${state.character} leave_capped_room: room ${state.room} capped — clearing assignment`);
        await runAtomic('set_policy', _ctx, { agent: state.agent, fields: { assigned_room: null } });
        return { note: `leave_capped_room: cleared assigned_room ${state.room}` };
      },
    }),
    mk({
      name:   'town_trip_bags_full',
      // Pack is full and the keeper could not make room (everything protected or needed).
      // Force a town trip to sell/bank and free up space.
      cost:   5,
      pre:    'inGame && keeperRunning && stallBagsFull && !busy && !gearTripCooldown',
      effect: 'town_trip_bags_full',
      run:    async (state) => {
        setCooldown('gear_trip', state.agent, 10 * 60 * 1000);
        const dest = innDest(state.room ?? 0);
        console.log(`[goap] ${state.character} town_trip_bags_full: bags full — travelling to inn ${dest}`);
        const result = await relocateThenRevive(_ctx, {
          agent: state.agent, to: dest,
          stopWhy:  'goap: bags full — sending to town to sell',
          reviveWhy: 'goap: arrived at town — keeper will sell on next pass',
        });
        console.log(`[goap] ${state.character} town_trip_bags_full: arrived=${result?.arrived}`);
        return { note: `town_trip_bags_full: travelled to inn ${dest}` };
      },
    }),
    mk({
      name:   'retarget_unreachable',
      // Cannot reach any room that generates the current prey, or roam limit hit with
      // nothing found. Pick new prey from where we are now.
      cost:   5,
      pre:    'inGame && keeperRunning && (stallCannotReach || stallRoamLimit) && !busy',
      effect: 'retarget_unreachable',
      run:    async (state) => {
        console.log(`[goap] ${state.character} retarget_unreachable: ${state.stalledWhy} — picking new prey`);
        const result = await runAtomic('pick_prey', _ctx, {
          agent: state.agent, goals: [{ kind: 'hp' }], karma: state.karma });
        const candidates = result?.candidates ?? [];
        const next = candidates.find(c => c.creature !== state.hunt);
        if (!next) {
          console.log(`[goap] ${state.character} retarget_unreachable: no alternative found`);
          return null;
        }
        await runAtomic('set_policy', _ctx, { agent: state.agent,
          fields: { hunt: next.creature, assigned_room: next.best_room ?? null } });
        return { note: `retarget_unreachable: ${state.hunt} -> ${next.creature} room ${next.best_room}` };
      },
    }),
    mk({
      name:   'rescue_trapped',
      // Trapped: cannot fight (no weapon/food), cannot rest (unsafe), cannot leave.
      // Best we can do is stop the keeper and travel to an inn to break the deadlock.
      cost:   3,
      pre:    'inGame && keeperRunning && (stallTrapped || stallTooHurt) && !busy && !inn_room',
      effect: 'rescue_trapped',
      run:    async (state) => {
        const dest = innDest(state.room ?? 0);
        console.log(`[goap] ${state.character} rescue_trapped: ${state.stalledWhy} — evacuating to inn ${dest}`);
        const result = await relocateThenRevive(_ctx, {
          agent: state.agent, to: dest,
          stopWhy:  'goap: trapped/too hurt — evacuating to inn',
          reviveWhy: 'goap: arrived at inn — keeper will rest',
        });
        console.log(`[goap] ${state.character} rescue_trapped: arrived=${result?.arrived}`);
        return { note: `rescue_trapped: travelled to inn ${dest}` };
      },
    }),
    mk({
      name:   'escalate_to_operator',
      // Last resort: stalled, healthy, no assigned room, and no alternative prey.
      // The planner has nothing left to try — flag it for a human.
      // Cost 7 — only wins when every cheaper action's precondition fails.
      cost:   7,
      pre:    'inGame && keeperRunning && stalled && stalledSeconds > 300 && !busy && ' +
              'assignedRoom === null && health !== null && healthMax !== null && ' +
              '(health / healthMax) >= 0.7 && !inn_room',
      effect: 'escalate_to_operator',
      run:    async (state) => {
        escalateToOperator(state.character, state.stalledWhy ?? 'stalled', {
          stalled_seconds: state.stalledSeconds,
          room: state.room,
          hunt: state.hunt,
        });
        return { note: 'escalated to operator' };
      },
    }),
    mk({
      name:   'leave_raza',
      // Raza rooms 1011-1018 have zero exits in the map graph — the router cannot
      // plan a path out and travel will return arrived:false indefinitely. The broker
      // exposes leave_raza which walks the character out through the known door sequence.
      // Gated on level >= 25 (the leave_raza tool's own threshold): Raza generates only
      // level-25 mummies, and advancement needs monster_level > base_max_health, so below
      // 25 the newbie zone is where the character belongs. A sub-25 character stalled in a
      // capped Raza room is handled by leave_capped_room instead — it stays in Raza and
      // clears the bad assignment rather than stranding a mummy-only hunter outside.
      cost:   0,   // lower than stop_and_travel: being in Raza is the worst situation
      pre:    'inGame && level !== null && level >= 25 && room !== null && room >= 1011 && room <= 1018',
      effect: 'leave_raza',
      run:    async (state) => {
        await runAtomic('leave_raza', _ctx, { agent: state.agent });
        return { note: `leave_raza from room ${state.room}` };
      },
    }),
  ];
}
// Each action's effect MUST remove its own precondition, or the planner will fire
// it forever. This is the discipline:
//   escalate_to_operator -- writes needs-operator.json; cleared by clearEscalation
//                     when the stall resolves (next passing pass). Does not loop
//                     because cheaper actions (retarget, retreat) have already
//                     failed their preconditions for this character.
//   retarget_on_stall-- effect sets hunt to a new creature; the stall clears on
//                     the next pass when the keeper moves to a new room. The
//                     precondition reads `hunt !== new_creature` implicitly because
//                     `next = candidates.find(c => c.creature !== state.hunt)`.
//   retreat_to_inn   -- effect is "character travelling to inn"; once there,
//                     `inn_room` becomes true so the precondition fails.
//   buy_next_skill   -- effect is "one skill purchased"; the queue advances so
//                     `nextSkillCost` returns the NEXT level's cost (or null when
//                     done), and `totalFunds` drops below the new cost. Both sides
//                     of the precondition change, so it cannot fire twice for the
//                     same level.
//   leave_raza       -- effect is "character is no longer in rooms 1011-1018"; once
//                     outside, room falls outside [1011,1018] and the pre fails.
//   stop_and_travel  -- effect is "character lands in assigned_room"; once landed,
//                     health is non-null and room === assignedRoom, so the
//                     precondition fails on the next pass.
//   set_purpose      -- effect sets purpose to 'advance', so the precondition
//                     `purpose !== 'advance'` fails on the next pass.
//   set_prey         -- effect sets hunt to the target; yieldCheck will re-evaluate
//                     against the new prey and either go paying:true (done) or
//                     keep returning paying:false only for the same reason.
//   rest_in_inn      -- effect sets parked_at_inn=true, so the precondition
//                     `!parked_at_inn` fails on the next pass.
//   relocate_no_safe_wall -- effect clears assigned_room; the precondition requires
//                     assignedRoom !== null, so the clear makes it fail on the next
//                     pass. The keeper's room-selection then picks a room with a wall.
//   leave_capped_room -- same clear-assignment shape as relocate_no_safe_wall; the
//                     room is capped by creatures we will not fight, and clearing
//                     the assignment makes the precondition fail on the next pass.
// All of the above are monotone: each one moves one field of the world state forward
// and never back. The test in m59-goap-test.mjs verifies this with a hand-driven pass.

// ============================================================================
// PLANNER -- forward search over the action library.
//
// With four actions and one pass per character, this is not classical STRIPS
// planning -- it is a "lowest-cost applicable action, applied once per pass".
// The reason it is structured as a planner rather than a chain of if/else:
//
//   - the action library is the canonical place where preconditions live
//   - new actions (heal, retarget, transfer-coin) join the same loop
//   - the loop guard against infinite cycles is one `applied` flag, and the test
//     exercises it explicitly
//
// We also layer goals on top: a per-character goal list ordered by priority picks
// the `target` field of the action (which prey to set, which item to equip).
// When no goal exists for a character, the planner still runs safety actions
// (stop_and_travel, rest_in_inn) but skips the strategic ones (set_prey).
// ============================================================================

// Convert a fleet row into the world state the planner reasons about. Exported so
// the test can drive it without touching the broker.
// (deriveWorldState is defined above and re-exported through the planner.)

// Pick the highest-priority goal for this character, if any.
export function selectGoal(goals, character) {
  const list = goals?.[character] ?? [];
  if (!Array.isArray(list) || list.length === 0) return null;
  // Highest priority first; ties broken by declaration order.
  const sorted = list
    .map((g, i) => ({ g, i, p: Number(g.priority ?? 10) }))
    .sort((a, b) => (b.p - a.p) || (a.i - b.i));
  return sorted[0]?.g ?? null;
}

// Decide which action to take. Returns the action object, or null when nothing
// is wrong (the happy path: a paying keeper in the right room does no work).
//
//   state          -- derived world state for one character
//   goals          -- full goals dict (char -> list)
//   library        -- action library from buildActionLibrary
//
// Returns: { action, goal, cost, reason } or null.
export function planAction(state, goals, library) {
  // Always consider the safety actions first; they have the lowest costs.
  // Among applicable actions, pick the lowest cost. Ties: declaration order.
  const goal = selectGoal(goals, state.character);
  const enriched = {
    ...state,
    parked_at_inn: !!state.parked_at_inn,
    goalTarget: goal?.target ?? null,
    goalKind: goal?.kind ?? null,
  };
  const applicable = library
    .filter(a => {
      try { return a.preFn(enriched); } catch { return false; }
    })
    .sort((a, b) => a.cost - b.cost);
  if (applicable.length === 0) return null;
  // Don't fire a strategic action when no goal declares a target for it.
  const action = applicable[0];
  if ((action.name === 'set_prey') && !goal?.target) return null;
  return { action, goal, cost: action.cost,
           reason: `precondition met for ${action.name}` };
}

// ============================================================================
// EXECUTOR -- runs one planned action via the broker MCP tools.
// ============================================================================

export async function executePlan(plan, state, dryRun) {
  if (!plan) return null;
  const { action } = plan;
  const label = `[goap] ${state.character} action=${action.name}`;
  if (dryRun) {
    console.log(`${label} (dry-run)`);
    return null;
  }
  console.log(label);
  try {
    const fragment = await action.run(state);
    return fragment;
  } catch (err) {
    console.error(`${label} failed: ${err.message}`);
    return null;
  }
}

// One full pass over the fleet: read fleet, plan per character, execute. Each
// character gets AT MOST one action per pass -- that is what makes the cycle
// guard cheap: even if all four actions were applicable, the world state after
// pass N+1 differs from pass N (every effect changes a field the precondition
// reads), so the planner either picks a different action or picks none.
async function runPass(dryRun) {
  const goals = loadGoals();
  let rows;
  try {
    rows = await fetchFleet();
  } catch (err) {
    console.error('[goap] cannot reach broker:', err.message);
    return;
  }
  if (rows.length === 0) {
    console.log('[goap] fleet returned no rows');
    return;
  }
  const library = buildActionLibrary();
  const fleetNames = new Set(rows.map(r => r.character).filter(Boolean));
  for (const row of rows) {
    const state = deriveWorldState(row, fleetNames);
    if (!state.inGame) continue;
    // Clear any prior escalation when the character is no longer stalled.
    if (!state.stalled && state.character) clearEscalation(state.character);
    const plan = planAction(state, goals, library);
    if (!plan) continue;
    await executePlan(plan, state, dryRun);
  }
}

// ============================================================================
// CLI -- only runs when this file is invoked directly (NOT when imported by a test).
// ============================================================================

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // One process per repo+fleet: the pid file is a hint, but a stale one from a crashed
  // run must not block the new one, and a LIVE one must.
  const pidPath = join(HERE, '..', 'substrate', `goap-${process.env.M59_FLEET || 'default'}.pid`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (existsSync(pidPath)) {
    let held = null;
    try { held = JSON.parse(readFileSync(pidPath, 'utf8')).pid; } catch { /* stale, take it */ }
    if (held && alive(held) && held !== process.pid) {
      console.error(`[goap] already running (pid ${held}, ${pidPath})`);
      process.exit(1);
    }
  }
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, at: Date.now() }, null, 2));
  const rmPid = () => { try { unlinkSync(pidPath); } catch { /* gone already */ } };
  // SIGTERM must EXIT, not just clean up: a handler that returns leaves the default
  // disposition, so the process would ignore the signal and the service's stop and
  // restart would time out on a process that was, from outside, perfectly alive.
  process.on('exit', rmPid);
  process.on('SIGTERM', () => { rmPid(); process.exit(0); });
  process.on('SIGINT', () => { rmPid(); process.exit(0); });
  // The loop must not die silently: a dead supervisor is the exact failure this pid
  // file exists to catch, so log the reason and exit loudly for whoever restarts it.
  process.on('uncaughtException', (e) => { console.error('[goap] uncaught:', e.stack || e); rmPid(); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error('[goap] unhandled rejection:', e); });
  const args = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const once    = args.includes('--once');
  const goalsCmd = args.includes('--goals');

  if (goalsCmd) {
    const goals = loadGoals();
    console.log(JSON.stringify(goals, null, 2));
    process.exit(0);
  }

  if (once) {
    await runPass(dryRun);
  } else {
    console.log(`[goap] starting loop every ${INTERVAL_MS / 1000}s${dryRun ? ' (dry-run)' : ''}`);
    const pass = async () => { try { await runPass(dryRun); } catch (e) { console.error('[goap] pass failed:', e.message); } };
    await pass();
    setInterval(pass, INTERVAL_MS);
  }
}
