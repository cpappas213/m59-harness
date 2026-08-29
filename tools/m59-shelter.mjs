#!/usr/bin/env node
// RUNNING FOR COVER: THE DECISION, THE WALL IT PICKED, AND WHETHER IT HELPED.
//
//   node tools/m59-shelter.mjs                 # the runs this fleet has made, newest first
//   node tools/m59-shelter.mjs --summary       # by room: how hurt, how far, how often it worked
//   node tools/m59-shelter.mjs --json
//
// ======================== WHY THIS EXISTS ========================
//
// The travel doctrine says that everything except a person and dying is answered the same way:
// find the next route-adjacent wall, go to it, play dead once, rest to full, carry on. That is
// the single most important behaviour in the fleet and until now NOTHING ON DISK RECORDED IT.
// A postmortem says a character died at 7/20 with fifteen trolls on it; it does not say whether
// a wall was ever chosen, how hurt the character was when it chose, how far away the wall was,
// or whether it got there. Those are different faults with different fixes and they render
// identically as "died travelling".
//
// The operator's ask, 2026-08-27, is the schema: **record both squares and the health at the
// moment of the decision, so the run for cover can be recreated.** So a row is written when the
// wall is CHOSEN — not when it is reached — because a choice that never arrives is the
// interesting one and a ledger written on arrival cannot see it.
//
// TWO ROWS PER RUN, SHARING AN ID. `chose` is what was known at the decision; `settled` is what
// happened. Append-only, because the record of how a decision turned out is the finding. A run
// with a `chose` and no `settled` is a character that never got there, and that is data rather
// than a gap.
//
// EPOCH-STAMPED, like the tactics ledger and for the same reason: how far a hurt character can
// get is a statement about the mover that carried it, and the mover changes. See
// tools/m59-epoch.mjs and the `#movement` tag in CLAUDE.md.
//
// PER FLEET, and gitignored. These rows name characters and describe one machine's roads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { sameEpoch, epochId } from './m59-epoch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLEET = () => fleetName() || 'default';
export const SHELTER_DIR = process.env.M59_SHELTER_DIR
  || path.join(HERE, '..', 'substrate');

export function shelterFile(fleet = FLEET()) {
  return path.join(SHELTER_DIR, `shelter-runs-${fleet}.json`);
}

const num = (v) => (Number.isFinite(v) ? v : null);
const sq = (s) => (s && Number.isFinite(s.row) && Number.isFinite(s.col)
  ? { row: s.row, col: s.col } : null);

/**
 * ONE ROW. `kind` is 'chose' or 'settled'; `run` ties them together.
 *
 * NEVER THROWS AND NEVER BLOCKS A DECISION. This is a notebook, not a dependency — a keeper
 * that cannot write its ledger still has to run for cover.
 */
export function recordShelterRun(row = {}) {
  try {
    const entry = {
      t: row.at ?? Date.now(),
      epoch: epochId('movement'),
      run: row.run ?? null,
      kind: row.kind === 'settled' ? 'settled' : 'chose',
      character: row.character ?? null,
      room: num(row.room),
      room_name: row.room_name ?? null,

      // (A) HOW HURT IT WAS WHEN IT DECIDED. The fraction is what the threshold is compared
      // against; the raw pair is what makes it readable next to a postmortem's health trail.
      health: num(row.health), max_health: num(row.max_health),
      health_pct: num(row.health_pct),
      vigor: num(row.vigor),
      // What it was losing at the time. A character at 80% falling fast and one at 80% that
      // stopped bleeding two rooms ago are not the same decision.
      health_per_second: num(row.health_per_second),
      threats: Array.isArray(row.threats) ? row.threats.slice(0, 12) : null,

      // (B) BOTH SQUARES, AND HOW FAR. `detour` is how far the wall sits off the planned road
      // — the number `travelShelterDetour` caps — and `squares` is how far the character
      // actually has to walk, which is the one that costs health.
      from: sq(row.from), to: sq(row.to),
      detour: num(row.detour),
      squares: num(row.squares),
      proven: row.proven ?? null,
      // WHICH ARM OF THE DIVERT RULE WAS IN FORCE. "Any damage at all" is only defensible
      // where the map outranks the character; everywhere else an ordinary threshold applies.
      // Without this column a row cannot be read against the rule that produced it.
      outranked: row.outranked === true ? true : row.outranked === false ? false : null,
      divert_at: num(row.divert_at),
      at_step: num(row.at_step),
      legs_left: num(row.legs_left),

      // Filled on the `settled` row.
      //
      // `arrived` is CHECKED against the body's own square, not taken from whoever called the
      // arrival handler. It was taken on trust for one afternoon and the ledger reported
      // fifteen refuges that cost health — every one of them a character resting several
      // squares past the wall, in the open, because a proved leg had swallowed the waypoint.
      // `rested_at` is here so the next version of that mistake is one column away.
      arrived: row.arrived === true ? true : row.arrived === false ? false : null,
      on_the_wall: row.on_the_wall === true ? true : row.on_the_wall === false ? false : null,
      rested_at: sq(row.rested_at),
      ms: num(row.ms),
      rested_to: num(row.rested_to),
      hp_gained: num(row.hp_gained),
      cut_short: row.cut_short ?? null,
      why: row.why ?? null,
    };
    const file = shelterFile(row.fleet ?? FLEET());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let book = { runs: [] };
    try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first row */ }
    if (!Array.isArray(book.runs)) book.runs = [];
    book.runs.push(entry);
    // A NOTEBOOK, NOT AN ARCHIVE. Rows from a mover that no longer exists are worse than no
    // rows — see the `#movement` epoch argument — and the old ones are still on the previous
    // epoch's disk if anybody wants them.
    if (book.runs.length > 5000) book.runs = book.runs.slice(-5000);
    fs.writeFileSync(file, JSON.stringify(book, null, 1));
    return entry;
  } catch { return null; }
}

export function shelterRuns({ fleet = FLEET(), thisEpochOnly = true } = {}) {
  let book = { runs: [] };
  try { book = JSON.parse(fs.readFileSync(shelterFile(fleet), 'utf8')); } catch { return []; }
  const runs = Array.isArray(book.runs) ? book.runs : [];
  if (!thisEpochOnly) return runs;
  // `sameEpoch` answers true, false, or NULL for "cannot say" — and a row we cannot place is
  // kept rather than dropped, because silently discarding evidence is worse than including it
  // with a caveat.
  // ARGUMENTS THE RIGHT WAY ROUND. This read `sameEpoch('movement', r.epoch)`, which passes
  // the domain as the row and the row as the domain: `epochId('1596f75e578d+ac40f318')` is
  // not a known domain, so it answered null, "cannot say" is kept rather than dropped, and
  // the filter never once filtered. Every run since the ledger was written has been averaged
  // into every later epoch's summary -- which is the exact thing the #movement tag exists to
  // stop, in the file that argues for it. Caught by reading a post-rebake summary that still
  // showed the pre-rebake rows.
  return runs.filter(r => sameEpoch(r.epoch ?? null, 'movement') !== false);
}

/** Pair the two rows back up, so a run is one object again. */
export function pairRuns(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!r.run) continue;
    const cur = byId.get(r.run) ?? {};
    byId.set(r.run, r.kind === 'settled' ? { ...cur, settled: r } : { ...cur, chose: r });
  }
  return [...byId.values()].filter(v => v.chose);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const rows = shelterRuns({ thisEpochOnly: !args.includes('--all') });
  if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  const paired = pairRuns(rows);
  if (!paired.length) {
    console.log(`\nno shelter runs recorded for fleet "${FLEET()}" on epoch ${epochId('movement')}.`);
    console.log(`  ${shelterFile()}`);
    console.log('  A fleet that never runs for cover writes nothing here — so an empty book is');
    console.log('  either a quiet week or a doctrine that is not firing, and those look the same.\n');
    process.exit(0);
  }
  if (args.includes('--summary')) {
    const byRoom = new Map();
    for (const p of paired) {
      const k = `${p.chose.room} ${p.chose.room_name ?? ''}`.trim();
      const e = byRoom.get(k) ?? { n: 0, arrived: 0, pct: [], squares: [], gained: [] };
      e.n++;
      if (p.settled?.arrived) e.arrived++;
      if (p.chose.health_pct != null) e.pct.push(p.chose.health_pct);
      if (p.chose.squares != null) e.squares.push(p.chose.squares);
      if (p.settled?.hp_gained != null) e.gained.push(p.settled.hp_gained);
      byRoom.set(k, e);
    }
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const show = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
    console.log(`\nRUNNING FOR COVER — fleet "${FLEET()}", epoch ${epochId('movement')}\n`);
    console.log('  room                              runs  got there   hurt at   walked   healed');
    for (const [k, e] of [...byRoom].sort((a, b) => b[1].n - a[1].n))
      console.log('  ' + k.slice(0, 32).padEnd(32) + '  '
        + String(e.n).padStart(4) + '   ' + `${e.arrived}/${e.n}`.padStart(8) + '   '
        + (avg(e.pct) == null ? '     —' : (show(avg(e.pct) * 100) + '%').padStart(6)) + '   '
        + show(avg(e.squares), 1).padStart(6) + '   ' + show(avg(e.gained), 1).padStart(6));
    console.log('');
    process.exit(0);
  }
  console.log(`\nRUNNING FOR COVER — fleet "${FLEET()}", ${paired.length} run(s), newest first\n`);
  for (const p of paired.slice(-40).reverse()) {
    const c = p.chose, s = p.settled;
    const at = new Date(c.t).toISOString().slice(11, 19);
    console.log(`  ${at}  ${(c.character ?? '?').padEnd(8)} ${String(c.room).padStart(4)} ${(c.room_name ?? '').slice(0, 26)}`);
    console.log(`            hurt at ${c.health_pct == null ? '?' : Math.round(c.health_pct * 100) + '%'}`
      + ` (${c.health}/${c.max_health}), vigor ${c.vigor ?? '?'}`
      + (c.health_per_second != null ? `, losing ${(-c.health_per_second).toFixed(2)}/s` : ''));
    console.log(`            from ${c.from ? c.from.row + ',' + c.from.col : '?'}`
      + ` -> ${c.to ? c.to.row + ',' + c.to.col : '?'}`
      + `   ${c.squares ?? '?'} squares, ${c.detour ?? '?'} off the road`
      + (c.proven ? ', proven' : ''));
    if (!s) console.log('            NEVER SETTLED — no outcome row for this run');
    else console.log(`            ${s.arrived ? 'got there' : 'did NOT get there'}`
      + (s.on_the_wall === false && s.rested_at
         ? `  — SAT AT ${s.rested_at.row},${s.rested_at.col}, NOT ON THE WALL` : '')
      + (s.ms != null ? ` in ${(s.ms / 1000).toFixed(1)}s` : '')
      + (s.hp_gained != null ? `, healed ${s.hp_gained}` : '')
      + (s.cut_short ? `, cut short: ${s.cut_short}` : ''));
  }
  console.log('');
}
