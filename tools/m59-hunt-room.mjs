#!/usr/bin/env node
// m59-hunt-room.mjs -- FIND THE NEAREST ROOM WITH HUNTABLE MOBS.
//
// The GOAP keeper needs to know where to send a character that
// has no target in the current room. This module loads the spawn
// index and the map graph, finds rooms with huntable mobs at or
// below the character's level, and returns the nearest one by
// BFS path length.
//
// The result is a room number that the GOAP keeper can pass to
// the travel_to atomic, which uses the broker's travel() to walk
// the character there.

import { readFileSync, existsSync } from 'node:fs';
import { findPath, loadMap as _loadMap } from './m59-map.mjs';

let _spawns = null;
let _map = null;

function loadSpawns() {
  if (_spawns) return _spawns;
  const file = 'substrate/m59-spawns.json';
  if (!existsSync(file)) return null;
  _spawns = JSON.parse(readFileSync(file, 'utf8'));
  return _spawns;
}

function loadMap() {
  if (_map) return _map;
  try { _map = _loadMap(); } catch { _map = null; }
  return _map;
}

/**
 * Find rooms with huntable mobs at or below the given level.
 *
 * @param {number} level - the character's level
 * @returns {Array<{room: number, creature: string, level: number}>}
 */
export function huntRoomsAtOrBelow(level) {
  const spawns = loadSpawns();
  if (!spawns) return [];
  const out = [];
  for (const [num, entries] of Object.entries(spawns.rooms ?? {})) {
    for (const e of entries) {
      if (e.huntable && e.level <= level) {
        out.push({ room: parseInt(num), creature: e.creature, level: e.level });
        break;  // one match per room is enough
      }
    }
  }
  return out;
}

/**
 * Find the nearest hunt room from a given room.
 *
 * @param {number} fromRoom - the character's current room number
 * @param {number} level - the character's level
 * @returns {{room: number, creature: string, level: number, hops: number, path: number[]}|null}
 */
export function nearestHuntRoom(fromRoom, level) {
  const candidates = huntRoomsAtOrBelow(level);
  if (!candidates.length) return null;

  const map = loadMap();
  if (!map) return null;

  let best = null;
  for (const c of candidates) {
    if (c.room === fromRoom) {
      // Already there.
      return { ...c, hops: 0, path: [] };
    }
    const r = findPath(map, fromRoom, c.room, { danger: false });
    if (!r.found) continue;
    const hops = r.hops.length;
    if (!best || hops < best.hops) {
      best = { ...c, hops, path: r.hops.map(h => h.to) };
    }
  }
  return best;
}
