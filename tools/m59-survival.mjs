#!/usr/bin/env node
// HOW FAR DOES A CHARACTER GET BEFORE IT DIES?
//
//   node tools/m59-survival.mjs                 # the window on disk now
//   node tools/m59-survival.mjs --archives      # every archived window, oldest first
//
// MAPS CROSSED PER DEATH is the number, and it is the right one because it is a RATE OVER
// WORK DONE rather than over time. Deaths per hour flatters a fleet that is standing still —
// the safest possible travel policy is not to travel — and it punishes one that is crossing
// hard rooms quickly, which is the thing we are trying to make possible. A crossing is a
// unit of what the fleet is for, so the question is how many of them a character gets
// through before the road takes it.
//
// It counts SUCCESSFUL room crossings from the transit ledger, and deaths from the keeper
// ledger, over the same window. A failed hop is not a map crossed and is not counted as one;
// it is reported alongside, because a policy that survives by never arriving would otherwise
// look excellent here.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = join(HERE, '..', 'substrate');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const readJsonl = (file) => {
  const out = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
};

/** One window: a directory of transit files and a directory of keeper ledger days. */
export function measure({ transitDir, ledgerDir, only = null }) {
  // `only` may be filled in below from the ledger when the caller did not name a roster.
  // WHOSE WINDOW IS THIS? substrate/transits/ holds every fleet this checkout has ever run —
  // prod's characters sit beside the arena's — while the keeper ledger is per fleet by
  // construction. So the ledger decides who counts, and the transit files are filtered to
  // that set. Without this the live read mixed 54 prod characters into a shadow measurement
  // and reported 17,969 crossings and no deaths, which is a fact about the wrong fleet.
  const ledgerFirst = [];
  if (existsSync(ledgerDir)) {
    for (const f of readdirSync(ledgerDir)) {
      if (f.endsWith('.jsonl')) ledgerFirst.push(...readJsonl(join(ledgerDir, f)));
    }
  }
  if (!only) {
    const seen = new Set(ledgerFirst.map(r => r.character).filter(Boolean));
    if (seen.size) only = seen;
  }

  const crossings = [];
  if (existsSync(transitDir)) {
    for (const f of readdirSync(transitDir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      if (only && !only.has(name)) continue;
      let j = null;
      try { j = JSON.parse(readFileSync(join(transitDir, f), 'utf8')); } catch { continue; }
      for (const t of (j.transits ?? [])) crossings.push({ character: j.character ?? name, ...t });
    }
  }
  const ledger = ledgerFirst;
  const kindOf = r => r.kind ?? r.event ?? '?';
  const deaths = ledger.filter(r => kindOf(r) === 'died' && (!only || only.has(r.character)));
  const holds = ledger.filter(r => kindOf(r) === 'travel_hold' && (!only || only.has(r.character)));
  const refused = ledger.filter(r => kindOf(r) === 'travel_pause'
    && /did not consider|could not take/.test(String(r.did ?? '')) && (!only || only.has(r.character)));

  const ok = crossings.filter(c => c.ok);
  const times = [...crossings, ...ledger].map(r => r.at ?? r.t).filter(Number.isFinite).sort((a, b) => a - b);
  const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const bodies = new Set([...crossings.map(c => c.character), ...ledger.map(r => r.character)]
    .filter(Boolean)).size;
  const diedOnce = new Set(deaths.map(d => d.character).filter(Boolean)).size;

  return {
    spanMin: spanMs / 60000,
    bodies,
    crossed: ok.length,
    failed: crossings.length - ok.length,
    deaths: deaths.length,
    // THE NUMBER. Infinity when nothing died, which is honest and not a bug — a window with
    // no deaths has no average to report, and printing a large finite number would invent one.
    mapsPerDeath: deaths.length ? ok.length / deaths.length : Infinity,
    holds: holds.length,
    refused: refused.length,
    survivors: bodies ? (bodies - diedOnce) / bodies : null,
    deathsPerBodyHour: spanMs && bodies ? deaths.length / ((spanMs / 3600000) * bodies) : null,
  };
}

const fmt = (m, label) => {
  const per = m.mapsPerDeath === Infinity ? '  none' : m.mapsPerDeath.toFixed(1);
  return label.padEnd(26) +
    String(Math.round(m.spanMin) + 'm').padStart(6) +
    String(m.crossed).padStart(9) +
    String(m.failed).padStart(8) +
    String(m.deaths).padStart(8) +
    per.padStart(9) +
    String(m.holds).padStart(8) +
    String(m.refused).padStart(9) +
    (m.survivors == null ? '' : String(Math.round(m.survivors * 100) + '%').padStart(7));
};

const HEAD = 'window'.padEnd(26) + 'span'.padStart(6) + 'crossed'.padStart(9) +
             'failed'.padStart(8) + 'deaths'.padStart(8) + 'maps/death'.padStart(9) +
             'refuges'.padStart(8) + 'refused'.padStart(9) + 'lived'.padStart(7);

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const fleet = arg('--fleet', 'shadow');
  const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
  const rows = [];

  if (argv.includes('--archives')) {
    const arcRoot = join(SUB, 'archive');
    const dirs = existsSync(arcRoot)
      ? readdirSync(arcRoot).filter(d => {
          try { return statSync(join(arcRoot, d)).isDirectory(); } catch { return false; }
        }).sort()
      : [];
    for (const d of dirs) {
      const m = measure({ transitDir: join(arcRoot, d, 'transits'),
                          ledgerDir: join(arcRoot, d, `history-${fleet}`), only });
      if (!m.crossed && !m.deaths) continue;      // an archive of backups, not of a run
      rows.push([d, m]);
    }
  }
  rows.push(['NOW (live)', measure({ transitDir: join(SUB, 'transits'),
                                     ledgerDir: join(SUB, 'history', fleet), only })]);

  console.log('MAPS CROSSED PER DEATH — a rate over work done, not over time.');
  console.log('A fleet that never travels never dies, so deaths-per-hour flatters standing still.\n');
  console.log(HEAD);
  for (const [label, m] of rows) console.log(fmt(m, label));
  console.log('\n`failed` is hops that did not cross. A policy that survives by never arriving');
  console.log('would look excellent in the maps/death column alone, so it is printed beside it.');
}
