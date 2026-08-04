#!/usr/bin/env node
// THE THING NO SINGLE KEEPER CAN DECIDE.
//
//   node tools/m59-supervise.mjs                 # run it, every 60s, until stopped
//   node tools/m59-supervise.mjs --once          # one round and exit
//   node tools/m59-supervise.mjs --graduate 30   # the level at which the valley starts
//   node tools/m59-supervise.mjs --dry-run
//
// A keeper knows about one character and the room it is standing in. Three things are
// invisible from there, and all three are what this does:
//
//   PAIR      Two characters on one monster both advance from it — advancement is a
//             per-character flag, not a split pot — and between them they take the
//             damage one would have taken alone while each regenerates on its own
//             clock. Nothing in the game pairs anyone; the pairing is a convention two
//             keepers hold, and something outside them has to decide who with whom.
//   GRADUATE  Prey stops paying the moment the character reaches its level
//             (AdvancementCheck needs monster_level > base_max_health). A keeper
//             happily farms something worth nothing for ever, reporting kills.
//   UNSTICK   A keeper that has stalled cannot restart itself.
//
// NO CHARACTER NAMES IN THIS FILE. The old supervisor carried a hard-coded table of
// twenty-five names mapping to schools, and when the fleet was replaced every lookup
// missed and silently fell through to a default — every character got the same prey
// and nothing said so. Everything here is read from the live fleet instead, which is
// also what lets this repository be public.
import { readFileSync, existsSync } from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
// NOT `URL`. Naming this URL shadows the global constructor for the whole module, and
// the only use of `new URL(...)` is in outfitPair — so the shadowing turned deployment
// into "round failed: URL is not a constructor" while every other round looked fine.
const RPC = `http://127.0.0.1:${PORT}/`;
const ONCE = !!arg('once', false);
const DRY = !!arg('dry-run', false);
const GRADUATE_AT = Number(arg('graduate', 30));
const EVERY_MS = Number(arg('every', 60)) * 1000;

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
const stamp = () => new Date().toISOString().slice(11, 19);

// WHERE THE GRADUATES GO, and why these three.
//
// All three generate fungus beasts. A fungus beast is level 50, which reads as far out
// of reach for a character of 30 — and the level is the wrong number to read. Level
// sets HIT POINTS and what the kill pays; what it hits you WITH is viDifficulty, and a
// fungus beast's is 1:
//
//   GetAttackAbility = 3*viLevel + 60*viDifficulty     (monster.kod)
//   fungus beast:  3*50 + 60*1  = 210
//   centipede:     3*30 + 60*5  = 390
//
// So the thing they have been farming all week is nearly twice as likely to land a
// blow. Damage is Fuzzy(viLevel/Random(10,15)) — 3 to 5 for a fungus beast against 2
// to 3 for a centipede — so per swing it is comparable, and it swings less often
// (viSpeed 4 against 16). What level 50 buys is a long fight against a big pool of hit
// points, which is exactly the fight a pair at 200 vigor wins: health comes back at
// ((200-vigor)^2/6 + 1000) ms a point, or one a second at 200, and two characters
// splitting the incoming hits each regenerate faster than one slow monster can deal.
//
// They are also FRESH GROUND. The safe-spot book has no failures recorded in any of
// them, where the old rooms have hundreds — 95 discredited squares at the Tos gate
// alone — and a room with no usable squares left is a room the keeper has to fight in
// the open in, which is where the fleet has been dying.
const VALLEY = [
  { room: 544, name: 'Valley of Ileria',                  hunt: 'fungus beast', share: 65, cap: 10 },
  { room: 563, name: 'Source of the River Ille',          hunt: 'fungus beast', share: 70, cap: 7 },
  { room: 562, name: 'The sandy shores of the Great Ocean', hunt: 'fungus beast', share: 50, cap: 6 },
];

// The orders a graduated pair runs. Everything here is a deliberate departure from the
// low-level loop, and each one is load-bearing:
const VALLEY_ORDERS = {
  mode: 'farm',
  strategy: 'wellfed',          // vigor IS the healing rate, and healing is the tactic
  fight_above_vigor: 180,       // set out near the 200 ceiling, not at the 140 floor
  rest_below: 0.75,             // break off early; there is a partner to carry it
  flee_below: 0.35,
  max_carry: 40,
  roam: false,                  // stay in the assigned room; the partner is there
  use_safe_spots: true,
  hold_resume_above: 0.9,
};

const inTown = n => /Raza|Mausoleum|Museum|Marion|Tos|Barloque|Jasper|Cornoth|inn/i.test(n || '');

// WHAT TO HUNT WHEN WE HAVE LOST TRACK OF THE ORDERS, by level.
//
// Every restart path needs a fallback, and the old one was the bare string 'giant rat'
// — which is right for a character of 25 and actively harmful for one of 32, because a
// level-30 rat pays a level-32 character NOTHING. AdvancementCheck only rolls when
// monster_level > base_max_health. Three graduated characters were found hunting rats,
// two of them standing IN the valley rooms, having been re-targeted by a restart. They
// were killing steadily and gaining nothing, which is the failure that looks exactly
// like success: the keeper works, the journal fills, the level never moves.
//
// So the fallback has to know the level it is falling back FOR:
//
//   under 30   giant rat (L30) — above them, so it still pays
//   30 to 44   fungus beast (L50) — the valley prey; see the viDifficulty note in
//              CLAUDE.md for why a level-50 creature is the safer fight here
//   over 44    null. Nothing here is a safe guess, and guessing is what caused this;
//              the caller keeps whatever orders it already had.
//   under 30   giant rat (L30)
//   30 to 58   fungus beast (L50)
//   59 to 73   battered skeleton (L60)
//   74 to 88   skeleton (L75)
//   89 and up  troll (L90)
//
// Each threshold sits one below its creature's level, so the prey is always ABOVE the
// character when the band opens — which is the whole requirement, since AdvancementCheck
// only rolls when monster_level > base_max_health. The band then runs until the next
// prey becomes reachable rather than until this one stops paying, so a character does
// not sit on worthless prey waiting for a promotion.
export function fallbackHunt(level) {
  const l = Number(level) || 0;
  if (l < 30) return 'giant rat';          // L30
  if (l < 59) return 'fungus beast';       // L50
  if (l < 74) return 'battered skeleton';  // L60
  if (l < 89) return 'skeleton';           // L75
  return 'troll';                          // L90
}

// PAIR THEM UP. Two rules, both about not producing a party that cannot function:
//   * never pair a character with itself, and never leave a three
//   * pair by level, so neither partner is fighting something the other outclasses
// An odd fleet leaves one unpaired, and that is reported rather than hidden — a
// character that thinks it has a partner and has not is worse than a solo one.
// KEEP PAIRS THAT ALREADY WORK. Re-pairing from scratch every round looks like
// self-healing and is actually a thrash: pairUp sorts by level, levels change as
// characters gain and die, so the assignment reshuffles constantly — and every
// reshuffle stops two keepers and re-travels two characters. Nobody arrives before
// being reassigned. Nineteen of twenty-one were misplaced and six pairings one-sided
// within two rounds of running it that way, while deaths climbed.
//
// So an existing MUTUAL pair is left exactly as it is, and only the unpaired are
// matched up. That still heals a widowed character — its partner is gone, so it is
// unpaired and gets re-matched — without disturbing anything that is working.
export function pairUp(rows) {
  const by = new Map(rows.map(r => [r.agent, r]));
  const pairs = [], taken = new Set();
  for (const r of rows) {
    if (taken.has(r.agent) || !r.partner_ok) continue;
    const mate = by.get(r.partner);
    if (!mate || taken.has(mate.agent)) continue;
    taken.add(r.agent); taken.add(mate.agent);
    pairs.push([r, mate]);
  }
  const rest = rows.filter(r => !taken.has(r.agent))
                   .sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  while (rest.length >= 2) pairs.push([rest.shift(), rest.shift()]);
  return { pairs, odd: rest[0] ?? null };
}

// Spread the pairs over the rooms rather than stacking them: each room caps its
// generator (10, 7 and 6), and two pairs in one room halve each other's supply while
// sharing all of the danger.
export function assignRooms(pairs, rooms = VALLEY) {
  return pairs.map((p, i) => ({ pair: p, ...rooms[i % rooms.length] }));
}

async function orders(agent, room, hunt, partner) {
  return call('autopilot', {
    agent, action: 'start', ...VALLEY_ORDERS,
    hunt, assigned_room: room, partner,
  });
}

// TRAVEL IS FLAKY IN THE MIDDLE, AND RETRYING WORKS.
//
// A multi-hop route fails part-way with things like "start is outside the room grid" —
// the character arrives at an edge, its coordinates read as off the grid for a moment,
// and the next edge cannot be computed. It is transient: the position settles and the
// same route succeeds. What makes retrying correct rather than hopeful is that travel
// is resumable — each attempt starts from wherever the character actually got to, so
// three attempts continue a route rather than restarting it.
//
// Reports where it ended up when it never makes it, because "could not reach" without
// a location leaves a character stranded somewhere nobody is looking.
async function travelTo(agent, room, { tries = 3, hops = 20 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const t = await call('travel', { agent, to: room, max_hops: hops })
                    .catch(e => ({ arrived: false, why: e.message }));
    if (t.arrived) return { arrived: true, attempts: i + 1 };
    last = t;
    const st = await call('status', { agent, brief: true }).catch(() => null);
    if (st?.where?.num === room) return { arrived: true, attempts: i + 1, note: 'already there' };
    await sleep(1500);
  }
  const st = await call('status', { agent, brief: true }).catch(() => null);
  const stuck = (last?.log || []).filter(h => !h.ok).slice(-1)[0];
  return { arrived: false, attempts: tries,
           why: stuck ? `${stuck.from} -> ${stuck.to}: ${stuck.also_tried?.[0]?.why ?? stuck.why ?? 'refused'}`
                      : (last?.why || 'refused'),
           left_in: st?.where?.name ?? null };
}

async function deploy(a, b, room, name, hunt) {
  const out = [];
  for (const [me, mate] of [[a, b], [b, a]]) {
    // STOP THE KEEPER BEFORE WALKING IT ACROSS THE WORLD.
    //
    // A running keeper is also moving the character — taking safe spots, pulling
    // monsters back to them, breaking off. Travel plans a route to an exact square and
    // then finds the character somewhere else, which is reported as "kept ending up
    // somewhere other than the planned square" and retried until it gives up. Both
    // sides are working correctly and fighting each other; the fix is that only one
    // thing may drive a character at a time.
    await call('autopilot', { agent: me.agent, action: 'stop' }).catch(() => {});
    const t = await travelTo(me.agent, room);
    if (!t.arrived) {
      // NEVER LEAVE A CHARACTER WITH NO KEEPER. We stopped it to travel; if the travel
      // failed it is standing in a monster room with nothing driving it, which is worse
      // than the situation we were trying to improve. Put it back to work where it is.
      await call('autopilot', { agent: me.agent, action: 'start', mode: 'farm',
                                hunt: me.hunting || hunt }).catch(() => {});
      out.push(`${me.character}: could not reach ${name} after ${t.attempts} tries — ` +
               `${t.why}${t.left_in ? ` (left in ${t.left_in})` : ''} — keeper restarted where it stands`);
      continue;
    }
    // AND IF GIVING THE ORDERS FAILS, THE KEEPER IS STILL OFF.
    //
    // The failed-travel path above is careful about this and this one was not: a throw
    // from orders() was caught, noted, and the loop moved on — leaving a character
    // standing in a room with nothing driving it, indefinitely, for whatever reason the
    // call failed. It is the same hazard the comment above names, on the success path.
    //
    // Found by the uptime ledger within an hour of it existing: t1 and t5 stopped 104ms
    // apart, travelled to Marion, and sat there at full health with no keeper for eight
    // minutes. The stops had no matching starts, which is exactly what that ledger is
    // for. Falling back to "farm where you stand" is worse than the intended orders and
    // enormously better than nothing.
    const gave = await orders(me.agent, room, hunt, mate.agent)
                         .then(() => true)
                         .catch(e => { out.push(`${me.character}: ${e.message}`); return false; });
    if (!gave) {
      const back = await call('autopilot', { agent: me.agent, action: 'start', mode: 'farm',
                                             hunt: me.hunting || hunt }).catch(() => null);
      out.push(`${me.character}: orders failed after arriving — keeper ${back ? 'restarted plainly' : 'COULD NOT BE RESTARTED'}`);
      continue;
    }
    out.push(`${me.character} -> ${name} (${room}) hunting ${hunt}, partnered with ${mate.character}`);
  }
  return out;
}

async function round(n) {
  const f = await call('fleet', {});
  const rows = (f.fleet || []).filter(r => r.in_game !== false);
  const hist = {};
  for (const r of rows) if (r.level) hist[r.level] = (hist[r.level] || 0) + 1;
  const ready = rows.filter(r => (r.level ?? 0) >= GRADUATE_AT);
  console.log(`${stamp()} [${n}] ${rows.length} in game  ready=${ready.length} (>=${GRADUATE_AT}hp)  ` +
              `stalled=${f.stalled_count ?? '?'}  ${JSON.stringify(hist)}`);

  // 1. UNSTICK. Before anything else: a stalled keeper cannot be paired or moved, and
  // restarting it is what clears the set of rooms it gave up routing to.
  for (const r of rows.filter(r => r.stalled && r.stalled !== false)) {
    const why = JSON.stringify(r.stalled).slice(0, 90);
    const reason = String(r.stalled?.why ?? r.stalled);
    // A DELIBERATE REFUSAL IS NOT A STALL, and restarting it is actively harmful.
    //
    // The keeper refuses to fight in a room with no safe wall it can find, and records
    // which rooms those are for the session. Restarting the keeper throws that record
    // away, so the fresh one walks back in, re-probes, refuses again, and reports a
    // stall again — once a minute, for ever. Eight characters were caught in that loop
    // within a minute of the rule going live, and every line of it looked like the
    // supervisor working.
    //
    // The keeper relocates itself out of a denied room. Leave it alone to do it.
    if (/no safe wall|refusing to fight/i.test(reason)) {
      console.log(`   leaving ${r.character} alone: ${reason.slice(0, 70)} ` +
                  '(a refusal, not a stall — it relocates itself)');
      continue;
    }
    if (DRY) { console.log(`   would restart ${r.character}: ${why}`); continue; }
    const persistent = typeof r.stalled === 'object' && (r.stalled.idle_passes ?? 0) >= 8;
    if (!persistent && !/no keeper|keeper stopped/.test(String(r.stalled))) continue;
    await call('autopilot', { agent: r.agent, action: 'start', mode: 'farm',
                              // Its own hunt first; only fall back when we genuinely do
                              // not know, and then by level rather than to a constant.
                              hunt: r.hunting || fallbackHunt(r.level) }).catch(() => {});
    console.log(`   restarted ${r.character}: ${why}`);
  }

  // 2. GRADUATE EVERYONE WHO IS READY, including those already out there.
  //
  // The pool is every character at or over the threshold, not just the ones still in
  // the old rooms. Two reasons, and the second is the one that was wrong before:
  //
  //   * pairs do not survive on their own. A partner dies, or drops, or is left over
  //     from an odd round — and re-pairing from the whole ready set each round heals
  //     that, where pairing only the newly-ready leaves a widowed character alone in a
  //     room full of level-50 creatures, which is the worst place in the plan to be.
  //   * an odd round used to leave one character behind entirely. With the whole set
  //     in the pool it is a different character each round and it joins the next one.
  //
  // Characters already standing in their assigned room with the right partner are
  // skipped below, so this costs nothing for the ones that are already right.
  const alreadyThere = new Set(VALLEY.map(v => v.room));
  if (!ready.length) { console.log('   nobody is ready to graduate yet'); return rows; }

  const { pairs, odd } = pairUp(ready);
  if (odd) console.log(`   ${odd.character} is the odd one this round — left on its current ` +
                       'orders rather than sent to fight level-50 prey alone; it pairs up next ' +
                       'round, and the pool is re-paired every round so it will not be the same one');
  const plan = assignRooms(pairs);
  for (const p of plan) {
    const [a, b] = p.pair;
    // ALREADY IN PLACE, TOGETHER, AND PAIRED WITH EACH OTHER. Anything less than all
    // three and it is re-deployed: a character in the right room with the wrong partner
    // is not in a party, it is standing next to someone.
    const settled = (x, y) => x.room_num === p.room && x.partner === y.agent;
    if (settled(a, b) && settled(b, a)) continue;
    if (DRY) { console.log(`   would send ${a.character} + ${b.character} -> ${p.name} (${p.room})`); continue; }
    // GEAR BEFORE GOING. Sending an unarmoured pair at a level-50 creature is the one
    // way this plan fails for a reason that was entirely avoidable.
    console.log(`   outfitting ${a.character} + ${b.character}`);
    await outfitPair(a, b);
    for (const line of await deploy(a, b, p.room, p.name, p.hunt)) console.log('   ' + line);
  }
  return rows;
}

// Shell out to the outfitter rather than reimplementing it: it already knows about
// per-town bank accounts, the shop-reply race, and putting the keeper's orders back.
async function outfitPair(a, b) {
  const { spawn } = await import('node:child_process');
  const script = new URL('./m59-outfit.mjs', import.meta.url).pathname
                   .replace(/^\/([A-Za-z]:)/, '$1');
  await new Promise(res => {
    const p = spawn(process.execPath, [script, '--agents', `${a.agent},${b.agent}`,
                                       '--port', String(PORT)], { stdio: 'inherit' });
    p.on('exit', res);
    setTimeout(() => { try { p.kill(); } catch {} res(); }, 8 * 60 * 1000);
  });
}

// ONLY WHEN RUN, NEVER WHEN IMPORTED.
//
// pairUp and assignRooms are worth testing and the test has to import this file to
// reach them — and without this guard that import starts supervising the live fleet
// in a loop that never returns. It is the same trap m59-broker.mjs carries a warning
// about, and it caught this file the first time the test was run.
// pathToFileURL, not string surgery: on Windows a bare C:\... path is neither a valid
// URL nor comparable to import.meta.url without it.
const { pathToFileURL } = await import('node:url');
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  for (let n = 0; ; n++) {
    try { await round(n); }
    catch (e) {
      // A broker restart makes every call fail for a minute. Not a reason to stop.
      console.log(`${stamp()} round failed: ${e.message}`);
    }
    if (ONCE) break;
    await sleep(EVERY_MS);
  }
}
