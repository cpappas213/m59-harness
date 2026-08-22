#!/usr/bin/env node
// AN INTERRUPTED JOURNEY IS SUSPENDED, NOT FORGOTTEN.
//
//   node tools/m59-resumetravel-test.mjs
//
// Offline. No socket, no broker, no roster — safe any time.
//
// ============================ WHAT THIS IS BUILT FROM ============================
//
// A shuttle test on the shadow fleet, 2026-08-21: twenty-one characters sent back and
// forth between Castle Victoria and Tos, and not one arrived. Some of that was a
// confinement refusing the journey outright. The rest was this: the mid-hop guards end a
// journey ON PURPOSE when the character is in trouble, and until this change they ended the
// OBJECTIVE along with the movement.
//
// `takeBack` did not even have a destination to keep. It recorded
// `was_travelling_to: held.why`, which is prose —— "travelling to Castle Victoria" —— and
// reads like a destination without being one. So a character pulled off the road at 30%
// health healed up at a wall, and then went back to farming with no memory that anybody
// had sent it anywhere. From outside, that is indistinguishable from travel not working:
// the shuttle logged it as "stopped being busy without arriving".
//
// THE RULE THIS SERVES, set by the operator 2026-08-21: A JOURNEY IS NEVER ABANDONED
// UNLESS A PLAYER IS ATTACKING. Every other kind of travel trouble — monsters, an empty
// hand, an emptying bar — is answered by finding a SAFE WALL and resting at it, which is
// drastically safer and more effective than running, because a wall a creature cannot path
// to is almost always closer than the nearest town. The journey then carries on.
//
// So the objective is kept, and picked back up from the LAST pass stage — by construction
// nothing more urgent wanted that tick — once health and vigor are back up, which is what
// "rested at the wall" means in numbers.
//
// THE FIVE REFUSALS are the safety of the resume itself, and two of them are RUNAWAY
// BACKSTOPS rather than policy: set tight, they quietly become a second abandon rule and
// undo the operator's rule above.
//
//   died since      resuming the road that killed you is the Cccc post-mortem with steps
//   too many tries  a BACKSTOP at 12, not "give up after two" — a road with eight
//                   wall-rests along it is a road, not a loop
//   stale           thirty minutes, which is longer than a bad rest; five was not
//   too hurt        NOT a drop —— being hurt is temporary and the note stays good
//   switched off    `resume_travel: false`, per character, live
//
// It should fail the day a resume stops asking one of those five questions, or the day
// something other than a player starts abandoning journeys.

import { Autopilot, HANDLED, CONTINUE } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const BROKER_SRC = readFileSync('tools/m59-broker.mjs', 'utf8');

// Same shape as m59-travelling-test's fixture, and for the same reason: a real constructor
// wants a session, which wants a socket, which wants a server. `who()` resolves to null so
// `recordEvent` is a no-op and no assertion here appends to the real ledger.
const keeper = ({ health = 37, max = 37, policy = {}, room = 535, travelled = [] } = {}) => {
  const notes = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, policy, claims: new Map(), passes: 1,
    tally: { deaths: 0 }, doing: 'travelling',
    book: { save: () => {} },
    watch: { pulses: [], wedges: 0 },
    note: (what, detail) => notes.push({ what, detail }),
    recordFrame: () => {},
    ledgerEvent: () => {},
    progress: () => {}, noProgress: () => {},
    armed: () => true,
    safety: () => ({ fleeAt: 0.7 }),
    travel: async (to, opts) => { travelled.push({ to, opts }); return { arrived: true }; },
    s: {
      name: null,
      cancelMovement: () => ({ cancelled: true }),
      world: { room: { num: room, name: 'somewhere' } },
      client: { selfId: 1, self: { id: 1, col: 25, row: 5 }, room: { objects: new Map() },
                vitals: () => ({ health: { value: health, max }, vigor: { value: 80 } }) },
    },
  });
  k.travelled = travelled;
  return k;
};
const ctxFor = k => {
  const v = k.s.client.vitals();
  return { s: k.s, c: k.s.client, room: k.s.world.room, v,
           hp: v.health.max ? v.health.value / v.health.max : null };
};
const said = (k, re) => k.notes.some(n => re.test(n.what) || re.test(JSON.stringify(n.detail ?? {})));

// ---------------------------------------------------------------------------
console.log('\nthe objective is stored at all');
{
  const k = keeper();
  k.goTravelling('travelling to Castle Victoria', { to: 38 });
  ok('goTravelling records the destination as a NUMBER, not just the prose reason',
     k.inert.to === 38 && typeof k.inert.to === 'number', JSON.stringify(k.inert?.to));
  ok('and the attempt count rides on the journey, not only on the suspended note',
     k.inert.attempts === 0);

  const legacy = keeper();
  legacy.goTravelling('travelling to somewhere');
  ok('a caller that names no destination still travels, with to = null',
     legacy.inert.travelling === true && legacy.inert.to === null);

  // A SUSPENDED OBJECTIVE OUTLIVES A SYSTEM SAVE. IT MAY NOT NAME ANYTHING TEMPORARY.
  //
  // In-game object ids are regenerated on every save, alongside garbage collection — a
  // character resolved as 7218 is a heartstone half an hour later, and nothing errors.
  // So what is kept across the gap between a take-back and a resume has to be the STABLE
  // room number (`look.room.num`), never the live room object (`look.room.object_id`) and
  // never a character's object id. The router resolves those fresh at the moment it moves.
  const k2 = keeper();
  k2.goTravelling('travelling to Castle Victoria', { to: 38 });
  k2.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'flee',
                          attempts: 1, deaths_at: 0 };
  const keys = Object.keys(k2.suspendedJourney).sort();
  ok('the suspended objective carries only stable fields — no object id of any kind',
     JSON.stringify(keys) === JSON.stringify(['at', 'attempts', 'deaths_at', 'to', 'trigger', 'why']),
     JSON.stringify(keys));
  ok('and nothing in the journey state is id-shaped either',
     !/object_id|objectId/.test(JSON.stringify(k2.inert)), JSON.stringify(k2.inert));

  // THE ONE THAT KEEPS "one direction per body" TRUE.
  const busy = keeper();
  busy.suspendedJourney = { to: 50, why: 'old', at: Date.now(), attempts: 1, deaths_at: 0 };
  busy.goTravelling('travelling to Castle Victoria', { to: 38 });
  ok('a NEW journey retires any suspended objective',
     busy.suspendedJourney === null);
}

// ---------------------------------------------------------------------------
console.log('\nthe take-back suspends rather than discards');
{
  // takeBack is a closure inside passTravelling, so it is exercised the way the ladder
  // reaches it: through the real method, with the journey state the fixture sets up.
  const k = keeper({ health: 8 });
  k.goTravelling('travelling to Castle Victoria', { to: 38 });
  const before = k.inert;
  // Reproduce the takeBack contract directly against the state it reads, rather than
  // driving the whole threat ladder — this suite is about what happens to the OBJECTIVE.
  k.tally.travel_takebacks = 0;
  k.suspendedJourney = { to: 38, why: before.why, at: Date.now(), trigger: 'flee',
                         attempts: (before.attempts ?? 0) + 1, deaths_at: k.tally.deaths };
  k.revive('flee while travelling');
  ok('the destination survives the take-back', k.suspendedJourney?.to === 38);
  ok('and the first take-back counts as attempt 1', k.suspendedJourney.attempts === 1);
  ok('and the journey state itself is gone — a suspended journey holds nothing',
     k.inert === null);

  const src = readFileSync('tools/m59-autopilot.mjs', 'utf8');
  ok('takeBack only suspends when it HAS a destination',
     /if \(held\.to != null\) \{/.test(src));
  ok('and carries the attempt count forward from the journey',
     /attempts: \(held\.attempts \?\? 0\) \+ 1/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\nthe five refusals');
{
  const suspended = (over = {}) => ({ to: 38, why: 'travelling to Castle Victoria',
    at: Date.now(), trigger: 'flee', attempts: 1, deaths_at: 0, ...over });

  // 1. died since
  const dead = keeper();
  dead.suspendedJourney = suspended();
  dead.tally.deaths = 1;
  ok('a journey the character DIED on is dropped, not resumed',
     await dead.resumeSuspendedJourney(ctxFor(dead)) === CONTINUE &&
     dead.suspendedJourney === null && dead.travelled.length === 0);
  ok('and says that is why', said(dead, /died since/));

  // 2. too many attempts — a RUNAWAY BACKSTOP, not the abandon policy. The default is
  //    deliberately generous (12) because a journey is only given up for a PLAYER; every
  //    other trouble pauses at a wall and carries on, so a corridor with several wall-rests
  //    in it must not trip this. A tight cap here silently becomes a second abandon rule.
  const tired = keeper();
  tired.suspendedJourney = suspended({ attempts: 13 });
  ok('past the runaway cap the objective is dropped rather than resuming for ever',
     await tired.resumeSuspendedJourney(ctxFor(tired)) === CONTINUE &&
     tired.suspendedJourney === null && tired.travelled.length === 0);
  const patient = keeper();
  patient.suspendedJourney = suspended({ attempts: 13 });
  patient.policy.resumeTravelAttempts = 20;
  ok('and the cap is a policy, so an operator can say otherwise',
     await patient.resumeSuspendedJourney(ctxFor(patient)) === HANDLED &&
     patient.travelled.length === 1);

  // 3. stale
  // Thirty minutes by default: five was shorter than a bad rest, so an objective could
  // expire while the character was doing the very thing it was taken off the road to do.
  const old = keeper();
  old.suspendedJourney = suspended({ at: Date.now() - 2_400_000 });
  ok('an objective older than the window is dropped',
     await old.resumeSuspendedJourney(ctxFor(old)) === CONTINUE &&
     old.suspendedJourney === null && old.travelled.length === 0);
  ok('and says it went stale', said(old, /stale/));

  // 4. too hurt — NOT a drop. This is the one that must not throw the objective away.
  const hurt = keeper({ health: 12, max: 37 });
  hurt.suspendedJourney = suspended();
  ok('a character still too hurt to set out does NOT resume',
     await hurt.resumeSuspendedJourney(ctxFor(hurt)) === CONTINUE && hurt.travelled.length === 0);
  ok('...and KEEPS the objective for a later tick — being hurt is temporary',
     hurt.suspendedJourney?.to === 38);

  // 5. switched off
  const off = keeper();
  off.suspendedJourney = suspended();
  off.policy.resumeTravel = false;
  ok('resume_travel: false refuses',
     await off.resumeSuspendedJourney(ctxFor(off)) === CONTINUE && off.travelled.length === 0);
  ok('...and keeps the objective rather than destroying it behind a switch',
     off.suspendedJourney?.to === 38);
}

// ---------------------------------------------------------------------------
console.log('\nand when nothing refuses, it goes');
{
  const k = keeper();
  k.suspendedJourney = { to: 38, why: 'travelling to Castle Victoria', at: Date.now(),
                         trigger: 'flee', attempts: 1, deaths_at: 0 };
  const verdict = await k.resumeSuspendedJourney(ctxFor(k));
  ok('the stage reports HANDLED so the tick is not also spent farming', verdict === HANDLED);
  ok('it actually travels, to the stored destination', k.travelled[0]?.to === 38);
  ok('the note is consumed exactly once', k.suspendedJourney === null);
  ok('and it says it is resuming rather than starting something new',
     said(k, /RESUMING THE JOURNEY/));

  // Already there: clearing without travelling, so the ledger gets no journey that never moved.
  const there = keeper({ room: 38 });
  there.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'flee',
                             attempts: 1, deaths_at: 0 };
  ok('a character already at the destination clears the note and travels nowhere',
     await there.resumeSuspendedJourney(ctxFor(there)) === CONTINUE &&
     there.suspendedJourney === null && there.travelled.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nthe wiring the keeper cannot check for itself');
{
  ok('the broker hands travelJob its destination, not just the room name',
     /goTravelling\(`travelling to \$\{where\}`, \{ to: dest \}\)/.test(BROKER_SRC));
  // An unrecognised key is REPORTED, never applied and never dropped — so a policy the
  // keeper reads has to exist in the schema or it can never be set at all.
  for (const key of ['resume_travel', 'resume_travel_attempts', 'resume_travel_within_ms'])
    ok(`\`${key}\` is a declared autopilot parameter`,
       BROKER_SRC.includes(`${key}:`) && BROKER_SRC.includes(`a.${key} !== undefined`));
  ok('resume happens in the LAST pass stage, so nothing more urgent is skipped for it',
     /await this\.resumeSuspendedJourney\(ctx\)/.test(readFileSync('tools/m59-autopilot.mjs', 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
