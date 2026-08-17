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
import { sharedRoomGeometry } from './m59-roo.mjs';

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
export function attachStepMasks(map, { geometryOf } = {}) {
  const table = routesFor(map?.geometryManifestSha256 ?? null);
  if (!table) return { attached: 0, rooms: 0, ok: false,
                       why: load() ? 'the routing table was baked from different geometry'
                                   : 'no routing table — run node tools/m59-routebake.mjs' };
  let attached = 0, rooms = 0, refused = 0;
  for (const [num, baked] of Object.entries(table.rooms)) {
    const room = map?.rooms?.[num] ?? map?.rooms?.[Number(num)];
    if (!room?.roo || typeof baked?.stepMask !== 'string') continue;
    rooms++;
    const geometry = geometryOf ? geometryOf(room) : sharedRoomGeometry(room);
    if (!geometry) continue;
    const bytes = Buffer.from(baked.stepMask, 'base64');
    if (geometry.attachStepMask(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)))
      attached++;
    else refused++;
  }
  return { attached, rooms, refused, ok: attached > 0, view: table.view ?? 'grid' };
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
  const split = rooms.filter(r => new Set(r.anchors.map(a => a.region)).size > 1);
  console.log(`${split.length} room(s) have exits in more than one region — walking cannot ` +
              `join those, which is what blink is for`);
}
