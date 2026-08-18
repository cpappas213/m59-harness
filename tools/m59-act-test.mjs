#!/usr/bin/env node
// m59-act-test.mjs -- THE ATOMIC CONTRACT, ENFORCED MECHANICALLY.
//
// Offline, no server:  node tools/m59-act-test.mjs
//
// Two halves. The first is a CONFORMANCE sweep that every file in tools/m59-act/
// must pass, whoever writes it and whenever: it is the thing that stops the next
// wave of atomics turning into wrappers the way the last one did. The second is
// per-atomic behaviour.
//
// The conformance rules come from docs/keeper-rebuild-plan.md §4, and each exists
// because of a specific failure already paid for in this repository:
//
//   TAKES A CLIENT, NOT A KEEPER
//     The fork's BT modules took a keeper and called 71 of its methods. 25 of
//     those existed on one fork only, so the modules could not be carried to
//     another trunk at all -- the wrapper debt and the fork turned out to be the
//     same bill. An atomic over the client is portable because m59-client.mjs is
//     identical everywhere.
//
//   DECLARES pre/effects FROM THE CLOSED VOCABULARY
//     A precondition nobody produces makes a plan silently unsatisfiable, and the
//     planner can only report "no plan". Same shape as policy.purpose sitting
//     outside a schema for a year with the yield audit switched off behind it.
//
//   NO UNBOUNDED LOOP
//     The keeper is a long-await machine and 82% of deaths had it blind, worst
//     case 909 seconds inside one travel call. An atomic that loops cannot be
//     interrupted between iterations, so looping belongs to the caller.
//
//   REFUSES BY RETURNING, NOT BY THROWING
//     A refusal that throws has to be caught by every caller, and the ones that
//     forget read it as success -- which is exactly how "no error" came to mean
//     "the merchant sold it" for years, when a refusal here is a sentence spoken
//     to the room and never an error on the wire.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, SYMBOL_NAMES } from './m59-worldstate.mjs';
import { fakeClient, fakeSession } from './m59-fake-client.mjs';

const ACTDIR = join(dirname(fileURLToPath(import.meta.url)), 'm59-act');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------------------------------------------
// Conformance: every atomic, every rule.
// ---------------------------------------------------------------------------
const files = readdirSync(ACTDIR).filter(f => f.endsWith('.mjs')).sort();
ok('there is at least one atomic to check', files.length > 0);

for (const file of files) {
  const src = readFileSync(join(ACTDIR, file), 'utf8');
  const mod = await import(join(ACTDIR, file));
  const fns = Object.values(mod).filter(v => typeof v === 'function' && v.atomic);

  console.log(`\nconformance: m59-act/${file}`);
  ok(`${file} exports at least one tagged atomic`, fns.length > 0,
     'tag it with `fn.atomic = "name"` so the sweep can find it');

  for (const fn of fns) {
    const n = fn.atomic;

    // 1. the vocabulary
    ok(`${n}: declares pre`, Array.isArray(fn.pre));
    ok(`${n}: declares effects`, Array.isArray(fn.effects));
    const problems = validate({ name: n, pre: fn.pre, effects: fn.effects });
    ok(`${n}: every pre/effect is a known world-state symbol`, problems.length === 0,
       problems[0] ?? '');
    ok(`${n}: effects are not empty — an atomic that changes nothing is a Condition`,
       (fn.effects ?? []).length > 0);

    // 2. NEVER THE KEEPER. Checked in the source, because a signature cannot say it.
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok(`${n}: never reaches for a keeper`,
       !/\bkeeper\./.test(body) && !/\bthis\.(policy|s|note|tally)\b/.test(body),
       'an atomic takes (client, session) and nothing else');

    // 3. bounded — no loop around an await
    const looping = /\b(while|for)\s*\([^)]*\)\s*\{[^]*?\bawait\b/.test(body);
    ok(`${n}: contains no loop around an await`, !looping,
       'looping is the callers job, so it can be interrupted between iterations');

    // 4. arity: (client, session, args)
    ok(`${n}: takes (client, session, args)`, fn.length <= 3 && fn.length >= 2);
  }
}

// ---------------------------------------------------------------------------
// Behaviour: attack
// ---------------------------------------------------------------------------
const { attack, SWING_MS } = await import('./m59-act/attack.mjs');

const withFoe = (col = 11, row = 10) => {
  const c = fakeClient({
    selfId: 1, col: 10, row: 10,
    equipped: [{ id: 5, name: 'mace' }],
    room: { num: 1, objects: [{ id: 9, name: 'mummy', col, row }] },
  });
  return { c, s: fakeSession(c) };
};

console.log('\nattack: one swing, and it reaches the wire');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('it reports sending', r.sent === true);
  ok('exactly ONE attack packet — an atomic is one swing',
     c.sent.filter(x => x[0] === 'attack').length === 1, JSON.stringify(c.sent));
  ok('aimed at the target we named', c.sent.find(x => x[0] === 'attack')[1] === 9);
  ok('the swing timer is the server\'s', SWING_MS === 1050);
}

console.log('\nattack refuses by RETURNING — never by throwing');
{
  const { c, s } = withFoe();
  let threw = false; let r;
  try { r = await attack(c, s, {}); } catch { threw = true; }
  ok('no target: does not throw', !threw);
  ok('and says why', r.sent === false && /no target/.test(r.reason));
  ok('and sent nothing', c.sent.length === 0);

  let r2, threw2 = false;
  try { r2 = await attack(null, null, { targetId: 9 }); } catch { threw2 = true; }
  ok('no client: does not throw either', !threw2 && r2.sent === false);
}

console.log('\nattack obeys the reach disc — a swing from too far is thrown away by the server');
{
  const far = withFoe(14, 10);              // distance 4, outside the radius-3 disc
  const r = await attack(far.c, far.s, { targetId: 9, waitMs: 1 });
  ok('it refuses rather than wasting the round', r.sent === false);
  ok('and names the reason', /out of reach/.test(r.reason));
  ok('and no packet went out', far.c.sent.filter(x => x[0] === 'attack').length === 0);

  const edge = withFoe(13, 10);             // distance exactly 3 — legal
  const r2 = await attack(edge.c, edge.s, { targetId: 9, waitMs: 1 });
  ok('three squares away IS in reach and does swing', r2.sent === true);
}

console.log('\nattack is honest: it reads the room back rather than trusting the send');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('the target was there before', r.target_present_before === true);
  ok('and is reported still there after — nothing is claimed about damage',
     r.target_present_after === true);

  // Now the room says it is gone. The atomic must report the ROOM's answer.
  const { c: c2, s: s2 } = withFoe();
  s2.pacer = { submit: async (_k, fn) => { fn(); c2.room.objects.delete(9); } };
  const r2 = await attack(c2, s2, { targetId: 9, waitMs: 1 });
  ok('a target that left is reported gone, from the room and not from the send',
     r2.sent === true && r2.target_present_after === false);
}

console.log('\nattack will not swing at something that is not there');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 999, waitMs: 1 });
  ok('an absent target is refused', r.sent === false && /not in the room/.test(r.reason));
  ok('and nothing was sent', c.sent.filter(x => x[0] === 'attack').length === 0);
}

console.log('\nattack declares a plan-able contract');
{
  ok('pre includes being armed and in reach',
     attack.pre.includes('armed') && attack.pre.includes('in_reach'));
  ok('pre includes the engagement band — the ceiling is a PRECONDITION, not an afterthought',
     attack.pre.includes('target_in_band'));
  ok('every symbol it names exists in the vocabulary',
     [...attack.pre, ...attack.effects].every(s => SYMBOL_NAMES.includes(s.replace(/^!/, ''))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
