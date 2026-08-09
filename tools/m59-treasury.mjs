#!/usr/bin/env node
// MOVE MONEY TO THE CHARACTERS THAT CANNOT RE-ARM WITHOUT IT.
//
//   node tools/m59-treasury.mjs                 # say what it would move, move nothing
//   node tools/m59-treasury.mjs --apply         # actually hand it over
//   node tools/m59-treasury.mjs --need 900      # what counts as "cannot re-arm", default 900
//   node tools/m59-treasury.mjs --keep 500      # what a donor keeps in hand, default 500
//   node tools/m59-treasury.mjs --max 1200      # most to move in one hand-over, default 1200
//
// WHY THIS EXISTS.
//
// The fleet earns plenty and distributes none of it. Measured over four passes its total
// wealth fell 61,085 -> 58,401 -> 52,252 while THREE characters held 68% of what was left
// and ELEVEN had nothing banked at all. At the same time five characters were walking
// around with no body armour and the outfitter was reporting, correctly and uselessly,
// "nothing banked at Yevitan to draw on, nothing banked at Skivlat to draw on".
//
// Those two facts are one problem. Armour costs 480 to 1800 depending on which smith the
// router picks, gear breaks about once a pass per character, and a character that cannot
// replace its armour dies more, loses its pack when it does, and gets poorer — while the
// good farmers accumulate money they have no use for. Nothing in the fleet moves value
// from the second group to the first.
//
// m59-almoner.mjs already does exactly this for REAGENTS, and the shape of the argument is
// the same: the fleet is not short, it is badly distributed. This is the coin half, and it
// is deliberately a separate tool rather than a fifth job inside the almoner — the almoner
// walks characters to hand over herbs, and a herb is worth nothing while a purse is the
// only thing standing between a character and being unable to fight.
//
// TWO THINGS IT WILL NOT DO, and both are because of recorded failures:
//
//   * IT WILL NOT EMPTY A DONOR. `supply` takes {id, amount} for exactly this reason —
//     the broker's own comment records Waldorf lending Rizzo its entire 1,311 and being
//     left "with nothing and no food, which is the problem moved rather than solved".
//     Every donor keeps a float, and the float is what a character needs to buy its own
//     way home.
//   * IT PREFERS HAND MONEY, AND GOES TO A BANK ONLY WHEN THERE IS NONE. The first
//     version refused the bank outright, reasoning that a withdraw-walk-hand-over errand
//     is three legs and hand money is usually available. The first live run said
//     otherwise: one character carried a spare, eleven had nothing banked, and the three
//     richest held 30,675 between them entirely behind counters — so the tool worked
//     perfectly and moved 266 shillings. The bank leg is the job, not an optimisation.
//     It stays bounded because it is the dangerous half: ONE donor per run, ONE
//     withdrawal, the amount decided before setting off, and a reserve left in the
//     account so the donor can still re-arm itself when its own armour breaks.
//
// Read-only until --apply. Never calls `leave`, never starts or stops a broker.
const PORT = Number(argOf('port', 8901));
const URL = `http://127.0.0.1:${PORT}/`;
const APPLY = has('apply');
// Enough to replace body armour at the dearest counter the router might pick (1800 was
// paid once) plus a walking float would be ~2200. That is not the bar: the bar is being
// able to buy the CHEAPEST adequate kit, because a character below it can do nothing at
// all, and one above it can at least shop. 900 clears leather at Colhorr (640) or Rook
// (800) with a little over.
const NEED = Number(argOf('need', 900));
const KEEP = Number(argOf('keep', 500));
const MAX  = Number(argOf('max', 1200));

function has(name) { return process.argv.includes('--' + name); }
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}

let id = 0;
async function call(name, args = {}, timeoutMs = 120000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

const purseOf = (items) => (items || []).filter(i => /shilling/i.test(i.name ?? ''))
                                        .reduce((t, i) => t + (i.amount || 1), 0);
const coinIdOf = (items) => (items || []).find(i => /shilling/i.test(i.name ?? ''))?.id ?? null;

const fleet = await call('fleet', {});
const rows = (fleet.fleet || []).filter(r => r.in_game !== false);
if (!rows.length) { console.log('no characters in game'); process.exit(0); }

// Read every purse once. `fleet` carries `purse` already, but the hand-over needs the
// OBJECT ID of the coin stack and only `inventory` has that — and reading it here means
// the plan and the transfer are working from the same numbers.
const held = [];
for (const r of rows) {
  const inv = await call('inventory', { agent: r.agent }).catch(() => ({ items: [] }));
  held.push({
    agent: r.agent, character: r.character, room: r.room_num,
    purse: purseOf(inv.items), coin: coinIdOf(inv.items),
    banked: r.banked?.balance ?? 0,
  });
}

// WHO IS ACTUALLY FIGHTING IN NOTHING — the question this tool exists to answer, and the
// one it was not asking.
//
// The first version ranked by poverty alone and funded whoever had least. That is a
// reasonable-sounding rule and it delivered 799 and 996 shillings to two characters who
// already had armour, while the three walking around without any kept 103, 106 and 110.
// Being poor is uncomfortable; being poor AND unarmoured is the thing that kills a
// character and costs it the pack it needed to get rich with.
//
// `equipment` is the server's own use list — plUsing — and is the only authoritative
// answer to "is this character wearing armour". It costs one call each and is worth it:
// the board carries no equipped count, and the proxy this used before (`r.equipped_count`)
// does not exist on the row, so it was `null` for everybody and the sort never saw it.
const ARMOUR = /leather (armor|armour)|chain|plate|mail|robe/i;
for (const h of held) {
  const eq = await call('equipment', { agent: h.agent }).catch(() => ({ equipped: [] }));
  h.armoured = (eq.equipped || []).some(x => ARMOUR.test(String(x?.name ?? x ?? '')));
}
const bare = held.filter(h => !h.armoured).map(h => h.character);
console.log(`fighting without body armour: ${bare.length ? bare.join(', ') : 'nobody'}`);

const totalPurse = held.reduce((t, h) => t + h.purse, 0);
const totalBank  = held.reduce((t, h) => t + h.banked, 0);
console.log(`fleet holds ${totalPurse} in hand and ${totalBank} banked ` +
            `(${held.filter(h => h.banked === 0).length} of ${held.length} with nothing banked)`);

// WHO CANNOT SHOP. Purse plus balance, because a character with money in a bank can get
// at it on its own and does not need a donor — the outfitter withdraws.
// UNARMOURED FIRST, THEN POOREST. A character with no armour and 106 shillings outranks
// one with armour and 90: the first cannot fix itself and the second is merely broke.
const needy = held.filter(h => h.purse + h.banked < NEED)
                  .sort((a, b) => (a.armoured === b.armoured)
                    ? (a.purse + a.banked) - (b.purse + b.banked)
                    : (a.armoured ? 1 : -1));
// WHO CAN SPARE IT, from money already in hand. Sorted richest first so the fewest
// hand-overs are made: each one is a walk, and a walk is the part that fails.
const donors = held.filter(h => h.purse - KEEP >= 100 && h.coin != null)
                   .sort((a, b) => (b.purse - KEEP) - (a.purse - KEEP));

console.log(`${needy.length} character(s) below ${NEED}; ${donors.length} carrying more than ${KEEP} in hand`);
if (!needy.length) { console.log('nothing to do'); process.exit(0); }
// AND WHEN THE MONEY IS ALL IN BANKS, FETCH SOME — because on this fleet it always is.
//
// The first version of this refused to make a bank trip and reported the fact instead,
// on the reasoning that a withdraw-walk-hand-over errand is three legs and hand money is
// usually available. Run against the real fleet that turned out to be exactly backwards:
// ONE character was carrying a spare, eleven had nothing banked, and the three richest
// held 30,675 between them — all of it behind a counter. The tool worked perfectly and
// moved 266 shillings.
//
// So the bank leg is not an optimisation, it is the whole job. It is still the dangerous
// half — three legs, each able to fail in the middle and leave coin on a character nobody
// planned for — so it is bounded: one donor per run, one withdrawal, and the amount is
// decided before setting off rather than "take out a round number and see".
const BANKS = [{ room: 54, name: 'First Royal Bank of Tos' },
               { room: 376, name: 'The Royal Bank of Jasper' }];
// HOLD THE CHARACTER STILL WHILE THE ERRAND RUNS.
//
// This is why the bank leg kept failing. The tool travelled a donor to the counter and
// then asked for money — and never stopped the keeper, which is running its own eight-
// second pass and simply walked the character off again. The withdrawal then fired
// wherever it happened to be standing and the banker answered, verbatim, "You can't check
// any balance here!" — reported by this tool as "the counter gave nothing", which reads
// like an empty account and was a character in the wrong room.
//
// m59-outfit.mjs has stopped the keeper around its errands from the beginning, for exactly
// this reason: anything that drives a character has to be serialised against everything
// else that drives one. `stop` is inert rather than hard, so the keeper keeps looking,
// keeps recording, and keeps its death record — it just stops steering.
const holding = new Set();
async function hold(agent, why) {
  if (holding.has(agent)) return;
  await call('autopilot', { agent, action: 'stop', why }, 60000).catch(() => {});
  holding.add(agent);
}
async function releaseAll() {
  for (const agent of holding)
    await call('autopilot', { agent, action: 'revive', why: 'treasury errand finished' }, 60000).catch(() => {});
  holding.clear();
}
// PUT EVERY CHARACTER BACK EVEN IF THIS DIES PART-WAY — AND DO NOT RUN IT UNDER A
// SHORTER TIMEOUT THAN THE WALK.
//
// A held keeper gives itself up after INERT_MAX_MS (fifteen minutes), which is the safety
// net and not an acceptable outcome: fifteen minutes of a character standing still is
// worse than the money it was waiting for. The handler below releases on a signal, but it
// is asynchronous and a signal is not — killed hard enough, it loses the race.
//
// That happened on the first run with holds: an external `timeout 560` fired mid-delivery
// and four keepers were left stopped until they were revived by hand. So the rule is that
// this tool owns its own clock — the deliveries are cross-world walks and can take ten
// minutes — and anything wrapping it must not cut it short.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Fire the releases and give them a moment; exiting immediately would abandon the
    // characters this function exists to protect.
    releaseAll().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}

async function fetchFromBank(needTotal) {
  // The richest ACCOUNT, not the richest purse. Keeping a reserve banked is the same
  // instinct as the hand float: a donor that empties its account cannot re-arm itself
  // the next time its own armour breaks, and it is usually the character doing the most
  // fighting.
  const RESERVE = 3000;
  const cand = held.filter(h => h.banked - RESERVE >= 500)
                   .sort((a, b) => b.banked - a.banked)[0];
  if (!cand) { console.log(`no account holds more than ${RESERVE} spare to draw on`); return null; }
  const take = Math.min(MAX * 2, cand.banked - RESERVE, Math.max(500, needTotal));
  const bank = BANKS[0];
  console.log(`fetching ${take}sh: ${cand.character} has ${cand.banked} banked — going to ${bank.name}`);
  await hold(cand.agent, 'treasury: fetching money for characters that cannot re-arm');
  let at = cand.room;
  for (let i = 0; i < 3 && at !== bank.room; i++) {
    const t = await call('travel', { agent: cand.agent, to: bank.room }, 300000).catch(() => ({}));
    at = t.room?.num ?? at;
    if (at !== bank.room) {
      const f = await call('fleet', {}).catch(() => ({ fleet: [] }));
      at = (f.fleet || []).find(r => r.agent === cand.agent)?.room_num ?? at;
    }
  }
  if (at !== bank.room) { console.log(`  ${cand.character} could not reach ${bank.name}`); return null; }
  const before = cand.purse;
  await call('bank', { agent: cand.agent, action: 'withdraw', amount: take }, 90000).catch(() => null);
  await new Promise(r => setTimeout(r, 1500));
  const inv = await call('inventory', { agent: cand.agent }).catch(() => ({ items: [] }));
  const now = purseOf(inv.items);
  // Read the purse, never the reply: a withdrawal reports the amount handed over, not the
  // new balance, and an over-withdrawal is refused with a sentence rather than an error.
  console.log(`  ${cand.character}: purse ${before} -> ${now}` + (now > before ? '' : '  (the counter gave nothing)'));
  if (now <= before) return null;
  cand.purse = now; cand.coin = coinIdOf(inv.items); cand.room = bank.room;
  return cand;
}

// TRIGGERED ON WHETHER THE HAND MONEY COVERS THE NEED, NOT ON WHETHER ANY EXISTS.
//
// The first version asked `if (!donors.length)`, so a single character carrying 766 spare
// suppressed the bank leg entirely: the run planned one 266-shilling hand-over and told
// ten characters "nobody left with money to spare" while 30,675 sat in three accounts.
// One donor is not the same as enough, and the difference is ten characters that stay
// unable to buy armour.
const handSpare = donors.reduce((t, d) => t + (d.purse - KEEP), 0);
const wanted = needy.reduce((t, n) => t + Math.max(0, NEED - (n.purse + n.banked)), 0);
if (handSpare < wanted) {
  console.log(`hand money covers ${handSpare} of ${wanted} needed`);
  if (!APPLY) {
    console.log(`--apply would send the richest account to a bank to fetch the difference.`);
    process.exit(0);
  }
  const fetched = await fetchFromBank(wanted - handSpare);
  if (!fetched) console.log('could not raise any cash from a bank; moving what is in hand');
  else if (!donors.includes(fetched)) donors.push(fetched);
  donors.sort((a, b) => (b.purse - KEEP) - (a.purse - KEEP));
}

// Give each donor a fair share of recipients rather than draining the richest, and prefer
// a donor ALREADY IN THE ROOM — that is a hand-over with no walk at all, and the walk is
// the failure-prone half.
const spare = new Map(donors.map(d => [d.agent, d.purse - KEEP]));
const plan = [];
for (const n of needy) {
  const able = donors.filter(d => (spare.get(d.agent) ?? 0) >= 100 && d.agent !== n.agent);
  if (!able.length) { console.log(`  ${n.character}: nobody left with money to spare`); continue; }
  const pick = able.find(d => d.room === n.room) ?? able[0];
  const gap = Math.max(0, NEED - (n.purse + n.banked));
  const amount = Math.min(MAX, spare.get(pick.agent), gap);
  if (amount < 100) continue;
  spare.set(pick.agent, spare.get(pick.agent) - amount);
  plan.push({ from: pick, to: n, amount, sameRoom: pick.room === n.room });
}

for (const p of plan)
  console.log(`  ${p.from.character} -> ${p.to.character}: ${p.amount}sh` +
              (p.sameRoom ? '  [same room — no walk]' : `  [walk: ${p.from.room} -> ${p.to.room}]`) +
              `  (${p.to.character} has ${p.to.purse}+${p.to.banked})`);
if (!plan.length) { console.log('nothing worth moving'); process.exit(0); }
if (!APPLY) { console.log('\nplan only — pass --apply to hand it over'); process.exit(0); }

for (const p of plan) {
  try {
    // Both ends: the walker must not wander off mid-route, and the receiver must be where
    // the walker is going when it arrives.
    await hold(p.from.agent, 'treasury: handing money to a character that cannot re-arm');
    await hold(p.to.agent, 'treasury: waiting for money to re-arm with');
    // THE PARTIAL STACK IS THE WHOLE POINT. A bare id means the entire purse; {id, amount}
    // means the loan. See the broker's own note on this — a character that lends
    // everything has moved the problem rather than solved it.
    // NINE HUNDRED SECONDS, NOT THREE HUNDRED. The first live run planned four hand-overs
    // and lost the first one to `The operation was aborted due to timeout` on a walk from
    // 576 to 108 — most of the width of the world. A timeout shorter than the walk turns
    // every long delivery into a failure that looks like a routing problem, and the coin
    // is left on the donor with nothing saying so.
    let r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                   what: [{ id: p.from.coin, amount: p.amount }],
                                   who_travels: 'from' }, 900_000);
    // Same fallback as the almoner, for the same reason: a blocked edge is directional
    // and about the room being LEFT, so the reverse trip is a different question. The
    // poorer character also has less to lose by moving.
    if (r?.supplied !== true && /could not get there|no floor|boundary|not in the room/i.test(JSON.stringify(r))) {
      console.log(`    ${p.from.character} could not get there — sending ${p.to.character} instead`);
      r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                 what: [{ id: p.from.coin, amount: p.amount }],
                                 who_travels: 'to' }, 900_000)
            .catch(e => ({ supplied: false, reason: e.message }));
    }
    // VERIFY AGAINST THE PURSE, NOT AGAINST THE REPLY. `supplied: true` says the offer was
    // accepted; what matters is how much arrived, and a partial hand-over reports the same
    // way as a whole one.
    const after = purseOf((await call('inventory', { agent: p.to.agent }).catch(() => ({ items: [] }))).items);
    const moved = after - p.to.purse;
    console.log(`  ${p.from.character} -> ${p.to.character}: ` +
                (moved > 0 ? `${moved}sh arrived (purse ${p.to.purse} -> ${after})`
                           : `NOTHING ARRIVED — ${r?.reason ?? JSON.stringify(r).slice(0, 120)}`));
  } catch (e) {
    console.log(`  ${p.from.character} -> ${p.to.character}: FAILED ${e.message}`);
  }
}

// Everybody back to work. This is the line that matters most in the file: a tool that
// leaves keepers stopped has taken characters out of the fleet more effectively than any
// amount of money puts them back.
await releaseAll();
console.log('keepers released');
