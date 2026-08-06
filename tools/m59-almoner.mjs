#!/usr/bin/env node
// MOVE REAGENTS FROM THE RICH TO THE STARVING, THEN TURN THEM INTO VIGOR.
// AND MOVE SIGNET RINGS DOWNWARD, WHICH IS WORTH TEN TIMES MORE THAN ANY OF IT.
//
//   node tools/m59-almoner.mjs --dry-run
//   node tools/m59-almoner.mjs                    # hand out and set the vigor floor
//   node tools/m59-almoner.mjs --amount 10        # per reagent kind, default 10
//   node tools/m59-almoner.mjs --floor 140        # vigor to fight above afterwards
//   node tools/m59-almoner.mjs --signets-only     # just the rings
//   node tools/m59-almoner.mjs --no-signets       # just the reagents, as it used to be
//
// THE RINGS COME FIRST AND THEY ARE NOT A SIDE ERRAND. A signet ring pays its value TEN
// TIMES OVER to a character the server considers a newbie, and plain value to everyone
// else — and "newbie" is not a choice anybody here made: EvaluatePKStatus enables
// player-killing for you the moment base max health reaches 30 (player.kod:11047). Max
// health is the level here. So the same ring is worth up to 1500 shillings in the hands
// of a level-24 character and up to 150 in the hands of a level-31 one, and which of them
// is holding it is decided by whichever happened to loot it.
//
// That is exactly the almoner's job. The fleet's small characters are the ones with no
// money, no food and no floor under them, and this is the one mechanism in the game that
// pays them ten times what it pays anyone else. Redistributing rings downward and then
// sending them to be cashed is the single largest transfer available to this tool — one
// ring is worth more than every elderberry it will ever move — so it runs FIRST and it
// runs even on the passes where there is no reagent work to do.
//
// WHY THIS IS THE HIGHEST-VALUE ERRAND AVAILABLE. The fleet's food supply is not
// bought, it is CAST: `create food` turns 2 ElderBerry and 2 Herbs into a meal, and
// both drop free in the rooms these characters already hunt. A character with no
// reagents cannot cast, so it cannot eat; resting alone tops out at 80 vigor of 200,
// and everything above 80 has to come from food. So an empty pack is not a small
// inconvenience — it caps a character at the resting floor for ever.
//
// And vigor is not a comfort stat. It sets the HEALTH REGENERATION RATE:
// ((200-vigor)^2/6 + 1000) ms a point, which is 1.0 hp/s at 200 and 0.29 hp/s at 80.
// A character stuck at 80 recovers three and a half times slower than one at 200,
// between every fight, for ever. That is most of the difference between a fleet that
// grinds upward and one that dies in the same room all night.
//
// The distribution in this fleet was extreme when this was written: three characters
// held 329 ElderBerry and 670 Herbs between them, while seven had none at all — and
// every one of the seven was standing in the two rooms where the fleet was dying.
// Nothing was wrong with any of them individually. Nothing was moving the surplus.
//
// It does NOT do the trade itself: `supply` already drives both ends of a two-sided
// protocol between characters this broker holds, and verifies the receiver actually
// ended up with the goods. A half-finished trade is silent, which is exactly why that
// tool exists and why this one calls it rather than reimplementing it.
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const AMOUNT = Number(arg('amount', 10));
const FLOOR = Number(arg('floor', 140));
// Keep the giver able to feed itself: handing away the last of it just moves the
// problem. One casting is 2 of each, so this is several meals of margin.
const KEEP_BACK = Number(arg('keep', 20));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const t = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const countOf = (items, re) => (items || []).filter(i => re.test(i.name || ''))
                                            .reduce((t, i) => t + (i.amount || 1), 0);

// `fleet` throws "Cannot read properties of null (reading 'inventory')" while a
// character is between logging out and being rejoined — the session exists and its
// client does not. It is transient and clears within a rejoin cycle, but it takes the
// whole call down with it, so a run that happens to start during one gets nothing.
// (It also killed a supervisor round. Worth fixing in the fleet tool itself; retried
// here so this errand does not depend on that.)
let f = null;
for (let i = 0; i < 4 && !f; i++) {
  f = await call('fleet', {}).catch(async (e) => {
    if (i === 3) throw e;
    console.log(`  fleet unreadable (${String(e.message).slice(0, 60)}) — retrying`);
    await sleep(4000);
    return null;
  });
}
const live = (f.fleet || []).filter(x => x.in_game !== false);

// ------------------------------------------------------------------ the rings, first
//
// Three steps and each is refused cleanly when it has nothing to do, so this costs a
// single survey call on the passes — most of them — where the fleet is carrying none.
if (!arg('no-signets', false)) {
  const survey = await call('signets', { action: 'survey' }).catch(e => ({ __err: e.message }));
  if (survey.__err) {
    // A broker predating the signets tool answers "no such tool", and that must not take
    // the reagent run down with it — this errand has been the fleet's food supply for
    // months and the rings are the new part.
    console.log(`signets: ${survey.__err}`);
  } else if (!survey.rings) {
    console.log('signet rings: none in the fleet');
  } else {
    console.log(`signet rings: ${survey.rings} carried, ${survey.in_the_wrong_hands} in hands that ` +
                `would be paid a tenth`);
    for (const cr of survey.carriers)
      console.log(`  ${cr.character} (${cr.level}, ${cr.paid}) ` +
                  cr.holding.map(h => `${h.owner} -> ${h.go_to}`).join('; ') +
                  (cr.committed ? `  [busy: ${cr.committed}]` : ''));
    if (DRY) console.log('  dry run — no rings moved and nobody dispatched');
    else {
      if (survey.in_the_wrong_hands) {
        const moved = await call('signets', { action: 'redistribute' })
                            .catch(e => ({ moved: 0, __err: e.message }));
        console.log(`  redistributed ${moved.moved ?? 0}` +
                    (moved.__err ? ` (${moved.__err})` : ''));
        for (const m of moved.moved_detail ?? []) console.log(`    ${m}`);
        for (const m of moved.failed ?? []) console.log(`    could not: ${m}`);
      }
      const sent = await call('signets', { action: 'return' })
                        .catch(e => ({ dispatched: 0, __err: e.message }));
      console.log(`  dispatched ${sent.dispatched ?? 0} return errand(s)` +
                  (sent.__err ? ` (${sent.__err})` : ''));
      for (const e of sent.errands ?? [])
        console.log(`    ${e.carrier} -> ${e.to} at ${e.where} (${e.town}), paid ${e.paid}`);
      for (const s of sent.skipped ?? []) console.log(`    skipped: ${s}`);
    }
  }
  console.log('');
}
if (arg('signets-only', false)) process.exit(0);

// ------------------------------------------------------------------ then the reagents

const held = [];
for (const r of live) {
  const inv = await call('inventory', { agent: r.agent }).catch(() => ({ items: [] }));
  held.push({ agent: r.agent, character: r.character, room: r.room_num, level: r.level,
              has_food: r.has_food,
              eb: countOf(inv.items, /elder\s?berry/i), hb: countOf(inv.items, /^herbs?$/i) });
}

// A recipient is someone who cannot cast their way out: no food AND not enough
// reagents to make any. Having no food but a full pack is not a problem, it is a
// character that has not got round to cooking yet.
const CASTABLE = 2;
const needy = held.filter(h => !h.has_food && (h.eb < CASTABLE || h.hb < CASTABLE))
                  .sort((a, b) => (a.eb + a.hb) - (b.eb + b.hb));
// A donor must be able to give a full share of BOTH and still keep its own margin.
const donors = held.filter(h => h.eb >= AMOUNT + KEEP_BACK && h.hb >= AMOUNT + KEEP_BACK)
                   .sort((a, b) => (b.eb + b.hb) - (a.eb + a.hb));

console.log(`${needy.length} character(s) cannot cast create food; ${donors.length} can spare a share`);
if (!needy.length) { console.log('nothing to do'); process.exit(0); }
if (!donors.length) { console.log('nobody has a surplus — the fleet is genuinely short'); process.exit(0); }

// Give each donor a fair number of recipients rather than draining the richest one,
// and PREFER A DONOR ALREADY IN THE RECIPIENT'S ROOM — the giver travels, and a walk
// across the world through monster rooms is the expensive and failure-prone part of
// this. Somebody standing next to the person who needs it should be the one to give.
const capacity = new Map(donors.map(d => [d.agent,
  Math.max(1, Math.floor(Math.min(d.eb - KEEP_BACK, d.hb - KEEP_BACK) / AMOUNT))]));
const plan = [];
for (const n of needy) {
  // Same room first — that is a hand-over with no walk at all. Otherwise the donor
  // with the most left to give, which spreads the trips instead of sending one
  // character on eight round trips across the world: each of those is minutes of
  // walking through monster rooms, they are the part that fails, and serialising them
  // through one character means one bad route stalls every remaining delivery.
  const able = donors.filter(d => (capacity.get(d.agent) || 0) > 0);
  const pick = able.find(d => d.room === n.room)
            || able.sort((a, b) => (capacity.get(b.agent) || 0) - (capacity.get(a.agent) || 0))[0];
  if (!pick) { console.log(`  ${n.character}: nobody left with a share to give`); continue; }
  capacity.set(pick.agent, capacity.get(pick.agent) - 1);
  plan.push({ from: pick, to: n, sameRoom: pick.room === n.room });
}

for (const p of plan)
  console.log(`  ${p.from.character} -> ${p.to.character} (${AMOUNT} of each)` +
              (p.sameRoom ? '  [same room — no walk]' : `  [walk: ${p.from.room} -> ${p.to.room}]`));
if (DRY) { console.log('\ndry run — nothing handed over'); process.exit(0); }

for (const p of plan) {
  try {
    // THE GIVER WALKS BY DEFAULT — but if it cannot, send the receiver instead.
    //
    // The surplus pools where the good farmers are, and they are good farmers partly
    // because they stay put. When every donor sits in one room whose exit is refused
    // ("no floor anywhere on the west boundary"), giver-walks fails for the whole
    // fleet at once and nothing moves — which is exactly what happened: seven of seven
    // deliveries, one error, one room.
    //
    // Swapping who walks costs nothing and fails independently: a blocked edge is
    // directional and about the room being LEFT, so the reverse trip is a different
    // question with a different answer. It is also the better trip on its own terms —
    // the starving character has an empty pack and nothing to lose by moving, while
    // the donor is mid-hunt with a full one.
    let r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                   what: 'reagents', amount: AMOUNT, who_travels: 'from' });
    if (r?.supplied !== true && /could not get there|no floor|boundary/i.test(JSON.stringify(r))) {
      console.log(`    ${p.from.character} is walled in — sending ${p.to.character} to fetch instead`);
      r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                 what: 'reagents', amount: AMOUNT, who_travels: 'to' })
                .catch(e => ({ supplied: false, reason: e.message }));
    }
    // `supplied` is the field the tool actually returns — not `delivered`, `ok` or
    // `received`, all of which I guessed and none of which exist. Guessing read a
    // successful hand-over as a failure and skipped the cast that was the whole point,
    // while the goods sat in the recipient's pack. Verify against the response, and
    // against `receiver_carrying`, which is the tool's own proof it landed.
    const ok = r.supplied === true && (r.receiver_carrying ?? 0) > 0;
    console.log(`  ${p.from.character} -> ${p.to.character}: ` +
                (ok ? 'delivered' : 'NOT delivered') + ' ' + JSON.stringify(r).slice(0, 160));
    if (!ok) continue;

    // COOK, EAT, THEN AIM HIGHER. Handing over reagents changes nothing on its own —
    // the character has to spend them, and then be told that 80 vigor is no longer
    // good enough to set out at. provision() climbs to the floor by eating, which it
    // can only do now that it has something to cook.
    await call('cast', { agent: p.to.agent, spell: 'create food' }).catch(() => {});
    await sleep(1200);
    await call('autopilot', { agent: p.to.agent, fight_above_vigor: FLOOR }).catch(() => {});
    console.log(`    ${p.to.character}: cast create food, now fighting above ${FLOOR} vigor`);
  } catch (e) {
    console.log(`  ${p.from.character} -> ${p.to.character}: FAILED ${e.message}`);
  }
}
process.exit(0);
