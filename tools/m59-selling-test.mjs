#!/usr/bin/env node
// Merchant equipment retention, offline. No broker or server.

import assert from 'node:assert/strict';
import { merchantEquipmentPlan } from './m59-skills.mjs';

const client = (names, using = new Set()) => ({
  inventory: names.map((name, i) => ({ id: i + 1, nameRsc: i + 1, amount: 1 })),
  rsc: new Map(names.map((name, i) => [i + 1, name])),
  using,
  statsById: new Map(),
});

{
  const c = client([
    'hammer', 'mace', 'axe', 'long sword',
    'leather armor', 'chain mail',
    'small round shield', 'knight shield',
  ], new Set([1, 5]));
  const p = merchantEquipmentPlan(c, {
    maxWeapons: 2,
    weaponPriority: ['hammer', 'mace', 'axe', 'sword'],
  });
  assert.equal(p.verified, true);
  assert.deepEqual([...p.keep.keys()].filter(id => id <= 4), [1, 2],
    'equipped hammer plus the best spare fit under max_weapons=2');
  assert.deepEqual([...p.sell.keys()].filter(id => id <= 4), [3, 4],
    'every weapon beyond the cap is sold');
  assert.equal(p.sell.has(6), true, 'unworn body armour is surplus when body is equipped');
  assert.equal(p.keep.has(8), true, 'the best shield is retained for an empty shield slot');
  assert.equal(p.sell.has(7), true, 'inferior armour for the same empty slot is sold');
}

{
  const c = client(['leather armor', 'plate armor'], new Set());
  const p = merchantEquipmentPlan(c, { maxWeapons: 2 });
  assert.equal(p.keep.has(1), true, 'a naked character keeps its best usable future body piece');
  assert.equal(p.sell.has(2), true, 'it does not keep every spare body piece merely because it is naked');
}

{
  const c = client(['hammer', 'mace', 'leather armor'], null);
  delete c.using;
  const p = merchantEquipmentPlan(c, { maxWeapons: 1 });
  assert.equal(p.verified, false);
  assert.equal(p.sell.size, 0, 'unknown server equipment state never causes a forced gear sale');
}

console.log('m59-selling-test: 9 passed');
