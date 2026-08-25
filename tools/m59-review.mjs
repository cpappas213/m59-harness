// WHICH ROOMS ARE SLOW, WORST FIRST, AS A QUEUE SOMEBODY CAN WALK THROUGH.
//
//   node tools/m59-review.mjs                    build/refresh the queue and print it
//   node tools/m59-review.mjs --over 30          a stricter bar, in seconds (default 60)
//   node tools/m59-review.mjs --next             the next room to look at, and how to get there
//   node tools/m59-review.mjs --done 599         mark a room reviewed; it stops coming back
//   node tools/m59-review.mjs --fleet shadow     which ledger to read (default: this checkout's)
//
// A MINUTE IS THE BAR, AND IT IS AN OPERATOR'S BAR RATHER THAN A MEASURED ONE. Nothing in
// this game needs sixty seconds to cross one room: the whole Tos-to-Castle-Victoria road is
// seven rooms and a human walks it in under five minutes. So a room that takes longer than a
// minute is not slow, it is STUCK, and the interesting question is what it was doing — which
// is a question to answer by standing in the room, not by reading a mean.
//
// WHY A QUEUE RATHER THAN A REPORT. "Ukgoth is slow" has been true and useless for weeks.
// The queue exists to be emptied one room at a time, with somewhere to record that a room
// has been looked at, so the second pass is about the rooms the first pass did not reach.
// `--done` is the whole point: a list that cannot be crossed off is a report wearing a
// different hat.
//
// NO CHARACTER NAMES. The ledgers are full of them and the queue is a thing to paste into a
// chat window. A room number and a square is all anybody needs to go and look.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = n => argv.includes('--' + n);

const FLEET = flag('fleet', null) ?? fleetName();
const QUEUE = join(REPO, 'substrate', `review-queue${FLEET ? '-' + FLEET : ''}.json`);
const OVER_MS = Number(flag('over', 60)) * 1000;

// SINCE THE BROKER STARTED, BECAUSE THAT IS WHEN THE CODE CHANGED.
//
// Without a window the first build of this reported 1,802 slow crossings of North Barloque:
// true, and mostly from code that has since been replaced three times. A day is no better —
// on a day like today the harness changed eight times, and a queue that mixes those is a
// queue of rooms that were slow under code nobody is running.
//
// The broker's own pid file records when the service started it, and every keeper is a child
// of that process, so "since the broker came up" IS "since this code went live". `--since N`
// overrides it in hours, and `--since 0` asks for the whole ledger when the long view is
// genuinely wanted — `m59-overhead.mjs` remains the tool for history.
const brokerStart = (() => {
  for (const f of [`broker-${FLEET}.pid`, 'broker.pid']) {
    try {
      const j = JSON.parse(readFileSync(join(REPO, 'substrate', f), 'utf8'));
      const at = Number(j?.at);
      if (Number.isFinite(at) && at > 0) return at;
    } catch { /* no pid file: fall through */ }
  }
  return null;
})();
const SINCE_ARG = flag('since', null);
const SINCE_H = SINCE_ARG === null ? null : Number(SINCE_ARG);
const SINCE = SINCE_H === null
  ? (brokerStart ?? Date.now() - 24 * 3600 * 1000)
  : (SINCE_H > 0 ? Date.now() - SINCE_H * 3600 * 1000 : 0);
const WINDOW_SAID = SINCE_H === null
  ? (brokerStart ? `since the broker started (${new Date(brokerStart).toISOString().slice(11, 19)}Z)`
                 : 'last 24h — no broker pid file found')
  : (SINCE_H > 0 ? `last ${SINCE_H}h` : 'all time');

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const roomNames = (() => {
  try {
    const w = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
    const out = {};
    for (const [num, r] of Object.entries(w.rooms ?? {})) if (r?.name) out[Number(num)] = r.name;
    return out;
  } catch { return {}; }
})();
const nameOf = n => roomNames[Number(n)] ?? `room ${n}`;

// Every transit ledger belonging to this fleet. A character file is one letter repeated four
// times for the shadow fleet and a Muppet name for production; rather than guess, read them
// all and let the fleet's own ledger directory do the scoping.
function transits() {
  const dir = join(REPO, 'substrate', 'transits');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const e of (j.transits ?? [])) out.push(e);
  }
  return out;
}

const prior = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : { reviewed: {}, notes: {} };

if (flag('done')) {
  const room = Number(flag('done'));
  prior.reviewed[room] = new Date().toISOString();
  const note = flag('note');
  if (note) prior.notes[room] = note;
  writeFileSync(QUEUE, JSON.stringify(prior, null, 1));
  console.log(`room ${room} (${nameOf(room)}) marked reviewed${note ? ` — ${note}` : ''}`);
  process.exit(0);
}

// One row per ROOM, because that is what somebody can go and stand in. The exit pair is kept
// because "slow leaving by the north door" and "slow in general" are different problems.
const byRoom = new Map();
for (const e of transits()) {
  const ms = Number(e.ms);
  if (!Number.isFinite(ms) || ms < OVER_MS) continue;
  if (SINCE && Number(e.at) < SINCE) continue;
  const room = Number(e.room);
  if (!Number.isFinite(room)) continue;
  const r = byRoom.get(room) ?? { room, n: 0, worst: 0, total: 0, exits: new Map(), failed: 0, at: 0 };
  r.n++; r.total += ms; r.at = Math.max(r.at, Number(e.at) || 0);
  if (ms > r.worst) r.worst = ms;
  if (!e.ok) r.failed++;
  const key = `${e.room}->${e.to}`;
  r.exits.set(key, (r.exits.get(key) ?? 0) + 1);
  byRoom.set(room, r);
}

const rows = [...byRoom.values()]
  .map(r => ({ ...r, avg: Math.round(r.total / r.n), exits: [...r.exits.entries()].sort((a, b) => b[1] - a[1]) }))
  .sort((a, b) => (b.n * b.avg) - (a.n * a.avg));

const open = rows.filter(r => !prior.reviewed[r.room]);

if (has('next')) {
  const r = open[0];
  if (!r) { console.log('review queue is empty — every slow room has been looked at'); process.exit(0); }
  console.log(`NEXT: room ${r.room} — ${nameOf(r.room)}`);
  console.log(`  ${r.n} crossing(s) over ${Math.round(OVER_MS / 1000)}s, worst ${Math.round(r.worst / 1000)}s, average ${Math.round(r.avg / 1000)}s` +
              (r.failed ? `, ${r.failed} of them never arrived` : ''));
  console.log(`  slowest exits: ${r.exits.slice(0, 3).map(([k, n]) => `${k} x${n}`).join('  ')}`);
  console.log('');
  console.log('  to go and look:');
  console.log(`    node tools/m59-dm.mjs where TESTER            # find TESTER`);
  console.log(`    node tools/m59-roomview.mjs ${r.room}                # the map, the rail, and every refusal on it`);
  console.log('');
  console.log(`  when done:  node tools/m59-review.mjs --done ${r.room} --note "what it was"`);
  process.exit(0);
}

writeFileSync(QUEUE, JSON.stringify(prior, null, 1));

console.log(`rooms taking over ${Math.round(OVER_MS / 1000)}s to cross — fleet "${FLEET ?? '(unnamed)'}", ${WINDOW_SAID}`);
console.log('');
if (!rows.length) { console.log('  nothing over the bar. Either the road is healthy or nobody has walked it.'); process.exit(0); }
console.log('   #  room                                    slow  worst   avg  failed  exits');
rows.forEach((r, i) => {
  const done = prior.reviewed[r.room];
  console.log(
    String(done ? ' -' : (open.indexOf(r) + 1)).padStart(4) + '  ' +
    (String(r.room) + ' ' + nameOf(r.room)).slice(0, 36).padEnd(38) +
    String(r.n).padStart(4) +
    String(Math.round(r.worst / 1000) + 's').padStart(7) +
    String(Math.round(r.avg / 1000) + 's').padStart(6) +
    String(r.failed).padStart(8) + '  ' +
    r.exits.slice(0, 2).map(([k, n]) => `${k}x${n}`).join(' ') +
    (done ? `   [reviewed ${String(done).slice(0, 10)}${prior.notes[r.room] ? ': ' + prior.notes[r.room] : ''}]` : ''));
});
console.log('');
console.log(`  ${open.length} still to look at.  node tools/m59-review.mjs --next`);
