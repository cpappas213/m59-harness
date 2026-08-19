// WHAT SHOULD THIS JOURNEY HAVE COST, AND WHAT DID IT.
//
// Every measurement of travel in this repository has been an absolute number of seconds,
// and an absolute number cannot be judged: 200 seconds is excellent for a crossing of The
// King's Way and disgraceful for a walk to the next room. So "travel is slow" has never
// been falsifiable, and neither has "travel is fixed". This grades a journey against what
// the geometry says it should have taken, which turns both claims into a ratio.
//
// THE BEST TIME IS PIVOTS, NOT SQUARES, AND THAT IS MEASURED RATHER THAN CHOSEN. A client
// reports its position about once a second, so a move is a packet is a second — and most of
// a route is straight line, which costs one move however many squares it spans. The same
// six routes in room 587 are 311 squares and 66 pivots, so charging squares overstates a
// trip 4.7x and does it UNEVENLY, which would flatter exactly the rooms that walk worst.
// `stringPull` is the same function the walker uses to decide what it may skip, so the
// estimate and the walk agree on what a move is rather than agreeing by luck.
//
// WHAT THIS IS NOT. It is an estimate of WALKING. It cannot know about a monster standing
// in a doorway, and a leg that spent ninety seconds being blocked is not evidence that the
// router is bad — which is precisely why the ratio must be read next to the tactic ledger
// and the damage, never alone. A grade is a question, and the answer is usually in
// `m59-tactics.mjs`.
//
//   node tools/m59-travelgrade.mjs 584 50            what the trip should cost
//   node tools/m59-travelgrade.mjs 584 50 --detail   room by room
//   node tools/m59-travelgrade.mjs --grade 240 584 50    and what a 240s leg scored
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, findPath, edgeCandidatesOf } from './m59-map.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';

// One move a second, because that is the rate a client reports at — see the note above and
// SECONDS_PER_PIVOT in m59-routes.mjs, which this deliberately agrees with rather than
// inventing a second answer to.
export const SECONDS_PER_PIVOT = 1.0;
// Crossing a boundary is a walk to the staging square, a step through, and the server's
// room change. Measured on the clean cases this session: an unobstructed door that the
// walker did not have to fumble for lands around three seconds.
export const SECONDS_PER_DOOR = 3.0;
// The bar. Inside this and the journey is as good as the geometry allows.
export const WITHIN = Number(process.env.M59_GRADE_WITHIN || 0.20);

let cached = null;
export function world() {
  if (cached) return cached;
  const map = loadMap(movementMapFile());
  try { attachStepMasks(map); } catch { /* no masks means the coarse grid, as everywhere */ }
  cached = map;
  return cached;
}

const staging = (room, e) => {
  const out = [];
  let crossings = [];
  try { crossings = edgeCandidatesOf(room, e, null, { live: true }); } catch { return out; }
  for (const c of crossings) for (const s of (c.stages ?? [])) out.push(s);
  return out;
};

/**
 * The cheapest number of moves a body can cross this room in, between these two squares.
 *
 * Null when it cannot be answered — an unbaked room, a square with no stand point, a pair
 * the router cannot join. NULL IS NOT ZERO, and every caller has to read it that way: a
 * zero here would make the rooms we understand least look like the fastest ones.
 */
export function pivotsAcross(geo, from, to) {
  if (!geo?.collisionReady || !from || !to) return null;
  const plan = geo.path(from.row, from.col, to.row, to.col);
  if (!plan?.found || !plan.steps?.length) return null;
  const half = 32;
  const point = s => geo.standPoint?.(s.row, s.col)
    ?? { x: (s.col * 64 + half - 64) * 16, y: (s.row * 64 + half - 64) * 16 };
  const line = [from, ...plan.steps].map(point).filter(Boolean);
  if (line.length < 2) return null;
  try {
    const pulled = geo.stringPull(line);
    if (pulled?.points?.length) return Math.max(1, pulled.points.length - 1);
  } catch { /* fall through to the square count, which is the honest upper bound */ }
  return plan.steps.length;
}

/**
 * What a journey between two rooms should cost, in seconds.
 *
 * Reports `unknown` rooms rather than silently pricing them at zero, because a route whose
 * middle could not be estimated must not come out looking cheap.
 */
export function optimal(fromRoom, toRoom, { map = world() } = {}) {
  const route = findPath(map, fromRoom, toRoom);
  if (!route?.found || !route.hops?.length) return { ok: false, why: 'no route in the graph' };
  const rooms = [route.hops[0].from, ...route.hops.map(h => h.to)];
  const legs = [];
  let seconds = 0, unknown = 0;
  // Where a walk INTO each room lands, so the in-room cost is measured from the door it
  // actually arrives at rather than from the middle of the floor.
  let entry = null;
  for (let i = 0; i < route.hops.length; i++) {
    const hop = route.hops[i];
    const room = map.rooms[hop.from];
    const geo = room?.roo ? (() => { try { return sharedRoomGeometry(room); } catch { return null; } })() : null;
    const edge = (room?.edgeExits ?? []).find(e => e.to === hop.to);
    // A TOWN LEAVES BY DOORS, NOT BY EDGES, AND PRICING ONLY THE EDGES MAKES A TOWN FREE.
    //
    // Cor Noth publishes no usable edge at all — every way out of it is a `go` door — so an
    // estimator that reads `edgeExits` alone charged 3 seconds for crossing the whole city
    // and reported the room as "could not be estimated". Across the operator's grand tour
    // that was most of the route: Marion, Cor Noth, Barloque, Tos and Jasper are all towns,
    // and the loop came out at 293s against an operator's estimate of 10-15 minutes. A door
    // has a square you must stand on, so it is priced exactly like a staging square.
    const doors = (room?.goExits ?? []).filter(g => g.to === hop.to && !g.locked);
    let across = null, target = null;
    if (geo) {
      const stages = edge ? staging(room, edge) : [];
      for (const g of doors) stages.push({ row: g.row, col: g.col });
      const start = entry ?? { row: Math.round(geo.rows / 2), col: Math.round(geo.cols / 2) };
      for (const s of stages) {
        const p = pivotsAcross(geo, start, s);
        if (p != null && (across == null || p < across)) { across = p; target = s; }
      }
    }
    if (across == null) unknown++;
    const cost = (across ?? 0) * SECONDS_PER_PIVOT + SECONDS_PER_DOOR;
    seconds += cost;
    legs.push({ room: hop.from, name: map.rooms[hop.from]?.name ?? '?', to: hop.to,
                pivots: across, stand_on: target, seconds: Math.round(cost * 10) / 10,
                estimated: across != null });
    const arrival = edge?.arriveRow != null ? edge
      : (room?.goExits ?? []).find(g => g.to === hop.to && g.arriveRow != null);
    entry = arrival?.arriveRow != null ? { row: arrival.arriveRow, col: arrival.arriveCol } : null;
  }
  return { ok: true, from: fromRoom, to: toRoom, rooms, hops: route.hops.length,
           seconds: Math.round(seconds * 10) / 10, unknown, legs };
}

/** actual/optimal, and whether it is inside the bar. */
export function grade(actualSeconds, best) {
  if (!best?.ok || !(best.seconds > 0)) return { ok: false, why: best?.why ?? 'no estimate' };
  const ratio = actualSeconds / best.seconds;
  return { ok: true, actual: actualSeconds, best: best.seconds,
           ratio: Math.round(ratio * 100) / 100, within: ratio <= 1 + WITHIN };
}

/** The distribution that decides whether the fleet is actually there. */
export function distribution(ratios = []) {
  if (!ratios.length) return null;
  const s = [...ratios].sort((a, b) => a - b);
  const at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, best: s[0], p50: at(0.5), p90: at(0.9), p99: at(0.99), worst: s[s.length - 1],
           within: s.filter(r => r <= 1 + WITHIN).length };
}

// ---------------------------------------------------------------------------- CLI
const direct = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const gradeAt = process.argv.indexOf('--grade');
  const actual = gradeAt > 0 ? Number(process.argv[gradeAt + 1]) : null;
  const nums = args.map(Number).filter(Number.isFinite).filter(n => n !== actual);
  if (nums.length < 2) {
    console.log('usage: node tools/m59-travelgrade.mjs <fromRoom> <toRoom> [--detail]');
    console.log('       node tools/m59-travelgrade.mjs --grade <seconds> <fromRoom> <toRoom>');
    process.exit(1);
  }
  const best = optimal(nums[0], nums[1]);
  if (!best.ok) { console.log(best.why); process.exit(1); }
  console.log(`${nums[0]} -> ${nums[1]}: ${best.hops} hop(s), best ${best.seconds}s` +
              (best.unknown ? `  (${best.unknown} room(s) could not be estimated)` : ''));
  if (process.argv.includes('--detail'))
    for (const l of best.legs)
      console.log(`   ${String(l.room).padStart(4)} ${String(l.name).slice(0, 32).padEnd(33)} -> ${String(l.to).padEnd(5)} ` +
                  `${l.estimated ? String(l.pivots).padStart(3) + ' pivots' : ' not estimated'}  ${l.seconds}s` +
                  (l.stand_on ? `  via ${l.stand_on.row},${l.stand_on.col}` : ''));
  if (Number.isFinite(actual)) {
    const g = grade(actual, best);
    console.log(`\nactual ${g.actual}s against best ${g.best}s = ${g.ratio}x  ` +
                (g.within ? `INSIDE the ${Math.round(WITHIN * 100)}% bar` : `OUTSIDE the ${Math.round(WITHIN * 100)}% bar`));
  }
}
