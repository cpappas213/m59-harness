#!/usr/bin/env node
// BLINK IS A ONE-WAY PORTAL AND EVERY ROOM HAS ONE.
//
//   node tools/m59-blink.mjs            # every room whose blink point opens a door walking cannot
//   node tools/m59-blink.mjs --save     # write substrate/m59-blink.json for the route bake
//   node tools/m59-blink.mjs --room 382 # one room, whatever it says
//
// `blink.kod` says "Teleports you to a central location in the room" and posts @Teleport to
// the room, which answers from `viTeleport_row` / `viTeleport_col` — a FIXED pair declared
// per room in the kod. So from anywhere a character can cast, it can reach that one square,
// and therefore everything that square can walk to.
//
// FOR MOST ROOMS THIS OPENS NOTHING, and that is the expected result rather than a
// disappointment: where a room is one connected body, the blink point was already reachable.
// It matters exactly where a room has a one-way ledge, and there it can save a whole map of
// travel. West Jasper is the worked example — entering from the north edge leaves a body in
// a 795-square pocket that reaches ONE of seven doors by walking, and the blink point at
// 37,25 sits outside that pocket and reaches ALL SEVEN.
//
// IT IS NOT FREE, AND NOTHING HERE MAY PRETEND IT IS. Casting costs mana, a character may
// have to rest to afford it, and a cast can fail and need repeating. So blink reachability
// is recorded SEPARATELY from walking and never merged into it: walking is what the router
// plans on, and blink is what a caller may fall back to when walking cannot answer at all.
//
// Coordinates are the kod's, which is what substrate/m59-map.json already uses — checked
// against jaswest.kod's `plExits = Cons([ 49, 36, ROOM_LOCKED_DOOR ])` and the same exit in
// the map, which agree exactly.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'substrate', 'm59-blink.json');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

export function kodRoot() {
  const guesses = [process.env.M59_ROOT, 'C:/code/Meridian59',
                   join(HERE, '..', '..', '..', 'Meridian59')].filter(Boolean);
  for (const g of guesses) {
    try { if (statSync(join(g, 'kod')).isDirectory()) return g; } catch { /* next */ }
  }
  return null;
}

function kodFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) kodFiles(p, out);
    else if (e.name.endsWith('.kod')) out.push(p);
  }
  return out;
}

/**
 * The blink point declared in one kod file, and which .roo it belongs to.
 *
 * A kod file is one class is one room, so a file naming exactly one .roo and declaring a
 * teleport pair is unambiguous. A file naming several is REFUSED rather than guessed at: a
 * blink point attached to the wrong room is worse than no blink point at all, because it
 * would claim exits a character cannot actually reach.
 */
export function blinkIn(text) {
  const row = /\bviTeleport_row\s*=\s*(-?\d+)/.exec(text);
  const col = /\bviTeleport_col\s*=\s*(-?\d+)/.exec(text);
  if (!row || !col) return null;
  const roos = [...new Set([...text.matchAll(/=\s*([\w.\-]+\.roo)\b/gi)].map(m => m[1].toLowerCase()))];
  if (roos.length !== 1) return { ambiguous: roos };
  const angle = /\bviTeleport_angle\s*=\s*(-?\d+)/.exec(text);
  return {
    roo: roos[0], row: Number(row[1]), col: Number(col[1]),
    ...(angle ? { angle: Number(angle[1]) } : {}),
  };
}

export function collectBlinks(root = kodRoot()) {
  if (!root) return { points: {}, ambiguous: [], declared: 0, root: null };
  const points = {};
  const ambiguous = [];
  let declared = 0;
  for (const f of kodFiles(join(root, 'kod'))) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const b = blinkIn(text);
    if (!b) continue;
    declared++;
    if (b.ambiguous) { ambiguous.push({ file: f.slice(root.length + 1), roos: b.ambiguous }); continue; }
    points[b.roo] = { row: b.row, col: b.col, ...(b.angle != null ? { angle: b.angle } : {}) };
  }
  return { points, ambiguous, declared, root };
}

const direct = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (direct) {
  const { points, ambiguous, declared, root } = collectBlinks();
  if (!root) {
    console.error('no Meridian 59 source tree found — set M59_ROOT to it');
    process.exit(2);
  }
  const { loadMap } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const map = await loadMap();
  try { attachStepMasks(map); } catch { /* coarse, as everywhere */ }

  const only = arg('--room') ? Number(arg('--room')) : null;
  const byRoom = {};
  const rows = [];
  let matched = 0;

  for (const key of Object.keys(map.rooms)) {
    const room = map.rooms[key];
    const file = String(room?.roo?.file ?? room?.rooFile ?? '').toLowerCase();
    const p = points[file];
    if (!p) continue;
    matched++;
    byRoom[room.num] = { row: p.row, col: p.col, ...(p.angle != null ? { angle: p.angle } : {}) };
    if (only && room.num !== only) continue;

    let g = null;
    try { g = sharedRoomGeometry(room); } catch { /* no geometry */ }
    if (!g?.collisionReady) continue;
    const exits = [...(room.edgeExits ?? []), ...(room.goExits ?? [])]
      .filter(e => Number.isFinite(e.row) && Number.isFinite(e.col));
    if (!exits.length) continue;

    const flood = (sr, sc) => {
      if (!g.walkable(sr, sc)) return null;
      const seen = new Set([`${sr},${sc}`]);
      const st = [[sr, sc]];
      while (st.length) {
        const [y, x] = st.pop();
        for (const n of g.neighbors(y, x, { collision: true }) ?? []) {
          const k = `${n.row},${n.col}`;
          if (seen.has(k)) continue;
          seen.add(k); st.push([n.row, n.col]);
        }
      }
      return seen;
    };

    const fromBlink = flood(p.row, p.col);
    if (!fromBlink) { rows.push([room.num, room.name, 'not walkable', 0, 0]); continue; }
    const blinkDoors = exits.filter(e => fromBlink.has(`${e.row},${e.col}`)).length;
    // The WORST any single doorway manages by walking is the number that matters: that is
    // the body a character gets stranded in when it arrives through the wrong door.
    // AND HOW BIG THE PLACE IT STRANDS YOU IN IS, which is the difference between a finding
    // and an artefact. An exit anchor is very often a one-square pocket BY DESIGN -- you step
    // into a doorway and cannot step back off it -- and such a doorway reaching one door is
    // the system working, not a trap. A doorway that drops you into EIGHT HUNDRED squares
    // with one way out is a trap, and that is West Jasper.
    let worst = Infinity, strandedIn = 0;
    for (const e of exits) {
      const f = flood(e.row, e.col);
      if (!f) continue;
      const doors = exits.filter(x => f.has(`${x.row},${x.col}`)).length;
      if (doors < worst) { worst = doors; strandedIn = f.size; }
    }
    if (!Number.isFinite(worst)) worst = 0;
    rows.push([room.num, room.name, `${blinkDoors}/${exits.length}`, worst,
               blinkDoors - worst, strandedIn]);
  }

  const gained = rows.filter(r => r[4] > 0).sort((a, b) => b[4] - a[4]);
  console.log(`${declared} kod room file(s) declare a blink point; ${matched} matched a room in the map` +
              (ambiguous.length ? `; ${ambiguous.length} skipped as ambiguous` : ''));
  console.log(`\n${gained.length} room(s) where blinking reaches doors the worst-off doorway cannot walk to:\n`);
  console.log('room  name                             blink reaches  worst walk  gained  stranded in');
  for (const [num, name, reach, worst, gain, stranded] of (only ? rows : gained).slice(0, 40)) {
    console.log(String(num).padStart(4) + '  ' + String(name).slice(0, 30).padEnd(32) +
                String(reach).padStart(9) + String(worst).padStart(12) +
                String(gain > 0 ? '+' + gain : gain).padStart(8) +
                String(stranded).padStart(13) + (stranded >= 20 ? '  <- a real trap' : ''));
  }
  const traps = gained.filter(r => r[5] >= 20);
  console.log(`
${traps.length} of those strand a body in 20+ squares rather than a one-square ` +
              `doorway pocket, which is the difference between a trap and the system working.`);

  if (argv.includes('--save')) {
    writeFileSync(OUT, JSON.stringify({
      note: 'viTeleport_row/col per room, from the kod. Blink teleports the caster to this ' +
            'square from anywhere in the room, so anything that square can walk to is ' +
            'reachable from anywhere a character can cast. It costs mana and can fail, so it ' +
            'is recorded separately from walking and must never be merged into it.',
      written: new Date().toISOString(), source: root, rooms: byRoom,
    }, null, 1) + '\n');
    console.log('\nwrote ' + OUT);
  }
}
