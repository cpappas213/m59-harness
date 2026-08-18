#!/usr/bin/env node
// m59-act/buy.mjs -- BUY ONE ITEM FROM A MERCHANT.
//
// The packet is BP_REQ_BUY {4,OBJECT} — the item id from the merchant's
// buy list. The server checks the purse, decrements it, and sends the item
// into the pack. No negotiation, no trade protocol — unlike selling, buying
// is a one-way street.
//
// WHAT THE ATOMIC CHECKS BEFORE SENDING:
//   THE ITEM IS IN THE MERCHANT'S BUY LIST. The client caches the buy list
//   when the merchant's BP_SELL_LIST arrives (the 'buy-list' event). Buying
//   an id that is not in the list is a packet the server drops.
//   THE PURSE COVERS THE COST. The server refuses when the purse is short,
//   and the refusal is a message. Checking locally is a courtesy — it saves
//   a round-trip and lets the planner reason about "can I afford this"
//   without executing. The check is a REFUSAL, not a confirmation: the
//   purse can change between the check and the send, and the server's
//   answer is the one that counts.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT SELL. Selling is the trade protocol (offer -> counter ->
//   accept) and has its own atomic.
//   IT DOES NOT WALK. The merchant must be in the room. A planner that
//   needs to travel to a shop plans the travel separately.
//   IT DOES NOT REFRESH THE INVENTORY. The caller re-reads when it needs to
//   confirm the item arrived.

/**
 * buy(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_BUY for one item. Returns { sent, bought, reason }.
 *
 * `bought` is the item name on success, null on refusal.
 */
export async function buy(client, session, { itemId, waitMs = 1200 } = {}) {
  if (!client || !session) return { sent: false, bought: null, reason: 'no client or session' };
  if (itemId == null)      return { sent: false, bought: null, reason: 'no item id' };

  // The buy list is cached on the client when BP_SELL_LIST arrives.
  const buyList = client.buyList;
  if (!buyList?.items?.length)
    return { sent: false, bought: null, reason: 'no buy list (not in a shop room?)' };

  const entry = buyList.items.find(i => i.id === itemId);
  if (!entry)
    return { sent: false, bought: null, reason: `item ${itemId} not in the buy list` };

  const name = client.rsc?.get?.(entry.nameRsc) ?? `item ${itemId}`;
  const cost = entry.cost ?? 0;

  // THE PURSE CHECK. A courtesy — the server's refusal is the real answer,
  // but planning a buy we cannot afford wastes the pass.
  // The purse is not a client property; it is the sum of shilling objects in
  // the inventory, the same way the broker's purseAmount() reads it.
  const purse = (client.inventory ?? [])
    .filter(o => /shilling/i.test(client.rsc?.get?.(o.nameRsc) ?? ''))
    .reduce((sum, o) => sum + (o.amount ?? 1), 0);
  if (purse < cost)
    return { sent: false, bought: null, reason: `cannot afford: ${name} costs ${cost}, purse has ${purse}` };

  const before = client.evSeq ?? 0;
  await session.pacer.submit('buy', () => client.buy(itemId), waitMs).catch(() => {});
  const ev = await client.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  // The server says "You bought X for Y" on success and "You can't afford
  // that" or "They don't have that" on refusal.
  const success = msgs.some(m => /bought|purchased/i.test(m));
  if (success) return { sent: true, bought: name, reason: null };

  return { sent: true, bought: null, reason: msgs.join('; ') || 'no reply' };
}

buy.pre     = [];   // the purse check is local and item-specific; the
                    // vocabulary does not model a per-item "affordable" symbol.
                    // A planner that needs "can I afford X" checks the buy
                    // list cost against the purse at plan time.
buy.effects = [];   // the item goes into the pack and the purse drops. Neither
                    // is a vocabulary symbol: pack_room is about capacity, not
                    // contents, and the purse is not a symbol at all.
buy.atomic  = 'buy';
buy.mutates = true;  // sends a mutation packet (BP_REQ_BUY); effects are
                     // item-level, not vocabulary-level
