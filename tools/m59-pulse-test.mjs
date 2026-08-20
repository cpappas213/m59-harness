#!/usr/bin/env node
// IS THE CHARACTER MOVING — the contract test for the position pulse.
//
//   node tools/m59-pulse-test.mjs
//
// Offline. The real `Autopilot.pulsePosition` is lifted out of `m59-autopilot.mjs` by
// brace matching and driven against a fake keeper, because what is under test is a
// DECISION about a sequence of samples, and a sequence is something a fixture can state
// exactly and a live fleet cannot.
//
// WHAT IT IS FOR. Every other stall number in this repository measures the KEEPER.
// `ms_since_moved` is when the keeper last moved somebody, so it climbs while an errand
// walks the character perfectly well — which is how a post-mortem came to report
// `doing: "stalled", 8 minutes since it last moved` about a character the frames put in
// three different rooms — and it stays quiet while a wedged character replans into the
// same wall forever, because the keeper is working hard the whole time. The pulse asks
// the other question, of the character, on its own clock.
//
// THE FAILURE MODE OF AN INSTRUMENT IS FALSE ALARMS, so most of this file is the
// exclusions. A detector that shouts every time somebody sits down to rest gets switched
// off within a day, and then it is not there on the day it was needed.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const SOURCE = {};
function lift(signature, name, deps = {}) {
  const start = src.indexOf('  ' + signature);
  ok(`the ${name} method was located`, start >= 0);
  let depth = 0, end = -1;
  for (let at = src.indexOf(') {', start) + 2; at < src.length; at++) {
    if (src[at] === '{') depth++;
    else if (src[at] === '}') { depth--; if (depth === 0) { end = at + 1; break; } }
  }
  const method = src.slice(start, end);
  ok(`and ${name} is a whole method`, method.trim().endsWith('}'));
  SOURCE[name] = method;
  return new Function(...Object.keys(deps), `return ({${method}}).${name}`)(...Object.values(deps));
}
const pulsePosition = lift('pulsePosition(now, hp) {', 'pulsePosition', { PULSE_SAMPLES: 3 });
// `inertBleeding` is the other half of the inert branch and is lifted rather than stubbed
// for the usual reason: a hand-written imitation would be testing the imitation, and this
// one decides whether a character being eaten is visible at all.
const inertBleeding = lift('inertBleeding(w, hp) {', 'inertBleeding', {});
// `pennedIn` is what makes the inert branch see the two-square BOUNCE rather than only a
// character standing perfectly still — the failure that killed Cccc with its last three
// pulses reading 35,33 / 34,33 / 35,33.
const pennedIn = lift('pennedIn(w) {', 'pennedIn', {});

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a keeper mid-walk.
// ---------------------------------------------------------------------------
function keeper({ doing = 'travelling', inert = null, hold = null,
                  room = 587, col = 10, row = 10 } = {}) {
  const self = { col, row, x: col * 64 + 32, y: row * 64 + 32 };
  const notes = [], frames = [];
  return {
    doing, inert, hold, tally: {}, pulsePosition, inertBleeding, pennedIn,
    watch: { pulses: [], lastPulseAt: 0, wedged: null, wedges: 0 },
    s: { client: { self, room: { id: room } } },
    note: (what, detail) => notes.push({ what, detail }),
    recordFrame: why => frames.push(why),
    notes, frames,
    // Move the body, or do not, and take a sample.
    tick(t, { to = null, health = 50 } = {}) {
      if (to) { self.col = to.col; self.row = to.row; self.x = to.col * 64 + 32; }
      return this.pulsePosition(t, { value: health, max: 50 });
    },
  };
}

// ---------------------------------------------------------------------------
console.log('a character that is going somewhere and is not moving gets flagged');
{
  const k = keeper({ doing: 'travelling' });
  ok('one sample is not enough to say anything', k.tick(1000) === null);
  const wedged = k.tick(2000);
  ok('two samples a second apart at the same square is the alert', !!wedged);
  ok('and it says which square', wedged.at.col === 10 && wedged.at.row === 10);
  ok('and what the character was supposed to be doing', wedged.doing === 'travelling');
  ok('it raises a `!` note a person can grep for',
     k.notes.some(n => n.what.startsWith('! NOT MOVING')));
  ok('and writes ONE frame, because a wedge is quiet and the ring is written on damage',
     k.frames.length === 1 && k.frames[0].startsWith('!'));
  ok('it counts the episode', k.watch.wedges === 1 && k.tally.pulse_wedges === 1);

  // ONE EPISODE, NOT ONE PER TICK. At 500ms a five-minute wedge is 600 ticks; six hundred
  // identical notes is the same as no notes.
  for (let t = 3000; t <= 8000; t += 1000) k.tick(t);
  ok('a continuing wedge stays ONE episode', k.watch.wedges === 1);
  ok('and one note', k.notes.filter(n => n.what.startsWith('! NOT MOVING')).length === 1);
  ok('while its duration keeps climbing', k.watch.wedged.for_ms >= 6000,
     `${k.watch.wedged.for_ms}ms`);

  // And it clears when the body moves, so the next wedge is a new event.
  ok('moving clears it', k.tick(9000, { to: { col: 11, row: 10 } }) === null
     && k.watch.wedged === null);
}

// ---------------------------------------------------------------------------
console.log('\nstanding still on purpose is not a stall');
{
  // Each of these is a different reason, and folding them together is how "why was it not
  // flagged" stops being answerable.
  const cases = [
    ['resting', keeper({ doing: 'recovering' })],
    ['fighting', keeper({ doing: 'fighting' })],
    ['trading', keeper({ doing: 'trading' })],
    ['waiting', keeper({ doing: 'waiting' })],
    ['holding a safe spot', keeper({ doing: 'travelling', hold: { col: 10, row: 10 } })],
    ['inert — something else is driving', keeper({ doing: 'travelling', inert: { why: 'errand' } })],
  ];
  for (const [why, k] of cases) {
    k.tick(1000); k.tick(2000); k.tick(3000);
    ok(`${why} is never flagged`, k.watch.wedges === 0 && !k.watch.wedged);
  }
  // HOLDING A WALL IS THE ONE THAT MATTERS MOST. A wall that works and a wedge look
  // identical from outside — perfectly still, for minutes — and they are opposites. The
  // safe wall is the fleet's whole defensive game; flagging it would train everyone to
  // ignore the alert.
  const wall = keeper({ doing: 'travelling', hold: { col: 10, row: 10 } });
  for (let t = 1000; t <= 60000; t += 1000) wall.tick(t);
  ok('a wall held for a full minute raises nothing at all', wall.watch.wedges === 0);
}

// ---------------------------------------------------------------------------
console.log('\nit compares SQUARES, because sliding along a wall is not progress');
{
  // The bounce this exists to catch moves in fine units and goes nowhere: `walkTo` slides,
  // lands off plan, replans into the same wall. Comparing fine coordinates would call
  // that healthy movement, which is exactly the reading that hid the fault for a session.
  const k = keeper({ doing: 'travelling' });
  k.tick(1000);
  k.s.client.self.x += 24;                      // slid a third of a square, same square
  const wedged = k.tick(2000);
  ok('a slide within one square still reads as not moving', !!wedged);

  const moved = keeper({ doing: 'travelling' });
  moved.tick(1000);
  ok('a real change of square does not', moved.tick(2000, { to: { col: 11, row: 10 } }) === null);
}

// ---------------------------------------------------------------------------
console.log('\nand it says whether something is eating the character while it stands there');
{
  // "Stuck" and "stuck and being hit" are the same symptom and completely different
  // urgencies, and the pulse already holds both samples.
  const hurt = keeper({ doing: 'travelling' });
  hurt.tick(1000, { health: 50 });
  const wedged = hurt.tick(2000, { health: 41 });
  ok('a wedge that is taking damage says so', wedged?.taking_hits === true);

  const quiet = keeper({ doing: 'travelling' });
  quiet.tick(1000, { health: 50 });
  ok('a quiet one does not', quiet.tick(2000, { health: 50 })?.taking_hits === false);
}

// ---------------------------------------------------------------------------
console.log('\nit decides nothing, and that is deliberate');
{
  // The handbrake acts on HEALTH and cancels movement. This is an instrument: the whole
  // point is to make a fault debuggable, and an instrument that also acts is one whose
  // false alarms cost characters rather than log lines.
  // AND THAT STAYS TRUE NOW THAT AN INERT WEDGE IS ACTED ON. The rescue lives in
  // `watchdogTick`, which is where the handbrake already is; this function's job is still
  // only to say what the body is doing. Keeping the two apart is what makes it possible to
  // test the observation without a session and the action without a fixture.
  ok('nothing in the method cancels movement',
     !/cancelMovement|cancelledMovement/.test(SOURCE.pulsePosition));
  ok('nothing in it moves the character',
     !/walkTo|stepFine|leaveVia|travel\(/.test(SOURCE.pulsePosition));
  ok('and it never throws on a character whose position is unknown', (() => {
    const k = keeper({ doing: 'travelling' });
    k.s.client.self = null;
    try { return k.tick(1000) === null && k.tick(2000) === null; } catch { return false; }
  })());
  // A room change is movement, even to the same square number — rooms have their own grids.
  const zoned = keeper({ doing: 'travelling' });
  zoned.tick(1000);
  zoned.s.client.room.id = 588;
  ok('crossing into another room at the same coordinates is not a stall',
     zoned.tick(2000) === null);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('inert excuses standing still, and not standing still while dying');
{
  // THE CASE THIS WAS BLIND TO, and it killed two characters in one leg. `inert` means an
  // errand or a bot owns the character, and the pulse stood down for it — the instrument
  // deferring to the driver, which is right until the driver stops driving.
  //
  // Measured on the arena fleet, 2026-08-20, North Barloque to Tos: Bbbb and Eeee died in
  // The Flatlands stationary for 268 and 111 seconds with four ants on them, and both
  // post-mortems read `stood_down_for: "travelling to The Streets of Tos"` with `wedges: 0`.
  // The one instrument that reads the character's own clock was switched off by the state
  // that was killing them.
  //
  // THREE SAMPLES, NOT TWO. `pennedIn` asks the whole ring, because the two-square bounce
  // reads as movement to any test that only compares the last two — Cccc's last three
  // pulses were 35,33 / 34,33 / 35,33 and it died there.
  const dying = keeper({ doing: null, inert: { why: 'travelling to The Streets of Tos' } });
  dying.tick(1000, { health: 20 });
  dying.tick(2000, { health: 18 });
  const wedged = dying.tick(3000, { health: 16 });
  ok('an inert character losing health where it stands IS flagged', !!wedged);
  ok('and the wedge says who had stood down for whom',
     wedged?.inert === 'travelling to The Streets of Tos');
  ok('and that it is taking hits', wedged?.taking_hits === true);

  // AND THE EXCLUSION STILL HOLDS, which is the half that keeps this from becoming a false
  // alarm generator: an errand walking a character through a quiet room is standing still
  // for whole seconds at a time and is nobody's emergency.
  const quiet = keeper({ doing: null, inert: { why: 'walking to the smith' } });
  for (let t = 1000; t <= 30000; t += 1000) quiet.tick(t, { health: 50 });
  ok('an inert character at steady health is still never flagged', quiet.watch.wedges === 0);

  // Healing while inert is not dying either — the comparison is directional on purpose.
  const mending = keeper({ doing: null, inert: { why: 'resting under orders' } });
  mending.tick(1000, { health: 20 });
  mending.tick(2000, { health: 24 });
  ok('an inert character gaining health is not flagged', mending.watch.wedges === 0);

  // Moving while inert and hurt is a driver that is still driving.
  const walking = keeper({ doing: null, inert: { why: 'errand' } });
  walking.tick(1000, { health: 20 });
  ok('an inert character that is still moving is not flagged',
     walking.tick(2000, { to: { col: 11, row: 10 }, health: 16 }) === null);

  // A WEDGE SURVIVES A PAINLESS SECOND, and this is the assertion that would have caught
  // the first version being useless. Damage lands about once a second and so does the
  // pulse, so half the ticks see no drop — and the excused branch CLEARS the wedge. Live,
  // that read as `wedges: 8, rescues: 0` on a character that then died: the episode never
  // aged past one pulse, so the rescue four seconds later could never fire.
  const intermittent = keeper({ doing: null, inert: { why: 'travelling' } });
  intermittent.tick(1000, { health: 20 });
  intermittent.tick(2000, { health: 18 });
  intermittent.tick(3000, { health: 16 });          // hit — opens the wedge
  intermittent.tick(4000, { health: 16 });          // quiet second
  intermittent.tick(5000, { health: 16 });          // and another
  const still = intermittent.tick(6000, { health: 12 });
  ok('a quiet second does not end the episode', !!still && intermittent.watch.wedges === 1);
  ok('and its duration keeps climbing across them', (still?.for_ms ?? 0) >= 3000);

  // It ends when the BODY genuinely leaves, which is the only thing that means the driver
  // is back. Two squares is outside `pennedIn`'s neighbourhood; one is not, which is the
  // whole point — a body that alternates between two squares has not gone anywhere.
  ok('and walking out of the neighbourhood ends it',
     intermittent.tick(7000, { to: { col: 14, row: 14 }, health: 12 }) === null
     && !intermittent.watch.wedged);

  // THE BOUNCE ITSELF, which is the case the exact-square test cannot see: alternating
  // between two adjacent squares for ever while something eats you.
  const bouncing = keeper({ doing: null, inert: { why: 'travelling to Castle Victoria' }, col: 35, row: 33 });
  bouncing.tick(1000, { health: 30 });
  bouncing.tick(2000, { to: { col: 34, row: 33 }, health: 26 });
  const caught = bouncing.tick(3000, { to: { col: 35, row: 33 }, health: 22 });
  ok('a character oscillating between two squares while inert IS flagged', !!caught);
  ok('and it is still recognised as taking hits', caught?.taking_hits === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
