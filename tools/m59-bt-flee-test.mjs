#!/usr/bin/env node
// m59-bt-flee-test.mjs -- offline tests for the flee/rest behavior tree.
//
// Runs without a broker or server. Uses a mock keeper that records which
// methods were called and returns canned values.
//
//   node tools/m59-bt-flee-test.mjs

import {
  getFleeTree, doomedNode, fleeThresholdNode, sanctuarySettleNode,
  getAWallNode, vigorWalkNode, leaveRoomNode, restNode,
} from './m59-bt-flee.mjs';

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Mock keeper
// ---------------------------------------------------------------------------

function mockKeeper(overrides = {}) {
  const calls = [];
  const k = {
    calls,
    note: (msg, detail) => calls.push(['note', msg]),
    progress: (msg) => calls.push(['progress', msg]),
    noProgress: (msg) => calls.push(['noProgress', msg]),
    policy: {
      fleeBelow: 0.4,
      restBelow: 0.6,
      doomedInSpotBelow: 0.35,
      holdResumeAbove: 0.8,
      useSafeSpots: true,
      panicLogoff: true,
      mode: 'farm',
      hunt: 'giant rat',
      strategy: 'baseline',
      ...overrides.policy,
    },
    s: {
      name: 't1',
      client: {
        vitals: () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } }),
        self: { col: 10, row: 10 },
        selfId: 1,
        room: { objects: new Map() },
        rsc: { get: () => 'giant rat' },
        armed: () => true,
      },
      world: { exits: () => [] },
    },
    hold: null,
    holdWorks: () => false,
    doing: null,
    wallTriedAt: null,
    settledIn: null,
    tally: { rests: 0, withdrawals: 0, mulligans: 0, fled_rooms: 0 },
    recoverUntilWhole: false,
    recovered: () => true,
    safety: () => ({ engageAt: 0.75, fleeAt: 0.3 }),
    sanctuary: () => false,
    armed: () => true,
    // BT flee helpers
    _btFleeNear: () => [],
    _btFleeHostiles: () => [],
    _btFleeStrategy: () => ({}),
    _btFleeRestAndCook: async () => {},
    _btFleeTurnInPlace: async () => ({ turned: true }),
    _btFleeNudge: async () => ({ moved: true }),
    _btFleeReturnToSpot: async () => ({ arrived: true }),
    _btFleeHealUp: async () => ({ healed: true }),
    _btFleeRestUntil: async () => null,
    // Methods that the BT nodes call
    playDead: async () => true,
    townTripIfCornered: async () => false,
    retreatToSafety: async () => {},
    settle: async () => {},
    takeSafeSpot: async () => false,
    breakOut: async () => ({ did: false }),
    provision: async () => 'full',
    declareInterest: () => {},
    cookSomething: async () => {},
    releaseHold: () => {},
    ...overrides,
  };
  return k;
}

function bb(keeper, overrides = {}) {
  return {
    session: keeper,
    client: keeper.s.client,
    policy: keeper.policy,
    room: { num: 100, name: 'Test Room' },
    _bt: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-bt-flee-test.mjs\n');

t('getFleeTree throws without a keeper', () => {
  let threw = false;
  try { getFleeTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getFleeTree returns a tree with tick and tickAsync', () => {
  const k = mockKeeper();
  const tree = getFleeTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick function');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync function');
});

t('doomedNode: FAILURE when no nearby hostiles', async () => {
  const k = mockKeeper({ _btFleeNear: () => [] });
  const node = doomedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('doomedNode: FAILURE when health is above doomedAt', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = doomedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('fleeThresholdNode: FAILURE when health is above fleeBelow', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = fleeThresholdNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('fleeThresholdNode: SUCCESS when below fleeBelow in the open', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    retreatToSafety: async () => {},
  });
  k.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = fleeThresholdNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('sanctuarySettleNode: FAILURE when not in a sanctuary', async () => {
  const k = mockKeeper({ sanctuary: () => false });
  const node = sanctuarySettleNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('getAWallNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = getAWallNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('vigorWalkNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = vigorWalkNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('leaveRoomNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = leaveRoomNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('restNode: FAILURE when in combat zone and not sheltered', async () => {
  const k = mockKeeper({
    _btFleeHostiles: () => [{ id: 2 }],
    holdWorks: () => false,
    hold: null,
  });
  const node = restNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('restNode: SUCCESS when safe and hurt', async () => {
  const k = mockKeeper({
    _btFleeHostiles: () => [],
    holdWorks: () => false,
    hold: null,
  });
  k.s.client.vitals = () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = restNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: rest wins when safe and hurt', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [],
    _btFleeHostiles: () => [],
    holdWorks: () => false,
    hold: null,
    sanctuary: () => false,
  });
  k.s.client.vitals = () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } });
  const tree = getFleeTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: doomed wins when very low health with nearby hostile', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    playDead: async () => true,
  });
  k.hold = { col: 10, row: 10 };
  k.holdWorks = () => true;
  k.s.client.vitals = () => ({ health: { value: 5, max: 36 }, vigor: { value: 140, max: 200 } });
  const tree = getFleeTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// ---------------------------------------------------------------------------

run();
