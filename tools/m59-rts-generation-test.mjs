#!/usr/bin/env node
import assert from 'node:assert/strict';
import { RtsGenerationClock } from './m59-rts-generation.mjs';

const clock = new RtsGenerationClock();
assert.deepEqual(clock.next(1000, 42),
  { observed_at: '1970-01-01T00:00:01.000Z', sequence: '1000-42' });
assert.deepEqual(clock.next(1000, 42),
  { observed_at: '1970-01-01T00:00:01.001Z', sequence: '1001-42' },
  'two complete reads captured in one millisecond have distinct generations');
assert.deepEqual(clock.next(999, 42),
  { observed_at: '1970-01-01T00:00:01.002Z', sequence: '1002-42' },
  'a wall-clock rollback cannot reuse a prior generation');
assert.deepEqual(clock.next(2000, 42),
  { observed_at: '1970-01-01T00:00:02.000Z', sequence: '2000-42' });

for (const [at, pid] of [[-1, 42], [1.5, 42], [1, 0], [1, Number.MAX_SAFE_INTEGER + 1]])
  assert.throws(() => new RtsGenerationClock().next(at, pid));

console.log('m59 RTS monotonic generation clock: PASS');
