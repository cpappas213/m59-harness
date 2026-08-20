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

import { FOOD_RE } from '../m59-worldstate.mjs';

import { affordances } from '../m59-parse.mjs';

/**
 * buy(client, session, { itemId, waitMs })
 *
 * Sends BP_REQ_BUY for one item. Returns { sent, bought, reason }.
 *
 * `bought` is the item name on success, null on refusal.
 */
const WEAPON_RE = /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow/i;

export async function buy(client, session, { itemId, waitMs = 1200, name: wantName } = {}) {
  if (!client || !session) return { sent: false, bought: null, reason: 'no client or session' };
  const c = client;

  // ONE INTERACTION PER CALL, and buying is really THREE of them: get near the
  // merchant, open the shop, hand over the money. This used to do all three in one
  // call, inside a `for (const seller of merchants)` loop that walked up to 20 steps
  // and waited 4s per merchant -- so a buy could hold the pass for tens of seconds
  // with nothing sampling health, and the sweep's no-loop-around-an-await rule exists
  // precisely to stop that.
  //
  // So each call advances exactly one phase and returns. The keeper calls again next
  // pass, which is a re-read of the world between every phase rather than a plan made
  // once and executed blind.
  let buyList = c.buyList;

  if (!buyList?.items?.length) {
    const objects = c.room?.objects;
    const list = objects instanceof Map ? [...objects.values()]
               : Array.isArray(objects) ? objects : [];
    const merchants = list.filter(o => affordances(o.flags ?? 0).includes('buy'));
    if (!merchants.length)
      return { sent: false, bought: null, reason: 'no merchant in this room' };

    // THE NEAREST ONE, not each one in turn. Trying every merchant in a room was how
    // one call became a tour; if the nearest cannot serve us the next pass sees an
    // unchanged buy list and we are no worse off than after one wasted step.
    const me = c.self;
    const seller = me
      ? merchants.reduce((best, o) => {
          const d = Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row);
          return d < best.d ? { o, d } : best;
        }, { o: null, d: Infinity }).o
      : merchants[0];
    const sName = c.rsc?.get?.(seller.nameRsc) ?? 'merchant';

    // PHASE 1 -- get within talking distance. One step, then hand the pass back.
    if (me) {
      const d = Math.hypot((seller.col ?? 0) - me.col, (seller.row ?? 0) - me.row);
      if (d > 2) {
        const stepped = typeof session.walkTo === 'function'
          ? await session.walkTo(seller.col, seller.row, { maxSteps: 1 })
              .catch(() => ({ arrived: false }))
          : { arrived: false, reason: 'no walker on the session' };
        const after = c.self;
        const moved = !!after && (after.col !== me.col || after.row !== me.row);
        return { sent: true, bought: null, approaching: sName,
                 reason: moved ? `a step closer to ${sName}`
                               : (stepped?.reason ?? `could not get closer to ${sName}`) };
      }
    }

    // PHASE 2 -- open the shop. One request, one bounded wait.
    const before = c.evSeq;
    await session.pacer.submit('buy', () => c.buy(seller.id), 1000).catch(() => {});
    const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 1500 })
                      .catch(() => ({ events: [] }));
    const shop = ev.events?.find(e => e.kind === 'shop');
    if (!shop?.items?.length)
      // `bought: FALSE`, not null. Null is "not applicable yet" -- what the approach
      // phase returns while it is genuinely making progress -- and didAct() reads only
      // an explicit false as a refusal. Returning null here made a merchant with an
      // empty counter report acted=true on every pass, so the keeper called progress(),
      // the goal-skip that stops a hopeless goal after five failures NEVER COUNTED ONE,
      // and JayB stood in front of Marcus in the Raza Inn opening an empty shop for ever.
      // Watched from the client, which is the only place it looked like anything at all.
      //
      // The wait is 1500ms rather than 4000ms for the same episode: the list arrives at
      // once or not at all, and burning four seconds per pass to learn nothing is four
      // seconds of not looking at anything else.
      return { sent: true, bought: false, reason: `${sName} offered no list` };
    buyList = { items: shop.items };
  }

  // PHASE 3 -- the purchase.
  const nameOf = (i) => c.rsc?.get?.(i.nameRsc) ?? i.name ?? '';
  let entry;
  if (itemId != null) {
    entry = buyList.items.find(i => i.id === itemId);
    if (!entry)
      return { sent: false, bought: null, reason: `item ${itemId} not in the buy list` };
  } else if (wantName) {
    entry = buyList.items.find(i => FOOD_RE.test(nameOf(i)));
    if (!entry)
      return { sent: false, bought: null, reason: `no food item in the buy list (wanted: ${wantName})` };
  } else {
    const eq = c.equipment?.();
    const isArmedNow = !eq || eq.known === false
      ? true
      : (eq.equipped || []).some(o => WEAPON_RE.test(o.name ?? c.rsc?.get?.(o.nameRsc) ?? ''));
    if (!isArmedNow) {
      entry = buyList.items
        .filter(i => WEAPON_RE.test(nameOf(i)))
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
    }
    entry ??= [...buyList.items].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
    if (!entry) return { sent: false, bought: null, reason: 'buy list is empty' };
  }

  const name = nameOf(entry) || `item ${entry.id}`;
  const cost = entry.cost ?? 0;

  // THE PURSE CHECK. A courtesy -- the server's refusal is the real answer, but
  // planning a buy we cannot afford wastes the pass.
  const purse = (c.inventory ?? [])
    .filter(o => /shilling/i.test(c.rsc?.get?.(o.nameRsc) ?? ''))
    .reduce((sum, o) => sum + (o.amount ?? 1), 0);
  if (purse < cost)
    return { sent: false, bought: null, reason: `cannot afford: ${name} costs ${cost}, purse has ${purse}` };

  // BUY THE ENTRY WE CHOSE, NOT THE ARGUMENT WE WERE GIVEN. This sent `itemId`, which
  // is undefined on every planner-initiated buy -- the planner asks for "a buy" and
  // lets the atomic pick -- so the request went out with no item on it and the reply
  // never matched /bought/. It reported `sent: true` either way.
  const before = c.evSeq ?? 0;
  await session.pacer.submit('buy', () => c.buy(entry.id), waitMs).catch(() => {});
  const ev = await c.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  const success = msgs.some(m => /bought|purchased/i.test(m));
  if (success) return { sent: true, bought: name, reason: null };
  // Same rule as above: a purchase that did not happen is `false`, so the caller can
  // count it. "No error" has never meant success here.
  return { sent: true, bought: false, reason: msgs.join('; ') || 'no reply' };
}

buy.pre     = ['has_money', 'at_shop'];  // the planner only plans a buy when
                    // the character can afford something AND a merchant is
                    // in the room. The per-item cost check still runs inside
                    // the atomic; has_money is a coarse gate (walking floor),
                    // not an exact affordability test.
buy.effects = ['has_food', 'armed'];  // buying a weapon makes you armed;
                     // buying food feeds you. The atomic picks the right item
                     // based on what the character needs. The planner chains
                     // armed=false -> buy -> armed=true, or has_food=false ->
                     // buy -> has_food=true. The next pass re-evaluates from
                     // the actual inventory.
buy.atomic  = 'buy';
buy.mutates = true;  // sends a mutation packet (BP_REQ_BUY); effects are
                     // item-level, not vocabulary-level
