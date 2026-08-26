#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countRecentDeaths, readRecentDeaths } from './m59-death-tally.mjs';

const now = Date.parse('2026-08-26T12:30:00Z');
const records = [
  { character: 'Clifford', at: now - 60_000, reason: 'died',
    where: { room: 'Upstairs', num: 39, col: 16, row: 4 },
    vitals: { level: 58, last_health: 2 }, was: { hunting: 'battered skeleton', in_safe_spot: false } },
  { character: 'Clifford', at: now - 120_000,
    where: { room: 'Upstairs', num: 39 },
    was: { in_safe_spot: { proven: true } } },
  { character: 'Zoot', at: now - 30_000, where: { room: 'Upstairs', num: 39 },
    was: { in_safe_spot: { proven: false } } },
  { character: 'Old', at: now - 25 * 60 * 60_000 },
  { character: '', at: now - 1 },
];

const by = countRecentDeaths(records, { now });
assert.equal(by.get('Clifford').count, 2);
assert.equal(by.get('Clifford').in_safe_spot, 1);
assert.equal(by.get('Clifford').in_proven_safe_spot, 1);
assert.equal(by.get('Clifford').last.col, 16);
assert.equal(by.get('Zoot').count, 1);
assert.equal(by.has('Old'), false);

const dir = mkdtempSync(join(tmpdir(), 'm59-deaths-'));
writeFileSync(join(dir, 'one.json'), JSON.stringify(records[0]));
writeFileSync(join(dir, 'broken.json'), '{');
writeFileSync(join(dir, 'ignore.txt'), JSON.stringify(records[1]));
assert.equal(readRecentDeaths(dir, { now }).get('Clifford').count, 1);

console.log('m59-death-tally-test: 8/8');
