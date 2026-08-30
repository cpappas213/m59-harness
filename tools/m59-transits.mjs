#!/usr/bin/env node
// HOW LONG IT TAKES TO CROSS ONE MAP, measured per room, per journey.
//
//   node tools/m59-transits.mjs                 slowest rooms first, fleet-wide
//   node tools/m59-transits.mjs --worst 40      the forty slowest individual crossings
//   node tools/m59-transits.mjs --room 544      every crossing of one room
//   node tools/m59-transits.mjs --character Gonzo
//   node tools/m59-transits.mjs --failures      only the hops that never got out
//
// WHY THIS EXISTS, AND WHAT IT IS NOT FOR.
//
// It is NOT for measuring damage taken in transit. There is no safe travel in Meridian 59
// and there is not meant to be: human players die crossing the world constantly, taking
// hits on the road is a normal feature of the game, and the world is expected to get more
// dangerous as other players start hunting these characters. A journey that took damage is
// a journey, not a fault. Damage is minimised by leaving at full health and the best vigor
// that food and rest can buy, by moving faster, by evading, and by picking a cheaper route
// — never by giving up partway, which would cancel most journeys the fleet ever makes.
//
// It IS for TIME EXPOSED. Every second spent inside a map is a second something can reach
// you, so the crossing time is the thing worth attacking, and it is a number nothing was
// recording. The case that started this: Gonzo took ten hits in ten different squares of
// the Valley of Ileria between 09:36:01 and 09:37:55 — nearly two minutes inside one map.
// Most maps in this game can be crossed in well under a minute from any exit to any other.
// A two-minute crossing is not a dangerous map, it is a slow one, and slow is a thing we
// control.
//
// SO THE MEASUREMENT IS PER ROOM AND PER ATTEMPT, not per journey. A journey that took six
// minutes tells you nothing; six rooms with one of them at 114 seconds tells you where to
// look. `tried` and `reason` are recorded with the time because the suspicion is that most
// of the tail is not walking at all — it is candidate exit squares being refused one after
// another, each attempt paced against the server, with the successful one arrived at last.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const TRANSIT_DIR = process.env.M59_TRANSIT_DIR || here('../substrate/transits');

// A few hours of travel for a busy character. Crossings are far rarer than hits — one per
// room entered rather than one per swing — so this is a deeper history for a smaller file.
const MAX_TRANSITS = 600;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(TRANSIT_DIR, `${safeName(character)}.json`);

export function emptyBook(character) {
  return { character: character ?? null, version: 1, transits: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;
  try {
    mkdirSync(TRANSIT_DIR, { recursive: true });
    writeFileSync(fileFor(book.character), JSON.stringify(book, null, 2));
    return fileFor(book.character);
  } catch { return null; }
}

export const listCharacters = () => {
  try { return readdirSync(TRANSIT_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// One room, crossed once, during one journey.
//
// `ms` is the whole time in the room — from the moment the previous hop's arrival settled
// to the moment we left. `walk_ms` is only the part inside leaveViaAny. The DIFFERENCE is
// route planning and exit selection, and separating them is the point: if the tail is in
// `ms - walk_ms` the problem is deciding, and if it is in `walk_ms` the problem is doing.
export function record(book, { at = Date.now(), room = null, roomName = null,
                               to = null, toName = null, ms = 0, walkMs = null,
                               ok = true, tried = 1, reason = null,
                               journey = null, hop = null, destination = null,
                               // WHY EACH SQUARE SAID NO, AND THE ONE THE MODEL BELIEVED IN.
                               //
                               // These are named here because this function REBUILDS the row
                               // from a fixed list rather than spreading what it was given —
                               // so a field added at the call site is silently discarded at
                               // the writer. `refusals` was added to `noteTransit` earlier
                               // today precisely so that "every square for that exit refused
                               // (4 tried)" would stop being opaque, and four more of those
                               // rows were written tonight with the detail dropped on this
                               // line. No error, no warning, just an empty column.
                               refusals = null, believed = null } = {}) {
  const t = { at, room, room_name: roomName, to, to_name: toName,
              ms, walk_ms: walkMs, ok, tried,
              ...(reason ? { reason } : {}),
              ...(refusals?.length ? { refusals } : {}),
              ...(believed ? { believed } : {}),
              journey, hop, destination };
  book.transits.push(t);
  while (book.transits.length > MAX_TRANSITS) book.transits.shift();
  return t;
}

const pctile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

// WHAT THE FLEET'S TRAVEL ACTUALLY COSTS, by room.
//
// The median is not the interesting number and never was — it is the tail that kills, and
// a room whose median crossing is 8 seconds and whose p99 is 140 is a room with a specific
// bug in it rather than a big map.
export function byRoom(books, { since = 0, failuresOnly = false } = {}) {
  const rooms = new Map();
  for (const b of books) {
    for (const t of b.transits || []) {
      if (t.at < since) continue;
      if (failuresOnly && t.ok) continue;
      const k = t.room;
      if (!rooms.has(k)) rooms.set(k, { room: k, name: t.room_name, times: [], fails: 0,
                                        tried: 0, crossings: 0, worst: null });
      const r = rooms.get(k);
      r.name ??= t.room_name;
      r.crossings++;
      r.times.push(t.ms);
      r.tried += t.tried || 1;
      if (!t.ok) r.fails++;
      if (!r.worst || t.ms > r.worst.ms) r.worst = t;
    }
  }
  const out = [...rooms.values()].map(r => {
    const s = r.times.slice().sort((a, b) => a - b);
    return { room: r.room, name: r.name, crossings: r.crossings, failed: r.fails,
             median_ms: pctile(s, 0.5), p90_ms: pctile(s, 0.9), max_ms: s[s.length - 1] ?? 0,
             // How many exit squares had to be attempted per crossing on average. Above 1
             // means squares are being refused, which is where the suspicion points.
             squares_per_crossing: +(r.tried / r.crossings).toFixed(2),
             worst: r.worst };
  });
  out.sort((a, b) => b.max_ms - a.max_ms);
  return out;
}

// ------------------------------------------------------------------ the command line

if (process.argv[1]?.endsWith('m59-transits.mjs')) {
  const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? true) : dflt;
  };
  const only = arg('character');
  const roomWanted = arg('room');
  const worstN = Number(arg('worst', 0));
  const failuresOnly = process.argv.includes('--failures');
  // ONLY THIS RUN, BECAUSE THE LEDGER IS APPEND-ONLY AND OUTLIVES THE CODE THAT WROTE IT.
  //
  // Every number here is an attribute of a BUILD as much as of a map, and the book holds
  // months of crossings made by walkers that have since been fixed. Reporting the lot and
  // calling it "how we do" averages the current code with every version of itself, which is
  // the one thing a before-and-after must not do. Accepts an ISO timestamp, a millisecond
  // epoch, or a plain age — `--since 45m`, `--since 3h`.
  const sinceArg = arg('since');
  const since = (() => {
    if (!sinceArg || sinceArg === true) return 0;
    const age = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(sinceArg));
    if (age) {
      const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[age[2]];
      return Date.now() - Number(age[1]) * unit;
    }
    const n = Number(sinceArg);
    if (Number.isFinite(n) && n > 1e11) return n;
    const t = Date.parse(String(sinceArg));
    return Number.isFinite(t) ? t : 0;
  })();
  const names = only ? [safeName(only)] : listCharacters();
  if (!names.length) {
    console.log(`no transit records yet — ${TRANSIT_DIR} is empty.`);
    console.log('The broker writes one per room crossed during a travel; give a running fleet a while.');
    process.exit(0);
  }
  const books = names.map(loadBook);
  const secs = (ms) => (ms / 1000).toFixed(1) + 's';
  const pad = (s, w) => String(s).padEnd(w);

  let all = books.flatMap(b => (b.transits || []).map(t => ({ ...t, who: b.character })));
  if (since) all = all.filter(t => (t.at ?? 0) >= since);
  if (roomWanted != null) all = all.filter(t => String(t.room) === String(roomWanted));
  if (failuresOnly) all = all.filter(t => !t.ok);
  if (!all.length) { console.log('nothing recorded that matches.'); process.exit(0); }

  if (worstN || roomWanted != null || only) {
    const rows = all.slice().sort((a, b) => b.ms - a.ms).slice(0, worstN || 30);
    console.log(pad('when', 10) + pad('who', 10) + pad('room', 34) + pad('->', 26) +
                pad('in room', 10) + pad('walking', 10) + pad('squares', 9) + 'outcome');
    for (const t of rows)
      console.log(pad(new Date(t.at).toISOString().slice(11, 19), 10) + pad(t.who, 10) +
                  pad(`${t.room_name ?? '?'} (${t.room})`, 34) +
                  pad(`${t.to_name ?? t.to ?? '?'}`, 26) +
                  pad(secs(t.ms), 10) + pad(t.walk_ms != null ? secs(t.walk_ms) : '-', 10) +
                  pad(t.tried, 9) + (t.ok ? 'left' : `FAILED — ${String(t.reason).slice(0, 44)}`));
    console.log('');
  }

  // PER BOUNDARY, WHICH IS THE QUESTION "HOW LONG BETWEEN THESE TWO MAPS" ACTUALLY ASKS.
  //
  // `byRoom` below answers a different and also-useful one — how long a body spends INSIDE
  // a map, whichever door it came in by — and the header argues for it. But a fleet walking
  // a fixed itinerary is crossing named boundaries, and a boundary is where the failures
  // live: 586 -> 587 and 587 -> 576 were 0/3 while 587's own floor routed perfectly.
  //
  // Both maps are named by number AND name on both sides, because a room number is what
  // every tool here speaks and a name is what a person recognises, and the two have been
  // confused in this repository often enough to be worth the width.
  if (process.argv.includes('--hops')) {
    const byHop = new Map();
    for (const t of all) {
      const k = `${t.room}>${t.to}`;
      const e = byHop.get(k) ?? { room: t.room, room_name: t.room_name, to: t.to,
                                  to_name: t.to_name, ok: [], failed: 0, reasons: new Map() };
      if (t.ok) e.ok.push(t.ms); else {
        e.failed++;
        e.reasons.set(t.reason ?? 'no reason', (e.reasons.get(t.reason ?? 'no reason') ?? 0) + 1);
      }
      byHop.set(k, e);
    }
    const rows = [...byHop.values()].map(e => {
      const s = e.ok.slice().sort((a, b) => a - b);
      return { ...e, crossed: s.length,
               median_ms: pctile(s, 0.5), p90_ms: pctile(s, 0.9), max_ms: s[s.length - 1] ?? 0 };
    }).sort((a, b) => b.max_ms - a.max_ms);
    console.log(pad('from', 38) + pad('to', 38) + pad('crossed', 9) + pad('failed', 8) +
                pad('median', 9) + pad('p90', 9) + pad('worst', 9) + 'commonest refusal');
    for (const r of rows) {
      const worstReason = [...r.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      console.log(pad(`${r.room} - ${r.room_name ?? '?'}`, 38) +
                  pad(`${r.to} - ${r.to_name ?? '?'}`, 38) +
                  pad(r.crossed, 9) + pad(r.failed, 8) +
                  pad(r.crossed ? secs(r.median_ms) : '-', 9) +
                  pad(r.crossed ? secs(r.p90_ms) : '-', 9) +
                  pad(r.crossed ? secs(r.max_ms) : '-', 9) +
                  (worstReason ? `${worstReason[0]} x${worstReason[1]}` : ''));
    }
    const okAll = all.filter(t => t.ok).map(t => t.ms).sort((a, b) => a - b);
    console.log('');
    console.log(`${rows.length} boundaries, ${all.length} attempts, ${okAll.length} crossed, ` +
                `${all.length - okAll.length} refused. Across every crossing: median ` +
                `${secs(pctile(okAll, 0.5))}, p90 ${secs(pctile(okAll, 0.9))}, ` +
                `worst ${secs(okAll[okAll.length - 1] ?? 0)}.`);
    process.exit(0);
  }

  // `since` GOES HERE TOO, AND IT DID NOT. `byRoom` has taken a `since` since it was
  // written and this call never passed it, so `--since` filtered the worst-crossings list
  // and the footer while the per-room table -- the part anybody actually reads -- silently
  // reported every crossing ever recorded. `--since 45m` printed a footer saying 242
  // crossings directly above a table whose first row claimed 954, and the two numbers were
  // answering different questions with the same word.
  //
  // That is the exact failure the header of this file argues against: the book holds months
  // of crossings made by walkers that have since been fixed, and reporting the lot is how a
  // before-and-after becomes an average of the code with every version of itself.
  const rooms = byRoom(books, { failuresOnly, since });
  console.log(pad('room', 36) + pad('crossings', 11) + pad('failed', 8) +
              pad('median', 9) + pad('p90', 9) + pad('worst', 9) + 'squares/crossing');
  for (const r of rooms.slice(0, 25))
    console.log(pad(`${r.name ?? '?'} (${r.room})`, 36) + pad(r.crossings, 11) + pad(r.failed, 8) +
                pad(secs(r.median_ms), 9) + pad(secs(r.p90_ms), 9) + pad(secs(r.max_ms), 9) +
                r.squares_per_crossing);
  const every = all.map(t => t.ms).sort((a, b) => a - b);
  console.log('');
  console.log(`${all.length} crossings — median ${secs(pctile(every, 0.5))}, ` +
              `p90 ${secs(pctile(every, 0.9))}, p99 ${secs(pctile(every, 0.99))}, ` +
              `worst ${secs(every[every.length - 1])}. ` +
              `${all.filter(t => !t.ok).length} never got out.`);
  console.log('A map that cannot be crossed in under a minute is a map with a problem in ' +
              'it, not a big map.');
}

// HOW LONG A JOURNEY WILL TAKE, FROM HOW LONG THE SAME HOPS HAVE TAKEN BEFORE.
//
// The graveyard is the reason this exists. It generates for 35 real minutes in every 120
// and nothing at all in between, so a shift that sets off when the window OPENS spends a
// chunk of it walking — and the walk from the King's Way is not short. Setting off early
// by the length of the walk turns travel time into window time.
//
// PER-EDGE, NOT PER-JOURNEY. Journeys are between arbitrary pairs and most pairs have
// never been walked, but the EDGES repeat constantly — the same corridors carry every
// trip. So the estimate is the sum of each hop's own history, which means a route nobody
// has ever taken end to end still gets a real number as long as its pieces are familiar.
//
// The median, not the mean: transit times have a long tail (a blocked square, a monster in
// a doorway, a replan) and a handful of 40-second hops would drag a mean far above what a
// journey normally costs. The tail is real, which is what `p90JourneyMs` is for — a shift
// that wants to be THERE on time should leave on the pessimistic number, not the typical
// one.
const edgeKey = (from, to) => `${from}->${to}`;

export function edgeTimes(books, { since = 0 } = {}) {
  const edges = new Map();
  for (const b of books) {
    for (const t of b.transits || []) {
      // A failed crossing is not a duration — it is a crossing that did not happen, and
      // averaging it in would price a route by how often it goes wrong rather than how
      // long it takes when it works. Failure belongs in `byRoom`, which is about exactly
      // that, and not here.
      if (!t.ok || t.at < since || t.room == null || t.to == null) continue;
      const k = edgeKey(t.room, t.to);
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(t.ms);
    }
  }
  const out = new Map();
  for (const [k, times] of edges) {
    const s = times.sort((a, b) => a - b);
    out.set(k, { samples: s.length, median_ms: pctile(s, 0.5), p90_ms: pctile(s, 0.9) });
  }
  return out;
}

// What a hop costs when this pair has never been walked. Measured across the fleet's whole
// history rather than guessed, and recomputed from the same books, so it moves when the
// world does. The fallback matters more than it looks: a route into an unfamiliar corner
// is exactly when an estimate is most needed and least informed.
export function typicalHopMs(edges) {
  const all = [...edges.values()].flatMap(e => Array(e.samples).fill(e.median_ms))
    .sort((a, b) => a - b);
  return all.length ? pctile(all, 0.5) : 6000;
}

/**
 * Estimate a journey from its hops. `hops` is what `findPath` returns.
 *
 * Reports how much of the answer is real history — `known_hops` against `hops` — because
 * an estimate assembled mostly from the fallback is a different kind of number from one
 * assembled from a hundred crossings of the same corridor, and a caller deciding when to
 * set off should be able to tell them apart.
 */
export function estimateJourney(hops = [], edges, { percentile = 'p90' } = {}) {
  const fallback = typicalHopMs(edges);
  const field = percentile === 'median' ? 'median_ms' : 'p90_ms';
  let total = 0, known = 0, samples = 0;
  for (const hop of hops) {
    const e = edges.get(edgeKey(hop.from, hop.to));
    if (e) { total += e[field]; known += 1; samples += e.samples; }
    else total += fallback;
  }
  return { ms: Math.round(total), hops: hops.length, known_hops: known, samples,
           fallback_hop_ms: fallback, basis: percentile,
           confidence: hops.length ? known / hops.length : 0 };
}

/** Every character with a transit book on disk. */
export function allCharacters() {
  try { return readdirSync(TRANSIT_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
}
