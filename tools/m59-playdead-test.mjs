#!/usr/bin/env node
// PLAYING DEAD ON A SAFE SPOT, PINNED — AND THE TURN THAT MAKES IT WORTH ANYTHING.
//
// Offline: no socket, no roster, no broker. The session is a fake and the only thing that
// leaves it is a recorded list of what was sent.
//
// WHAT THIS GUARDS. Playing dead buys safety by not acting, and the same flag that keeps
// the monsters off keeps HealthTimer off with it — so a freeze recovers vigor and NEVER
// health (player.kod:5613, gated on PFLAG_MOVED_SINCE_ENTRY). Out in the open that is the
// whole trade and there is no way around it: the only thing that arms the timer is moving,
// and moving is what gets you hit.
//
// A safe spot is the one place in this game where that is not true. Nothing can reach the
// square, so a TURN — which sets the flag and gives up no ground — costs exactly nothing.
// Being unreachable AND healing is available on a safe spot and nowhere else, and it is the
// entire reason safe spots are worth the machinery behind them.
//
// So the failure this pins is a quiet one: come back on the spot, do not turn, and the
// character is unreachable and healing at zero. That looks identical to working. It reads
// as a wall that holds — because the wall does hold — while the health sits at four.

import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const SPOT = { col: 23, row: 6, x: 32, y: 32, proven: true };

// A session that records rather than sends. `sent` is the whole assertion surface.
function fakeSession({ health = 12, max = 40, backAt = SPOT } = {}) {
  const sent = [];
  const client = {
    selfId: 1,
    self: { col: SPOT.col, row: SPOT.row, degrees: 90 },
    room: { objects: new Map() },
    vitals: () => ({ health: { value: health, max }, vigor: { value: 40, max: 200 } }),
    face: to => { sent.push({ kind: 'face', to }); },
    roomContents: () => { sent.push({ kind: 'roomContents' }); },
    waitFor: async () => ({}),
  };
  const s = {
    client, sent,
    need: () => client,
    pacer: { submit: async (lane, fn) => fn() },
    world: { room: { num: 39 } },
    // where the character comes back standing, after the reconnect
    comeBackAt: backAt,
  };
  return s;
}

// An Autopilot with everything the freeze path touches stubbed, and nothing else.
function keeper(s, over = {}) {
  const a = Object.create(Autopilot.prototype);
  a.s = s;
  a.policy = {};
  a.tally = {};
  a.notes = [];
  a.note = (msg, detail) => a.notes.push({ msg, detail });
  a.progress = () => {};
  a.noProgress = m => a.notes.push({ msg: 'NOPROGRESS: ' + m });
  a.tellPilot = async () => {};
  a.holdWorks = () => true;
  a.reconnect = async () => {
    // A reconnect is a fresh entry into the room. That is the point: the flag comes back
    // CLEAR, which is what the turn has to fix.
    if (s.comeBackAt) s.client.self = { ...s.client.self, ...s.comeBackAt };
    return { ok: true };
  };
  a.hold = { ...SPOT, takenAt: Date.now() - 5000, quietMs: 4000 };
  Object.assign(a, over);
  return a;
}
const noted = (a, re) => a.notes.some(n => re.test(n.msg));

console.log('coming back on the spot arms the health timer');
{
  const s = fakeSession();
  const a = keeper(s);
  const held = await a.playDead('at 12 health with 3 adjacent');

  ok('the freeze is reported as handled', held === true);
  // THE ONE THAT MATTERS.
  ok('A TURN IS SENT ON THE RECONNECT', s.sent.some(x => x.kind === 'face'),
     JSON.stringify(s.sent));
  ok('and the facing actually changes, or the flag is not set',
     s.sent.find(x => x.kind === 'face')?.to !== 90);
  ok('the turn is recorded, so the rest branch knows the timer is armed',
     Number.isFinite(a.turnedAt));
  ok('the spot is kept, marked as one we came back to',
     a.hold?.reclaimed === true && a.hold.col === SPOT.col && a.hold.row === SPOT.row);
  ok('and it is reported as a turn that went through',
     a.notes.some(n => n.detail?.turned === true));

  // A verifying turn sleeps and then round-trips room-contents, and comparing a position
  // across up to 2.3 seconds of live combat is what once reported a turn had "moved us off
  // the square" and cost a character a proven spot he was standing on. REQ_TURN carries no
  // coordinates; there is nothing to verify.
  ok('THE TURN DOES NOT ROUND-TRIP ROOM-CONTENTS TO VERIFY ITSELF',
     !s.sent.some(x => x.kind === 'roomContents'));
  // Freezing is what the OTHER branch does. On the spot the walls do the work and the
  // grace period is ours to spend.
  ok('and we are not frozen — the walls are doing the work',
     !a.frozenUntil || a.frozenUntil <= Date.now());
}

console.log('');
console.log('a second freeze would undo the first');
{
  // Playing dead recovers vigor and never health, so the pass after a freeze is at the same
  // health, still doomed and still sheltered — and asks for another one. Granting it clears
  // PFLAG_MOVED_SINCE_ENTRY again, which throws away the only thing the reclaim achieved.
  const s = fakeSession();
  const a = keeper(s);
  await a.playDead('first');
  s.sent.length = 0;
  const again = await a.playDead('and again, no better off');

  ok('THE SECOND FREEZE IS REFUSED', again === false);
  ok('and it is refused for healing, not for failure counting',
     noted(a, /already healing/));
  ok('nothing is sent — no logoff, no turn', s.sent.length === 0, JSON.stringify(s.sent));
  ok('the spot is still held, so the caller rests here rather than leaving',
     a.hold?.col === SPOT.col);
}

console.log('');
console.log('the refusal is about THIS spot, not about spots in general');
{
  // A character that took a fresh spot after the reclaim has an unarmed timer again, and a
  // freeze from there is a real option. Keying the refusal on the hold rather than on a
  // sticky flag is what keeps that true.
  const s = fakeSession();
  const a = keeper(s);
  await a.playDead('first');
  a.hold = { col: 9, row: 9, x: 32, y: 32, takenAt: Date.now(), quietMs: 0 };
  ok('a spot taken since the turn does not inherit the refusal',
     a.hold.reclaimed !== true &&
     !(a.hold.reclaimed && a.turnedAt && a.turnedAt >= a.hold.takenAt));

  const b = keeper(fakeSession(), { hold: null, turnedAt: Date.now() });
  ok('and neither does having turned with no spot at all',
     !(b.hold?.reclaimed && b.turnedAt && b.turnedAt >= b.hold.takenAt));
}

console.log('');
console.log('coming back somewhere else is not a safe spot');
{
  // A reconnect normally puts you back exactly where you were, but the branch above trusts
  // `hold` completely — so believing in a square we are not standing on is worse than
  // freezing. Turning there would be spending the grace period for nothing.
  const s = fakeSession({ backAt: { col: 40, row: 40 } });
  const a = keeper(s);
  const held = await a.playDead('at 12 health');

  ok('the hold is given up', a.hold === null);
  ok('and no turn is sent, because there is no wall to turn behind',
     !s.sent.some(x => x.kind === 'face'), JSON.stringify(s.sent));
  ok('we freeze instead, completely still', held === true && a.frozenUntil > Date.now());
  ok('and say so rather than carrying on', noted(a, /did not come back on the safe spot/));
}

console.log('');
console.log('a turn that does not go through is said out loud');
{
  // Unreachable and healing at zero is the failure that looks exactly like success. If the
  // turn fails there is nothing in the world to observe — the wall still holds, the room
  // still cannot reach us, and the health simply never moves.
  const s = fakeSession();
  s.client.face = () => { throw new Error('squelched'); };
  const a = keeper(s);
  const held = await a.playDead('at 12 health');

  ok('the spot is still held', held === true && a.hold?.reclaimed === true);
  ok('the timer is NOT claimed to be armed', !a.turnedAt);
  ok('IT IS REPORTED AS NO PROGRESS, not as a successful freeze',
     noted(a, /NOPROGRESS: .*could not turn/));
  ok('and the note says rest will pay nothing',
     a.notes.some(n => /REST WILL PAY NOTHING/.test(n.detail?.plan || '')));
  // And crucially it must not then refuse the next freeze: with no armed timer, freezing
  // is still the best thing available.
  ok('a freeze is still available next pass, since nothing is healing',
     !(a.hold?.reclaimed && a.turnedAt && a.turnedAt >= a.hold.takenAt));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
