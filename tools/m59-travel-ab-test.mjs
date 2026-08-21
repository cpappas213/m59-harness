#!/usr/bin/env node
// THE TRAVEL A/B — the randomisation and the arithmetic. Offline, safe any time:
//
//   node tools/m59-travel-ab-test.mjs
//
// This experiment runs on twenty-one live characters and its outcome is DEATHS, so the two
// things that can quietly ruin it are pinned here.
//
//   * A BIASED SPLIT. If the arm correlates with the character — or with the time of day,
//     or with which character travels most — the result is a fact about the fleet rather
//     than about the intervention, and it will look exactly like a real effect.
//   * ARITHMETIC THAT CLAIMS TOO MUCH. Rare events make it very easy to read noise as a
//     finding. A two-hour run with one death in each arm must say "not yet", and the
//     "how much longer" answer has to be right or somebody stops the experiment early.
//
// The outcome metric is deliberately NOT damage taken. The hypothesis players state is
// that fighting from a wall means you take MORE damage and die LESS — so a measurement
// built on damage would reject the intervention precisely when it is working.

import { readFileSync } from 'node:fs';
import { twoProportion, eventsNeeded, isTravelTrip } from './m59-travel-ab.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import * as party from './m59-party.mjs';

const AUTOPILOT_SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
// A NAME THE PARTY ROSTER ACTUALLY KNOWS. `party.isFleetmate` reads the live roster, and a
// keeper that has not had a pass yet is absent from it — so the fixture registers one
// rather than asserting against whatever happens to be in memory.
const FLEETMATE = 'AbsolutelyOurs';
party.setRosterSource(() => new Set([FLEETMATE]));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const armOf = (seed) => Autopilot.prototype.travelArmFor.call(null, seed);

console.log('what counts as a journey');
{
  ok('one room boundary is zoning, not a trip', !isTravelTrip({ legs: 1 }));
  ok('zero room changes are not a trip either', !isTravelTrip({ legs: 0 }));
  ok('two or more room changes are a trip', isTravelTrip({ legs: 2 }));
  ok('legacy rows with no leg count are retained rather than guessed away', isTravelTrip({}));
}

console.log('\nthe split');
{
  let hold = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) if (armOf(`t${i % 21}-${i}-${1786000000000 + i * 137}`) === 'hold') hold++;
  const share = hold / N;
  // At n=200,000 the standard error is 0.11%, so a fair coin lands inside 0.5% almost
  // always and a tighter bound would fail on noise a few runs in a row. The imbalance that
  // would actually matter to a rare-event experiment is percent-scale, not this.
  ok('it is a coin, within half a percent', Math.abs(share - 0.5) < 0.005,
     `got ${(share * 100).toFixed(2)}%`);

  // THE BUG THIS CAUGHT. FNV-1a's last step multiplies by an odd constant, so its low bit
  // is (running hash) XOR (last character) and nothing else in the seed reaches it. Seeds
  // differing only in their final character alternated arms exactly.
  const tails = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(t => armOf('same-prefix-' + t));
  ok('THE ARM IS NOT DECIDED BY THE LAST CHARACTER — with the old hash these alternated ' +
     'in lockstep with its parity, which meant the experiment was randomising on one bit ' +
     'of the clock and the character was contributing nothing',
     !tails.every((a, i) => (a === 'hold') === (i % 2 === 1)));

  // THE ONE THAT MATTERS. A split that is 50/50 overall can still put one character almost
  // entirely in one arm, and the characters differ by max health, hunting ground and
  // strategy — so that would be a fact about Kermit, not about holding at walls.
  let worst = 0, worstWho = null;
  for (const who of ['Kermit', 'Piggy', 'Lew', 'Gonzo', 'Sweetums', 'Rizzo', 'Camilla']) {
    let h = 0;
    for (let i = 0; i < 20000; i++) if (armOf(`${who}-${i}-${1786000000000 + i * 911}`) === 'hold') h++;
    const d = Math.abs(h / 20000 - 0.5);
    if (d > worst) { worst = d; worstWho = who; }
  }
  ok('NO CHARACTER SITS IN ONE ARM — every one of them is within 2% of even, so the ' +
     'comparison is within-character and the differences between them cancel',
     worst < 0.02, `worst was ${worstWho} at ${(worst * 100).toFixed(1)}% off`);

  ok('it is stable — asking twice gives the same answer, so a decision re-evaluated ' +
     'mid-journey cannot flip arms', armOf('Kermit-7-1786000000000') === armOf('Kermit-7-1786000000000'));
  ok('and it is not stable across journeys, which is the point',
     new Set(Array.from({ length: 40 }, (_, i) => armOf(`Kermit-${i}-17860000000${i}`))).size === 2);
}

console.log('\nthe test that decides when to believe it');
{
  ok('no data, no answer', twoProportion(0, 0, 0, 0) === null);
  ok('identical rates are not a finding',
     twoProportion(10, 1000, 10, 1000).p > 0.99);
  // The shape of a real early result: one death each, a couple of thousand journeys.
  const early = twoProportion(1, 2000, 1, 2000);
  ok('ONE DEATH IN EACH ARM IS NOT A RESULT, however tempting the ratio looks',
     early.p > 0.9, `p = ${early?.p?.toFixed(3)}`);
  // And the shape of a real finding: a halving, with enough events behind it.
  const real = twoProportion(40, 20000, 18, 20000);
  ok('a halving on 58 deaths is', real.p < 0.01, `p = ${real?.p?.toFixed(4)}`);
  ok('the sign is right — fewer deaths in the second arm gives a positive z',
     twoProportion(40, 20000, 18, 20000).z > 0);
  ok('a zero-death window does not divide by zero', twoProportion(0, 500, 0, 500) === null);
}

console.log('\nhow much longer to run');
{
  // Standard two-proportion sizing. The absolute values matter less than the shape: a
  // smaller effect must need more events, and every answer must be a usable number.
  const half = eventsNeeded(0.5), quarter = eventsNeeded(0.25), most = eventsNeeded(0.75);
  ok('detecting a halving needs tens of deaths, not hundreds', half > 15 && half < 60, `got ${half}`);
  ok('A SMALLER EFFECT NEEDS MORE EVIDENCE, which is the property that stops this being ' +
     'used to justify stopping early', quarter > half && half > most,
     `${quarter} > ${half} > ${most}`);
  ok('all of them are finite and positive',
     [0.1, 0.25, 0.5, 0.75, 0.9].every(r => Number.isFinite(eventsNeeded(r)) && eventsNeeded(r) > 0));
}

console.log('\nthe gate that decides a candidate moment');
{
  // A stub keeper: travelHoldCandidate reads only vitals, the policy and what is in reach.
  // A ROOM IS PART OF THE STUB NOW, because the gate asks who else is standing here — see
  // the PvP section below. `objects` is the client's own map, keyed by id.
  const keeper = (health, max, vigor, inReach = 0, { policy = {}, players = [] } = {}) => ({
    policy,
    s: { client: {
      selfId: 99,
      vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }),
      rsc: { get: (r) => players.find(p => p.nameRsc === r)?.name ?? null },
      room: { objects: new Map(players.map(p => [p.id, p])) },
    } },
    inReachOfUs: () => Array.from({ length: inReach }, (_, i) => ({ id: i })),
    travelHoldCandidate: Autopilot.prototype.travelHoldCandidate,
  });
  const ask = (k, remaining = 3) => k.travelHoldCandidate({ remaining });

  ok('hurt, rested, nothing in reach, rooms to go — that is the case this exists for',
     ask(keeper(20, 44, 150)).candidate === true);
  ok('healthy enough is not a candidate', ask(keeper(40, 44, 150)).candidate === false);
  ok('ARRIVING HURT IS FINE — the last room of a journey is somebody else\'s decision',
     ask(keeper(20, 44, 150), 0).candidate === false);
  // TOO TIRED FOR THE POINTS TO COME. Health returns at a rate set by vigor, so below the
  // floor a top-up costs longer than the journey and buys nothing.
  //
  // THE FLOOR IS 80, NOT 100, AND THIS ASSERTION SPENT A WHILE RED ABOUT IT. Resting caps
  // at REST_VIGOR_CAP (80 of 200) and everything above has to be EATEN, so a fleet that
  // cannot cook sits at exactly 80 for ever — and a floor of 100 meant the hold NEVER FIRED
  // for any of them. The default moved and the test did not, which is a test asserting a
  // behaviour nothing has shipped.
  ok('TOO TIRED FOR THE POINTS TO COME — below the floor a top-up costs more than it buys',
     ask(keeper(20, 44, 40)).candidate === false &&
     /too tired/.test(ask(keeper(20, 44, 40)).why));
  ok('AND 80 IS NOT TOO TIRED, because 80 is where an unfed fleet lives',
     ask(keeper(20, 44, 80)).candidate === true);
  ok('something already swinging is a fight, not a pause — the ordinary pass is better ' +
     'at both halves of that than a hold is',
     ask(keeper(20, 44, 150, 2)).candidate === false);
  ok('unreadable health refuses rather than guessing',
     ask({ ...keeper(20, 44, 150), s: { client: { vitals: () => ({}) } } }).candidate === false);
  ok('and every refusal says why, because a gate that silently never fires is an ' +
     'experiment that measures nothing',
     [keeper(40, 44, 150), keeper(20, 44, 40), keeper(20, 44, 150, 2)]
       .every(k => typeof ask(k).why === 'string' && ask(k).why.length > 0));
}

console.log('\na wall stops monsters, not people');
{
  // WHY THIS OUTRANKS BEING HURT. A safe spot works because a creature cannot path to it;
  // that says nothing whatever about a player, who can walk to the same square, swing
  // first, and take the pack. Standing still for a minute and a half with a full inventory
  // is the best target this game offers, so the trade inverts: dying to the troll while
  // running costs the walk back, dying to the player costs everything carried.
  const stranger = { id: 7, flags: OF.PLAYER, nameRsc: 700, name: 'SomebodyElse' };
  const mate = { id: 8, flags: OF.PLAYER, nameRsc: 800, name: FLEETMATE };
  const keeper = (players, policy = {}) => ({
    policy,
    s: { client: {
      selfId: 99,
      vitals: () => ({ health: { value: 20, max: 44 }, vigor: { value: 150 } }),
      rsc: { get: (r) => players.find(p => p.nameRsc === r)?.name ?? null },
      room: { objects: new Map(players.map(p => [p.id, p])) },
    } },
    inReachOfUs: () => [],
    travelHoldCandidate: Autopilot.prototype.travelHoldCandidate,
  });
  const ask = k => k.travelHoldCandidate({ remaining: 3 });

  ok('a stranger in the room cancels the hold', ask(keeper([stranger])).candidate === false);
  ok('and says so in words a person can grep for',
     /a wall stops\s+monsters, not people|not ours/.test(ask(keeper([stranger])).why));
  ok('an empty room still holds', ask(keeper([])).candidate === true);
  ok('a FLEETMATE is not a threat — twenty-one of our own walk the same road',
     ask(keeper([mate])).candidate === true);
  ok('"ignore" restores the behaviour from before this existed',
     ask(keeper([stranger], { travelHoldPvp: 'ignore' })).candidate === true);
  ok('"room" counts the player standing here', ask(keeper([stranger], { travelHoldPvp: 'room' })).candidate === false);
}

console.log('\n"on" means on, which it did not');
{
  // `travelHold` checks the mode for 'off' and 'observe' and then honours `arm === "walk"`
  // whatever the mode says. So `travel_hold: "on"` was accepted, stored, reported back by
  // `autopilot status`, and left the coin in charge: the shadow fleet ran an evening with
  // it set on all twenty-one characters and the ledger holds THREE hold events for the day,
  // two of them the control arm. `'on'` was not even in the tool's own enum.
  const armFor = (mode) => {
    const holdMode = mode ?? 'ab';
    return holdMode === 'on' ? 'hold' : holdMode === 'off' ? 'walk' : armOf('seed-' + mode);
  };
  ok('"on" always takes the hold arm', armFor('on') === 'hold');
  ok('"off" never does', armFor('off') === 'walk');
  ok('and the experiment still flips for "ab"',
     new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(x => armOf('ab-' + x))).size === 2);
  // The source is the contract: if the forcing line ever comes out of travel(), this goes red.
  ok('travel() derives the arm from the mode rather than always rolling',
     /holdMode === 'on' \? 'hold'/.test(AUTOPILOT_SRC));
}

console.log('\ndo not set out hurt from a place that is free to heal in');
{
  // AN INN IS THE ONE PLACE HEALING IS FREE. Nothing spawns there and nothing can reach
  // you, so the points that cost eighty-seven exposed seconds at a wall in the Cragged
  // Mountains cost nothing at all here — and it is exactly where a character stands after
  // coming out of the Underworld, which is when something next asks it to cross the world.
  const keeper = ({ health = 20, max = 44, vigor = 40, safe = true, policy = {},
                    inReach = 0 } = {}) => {
    const notes = [];
    return {
      policy, notes,
      settled: 0, restedTo: null,
      s: { world: { room: { num: safe ? 202 : 598, name: safe ? 'The Limping Toad' : 'The Cragged Mountains' } },
           client: { vitals: () => ({ health: { value: health, max },
                                      vigor: { value: vigor, scale_max: 200 } }) } },
      sanctuary: () => safe,
      inReachOfUs: () => Array.from({ length: inReach }, (_, i) => ({ id: i })),
      note: (what, detail) => notes.push({ what, detail }),
      async settle() { this.settled++; },
      restBeforeSettingOut: Autopilot.prototype.restBeforeSettingOut,
    };
  };

  // `restUntil` is the module's, so the fixture cannot drive it — what is asserted here is
  // the GATE, which is the part that was missing and the part an operator sets.
  const ask = async (k) => {
    const before = k.notes.length;
    let threw = null;
    try { await k.restBeforeSettingOut(); } catch (e) { threw = e; }
    return { note: k.notes[before] ?? null, threw, k };
  };

  const decided = await ask(keeper({ health: 20, max: 44 }));
  ok('hurt, in an inn, nothing in reach — it rests before setting out',
     /resting before setting out/.test(decided.note?.what ?? ''));
  ok('and says vigor stops at the resting cap, because everything above it is eaten',
     /resting cap/.test(JSON.stringify(decided.note?.detail ?? {})));

  const full = await ask(keeper({ health: 44, max: 44, vigor: 80 }));
  ok('already fit — it just goes', full.note === null);

  const outdoors = await ask(keeper({ health: 20, max: 44, safe: false }));
  ok('SOMEWHERE HOSTILE IT DOES NOT SIT DOWN — that is how characters die, and the ' +
     'ordinary survival ladder decides there instead', outdoors.note === null);

  const fighting = await ask(keeper({ health: 20, max: 44, inReach: 2 }));
  ok('something already swinging makes this a fight, not a pause', fighting.note === null);

  const off = await ask(keeper({ health: 20, max: 44, policy: { travelStartHealth: 0 } }));
  ok('travel_start_health 0 switches it off', off.note === null);

  // VIGOR ALONE IS ENOUGH TO JUSTIFY A SIT. A character at full health and 20 vigor heals
  // at a crawl for the rest of the journey, which is the whole reason vigor is in the gate.
  const tired = await ask(keeper({ health: 44, max: 44, vigor: 20 }));
  ok('full health but low vigor still rests, because vigor IS the healing rate',
     /resting before setting out/.test(tired.note?.what ?? ''));

  // The fraction bug that would have made this permanently on: REST_VIGOR_CAP is 0.4, a
  // fraction of 200, and comparing it against a raw vigor value makes every gate pass.
  ok('the vigor comparison is a fraction, not a raw value',
     /vigorPct\(v\)/.test(AUTOPILOT_SRC) &&
     !/vig >= wantVigor[\s\S]{0,40}vigor\?\.value/.test(AUTOPILOT_SRC));
}

console.log('');
console.log('a refusal leaves a trace');
{
  // The gate has six ways to say no and the caller used to throw all six away, so a window
  // with 1,599 journeys and 13 deaths held FOUR hold decisions and could not answer the only
  // question worth asking of it: did the characters that died try to shelter at a wall?
  //
  // These pin which refusals earn a line -- the ones where the character WANTED to stop,
  // hurt and mid-journey, and something else turned it away -- and which must stay silent.
  // A healthy character not stopping is the system working; writing that would put a row on
  // every hop of every journey and drown the rows that matter.
  const events = [];
  const keeper = {
    policy: { travelHold: 'on', travelHoldBelow: 0.75 },
    ledgerEvent: (kind, rec) => events.push({ kind, ...rec }),
    travelHoldCandidate: null,
    inReachOfUs: () => [],
    s: { client: null, world: null },
    book: null,
    note: () => {},
  };
  const mid = { journey: 'j1', room: { num: 578, name: 'The Cragged Mountains' },
                hops_done: 3, remaining: 4 };
  const run = async (look, at = mid) => {
    events.length = 0;
    keeper.travelHoldCandidate = () => look;
    await Autopilot.prototype.travelHold.call(keeper, at, 'hold');
    return events;
  };

  let e = await run({ candidate: false, why: 'vigor 40 -- too tired for the points to come',
                      frac: 0.4, health: 20, max: 50, vigor: 40 });
  ok('a hurt character refused for vigor is recorded', e.length === 1, JSON.stringify(e));
  ok('and says it never got as far as looking', e[0] && e[0].did === 'did not consider a wall');
  ok('and carries the reason the gate gave, not a summary', !!e[0] && /vigor 40/.test(e[0].why));
  ok('and keeps the vitals that explain it', !!e[0] && e[0].health === 20 && e[0].vigor === 40);

  e = await run({ candidate: false, why: '3 already in reach -- this is a fight, not a pause',
                  frac: 0.3, health: 15, max: 50 });
  ok('refused because something is already swinging is recorded too', e.length === 1);
  ok('with that reason intact', !!e[0] && /in reach/.test(e[0].why));

  e = await run({ candidate: false, why: 'healthy enough (92%)', frac: 0.92, health: 46, max: 50 });
  ok('a healthy character not stopping writes nothing', e.length === 0, JSON.stringify(e));

  e = await run({ candidate: false, why: 'last room of the journey', frac: 0.3, health: 15, max: 50 },
                { ...mid, remaining: 0 });
  ok('arriving hurt at the destination is not a refusal to shelter', e.length === 0);

  e = await run({ candidate: false, why: 'health unreadable' });
  ok('an unreadable vital is not counted as a refusal either', e.length === 0);

  // OFF MEANS OFF, and it must stay ahead of the recording: a fleet that has switched the
  // feature off is not refusing anything and should not be filling a ledger with rows.
  keeper.policy = { travelHold: 'off', travelHoldBelow: 0.75 };
  e = await run({ candidate: false, why: 'vigor 40 -- too tired', frac: 0.4, health: 20, max: 50 });
  ok('with the hold switched off nothing is recorded at all', e.length === 0);
  keeper.policy = { travelHold: 'on', travelHoldBelow: 0.75 };
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
