#!/usr/bin/env node
// WHERE DOES THE MOVER LET US WALK ONTO GROUND THE COARSE GRID CALLS SOLID?
//
//   node tools/m59-clipsweep.mjs                 every room, worst first
//   node tools/m59-clipsweep.mjs --room 599
//   node tools/m59-clipsweep.mjs --anchors       only the exit anchors, and how they are reached
//   node tools/m59-clipsweep.mjs --json
//
// OFFLINE. Reads the same baked geometry the broker plans on; no server, no broker.
//
// THE INVARIANT THIS CHECKS, AND IT IS THE ONE THE WHOLE SUBSYSTEM RESTS ON. The
// collision view is supposed to be STRICTER than the coarse grid — "the mask may only
// ever PREFER", in CLAUDE.md's words. A safe wall IS the two disagreeing, and the
// disagreement is always meant to run one way: the grid offers a neighbour and the BSP
// refuses it. That is why a bake can only ever cost a walk, never authorise one.
//
// IN UKGOTH IT RUNS THE OTHER WAY, and that is not a preference, it is permission. Row 1
// of room 599 is two separate patches of floor — 27-34 and 62-66 — with solid rock
// between them. The mover will walk 27 of the 28 steps across that rock, so the router
// plans a crossing there and the character takes it, because the SERVER does no geometry
// check at all and trusts the client. The operator's account of the real room: the only
// doorway to Castle Victoria is at 1,27, reached by a run-and-fall jump onto a cliff
// top, and the eastern crossing "must've cheated through the wall by accident".
//
// It did. And it invalidated a whole afternoon's conclusions: 21 of 21 characters
// "arrived" at Castle Victoria through that wall in 17-23 seconds, which was read as
// proof that routing was fine and the problem was contention between bodies.
//
// SO THIS COUNTS THE PERMISSION, NOT THE PREFERENCE. A step is a CLIP when
// `moverStepLands` allows it onto a square `walkable` calls solid. Every one of those is
// a place a bot can go and a player cannot.
//
// WHY THE COARSE GRID IS TREATED AS THE TRUTH HERE, given this repository spends most of
// its time saying the opposite: because the two disagree in a KNOWN direction. The grid
// is too generous about tight squares — it calls the wall side of a gap open — and that
// is the failure the collision view was built to correct. It is not generous about SOLID
// ROCK. So grid-solid plus mover-open is not the ordinary disagreement; it is the one
// that cannot be explained by coarseness, and it is worth every false positive it costs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TABLE = join(REPO, 'substrate', 'm59-routes.json');
const OUT = join(REPO, 'substrate', 'clip-sweep.json');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIRS = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];

const map = await loadMap();
const att = attachStepMasks(map);
if (!att.ok) console.error(`[clipsweep] no usable step masks: ${att.why} — every room will look clean`);

const only = arg('--room') ? Number(arg('--room')) : null;
const table = (() => { try { return JSON.parse(readFileSync(TABLE, 'utf8')); } catch { return null; } })();

/**
 * The coarse grid's own connected components, over grid-walkable squares only.
 *
 * This is the map MONSTERS move on and the one this repository spends most of its time
 * declining to treat as authority — which is right for a SQUARE and wrong for a ROOM. The
 * grid is too tight about individual tiles; it does not invent a wall across the middle of
 * a room. So "these five squares have no grid path to the other 1,679" is a claim it can
 * make, and the claim is that a player cannot walk there.
 *
 * Deliberately NOT `neighbors(collision:true)`: that is the view under test.
 */
function coarseComponents(g, R, C) {
  const of = new Map(), size = new Map();
  let id = 0;
  for (let r = 0; r <= R; r++) for (let c = 0; c <= C; c++) {
    if (!g.walkable(r, c) || of.has(`${r},${c}`)) continue;
    const stack = [[r, c]]; of.set(`${r},${c}`, id); let n = 0;
    while (stack.length) {
      const [a, b] = stack.pop(); n++;
      for (const nb of g.neighbors(a, b, { collision: false })) {
        if (!g.walkable(nb.row, nb.col)) continue;
        const k = `${nb.row},${nb.col}`;
        if (of.has(k)) continue;
        of.set(k, id); stack.push([nb.row, nb.col]);
      }
    }
    size.set(id, n); id++;
  }
  let main = -1, best = -1;
  for (const [k, n] of size) if (n > best) { best = n; main = k; }
  return { of, size, main, main_size: best, count: id };
}

const rows = [];
for (const num of Object.keys(map.rooms).map(Number).sort((a, b) => a - b)) {
  if (only != null && num !== only) continue;
  const room = map.rooms[num];
  const g = room?.roo && sharedRoomGeometry(room);
  if (!g?.moverStepLands) continue;

  let clipSteps = 0, legalSteps = 0;
  const clipTargets = new Set();
  const R = room.rows ?? 0, C = room.cols ?? 0;
  for (let r = 0; r <= R; r++) {
    for (let c = 0; c <= C; c++) {
      if (!g.walkable(r, c)) continue;             // only ask FROM real floor
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr > R || nc > C) continue;
        if (!g.moverStepLands(r, c, nr, nc)) continue;
        if (g.walkable(nr, nc)) { legalSteps++; continue; }
        clipSteps++; clipTargets.add(`${nr},${nc}`);
      }
    }
  }
  if (!clipSteps && !legalSteps) continue;

  // AND WHERE THE ANCHORS SIT. An anchor on ground only a clip can reach is worse than a
  // badly placed one: it is a doorway the fleet can only use by cheating, and it will look
  // like it works right up until somebody watches.
  //
  // ASKING WHETHER THE ANCHOR SQUARE IS SOLID IS THE WRONG QUESTION, AND UKGOTH IS WHY.
  //
  // The first version of this asked exactly that — `!walkable(anchor)` — and reported
  // Ukgoth CLEAN, in the same run whose header calls Ukgoth the worst case in the world.
  // Room 599's north anchor to Outside Castle Victoria was baked at row 1, col 62, and
  // that square IS grid-walkable. It is also one of FIVE grid-walkable squares in a patch
  // with no coarse-grid connection to the other 1,679: an island in the rock at the room's
  // north-east corner, which the east anchor to 598 sits on as well.
  //
  // So the anchor was fine and the APPROACH was the cheat, and no per-square test can see
  // that. The question a doorway has to answer is "can a body get here from the rest of
  // the room without crossing ground the coarse grid calls solid", which is a CONNECTIVITY
  // question — and the coarse grid is the only view that can answer it, because the
  // collision view is the one being permissive.
  const comp = coarseComponents(g, R, C);
  const baked = table?.rooms?.[num] ?? table?.rooms?.[String(num)];
  const anchors = (baked?.anchors ?? []).map(a => {
    const id = comp.of.get(`${a.row},${a.col}`);
    return {
      to: a.to, dir: a.dir ?? a.kind,
      at: { row: a.row, col: a.col },
      on_solid_ground: !g.walkable(a.row, a.col),     // the anchor square itself is grid-solid
      island: id != null && id !== comp.main ? comp.size.get(id) : 0,
    };
  });
  const badAnchors = anchors.filter(a => a.on_solid_ground || a.island);

  rows.push({ room: num, name: room.name ?? '',
              clip_steps: clipSteps, legal_steps: legalSteps,
              clip_squares: clipTargets.size,
              pct: legalSteps + clipSteps ? (100 * clipSteps / (legalSteps + clipSteps)) : 0,
              coarse_islands: comp.count - 1, coarse_body: comp.main_size,
              anchors: anchors.length, anchors_on_solid: badAnchors.length, bad: badAnchors });
}

rows.sort((a, b) => b.clip_squares - a.clip_squares);
if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }

const withClip = rows.filter(r => r.clip_squares > 0);
const withBad = rows.filter(r => r.anchors_on_solid > 0);
console.log(`${rows.length} room(s) checked`);
console.log(`${withClip.length} have squares the mover will step onto that the coarse grid calls SOLID`);
console.log(`${withBad.length} have an EXIT ANCHOR only a clip can reach — the square is grid-solid, ` +
            `or it is on an island of grid floor the coarse grid cannot walk to from the room's body\n`);

if (!argv.includes('--anchors')) {
  console.log('room  name                              clip sq   clip steps   % of steps');
  for (const r of withClip.slice(0, 20))
    console.log(String(r.room).padStart(4), (r.name || '').slice(0, 30).padEnd(32),
      String(r.clip_squares).padStart(7), String(r.clip_steps).padStart(12),
      (r.pct.toFixed(1) + '%').padStart(12));
}

if (withBad.length) {
  console.log('\nEXIT ANCHORS ONLY A CLIP CAN REACH — a doorway that works for a bot and not for a player:');
  for (const r of withBad)
    for (const a of r.bad)
      console.log(`  room ${String(r.room).padStart(4)} ${(r.name || '').slice(0, 26).padEnd(28)} ` +
        `-> ${String(a.to).padEnd(5)} ${String(a.dir).padEnd(6)} at row ${a.at.row}, col ${a.at.col}` +
        (a.island ? `  — on a ${a.island}-square island in the coarse grid`
                  : `  — the square itself is grid-solid`));
}

writeFileSync(OUT, JSON.stringify({
  _what: 'Squares the collision view will step onto that the coarse grid calls solid — the ' +
         'invariant running backwards. See the header of tools/m59-clipsweep.mjs.',
  swept_at: new Date().toISOString(), rooms: rows,
}, null, 2));
console.log(`\nwrote ${OUT}`);
