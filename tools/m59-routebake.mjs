#!/usr/bin/env node
// EXIT TO EXIT, WORKED OUT ONCE, OFFLINE, AGAINST THE MAP THE MOVER ACTUALLY ENFORCES.
//
//   node tools/m59-routebake.mjs                 bake every room
//   node tools/m59-routebake.mjs --rooms 150,578 just these
//   node tools/m59-routebake.mjs --check         report, write nothing
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

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from './m59-map.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';

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
  for (const ch of String(path ?? '')) {
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
export function exitAnchors(room, geometry) {
  const out = [];
  for (const e of room.edgeExits ?? []) {
    const dir = e.leaveName ?? null;
    if (!dir) continue;
    let best = null;
    try {
      for (const a of geometry.edgeApproachCandidates(dir)) {
        // Prefer one the model believes can actually be stood on and walked from.
        if (!a.stages?.length) continue;
        best = a.stages[0];
        break;
      }
    } catch { /* an unbaked direction simply offers nothing */ }
    if (!best) continue;
    out.push({ kind: 'edge', dir, to: e.to, row: best.row, col: best.col });
  }
  for (const g of room.goExits ?? []) {
    if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) continue;
    out.push({ kind: 'go', to: g.to, row: g.row, col: g.col, locked: !!g.locked });
  }
  // One anchor per square: two exits sharing a square are one place to walk to.
  const seen = new Set();
  return out.filter(a => {
    const k = `${a.row},${a.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// WHICH VIEW OF "CAN I STEP THERE" THE BAKE USES, AND WHY THE STRICT ONE IS NOT DEFAULT.
//
// The obvious answer is the mover's own trace, so that a baked route is one the mover will
// certainly walk. Measured, it is not usable for this yet: on room 150 it refuses 10% of
// grid-adjacent walkable pairs (1232 of 1365 accepted, and `slide` changes nothing), and a
// 10% cut rate on a lattice shatters connectivity — every room came out in 109 to 214
// disconnected regions, which is plainly not what a room is.
//
// It also disagrees with the SERVER, which is the only real authority: asked what a live
// character can step to, the server offered 7-8 directions where the trace allowed 4-5, and
// in two cases where our own coarse grid said the square was not walkable at all.
//
// So the strict view is baked in only when asked for, and the file records which view it
// used. Mixing the two silently would produce a routing table that is right about some
// rooms and confidently wrong about others, with nothing on its face to say which.
//
// `--collision` re-bakes with the trace. When the exit-gap record (m59-exitgap.mjs) has
// enough believed-vs-actual pairs to fix the approach model, that is the flag to flip.
export function components(geometry, { collision = false } = {}) {
  const { rows, cols } = geometry;
  const label = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const at = (r, c) => r * (cols + 2) + c;
  let next = 0;
  const sizes = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      if (!geometry.walkable(r, c) || label[at(r, c)] !== -1) continue;
      const id = next++;
      let size = 0;
      const stack = [[r, c]];
      label[at(r, c)] = id;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        size++;
        // The MOVER's neighbours, not the grid's — that is the whole point of the bake.
        for (const n of geometry.neighbors(cr, cc, { collision })) {
          if (label[at(n.row, n.col)] !== -1) continue;
          label[at(n.row, n.col)] = id;
          stack.push([n.row, n.col]);
        }
      }
      sizes.push(size);
    }
  }
  return { label, at, count: next, sizes };
}

/** Shortest collision-valid path from one square to every other, as a came-from map. */
function bfs(geometry, fromRow, fromCol, { collision = false } = {}) {
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
    const ch = LETTER.get(`${r - prev.row},${c - prev.col}`);
    if (!ch) return null;
    steps.push(ch);
    r = prev.row; c = prev.col;
    if (r === fromRow && c === fromCol) break;
  }
  return steps.reverse().join('');
}

/** Bake one room. */
export function bakeRoom(room, { collision = false } = {}) {
  const geometry = sharedRoomGeometry(room);
  if (!geometry?.collisionReady)
    return { room: room.num, skipped: 'no collision geometry' };
  const anchors = exitAnchors(room, geometry);
  const comp = components(geometry, { collision });
  const regionOf = a => comp.label[comp.at(a.row, a.col)];
  const tagged = anchors.map(a => ({ ...a, region: regionOf(a) }));

  const routes = {};
  for (const from of tagged) {
    if (from.region < 0) continue;
    const targets = tagged.filter(t => t !== from && t.region === from.region);
    if (!targets.length) continue;
    const { came, key } = bfs(geometry, from.row, from.col, { collision });
    for (const to of targets) {
      const p = pathString(came, key, from.row, from.col, to.row, to.col);
      if (p == null) continue;
      routes[`${from.row},${from.col}>${to.row},${to.col}`] = p;
    }
  }
  return {
    room: room.num,
    rows: geometry.rows, cols: geometry.cols,
    security: geometry.security ?? null,
    view: collision ? 'collision' : 'grid',
    regions: comp.count,
    anchors: tagged.map(a => ({ kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                                row: a.row, col: a.col, region: a.region })),
    routes,
  };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const only = val('--rooms')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  const check = argv.includes('--check');
  const collision = argv.includes('--collision');

  const map = loadMap(movementMapFile());
  const rooms = Object.values(map.rooms)
    .filter(r => r?.roo && (!only || only.includes(Number(r.num))));
  console.error(`baking ${rooms.length} room(s)…`);

  const out = {}; let skipped = 0, pairs = 0, split = 0;
  const t0 = Date.now();
  for (const [i, room] of rooms.entries()) {
    const t = Date.now();
    const baked = bakeRoom(room, { collision });
    if (baked.skipped) { skipped++; continue; }
    out[baked.room] = baked;
    pairs += Object.keys(baked.routes).length;
    if (baked.regions > 1) split++;
    if (rooms.length > 5)
      process.stderr.write(`\r  ${i + 1}/${rooms.length}  room ${baked.room} ` +
        `${baked.anchors.length} exits, ${baked.regions} region(s), ` +
        `${Object.keys(baked.routes).length} routes, ${Date.now() - t}ms      `);
  }
  process.stderr.write('\n');
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`baked ${Object.keys(out).length} room(s) in ${took}s — ${pairs} routes, ` +
                `${skipped} without collision geometry, ${split} room(s) in more than one region`);

  if (check) {
    for (const r of Object.values(out).filter(x => x.regions > 1).slice(0, 12))
      console.error(`  room ${r.room}: ${r.regions} regions, exits in ` +
                    `${new Set(r.anchors.map(a => a.region)).size} of them` +
                    ` — walking cannot join them; that is what blink is for`);
  } else {
    mkdirSync(dirname(ROUTES_FILE()), { recursive: true });
    writeFileSync(ROUTES_FILE(), JSON.stringify({
      format: 'm59-routes/1',
      view: collision ? 'collision' : 'grid',
      builtAt: new Date().toISOString(),
      builtFrom: movementMapFile(),
      geometryManifestSha256: map.geometryManifestSha256 ?? null,
      rooms: out,
    }));
    const mb = (readFileSync(ROUTES_FILE()).length / 1048576).toFixed(2);
    console.error(`wrote ${ROUTES_FILE()} (${mb} MB)`);
  }
}
