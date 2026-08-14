#!/usr/bin/env node
// m59-goap-test.mjs -- pure-logic tests for the GOAP planner.
//
// The planner is data + functions; the broker is not in the loop. We drive the
// planner with hand-built fleet rows and check which action it picks. The four
// pins are the ones the task brief calls out:
//
//   1. stalled character            → stop_and_travel
//   2. vitals_unknown + wrong room   → stop_and_travel
//   3. correct state                 → no action
//   4. action/effect cycle           → terminates after one pass
//
// Run:   node tools/m59-goap-test.mjs
// Exits 0 on success, 1 on first failure.

import assert from 'node:assert/strict';

import {
  deriveWorldState,
  buildActionLibrary,
  planAction,
  selectGoal,
  compileExpr,
} from './m59-goap.mjs';

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  yes  ${name}`); passed++; }
  catch (e) { console.error(`  NO   ${name}\n       ${e.message}`); failed++; }
};

// ---------- fixtures ----------------------------------------------------------

const baseRow = {
  agent: 'a1', character: 'Aldric', in_game: true, room_num: 70,
  room: 'graveyard', assigned_room: 70,
  health: '50/50', level: 50, vigor: 200,
  policy: { hunt: 'zombie', purpose: 'advance', goals: [{ kind: 'hp' }],
            assignedRoom: 70, mode: 'farm' },
  keeper_running: true,
  parked: null, committed: null, busy: null,
  stalled: false,
  yield_check: { paying: true },
  mode: 'farm',
};

const stalledRow = {
  ...baseRow, stalled: { since_seconds: 600, idle_passes: 8, why: 'no prey' },
};

const vitalsUnknownWrongRoom = {
  ...baseRow, health: null, room_num: 1, assigned_room: 70,
};

const correctRow = baseRow;

const goals = {
  Aldric: [{ kind: 'advance', target: 'zombie', priority: 10 }],
};

// ---------- pins --------------------------------------------------------------

console.log('goap planner');

t('stalled character → stop_and_travel', () => {
  const state = deriveWorldState(stalledRow);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.ok(plan, 'planner should return a plan');
  assert.equal(plan.action.name, 'stop_and_travel');
  assert.equal(plan.cost, 1, 'stop_and_travel is the cheapest action');
});

t('vitals_unknown with wrong room → stop_and_travel', () => {
  const state = deriveWorldState(vitalsUnknownWrongRoom);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.ok(plan, 'planner should return a plan');
  assert.equal(plan.action.name, 'stop_and_travel');
});

t('vitals_unknown with correct room → no action', () => {
  // Health null but already in the right room -- no travel needed.
  const row = { ...baseRow, health: null, room_num: 70, assigned_room: 70 };
  const state = deriveWorldState(row);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.equal(plan, null, 'planner should pick nothing when the character is already home');
});

t('character at correct level+room with paying prey → no action', () => {
  const state = deriveWorldState(correctRow);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.equal(plan, null, 'planner should pick nothing in the happy case');
});

t('set_prey fires when yieldCheck says paying=false', () => {
  const row = { ...baseRow, yield_check: { paying: false, why: 'creature is below level' } };
  const state = deriveWorldState(row);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.ok(plan, 'planner should pick something');
  assert.equal(plan.action.name, 'set_prey');
});

t('set_purpose fires when purpose is null', () => {
  const row = { ...baseRow, policy: { ...baseRow.policy, purpose: null } };
  const state = deriveWorldState(row);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.ok(plan, 'planner should pick something');
  // set_purpose has lower cost than set_prey, so it wins.
  assert.equal(plan.action.name, 'set_purpose');
});

t('rest_in_inn fires when health < 35% and not parked', () => {
  const row = { ...baseRow, health: '15/50' };
  const state = deriveWorldState(row);
  const lib = buildActionLibrary();
  const plan = planAction(state, goals, lib);
  assert.ok(plan, 'planner should pick something');
  assert.equal(plan.action.name, 'rest_in_inn');
});

// ---------- cycle guard -------------------------------------------------------

t('action/effect cycle terminates after one pass', () => {
  // The character is stalled in the wrong room. The planner should pick
  // stop_and_travel exactly once; its effect (vitals known, room == assignedRoom,
  // no longer stalled) must remove its own precondition.
  const state = deriveWorldState(stalledRow);
  const lib = buildActionLibrary();
  const plan1 = planAction(state, goals, lib);
  assert.ok(plan1);
  assert.equal(plan1.action.name, 'stop_and_travel');
  // Simulate the effect: the character has now arrived in assigned_room and
  // the keeper reports unstalled.
  const after = { ...state, room: state.assignedRoom, stalled: false,
                  stalledSeconds: null, busy: false };
  const plan2 = planAction(after, goals, lib);
  assert.equal(plan2, null, 'planner must stop firing once the precondition no longer holds');
});

t('set_prey loop terminates: paying=true after retarget', () => {
  // Once the prey is retargeted to the goal target, yieldCheck would normally
  // flip to paying=true (or stay paying=false for the same reason). Either way,
  // the action's effect MUST make the precondition fail on the second pass.
  // We assert that with the "prey set, yield paying" post-state, plan is null.
  const after = {
    ...deriveWorldState(baseRow),
    hunt: 'zombie',
    yieldPaying: true,
    yieldCheck: { paying: true },
  };
  const lib = buildActionLibrary();
  assert.equal(planAction(after, goals, lib), null);
});

t('set_purpose loop terminates: purpose set', () => {
  const after = { ...deriveWorldState(baseRow), purpose: 'advance' };
  const lib = buildActionLibrary();
  assert.equal(planAction(after, goals, lib), null);
});

t('rest_in_inn loop terminates: parked_at_inn set', () => {
  const after = { ...deriveWorldState({ ...baseRow, health: '15/50' }),
                  parked_at_inn: true };
  const lib = buildActionLibrary();
  assert.equal(planAction(after, goals, lib), null);
});

t('1000 simulated passes converge (no infinite loop)', () => {
  // Drive the planner against a state that needs stop_and_travel, then keep
  // feeding its effects back through. The cycle MUST converge -- every action's
  // effect removes its own precondition. A regression here is the test failing
  // on count > 50 or running forever (the runtime is the assertion).
  let state = deriveWorldState(stalledRow);
  const lib = buildActionLibrary();
  let appliedCount = 0;
  for (let i = 0; i < 1000; i++) {
    const plan = planAction(state, goals, lib);
    if (!plan) break;
    appliedCount++;
    if (plan.action.name === 'stop_and_travel') {
      state = { ...state, room: state.assignedRoom,
                health: state.health ?? 50, healthMax: state.healthMax ?? 50,
                stalled: false };
    } else if (plan.action.name === 'set_purpose') {
      state = { ...state, purpose: 'advance' };
    } else if (plan.action.name === 'set_prey') {
      state = { ...state, hunt: state.goalTarget ?? 'zombie', yieldPaying: true };
    } else if (plan.action.name === 'rest_in_inn') {
      state = { ...state, parked_at_inn: true };
    }
  }
  assert.ok(appliedCount <= 4, `applied ${appliedCount} actions, expected at most 4`);
  assert.equal(planAction(state, goals, lib), null, 'planner should be quiet at fixed point');
});

// ---------- helpers -----------------------------------------------------------

t('selectGoal picks the highest-priority entry', () => {
  const g = { A: [
    { kind: 'advance', target: 'rat',   priority: 1 },
    { kind: 'advance', target: 'zombie', priority: 10 },
  ] };
  assert.equal(selectGoal(g, 'A').target, 'zombie');
});

t('selectGoal returns null when the character has no goals', () => {
  assert.equal(selectGoal({ A: [] }, 'A'), null);
  assert.equal(selectGoal({}, 'B'), null);
});

t('compileExpr catches broken preconditions safely', () => {
  const fn = compileExpr('undefined_var.foo > 0');
  // must not throw -- a bad precondition reads as "not applicable"
  assert.equal(fn({ x: 1 }), false);
});

t('deriveWorldState parses health "value/max" and nulls', () => {
  const a = deriveWorldState({ ...baseRow, health: '12/40' });
  assert.equal(a.health, 12);
  assert.equal(a.healthMax, 40);
  const b = deriveWorldState({ ...baseRow, health: null });
  assert.equal(b.health, null);
  assert.equal(b.healthMax, null);
});

t('deriveWorldState computes busy from parked/committed/busy/faculties', () => {
  assert.equal(deriveWorldState(baseRow).busy, false);
  assert.equal(deriveWorldState({ ...baseRow, parked: { parked: true } }).busy, true);
  assert.equal(deriveWorldState({ ...baseRow, committed: { kind: 'errand' } }).busy, true);
});

// ---------- summary ----------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
