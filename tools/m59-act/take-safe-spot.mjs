#!/usr/bin/env node
// m59-act/take-safe-spot.mjs -- THE TAKE-SAFE-SPOT ATOMIC.
// Move to a wall or corner to reduce the number of directions
// enemies can attack from. This is a tactical repositioning step
// before or during combat.
//
// CONTRACT: (client, session) -> { sent, at_wall, reason, spot }
//   - sent: true when a move was attempted
//   - at_wall: true when the character is now adjacent to a wall
//   - spot: { col, row } of the safe spot, if found
//   - reason: null on success, a description of what went wrong
//
// HOW IT WORKS:
//   1. If already at a wall (2+ non-walkable neighbors), done.
//   2. Scan a 12-cell radius around the character for cells that are
//      standable AND have 2+ non-walkable neighbors (wall corners).
//   3. Walk to the nearest such cell. Walk the FULL distance, not 2 steps.
//   4. If no wall-adjacent cell is found in the radius, walk toward the
//      nearest non-walkable cell (a wall) and stop next to it.
//
// THE WALK IS IDEMPOTENT: if the character is already moving toward
// a safe spot (same target), don't start a new walk. The GOAP keeper
// re-plans every second; without this, each pass cancels the previous
// walk and the character never arrives.

import { evaluate } from '../m59-worldstate.mjs';

// Module-level cache: the last safe-spot target per character name.
// If the character is still walking to the same target, skip the walk.
const _lastTarget = new Map();

/**
 * Check if a cell is "at a wall": standable, with 2+ of its 4 cardinal
 * neighbors being non-walkable. This is a corner or alcove.
 */
function wallScore(r, c, isWalkable) {
  let walls = 0;
  if (!isWalkable(r + 1, c)) walls++;
  if (!isWalkable(r - 1, c)) walls++;
  if (!isWalkable(r, c + 1)) walls++;
  if (!isWalkable(r, c - 1)) walls++;
  return walls;
}

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .walkTo, .s)
 */
export async function takeSafeSpot(client, session, _opts = {}) {
  if (!client || !session)
    return { sent: false, at_wall: false, reason: 'no client or session' };

  const c = client;
  const s = session.s ?? session;
  const me = c.self;
  if (!me) return { sent: false, at_wall: false, reason: 'own position unknown' };

  // Build a walkable checker from the session's geometry.
  // Uses the union of coarse (standable) and fine (fineWalkable) grids.
  const geo = s.world?.geometry ?? null;
  const isWalkable = (r, c) => {
    if (geo) {
      const coarse = geo.standable?.(r, c) ?? false;
      const fine = geo.fineWalkable?.(r, c) ?? false;
      return coarse || fine;
    }
    // Fallback: use the world's reach()
    const reach = s.world?.reach?.(c, r);
    return reach?.reachable ?? true;
  };

  // Step 1: are we already at a wall?
  const hereWalls = wallScore(me.row, me.col, isWalkable);
  if (hereWalls >= 2) {
    return { sent: false, at_wall: true, reason: null, spot: { col: me.col, row: me.row } };
  }
  // Adjacent to at least one wall? Good enough for holding position.
  if (hereWalls >= 1) {
    return { sent: false, at_wall: true, reason: 'already at a wall', spot: { col: me.col, row: me.row } };
  }

  // Step 2: scan for nearby wall-adjacent cells (corners/alcoves).
  const radius = 12;
  let best = null;
  let bestDist = Infinity;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = me.row + dr, c2 = me.col + dc;
      if (!isWalkable(r, c2)) continue;
      const ws = wallScore(r, c2, isWalkable);
      if (ws < 2) continue;
      const d = Math.hypot(dr, dc);
      // Prefer corners (3+ walls) at same distance
      const score = d - ws * 0.5;
      if (score < bestDist) {
        bestDist = score;
        best = { col: c2, row: r, walls: ws, dist: d };
      }
    }
  }

  // Step 3: if no corner found, walk toward the nearest wall.
  let target = best;
  if (!target) {
    // Find the nearest non-walkable cell and step next to it.
    let nearestWall = null;
    let nearestWallDist = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const r = me.row + dr, c2 = me.col + dc;
        if (isWalkable(r, c2)) continue;
        const d = Math.hypot(dr, dc);
        if (d < nearestWallDist) {
          nearestWallDist = d;
          nearestWall = { row: r, col: c2 };
        }
      }
    }
    if (nearestWall) {
      // Step from the character toward the wall, stopping 1 cell short.
      const dx = nearestWall.col - me.col;
      const dy = nearestWall.row - me.row;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const step = Math.min(1, dist - 1);
      target = {
        col: me.col + Math.round((dx / dist) * step),
        row: me.row + Math.round((dy / dist) * step),
        walls: 1,
        dist: dist - 1,
      };
      // Only use it if the target cell is actually walkable
      if (!isWalkable(target.row, target.col)) target = null;
    }
  }

  if (!target) {
    return { sent: false, at_wall: false, reason: 'no wall found within radius' };
  }

  // Step 4: walk to the target. Idempotent — if we're already walking
  // to the same target, don't restart.
  const charName = c.me?.name ?? s.name ?? 'unknown';
  const key = `${charName}:${target.col}:${target.row}`;
  const prev = _lastTarget.get(charName);
  if (prev && prev.col === target.col && prev.row === target.row) {
    // Already heading to this spot. Check if we've arrived.
    const arrived = Math.hypot(me.col - target.col, me.row - target.row) <= 1.5;
    if (arrived) {
      _lastTarget.delete(charName);
      return { sent: false, at_wall: true, reason: null, spot: { col: me.col, row: me.row } };
    }
    // Still walking. Don't cancel — report in-progress.
    return { sent: false, at_wall: false, reason: 'walking to safe spot', spot: target };
  }
  _lastTarget.set(charName, { col: target.col, row: target.row });

  const maxSteps = Math.ceil(target.dist) + 6;
  const walk = await s.walkTo(target.col, target.row, { maxSteps }).catch(() => {
    _lastTarget.delete(charName);
    return { arrived: false, reason: 'walk failed' };
  });

  // Walk is done. Clear the cache so the next pass can re-evaluate.
  // If we arrived, the at_wall check below will return success.
  // If we didn't arrive, the next pass will pick a new target or
  // retry this one.
  _lastTarget.delete(charName);

  // Only check left_room — the room ID comparison fails because
  // c.room.id is the live objId (e.g. 1511) while s.world.room.id
  // may be the map num (e.g. 557). The walkTo already handles
  // actual room changes via left_room.
  if (walk.left_room) {
    _lastTarget.delete(charName);
    return { sent: true, at_wall: false, reason: 'room changed during walk' };
  }

  const me2 = c.self;
  if (!me2) {
    _lastTarget.delete(charName);
    return { sent: true, at_wall: false, reason: 'lost position' };
  }

  const nowWalls = wallScore(me2.row, me2.col, isWalkable);
  if (nowWalls >= 1) {
    _lastTarget.delete(charName);
    return { sent: true, at_wall: true, reason: null, spot: { col: me2.col, row: me2.row } };
  }

  // Didn't reach a wall. Keep the target in the cache so the next
  // pass continues walking instead of restarting.
  if (walk.arrived) {
    _lastTarget.delete(charName);
  }
  return {
    sent: true,
    at_wall: false,
    reason: walk.arrived ? 'at target but not at a wall' : (walk.reason ?? 'could not reach a wall'),
    from: { col: me.col, row: me.row },
    to: { col: me2.col, row: me2.row },
    spot: { col: target.col, row: target.row },
  };
}

// GOAP metadata.
takeSafeSpot.pre     = [];
takeSafeSpot.effects = [];  // tactical repositioning, no world-state change
takeSafeSpot.mutates  = true;  // sends movement packets
takeSafeSpot.atomic  = 'take_safe_spot';
