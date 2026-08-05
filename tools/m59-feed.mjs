#!/usr/bin/env node
// FEED THE CHARACTERS THAT CANNOT FEED THEMSELVES.
//
//   node tools/m59-feed.mjs --dry-run        # who needs it and where they would go
//   node tools/m59-feed.mjs                  # do it
//   node tools/m59-feed.mjs --agents t18,t19
//   node tools/m59-feed.mjs --want 6         # how many meals to come away with
//
// WHY THIS EXISTS, AND WHY EVERY OTHER ROUTE FAILED.
//
// Resting stops awarding vigor at 80 of 200, so everything above that has to be EATEN.
// A character at 80 fights badly, earns little, and therefore cannot buy the food that
// would fix it — the loop closes on itself and nothing inside the wilderness opens it.
// Twelve of twenty-one sat in it all night.
//
// Handing them food from a richer character was tried five ways and failed five ways:
// the trade API wants a character name rather than an agent id; the receiver's keeper
// cancels the exchange by acting; a half-finished trade swallows the goods so the next
// delivery finds an empty pack; the donor arrives to find the recipient has walked off;
// and `supply` would not travel at all until it was made to. Each of those is now
// fixed, and the approach is still wrong, because it needs two characters to be in one
// place at one time and this fleet is never still.
//
// THE CHARACTER DOES NOT NEED A DONOR. It needs a shop. Innkeepers sell bread and buy
// anything (buys_anything in the merchant table), so one trip both funds itself and
// spends the money: sell the mushrooms and pelts nobody wants, buy the loaf. No second
// character, no meeting, no trade protocol.
//
// The keeper is stopped for the errand and restored on EVERY path out, including a
// throw — the same invariant deploy() and outfitPair() needed, learned the same way,
// which is by finding characters standing in towns with nothing driving them.
import { readFileSync } from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const ONLY = arg('agents', null);
const WANT = Number(arg('want', 6));
// Below this a character is worth a trip. Above it, resting and the odd loaf keep up.
const HUNGRY_BELOW = Number(arg('below', 150));
// How many times to re-ask travel for one shop. Four was the observed cost of a five-hop
// walk; eight leaves room for a worse one without walking for ever.
const TRAVEL_TRIES = Number(arg('travel-tries', 8));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ITEMS = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../substrate/m59-items.json', import.meta.url)
                                     .pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8'));
  } catch { return null; }
})();
const foodValue = (n) => ITEMS?.food?.[String(n || '').trim().toLowerCase()] || null;
const isFood = (n) => !!foodValue(n);
const vigorOf = (n) => foodValue(n)?.nutrition ?? 0;

// Never sell these. Money, gems (worth more than the trip), reagents the creation
// spells need, and anything being worn — sell_all's own keep list covers equipment, but
// naming the reagents matters because they are the OTHER route to food.
const KEEP = ['shilling', 'elderberry', 'herb', 'diamond', 'ruby', 'emerald', 'sapphire',
              'armor', 'armour', 'shield', 'helm', 'mace', 'sword', 'axe', 'hammer'];

const purseOf = items => (items || []).filter(i => /shilling/i.test(i.name))
                                      .reduce((t, i) => t + (i.amount || 1), 0);
const foodIn = items => (items || []).filter(i => isFood(i.name))
                                     .reduce((t, i) => t + (i.amount || 1), 0);
// What the pack is worth in vigor, which is the number that actually matters. Six water
// skins and six wheels of cheese are both "6 meals" and are 18 vigor against 180.
const vigorIn = items => (items || []).filter(i => isFood(i.name))
                                      .reduce((t, i) => t + vigorOf(i.name) * (i.amount || 1), 0);

// Rooms with someone who sells food, nearest first. Asked per character because
// "nearest" is a property of where it is standing.
async function foodShopsFor(agent) {
  const seen = new Map();
  // The catalogue has no "food" category — the items are called bread, apple, pie. So
  // ask for the things themselves, which is also how this was missed for so long.
  for (const what of ['bread', 'apple', 'meat pie', 'cheese']) {
    const m = await call('merchants', { agent, sells: what }).catch(() => ({ matches: [] }));
    for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
  }
  const priced = [];
  for (const m of seen.values()) {
    const rt = await call('map', { agent, to: m.room }).catch(() => null);
    if (rt?.route?.found) priced.push({ room: m.room, hops: rt.route.hops.length });
  }
  return priced.sort((a, b) => a.hops - b.hops).map(p => p.room);
}

// FIND SOMEONE WHO CAN LEND IT THE PRICE OF A MEAL.
//
// Selling only works for a character that still has something to sell, and the ones that
// need this most have been stripped by repeated deaths — Gonzo, Rizzo and Lew were
// carrying nothing but their weapon. The fleet is not poor, though: three characters were
// holding 3,259 shillings between them while ten had none. It is a distribution problem.
//
// Nearest by ROUTE, not by room number, because the donor has to walk it. supply() holds
// both keepers, travels, and verifies the money arrived in the receiver's pack.
const DONOR_RESERVE = Number(arg('donor-reserve', 200));
async function fundFrom(row, need) {
  const f = await call('fleet', {}).catch(() => null);
  if (!f) return null;
  const donors = [];
  for (const c of f.fleet || []) {
    if (c.agent === row.agent) continue;
    const inv = await call('inventory', { agent: c.agent }).catch(() => ({ items: [] }));
    const sh = (inv.items || []).find(i => /shilling/i.test(i.name));
    // Leave the donor something, but do not price the loan out of existence. The reserve
    // was 400 against a 600 loan, which asks for a donor holding a thousand — the whole
    // fleet's richest character had 904, so nothing qualified and every destitute
    // character stayed destitute while the fleet sat on 4,473 shillings. A donor at high
    // vigor with loot in its pack can rebuild a small reserve; a character at zero and
    // vigor 80 cannot rebuild anything.
    if ((sh?.amount || 0) >= need + DONOR_RESERVE) donors.push({ agent: c.agent, name: c.character, id: sh.id, sh: sh.amount, room: c.room_num });
  }
  if (!donors.length) return null;
  const routed = [];
  for (const d of donors) {
    if (d.room === row.room_num) { routed.push({ ...d, hops: 0 }); continue; }
    const m = await call('map', { agent: d.agent, to: row.room_num }).catch(() => null);
    if (m?.route?.found) routed.push({ ...d, hops: m.route.hops.length });
  }
  if (!routed.length) return null;
  routed.sort((a, b) => a.hops - b.hops);
  const d = routed[0];
  // Lend the price of several meals, not the whole purse. The donor is earning and
  // needs to keep eating; taking everything just moves the destitution along the line.
  const r = await call('supply', { from: d.agent, to: row.agent,
                                   what: [{ id: d.id, amount: need }], who_travels: 'from' })
                  .catch(e => ({ supplied: false, reason: e.message }));
  return r?.supplied ? `${d.name} (${d.hops} hops, ${need}sh of ${d.sh})` : null;
}

async function feed(row) {
  const who = row.character || row.agent;
  const was = await call('autopilot', { agent: row.agent, action: 'status' }).catch(() => null);
  if (DRY) {
    const shops = await foodShopsFor(row.agent);
    return `${who}: vigor ${row.vigor}, would go to ${shops.length ? `room ${shops[0]}` : 'NOWHERE — no reachable food shop'}`;
  }
  await call('autopilot', { agent: row.agent, action: 'stop' }).catch(() => {});
  try {
    const shops = await foodShopsFor(row.agent);
    if (!shops.length) return `${who}: no reachable food shop`;

    // TRAVEL IS RESUMABLE, SO KEEP ASKING — AND JUDGE IT ON WHETHER THE ROOM CHANGED.
    //
    // Three attempts per shop across three shops sounds like nine chances and is not: a
    // walk that stops halfway has made progress, and starting again on a different shop
    // throws that progress away. Clifford took FOUR attempts to reach room 103, moving
    // 552 -> 544 -> 554 -> 574 -> 574 -> 103, and every one of the first three returned
    // arrived:false while getting closer. On three tries it would have been abandoned as
    // unreachable, which is exactly what "could not reach a food shop (tried 52, 151,
    // 103)" meant after an hour of trying.
    //
    // Rooms are not adjacent in the way the map suggests — an edge you can route through
    // is not an edge you can necessarily step through from the square the router picked
    // — so a failed hop is normal and the honest test is movement, not success. Give up
    // on a shop only when two attempts running leave the character in the same room.
    const whereNow = async () => {
      const st = await call('status', { agent: row.agent, brief: true }).catch(() => null);
      return st?.where?.num ?? null;
    };
    // AN EMPTY COUNTER IS A REASON TO WALK ON, NOT A REASON TO STOP.
    //
    // `merchants` answers what a shop SELLS; stock is a live thing that runs out and is
    // restocked on the server's own schedule. So the catalogue can send a character five
    // hops to The Bhrama & Falcon and have it arrive at a counter holding nothing —
    // which happened to Sweetums at room 103 (0 items) and Gonzo at 202 (5 items, none
    // of them food) in the same run. Both walked, both gave up, both came home hungry.
    //
    // The shop candidates are already ranked by route, so the next one is the next
    // cheapest thing to try. Arriving at an empty counter now costs the walk, not the
    // errand.
    let arrived = false, tried = [], seller = null, why = [];
    for (const room of shops.slice(0, 4)) {
      let got = false, stuck = 0, was = await whereNow();
      for (let i = 0; i < TRAVEL_TRIES && !got && stuck < 2; i++) {
        const t = await call('travel', { agent: row.agent, to: room, max_hops: 20 })
                        .catch(e => ({ arrived: false, why: e.message }));
        const now = await whereNow();
        if (t.arrived || now === room) { got = true; break; }
        if (now === was) stuck++; else { stuck = 0; was = now; }
        await sleep(1200);
      }
      if (!got) { tried.push(room); why.push(`${room}: could not get there`); continue; }

      const look = await call('look', { agent: row.agent }).catch(() => ({ objects: [] }));
      const here = (look.objects || []).find(o => (o.can || []).includes('buy'));
      if (!here) { tried.push(room); why.push(`${room}: nobody here trades`); continue; }
      // Ask what is ON THE SHELF, not what the catalogue believes.
      const peek = await call('shop', { agent: row.agent, seller: here.id }).catch(() => null);
      const stocked = (peek?.items || []).some(i => isFood(i.name) && (i.cost ?? 0) > 0);
      if (!stocked) {
        tried.push(room);
        why.push(`${room}: counter has ${(peek?.items || []).length} item(s), no food on the shelf`);
        continue;
      }
      arrived = room; seller = here; break;
    }
    if (!arrived) return `${who}: no food to be had — ${why.join('; ')}`;

    // FUND IT FROM THE PACK. This is the whole trick: the character is broke because it
    // cannot fight, and it is carrying loot it cannot eat. One counter solves both.
    let inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    const before = purseOf(inv);
    if (before < 200) {
      await call('sell_all', { agent: row.agent, merchant: seller.id, keep: KEEP, min_price: 1 })
        .catch(() => null);
      await sleep(800);
      inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    }
    let purse = purseOf(inv);
    // Still broke after selling everything it had? Then it had nothing, and no amount of
    // shopping fixes that. Borrow from whoever is nearest and can spare it.
    //
    // BORROW WHAT THE GAP COSTS, not a flat sum against a flat trigger. A character
    // holding 200 shillings did not qualify for help and could buy one cheese, so it
    // walked to the shop, closed a fifth of its deficit, and was back at the resting cap
    // an hour later. Cheese runs about 4 shillings a vigor point, which is the rate to
    // budget against; the shop's own prices decide the rest.
    let lender = null;
    const gap = Math.max(0, (row.vigor_target ?? 180) - (row.vigor ?? 0));
    const wantPurse = Math.min(900, Math.max(200, gap * 5));
    if (purse < wantPurse) {
      lender = await fundFrom(row, Math.min(900, wantPurse - purse));
      if (lender) {
        await sleep(1000);
        inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
        purse = purseOf(inv);
      }
    }

    // A FAILED SHOP CALL IS NOT AN EMPTY SHOP, and reporting it as one sent me looking
    // at the wrong thing: room 103 plainly sells bread at 108 and apples at 45, and the
    // message said it sold no food.
    let shop = null, shopErr = null;
    try { shop = await call('shop', { agent: row.agent, seller: seller.id }); }
    catch (e) { shopErr = e.message; }
    if (!shop) return `${who}: could not open the shop at ${arrived} — ${shopErr ?? 'no reply'}`;
    // BUY VIGOR, NOT ITEMS. viNutrition is vigor one-for-one (player.kod:1277), and it
    // ranges from 3 for a water skin to 30 for a cheese. Sorting on price and taking the
    // cheapest — which is what this did — always chose the water skin, so a character
    // sent to close a 100-vigor gap came back with six of them and eighteen vigor, and
    // the errand reported success. Rank on vigor per shilling; money is the constraint,
    // not the stomach, because food keeps in the pack and the stomach drains in a
    // quarter of an hour (FOOD_USE_RATE 12).
    const menu = (shop.items || []).filter(i => isFood(i.name) && (i.cost ?? 0) > 0)
                                   .map(i => ({ ...i, vigor: vigorOf(i.name) }))
                                   .filter(i => i.vigor > 0)
                                   .sort((a, b) => (b.vigor / b.cost) - (a.vigor / a.cost)
                                                || b.vigor - a.vigor);
    if (!menu.length)
      return `${who}: room ${arrived} stocks ${(shop.items || []).length} item(s), none of them food`;

    // How much vigor this character is actually short. WANT survives as a floor for the
    // case where the board did not say.
    const short = Math.max(0, (row.vigor_target ?? 180) - (row.vigor ?? 0));
    const target = Math.max(short, WANT * 10);

    let spent = 0, gained = 0, bought = [];
    for (let n = 0; n < 40 && gained < target; n++) {
      const pick = menu.find(i => i.cost <= purse - spent);
      if (!pick) break;
      await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [pick.id] }).catch(() => null);
      spent += pick.cost; gained += pick.vigor; bought.push(pick.name);
      await sleep(600);
    }
    const after = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    if (!bought.length && purse < (menu[0]?.cost ?? 0))
      return `${who}: at the counter with ${purse}sh and the cheapest food is ${menu[0].cost}sh — ` +
             'it has nothing left to sell. Selling cannot fund a character that has already ' +
             'lost everything; this one needs a hand-out';
    const tally = [...new Set(bought)].map(n => {
      const c = bought.filter(x => x === n).length;
      return c > 1 ? `${n} x${c}` : n;
    }).join(', ');
    return `${who}: purse ${before}->${purse}${lender ? ` (funded by ${lender})` : ''}, ` +
           `bought ${bought.length ? tally : 'NOTHING'} (${spent}sh, +${gained} vigor` +
           `${gained < target ? ` of ${target} wanted` : ''}) — ` +
           `pack now holds ${vigorIn(after)} vigor in ${foodIn(after)} item(s)`;
  } finally {
    // The invariant. An errand may never leave a character unattended, whatever went
    // wrong — this file exists partly because three other errands did exactly that.
    if (!DRY) {
      const back = await call('autopilot', {
        agent: row.agent, action: 'start', mode: was?.mode || 'farm',
        hunt: was?.policy?.hunt, assigned_room: was?.policy?.assignedRoom ?? null,
      }).catch(() => null);
      if (!back) console.log(`  ${who}: COULD NOT RESTART ITS KEEPER`);
    }
  }
}

// The fleet read can fail transiently while a session is mid-rejoin — the broker walks
// every session and one of them briefly has no client. Worth one retry rather than
// aborting the whole errand over a race that resolves itself in a second.
let f = null;
for (let i = 0; i < 3 && !f; i++) {
  f = await call('fleet', {}).catch(async (e) => {
    console.log(`  (fleet read failed: ${e.message.slice(0, 60)} — retrying)`);
    await sleep(2500); return null;
  });
}
if (!f) { console.error('could not read the fleet'); process.exit(1); }
const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;
const rows = (f.fleet || [])
  .filter(r => r.in_game !== false)
  .filter(r => (only ? only.includes(r.agent) : (r.vigor ?? 200) < HUNGRY_BELOW && !r.has_food));

console.log(`${rows.length} character(s) below ${HUNGRY_BELOW} vigor with no food${DRY ? ' (dry run)' : ''}`);
for (const row of rows) {
  try { console.log('  ' + await feed(row)); }
  catch (e) { console.log(`  ${row.character || row.agent}: ${e.message}`); }
}
