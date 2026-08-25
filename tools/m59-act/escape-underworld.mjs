#!/usr/bin/env node
// m59-act/escape-underworld.mjs -- THE ESCAPE-UNDERWORLD ATOMIC.
// Walk the character to a portal and step on it.
//
// The legacy escapeUnderworld() uses s.walkTo() which relies on
// the local pathfinder. In the Underworld, the pathfinder
// produces wrong paths ("kept ending up somewhere other than
// the planned square") because the collision geometry doesn't
// match the actual room.
//
// This atomic first tries the legacy escape. If it fails with
// a pathfinding error, it falls back to a direct walk: find the
// nearest portal in the room and use client.moveToSquare() to
// walk there, bypassing the pathfinder entirely. The server
// handles collision; the character walks in a straight line.
//
// CONTRACT: (client, session) -> { sent, left, reason }

import { escapeUnderworld } from '../m59-skills.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Direct walk to the nearest portal, bypassing the pathfinder.
 * Uses client.moveToSquare() to send a direct move command.
 */
export async function directWalkToPortal(c, session) {
  const objects = c.room?.objects;
  const list = objects instanceof Map
    ? [...objects.values()]
    : Array.isArray(objects) ? objects : [];

  // Find portals (objects with 'teleport' in their can list, or
  // named 'portal' or 'rip in space').
  const portals = list.filter(o => {
    const name = c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
    return /portal|rip in space/i.test(name);
  });

  if (!portals.length)
    return { left: false, reason: 'no portals found in the room' };

  // Find the nearest portal (Euclidean distance in col/row).
  const me = c.self;
  if (!me) return { left: false, reason: 'own position unknown' };

  const meCol = me.col ?? 0, meRow = me.row ?? 0;
  portals.sort((a, b) => {
    const da = (a.col - meCol) ** 2 + (a.row - meRow) ** 2;
    const db = (b.col - meCol) ** 2 + (b.row - meRow) ** 2;
    return da - db;
  });

  const target = portals[0];
  const targetName = c.rsc?.get?.(target.nameRsc) ?? target.name ?? 'portal';
  const targetCol = target.col, targetRow = target.row;

  // Walk toward the portal using moveToSquare. The server handles
  // collision and the character will stop if blocked. We send
  // the move command, wait, and check if the room changed.
  const wasIn = c.room.id;
  const before = c.evSeq;

  // Send a move command to the portal's position.
  try {
    c.moveToSquare(targetCol, targetRow);
  } catch (e) {
    return { left: false, reason: `moveToSquare failed: ${e.message}` };
  }

  // Wait for either a room change (success) or a timeout.
  const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 8000 })
    .catch(() => ({ events: [] }));
  const entered = (arr.events ?? []).find(e => e.kind === 'room-entered');

  if (entered || c.room.id !== wasIn) {
    const nowName = c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null;
    return {
      left: true,
      arrived_in: entered?.roomName ?? nowName ?? c.room.id,
      via: `direct walk to ${targetName}`,
    };
  }

  // Check if we're adjacent to the portal (within 2 tiles).
  const me2 = c.self;
  if (me2) {
    const dx = Math.abs((me2.col ?? 0) - targetCol);
    const dy = Math.abs((me2.row ?? 0) - targetRow);
    if (dx <= 2 && dy <= 2) {
      // We're next to the portal. Step onto it.
      try { c.moveToSquare(targetCol, targetRow); } catch {}
      const arr2 = await c.waitFor({ since: c.evSeq, kinds: ['room-entered'], timeoutMs: 5000 })
        .catch(() => ({ events: [] }));
      const entered2 = (arr2.events ?? []).find(e => e.kind === 'room-entered');
      if (entered2 || c.room.id !== wasIn) {
        const nowName = c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null;
        return {
          left: true,
          arrived_in: entered2?.roomName ?? nowName ?? c.room.id,
          via: `stepped onto ${targetName} after direct walk`,
        };
      }
      return {
        left: false,
        reason: `adjacent to ${targetName} but stepping on it did nothing (unlit?)`,
      };
    }
  }

  return {
    left: false,
    reason: `walked toward ${targetName} at (${targetCol},${targetRow}) but did not arrive (now at ${me2?.col ?? '?'},${me2?.row ?? '?'})`,
  };
}

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .travel, .s, etc.)
 * @param {object} [opts]
 * @param {string} [opts.city] - a specific city to aim for
 * @param {number} [opts.diedInRoom] - the room the character died in
 */
export async function escapeUnderworldAtomic(client, session, opts = {}) {
  if (!client || !session)
    return { sent: false, left: false, reason: 'no client or session' };

  const roomName = client?.roomNameRsc
    ? (client.rsc?.get?.(client.roomNameRsc) ?? '')
    : (client?.room?.name ?? '');
  if (!/underworld/i.test(roomName) && client?.room?.id !== 6)
    return { sent: false, left: false, reason: 'not in the Underworld' };

  const s = session.s ?? session;

  // Try the legacy escape first.
  try {
    const r = await escapeUnderworld(s, {
      city: opts.city,
      nearestTo: opts.diedInRoom,
      maxSeconds: 60,
    });
    if (r.left) {
      return { sent: true, left: true, reason: null, via: r.via };
    }

    // The legacy escape failed. Check if it was a pathfinding error.
    const tried = r.tried ?? [];
    const pathFail = tried.some(t => /kept ending up|never got onto/.test(t.why ?? ''));

    if (pathFail) {
      // Fall back to a direct walk, bypassing the pathfinder.
      const direct = await directWalkToPortal(client, session);
      return { sent: true, left: direct.left, reason: direct.left ? null : direct.reason, via: direct.via ?? null };
    }

    return { sent: true, left: false, reason: r.reason ?? 'escape failed' };
  } catch (e) {
    // Legacy escape threw. Try the direct walk as a last resort.
    try {
      const direct = await directWalkToPortal(client, session);
      return { sent: true, left: direct.left, reason: direct.left ? null : `legacy: ${e.message}; direct: ${direct.left ? '' : direct.reason}`, via: direct.via ?? null };
    } catch {
      return { sent: true, left: false, reason: e.message };
    }
  }
}

// Precondition: the character is in the Underworld.
escapeUnderworldAtomic.pre = ['in_underworld'];

// Effect: the character is no longer in the Underworld.
escapeUnderworldAtomic.effects = ['!in_underworld'];

escapeUnderworldAtomic.atomic = 'escape_underworld';
escapeUnderworldAtomic.mutates = true;  // sends movement packets; the room changes
