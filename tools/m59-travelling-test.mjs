#!/usr/bin/env node
// A JOURNEY STEERS A CHARACTER. IT DOES NOT SWITCH OFF ITS WILL TO LIVE.
//
//   node tools/m59-travelling-test.mjs
//
// Offline. No socket, no broker, no roster — safe any time.
//
// ======================== THE DEATH THIS SUITE IS BUILT FROM ========================
//
// Cccc, shadow fleet, 2026-08-21T02:30:25Z. The record, second by second, because every
// assertion below is one line of it:
//
//   02:27:31  dies in the Cragged Mountains. Wakes in the Underworld at 2 of 37.
//   02:29:13  a commute driver polls, sees him "stuck in room 1" — which is the Underworld
//             — and re-sends `travel`. `travelJob` calls goInert. THE SURVIVAL LADDER IS
//             NOW OFF for the length of the walk.
//   02:29:31  the keeper escapes the Underworld (the one thing above the inert gate) into
//             the Limping Toad Inn, a sanctuary, at 11 of 37.
//   02:29:40  "You open the door and walk through." The journey walks him back OUT of the
//             inn at 30% health, against a flee threshold of 70%.
//   02:30:00  enters West Merchant Way through Ilerian Woods. Six things in the room.
//   02:30:00  ...to 02:30:23. Twenty-two seconds. Health 10, 8, 6, 4, 3. Pulses read
//             23,3 / 25,5 / 26,5 / 25,5 — a two-square shuffle against a wall.
//   02:30:19  the old rescue finally fires, 5.1 seconds before the end, because it also
//             required four seconds of STILLNESS and the shuffle reset that timer on
//             every sample.
//   02:30:23  "### Cccc was just killed by a giant rat."
//
// Nothing in the survival ladder was broken. The ladder was switched off, deliberately, by
// a state that means "somebody else is driving" being used for a driver that only steers.
//
// So this suite pins two properties, and both of them erode silently:
//
//   1. THE STATE IS DIFFERENT FROM INERT. A journey takes `goTravelling`, an errand takes
//      `goInert`, and a journey may not quietly upgrade itself into the errand's silence.
//   2. THE TRIGGERS DO NOT ASK WHETHER THE BODY IS MOVING. Below the flee line with
//      something adjacent is enough; so is losing health fast enough that the bar empties
//      before the road ends. A character being eaten while it walks is in exactly as much
//      trouble as one being eaten while it stands, and it is harder to see.
//
// It should fail the day somebody makes a journey blind again.

import { Autopilot, TRAVEL_GUARD_DEFAULTS, TRAVEL_GUARD_KEYS, TRAVEL_GUARD_CLOCK,
         PASS_STAGES, HANDLED, CONTINUE } from './m59-autopilot.mjs';
// The real flag values rather than numbers written out here. A fixture that hardcodes
// 0x200 for ATTACKABLE builds a room full of things the code under test cannot see, and
// then passes every assertion that expects nothing to happen.
import { OF } from './m59-parse.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const AUTOPILOT_SRC = readFileSync('tools/m59-autopilot.mjs', 'utf8');
const BROKER_SRC = readFileSync('tools/m59-broker.mjs', 'utf8');

// A keeper with no session behind it.
//
// The prototype rather than `new Autopilot(...)`, for the same reason m59-unattended-test
// does it: a real constructor wants a session, which wants a socket, which wants a server,
// and the whole value of this suite is that it runs on a laptop with nothing up.
//
// `who()` resolves to null here on purpose — `recordEvent` is a no-op for a nameless
// character, so a test that exercises a take-back does not append to the real ledger.
const keeper = ({ health = 30, max = 37, vigor = 80, adjacent = 0, players = 0, armed = true,
                  fleeAt = 0.7, guard = null, policy = {}, pulses = null } = {}) => {
  const notes = [];
  const objects = new Map();
  // A monster carries ATTACKABLE and not PLAYER. That distinction is load-bearing
  // everywhere in this file — every character is ATTACKABLE, and the fleet walks the same
  // roads — so the fixture builds it from the real flags.
  for (let i = 0; i < adjacent; i++)
    objects.set(i + 10, { id: i + 10, flags: OF.ATTACKABLE, col: 25, row: 5, nameRsc: 1 });
  // A STRANGER IS A PLAYER THAT IS NOT ONE OF OURS, and it needs BOTH flags: the room
  // filter asks for PLAYER and ATTACKABLE together. `rsc` is absent from this fixture, so
  // the name lookup yields undefined and `party.isFleetmate` says no — which is what makes
  // these strangers rather than fleetmates.
  for (let i = 0; i < players; i++)
    objects.set(i + 90, { id: i + 90, flags: OF.PLAYER | OF.ATTACKABLE, col: 25, row: 5, nameRsc: 2 });
  const self = { id: 1, col: 25, row: 5 };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, policy, claims: new Map(), passes: 1,
    tally: {}, doing: 'travelling',
    book: { save: () => {} },
    watch: { pulses: pulses ?? [], wedges: 0 },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {},
    noProgress: () => {},
    recordFrame: () => {},
    armed: () => armed,
    safety: () => ({ fleeAt }),
    ledgerEvent: () => {},
    s: {
      name: null,
      cancelMovement: () => ({ cancelled: true, interrupted: { kind: 'travel', label: 'walk to 39' } }),
      world: { room: { num: 535, name: 'West Merchant Way through Ilerian Woods' } },
      client: {
        selfId: 1, self,
        room: { objects },
        vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }),
      },
    },
  });
  if (guard) k.inert = { why: 'travelling to Upstairs in Castle Victoria', at: Date.now(),
                         maxMs: 900_000, travelling: true, guard: k.travelGuard(guard) };
  return k;
};

// The context the pass ladder hands every stage.
const ctxFor = k => {
  const v = k.s.client.vitals();
  return { s: k.s, c: k.s.client, room: k.s.world.room, v,
           hp: v.health.max ? v.health.value / v.health.max : null };
};

// Pulses shaped like the real ring: `n` samples one second apart, health falling by
// `perSample`, and — unless `still` — shuffling between two squares the way Cccc did.
const ring = ({ n = 6, from = 10, perSample = 0.5, still = false } = {}) => {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    at: now - (n - 1 - i) * 1000,
    room: 535,
    col: still ? 25 : (i % 2 ? 26 : 25),
    row: 5,
    health: Math.round(from - i * perSample),
    doing: 'travelling',
  }));
};

// ---------------------------------------------------------------------------
console.log('\nthe guard: what a journey leaves switched on');
{
  // FIVE, not six. `play_dead` was removed 2026-08-21: it cancelled a journey so the
  // ordinary ladder could freeze, and freezing is now refused anywhere but a proven safe
  // spot because it recovers vigor and NEVER health. The doomed rung it gated still exists
  // and is gated on `flee` instead — see "inside two hits of death" below.
  ok('all five faculties default to ON — a character with no opinion still defends itself',
     TRAVEL_GUARD_KEYS.length === 5 && TRAVEL_GUARD_KEYS.every(key => TRAVEL_GUARD_DEFAULTS[key] === true),
     JSON.stringify(TRAVEL_GUARD_DEFAULTS));
  ok('and every one of them says which clock it is on',
     TRAVEL_GUARD_KEYS.every(key => ['mid-hop', 'hop boundary', 'both'].includes(TRAVEL_GUARD_CLOCK[key])),
     JSON.stringify(TRAVEL_GUARD_CLOCK));
  // NOTHING IS ON BOTH ANY MORE, AND THE REASON IS WHAT MID-HOP COSTS.
  //
  // `safe_spot` was 'both' on a real argument — the Cragged Mountains is 2,450 squares and
  // kills a character long before it offers a boundary to be asked at. What that argument
  // missed is that the only thing a mid-hop trigger CAN do is cancel the crossing: the mover
  // has the body. Firing on any damage in a zone that outranks the character then tore the
  // crossing down at step 0 of 40, over and over, and a shelter that prevents arrival is not
  // shelter. One faculty on one clock, and the wall pauses at the boundary instead.
  // CORRECTED 2026-08-23. The line above is the argument as it stood, and the half of it
  // that has since become false is "cancelling is the cost". A cancelled journey used to be
  // a LOST journey; f245be5 made one that ends short keep its destination, and a4bb63f fixed
  // the rung that resumes it — `passErrand`'s idle catch-all ended every tick before
  // `passFarm` was ever reached, so the resume had never once fired in the life of this
  // repository. It fires now. Mid-hop is therefore a pause by a slower route.
  //
  // And the thing that actually made mid-hop unaffordable was never the clock: it was
  // `travelShelterBelow` returning 1 — shelter at any damage at all — in a zone that
  // outranks the character, which the Twisted Wood does continuously. Fixed at its source.
  ok('the wall is on BOTH clocks, because a mid-hop cancel now keeps its objective',
     TRAVEL_GUARD_CLOCK.safe_spot === 'both', JSON.stringify(TRAVEL_GUARD_CLOCK));
  ok('and it is the only faculty that is, because it is the only one that can be resumed',
     TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'both').join() === 'safe_spot',
     JSON.stringify(TRAVEL_GUARD_CLOCK));
  // A THRESHOLD OF 1 IS NOT A THRESHOLD, and that is the assertion that would have stopped
  // the whole detour. A dangerous room is a reason to shelter EARLIER, not at full health.
  // CORRECTED AGAIN, SAME DAY, AND DELIBERATELY LEFT AS A TRAIL RATHER THAN TIDIED.
  //
  // This line first said "nothing is on both clocks". Then it said "an outranking room
  // shelters earlier rather than at any scratch", asserting that the threshold was no longer
  // 1. It is 1 again, and the operator's argument for that is the one that holds:
  //
  //   What made a sensitive trigger unaffordable was never its sensitivity. It was that the
  //   shelter it triggered never COMPLETED — the search only considered coarse-walkable
  //   squares, so every spot in the book was ordinary floor, eighteen steps away, and a stop
  //   bought nothing. Standing on grass does not stop anything, so the rung fired again
  //   immediately and the crossing was torn down thirty times in a leg.
  //
  // With the spot a real wall 2.2 squares away and the cancel keeping its destination, a
  // stop costs a few seconds and returns full health behind geometry nothing can path to.
  // Against rooms that cross in fifteen to twenty-five seconds, that is cheap against any
  // chance of dying.
  //
  // So what is pinned now is the LOOP GUARD, because that is what carries the load once the
  // threshold stops trying to: a per-room budget, with the doomed case exempt from it.
  ok('any damage is enough to want a wall — the threshold is not doing the rationing',
     /travelWallBelowOutranked \?\? 1/.test(AUTOPILOT_SRC)
     && /travelWallBelow \?\? 1\)/.test(AUTOPILOT_SRC));
  ok('and the per-room budget is what stops a hostile room looping',
     /travelShelterPerRoom \?\? 4/.test(AUTOPILOT_SRC));
  // The split is what keeps "only one thing drives a body" true, so it is pinned rather
  // than left to a comment: the four that CANCEL a journey and the two that PAUSE it.
  const midHop = TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'mid-hop');
  ok('the three that interrupt a journey are the mid-hop ones',
     JSON.stringify(midHop.sort()) === JSON.stringify(['arm', 'fight_back', 'flee']),
     JSON.stringify(midHop));
  const boundary = TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'hop boundary');
  ok('and resting is the one that only ever pauses',
     JSON.stringify(boundary.sort()) === JSON.stringify(['rest']),
     JSON.stringify(boundary));

  const k = keeper({ policy: { travelGuard: { flee: false } } });
  ok('a policy switch turns exactly one faculty off', k.travelGuard().flee === false);
  ok('and leaves the other five alone',
     TRAVEL_GUARD_KEYS.filter(key => key !== 'flee').every(key => k.travelGuard()[key] === true));
  ok('an explicit override beats the policy',
     k.travelGuard({ flee: true }).flee === true);
  // The rule from docs/m59-policy.md: an unrecognised key is never merged into a shape the
  // rest of the file would read as a real faculty. The TOOL refuses it; this refuses to
  // carry it.
  ok('an unrecognised faculty is dropped rather than carried into the shape',
     !('teleport' in keeper({ policy: { travelGuard: { teleport: true } } }).travelGuard()));
}

// ---------------------------------------------------------------------------
console.log('\ntravelling is not inert, and cannot become it by accident');
{
  const k = keeper();
  k.goTravelling('travelling to Upstairs in Castle Victoria');
  ok('goTravelling marks the hold as a journey', k.inert?.travelling === true);
  ok('and `travelling` reads it back', !!k.travelling);
  ok('and it still reads as held to everything that asks the old question',
     k.inertStatus()?.inert === true);
  ok('the status says which stand-down it is', k.inertStatus()?.state === 'travelling');
  ok('and lists what is still allowed, so an operator can see it before a death',
     Array.isArray(k.inertStatus()?.may_still) && k.inertStatus().may_still.length === 5);

  const errand = keeper();
  errand.goInert('m59-outfit: buying a weapon');
  ok('goInert is still blind — an errand asked for silence and gets it',
     errand.inert && !errand.inert.travelling && errand.travelling === null);
  ok('and refuses every faculty', TRAVEL_GUARD_KEYS.every(key => errand.travelAllows(key) === false));
  // A journey must not be able to take a character an errand already holds and quietly
  // hand its survival back — the errand is the one that knows why it wanted silence.
  errand.goTravelling('travelling to somewhere else');
  ok('a journey cannot upgrade an errand hold into a travelling one',
     errand.inert.travelling !== true);

  const free = keeper();
  ok('with nothing holding it, every faculty is allowed',
     TRAVEL_GUARD_KEYS.every(key => free.travelAllows(key) === true));
}

// ---------------------------------------------------------------------------
console.log('\nthe damage rate — the instrument that replaces stillness');
{
  const k = keeper({ health: 10, max: 37, pulses: ring({ from: 10, perSample: 0.5 }) });
  const rate = k.damageRate();
  ok('reads about half a point a second off the pulse ring — the rate that killed Cccc',
     rate !== null && Math.abs(rate - 0.5) < 0.15, String(rate));
  // Cccc had 10 health left and was losing about half a point a second, so roughly twenty
  // seconds. He died twenty-two seconds after entering the room.
  ok('and turns it into a time to death — about twenty seconds, which is what he had',
     Math.abs(k.timeToDeath() - 20_000) < 6_000, String(k.timeToDeath()));

  const steady = keeper({ pulses: ring({ from: 30, perSample: 0 }) });
  ok('a character that is not losing health has no rate', steady.damageRate() === 0);
  ok('and no time to death', steady.timeToDeath() === null);
  const healing = keeper({ pulses: ring({ from: 10, perSample: -1 }) });
  ok('and one that is HEALING is never reported as dying', healing.damageRate() === 0);
  ok('too little ring to say is null, not zero',
     keeper({ pulses: ring({ n: 2 }) }).damageRate() === null);

  // THE WHOLE POINT. The ring got wider so a rate could be read from it, and the two
  // movement tests must not have widened with it — `pennedIn` gets STRICTER as the ring
  // grows, so a careless edit here switches off the handbrake it feeds.
  ok('pennedIn still reads only the newest few samples',
     /w\.pulses\.slice\(-PULSE_MOVEMENT_SAMPLES\)/.test(AUTOPILOT_SRC));
}

// ---------------------------------------------------------------------------
console.log('\nthe triggers — none of them ask whether the body is moving');
{
  // A JOURNEY IS ONLY ABANDONED FOR A PLAYER — everything else PAUSES to take a wall and
  // carries on afterwards (operator's rule, 2026-08-21). Both outcomes cancel the movement
  // and return CONTINUE, so `took` is still the right question for "did the ladder get the
  // character back"; what changed is that the note says which of the two it was, and
  // whether the objective survived.
  const run = async k => {
    const verdict = await k.passTravelling(ctxFor(k));
    const notes = k.notes;
    const paused = notes.some(n => /^PAUSED THE JOURNEY/.test(n.what ?? ''));
    const abandoned = notes.some(n => /^ABANDONED THE JOURNEY/.test(n.what ?? ''));
    return { verdict, took: verdict === CONTINUE, notes,
             tookBack: paused || abandoned, paused, abandoned,
             kept: k.suspendedJourney != null };
  };

  // ---- CCCC'S EXACT SITUATION, and the one the old rescue could not see. 10 of 37 is
  // 27%, the flee line is 70%, six things in the room — and the pulses are SHUFFLING
  // between 25,5 and 26,5, which is what reset the four-second stillness timer over and
  // over while he was eaten.
  const cccc = keeper({ health: 10, max: 37, adjacent: 6, fleeAt: 0.7,
                        guard: {}, pulses: ring({ from: 10, perSample: 0.5 }) });
  const r = await run(cccc);
  ok('a shuffling character below the flee line with things adjacent IS taken back',
     r.took && r.tookBack, JSON.stringify(r.verdict));
  ok('and the journey is cancelled rather than fought for',
     cccc.notes.some(n => n.detail?.interrupted?.kind === 'travel'));
  ok('and the keeper is driving again on the same pass', cccc.inert === null);
  ok('and it decides nothing itself — the ordinary ladder does',
     cccc.notes.some(n => /ordinary ladder runs/.test(n.detail?.note ?? '')));
  // SIX MONSTERS AND NO PLAYER, SO THE JOURNEY IS NOT GIVEN UP. This is the operator's
  // rule of 2026-08-21 and the reason the note names two different acts: the movement
  // stops so the ladder can put a wall at his back, and the destination is kept so he
  // walks on once he is whole. Abandoning is for a person being on us, and nothing else.
  ok('a MONSTER pauses the journey rather than ending it', r.paused && !r.abandoned,
     JSON.stringify({ paused: r.paused, abandoned: r.abandoned }));

  // THE SWITCH HAS TO ACTUALLY WORK, or it is decoration. Isolating the flee trigger needs
  // a character below the flee line and NOT inside two hits of death, or `play_dead` fires
  // instead and the pair proves nothing: worstHit is min(30, floor((max+2)/3)), so a
  // 60-health character is doomed at 40 and flees at 42. 41 sits in the one-point gap
  // between them. (Cccc at 10 of 37 was below BOTH, which is why the case above is taken
  // back whichever of the two you switch off — and is the right answer for him.)
  const bracket = { health: 41, max: 60, adjacent: 2, fleeAt: 0.7,
                    pulses: ring({ from: 41, perSample: 0 }) };
  // AND MONSTERS DO NOT REACH THIS RUNG, WHICH IS THE POINT OF IT.
  //
  // I asserted the opposite here and was wrong, and the way it was wrong is worth keeping:
  // rung 4 tests `worthEnding`, and under the default `travel_flee_from: 'players'` that
  // list is STRANGERS ONLY. Two monsters adjacent, below the flee line, is not this rung's
  // business — being bitten on the road is the ordinary condition of travel, and the answer
  // to it is the WALL rung above, which pauses and keeps the objective.
  //
  // That is the operator's rule stated as code: never abandon a journey unless a PLAYER is
  // attacking. A test that expects a monster to end a journey is asking for the behaviour
  // that made trips accumulate the same damage in both directions and never arrive.
  const monstersOnly = keeper({ ...bracket, guard: {} });
  const rMon = await run(monstersOnly);
  ok('below the flee line with MONSTERS on us, the flee rung does not fire — the wall does',
     !monstersOnly.notes.some(n => n.detail?.trigger === 'below the flee line with someone adjacent'),
     JSON.stringify(monstersOnly.notes.map(n => n.detail?.trigger)));
  ok('and the journey is not abandoned for them', !rMon.abandoned);
  // A STRANGER IS A DIFFERENT FACT. A wall stops monsters and says nothing about a person,
  // who can walk to the same square, swing first and take the pack.
  const willFlee = keeper({ ...bracket, adjacent: 0, players: 2, guard: {} });
  ok('below the flee line with a STRANGER adjacent, the flee trigger is the one that fires',
     (await run(willFlee)).took &&
     willFlee.notes.some(n => n.detail?.trigger === 'below the flee line with someone adjacent'),
     JSON.stringify(willFlee.notes.map(n => n.detail?.trigger)));
  const noFlee = keeper({ ...bracket, adjacent: 0, players: 2, guard: { flee: false } });
  const r2 = await run(noFlee);
  ok('and with flee switched off that same character walks on',
     !r2.took && r2.verdict === HANDLED);
  ok('and stays in the travelling state', !!noFlee.travelling);

  // ---- ABOVE THE FLEE LINE, BUT DYING FAST. Nothing adjacent in the room model at all,
  // so this can only fire on the rate.
  //
  // AND IT IS GATED ON A PERSON DOING IT, for the same reason rung 4 is: this rung is the
  // only one in the file that ABANDONS. A bar emptying under monsters is the road doing what
  // the road does — the wall rung answers that and keeps the objective. I asserted this one
  // wrongly too, in the same direction, which is what a rule is for.
  const bleedingMonsters = keeper({ health: 30, max: 37, adjacent: 2, fleeAt: 0.7, guard: {},
                                    pulses: ring({ from: 34, perSample: 4 }) });
  const rBleedMon = await run(bleedingMonsters);
  ok('a bar emptying under MONSTERS never abandons the journey', !rBleedMon.abandoned,
     JSON.stringify(bleedingMonsters.notes.map(n => n.detail?.trigger)));
  const bleeding = keeper({ health: 30, max: 37, adjacent: 0, players: 1, fleeAt: 0.7, guard: {},
                            pulses: ring({ from: 34, perSample: 4 }) });
  const r3 = await run(bleeding);
  ok('a STRANGER emptying the bar fast enough is taken back on the rate alone',
     r3.took && r3.tookBack, JSON.stringify(bleeding.notes.map(n => n.detail?.trigger)));
  ok('and says how long it had left', bleeding.notes.some(n => n.detail?.seconds_left != null));
  ok('and THIS is the one rung that abandons, because a wall does not stop a person',
     r3.abandoned);
  const noFight = keeper({ health: 30, max: 37, adjacent: 0, fleeAt: 0.7,
                           guard: { fight_back: false },
                           pulses: ring({ from: 34, perSample: 4 }) });
  ok('with fight_back off, a fast bleed does not interrupt the journey',
     !(await run(noFight)).took);

  // ---- TWO HITS FROM DEATH. worstHit is min(30, floor((max+2)/3)) = 13 for a 37-health
  // character, so 26 or below with something adjacent is the doomed case.
  const doomed = keeper({ health: 8, max: 37, adjacent: 1, fleeAt: 0.2, guard: {},
                          pulses: ring({ from: 8, perSample: 0 }) });
  const r4 = await run(doomed);
  ok('inside two hits of death it is taken back even with the flee line set low',
     r4.took && doomed.notes.some(n => n.detail?.trigger === 'two hits from death'));
  // The doomed rung is gated on `flee` now, not on a `play_dead` key that no longer
  // exists — so switching flee off is what leaves the decision to the journey.
  ok('and flee off leaves that decision to the journey',
     !(await run(keeper({ health: 8, max: 37, adjacent: 1, fleeAt: 0.2,
                          guard: { flee: false, fight_back: false },
                          pulses: ring({ from: 8, perSample: 0 }) }))).took);

  // ---- THE WEAPON IS GONE. Ahead of everything else, because being unarmed is WHY the
  // next room goes badly.
  const bare = keeper({ health: 36, max: 37, adjacent: 0, armed: false, guard: {},
                        pulses: ring({ from: 36, perSample: 0 }) });
  const r5 = await run(bare);
  ok('an unarmed character is taken back at full health', r5.took);
  ok('and the reason is the weapon, not the damage',
     bare.notes.some(n => n.detail?.trigger === 'unarmed'));
  ok('with arm off it walks on unarmed',
     !(await run(keeper({ health: 36, max: 37, armed: false, guard: { arm: false },
                          pulses: ring({ from: 36, perSample: 0 }) }))).took);

  // ---- NOTHING WRONG. The journey keeps the character, and this must not read as a stall
  // to the supervisor, which restarts keepers that report no progress.
  const fine = keeper({ health: 36, max: 37, adjacent: 0, guard: {},
                        pulses: ring({ from: 36, perSample: 0 }) });
  const r6 = await run(fine);
  ok('a healthy character on a quiet road is left alone', !r6.took && r6.verdict === HANDLED);
  ok('and is not taken back', !r6.tookBack);
  ok('and stays travelling', !!fine.travelling);
}

// ---------------------------------------------------------------------------
console.log('\nthe wiring — the parts a rename would silently break');
{
  // The gate in passUnderworld is what routes a travelling keeper into the restricted
  // ladder rather than into the blind `return HANDLED`. If this comes out, everything
  // above still passes and the fleet is back where it started.
  ok('the pass gate sends a travelling keeper to the restricted ladder',
     /\} else if \(this\.inert\.travelling\) \{/.test(AUTOPILOT_SRC) &&
     /await this\.passTravelling\(ctx\)/.test(AUTOPILOT_SRC));
  ok('and the ordinary stages run on the SAME pass after a take-back',
     /const verdict = await this\.passTravelling\(ctx\);\s*\n\s*if \(verdict !== CONTINUE\) return HANDLED;/
       .test(AUTOPILOT_SRC));
  ok('an errand still gets the blind branch',
     /this\.progress\('inert -- something else is driving'\);/.test(AUTOPILOT_SRC));

  // The broker half. `travelJob` is the one entry into the hop loop, and which stand-down
  // it takes is the whole difference between this suite passing and Cccc dying.
  ok('travelJob stands the keeper down as travelling', /goTravelling\(/.test(BROKER_SRC));
  ok('and travelJob does not reach for goInert',
     !/goTravelling[\s\S]{0,1200}goInert\(/.test(BROKER_SRC.slice(BROKER_SRC.indexOf('  travelJob(dest, {'))));
  // The result is CAPTURED rather than returned straight out, because the `finally` needs to
  // know whether the journey arrived: one that ended short keeps its destination so the resume
  // can pick it up, and one that arrived must not.
  ok('and it goes through the KEEPER travel, which carries the rest and the hop hook',
     /keeper && typeof keeper[.]travel === 'function'[)][\s\S]{0,40}outcome = await keeper[.]travel[(]/
       .test(BROKER_SRC));
  ok('and a journey that ended short keeps its destination for the resume',
     /suspendedJourney = [{][\s\S]{0,240}the travel job ended short/.test(BROKER_SRC));
  ok('while one that ARRIVED does not',
     /const arrived = outcome[?][.]arrived === true/.test(BROKER_SRC)
     && /if [(]!arrived && dest != null/.test(BROKER_SRC));
  ok('travel_guard is settable from the autopilot tool', /travel_guard: \{/.test(BROKER_SRC));
  ok('and an unknown faculty is refused rather than ignored',
     /travel_guard: no such faculty/.test(BROKER_SRC));

  // passTravelling is deliberately NOT in PASS_STAGES — it is reached only from the gate,
  // because a stage would run it on every pass including the ones where nothing holds the
  // character at all.
  ok('passTravelling is not a stage in its own right',
     !PASS_STAGES.includes('passTravelling'));
}

// ---------------------------------------------------------------------------
console.log('\nresting mid-journey stops at BOTH ceilings');
{
  // Cccc left the Limping Toad at 11 of 37 health and 11 of 200 vigor and never rose above
  // either. Vigor is not a nicety here: it sets the RATE health comes back at, so a
  // character that leaves an inn full but exhausted has no recovery left for the road.
  const src = AUTOPILOT_SRC.slice(AUTOPILOT_SRC.indexOf('  async travelRestAtSanctuary('));
  const body = src.slice(0, src.indexOf('\n  async restBeforeSettingOut('));
  ok('the sanctuary rest asks for a health target and a vigor target together',
     /restUntil\(this\.s, \{\s*\n\s*health: wantHealth, vigor: wantVigor,/.test(body));
  ok('and the vigor target is capped at what sitting can actually reach',
     /Math\.min\(this\.policy\.travelStartVigor \?\? REST_VIGOR_CAP, REST_VIGOR_CAP\)/.test(body));
  ok('and full health rather than travel_hold_to, because a sanctuary costs no exposure',
     /const wantHealth = this\.policy\.travelStartHealth \?\? 1;/.test(body));
  ok('it is asked at EVERY hop boundary, not once at the top of the journey',
     /await this\.travelRestAtSanctuary\(at, arm\)/.test(AUTOPILOT_SRC));
  ok('and it restores `doing` afterwards so the pulse keeps watching the road',
     /\} finally \{ this\.doing = wasDoing; \}/.test(body));
  ok('the pre-departure rest and the mid-journey one share one switch',
     /travel_guard\.rest is off for this character/.test(AUTOPILOT_SRC));
}

// ---------------------------------------------------------------------------
console.log('\nthe safe-wall A/B is retired');
{
  const k = keeper({ policy: { travelHold: 'ab' } });
  ok('ab is honoured as "on" rather than rolling a coin', k.travelHoldMode() === 'on');
  ok('half too', keeper({ policy: { travelHold: 'half' } }).travelHoldMode() === 'on');
  ok('and the remap is SAID, not silent',
     k.notes.some(n => /A\/B is retired/.test(n.what)));
  ok('once per keeper, not once per hop',
     (() => { const k2 = keeper({ policy: { travelHold: 'ab' } });
              k2.travelHoldMode(); k2.travelHoldMode(); k2.travelHoldMode();
              return k2.notes.filter(n => /A\/B is retired/.test(n.what)).length === 1; })());
  ok('off is still off — the one setting that stops a hold',
     keeper({ policy: { travelHold: 'off' } }).travelHoldMode() === 'off');
  ok('observe still only writes down what it would have done',
     keeper({ policy: { travelHold: 'observe' } }).travelHoldMode() === 'observe');
  ok('and the fleet default is to hold', /M59_TRAVEL_HOLD \|\| 'on'/.test(AUTOPILOT_SRC));
}


console.log('');
console.log('MID-HOP A WALL IS AN OPTION AGAIN — BECAUSE A CANCEL NO LONGER LOSES THE ROAD');
{
  // Room 587, measured: the body walked six squares of a 65-square baked rail, was taken
  // back for a wall, and started again. Thirty laps in one leg, with six refusals in two
  // hundred and thirty move attempts — nothing was blocked, it was being interrupted. Then,
  // with the interruption bounded, "cancelled at 0 of 40": step zero of forty.
  //
  // The cause is that mid-hop there is nothing else this rung can do. The mover has the
  // body; the keeper cannot walk to a wall without taking the body off the line first. And
  // `travelShelterBelow` returns 1 — ANY damage — in a zone that outranks the character,
  // which the Twisted Wood does for every character this fleet has. So the crossing was torn
  // down continuously, and a shelter that prevents arrival is not shelter.
  //
  // The wall is now the HOP BOUNDARY's business, where nothing is contended and the journey
  // PAUSES rather than ending. What follows pins both halves of that.
  const withPlan = extra => {
    const k = keeper({ adjacent: 2, guard: {}, ...extra });
    k.s.activeShelter = { atStep: 0, maxDetour: 4,
                          spots: [{ atStep: 1, detour: 2, col: 20, row: 5,
                                    refused_approaches: 3, proven: true }] };
    return k;
  };
  // `run` above is block-scoped; the stage is called directly here.
  const sheltered = async k => { await k.passTravelling(ctxFor(k)); return k.notes.some(n =>
    n.detail?.trigger === 'a wall is nearer than the next room'); };

  // CORRECTED 2026-08-23, AND THIS IS THE ASSERTION THAT WAS BACKWARDS.
  //
  // Hurt, in a zone that outranks us, something on us — it now TAKES the wall. Aaaa is the
  // case: entered the Cragged Mountains at full health, killed inside it in twenty-five
  // seconds, and never reached another boundary to be asked at. The room is 2,450 squares.
  // A wall it cannot be offered until the far side of the room is not a wall it has.
  const hurt = withPlan({ health: 30, max: 60, fleeAt: 0.7 });
  ok('a hurt traveller mid-hop DOES stop for a wall now', await sheltered(hurt),
     JSON.stringify(hurt.notes.map(n => n.what)));

  // WHAT STOPS IT BECOMING THE OLD BUG AGAIN: a per-room budget. The failure was never one
  // stop, it was thirty laps of stop-and-restart in a single leg — so the budget is what
  // makes mid-hop affordable, and the note when it is spent is what keeps the refusal
  // arguable rather than silent.
  const spent = withPlan({ health: 30, max: 60, fleeAt: 0.7 });
  // Keyed on the ROOM the counter belongs to — it resets on entering a new one, so a
  // fixture that omits the room is a fixture whose budget is wiped before it is read.
  spent.shelterStops = { room: spent.s.world.room.num, taken: 99, noted: false };
  ok('but not once this room\'s budget is spent', !(await sheltered(spent)));
  ok('and it says so rather than a faculty going quiet',
     spent.notes.some(n => /the wall for this is at the end of the hop/.test(n.what ?? '')),
     JSON.stringify(spent.notes.map(n => n.what)));

  // ...AND TWO HITS FROM DEATH IS NOT "A BAD ROOM". Waiting for a boundary that is 2,450
  // squares away is how the Cragged Mountains killed seven of eleven in one window, so the
  // one case that still stops mid-hop is the one that is about to be a death.
  const doomed = withPlan({ health: 10, max: 60, fleeAt: 0.7 });
  ok('but two hits from death still takes the wall where it stands', await sheltered(doomed));
  // No budget on dying: the same character with a room full of spent stops still stops.
  const doomedAgain = withPlan({ health: 10, max: 60, fleeAt: 0.7 });
  doomedAgain.shelterStops = { room: 535, taken: 9 };
  ok('and nothing rations that — there is no budget on dying', await sheltered(doomedAgain));

  // The faculty switch still governs it, so an operator can turn the whole thing off.
  const off = withPlan({ health: 10, max: 60, fleeAt: 0.7, guard: { safe_spot: false } });
  ok('with safe_spot switched off even the doomed case declines', !(await sheltered(off)));
}


// ---------------------------------------------------------------------------
// THE WALL IS FOUND ALONG THE ROUTE, AND BEING HURT ON A ROAD IS THE WHOLE TRIGGER.
//
// Two separate things kept a character from ever sheltering twice on one journey.
//
// THE TRIGGER asked for something within melee reach AT THE INSTANT OF THE PASS. A traveller
// is hit and keeps walking; by the next sample the thing that hit it is three squares back
// and `inReachOfUs()` is empty. Measured across a whole run: ZERO travel_paused_for_wall
// events for two characters who between them lost thirty-eight health and both died. Bbbb
// rested to full in 586, resumed, crossed 587, 597 and 598 in a hundred and seven seconds,
// arrived in the Cragged Mountains at 8 of 20 having never once been offered a wall, and
// died there in fifteen seconds.
//
// This repository already made this argument about the watchdog rescue — "the trigger is
// DAMAGE, and it does not care whether the body is moving" — and a stillness requirement
// missed it the same way an adjacency requirement does.
//
// THE SEARCH is the operator's rule: look along the PLANNED ROUTE and take the next wall
// near it. That branch already existed and was simply never reached. The radius fallback is
// what walked Bbbb backwards into 586, a room it had already crossed.
console.log('');
console.log('THE WALL IS FOUND ALONG THE ROUTE, AND DAMAGE ALONE IS THE TRIGGER');
{
  const stage = AUTOPILOT_SRC.slice(AUTOPILOT_SRC.indexOf('async passTravelling'),
                                    AUTOPILOT_SRC.indexOf('async passFollow'));
  ok('the shelter no longer waits for something to be standing next to us',
     !/shelterNow && this\.travelAllows\('safe_spot'\) && hp !== null && near\.length/.test(stage));
  ok('and says why an adjacency test is the wrong shape',
     /NO ADJACENCY REQUIREMENT/.test(stage));
  // THE ROUTE IS ASKED FIRST. `shelterAhead` refuses anything already passed, which is the
  // property a radius search cannot have.
  ok('the route is consulted before any search around the body',
     stage.indexOf('shelterAhead(') < stage.indexOf('nearestSafeSpot(') ||
     stage.indexOf('nearestSafeSpot(') === -1);
  ok('and it is the planned stops it asks, not a fresh guess',
     /const planned = this\.s\.activeShelter/.test(stage));
  // THE FALLBACK IS THE ONE THAT CAN GO BACKWARDS, so it may not be silent.
  ok('falling back to a radius search says so',
     /no planned wall ahead — searching around the body instead/.test(stage));
  ok('and names the risk rather than just the fact',
     /can offer a wall behind us/.test(stage));
  // The reason string has to survive an empty reach list now that one is expected.
  ok('the reason reads sensibly with nothing in reach',
     /nothing in reach right now/.test(stage));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
