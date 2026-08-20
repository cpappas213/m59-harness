#!/usr/bin/env node
// m59-motion-probe.mjs -- DOES FINE PLANNING ACTUALLY BEAT COARSE PLANNING?
//
//   node tools/m59-motion-probe.mjs                 # a sample across rooms
//   node tools/m59-motion-probe.mjs --room 1012     # one room
//   node tools/m59-motion-probe.mjs --pairs 20 --rooms 8 --seed 7
//
// OFFLINE. No server, no game install, no M59_ROOT: the collision model is baked into
// substrate/ and `sharedRoomGeometry` reconstructs it from the map.
//
// WHY THIS EXISTS. docs/TICK-PLAN.md argues that motion planning must happen on the fine
// grid, and most of the striking numbers behind that argument are QUOTED FROM CLAUDE.md
// rather than measured here -- "218 of 311 centre-to-centre steps failed" is an upstream
// figure about one room from an unknown build. A design decision resting on a number
// nobody in this checkout has reproduced is exactly the thing this repository keeps
// warning about, so this reproduces it, or fails to.
//
// WHAT IT MEASURES, per random walkable pair of squares:
//
//   coarse   geo.path() over squares, then how many of ITS OWN steps the mover's trace
//            (moverStepLands) refuses. A coarse plan containing refused steps is a plan
//            that will stall partway, which is the failure being claimed.
//   fine     finePathProtocol between the same two points, then stringPull. Found? How
//            many waypoints survive? How long did it take?
//
// It reports DISAGREEMENTS as the headline: pairs where coarse finds a route containing
// steps the mover refuses, and pairs where one planner finds a route and the other does
// not. Agreement everywhere would mean the fine planner buys nothing and the plan is
// wrong.
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, KOD_FINENESS } from './m59-roo.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ROOMS = Number(arg('rooms', 6));
const PAIRS = Number(arg('pairs', 12));
const ONE   = arg('room', null);
const MAXN  = Number(arg('max-nodes', 20000));

// Deterministic, so a run can be repeated and argued with.
let seed = Number(arg('seed', 1));
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const K = KOD_FINENESS ?? 64;
const centre = (col, row) => ({ x: col * K + (K >> 1), y: row * K + (K >> 1) });

function squaresOf(geo) {
  const out = [];
  for (let r = 1; r <= geo.rows; r++)
    for (let c = 1; c <= geo.cols; c++)
      if (geo.standable(r, c)) out.push({ r, c });
  return out;
}

// The steps in a coarse path that the MOVER's own trace refuses. This is the number the
// argument turns on: a coarse plan is only useful if the mover will walk it.
function coarseRefusals(geo, pts) {
  let refused = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!geo.moverStepLands(a.row ?? a.r, a.col ?? a.c, b.row ?? b.r, b.col ?? b.c)) refused++;
  }
  return refused;
}

const map = loadMap();
const masks = attachStepMasks(map);
console.log(`step masks attached to ${masks.attached} room(s)\n`);

const candidates = Object.keys(map.rooms)
  .filter(n => { try { const g = sharedRoomGeometry(map.rooms[n]); return g?.collisionReady; } catch { return false; } });
const rooms = ONE ? [ONE] : candidates.filter((_, i) => i % Math.max(1, Math.floor(candidates.length / ROOMS)) === 0).slice(0, ROOMS);

const tally = { pairs: 0, coarseFound: 0, fineFound: 0,
                coarseWithRefusals: 0, coarseRefusedSteps: 0, coarseSteps: 0,
                fineWaypoints: 0, finePulled: 0, fineMs: [],
                onlyCoarse: 0, onlyFine: 0, cappedFine: 0,
                hybrid: 0, hybridPts: 0, hybridUnver: 0, hybridMs: [] };

for (const num of rooms) {
  const geo = sharedRoomGeometry(map.rooms[num]);
  if (!geo?.collisionReady) continue;
  const sq = squaresOf(geo);
  if (sq.length < 4) continue;
  let refusalsHere = 0, pairsHere = 0;

  for (let i = 0; i < PAIRS; i++) {
    const a = sq[Math.floor(rnd() * sq.length)], b = sq[Math.floor(rnd() * sq.length)];
    if (a.r === b.r && a.c === b.c) continue;
    tally.pairs++; pairsHere++;

    const cp = geo.path(a.r, a.c, b.r, b.c);
    const pts = cp?.path ?? cp?.steps ?? [];
    const coarseOk = !!(cp?.found ?? pts.length);
    if (coarseOk) {
      tally.coarseFound++;
      tally.coarseSteps += pts.length;
      const bad = coarseRefusals(geo, pts);
      tally.coarseRefusedSteps += bad;
      if (bad > 0) { tally.coarseWithRefusals++; refusalsHere++; }
    }

    const p0 = centre(a.c, a.r), p1 = centre(b.c, b.r);
    const t = Date.now();
    const fp = geo.finePathProtocol(p0.x, p0.y, p1.x, p1.y, { maxNodes: MAXN });
    tally.fineMs.push(Date.now() - t);
    if (fp?.found) {
      tally.fineFound++;
      tally.fineWaypoints += fp.waypoints.length;
      tally.finePulled += geo.stringPull(fp.waypoints.map(w => ({ x: w.x, y: w.y }))).points.length;
    } else if ((fp?.expanded ?? 0) >= MAXN * 0.95) tally.cappedFine++;

    if (coarseOk && !fp?.found) tally.onlyCoarse++;
    if (!coarseOk && fp?.found) tally.onlyFine++;

    // THE HYBRID: plan coarsely, then string-pull the square CENTRES with the mover's own
    // trace. The coarse steps are never walked -- they are a corridor, and the pull
    // replaces them with the fewest long straight legs the trace will verify. This is the
    // candidate design, so it is measured beside the other two rather than argued for.
    if (coarseOk) {
      const t2 = Date.now();
      const sp = geo.stringPull(pts.map(q => centre(q.col ?? q.c, q.row ?? q.r)));
      tally.hybridMs.push(Date.now() - t2);
      tally.hybrid++; tally.hybridPts += sp.points.length; tally.hybridUnver += sp.unverified;
    }
  }
  console.log(`  room ${String(num).padEnd(5)} ${String(map.rooms[num].name).slice(0, 26).padEnd(27)} ` +
              `${pairsHere} pairs, ${refusalsHere} coarse plan(s) contained a refused step`);
}

const ms = tally.fineMs.sort((x, y) => x - y);
const p = q => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : 0;
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';

console.log(`\n=== ${tally.pairs} pairs across ${rooms.length} room(s) ===`);
console.log(`coarse found a route      ${tally.coarseFound}  (${pct(tally.coarseFound, tally.pairs)})`);
console.log(`fine   found a route      ${tally.fineFound}  (${pct(tally.fineFound, tally.pairs)})`);
console.log(`\nTHE CLAIM UNDER TEST — coarse plans the mover will not walk:`);
console.log(`  coarse plans containing >=1 refused step   ${tally.coarseWithRefusals} of ${tally.coarseFound}  (${pct(tally.coarseWithRefusals, tally.coarseFound)})`);
console.log(`  refused steps / all coarse steps           ${tally.coarseRefusedSteps} of ${tally.coarseSteps}  (${pct(tally.coarseRefusedSteps, tally.coarseSteps)})`);
console.log(`\nplan size, where both found one:`);
console.log(`  coarse steps (avg)      ${(tally.coarseSteps / Math.max(1, tally.coarseFound)).toFixed(1)}`);
console.log(`  fine waypoints (avg)    ${(tally.fineWaypoints / Math.max(1, tally.fineFound)).toFixed(1)}`);
console.log(`  after stringPull (avg)  ${(tally.finePulled / Math.max(1, tally.fineFound)).toFixed(1)}`);
console.log(`\ndisagreements:  coarse-only ${tally.onlyCoarse}   fine-only ${tally.onlyFine}`);
console.log(`fine planner cost:  median ${p(.5)}ms  p90 ${p(.9)}ms  max ${ms[ms.length - 1] ?? 0}ms` +
            `   hit the node cap: ${tally.cappedFine}`);

const hms = tally.hybridMs.sort((x, y) => x - y);
const hp = q => hms.length ? hms[Math.min(hms.length - 1, Math.floor(hms.length * q))] : 0;
console.log(`\nTHE HYBRID — coarse corridor, string-pulled on the mover's trace:`);
console.log(`  routes ${tally.hybrid}   points after pull (avg) ${(tally.hybridPts / Math.max(1, tally.hybrid)).toFixed(1)}` +
            `   UNVERIFIED LEGS ${tally.hybridUnver}`);
console.log(`  cost: median ${hp(.5)}ms  p90 ${hp(.9)}ms  max ${hms[hms.length - 1] ?? 0}ms`);
