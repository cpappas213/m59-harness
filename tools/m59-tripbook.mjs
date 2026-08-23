// THE FLEET'S OWN SUCCESSFUL WALKS, TIDIED UP AND HANDED BACK.
//
// A room's geometry does not change. Its doors do not move. And yet every trip through a
// boundary re-derived the crossing, re-ranked the candidates, and rediscovered the same
// square by walking at the wrong ones first — so a character that had just crossed the
// whole room correctly would spend "dozens of seconds if not minutes" wiggling at an
// entrance that has been in the same place since the map was built. The fleet crosses these
// boundaries hundreds of times a day and learned nothing from any of it.
//
// This is the memory. It records what a walk ACTUALLY DID when it worked, cleans the
// walking-about out of it, and offers it back the next time somebody makes the same trip.
//
// WHAT MAKES A RECORDING SAFE TO REPLAY IS THAT EVERY STEP IN IT WAS ALREADY AUTHORISED.
// The trail is built from moves the fine validator accepted at the time, so replaying it
// cannot invent a traversal — the same argument that lets `retreatAlongBreadcrumbs` walk a
// trail backwards. It is a shortcut through the DECIDING, never through the checking: a
// replayed step still goes through the ordinary validated move, so a world that has changed
// under us refuses it exactly as it would refuse a freshly planned one.
//
// TWO CLEANING PASSES, AND THEY REMOVE DIFFERENT KINDS OF WASTE:
//
//   * ELIDE THE LOOPS. A walk that visited a square twice did a round trip in between, and
//     the round trip is the wiggling. `elideLoops` is the same function the breadcrumb
//     retreat uses, so a trip and a retreat agree on what a loop is rather than having two
//     opinions.
//   * PULL THE STRING. What is left is a list of squares, and most of a route is straight
//     line: `stringPull` reduces it to the pivots the geometry actually requires, which is
//     the 5.78x fewer moves the walker already gets on a fresh plan. A recorded trip that
//     was not pulled would replay every shuffle the original walk made.
//
// AND A TRIP IS ONLY KEPT IF IT WAS CLEAN. A crossing that took four attempts, or lost
// health on the way, is a record of something going wrong; replaying it would teach the
// fleet the bad approach as though it were the good one. `stumbles` and `hp_lost` are the
// gate, and the fastest clean recording wins — which is what makes this get better over
// time rather than merely consistent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elideLoops } from './m59-roo.mjs';
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
export const TRIPS_DIR = process.env.M59_TRIPS_DIR || path.join(HERE, '..', 'substrate', 'trips');

// How much wiggling disqualifies a recording. Zero on both, deliberately: the point of the
// book is to carry the GOOD approach, and there is no shortage of trips to learn from.
export const MAX_STUMBLES = Number(process.env.M59_TRIP_MAX_STUMBLES || 0);
export const MAX_HP_LOST = Number(process.env.M59_TRIP_MAX_HP || 0);
// A recording of two squares is not worth the bookkeeping, and one of three hundred is a
// walk that went wrong in a way the gate above did not catch.
export const MIN_STEPS = 2, MAX_STEPS = 200;

export function tripsFile(fleet = FLEET()) {
  return path.join(TRIPS_DIR, String(fleet).replace(/[^\w.-]/g, '_') + '.json');
}

let book = null, bookFleet = null, saveTimer = null;

export function loadTrips(fleet = FLEET()) {
  if (book && bookFleet === fleet) return book;
  bookFleet = fleet;
  try { book = JSON.parse(fs.readFileSync(tripsFile(fleet), 'utf8')).trips ?? {}; }
  catch { book = {}; }                    // no book means plan it fresh, exactly as before
  return book;
}

// KEYED ON THE ROOM AND THE DESTINATION, NEVER ON THE DIRECTION.
//
// One wall can carry two exits to two different rooms, split by a row or column condition —
// Western border of the Twisted Wood declares `east -> 586 row<19` and `east -> 597 row>20`.
// A book keyed by direction would hand the same approach to both and send a character to
// the wrong town while every leg reported success. This is the same mistake `anchorFor`
// exists to make inexpressible, and it must not be reintroduced here.
export const tripKey = (room, to, from) =>
  String(room) + '>' + String(to) + (from == null ? '' : '@' + String(from));

/**
 * Clean a recorded walk into something worth replaying.
 *
 * Returns null when there is nothing left worth keeping, which is the honest answer for a
 * two-step shuffle and keeps the book free of entries that save nobody anything.
 */
export function simplify(squares, { pull = null } = {}) {
  if (!Array.isArray(squares) || squares.length < MIN_STEPS) return null;
  const tidy = elideLoops(squares.filter(s => Number.isFinite(s?.row) && Number.isFinite(s?.col)));
  if (tidy.length < MIN_STEPS || tidy.length > MAX_STEPS) return null;
  // The pull is optional because the caller owns the geometry and this module must stay
  // importable without one — the CLI reads books on machines with no map loaded.
  if (typeof pull !== 'function') return tidy;
  try {
    const pulled = pull(tidy);
    return Array.isArray(pulled) && pulled.length ? pulled : tidy;
  } catch { return tidy; }
}

/**
 * Offer the recorded approach for this trip, or null.
 *
 * NULL MEANS "PLAN IT THE WAY YOU ALWAYS DID". Every consumer must read it that way: the
 * book is an accelerator over the existing router, never a replacement for it, so a fleet
 * with an empty book behaves exactly as one that has never heard of this file.
 */
export function recallTrip(room, to, from, { fleet = FLEET() } = {}) {
  const trips = loadTrips(fleet);
  return trips[tripKey(room, to, from)] ?? trips[tripKey(room, to)] ?? null;
}

/**
 * Write down a trip that worked, if it worked cleanly and beat what is already known.
 */
export function recordTrip({ room, to, from = null, squares, stand_on = null,
                             stumbles = 0, hp_lost = 0, ms = null, pull = null,
                             fleet = FLEET() } = {}) {
  try {
    if (!Number.isFinite(room) || !Number.isFinite(to)) return null;
    if (stumbles > MAX_STUMBLES || hp_lost > MAX_HP_LOST) return null;
    const steps = simplify(squares, { pull });
    if (!steps) return null;
    const trips = loadTrips(fleet);
    const key = tripKey(room, to, from);
    const had = trips[key];
    // FEWER PIVOTS IS THE MEASURE, NOT FEWER SECONDS. Wall-clock is mostly other people's
    // monsters; the number of moves a replay has to send is the part this book controls,
    // and it is the part that is stable enough to compare between two different days.
    if (had && had.steps.length <= steps.length) {
      had.seen = (had.seen ?? 1) + 1;
      schedule(fleet);
      return had;
    }
    trips[key] = { steps, ...(stand_on ? { stand_on } : {}), seen: (had?.seen ?? 0) + 1,
                   ms: Number.isFinite(ms) ? Math.round(ms) : null, at: Date.now() };
    schedule(fleet);
    return trips[key];
  } catch { return null; }
}

function schedule(fleet) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(TRIPS_DIR, { recursive: true });
      fs.writeFileSync(tripsFile(fleet), JSON.stringify({
        note: 'Walks this fleet completed cleanly, with the loops elided and the string ' +
              'pulled, offered back the next time the same trip is made. Every step was ' +
              'authorised by the fine validator when it was recorded, and a replayed step ' +
              'is validated again — this shortcuts the deciding, never the checking.',
        written: new Date().toISOString(),
        trips: book,
      }, null, 1) + String.fromCharCode(10));
    } catch { /* a fleet that cannot write its book simply plans afresh */ }
  }, 15000);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

// ---------------------------------------------------------------- the CLI
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const fleet = arg('--fleet') ?? FLEET();
  const trips = loadTrips(fleet);
  const rows = Object.entries(trips);
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ fleet, trips }, null, 2)); }
  else if (!rows.length) {
    console.log('no recorded trips for fleet "' + fleet + '"');
    console.log('(' + tripsFile(fleet) + ')');
  } else {
    console.log('fleet "' + fleet + '" — ' + rows.length + ' recorded trip(s)\n');
    console.log('trip                 pivots  seen   ms  stands on');
    for (const [key, t] of rows.sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0))) {
      console.log(key.padEnd(20) + ' ' + String(t.steps.length).padStart(6) + ' ' +
                  String(t.seen ?? 1).padStart(5) + ' ' + String(t.ms ?? '-').padStart(5) + '  ' +
                  (t.stand_on ? t.stand_on.row + ',' + t.stand_on.col : '-'));
    }
  }
}
