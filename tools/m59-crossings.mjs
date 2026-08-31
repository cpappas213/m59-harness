#!/usr/bin/env node
// WHERE A PERSON ACTUALLY CROSSED, HARVESTED FROM RECORDED WALKS.
//
//   node tools/m59-crossings.mjs                 what has been observed
//   node tools/m59-crossings.mjs --save          write substrate/m59-crossings.json
//   node tools/m59-crossings.mjs --compare       observed against what exits() offers
//
// THE MODEL INVENTS EXITS AND MISSES REAL ONES, AND THERE IS NO ARGUING IT OUT OF EITHER.
// Crossing candidates are derived by tracing the BSP, and the BSP is not the authority on
// where a player may stand. Measured on the west wall of Main gate to the city of Tos, the
// bake staged for rows 8,9,10,11,12,13,20,23,46,47,48 — six of those are squares the
// server's own movement grid calls unwalkable, and the nearest phantom was chosen ahead of
// every real opening. In the other direction, Western border of the Twisted Wood offers
// exactly ONE crossing west (row 5) and an operator crossed there 37 times using rows 5
// AND 6.
//
// A RECORDED CROSSING SETTLES BOTH, and it needs nothing from the operator but playing the
// game. `m59-proxy.mjs` already logs every move packet a real client sends, so a room
// change in that log is bracketed: the last position in the old room and the first in the
// new. That is the crossing point, with no reaction time in it — which matters, because
// the operator cannot signal the exact square by hand: "the moment I touch it, I'm
// teleported, far before I'd be able to react".
//
// THE LAST RECORDED SQUARE IS OFF THE MAP, AND THAT IS THE FINDING RATHER THAN AN ERROR.
// Crossings are logged from column 0, or from one past the last column — outside the room's
// coordinate space entirely. Nothing else in the game addresses such a square: it is the
// outward step that triggers `Room.StandardLeaveDir`, and it is what an operator means by
// having to "run against the invisible wall to actually go forward and out of the zone".
// So the square a character must STAND on is the observed one pulled back inside the room.
//
// Offline. Reads walk logs and writes a book; talks to nothing.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { movementMapFile } from './m59-map-path.mjs';
import { evidenceDirFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WALKS_DIR = process.env.M59_WALKS_DIR || join(evidenceDirFor(), 'walks');
export const CROSSINGS_FILE = process.env.M59_CROSSINGS ||
  join(evidenceDirFor(), 'm59-crossings.json');

// THE DOOR HAS NOT MOVED, SO STOP RE-DERIVING IT EVERY TIME.
//
// The book above is the OPERATOR's evidence — squares a real client was watched crossing —
// and it outranks every derived candidate because a record of somebody actually arriving
// beats a guess from the same .roo the guesses came from. The fleet crosses these same
// boundaries hundreds of times a day and learned nothing from any of it: every trip
// re-derived the crossing, re-ranked the candidates, and re-discovered the same square by
// walking at the wrong ones first. Watched from inside the game that is a character
// spending "dozens of seconds if not minutes" wiggling at an entrance that has been in the
// same place since the map was built, having just walked the whole room correctly.
//
// So a crossing that WORKS is written down, and it is written down as the same kind of
// fact: a square somebody actually crossed at. Two files rather than one, because
// provenance is the whole argument for ranking these first — the operator's file is
// committed evidence about a human playing, and this one is the fleet's own history, and
// merging them on disk would make it impossible to tell which claim came from where.
export const LEARNED_CROSSINGS_FILE = process.env.M59_CROSSINGS_LEARNED ||
  join(HERE, '..', 'substrate', 'm59-crossings-learned.json');

/**
 * Pull an observed off-map position back to the square inside the room it was left from.
 *
 * Only ever by one square, and only on the axis that went out of bounds — a position that
 * is off the map in neither axis is a room change that did not happen at a boundary (a
 * door, a teleport, a death) and is not evidence about an edge.
 */
export function insideOf({ row, col }, { rows, cols }) {
  // COORDINATE CONTRACT: both inputs and the result are named; no tuple order is implied.
  let r = row, c = col;
  if (col < 1) c = 1; else if (col > cols) c = cols;
  if (row < 1) r = 1; else if (row > rows) r = rows;
  const wasOff = (col < 1 || col > cols || row < 1 || row > rows);
  return wasOff ? { row: r, col: c } : null;
}

export function harvest({ walksDir = WALKS_DIR, mapFile = movementMapFile() } = {}) {
  // SERIALIZED CONTRACT: crossing evidence keys encode squares as `"row,col"`;
  // decoded public values use named `{row,col}` fields.
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const byObj = new Map();
  for (const [n, r] of Object.entries(map.rooms)) if (r.objId) byObj.set(r.objId, Number(n));

  const seen = new Map();          // "from>to" -> Map("row,col" -> count)
  let files = 0, transitions = 0, atBoundary = 0;
  if (!existsSync(walksDir)) return { pairs: {}, files, transitions, atBoundary };

  for (const f of readdirSync(walksDir)) {
    if (!f.endsWith('.jsonl')) continue;
    files++;
    let pts;
    try {
      pts = readFileSync(join(walksDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { continue; }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].room === pts[i - 1].room) continue;
      transitions++;
      const from = byObj.get(pts[i - 1].room), to = byObj.get(pts[i].room);
      if (from == null || to == null) continue;
      const room = map.rooms[String(from)];
      const dims = { rows: room?.rows ?? 0, cols: room?.cols ?? 0 };
      if (!dims.rows || !dims.cols) continue;
      const inside = insideOf({ row: pts[i - 1].row, col: pts[i - 1].col }, dims);
      if (!inside) continue;                       // not an edge crossing
      atBoundary++;
      const k = from + '>' + to, sq = inside.row + ',' + inside.col;
      const m = seen.get(k) ?? seen.set(k, new Map()).get(k);
      m.set(sq, (m.get(sq) ?? 0) + 1);
    }
  }
  const pairs = {};
  for (const [k, m] of seen)
    pairs[k] = [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([sq, n]) => { const [row, col] = sq.split(',').map(Number); return { row, col, seen: n }; });
  return { pairs, files, transitions, atBoundary };
}

let bookCache = null;
export function crossingBook(file = CROSSINGS_FILE) {
  if (bookCache) return bookCache;
  let pairs = {};
  try { pairs = JSON.parse(readFileSync(file, 'utf8')).pairs ?? {}; }
  catch { pairs = {}; }                            // no book is "nothing observed"
  // The fleet's own successes, merged on READ so the two files stay separable on disk.
  // Counts add: a square the operator crossed at once and the fleet has crossed at forty
  // times is better evidence than either alone, and `witness` only ever compares counts.
  let learned = {};
  try { learned = JSON.parse(readFileSync(LEARNED_CROSSINGS_FILE, 'utf8')).pairs ?? {}; }
  catch { learned = {}; }
  for (const [key, squares] of Object.entries(learned)) {
    const merged = new Map((pairs[key] ?? []).map(o => [o.row + ',' + o.col, o.seen ?? 1]));
    for (const o of squares)
      merged.set(o.row + ',' + o.col, (merged.get(o.row + ',' + o.col) ?? 0) + (o.seen ?? 1));
    pairs[key] = [...merged].sort((a, b) => b[1] - a[1])
      .map(([sq, seen]) => { const [row, col] = sq.split(',').map(Number); return { row, col, seen }; });
  }
  bookCache = pairs;
  return bookCache;
}
export const observedCrossings = (from, to) => crossingBook()[from + '>' + to] ?? [];

/**
 * Write down a crossing that actually worked.
 *
 * MUST NOT THROW AND MUST NOT BLOCK THE WALK. It is called from the broker the moment a
 * character changes room, on the one event loop twenty-one sessions share, so the write is
 * debounced and every failure is swallowed — a book that cannot be written is a fleet that
 * re-derives, which is exactly how it behaved before this existed.
 *
 * The square is the one a character STANDS on to cross, matching the pull-back the
 * harvester applies to the operator's logs, so both files mean the same thing.
 */
let learnedPending = null, learnedTimer = null;
export function recordCrossing(from, to, square, { file = LEARNED_CROSSINGS_FILE } = {}) {
  try {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (!Number.isFinite(square?.row) || !Number.isFinite(square?.col)) return false;
    if (!learnedPending) {
      try { learnedPending = JSON.parse(readFileSync(file, 'utf8')).pairs ?? {}; }
      catch { learnedPending = {}; }
    }
    const key = from + '>' + to;
    const list = learnedPending[key] ?? (learnedPending[key] = []);
    const hit = list.find(o => o.row === square.row && o.col === square.col);
    if (hit) hit.seen = (hit.seen ?? 1) + 1;
    else list.push({ row: square.row, col: square.col, seen: 1 });
    bookCache = null;                              // the merged view is now stale
    if (!learnedTimer) {
      learnedTimer = setTimeout(() => {
        learnedTimer = null;
        try {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify({
            note: 'Squares THIS FLEET actually crossed a boundary from, written by the ' +
                  'broker when a leaveVia succeeded. Same meaning as m59-crossings.json ' +
                  'and kept apart from it so the provenance of each claim stays legible.',
            written: new Date().toISOString(),
            pairs: learnedPending,
          }, null, 1) + String.fromCharCode(10));
        } catch { /* a fleet that cannot write its book simply re-derives */ }
      }, 10000);
      if (typeof learnedTimer.unref === 'function') learnedTimer.unref();
    }
    return true;
  } catch { return false; }
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-crossings.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const nm = n => map.rooms[String(n)]?.name ?? ('room ' + n);
  const found = harvest();
  const keys = Object.keys(found.pairs).sort();

  console.log(`${found.files} walk log(s), ${found.transitions} room change(s), ` +
              `${found.atBoundary} at a room boundary\n`);

  if (has('compare')) {
    const { RoomGeometry } = await import('./m59-roo.mjs');
    console.log('  boundary                                  observed        we offer');
    for (const k of keys) {
      const [f, t] = k.split('>').map(Number);
      const room = map.rooms[String(f)];
      if (!room?.roo) continue;
      const dir = (room.edgeExits || []).find(e => String(e.to) === String(t))?.leaveName;
      if (!dir) continue;
      let offered = [];
      try {
        offered = RoomGeometry.fromJSON(room.roo).edgeApproachCandidates(dir)
          .map(a => a.row + ',' + a.col);
      } catch { /* unscoreable */ }
      const obs = found.pairs[k].map(o => o.row + ',' + o.col);
      const missing = obs.filter(o => !offered.includes(o));
      const label = `${f} -> ${t} ${dir}`;
      console.log('  ' + label.padEnd(42) + obs.slice(0, 3).join(' ').padEnd(16) +
                  offered.slice(0, 3).join(' ') +
                  (missing.length ? `   MISSING ${missing.join(' ')}` : ''));
    }
    process.exit(0);
  }

  for (const k of keys) {
    const [f, t] = k.split('>').map(Number);
    console.log('  ' + (nm(f).slice(0, 30)).padEnd(30) + ' -> ' + (nm(t).slice(0, 24)).padEnd(24) +
                found.pairs[k].map(o => `${o.row},${o.col} x${o.seen}`).join('  '));
  }

  if (has('save')) {
    mkdirSync(dirname(CROSSINGS_FILE), { recursive: true });
    writeFileSync(CROSSINGS_FILE, JSON.stringify({
      note: 'Squares a REAL CLIENT was observed crossing a room boundary from, harvested ' +
            'from proxy walk logs by m59-crossings.mjs. Observation, not derivation: the ' +
            'BSP-derived candidates invent crossings the movement grid forbids and miss ' +
            'real ones. The recorded position is off the map — that outward step IS the ' +
            'trigger — so these are pulled back one square to where a character stands.',
      builtAt: new Date().toISOString(),
      pairs: found.pairs,
    }, null, 1));
    console.log(`\nwrote ${CROSSINGS_FILE} — ${keys.length} boundary pair(s)`);
  }
}
