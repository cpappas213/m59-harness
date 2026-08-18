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
const start = src.indexOf('  pulsePosition(now, hp) {');
ok('the pulsePosition method was located', start >= 0);
let depth = 0, end = -1;
for (let at = src.indexOf(') {', start) + 2; at < src.length; at++) {
  if (src[at] === '{') depth++;
  else if (src[at] === '}') { depth--; if (depth === 0) { end = at + 1; break; } }
}
const method = src.slice(start, end);
ok('and it is a whole method', method.trim().endsWith('}'));
const pulsePosition = new Function('PULSE_SAMPLES',
  `return ({${method}}).pulsePosition`)(3);

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a keeper mid-walk.
// ---------------------------------------------------------------------------
function keeper({ doing = 'travelling', inert = null, hold = null,
                  room = 587, col = 10, row = 10 } = {}) {
  const self = { col, row, x: col * 64 + 32, y: row * 64 + 32 };
  const notes = [], frames = [];
  return {
    doing, inert, hold, tally: {}, pulsePosition,
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
  ok('nothing in the method cancels movement',
     !/cancelMovement|cancelledMovement/.test(method));
  ok('nothing in it moves the character',
     !/walkTo|stepFine|leaveVia|travel\(/.test(method));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
