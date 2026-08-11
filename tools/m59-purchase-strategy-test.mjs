#!/usr/bin/env node
// Independent merchant purchase permissions, offline. No broker or server.

import assert from 'node:assert/strict';
import { purchaseEnabled } from './m59-autopilot.mjs';

for (const kind of ['food', 'weapons', 'reagents']) {
  assert.equal(purchaseEnabled({}, kind), true,
    `${kind} purchasing preserves the historical enabled default`);
}
assert.equal(purchaseEnabled({ buyFood: false }, 'food'), false);
assert.equal(purchaseEnabled({ buyWeapons: false }, 'weapons'), false);
assert.equal(purchaseEnabled({ buyReagents: false }, 'reagents'), false);
assert.equal(purchaseEnabled({ buyFood: false, buyWeapons: false, buyReagents: true }, 'reagents'), true,
  'one disabled purchase class does not disable another');

console.log('m59-purchase-strategy-test: 7 passed');
