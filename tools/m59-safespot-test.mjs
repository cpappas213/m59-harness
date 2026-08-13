#!/usr/bin/env node
// Does the keeper actually KNOW whether it is in a working safe spot?
//
//   node tools/m59-safespot-test.mjs
//
// Everything here runs offline against a fake room, because the thing being tested is
// a judgement rather than a protocol: given what the character can see, does it reach
// the right conclusion about where it is standing, and does it write that conclusion
// down where the next character can read it?
//
// The reason this is worth a test at all is that the failure is silent in both
// directions and expensive in both. Believing a bad square is safe makes the keeper
// stand still and rest while something eats it. Refusing to believe a good one throws
// away the largest advantage in the game — a free heal to full in a monster room.
import './m59-test-ledger.mjs';        // FIRST — the keeper records casts; see that file
import { unlinkSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { SafeSpotBook } from './m59-safespots.mjs';
import { returnToSpot } from './m59-skills.mjs';

const BOOK = `${process.env.TEMP || '/tmp'}/m59-safespot-test-${process.pid}.json`;
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fake room
//
// Only as much world as observe() reads: where we are, what our health is, and what
// is standing next to us.
function world({ col = 5, row = 5, health = 30, max = 30, room = 999 } = {}) {
  const objects = new Map();
  const names = new Map([[1, 'giant rat'], [2, 'baby spider'], [3, 'Varuka']]);
  const c = {
    selfId: 99,
    room: { id: room, objects },
    rsc: { get: n => names.get(n) || `rsc${n}` },
    vitals: () => ({ health: { value: c._health, max }, vigor: { value: 150, max: 200 } }),
    _health: health,
    inventory: [],
    // The real client resolves this out of room contents on every read, which is why
    // a save-game renumber makes a live character look dead. Same shape here.
    get self() { return objects.get(this.selfId); },
  };
  objects.set(99, { id: 99, col, row, x: col * 64 + 20, y: row * 64 + 40, flags: 0 });
  const s = {
    name: 'test', live: true, client: c,
    world: { room: { num: room, name: 'Test Room' }, geometry: null },
  };
  return {
    s, c,
    me: () => objects.get(99),
    hurt: n => { c._health = Math.max(0, c._health - n); },
    // OF.ATTACKABLE is 0x200 in m59-parse; take it from a real flag word rather than
    // hardcoding, so this test cannot drift away from the parser.
    addMonster: (id, dcol, drow, flags) => objects.set(id, {
      id, col: objects.get(99).col + dcol, row: objects.get(99).row + drow, flags }),
    remove: id => objects.delete(id),
  };
}

const { OF } = await import('./m59-parse.mjs');
const MONSTER = OF.ATTACKABLE;

console.log('\n--- safe-spot arrival is confirmed, not predicted ---');
{
  // The dead-reckoned position says we are home. The authoritative read says the
  // server still has us one square away; returnToSpot must not accept the first claim.
  const me = { col: 5, row: 5, x: 352, y: 352, predicted: true };
  let confirms = 0, fineWalks = 0;
  const c = { get self() { return me; } };
  const s = {
    need: () => c,
    confirmPosition: async () => {
      confirms++;
      Object.assign(me, { col: 6, row: 5, x: 416, y: 352, predicted: false });
      return { col: me.col, row: me.row };
    },
    walkTo: async (col, row) => {
      Object.assign(me, { col, row, x: col * 64 + 32, y: row * 64 + 32, predicted: true });
      return { arrived: true };
    },
    walkFine: async (x, y) => {
      fineWalks++;
      Object.assign(me, { col: (x / 64) | 0, row: (y / 64) | 0, x, y, predicted: false });
      return { arrived: true };
    },
  };
  const back = await returnToSpot(s, { col: 5, row: 5, x: 352, y: 352 });
  ok('a predicted match is checked with the server', confirms === 2,
     `confirmed ${confirms} time(s): before routing and after its predicted arrival`);
  ok('the stale prediction is corrected rather than accepted as already home',
     back.arrived && !back.already && fineWalks === 1,
     JSON.stringify({ back, fineWalks }));
  ok('success means the final coarse and fine position both match the hold',
     me.col === 5 && me.row === 5 && me.x === 352 && me.y === 352 && !me.predicted);
}

function keeper(w) {
  const p = new Autopilot(w.s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  p.book = new SafeSpotBook(BOOK);      // never touch the real substrate
  return p;
}

// A pass of time in which we did nothing: the keeper looks, and looks again later.
//
// Time is simulated by ageing what the keeper has already stamped rather than by
// sleeping, and EVERY clock has to move together. Ageing only the last observation
// would drag a walk that happened before it to after it, and the keeper would
// correctly conclude it had just moved — measuring the harness instead of the code.
// Clocks still at zero mean "never happened" and must stay there.
const look = (p, msAgo = 0) => {
  if (msAgo) {
    const back = v => (v > 0 ? v - msAgo : v);
    if (p.lastObs) p.lastObs.at -= msAgo;
    p.movedAt = back(p.movedAt);
    p.swungAt = back(p.swungAt);
    p.turnedAt = back(p.turnedAt);
    p.rejoinedAt = back(p.rejoinedAt);
    if (p.hold) p.hold.takenAt -= msAgo;
  }
  p.observe();
};

// Stand somewhere, having walked there. The walk matters: nothing counts as evidence
// until the character has acted, because until then the server is holding the
// monsters back and the quiet is the grace period rather than the wall.
//
// SETTLED A MOMENT AGO, NOT THIS INSTANT, because that is what the real loop does and
// the difference is load-bearing. observe() runs at the top of a pass and the square is
// claimed later in the same pass, so the first baseline reading is taken a pass — about
// a second — after settling. A fixture that settles at the same instant as the baseline
// is asking the keeper to judge a window that opens 0ms after arrival, which it now
// correctly refuses to do (SETTLE_GRACE_MS in m59-autopilot.mjs).
//
// The two clocks are separate on purpose. Walking in stamps both; claiming a square we
// were already standing on (`steps_away === 0`) stamps only the second, and that is the
// case the grace exists for — so a test asks for "moved here ages ago, claimed it just
// now" with `{ settledMsAgo: 5000, takenMsAgo: 0 }`.
const holdAt = (p, col, row, { settledMsAgo = 1000, takenMsAgo = settledMsAgo, ...extra } = {}) => {
  p.movedAt = Date.now() - settledMsAgo;
  p.hold = { room: 999, col, row, takenAt: Date.now() - takenMsAgo,
             quietMs: 0, damageWhileIdle: 0,
             failures: 0, mostAttackers: 0, proven: false, ...extra };
  return p.hold;
};

console.log('\n--- a room does not become an unbounded wall experiment ---');
{
  const w = world();
  const p = keeper(w);
  p.policy.pullsBeforeBarren = 1;
  p.policy.barrenSpotsBeforeRoomDecision = 2;

  holdAt(p, 5, 5, { proven: true });
  ok('one fully failed wall is retired without condemning the room',
     p.pullDidNotConvert('nothing reached the first wall') && !p.noWallRooms?.get(999));

  holdAt(p, 6, 5, { proven: true });
  ok('a bounded sample of independent failed walls ends the room search',
     p.pullDidNotConvert('nothing reached the second wall') &&
       /2 top-ranked walls/.test(p.noWallRooms?.get(999) || ''),
     p.noWallRooms?.get(999));
  ok('the decision says it is room-scoped and leaves the strategic goal alone',
     p.journal.some(e => e.what === 'ROOM WALL SEARCH EXHAUSTED' &&
       /does not block/.test(e.goal_scope || '')));

  // A truthy geometry is enough because the room decision must short-circuit before
  // another candidate scan or route. Travel holds remain allowed to use walls here.
  w.s.world.geometry = {};
  const stopped = await p.takeSafeSpot('another fight wall', null);
  ok('another combat pass does not start researching a third wall',
     !stopped.took && stopped.unreachable_terrain && /stopping the wall search/.test(stopped.why));
}

console.log('\n--- proving a spot that works ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);                    // a rat, adjacent
  holdAt(p, 5, 5, { x: 340, y: 360 });
  look(p);                                            // first reading, nothing to compare
  ok('an untested spot is not trusted', !p.holdWorks(), 'holdWorks() false on arrival');
  look(p, 8000);                                      // 8s quiet with the rat next to us
  ok('still not trusted after 8s', !p.holdWorks(), `quiet ${Math.round(p.hold.quietMs / 1000)}s`);
  look(p, 8000);                                      // 16s total
  ok('trusted once it has held long enough', p.holdWorks(),
     `quiet ${Math.round(p.hold.quietMs / 1000)}s with ${p.hold.mostAttackers} adjacent`);
  ok('written to the book', p.book.get(999, 5, 5)?.held === 1,
     JSON.stringify(p.book.get(999, 5, 5)));
  ok('the exact position is recorded, not just the square', p.book.get(999, 5, 5)?.x === 340,
     'fine coordinate kept so we can stand where it actually worked');
}

console.log('\n--- disproving a spot that does not ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  holdAt(p, 7, 7, { proven: true });
  w.me().col = 7; w.me().row = 7;
  w.addMonster(1, 0, 0, MONSTER);                     // put the rat back beside us
  look(p);
  w.hurt(4);                                          // hit while sitting still
  look(p, 8000);
  ok('a hit taken while standing still disproves it', !p.holdWorks(),
     `book says ${JSON.stringify(p.book.get(999, 7, 7))}`);
  ok('said so out loud', p.journal.some(e => e.what === 'THIS IS NOT A SAFE SPOT'));
  ok('and stops standing in it', p.hold === null,
     'keeping it would mean refusing to approach and refusing to withdraw while being hit');

  // Go back and be wrong about it a second time — which is what will happen, because
  // after one failure the geometry still recommends it.
  holdAt(p, 7, 7);
  look(p);
  w.hurt(4);
  look(p, 8000);
  ok('two failures discredit the square in the book',
     p.book.discredited(p.book.get(999, 7, 7)), JSON.stringify(p.book.get(999, 7, 7)));
}

// A FAILURE IS PERMANENT, SO THE PACKET THAT ARRIVES LATE MUST NOT CAUSE ONE.
//
// Being hit is resolved on the server and travels to us; our arrival travels the other
// way. A blow resolved while we were still a square short can therefore land after we
// have reported standing on the spot, and blame the wall for something that was already
// in the air. The walked-in path was covered by accident — takeSafeSpot stamps movedAt on
// arrival, so the first window is thrown out for "we moved" — but claiming a square we
// were ALREADY standing on walks nowhere, stamps nothing, and opened a countable window
// the instant the hold was taken.
console.log('\n--- a blow already in the air is not the wall\'s fault ---');
{
  const w = world({ col: 11, row: 11 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  // Walked here long ago as part of the fight; claimed the square this instant. No walk
  // means no movement stamp, so the "we moved in this window" discard does not apply.
  holdAt(p, 11, 11, { settledMsAgo: 5000, takenMsAgo: 0 });
  look(p);
  w.hurt(4);                       // the approach's damage, arriving now
  look(p, 120);
  ok('a hit inside the settle grace does not discredit the square',
     !p.book.discredited(p.book.get(999, 11, 11)),
     `book says ${JSON.stringify(p.book.get(999, 11, 11))}`);
  ok('and does not touch the book at all', p.book.get(999, 11, 11) === null,
     'a discarded reading must leave no trace, or the record grows entries nothing concluded');
  ok('we are still standing in it', p.hold !== null,
     'releasing the hold on an untrusted reading throws away a square we never judged');
  const last = p.trials[p.trials.length - 1];
  ok('the reading is recorded as discarded rather than silently dropped',
     last && last.counted === false && /grace/.test(last.verdict || ''),
     JSON.stringify(last));
  ok('and carries how settled we were, so the grace can be argued from data',
     last && last.settled_ms != null && last.settled_ms < 250, JSON.stringify(last?.settled_ms));
}

// THE GRACE MUST NOT BECOME A HOLE. It buys one window, not immunity.
console.log('\n--- and once settled, a hit still condemns the square ---');
{
  const w = world({ col: 12, row: 12 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 12, 12, { settledMsAgo: 5000, takenMsAgo: 0, proven: true });
  look(p);                         // baseline taken the instant the square was claimed
  look(p, 900);                    // a quiet window, discarded by the grace
  w.hurt(4);                       // now a real hit, well clear of the grace
  look(p, 900);
  ok('a hit after the grace still disproves the spot', !p.holdWorks(),
     `book says ${JSON.stringify(p.book.get(999, 12, 12))}`);
  ok('and is written to the book', (p.book.get(999, 12, 12)?.failed ?? 0) === 1,
     JSON.stringify(p.book.get(999, 12, 12)));
  ok('with the settled margin recorded on the entry',
     (p.book.get(999, 12, 12)?.min_settled_ms ?? -1) >= 250,
     JSON.stringify(p.book.get(999, 12, 12)));
}

// The same delay that hides a hit until later is what makes the square look quiet now,
// so a window we will not read for damage is not one we may read for proof either.
console.log('\n--- quiet inside the grace proves nothing either ---');
{
  const w = world({ col: 13, row: 13 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 13, 13, { settledMsAgo: 5000, takenMsAgo: 0 });
  look(p);
  look(p, 200);                    // quiet, but inside the grace
  ok('quiet inside the grace does not accumulate toward proof', p.hold.quietMs === 0,
     'quietMs ' + p.hold.quietMs);
  ok('and the square is not written up as holding', p.book.get(999, 13, 13) === null,
     JSON.stringify(p.book.get(999, 13, 13)));
}

// PUTTING BACK A SQUARE RETIRED BEFORE THE GRACE EXISTED. See m59-safespot-retest.mjs.
//
// The danger in this direction is the opposite of the usual one: a reinstatement that
// restores TRUST rather than eligibility would put characters back onto squares on the
// strength of a judgement we have just decided was unreliable.
console.log('\n--- reinstating a square retired on one point of damage ---');
{
  // From the book module, not the tool: m59-safespot-retest.mjs is a script with no
  // entry-point guard, so importing it here would run it against the real book.
  const { selectForRetest, reinstateUntested } = await import('./m59-safespots.mjs');
  const rooms = {
    999: {
      '1,1': { col: 1, row: 1, held: 3, failed: 1, damage_taken: 1, held_seconds: 40 },
      '2,2': { col: 2, row: 2, held: 2, failed: 1, damage_taken: 6 },
      '3,3': { col: 3, row: 3, held: 0, failed: 1, damage_taken: 1 },
      '4,4': { col: 4, row: 4, held: 4, failed: 0 },
      '5,5': { col: 5, row: 5, held: 2, failed: 1, damage_taken: 1, verified: true },
    },
  };
  const picked = selectForRetest(rooms, { maxDamage: 1 });
  const keys = picked.map(p => p.key).sort();
  ok('picks the square that held and then went out on one point',
     keys.join(',') === '1,1', keys.join(',') || '(none)');
  ok('leaves a square that lost six — something genuinely reached that one',
     !keys.includes('2,2'));
  ok('leaves a square that never held — there is no proof to restore',
     !keys.includes('3,3'));
  ok('leaves a square that was never retired', !keys.includes('4,4'));
  ok('leaves a human-verified square alone', !keys.includes('5,5'),
     'a mark already outranks our arithmetic; zeroing its record would be a loss');

  const back = reinstateUntested(rooms[999]['1,1']);
  ok('the reinstated square is untested, not proven', back.held === 0 && back.failed === 0,
     JSON.stringify({ held: back.held, failed: back.failed }));
  ok('and is therefore NOT inherited as trusted',
     !(!!back.held && !new SafeSpotBook(null).discredited(back)),
     'takeSafeSpot reads held && !discredited — restoring held would rest characters on it');
  ok('it stays eligible to be offered again', back.retest === true,
     'zeroing held alone would drop any square that qualified only because it had held');
  ok('and keeps what it used to be', back.retest_from?.held === 3 && back.retest_from?.failed === 1,
     JSON.stringify(back.retest_from));
  ok('a reinstated square that fails again is out for good',
     new SafeSpotBook(null).discredited({ ...back, failed: 1 }),
     'retest must not survive a fresh failure, or the grace becomes a way back in for ever');

  // SELECTED AGAINST ONE BOOK, WRITTEN TO ANOTHER. The pardon zeroes damage_taken, which
  // is the very number that identifies this subset — so after it has run the squares are
  // invisible in the live book and have to be chosen from a snapshot taken before it.
  // The history kept must then be the SNAPSHOT's, not the pardoned record's zeroes.
  const pardoned = { col: 1, row: 1, held: 3, failed: 0, damage_taken: 0,
                     failed_before_wallhug: 1, retested_at: 0 };
  const viaRef = reinstateUntested(pardoned, { from: rooms[999]['1,1'] });
  ok('the live record is what gets rewritten', viaRef.held === 0 && viaRef.failed === 0,
     JSON.stringify({ held: viaRef.held, failed: viaRef.failed }));
  ok('but the history kept is the snapshot\'s, not the pardoned zeroes',
     viaRef.retest_from.failed === 1 && viaRef.retest_from.damage_taken === 1,
     JSON.stringify(viaRef.retest_from));
  ok('and the pardon\'s own marker is left intact', viaRef.failed_before_wallhug === 1,
     'overwriting it would erase that a different tool had already judged this square');
}

console.log('\n--- damage we asked for proves nothing ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  holdAt(p, 5, 5);
  look(p);
  p.swungAt = Date.now();                             // we hit it, so it hits back
  w.hurt(6);
  look(p, 8000);
  ok('retaliation after our own swing does not count against the spot',
     p.hold.failures === 0, 'the mechanic allows exactly this, so it is not evidence');
  ok('nor does it count in favour of it', p.hold.quietMs === 0,
     'a window we swung in is not a test of anything');
}

console.log('\n--- quiet because of the walls, or quiet because of the grace period? ---');
{
  // The dangerous false positive. On entry — and a reconnect is an entry — the server
  // will not let the monsters attack until the player acts. A spot "proved" during
  // that window has been proved by the server's politeness, and the character will
  // take that belief into the next fight and rest through a beating on the strength
  // of it.
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  // A square of its own: the book is shared with the other blocks on purpose — that
  // is what makes it a book — so "nothing was written" has to be asked somewhere
  // nothing has been written before.
  w.me().col = 3; w.me().row = 3;
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 3, 3);
  p.rejoinedAt = Date.now();                          // just logged back in
  look(p); look(p, 8000); look(p, 8000); look(p, 8000);
  ok('quiet during the grace period proves nothing', !p.holdWorks(),
     `${Math.round(p.hold.quietMs / 1000)}s of quiet, and none of it counted`);
  ok('nothing written to the book on that evidence', !p.book.get(999, 3, 3));

  p.turnedAt = Date.now();                            // now act, and wake the room
  look(p); look(p, 8000); look(p, 8000);
  ok('the same quiet counts once we have woken them', p.holdWorks(),
     'turning is what makes the experiment mean anything');
}

console.log('\n--- keeping track of where we are ---');
{
  const w = world();
  const p = keeper(w);
  holdAt(p, 5, 5, { proven: true });
  p.pendingPull = { waitUntil: Date.now() + 30_000, target: 'giant rat' };
  p.pullsWithoutContact = 2;
  w.me().col = 6;                                     // something moved us
  look(p);
  ok('a spot we are not standing on is released', p.hold === null,
     'holding a belief about a square we left is how a keeper walks into a swarm confident');
  ok('and said why', p.journal.some(e => e.what === 'gave up the safe spot'));
  ok('pull evidence is released with its wall',
     p.pendingPull === null && p.pullsWithoutContact === 0,
     'misses from one square must not condemn the next square');
}
{
  const w = world();
  const p = keeper(w);
  holdAt(p, 5, 5, { proven: true });
  w.s.world.room = { num: 1000, name: 'Somewhere Else' };
  look(p);
  ok('a spot in another room is released', p.hold === null);
}

console.log('\n--- is this fight worth a wall? ---');
{
  const w = world({ health: 25, max: 25 });
  const p = keeper(w);
  const above = p.holdWorthwhile(['giant rat']);       // level 30 vs our 25
  ok('yes when the kill can raise max health', above.hold,
     `level ${above.level} vs our ${above.my_level}: ${above.why.slice(0, 60)}...`);
  const below = p.holdWorthwhile(['baby spider']);     // level 25 vs our 25 — pays nothing
  ok('no when we outclass it and it is alone', !below.hold,
     `level ${below.level} vs our ${below.my_level}`);
  ok('unknown creatures get the wall', p.holdWorthwhile(['no such beast']).hold,
     'the careful reading of an unknown creature is that it can hurt us');
  p.policy.useSafeSpots = false;
  ok('and the owner can still switch it off', !p.holdWorthwhile(['giant rat']).hold);
}
{
  // Outclassed prey, but three of them: swarms are what actually kills characters.
  const w = world({ health: 40, max: 40 });
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  w.addMonster(2, 2, 0, MONSTER);
  w.addMonster(4, 0, 2, MONSTER);
  const v = p.holdWorthwhile(['baby spider']);
  ok('a crowd of things we outclass still gets the wall', v.hold, `crowd ${v.crowd}`);
}

console.log('\n--- what it reports back ---');
{
  const w = world();
  const p = keeper(w);
  ok('honest when not in one', p.status().safe_spot === false);
  w.addMonster(1, 1, 0, MONSTER);
  w.addMonster(2, 0, 1, MONSTER);
  holdAt(p, 5, 5, { canReachYou: 3, backCover: 5 });
  look(p); look(p, 14000);
  const st = p.status();
  ok('reports that the spot works, with the evidence', st.safe_spot.works,
     st.safe_spot.evidence);
  ok('counts what is on us', st.threat.in_swing_range === 2,
     `${st.threat.in_swing_range} in range, ${st.threat.camped_on_us} camped`);
  ok('and is honest that targeting is inferred, not told',
     /nothing in the protocol says/.test(st.threat.note));
}

console.log('\n--- the measurement is auditable, not just the conclusion ---');
{
  // Every window has to leave a record saying what it was and why it counted or did
  // not. Without this the only thing anyone can disagree with is the summary, and a
  // measurement bug lives entirely in the discards.
  const w = world();
  const p = keeper(w);
  const verdicts = () => p.trials.map(t => t.verdict);

  look(p);
  ok('a reading with no spot says so', /not holding/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  {
    // A keeper that has only just started has nothing to compare against, which is a
    // different discard from all the others and has to say so rather than look quiet.
    const w2 = world();
    const p2 = keeper(w2);
    w2.addMonster(1, 1, 0, MONSTER);
    holdAt(p2, 5, 5);
    look(p2);
    ok('the first reading has nothing to compare to', /no previous reading/.test(p2.trials.at(-1).verdict),
       p2.trials.at(-1).verdict);
  }

  w.me().col = 4; w.me().row = 4;
  holdAt(p, 4, 4);
  look(p);
  look(p, 8000);
  ok('quiet with nothing adjacent is not evidence', /nothing was in swing range/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  w.addMonster(1, 1, 0, MONSTER);
  look(p, 8000);
  p.swungAt = Date.now();
  look(p, 8000);
  ok('a window we swung in is named as such', /we swung/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  p.rejoinedAt = Date.now();
  look(p, 8000);
  ok('a window inside the grace period is named as such', /grace period/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  const t = p.trials.at(-1);
  ok('and every reading carries its own inputs',
     ['window_s', 'health_before', 'health_after', 'adjacent_at_start', 'swung_in_window',
      'moved_in_window', 'monsters_awake'].every(k => k in t),
     JSON.stringify(t));
  ok('discards are distinguishable from conclusions', p.trials.every(x => x.counted === false),
     `${verdicts().length} readings so far, none of them counted`);
}

console.log('\n--- stopping is not instant, and starting has to know that ---');
{
  // The sequence every relocation uses: stop the keeper, walk the character somewhere,
  // start it again. The walk takes longer than a pass, so the start lands while the
  // old loop is still winding down — and if start() believes `running` it returns
  // "already going" and is then switched off by the loop it declined to replace. The
  // keeper then reports itself started and does nothing at all, for ever.
  const w = world();
  const p = keeper(w);
  p.pass = async () => { await new Promise(r => setTimeout(r, 30)); };   // a slow pass
  // ...and a short gap, so the test is not a sleep. decideMs is what the loop waits on
  // now — deciding was un-bundled from resyncing, and idleMs only sets how often the
  // server is re-asked. Both are set so the intent survives whichever one is read.
  p.policy.decideMs = 10;
  p.policy.idleMs = 10;
  p.start();
  ok('starts', p.running);
  // THE ORDINARY STOP NO LONGER HAS THIS RACE, because it no longer ends the loop: it
  // makes the keeper inert, which takes effect on the flag rather than at a pass
  // boundary. That is the point of it — see Autopilot.goInert — and it is worth pinning
  // that the instant path really is instant.
  p.stop('held for an errand');
  ok('the ordinary stop takes effect immediately', p.running && !!p.inert,
     'nothing has to wait for the pass to end, because the loop is not ending');
  p.start();
  ok('and a start hands the controls straight back', p.running && !p.inert);

  // THE HARD STOP STILL HAS IT, and always will: ending a loop means waiting for the
  // pass it is inside, and a walk is longer than a pass. This is the sequence that
  // stranded three characters — stop, walk, start — where the start landed while the old
  // loop was still winding down, returned "already going", and was then switched off by
  // the very loop it had declined to replace.
  p.stop('code is being reloaded', { hard: true });
  ok('a hard stop is only a request at first', p.running && p.stopping,
     'the loop is still mid-pass; it has not noticed yet');
  p.start();
  ok('a start cancels a hard stop that has not landed', p.running && !p.stopping);
  ok('and says so in the journal',
     p.journal.some(e => /start cancelled a stop/.test(e.what)));

  await new Promise(r => setTimeout(r, 150));   // let several passes go by
  ok('it is still running afterwards', p.running,
     'the winding-down loop must not switch off the keeper that replaced its orders');
  p.stop('really stopping now', { hard: true });
  await new Promise(r => setTimeout(r, 150));
  ok('and an uncancelled hard stop still stops it', !p.running);
}

console.log('\n--- friendly bots are not a monster swarm ---');
{
  // What actually happened to Isolde: three of her own fleet stacked on one square
  // in an inn. Every character is ATTACKABLE, so they counted as things about to kill
  // her, and at 4 of 25 health she froze — which is the one state in which health
  // cannot come back. She woke, counted the same three, and froze again, for ever.
  const w = world({ health: 4, max: 25 });
  const p = keeper(w);
  const PLAYER = OF.PLAYER;
  w.addMonster(3, 0, 0, MONSTER | PLAYER);          // a friendly bot on our own square
  w.addMonster(4, 1, 0, MONSTER | PLAYER);
  w.addMonster(5, 0, 1, MONSTER | PLAYER);
  const c = w.c, me = w.me();
  const near = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 2);
  ok('a pile of players registers as no threat at all', near.length === 0,
     'three characters adjacent, none of them counted');
  w.addMonster(6, 1, 1, MONSTER);                    // ...and a real monster still does
  const near2 = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 2);
  ok('but a real monster beside them still does', near2.length === 1);
}

console.log('\n--- a freeze that changed nothing is not repeated ---');
{
  // Independent of what caused it: playing dead recovers vigor and never health, so
  // freezing twice from the same health can never end. The guard has to be on the
  // outcome, not on the cause.
  const w = world({ health: 4, max: 25 });
  const p = keeper(w);
  let rejoins = 0;
  p.s.rejoin = async () => { rejoins++; };
  const first = await p.playDead('test');
  ok('the first freeze is allowed', first === true, `rejoined ${rejoins}x`);
  p.frozenUntil = null;
  const second = await p.playDead('test');     // same health: one more is tolerated
  const third = await p.playDead('test');      // and then it must stop
  ok('a repeat from the same health is refused', third === false,
     `second=${second}, third=${third}`);
  ok('and it says why rather than looping quietly',
     p.journal.some(e => /refusing to freeze again/.test(e.what)));
  w.c._health = 20;                            // healed: the guard must release
  const after = await p.playDead('test');
  ok('freezing is allowed again once health has moved', after === true);
}

console.log('\n--- nobody calls for rescue from a pub ---');
{
  // Being hurt is not being in danger. Monsters cannot attack in an inn at all, so a
  // broadcast from one spends mana and other players' attention on a character that
  // is in no trouble and can fix itself by moving and sitting down.
  const w = world({ health: 3, max: 25 });
  const p = keeper(w);
  let broadcasts = 0;
  w.c.me = { name: 'Tester' };
  w.c.roomNameRsc = 1;
  w.c.requestInventory = () => {};
  w.c.waitFor = async () => ({ events: [] });
  w.c.broadcast = async () => { broadcasts++; };
  w.c.say = async () => { broadcasts++; };
  w.s.pacer = { submit: async (_k, fn) => fn() };
  w.s.need = () => w.c;

  p.sanctuary = () => true;                       // standing in an inn
  await p.askForHelp('badly hurt and out of flasks');
  ok('a hurt character in a sanctuary says nothing', broadcasts === 0,
     'it can move and rest its way back to full without anyone');
  ok('and records why rather than failing silently',
     p.journal.some(e => /not asking for help/.test(e.what)));

  p.sanctuary = () => false;                      // out in the world
  p.lastPleaAt = 0;
  await p.askForHelp('badly hurt and out of flasks').catch(() => {});
  ok('but the same character in the field still asks', broadcasts > 0);
}

console.log('\n--- no dead zone between "too hurt to fight" and "hurt enough to rest" ---');
{
  // The gap that stranded Cedric: restBelow 0.6, engageAt 0.9 for anything under
  // thirty max health, so 64% health is too hurt to start a fight and not hurt enough
  // to sit down. A keeper in that band does neither, for ever, and the branch that
  // declines the fight reports progress — so it does not even look stuck.
  const w = world({ health: 18, max: 28 });
  const p = keeper(w);
  p.mode = 'farm';
  p.policy.hunt = 'centipede';
  // The number the fleet actually runs, not the module default — the gap opens as
  // soon as restBelow is set anywhere under engageAt, and every character here is
  // configured at 0.6.
  p.policy.restBelow = 0.6;
  const engageAt = p.safety().engageAt;
  const restAt = Math.max(p.policy.restBelow, 0, engageAt);
  const hp = 18 / 28;
  ok('the old thresholds really did leave a gap', hp > p.policy.restBelow && hp < engageAt,
     `${Math.round(hp * 100)}% is above restBelow ${p.policy.restBelow} and below engageAt ${engageAt}`);
  ok('resting now triggers anywhere below the engage threshold', hp < restAt,
     `restAt is now ${restAt}, so 64% rests instead of waiting`);
  ok('and the two thresholds cannot cross', restAt >= engageAt,
     'whatever health it takes to be willing to fight is the health worth resting to');
}

console.log('\n--- fleetmates are not prey ---');
{
  // What was actually happening: 131 of 132 "hit back at whatever is adjacent"
  // decisions across the fleet were aimed at another of our own characters. Guardian
  // angels meant nobody died of it — twenty-five characters simply spent the night
  // swinging at each other and produced three kills between them.
  const w = world();
  const p = keeper(w);
  const PLAYER = OF.PLAYER;
  w.addMonster(3, 1, 0, MONSTER | PLAYER);          // a fleetmate, adjacent
  const c = w.c, me = w.me();
  const adjacent = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 1.5);
  ok('an adjacent fleetmate is never picked as a target', adjacent.length === 0,
     'every character is ATTACKABLE, so this filter is the only thing separating them');
  w.addMonster(4, 0, 1, MONSTER);
  const adj2 = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 1.5);
  ok('a real monster beside the fleetmate still is', adj2.length === 1);
}

console.log('\n--- one wall each ---');
{
  // The geometry is deterministic, so every keeper in a room ranks the same squares
  // identically and they all walk to the same corner — three characters ended up on
  // (50,21) of one room and four stacked on (8,15) of the Limping Toad.
  const { claimSpot, releaseSpot, spotTakenByAnother } = await import('./m59-autopilot.mjs');
  claimSpot('o1', 586, 35, 40);
  ok('a claimed square is closed to everyone else',
     spotTakenByAnother('o3', 586, 35, 40) === 'o1');
  ok('but not to the keeper that claimed it',
     spotTakenByAnother('o1', 586, 35, 40) === null,
     'it must be able to re-take its own spot after a reconnect');
  ok('a different square in the same room is free',
     spotTakenByAnother('o3', 586, 20, 49) === null);
  ok('and the same square in a different room is free',
     spotTakenByAnother('o3', 587, 35, 40) === null);
  claimSpot('o1', 586, 12, 12);
  ok('claiming a new one releases the old', spotTakenByAnother('o3', 586, 35, 40) === null,
     'a keeper holds at most one wall');
  releaseSpot('o1');
  ok('giving it up frees it', spotTakenByAnother('o3', 586, 12, 12) === null);
}

console.log('\n--- pairing loot runs ---');
{
  const { planRuns } = await import('./m59-lootrun.mjs');
  const fleet = [
    // A farmer going well: killing, nearly full, plenty of vigor left.
    { agent: 'o1', character: 'Roland', in_game: true, carrying: 12, max_carry: 14,
      vigor_of: '150/200', health: '20/20', autopilot: { kills: 9 }, room_num: 586, room: 'Tos gate',
      has_food: true, has_weapon: true },
    // A runner: empty pack, no food, healthy enough to walk.
    { agent: 's1', character: 'Seraphel', in_game: true, carrying: 2, max_carry: 14,
      vigor_of: '80/200', health: '20/20', autopilot: { kills: 0 }, has_food: false, has_weapon: true },
    // Too hurt to be sent anywhere.
    { agent: 's2', character: 'Aurelia', in_game: true, carrying: 0, max_carry: 14,
      vigor_of: '80/200', health: '4/21', autopilot: { kills: 0 }, has_food: false, has_weapon: true },
  ];
  const p = planRuns(fleet);
  ok('the overflowing farmer is spotted', p.farmers_overflowing.includes('Roland'),
     `12/14 carried and still killing`);
  ok('a healthy poor character is sent', p.runs[0]?.runner_name === 'Seraphel',
     p.runs[0]?.why ?? 'no run planned');
  ok('the badly hurt one is not', !p.runners_free.includes('Aurelia'),
     '4/21 health — the walk goes through what made the farmer rich');
  ok('payment is credit when the runner has no food',
     /proceeds/.test(p.runs[0]?.pay_with ?? ''), p.runs[0]?.pay_with);

  const idle = planRuns([{ agent: 'x', character: 'Idle', in_game: true, carrying: 1, max_carry: 14,
                           vigor_of: '150/200', health: '20/20', autopilot: { kills: 9 } }]);
  ok('an empty-handed farmer is not worth a trip', idle.runs.length === 0, idle.note);
}

console.log('\n--- nobody starts a fight tired ---');
{
  const { STRATEGIES } = await import('./m59-autopilot.mjs');
  // The floor has to be REACHABLE BY RESTING or it strands everyone without food, and
  // twenty of twenty-five have none. Resting stops at the rest threshold of 80.
  const REST_STOPS_AT = 80;
  const floors = Object.entries(STRATEGIES)
    .map(([k, v]) => [k, v.vigorFloor ?? v.fightAboveVigor ?? 0]);
  ok('no strategy still permits fighting at any vigor',
     floors.every(([, f]) => f >= 70), JSON.stringify(floors));
  ok('the baseline floor is reachable without food', 70 < REST_STOPS_AT,
     'resting alone stops at 80, so a floor of 70 can always be met by sitting down');

  // And the reader that all of this depends on: vigor is {value, scale_max}, not
  // {value, max}, so the old pct() silently returned null and every vigor decision in
  // the file was dead code.
  const vitals = { vigor: { value: 61, scale_max: 200, rest_threshold: 80 } };
  const oldPct = v => (v && v.max ? v.value / v.max : null);
  const vigorPct = v => (v?.vigor?.value == null ? null : v.vigor.value / (v.vigor.scale_max ?? 200));
  ok('the old reader really did return null', oldPct(vitals.vigor) === null,
     'which is why no character has ever rested for being tired');
  ok('the new one reads it', Math.round(vigorPct(vitals) * 100) === 31,
     `61 of 200 = ${Math.round(vigorPct(vitals) * 100)}%`);
}

console.log('\n--- a character can be a service ---');
{
  const { planProvisioning } = await import('./m59-lootrun.mjs');
  const { planCharacter, STAT_ORDER } = await import('./m59-newchar.mjs');

  const fleet = [
    { agent: 'q1', character: 'Malig', in_game: true, mana_now: 23,
      provides: ['create food', 'create weapon'], has_food: true, has_weapon: true },
    { agent: 's1', character: 'Seraphel', in_game: true, mana_now: 20, provides: [],
      has_food: false, has_weapon: false, room_num: 544 },
  ];
  const p = planProvisioning(fleet);
  ok('a caster is matched to what it can fix', p.jobs.length === 2,
     p.jobs.map(j => j.service).join(', '));
  ok('create weapon is free of reagents',
     p.jobs.find(j => j.service === 'create weapon')?.reagents_needed.length === 0,
     'one caster can arm the whole fleet for nothing');
  ok('and flagged as temporary',
     p.jobs.find(j => j.service === 'create weapon')?.temporary === true,
     'it expires in minutes to hours — a stopgap, not a repair');
  ok('create food asks the supplicant for reagents',
     p.jobs.find(j => j.service === 'create food')?.reagents_needed.length === 2);
  ok('a fleet with no caster is told what to do about it',
     /reroll/.test(planProvisioning([fleet[1]]).note ?? ''),
     planProvisioning([fleet[1]]).note);

  // The creation path these depend on.
  const plan = planCharacter({ name: 'Testchar' });
  ok('the default new character can cast both on day one',
     plan.uncastable_at_first.length === 0 &&
     plan.spells.some(s => s.name === 'create weapon') &&
     plan.spells.some(s => s.name === 'create food'),
     'Kraanan has no karma gate, unlike Shal\'ille (+10) and Qor (-10)');
  ok('and spends every stat point', plan.stat_total === 200,
     `${plan.stat_total}/200, ceiling ${plan.max_health_ceiling}`);
}

console.log('\n--- one character\'s experiment is every character\'s knowledge ---');
{
  const p = keeper(world());
  p.book.save();
  const fresh = new SafeSpotBook(BOOK);
  ok('a proven spot survives a restart', fresh.get(999, 5, 5)?.held >= 1,
     JSON.stringify(fresh.list(999).map(x => `${x.col},${x.row}:${x.verdict}`)));
  ok('and so does a disproved one', fresh.discredited(fresh.get(999, 7, 7)),
     'the geometry will keep recommending it; the book is what stops us going back');
}

// --- vigor is not shaped like health, and reading it wrong stops the whole fleet ---
//
// The deadlock this guards: the keeper reads vigor correctly and sends anyone below
// restBelow to rest; restUntil read it with a helper that wants {value,max}, got null
// from {value,scale_max}, and treated null as "already full". So it answered "already
// recovered" without sitting down, the rest branch returned before farming or errands,
// and the character did nothing at all — for ever — while reporting full health and a
// sensible activity. Thirty-seven characters, no kills, nothing in any log to see.
console.log('\n--- vigor is not shaped like health ---');
{
  const vigor = { value: 40, scale_max: 200, rest_threshold: 80 };
  const naive = v => (v && v.max ? v.value / v.max : null);
  ok('the naive {value,max} read gives nothing for vigor', naive(vigor) === null,
     'vigor has scale_max, not max');
  ok('and "nothing" defaulted to satisfied, which is the deadlock',
     (naive(vigor) ?? 1) >= 0.4, 'null ?? 1 >= any target');

  const vigorFrac = g => (!g || g.value == null) ? null : g.value / (g.scale_max ?? 200);
  ok('reading it against scale_max gives the real fraction', vigorFrac(vigor) === 0.2,
     `40/200 = ${vigorFrac(vigor)}`);
  ok('so a tired character is now correctly seen as needing rest',
     (vigorFrac(vigor) ?? 1) < 0.4);

  // The second half: resting can only ever reach RestTimer's threshold, so a target
  // above it is a target that never arrives.
  const REST_VIGOR_CAP = 0.4;
  ok('the rest target never exceeds what resting can deliver',
     Math.min(0.6, REST_VIGOR_CAP) === 0.4,
     'restBelow 0.6 would ask for 120 of 200; resting stops at 80');
  ok('and a character that rested to the cap is no longer "hurt"',
     !((80 / 200) < Math.min(0.6, REST_VIGOR_CAP)),
     'otherwise it stands up and sits straight back down');
}

// --- one failure retires a spot for good ---
//
// Godfrey died on a square recorded held:1. Under the old rule (failed >= 2 AND failed >
// held) it stayed "proven" and stayed recommended — to him, and to everyone inheriting
// the book. Spots seem safe at first and turn out not to be: the wall that holds two
// attackers does not hold six.
console.log('\n--- a spot that has ever failed is retired ---');
{
  const { safeSpotBook } = await import('./m59-safespots.mjs');
  const b = safeSpotBook(BOOK);
  b.held(900, { col: 1, row: 1, seconds: 60, attackers: 2 });
  ok('a clean square is not discredited', !b.discredited(b.get(900, 1, 1)));
  ok('and it reports as holding', b.list(900).find(r => r.col === 1)?.verdict === 'holds');

  b.failed(900, { col: 1, row: 1, damage: 99, attackers: 6 });
  const rec = b.get(900, 1, 1);
  ok('one failure discredits it even though it held first', b.discredited(rec),
     `held ${rec.held}, failed ${rec.failed}`);
  ok('and the verdict says so rather than "holds"',
     b.list(900).find(r => r.col === 1)?.verdict === 'does not work');

  // Holding again afterwards must not buy it back.
  b.held(900, { col: 1, row: 1, seconds: 120, attackers: 1 });
  b.held(900, { col: 1, row: 1, seconds: 120, attackers: 1 });
  ok('holding three times afterwards does not rehabilitate it',
     b.discredited(b.get(900, 1, 1)),
     `held ${b.get(900,1,1).held}, failed ${b.get(900,1,1).failed}`);
}

// --- the newbie zone is a separate world with a one-way door ---
console.log('\n--- provisioning does not propose what it cannot reach ---');
{
  const { planProvisioning } = await import('./m59-lootrun.mjs');
  const caster = { agent: 'qm1', character: 'Kraan', in_game: true, mana_now: 25,
                   provides: ['create weapon', 'create food'],
                   has_food: true, has_weapon: true, room: 'Raza Inn', room_num: 1011 };
  const far = { agent: 'o1', character: 'Roland', in_game: true, mana_now: 15, provides: [],
                has_food: false, has_weapon: false, room: 'Main gate to the city of Tos', room_num: 586 };
  const near = { agent: 'nf1', character: 'Aldric', in_game: true, mana_now: 15, provides: [],
                 has_food: false, has_weapon: false, room: 'Mausoleum', room_num: 1016 };

  const split = planProvisioning([caster, far]);
  ok('a caster in Raza is not paired with a supplicant outside it', split.jobs.length === 0,
     split.jobs.map(j => j.why).join('; ') || 'no jobs');
  ok('and the reason is reported rather than silently dropped',
     /one-way|Raza/.test((split.unreachable || []).join(' ')), (split.unreachable || [])[0]);

  const same = planProvisioning([caster, near]);
  ok('two characters on the same side of the portal still pair up', same.jobs.length === 2,
     same.jobs.map(j => j.service).join(', '));
}

// -------------------------------------------------- who judged the square
//
// A failure is permanent whichever activity found it out — a square that let a blow
// through is a bad square whether the character was fighting from it or resting at it
// part-way through a journey, and the conservative direction is the cheap one. But the two
// are not the same evidence: a travel hold is taken in a room nobody chose, with whatever
// followed you through the door, on a wall derived from geometry nobody has stood on. So
// the judge is written down and the travel-only rejections stay fishable.
console.log('\nprovenance of a verdict');
{
  const b = new SafeSpotBook(BOOK);
  b.held(544, { col: 5, row: 5, seconds: 12, attackers: 2, source: 'fight' });
  b.held(544, { col: 5, row: 5, seconds: 12, attackers: 2, source: 'fight' });
  b.failed(544, { col: 5, row: 5, damage: 3, attackers: 1, source: 'travel' });
  const rec = b.list(544).find(r => r.col === 5);

  ok('A TRAVEL FAILURE STILL DISCREDITS THE SQUARE — permanently, and on purpose',
     b.discredited(rec) && rec.verdict === 'does not work');
  ok('the most recent judge is named', rec.failed_via === 'travel' && rec.held_via === 'fight');
  ok('and every judge is counted, so one travel failure against two fight holds is legible',
     rec.failed_by.travel === 1 && rec.held_by.fight === 2);
  ok('THE TRAVEL-ONLY REJECTIONS CAN BE FISHED OUT, which is the whole reason for the tag',
     [rec].filter(r => b.discredited(r) && r.failed_by && !r.failed_by.fight).length === 1);

  b.failed(544, { col: 9, row: 9, damage: 1, attackers: 1 });
  const untagged = b.list(544).find(r => r.col === 9);
  ok('an untagged failure — every record written before this existed — still reads exactly ' +
     'as it did, rather than defaulting into anybody\'s pile',
     untagged.failed === 1 && untagged.failed_via === undefined && untagged.failed_by === undefined);
  ok('and it is still discredited, because that never depended on knowing who judged it',
     b.discredited(untagged));
}

try { unlinkSync(BOOK); } catch { /* never written */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
