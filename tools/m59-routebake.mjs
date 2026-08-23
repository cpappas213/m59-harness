#!/usr/bin/env node
// EXIT TO EXIT, WORKED OUT ONCE, OFFLINE, AGAINST THE MAP THE MOVER ACTUALLY ENFORCES.
//
//   node tools/m59-routebake.mjs                 bake every room
//   node tools/m59-routebake.mjs --rooms 150,578 just these
//   node tools/m59-routebake.mjs --check         report, write nothing
//   node tools/m59-routebake.mjs --resume        keep what is already on disk, bake the rest
//   node tools/m59-routebake.mjs --grid          the old coarse view, for comparison only
//
// THIRTEEN MINUTES ON THIS MACHINE, FLUSHED EVERY MINUTE. `--resume` adopts the rooms
// already in the table when — and only when — they were baked from the same geometry and
// the same view, so a killed bake costs a minute rather than the lot.
//
// WHAT THE RUNTIME ACTUALLY USES OUT OF THIS IS THE STEP MASK. The routes and the region
// labels are useful; the mask is the thing that changes behaviour, because it turns "would
// the mover take this step" from a 0.44ms trace into an array index and so lets the router
// plan on the same map the mover enforces without stopping the event loop.
//
// WHY THIS EXISTS, AND WHY IT IS A BAKE RATHER THAN A BUDGET.
//
// Since #18 movement is validated against the CLIENT's BSP — walls, sector heights, the
// player radius — while the router planned on the SERVER's coarse one-byte-a-square grid.
// Those disagree, and a router planning on a different map from the one the mover enforces
// does not produce a wrong route: it produces a character walking into a wall for ever.
//
// Making the router ask the mover's own trace fixes it and CANNOT BE DONE AT RUNTIME. The
// trace is synchronous and CPU-bound, A* calls it tens of thousands of times, and every
// session in the broker shares one event loop — so a cold path measured 1.2s during which
// no character's keepalive is answered. Shipped on by default, it took twelve of
// twenty-one characters out of the world in five minutes.
//
// Offline there is no loop to block. So the expensive, correct thing is done once here and
// the runtime does a lookup.
//
// ---------------------------------------------------------------------------
// WHAT IS STORED, AND THE TWO DIFFERENT QUESTIONS IT ANSWERS
//
//   components — every walkable square labelled by which collision-connected region it is
//                in, and each exit tagged with its region. This answers "is there a route
//                at all" in O(1), and that is the question that was most expensive to get
//                wrong: rooms 578 and 101 each burned a full A* exhaustion to conclude
//                "no route", every pass, for characters that genuinely cannot walk out.
//                A room with two regions is not broken — the Cragged Mountains has a cliff
//                and you need `blink` to get up it.
//
//   routes     — the actual step list between each ordered pair of exits in the same
//                region, as a direction string. One BFS per exit rather than one per PAIR:
//                a single search from an exit square yields the shortest path to every
//                other square in the room, including all the other exits.
//
// ONE BFS PER EXIT, NOT PER PAIR. The busiest room here has 58 exits; per-pair would be
// 3,306 searches for what 58 already answer.
//
// PATHS ARE STORED AS DIRECTIONS, NOT SQUARES. A step is one of eight neighbours, so it is
// one character; a forty-step route is forty bytes rather than forty coordinate pairs. The
// squares are recovered by walking the string from the known start.
//
// A SIBLING FILE, NOT substrate/m59-map.json. That file is already 27 MB and is the
// checked map with its own manifest; this is derived from it and regenerable, and mixing
// the two would mean rebaking geometry to change a routing decision.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, edgeCandidatesOf } from './m59-map.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { sharedRoomGeometry, CLIENT_FINENESS, STEP_MASK_VERSION } from './m59-roo.mjs';

// WHAT THIS BAKE COMPUTES, VERSIONED — because --resume could not tell that it had changed.
//
// The resume check compared the map, the view and the step-mask version, and a table that
// matched on all three was reused wholesale. None of them moves when the BAKE'S OWN LOGIC
// does. So fixing how the main region is chosen and re-running produced:
//
//     resuming: 264 room(s) already baked from the same map
//     baking 0 room(s) (264 already done)
//
// A clean exit, a written file, and not one number changed. That is the same undetectable
// wrong as a half-table stitched from two predicates, which the check three lines below
// already refuses — only for the algorithm rather than the geometry. Bump this whenever what
// a room's entry MEANS changes, and every stale table re-bakes itself instead of being
// silently kept.
//
//   2 — main region chosen by forward reach rather than largest SCC; blink points recorded
export const BAKE_VERSION = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const ROUTES_FILE = () => process.env.M59_ROUTES_FILE ||
  join(REPO, 'substrate', 'm59-routes.json');

// The eight directions, in a fixed order, so a stored path is stable across bakes. The
// letter is what goes in the string.
export const STEP_DIRS = [
  ['n', -1, 0], ['s', 1, 0], ['e', 0, 1], ['w', 0, -1],
  ['a', -1, 1], ['b', 1, 1], ['c', 1, -1], ['d', -1, -1],
];
const BY_LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [ch, { dr, dc }]));

/** Walk a stored direction string back into squares. */
export function replay(fromRow, fromCol, path) {
  const out = [];
  let r = fromRow, c = fromCol;
  const str = String(path ?? '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    // An inline jump: `(dr,dc)`. See pathString — a fall is a single move of more than one
    // square and has no direction letter, so it is spelled out where it happens.
    if (ch === '(') {
      const close = str.indexOf(')', i);
      if (close < 0) return out;
      const m = /^(-?\d+),(-?\d+)$/.exec(str.slice(i + 1, close));
      if (!m) return out;
      r += Number(m[1]); c += Number(m[2]);
      out.push({ row: r, col: c });
      i = close;
      continue;
    }
    const d = BY_LETTER.get(ch);
    if (!d) return out;
    r += d.dr; c += d.dc;
    out.push({ row: r, col: c });
  }
  return out;
}

/**
 * The squares a room's exits are used from.
 *
 * An edge exit is used from one of its approach squares — the model's own answer to "where
 * do you stand to cross this boundary". A `go` exit names its square outright. Both are
 * reduced to a square, because that is what a route ends at.
 */
export function exitAnchors(room, geometry, { reachable = null, playerReachable = null } = {}) {
  const out = [];
  for (const e of room.edgeExits ?? []) {
    const dir = e.leaveName ?? null;
    if (!dir) continue;
    // A BOUNDARY PUBLISHES MANY STAGING SQUARES AND THEY ARE NOT INTERCHANGEABLE. This
    // took the first one offered and called that the exit, which is how room 578 came out
    // with all four of its exits "unreachable" while a character can plainly walk to three
    // of them — the first square on the list happened to be one the mover cannot get to,
    // and the other ten were never considered. `reachable` is the room's own body, so a
    // square it can walk to always beats a square merely printed first.
    // ASK PER EXIT, NOT PER DIRECTION — A WALL CAN LEAD TO TWO DIFFERENT ROOMS.
    //
    // `edgeApproachCandidates(dir)` answers "where can I cross this boundary", and a
    // boundary is frequently more than one exit. Western border of the Twisted Wood
    // declares east->586 `row < 19` AND east->597 `row > 20`: the same wall, split. Taking
    // the direction's first candidate gave BOTH exits the anchor 9,67, which satisfies
    // `row < 19` — so a character asked to walk to The Twisted Wood was sent to a square
    // that puts it in Main gate to Tos instead. Not a failure to arrive; arriving in the
    // WRONG ROOM, which nothing downstream would have reported as an error.
    //
    // `edgeCandidatesOf(room, e)` is the per-exit question and already exists: it runs
    // `selectedEdgeAt`, which simulates StandardLeaveDir's own ordered scan of
    // plEdge_Exits, so a candidate is kept only if crossing THERE actually fires THIS
    // exit. The world model has always used it; the bake reached past it to the raw list.
    // The operator's recorded crossings agree — 587 -> 597 is walked from row 47.
    // AND A THIRD PREFERENCE ABOVE BOTH, WHICH IS THE CLIPSWEEP FINDING PUT TO WORK.
    //
    // `reachable` is the room's body in the COLLISION view — the view that is too
    // permissive, and the one that walks 27 of the 28 squares of rock across the top of
    // Ukgoth. So "the body can reach this square" is satisfied by a square only a clip can
    // reach, and picking it bakes a doorway that works for a bot and not for a player.
    //
    // `playerReachable` is the coarse grid's main component: the map monsters move on,
    // which is too tight about individual tiles and does NOT invent a wall across the
    // middle of a room. A stage outside it is one no walking route reaches without crossing
    // ground the grid calls solid.
    //
    // Ukgoth is the case. Its north exit publishes 2,26 first and 1,27 second; 2,26 is a
    // ONE-SQUARE island in the coarse grid and 1,27 is in the main body of 1,679 — and 1,27
    // is the doorway the operator names. Preferring the coarse-connected stage is the whole
    // difference between the two.
    //
    // Ordered, never filtered: a stage that satisfies neither is still baked, because a
    // bake must never be the reason a doorway disappears.
    let best = null, second = null, fallback = null;
    try {
      for (const a of edgeCandidatesOf(room, e)) {
        for (const stage of a.stages ?? []) {
          fallback ??= stage;
          const k = `${stage.row},${stage.col}`;
          const bodyOk = !reachable || reachable.has(k);
          const playerOk = !playerReachable || playerReachable.has(k);
          if (bodyOk && playerOk) { best = stage; break; }
          if (bodyOk) second ??= stage;
        }
        if (best) break;
      }
    } catch { /* an unbaked direction simply offers nothing */ }
    best ??= second ?? fallback;
    if (!best) continue;
    out.push({ kind: 'edge', dir, to: e.to, row: best.row, col: best.col });
  }
  for (const g of room.goExits ?? []) {
    if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) continue;
    out.push({ kind: 'go', to: g.to, row: g.row, col: g.col, locked: !!g.locked });
  }
  // TWO EXITS SHARING A SQUARE ARE ONE PLACE TO WALK TO AND STILL TWO EXITS.
  //
  // This used to drop the later one, which is right about the ROUTING — the pair share a
  // square so they share a path — and wrong about everything else, because the discarded
  // entry takes its `to` with it. Western border of the Twisted Wood declares east->586
  // AND east->597, both staging at 9,67; the table therefore had no anchor for 597 at all,
  // and a caller asking "where do I stand to reach The Twisted Wood" got nothing and fell
  // back to deriving one live — which is how a character ended up walking at a phantom.
  //
  // So every declared exit is kept, and the deduplication moves to where the cost actually
  // is: one BFS per DISTINCT SQUARE rather than per exit. Nothing is recomputed and
  // nothing is lost.
  return out;
}

/** The distinct squares among a set of anchors — one BFS each is all the work there is. */
export function anchorSquares(anchors) {
  const seen = new Map();
  for (const a of anchors) {
    const k = `${a.row},${a.col}`;
    if (!seen.has(k)) seen.set(k, { row: a.row, col: a.col });
  }
  return [...seen.values()];
}

// WHICH VIEW OF "CAN I STEP THERE" THE BAKE USES — AND THE CORRECTION THAT MADE THE
// STRICT ONE USABLE AT ALL.
//
// This file used to say the mover's own view could not be baked: on room 150 it refused
// 10% of grid-adjacent walkable pairs and broke every room into 109 to 214 disconnected
// regions, which is plainly not what a room is. That measurement was real and the
// conclusion drawn from it was wrong, because it was measuring the wrong predicate.
//
// `RoomGeometry.stepAllowedByCollision` asks whether the straight line between two square
// CENTRES arrives exactly, with no sliding. `Session.validateFineTarget` — the thing that
// actually decides whether a step happens — slides, quantizes toward the start, and cares
// only that the endpoint is IN the target square, because `walkTo` compares squares. The
// player is a disc of radius 248 in a square of 1024, so centres near walls are places
// nobody stands and a person walking that corridor never tries to.
//
// Asked the mover's real question (`RoomGeometry.moverStepLands`), the same rooms come out
// as rooms: 150 in 15 regions with 96% of it in one, 578 in TWO with 99.4% in one, 545 in
// 10 with 98.5% in one, against 159, 214 and 101 before. That is the difference between a
// routing table that shatters and one that can be planned on.
//
// So the mover's view is now the DEFAULT here and `--grid` asks for the old coarse one.
// The file records which view it used, because mixing the two silently would produce a
// table that is right about some rooms and confidently wrong about others with nothing on
// its face to say which.
// A REGION IS A SET OF SQUARES THAT CAN ALL REACH EACH OTHER, WHICH MEANS THIS HAS TO BE
// A STRONGLY CONNECTED COMPONENT AND NOT A FLOOD FILL.
//
// The mover's step graph is DIRECTED, and heavily so: measured on room 150, 2,606 of
// 23,219 adjacent pairs (11%) are one-way. That is not a modelling artifact — the stock
// client's wall test only blocks a move that gets CLOSER to a wall, so a square whose
// centre already lies inside a wall's radius is one a character can leave and cannot
// enter. There really are such squares and they really are one-way.
//
// THE DOZENS OF TINY REGIONS AGAINST THE WALLS ARE NOT NOISE — THEY ARE THE SAFE SPOTS.
// A room coming out in ninety pieces is ninety-odd real features: one big body of floor
// and a scatter of corners the BSP hems in. That is the same geometric fact the safe-spot
// book measures from the other side (`substrate/m59-safespots.json`, and the note in
// CLAUDE.md): a square whose lines to the surrounding floor are broken is a square whose
// line to a MONSTER is broken, and `Room.LineOfSight` is checked for the monster and never
// for us. Held rates run 28% at zero refused neighbours and 70% at four or more. So this
// pass is a safe-spot predictor as much as a routing one, and smoothing the pockets away
// to make the count look tidy would throw away the more valuable half.
//
// What was actually wrong with the old flood is narrower and matters for both uses: it
// labelled "everything reachable FROM here", so the answer depended on which square it
// happened to start from and it was not a partition — and it could not tell a pocket you
// can leave but not enter from one you can enter but not leave. Those are opposite facts.
// For routing, one is a trap and the other is a detour. For a safe spot, the one you can
// step into and out of is the one worth walking to. Tarjan keeps every pocket and
// distinguishes them; `sizes` is what says which is which.
//
// Iterative, because these rooms reach 8,639 walkable squares and recursion would not
// survive the Cragged Mountains.
export function components(geometry, { collision = true } = {}) {
  const { rows, cols } = geometry;
  const at = (r, c) => r * (cols + 2) + c;
  const label = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const index = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const low = new Int32Array((rows + 2) * (cols + 2)).fill(0);
  const onStack = new Uint8Array((rows + 2) * (cols + 2));
  const sccStack = [];
  const sizes = [];
  let counter = 0, next = 0;

  for (let r0 = 1; r0 <= rows; r0++) {
    for (let c0 = 1; c0 <= cols; c0++) {
      // `standable`, the same predicate `neighbors` plans with. Labelling only the coarse
      // grid's squares would leave every square the BSP adds unlabelled — outside every
      // region, and so "unreachable" to anything that asks whether two exits connect.
      if (!geometry.standable(r0, c0) || index[at(r0, c0)] !== -1) continue;
      // Each frame is one square plus how many of its neighbours have been dealt with.
      const work = [{ r: r0, c: c0, i: 0, ns: null }];
      while (work.length) {
        const frame = work[work.length - 1];
        const k = at(frame.r, frame.c);
        if (frame.i === 0) {
          index[k] = counter; low[k] = counter; counter++;
          sccStack.push(k); onStack[k] = 1;
          // The MOVER's neighbours, not the grid's — that is the whole point of the bake.
          frame.ns = geometry.neighbors(frame.r, frame.c, { collision });
        }
        if (frame.i < frame.ns.length) {
          const n = frame.ns[frame.i++];
          const nk = at(n.row, n.col);
          if (index[nk] === -1) work.push({ r: n.row, c: n.col, i: 0, ns: null });
          else if (onStack[nk]) low[k] = Math.min(low[k], index[nk]);
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = at(work[work.length - 1].r, work[work.length - 1].c);
          low[parent] = Math.min(low[parent], low[k]);
        }
        if (low[k] === index[k]) {
          const id = next++;
          let size = 0, popped;
          do { popped = sccStack.pop(); onStack[popped] = 0; label[popped] = id; size++; }
          while (popped !== k);
          sizes.push(size);
        }
      }
    }
  }
  return { label, at, count: next, sizes };
}

/** Shortest collision-valid path from one square to every other, as a came-from map. */
function bfs(geometry, fromRow, fromCol, { collision = true } = {}) {
  const { cols } = geometry;
  const came = new Map();
  const key = (r, c) => r * (cols + 2) + c;
  const start = key(fromRow, fromCol);
  came.set(start, null);
  let frontier = [[fromRow, fromCol]];
  while (frontier.length) {
    const nextFrontier = [];
    for (const [r, c] of frontier) {
      for (const n of geometry.neighbors(r, c, { collision })) {
        const k = key(n.row, n.col);
        if (came.has(k)) continue;
        came.set(k, { row: r, col: c, dir: n.dir });
        nextFrontier.push([n.row, n.col]);
      }
    }
    frontier = nextFrontier;
  }
  return { came, key };
}

const LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [`${dr},${dc}`, ch]));

function pathString(came, key, fromRow, fromCol, toRow, toCol) {
  const steps = [];
  let r = toRow, c = toCol;
  for (;;) {
    const prev = came.get(key(r, c));
    if (prev === undefined) return null;          // unreachable
    if (prev === null) break;                     // reached the start
    // A JUMP IS WRITTEN INLINE, NOT IN A SEPARATE TABLE.
    //
    // The eight letters cover every unit step and nothing else, so a route containing a
    // FALL — Ukgoth's cliff is row 36,col 16 to row 38,col 10, two rows and six columns in
    // one move — could not be spelled and was dropped WHOLE. Room 599 has three anchors,
    // six ordered pairs between them, and exactly one baked route; the crossing a traveller
    // actually needs was reachable, unspellable, and therefore absent.
    //
    // The first fix here put those pairs in a separate squares-only table, which made the
    // two encodings alternatives — and they are not. A real route is mostly ordinary steps
    // WITH a jump in the middle of it, so one string has to be able to say both. `(dr,dc)`
    // is that: every old string still decodes unchanged, and a jump costs a few bytes where
    // it occurs instead of costing the route its place in the table.
    const dr = r - prev.row, dc = c - prev.col;
    const ch = LETTER.get(`${dr},${dc}`) ?? `(${dr},${dc})`;
    steps.push(ch);
    r = prev.row; c = prev.col;
    if (r === fromRow && c === fromCol) break;
  }
  return steps.reverse().join('');
}

// THE BLINK POINT, IF THE KOD DECLARED ONE. Read lazily and tolerated when absent: a clone
// without a Meridian 59 source tree has no substrate/m59-blink.json and must still bake.
let BLINK_BOOK = undefined;
function blinkPointFor(roomNum) {
  if (BLINK_BOOK === undefined) {
    try {
      const f = new URL('../substrate/m59-blink.json', import.meta.url);
      BLINK_BOOK = JSON.parse(readFileSync(f, 'utf8')).rooms ?? {};
    } catch { BLINK_BOOK = {}; }
  }
  return BLINK_BOOK[roomNum] ?? BLINK_BOOK[String(roomNum)] ?? null;
}

/** Bake one room. */
export function bakeRoom(room, { collision = true } = {}) {
  const geometry = sharedRoomGeometry(room);
  if (!geometry?.collisionReady)
    return { room: room.num, skipped: 'no collision geometry' };
  // THE MASK FIRST, BECAUSE EVERYTHING ELSE HERE IS THEN A LOOKUP. Attaching it makes
  // `neighbors({collision:true})` an array index for the component pass and every BFS
  // below, instead of eight traces a square repeated by each of them.
  const mask = collision ? geometry.buildStepMask() : null;
  if (mask) geometry.attachStepMask(mask);
  const comp = components(geometry, { collision });
  // THE ROOM ITSELF IS THE BIGGEST REGION AND EVERY OTHER ONE IS A POCKET — but "outside
  // the main region" is NOT the same as "cannot be walked to", and conflating the two is
  // the trap this bake nearly shipped. An exit anchor is usually a pocket by design: you
  // step into the doorway and you cannot step back off it into the room. So what a
  // consumer needs is one-directional — can the body of the room REACH this square —
  // which is one flood from any square of the main region, not an equality test.
  //
  // Computed BEFORE the anchors, because choosing which staging square on a boundary is
  // "the exit" is exactly the decision that needs this answer.
  // THE BIGGEST STRONGLY CONNECTED SET IS NOT THE ROOM, AND IN WEST JASPER IT IS A TRAP.
  //
  // `components` is Tarjan, so a region here is a set of MUTUALLY reachable squares, which is
  // the right definition. Picking the largest one as "the room" is the part that is wrong,
  // because a one-way ledge inside the body splits it into several SCCs while a dead-end
  // pocket above the ledge stays whole. West Jasper measured, 2,669 walkable squares:
  //
  //     largest SCC                          795 squares, and 34 of 35 exits "stranded"
  //     forward reach from the inn doorway  1,464 squares, and 6 of 6 other doors
  //     forward reach from the north edge     795 squares, and 0 of 6 other doors
  //
  // The 795 IS the north-edge pocket -- a body that walks in from Sweet Grass Prairies can
  // reach no exit at all -- and the bake crowned it the room and called every real door
  // unreachable. What `reachedFromBody` is asked for is one-directional ("can the body of the
  // room reach this square"), so the honest seed is simply whichever square reaches the most,
  // not whichever mutual clique is biggest.
  //
  // Cheap despite looking quadratic: candidates are one square per SCC, largest first, and
  // any candidate already inside an earlier flood is SKIPPED -- if A is reachable from B then
  // everything A reaches is reachable from B, so A's set cannot be the larger one and cannot
  // be lost by skipping it.
  const floodFrom = (r, c) => {
    const seen = new Set([`${r},${c}`]);
    const stack = [{ r, c }];
    while (stack.length) {
      const at = stack.pop();
      for (const n of geometry.neighbors(at.r, at.c, { collision })) {
        const k = `${n.row},${n.col}`;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push({ r: n.row, c: n.col });
      }
    }
    return seen;
  };
  const reps = [];
  {
    const seenLabel = new Set();
    for (let r = 1; r <= geometry.rows; r++)
      for (let c = 1; c <= geometry.cols; c++) {
        if (!geometry.standable(r, c)) continue;
        const id = comp.label[comp.at(r, c)];
        if (id < 0 || seenLabel.has(id)) continue;
        seenLabel.add(id);
        reps.push({ r, c, id, size: comp.sizes[id] ?? 0 });
      }
    reps.sort((x, y) => y.size - x.size);
  }
  let mainSeed = null, mainRegion = -1, mainSize = 0;
  let reachedFromBody = new Set();
  {
    const covered = new Set();
    for (const rep of reps) {
      if (covered.has(`${rep.r},${rep.c}`)) continue;
      const set = floodFrom(rep.r, rep.c);
      for (const k of set) covered.add(k);
      if (set.size > reachedFromBody.size) {
        reachedFromBody = set;
        mainSeed = { r: rep.r, c: rep.c };
        mainRegion = rep.id;
      }
    }
    // `main_region_squares` now means what every consumer already read it as: how much of the
    // room the body can actually walk to. It used to mean the size of a mutual clique, which
    // is a different and much less useful number.
    mainSize = reachedFromBody.size;
  }

  // The coarse grid's own main component — see `playerReachable` in exitAnchors. Computed
  // here rather than passed in because it is one flood fill over squares already in memory,
  // and the bake is the only caller that needs it.
  const coarseBody = (() => {
    const seen = new Map(); let id = 0, best = -1, bestId = -1;
    for (let r = 0; r <= geometry.rows; r++) for (let c = 0; c <= geometry.cols; c++) {
      if (!geometry.walkable(r, c) || seen.has(`${r},${c}`)) continue;
      const stack = [[r, c]]; seen.set(`${r},${c}`, id); let n = 0;
      while (stack.length) {
        const [a, b] = stack.pop(); n++;
        for (const nb of geometry.neighbors(a, b, { collision: false })) {
          if (!geometry.walkable(nb.row, nb.col)) continue;
          const k = `${nb.row},${nb.col}`;
          if (seen.has(k)) continue;
          seen.set(k, id); stack.push([nb.row, nb.col]);
        }
      }
      if (n > best) { best = n; bestId = id; }
      id++;
    }
    const out = new Set();
    for (const [k, v] of seen) if (v === bestId) out.add(k);
    return out;
  })();
  const anchors = exitAnchors(room, geometry,
    { reachable: reachedFromBody, playerReachable: coarseBody });
  const regionOf = a => comp.label[comp.at(a.row, a.col)];
  const tagged = anchors.map(a => ({ ...a, region: regionOf(a),
                                     from_body: reachedFromBody.has(`${a.row},${a.col}`) }));
  const strandedExits = tagged.filter(a => !a.from_body).length;

  // ONE BFS PER ANCHOR, AND NO SAME-REGION FILTER ON IT.
  //
  // This used to skip any pair of anchors in different regions, which was right when a
  // region was a flood fill and is wrong now that it is a strongly connected component:
  // an exit square is very often a POCKET ON PURPOSE — you can step onto it and you cannot
  // step back off it into the room, because that is what standing in a doorway is. Under
  // mutual reachability every one of room 578's four exits sits outside the main body, and
  // filtering on that would have baked no routes to any of them.
  //
  // The BFS already answers the only question that matters — is there a way from here to
  // there — so it is simply asked, and a pair with no path silently produces no entry.
  // ONE BFS PER DISTINCT SQUARE, not per exit — see anchorSquares. Two exits on one
  // square asked the same question twice.
  const squares = anchorSquares(tagged.filter(a => a.region >= 0));

  // BLINK IS A ONE-WAY PORTAL AND EVERY ROOM HAS ONE — see tools/m59-blink.mjs.
  //
  // `blink.kod` teleports the caster to viTeleport_row/col, a fixed square declared per room,
  // from ANYWHERE in the room. So every exit that square can walk to is reachable from
  // anywhere a character can cast, whatever ledge it walked itself into. In West Jasper that
  // is the difference between one door and all seven; measured across the whole map it makes
  // a difference in 8 rooms and none at all in the rest, which is the expected shape.
  //
  // KEPT APART FROM WALKING, DELIBERATELY. It costs mana, a character may have to rest to
  // afford it, and a cast can fail and need repeating — so this is never merged into `reach`,
  // which is what the router plans on. A caller that has run out of walking answers can ask
  // for this one; nothing gets it by accident.
  const blinkAt = blinkPointFor(room.num);
  const blink = (() => {
    if (!blinkAt || !geometry.walkable(blinkAt.row, blinkAt.col)) return null;
    const from = floodFrom(blinkAt.row, blinkAt.col);
    return { row: blinkAt.row, col: blinkAt.col, squares: from.size,
             reaches: squares.filter(q => from.has(`${q.row},${q.col}`))
                        .map(q => `${q.row},${q.col}`).sort() };
  })();

  const routes = {};
  const pivots = {};
  // WHETHER A PAIR IS JOINED AT ALL, RECORDED SEPARATELY FROM THE ROUTE BETWEEN THEM.
  //
  // Those were the same fact until a jump appeared in one. `pathString` encodes a route as
  // one letter per step, in `STEP_DIRS`, which is the eight unit directions — and a fall is
  // a single move of two or three squares. `LETTER.get('3,-3')` is undefined, `pathString`
  // returns null, and the pair silently produces no entry: the BFS reached it, the bake
  // dropped it, and `bakedPath` — which m59-world.mjs reads as "can walking join these two
  // exits" — answered no.
  //
  // Found in Ukgoth, and it is exactly the room where it costs the most. The route from the
  // Castle Victoria doorway to the Sentinel doorway is 83 steps and its FIRST move is a
  // fall, 2,26 -> 5,23. So the transit check refused a crossing the mover can make, and
  // m59-routing-test's "the directed answer still offers the way that works" went red the
  // moment the north anchor moved off the rock island onto the real door.
  //
  // `reach` is the honest half: a BFS answer, kept whether or not the steps can be spelled.
  // `routes` and `pivots` stay exactly as they were — a caller wanting the SQUARES still
  // gets null and still has to work them out — and `unspellable` counts what was dropped,
  // because a bake that quietly omits a thing is how this went unnoticed.
  const reach = {};
  let unspellable = 0;
  for (const from of squares) {
    const targets = squares.filter(t => t.row !== from.row || t.col !== from.col);
    if (!targets.length) continue;
    const { came, key } = bfs(geometry, from.row, from.col, { collision });
    for (const to of targets) {
      const pair = `${from.row},${from.col}>${to.row},${to.col}`;
      if (came.has(key(to.row, to.col))) reach[pair] = 1;
      const p = pathString(came, key, from.row, from.col, to.row, to.col);
      if (p == null) { if (reach[pair]) unspellable++; continue; }
      routes[pair] = p;

      // AND THE PIVOTS, WHICH ARE WHAT A WALKER SHOULD ACTUALLY BE GIVEN.
      //
      // A square-by-square route reproduces the failure the whole bake exists to avoid:
      // stepping between square CENTRES runs an axis-aligned move into wall faces that
      // are 54.9% non-axis-aligned in these rooms, and measured on 587 that refuses 218
      // of 311 steps — 200 of them without moving the character at all.
      //
      // `stringPull` reaches as far along the route as the straight line still ARRIVES
      // with `slide:false`, which is stricter than the ordinary mover. Doing it HERE
      // rather than at walk time is the point of a bake: every leg is proved before any
      // character walks it, once, offline, instead of being rediscovered per journey.
      // `unverified` counts the legs it could not prove — a route that is mostly those is
      // one the walker will still struggle with, and the table should say so rather than
      // let it be inferred.
      try {
        const steps = replay(from.row, from.col, p);
        const pts = [{ row: from.row, col: from.col }, ...steps]
          .map(s => ({ x: (s.col - 0.5) * CLIENT_FINENESS, y: (s.row - 0.5) * CLIENT_FINENESS }));
        const pulled = geometry.stringPull(pts);
        pivots[pair] = {
          squares: pulled.points.map(pt => [Math.round(pt.y / CLIENT_FINENESS - 0.5) + 1,
                                            Math.round(pt.x / CLIENT_FINENESS - 0.5) + 1]),
          unverified: pulled.unverified,
        };
      } catch { /* a route we cannot pull is still a route; the step string stands */ }
    }
  }
  return {
    room: room.num,
    rows: geometry.rows, cols: geometry.cols,
    // ONE BYTE A SQUARE, ONE BIT A DIRECTION, in `STEP_MASK_DIRS` order — the whole of
    // `moverStepLands`, so the runtime never has to trace. 510,789 squares across 264
    // rooms is 0.49 MB raw and 0.65 MB base64; the trace it replaces cost 1.2s on one
    // cold path and took twelve characters out of the world. See RoomGeometry.buildStepMask.
    ...(mask ? { stepMask: Buffer.from(mask).toString('base64') } : {}),
    security: geometry.security ?? null,
    view: collision ? 'collision' : 'grid',
    regions: comp.count,
    main_region: mainRegion,
    main_region_squares: mainSize,
    ...(blink ? { blink } : {}),
    walkable: comp.sizes.reduce((n, s) => n + s, 0),
    // Every region that is not the room proper, smallest first. These are the corners the
    // BSP hems in — the safe-spot candidates — and a one-square one is the strongest.
    pockets: comp.sizes.filter((_, id) => id !== mainRegion).length,
    stranded_exits: strandedExits,
    // Anchor pairs the BFS joined, including the ones whose steps cannot be spelled — see
    // the note above `reach`. `unspellable` is how many of those there were.
    reach,
    ...(unspellable ? { unspellable } : {}),
    // `from_body` is the one a router should read: can the room walk to this exit. `region`
    // is kept beside it because a pocket exit and a main-body exit behave differently once
    // you are standing on one — the first cannot be stepped back off.
    anchors: tagged.map(a => ({ kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                                row: a.row, col: a.col, region: a.region,
                                from_body: !!a.from_body })),
    routes,
    // The same routes as verified PIVOTS. See where these are built: a walker given
    // squares re-discovers the off-plan problem; a walker given pivots does not.
    pivots,
  };
}


/**
 * The order to bake rooms in: the ones the fleet actually stands in, first.
 *
 * A PARTIAL TABLE IS USEFUL IN PROPORTION TO WHICH ROOMS ARE IN IT, and until now the
 * order was `Object.values(map.rooms)`, i.e. whatever the map happened to list. That makes
 * the first twenty minutes of a bake worth almost nothing to a running fleet, because the
 * rooms it walks are scattered through the file. Rooms without a mask degrade individually
 * to the coarse grid, so an interrupted bake in this order is a table that already covers
 * the routes anybody is on.
 *
 * Three tiers, and the third is why islands sort last:
 *
 *   1. VISITED, by how often. `substrate/history/` records a room NAME on every sample and
 *      event — 110 distinct rooms across this machine's records, from 22,722 samples in
 *      Upstairs in Castle Victoria down to single figures. Walk logs add the operator's own
 *      rooms by object id.
 *   2. NEAR something visited, by hop distance over the room graph. A room one door from
 *      the fleet's ground is a room the fleet is one decision away from entering.
 *   3. Everything else, in map order.
 *
 * A NAME IS NOT A ROOM AND TWO ROOMS SHARE A NAME. "The King's Way" is 575 and 576; "The
 * Cragged Mountains" is 578 and 598. Both get the credit, which is right for an ordering —
 * the cost of baking one room early is nothing, and resolving the ambiguity would need
 * per-sample coordinates the history does not carry.
 *
 * Ordering only. It never drops a room, so the finished table is identical either way.
 */
export function bakeOrder(map, { historyDir = null, walksDir = null } = {}) {
  const byName = new Map();
  for (const r of Object.values(map.rooms)) {
    const k = String(r?.name ?? '').trim().toLowerCase();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(Number(r.num));
  }
  const visits = new Map();
  const bump = (num, n) => visits.set(num, (visits.get(num) ?? 0) + n);

  const hist = historyDir ?? join(REPO, 'substrate', 'history');
  const walk = (dir, depth = 0) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let text = '';
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/"room":"([^"]*)"/g))
        for (const num of byName.get(m[1].trim().toLowerCase()) ?? []) bump(num, 1);
    }
  };
  walk(hist);

  // The operator's own recorded walks, which name rooms by the SERVER's object id.
  const byObj = new Map();
  for (const r of Object.values(map.rooms)) if (r?.objId) byObj.set(r.objId, Number(r.num));
  const wdir = walksDir ?? join(REPO, 'substrate', 'walks');
  try {
    for (const f of readdirSync(wdir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const m of readFileSync(join(wdir, f), 'utf8').matchAll(/"room":(\d+)/g)) {
        const num = byObj.get(Number(m[1]));
        if (num != null) bump(num, 1);
      }
    }
  } catch { /* no walk logs is not an error */ }

  // Hop distance from the visited set, over whatever exits the map declares.
  const neighbours = num => {
    const r = map.rooms[String(num)];
    const out = new Set();
    for (const e of r?.edgeExits ?? []) if (e?.to != null) out.add(Number(e.to));
    for (const e of r?.goExits ?? []) if (e?.to != null && Number(e.to) > 0) out.add(Number(e.to));
    return [...out];
  };
  const dist = new Map();
  let frontier = [...visits.keys()];
  for (const n of frontier) dist.set(n, 0);
  for (let d = 1; frontier.length && d <= 12; d++) {
    const next = [];
    for (const n of frontier)
      for (const m of neighbours(n))
        if (!dist.has(m)) { dist.set(m, d); next.push(m); }
    frontier = next;
  }

  return { visits, dist,
    compare: (a, b) => {
      const va = visits.get(Number(a.num)) ?? 0, vb = visits.get(Number(b.num)) ?? 0;
      if (va !== vb) return vb - va;                       // most-visited first
      const da = dist.get(Number(a.num)) ?? 99, db = dist.get(Number(b.num)) ?? 99;
      if (da !== db) return da - db;                       // then nearest to somewhere visited
      return Number(a.num) - Number(b.num);                // then stable
    } };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const only = val('--rooms')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  const check = argv.includes('--check');
  // The mover's view is the point of the bake now; `--grid` asks for the old coarse one,
  // which is only useful for comparing the two.
  const collision = !argv.includes('--grid');

  const map = loadMap(movementMapFile());
  const manifest = map.geometryManifestSha256 ?? null;
  const rooms = Object.values(map.rooms)
    .filter(r => r?.roo && (!only || only.includes(Number(r.num))));
  // MOST-WALKED FIRST — see bakeOrder. A bake that is interrupted, or read while still
  // running, then covers the rooms the fleet is actually in rather than a scatter.
  const order = bakeOrder(map);
  rooms.sort(order.compare);

  // THIRTEEN MINUTES THAT USED TO BE ALL-OR-NOTHING. The whole table was one write after
  // the loop, so a Ctrl-C, a reboot or an OOM at room 250 of 264 produced nothing at all
  // and the next run started from the beginning. Two things fix that and they are the same
  // mechanism: the partial table is flushed as it goes, and a rerun can adopt what is
  // already on disk.
  //
  // ADOPTION IS GATED ON THE MANIFEST AND ON THE VIEW, because a half-table stitched from
  // two different maps is exactly the confidently-wrong artifact this file keeps warning
  // about — and unlike a stale table, nothing downstream could detect it. Same geometry
  // and same view, or the existing rooms are ignored and it bakes from scratch.
  const resume = argv.includes('--resume');
  const out = {};
  if (resume) {
    try {
      const prior = JSON.parse(readFileSync(ROUTES_FILE(), 'utf8'));
      const sameMap = prior?.geometryManifestSha256 && manifest
        && prior.geometryManifestSha256 === manifest;
      const sameView = (prior?.view ?? 'grid') === (collision ? 'collision' : 'grid');
      // A half-table stitched from two PREDICATES is the same kind of undetectable wrong
      // as one stitched from two maps, so --resume refuses it for the same reason.
      const samePredicate = (prior?.stepMaskVersion ?? 1) === STEP_MASK_VERSION;
      const sameBake = (prior?.bakeVersion ?? 1) === BAKE_VERSION;
      if (sameMap && sameView && samePredicate && sameBake) {
        for (const [num, baked] of Object.entries(prior.rooms ?? {}))
          if (baked && !baked.skipped) out[num] = baked;
        console.error(`resuming: ${Object.keys(out).length} room(s) already baked from the same map`);
      } else {
        console.error(`ignoring the table on disk — ` +
          (!sameMap ? 'it was baked from different geometry'
           : !sameView ? `it is the ${prior?.view} view`
           : !samePredicate ? `it was baked with step-mask v${prior?.stepMaskVersion ?? 1}, this build is v${STEP_MASK_VERSION}`
           : `it was baked by bake v${prior?.bakeVersion ?? 1}, this build is v${BAKE_VERSION}`));
      }
    } catch { console.error('nothing usable on disk to resume from'); }
  }
  const todo = rooms.filter(r => !(String(r.num) in out));
  console.error(`baking ${todo.length} room(s)${resume && todo.length !== rooms.length
    ? ` (${rooms.length - todo.length} already done)` : ''}…`);

  let skipped = 0, pairs = 0, pockets = 0, stranded = 0;
  const t0 = Date.now();
  // Flushed on a CLOCK rather than every N rooms, because room sizes vary by two orders
  // of magnitude here: 264 rooms is anything from 18ms to 30s each, so "every 25 rooms"
  // is thirty seconds in one place and six minutes in another.
  const FLUSH_MS = 60_000;
  let lastFlush = Date.now();
  const write = () => {
    mkdirSync(dirname(ROUTES_FILE()), { recursive: true });
    writeFileSync(ROUTES_FILE(), JSON.stringify({
      format: 'm59-routes/1',
      view: collision ? 'collision' : 'grid',
      builtAt: new Date().toISOString(),
      builtFrom: movementMapFile(),
      geometryManifestSha256: manifest,
      // WHAT THE MASK BITS MEAN. The manifest above hashes the geometry and therefore
      // cannot notice the PREDICATE changing, so a table baked by older code against the
      // same map verifies perfectly and encodes the wrong doors. See STEP_MASK_VERSION.
      stepMaskVersion: STEP_MASK_VERSION,
      bakeVersion: BAKE_VERSION,
      // Says outright that the table is short of the map it was built from, so a partial
      // flush cannot be mistaken for a finished bake by anything reading it.
      complete: Object.keys(out).length + skipped >= rooms.length && !only,
      rooms: out,
    }));
  };

  for (const [i, room] of todo.entries()) {
    const t = Date.now();
    const baked = bakeRoom(room, { collision });
    if (baked.skipped) { skipped++; continue; }
    out[baked.room] = baked;
    pairs += Object.keys(baked.routes).length;
    pockets += baked.pockets ?? 0;
    stranded += baked.stranded_exits ?? 0;
    if (todo.length > 5)
      process.stderr.write(`\r  ${i + 1}/${todo.length}  room ${baked.room} ` +
        `${baked.anchors.length} exits, ${baked.main_region_squares}/${baked.walkable} ` +
        `in the main body, ${baked.pockets} pocket(s), ` +
        `${Object.keys(baked.routes).length} routes, ${Date.now() - t}ms      `);
    if (!check && Date.now() - lastFlush >= FLUSH_MS) { write(); lastFlush = Date.now(); }
  }
  process.stderr.write('\n');
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`baked ${Object.keys(out).length} room(s) in ${took}s — ${pairs} routes, ` +
                `${skipped} without collision geometry, ${pockets} pocket(s) off the main ` +
                `body (safe-spot candidates), ${stranded} exit(s) stranded outside it`);

  if (check) {
    // WHAT A ROOM ACTUALLY LOOKS LIKE, rather than a region count. A room in a hundred
    // pieces with 99% of its floor in one of them is a normal room with a lot of corners.
    // The line worth acting on is an exit THE BODY OF THE ROOM CANNOT REACH.
    //
    // AND THAT IS A CLAIM ABOUT THIS MODEL, NOT ABOUT THE WORLD. This report used to say
    // "walking cannot join those; that is what blink is for" about every such exit, which
    // is an overclaim three ways over. Most of them are neither:
    //
    //   * a doorway is a POCKET BY DESIGN — you step onto the exit square and cannot step
    //     back off it into the room — and is reached perfectly well from the body;
    //   * this model is stricter than the client it models, so an unreachable reading is
    //     as likely to be ours as the map's;
    //   * the one place in the world genuinely joined only by blink is the CRAGGED
    //     MOUNTAINS cliff (578, and 598 by the same name): entering by the north-west, the
    //     south-west and south-east exits are a one-way trip unless you blink up the cliff
    //     near the north-west corner.
    //
    // So this says what it measured and leaves the conclusion to somebody who can go and
    // look. A refusal we invented reads exactly like a wall, which is the failure this
    // whole routing path exists to stop repeating.
    const rows = Object.values(out).sort((a, b) =>
      (b.stranded_exits - a.stranded_exits) || (a.main_region_squares / a.walkable) - (b.main_region_squares / b.walkable));
    for (const r of rows.slice(0, 12))
      console.error(`  room ${String(r.room).padEnd(5)} ` +
        `${String(Math.round(100 * r.main_region_squares / Math.max(1, r.walkable))).padStart(3)}% of ${String(r.walkable).padStart(5)} squares in one body, ` +
        `${String(r.pockets).padStart(4)} pocket(s), ` +
        (r.stranded_exits
          ? `${r.stranded_exits} of ${r.anchors.length} exit(s) this model cannot walk to from that body — go and look before believing it`
          : `all ${r.anchors.length} exit(s) reachable from it`));
  } else {
    write();
    const mb = (readFileSync(ROUTES_FILE()).length / 1048576).toFixed(2);
    console.error(`wrote ${ROUTES_FILE()} (${mb} MB)`);
  }
}
