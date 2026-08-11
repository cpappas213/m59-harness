#!/usr/bin/env node
// TURN THE LOOT NOBODY EATS INTO THE TWO THINGS THAT KEEP VIGOR UP.
//
//   node tools/m59-reagents.mjs --dry-run     who would go where, and with what to sell
//   node tools/m59-reagents.mjs               do it
//   node tools/m59-reagents.mjs --want 20     of EACH half to come away with, default 12
//   node tools/m59-reagents.mjs --agents t3,t7
//
// WHY. Vigor is the variable the whole fleet turns on: resting stops paying at 80 of 200
// and everything above that has to be EATEN, so a character at 80 fights badly, earns
// little, and cannot buy its way out. The fleet's own answer is `create food` — 2
// ElderBerry + 2 Herbs a cast — and it had run the stock down to 26 elderberry across
// twenty-one characters with the almoner reporting "nobody has a surplus, the fleet is
// genuinely short". Redistribution cannot fix a shortage.
//
// Meanwhile every character is carrying mushrooms, red mushrooms, blue mushrooms,
// emeralds and sapphires — things the fleet does not eat, wear or swing, and which exist
// only to be sold. That is the trade this errand makes.
//
// I TOLD THE OPERATOR THIS WAS IMPOSSIBLE. Asked where elderberry comes from, I answered
// that no merchant sells it and the fleet could only farm it. That was wrong twice over:
// m59-lore's `sells` matcher compared against a field the merchant file does not have, and
// I repeated its empty result as a finding. Seven shops sell ElderBerry — HazarApothecary
// (1014, 1004), BarloqueApothecary (104), JasperMerchant (373), CornothGrocer (151),
// MarionInnkeeper (202), TosApothecary (53) — and six of them sell Herbs.
//
// The keeper already banks above its threshold, so money flows one way; this spends what
// is IN HAND, which is what selling just produced.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const ONLY = arg('agents', null);
const REVIVE_ONLY = !!arg('revive-only', false);
const WANT = Number(arg("want", 12));          // of each half to come away with
const SHORT_BELOW = Number(arg('below', 6));   // who counts as short

let id = 0;
async function call(name, args = {}, ms = 120_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text;
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// NOBODY IS LEFT INERT, INCLUDING WHEN THIS PROCESS IS KILLED.
//
// A `finally` does not run through a hard kill. That is not a hypothetical: this errand
// was run under `timeout 520`, the timeout killed node mid-trip, the finally never
// executed, and a character sat inert — keeper alive and recording, but not moving,
// swinging or trading — until an operator noticed and cleared it by hand. outfitPair
// carries a comment about the identical failure with p.kill(); I reproduced it from the
// other side.
//
// So the set of characters this process has made inert is tracked, and reviving them is
// attached to every way out there is: the normal path, an unhandled throw, and SIGINT /
// SIGTERM. Reviving something already awake is free, so over-reviving costs nothing and
// under-reviving costs a character.
const madeInert = new Set();
// A BUSY DECLARATION OUTLIVES THIS PROCESS UNLESS SOMEBODY CLEARS IT, so it is tracked and
// released on exactly the same paths as `inert` — normal return, throw, SIGINT/SIGTERM.
// Only the holder may clear its own busy, which is why the name is a constant rather than
// something assembled per call: a mismatched `by` leaves the character marked in flight
// until an operator overrides it by hand.
const BUSY_BY = 'm59-reagents';
const madeBusy = new Set();

async function reviveAll(why) {
  for (const agent of [...madeBusy]) {
    try {
      await call('autopilot', { agent, action: 'free', by: BUSY_BY }, 30_000);
      madeBusy.delete(agent);
    } catch { /* the lease expires on its own; never let this stop the revive below */ }
  }
  for (const agent of [...madeInert]) {
    try {
      await call('autopilot', { agent, action: 'revive', why }, 30_000);
      madeInert.delete(agent);
    } catch { /* keep trying the rest; a failure here must not stop the others */ }
  }
}

let bailing = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, async () => {
    if (bailing) return;
    bailing = true;
    console.log(`\n${sig} — reviving ${madeInert.size} keeper(s) before exit`);
    await reviveAll(`errand interrupted by ${sig}`);
    process.exit(130);
  });
}
process.on('uncaughtException', async (e) => {
  console.error('uncaught: ' + e.message);
  await reviveAll('errand threw');
  process.exit(1);
});

// NEVER SELL THESE. Money, the two reagents this errand exists to accumulate, and
// anything being worn or swung. Everything else is inventory the fleet cannot use.
//
// Gems are deliberately NOT protected. They are reagents for spells nobody here casts,
// they are not eaten, worn or swung, and holding them back is a one-way ratchet — one
// character was carrying fifty-six sapphires and thirty-six emeralds and could not buy an
// apple. A gem is worth more than the trip precisely because a merchant will pay for it.
const KEEP = ['shilling', 'elderberry', 'herb',
              'armor', 'armour', 'shield', 'helm', 'mace', 'sword', 'axe', 'hammer', 'bow',
              // A signet ring is 1500sh of somebody else's property and the fleet already
              // has a path for returning it to whoever is named on it.
              'signet'];

// FOOD IS NOT JUNK, AND A NAME LIST CANNOT TELL THE DIFFERENCE.
//
// The first version of KEEP was names only, and the dry run showed it would sell Fozzie's
// sixteen apples and eighteen loaves and Rowlf's edible mushrooms — the exact commodity
// this errand exists to buy the ingredients for. Substring matching cannot separate them
// either: "edible mushroom" is food at 5 nutrition and "blue mushroom" is not food at all,
// and both contain "mushroom".
//
// So ask the item table, which knows: anything with nutrition is kept, everything else on
// the mushroom-and-gem pile goes to the counter.
const FOOD = (() => {
  try {
    const j = JSON.parse(readFileSync(new URL('../substrate/m59-items.json', import.meta.url)
                                        .pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8'));
    return new Set(Object.values(j.food ?? {}).filter(f => (f.nutrition ?? 0) > 0)
                     .map(f => String(f.name).toLowerCase()));
  } catch { return new Set(); }
})();
const isFood = (name) => FOOD.has(String(name || '').trim().toLowerCase());

const norm = s => String(s || '').toLowerCase();
const countOf = (items, re) => (items || []).filter(i => re.test(norm(i.name)))
                                            .reduce((t, i) => t + (i.amount || 1), 0);
const purseOf = items => countOf(items, /shilling/);

// Rooms with a counter that sells ElderBerry, nearest by ROUTE. Asked per character
// because "nearest" is a fact about where it is standing, not about the map.
// HERB SELLERS ONLY. This asked for elderberry sellers AND herb sellers and pooled them,
// which was right when both halves had to be bought. It is now actively wrong, because the
// two lists are NOT the same shop list:
//
//   sells herbs:      1014, 1004, 104 (Joguer), 373 (Zhieu B'hob), 202 (Morrigan), 53 (Frisconar)
//   sells elderberry: those, PLUS 151 — Solomon, CornothGrocer, who sells NO herbs at all
//
// 151 is often the nearest counter, so pooling put it at the front of the queue and seven
// characters walked to the one shop in the world that could not sell them the thing they
// were short of. They each bought elderberry instead and the trip reported numbers going
// up. Ask only for what we are actually here to buy.
//
// STILL THE RIGHT LIST NOW THAT BOTH HALVES ARE BOUGHT AGAIN (see the buy step: the undead
// the fleet farms drop no elderberry either). Every herb seller above ALSO sells
// elderberry, so asking for herb sellers is exactly "counters that stock both halves", and
// 151 — the one that can only ever supply half a casting — stays correctly excluded. Do
// not re-pool the two lists to "widen" the search; that is the bug described above.
async function reagentShopsFor(agent) {
  const seen = new Map();
  {
    const m = await call('merchants', { agent, sells: 'herb' }, 60_000).catch(() => ({ matches: [] }));
    for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
  }
  const priced = [];
  for (const room of seen.keys()) {
    const rt = await call('map', { agent, to: room }, 60_000).catch(() => null);
    if (rt?.route?.found) priced.push({ room, hops: rt.route.hops.length });
  }
  return priced.sort((a, b) => a.hops - b.hops).map(p => p.room);
}

// Walk one character to one room and report where it actually ended up. Same rule as the
// shop loop below and for the same reason: travel is resumable and a failed hop is normal,
// so judge it on whether the room CHANGED, never on whether the call claimed it arrived.
async function goTo(agent, room, where) {
  let at = await where(), stuck = 0;
  for (let i = 0; i < 8 && at !== room && stuck < 2; i++) {
    await call('travel', { agent, to: room, max_hops: 20 }).catch(() => ({}));
    const now = await where();
    if (now === room) return now;
    if (now === at) stuck++; else { stuck = 0; at = now; }
    await sleep(1200);
  }
  return at;
}

async function stockUp(row) {
  const who = row.character || row.agent;
  const purchaseStatus = await call('autopilot', { agent: row.agent, action: 'status' }, 60_000)
    .catch(() => null);
  if (purchaseStatus?.policy?.buyReagents === false)
    return `${who}: paid reagent buying is disabled by strategy`;
  const inv0 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
  const eb0 = countOf(inv0.items, /elder/);
  const purse0 = purseOf(inv0.items);
  const sellable = (inv0.items || [])
    .filter(i => !isFood(i.name))
    .filter(i => !KEEP.some(k => norm(i.name).includes(k)));

  if (DRY) {
    const shops = await reagentShopsFor(row.agent);
    return `${who}: ${eb0} elderberry, ${purse0}sh, ${sellable.length} sellable ` +
           `(${sellable.slice(0, 4).map(i => i.name + (i.amount > 1 ? ` x${i.amount}` : '')).join(', ')})` +
           ` -> ${shops.length ? `room ${shops[0]}` : 'NO REACHABLE APOTHECARY'}`;
  }

  const shops = await reagentShopsFor(row.agent);
  if (!shops.length) return `${who}: no reachable shop that sells reagents`;

  // The keeper is stopped for the errand and restored on EVERY path out, including a
  // throw — the invariant deploy(), outfitPair() and feed() all needed and each learned
  // the same way, by finding characters standing in towns with nothing driving them.
  // INERT, NOT STOPPED. A stopped keeper is a character held still in whatever was
  // happening to it, and the uptime ledger charges any death in that window to the
  // strategy unless somebody writes down that it was deliberate. Inert is the state built
  // for exactly this: the keeper keeps looking and keeps recording — frames, observations,
  // the death record — and stops moving, swinging, speaking and trading, because something
  // else is driving. It is recorded as its own event, so this errand cannot pollute the
  // "died with nothing driving it" number the way stop/start does.
  //
  // It also means there is no policy to rebuild on the way out: revive puts back what was
  // already there, rather than me reconstructing assigned_room and hunt from a status read
  // and hoping I got the field names right.
  await call('autopilot', { agent: row.agent, action: 'inert',
                            why: 'reagent trip: selling junk to buy elderberry and herbs' })
              .catch(() => {});
  madeInert.add(row.agent);          // so every exit path can put it back

  // INERT STOPS THE KEEPER. IT DOES NOT STOP A BOT, AND THAT IS WHY THIS TRIP KEPT FAILING.
  //
  // `inert` is a statement about the keeper — it stands down and this errand drives. A bot
  // attached to the fleet is a DIFFERENT driver holding `movement`, and nothing about going
  // inert tells it to stand off. So with dum steering, this errand walked a character
  // toward an apothecary while the bot walked it back to the hunting room, and the trip
  // reported `could not reach any of 373, 53, 104` — measured on prod: two characters
  // completed in forty minutes while the bot held work, movement and economy on the fleet.
  //
  // `busy` is the verb for this and it already exists: a claim says who is steering and
  // leaves the character takeable, `busy` says an operation is IN FLIGHT and is what makes
  // everything else step over it. See the commitment note in CLAUDE.md — this errand is
  // exactly the case it was written for, "an external errand walks a character with its
  // keeper inert by design".
  //
  // THE WINDOW IS AN ESTIMATE THAT EXTENDS, NOT A NUMBER SOMEBODY GUESSED. A trip is up to
  // three shops at eight attempts each, plus a bank leg, plus selling and buying — several
  // minutes when it goes well and longest exactly when it is going badly, which is when
  // being interrupted costs the whole errand. So ask for a padded window; the harness
  // clamps it to BUSY_MAX_MS and says so rather than refusing.
  await call('autopilot', { agent: row.agent, action: 'busy', by: BUSY_BY,
                            kind: 'reagent-trip', label: 'buying elderberry and herbs',
                            why: 'walking to an apothecary, selling junk and restocking both halves',
                            lease_ms: 10 * 60_000 }, 30_000).catch(() => {});
  madeBusy.add(row.agent);
  try {
    const where = async () => {
      const st = await call('status', { agent: row.agent, brief: true }, 60_000).catch(() => null);
      return st?.where?.num ?? st?.room?.id ?? null;
    };
    let arrived = null;
    for (const room of shops.slice(0, 3)) {
      let at = await where(), stuck = 0;
      // Travel is resumable and a failed hop is normal here — judge it on whether the
      // room CHANGED, not on whether the call said it arrived.
      for (let i = 0; i < 8 && at !== room && stuck < 2; i++) {
        await call('travel', { agent: row.agent, to: room, max_hops: 20 }).catch(() => ({}));
        const now = await where();
        if (now === room) { at = now; break; }
        if (now === at) stuck++; else { stuck = 0; at = now; }
        await sleep(1200);
      }
      if (at === room) { arrived = room; break; }
    }
    if (arrived == null) return `${who}: could not reach any of ${shops.slice(0, 3).join(', ')}`;

    // FIND THE COUNTER FIRST — SELLING NEEDS TO KNOW WHO TO SELL TO.
    //
    // The first version called sell_all with {agent, keep, min_price} and no merchant.
    // That parameter is REQUIRED, so the call was rejected outright and nothing was sold:
    // Camilla walked to a shop carrying 148 mushrooms and came back with her purse
    // unchanged at 171sh and no elderberry, and the run reported no error I could see
    // because the trip's own output was cut off. A required argument omitted is not a
    // silent no-op — it is a rejection — but from outside it looked exactly like a
    // merchant that would not buy.
    const look = await call('look', { agent: row.agent }, 60_000).catch(() => ({ objects: [] }));
    let seller = (look.objects || []).find(o => (o.can || []).includes('buy'))
              ?? (look.objects || []).find(o => /apothecar|grocer|merchant|innkeep/i.test(o.name || ''));
    if (!seller) return `${who}: reached ${arrived} but found nobody at the counter`;
    let bankNote = '';

    // SELL, THEN BUY. The money to buy with is the money the selling just made — these
    // characters have been stripped by repeated deaths and carry almost nothing.
    let sold = null;
    if (sellable.length)
      sold = await call('sell_all', { agent: row.agent, merchant: seller.id,
                                      keep: KEEP, min_price: 1 }, 120_000)
                   .catch(e => ({ error: e.message }));

    const inv1 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
    let purse1 = purseOf(inv1.items);

    // THE MONEY IS USUALLY IN THE BANK, AND SELLING JUNK DOES NOT ALWAYS REACH IT.
    //
    // `bankSurplus` in the keeper only ever DEPOSITS — it keeps a 400 float and banks the
    // rest, and nothing anywhere withdraws for food. So a character that has spent its
    // float stays broke for as long as its loot is unprofitable, while its account grows.
    // Measured the morning this was added: 30,360 shillings banked across the fleet, and
    // Kermit walked to Joguer's counter with FOUR shillings and bought nothing. Statler
    // (2sh against 3,953 banked) and Animal (2sh against 1,426) did the same. The trip
    // reported success each time — "spent 0sh" is not an error.
    //
    // Jasper, Tos and Barloque share one account (BANK_BASIC, see CLAUDE.md), so either
    // counter below serves any of the three towns; Ko'catan's is a different account and
    // is deliberately not here. 54 is next door to the Tos apothecary at 53 and 376 is a
    // few steps from the Jasper merchant at 373, which is why the extra legs are cheap.
    //
    // Ask for no more than the banker actually holds. A balance is only known when one was
    // said out loud (there is no packet for it), so an unknown balance still asks — that
    // is the only thing available — but a KNOWN one caps the request, because asking 1000
    // of an account holding 813 is refused outright and reads exactly like an empty
    // account. That cost `m59-outfit.mjs` two walked banks and a bare character.
    const BANKS = [54, 376];
    const needMoney = 260;   // ~16 of each half at the Barloque shelf, with room to spare
    if (purse1 < needMoney) {
      const balance = row.banked?.balance ?? null;
      if (balance === 0) {
        bankNote = ` [nothing banked to draw on]`;
      } else {
        const back = arrived;
        let got = null;
        for (const bank of BANKS) {
          const at = await goTo(row.agent, bank, where);
          if (at !== bank) continue;
          const want = Math.min(900, balance == null ? 900 : balance);
          if (want <= 0) break;
          await call('bank', { agent: row.agent, action: 'withdraw', amount: want }).catch(() => null);
          await sleep(800);
          const p = purseOf((await call('inventory', { agent: row.agent }, 60_000)
                               .catch(() => ({ items: [] }))).items || []);
          got = p - purse1;
          if (p > purse1) { purse1 = p; break; }
        }
        bankNote = got > 0 ? ` [withdrew ${got}sh]`
                 : got === null ? ` [could not reach a bank]`
                 : ` [the banker handed over nothing]`;
        // BACK TO THE COUNTER, and the seller id is re-read there rather than reused:
        // object ids are per-room and the one found before the bank trip names something
        // in a room this character is no longer standing in.
        if (await goTo(row.agent, back, where) !== back)
          return `${who}: withdrew at the bank but could not get back to ${back}${bankNote}`;
        const look2 = await call('look', { agent: row.agent }, 60_000).catch(() => ({ objects: [] }));
        const s2 = (look2.objects || []).find(o => (o.can || []).includes('buy'))
                ?? (look2.objects || []).find(o => /apothecar|grocer|merchant|innkeep/i.test(o.name || ''));
        if (!s2) return `${who}: back at ${back} but found nobody at the counter${bankNote}`;
        seller = s2;
      }
    }

    const stock = await call('shop', { agent: row.agent, seller: seller.id }, 60_000)
                        .catch(e => ({ error: e.message }));
    const offers = (stock?.items || stock?.for_sale || []);
    const wanted = offers.filter(o => /elder|herb/i.test(o.name || ''));
    if (!wanted.length)
      return `${who}: ${arrived} sells no elderberry or herbs after all (had ${purse1}sh)`;

    // BUY WHICHEVER HALF THIS CHARACTER IS ACTUALLY SHORT OF, MEASURED NOW.
    //
    // This used to buy elderberry first, on the stated grounds that it "is the scarce half
    // of the recipe and the one the fleet runs out of". That was true when it was written
    // and has inverted completely: measured across all twenty-one characters the fleet
    // holds 1739 elderberry and 38 HERBS. Gonzo alone carries 237 elderberry and not one
    // herb, and cannot cast a single create food.
    //
    // A casting is 2 + 2, so the number of castings a character has is min(elder, herb) / 2
    // and the only useful purchase is the SMALLER pile. Buying the larger one reads as a
    // successful restock — the purse moves, the count climbs, the run reports numbers going
    // up — while the castings available stay at zero, which is exactly what happened.
    // HERBS FIRST, AND NOT MERELY BECAUSE THEY ARE THE SMALLER PILE TODAY.
    //
    // The two halves of the recipe have completely different supply. ElderBerry is on the
    // skeleton and battered-skeleton loot tables the fleet now farms all day, so it
    // arrives free and forever; Herbs are on neither and can ONLY be bought. Measured
    // across the fleet the day this changed: 1771 elderberry against 47 herbs, with
    // seventeen characters holding hundreds of the former and none of the latter.
    //
    // So this is not "buy whichever is lower" — that rule would start buying elderberry
    // again the moment a character's herbs briefly overtook it, spending money on the
    // one input that restocks itself. Buy the half the world will not give us.
    // SORTING IS NOT CHOOSING, and that distinction cost the fleet about 1200 shillings.
    //
    // The first version of this put herbs at the front of `wanted` and left the loop below
    // alone — and that loop pushes EVERY entry of `wanted` on every iteration, so ordering
    // changed which id went in first and nothing else. Both reagents were still bought.
    // Measured on the run that exposed it: Zoot spent 252sh and came away with elderberry
    // 108 -> 115 and herbs 0; Beaker spent 72sh for elderberry 124 -> 126 and herbs 0.
    // The report read like a successful restock in both cases.
    //
    // So filter, do not sort. Buy an explicit quantity of each half by ITS OWN id, never
    // by ordering a list that the loop below pushes in its entirety.
    //
    // CORRECTION, 2026-08-11: everything above this line is still the right method and its
    // premise has expired. "ElderBerry is on the skeleton and battered-skeleton loot tables
    // the fleet now farms all day, so it arrives free and forever" is FALSE, and the fleet
    // was starving on it. Read out of `substrate/m59-spawns.json` the day this changed:
    //
    //   skeleton          TID_TOUGH      RedMushroom BlueMushroom Snack Emerald Sapphire
    //                                    Diamond BlueDragonScale Ruby InkyCap MartyrScroll
    //   battered skeleton TID_SKELETON2  Mushroom RedMushroom Snack Money NeruditeArrow
    //                                    Emerald Sapphire InkyCap Knightshield ...
    //   zombie            TID_ZOMBIE     RedMushroom Waterskin Flask Arsenic Money ...
    //
    // No ElderBerry on any of the three. It was on the FUNGUS BEAST (TID_MEDIUM, 30%),
    // which is what the fleet farmed when that comment was written — and graduating from
    // fungus beasts to undead cut off the supply silently, because nothing in the fleet
    // measures where a reagent comes from. Result on the morning this was found: elderberry
    // 0 for Kermit, Beaker, Zoot and Gonzo, 1 for Robin, 2 for Clifford; six characters
    // unable to cast create food at all; the almoner reporting "nobody left with elderberry
    // to give"; 811 cast_declined for Gonzo alone; and seven characters pinned at the
    // resting cap of 80 vigor with no way past it.
    //
    // So the rule is neither "always buy elderberry" nor "never" — both are a guess about a
    // loot table that changes whenever the fleet changes prey. BUY WHAT THIS CHARACTER IS
    // ACTUALLY SHORT OF, MEASURED IN ITS OWN PACK, for each half independently. When the
    // prey does drop elderberry the count stays above WANT on its own and this spends
    // nothing on it, which is the behaviour the comment above was protecting.
    const hb0 = countOf(inv0.items, /herb/);
    const perReagent = [
      { what: 'herbs',      have: hb0, offers: wanted.filter(o => /herb/i.test(o.name || '')) },
      { what: 'elderberry', have: eb0, offers: wanted.filter(o => /elder/i.test(o.name || '')) },
    ];
    const short = perReagent.filter(r => r.have < WANT && r.offers.length);
    if (!short.length) {
      const missing = perReagent.filter(r => r.have < WANT).map(r => r.what);
      return missing.length
        ? `${who}: ${arrived} sells no ${missing.join(' or ')} after all — bought nothing, purse still ${purse1}sh`
        : `${who}: already holds ${WANT}+ of both halves — bought nothing, purse still ${purse1}sh`;
    }
    const buyIds = [];
    for (const r of short) {
      const need = Math.max(0, WANT - r.have);
      for (let i = 0; i < need && i < 40; i++) for (const o of r.offers) buyIds.push(o.id);
    }
    const bought = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: buyIds.slice(0, 60) },
                              180_000).catch(e => ({ error: e.message }));

    const inv2 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
    const eb2 = countOf(inv2.items, /elder/);
    const hb2 = countOf(inv2.items, /herb/);
    const purse2 = purseOf(inv2.items);
    // REPORT WHAT THE PURSE DID, not what the buy was asked to do. A purchase that does
    // not register is silent — the counter simply takes nothing — so the money is the
    // only honest witness.
    // SAY WHEN THE TRIP LEFT THE CHARACTER UNABLE TO CAST ANYWAY.
    //
    // A casting is 2 + 2, so the number of castings is min(elder, herb)/2 and a trip that
    // fills one half and not the other has bought nothing usable. That is not a rare edge:
    // Animal went to 373, spent every one of its 400 shillings, came away with elderberry
    // 4 -> 14 and herbs STILL 0 — the counter offered no herbs that trip — and the line
    // read like a successful restock because it only ever named what went up. The early
    // return above covers "this shop sells neither"; this covers the worse case, where
    // one half was bought and the trip still ends with zero castings.
    const castings = Math.floor(Math.min(eb2, hb2) / 2);
    const dry = castings === 0
      ? `  *** STILL CANNOT CAST — ${eb2 ? 'no herbs' : 'no elderberry'} at this counter ***` : '';
    return `${who}: at ${arrived}, sold ${sellable.length} kind(s) ` +
           `(${purse0} -> ${purse1}sh)${bankNote}, spent ${purse1 - purse2}sh, ` +
           `elderberry ${eb0} -> ${eb2}, herbs now ${hb2}, ${castings} casting(s)` +
           (bought?.error ? ` [buy said: ${String(bought.error).slice(0, 50)}]` : '') + dry;
  } finally {
    // The same invariant every errand in this repo needed and each learned by finding
    // characters standing in towns with nothing driving them: whoever this stopped is
    // driving again before we return, on every path out including a throw.
    // Clear `busy` FIRST. It is what everything else steps over, so leaving it set on a
    // character whose keeper is already driving again is the one combination that reads as
    // healthy from every angle while the fleet ignores it.
    await call('autopilot', { agent: row.agent, action: 'free', by: BUSY_BY }, 30_000)
            .then(() => madeBusy.delete(row.agent)).catch(() => {});
    const ok = await call('autopilot', { agent: row.agent, action: 'revive',
                                         why: 'reagent trip finished' })
                     .then(() => true).catch(() => false);
    if (ok) madeInert.delete(row.agent);
    else console.log(`  ${who}: COULD NOT REVIVE ITS KEEPER after the reagent trip`);
  }
}

// ---------------------------------------------------------------- main

const f = await call('fleet', {}, 120_000).catch(() => null);
if (!f?.fleet) { console.error('could not read the fleet'); process.exit(1); }
const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;

const candidates = [];
for (const r of f.fleet.filter(x => x.character && x.room_num != null)) {
  if (only && !only.includes(r.agent)) continue;
  // SHORT MEANS SHORT OF A CASTING, NOT SHORT OF A PLANT. `create food` costs 2 elderberry
  // AND 2 herbs, so what a character has is min(elder, herb) — and selecting on elderberry
  // alone hid the entire shortage: seventeen characters sitting on hundreds of elderberry
  // and zero herbs were all "well stocked" and never sent, while the four this did send
  // were picked for being low on the plentiful half.
  // Selection is on min(elder, herb) — BOTH HALVES HAVE TO BE BOUGHT AGAIN. This said
  // "HERBS ALONE ... elderberry drops from the prey and herbs do not", which was true of
  // fungus beasts and is false of the undead the fleet farms now; the buy step above has
  // the loot tables. Selecting on herbs alone while elderberry was the empty half sent
  // nobody: a character with 12 herbs and 0 elderberry has no castings and looked stocked.
  const hb = r.reagents?.herb ?? r.reagents?.herbs ?? 0;
  const eb = r.reagents?.elder ?? r.reagents?.elderberry ?? 0;
  if (!only && Math.min(hb, eb) >= SHORT_BELOW) continue;
  candidates.push(r);
}

// THE FLAG THE WARNING BELOW TELLS YOU TO RUN, WHICH DID NOT EXIST.
//
// `--revive-only` appeared exactly once in this file — inside the message recommending
// it. Unknown flags are ignored here, so an operator following that advice re-ran the
// ENTIRE errand: six more characters walked to shops and about 350 shillings went on
// elderberry, while the output still looked like a repair job. A tool that names a flag
// in its own error text has promised that flag exists.
//
// It restarts every keeper this repository can see as farming, which is the same repair
// `reviveAll` does at the end of a real run, without moving anybody or spending anything.
if (REVIVE_ONLY) {
  let fixed = 0;
  for (const r of (f.fleet || [])) {
    if (!/inert|no keeper|stopped/i.test(String(r.activity || ''))) continue;
    const st = await call('autopilot', { agent: r.agent, action: 'status' }, 30_000).catch(() => null);
    const p = st?.policy || {};
    await call('autopilot', { agent: r.agent, action: 'start', mode: 'farm',
                              hunt: p.hunt || undefined,
                              assigned_room: p.assignedRoom ?? undefined },
               60_000).catch(() => {});
    console.log(`  revived ${r.character || r.agent} (was: ${String(r.activity).slice(0, 60)})`);
    fixed++;
  }
  console.log(fixed ? `${fixed} keeper(s) restarted — nobody moved, nothing bought`
                    : 'no stopped keepers to revive');
  process.exit(0);
}

console.log(`${candidates.length} character(s) with fewer than ${SHORT_BELOW} of either half ` +
            `(a casting is 2 elderberry + 2 herbs, so the smaller pile is the count)` +
            `${DRY ? ' (dry run)' : ''}`);
for (const row of candidates) {
  try { console.log('  ' + await stockUp(row)); }
  catch (e) { console.log(`  ${row.character || row.agent}: ${e.message.slice(0, 90)}`); }
}

// The belt to the signal handlers' braces: whatever happened above, nothing this process
// made inert is still inert when it returns.
await reviveAll('errand finished');
if (madeInert.size) console.log(`WARNING: ${madeInert.size} keeper(s) could not be revived — ` +
  `run: node tools/m59-reagents.mjs --revive-only`);
