#!/usr/bin/env node
// GET THE FLEET ARMED AND ARMOURED, and pay for it out of the bank.
//
//   node tools/m59-outfit.mjs                      # everyone who is short of something
//   node tools/m59-outfit.mjs --agents t1,t2       # just these
//   node tools/m59-outfit.mjs --at 201             # shop here rather than the nearest
//   node tools/m59-outfit.mjs --withdraw 1000      # how much to take out per character
//   node tools/m59-outfit.mjs --dry-run            # say what it would buy and stop
//
// WHY THIS EXISTS AS A TRIP RATHER THAN A KEEPER RULE. Buying is several minutes of
// walking, a shop, and a bank, and the keeper's pass is eight seconds long — so this
// stops the keeper, does the errand, and puts the orders back exactly as they were.
// Anything that drives a character has to be serialised against everything else that
// drives one, or two loops walk the same character to two different towns.
//
// BUYING ORDER IS DEFENCE FIRST. A weapon changes how fast something dies; armour
// changes whether you are still standing when it does. See m59-skills.mjs ARMOUR for
// why leather outranks plate here rather than being the cheap option.
//
// EACH TOWN KEEPS A SEPARATE BANK ACCOUNT (holder.kod:828 relays the request to
// whatever is in the room). Money paid in at Tos is not available in Marion. So the
// withdrawal is attempted where the character already is, and a character whose money
// is in another town is reported rather than silently left broke — with `--from-mate`
// a partner standing there can cover it instead.
import { readFileSync } from 'node:fs';

const arg = (name, def = null) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const URL = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const AT = arg('at', null) == null ? null : Number(arg('at'));
const WITHDRAW = Number(arg('withdraw', 1000));
const ONLY = arg('agents', null);
const FROM_MATE = !!arg('from-mate', false);

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(URL, {
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

// WHAT A CHARACTER GOING TO THE VALLEY NEEDS. One line each so the list is the
// argument: a mace because these characters' proficiency is in mace fighting, leather
// because it is the only armour with positive defence and no spell penalty, a shield
// because it is the cheapest defence in the game at 160.
const WANTS = [
  { slot: 'armour', re: /leather (armor|armour)/i,  fallback: /armor|armour|mail/i, what: 'leather armour' },
  { slot: 'shield', re: /metal shield/i,            fallback: /shield/i,            what: 'a shield' },
  { slot: 'weapon', re: /\bmace\b/i,                fallback: /sword|axe|hammer|mace/i, what: 'a mace' },
];

const nameOf = (i) => String(i?.name ?? i ?? '');
const carries = (items, re) => items.some(i => re.test(nameOf(i)));
const purseOf = (items) => items.filter(i => /shilling/i.test(nameOf(i)))
                                .reduce((t, i) => t + (i.amount || 1), 0);

// What is this character missing? Read the PACK for what it owns; wearing is a
// separate question and wear_best answers it afterwards.
function missingFor(items) {
  return WANTS.filter(w => !carries(items, w.re) && !carries(items, w.fallback));
}

async function outfit(row) {
  const who = row.character || row.agent;
  const inv0 = await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }));
  let items = inv0.items || [];
  const missing = missingFor(items);
  if (!missing.length) {
    // Owning is not wearing. Even a fully-stocked character is worth a wear_best.
    if (!DRY) {
      const w = await call('wear_best', { agent: row.agent }).catch(() => null);
      await call('equip_best', { agent: row.agent }).catch(() => null);
      if (w?.worn?.length) return `${who}: already stocked — put on ${w.worn.map(x => x.name).join(', ')}`;
    }
    return `${who}: already stocked`;
  }
  if (DRY) return `${who}: would buy ${missing.map(m => m.what).join(', ')}`;

  // Stop the keeper, and remember EXACTLY what it was running so the errand cannot
  // quietly re-write a character's orders. Restored in the finally below.
  const was = await call('autopilot', { agent: row.agent, action: 'status' }).catch(() => null);
  await call('autopilot', { agent: row.agent, action: 'stop' }).catch(() => {});
  const log = [];
  try {
    // Where to shop. An explicit room wins; otherwise ask which merchants sell what we
    // lack and take the fewest hops, which is the same question gear-buying always is.
    let shopRoom = AT;
    let candidates = AT != null ? [AT] : [];
    if (shopRoom == null) {
      const seen = new Map();
      for (const what of ['armor', 'shield', 'mace']) {
        const m = await call('merchants', { agent: row.agent, sells: what }).catch(() => ({ matches: [] }));
        for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
      }
      // A WANDERING MERCHANT IS NOT A DESTINATION.
      //
      // The index records where a merchant was SEEN, which is the right thing for the
      // stationary ones — every other NPC in this game stays put — and completely wrong
      // for the six the game files keep under `monster/towns/wanderer/`: DarkWizard,
      // Heretic, HunterGhost, Izzio, JealousGeneral and Minstrel, each declared `is
      // Wanderer`.
      //
      // Izzio is the one that matters, because he is the only wanderer that sells gear —
      // leather armour, a metal shield, a long sword — and he circulates between Lake of
      // Jala's Song, the Main Gate of Barloque, the King's Way, the Temple of Shal'ille
      // and West Merchant Way through Ilerian Woods. He was last seen at 593, so that is
      // where the errand went, and the log filled with "nobody here sells anything (room
      // 593)" — a true statement about an empty gate, walked to on purpose.
      //
      // So wanderers go LAST rather than being dropped. Walking to where one was last
      // standing is a coin toss, which is why it must not be the first choice — but it
      // is not worthless, and for SKILLS there is sometimes no other seller in the game.
      // A coin toss beats no option at all.
      //
      // The per-candidate check below already handles him not being there: reaching a
      // room and finding nobody who sells is treated exactly like failing to reach it,
      // and the loop moves on. So a wanderer at the end of the list costs one wasted
      // trip in the worst case and buys the only source of a skill in the best.
      const WANDERERS = new Set(['DarkWizard', 'Heretic', 'HunterGhost',
                                 'Izzio', 'JealousGeneral', 'Minstrel']);
      const isWanderer = x => WANDERERS.has(String(x?.merchant ?? x?.cls ?? x?.class ?? ''));

      const priceAll = async (list) => {
        const out = [];
        for (const m of list) {
          const rt = await call('map', { agent: row.agent, to: m.room }).catch(() => null);
          if (rt?.route?.found) out.push({ room: m.room, hops: rt.route.hops.length, roams: isWanderer(m) });
        }
        return out.sort((a, b) => a.hops - b.hops);
      };
      const settled = await priceAll([...seen.values()].filter(x => !isWanderer(x)));
      const roaming = await priceAll([...seen.values()].filter(isWanderer));
      const priced = [...settled, ...roaming];       // stationary first, always

      if (!priced.length) return `${who}: no smith reachable`;
      if (!settled.length)
        log.push('no stationary seller reachable — trying a wanderer, which may not be there');
      candidates = priced.map(p => p.room);
      shopRoom = candidates[0];
    }

    // TRAVEL IS FLAKY IN THE MIDDLE AND RESUMABLE, so retry rather than give up: a
    // multi-hop route fails part-way with "start is outside the room grid" when the
    // character's position has not settled after an edge crossing, and the next
    // attempt continues from wherever it actually got to.
    // AND IF THAT SHOP CANNOT BE REACHED, TRY THE NEXT ONE.
    //
    // Picking the nearest smith and giving up on it is how the supervisor spent cycle
    // after cycle walking characters to Marion and failing at the same refused exit:
    //
    //   Bunsen: could not reach room 201 — Marion -> Ye Olde Slasher Salesman:
    //           You are unable to go anywhere.
    //
    // Every ninety seconds, for both members of a pair, with nothing learned between
    // attempts. Nearest is a preference and not a requirement — a shop three rooms
    // further away that can actually be entered is strictly better than one next door
    // that refuses, and `priced` is already sorted, so the next candidate is free.
    // ARRIVING IS NOT THE SAME AS FINDING A SHOPKEEPER, and treating them as the same
    // is why outfitting quietly did nothing about half the time.
    //
    // The candidate list comes from the merchant index, which records where a merchant
    // was SEEN. Izzio really is recorded at 593 selling leather armour and a shield —
    // and a character sent there was told "nobody here sells anything (room 593)" and
    // the whole errand ended, on the first candidate, with two more in the list unread.
    //
    // A shop we reached but cannot buy in is worth exactly what a shop we could not
    // reach is worth, and the loop already knows what to do with the second: try the
    // next one. This says so for the first as well.
    let arrived = false, lastWhy = null, tried = [], seller = null;
    for (const room of (candidates.length ? candidates : [shopRoom]).slice(0, 3)) {
      shopRoom = room;
      let here = false;
      for (let i = 0; i < 3 && !here; i++) {
        const t = await call('travel', { agent: row.agent, to: shopRoom, max_hops: 20 })
                        .catch(e => ({ arrived: false, why: e.message }));
        if (t.arrived) { here = true; break; }
        const stuck = (t.log || []).filter(h => !h.ok).slice(-1)[0];
        lastWhy = stuck ? `${stuck.from} -> ${stuck.to}: ${stuck.also_tried?.[0]?.why ?? 'refused'}`
                        : (t.why || 'travel refused');
        const st = await call('status', { agent: row.agent, brief: true }).catch(() => null);
        if (st?.where?.num === shopRoom) { here = true; break; }
        await sleep(1500);
      }
      if (!here) { tried.push(`${room} (${lastWhy})`); continue; }

      // A FAILED READ IS NOT AN EMPTY ROOM. This caught the error and substituted
      // `{objects: []}`, which is indistinguishable from a room with no merchant in it
      // — so a timed-out look reported the shop as empty and the character walked away
      // from a shopkeeper it was standing next to.
      const seen = await call('look', { agent: row.agent }).catch(e => ({ error: e.message }));
      if (seen.error) {
        tried.push(`${room} (could not read the room: ${seen.error})`);
        continue;
      }
      seller = (seen.objects || []).find(o => (o.can || []).includes('buy'));
      if (!seller) {
        // SAY WHAT WAS ACTUALLY THERE. "nobody here sells anything" is unfalsifiable
        // from a log — it cannot be told apart from a bad room read, a merchant that
        // moved, or an affordance we failed to derive. The contents make it debuggable.
        const what = (seen.objects || []).map(o => o.name).filter(Boolean).slice(0, 8);
        tried.push(`${room} (reached it; ${what.length ? 'saw ' + what.join(', ') : 'room read as empty'})`);
        continue;
      }

      // WALK TO THE SHOPKEEPER BEFORE TRADING WITH IT.
      //
      // Nothing in UserBuy or GetForSale (monster.kod:4818) checks distance, so buying
      // does not strictly need this — but every NPC in this game is stationary, so
      // standing next to one costs a couple of seconds and removes a whole class of
      // "it should have worked" from the log. It is also simply what a player does, and
      // the offer/trade paths are less forgiving than the buy path.
      //
      // Failure here is not fatal: if the walk is refused we are still in the room with
      // the merchant, which is where the old code traded from anyway.
      if (seller.col != null && seller.row != null) {
        const w = await call('walk_to', { agent: row.agent, col: seller.col, row: seller.row })
                        .catch(e => ({ arrived: false, why: e.message }));
        // ARRIVING IS THE WRONG TEST HERE. The merchant is STANDING on the square we
        // aimed at, so the last step is refused and walk_to honestly reports
        // arrived:false — while we are in fact standing next to it, which is the thing
        // we wanted. Measure the distance instead of believing the flag, or the log
        // fills with failures that are successes.
        const at = w?.position ?? null;
        const gap = at ? Math.max(Math.abs(at.col - seller.col), Math.abs(at.row - seller.row)) : null;
        const name = seller.name ?? 'the merchant';
        log.push(gap != null && gap <= 1 ? `standing with ${name}`
               : gap != null            ? `${gap} squares from ${name} — trading from here`
                                        : `could not walk to ${name} (${w?.reason ?? w?.why ?? 'refused'}) — trading from here`);
      }
      arrived = true;
      break;
    }
    if (!arrived) return `${who}: no smith worked out — tried ${tried.join('; ')}`;
    log.push(`at ${shopRoom}`);

    // FUND IT. The purse first, then the bank we are standing next to, then a partner.
    items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    let money = purseOf(items);
    if (money < WITHDRAW / 2) {
      const b = await call('bank', { agent: row.agent, action: 'withdraw', amount: WITHDRAW })
                      .catch(e => ({ error: e.message }));
      if (b?.balance != null || /shilling/i.test(String(b?.said ?? ''))) {
        await sleep(800);
        items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
        const now = purseOf(items);
        if (now > money) { log.push(`withdrew ${now - money}sh`); money = now; }
      } else if (b?.error) {
        // Not a failure worth stopping for: there may be no bank in this room, or the
        // account may be in another town. Say which, and carry on with what we carry.
        log.push('no withdrawal here (each town banks separately)');
      }
    }

    // Sell what we are carrying if that is what it takes. A character that has been
    // farming carries reagents and drops worth more than the armour costs.
    // `seller` was found above, as part of deciding this shop was worth stopping at.
    if (money < 400) {
      const sold = await call('sell_all', { agent: row.agent, merchant: seller.id,
        keep: ['flask', 'mace', 'sword', 'axe', 'hammer', 'armor', 'armour', 'shield', 'helm'] })
        .catch(() => null);
      if (sold?.total_received) { money += sold.total_received; log.push(`sold for ${sold.total_received}sh`); }
    }

    const shop = await call('shop', { agent: row.agent, seller: seller.id }).catch(() => ({}));
    const stock = shop.items || [];
    for (const w of missing) {
      // Prefer the exact thing asked for; fall back to the same slot if the shop has
      // no leather but does have something wearable.
      const pick = (re) => stock.filter(i => re.test(nameOf(i)))
                                .sort((a, b) => (a.cost ?? a.price ?? 9e9) - (b.cost ?? b.price ?? 9e9))[0];
      const opt = pick(w.re) || pick(w.fallback);
      if (!opt) { log.push(`${w.what}: not sold here`); continue; }
      const cost = opt.cost ?? opt.price ?? 0;
      if (cost > money) { log.push(`${w.what}: ${cost}sh, only ${money}sh`); continue; }
      await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [opt.id] }).catch(() => null);
      money -= cost;
      log.push(`bought ${nameOf(opt)} @${cost}`);
    }

    // WEAR IT. Buying without equipping is the same as not buying — and the shop
    // replies before the server has finished moving the goods, so an immediate read
    // reports the state from BEFORE the trade and every character comes back "still
    // missing armour" while carrying what it just paid for.
    await sleep(1500);
    const worn = await call('wear_best', { agent: row.agent }).catch(() => null);
    const held = await call('equip_best', { agent: row.agent }).catch(() => null);
    if (worn?.worn?.length) log.push('wearing ' + worn.worn.map(x => x.name).join(', '));
    if (held?.wielding) log.push('wielding ' + held.wielding);

    items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    const still = missingFor(items).map(w => w.what);
    return `${who}: ${log.join(', ')}` + (still.length ? ` — STILL MISSING ${still.join(', ')}` : '');
  } finally {
    // Put the orders back exactly as they were, including the strategy and the room
    // assignment — an errand must not become a re-tasking.
    if (was?.running) {
      await call('autopilot', {
        agent: row.agent, action: 'start', mode: was.mode, hunt: was.policy?.hunt,
        strategy: was.policy?.strategy, flee_below: was.policy?.fleeBelow,
        rest_below: was.policy?.restBelow, max_carry: was.policy?.maxCarry,
        roam: was.policy?.roam, assigned_room: was.policy?.assignedRoom ?? null,
      }).catch(() => {});
    }
  }
}

const f = await call('fleet', {});
let rows = (f.fleet || []).filter(r => r.in_game !== false);
if (ONLY && ONLY !== true) {
  const want = new Set(String(ONLY).split(',').map(x => x.trim()));
  rows = rows.filter(r => want.has(r.agent) || want.has(r.character));
}
console.log(`outfitting ${rows.length} character(s)${DRY ? ' (dry run)' : ''}` +
            (AT ? ` at room ${AT}` : ' at the nearest smith'));

// In small batches: each of these walks a character across the world, and running the
// whole fleet at once makes the broker's pacer the bottleneck for everything else.
const BATCH = 4;
for (let i = 0; i < rows.length; i += BATCH) {
  const res = await Promise.all(rows.slice(i, i + BATCH).map(r =>
    outfit(r).catch(e => `${r.character || r.agent}: FAILED ${e.message}`)));
  res.forEach(x => console.log('  ' + x));
}
process.exit(0);
