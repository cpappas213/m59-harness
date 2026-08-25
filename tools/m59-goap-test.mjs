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
    // Real /fleet rows publish `activity` (ap.activity(), 'no keeper' when none) and
    // never publish `in_game` for in-game characters -- deriveWorldState reads
    // `row.character != null && row.activity != null` as the in-game test.
    activity:  'hunting giant rat',
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

function rowInRazaLevel(level) {
  return makeRow({
    level,
    room_num: 1016,       // in Raza, the Grand Museum / Mausoleum range
    assigned_room: null,
  });
}

// The fleet row omits `inert`; the keeper's inert state surfaces as
// committed.kind === 'driven' (describeCommitment returns 'driven' exactly when
// inert is set) and as activity "inert -- <why>".
function rowInertDriven() {
  return makeRow({
    activity: 'inert -- post-restart, keeper stopped without a reason',
    committed: { kind: 'driven', label: 'post-restart, keeper stopped without a reason' },
    health: '45/50',
  });
}

// A real errand in flight -- committed.kind 'errand' -- must NOT be revived.
function rowInertErrand() {
  return makeRow({
    activity: 'inert -- checking the crate',
    committed: { kind: 'errand', label: 'checking the crate' },
    health: '45/50',
  });
}

// An inert keeper whose reason is "unarmed": reviving just makes it re-inert, so
// revive_inert must step aside and send_to_town_for_gear must arm it instead.
function rowInertUnarmed() {
  return makeRow({
    activity: 'inert -- unarmed, does not know create weapon',
    committed: { kind: 'driven', label: 'unarmed, does not know create weapon' },
    has_weapon: false,
    health: '45/50',
  });
}

function rowCappedRoom() {
  return makeRow({
    stalled: { since_seconds: 300, why: 'room capped by creatures we will not fight', ms_since_moved: 300000 },
    room_num: 14,          // at the capped assigned room, so stop_and_travel cannot outbid
    assigned_room: 14,
    health: '45/50',
  });
}

// Stalled on "no safe wall" with no assigned room: there is nothing for
// relocate_no_safe_wall to clear, so it must step aside and let the keeper
// retarget instead.
function rowNoSafeWallUnassigned() {
  return makeRow({
    stalled: { since_seconds: 300, why: 'no safe wall here and nowhere better to go', ms_since_moved: 300000 },
    room_num: 12,
    assigned_room: null,
    health: '45/50',
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
// Test 7: capped-room stall -> leave_capped_room
// ---------------------------------------------------------------------------

test('capped_room_triggers_leave_capped_room', () => {
  const state = deriveWorldState(rowCappedRoom());
  const lib   = buildActionLibrary();
  const plan  = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action for a capped-room stall');
  assertEq(plan.action.name, 'leave_capped_room',
    'expected leave_capped_room when room is capped by creatures we will not fight');
});

// ---------------------------------------------------------------------------
// Test 8: leave_capped_room's effect removes its own precondition (no loop).
// Clearing assigned_room makes `assignedRoom !== null` fail on the next pass.
// ---------------------------------------------------------------------------

test('leave_capped_room_no_infinite_loop', () => {
  const state  = deriveWorldState(rowCappedRoom());
  const lib    = buildActionLibrary();
  const action = lib.find(a => a.name === 'leave_capped_room');
  assert(action, 'leave_capped_room should exist in library');

  assertEq(action.preFn(state), true,
    'precondition should be true before the action runs');

  // Simulate the effect: the assignment is cleared.
  const post = { ...state, assignedRoom: null };
  assertEq(action.preFn(post), false,
    'precondition should be false after assigned_room is cleared');
});

// ---------------------------------------------------------------------------
// Test 9: relocate_no_safe_wall refuses to fire when there is nothing to clear.
// With assigned_room already null, the no-op clear would loop, so the guard must
// keep it off the table. (Which cheaper action wins instead -- avoid_crowded_room
// at 5, then retarget_on_stall at 6 -- is the designed escalation.)
// ---------------------------------------------------------------------------

test('relocate_no_safe_wall_requires_an_assignment', () => {
  const state  = deriveWorldState(rowNoSafeWallUnassigned());
  const lib    = buildActionLibrary();
  const action = lib.find(a => a.name === 'relocate_no_safe_wall');
  assert(action, 'relocate_no_safe_wall should exist in library');

  assertEq(action.preFn(state), false,
    'relocate_no_safe_wall must not fire when assigned_room is already null');

  // The planner picks a cheaper applicable action instead.
  const plan = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should still produce an action');
  assert(plan.action.name !== 'relocate_no_safe_wall',
    'relocate_no_safe_wall should not be chosen');
});

// ---------------------------------------------------------------------------
// Test 10: leave_raza is gated on level >= 25. Raza generates only level-25
// mummies, and advancement needs monster_level > base_max_health, so below 25
// the newbie zone is where the character belongs -- the tool's own threshold.
// ---------------------------------------------------------------------------

test('leave_raza_gated_on_level', () => {
  const lib  = buildActionLibrary();
  const raza = lib.find(a => a.name === 'leave_raza');
  assert(raza, 'leave_raza should exist in library');

  const low  = deriveWorldState(rowInRazaLevel(24));
  assertEq(raza.preFn(low), false,
    'leave_raza must not fire below level 25');

  const high = deriveWorldState(rowInRazaLevel(50));
  assertEq(raza.preFn(high), true,
    'leave_raza should fire at level 25+');
});

// ---------------------------------------------------------------------------
// Test 11: revive_inert detects the inert keeper from committed.kind === 'driven'
// (the fleet row omits `inert`), and fires despite the inert-driven busy. A real
// errand (committed.kind 'errand') is NOT revived.
// ---------------------------------------------------------------------------

test('revive_inert_fires_on_driven_committed', () => {
  const lib = buildActionLibrary();
  const state = deriveWorldState(rowInertDriven());
  assertEq(state.inert, true, 'inert should be true from committed.kind driven');
  const plan = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action');
  assertEq(plan.action.name, 'revive_inert',
    'an inert-driven keeper should be revived');
});

test('revive_inert_skips_real_errand', () => {
  const lib = buildActionLibrary();
  const state = deriveWorldState(rowInertErrand());
  assertEq(state.inert, true, 'inert is true while an errand is driving');
  const raza = lib.find(a => a.name === 'revive_inert');
  assertEq(raza.preFn(state), false,
    'revive_inert must not fire while a real errand is in flight');
});

// ---------------------------------------------------------------------------
// Test 12: an inert keeper whose reason is unarmed must NOT be revived (reviving
// just makes it re-inert) -- send_to_town_for_gear arms it instead.
// ---------------------------------------------------------------------------

test('unarmed_inert_goes_to_gear_not_revive', () => {
  const lib = buildActionLibrary();
  const state = deriveWorldState(rowInertUnarmed());
  assertEq(state.inert, true, 'inert should be true');
  assertEq(state.inertWhy, 'unarmed, does not know create weapon',
    'inertWhy should carry the unarmed reason');

  const raza = lib.find(a => a.name === 'revive_inert');
  assertEq(raza.preFn(state), false,
    'revive_inert must not fire for an unarmed keeper -- it would just re-inert');

  const plan = planAction(state, NO_GOALS, lib);
  assert(plan, 'planner should produce an action');
  assertEq(plan.action.name, 'send_to_town_for_gear',
    'an unarmed inert keeper should be sent to town to buy a weapon');
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
