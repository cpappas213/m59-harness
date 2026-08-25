#!/usr/bin/env node
// m59-bt-gear-test.mjs -- tests for the BT gear upgrade node.
//
//   node tools/m59-bt-gear-test.mjs
//
// Offline tests. No broker, no server. They verify the gear upgrade node's
// logic: loadout parsing, missing-gear detection, town gating, purse gating,
// and the buy path.

import { gearUpgradeNode } from './m59-bt-gear.mjs';
import { loadoutFor } from './m59-loadout.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Helper: make a fake keeper
function makeKeeper({
  character = 'Lee',
  room = { name: 'Barloque', num: 100 },
  purse = 500,
  inventory = [],
  loadout = null,
  policy = { walkingMoney: 400, buyWeapons: true },
  sellerItems = [],
} = {}) {
  const notes = [];
  const pacerQueue = [];
  const keeper = {
    s: {
      client: {
        me: { name: character },
        inventory,
        evSeq: 1,
        requestInventory: async () => ({ ok: true }),
        waitFor: async () => ({ events: [] }),
        buyItems: async () => ({ ok: true }),
        buy: async () => ({ ok: true }),
      },
      credentials: { character },
      world: { room },
      pacer: {
        submit: async (kind, fn) => fn(),
      },
    },
    policy,
    note: (what, detail) => notes.push({ what, detail }),
    purseNow: () => purse,
    armed: () => false,   // default: unarmed
    sellerHere: async ({ want } = {}) => {
      if (!sellerItems.length) return null;
      return {
        seller: { id: 999, nameRsc: 'smith' },
        items: sellerItems.filter(i => !want || want.test(i.name)),
      };
    },
    _notes: notes,
  };
  return keeper;
}

// Helper: a blackboard with a room
function bb({ room = { name: 'Barloque', num: 100 } } = {}) {
  return { room };
}

console.log('\ngearUpgradeNode: no loadout → FAILURE');
{
  const keeper = makeKeeper({ character: 'Nobody' });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('returns FAILURE for unknown character', r === 'FAILURE');
}

console.log('\ngearUpgradeNode: fully stocked → FAILURE');
{
  // Loadout wants long sword, scale armor, gold round shield.
  // Inventory has all three.
  const keeper = makeKeeper({
    character: 'Lee',
    inventory: [
      { name: 'long sword', broken: false },
      { name: 'scale armor', broken: false },
      { name: 'gold round shield', broken: false },
    ],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('returns FAILURE when fully stocked', r === 'FAILURE');
  check('no notes', keeper._notes.length === 0);
}

console.log('\ngearUpgradeNode: missing gear + not in town → FAILURE');
{
  const keeper = makeKeeper({
    character: 'Lee',
    room: { name: 'Ilerian Woods', num: 557 },
    inventory: [{ name: 'mace', broken: false }],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb({ room: { name: 'Ilerian Woods', num: 557 } }));
  check('returns FAILURE when not in town', r === 'FAILURE');
  const deferNote = keeper._notes.find(n => n.what === 'missing gear, but not in a town');
  check('notes that gear is missing but not in town', !!deferNote);
  check('note lists missing items', deferNote.detail.missing.length > 0);
}

console.log('\ngearUpgradeNode: missing gear + in town + poor → FAILURE');
{
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 100,   // below the 400 walking-money floor + 100
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'mace', broken: false }],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('returns FAILURE when too poor', r === 'FAILURE');
  const poorNote = keeper._notes.find(n => n.what === 'missing gear, but not enough money');
  check('notes that there is not enough money', !!poorNote);
}

console.log('\ngearUpgradeNode: missing gear + in town + can afford → SUCCESS');
{
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 1000,
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'mace', broken: false }],
    sellerItems: [
      { name: 'long sword', id: 1, cost: 500 },
      { name: 'scale armor', id: 2, cost: 800 },
      { name: 'gold round shield', id: 3, cost: 300 },
    ],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('returns SUCCESS when it buys something', r === 'SUCCESS');
  const boughtNote = keeper._notes.find(n => n.what === 'bought gear');
  check('notes the purchase', !!boughtNote);
  check('bought an item', boughtNote.detail.item != null);
}

console.log('\ngearUpgradeNode: broken items are not stock');
{
  // Loadout wants long sword. Inventory has a broken long sword.
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 1000,
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'long sword', broken: true }],
    sellerItems: [{ name: 'long sword', id: 1, cost: 500 }],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  // The broken long sword should NOT count as stock, so the node should
  // try to buy a new one.
  check('treats broken item as missing', r === 'SUCCESS');
}

console.log('\ngearUpgradeNode: dynamic threshold - can afford a cheap weapon');
{
  // Lee has 124 shillings, floor is 400. He can't buy an 800-shilling scale armor,
  // but he CAN buy a 100-shilling mace if that's what's on the shelf and it's the
  // only missing item. 124 - 100 = 24, which is below the floor of 400, so the
  // per-item check `cost > purse - floor` → `100 > 124 - 400 = -276` → false. So he
  // CAN buy it (the floor is a hard floor, but 24 < 400 means he'd be below the floor
  // after the purchase).
  //
  // Wait: the check is `cost > purse - floor`. If purse=124, floor=400:
  //   purse - floor = 124 - 400 = -276
  //   cost (100) > -276 → true → skip.
  //
  // So he CAN'T buy it. The floor is a hard floor: you never drop below it.
  // With 124 shillings and a 400 floor, he can't buy ANYTHING.
  //
  // The dynamic threshold means: as his purse grows, the threshold drops.
  // At purse=500: 500-400=100, can buy a 100-shilling item.
  // At purse=900: 900-400=500, can buy a 500-shilling item.
  // At purse=1200: 1200-400=800, can buy an 800-shilling item.
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 124,
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'mace', broken: false }],
    sellerItems: [{ name: 'long sword', id: 1, cost: 100 }],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  // 124 - 400 = -276. 100 > -276 → true → can't afford.
  check('cannot buy when purse is below floor', r === 'FAILURE');
}

console.log('\ngearUpgradeNode: dynamic threshold - can afford at higher purse');
{
  // At purse=500: 500-400=100. A 100-shilling item: 100 > 100? No (not strictly greater).
  // So he CAN buy it.
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 500,
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'mace', broken: false }],
    sellerItems: [{ name: 'long sword', id: 1, cost: 100 }],
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('can buy when purse covers item + floor', r === 'SUCCESS');
}

console.log('\ngearUpgradeNode: no seller in town → FAILURE');
{
  const keeper = makeKeeper({
    character: 'Lee',
    purse: 1000,
    room: { name: 'Barloque', num: 100 },
    inventory: [{ name: 'mace', broken: false }],
    sellerItems: [],   // no seller
  });
  const node = gearUpgradeNode(keeper);
  const r = await node.tickAsync(bb());
  check('returns FAILURE when no seller', r === 'FAILURE');
  const noSellerNote = keeper._notes.find(n => n.what === 'missing gear, no seller here');
  check('notes that no seller is here', !!noSellerNote);
}

console.log('\ngearUpgradeNode: throttle - repeated not-in-town notes are throttled');
{
  const keeper = makeKeeper({
    character: 'Lee',
    room: { name: 'Ilerian Woods', num: 557 },
    inventory: [{ name: 'mace', broken: false }],
  });
  const node = gearUpgradeNode(keeper);
  const r1 = await node.tickAsync(bb({ room: { name: 'Ilerian Woods' } }));
  const count1 = keeper._notes.filter(n => n.what === 'missing gear, but not in a town').length;
  // Second tick within 60s should be throttled
  const r2 = await node.tickAsync(bb({ room: { name: 'Ilerian Woods' } }));
  const count2 = keeper._notes.filter(n => n.what === 'missing gear, but not in a town').length;
  check('first tick notes it', count1 === 1);
  check('second tick is throttled', count2 === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
