#!/usr/bin/env node
// m59-bt-town-test.mjs -- tests for the BT town business nodes.

import assert from 'node:assert';
import { getTownTree, inBankNode, shouldTripNode, travelToTownNode, doTownBusinessNode, returnHomeNode } from './m59-bt-town.mjs';
import { FAILURE, SUCCESS, RUNNING } from './m59-bt.mjs';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

function mockKeeper(overrides = {}) {
  return {
    s: {
      live: true,
      client: {
        self: { health: 30, maxHealth: 30 },
        inventory: [],
        rsc: { get: (id) => {
          const map = { shilling: 'shilling', mushroom: 'red mushroom' };
          return map[id] || '';
        }},
        room: { objects: new Map() },
        vitals: () => ({ vigor: { value: 150 } }),
      },
      world: { room: { num: 100, name: 'Test Room' }, route: () => ({ found: true, hops: [100, 2003] }) },
      bankKnown: () => ({ balance: 1000 }),
      pacer: { submit: async (l, fn) => fn() },
    },
    policy: { bankAbove: 500, walkingMoney: 400, assignedRoom: 100, buyFood: true, hungryFloor: 100 },
    note: () => {},
    bankSurplus: async () => {},
    bankRun: async () => false,
    reagentCount: () => ({ elderberry: 0, herbs: 0 }),
    larder: () => [],
    travelToRoom: async (room) => ({ arrived: room === 2003 }),
    restockInTown: async () => {},
    buyFoodInTown: async () => {},
    loadout: () => ({ protect: [] }),
    itemValue: (name, amount) => 0,
    armed: () => true,
    deliveryCashReserve: () => 0,
    progress: () => {},
    tally: {},
    doing: '',
    _bankRunDoTownBusiness: async () => {},
    bankTripAt: 0,
    sellTripAt: 0,
    foodTripAt: 0,
    constructor: { _combatSkills: {} },
    ...overrides,
  };
}

// ─── in_bank tests ─────────────────────────────────────────────────────────────

await check('in_bank: not in a bank returns FAILURE', async () => {
  const k = mockKeeper();
  const node = inBankNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('in_bank: in a bank with surplus returns SUCCESS', async () => {
  const k = mockKeeper({
    s: {
      ...mockKeeper().s,
      world: { room: { num: 2003, name: 'First Royal Bank of Tos' } },
      client: {
        ...mockKeeper().s.client,
        inventory: [{ nameRsc: 'shilling', amount: 1000 }],
      },
    },
  });
  // The client needs a deposit method
  k.s.client.deposit = async () => {};
  k.s.client.waitFor = async () => ({ events: [] });
  k.s.client.requestInventory = async () => {};
  const node = inBankNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, SUCCESS);
});

await check('in_bank: in a bank with no surplus returns FAILURE', async () => {
  const k = mockKeeper({
    s: {
      ...mockKeeper().s,
      world: { room: { num: 2003, name: 'First Royal Bank of Tos' } },
      client: {
        ...mockKeeper().s.client,
        inventory: [{ nameRsc: 'shilling', amount: 100 }],
      },
    },
  });
  k.s.client.deposit = async () => {};
  k.s.client.waitFor = async () => ({ events: [] });
  k.s.client.requestInventory = async () => {};
  const node = inBankNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('in_bank: not live returns FAILURE', async () => {
  const k = mockKeeper({ s: { live: false, client: null, world: null } });
  const node = inBankNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// ─── should_trip tests ─────────────────────────────────────────────────────────

await check('should_trip: bankAbove=0 returns FAILURE', async () => {
  const k = mockKeeper({ policy: { bankAbove: 0 } });
  const node = shouldTripNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('should_trip: already in a bank returns FAILURE', async () => {
  const k = mockKeeper({
    s: { ...mockKeeper().s, world: { room: { num: 2003, name: 'First Royal Bank of Tos' } } },
  });
  const node = shouldTripNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('should_trip: active trip returns FAILURE', async () => {
  const k = mockKeeper();
  const node = shouldTripNode(k);
  const bb = { _trip: { state: 'travelling', destination: { room: 2003 } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, FAILURE);
});

await check('should_trip: low carried, no triggers returns FAILURE', async () => {
  const k = mockKeeper({
    larder: () => [{ food: { nutrition: 100 }, o: { amount: 1 } }],
  });
  k.s.client.inventory = [{ nameRsc: 'shilling', amount: 100 }];
  const node = shouldTripNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('should_trip: carried > bankAbove returns SUCCESS', async () => {
  const k = mockKeeper({
    larder: () => [{ food: { nutrition: 100 }, o: { amount: 1 } }],
  });
  k.s.client.inventory = [{ nameRsc: 'shilling', amount: 600 }];
  const node = shouldTripNode(k);
  const bb = {};
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip.state, 'travelling');
  assert.strictEqual(bb._trip.reason, 'bank');
});

await check('should_trip: on bank cooldown returns FAILURE', async () => {
  const k = mockKeeper({
    larder: () => [{ food: { nutrition: 100 }, o: { amount: 1 } }],
    bankTripAt: Date.now(),
  });
  k.s.client.inventory = [{ nameRsc: 'shilling', amount: 600 }];
  const node = shouldTripNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// ─── travel_to_town tests ──────────────────────────────────────────────────────

await check('travel_to_town: no trip returns FAILURE', async () => {
  const k = mockKeeper();
  const node = travelToTownNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('travel_to_town: already at destination returns SUCCESS', async () => {
  const k = mockKeeper();
  const node = travelToTownNode(k);
  const bb = { _trip: { state: 'travelling', destination: { room: 100, name: 'Test' } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip.state, 'in_town');
});

await check('travel_to_town: travel succeeds returns SUCCESS', async () => {
  const k = mockKeeper();
  const node = travelToTownNode(k);
  const bb = { _trip: { state: 'travelling', destination: { room: 2003, name: 'Bank' } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip.state, 'in_town');
});

await check('travel_to_town: travel fails clears trip', async () => {
  const k = mockKeeper({
    travelToRoom: async () => ({ arrived: false, reason: 'no route' }),
  });
  const node = travelToTownNode(k);
  const bb = { _trip: { state: 'travelling', destination: { room: 9999, name: 'Nowhere' } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, FAILURE);
  assert.strictEqual(bb._trip, null);
});

// ─── do_town_business tests ────────────────────────────────────────────────────

await check('do_town_business: not in town returns FAILURE', async () => {
  const k = mockKeeper();
  const node = doTownBusinessNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('do_town_business: in town returns SUCCESS', async () => {
  const k = mockKeeper();
  const node = doTownBusinessNode(k);
  const bb = { _trip: { state: 'in_town', destination: { room: 2003 } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip.state, 'returning');
});

// ─── return_home tests ─────────────────────────────────────────────────────────

await check('return_home: not returning returns FAILURE', async () => {
  const k = mockKeeper();
  const node = returnHomeNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('return_home: already home clears trip', async () => {
  const k = mockKeeper();
  const node = returnHomeNode(k);
  const bb = { _trip: { state: 'returning', destination: { room: 2003 } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip, null);
});

await check('return_home: travel back returns SUCCESS', async () => {
  const k = mockKeeper({
    travelToRoom: async (room) => ({ arrived: room === 100 }),
  });
  const node = returnHomeNode(k);
  const bb = { _trip: { state: 'returning', destination: { room: 2003 } } };
  const r = await node.tickAsync(bb);
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(bb._trip, null);
});

// ─── full tree tests ───────────────────────────────────────────────────────────

await check('tree: not in bank, no trip needed returns FAILURE', async () => {
  const k = mockKeeper({
    larder: () => [{ food: { nutrition: 100 }, o: { amount: 1 } }],
  });
  const tree = getTownTree(k);
  const r = await tree.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

await check('tree: in a bank with surplus returns SUCCESS', async () => {
  const k = mockKeeper({
    s: {
      ...mockKeeper().s,
      world: { room: { num: 2003, name: 'First Royal Bank of Tos' } },
      client: {
        ...mockKeeper().s.client,
        inventory: [{ nameRsc: 'shilling', amount: 1000 }],
      },
    },
  });
  k.s.client.deposit = async () => {};
  k.s.client.waitFor = async () => ({ events: [] });
  k.s.client.requestInventory = async () => {};
  const tree = getTownTree(k);
  const r = await tree.tickAsync({});
  assert.strictEqual(r, SUCCESS);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
