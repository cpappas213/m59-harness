#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRooFileBounded } from './m59-roo.mjs';

const directory = mkdtempSync(join(tmpdir(), 'm59-roo-bounded-'));
try {
  const file = join(directory, 'fixture.roo');
  writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual([...readRooFileBounded(file, 4)], [1, 2, 3, 4]);
  assert.throws(() => readRooFileBounded(file, 3), /exceeds the 3-byte ROO ceiling/);
  assert.throws(() => readRooFileBounded(file, 0), /ROO read ceiling/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('m59 bounded ROO file read: PASS');
