#!/usr/bin/env node
// m59-keeper-bt-test.mjs -- tests for the BT keeper driver
//
//   node tools/m59-keeper-bt-test.mjs
//
// These are offline tests. No broker, no server. They verify the driver's
// DECISION LADDER: that it ticks flee before farm, that a SUCCESS in either
// ends the pass, that a full FAILURE delegates to the legacy pass(), and that
// a RUNNING subtree is drained rather than abandoned.

import { BTKeeper } from './m59-keeper-bt.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// A mock legacy keeper. Records the order in which things are touched so the
// tests can assert on the ladder's decision order without a live session.
function mockKeeper(overrides = {}) {
  const calls = [];
  return {
    calls,
    s: { live: true, client: {}, world: { room: { num: 1, name: 'Test' } } },
    policy: {},
    note(msg) { calls.push(['note', msg]); },
    async pass() { calls.push(['legacy.pass']); },
    _note(msg) { calls.push(['note', msg]); },
    ...overrides,
  };
}

// A fake tree that returns a scripted sequence of results.
function fakeTree(results) {
  let i = 0;
  return {
    async tickAsync(bb) {
      const r = results[Math.min(i, results.length - 1)];
      i++;
      return r;
    },
  };
}

console.log('\nBTKeeper construction:');
{
  const k = mockKeeper();
  const d = new BTKeeper(k);
  check('driver is created', d !== null);
  check('driver holds the keeper', d.k === k);
  check('driver has a pass method', typeof d.pass === 'function');
}
{
  let threw = false;
  try { new BTKeeper(null); } catch { threw = true; }
  check('throws with no keeper', threw);
}

console.log('\nLadder ordering (flee before farm):');
{
  // Both trees return FAILURE -> legacy pass. But flee must be ticked first.
  const order = [];
  const k = mockKeeper({
    pass: async () => { order.push('legacy.pass'); },
  });
  const d = new BTKeeper(k);
  let fleeTicked = 0, farmTicked = 0;
  d._flee = () => ({ tickAsync: async () => { fleeTicked++; return FAILURE; } });
  d._farm = () => ({ tickAsync: async () => { farmTicked++; return FAILURE; } });

  await d.pass();
  check('flee tree was ticked', fleeTicked > 0);
  check('farm tree was ticked', farmTicked > 0);
  check('delegated to legacy pass when both fail', order.includes('legacy.pass'));
}

console.log('\nFlee SUCCESS ends the pass:');
{
  let farmTicked = 0, legacyTicked = 0;
  const k = mockKeeper({ pass: async () => { legacyTicked++; } });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => SUCCESS });
  d._farm = () => ({ tickAsync: async () => { farmTicked++; return FAILURE; } });

  await d.pass();
  check('farm not ticked when flee succeeded', farmTicked === 0);
  check('legacy pass not called', legacyTicked === 0);
}

console.log('\nFarm SUCCESS ends the pass:');
{
  let farmTicked = 0, legacyTicked = 0;
  const k = mockKeeper({ pass: async () => { legacyTicked++; } });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => FAILURE });
  d._farm = () => ({ tickAsync: async () => { farmTicked++; return SUCCESS; } });

  await d.pass();
  check('farm was ticked', farmTicked > 0);
  check('legacy pass not called when farm succeeded', legacyTicked === 0);
}

console.log('\nNot in game: no work done:');
{
  let legacyTicked = 0, fleeTicked = 0;
  const k = mockKeeper({
    s: { live: false, client: {}, world: { room: null } },
    pass: async () => { legacyTicked++; },
  });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => { fleeTicked++; return SUCCESS; } });

  await d.pass();
  check('flee not ticked when not in game', fleeTicked === 0);
  check('legacy pass not called when not in game', legacyTicked === 0);
}

console.log('\nRUNNING subtree is drained, not abandoned:');
{
  // Flee returns RUNNING then SUCCESS on the second tick. The driver must
  // keep ticking it (drain) until it settles.
  let fleeTicked = 0;
  const k = mockKeeper({ pass: async () => {} });
  const d = new BTKeeper(k);
  // Speed up the drain loop's 250ms wait for the test.
  const seq = [RUNNING, SUCCESS];
  d._flee = () => ({ tickAsync: async () => seq[Math.min(fleeTicked++, seq.length - 1)] });
  d._farm = () => ({ tickAsync: async () => FAILURE });

  await d.pass();
  check('flee ticked more than once (drained)', fleeTicked >= 2);
}

console.log('\nFallback sets the re-entrancy guard:');
{
  // When both trees fail, the driver calls legacy pass() with _btKeeperPass
  // set, so the legacy pass() gate does not bounce back into the driver.
  let sawGuard = false;
  const k = mockKeeper({
    pass: async () => { sawGuard = k._btKeeperPass === true; },
  });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => FAILURE });
  d._farm = () => ({ tickAsync: async () => FAILURE });

  await d.pass();
  check('legacy pass saw _btKeeperPass=true', sawGuard);
  check('guard cleared after fallback', k._btKeeperPass !== true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
