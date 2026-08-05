#!/usr/bin/env node
// m59-rearm.mjs — give the fleet's spare weapons to the characters holding none.
//
//   node tools/m59-rearm.mjs                  # who is unarmed, who can spare one (dry)
//   node tools/m59-rearm.mjs --go             # actually hand them out
//   node tools/m59-rearm.mjs --go --agents t1,t16
//
// WHY THIS EXISTS.
//
// `create weapon` makes a TEMPORARY weapon. The spell attaches IA_MADE with
// timer_duration = spellPower * 2 minutes (creaweap.kod:123-125), so at this fleet's
// spellpower a conjured mace lasts well under an hour and then simply vanishes. A
// character that armed itself that way is unarmed again a few passes later, and an
// unarmed character does not error — UserAttack falls back to a punch, so it stands in a
// monster room hitting things for nothing while every reading says it is hunting.
//
// Re-casting is not a reliable answer either: the spell costs 15 mana, and the
// characters that keep losing weapons are the ones fighting hardest, so they are
// repeatedly found at 10 or 11 mana with nothing to swing.
//
// Meanwhile the fleet hoards. Looted maces accumulate in whoever killed the thing:
// Robin and Zoot were each carrying five while Kermit, Floyd and Scooter fought with
// their fists. A permanent mace in the right pack is worth more than three casts.
//
// This does not buy anything and does not create anything. It moves what the fleet
// already owns.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const GO = !!arg('go', false);
const ONLY = arg('agents', null);
// WHAT TO MOVE. The fleet hoards every resource the same way — whoever killed the thing
// keeps it — so weapons and reagents are the same errand with a different filter.
//
// Reagents matter for the same reason weapons do and are missed for the same reason:
// `create food` consumes 2 elderberry and 2 herbs and REFUSES SILENTLY without them, so a
// character with none cannot get past the resting cap of 80 and fights permanently tired.
// The `quartermaster` tool already evens them out, but only between characters standing
// in the SAME ROOM — and with the fleet spread that left sixteen characters on 0/0 while
// Fozzie carried sixty elderberry at full vigor. The walk is worth it now: 80 vigor is a
// six-fold death rate and produces nothing to justify it.
const WHAT = String(arg('what', 'weapons'));
// Buy a weapon when the fleet has none spare. Off unless asked, because it spends money.
const BUY = !!arg('buy', false);
const REAGENT = /elder\s*berry|elderberry|herbs?/i;
const WANT_REAGENTS = Number(arg('want', 6));

let id = 0;
// Long by default: `supply` walks a character across rooms and that is minutes, not
// seconds. A client-side timeout here does not cancel the errand — it abandons it
// mid-flight with a keeper still stopped, which is how three of these were lost before.
async function call(name, args = {}, timeoutMs = 600_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    const text = j.result?.content?.[0]?.text;
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const skills = await import('./m59-skills.mjs');

// Spend the donor's stock, and retire a stack only when what is left cannot cover
// another delivery. Shifting the whole stack after one handover let a donor holding
// sixty elderberry supply exactly one character.
function drawDown(donor, carried) {
  for (const sp of carried) {
    const amount = sp.give ?? 1;
    if (sp.remaining != null) {
      sp.remaining -= amount;
      if (sp.remaining >= amount) continue;
    }
    const i = donor.spare.indexOf(sp);
    if (i >= 0) donor.spare.splice(i, 1);
  }
}

// BUY ONE, WHEN THE FLEET HAS NONE TO LEND.
//
// Conjured weapons expire — IA_MADE, spellPower*2 minutes — and looted maces stopped
// keeping up: the fleet reached zero spare weapons with three characters unarmed and
// two of them short of the 15 mana to conjure. Lending cannot solve a shortage.
//
// This is the feed tool's shop sequence, which is the only one known to work: walk with
// retries, require status and look to AGREE on the room, re-find the merchant immediately
// before buying, and judge the purchase by the purse rather than by the request.
async function buyWeaponFor(row) {
  const purseOf = items => (items || []).filter(i => /shilling/i.test(i.name))
                                        .reduce((t, i) => t + (i.amount || 1), 0);
  const inv0 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
  const purse0 = purseOf(inv0.items);
  if (purse0 < 100) return `${row.character}: only ${purse0}sh — a weapon costs more than that`;

  const seen = new Map();
  for (const what of ['mace', 'short sword', 'sword']) {
    const m = await call('merchants', { agent: row.agent, sells: what }, 60_000).catch(() => ({ matches: [] }));
    for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
  }
  const priced = [];
  for (const room of seen.keys()) {
    const rt = await call('map', { agent: row.agent, to: room }, 60_000).catch(() => null);
    if (rt?.route?.found) priced.push({ room, hops: rt.route.hops.length });
  }
  priced.sort((a, b) => a.hops - b.hops);
  if (!priced.length) return `${row.character}: no reachable smith`;

  const where = async () => {
    const st = await call('status', { agent: row.agent, brief: true }, 60_000).catch(() => null);
    return st?.where?.num ?? null;
  };
  for (const cand of priced.slice(0, 3)) {
    let at = await where(), stuck = 0;
    for (let i = 0; i < 8 && at !== cand.room && stuck < 2; i++) {
      await call('travel', { agent: row.agent, to: cand.room, max_hops: 20 }).catch(() => ({}));
      const now = await where();
      if (now === cand.room) { at = now; break; }
      if (now === at) stuck++; else { stuck = 0; at = now; }
      await sleep(1200);
    }
    if (at !== cand.room) continue;

    let smith = null;
    for (let look = 0; look < 4 && !smith; look++) {
      if (look) await sleep(1500);
      const here = await where();
      const seenRoom = await call('look', { agent: row.agent }, 60_000).catch(() => ({ objects: [] }));
      if (seenRoom.room?.num !== here) continue;
      smith = (seenRoom.objects || []).find(o => (o.can || []).includes('buy'));
    }
    if (!smith) continue;

    const shop = await call('shop', { agent: row.agent, seller: smith.id }, 60_000).catch(() => null);
    const menu = (shop?.items || []).filter(i => skills.weaponScore(i.name) > 0 && (i.cost ?? 0) > 0)
                                    .sort((a, b) => skills.weaponScore(b.name) - skills.weaponScore(a.name)
                                                 || a.cost - b.cost);
    const pick = menu.find(i => i.cost <= purse0);
    if (!pick) continue;
    await call('shop', { agent: row.agent, seller: smith.id, buy_ids: [pick.id] }).catch(() => null);
    await sleep(1500);
    const inv1 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
    const purse1 = purseOf(inv1.items);
    if (purse1 >= purse0)
      return `${row.character}: the smith at ${cand.room} took nothing for a ${pick.name} at ${pick.cost}sh`;
    let eq = null;
    for (let i = 0; i < 3 && !eq?.wielding; i++) {
      await sleep(1800);
      eq = await call('equip_best', { agent: row.agent }, 60_000).catch(() => null);
    }
    return `${row.character}: bought a ${pick.name} for ${purse0 - purse1}sh at room ${cand.room} — ` +
           `now wielding ${JSON.stringify(eq?.wielding ?? null)}${eq?.verified ? ' (verified)' : ''}`;
  }
  // SAY WHICH IT WAS. "Could not reach a smith that had a weapon it could afford" covers
  // three different failures — no route, a walk that fell short, and a price out of reach
  // — and reading it as the last one sent me looking at weapon prices for a pass. It is
  // the walk: smiths are seven hops out where food shops are one to five, and only one
  // smith is routable from most of the fleet's ground at all.
  return `${row.character}: never got to a smith. ${priced.length} routable ` +
         `(${priced.slice(0, 3).map(p => `${p.room} at ${p.hops} hops`).join(', ')}), ` +
         'and the walk did not finish. This is a distance problem, not a price one — ' +
         'weapon base values inherit the Item default of 10 and every smith stocks a mace.';
}

async function main() {
  const f = await call('fleet', {}, 120_000);
  const rows = (f.fleet || []).filter(r => r.character);
  if (!rows.length) { console.log('no characters in game'); return; }

  const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;

  // WHAT IS IN EACH PACK. `wielding` comes from the server's use list, which is the only
  // authority on what is actually held — the pack is a different question and the two
  // come apart constantly.
  const packs = new Map();
  for (const r of rows) {
    const inv = await call('inventory', { agent: r.agent }, 60_000).catch(() => ({ items: [] }));
    packs.set(r.agent, inv.items || []);
  }

  // A CHARACTER IN THE UNDERWORLD IS DEAD AND CANNOT BE ROUTED.
  //
  // Room 1 is where the dead wake up, and nothing routes out of it — the way out is a
  // portal rather than an edge, so the pathfinder answers "no route from 1 to 575" and
  // the errand spends a whole sequence of walk attempts learning that. Camilla cost one
  // exactly that way. It will be back in the world under its own keeper within a minute
  // or two, so skip it and let a later pass catch it. A donor in there has already
  // dropped everything it was carrying, so it is no use either.
  const UNDERWORLD = 1;
  const inTheWorld = r => (r.room_num ?? r.r?.room_num) !== UNDERWORLD;

  const isReagents = /^reagent/i.test(WHAT);
  const countOf = (items, re) => items.filter(i => re.test(i.name)).reduce((t, i) => t + (i.amount || 1), 0);

  let unarmed, donors, noun;
  if (isReagents) {
    noun = 'reagent';
    // A character needs BOTH kinds; short of either it cannot cast at all. Rank the
    // needy by who has least, so the first walk buys the most.
    unarmed = rows.filter(inTheWorld).map(r => ({ ...r, eb: countOf(packs.get(r.agent) || [], /elder/i),
                                     hb: countOf(packs.get(r.agent) || [], /herbs?/i) }))
                  .filter(r => Math.min(r.eb, r.hb) < 2 && (r.eb + r.hb) < WANT_REAGENTS * 2)
                  .filter(r => !only || only.includes(r.agent))
                  .sort((a, b) => (a.eb + a.hb) - (b.eb + b.hb));
    // A donor keeps enough for its own three castings before it gives any away.
    donors = rows.filter(inTheWorld).map(r => {
      const items = packs.get(r.agent) || [];
      const spare = [];
      // `remaining` rather than one entry per kind. A donor holding sixty elderberry can
      // supply ten characters, but shifting the whole stack away after the first handover
      // let it supply exactly one — and the dry run, which never shifts, cheerfully
      // planned nine deliveries from a donor that could make one.
      for (const re of [/elder/i, /herbs?/i]) {
        const held = items.filter(i => re.test(i.name));
        const total = countOf(items, re);
        if (total > WANT_REAGENTS && held[0])
          spare.push({ ...held[0], give: WANT_REAGENTS, remaining: total - WANT_REAGENTS });
      }
      return { r, spare };
    }).filter(d => d.spare.length > 0);
  } else {
    noun = 'weapon';
    for (const [k, items] of packs)
      packs.set(k, items.filter(i => skills.weaponScore(i.name) > 0)
                        .sort((a, b) => skills.weaponScore(b.name) - skills.weaponScore(a.name)));
    // NOT WIELDING IS THE TEST. A pack with weapons in it does not make a character
    // armed: brokenness lives on the server (piHits <= 0) and the name never changes, so
    // a pack can be full of maces that every wield attempt refuses. Kermit was carrying
    // one and fighting bare-handed — "You can't use the mace--it's broken" — and this
    // tool skipped it because the pack was not empty. The server's use list is the only
    // authority on what is actually held, and a spare mace is cheap insurance against
    // being wrong.
    unarmed = rows.filter(r => !r.wielding).filter(inTheWorld)
                  .filter(r => !only || only.includes(r.agent));
    // A donor keeps the one it is using plus one in reserve — a fleet that strips its
    // fighters bare to arm the idle has not gained anything.
    donors = rows.filter(inTheWorld).map(r => ({ r, spare: (packs.get(r.agent) || []).slice(r.wielding ? 1 : 2) }))
                 .filter(d => d.spare.length > 0);
  }

  console.log(`${unarmed.length} short of ${noun}s; ` +
              `${donors.reduce((t, d) => t + d.spare.length, 0)} spare ${noun} stack(s) across ${donors.length} character(s)`);
  if (!unarmed.length) return;

  for (const need of unarmed) {
    // Nearest by ROUTE, because the donor has to walk it — room numbers are not distance.
    const routed = [];
    for (const d of donors) {
      if (!d.spare.length || d.r.agent === need.agent) continue;
      if (d.r.room_num === need.room_num) { routed.push({ d, hops: 0 }); continue; }
      const m = await call('map', { agent: d.r.agent, to: need.room_num }, 60_000).catch(() => null);
      if (m?.route?.found) routed.push({ d, hops: m.route.hops.length });
    }
    routed.sort((a, b) => a.hops - b.hops);
    const pick = routed[0];
    if (!pick) {
      // Nobody has one to give. Buy it — the fleet has money and the shops work now.
      if (BUY && !isReagents && GO) { console.log('  ' + await buyWeaponFor(need)); continue; }
      // SAY WHICH FLAG IS ACTUALLY MISSING. This told me to pass --buy while I was
      // passing --buy: the purchase needs --go as well, and the advice was a constant
      // string that could not know what had been asked for. An instruction that is
      // wrong about the command you just ran costs more than no instruction.
      console.log(`  ${need.character}: no donor can reach it` +
                  (isReagents ? ''
                   : BUY && !GO ? ' (--buy is set but this is a dry run — add --go to purchase)'
                   : !BUY ? ' (pass --buy --go to purchase one instead)'
                   : ''));
      continue;
    }
    // BOTH KINDS IN ONE WALK. `create food` consumes 2 elderberry AND 2 herbs and refuses
    // silently short of either, so delivering elderberry alone buys the recipient nothing
    // and costs the donor the same trip. supply() takes a list; use it.
    const carry = isReagents
      ? pick.d.spare.filter(sp => {
          const short = /elder/i.test(sp.name) ? (need.eb ?? 0) : (need.hb ?? 0);
          return short < WANT_REAGENTS;
        })
      : [pick.d.spare[0]].filter(Boolean);
    if (!carry.length) { console.log(`  ${need.character}: donor has nothing it is short of`); continue; }
    const give = carry[0];
    const amount = give.give ?? 1;
    if (!GO) {
      console.log(`  ${need.character} <- ${pick.d.r.character} (${pick.hops} hops): ` +
                  carry.map(sp => `${(sp.give ?? 1) > 1 ? (sp.give ?? 1) + ' x ' : ''}${sp.name}`).join(' + '));
      // Draw it down here too. A plan that does not spend its own stock is not a plan —
      // it listed nine deliveries from a donor that could make one.
      drawDown(pick.d, carry);
      continue;
    }
    // RE-READ THE DONOR BEFORE HANDING ANYTHING OVER.
    //
    // The plan is built from one scan of every pack, and by the time a walk finishes the
    // world has moved: object ids are renumbered by a `save game`, and a character that
    // dies drops its whole pack. Fozzie was planned as the donor for six deliveries,
    // died somewhere in the middle, and every remaining handover came back "carrying
    // nothing matching those ids" — six walks spent on a pack that no longer existed.
    const fresh = await call('inventory', { agent: pick.d.r.agent }, 60_000).catch(() => null);
    if (fresh) {
      const byName = new Map();
      for (const i of fresh.items || []) if (!byName.has(i.name)) byName.set(i.name, i);
      const still = carry.map(sp => { const now = byName.get(sp.name); return now ? { ...sp, id: now.id } : null; })
                         .filter(Boolean);
      if (!still.length) {
        console.log(`  ${need.character} <- ${pick.d.r.character}: donor no longer has it ` +
                    '(pack changed since the plan — most likely it died)');
        pick.d.spare.length = 0;
        continue;
      }
      carry.length = 0; carry.push(...still);
    }
    // supply() holds BOTH keepers for the whole exchange and restores them itself. Do not
    // stop them here as well: the errand that does the walking owns that invariant, and
    // two owners is how a character ends up unattended.
    // THE ONE WHO NEEDS IT DOES THE WALKING.
    //
    // This sent the DONOR, and that is backwards twice over. The donor is the character
    // with something worth keeping, and walking it out of wherever it was safe is how the
    // fleet lost its capital: Robin walked with 70 elderberry and died, Lew with 42 and
    // 152 herbs and died, and each time the whole stock hit the floor along with the plan
    // built around it. The recipient has nothing to lose by walking — that is what makes
    // it the recipient.
    //
    // It also gives the walk a stationary destination. A donor chasing a keeper-driven
    // recipient is chasing a moving target, which is most of why these failed; a
    // recipient walking to a character holding a safe spot is walking to a fixed point.
    //
    // First run with the direction reversed: three transfers, three successes, after an
    // unbroken run of failures the other way. Waldorf went 80 to 108 vigor and Clifford
    // 80 to 118, and the donor kept its spot and 14 elderberry.
    const r = await call('supply', { from: pick.d.r.agent, to: need.agent,
                                     what: carry.map(sp => ({ id: sp.id, amount: sp.give ?? 1 })),
                                     who_travels: 'to' })
                    .catch(e => ({ supplied: false, reason: e.message }));
    if (!r?.supplied) {
      // A FAILED HANDOVER IS NOT THE SAME AS A CHARACTER STILL EMPTY-HANDED. Its own
      // keeper may have conjured one meanwhile, and saying "FAILED" about a character
      // that is now armed reads as a problem to chase. Ask the server before deciding.
      // Only ask this in weapons mode — "its keeper armed it" is meaningless about a
      // reagent delivery, and it printed there anyway, which reads as success.
      const eq = isReagents ? null : await call('equipment', { agent: need.agent }, 60_000).catch(() => null);
      const armedAnyway = eq?.wielding ?? null;
      console.log(`  ${need.character} <- ${pick.d.r.character}: handover failed — ` +
                  `${String(r?.reason || 'no reason given').slice(0, 90)}` +
                  (armedAnyway ? ` (but it is wielding ${JSON.stringify(armedAnyway)} now — its keeper ` +
                                 'armed it, so this is not an unarmed character)'
                               : isReagents ? '' : ' (still empty-handed)'));
      continue;
    }
    drawDown(pick.d, carry);
    if (isReagents) {
      console.log(`  ${need.character} <- ${pick.d.r.character} (${pick.hops} hops): ` +
                  carry.map(sp => `${sp.give ?? 1} x ${sp.name}`).join(' + '));
      continue;
    }
    // ASK AGAIN BEFORE CALLING IT UNVERIFIED.
    //
    // A single read 1.5s after the handover said "wielding null (UNVERIFIED)" for a
    // character that was, in fact, holding the mace — BP_USE arrives when it arrives, and
    // the equip request itself has to land first. Reporting an unverified failure that
    // actually worked is worse than reporting nothing: it sends the next pass chasing a
    // problem that is not there.
    let eq = null;
    for (let i = 0; i < 3 && !eq?.wielding; i++) {
      await sleep(2000);
      eq = await call('equip_best', { agent: need.agent }, 90_000).catch(() => null);
    }
    console.log(`  ${need.character} <- ${pick.d.r.character} (${pick.hops} hops): ${give.name} — ` +
                `now wielding ${JSON.stringify(eq?.wielding ?? null)}` +
                `${eq?.verified ? ' (verified against the server use list)' : ' (UNVERIFIED)'}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
