#!/usr/bin/env node
// m59-act/drop.mjs -- DROP ONE ITEM FROM THE PACK TO THE FLOOR.
//
// The inverse of pickup. A character that is full, that is carrying broken
// gear, or that is giving an item to another character all start here.
//
// WHAT IT IS: BP_REQ_DROP is a LIST opcode {2,LIST_OBJ_PARM} — a count-
// prefixed id list, not a single id. The client's drop() already wraps the
// list encoding; this atomic sends one id in that list.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT WALK. Dropping is a local action; the item lands on the
//   square the character is standing on.
//   IT DOES NOT CONFIRM THE DROP. The server sends a 'message' when the
//   drop succeeds, but it does not send a 'dropped' event the way pickup
//   sends 'got'. The atomic reports that the command was sent and lets the
//   caller re-read the room to confirm.
//   IT DOES NOT REFUSE EQUIPPED ITEMS. The server will refuse (you cannot
//   drop what you are wearing), and the refusal message is the measurement.
//   Refusing locally would require reading the equipment state, which is
//   the equip atomic's job, not this one.

/**
 * drop(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_DROP for one item in the pack. Returns { sent, reason }.
 */
export async function drop(client, session, { itemId, waitMs = 800 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  if (itemId == null)      return { sent: false, reason: 'no item id' };

  // The item must be in the pack. Dropping an id we do not hold is a packet
  // the server drops in silence.
  const held = (client.inventory ?? []).some(o => o.id === itemId);
  if (!held) return { sent: false, reason: 'not in the pack' };

  const before = client.evSeq ?? 0;
  await session.pacer.submit('drop', () => client.drop([itemId]), waitMs).catch(() => {});
  const ev = await client.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  // The server says "You dropped X" on success and "You can't drop that" or
  // similar on refusal. Both are messages; the text tells which.
  return { sent: true, reason: msgs.length ? msgs.join('; ') : null };
}

drop.pre     = [];
drop.effects = [];   // the item leaves the pack and lands on the floor. The
                     // vocabulary does not model per-item pack slots, so there
                     // is no symbol to set. A planner that needs "the floor
                     // now has X" plans the pickup as the next step.
drop.atomic  = 'drop';
drop.mutates = true;  // sends a mutation packet (BP_REQ_DROP); effects are
                      // item-level, not vocabulary-level
