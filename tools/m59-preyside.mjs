#!/usr/bin/env node
// m59-preyside.mjs -- WHICH SIDE OF A SPLIT ROOM THE PREY IS ON.
//
// THE PROBLEM THIS EXISTS FOR. Some rooms are two rooms wearing one number. Upstairs Castle
// Victoria is the measured case: on the map the MOVER enforces (step masks attached, not the
// coarse grid) it is two disconnected islands, and Castle Victoria's four doors into it land
// on only two squares, one per island --
//
//     door (19,2) and (19,1)  ->  arrives (28,8)   one island
//     door (17,2) and (17,1)  ->  arrives (23,8)   the other
//
// `orderExits` ranks doors by reachable-then-nearest, so a character heading there takes
// whichever door is closest and lands wherever that puts it. Land on the wrong island and
// the prey is visible and unreachable: "the coarse grid found no route beside the target,
// and the fine grid could not reach one either". Six characters at levels 46-57 spent a
// whole night in that room and killed nothing.
//
// WHY IT HAS TO BE REMEMBERED RATHER THAN COMPUTED. The side has to be chosen at TRAVEL
// time, from outside the room, and nothing available at that moment knows it. The spawn
// index (substrate/m59-spawns.json) says battered skeletons and zombies generate in room 39
// and carries no coordinates at all; the room's live contents cannot be read from the next
// room. The only source is having been there and looked.
//
// AND IT HAS TO SURVIVE A RESTART, which is the whole reason this is a file and not a field.
// The first version of this kept the side on the keeper (`wantSide`), set when a bridge was
// planned from INSIDE the room. A keeper restart wiped it, and a character stranded in the
// via room -- which is exactly where these wedge -- came back through whichever door was
// nearest, having forgotten why it left.
//
// WHAT IS STORED IS A SQUARE, NOT AN ISLAND ID. There is no stable name for an island: it is
// whatever `geo.path` says it is, and that answer changes with the bake. A remembered square
// is checked against today's geometry every time it is used, so a stale one degrades to "no
// opinion" (doorsLandingNear returns null and the ordinary door ordering stands) rather than
// to a confident wrong answer.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PREY_SIDE_FILE = process.env.M59_PREYSIDE_FILE
  || join(HERE, '..', 'substrate', 'prey-sides.json');

// A sighting older than this is not evidence about a room that regenerates every few
// minutes. It is not deleted -- an old square on the right island is still the right island,
// and islands do not move -- but a fresher one always wins.
export const PREY_SIDE_STALE_MS = Number(process.env.M59_PREYSIDE_STALE_MS || 24 * 3600 * 1000);

let cache = null, cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = statSync(PREY_SIDE_FILE).mtimeMs; } catch { mtime = 0; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = JSON.parse(readFileSync(PREY_SIDE_FILE, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = { rooms: {} };
  } catch { cache = { rooms: {} }; }
  if (!cache.rooms || typeof cache.rooms !== 'object') cache.rooms = {};
  cacheMtime = mtime;
  return cache;
}

const keyOf = (hunt) => String(hunt ?? '').trim().toLowerCase() || '*';

/**
 * WHERE THIS PREY WAS LAST SEEN STANDING, in this room. `{ col, row, at }` or null.
 * The caller decides what to do with it; nothing here knows about islands or doors.
 */
export function preySideFor(room, hunt) {
  const r = load().rooms?.[String(room)];
  if (!r) return null;
  // The exact creature first, then whatever was last seen in the room. A room with one
  // generator answers both the same way; a room with two answers the specific question
  // when it can and the general one when it cannot.
  const hit = r[keyOf(hunt)] ?? r['*'] ?? null;
  if (!hit || !Number.isFinite(Number(hit.col)) || !Number.isFinite(Number(hit.row))) return null;
  return { col: Number(hit.col), row: Number(hit.row), at: Number(hit.at) || 0 };
}

/**
 * NOTE THAT PREY WAS STANDING HERE. Cheap and idempotent: it rewrites only when the square
 * has actually changed or the record has aged, because this is called from the hot path of
 * every pass that can see its quarry and a write per pass would be a file rewritten twice a
 * second on a fleet of twenty-one.
 */
export function notePreySide(room, hunt, square, { now = Date.now() } = {}) {
  if (room == null || !square) return false;
  const col = Number(square.col), row = Number(square.row);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return false;
  const book = load();
  const rk = String(room), hk = keyOf(hunt);
  const room_ = (book.rooms[rk] ||= {});
  const prev = room_[hk];
  // Same square and recent enough: nothing to say.
  if (prev && Number(prev.col) === col && Number(prev.row) === row
      && (now - (Number(prev.at) || 0)) < 60_000) return false;
  room_[hk] = { col, row, at: now };
  room_['*'] = { col, row, at: now, hunt: String(hunt ?? '') };
  try {
    mkdirSync(dirname(PREY_SIDE_FILE), { recursive: true });
    writeFileSync(PREY_SIDE_FILE, JSON.stringify(book, null, 1) + '\n', 'utf8');
    try { cacheMtime = statSync(PREY_SIDE_FILE).mtimeMs; } catch { cacheMtime = 0; }
  } catch { /* an unwritable book still gives THIS process a usable answer */ }
  return true;
}

/** Everything the book holds, for a board or a test. */
export function allPreySides() {
  const out = [];
  const book = load();
  for (const [room, byHunt] of Object.entries(book.rooms || {}))
    for (const [hunt, v] of Object.entries(byHunt || {}))
      if (hunt !== '*') out.push({ room: Number(room), hunt, col: v.col, row: v.row, at: v.at });
  return out.sort((a, b) => a.room - b.room || a.hunt.localeCompare(b.hunt));
}

/** Test seam: drop the memo so a fixture's file is re-read. */
export function _resetPreySideCache() { cache = null; cacheMtime = 0; }
