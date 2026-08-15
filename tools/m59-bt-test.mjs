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
// Summary and exit code
// ---------------------------------------------------------------------------

(async () => {
  // asyncTest appended work to _passed/_failed asynchronously -- give the
  // microtask queue a tick to settle before printing the summary.
  await new Promise(r => setImmediate(r));
  const total = _passed + _failed;
  console.log('');
  console.log(`${_passed}/${total} passing`);
  if (_failed > 0) {
    console.log(`FAILURES: ${_failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
})();
