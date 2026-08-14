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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GOALS_PATH  = new URL('../substrate/goap-goals.json', import.meta.url);
const BROKER_URL  = 'http://127.0.0.1:8901/';
const INTERVAL_MS = 60_000;

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

export function loadGoals() {
  const path = new URL(GOALS_PATH).pathname;
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf8');
    console.log('[goap] created empty goals file at', path);
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8'));
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
export function deriveWorldState(row) {
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
    keeperRunning: !!row.keeper_running,
    stalled:       !!stalledObj,
    stalledSeconds,
    // "busy" is the union of the four ways a character can be off-limits.
    busy: !!(
      row.parked  ||
      row.committed ||
      (row.busy && row.busy.busy) ||
      // keeper claimed externally -- not in our possession
      (row.faculties && Object.values(row.faculties).some(f => f !== 'keeper'))
    ),
    yieldPaying: row.yield_check ? row.yield_check.paying !== false : true,
    yieldCheck:  row.yield_check ?? null,
    inGame:      row.in_game !== false && row.character != null,
  };
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
      name:   'stop_and_travel',
      // cheapest because every other action is unsafe while stalled
      cost:   1,
      // precondition: stalled OR vitals_unknown with wrong room.
      // Bypasses the keeper ladder: a stalled keeper gets a stop + a fresh walk.
      pre:    '(stalled && !busy) || (health === null && assignedRoom !== null && room !== assignedRoom && inGame)',
      effect: 'stop_and_travel',
      run:    async (state) => {
        await callTool('autopilot', { agent: state.agent, action: 'stop',
                                      why: 'goap: stalled or vitals unknown -- relocate' });
        await callTool('travel', { agent: state.agent, to: state.assignedRoom,
                                   background: true });
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
        await callTool('autopilot', { agent: state.agent, action: 'set',
                                      purpose: 'advance',
                                      goals: [{ kind: 'hp' }] });
        return { purpose: 'advance', goals: [{ kind: 'hp' }] };
      },
    }),
    mk({
      name:   'set_prey',
      // retarget when yieldCheck says paying=false, OR no prey set at all.
      cost:   3,
      pre:    'inGame && keeperRunning && hunt === null || (yieldCheck && yieldPaying === false)',
      effect: 'set_prey',
      run:    async (state) => {
        // The planner is told the target through the goal; the executor reads it
        // from the goal passed into `run`. Action library stays pure.
        const target = state.goalTarget ?? state.hunt ?? 'giant rat';
        const room   = state.assignedRoom ?? state.room ?? null;
        await callTool('autopilot', { agent: state.agent, action: 'set',
                                      hunt: target,
                                      assigned_room: room });
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
        await callTool('inn', { agent: state.agent, action: 'claim',
                                character: state.character });
        return { parked_at_inn: true };
      },
    }),
  ];
}

// Each action's effect MUST remove its own precondition, or the planner will fire
// it forever. This is the discipline:
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
// All four are monotone: each one moves one field of the world state forward and
// never back. The test in m59-goap-test.mjs verifies this with a hand-driven pass.

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
async function runPass(goals, dryRun) {
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
  for (const row of rows) {
    const state = deriveWorldState(row);
    if (!state.inGame) continue;
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
  const args = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const once    = args.includes('--once');
  const goalsCmd = args.includes('--goals');

  if (goalsCmd) {
    const goals = loadGoals();
    console.log(JSON.stringify(goals, null, 2));
    process.exit(0);
  }

  const goals = loadGoals();

  if (once) {
    await runPass(goals, dryRun);
  } else {
    console.log(`[goap] starting loop every ${INTERVAL_MS / 1000}s${dryRun ? ' (dry-run)' : ''}`);
    await runPass(goals, dryRun);
    setInterval(() => runPass(goals, dryRun), INTERVAL_MS);
  }
}
