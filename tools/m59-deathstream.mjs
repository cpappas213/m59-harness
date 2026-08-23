#!/usr/bin/env node
// WHOSE DEATHS ARE THESE — the record, split by fleet, because I kept mixing them.
//
//   node tools/m59-deathstream.mjs                 every fleet, last 24h, separated
//   node tools/m59-deathstream.mjs --minutes 30
//   node tools/m59-deathstream.mjs --fleet prod
//
// `m59-postmortems.mjs` scopes correctly — it asks `fleetScope` and sets other fleets
// aside. Every ad-hoc scan of `substrate/postmortems/` does not, and I wrote three of them
// in one session and quoted all three. The directory is keyed by CHARACTER NAME and nothing
// else, so a scan of it silently merges a live 21-character prod fleet with six throwaway
// arena bots that die constantly by design.
//
// That is not a hypothetical: a check-in reported "13 deaths in the last 30 minutes" when
// seven of them were arena test bots the reporter had left standing in a monster room.
// The prod number was six. The difference is the whole meaning of the report.
//
// So the roster files are the authority on membership, exactly as they are for everything
// else here, and a character in no roster is reported as UNKNOWN rather than folded into
// whichever fleet is being asked about.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = join(HERE, '..', 'substrate');

/** character name -> fleet, from every roster on this machine. */
export function membership() {
  const who = new Map();
  const add = (file, fleet) => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const rows = raw.agents ?? raw;
      for (const slot of Object.values(rows)) {
        const name = slot?.credentials?.character ?? slot?.character;
        if (name) who.set(String(name), fleet);
      }
    } catch { /* a roster that is not there is not an error */ }
  };
  try {
    for (const f of readdirSync(join(SUB, 'fleets')))
      if (f.endsWith('.json')) add(join(SUB, 'fleets', f), f.replace(/\.json$/, ''));
  } catch { /* no named fleets */ }
  add(join(SUB, 'fleet-state.json'), 'default');
  return who;
}

export function deathsBy({ minutes = 24 * 60 } = {}) {
  const who = membership();
  const since = Date.now() - minutes * 60_000;
  const out = new Map();
  for (const file of readdirSync(join(SUB, 'postmortems'))) {
    if (!file.endsWith('.json')) continue;
    let d; try { d = JSON.parse(readFileSync(join(SUB, 'postmortems', file), 'utf8')); } catch { continue; }
    if (!(d.at > since)) continue;
    const fleet = who.get(d.character) ?? 'UNKNOWN';
    const row = out.get(fleet) ?? { total: 0, chars: new Map(), rooms: new Map() };
    row.total++;
    row.chars.set(d.character, (row.chars.get(d.character) ?? 0) + 1);
    const where = d.where?.room ?? '(unplaced)';
    row.rooms.set(where, (row.rooms.get(where) ?? 0) + 1);
    out.set(fleet, row);
  }
  return out;
}

if (process.argv[1]?.endsWith('m59-deathstream.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const minutes = Number(flag('minutes', String(24 * 60)));
  const only = flag('fleet', null);
  const by = deathsBy({ minutes });
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${v}x ${k}`).join('  ');
  console.log(`deaths in the last ${minutes} minute(s), by fleet\n`);
  if (!by.size) console.log('  none');
  for (const [fleet, row] of [...by.entries()].sort((a, b) => b[1].total - a[1].total)) {
    if (only && fleet !== only) continue;
    console.log(`  ${fleet.padEnd(12)} ${String(row.total).padStart(4)} death(s)`);
    console.log(`    who   ${top(row.chars)}`);
    console.log(`    where ${top(row.rooms)}`);
  }
  if (by.has('UNKNOWN'))
    console.log('\n  UNKNOWN means the character is in no roster on this machine — a deleted\n' +
                '  fleet, or a rename. It is never folded into a named fleet.');
}
