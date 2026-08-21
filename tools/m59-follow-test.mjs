#!/usr/bin/env node
// LEADING THE FLEET BY WALKING IN FRONT OF IT, PINNED.
//
// Offline: no socket, no roster, no broker. The two things worth pinning are the security
// boundary and the trail discipline, and the first matters more.
//
// `prod` is a SHARED SERVER. This is a command that moves twenty bodies at once, so a
// stranger who worked out the phrase could walk the fleet into open ground, into a PK trap,
// or just away from what it was doing. The speaker has to be on our own roster.

import { heardOrder, dropCrumb, nextStep, behindBy, exitTakenFrom,
         REACHED_WITHIN, CRUMB_EVERY, MAX_TRAIL } from './m59-follow.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const OURS = new Set(['Piggy', 'Kermit']);
const isOurs = n => OURS.has(n);
const said = (name, text, speaker = 1) => ({ kind: 'said', name, text, speaker });

console.log('who may give the order');
{
  ok('one of ours saying it is obeyed',
     heardOrder([said('Piggy', 'follow me')], { isOurs })?.order === 'follow');
  // THE ONE THAT MATTERS. A stranger on a shared server must not be able to move the fleet.
  ok('A STRANGER IS HEARD AND IGNORED',
     heardOrder([said('SomeRandom', 'follow me')], { isOurs }) === null);
  ok('and so is a stranger who knows a name of ours',
     heardOrder([said('NotPiggy', 'Piggy follow me')], { isOurs }) === null);
  ok('an unnamed speaker is not trusted either',
     heardOrder([said(null, 'follow me')], { isOurs }) === null);
  // A character must not take its own order — it hears its own speech in the room stream.
  ok('a character does not follow itself',
     heardOrder([said('Piggy', 'follow me', 7)], { isOurs, self: 7 }) === null);
  ok('the leader id and name come back so the follower knows who to watch',
     heardOrder([said('Kermit', 'follow me', 42)], { isOurs })?.leaderId === 42);
}

console.log('');
console.log('starting and stopping');
{
  ok('stop is understood', heardOrder([said('Piggy', 'stop')], { isOurs })?.order === 'stop');
  ok('and so is holding position',
     heardOrder([said('Piggy', 'hold position')], { isOurs })?.order === 'stop');
  ok('and staying put', heardOrder([said('Piggy', 'stay here')], { isOurs })?.order === 'stop');
  // THE LAST ORDER IN A BATCH WINS. Someone who says "follow me" and then "stop" inside one
  // pass meant stop, and obeying the first would walk the fleet off after them.
  ok('the last order in a batch wins',
     heardOrder([said('Piggy', 'follow me'), said('Piggy', 'stop')], { isOurs })?.order === 'stop');
  ok('in either direction',
     heardOrder([said('Piggy', 'stop'), said('Piggy', 'follow me')], { isOurs })?.order === 'follow');
  ok('ordinary chat is not an order', heardOrder([said('Piggy', 'hello all')], { isOurs }) === null);
  ok('an empty batch is null, not a throw', heardOrder([], { isOurs }) === null);
  ok('and so is rubbish', heardOrder(null, { isOurs }) === null);
}

console.log('');
console.log('the trail is a queue of where the leader actually stood');
{
  const t = [];
  dropCrumb(t, { row: 10, col: 10 });
  ok('the first crumb is always dropped', t.length === 1);
  dropCrumb(t, { row: 11, col: 10 });
  ok('a shuffle on the spot does not fill the queue with jitter', t.length === 1);
  dropCrumb(t, { row: 12, col: 10 });
  ok('two squares of movement earns a crumb', t.length === 2);
  // The queue is bounded: older than about a minute of walking and the leader has gone
  // somewhere a follower can no longer usefully retrace.
  for (let i = 0; i < MAX_TRAIL * 2; i++) dropCrumb(t, { row: 12 + i * CRUMB_EVERY, col: 10 });
  ok('the queue is bounded', t.length === MAX_TRAIL, String(t.length));
  ok('and it is the OLD end that is dropped, so the newest path survives',
     t[t.length - 1].row > t[0].row);
  ok('a bad position is ignored rather than poisoning the trail',
     dropCrumb([], { row: NaN, col: 1 }).length === 0);
}

console.log('');
console.log('the follower walks the path, not the person');
{
  // WHY THIS IS THE WHOLE POINT. Walking AT a leader is a beeline, and a beeline is what
  // fails in the rooms this exists for. The follower goes where the leader WENT.
  const t = [{ row: 10, col: 10 }, { row: 12, col: 10 }, { row: 14, col: 10 }];
  const me = { row: 10, col: 10 };
  const first = nextStep(t, me);
  ok('standing on the oldest crumb consumes it and aims at the next',
     first?.row === 12 && t.length === 2, JSON.stringify(first));
  // Passing near a crumb IS reaching it — insisting on the exact square is how a follower
  // stalls on geometry the leader crossed at a slightly different angle.
  const t2 = [{ row: 10, col: 10 }, { row: 12, col: 10 }];
  ok('passing close enough counts as reached',
     nextStep(t2, { row: 10, col: 11 })?.row === 12);
  const t3 = [{ row: 30, col: 30 }];
  ok('a distant crumb is aimed at rather than skipped',
     nextStep(t3, { row: 10, col: 10 })?.row === 30 && t3.length === 1);
  ok('an empty trail means caught up, not lost', nextStep([], { row: 1, col: 1 }) === null);
  ok('and so does one entirely behind us',
     nextStep([{ row: 1, col: 1 }], { row: 1, col: 1 }) === null);
  ok('how far behind is the queue length', behindBy([1, 2, 3]) === 3 && behindBy(null) === 0);
}

console.log('');
console.log('the leader walked out of the zone — which door?');
{
  // A trail ends where the leader stopped being visible, so walking it to the end leaves a
  // follower standing in an empty room having done exactly as told and achieved nothing.
  // The leader is STILL ONLINE — they did not log out, they left the map — and the last
  // place we saw them was next to a door. People do not evaporate.
  const exits = [{ row: 1, col: 20, to: 576 }, { row: 40, col: 3, to: 568 }, { row: 60, col: 60, to: 826 }];
  ok('the door nearest the last sighting is the one they took',
     exitTakenFrom(exits, { row: 2, col: 21 })?.to === 576);
  ok('and it is nearest that decides, not the order they are listed in',
     exitTakenFrom(exits, { row: 41, col: 4 })?.to === 568);
  ok('the distance is reported so a reader can judge the guess',
     exitTakenFrom(exits, { row: 2, col: 21 })?.squares_from_last_sighting === 1);
  // REFUSING TO GUESS IS THE IMPORTANT HALF. A leader who vanished in open ground far from
  // any door did not use one — they died, or logged out — and marching the fleet to the
  // nearest exit anyway is how a group ends up a zone away from where it should be.
  ok('vanishing in open ground is NOT a door and returns null',
     exitTakenFrom(exits, { row: 30, col: 30 }) === null);
  ok('unless the caller widens the radius on purpose',
     exitTakenFrom(exits, { row: 30, col: 30 }, { within: 40 }) !== null);
  ok('no exits means no inference', exitTakenFrom([], { row: 1, col: 1 }) === null);
  ok('no sighting means no inference', exitTakenFrom(exits, null) === null);
  ok('a malformed sighting is refused rather than guessed at',
     exitTakenFrom(exits, { row: NaN, col: 2 }) === null);
}

console.log('');
console.log('an edge exit is a whole wall, not a doorway');
{
  // THE BUG THIS FIXES. The Cragged Mountains has FIVE exits and every one is an edge: it
  // carries a direction and an arriveRow/arriveCol in the DESTINATION room, and nothing at
  // all about where you stand in this one. Requiring a row/col filtered all five out, so
  // followers walked to the wall their leader had just crossed and then reported, correctly
  // and uselessly, that there was no door near where they vanished.
  const edges = [
    { leaveName: 'north', to: 576 }, { leaveName: 'south', to: 579 },
    { leaveName: 'west',  to: 568 }, { leaveName: 'east',  to: 826 },
  ];
  const room = { rows: 60, cols: 50 };
  const near = exitTakenFrom(edges, { row: 2, col: 40 }, room);
  ok('a leader who vanished by the north wall took the north exit', near?.to === 576);
  // You leave a room by walking off the edge WHEREVER YOU ARE STANDING, so the crossing
  // point is the sighting projected onto that wall -- not a staging square the router likes
  // on the far side of the room.
  ok('and the crossing point is their own column on that wall',
     near?.at?.row === 1 && near.at.col === 40, JSON.stringify(near?.at));
  ok('one square from the wall is one square away', near?.squares_from_last_sighting === 1);

  ok('the south wall is measured from the far side',
     exitTakenFrom(edges, { row: 59, col: 10 }, room)?.to === 579);
  ok('west', exitTakenFrom(edges, { row: 30, col: 2 }, room)?.to === 568);
  ok('east', exitTakenFrom(edges, { row: 30, col: 49 }, room)?.to === 826);

  // The refusal still has to work, or a leader who died mid-room marches the group at a wall.
  ok('vanishing in the middle is still not a door',
     exitTakenFrom(edges, { row: 30, col: 25 }, room) === null);
  // Without room bounds an edge cannot be measured at all, and guessing is worse than null.
  ok('no room bounds means no edge inference',
     exitTakenFrom(edges, { row: 2, col: 40 }) === null);
  // Both kinds in one room: whichever is genuinely nearer wins.
  const mixed = [{ leaveName: 'north', to: 576 }, { row: 30, col: 25, to: 999 }];
  ok('a go exit still wins when it is the nearer one',
     exitTakenFrom(mixed, { row: 30, col: 26 }, room)?.to === 999);
  ok('and the edge wins when it is', exitTakenFrom(mixed, { row: 2, col: 40 }, room)?.to === 576);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
