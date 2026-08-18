#!/usr/bin/env node
// m59-act/sell.mjs -- SELL ONE ITEM TO A MERCHANT.
//
// Selling is the trade protocol, not a one-way street like buying. The
// sequence is:
//
//   1. offer(merchantId, [itemId])  ->  BP_REQ_OFFER
//   2. server replies with a counter (BP_OFFER_CANCELED with a price, or
//      BP_OFFER_ACCEPTED if the merchant names the price directly)
//   3. accept()                      ->  BP_REQ_ACCEPT
//   4. server confirms, the item leaves the pack, the purse rises
//
// The broker's sellOne() does exactly this. This atomic wraps the same
// sequence for a single item.
//
// WHAT IT CHECKS BEFORE SENDING:
//   THE ITEM IS IN THE PACK. Offering an id we do not hold is a packet the
//   server drops.
//   THE MERCHANT IS IN THE ROOM. The offer is addressed to a player id, and
//   a player that is not in the room will not see it.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT QUOTE. A quote is an offer that is cancelled rather than
//   accepted. This atomic sells; a planner that wants to know the price
//   without committing plans a quote separately.
//   IT DOES NOT WALK. The merchant must be in the room.
//   IT DOES NOT REFRESH THE INVENTORY. The caller re-reads when it needs to
//   confirm the item left the pack.

/**
 * sell(client, session, { merchantId, itemId, waitMs })
 *
 * Offers one item to a merchant and accepts the counter.
 * Returns { sent, sold, price, reason }.
 *
 * `sold` is the item name on success, null on refusal.
 * `price` is the shillings received, null if not confirmed.
 */
export async function sell(client, session, { merchantId, itemId, waitMs = 1500 } = {}) {
  if (!client || !session) return { sent: false, sold: null, price: null, reason: 'no client or session' };
  if (merchantId == null)  return { sent: false, sold: null, price: null, reason: 'no merchant id' };
  if (itemId == null)      return { sent: false, sold: null, price: null, reason: 'no item id' };

  // The item must be in the pack.
  const item = (client.inventory ?? []).find(o => o.id === itemId);
  if (!item) return { sent: false, sold: null, price: null, reason: 'item not in the pack' };
  const name = client.rsc?.get?.(item.nameRsc) ?? `item ${itemId}`;

  // The merchant must be in the room.
  const room = client.room;
  const merchant = room?.objects?.get?.(merchantId);
  if (!merchant)
    return { sent: false, sold: null, price: null, reason: 'merchant not in the room' };

  // STEP 1: offer.
  const before1 = client.evSeq ?? 0;
  const offerItems = item.amount > 1 ? [{ id: itemId, amount: item.amount }] : itemId;
  await session.pacer.submit('trade', () => client.offer(merchantId, offerItems), waitMs).catch(() => {});

  // Wait for the counter. The server replies with either a price (which we
  // accept) or a refusal (which we report).
  const ev1 = await client.waitFor({ since: before1, kinds: ['trade', 'message'], timeoutMs: waitMs * 2 })
                .catch(() => ({ events: [] }));

  const tradeEv = (ev1.events ?? []).find(e => e.kind === 'trade');
  const msgs1 = (ev1.events ?? []).filter(e => e.text).map(e => e.text);

  if (!tradeEv) {
    // No counter arrived. Either the merchant refused outright (a message)
    // or the offer was lost. Report and stop.
    const refusal = msgs1.find(m => /refuse|won't|cannot|don't/i.test(m));
    if (refusal) return { sent: true, sold: null, price: null, reason: refusal };
    return { sent: true, sold: null, price: null, reason: 'no counter from merchant' };
  }

  // STEP 2: accept the counter.
  const before2 = client.evSeq ?? 0;
  await session.pacer.submit('trade', () => client.acceptOffer(), waitMs).catch(() => {});
  const ev2 = await client.waitFor({ since: before2, kinds: ['trade', 'message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs2 = (ev2.events ?? []).filter(e => e.text).map(e => e.text);
  // On success the server says "You sold X for Y shillings" and the trade
  // ends. On refusal it says "They don't want that" or similar.
  const success = msgs2.some(m => /sold|received|thank/i.test(m));
  if (!success)
    return { sent: true, sold: null, price: null, reason: msgs2.join('; ') || 'trade refused' };

  // Parse the price from the message if possible.
  const m = msgs2.join(' ').match(/(\d+)\s*shillings?/i);
  const price = m ? Number(m[1]) : null;

  return { sent: true, sold: name, price, reason: null };
}

sell.pre     = ['at_shop'];  // need a merchant in the room to sell to
sell.effects = ['has_money'];  // selling produces money (coarse gate)
sell.atomic  = 'sell';
sell.mutates = true;  // sends mutation packets (BP_REQ_OFFER + BP_ACCEPT_OFFER);

// ---------------------------------------------------------------------------
// BINDING -- which merchant, and which item. See m59-act/equip.mjs.
// ---------------------------------------------------------------------------
//
// SELLING IS AN ALLOWLIST, NOT A CHECK, and that rule outranks anything visible on the
// wire: `buys_anything` is true for the bankers, and Skivlat takes what you hand him,
// says thank you and gives nothing back. Nothing in a room object distinguishes a
// market from that. So an `isTrusted` predicate is REQUIRED to sell to anybody, there
// is deliberately no permissive default, and with none supplied this refuses --
// being wrong about a buyer costs the whole pack, being wrong about a walk costs a walk.
export function pickSale(client, isTrusted) {
  const objects = client?.room?.objects;
  const list = objects instanceof Map ? [...objects.values()]
             : Array.isArray(objects) ? objects : [];
  const nameOf = (o) => String(o?.name ?? client?.rsc?.get?.(o?.nameRsc) ?? '');
  if (typeof isTrusted !== 'function') return { why: 'no trusted-buyer test supplied' };

  const merchant = list.find(o => (o.can ?? []).includes('buy') && isTrusted(nameOf(o), o));
  if (!merchant?.id) return { why: 'no trusted buyer in this room' };

  const inv = client?.inventory;
  const item = (Array.isArray(inv) ? inv : [])
    .find(o => o?.id != null && !/shilling|gold|silver|copper/i.test(nameOf(o)));
  if (!item) return { why: 'nothing in the pack worth offering' };
  return { merchant, item };
}

export function sellOf({ isTrusted = null } = {}) {
  const run = (client, session, args = {}) => {
    const { merchant, item, why } = pickSale(client, isTrusted);
    if (!merchant) return { sent: false, sold: null, price: null, reason: why };
    return sell(client, session, { ...args, merchantId: merchant.id, itemId: item.id });
  };
  run.pre     = sell.pre;
  run.effects = sell.effects;
  run.mutates = sell.mutates;
  run.atomic  = 'sell';
  return run;
}
