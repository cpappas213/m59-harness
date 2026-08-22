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

import { readFileSync } from 'node:fs';
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

const SRC = readFileSync(join(HERE, 'm59-collision-trace.mjs'), 'utf8');
const BROKER = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

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
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
