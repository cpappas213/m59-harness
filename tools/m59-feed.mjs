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
const isFood = (n) => !!ITEMS?.food?.[String(n || '').trim().toLowerCase()];

// Never sell these. Money, gems (worth more than the trip), reagents the creation
// spells need, and anything being worn — sell_all's own keep list covers equipment, but
// naming the reagents matters because they are the OTHER route to food.
const KEEP = ['shilling', 'elderberry', 'herb', 'diamond', 'ruby', 'emerald', 'sapphire',
              'armor', 'armour', 'shield', 'helm', 'mace', 'sword', 'axe', 'hammer'];

const purseOf = items => (items || []).filter(i => /shilling/i.test(i.name))
                                      .reduce((t, i) => t + (i.amount || 1), 0);
const foodIn = items => (items || []).filter(i => isFood(i.name))
                                     .reduce((t, i) => t + (i.amount || 1), 0);

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

    let arrived = false, tried = [];
    for (const room of shops.slice(0, 3)) {
      for (let i = 0; i < 3 && !arrived; i++) {
        const t = await call('travel', { agent: row.agent, to: room, max_hops: 20 })
                        .catch(e => ({ arrived: false, why: e.message }));
        if (t.arrived) { arrived = room; break; }
        const st = await call('status', { agent: row.agent, brief: true }).catch(() => null);
        if (st?.where?.num === room) { arrived = room; break; }
        await sleep(1200);
      }
      if (arrived) break;
      tried.push(room);
    }
    if (!arrived) return `${who}: could not reach a food shop (tried ${tried.join(', ')})`;

    const look = await call('look', { agent: row.agent }).catch(() => ({ objects: [] }));
    const seller = (look.objects || []).find(o => (o.can || []).includes('buy'));
    if (!seller) return `${who}: reached room ${arrived} but nobody here trades`;

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
    const purse = purseOf(inv);

    // A FAILED SHOP CALL IS NOT AN EMPTY SHOP, and reporting it as one sent me looking
    // at the wrong thing: room 103 plainly sells bread at 108 and apples at 45, and the
    // message said it sold no food.
    let shop = null, shopErr = null;
    try { shop = await call('shop', { agent: row.agent, seller: seller.id }); }
    catch (e) { shopErr = e.message; }
    if (!shop) return `${who}: could not open the shop at ${arrived} — ${shopErr ?? 'no reply'}`;
    const menu = (shop.items || []).filter(i => isFood(i.name) && (i.cost ?? 0) > 0)
                                   .sort((a, b) => a.cost - b.cost);
    if (!menu.length)
      return `${who}: room ${arrived} stocks ${(shop.items || []).length} item(s), none of them food`;

    let spent = 0, bought = [];
    for (let n = 0; n < WANT; n++) {
      const pick = menu.find(i => i.cost <= purse - spent);
      if (!pick) break;
      await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [pick.id] }).catch(() => null);
      spent += pick.cost; bought.push(pick.name);
      await sleep(600);
    }
    const after = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    if (!bought.length && purse < (menu[0]?.cost ?? 0))
      return `${who}: at the counter with ${purse}sh and the cheapest food is ${menu[0].cost}sh — ` +
             'it has nothing left to sell. Selling cannot fund a character that has already ' +
             'lost everything; this one needs a hand-out';
    return `${who}: purse ${before}->${purse}, bought ${bought.length ? bought.join(', ') : 'NOTHING'} ` +
           `(${spent}sh) — now carrying ${foodIn(after)} meal(s)`;
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
