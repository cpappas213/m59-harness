#!/usr/bin/env node
// m59-act/escape-underworld.mjs -- THE ESCAPE-UNDERWORLD ATOMIC.
// Walk the character to a portal and step on it.
//
// The Underworld has no exits, no map, no geometry. The portals are
// objects in the room that you walk next to. The legacy escapeUnderworld()
// in m59-underworld.mjs handles the fine-coordinate walking; this
// atomic is a thin wrapper that calls it.
//
// CONTRACT: (client, session) -> { sent, left, reason }
//   - sent: true when the escape attempt was made (regardless of success)
//   - left: true when the character actually left the Underworld
//   - reason: null on success, a description of what went wrong

import { escapeUnderworld } from '../m59-skills.mjs';

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

  const room = client?.room;
  if (!room || !/underworld/i.test(room.name ?? ''))
    return { sent: false, left: false, reason: 'not in the Underworld' };

  try {
    const r = await escapeUnderworld(session.s ?? session, {
      city: opts.city,
      died_in_room: opts.diedInRoom,
    });
    return {
      sent: true,
      left: !!r?.left,
      reason: r?.left ? null : (r?.reason ?? 'escape failed'),
    };
  } catch (e) {
    return { sent: true, left: false, reason: e.message };
  }
}

// Precondition: the character is in the Underworld.
escapeUnderworldAtomic.pre = ['in_underworld'];

// Effect: the character is no longer in the Underworld.
escapeUnderworldAtomic.effects = ['!in_underworld'];

escapeUnderworldAtomic.atomic = 'escape_underworld';
escapeUnderworldAtomic.mutates = true;  // sends movement packets; the room changes
