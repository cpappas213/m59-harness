#!/usr/bin/env node
// m59-bt-recover-test.mjs -- tests for the post-death loot recovery node.

import assert from 'node:assert';
import { lootRecoveryNode } from './m59-bt-recover.mjs';
import { FAILURE, SUCCESS, RUNNING } from './m59-bt.mjs';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

function mockKeeper(overrides = {}) {
  return {
    lastDeath: null,
    _recoveredDeathAt: null,
    _recoverNotReadyNotedAt: null,
    _recoverTravelFailNotedAt: null,
    policy: { assignedRoom: 557 },
    s: { live: true, client: { self: { health: 30, maxHealth: 30 } }, world: { room: { num: 100 } } },
    note: () => {},
    travelToRoom: async () => ({ arrived: true }),
    _pickUpDropped: async () => ['mace', 'shilling x200'],
    ...overrides,
  };
}

// 1. No death: FAILURE.
await checkAsync('no death returns FAILURE', async () => {
  const k = mockKeeper();
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 2. Old death (>30 min): FAILURE.
await checkAsync('old death returns FAILURE', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 31 * 60 * 1000, room_num: 563 },
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 3. Already recovered: FAILURE.
await checkAsync('already recovered returns FAILURE', async () => {
  const at = Date.now() - 5 * 60 * 1000;
  const k = mockKeeper({
    lastDeath: { at, room_num: 563 },
    _recoveredDeathAt: at,
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 4. Low HP: FAILURE (waiting).
await checkAsync('low HP returns FAILURE', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: 563 },
    s: { live: true, client: { self: { health: 10, maxHealth: 30 } }, world: { room: { num: 100 } } },
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 5. No death room: FAILURE.
await checkAsync('no death room returns FAILURE', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: null },
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 6. Already in death room: picks up items.
await checkAsync('in death room picks up items', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: 100, died_in: 'Test Room' },
    s: { live: true, client: { self: { health: 30, maxHealth: 30 } }, world: { room: { num: 100 } } },
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  // _pickUpDropped returns items, so the node should return the picked items (truthy)
  assert.notStrictEqual(r, FAILURE);
});

// 7. Travel to death room: SUCCESS with items.
await checkAsync('travels to death room and picks up', async () => {
  const calls = [];
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: 563, died_in: 'Source of the River Ille' },
    s: { live: true, client: { self: { health: 30, maxHealth: 30 } }, world: { room: { num: 100 } } },
    travelToRoom: async (room) => { calls.push(room); return { arrived: true }; },
    _pickUpDropped: async () => ['mace', 'shilling x200'],
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, SUCCESS);
  assert.strictEqual(calls[0], 563);   // first call is to the death room
});

// 8. Travel fails: FAILURE.
await checkAsync('travel failure returns FAILURE', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: 563 },
    s: { live: true, client: { self: { health: 30, maxHealth: 30 } }, world: { room: { num: 100 } } },
    travelToRoom: async () => ({ arrived: false, reason: 'no route' }),
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

// 9. Nothing to pick up: FAILURE (marks as recovered).
await checkAsync('nothing to pick up marks recovered', async () => {
  const at = Date.now() - 2 * 60 * 1000;
  const k = mockKeeper({
    lastDeath: { at, room_num: 563, died_in: 'Test Room' },
    s: { live: true, client: { self: { health: 30, maxHealth: 30 } }, world: { room: { num: 100 } } },
    travelToRoom: async () => ({ arrived: true }),
    _pickUpDropped: async () => [],
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
  assert.strictEqual(k._recoveredDeathAt, at);
});

// 10. Not in game: FAILURE.
await checkAsync('not in game returns FAILURE', async () => {
  const k = mockKeeper({
    lastDeath: { at: Date.now() - 2 * 60 * 1000, room_num: 563 },
    s: { live: false, client: null, world: null },
  });
  const node = lootRecoveryNode(k);
  const r = await node.tickAsync({});
  assert.strictEqual(r, FAILURE);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
