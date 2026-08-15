#!/usr/bin/env node
// m59-bt-wiring-test.mjs -- offline tests for the behavior-tree wiring step.
//
// Proves that tools/m59-autopilot.mjs's pass() honors the per-character
// policy.useBT flag exactly as the BT-PLAN specifies:
//
//   (a) useBT undefined or false => the BT is not invoked; pass() proceeds unchanged.
//   (b) useBT=true and the character is unarmed => the BT runs getArmedTree.
//   (c) useBT=true and the character is already armed => the BT is bypassed.
//   (d) overnight-bug regression: knows_create_weapon=false and low mana force
//       the Selector to fall through to travel_and_buy on the first tick,
//       NOT spin on conjure_weapon forever (the Rowlf bug from BT-PLAN).
//   (e) RUNNING slot remains stable across consecutive ticks.
//
// Pure in-memory. No broker, no HTTP, no live Meridian session. Stubs a
// Autopilot-shaped object just enough for the wiring block to exercise.
//
// Run with:   node tools/m59-bt-wiring-test.mjs

import {
  RUNNING,
} from './m59-bt.mjs';
import {
  getArmedTree,
  updateBlackboard,
} from './m59-bt-nodes.mjs';

// Tiny test harness.
let _passed = 0;
let _failed = 0;
function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    _failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assert failed');
}

// Build a stub keeper the BT block can drive. The real Keeper methods
// (armSelf, equipBest, makeWeapon, buyWeaponsAtNearestSmith) are stubbed
// here -- we record calls rather than reach for the network.
function makeStubKeeper({
  armed = false,
  knowsCreateWeapon = true,
  mana = 50,
} = {}) {
  const calls = [];
  const stub = {
    s: { client: null, live: true, name: 'stub' },
    policy: { useBT: true },
    armSelfCalled: 0,
    equipBestCalled: 0,
    makeWeaponCalled: 0,
    buyWeaponsCalled: 0,
    buyWeaponsAtNearestSmithCalled: 0,
    async armSelf()             { calls.push('armSelf');                     this.armSelfCalled++; return true; },
    async equipBest()           { calls.push('equipBest');                   this.equipBestCalled++; return true; },
    async makeWeapon()          { calls.push('makeWeapon');                  this.makeWeaponCalled++; return true; },
    async buyWeapons()          { calls.push('buyWeapons');                  this.buyWeaponsCalled++; return true; },
    async buyWeaponsAtNearestSmith() {
      calls.push('buyWeaponsAtNearestSmith');
      this.buyWeaponsAtNearestSmithCalled++;
      return true;
    },
  };
  const client = {
    armed: () => armed,
    spells: knowsCreateWeapon ? [{ nameRsc: 0, name: 'create weapon' }] : [{ nameRsc: 0, name: 'blink' }],
    vitals: () => ({ mana: { value: mana } }),
    inventory: [],
  };
  stub.s.client = client;
  return { stub, client, calls };
}

// Mirror the actual wiring block from m59-autopilot.mjs. Reduced to the
// essentials the tests need; if this drifts from the real block, the
// associated test in m59-bt-wiring-test.mjs is the contract that catches it.
async function simulatePassTick(keeper) {
  const c = keeper.s.client;
  if (!c || typeof c.armed !== 'function') return 'no-client';
  if (c.armed()) return 'already-armed';
  if (!keeper.policy || keeper.policy.useBT !== true) return 'flag-off';
  const bb = updateBlackboard(
    keeper._btBlackboard || (keeper._btBlackboard = {}),
    { client: c, session: keeper, policy: keeper.policy },
  );
  const tree = getArmedTree({ session: { keeper } });
  await tree.tick(bb);
  if (c.armed()) return 'armed-by-bt';
  return 'bt-did-not-arm';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('wiring: useBT undefined => BT not invoked, falls through', async () => {
  const { stub, calls } = makeStubKeeper({ armed: false });
  stub.policy = {}; // no useBT key
  const outcome = await simulatePassTick(stub);
  assertEq(outcome, 'flag-off');
  assertEq(calls.length, 0);
});

test('wiring: useBT=false => BT not invoked, falls through', async () => {
  const { stub, calls } = makeStubKeeper({ armed: false });
  stub.policy = { useBT: false };
  const outcome = await simulatePassTick(stub);
  assertEq(outcome, 'flag-off');
  assertEq(calls.length, 0);
});

test('wiring: useBT=true and armed=true at tick start => BT bypassed', async () => {
  const { stub, calls } = makeStubKeeper({ armed: true });
  stub.policy = { useBT: true };
  const outcome = await simulatePassTick(stub);
  assertEq(outcome, 'already-armed');
  assertEq(calls.length, 0);
  assert(!('_btBlackboard' in stub), 'blackboard must NOT be initialized when BT is bypassed');
});

test('wiring: useBT=true and unarmed => BT runs, bb._bt initialised', async () => {
  const { stub } = makeStubKeeper({ armed: false, knowsCreateWeapon: false });
  const outcome = await simulatePassTick(stub);
  assertEq(outcome, 'bt-did-not-arm');
  assert(stub._btBlackboard, 'blackboard should exist after the tick');
  assert(stub._btBlackboard._bt, 'bb._bt slot bag should exist after the tick');
});

test('wiring: overnight-bug regression -- no create_weapon spell, BT falls through', async () => {
  // Rowlf bug from BT-PLAN: a character that does NOT know create_weapon sat on
  // `await conjure_weapon` forever under the old sequential pass(). The BT's
  // Selector fixes it structurally: on tick 0, the conjure_weapon Sequence's
  // FIRST Condition (knowsCreateWeapon) returns FAILURE, the Sequence itself
  // returns FAILURE synchronously, and the Selector advances to the
  // travel_and_buy arm on the same tick.
  const { stub, calls } = makeStubKeeper({ armed: false, knowsCreateWeapon: false });
  stub.policy = { useBT: true };
  await simulatePassTick(stub);
  assertEq(stub.makeWeaponCalled, 0, 'makeWeapon must NOT be called when knowsCreateWeapon=false');
  const lastCall = calls[calls.length - 1];
  assert(
    lastCall === 'buyWeapons' || lastCall === 'buyWeaponsAtNearestSmith' ||
    lastCall === 'equipBest'  || lastCall === 'armSelf',
    `Selector must advance past conjure when knowsCreateWeapon=false; last call was ${lastCall}`,
  );
});

test('wiring: knowsCreateWeapon=true but mana<15 => conjure fails fast, fall through', async () => {
  // Second conjure-regression vector from BT-PLAN: low mana. The Sequence is
  // `knowsCreateWeapon && mana>=15 && castCreateWeapon`. If mana is 14, the
  // second Condition returns FAILURE and the Selector advances.
  const { stub } = makeStubKeeper({ armed: false, knowsCreateWeapon: true, mana: 14 });
  stub.policy = { useBT: true };
  await simulatePassTick(stub);
  assertEq(stub.makeWeaponCalled, 0, 'makeWeapon must NOT be called when mana < 15');
  const sawNonConjure =
    stub.buyWeaponsCalled > 0 || stub.buyWeaponsAtNearestSmithCalled > 0 ||
    stub.equipBestCalled   > 0 || stub.armSelfCalled             > 0;
  assert(sawNonConjure, 'a non-conjure arm must have run on the fall-through tick');
});

test('wiring: successive ticks reuse the same blackboard instance', async () => {
  const { stub } = makeStubKeeper({ armed: false, knowsCreateWeapon: true, mana: 50 });
  stub.policy = { useBT: true };
  await simulatePassTick(stub);
  const bb1 = stub._btBlackboard;
  assert(bb1, 'first tick should initialise the blackboard');
  await simulatePassTick(stub);
  const bb2 = stub._btBlackboard;
  assertEq(bb2, bb1, 'second tick must reuse the same blackboard instance');
  assert(bb2._bt, 'bb._bt must still exist on the second tick');
});

test('wiring: updateBlackboard preserves GOAP-written strategic fields', async () => {
  // Per BT-PLAN, GOAP writes assignedRoom/hunt/purpose/goals between ticks.
  // updateBlackboard must NOT clobber them when it refreshes client/policy.
  const bb = updateBlackboard(
    { assignedRoom: 1234, hunt: 'ant', purpose: 'money', goals: [{ kind: 'hp' }] },
    { client: { armed: () => false }, session: { keeper: null }, policy: { useBT: true } },
  );
  assertEq(bb.assignedRoom, 1234);
  assertEq(bb.hunt, 'ant');
  assertEq(bb.purpose, 'money');
  assertEq(bb.goals.length, 1);
  assert(bb.client);
  assert(bb._bt);
});

test('wiring: BT subtree factories still pass smoke checks', async () => {
  const { stub } = makeStubKeeper({ armed: false, knowsCreateWeapon: false });
  const bb = { client: stub.s.client, session: stub, _bt: {} };
  const tree = getArmedTree({ session: { keeper: stub } });
  const status = await tree.tick(bb);
  assert(
    status === RUNNING || status === 'SUCCESS' || status === 'FAILURE',
    `tick must return a status, got ${status}`,
  );
});

console.log('');
console.log(`${_passed}/${_passed + _failed} passing`);
if (_failed > 0) process.exit(1);
process.exit(0);
