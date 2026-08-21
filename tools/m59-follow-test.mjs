#!/usr/bin/env node
// LEADING THE FLEET BY WALKING IN FRONT OF IT, PINNED.
//
// Offline: no socket, no roster, no broker. The two things worth pinning are the security
// boundary and the trail discipline, and the first matters more.
//
// `prod` is a SHARED SERVER. This is a command that moves twenty bodies at once, so a
// stranger who worked out the phrase could walk the fleet into open ground, into a PK trap,
// or just away from what it was doing. The speaker has to be on our own roster.

import { heardOrder, dropCrumb, nextStep, behindBy,
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
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
