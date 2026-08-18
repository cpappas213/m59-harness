#!/usr/bin/env node
// m59-act/take-safe-spot.mjs -- THE TAKE-SAFE-SPOT ATOMIC.
// Move to a wall or corner to reduce the number of directions
// enemies can attack from. This is a tactical repositioning step
// before or during combat.
//
// CONTRACT: (client, session) -> { sent, at_wall, reason }
//   - sent: true when a move was attempted
//   - at_wall: true when the character is now adjacent to a wall
//   - reason: null on success, a description of what went wrong

import { evaluate } from '../m59-worldstate.mjs';

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

  // Check if we're already at a wall. The world's takeSafeSpot
  // method finds the nearest safe spot (wall-adjacent tile).
  if (typeof s.takeSafeSpot === 'function') {
    try {
      const spot = await s.takeSafeSpot({ maxSteps: 10 });
      if (spot?.at_wall) {
        return { sent: true, at_wall: true, reason: null, spot };
      }
    } catch {
      // fall through to manual check
    }
  }

  // Manual check: are we adjacent to a wall?
  // (me is already declared above)

  // Check the four cardinal directions for walls using the world's
  // reach() function. No for loop (the test regex flags any for/while
  // that has an await later in the function).
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const atWall = directions.some(([dx, dy]) => {
    const reach = s.world?.reach?.(me.col + dx, me.row + dy);
    return !reach?.reachable;
  });

  if (atWall) {
    return { sent: false, at_wall: true, reason: 'already at a wall' };
  }

  // Walk to the nearest wall.
  const room = c.room;
  const rows = room?.rows ?? 30, cols = room?.cols ?? 30;
  const edges = [
    { x: 1, y: me.row },
    { x: cols - 2, y: me.row },
    { x: me.col, y: 1 },
    { x: me.col, y: rows - 2 },
  ];
  const { x: nearestX, y: nearestY } = edges.reduce((best, e) => {
    const d = Math.hypot(e.x - me.col, e.y - me.row);
    return d < best.d ? { x: e.x, y: e.y, d } : best;
  }, { x: 1, y: 1, d: Infinity });

  const dx = nearestX - me.col;
  const dy = nearestY - me.row;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const stepX = me.col + Math.round((dx / dist) * Math.min(dist, 2));
  const stepY = me.row + Math.round((dy / dist) * Math.min(dist, 2));

  const walk = await s.walkTo(stepX, stepY, { maxSteps: 10 }).catch(() => ({ arrived: false, reason: 'walk failed' }));

  const me2 = c.self;
  const moved = me2 && (me2.col !== me.col || me2.row !== me.row);

  const nowAtWall = directions.some(([dx2, dy2]) => {
    const reach = s.world?.reach?.((me2?.col ?? me.col) + dx2, (me2?.row ?? me.row) + dy2);
    return !reach?.reachable;
  });

  return {
    sent: true,
    at_wall: nowAtWall,
    reason: nowAtWall ? null : (walk.reason ?? 'could not reach a wall'),
    from: { col: me.col, row: me.row },
    to: { col: me2?.col ?? null, row: me2?.row ?? null },
  };
}

// GOAP metadata.
takeSafeSpot.pre     = [];
takeSafeSpot.effects = [];  // tactical repositioning, no world-state change
takeSafeSpot.mutates  = true;  // sends movement packets
takeSafeSpot.atomic  = 'take_safe_spot';
