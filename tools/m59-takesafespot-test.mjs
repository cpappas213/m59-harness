#!/usr/bin/env node
// TAKING A WALL: WHEN THE KEEPER STOPS LOOKING, AND WHAT IT CALLS THE ROOM WHEN IT DOES.
//
//   node tools/m59-takesafespot-test.mjs
//
// Offline. Opens no socket, touches no roster.
//
// `m59-safespot-test.mjs` pins the safe-spot BOOK — which squares are walls and how they are
// scored. This pins the DECISION on top of it: when `takeSafeSpot` refuses without searching,
// when a refusal is a verdict about the terrain rather than about this attempt, and which
// requests a fight's verdict is allowed to deny. That last one matters more than it reads:
// the road doctrine's whole answer to being hurt is `takeSafeSpot(..., source: 'travel')`, so
// a fight's blacklist leaking into it would silently take the rest stop away from every hurt
// traveller in the fleet.
//
// This header used to say "This tests the new decomposition methods", and for 544 commits it
// tested four methods that do not exist. See the note above the first group.

import { Autopilot } from './m59-autopilot.mjs';
import { crowdedSquares } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Mock session and keeper
// ---------------------------------------------------------------------------

function mockSession(overrides = {}) {
  return {
    name: 't1',
    client: {
      self: { col: 10, row: 10 },
      room: { objects: new Map() },
    },
    world: {
      room: { num: 100 },
      geometry: {
        rows: 20, cols: 20,
        walkable: () => true,
        monsterCanReach: () => true,
      },
      map: {},
      exits: () => [],
    },
    pacer: { submit: async () => {} },
    ...overrides,
  };
}

function mockKeeper(overrides = {}) {
  const s = mockSession(overrides.session);
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    s,
    policy: {
      maxBotsPerSafeSpot: null,
      los: 0,
      ...overrides.policy,
    },
    name: 't1',
    note: () => {},
    doing: null,
    noWallRooms: new Map(),
    searchSafeSpot: () => null,
    crossSameRoomIsland: async () => ({ arrived: true }),
    ...overrides,
  });
  return k;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-takesafespot-test.mjs\n');

// ===========================================================================
// THESE EIGHT USED TO CALL FOUR METHODS THAT DO NOT EXIST, AND HAD NEVER PASSED.
//
// `ea140e4` (2026-08-16) split `takeSafeSpot` into `_takeSafeSpotCheckNoWall`,
// `_takeSafeSpotSearch`, `_takeSafeSpotAllBarren` and `_takeSafeSpotWalkToSpot`, and added
// this file to test them. The helpers are not in the tree. The test is. It has reported
// `4 passed, 8 failed` ever since, through 544 commits, with every failure reading
// `k._takeSafeSpotCheckNoWall is not a function`.
//
// THE MECHANISM IS WORTH MORE THAN THE BUG. That commit touched two files: it MODIFIED
// m59-autopilot.mjs and ADDED this one. A merge resolves a modified file to one side; a new
// file has nothing to conflict with and is simply taken. So the half of the commit that was
// a new file survived and the half that was an edit did not, and the result is a suite that
// tests code nobody ships while reporting a failure everybody has learned to scroll past.
// **A commit that adds a test and the code it tests can be half-merged, and it is always the
// test half that survives.** Nothing in a green-tests habit catches that, because it is not
// green — it is a familiar red.
//
// SO THE FIX IS NOT TO RESTORE THE HELPERS. `takeSafeSpot` is 330 lines and 544 commits
// downstream of that split; re-deriving the decomposition now would be rewriting the fleet's
// survival path to satisfy a test. The behaviours those eight assertions stood for are real
// and worth pinning, so they are pinned HERE, through the method that actually runs. A
// structural test for a shape that does not exist pins nothing; a behavioural one survives
// the next refactor, which is the whole argument.
// ===========================================================================

// --- A ROOM ALREADY KNOWN TO HAVE NO USABLE WALL IS NOT RE-SCANNED ---
//
// Once several independently tested walls have all failed, continuing to scan is research
// rather than survival, and the scan is a room-sized search plus pathfinds on a one-second
// clock.

t('a room recorded as wall-less is refused without a search', async () => {
  let searched = 0;
  const k = mockKeeper({ searchSafeSpot: () => { searched++; return null; } });
  k.noWallRooms = new Map([[100, 'all walls failed']]);
  const r = await k.takeSafeSpot('why', null, { source: 'fight' });
  if (r.took !== false) throw new Error('expected took:false');
  if (r.unreachable_terrain !== true) throw new Error('expected unreachable_terrain');
  if (r.why !== 'all walls failed') throw new Error(`expected the recorded reason, got ${r.why}`);
  if (searched !== 0) throw new Error('it searched anyway — the short circuit did not fire');
});

t('a room not on that list is searched normally', async () => {
  let searched = 0;
  const k = mockKeeper({ searchSafeSpot: () => { searched++; return null; } });
  k.noWallRooms = new Map();
  await k.takeSafeSpot('why', null, { source: 'fight' });
  if (searched === 0) throw new Error('expected a search');
});

// THE VERDICT IS ABOUT FIGHTING, AND ONLY ABOUT FIGHTING. "No wall will hold this quarry" is
// a statement about pulling something to a wall. A traveller wanting somewhere to sit down
// and heal has a different question, and the road doctrine leans on it: `takeSafeSpot` with
// `source: 'travel'` is what a hurt character on the road calls, and a room blacklisted by
// some earlier fight must not deny it a rest stop.
t('but a traveller is not turned away by a fight\'s verdict', async () => {
  let searched = 0;
  const k = mockKeeper({ searchSafeSpot: () => { searched++; return null; } });
  k.noWallRooms = new Map([[100, 'all walls failed']]);
  const r = await k.takeSafeSpot('resting on the road', null, { source: 'travel' });
  if (searched === 0) throw new Error('a travel shelter request was refused on a fight verdict');
  if (r.unreachable_terrain === true && r.why === 'all walls failed')
    throw new Error('travel got the fight short circuit');
});

// --- AND NO RESULT IS A VERDICT ABOUT THE ROOM ---
//
// `barrenSpots` was removed on 2026-08-27: there is no concept of a safe wall that does not
// work. What used to sit here turned "every eligible square failed repeated pulls" into
// `unreachable_terrain: true`, and three such squares into a permanent room-level refusal.
// These pin its absence, because a removal nobody asserts is a removal somebody re-adds.

t('a fruitless search is about this attempt, never about the terrain', async () => {
  const k = mockKeeper({
    searchSafeSpot: (geo, me, room, opts) => {
      Object.assign(opts.stats, { eligible: 5, unreachable_to_us: 5 });
      return null;
    },
  });
  const r = await k.takeSafeSpot('why', null, { source: 'fight' });
  if (r.unreachable_terrain === true)
    throw new Error('a failed search was reported as a verdict on the terrain');
  if (!/more defensible than open floor/.test(r.why ?? ''))
    throw new Error(`expected the ordinary answer, got ${r.why}`);
});

t('and repeated fruitless searches never write the room off', async () => {
  const k = mockKeeper({ searchSafeSpot: () => null });
  for (let i = 0; i < 10; i++) await k.takeSafeSpot('why', null, { source: 'fight' });
  if (k.noWallRooms?.get(100))
    throw new Error('ten failed searches condemned the room');
});

// AND THE PULL COUNTER STILL MOVES THE BODY ON — it is the live decision that survived the
// removal. Four pulls that produce nothing means stop standing here; it just records nothing
// against the square, so the very next selection may choose it again.
t('four non-converting pulls give up the stand but blacklist nothing', async () => {
  const k = mockKeeper();
  k.policy.pullsBeforeMovingOn = 2;
  k.hold = { col: 5, row: 5 };
  k.releaseHold = () => { k.hold = null; };
  k.noProgress = () => {};
  if (k.pullDidNotConvert('nothing came') !== false)
    throw new Error('gave up on the first pull');
  if (k.pullDidNotConvert('nothing came') !== true)
    throw new Error('did not give up at the limit');
  if (k.barrenSpots) throw new Error('barrenSpots was recreated');
  if (k.noWallRooms?.get(100)) throw new Error('the room was condemned');
});

// --- THE SEARCH ITSELF ---

t('finding nothing is answered, not thrown', async () => {
  const k = mockKeeper({ searchSafeSpot: () => null });
  const r = await k.takeSafeSpot('why', null, { source: 'fight' });
  if (r.took !== false) throw new Error(`expected took:false, got ${JSON.stringify(r)}`);
});

t('and the square the search returns is the one that gets claimed', async () => {
  let asked = null;
  const k = mockKeeper({
    searchSafeSpot: (geo, me, room, opts) => { asked = { geo, me, room, opts }; return null; },
  });
  await k.takeSafeSpot('why', null, { source: 'fight' });
  if (!asked) throw new Error('the search was never called');
  if (asked.room?.num !== 100) throw new Error('the search was asked about the wrong room');
  if (asked.me?.col !== 10 || asked.me?.row !== 10)
    throw new Error('the search was asked from the wrong position');
  // The stats object is how the caller learns WHY nothing came back, and it is reset before
  // every attempt so it describes the last one rather than accumulating across retries.
  if (!asked.opts || typeof asked.opts.stats !== 'object')
    throw new Error('the search was not given a stats object to report through');
});
// ---------------------------------------------------------------------------
// A wall square is only worth walking to if the walk can end on it, and the fine walker
// cannot route around a body. So squares other players stand on — or next to — are skipped
// for this pass, exactly like squares we recently failed to reach. Players only: a monster
// next to a wall is what the wall is for. Castle Victoria, 2026-08-26: six characters in
// one 2x3 block, two on the same square, all "NOT MOVING".

t('crowdedSquares: another player excludes their square and its eight neighbours', () => {
  const objects = new Map([
    [1, { id: 1, col: 12, row: 10, flags: OF.PLAYER }],
    [2, { id: 2, col: 5, row: 5, flags: OF.ATTACKABLE }],   // a monster: not a crowd
    [99, { id: 99, col: 20, row: 20, flags: OF.PLAYER }],   // ourselves
  ]);
  const out = crowdedSquares(objects, 99);
  for (const k of ['12,10', '11,9', '13,11', '12,11'])
    if (!out.has(k)) throw new Error('missing ' + k);
  if (out.has('5,5')) throw new Error('a monster was treated as a crowd');
  if (out.has('20,20')) throw new Error('we excluded our own square');
  if (out.size !== 9) throw new Error('expected 9 squares, got ' + out.size);
});

t('crowdedSquares: no players, or no objects at all, is an empty set', () => {
  if (crowdedSquares(new Map(), 1).size !== 0) throw new Error('empty map');
  if (crowdedSquares(null, 1).size !== 0) throw new Error('null');
  if (crowdedSquares([{ id: 2, col: 1, row: 1, flags: OF.ATTACKABLE }], 1).size !== 0)
    throw new Error('monster only');
});

t('spotExclusions: recently unreachable squares and crowded squares are one set', () => {
  const k = mockKeeper({
    unreachableIn: () => new Set(['1,1']),
    session: { client: { selfId: 99,
      self: { col: 10, row: 10 },
      room: { objects: new Map([[7, { id: 7, col: 12, row: 10, flags: OF.PLAYER }]]) } } },
  });
  const out = k.spotExclusions(100);
  if (!out.has('1,1')) throw new Error('lost the remembered unreachable square');
  if (!out.has('12,10') || !out.has('11,10')) throw new Error('missing the crowd');
});

t('spotExclusions: with nobody around, the remembered set is returned as-is (may be null)', () => {
  const k = mockKeeper({ unreachableIn: () => null,
    session: { client: { selfId: 99, self: { col: 10, row: 10 }, room: { objects: new Map() } } } });
  if (k.spotExclusions(100) !== null) throw new Error('expected null through');
});

// ---------------------------------------------------------------------------

run();
