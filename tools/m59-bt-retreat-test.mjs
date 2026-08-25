#!/usr/bin/env node
// m59-bt-retreat-test.mjs -- offline tests for the retreat/withdraw BT.
//
//   node tools/m59-bt-retreat-test.mjs

import {
  getRetreatTree, getWithdrawTree, Fallback,
  alreadySafeNode, quietRetreatNode, sanctuaryNode,
  travelRefugeNode, localWallNode, takeWallNode, walkAwayNode,
} from './m59-bt-retreat.mjs';

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
    policy: { mode: 'farm', hunt: 'giant rat' },
    s: {
      name: 't1',
      client: {
        vitals: () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } }),
        self: { col: 10, row: 10 },
        selfId: 1,
        room: { objects: new Map() },
        rsc: { get: () => 'giant rat' },
      },
      world: {
        room: { num: 100 },
        exits: () => [],
        route: (to) => ({ hops: [100, 101, to] }),
        geometry: {
          rows: 20, cols: 20,
          walkable: () => true,
          path: () => ({ found: true, steps: [] }),
        },
      },
      walkTo: async () => ({ steps: 5, arrived: true }),
    },
    hold: null,
    holdWorks: () => false,
    doing: null,
    tally: { withdrawals_to_a_wall: 0 },
    fledInARow: 0,
    // BT helpers
    inReachOfUs: () => [],
    takeSafeSpot: async () => ({ took: false }),
    withdraw: async () => {},
    travel: async () => ({ arrived: false }),
    leaveHold: async () => {},
    // Constructor constants
    constructor: {
      CITY_INNS: { victoria: { inn: 2, name: 'Victoria Inn' } },
      PREFERRED_QUIET_RETREATS: {},
      preferredQuietRetreat: (world, opts) => null,
    },
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

console.log('m59-bt-retreat-test.mjs\n');

// --- Fallback node ---

t('Fallback: returns SUCCESS when first child succeeds', async () => {
  const { SUCCESS, FAILURE } = await import('./m59-bt.mjs');
  const child1 = { tick: () => SUCCESS };
  const child2 = { tick: () => FAILURE };
  const fb = { tick: () => SUCCESS };
  const node = new Fallback([child1, child2], fb);
  const r = node.tick({});
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('Fallback: returns SUCCESS when second child succeeds', async () => {
  const { SUCCESS, FAILURE } = await import('./m59-bt.mjs');
  const child1 = { tick: () => FAILURE };
  const child2 = { tick: () => SUCCESS };
  const fb = { tick: () => SUCCESS };
  const node = new Fallback([child1, child2], fb);
  const r = node.tick({});
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('Fallback: returns fallback result when all children fail', async () => {
  const { SUCCESS, FAILURE } = await import('./m59-bt.mjs');
  const child1 = { tick: () => FAILURE };
  const child2 = { tick: () => FAILURE };
  const fb = { tick: () => SUCCESS };
  const node = new Fallback([child1, child2], fb);
  const r = node.tick({});
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS from fallback, got ${r}`);
});

t('Fallback: returns FAILURE when all children fail and no fallback', async () => {
  const { SUCCESS, FAILURE } = await import('./m59-bt.mjs');
  const child1 = { tick: () => FAILURE };
  const node = new Fallback([child1], null);
  const r = node.tick({});
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

// --- already_safe ---

t('alreadySafeNode: FAILURE when no hold', async () => {
  const k = mockKeeper({ hold: null, holdWorks: () => false });
  const node = alreadySafeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('alreadySafeNode: SUCCESS when holding a working spot', async () => {
  const k = mockKeeper({
    hold: { col: 10, row: 10 },
    holdWorks: () => true,
  });
  const node = alreadySafeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- quiet_retreat ---

t('quietRetreatNode: FAILURE when not in a quiet retreat', async () => {
  const k = mockKeeper();
  k.s.world.room.num = 999; // not a quiet retreat
  const node = quietRetreatNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('quietRetreatNode: SUCCESS when in a quiet retreat', async () => {
  const k = mockKeeper();
  k.s.world.room.num = 500;
  k.constructor.PREFERRED_QUIET_RETREATS = { cv_upstairs: { room: 500, name: 'CV Upstairs' } };
  const node = quietRetreatNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- sanctuary ---

t('sanctuaryNode: FAILURE when not in an inn', async () => {
  const k = mockKeeper();
  k.s.world.room.num = 999; // not an inn
  const node = sanctuaryNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('sanctuaryNode: SUCCESS when in an inn', async () => {
  const k = mockKeeper();
  k.s.world.room.num = 2; // Victoria Inn
  const node = sanctuaryNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- travel_refuge ---

t('travelRefugeNode: SUCCESS when travel succeeds', async () => {
  const k = mockKeeper({
    travel: async () => ({ arrived: true }),
  });
  const node = travelRefugeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('travelRefugeNode: FAILURE when travel fails', async () => {
  const k = mockKeeper({
    travel: async () => ({ arrived: false }),
    world_route: null,
  });
  k.s.world.route = (to) => ({ hops: null }); // no route
  const node = travelRefugeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

// --- local_wall ---

t('localWallNode: calls withdraw', async () => {
  let called = false;
  const k = mockKeeper({
    withdraw: async () => { called = true; },
  });
  const node = localWallNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
  if (!called) throw new Error('expected withdraw to be called');
});

// --- take_wall ---

t('takeWallNode: FAILURE when takeSafeSpot fails', async () => {
  const k = mockKeeper({ takeSafeSpot: async () => ({ took: false }) });
  const node = takeWallNode(k);
  const r = await node.tickAsync(bb(k), [{ id: 2, col: 5, row: 5 }]);
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('takeWallNode: SUCCESS when takeSafeSpot succeeds', async () => {
  const k = mockKeeper({ takeSafeSpot: async () => ({ took: true }) });
  k.hold = { col: 12, row: 8 };
  const node = takeWallNode(k);
  const r = await node.tickAsync(bb(k), [{ id: 2, col: 5, row: 5 }]);
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- walk_away ---

t('walkAwayNode: FAILURE when no geometry', async () => {
  const k = mockKeeper();
  k.s.world.geometry = null;
  const node = walkAwayNode(k);
  const r = await node.tickAsync(bb(k), [{ id: 2, col: 5, row: 5 }]);
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

// --- Trees ---

t('getRetreatTree: throws without a keeper', () => {
  let threw = false;
  try { getRetreatTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getRetreatTree: returns a tree', () => {
  const k = mockKeeper();
  const tree = getRetreatTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync');
});

t('getWithdrawTree: throws without a keeper', () => {
  let threw = false;
  try { getWithdrawTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getWithdrawTree: returns a tree', () => {
  const k = mockKeeper();
  const tree = getWithdrawTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync');
});

t('retreat tree: already_safe wins when holding a working spot', async () => {
  const k = mockKeeper({
    hold: { col: 10, row: 10 },
    holdWorks: () => true,
  });
  const tree = getRetreatTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
  // Should have called note('staying behind the wall...')
  const notes = k.calls.filter(c => c[0] === 'note').map(c => c[1]);
  if (!notes.some(n => /staying behind/.test(n)))
    throw new Error('expected "staying behind the wall" note');
});

t('retreat tree: falls through to travel when not in sanctuary', async () => {
  const k = mockKeeper({
    hold: null,
    holdWorks: () => false,
    travel: async () => ({ arrived: true }),
  });
  k.s.world.room.num = 100; // not a sanctuary
  k.constructor.PREFERRED_QUIET_RETREATS = {};
  const tree = getRetreatTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// ---------------------------------------------------------------------------

run();
