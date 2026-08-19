// WHICH TACTIC, WHEN, AND DID IT ACTUALLY HELP.
//
// The walker has a handful of tactics for the moment a walk stops working, and all of them
// are real things a player does: run at the door along a line already proved clear, wiggle
// or retrace so the thing blocking you follows and comes off the gap, sidestep it, set the
// refused edges aside and plan on the coarse grid, walk the last stretch in fine units.
// Each is right in some situation and WRONG in others — and a tactic used at the wrong
// moment does not merely fail, it spends the seconds and the health that the right tactic
// needed. Backing away from something that is already swinging is a free hit and a delay.
//
// None of that was measurable. Fixes were being added by argument, one at a time, with no
// record of which tactic fired, what it was answering, what it cost, or whether the walk
// was unstuck afterwards. This is that record.
//
// THREE RULES, because each is a way the number could lie:
//
//   * A TACTIC IS SCORED AGAINST ITS TRIGGER, NEVER ON ITS OWN. "Retreat works 40% of the
//     time" is not a fact about retreating; it is an average over situations where it is
//     the obvious answer and situations where it is the worst available one. Every row
//     carries the trigger, and the summary never averages across them.
//   * THE OUTCOME IS MEASURED BY THE CALLER, NOT ASSUMED BY THE TACTIC. `worked` means the
//     thing the tactic was meant to unblock then succeeded — the next step landed, the
//     route reappeared, the door opened. A tactic that ran without error and left the walk
//     exactly as stuck is a FAILURE, and that is the commonest kind here.
//   * WHAT IT COST IS PART OF THE RESULT. A tactic that works in twelve seconds while
//     something is hitting you for nine health is not better than one that fails in one
//     second. Time and health are recorded on every row, including the successes.
//
// Written as JSONL because it is append-only evidence with no schema anyone should be
// tempted to edit, exactly like the hits and client-signal ledgers beside it. Gitignored:
// every row names a character.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

// WHICH FLEET, ASKED THE ONE WAY THIS REPOSITORY ASKS IT.
//
// This module used to read the environment directly with a literal fallback, which is
// its own argv/env reading — the exact mistake CLAUDE.md already records against the
// tithe book, where "a broker started with no --fleet but a recorded substrate/fleet-default
// wrote default-t14 while the tool read prod-t14". It happened again here and was visible on
// disk: the prod broker is started with `--fleet prod` as a COMMAND LINE argument, not an
// environment variable, so every trail it recorded went into `default.jsonl` — 14 MB of prod
// under a name no tool would ever look for.
//
// `fleetName` is the resolver every other fleet tool uses: --fleet, then M59_FLEET, then
// substrate/fleet-default, then the unnamed fleet. One answer, one place.
const FLEET = () => fleetName() || 'default';


const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TACTICS_DIR = process.env.M59_TACTICS_DIR || path.join(HERE, '..', 'substrate', 'tactics');

// THE CLOSED SET, so a new tactic shows up in the report the day it is added rather than
// being averaged into "other". An unrecognised name is RECORDED, never dropped — the same
// rule the commitment board follows, and for the same reason: a tactic nobody can see is
// one nobody can judge.
export const TACTICS = Object.freeze({
  string_pull: 'ran the proved straight line at the target',
  hop_coalesce: 'skipped ahead along a line the pull had already proved',
  breadcrumb_retreat: 'walked the validated trail backwards',
  needle_backoff: 'backed off a one-square doorway so the blocker would follow',
  needle_wait: 'stood and waited for a one-square doorway to clear',
  sidestep: 'stepped around the body in the way',
  drop_occupancy: 'forgot where bodies were standing and replanned',
  coarse_fallback: 'set the refused edges aside and planned on the server grid',
  fine_walk: 'walked it in fine units instead of square steps',
  floor_recovery: 'stepped back onto ground the mover believes in',
});

// WHAT THE TACTIC WAS ANSWERING. The same distinctions the walker already makes, because a
// trigger this file invents is a trigger nothing can be keyed off.
export const TRIGGERS = Object.freeze({
  body_blocked: 'something alive refused the step',
  off_plan: 'the step landed somewhere other than the planned square',
  no_route: 'the planner had nothing from here',
  off_floor: 'standing where the mover says there is no floor',
  door_refused: 'the boundary would not take us',
});

let buffer = [], flushTimer = null;

export function tacticsFile(fleet = FLEET()) {
  return path.join(TACTICS_DIR, String(fleet).replace(/[^\w.-]/g, '_') + '.jsonl');
}

/**
 * Record one application of one tactic.
 *
 * FIRE AND FORGET, AND BUFFERED, because this is called from inside a walk that twenty-one
 * sessions share an event loop with. It must never throw and must never await: an
 * instrument that can break the thing it measures is worse than no instrument, and this one
 * sits on the movement path.
 */
export function recordTactic(row = {}) {
  try {
    const entry = {
      t: row.at ?? Date.now(),
      character: row.character ?? null,
      room: row.room ?? null,
      tactic: row.tactic ?? 'unknown',
      trigger: row.trigger ?? null,
      // Chebyshev squares to the goal before and after, so "did it get us anywhere" is
      // answerable separately from "did the next step work".
      gap_before: Number.isFinite(row.gap_before) ? row.gap_before : null,
      gap_after: Number.isFinite(row.gap_after) ? row.gap_after : null,
      ms: Number.isFinite(row.ms) ? Math.round(row.ms) : null,
      hp_lost: Number.isFinite(row.hp_lost) ? row.hp_lost : 0,
      // The caller's measured answer, never the tactic's own opinion of itself.
      worked: row.worked === true,
      ...(row.note ? { note: String(row.note).slice(0, 200) } : {}),
    };
    buffer.push(entry);
    if (buffer.length >= 64) flushTactics(row.fleet);
    else if (!flushTimer) {
      flushTimer = setTimeout(() => flushTactics(row.fleet), 5000);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    return entry;
  } catch { return null; }
}

export function flushTactics(fleet = FLEET()) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buffer.length) return 0;
  const rows = buffer; buffer = [];
  try {
    fs.mkdirSync(TACTICS_DIR, { recursive: true });
    fs.appendFileSync(tacticsFile(fleet), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return rows.length;
  } catch { return 0; }
}

export function readTactics({ fleet = FLEET(), hours = 24 } = {}) {
  let text = '';
  try { text = fs.readFileSync(tacticsFile(fleet), 'utf8'); } catch { return []; }
  const since = Date.now() - hours * 3600000;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if ((r.t ?? 0) >= since) out.push(r); } catch { /* a torn last line */ }
  }
  return out;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Per TACTIC AND TRIGGER, never per tactic alone — see the rule at the top of the file.
 */
export function summarise(rows = []) {
  const cells = new Map();
  for (const r of rows) {
    const key = r.tactic + ' ' + (r.trigger ?? 'unknown');
    const cell = cells.get(key) ?? { tactic: r.tactic, trigger: r.trigger ?? 'unknown',
                                     used: 0, worked: 0, ms: [], hp: 0, closed: 0, rooms: new Map() };
    cell.used++;
    if (r.worked) cell.worked++;
    if (Number.isFinite(r.ms)) cell.ms.push(r.ms);
    cell.hp += r.hp_lost ?? 0;
    if (Number.isFinite(r.gap_before) && Number.isFinite(r.gap_after) && r.gap_after < r.gap_before)
      cell.closed++;
    if (r.room != null) cell.rooms.set(r.room, (cell.rooms.get(r.room) ?? 0) + 1);
    cells.set(key, cell);
  }
  return [...cells.values()].map(c => ({
    tactic: c.tactic, trigger: c.trigger, used: c.used, worked: c.worked,
    success: c.used ? c.worked / c.used : 0,
    // Time is what a tactic costs whether or not it works, so the total is the honest
    // figure for "what did this spend of the walk" and the median for "what does one go
    // cost". Both, because one long retreat and thirty cheap ones read identically as an
    // average.
    total_ms: c.ms.reduce((a, b) => a + b, 0), median_ms: median(c.ms),
    hp_lost: c.hp,
    // Getting closer is not the same as being unstuck; a tactic can do one without the
    // other, and which one it does is the whole question for a retreat.
    closed_the_gap: c.closed,
    worst_rooms: [...c.rooms].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([room, n]) => ({ room, n })),
  })).sort((a, b) => b.total_ms - a.total_ms);
}

// ---------------------------------------------------------------- the CLI
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const fleet = arg('--fleet') ?? FLEET();
  const hours = Number(arg('--hours') ?? 24);
  const rows = readTactics({ fleet, hours });
  const table = summarise(rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ fleet, hours, rows: rows.length, tactics: table }, null, 2));
  } else if (!rows.length) {
    console.log('no tactics recorded for fleet "' + fleet + '" in the last ' + hours + 'h');
    console.log('(' + tacticsFile(fleet) + ')');
  } else {
    console.log('fleet "' + fleet + '", last ' + hours + 'h — ' + rows.length + ' tactic application(s)\n');
    console.log('tactic              trigger          used  worked   rate    total   median    hp  closer  rooms');
    for (const c of table) {
      console.log(
        c.tactic.padEnd(19) + ' ' + c.trigger.padEnd(15) + ' ' + String(c.used).padStart(4) + ' ' +
        String(c.worked).padStart(7) + ' ' + (100 * c.success).toFixed(0).padStart(5) + '% ' +
        (c.total_ms / 1000).toFixed(0).padStart(7) + 's ' + String(c.median_ms ?? '-').padStart(6) + 'ms ' +
        String(c.hp_lost).padStart(5) + ' ' + String(c.closed_the_gap).padStart(6) + '  ' +
        c.worst_rooms.map(r => r.room + 'x' + r.n).join(' '));
    }
    const worst = table.filter(c => c.used >= 3 && c.success < 0.25);
    if (worst.length) {
      console.log('\nSPENDING TIME AND NOT WORKING (3+ goes, under 25% success):');
      for (const c of worst)
        console.log('   ' + c.tactic + ' on ' + c.trigger + ': ' + c.worked + '/' + c.used + ', ' +
                    (c.total_ms / 1000).toFixed(0) + 's and ' + c.hp_lost + 'hp spent');
    }
  }
}
