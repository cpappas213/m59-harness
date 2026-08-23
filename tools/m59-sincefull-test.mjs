#!/usr/bin/env node
// WHAT THE BODY DID SINCE IT WAS LAST WHOLE — AND WHETHER THE MOVING WENT ANYWHERE.
//
//   node tools/m59-sincefull-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// WHY THIS EXISTS. Health falling is in every reading this repository has. What none of them
// could answer is what the character was DOING about it, and on a journey under attack the
// job is exactly two things: keep going forward, or get to a wall. Both are movement, and
// movement is all the other instruments can see.
//
// So the number here is PATH against NET. Forty squares walked ending two from where it
// started is not travelling, it is dithering — and every movement bug in this repository has
// looked exactly like that and like nothing else:
//
//   the 22<->23 oscillation on a rail        moving, going nowhere
//   dragging along a wall and back out       moving, ending where it began
//   the two-square shuffle at a wall         moving, and resetting every stall timer it met
//
// A stillness detector cannot see any of them, because none of them is still. This can.
//
// It should fail the day the ratio stops distinguishing a straight line from a shuffle.

import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The tracker is fed one pulse at a time and keeps no session state of its own, so a bare
// object with the prototype is the whole fixture. That is the point of taking `(at, hp)`
// rather than reaching into `this.s` for them.
const keeper = () => Object.assign(Object.create(Autopilot.prototype), { sinceFull: null });

let clock = 1_000_000;
const pulse = (k, { room = 587, col, row, health, max = 33, doing = 'travelling', ms = 500 }) => {
  clock += ms;
  k.trackSinceFull({ at: clock, room, col, row, health, doing }, { value: health, max });
};

console.log('');
console.log('while whole there is nothing to review');
{
  const k = keeper();
  pulse(k, { col: 10, row: 10, health: 33 });
  ok('a character at full health has no record open', k.sinceFullHealth() === null);
  pulse(k, { col: 11, row: 10, health: 30 });
  ok('and one drop opens it', k.sinceFullHealth() !== null);
  ok('which remembers the health it started from', k.sinceFullHealth().health_from === 30,
     JSON.stringify(k.sinceFullHealth()));
  // BACK TO FULL CLOSES IT. The interesting window is exactly one bleed; a record that
  // spanned two of them would average a fight with the walk that followed it.
  pulse(k, { col: 12, row: 10, health: 33 });
  ok('and being whole again clears it', k.sinceFullHealth() === null);
}

console.log('');
console.log('A STRAIGHT LINE AND A SHUFFLE ARE THE SAME AMOUNT OF MOVING');
{
  // Ten squares east, one square at a time.
  const straight = keeper();
  pulse(straight, { col: 10, row: 10, health: 30 });
  for (let i = 1; i <= 10; i++) pulse(straight, { col: 10 + i, row: 10, health: 30 });
  const s = straight.sinceFullHealth();
  ok('a straight walk records the squares it covered', s.squares_walked === 10, String(s.squares_walked));
  ok('and its net displacement is the same', s.net_from_start_of_this_room === 10,
     String(s.net_from_start_of_this_room));
  ok('so the ratio is 1', s.progress_ratio === 1, String(s.progress_ratio));

  // The 22<->23 oscillation, ten times. THE SAME TEN SQUARES OF WALKING.
  const dither = keeper();
  pulse(dither, { col: 22, row: 10, health: 30 });
  for (let i = 0; i < 5; i++) {
    pulse(dither, { col: 23, row: 10, health: 30 });
    pulse(dither, { col: 22, row: 10, health: 30 });
  }
  const d = dither.sinceFullHealth();
  ok('a shuffle records just as much walking', d.squares_walked === 10, String(d.squares_walked));
  ok('and no displacement at all', d.net_from_start_of_this_room === 0,
     String(d.net_from_start_of_this_room));
  ok('so the ratio is 0 — which is the whole finding', d.progress_ratio === 0,
     String(d.progress_ratio));
  // THE ASSERTION THAT MATTERS. Every other instrument scores these two identically.
  ok('the two are indistinguishable by distance walked and separated by the ratio',
     s.squares_walked === d.squares_walked && s.progress_ratio !== d.progress_ratio);
}

console.log('');
console.log('a room change is progress of a different kind, not a teleport');
{
  const k = keeper();
  pulse(k, { room: 587, col: 60, row: 40, health: 30 });
  pulse(k, { room: 587, col: 62, row: 40, health: 28 });
  // Across a boundary the coordinates start again, so distance in squares is meaningless.
  pulse(k, { room: 597, col: 2, row: 7, health: 28 });
  pulse(k, { room: 597, col: 4, row: 7, health: 26 });
  const f = k.sinceFullHealth();
  ok('the crossing is counted as a room change', f.room_changes === 1, String(f.room_changes));
  ok('and the rooms are kept in order', JSON.stringify(f.rooms) === JSON.stringify([587, 597]),
     JSON.stringify(f.rooms));
  // 2 squares before the boundary and 2 after; the jump between coordinate systems is NOT
  // 58 squares of walking, and counting it as such would make every crossing look like a
  // sprint and drown the ratio it is supposed to inform.
  ok('the coordinate jump is not counted as walking', f.squares_walked === 4,
     String(f.squares_walked));
  ok('and the net anchor restarts, so the ratio describes THIS room',
     f.net_from_start_of_this_room === 2, String(f.net_from_start_of_this_room));
}

console.log('');
console.log('reaching a wall is the CORRECT outcome, and the time to it is the measurement');
{
  const k = keeper();
  pulse(k, { col: 10, row: 10, health: 30, doing: 'travelling' });
  for (let i = 1; i <= 6; i++)
    pulse(k, { col: 10 + i, row: 10, health: 30 - i, doing: 'travelling', ms: 1000 });
  ok('a bleed with no shelter reached says so with a null rather than a zero',
     k.sinceFullHealth().reached_shelter_after_s === null);
  pulse(k, { col: 17, row: 10, health: 24, doing: 'holding a proven safe spot', ms: 1000 });
  const f = k.sinceFullHealth();
  ok('and once sheltered it reports how long that took', f.reached_shelter_after_s === 7,
     String(f.reached_shelter_after_s));
  ok('the lowest health of the bleed is kept, not just the latest',
     f.health_low === 24, String(f.health_low));
  ok('and the rate is health lost over the whole window',
     f.losing_per_s > 0 && f.losing_per_s < 2, String(f.losing_per_s));
  // A SECOND WALL DOES NOT RESTART THE CLOCK. The question is when this bleed first got
  // somewhere safe, and overwriting it would flatter a character that bounced between two.
  pulse(k, { col: 17, row: 10, health: 24, doing: 'holding a proven safe spot', ms: 5000 });
  ok('and staying there does not move the answer',
     k.sinceFullHealth().reached_shelter_after_s === 7,
     String(k.sinceFullHealth().reached_shelter_after_s));
}

console.log('');
console.log('it never throws on the readings a live keeper actually produces');
{
  const k = keeper();
  // No max, no value, a null column mid-walk, a teleport: every one of these happens, and a
  // diagnostic that throws inside the 500ms pulse would take the watchdog with it.
  ok('no vitals at all is a no-op', (k.trackSinceFull({ at: 1, room: 1 }, null), true));
  ok('a zero maximum is a no-op', (k.trackSinceFull({ at: 1, room: 1 }, { value: 1, max: 0 }), true));
  pulse(k, { col: 10, row: 10, health: 30 });
  ok('a null position does not throw', (pulse(k, { col: null, row: null, health: 29 }), true));
  // A jump of more than a few squares in half a second is dead reckoning or a relocate, not
  // walking, and counting it would make the denominator lie.
  const j = keeper();
  pulse(j, { col: 10, row: 10, health: 30 });
  pulse(j, { col: 40, row: 40, health: 30 });
  ok('and a teleport is not counted as walking', j.sinceFullHealth().squares_walked === 0,
     String(j.sinceFullHealth().squares_walked));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
