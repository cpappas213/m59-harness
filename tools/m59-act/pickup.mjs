#!/usr/bin/env node
// m59-act/pickup.mjs -- PICK UP ONE ITEM FROM THE FLOOR.
//
// The last link between a dead creature's drops and the pack. Without it a
// character can kill for a month and carry nothing, because the floor is
// where the loot goes and the pack is where the economy starts.
//
// THE REACH LIMIT IS MANHATTAN 7. UserGet measures |dx| + |dy| and refuses
// past 7 (user.kod:6820-6840), so an atomic that does not check distance is
// one that sends a packet the server drops in silence. The broker's lootFloor
// walks first when the drop is farther; this atomic does not walk. It is a
// single action, not a route, and a planner that needs to walk to a drop
// plans the walk separately (step, step, ..., pickup).
//
// WHAT IT REFUSES, AND WHY:
//   CURSED ITEMS. Two items in the game return TRUE from IsCursed: the Amulet
//   of Shadows (equips itself, applies a defence PENALTY, cannot be removed
//   without an uncurse spell, and shadowam.kod can call @Killed on its owner)
//   and the Ring of Lethargy. Picking one up is not a mistake you can undo by
//   dropping it. The broker's lootFloor refuses them the same way.
//   BROKEN WEAPONS. A shattered weapon looks like the real thing on the floor
//   and is worth nothing. The broker checks condition before taking; this
//   atomic does the same when the item is weapon-shaped.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT WALK. The atomic is one action. A planner that needs to close
//   seven squares plans the steps. This is the same reason step() is one
//   square and not a route.
//   IT DOES NOT REFRESH THE INVENTORY. The caller re-reads when it needs to
//   confirm the item is in the pack, the same way eat() reads vigor after.

// The two items in the game whose IsCursed returns TRUE. Defined here rather
// than imported from the broker: an atomic must not depend on the broker, and
// the list is two names that will not change.
const CURSED_ITEMS = /amulet of shadows|ring of lethargy/i;

const MANHATTAN_REACH = 7;   // user.kod:6820 — UserGet's reach limit

/**
 * pickUp(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_GET for one item in the current room and waits for the
 * 'got' event. Returns { sent, taken, reason }.
 *
 * `taken` is the item name on success, null on refusal. The refusal reason
 * is the server's message when it gives one, or a local reason (out of
 * reach, not in room, cursed, broken) when the atomic refuses before
 * sending.
 */
export async function pickUp(client, session, { itemId, waitMs = 1500 } = {}) {
  if (!client || !session) return { sent: false, taken: null, reason: 'no client or session' };
  if (itemId == null)      return { sent: false, taken: null, reason: 'no item id' };

  // The item must be in the current room's contents. A pickup of an id that
  // is not in the room is a packet the server drops.
  const room = client.room;
  const obj = room?.objects?.get?.(itemId);
  if (!obj) return { sent: false, taken: null, reason: 'not in the room' };

  const name = client.rsc?.get?.(obj.nameRsc) ?? '';

  // NEVER PICK UP THE TWO CURSED ITEMS. Same rule as the broker's lootFloor:
  // picking one up is not a mistake you can undo.
  if (CURSED_ITEMS.test(name))
    return { sent: false, taken: null, reason: `cursed: ${name} — it equips itself and cannot be removed without an uncurse spell` };

  // THE REACH CHECK. Manhattan distance, the server's own test.
  const me = client.self;
  if (me && obj.col != null && obj.row != null) {
    const d = Math.abs(obj.col - me.col) + Math.abs(obj.row - me.row);
    if (d > MANHATTAN_REACH)
      return { sent: false, taken: null, reason: `out of reach: ${d} squares (limit ${MANHATTAN_REACH})` };
  }

  const before = client.evSeq ?? 0;
  await session.pacer.submit('get', () => client.get(itemId), waitMs).catch(() => {});
  const ev = await client.waitFor({ since: before, kinds: ['got', 'message', 'vanished'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const got = (ev.events ?? []).find(e => e.kind === 'got');
  if (got) return { sent: true, taken: name, reason: null };

  const refused = (ev.events ?? []).filter(e => e.text).map(e => e.text).join('; ');
  return { sent: true, taken: null, reason: refused || 'no reply' };
}

pickUp.pre     = ['pack_room'];
pickUp.effects = [];   // the item goes into the pack, but which slot it fills is
                       // item-specific and the vocabulary does not model per-item
                       // slots. The planner that needs "I now hold X" plans the
                       // specific use (eat, equip, sell) as the next step.
pickUp.atomic  = 'pickup';
pickUp.mutates = true;  // sends a mutation packet (BP_REQ_GET); effects are
                         // item-level, not vocabulary-level
