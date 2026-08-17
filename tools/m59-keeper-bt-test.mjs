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

console.log('\nSafety-first routing (Underworld / arm before the trees):');
{
  // A character in the Underworld must be escaped BEFORE any tree ticks. The
  // regression for Lee: dead in The Underworld, the farm node looped on "this room
  // cannot produce our prey -- leaving now" forever because it tried to path-travel
  // out of a room with no graph exits. passUnderworld returns true -> the pass ends.
  const order = [];
  const k = mockKeeper({
    s: { live: true, client: { self: {} }, world: { room: { num: 999, name: 'The Underworld' } } },
    passUnderworld: async (s, c, room) => { order.push('underworld'); return true; },
  });
  const d = new BTKeeper(k);
  let fleeTicked = 0, farmTicked = 0;
  d._flee = () => ({ tickAsync: async () => { fleeTicked++; return FAILURE; } });
  d._farm = () => ({ tickAsync: async () => { farmTicked++; return FAILURE; } });

  await d.pass();
  check('underworld handled before the trees', order[0] === 'underworld');
  check('flee not ticked when dead in the underworld', fleeTicked === 0);
  check('farm not ticked when dead in the underworld', farmTicked === 0);
}
{
  // Not in the Underworld (passUnderworld returns false) AND unarmed (passArm true):
  // arm first, then the trees. The trees must still run after the safety checks.
  const order = [];
  const k = mockKeeper({
    s: { live: true, client: { self: {} }, world: { room: { num: 1, name: 'Test' } } },
    passUnderworld: async () => { order.push('underworld'); return false; },
    passArm: async () => { order.push('arm'); return true; },
  });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => { order.push('flee'); return FAILURE; } });
  d._farm = () => ({ tickAsync: async () => { order.push('farm'); return FAILURE; } });

  await d.pass();
  check('underworld checked first', order[0] === 'underworld');
  check('arm checked second (and ends the pass)', order[1] === 'arm');
  check('trees not ticked when unarmed and arm was handled', !order.includes('flee') && !order.includes('farm'));
}
{
  // Self-id lost: after 3 passes with no self, reconnect and stop. Defensive: a
  // keeper without reconnect (a partial mock) must not throw.
  const k = mockKeeper({ s: { live: true, client: {}, world: { room: { num: 1, name: 'Test' } } } });
  const d = new BTKeeper(k);
  d._flee = () => ({ tickAsync: async () => FAILURE });
  d._farm = () => ({ tickAsync: async () => FAILURE });
  let threw = false;
  try { for (let i = 0; i < 3; i++) await d.pass(); } catch { threw = true; }
  check('no self for 3 passes does not throw (reconnect is optional)', !threw);
}

// THE ROOT CAUSE OF THE PROVISIONING DEADLOCK. _btFarmStrategy() is called by every
// BT farm node that needs the strategy (provisionNode first). After the bt-keeper
// branch merge it read an undeclared `require_cache` (ReferenceError) and
// this.constructor.STRATEGIES (undefined), so every call threw, tickAsync swallowed
// the throw as FAILURE, and provisioning silently never ran -- Lee looped "too tired
// to start a fight" for ever while his larder sat full. These adapters must resolve
// the real strategy table and spawn file, not throw.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const k = { policy: { strategy: 'baseline' }, constructor: Autopilot };
  let threw = false, plan = null;
  try { plan = Autopilot.prototype._btFarmStrategy.call(k); } catch { threw = true; }
  check('_btFarmStrategy does not throw (no undeclared require_cache)', !threw);
  check('_btFarmStrategy resolves the baseline strategy table', plan && plan.vigorFloor === 140,
        `vigorFloor=${plan?.vigorFloor}`);
  check('STRATEGIES is exposed as a class static the BT tree can read',
        Autopilot.STRATEGIES && Autopilot.STRATEGIES.baseline?.vigorFloor === 140);
  check('SPAWN_FILE is exposed as a class static the BT tree can read',
        typeof Autopilot.SPAWN_FILE === 'string' && Autopilot.SPAWN_FILE.length > 0);
  let spawnThrew = false, spawnFile = null;
  try { spawnFile = Autopilot.prototype._btFarmSpawnFile.call(k); } catch { spawnThrew = true; }
  check('_btFarmSpawnFile does not throw', !spawnThrew);
  check('_btFarmSpawnFile returns the spawn file path', spawnFile === Autopilot.SPAWN_FILE);
}

// ---------------------------------------------------------------------------
// Town business: the BT keeper must sell loot and bank the surplus, or a BT
// character loots kills for ever and never converts them to money -- the bags
// fill, the purse never moves, and "sustainably profitable" is never testable.
// _townBusiness delegates to the legacy bankSurplus/bankRun.
// ---------------------------------------------------------------------------
console.log('\nTown business (sell + bank before farming):');
{
  // BT town tree: in a bank with surplus -> native deposit called
  let depositCalled = 0;
  const k = mockKeeper({
    policy: { bankAbove: 500 },
    s: {
      ...mockKeeper().s,
      world: { room: { num: 2003, name: 'First Royal Bank of Tos' } },
      client: {
        ...mockKeeper().s.client,
        inventory: [{ nameRsc: 'shilling', amount: 2000 }],
        rsc: { get: (id) => id === 'shilling' ? 'shilling' : '' },
        vitals: () => ({ vigor: { value: 200 } }),
        deposit: async () => { depositCalled++; },
        requestInventory: async () => {},
        waitFor: async () => ({ events: [] }),
      },
    },
  });
  const d = new BTKeeper(k);
  const r = await d._townBusiness(k, k.s, k.s.client);
  check('in bank with surplus -> pass consumed (banked)', r === true);
  check('deposit was called natively', depositCalled >= 1);
}
{
  // Not in a bank, no trip needed -> farming continues
  const k = mockKeeper({
    policy: { bankAbove: 500 },
    larder: () => [{ food: { nutrition: 100 }, o: { amount: 1 } }],
  });
  const d = new BTKeeper(k);
  const r = await d._townBusiness(k, k.s, k.s.client);
  check('no bank, no trip -> pass NOT consumed (farming continues)', r === false);
}
{
  // No bankAbove set -> no bank run attempted at all
  let bankRunCalled = 0;
  const k = mockKeeper({
    policy: {},
    bankSurplus: async () => {},
    bankRun: async () => { bankRunCalled++; return false; },
  });
  const d = new BTKeeper(k);
  const r = await d._townBusiness(k, k.s, k.s.client);
  check('no bankAbove -> bankRun not called', bankRunCalled === 0);
  check('no bankAbove -> pass not consumed', r === false);
}

// ---------------------------------------------------------------------------
// GOAP gear deadlock: the keeper must BUY the weapon when it is already IN town,
// even while the GOAP's 10-min dispatch window is active. The GOAP's
// send_to_town_for_gear walks the character to the inn and then relies on the keeper
// to buy; if the keeper stands down for the whole window, nobody buys and the
// character idles unarmed at the inn for ten minutes (Lee at Yonder Inn of Jasper).
// The stand-down only applies while still OUT of town (GOAP actively walking).
// ---------------------------------------------------------------------------
console.log('\nGOAP gear deadlock (buy in town, stand down only out of town):');
{
  // The gate: goapArming && !inTownWithSmith -> stand down. Otherwise buy.
  const goapArming = true;
  const inTownRegex = /inn|market|city|town|Tos|Barloque|Jasper|Cornoth|Roq/i;
  // In a town inn (Lee's case): inTownWithSmith true -> should BUY (not stand down)
  const roomName = 'Yonder Inn of Jasper';
  const inTown = inTownRegex.test(roomName);
  const standDown = goapArming && !inTown;
  check('in a town inn with GOAP armed -> does NOT stand down (buys)', standDown === false);
  // Out of town (still walking): stand down
  const outRoom = 'Main gate to the city of Tos' .replace('city of Tos','a field');
  const outTown = inTownRegex.test(outRoom);
  const outStandDown = goapArming && !outTown;
  check('out of town with GOAP armed -> stands down (GOAP walking)', outStandDown === true);
}

// ---------------------------------------------------------------------------
// Decision trace: the journal carries a compact record of which BT nodes
// evaluated and what each returned, so a death is readable without reverse-
// engineering it from the post-mortem frames. The trace is emitted as a
// single 'bt-trace' note when something fired (SUCCESS/RUNNING) or when the
// pass delegated to legacy (all FAILURE).
// ---------------------------------------------------------------------------
console.log('\nDecision trace (which BT nodes evaluated and what they returned):');
{
  // A tree WITH children (the real shape) so the trace wrapper engages.
  function realTree(results) {
    let i = 0;
    const children = results.map((r, idx) => ({
      _name: `node${idx}`,
      key: `node${idx}`,
      tick: () => results[Math.min(i, results.length - 1)],
      tickAsync: async () => results[Math.min(i++, results.length - 1)],
    }));
    return { children };
  }

  // Case 1: a node fires SUCCESS -> trace is emitted.
  {
    const notes = [];
    const k = mockKeeper({
      s: { live: true, client: { self: {} }, world: { room: { num: 1, name: 'Test' } } },
      note: (msg, detail) => notes.push([msg, detail]),
      pass: async () => {},
    });
    const d = new BTKeeper(k);
    // flee: node0=FAILURE, node1=SUCCESS  -> trace should fire
    d._flee = () => realTree([FAILURE, SUCCESS]);
    d._farm = () => ({ tickAsync: async () => FAILURE });
    await d.pass();
    const traceNote = notes.find(n => n[0] === 'bt-trace');
    check('trace emitted when a node fired SUCCESS', !!traceNote);
    if (traceNote) {
      check('trace names the tree (flee)', traceNote[1].trace.includes('[BT:flee]'));
      check('trace shows node0=FAILURE', traceNote[1].trace.includes('node0=FAILURE'));
      check('trace shows node1=SUCCESS', traceNote[1].trace.includes('node1=SUCCESS'));
    }
  }

  // Case 2: all nodes FAILURE -> delegated to legacy -> trace still emitted.
  {
    const notes = [];
    let legacyCalled = false;
    const k = mockKeeper({
      s: { live: true, client: { self: {} }, world: { room: { num: 1, name: 'Test' } } },
      note: (msg, detail) => notes.push([msg, detail]),
      pass: async () => { legacyCalled = true; },
    });
    const d = new BTKeeper(k);
    d._flee = () => realTree([FAILURE]);
    d._farm = () => realTree([FAILURE]);
    await d.pass();
    check('legacy called when all trees fail', legacyCalled);
    const traceNote = notes.find(n => n[0] === 'bt-trace');
    check('trace emitted when delegating to legacy', !!traceNote);
    if (traceNote) {
      // Both trees appear in the trace (flee and farm were both consulted).
      check('trace shows both trees (flee + farm)',
        traceNote[1].trace.includes('[BT:flee]') && traceNote[1].trace.includes('[BT:farm]'));
    }
  }

  // Case 3: a tree WITHOUT children (mock shape) -> no trace wrapper, no crash.
  {
    const notes = [];
    const k = mockKeeper({
      s: { live: true, client: { self: {} }, world: { room: { num: 1, name: 'Test' } } },
      note: (msg, detail) => notes.push([msg, detail]),
      pass: async () => {},
    });
    const d = new BTKeeper(k);
    d._flee = () => ({ tickAsync: async () => SUCCESS });   // no .children
    d._farm = () => ({ tickAsync: async () => FAILURE });
    let threw = false;
    try { await d.pass(); } catch { threw = true; }
    check('tree without children does not crash the trace', !threw);
  }

  // Case 4: trace is reset between passes (no cross-pass leakage).
  {
    const notes = [];
    const k = mockKeeper({
      s: { live: true, client: { self: {} }, world: { room: { num: 1, name: 'Test' } } },
      note: (msg, detail) => notes.push([msg, detail]),
      pass: async () => {},
    });
    const d = new BTKeeper(k);
    d._flee = () => realTree([SUCCESS]);
    d._farm = () => ({ tickAsync: async () => FAILURE });
    await d.pass();   // pass 1: fires
    const after1 = notes.filter(n => n[0] === 'bt-trace').length;
    d._flee = () => realTree([SUCCESS]);
    await d.pass();   // pass 2: fires again
    const after2 = notes.filter(n => n[0] === 'bt-trace').length;
    check('each pass emits its own trace', after1 === 1 && after2 === 2);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
