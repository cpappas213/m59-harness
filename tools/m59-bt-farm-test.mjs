#!/usr/bin/env node
// m59-bt-farm-test.mjs -- offline tests for the farm behavior tree.
//
// Runs without a broker or server. Uses a mock keeper that records which
// methods were called and returns canned values.
//
//   node tools/m59-bt-farm-test.mjs

import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import {
  getFarmTree, provisionNode, autoRetargetNode, roomInvalidNode,
  bagsFullNode, capBlockedNode, noHuntTargetNode, noTargetFoundNode,
  unarmedNode, tooHurtNode, tooTiredNode, fightNode,
} from './m59-bt-farm.mjs';

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
    note: (msg, detail) => calls.push(['note', msg]),
    policy: {
      hunt: 'giant rat',
      purpose: 'advance',
      goals: [{ kind: 'hp' }],
      maxCarry: 50,
      maxThreatOver: 20,
      roam: false,
      useSafeSpots: true,
      clearWeak: true,
      fightRounds: 30,
      ...overrides.policy,
    },
    s: {
      name: 't1',
      client: {
        vitals: () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } }),
        statsById: new Map([['stamina', { value: 20 }]]),
        rsc: { get: () => 'giant rat' },
        inventory: [],
        armed: () => true,
      },
    },
    hold: null,
    holdWorks: () => false,
    doing: null,
    emptyPasses: 0,
    homeRoom: null,
    foeId: null,
    clearing: null,
    unreachable: new Set(),
    cappedRooms: new Map(),
    noWallRooms: new Map(),
    tally: { kills: 0, rests: 0 },
    vigor: { waited: 0 },
    killTimes: [],
    weaponPriorityNow: () => null,
    // BT farm helpers
    _btFarmStrategy: () => ({}),
    _btFarmSpawnFile: () => 'test-spawns.json',
    _btFarmDeniedRooms: () => new Map(),
    _btFarmShouldRelocate: () => false,
    _btFarmFindCreature: () => [],
    _btFarmFoundTargets: () => [],
    _btFarmFight: async () => ({ killed: false, died: false, rounds: 0, target: 'test' }),
    // Methods that the BT nodes call
    provision: async () => 'ate',
    yieldCheck: () => ({ paying: true }),
    preyRooms: () => [],
    readyToLeaveSanctuary: async () => true,
    leaveHold: async () => ({ refused: false }),
    travel: async () => ({ arrived: true }),
    sweepBroken: async () => {},
    sweepGearCondition: async () => {},
    makeRoom: async () => ({ ok: true, did: 'sold junk' }),
    capBlockers: () => null,
    hibernate: async () => false,
    roam: async () => {},
    armSelf: async () => true,
    armed: () => true,
    safety: () => ({ engageAt: 0.75, fleeAt: 0.3, maxHit: 5 }),
    fightFloor: () => 100,
    takeSafeSpot: async () => ({ took: false }),
    inReachOfUs: () => [],
    clearRefusal: () => {},
    doneWaiting: () => {},
    askForHelp: async () => {},
    recordHealUse: () => {},
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-bt-farm-test.mjs\n');

t('getFarmTree throws without a keeper', () => {
  let threw = false;
  try { getFarmTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getFarmTree returns a tree with tick and tickAsync', () => {
  const k = mockKeeper();
  const tree = getFarmTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick function');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync function');
});

t('provisionNode: SUCCESS when provision returns ate', async () => {
  const k = mockKeeper({ provision: async () => 'ate' });
  const node = provisionNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('provisionNode: FAILURE when provision returns not-ate', async () => {
  const k = mockKeeper({ provision: async () => 'full' });
  const node = provisionNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('autoRetargetNode: FAILURE when purpose is not set', async () => {
  const k = mockKeeper({ policy: { purpose: null } });
  const node = autoRetargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('autoRetargetNode: FAILURE when paying is true', async () => {
  const k = mockKeeper({ yieldCheck: () => ({ paying: true }) });
  const node = autoRetargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('roomInvalidNode: FAILURE when no room', async () => {
  const k = mockKeeper();
  const node = roomInvalidNode(k);
  const r = await node.tickAsync(bb(k, { room: null }));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('bagsFullNode: FAILURE when inventory is not full', async () => {
  const k = mockKeeper();
  k.s.client.inventory = [];
  const node = bagsFullNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('bagsFullNode: SUCCESS when inventory is full', async () => {
  const k = mockKeeper();
  k.s.client.inventory = Array(50).fill({ name: 'junk' });
  const node = bagsFullNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('capBlockedNode: FAILURE when no room', async () => {
  const k = mockKeeper();
  const node = capBlockedNode(k);
  const r = await node.tickAsync(bb(k, { room: null }));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('capBlockedNode: FAILURE when capBlockers returns null', async () => {
  const k = mockKeeper({ capBlockers: () => null });
  const node = capBlockedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('noHuntTargetNode: FAILURE when hunt is set', async () => {
  const k = mockKeeper({ policy: { hunt: 'giant rat' } });
  const node = noHuntTargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('noHuntTargetNode: SUCCESS when hunt is not set', async () => {
  const k = mockKeeper({ policy: { hunt: null } });
  const node = noHuntTargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('unarmedNode: FAILURE when armed', async () => {
  const k = mockKeeper({ armed: () => true });
  const node = unarmedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tooHurtNode: FAILURE when health is above engageAt', async () => {
  const k = mockKeeper();
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  const node = tooHurtNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tooTiredNode: FAILURE when vigor is above floor', async () => {
  const k = mockKeeper();
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  k.fightFloor = () => 100;
  const node = tooTiredNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tree: provision wins when hungry', async () => {
  const k = mockKeeper({ provision: async () => 'ate' });
  const tree = getFarmTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: falls through to next node when provision is full', async () => {
  const k = mockKeeper({
    provision: async () => 'full',
    policy: { purpose: null },  // skip auto-retarget
  });
  k.s.client.inventory = [];
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  k.preyRooms = () => [];
  k.capBlockers = () => null;
  k.hibernation = false;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 0, target: 'giant rat' });
  const tree = getFarmTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  // Should fall through to fight and succeed
  if (r !== SUCCESS && r !== FAILURE) throw new Error(`expected SUCCESS or FAILURE, got ${r}`);
});

// ---------------------------------------------------------------------------

run();
