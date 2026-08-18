#!/usr/bin/env node
// DANGER-AVOIDANT ROUTING, against a hand-built graph rather than the world.
//
// A fixture, deliberately: the real map changes when somebody rebuilds it, and a test that
// asserts "the route from the crypts to town avoids the graveyard" would then be measuring
// the map rather than the algorithm. What is pinned here is the algorithm's shape, and the
// four ways it is easy to get wrong:
//
//   - a route is as dangerous as its WORST room, never its average
//   - an unknown room is safe, not hazardous
//   - a detour is bounded, because every extra room can choose a fight of its own
//   - and the fallback is exactly the old behaviour, so the worst case is unchanged

import assert from 'node:assert/strict';
import { findPath, roomDanger, hazardReason, loadMap } from './m59-map.mjs';

// A diamond: 1 -> (2 | 3) -> 4, where 2 is quiet and 3 is lethal. Plus a long quiet
// detour 1 -> 5 -> 6 -> 7 -> 8 -> 4 for the budget tests.
const map = { rooms: {
  90001: { num: 90001, name: 'start', goExits: [], edgeExits: [{ to: 90002 }, { to: 90003 }, { to: 90005 }] },
  90002: { num: 90002, name: 'quiet', goExits: [], edgeExits: [{ to: 90004 }] },
  90003: { num: 90003, name: 'lethal', goExits: [], edgeExits: [{ to: 90004 }] },
  90004: { num: 90004, name: 'end', goExits: [], edgeExits: [] },
  90005: { num: 90005, name: 'long a', goExits: [], edgeExits: [{ to: 90006 }] },
  90006: { num: 90006, name: 'long b', goExits: [], edgeExits: [{ to: 90007 }] },
  90007: { num: 90007, name: 'long c', goExits: [], edgeExits: [{ to: 90008 }] },
  90008: { num: 90008, name: 'long d', goExits: [], edgeExits: [{ to: 90004 }] },
} };
const via = result => result.hops.map(h => h.to);

// --- the basic choice ------------------------------------------------------------
{
  // The long way is rated too, so this test is about the diamond rather than about the
  // detour — an unrated corridor would legitimately beat both, which the next test covers.
  const danger = new Map([[90002, 200], [90003, 870], [90005, 500], [90006, 500], [90007, 500], [90008, 500]]);
  const p = findPath(map, 90001, 90004, { avoid: null, danger });
  assert.deepEqual(via(p), [90002, 90004], 'the quiet room is preferred over the lethal one');
  assert.equal(p.worst_rating, 200);
  assert.equal(p.detoured, false, 'same length, so not a detour');

  // Reverse the ratings and the choice reverses with them — the rule is the rating, not
  // the room number or the order the exits happen to be declared in.
  const flipped = findPath(map, 90001, 90004, { avoid: null, danger: new Map([[90002, 870], [90003, 200], [90005, 500], [90006, 500], [90007, 500], [90008, 500]]) });
  assert.deepEqual(via(flipped), [90003, 90004]);
}

// --- a route is its worst room, not its average ----------------------------------
{
  // The long way is four mild rooms; the short way is one terrible one. Averaging would
  // pick the short way, and that is the mistake this is here to prevent.
  const danger = new Map([[90002, 800], [90003, 800], [90005, 100], [90006, 100], [90007, 100], [90008, 100]]);
  const p = findPath(map, 90001, 90004, { avoid: null, danger });
  assert.deepEqual(via(p), [90005, 90006, 90007, 90008, 90004]);
  assert.equal(p.worst_rating, 100);
  assert.equal(p.detoured, true);
}

// --- an unknown room is safe, not hazardous --------------------------------------
{
  // Most of the world generates nothing. Treating silence as danger would route around
  // every town square in the game.
  const p = findPath(map, 90001, 90004, { avoid: null,
    danger: new Map([[90002, 300], [90005, 500], [90006, 500], [90007, 500], [90008, 500]]) });
  assert.deepEqual(via(p), [90003, 90004], 'room 3 is unrated, which beats room 2 at 300');
  assert.equal(p.worst_rating, 0);
}

// --- the destination's own danger is not counted ---------------------------------
{
  // A character sent to a hunting room is meant to be in it. Counting the destination
  // would make every route to a good farm look like a bad route, and there is nothing to
  // be done about it anyway — it is where the orders say to go.
  const p = findPath(map, 90001, 90004, { avoid: null, danger: new Map([[90004, 999], [90002, 10], [90003, 20], [90005, 500], [90006, 500], [90007, 500], [90008, 500]]) });
  assert.equal(p.worst_rating, 10);
  assert.deepEqual(via(p), [90002, 90004]);
}

// --- the detour is bounded -------------------------------------------------------
{
  // Its own fixture, because the danger has to sit on a room the route PASSES THROUGH —
  // the destination's own rating is deliberately not counted, so a two-room graph cannot
  // express this at all. Short way is two hops through a nasty room; long way is seven
  // hops through quiet ones.
  const chain = (from, to) => ({ num: from, name: `r${from}`, goExits: [],
    edgeExits: [{ to }] });
  const far = { rooms: {
    91001: { num: 91001, name: 'start', goExits: [], edgeExits: [{ to: 91002 }, { to: 91003 }] },
    91002: { num: 91002, name: 'nasty shortcut', goExits: [], edgeExits: [{ to: 91009 }] },
    91003: chain(91003, 91004), 91004: chain(91004, 91005), 91005: chain(91005, 91006), 91006: chain(91006, 91007), 91007: chain(91007, 91008),
    91008: chain(91008, 91009),
    91009: { num: 91009, name: 'end', goExits: [], edgeExits: [] },
  } };
  const quiet = new Map([[91002, 900], [91003, 10], [91004, 10], [91005, 10], [91006, 10], [91007, 10], [91008, 10]]);
  // Shortest is 2 hops, so the budget is 6 and the seven-hop alternative is refused —
  // even though it is far quieter. Six extra rooms of exposure is its own risk.
  const p = findPath(far, 91001, 91009, { avoid: null, danger: quiet });
  assert.equal(p.hops.length, 2, 'the long way is outside the detour budget');
  assert.equal(p.worst_rating, 900, 'and the route taken is honest about what is on it');

  // Shorten the alternative to inside the budget and the preference now applies.
  const near = { rooms: { ...far.rooms, 91003: chain(91003, 91008) } };
  const q = findPath(near, 91001, 91009, { avoid: null, danger: quiet });
  assert.equal(q.hops.length, 3, 'three hops is inside the budget of six');
  assert.equal(q.worst_rating, 10);
  assert.equal(q.detoured, true);
}

// --- avoid is a hard exclusion on top --------------------------------------------
{
  // `avoid` is a measured fact the spawn table cannot express — 534 is deadly in transit
  // because of how many things gang up in it, not because one generator is remarkable.
  const danger = new Map([[90002, 10], [90003, 20], [90005, 500], [90006, 500], [90007, 500], [90008, 500]]);
  const p = findPath(map, 90001, 90004, { avoid: new Set([90002]), danger });
  assert.deepEqual(via(p), [90003, 90004], 'the quieter room is excluded outright');
  // But never for where we are or where we are going: a character standing in a hazard
  // has to be able to leave it, and one sent to it has to arrive.
  assert.equal(findPath(map, 90002, 90004, { avoid: new Set([90002]), danger }).found, true);
  assert.equal(findPath(map, 90001, 90002, { avoid: new Set([90002]), danger }).found, true);
}

// --- the fallback is the old behaviour -------------------------------------------
{
  // With no danger data — an unreadable or absent spawn table — this must route exactly
  // as it did before any of this existed, which is the property that makes the change safe
  // to put in the most load-bearing function in the repository.
  const p = findPath(map, 90001, 90004, { avoid: null, danger: new Map() });
  assert.equal(p.found, true);
  assert.equal(p.hops.length, 2);
  assert.equal(findPath(map, 90001, 90004, { avoid: null, danger: false }).found, true);
  // And an unreachable destination still fails the same way rather than hanging.
  const isolated = { rooms: { ...map.rooms, 90009: { num: 90009, name: 'island', goExits: [], edgeExits: [] } } };
  const none = findPath(isolated, 90001, 90009, { avoid: null, danger: new Map([[90002, 5]]) });
  assert.equal(none.found, false);
  assert.match(none.reason, /no route/);
}

// --- same room in, nothing out ---------------------------------------------------
assert.deepEqual(findPath(map, 90004, 90004, { avoid: null, danger: new Map() }).hops, []);

// --- the real table parses and rates by attack rating ----------------------------
{
  // Not asserting specific rooms — that is the map's business and it gets rebuilt — only
  // that the table loads, is keyed by number, and holds ratings rather than levels.
  const table = roomDanger({ refresh: true });
  assert.ok(table instanceof Map);
  for (const [room, rating] of table) {
    assert.equal(Number.isInteger(room), true, 'keyed by room number');
    assert.ok(rating > 0, 'a room in the table has a positive rating');
  }
}

// --- THE HARD BLOCK, WHICH IS A DIFFERENT THING FROM THE SOFT ONE ----------------
//
// The distinction is the whole point and it is easy to collapse by accident: `avoid` is a
// preference that the permissive fallback drops when there is no other way, and NEVER_ENTER
// is not. A room that kills by arithmetic rather than by a fight has no "no other way"
// worth taking — "no route" is the correct answer, and it must survive every fallback in
// findPath, including the last one that used to be called with `null`.
{
  const real = loadMap();
  const HAZARD = 555;
  assert.ok(hazardReason(HAZARD), 'the hazard is declared with a reason, not a bare number');
  assert.equal(hazardReason(38), null, 'an ordinary room is not a hazard');

  // A keeper asking to go there is refused, and told why rather than getting a bare false.
  const refused = findPath(real, 534, HAZARD);
  assert.equal(refused.found, false, 'routing TO a hazard is refused by default');
  assert.equal(refused.hazard, HAZARD, 'the refusal names the room');
  assert.match(refused.reason, /acid/i, 'and says what is wrong with it');

  // A person may still send somebody deliberately — the "are you sure?" that defaults to no.
  assert.equal(findPath(real, 534, HAZARD, { allowHazardDestination: true }).found, true,
    'an explicit request is still honoured');

  // THE ORIGIN IS NEVER BLOCKED, or a character that ends up in one is stuck there for ever.
  assert.equal(findPath(real, HAZARD, 534).found, true, 'a character can always walk OUT');

  // And the block must not have quietly cut the world in half.
  assert.equal(findPath(real, 38, 374).found, true, 'ordinary routes are unaffected');
}

console.log(`routing: danger-avoidant path assertions passed (${roomDanger().size} rooms rated)`);
