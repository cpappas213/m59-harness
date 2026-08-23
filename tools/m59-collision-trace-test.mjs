#!/usr/bin/env node
// THE MOVEMENT TRACER IS OFF, AND THIS IS WHAT KEEPS IT OFF.
//
//   node tools/m59-collision-trace-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// WHAT THIS GUARDS, AND WHY IT IS A TEST RATHER THAN A CONVENTION. `m59-collision-trace.mjs`
// writes one line per move attempt. Twenty-one characters crossing the map produce thousands
// a minute, and the write sits inside `Session.step` — the tightest loop in the harness, the
// one whose cost is measured in whether a character outruns what is chewing on it.
//
// It is meant to be switched on in the ENVIRONMENT, for one run, while somebody is watching:
//
//   M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 --dashboard 8972
//   node tools/m59-collision-trace.mjs
//
// The failure this exists to prevent is the ordinary one: somebody debugging flips the
// default in the source to save typing, it works, and it gets committed. Nothing would fail,
// nothing would look wrong, and every fleet from then on would pay for an instrument nobody
// was reading. So the DEFAULT is asserted, not trusted — turning it on has to be a thing you
// do to a shell, and it cannot be done to the repository.
//
// It should fail the day the trace is left on.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A SCRATCH PATH, AND IT MUST BE SET BEFORE THE TRACER IS IMPORTED — which it is, because
// the tracer is only ever loaded by the dynamic `import()` further down.
//
// Proving "off writes nothing" means deleting the file first and checking it does not come
// back. Pointed at the fleet's own trace, that deletes a capture that is IN PROGRESS: it
// happened mid-run and took the movement record of a fleet crossing with it. Same pattern
// m59-collision-test.mjs already uses for the tactics and crossings books.
process.env.M59_COLLISION_TRACE_FILE =
  join(tmpdir(), `m59-collision-trace-test-${process.pid}.jsonl`);

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
let freshImport = 0;
const enabledTracer = async (traceFile, pendingMax, maxLines = 100) => {
  process.env.M59_COLLISION_TRACE = '1';
  process.env.M59_COLLISION_TRACE_FILE = traceFile;
  process.env.M59_COLLISION_TRACE_MAX = String(maxLines);
  process.env.M59_COLLISION_TRACE_PENDING_MAX = String(pendingMax);
  return import(`./m59-collision-trace.mjs?enabled=${process.pid}-${++freshImport}`);
};
const readRows = traceFile => readFileSync(traceFile, 'utf8').split('\n')
  .filter(Boolean).map(line => JSON.parse(line));

const SRC = readFileSync(join(HERE, 'm59-collision-trace.mjs'), 'utf8');
// THE SESSION MOVED. queueValidatedMove lives in m59-game.mjs in this checkout -- the
// keeper split took it out of the broker so a keeper process need not load the gateway.
// Upstream still has it in the broker, so this path is one of the few places our
// architecture is visible to a test of theirs. Same fix as m59-collision-test's, and the
// same failure shape: a suite bound to which FILE code lives in goes quiet when it moves.
const BROKER = readFileSync(join(HERE, 'm59-game.mjs'), 'utf8');

console.log('');
console.log('the default is off, in the source');
{
  // Asserted against the SOURCE rather than the imported value, because this process could
  // itself be running with the variable set — a test that reads its own environment would
  // pass or fail on how it happened to be invoked, which is not a fact about the repository.
  const line = SRC.split('\n').find(l => /export const COLLISION_TRACE\s*=/.test(l)) ?? '';
  ok('COLLISION_TRACE is declared', !!line, JSON.stringify(line));
  ok('and it is decided by the ENVIRONMENT, not by a literal in the file',
     /process\.env\.M59_COLLISION_TRACE\s*===\s*'1'/.test(line), JSON.stringify(line));
  // The two ways it gets left on: `= true`, or an env test with a truthy fallback.
  ok('it is not hardcoded true', !/export const COLLISION_TRACE\s*=\s*true/.test(SRC));
  ok('and there is no default that makes an unset variable mean ON',
     !/M59_COLLISION_TRACE\s*(\?\?|\|\|)\s*(1|'1'|true)/.test(SRC), 'a fallback would switch it on everywhere');
}

console.log('');
console.log('and with it off, tracing costs nothing and writes nothing');
{
  // Imported fresh with the variable explicitly cleared, so this is the real function.
  delete process.env.M59_COLLISION_TRACE;
  const mod = await import('./m59-collision-trace.mjs?off=' + Date.now());
  ok('COLLISION_TRACE reads false with the variable unset', mod.COLLISION_TRACE === false);
  // The point is that it returns before touching the filesystem. If it did not, this would
  // create the trace file as a side effect of running the test suite.
  let threw = null;
  try { mod.traceMove({ agent: 'nobody', room: 1, sent: false, reason: 'test' }); }
  catch (e) { threw = e.message; }
  ok('traceMove is a silent no-op rather than a throw', threw === null, String(threw));
  // Cleared FIRST, then asserted. Reading a file a previous run may have left behind makes
  // this assert on the machine's history rather than on the code, and it fails in the
  // confusing direction — the guard looks broken when what actually happened is that it
  // worked earlier. Found by flipping the default on to check this suite catches it: the
  // flipped run wrote a line, and the restored run then failed on the leftover.
  const { existsSync, unlinkSync } = await import('node:fs');
  if (existsSync(mod.TRACE_FILE)) unlinkSync(mod.TRACE_FILE);
  mod.traceMove({ agent: 'nobody', room: 1, sent: false, reason: 'test' });
  ok('and it wrote no trace file at all', !existsSync(mod.TRACE_FILE));
}

console.log('');
console.log('the broker calls it, and calls it where it is safe to');
{
  ok('the broker imports the tracer', /from '\.\/m59-collision-trace\.mjs'/.test(BROKER));
  ok('and traces move attempts', /traceMove\(\{/.test(BROKER));
  // THE PLACEMENT RULE. `queueValidatedMove` and `validateFineTarget` are lifted out of the
  // broker BY TEXT and evaluated by m59-collision-test.mjs, so a call inside either of them
  // becomes a free identifier in that eval and throws ReferenceError there while working in
  // the broker. Tracing therefore happens at the CALL SITES. This is not hypothetical: the
  // first wiring of this tracer put a call inside `Session.step`'s reach and the dependency
  // map caught it immediately.
  const inside = BROKER.slice(BROKER.indexOf('async queueValidatedMove'),
                              BROKER.indexOf('async queueValidatedMove') + 6000);
  ok('but never from inside queueValidatedMove, which is lifted by text elsewhere',
     !/traceMove\(/.test(inside));
  // Whatever it does record must not be a live object id — those are renumbered on every
  // system save, so a trace keyed on one is unreadable by the time anybody reads it.
  const calls = BROKER.match(/traceMove\(\{[\s\S]{0,220}?\}\)/g) ?? [];
  ok('there is at least one traced call site', calls.length >= 1, String(calls.length));
  ok('and every one records the ROOM NUMBER, never the room object id',
     calls.every(c => /room:\s*this\.world\?\.room\?\.num/.test(c)),
     calls.find(c => !/room:\s*this\.world\?\.room\?\.num/.test(c)) ?? '');
}

console.log('');
console.log('failed appends recover the original rows, once and in order');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-recovery-'));
  const traceFile = join(scratch, 'trace.jsonl');
  const mod = await enabledTracer(traceFile, 8);
  // The trace pathname itself is a directory, so appendFileSync fails with EISDIR while
  // mkdirSync(dirname(traceFile)) still succeeds. Create it AFTER initialization proved the
  // capture absent: an already-existing unreadable path may hide old rows and must fail closed.
  mkdirSync(traceFile);
  const realNow = Date.now;
  const times = [1_001, 1_002, 1_003];
  try {
    Date.now = () => times.shift();
    mod.traceMove({ agent: 'first', kind: 'step', at: 'caller', seq: 91 });
    mod.traceMove({ agent: 'second', kind: 'step', at: 'caller', seq: 92 });
    // Replace the failing destination with the file an operator would have repaired.
    rmSync(traceFile, { recursive: true, force: true });
    writeFileSync(traceFile, '');
    mod.traceMove({ agent: 'third', kind: 'step', at: 'caller', seq: 93 });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  ok('two failed writes and the recovery produce exactly three rows', rows.length === 3,
     JSON.stringify(rows));
  ok('recovery preserves attempt order and writes every row exactly once',
     rows.map(r => r.agent).join(',') === 'first,second,third', JSON.stringify(rows));
  ok('the sequence is monotonic and cannot be supplied by the caller',
     rows.map(r => r.seq).join(',') === '1,2,3', JSON.stringify(rows.map(r => r.seq)));
  ok('queued rows retain their original timestamps rather than recovery time',
     rows.map(r => r.at).join(',') === '1001,1002,1003', JSON.stringify(rows.map(r => r.at)));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('bounded recovery makes an overflow durably visible');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-overflow-'));
  const traceFile = join(scratch, 'trace.jsonl');
  const mod = await enabledTracer(traceFile, 2);
  mkdirSync(traceFile);
  const realNow = Date.now;
  const times = [2_001, 2_002, 2_003, 2_004, 2_005];
  try {
    Date.now = () => times.shift();
    for (const agent of ['one', 'two', 'three', 'four'])
      mod.traceMove({ agent, kind: 'step', sent: true });
    rmSync(traceFile, { recursive: true, force: true });
    writeFileSync(traceFile, '');
    mod.traceMove({ agent: 'five', kind: 'step', sent: true });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  const marker = rows[2];
  ok('the bounded queue retains its two oldest rows and the recovery row once',
     rows.map(r => r.agent ?? r.kind).join(',') === 'one,two,trace_loss,five',
     JSON.stringify(rows));
  ok('the loss marker replaces the first unavailable sequence and exposes the whole gap',
     marker?.schema === 'm59-collision-trace-loss/1'
       && marker?.seq === 3 && marker?.at === 2_003 && marker?.lostFromSeq === 3
       && marker?.lostThroughSeq === 4 && marker?.lostCount === 2
       && marker?.reason === 'pending_queue_overflow', JSON.stringify(marker));
  ok('the next durable row leaves the matching monotonic sequence gap',
     rows.map(r => r.seq).join(',') === '1,2,3,5', JSON.stringify(rows.map(r => r.seq)));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('an unreadable existing capture fails closed');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-unreadable-'));
  const traceFile = join(scratch, 'trace.jsonl');
  // A directory at the exact pathname is a portable EISDIR stand-in for existing bytes the
  // tracer cannot inspect. Repairing it later must not cause a fresh seq 1 append behind the
  // unknown capture.
  mkdirSync(traceFile);
  const mod = await enabledTracer(traceFile, 2);
  rmSync(traceFile, { recursive: true, force: true });
  writeFileSync(traceFile, '');
  mod.traceMove({ agent: 'must-not-append', kind: 'step', sent: true });
  ok('repairing an unreadable existing path does not start an ambiguous capture',
     readFileSync(traceFile, 'utf8') === '');
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('the physical line cap ends with a durable open loss range');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-cap-'));
  const traceFile = join(scratch, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const mod = await enabledTracer(traceFile, 2, 3);
  const realNow = Date.now;
  const times = [3_001, 3_002, 3_003];
  try {
    Date.now = () => times.shift();
    mod.traceMove({ agent: 'one', kind: 'step', sent: true });
    mod.traceMove({ agent: 'two', kind: 'step', sent: true });
    mod.traceMove({ agent: 'omitted', kind: 'step', sent: true });
    // Further attempts retry a failed marker if necessary, but may never duplicate it.
    mod.traceMove({ agent: 'also-omitted', kind: 'step', sent: true });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  const marker = rows[2];
  ok('the configured maximum remains a physical line bound', rows.length === 3,
     JSON.stringify(rows));
  ok('the last line explicitly marks every attempt from the cap onward as unavailable',
     marker?.schema === 'm59-collision-trace-loss/1' && marker?.kind === 'trace_loss'
       && marker?.reason === 'max_lines_reached' && marker?.seq === 3
       && marker?.at === 3_003 && marker?.lostFromSeq === 3
       && marker?.lostThroughSeq === null && marker?.lostCount === null,
     JSON.stringify(marker));
  ok('calls beyond the cap cannot duplicate its durable marker',
     rows.filter(r => r.reason === 'max_lines_reached').length === 1, JSON.stringify(rows));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('a supervised restart resumes one bounded capture');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-restart-'));
  const traceFile = join(scratch, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const first = await enabledTracer(traceFile, 2, 4);
  first.traceMove({ agent: 'one', kind: 'step', sent: true });
  first.traceMove({ agent: 'two', kind: 'step', sent: true });

  const restarted = await enabledTracer(traceFile, 2, 4);
  restarted.traceMove({ agent: 'three', kind: 'step', sent: true });
  restarted.traceMove({ agent: 'omitted', kind: 'step', sent: true });

  // A later restart sees the durable open-ended marker and cannot append behind it.
  const afterCap = await enabledTracer(traceFile, 2, 4);
  afterCap.traceMove({ agent: 'also-omitted', kind: 'step', sent: true });
  const rows = readRows(traceFile);
  ok('a restart continues the existing monotonic sequence',
     rows.map(row => row.seq).join(',') === '1,2,3,4', JSON.stringify(rows));
  ok('the cap remains a physical bound across process restarts',
     rows.length === 4 && rows[3]?.reason === 'max_lines_reached', JSON.stringify(rows));
  ok('nothing is appended after the open-ended cap marker',
     rows.filter(row => row.agent === 'also-omitted').length === 0, JSON.stringify(rows));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
