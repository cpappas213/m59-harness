#!/usr/bin/env node
// THE BAKED EXIT-TO-EXIT ROUTES, READ BACK.
//
//   node tools/m59-routes.mjs                 what is baked, and whether it is current
//   node tools/m59-routes.mjs --verify        every baked route re-walked against the grid
//   node tools/m59-routes.mjs --room 150      one room's anchors and routes
//
// Written by tools/m59-routebake.mjs. This is the read side: a lookup, and the checks that
// decide whether the lookup may be trusted at all.
//
// STALE IS WORSE THAN ABSENT, and that is the whole reason this file is not four lines.
// A routing table baked against a different map is a set of confident answers about a
// world that has changed — a character walking a route through a wall that was a door when
// the bake ran. So the table carries the geometry manifest it was built from, and it is
// refused outright unless that matches the map in play. Absent means "work it out", which
// is exactly what the router did before any of this existed.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES_FILE, replay } from './m59-routebake.mjs';
import { sharedRoomGeometry, STEP_MASK_VERSION } from './m59-roo.mjs';

let cache = { mtime: -1, value: null };

function load() {
  const file = ROUTES_FILE();
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.mtime === mtime) return cache.value;
  let value = null;
  if (mtime) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      value = (raw && raw.format === 'm59-routes/1' && raw.rooms) ? raw : null;
    } catch { value = null; }
  }
  cache = { mtime, value };
  return value;
}

/**
 * The table, but only if it was built from the map now in play.
 *
 * `mapManifest` is the map's own geometryManifestSha256. A table with no manifest, or one
 * that disagrees, is refused — see the note at the top.
 */
export function routesFor(mapManifest) {
  const t = load();
  if (!t) return null;
  if (!t.geometryManifestSha256 || !mapManifest) return null;
  if (t.geometryManifestSha256 !== mapManifest) return null;
  return t;
}

/**
 * Was this table's mask built by the predicate this build reads it with?
 *
 * THE MANIFEST CANNOT ANSWER THIS AND THAT IS THE WHOLE PROBLEM. It hashes the GEOMETRY,
 * so a table baked by older code against an unchanged map passes every check here and is
 * attached without a word — while every bit in it encodes a question nobody is asking any
 * more. When `moverStepLands` stopped gating on the server's coarse grid, that would have
 * kept the fleet out of hundreds of steps per room, silently, on a table that verified.
 *
 * A mismatch is NOT an error. It degrades to "plan on the coarse grid", which is exactly
 * what a checkout that has never run the bake does, and it says so — because the fix is a
 * rebake and the operator has to be told that rather than left to wonder.
 */
export function stepMaskCurrent(table) {
  return (table?.stepMaskVersion ?? 1) === STEP_MASK_VERSION;
}

/**
 * Hand every baked step mask to the geometry that will be planning on it.
 *
 * THIS IS THE ONE CALL THAT CHANGES HOW THE FLEET WALKS. Without it the router plans on
 * the server's coarse one-byte-a-square grid while the mover enforces the client's BSP,
 * and those disagree: measured across the twelve boundaries the exit-gap record complains
 * about most, 59% of walks to an exit ended with a character sliding along a wall,
 * replanning into the same wall, and giving up. With it, `neighbors({collision:true})` is
 * an array index and the router plans the steps the mover will actually make.
 *
 * REFUSED WHOLESALE IF THE MAP HAS MOVED, by the same manifest check as the routes: a mask
 * baked against different geometry is a confident map of the wrong doors. And refused per
 * room if the dimensions disagree, because a mask off by one row would never be noticed.
 *
 * Returns what it did rather than throwing. A missing or stale table is not an error — it
 * means "plan on the grid, exactly as this repository did before any of this existed" —
 * so a fresh clone that has never run the bake behaves precisely as it always has.
 */
// THE TABLE THIS PROCESS IS ACTUALLY PLANNING ON, or null.
//
// Set by `attachStepMasks` and by nothing else, so it is the table that passed the
// manifest check rather than whatever happens to be on disk. `null` is the ordinary answer
// in any tool that never attached masks, and every reader must treat it as "work it out
// live" — the table only ever held the common case, and a checkout that has never run the
// bake has to behave exactly as it did before the bake existed.
// AND IT IS AN ACCESSOR RATHER THAN A FIELD ON THE SUMMARY, which is not a style choice.
// `attachStepMasks` returns a small object that half a dozen tools print verbatim; putting
// the table on it turned `step masks: {...}` into a 1.5 MB dump of base64 masks in every
// one of them at once. A summary is something people look at.
let attachedTable = null;
export const activeRoutes = () => attachedTable;

export function attachStepMasks(map, { geometryOf } = {}) {
  const table = routesFor(map?.geometryManifestSha256 ?? null);
  if (!table) return { attached: 0, rooms: 0, ok: false,
                       why: load() ? 'the routing table was baked from different geometry'
                                   : 'no routing table — run node tools/m59-routebake.mjs' };
  // `rooms` is what the TABLE holds and `masked` is how many of those carry the payload.
  // Two counters rather than one, because "the table is empty" and "the table predates
  // step masks" are different problems with different fixes, and a single counter told
  // the second story with the first one's words.
  attachedTable = table;
  // A MASK FROM A DIFFERENT PREDICATE IS WORSE THAN NO MASK, so it is refused wholesale.
  // See stepMaskCurrent: the manifest hashes GEOMETRY and cannot see the predicate change,
  // so such a table verifies perfectly while encoding the wrong doors.
  //
  // REFUSED, BUT NOT SHORT-CIRCUITED — this loop is how several callers BUILD their
  // geometry. `geometryOf` is not only a lookup, it is a constructor with a cache behind
  // it (m59-stringpull-test, m59-overlay, m59-highlight, m59-hoptest and m59-provewall all
  // populate a Map from inside it), so returning early left every one of them holding an
  // empty cache and a TypeError. Refusing to attach is the decision; not visiting the
  // rooms was an accident of where the decision was made.
  const stale = !stepMaskCurrent(table);
  let attached = 0, refused = 0, masked = 0;
  const rooms = Object.keys(table.rooms).length;
  for (const [num, baked] of Object.entries(table.rooms)) {
    if (typeof baked?.stepMask !== 'string') continue;
    masked++;
    const room = map?.rooms?.[num] ?? map?.rooms?.[Number(num)];
    if (!room?.roo) continue;
    const geometry = geometryOf ? geometryOf(room) : sharedRoomGeometry(room);
    if (!geometry) continue;
    if (stale) continue;                 // geometry built above; the mask is not trusted
    const bytes = Buffer.from(baked.stepMask, 'base64');
    if (geometry.attachStepMask(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)))
      attached++;
    else refused++;
  }
  // A TABLE WITH NO MASKS IN IT IS ITS OWN ANSWER, and it is one somebody will actually
  // hit: every table baked before masks existed has all 264 rooms, matches the manifest,
  // and carries nothing the router can use. "No routing table" would send them looking for
  // a file that is sitting right there.
  if (stale)
    return { attached: 0, rooms, masked, refused: 0, ok: false, view: table.view ?? 'grid',
             why: `the routing table's step masks were baked by an older predicate ` +
                  `(v${table.stepMaskVersion ?? 1}, this build reads v${STEP_MASK_VERSION}) — ` +
                  `rerun node tools/m59-routebake.mjs` };
  return { attached, rooms, masked, refused, ok: attached > 0, view: table.view ?? 'grid',
           ...(attached ? {} : { why: !rooms
             ? 'the routing table has no rooms in it'
             : !masked
               ? `the routing table has ${rooms} room(s) and no step masks — it predates them; ` +
                 'rerun node tools/m59-routebake.mjs'
               : `${masked} step mask(s) on disk and none of them fit the map in play` }) };
}

/** Is this room's exit set split by geometry, and into how many reachable groups? */
export function regionsOf(table, roomNum) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  return { regions: r.regions, anchors: r.anchors, view: r.view ?? 'grid' };
}

/**
 * A baked path between two squares, as steps, or null.
 *
 * Null is the ordinary answer for anything that is not an exit-to-exit trip, and callers
 * must treat it as "work it out yourself" rather than as "there is no route" — the table
 * only ever held the common case.
 */
export function bakedPath(table, roomNum, from, to) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  const p = r.routes?.[`${from.row},${from.col}>${to.row},${to.col}`];
  if (typeof p !== 'string') return null;
  return replay(from.row, from.col, p);
}

/**
 * The baked square to stand on to leave `roomNum` for `toRoom`, or null.
 *
 * ASK BY DESTINATION, NOT BY DIRECTION — that distinction is the whole point of this
 * accessor. A wall can carry two exits to two different rooms, split by a row or column
 * condition (Western border of the Twisted Wood sends `row<19` to Main gate to the city of
 * Tos and `row>20` to The Twisted Wood, both eastward). A caller that asks "where do I
 * cross going east" gets a square that is right for one destination and silently wrong for
 * the other: the walk succeeds, every leg reports success, and the character is in the
 * wrong room. `exitAnchors` bakes one anchor per declared exit for exactly this reason, so
 * reading it back by direction would throw the distinction away again at the last step.
 *
 * `from_body` is not filtered here. An anchor the room's main body cannot reach is still
 * the right place to leave from — it is reported so a caller can prefer another exit, and
 * a bake must never be the reason a doorway disappears.
 */
export function anchorFor(table, roomNum, toRoom) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r?.anchors) return null;
  const want = Number(toRoom);
  const hit = r.anchors.filter(a => Number(a.to) === want);
  if (!hit.length) return null;
  // Two declared exits to the SAME room is ordinary (The King's Way reaches 575 twice).
  // Prefer one the body can walk to; otherwise the first, which is still a real crossing.
  return hit.find(a => a.from_body) ?? hit[0];
}

/**
 * A baked route as PIVOTS — the corners a walker actually has to aim at — or null.
 *
 * Same contract as `bakedPath`: null means "the table does not cover this", never "there
 * is no route". The difference is what the caller then does with it. A route handed over
 * as 73 grid squares is 73 chances to end up somewhere the plan did not expect, because a
 * step that SLIDES lands off-plan and the walker replans from a square it never chose;
 * measured in the Western border of the Twisted Wood, 218 of 311 grid steps failed and 200
 * of those did not move the character at all. The same route as 21 pivots is 21 aimed
 * moves, each already checked offline to ARRIVE rather than slide.
 *
 * `unverified` counts the legs the string pull could not prove. They are still emitted —
 * the underlying grid route is real — but a caller that cares can fall back rather than
 * trust a long leg through geometry nobody confirmed.
 */
export function bakedPivots(table, roomNum, from, to) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  const p = r?.pivots?.[`${from.row},${from.col}>${to.row},${to.col}`];
  if (!p?.squares?.length) return null;
  return { squares: p.squares.map(([row, col]) => ({ row, col })),
           unverified: p.unverified ?? 0 };
}

// A CLIENT REPORTS ITS POSITION ABOUT ONCE A SECOND, so what a room crossing COSTS is
// packets, not squares. Measured in Western border of the Twisted Wood, a six-route sample
// is 311 grid squares and 66 pivots; charging the squares overstates the trip by 4.7x and,
// worse, overstates it UNEVENLY — a long straight hall costs one pivot and a short
// switchback costs eight, so ranking candidate routes on square count prefers exactly the
// rooms that are slowest to walk.
const SECONDS_PER_PIVOT = 1.0;

/**
 * What crossing this room between these two exits should cost, in seconds, or null.
 *
 * Null means the table does not cover this pair, and a caller must read it as "no
 * estimate" rather than "free" — a zero here would make an unbaked room the most
 * attractive one on every route. This is an estimate of WALKING and nothing else: it
 * cannot know about a monster standing in a doorway, and it is not a promise.
 */
export function transitCost(table, roomNum, from, to) {
  const p = bakedPivots(table, roomNum, from, to);
  if (!p) return null;
  // The first pivot is where we already are, so the moves are the gaps between them.
  return { seconds: Math.max(0, p.squares.length - 1) * SECONDS_PER_PIVOT,
           pivots: p.squares.length, unverified: p.unverified };
}

/** Can walking join these two exits at all? `null` when the table cannot say. */
export function sameRegion(table, roomNum, a, b) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  const find = s => r.anchors.find(x => x.row === s.row && x.col === s.col);
  const x = find(a), y = find(b);
  if (!x || !y || x.region < 0 || y.region < 0) return null;
  return x.region === y.region;
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const t = load();
  if (!t) { console.error(`no usable table at ${ROUTES_FILE()} — run node tools/m59-routebake.mjs`); process.exit(1); }

  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(movementMapFile());
  const current = t.geometryManifestSha256 === map.geometryManifestSha256;

  if (val('--room')) {
    const n = Number(val('--room'));
    const r = t.rooms[n] ?? t.rooms[String(n)];
    if (!r) { console.error(`room ${n} is not in the table`); process.exit(1); }
    console.log(`room ${n} — ${r.rows}x${r.cols}, ${r.regions} region(s), view ${r.view ?? 'grid'}`);
    for (const a of r.anchors)
      console.log(`  ${a.kind.padEnd(5)} ${(a.dir ?? '').padEnd(6)} to ${String(a.to ?? '?').padEnd(6)}` +
                  ` at ${a.col},${a.row}  region ${a.region}`);
    console.log(`  ${Object.keys(r.routes).length} baked route(s)`);
    process.exit(0);
  }

  if (argv.includes('--verify')) {
    // EVERY STORED ROUTE RE-WALKED. A path is only worth having if each step is one the
    // grid actually permits and it lands exactly on the square it claims — a table that
    // is subtly wrong is worse than none, because nothing downstream re-checks it.
    let checked = 0, bad = 0, badRooms = new Set();
    for (const [num, r] of Object.entries(t.rooms)) {
      const room = map.rooms[num] ?? map.rooms[Number(num)];
      if (!room?.roo) continue;
      const g = sharedRoomGeometry(room);
      for (const [pair, path] of Object.entries(r.routes)) {
        const [a, b] = pair.split('>');
        const [fr, fc] = a.split(',').map(Number);
        const [tr, tc] = b.split(',').map(Number);
        const steps = replay(fr, fc, path);
        checked++;
        let ok = steps.length > 0;
        let pr = fr, pc = fc;
        for (const s of steps) {
          if (!g.walkable(s.row, s.col) ||
              Math.abs(s.row - pr) > 1 || Math.abs(s.col - pc) > 1) { ok = false; break; }
          pr = s.row; pc = s.col;
        }
        if (ok && (pr !== tr || pc !== tc)) ok = false;
        if (!ok) { bad++; badRooms.add(num); }
      }
    }
    console.log(`re-walked ${checked} baked route(s): ${checked - bad} valid, ${bad} invalid` +
                (bad ? ` across ${badRooms.size} room(s)` : ''));
    process.exit(bad ? 1 : 0);
  }

  const rooms = Object.values(t.rooms);
  const routes = rooms.reduce((n, r) => n + Object.keys(r.routes).length, 0);
  console.log(`${rooms.length} room(s), ${routes} baked route(s), view ${t.view ?? 'grid'}`);
  console.log(`built ${t.builtAt}`);
  console.log(current ? 'manifest MATCHES the map in play — the table is usable'
                      : 'manifest DOES NOT match the map in play — the table is refused, ' +
                        'run node tools/m59-routebake.mjs');
  // NOT "REGIONS", AND NOT "BLINK". This line used to count rooms whose exits fall in more
  // than one region and call those unwalkable. Both halves were wrong. A region is a
  // strongly connected component, and an exit square is very often a pocket BY DESIGN —
  // you step into the doorway and cannot step back off it — so "more than one region" is
  // the normal shape of a room with two doors in it. What can be said is one-directional:
  // how many exits the body of the room cannot walk to. Even that is a claim about this
  // MODEL, which is stricter than the client it models; the one place in the world
  // genuinely joined only by blink is the Cragged Mountains cliff (578, 598).
  const masked = rooms.filter(r => typeof r.stepMask === 'string').length;
  console.log(`${masked} room(s) carry a step mask — the part the router actually plans on`);
  const stranded = rooms.reduce((n, r) => n + (r.stranded_exits ?? 0), 0);
  const anchors = rooms.reduce((n, r) => n + r.anchors.length, 0);
  const pockets = rooms.reduce((n, r) => n + (r.pockets ?? 0), 0);
  console.log(`${pockets} pocket(s) off the main body across the world — these are the ` +
              `safe-spot candidates, not damage`);
  console.log(`${stranded} of ${anchors} exit anchor(s) this model cannot walk to from ` +
              `their own room's body — go and look before believing any one of them`);
}
