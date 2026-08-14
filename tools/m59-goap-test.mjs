#!/usr/bin/env node
// m59-goap-test.mjs -- offline tests for the GOAP planner.
//
// Runs against the in-memory planner API exported by m59-goap.mjs. Does NOT
// import m59-broker.mjs and does NOT contact a live broker: fleet state is
// supplied as plain objects, and the action library is either the production
// one or a tiny synthetic one we build inline for the cost-ordering case.
//
// Run with:   node tools/m59-goap-test.mjs
// Expects:    prints one PASS/FAIL line per test, a summary, and exits 0 only
//             when every test passes.

import {
  deriveWorldState,
  buildActionLibrary,
  planAction,
  compileExpr,
} from './m59-goap.mjs';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;
const _failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    _passed++;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    _failed++;
    _failures.push(name);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// Test fixtures -- plain-object fleet rows. Each row is shaped like the
// /fleet endpoint would return for one character, but no broker is consulted.
// ---------------------------------------------------------------------------

const NO_GOALS = {};

function makeRow(overrides = {}) {
  return {
    character: 'Kage',
    agent:     'Kage',
    in_game:   true,
    room_num:  12,
    assigned_room: 14,
    health:    '40/50',
    level:     50,
    keeper_running: true,
    stalled:   false,
    busy:      false,
    parked:    false,
    committed: false,
    faculties: { attack: 'keeper', defense: 'keeper', movement: 'keeper' },
    policy: {
      purpose:    'advance',
      hunt:       'giant rat',
      goals:      [{ kind: 'hp' }],
      assignedRoom: 14,
      mode:       'hunt',
    },
    yield_check: { paying: true },
    ...overrides,
  };
}

function rowStalledWrongRoom() {
  return makeRow({
    stalled: { since_seconds: 400, ms_since_moved: 400000 },
    room_num: 12,
    assigned_room: 14,
  });
}

function rowVitalsUnknownWrongRoom() {
  return makeRow({
    health: null,
    room_num: 12,
    assigned_room: 14,
  });
}

function rowHappyPath() {
  return makeRow({
    room_num: 14,                       // already at assigned room
    assigned_room: 14,
    stalled: false,
    health: '50/50',
  });
}

function rowPurposeUnset() {
  return makeRow({
    policy: { purpose: null, hunt: 'giant rat', goals: [{ kind: 'hp' }] },
    room_num: 14,
    assigned_room: 14,
  });
}

// ---------------------------------------------------------------------------
// Test 1: stalled + wrong room -> stop_and_travel
// ---------------------------------------------------------------------------

test('stalled_triggers_stop_and_travel', () => {
  const state = deriveWorldState(rowStalledWrongRoom());
  const lib   = buildActionLibrary();
  const plan  = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action');
  assertEq(plan.action.name, 'stop_and_travel',
    'expected stop_and_travel for stalled character in wrong room');
});

// ---------------------------------------------------------------------------
// Test 2: vitals unknown + wrong room -> stop_and_travel
// ---------------------------------------------------------------------------

test('vitals_unknown_triggers_stop_and_travel', () => {
  const state = deriveWorldState(rowVitalsUnknownWrongRoom());
  const lib   = buildActionLibrary();
  const plan  = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action');
  assertEq(plan.action.name, 'stop_and_travel',
    'expected stop_and_travel when health is null and assigned room differs');
});

// ---------------------------------------------------------------------------
// Test 3: in assigned room, paying prey, purpose+goals set -> empty plan
// ---------------------------------------------------------------------------

test('correct_room_paying_prey_no_action', () => {
  const state = deriveWorldState(rowHappyPath());
  const lib   = buildActionLibrary();
  const plan  = planAction(state, NO_GOALS, lib);
  assertEq(plan, null,
    'happy-path character should produce no action');
});

// ---------------------------------------------------------------------------
// Test 4: applying stop_and_travel's effect removes its own precondition
// (no infinite loop). We hand-simulate the world-state change the action
// would produce and re-run the precondition.
// ---------------------------------------------------------------------------

test('no_infinite_loop', () => {
  const row    = rowStalledWrongRoom();
  const state  = deriveWorldState(row);
  const lib    = buildActionLibrary();
  const action = lib.find(a => a.name === 'stop_and_travel');
  assert(action, 'stop_and_travel should exist in library');

  // Sanity: the precondition is true on the original state.
  assertEq(action.preFn(state), true,
    'precondition should be true before the action runs');

  // Simulate the effect: character relocates to assigned_room and vitals
  // become readable once they arrive. Build the post-state and re-check.
  const post = { ...state, room: state.assignedRoom, health: 50, healthMax: 50,
                 stalled: false, stalledSeconds: null };
  assertEq(action.preFn(post), false,
    'precondition should be false after stop_and_travel lands the character');
});

// ---------------------------------------------------------------------------
// Test 5: purpose=null -> set_purpose
// ---------------------------------------------------------------------------

test('purpose_unset_triggers_set_purpose', () => {
  const state = deriveWorldState(rowPurposeUnset());
  const lib   = buildActionLibrary();
  const plan  = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action for unset purpose');
  assertEq(plan.action.name, 'set_purpose',
    'expected set_purpose when purpose is null');
});

// ---------------------------------------------------------------------------
// Test 6: when two actions are both applicable, the cheaper one wins.
// We build a synthetic library here so we control costs directly, rather
// than relying on the production numbers.
// ---------------------------------------------------------------------------

test('action_cost_ordering', () => {
  // Synthetic library: both actions are applicable on the same state.
  const cheap = {
    name: 'cheap',
    cost: 1,
    pre:  'true',
    effect: 'cheap',
    run: async () => ({}),
    preFn: compileExpr('true'),
  };
  const pricey = {
    name: 'pricey',
    cost: 5,
    pre:  'true',
    effect: 'pricey',
    run: async () => ({}),
    preFn: compileExpr('true'),
  };
  const lib   = [pricey, cheap];             // declaration order intentionally reversed
  const state = deriveWorldState(makeRow()); // any state will do
  const plan  = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should pick one of the two applicable actions');
  assertEq(plan.action.name, 'cheap',
    'planner should pick the lower-cost action regardless of declaration order');

  // Reverse the costs and confirm the planner follows.
  const lib2 = [{ ...cheap, cost: 9 }, { ...pricey, cost: 2 }];
  const plan2 = planAction(state, NO_GOALS, lib2);
  assertEq(plan2.action.name, 'pricey',
    'planner should switch to whichever action is now cheapest');
});

// ---------------------------------------------------------------------------
// Summary and exit code
// ---------------------------------------------------------------------------

const total = _passed + _failed;
console.log('');
console.log(`${_passed}/${total} passing`);
if (_failed > 0) {
  console.log(`FAILURES: ${_failures.join(', ')}`);
  process.exit(1);
}
process.exit(0);
