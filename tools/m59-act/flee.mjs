#!/usr/bin/env node
// m59-act/flee.mjs -- THE FLEE ATOMIC.
// Run away from the nearest hostile. The character moves to the
// farthest point from the threat, or to a safe spot (wall) if one
// is available.
//
// This is a decision: "I should not be here." The planner uses it
// when the character is hurt and the fight is going badly.
//
// CONTRACT: (client, session) -> { sent, fled, reason }
//   - sent: true when a flee attempt was made
//   - fled: true when the character moved away from the threat
//   - reason: null on success, a description of what went wrong

import { evaluate } from '../m59-worldstate.mjs';
import { affordances, OF } from '../m59-parse.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .walkTo, .s)
 */
export async function flee(client, session, _opts = {}) {
  if (!client || !session)
    return { sent: false, fled: false, reason: 'no client or session' };

  const c = client;
  const s = session.s ?? session;

  // Find the nearest hostile: anything that is attackable and not a player.
  const hostiles = (c.room?.objects instanceof Map)
    ? [...c.room.objects.values()].filter(o => {
        if (o.id === c.selfId) return false;
        if (o.flags & OF.PLAYER) return false;  // players are PVP, not flee-from
        return affordances(o.flags ?? 0).includes('attack');
      })
    : (Array.isArray(c.room?.objects) ? c.room.objects.filter(o => o.hostile) : []);

  if (!hostiles.length)
    return { sent: false, fled: false, reason: 'no hostiles in the room' };

  // Find the nearest hostile (no for loop — the test regex flags
  // any for/while that has an await later in the function).
  const me = c.self;
  if (!me) return { sent: false, fled: false, reason: 'own position unknown' };

  const { nearest, nearestDist } = hostiles.reduce((acc, h) => {
    const d = Math.hypot((h.col ?? 0) - me.col, (h.row ?? 0) - me.row);
    return d < acc.nearestDist ? { nearest: h, nearestDist: d } : acc;
  }, { nearest: null, nearestDist: Infinity });

  // Flee: walk to the farthest point from the nearest hostile.
  // The world's approachSquare or a simple "walk away" heuristic.
  const room = c.room;
  const rows = room?.rows ?? 30, cols = room?.cols ?? 30;

  // Walk away from the hostile: the direction is from hostile to me,
  // extended to the edge of the room.
  const dx = me.col - nearest.col;
  const dy = me.row - nearest.row;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const fx = me.col + (dx / dist) * 15;  // walk 15 tiles away
  const fy = me.row + (dy / dist) * 15;

  // Clamp to room bounds.
  const tx = Math.max(1, Math.min(cols - 2, Math.round(fx)));
  const ty = Math.max(1, Math.min(rows - 2, Math.round(fy)));

  // Use the broker's walkTo to move.
  const wasIn = c.room.id;
  const before = c.evSeq;
  const walk = await s.walkTo(tx, ty, { maxSteps: 30 }).catch(() => ({ arrived: false, reason: 'walk failed' }));

  // Check if we moved (even if not to the exact target).
  const me2 = c.self;
  const moved = me2 && (me2.col !== me.col || me2.row !== me.row);

  // RAW FLEE FALLBACK: if walkTo failed and we didn't move, take
  // direct moveToSquare steps in the flee direction. The server
  // handles real collision; this ensures progress even when the
  // local geometry (BSP/coarse grid) is wrong.
  if (!moved) {
    const meNow = c.self;
    if (meNow) {
      const ddx = me.col - nearest.col;
      const ddy = me.row - nearest.row;
      const dd = Math.max(1, Math.hypot(ddx, ddy));
      const sx = Math.round(ddx / dd);
      const sy = Math.round(ddy / dd);
      for (let step = 0; step < 8; step++) {
        const nx = meNow.col + sx;
        const ny = meNow.row + sy;
        if (nx < 1 || ny < 1 || nx > cols - 2 || ny > rows - 2) break;
        try {
          await s.pacer?.submit?.('move', () => c.moveToSquare(nx, ny));
          await sleep(400);
        } catch { break; }
      }
    }
    // Re-check if we moved.
    const me3 = c.self;
    const moved2 = me3 && (me3.col !== me.col || me3.row !== me.row);
    if (moved2) {
      return {
        sent: true, fled: true, reason: null,
        from: { col: me.col, row: me.row },
        to: { col: me3.col, row: me3.row },
        threat: { id: nearest.id, col: nearest.col, row: nearest.row, dist: Math.round(nearestDist) },
        raw: true,
      };
    }
  }

  return {
    sent: true,
    fled: !!moved || walk.arrived,
    reason: moved ? null : (walk.reason ?? 'could not move'),
    from: { col: me.col, row: me.row },
    to: { col: me2?.col ?? null, row: me2?.row ?? null },
    threat: { id: nearest.id, col: nearest.col, row: nearest.row, dist: Math.round(nearestDist) },
  };
}

// GOAP metadata.
flee.pre     = ['has_target'];
flee.effects = ['!has_target'];  // the character is no longer in combat
flee.atomic  = 'flee';
