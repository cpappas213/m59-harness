#!/usr/bin/env node
// m59-bt-test.mjs -- offline tests for the behavior tree primitives.
//
// Pure in-memory tests: every node is constructed with mock callbacks, the
// blackboard is a plain object, and there is no broker, autopilot, or HTTP.
//
// Run with:   node tools/m59-bt-test.mjs
// Expects:    prints one PASS/FAIL line per test, a summary, and exits 0 only
//             when every test passes.

import {
  SUCCESS, FAILURE, RUNNING,
  Selector, Sequence, Condition, Action,
  Inverter, Timeout, Retry,
  selector, sequence,
} from './m59-bt.mjs';
import {
  wieldingWeaponCondition,
  weaponInInventoryCondition,
  knowsCreateWeaponCondition,
  manaAtLeastCondition,
  equipBestAction,
  castCreateWeaponAction,
  travelAndBuyAction,
  equipFromPackSequence,
  conjureWeaponSequence,
  getArmedTree,
  updateBlackboard,
} from './m59-bt-nodes.mjs';

// ---------------------------------------------------------------------------
// Tiny test harness -- mirrors the pattern in m59-goap-test.mjs.
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

// asyncTest: same as test() but the body may return a promise. We await it so
// async actions can be exercised in the same harness.
async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    _passed++;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    _failed++;
    _failures.push(name);
  }
}

// ---------------------------------------------------------------------------
// 1. Selector short-circuits on first SUCCESS
// ---------------------------------------------------------------------------

test('selector_short_circuits_on_first_success', () => {
  let secondTicked = false;
  const first  = new Condition(() => true);                         // SUCCESS
  const second = new Condition(() => { secondTicked = true; return true; });
  const third  = new Condition(() => { throw new Error('should not run'); });
  const sel    = new Selector([first, second, third]);
  assertEq(sel.tick({}), SUCCESS, 'selector should return SUCCESS');
  assertEq(secondTicked, false, 'second child must not have been ticked');
});

test('selector_returns_failure_when_all_children_fail', () => {
  const c1 = new Condition(() => false);
  const c2 = new Condition(() => false);
  const sel = new Selector([c1, c2]);
  assertEq(sel.tick({}), FAILURE, 'all-fail selector should return FAILURE');
});

// ---------------------------------------------------------------------------
// 2. Sequence short-circuits on first FAILURE
// ---------------------------------------------------------------------------

test('sequence_short_circuits_on_first_failure', () => {
  let thirdTicked = false;
  const first  = new Condition(() => true);
  const second = new Condition(() => false);                        // FAILURE
  const third  = new Condition(() => { thirdTicked = true; return true; });
  const seq    = new Sequence([first, second, third]);
  assertEq(seq.tick({}), FAILURE, 'sequence should return FAILURE');
  assertEq(thirdTicked, false, 'third child must not have been ticked');
});

test('sequence_returns_success_when_all_children_succeed', () => {
  const seq = new Sequence([
    new Condition(() => true),
    new Condition(() => true),
    new Condition(() => true),
  ]);
  assertEq(seq.tick({}), SUCCESS, 'all-success sequence should return SUCCESS');
});

// ---------------------------------------------------------------------------
// 3. RUNNING propagates upward
// ---------------------------------------------------------------------------

test('running_propagates_up_through_selector', () => {
  // First child fails, second returns RUNNING -> Selector returns RUNNING
  // without ticking the third.
  let thirdTicked = false;
  const running = new Action(() => RUNNING);
  const third   = new Condition(() => { thirdTicked = true; return true; });
  const sel     = new Selector([
    new Condition(() => false),
    running,
    third,
  ]);
  assertEq(sel.tick({}), RUNNING, 'RUNNING from middle child should propagate');
  assertEq(thirdTicked, false, 'later siblings should be skipped while RUNNING');
});

test('running_propagates_up_through_sequence', () => {
  // First child succeeds, second returns RUNNING -> Sequence returns RUNNING
  // without ticking the third.
  let thirdTicked = false;
  const running = new Action(() => RUNNING);
  const third   = new Condition(() => { thirdTicked = true; return true; });
  const seq     = new Sequence([
    new Condition(() => true),
    running,
    third,
  ]);
  assertEq(seq.tick({}), RUNNING, 'RUNNING from middle child should propagate');
  assertEq(thirdTicked, false, 'later siblings should be skipped while RUNNING');
});

// Action stores state on bb._bt and returns RUNNING until done.
asyncTest('action_returns_running_until_done_then_success', async () => {
  let ticks = 0;
  // The action counts ticks in its own private slot on the blackboard and
  // only returns SUCCESS once it has been ticked three times.
  const act = new Action((bb, slot) => {
    if (!slot) slot = { count: 0 };
    slot.count++;
    bb._bt[act.key] = slot;
    return slot.count >= 3 ? SUCCESS : RUNNING;
  });
  const bb = {};
  assertEq(act.tick(bb), RUNNING,  'first tick should be RUNNING');
  assertEq(act.tick(bb), RUNNING,  'second tick should still be RUNNING');
  assertEq(act.tick(bb), SUCCESS,  'third tick should reach SUCCESS');
  assert(typeof bb._bt === 'object', 'blackboard should have a _bt namespace');
});

// ---------------------------------------------------------------------------
// 4. Inverter
// ---------------------------------------------------------------------------

test('inverter_flips_success_to_failure', () => {
  const inv = new Inverter(new Condition(() => true));
  assertEq(inv.tick({}), FAILURE, 'SUCCESS should become FAILURE');
});

test('inverter_flips_failure_to_success', () => {
  const inv = new Inverter(new Condition(() => false));
  assertEq(inv.tick({}), SUCCESS, 'FAILURE should become SUCCESS');
});

test('inverter_passes_running_through', () => {
  const inv = new Inverter(new Action(() => RUNNING));
  assertEq(inv.tick({}), RUNNING, 'RUNNING should pass through inverter');
});

// ---------------------------------------------------------------------------
// 5. Timeout fires after maxMs
// ---------------------------------------------------------------------------

test('timeout_returns_failure_when_child_runs_too_long', () => {
  // A child that ALWAYS returns RUNNING, wrapped in a 30ms timeout. We tick
  // it twice with sleeps in between to make sure the wall clock advances past
  // the deadline.
  const slow  = new Action(() => RUNNING);
  const to    = new Timeout(30, slow);
  const bb    = {};
  assertEq(to.tick(bb), RUNNING, 'first tick should be RUNNING (within budget)');

  // Busy-wait a bit longer than the timeout using a synchronous spin so the
  // harness stays tiny (no fake-timers dependency). 50ms is comfortable.
  const start = Date.now();
  while (Date.now() - start < 50) { /* spin */ }

  assertEq(to.tick(bb), FAILURE, 'should return FAILURE after maxMs elapsed');
});

test('timeout_returns_child_status_when_child_finishes_in_time', () => {
  // A child that immediately succeeds, wrapped in a generous timeout.
  const fast = new Condition(() => true);
  const to   = new Timeout(10_000, fast);
  assertEq(to.tick({}), SUCCESS, 'should return child status when within budget');
});

// ---------------------------------------------------------------------------
// 6. Retry resets child state and re-ticks
// ---------------------------------------------------------------------------

test('retry_succeeds_when_world_state_improves_between_attempts', () => {
  // The action fails the first two times it's ticked and succeeds on the
  // third. Retry(3) loops up to 4 attempts within a single tick, so all of
  // those calls happen synchronously in one outer r.tick(bb).
  let calls = 0;
  const act = new Action((bb, slot) => {
    calls++;
    if (!slot) slot = { ticks: 0 };
    slot.ticks++;
    bb._bt[act.key] = slot;
    // After Retry wipes our slot, the next attempt sees a fresh slot with
    // ticks=0 again, then we increment to 1 and fail. We need the external
    // counter (bb.attempt) to advance independently so retries can succeed.
    bb.attempt = (bb.attempt || 0);
    return (bb.attempt + slot.ticks) >= 3 ? SUCCESS : FAILURE;
  });
  const r = new Retry(3, act);
  const bb = { attempt: 0 };
  // First outer tick: attempt stays 0, ticks goes 1, 1, 1, 1 -> all FAILURE.
  assertEq(r.tick(bb), FAILURE,  'four attempts all fail when attempt=0');
  assertEq(calls, 4,             'child should have been ticked 4 times');
  // Bump the external counter; next tick should succeed.
  bb.attempt = 2;
  assertEq(r.tick(bb), SUCCESS,  'next tick succeeds when attempt=2');
});

test('retry_returns_failure_after_n_attempts', () => {
  let calls = 0;
  const act = new Action(() => { calls++; return FAILURE; });
  const r = new Retry(2, act);    // up to 3 total ticks (i = 0..2)
  const bb = {};
  assertEq(r.tick(bb), FAILURE,  'should return FAILURE when child always fails');
  assertEq(calls, 3,             'child should have been ticked n+1 times');
});

test('retry_resets_action_state_between_attempts', () => {
  // Action stashes a `dirty` flag that the predicate uses to decide failure.
  // Retry must clear the slot so the second attempt sees a clean slate.
  let seenDirty = false;
  const act = new Action((bb, slot) => {
    if (slot && slot.dirty) seenDirty = true;
    // Mark dirty so a non-resetting retry would carry it forward.
    bb._bt[act.key] = { dirty: true };
    return FAILURE;
  });
  const r = new Retry(1, act);    // 2 total ticks
  const bb = {};
  r.tick(bb);
  // If Retry cleared the slot, the second tick's slot will be undefined and
  // seenDirty stays false. Otherwise the action would observe dirty=true.
  assertEq(seenDirty, false, 'retry should wipe child slot so state is reset');
});

// ---------------------------------------------------------------------------
// 7. Convenience builders and tree composition
// ---------------------------------------------------------------------------

test('selector_and_sequence_builders_compose', () => {
  const tree = selector(
    new Condition(() => false),           // fall through
    sequence(
      new Condition(() => true),
      new Condition(() => true),
    ),
    new Condition(() => true),
  );
  assertEq(tree.tick({}), SUCCESS, 'selector-of-sequence should return SUCCESS');
});

test('constants_are_exported', () => {
  assertEq(SUCCESS, 'SUCCESS', 'SUCCESS constant');
  assertEq(FAILURE, 'FAILURE', 'FAILURE constant');
  assertEq(RUNNING, 'RUNNING', 'RUNNING constant');
});

// ---------------------------------------------------------------------------
// 8. Nesting: deep tree returns the expected terminal status
// ---------------------------------------------------------------------------

test('deeply_nested_tree_propagates_failure_through_outer_sequence', () => {
  // Sequence -> Selector -> Sequence(Condition(false)) -> FAILURE
  const tree = sequence(
    new Condition(() => true),
    selector(
      sequence(
        new Condition(() => true),
        new Condition(() => false),       // FAILURE inside the inner sequence
      ),
      new Condition(() => false),
    ),
    new Condition(() => true),
  );
  assertEq(tree.tick({}), FAILURE,
    'inner FAILURE should propagate up through selector and outer sequence');
});

// ---------------------------------------------------------------------------
// 9. get_armed subtree -- the proof-of-concept wired from m59-bt-nodes.mjs.
//
// Every test here runs against a tiny fake client and a recording fake keeper,
// never against the live broker. The blackboard is a plain object whose
// `client` field is whatever the test wants the conditions to see.
// ---------------------------------------------------------------------------

// Fake client: every getter is a plain function so tests can swap
// implementations by reassignment. Spells and inventory are plain arrays.
function makeFakeClient(overrides = {}) {
  return {
    armed:        () => overrides.armed ?? false,
    vitals:       () => overrides.vitals ?? { mana: { value: 0, max: 0 } },
    spells:       overrides.spells ?? [],
    inventory:    overrides.inventory ?? [],
    rsc:          overrides.rsc ?? { get: () => '' },
  };
}

// Fake keeper: every method the BT might call resolves to a recorded value.
// `ticks` is the count of times each method was called, so tests can assert
// that conjure_weapon was NOT called when the character lacks the spell.
function makeFakeKeeper(overrides = {}) {
  const calls = { armSelf: 0, makeWeapon: 0, buyWeaponsAtNearestSmith: 0 };
  return {
    calls,
    armSelf:    async () => { calls.armSelf++;    return overrides.armSelf    ?? true; },
    makeWeapon: async () => { calls.makeWeapon++; return overrides.makeWeapon ?? true; },
    buyWeaponsAtNearestSmith:
      async () => { calls.buyWeaponsAtNearestSmith++; return overrides.buyWeaponsAtNearestSmith ?? true; },
  };
}

// Drive an async-running BT to a terminal status. The action factories in
// m59-bt-nodes.mjs return RUNNING once while their promise is in flight, then
// SUCCESS or FAILURE on the next tick. We pump ticks in a microtask loop
// until the tree returns a terminal status, then return that status.
async function tickUntilTerminal(tree, bb, maxTicks = 20) {
  let last = null;
  for (let i = 0; i < maxTicks; i++) {
    last = tree.tick(bb);
    if (last !== RUNNING) return last;
    // Yield so the action's promise can resolve before the next tick.
    await new Promise(r => setImmediate(r));
  }
  throw new Error(`BT did not terminate within ${maxTicks} ticks (last=${last})`);
}

asyncTest('get_armed_no_spell_falls_through_to_travel_and_buy', async () => {
  // THE OVERNIGHT BUG, REPLAYED. The character is unarmed, has no spell, and
  // the pack is empty. The selector must skip conjure_weapon IMMEDIATELY and
  // land on travel_and_buy. If makeWeapon were ever called here, the bug is
  // back -- it was the wait-for-mana loop the old keeper ran all night.
  const client = makeFakeClient({
    armed: false, vitals: { mana: { value: 50, max: 50 } }, spells: [],
  });
  const keeper = makeFakeKeeper();
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = await tickUntilTerminal(tree, bb);
  assertEq(r, SUCCESS, 'get_armed should reach SUCCESS via travel_and_buy');
  assertEq(keeper.calls.makeWeapon, 0,
    'makeWeapon must NOT be called when the character lacks create_weapon');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 1,
    'travel_and_buy must call the keeper buy routine exactly once');
});

asyncTest('get_armed_already_wielding_returns_success_without_actions', async () => {
  // The first arm of the selector must short-circuit before any action runs.
  const client = makeFakeClient({ armed: true });
  const keeper = makeFakeKeeper();
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = tree.tick(bb);
  assertEq(r, SUCCESS, 'wielding_weapon arm should return SUCCESS');
  assertEq(keeper.calls.armSelf, 0, 'equip_best must not run when already armed');
  assertEq(keeper.calls.makeWeapon, 0, 'create_weapon must not run when already armed');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 0,
    'travel_and_buy must not run when already armed');
});

asyncTest('get_armed_pack_weapon_runs_equip_best', async () => {
  // No spell, no weapon in hand, but a mace in the pack. The selector should
  // hit arm 2 (equip_from_pack) and skip arm 3 (conjure_weapon) and arm 4
  // (travel_and_buy). Critical: conjure_weapon must not even be considered.
  const inventory = [
    { id: 1, nameRsc: 100 },
    { id: 2, nameRsc: 200 },
  ];
  const rsc = { get: id => id === 100 ? 'iron mace' : id === 200 ? 'torch' : '' };
  const client = makeFakeClient({ inventory, rsc });
  const keeper = makeFakeKeeper();
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = await tickUntilTerminal(tree, bb);
  assertEq(r, SUCCESS, 'equip_from_pack should resolve to SUCCESS');
  assertEq(keeper.calls.armSelf, 1, 'equip_best must run exactly once');
  assertEq(keeper.calls.makeWeapon, 0,
    'makeWeapon must not run when the pack already has a weapon');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 0,
    'travel_and_buy must not run when the pack already has a weapon');
});

asyncTest('get_armed_knows_spell_and_has_mana_runs_conjure_weapon', async () => {
  // Full path through arm 3: spell is known, mana is sufficient, no weapon in
  // hand, no weapon in the pack. conjure_weapon must run; the others must not.
  const client = makeFakeClient({
    armed: false,
    vitals: { mana: { value: 25, max: 50 } },
    spells: [{ nameRsc: 7 }],
    inventory: [],
    rsc: { get: id => id === 7 ? 'create weapon' : '' },
  });
  const keeper = makeFakeKeeper();
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = await tickUntilTerminal(tree, bb);
  assertEq(r, SUCCESS, 'conjure_weapon should resolve to SUCCESS');
  assertEq(keeper.calls.makeWeapon, 1, 'makeWeapon must run exactly once');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 0,
    'travel_and_buy must not run when conjure_weapon succeeds');
});

asyncTest('get_armed_knows_spell_but_low_mana_falls_through', async () => {
  // The character knows create_weapon but has only 5 mana. The conjure_weapon
  // SEQUENCE must fail on the mana condition and fall through to travel_and_buy.
  // This is a DIFFERENT failure mode than "no spell" -- the spell is known,
  // mana is just short -- and the BT must handle both without waiting.
  const client = makeFakeClient({
    armed: false,
    vitals: { mana: { value: 5, max: 50 } },
    spells: [{ nameRsc: 7 }],
    inventory: [],
    rsc: { get: id => id === 7 ? 'create weapon' : '' },
  });
  const keeper = makeFakeKeeper({ makeWeapon: false });
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = await tickUntilTerminal(tree, bb);
  assertEq(r, SUCCESS, 'low mana should fall through to travel_and_buy -> SUCCESS');
  assertEq(keeper.calls.makeWeapon, 0,
    'makeWeapon must NOT be called when mana is below 15 (gated by sequence)');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 1,
    'travel_and_buy must run after low-mana conjure_weapon fails');
});

asyncTest('get_armed_no_spell_no_inventory_low_mana_still_goes_to_smith', async () => {
  // The strictest end of the matrix: armed=false, no spells, no inventory,
  // mana=0. travel_and_buy is the ONLY viable arm and the BT must reach it.
  const client = makeFakeClient({
    armed: false,
    vitals: { mana: { value: 0, max: 50 } },
    spells: [],
    inventory: [],
  });
  const keeper = makeFakeKeeper();
  const bb = updateBlackboard({}, { client });
  const tree = getArmedTree({ keeper });

  const r = await tickUntilTerminal(tree, bb);
  assertEq(r, SUCCESS, 'smith path should still succeed');
  assertEq(keeper.calls.makeWeapon, 0, 'no spell -> no conjure');
  assertEq(keeper.calls.buyWeaponsAtNearestSmith, 1, 'smith must be visited');
});

// ---------------------------------------------------------------------------
// 10. Individual condition and action factories -- guard against regressions
// where one of the four selector arms silently stops working.
// ---------------------------------------------------------------------------

test('wieldingWeaponCondition_reads_bb.client.armed', () => {
  const c1 = wieldingWeaponCondition();
  assertEq(c1.tick({ client: { armed: () => true } }), SUCCESS,  'armed true -> SUCCESS');
  assertEq(c1.tick({ client: { armed: () => false } }), FAILURE, 'armed false -> FAILURE');
  assertEq(c1.tick({}), FAILURE, 'no client -> FAILURE');
});

test('knowsCreateWeaponCondition_matches_by_rsc_name_case_insensitive', () => {
  const c = knowsCreateWeaponCondition();
  const rsc = { get: id => id === 1 ? 'Create Weapon' : id === 2 ? 'shocking burst' : '' };
  assertEq(c.tick({ client: { spells: [{ nameRsc: 1 }], rsc } }), SUCCESS,
    'matching name (any case) -> SUCCESS');
  assertEq(c.tick({ client: { spells: [{ nameRsc: 2 }], rsc } }), FAILURE,
    'different spell -> FAILURE');
  assertEq(c.tick({ client: { spells: [], rsc } }), FAILURE, 'no spells -> FAILURE');
  assertEq(c.tick({}), FAILURE, 'no client -> FAILURE');
});

test('manaAtLeastCondition_returns_failure_when_unknown', () => {
  // The "unknown vitals" window after a broker restart must read as FAILURE,
  // not as a number that happens to pass the threshold (a NaN comparison
  // would; we want the predicate to refuse instead).
  const c = manaAtLeastCondition(15);
  assertEq(c.tick({ client: { vitals: () => null } }), FAILURE,
    'null vitals -> FAILURE, not NaN-pass');
  assertEq(c.tick({ client: { vitals: () => ({ mana: null }) } }), FAILURE,
    'null mana -> FAILURE');
  assertEq(c.tick({ client: { vitals: () => ({ mana: { value: 5 } }) } }), FAILURE,
    '5 mana < 15 -> FAILURE');
  assertEq(c.tick({ client: { vitals: () => ({ mana: { value: 15 } }) } }), SUCCESS,
    '15 mana == 15 -> SUCCESS (threshold is inclusive)');
});

test('equipBestAction_returns_running_once_then_success', async () => {
  const keeper = makeFakeKeeper();
  const act = equipBestAction(keeper);
  const bb = {};
  assertEq(act.tick(bb), RUNNING, 'first tick kicks off, returns RUNNING');
  // The action does `Promise.resolve().then(() => asyncKeeper()).then(...)`.
  // asyncKeeper returns a Promise too, so the chain is three microtask hops
  // before the slot flips to done. Poll the action until it settles, with a
  // bounded number of tries.
  let status = RUNNING;
  for (let i = 0; i < 10 && status === RUNNING; i++) {
    await new Promise(r => setImmediate(r));
    status = act.tick(bb);
  }
  assertEq(status, SUCCESS, 'action should resolve to SUCCESS after promise settles');
  assertEq(keeper.calls.armSelf, 1, 'keeper.armSelf must be invoked once');
});

test('updateBlackboard_writes_client_and_initializes_bt', () => {
  const bb = {};
  const client = makeFakeClient();
  updateBlackboard(bb, { client });
  assertEq(bb.client, client, 'client should be written');
  assert(typeof bb._bt === 'object', '_bt should be initialized as an object');
  // Calling twice should not throw and should preserve existing _bt.
  bb._bt.existing = 'kept';
  updateBlackboard(bb, { client });
  assertEq(bb._bt.existing, 'kept', 'pre-existing _bt keys must survive a re-snapshot');
});

test('getArmedTree_throws_when_no_keeper_supplied', () => {
  let threw = false;
  try { getArmedTree({}); } catch (_e) { threw = true; }
  assert(threw, 'getArmedTree({}) should throw without a keeper');
});

// ---------------------------------------------------------------------------
// Summary and exit code
// ---------------------------------------------------------------------------

(async () => {
  // asyncTest appended work to _passed/_failed asynchronously. Each async test
  // may run several internal microtask hops (the action factories use
  // Promise.resolve().then(...).then(...)), so drain a few event loop ticks
  // before printing the summary to make sure every test has reported.
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  const total = _passed + _failed;
  console.log('');
  console.log(`${_passed}/${total} passing`);
  if (_failed > 0) {
    console.log(`FAILURES: ${_failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
})();
