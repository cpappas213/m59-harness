#!/usr/bin/env node
// WHEN THE GRAVEYARD IS OPEN, COUNTED FROM SOMETHING WE WATCHED RATHER THAN COMPUTED.
//
//   node tools/m59-dayclock.mjs                 # where we are in the cycle
//   node tools/m59-dayclock.mjs --start-in 60   # declare night starts in 60 minutes
//   node tools/m59-dayclock.mjs --start-now     # declare night starting right now
//   node tools/m59-dayclock.mjs --json
//
// `m59-nightshift.mjs` DERIVES the hour: `iTime = GetTime() - 5*HOUR`, a game day is two
// real hours, so the undead window is 35 real minutes in every 120. The arithmetic is
// right and it is still not trustworthy, because it is anchored to an epoch this process
// does not observe. Get the phase wrong and it reports NIGHT, in full confidence, in
// broad daylight — which is not a small error: it sent eighteen characters to stand in an
// empty graveyard killing the previous night's leftovers, and every reading agreed with
// itself the whole time. A clock with no way to be contradicted is the same failure as
// the `purpose` gate that was never on: it answers, and nothing checks the answer.
//
// So this one does not derive anything. It holds ONE fact — a moment somebody DECLARED a
// night to begin — and counts 120-minute cycles from it. That is worse in theory and
// better in practice, because the declaration comes from a person who looked at the sky,
// and being wrong is visible on the next shift instead of never.
//
// Re-anchor whenever the world disagrees with it. That is not patching over a bug, it IS
// the interface: the file records when we last saw the truth, and `--start-now` is how
// somebody standing in a spawning graveyard tells it so.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FILE = join(ROOT, 'substrate', 'gy-cycle.json');

// A game day is two real hours and the undead window is 35 real minutes of it — both
// from tosgrave.kod and system.kod, and both unchanged by the anchor being observed
// rather than computed. It is only the PHASE this file supplies.
export const CYCLE_MS = 120 * 60_000;
export const NIGHT_MS = 35 * 60_000;

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

export function readAnchor(file = FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeAnchor(atMs, { by = 'operator', note = null, file = FILE } = {}) {
  const rec = { night_starts_at: new Date(atMs).toISOString(), declared_at: new Date().toISOString(), by, note };
  writeFileSync(file, JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * Where `now` falls in the cycle that starts at `anchor`.
 *
 * The anchor may be in the FUTURE — declaring "night starts in an hour" is the ordinary
 * case — so the phase is taken modulo the cycle in a way that stays positive rather than
 * going negative before the first window. A negative modulo here would report the fleet
 * as mid-night an hour before the night, which is the exact error this file exists to
 * stop making.
 */
export function phaseAt(anchorMs, now = Date.now()) {
  const since = ((now - anchorMs) % CYCLE_MS + CYCLE_MS) % CYCLE_MS;
  const night = since < NIGHT_MS;
  return {
    night,
    into_ms: night ? since : null,
    // Time left in this window, or until the next one opens.
    closes_in_ms: night ? NIGHT_MS - since : null,
    opens_in_ms: night ? null : CYCLE_MS - since,
    cycle: Math.floor((now - anchorMs) / CYCLE_MS),
  };
}

const mins = (ms) => Math.round(ms / 60000);

if (process.argv[1]?.endsWith('m59-dayclock.mjs')) {
  const now = Date.now();
  const startIn = arg('start-in', null);
  if (arg('start-now', false)) writeAnchor(now, { note: arg('note', null) });
  else if (startIn !== null) writeAnchor(now + Number(startIn) * 60_000, { note: arg('note', null) });

  const rec = readAnchor();
  if (!rec) {
    console.log('no anchor declared yet — run --start-now while the graveyard is spawning,');
    console.log('or --start-in <minutes> if you know when the next night begins.');
    process.exit(1);
  }
  const anchor = Date.parse(rec.night_starts_at);
  const p = phaseAt(anchor, now);
  if (arg('json', false)) {
    console.log(JSON.stringify({ ...rec, ...p, now: new Date(now).toISOString() }));
  } else {
    const when = new Date(anchor).toLocaleTimeString();
    console.log(p.night
      ? `NIGHT — undead spawning; closes in ${mins(p.closes_in_ms)} min (${mins(p.into_ms)} min in)`
      : `DAY — graveyard is empty; next window opens in ${mins(p.opens_in_ms)} min`);
    console.log(`anchor: night declared for ${when} (cycle ${p.cycle}), 120 min cycle / 35 min window`);
    if (rec.note) console.log(`note:   ${rec.note}`);
    // Anything standing in 70 or 71 during the day is killing leftovers at best, so say
    // the next two openings outright rather than making somebody do the arithmetic.
    const next = [];
    for (let k = p.night ? 1 : 0; next.length < 2; k++) {
      const t = anchor + (Math.floor((now - anchor) / CYCLE_MS) + k + (p.night ? 0 : 1)) * CYCLE_MS;
      if (t > now) next.push(new Date(t).toLocaleTimeString());
    }
    console.log(`next:   ${next.join(', ')}`);
  }
}
