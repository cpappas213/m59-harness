#!/usr/bin/env node
// WHAT THE MONORAIL PROMISES, PINNED.
//
// `rideTrack` consults this book on every hop, and until now nothing tested it. Offline:
// no socket, no roster, no map -- `comb` takes its geometry as an argument precisely so it
// can be asked these questions with a stub.
//
// The rule that matters most is the one that is easiest to lose: RIDABILITY OUTRANKS TIME.
// Ranking on time alone is defensible and wrong, and it is wrong in a way nothing notices,
// because a track that cannot be sent still looks like a track. It was wrong here for as
// long as the file existed, and 578 The Cragged Mountains was 31% ridable because of it.

import { comb, unprovedLegs, trackKey, recallTrack, STRIKES_BEFORE_REJECT } from './m59-tracks.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log('  FAIL ' + what); } };
const eq = (a, b, what) => ok(a === b, `${what}: expected ${b}, got ${a}`);

// A stub room with one wall: any leg whose straight line crosses wire x=1000 is refused,
// and every other leg lands exactly where it was aimed. Protocol units in, client out, the
// same convention `straighten` uses.
const WALL = 1000;
const toClient = v => (v - 64) * 16;
const stubGeo = {
  collisionReady: true,
  inBounds: () => true,
  walkable: () => true,
  moverStepLands: () => true,
  traceFineMoveClient(x0, y0, x1, y1) {
    const crosses = (x0 < toClient(WALL)) !== (x1 < toClient(WALL));
    return crosses ? { x: x0, y: y0 } : { x: x1, y: y1 };
  },
};
const geoFor = () => stubGeo;
const P = (...xs) => xs.map(([x, y]) => ({ x, y }));

console.log('unprovedLegs');
{
  ok(unprovedLegs(stubGeo, P([100, 100], [500, 100])) === 0, 'a leg on one side of the wall proves');
  eq(unprovedLegs(stubGeo, P([100, 100], [2000, 100])), 1, 'a leg through the wall is refused');
  eq(unprovedLegs(stubGeo, P([100, 100], [2000, 100], [100, 100])), 2, 'both ways count');
  // No geometry is not a refusal. A caller without a map gets loop-elided trails, which are
  // worse tracks and not wrong ones -- so it must not report every leg as broken.
  eq(unprovedLegs(null, P([100, 100], [2000, 100])), 0, 'no geometry refuses nothing');
  eq(unprovedLegs({ collisionReady: false }, P([100, 100], [2000, 100])), 0, 'geometry that is not ready refuses nothing');
}

console.log('comb ranks ridability over time');
{
  // Two crossings of the same room between the same doors. The QUICK one hops the wall;
  // the SLOW one walks around it. Ranking on time keeps the first, which cannot be sent.
  const quick = { room: 578, cameFrom: 568, goingTo: 576, body: 1, ms: 1000,
                  points: P([100, 100], [2000, 100]), entered: 0, left: 1 };
  const slow  = { room: 578, cameFrom: 568, goingTo: 576, body: 2, ms: 9000,
                  points: P([100, 100], [900, 900], [900, 100]), entered: 0, left: 1 };
  for (const order of [[quick, slow], [slow, quick]]) {
    const best = comb(order, geoFor);
    const t = best.get(trackKey(578, 568, 576));
    ok(!!t, 'a track was kept');
    eq(t.unproved ?? 0, 0, 'the kept track has no refused leg, whichever order they arrive in');
    ok(t.ms === 9000, 'the slower crossing won because it can be sent');
    eq(t.seen, 2, 'both crossings are still counted as seen');
  }
}

console.log('comb still prefers the quicker of two equals');
{
  const fast = { room: 578, cameFrom: 568, goingTo: 576, body: 1, ms: 1000,
                 points: P([100, 100], [500, 100]), entered: 0, left: 1 };
  const slow = { room: 578, cameFrom: 568, goingTo: 576, body: 2, ms: 8000,
                 points: P([100, 100], [400, 400], [500, 100]), entered: 0, left: 1 };
  for (const order of [[fast, slow], [slow, fast]]) {
    const t = comb(order, geoFor).get(trackKey(578, 568, 576));
    eq(t.unproved ?? 0, 0, 'both are ridable');
    eq(t.ms, 1000, 'so the quicker one wins');
  }
}

console.log('comb keeps an unridable track when there is nothing better');
{
  // A book with a hole in it beats no book: `rideTrack` falls back to walkFine per leg, and
  // the alternative is planning the crossing from scratch. The count is recorded so the
  // book can be asked about itself without riding it.
  const only = { room: 599, cameFrom: 598, goingTo: 2, body: 1, ms: 1000,
                 points: P([100, 100], [2000, 100]), entered: 0, left: 1 };
  const t = comb([only], geoFor).get(trackKey(599, 598, 2));
  ok(!!t, 'the crossing is still learned');
  eq(t.unproved, 1, 'and it says how many of its legs cannot be sent');
}

console.log('a track without geometry is not marked broken');
{
  const c = { room: 3, cameFrom: 1, goingTo: 2, body: 1, ms: 1000,
              points: P([100, 100], [2000, 100]), entered: 0, left: 1 };
  const t = comb([c], () => null).get(trackKey(3, 1, 2));
  ok(!!t, 'a caller with no map still gets a track');
  eq(t.straightened, false, 'and it is honest about not having been straightened');
  eq(t.unproved ?? 0, 0, 'an unmeasurable leg is not a refused one');
}

console.log('trackKey and the strike rule');
{
  eq(trackKey(578, 568, 576), '578:568>576', 'the key is room and the pair of doors');
  eq(trackKey(578, null, 576), '578:?>576', 'an unknown origin is a question mark, not a crash');
  // THE KEY IS THE DOORS, NOT THE ROUTE -- which is why a re-bake has to clear the record
  // of any crossing whose waypoints moved. See the --save path in m59-tracks.mjs.
  const tracks = { '578:568>576': { room: 578, from: 568, to: 576, waypoints: P([1, 1], [2, 2]) } };
  ok(!!recallTrack(578, 568, 576, tracks, {}), 'a clean track is recalled');
  ok(!recallTrack(578, 568, 576, tracks, { '578:568>576': STRIKES_BEFORE_REJECT }),
     'a struck-out track is refused, and refusing means plan it as you always did');
  ok(!!recallTrack(578, 568, 576, tracks, { '578:568>576': STRIKES_BEFORE_REJECT - 1 }),
     'one strike short is still ridden');
  ok(!recallTrack(578, 568, 999, tracks, {}), 'a crossing with no track is null, not a throw');
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
