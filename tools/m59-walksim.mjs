#!/usr/bin/env node
// WILL THE WALKER GET STUCK IN THIS ROOM — asked of the WALKER, offline, with no server.
//
//   node tools/m59-walksim.mjs --room 598                 random floor -> that room's own exits
//   node tools/m59-walksim.mjs --room 598 --from 19,8 --to 64,19 --trace
//   node tools/m59-walksim.mjs --rooms 50,586,587,597,598,599,2,38
//   node tools/m59-walksim.mjs --cycle                    the operator's Tos->Victoria->Cor Noth->Barloque lap
//   node tools/m59-walksim.mjs --room 598 --clip 0,2,8    sweep a routing knob
//
// OFFLINE. Reads the same baked geometry and the same routing table the broker plans on;
// no server, no broker, no character.
//
// WHY THIS IS NOT m59-walktrial.mjs. That one asks the ROUTER — "is there a route from here
// to there" — and it is right about the thing it measures: from ordinary squares the router
// is essentially perfect, and it said so for months while the fleet stood in corners. This
// asks the WALKER, which is a different question and the one that was failing:
//
//   the router validates a step from the CENTRE of one square to the CENTRE of the next
//   the mover SLIDES
//   so after the first slide the body is never on a centre again
//
// and every subsequent step is being judged by a model of a position the character does not
// have. `walktrial --plan-only` cannot see that at all, because it never moves anything.
//
// WHAT IT DRIVES IS THE REAL THING. `RoomGeometry.path` for the plan, `standPoint` for the
// aim, `traceFineMoveClient` for the move — with the FINE POSITION CARRIED FORWARD, which is
// the whole point — plus `finePath`/`pullFine` for the fine detour and the same
// blocked-edge learning `walkTo` does. What it does not model is the server: no monsters, no
// bodies in the way, no packet loss. So an arrival here is "the geometry allows it" and a
// failure here is a failure the geometry causes, which is the half that is reproducible.
//
// IT PREDICTED THE LIVE FAULT. Room 598, 19,8 -> 64,19: this reports a bounce between 23,16
// and 23,17 for ever — from 23,17 the plan says south to 24,17 and the mover slides
// BACKWARDS into 23,16; from 23,16 the plan says east to 23,17 and it slides forward again.
// Watched live on the arena server at the same time, Aaaa did exactly that at col 8, rows
// 17-19, and reported "kept ending up somewhere other than the planned square".
//
// See docs/NEXT-STEPS-pathing.md, 2026-08-20.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedRoomGeometry, CLIP_STEP_COST } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { finePath, pullFine, pointOfSquare, boundsAround } from './m59-finepath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TABLE = join(REPO, 'substrate', 'm59-routes.json');

// The client's square, from a client-unit point. 1024 to the square, and the grid is
// 1-BASED while the leaves are 0-based — the same off-by-one that once made a whole-map
// coordinate error look like a local geometry defect. See NEXT-STEPS.md's correction.
const SQ = 1024;
export const squareOf = (x, y) => ({ row: Math.floor(y / SQ) + 1, col: Math.floor(x / SQ) + 1 });

// The operator's lap, in the order the fleet walks it. Both directions cross Ukgoth.
export const CYCLE_ROOMS = [50, 586, 587, 597, 598, 599, 2, 38,
                            589, 579, 578, 576, 575, 150, 574, 584, 583, 593, 585, 102, 101];

/**
 * WHERE IN THE NEXT SQUARE TO AIM, given where the body actually is.
 *
 * The simulator's copy of `Session.aimInto`, and it has to be a copy rather than an import
 * for the reason every offline test here lifts rather than imports: `m59-broker.mjs` cannot
 * be loaded without taking the fleet lock. Keep the two in step — this is the difference
 * between a simulator that predicts the bounce and one that predicts a walker nobody runs.
 *
 * Everything is in CLIENT units here (1024 to the square, 1-based grid), because that is
 * what `traceFineMoveClient` and `standPoint` speak; the broker's version does the same
 * thing in wire units and converts.
 */
export function aimInto(g, from, row, col) {
  const home = g.standPoint(row, col);
  if (!home || !from) return home;
  const reaches = (x, y) => g.traceFineMoveClient(from.x, from.y, x, y, { slide: false }).arrived === true;
  if (reaches(home.x, home.y)) return home;
  const q = SQ >> 2;
  const centre = { x: (col - 1) * SQ + SQ / 2, y: (row - 1) * SQ + SQ / 2 };
  const offsets = [[0, 0], [-q, 0], [q, 0], [0, -q], [0, q], [-q, -q], [-q, q], [q, -q], [q, q]];
  const bases = home.x === centre.x && home.y === centre.y ? [centre] : [home, centre];
  for (const base of bases)
    for (const [dx, dy] of offsets) {
      const x = base.x + dx, y = base.y + dy;
      const sq = squareOf(x, y);
      if (sq.row !== row || sq.col !== col) continue;      // never aim out of the square
      if (reaches(x, y)) return { x, y };
    }
  return home;
}

/**
 * ONE WALK, THE WAY `Session.walkTo` DOES IT.
 *
 * Plan, take the first step, move the BODY with the fine mover, learn the edge if it landed
 * somewhere else, try a fine detour, replan from where it actually is. The budgets are the
 * broker's own and are parameters here so a knob can be swept rather than argued about.
 *
 * The return says WHY rather than just no, because the three failures want opposite fixes:
 * `step budget` is a walk that was making progress and ran out of packets, `replan budget`
 * is one that was not, and `no route mid-walk` is edges learned until the goal disappeared.
 */
export function simulateWalk(g, fromR, fromC, toR, toC, {
  stepBudgetFactor = 3, hardCap = 400, fineDetourMax = 12,
  fineDetourNodes = 4000, fineDetourMargin = 4, clearance = 0, clipCost = undefined,
  aim = true, trace = false,
} = {}) {
  let cur = g.standPoint(fromR, fromC);
  if (!cur) return { arrived: false, why: 'no stand point at the start', steps: 0 };
  let at = squareOf(cur.x, cur.y);
  const plan0 = g.path(at.row, at.col, toR, toC, { collision: true, clearance, clipCost });
  if (!plan0.found) return { arrived: false, why: 'no route', planLen: 0, steps: 0 };

  const planLen = plan0.steps.length;
  const maxSteps = Math.min(planLen * stepBudgetFactor + 10, hardCap);
  const replanBudget = 8 + Math.floor(planLen / 10);
  const blockedEdges = new Set();
  const visits = new Map();
  const trail = [];
  let taken = 0, replans = 0, offPlan = 0, detours = 0, closest = Infinity, shortestRoute = Infinity;
  // The square we were in BEFORE the one we are in now. A refused FALL is a bad approach
  // rather than a bad ledge — see where this is used.
  let prevSquare = null;
  // WHERE IT WENT WRONG AND WHAT REFUSED IT. `traceFineMoveClient` names the WALL INDEX
  // that stopped a move, which is the one identifier that points at a feature of the .roo
  // rather than at a symptom. A handful of walls accounting for most of a room's deviations
  // is a map fact somebody can go and look at; "kept ending up somewhere other than the
  // planned square" is not.
  const refusals = [];
  // THE FINE POSITIONS, not just the squares. A square trail says a body oscillated; the
  // fine trail says where against the wall it was when the move was refused, which is the
  // only version you can draw on top of the .roo and learn anything from.
  const positions = [];

  // THE HONEST DENOMINATOR. `planLen` is the length of the FIRST plan - made before a single
  // edge had been tried - and dividing the walk by it measures how wrong that plan was, not
  // how badly the walk went. In a room where the first plan is impossible, a walker that
  // recovers perfectly still scores badly, and a walker that never left the first plan would
  // score 1.00x by failing to move at all.
  //
  // So replan from the START with everything the walk went on to learn. That route is made
  // only of edges nothing has refused, which makes it the shortest crossing anybody could
  // have planned KNOWING WHAT WE NOW KNOW - and the only fair thing to divide a walk by.
  const truePlan = () => {
    if (!blockedEdges.size) return planLen;
    const t = g.path(fromR, fromC, toR, toC, { collision: true, blockedEdges, clearance, clipCost });
    return t?.found ? t.steps.length : planLen;
  };

  while (taken < maxSteps) {
    if (at.row === toR && at.col === toC)
      return { arrived: true, steps: taken, planLen, planTrue: truePlan(), offPlan, detours,
               learned: blockedEdges.size, refusals, positions, trail: trace ? trail : trail.slice(-24) };
    let p = g.path(at.row, at.col, toR, toC, { collision: true, blockedEdges, clearance, clipCost });
    // RELAX IN THE ORDER THE FACTS DECAY, exactly as walkTo does — and modelling this
    // matters, because without it the simulator reports `no route mid-walk` for the
    // commonest recovery the real walker has. A refused edge is a wall and is kept; the
    // collision model is what gets set aside, because being wrong about a wall costs a
    // walk and refusing costs the errand. Not CLEARED, only set aside for this one plan:
    // forgetting the refusals would re-enter the same bounce with the same enthusiasm.
    if (!p.found && blockedEdges.size)
      p = g.path(at.row, at.col, toR, toC, { collision: false });
    if (!p.found)
      return { arrived: false, why: 'no route mid-walk', at, steps: taken, planLen,
               offPlan, detours, learned: blockedEdges.size, refusals, positions, trail: trail.slice(-24) };
    const s = p.steps[0];
    // A FALL IS PLANNED IN FALL MODE AND MUST BE ATTEMPTED IN FALL MODE. `fallTargets`
    // proves a drop with `traceFineMoveClient(..., { fall: true })` and the mover used to
    // send it without the flag, where an ordinary wall trace refuses it — the whole of the
    // mountain rooms. `Session.step` passes it now; this models that.
    const at2 = s.fall ? g.standPoint(s.row, s.col)
              : aim ? aimInto(g, cur, s.row, s.col)
              : g.standPoint(s.row, s.col);
    const t = g.traceFineMoveClient(cur.x, cur.y, at2.x, at2.y, { slide: true, fall: !!s.fall });
    let pos = { x: t.x, y: t.y };
    let landed = squareOf(pos.x, pos.y);
    taken++;

    if (landed.row !== s.row || landed.col !== s.col) {
      offPlan++;
      refusals.push({ from: `${at.row},${at.col}`, aimed: `${s.row},${s.col}`,
                      landed: `${landed.row},${landed.col}`,
                      reason: t.reason ?? (t.blocked ? 'blocked' : 'slid'),
                      wall: t.wallIndex ?? null, slid: !!t.slid });
      // THE EDGE THAT REFUSED IS NAMED FROM WHERE WE ASKED IT, not from where we ended up —
      // a slid step leaves the body at neither end, and blaming the landing square blames
      // an edge nobody tried. Same rule as walkTo.
      // A REFUSED FALL IS A BAD APPROACH, NOT A BAD LEDGE.
      //
      // `fallTargets` proved this drop from the take-off square's STAND POINT, and it is
      // still true: measured in room 578, 36 of 64 points sampled inside 45,16 make the
      // fall to 43,16 land correctly. The body is simply in one of the other 28 — it slid
      // into a corner of its own square on the way in, and from there NO point in the
      // landing square works, no neighbouring landing works, and `finePath` cannot even
      // reach the take-off point. It is wedged against the cliff.
      //
      // Blaming the ledge — which is what learning `45,16 > 43,16` does — deletes the only
      // way down and the room has no other, so the walk bounces until its budget ends.
      // Blaming the APPROACH sends the router at the same ledge from a different neighbour,
      // which lands the body at a different fine point, and most of them work.
      const dr = Math.sign(s.row - at.row), dc = Math.sign(s.col - at.col);
      const key = s.fall && prevSquare
        ? `${prevSquare.row},${prevSquare.col}>${at.row},${at.col}`
        : `${at.row},${at.col}>${at.row + dr},${at.col + dc}`;
      let learned = false;
      if ((dr || dc || s.fall) && !blockedEdges.has(key)) { blockedEdges.add(key); learned = true; }

      // The fine detour: half of what the square lattice calls a wall is a slide that
      // landed next door, and a quarter-square search threads it.
      if (detours < fineDetourMax) {
        detours++;
        const goal = pointOfSquare(g, s.row, s.col);
        const bounds = boundsAround([{ row: at.row, col: at.col }, { row: s.row, col: s.col }],
                                    fineDetourMargin);
        const found = goal && finePath(g, pos, goal, { bounds, maxNodes: fineDetourNodes });
        if (found?.found) {
          for (const leg of pullFine(g, pos, found.points)) {
            const tt = g.traceFineMoveClient(pos.x, pos.y, leg.x, leg.y, { slide: true });
            pos = { x: tt.x, y: tt.y }; taken++;
            const a2 = squareOf(pos.x, pos.y);
            if (a2.row === s.row && a2.col === s.col) break;
          }
          landed = squareOf(pos.x, pos.y);
          // Through the gap: the edge we blamed was never the problem, so unlearn it.
          if (learned && landed.row === s.row && landed.col === s.col) blockedEdges.delete(key);
        }
      }

      // PROGRESS ON THE ROUTE, NOT ON THE CROW FLY — the walker's own rule. In a room
      // whose way out goes away from the goal first, Chebyshev distance calls nine correct
      // steps in a row "no ground gained" and the budget ends the walk.
      const gap = Math.max(Math.abs(landed.row - toR), Math.abs(landed.col - toC));
      const after = g.path(landed.row, landed.col, toR, toC, { collision: true, blockedEdges, clearance, clipCost });
      const routeLeft = after.found ? after.steps.length : Infinity;
      const gained = gap < closest || routeLeft < shortestRoute;
      if (gap < closest) closest = gap;
      if (routeLeft < shortestRoute) shortestRoute = routeLeft;
      if (!learned && !gained && ++replans > replanBudget)
        return { arrived: false, why: 'replan budget', at: landed, steps: taken, planLen,
                 offPlan, detours, learned: blockedEdges.size, refusals, positions, trail: trail.slice(-24) };
    } else {
      const gap = Math.max(Math.abs(landed.row - toR), Math.abs(landed.col - toC));
      if (gap < closest) closest = gap;
    }

    positions.push({ x: Math.round(pos.x), y: Math.round(pos.y),
                     aim: { x: Math.round(at2.x), y: Math.round(at2.y) },
                     ...(s.fall ? { fall: true } : {}),
                     ...(landed.row === s.row && landed.col === s.col ? {} : { off: true }) });
    trail.push(`${landed.row},${landed.col}` + (landed.row === s.row && landed.col === s.col ? '' : '*'));
    // A BOUNCE IS THE FINDING, so it is named rather than left to run the budget out. Twelve
    // visits to one square is not a busy junction, it is the two-square oscillation.
    const k = `${landed.row},${landed.col}`;
    visits.set(k, (visits.get(k) ?? 0) + 1);
    if (visits.get(k) > 12)
      return { arrived: false, why: 'bouncing', bounce_at: k, at: landed, steps: taken,
               planLen, offPlan, detours, learned: blockedEdges.size, refusals, positions, trail: trail.slice(-24) };
    if (landed.row !== at.row || landed.col !== at.col) prevSquare = at;
    cur = pos; at = landed;
  }
  return { arrived: false, why: 'step budget', at, steps: taken, planLen, offPlan, detours,
           learned: blockedEdges.size, refusals, positions, trail: trail.slice(-24) };
}

/** Every square in a room a body could start a walk from. */
function floorOf(g, room) {
  const out = [];
  for (let r = 1; r <= (room.rows ?? 0); r++)
    for (let c = 1; c <= (room.cols ?? 0); c++)
      if (g.walkable(r, c) && g.standPoint(r, c)) out.push([r, c]);
  return out;
}

// A FIXED SEQUENCE, NOT Math.random(). Two runs of this tool have to be comparable or the
// numbers in a commit message mean nothing, and a knob sweep that resamples is measuring
// the sample.
function sequence(seed = 4242) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * A room's own exit anchors, as walk destinations.
 *
 * THE ANCHORS AND NOT RANDOM SQUARES, because that is what travel actually asks for. A
 * random pair includes pockets nothing can reach, and those are correct refusals rather
 * than defects — measuring them buries the signal in 40% legitimate no-route.
 */
function anchorsOf(table, g, num) {
  const r = table?.rooms?.[num] ?? table?.rooms?.[String(num)];
  return (r?.anchors ?? [])
    .filter(a => Number.isInteger(a.row) && Number.isInteger(a.col) && g.standPoint(a.row, a.col))
    .map(a => ({ row: a.row, col: a.col, to: a.to }));
}

// ---------------------------------------------------------------------------- cli
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const pair = v => { const [a, b] = String(v).split(',').map(Number); return { row: a, col: b }; };

  const map = await loadMap();
  const att = attachStepMasks(map);
  if (!att.ok) console.error(`[walksim] no usable step masks: ${att.why} — this measures the coarse grid, not the mover`);
  const table = (() => { try { return JSON.parse(readFileSync(TABLE, 'utf8')); } catch { return null; } })();

  const walks = Number(arg('--walks', 12));
  const clips = (arg('--clip') ?? String(CLIP_STEP_COST)).split(',').map(Number);
  // THE OTHER KNOB THE WALKER ACTUALLY SETS, and the one that turned out to matter most in
  // the mountains. `leaveVia` — the walk to a boundary, which is most of travelling — opts
  // into `clearance: 0.6`, a preference for open ground measured on room 587. Sweeping it
  // is how the Cragged Mountains was found to be the room where it backfires.
  const clearances = (arg('--clearance') ?? '0').split(',').map(Number);
  const axis = clearances.length > 1
    ? clearances.map(v => ({ label: `clear ${v}`, opts: { clearance: v, clipCost: clips[0] } }))
    : clips.map(v => ({ label: `clip ${v}`, opts: { clipCost: v, clearance: clearances[0] } }));
  const rooms = argv.includes('--cycle') ? CYCLE_ROOMS
    : arg('--rooms') ? arg('--rooms').split(',').map(Number)
    : arg('--room') ? [Number(arg('--room'))]
    : CYCLE_ROOMS;

  // ONE NAMED WALK, with the trail, which is the mode that answers "why".
  if (arg('--from') && arg('--to')) {
    const num = Number(arg('--room'));
    const g = sharedRoomGeometry(map.rooms[num]);
    if (!g?.moverStepLands) { console.error(`room ${num} has no collision geometry`); process.exit(2); }
    const from = pair(arg('--from')), to = pair(arg('--to'));
    for (const a of axis) {
      const r = simulateWalk(g, from.row, from.col, to.row, to.col, { ...a.opts, trace: true });
      console.log(`room ${num}  ${from.row},${from.col} -> ${to.row},${to.col}  ` +
                  `clip ${a.opts.clipCost}, clearance ${a.opts.clearance}`);
      console.log(`  ${r.arrived ? 'ARRIVED' : 'FAILED — ' + r.why + (r.bounce_at ? ' on ' + r.bounce_at : '')}` +
                  `   plan ${r.planLen ?? '-'} steps, walked ${r.steps}, ${r.offPlan ?? 0} off-plan, ` +
                  `${r.detours ?? 0} fine detour(s), ${r.learned ?? 0} edge(s) learned`);
      if (argv.includes('--trace')) console.log('  trail: ' + (r.trail ?? []).join(' '));
    }
    process.exit(0);
  }

  // WHY A ROOM IS SLOW, AGAINST THE GEOMETRY RATHER THAN AGAINST A SYMPTOM.
  //
  //   node tools/m59-walksim.mjs --why --room 598
  //
  // THE YARDSTICK IS THE THEORETICAL MINIMUM, which is not a guess: a running character
  // covers five squares a second (MOVEUNITS/MOVE_DELAY, move.c:49,184), so the floor on any
  // exit-to-exit crossing is `planned squares / 5` seconds. Everything above that is time
  // the character is in the room being shot at for no reason, which is the whole cost of a
  // deviation — a monster that could have been outrun gets another swing instead.
  //
  // Then the deviations themselves, grouped by the WALL INDEX that refused them. That index
  // is a line in the .roo, so a room whose deviations pile onto three walls is a room with
  // three features to go and look at; a room whose deviations are spread evenly is a walker
  // problem rather than a map one. Both answers are useful and they need opposite work.
  if (argv.includes('--why')) {
    const num = Number(arg('--room'));
    const room = map.rooms[num];
    const g = room?.roo && sharedRoomGeometry(room);
    if (!g?.moverStepLands) { console.error(`room ${num} has no collision geometry`); process.exit(2); }
    const goals = anchorsOf(table, g, num);
    const floor = floorOf(g, room);
    const rnd = sequence();
    const cases = [];
    // EVERY EXIT PAIR THE ROOM DECLARES, plus random floor to each exit — because the two
    // ask different questions. Anchor to anchor is the journey the fleet actually makes;
    // random floor to an anchor is what a character dropped by a death has to do.
    for (const a of goals) for (const b of goals)
      if (a.row !== b.row || a.col !== b.col) cases.push([[a.row, a.col], b, 'exit-to-exit']);
    for (let guard = 0; cases.length < goals.length * goals.length + walks && guard < walks * 60; guard++) {
      const a = floor[Math.floor(rnd() * floor.length)];
      const gl = goals[Math.floor(rnd() * goals.length)];
      if (a && gl && g.path(a[0], a[1], gl.row, gl.col, { collision: true, clipCost: 0 }).found)
        cases.push([a, gl, 'from the floor']);
    }
    const byWall = new Map(), bySquare = new Map(), byReason = new Map();
    let plannedAll = 0, walkedAll = 0, arrived = 0, firstPlanAll = 0;
    console.log(`room ${num} - ${room.name ?? '?'}   (a run is 5 squares/second)\n`);
    console.log('kind           from      to        1st   real  min     walked  actual  tax   deviations');
    for (const [from, gl, kind] of cases) {
      const r = simulateWalk(g, from[0], from[1], gl.row, gl.col, { clipCost: clips[0], clearance: clearances[0] });
      const plan = r.planLen ?? 0;
      const real = r.planTrue ?? plan;      // shortest route made only of edges nothing refused
      const min = real / 5, act = (r.steps ?? 0) / 5;
      if (r.arrived) { arrived++; plannedAll += real; walkedAll += r.steps; firstPlanAll += plan; }
      console.log(kind.padEnd(15) + `${from[0]},${from[1]}`.padEnd(10) + `${gl.row},${gl.col}`.padEnd(10) +
        String(plan).padEnd(6) + String(real).padEnd(6) + (min.toFixed(1) + 's').padEnd(8) +
        String(r.steps ?? 0).padEnd(8) + (act.toFixed(1) + 's').padEnd(8) +
        (real ? (act / Math.max(0.001, min)).toFixed(1) + 'x' : '-').padEnd(6) +
        (r.arrived ? String(r.offPlan ?? 0) : `${r.offPlan ?? 0}  FAILED — ${r.why}`));
      for (const ref of r.refusals ?? []) {
        const w = ref.wall == null ? 'no wall named' : `wall ${ref.wall}`;
        byWall.set(w, (byWall.get(w) ?? 0) + 1);
        bySquare.set(ref.from, (bySquare.get(ref.from) ?? 0) + 1);
        byReason.set(ref.reason, (byReason.get(ref.reason) ?? 0) + 1);
      }
    }
    console.log(`\n${arrived}/${cases.length} arrived. Across the ones that did: ` +
                `${plannedAll} squares in the shortest route nothing refuses, ${walkedAll} walked — ` +
                `${(walkedAll / Math.max(1, plannedAll)).toFixed(2)}x, ` +
                `${((walkedAll - plannedAll) / 5).toFixed(0)}s of tax.`);
    // Two ratios, and the gap between them is the finding: `real` is the shortest route made
    // only of edges nothing refused, `1st` is what the planner offered before it knew that.
    if (firstPlanAll && firstPlanAll !== plannedAll)
      console.log(`The FIRST plan asked for ${firstPlanAll} squares, so ` +
                  `${(walkedAll / Math.max(1, firstPlanAll)).toFixed(2)}x against that. The gap is ` +
                  `the planner being wrong rather than the walker wandering: ` +
                  `${plannedAll - firstPlanAll} of the extra squares were never avoidable.`);
    const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('\nWHAT REFUSED THE MOVE');
    for (const [k, n] of top(byReason)) console.log(`  ${String(n).padStart(5)}  ${k}`);
    console.log('\nWHICH WALL OF THE .roo — an index is a line somebody can go and look at');
    for (const [k, n] of top(byWall)) console.log(`  ${String(n).padStart(5)}  ${k}`);
    console.log('\nWHERE THE BODY WAS WHEN IT WAS REFUSED — row,col');
    for (const [k, n] of top(bySquare)) console.log(`  ${String(n).padStart(5)}  ${k}`);
    process.exit(0);
  }

  // THE SWEEP: random floor to the room's own exits, once per clip value.
  console.log(`${walks} walk(s) a room, random floor -> that room's baked exit anchors\n`);
  console.log('room  name                     ' + axis.map(a => a.label.padEnd(9)).join(''));
  const totals = new Map(axis.map(a => [a.label, { ok: 0, n: 0, steps: 0, why: {} }]));
  for (const num of rooms) {
    const room = map.rooms[num];
    const g = room?.roo && sharedRoomGeometry(room);
    if (!g?.moverStepLands) { console.log(String(num).padStart(4) + '  (no collision geometry)'); continue; }
    const goals = anchorsOf(table, g, num);
    if (!goals.length) { console.log(String(num).padStart(4) + '  (no baked anchors — run tools/setup.mjs routes)'); continue; }
    const floor = floorOf(g, room);
    // The same starts for every clip value, and only starts the router says are routable:
    // a genuine pocket is not the fault this measures.
    const rnd = sequence();
    const cases = [];
    for (let guard = 0; cases.length < walks && guard < walks * 60; guard++) {
      const a = floor[Math.floor(rnd() * floor.length)];
      const gl = goals[Math.floor(rnd() * goals.length)];
      if (a && gl && g.path(a[0], a[1], gl.row, gl.col, { collision: true, clipCost: 0 }).found)
        cases.push([a, gl]);
    }
    const cells = [];
    for (const a of axis) {
      const t = totals.get(a.label);
      let ok = 0;
      for (const [from, gl] of cases) {
        const r = simulateWalk(g, from[0], from[1], gl.row, gl.col, a.opts);
        if (r.arrived) { ok++; t.steps += r.steps; } else t.why[r.why] = (t.why[r.why] ?? 0) + 1;
      }
      t.ok += ok; t.n += cases.length;
      cells.push(`${String(ok).padStart(2)}/${String(cases.length).padEnd(2)}   `);
    }
    console.log(String(num).padStart(4), (room.name ?? '').slice(0, 24).padEnd(26), cells.join(''));
  }
  console.log('');
  for (const a of axis) {
    const t = totals.get(a.label);
    console.log(`${a.label.padEnd(10)}  ${t.ok}/${t.n}  ` +
                `${t.n ? (100 * t.ok / t.n).toFixed(1) : '0.0'}%  ` +
                `${(t.steps / Math.max(1, t.ok)).toFixed(1)} steps per arrival  ${JSON.stringify(t.why)}`);
  }
  console.log('\nA failure here is one the GEOMETRY causes: no monsters, no bodies in the way,\n' +
              'no packet loss. `step budget` was making progress and ran out; `replan budget`\n' +
              'was not; `bouncing` is the two-square oscillation; `no route mid-walk` is edges\n' +
              'learned until the goal disappeared.');
}
