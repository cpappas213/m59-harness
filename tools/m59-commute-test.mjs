#!/usr/bin/env node
// THE ONE RULE THE COMMUTE DRIVER HAS, PINNED.
//
// Offline: no socket, no roster, no broker. `decide` is pure so that the rule can be argued
// with here rather than in the transit ledger three hours later.
//
// The rule is DO NOT SEND TO A CHARACTER THAT IS BUSY, and every bug this driver has had was
// a violation of it. `travel` supersedes whatever movement is in flight and the ledger
// records that as `movement cancelled by a newer command`; measured across three windows,
// this driver was the LARGEST single cause of travel failure in the fleet — 54 of 183, then
// 18 of 34, then 33 of 56 — and the journeys it cancelled were the ones that could least
// afford it: a character resting at a safe wall, one resting to full before setting out, one
// still finishing the journey that had just delivered it.

import { decide, busy, healthFraction, unavailable,
         DWELL_MS, DEPART_GAP_MS, STUCK_POLLS, RESEND_QUIET_MS, MIN_HEALTH } from './m59-commute.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const NOW = 1_800_000_000_000;
const row = (o = {}) => ({ agent: 'shadow01', character: 'Aaaa', room_num: 578,
                           health: '40/40', activity: 'waiting', committed: null, ...o });
const st = (o = {}) => ({ inn: 52, dest: 39, going: 'dest', lastRoom: 578,
                          still: 0, arrivedAt: 0, sent: 0, laps: 0, ...o });
const call = (r, s, opts = {}) => decide(r, s, { now: NOW, ...opts });

console.log('reading health');
{
  ok('a "37/49" string is read', Math.abs(healthFraction({ health: '37/49' }) - 37 / 49) < 1e-9);
  ok('an object form is read', healthFraction({ health: { value: 5, max: 10 } }) === 0.5);
  ok('a missing vital is null, not a guess', healthFraction({}) === null);
  ok('and a zero maximum does not divide by it', healthFraction({ health: '5/0' }) === null);
}

console.log('');
console.log('what counts as busy');
{
  ok('a committed journey is busy whatever the body is doing',
     busy(row({ committed: { kind: 'driven' }, activity: 'waiting' })) !== null);
  // THE THREE THAT WERE BEING CANCELLED. None of them contains the word travel, and all
  // three are the harness doing exactly what it was asked to.
  ok('holding a safe wall is busy', busy(row({ activity: 'holding a proven safe spot' })) !== null);
  ok('resting is busy', busy(row({ activity: 'resting' })) !== null);
  ok('eating to raise vigor is busy', busy(row({ activity: 'eating to raise vigor' })) !== null);
  ok('travelling is busy', busy(row({ activity: 'inert — travelling to Castle Victoria' })) !== null);
  ok('fighting is busy', busy(row({ activity: 'fighting from a proven safe spot' })) !== null);
  ok('but waiting is not', busy(row({ activity: 'waiting' })) === null);
  ok('and neither is nothing at all', busy(row({ activity: null })) === null);
}

console.log('');
console.log('who is left alone entirely');
{
  ok('logged out', /not in game/.test(unavailable(row({ in_game: false })) ?? ''));
  ok('in the Underworld', /Underworld/.test(unavailable(row({ room_num: 1 })) ?? ''));
  ok('too hurt to be given a road',
     /health/.test(unavailable(row({ health: '10/40' })) ?? ''));
  ok(`and ${Math.round(MIN_HEALTH * 100)}% is not too hurt`,
     unavailable(row({ health: '24/40' })) === null);
  ok('a healthy character is available', unavailable(row()) === null);
}

console.log('');
console.log('THE RULE: a busy character is never sent to');
{
  // Busy is checked BEFORE the arrival branch, which is the check that was missing. A
  // character standing in the room it was sent to may still be finishing the journey that
  // delivered it, and the turn-round send cancelled the tail of it.
  const atTarget = row({ room_num: 39, committed: { kind: 'driven', label: 'travelling to 39' } });
  const s = st({ arrivedAt: NOW - DWELL_MS - 1 });
  const d = call(atTarget, s);
  ok('at the destination, dwell expired, but still committed — NOT sent',
     d.action === 'skip' && d.busy === true, JSON.stringify(d));

  // And the same at the other end of the loop.
  const idle = row({ room_num: 578, activity: 'holding a proven safe spot' });
  const d2 = call(idle, st({ still: 99, sent: 0 }));
  ok('idle-looking for many rounds but holding a wall — NOT sent',
     d2.action === 'skip' && d2.busy === true, JSON.stringify(d2));

  const resting = row({ room_num: 52, activity: 'resting' });
  const d3 = call(resting, st({ still: 99, sent: 0 }));
  ok('resting to full before setting out — NOT sent', d3.action === 'skip' && d3.busy === true);

  // Recovering outranks busy, and outranks arrival, and resets the dwell so a character does
  // not come out of the Underworld already counted as having stood at its destination.
  const dead = row({ room_num: 1, activity: 'waiting' });
  const d4 = call(dead, st({ arrivedAt: NOW - DWELL_MS - 1, still: 99 }));
  ok('in the Underworld — not sent, and the counters are cleared',
     d4.action === 'skip' && d4.resetStill === true && d4.resetDwell === true);
}

console.log('');
console.log('the commute itself');
{
  const arrived = row({ room_num: 39 });
  ok('reaching the destination starts the dwell rather than turning round',
     call(arrived, st()).action === 'arrive');
  ok('during the dwell it stands still',
     call(arrived, st({ arrivedAt: NOW - 1000 })).action === 'skip');

  const d = call(arrived, st({ arrivedAt: NOW - DWELL_MS - 1 }));
  ok('after the dwell it turns round', d.action === 'send' && d.going === 'inn');

  // The other direction, to prove the state machine is a loop and not a one-way trip.
  const home = row({ room_num: 52 });
  const back = call(home, st({ going: 'inn', arrivedAt: NOW - DWELL_MS - 1 }));
  ok('and turns round again at the inn', back.action === 'send' && back.going === 'dest');

  ok('one body at a time out of a shared doorway',
     call(arrived, st({ arrivedAt: NOW - DWELL_MS - 1 }),
          { lastDeparture: NOW - 1000 }).action === 'skip');
  ok('and once the doorway is clear it goes',
     call(arrived, st({ arrivedAt: NOW - DWELL_MS - 1 }),
          { lastDeparture: NOW - DEPART_GAP_MS - 1 }).action === 'send');
}

console.log('');
console.log('re-sending a character that really is stuck');
{
  const stuck = row({ room_num: 578, activity: 'waiting' });
  ok('a genuinely idle character in the wrong room is re-sent',
     call(stuck, st({ still: STUCK_POLLS, sent: NOW - RESEND_QUIET_MS - 1 })).action === 'send');
  ok('but not before the stillness counter says so',
     call(stuck, st({ still: STUCK_POLLS - 1, sent: NOW - RESEND_QUIET_MS - 1 })).action === 'skip');
  // A JOURNEY THAT HAS JUST ENDED LEAVES A CHARACTER IDLE FOR A MOMENT. Re-sending into that
  // gap is how the driver used to cancel the journey it had issued one round earlier.
  ok('and not within the quiet window after our own last send',
     call(stuck, st({ still: STUCK_POLLS, sent: NOW - 1000 })).action === 'skip');
  ok('the re-send keeps the same destination rather than turning round',
     call(stuck, st({ going: 'dest', still: STUCK_POLLS, sent: NOW - RESEND_QUIET_MS - 1 })).going === 'dest');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
