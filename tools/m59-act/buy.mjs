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

import { affordances } from '../m59-parse.mjs';

/**
 * buy(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_BUY for one item. Returns { sent, bought, reason }.
 *
 * `bought` is the item name on success, null on refusal.
 */
export async function buy(client, session, { itemId, waitMs = 1200, name: wantName } = {}) {
  if (!client || !session) return { sent: false, bought: null, reason: 'no client or session' };

  // The buy list is cached on the client when BP_SELL_LIST arrives.
  // This happens when you send a buy request to a merchant object.
  // If the list is empty, find a merchant (object with 'buy' affordance)
  // and open their shop.
  let buyList = client.buyList;
  if (!buyList?.items?.length) {
    const c = session.need();
    const objects = c.room?.objects;
    if (objects?.size) {
      // Find objects with the 'buy' affordance — these are merchants
      const merchants = [...objects.values()].filter(o =>
        affordances(o.flags).includes('buy')
      );
      for (const seller of merchants) {
        const sName = c.rsc?.get?.(seller.nameRsc) ?? 'merchant';
        // Walk to the merchant if far away — server requires proximity
        const me = c.self;
        if (me) {
          const d = Math.hypot((seller.col ?? 0) - me.col, (seller.row ?? 0) - me.row);
          if (d > 2) {
            console.error(`[buy] ${session.name ?? '?'} walking to ${sName} at (${seller.col},${seller.row}), dist=${d.toFixed(1)}`);
            try { await session.walkTo(seller.col, seller.row, { maxSteps: 20 }); } catch {}
          }
        }
        console.error(`[buy] ${session.name ?? '?'} opening shop: ${sName} (id=${seller.id})`);
        const before = c.evSeq;
        await session.pacer.submit('buy', () => c.buy(seller.id), 1000).catch(() => {});
        const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 })
                        .catch(() => ({ events: [] }));
        const shop = ev.events?.find(e => e.kind === 'shop');
        if (shop?.items?.length) {
          buyList = { items: shop.items };
          console.error(`[buy] ${session.name ?? '?'} got buy list from ${sName}: ${shop.items.length} items`);
          break;
        }
        // Try next merchant
      }
      if (!buyList?.items?.length) {
        console.error(`[buy] ${session.name ?? '?'} no merchant gave a buy list (tried ${merchants.length})`);
      }
    }
  }
  if (!buyList?.items?.length)
    return { sent: false, bought: null, reason: 'no buy list (no merchant in room?)' };

  // If no specific item id, pick the cheapest food item. The planner
  // says "buy something"; the atomic decides what. This is the grounding
  // step: the planner reasons in symbols, the atomic reasons in items.
  let entry;
  if (itemId != null) {
    entry = buyList.items.find(i => i.id === itemId);
    if (!entry)
      return { sent: false, bought: null, reason: `item ${itemId} not in the buy list` };
  } else if (wantName) {
    entry = buyList.items.find(i =>
      /food|bread|cheese|stew|apple|peach|bun|cake|pie|porridge|rice|meat|fish|salad|egg|ham|bacon|sausage|roast|kebab|bowl|plate|loaf|torta|pasta|noodles|sushi|burger|sandwich|pizza|dough|flour|milk|juice|water|beer|wine|ale|cider|potion|drink/i.test(
        client.rsc?.get?.(i.nameRsc) ?? ''
      ));
    if (!entry)
      return { sent: false, bought: null, reason: `no food item in the buy list (wanted: ${wantName})` };
  } else {
    // Cheapest item in the buy list. The planner doesn't know what's
    // for sale; the atomic picks the cheapest thing, which is usually
    // food or a basic reagent.
    entry = [...buyList.items].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
    if (!entry)
      return { sent: false, bought: null, reason: 'buy list is empty' };
  }

  const name = client.rsc?.get?.(entry.nameRsc) ?? `item ${entry.id}`;
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

buy.pre     = ['has_money', 'at_shop'];  // the planner only plans a buy when
                    // the character can afford something AND a merchant is
                    // in the room. The per-item cost check still runs inside
                    // the atomic; has_money is a coarse gate (walking floor),
                    // not an exact affordability test.
buy.effects = ['has_food'];  // buying the cheapest item is usually food;
                     // the planner chains has_food=false -> buy -> has_food=true.
                     // This is optimistic (the item might not be food), but
                     // the next pass re-evaluates has_food from the actual
                     // inventory, and if the item wasn't food, the planner
                     // re-plans.
buy.atomic  = 'buy';
buy.mutates = true;  // sends a mutation packet (BP_REQ_BUY); effects are
                     // item-level, not vocabulary-level
