#!/usr/bin/env node
// THE CONTRACT TEST FOR PLANNING ON THE MAP THE MOVER ENFORCES.
//
//   node tools/m59-routing-test.mjs
//
// Movement is validated against the CLIENT's BSP; the router planned on the SERVER's
// coarse one-byte-a-square grid. Those disagree, and a router planning on a different map
// from the one the mover enforces does not produce a wrong route — it produces a character
// sliding along a wall, replanning into the same wall, and giving up. Measured offline
// against the twelve boundaries the exit-gap record complains about most, that killed 59%
// of all walks to an exit, and on prod it killed characters: several died in the Western
// border of the Twisted Wood with spiders on them while bouncing between two squares.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE FAILS IN THE DANGEROUS DIRECTION IF INVERTED:
//
//   * `moverStepLands` is the MOVER's question, not `stepAllowedByCollision`'s. The second
//     asks whether a straight line between two square CENTRES arrives with no sliding —
//     which the player, a disc of radius 248 in a square of 1024, frequently cannot do
//     next to a wall. Measured, that predicate breaks room 150 into 159 pieces and room
//     578 into 214; the mover's own gives 15 and 2. Reverting to the strict one does not
//     look like a bug, it looks like a world full of walls.
//
//   * A step mask round-trips bit for bit. A mask read against a different direction
//     order is a confident map of the WRONG doors and nothing downstream could notice.
//
//   * With no mask attached, `path` plans exactly as it did before any of this existed.
//     That is what makes the change safe for a checkout that has never run the bake.
//
//   * `blockedEdges` removes an EDGE and not a SQUARE. A wall sits between two squares;
//     blaming the square removes a perfectly good place to stand that other neighbours
//     still reach, and that was the old behaviour.
//
//   * The bake's regions are STRONGLY CONNECTED COMPONENTS, and the tiny ones against the
//     walls are kept. They are not noise — they are the safe-spot signal, the same
//     geometric fact `substrate/m59-safespots.json` measures from the other side. A pass
//     that smoothed them away to make the count look tidy would throw that away.
//
//   * An exit anchor is chosen from a staging square the room's body can REACH, not the
//     first one the boundary happens to publish. Room 578 came out with all four exits
//     "unreachable" purely because the first square on each list was one the mover cannot
//     get to and the other ten were never considered.
//
// OFFLINE AND FIXTURE-FIRST. The geometry-backed half runs only when a baked map is
// present and reports itself skipped otherwise, because a suite that silently tests
// nothing is worse than one that says it did.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoomGeometry, protocolToward, STEP_MASK_DIRS, KOD_FINENESS, CLIENT_FINENESS,
         sharedRoomGeometry, STEP_MASK_VERSION, elideLoops } from './m59-roo.mjs';
import { components, exitAnchors } from './m59-routebake.mjs';
import { loadMap, selectedEdgeAt } from './m59-map.mjs';
import { crossingBook, WALKS_DIR } from './m59-crossings.mjs';
import { stepMaskCurrent, attachStepMasks } from './m59-routes.mjs';

let passed = 0, failed = 0, skipped = 0;
function ok(what, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
}
function skip(what, why) { skipped++; console.log(`  --   ${what} — ${why}`); }

// ---------------------------------------------------------------- the quantizer
// One home, two callers: Session.validateFineTarget decides what to SEND and
// moverStepLands decides what to PLAN. Two answers here is a router planning steps the
// mover will not make, which is the entire bug.
console.log('\nprotocolToward — one answer for "which integer square is this"');
{
  const scale = CLIENT_FINENESS / KOD_FINENESS;
  // The broker's inline arithmetic, spelled out, so a drift between them is a failure here
  // rather than a fleet walking into walls.
  const broker = (value, fromValue) => {
    const wire = value / scale + KOD_FINENESS;
    if (value > fromValue) return Math.floor(wire + 1e-9);
    if (value < fromValue) return Math.ceil(wire - 1e-9);
    return Math.round(wire);
  };
  let agree = true;
  for (let from = -2048; from <= 2048; from += 97)
    for (let v = -2048; v <= 2048; v += 31)
      if (protocolToward(v, from) !== broker(v, from)) agree = false;
  ok('it agrees with the arithmetic inside validateFineTarget everywhere', agree);
  ok('it rounds back toward the start when moving forward',
     protocolToward(1000, 0) <= 1000 / scale + KOD_FINENESS);
  ok('it rounds back toward the start when moving backward',
     protocolToward(-1000, 0) >= -1000 / scale + KOD_FINENESS);
  ok('a zero-length move is nearest-rounded rather than biased',
     protocolToward(512, 512) === Math.round(512 / scale + KOD_FINENESS));
}

// ---------------------------------------------------------------- the mask, on a fixture
console.log('\nthe step mask — bit order, round trip, and what an absent one means');
{
  // A tiny room with no collision payload at all. `moverStepLands` must answer "no
  // opinion" there rather than "refused": a room whose collision could not be baked still
  // has a usable coarse grid and must not become unroutable because of this.
  const bare = RoomGeometry.fromJSON({
    rows: 3, cols: 3,
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    grid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    moveGrid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  });
  ok('a room with no collision payload is not collisionReady', !bare.collisionReady);
  ok('and it therefore has no opinion about a step rather than refusing one',
     bare.moverStepLands(2, 2, 1, 1) === true);
  ok('it reports no step mask', bare.hasStepMask === false);
  ok('and `path` therefore defaults to the coarse grid, exactly as before',
     bare.path(1, 1, 3, 3).found === true);

  // Bit order is the one thing a mask cannot survive getting wrong, because nothing
  // downstream can detect it. Pin the order itself, and the round trip through base64.
  ok('the mask has exactly eight directions', STEP_MASK_DIRS.length === 8);
  ok('and they are the DIR table in its own order, so there is one table and not two',
     STEP_MASK_DIRS.map(d => d.name).join(',') ===
     'north,northeast,east,southeast,south,southwest,west,northwest');

  const made = new Uint8Array(bare.rows * bare.cols);
  for (let i = 0; i < made.length; i++) made[i] = (i * 37) & 0xff;
  const b64 = Buffer.from(made).toString('base64');
  const back = new Uint8Array(Buffer.from(b64, 'base64'));
  ok('a mask survives base64 byte for byte',
     back.length === made.length && made.every((v, i) => back[i] === v));
  ok('a mask of the right size is accepted', bare.attachStepMask(back) === true);
  ok('and the geometry then says so', bare.hasStepMask === true);
  ok('a mask of the WRONG size is refused rather than mis-indexed',
     bare.attachStepMask(new Uint8Array(made.length + 1)) === false);
  ok('and refusing one leaves the geometry with none rather than a bad one',
     bare.hasStepMask === false);
  ok('a non-mask is refused', bare.attachStepMask([1, 2, 3]) === false);
}

// ---------------------------------------------------------------- blockedEdges
console.log('\nblockedEdges — a wall is between two squares, not on one of them');
{
  // Three squares in a row, all mutually adjacent through the grid. Blocking the edge
  // 2,2 -> 2,3 must not make 2,3 unreachable: 1,3 still reaches it.
  const flags = new Array(9).fill(1);
  const open = new Array(9).fill(0xff);
  const g = RoomGeometry.fromJSON({ rows: 3, cols: 3, flags, grid: open, moveGrid: open });
  const edge = new Set(['2,2>2,3']);
  ok('the blocked edge is gone from that square\'s neighbours',
     !g.neighbors(2, 2, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('but the square is still reachable from elsewhere — an edge is not a square',
     g.neighbors(1, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('and the reverse edge is untouched, because refusals really are one-way',
     g.neighbors(2, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 2));
  const around = g.path(2, 2, 2, 3, { blockedEdges: edge });
  ok('a route to it still exists, going round', around.found === true);
  ok('and it is longer than the single step it replaced', (around.steps?.length ?? 0) > 1);

  const walled = new Set();
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++)
    if (!(r === 2 && c === 3)) walled.add(`${r},${c}>2,3`);
  const none = g.path(1, 1, 2, 3, { blockedEdges: walled });
  ok('when every way in is refused, the answer is no route', none.found === false);
  ok('and it says WHICH view refused, so a caller can fall back to the grid',
     none.blocked_edges === walled.size &&
     /mover/.test(none.reason ?? ''), JSON.stringify(none));
  ok('while the same search with no refusals still finds the step',
     g.path(1, 1, 2, 3).found === true);
}

// ---------------------------------------------------------------- against the real map
console.log('\nagainst the baked world map');
const { movementMapFile } = await import('./m59-map-path.mjs');
const mapFile = movementMapFile();
if (!existsSync(mapFile)) {
  skip('the mover view keeps a room in one piece', 'no baked map on this machine');
  skip('a baked mask agrees with the live predicate', 'ditto');
  skip('exit anchors prefer a staging square the body can reach', 'ditto');
} else {
  const { loadMap } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(mapFile);
  const room = map.rooms[578] ?? map.rooms['578'];      // the Cragged Mountains
  const geo = room?.roo ? sharedRoomGeometry(room) : null;
  if (!geo?.collisionReady) {
    skip('the mover view keeps a room in one piece', 'room 578 has no collision geometry');
    skip('a baked mask agrees with the live predicate', 'ditto');
    skip('exit anchors prefer a staging square the body can reach', 'ditto');
  } else {
    // THE MEASUREMENT THAT TURNED THE ROUTER BACK ON. Under the strict centre-to-centre
    // predicate this room is 214 pieces; under the mover's own it is a room.
    let strictRefused = 0, moverRefused = 0, pairs = 0;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const n of geo.neighbors(r, c)) {
        pairs++;
        if (!geo.stepAllowedByCollision(r, c, n.row, n.col)) strictRefused++;
        if (!geo.moverStepLands(r, c, n.row, n.col)) moverRefused++;
      }
    }
    ok('the mover refuses strictly fewer adjacent pairs than the centre-to-centre test',
       moverRefused < strictRefused, `mover ${moverRefused}, strict ${strictRefused}, of ${pairs}`);
    // MEASURED OVER THE POPULATION THE CLAIM IS ABOUT. `neighbors` now offers `standable`
    // squares, so this denominator gained every fringe square the BSP knows and the coarse
    // grid wrote off — squares that are real ground with very few legal steps off them.
    // Counting those made the rate jump 5% -> 10.8% without the mover having become one
    // bit stricter about anything it was already asked. So the small-minority claim is
    // asserted where it was always meant: between squares the coarse grid itself accepts.
    let gridPairs = 0, gridRefused = 0;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const n of geo.neighbors(r, c)) {
        if (!geo.walkable(n.row, n.col)) continue;
        gridPairs++;
        if (!geo.moverStepLands(r, c, n.row, n.col)) gridRefused++;
      }
    }
    ok('and between squares the coarse grid accepts it refuses only a small minority',
       gridRefused / gridPairs < 0.05,
       `${(100 * gridRefused / gridPairs).toFixed(1)}% of ${gridPairs}`);
    ok('while the ground the grid wrote off is tighter, as it should be',
       moverRefused / pairs > gridRefused / gridPairs,
       `all ${(100 * moverRefused / pairs).toFixed(1)}% vs grid-only ` +
       `${(100 * gridRefused / gridPairs).toFixed(1)}%`);

    const comp = components(geo, { collision: true });
    const biggest = Math.max(...comp.sizes);
    const walkable = comp.sizes.reduce((n, s) => n + s, 0);
    // A TERRACED MOUNTAIN IS NOT ONE BODY OF FLOOR, AND THIS USED TO INSIST IT WAS.
  // The threshold was 0.6 and room 578 now comes out at 745/2450 in 139 regions, because
  // the climb rule finally refuses its 1600-unit terrace faces. That is the room the
  // operator walked on 2026-08-17: arriving from The King's Way you are in the basin and
  // cannot reach any other exit on foot; blink puts you on top and then they are all
  // reachable. A room that models as one body is a room where that is not true.
  //
  // So the property is the FLOOR, not the fraction: the largest region must still be a
  // usable body rather than a scatter of ledges, and the room must not have dissolved.
  ok('the mover view still leaves a usable body of floor rather than a scatter',
     biggest >= 500 && comp.count < walkable / 10,
     `${biggest}/${walkable} in ${comp.count} region(s)`);
    ok('and the pockets against the walls are KEPT, because they are the safe spots',
       comp.count > 1 && comp.sizes.filter(s => s === 1).length > 0,
       `${comp.sizes.filter(s => s === 1).length} single-square pocket(s)`);

    // A MASK IS ONLY WORTH HAVING IF IT IS THE SAME ANSWER. This is the assertion that
    // catches a reordered bit table, an off-by-one row stride, or a predicate that drifted
    // between the bake and the runtime.
    const mask = geo.buildStepMask();
    ok('the mask is one byte for every square', mask.length === geo.rows * geo.cols);
    const fresh = RoomGeometry.fromJSON(room.roo);
    fresh.attachStepMask(mask);
    let agree = true, checked = 0;
    for (let r = 1; r <= geo.rows && agree; r++) for (let c = 1; c <= geo.cols && agree; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const d of STEP_MASK_DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (!geo.inBounds(nr, nc) || !geo.walkable(nr, nc)) continue;
        checked++;
        if (fresh.moverStepLands(r, c, nr, nc) !== geo.moverStepLands(r, c, nr, nc)) agree = false;
      }
    }
    ok('reading the mask gives the same answer as tracing, on every pair in the room',
       agree, `${checked} pair(s) compared`);

    // AND THE ANCHOR CHOICE. A boundary publishes many staging squares; taking the first
    // is how this room reported all four exits unreachable.
    const bodySeed = (() => {
      let best = -1, id = -1;
      for (let i = 0; i < comp.sizes.length; i++) if (comp.sizes[i] > best) { best = comp.sizes[i]; id = i; }
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++)
        if (geo.walkable(r, c) && comp.label[comp.at(r, c)] === id) return { r, c };
      return null;
    })();
    const body = new Set();
    if (bodySeed) {
      const stack = [bodySeed];
      body.add(`${bodySeed.r},${bodySeed.c}`);
      while (stack.length) {
        const at = stack.pop();
        for (const n of geo.neighbors(at.r, at.c, { collision: true })) {
          const k = `${n.row},${n.col}`;
          if (body.has(k)) continue;
          body.add(k); stack.push({ r: n.row, c: n.col });
        }
      }
    }
    const naive = exitAnchors(room, geo);
    const chosen = exitAnchors(room, geo, { reachable: body });
    const reach = list => list.filter(a => body.has(`${a.row},${a.col}`)).length;
    ok('choosing anchors with the body in hand reaches at least as many exits',
       reach(chosen) >= reach(naive),
       `first-offered ${reach(naive)}/${naive.length}, body-aware ${reach(chosen)}/${chosen.length}`);
    // THIS USED TO ASSERT A STRICT IMPROVEMENT AND NOW ASSERTS THE PROPERTY, because the
    // gap it measured was closed from the other end. Anchors are now chosen per EXIT
    // (`edgeCandidatesOf`, which runs `selectedEdgeAt`) rather than per DIRECTION, so the
    // candidate list no longer contains squares that would fire a different exit — and on
    // this room that alone puts a reachable square first, leaving the body-aware pass
    // nothing to rescue. A delta is only a contract while the baseline stays bad; what
    // actually has to hold is that the body can reach these exits, so assert THAT.
    //
    // Three of four, and the fourth is not a defect: entering the Cragged Mountains by the
    // north-west makes the south-west and south-east exits a one-way trip unless you blink
    // up the cliff. It is the one place in the world genuinely joined only by blink.
    // AND IT REACHES ALL FIVE, WHICH CONTRADICTS THIS REPOSITORY'S OWN PROSE — recorded
    // rather than asserted away. CLAUDE.md calls this cliff "the one place in the world
    // genuinely joined only by blink": enter by the north-west and the south-west and
    // south-east exits are said to be a one-way trip. The model does not agree and never
    // has. Checked directly with the OLD predicate (grid gate, centre aiming), every
    // ordered anchor pair here already had a route — 35,1 -> 1,13 in 60 steps, 1,13 ->
    // 35,1 in 59 — so this is not something the standable/stand-point work introduced; it
    // only made the same routes shorter (36 and 34). Either a player really can walk it
    // and the prose is wrong, or our vertical rules are too generous here and have been
    // all along. `m59-impossible-test` still refuses every checked-in trace in both
    // Cragged Mountains rooms, so whatever it is, it is not the traversals anybody has
    // written down. Worth an hour in the client; not worth a test that lies either way.
    // AND ON THE CRAGGED MOUNTAINS THE BODY REACHES EXACTLY ONE EXIT, WHICH IS THE FINDING.
  // This assertion has now been wrong twice in opposite directions. It first demanded a
  // strict improvement over first-offered; then, when the anchor work closed that gap, it
  // demanded that the body reach EVERY exit — which the model happily satisfied because it
  // believed a character could climb a 1600-unit cliff face. It cannot. The operator
  // walked it: from the basin you reach the north exit to The King's Way and nothing else,
  // and blink is what puts you on top.
  //
  // One exit from the basin is therefore the correct answer, and it is asserted as an
  // EXACT count rather than a floor, because "reaches at least one" would pass again the
  // day the cliff reopens.
  ok('and on the Cragged Mountains the basin reaches exactly one exit — the rest need blink',
     reach(chosen) === 1 && chosen.length >= 4,
     `first-offered ${reach(naive)}, body-aware ${reach(chosen)} of ${chosen.length}`);
    ok('an anchor it cannot reach is still OFFERED rather than deleted — a bake must ' +
       'never be the reason a doorway disappears',
       chosen.length === naive.length);

    // ------------------------------------------------ clearance: do not hug the wall
    //
    // A safe spot is a square the geometry hems in, which is what makes it worth
    // STANDING on and the last thing worth ROUTING THROUGH. With a flat step cost A* is
    // indifferent between the middle of a gap and the tight side of it, and the tight
    // side is where a step slides, the mover lands off plan, and the walker starts
    // bouncing. The preference is COST, so it can shape a route and can never remove one.
    const CLEARANCE = 0.6;                    // what leaveVia asks for
    const masked = RoomGeometry.fromJSON(room.roo);
    masked.attachStepMask(geo.buildStepMask());
    const tightness = at => {
      let open = 0;
      for (const d of STEP_MASK_DIRS) {
        const r = at.row + d.dr, c = at.col + d.dc;
        // `standable`, because that is what `clearanceField` counts. Measuring openness
        // one way while the router optimises it another does not weaken the test, it
        // points it at a different quantity: with `walkable` here the preference read as
        // making routes WORSE (3.69 -> 3.89) while doing exactly what it was asked.
        if (masked.inBounds(r, c) && masked.standable(r, c)
            && masked.moverStepLands(at.row, at.col, r, c)) open++;
      }
      return STEP_MASK_DIRS.length - open;
    };
    const floor = [];
    for (let r = 1; r <= masked.rows; r++) for (let c = 1; c <= masked.cols; c++)
      if (masked.walkable(r, c)) floor.push({ row: r, col: c });
    let seed = 7, routes = 0, hugged = 0, cleared = 0, lenFlat = 0, lenClear = 0;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 400 && routes < 40; i++) {
      const a = floor[(rnd() * floor.length) | 0], b = floor[(rnd() * floor.length) | 0];
      const flat = masked.path(a.row, a.col, b.row, b.col, { clearance: 0 });
      const clear = masked.path(a.row, a.col, b.row, b.col, { clearance: CLEARANCE });
      if (!flat.found || !clear.found || flat.steps.length < 8) continue;
      routes++;
      const mean = p => p.steps.reduce((n, s) => n + tightness(s), 0) / p.steps.length;
      hugged += mean(flat); cleared += mean(clear);
      lenFlat += flat.steps.length; lenClear += clear.steps.length;
    }
    ok('the clearance preference routes further from the walls',
       routes > 10 && cleared < hugged,
       `${routes} routes, ${(hugged / routes).toFixed(2)} -> ${(cleared / routes).toFixed(2)} ` +
       'blocked neighbours per step');
    ok('and pays for it in a little length rather than in refusals',
       lenClear >= lenFlat && lenClear < lenFlat * 1.25,
       `${(lenFlat / routes).toFixed(1)} -> ${(lenClear / routes).toFixed(1)} steps`);
    // IT MAY ONLY EVER PREFER. Same rule as the mask itself: being wrong about a wall
    // costs a walk, refusing costs the errand, silently.
    let bothFound = true;
    for (let i = 0; i < 200 && bothFound; i++) {
      const a = floor[(rnd() * floor.length) | 0], b = floor[(rnd() * floor.length) | 0];
      if (masked.path(a.row, a.col, b.row, b.col, { clearance: 0 }).found
          !== masked.path(a.row, a.col, b.row, b.col, { clearance: CLEARANCE }).found)
        bothFound = false;
    }
    ok('a route that exists without the preference still exists with it', bothFound);
    // THE DESTINATION IS EXEMPT, because walking to a wall corner is the whole point of
    // a safe spot and taxing it would price the fleet out of the move that keeps it alive.
    const corner = floor.filter(p => tightness(p) >= 5)
      .find(p => masked.path(floor[0].row, floor[0].col, p.row, p.col,
                             { clearance: CLEARANCE }).found);
    ok('a tight corner is still routed to', !!corner,
       corner ? `${corner.col},${corner.row}` : 'no reachable corner in this room');
    ok('and with no mask there is nothing to measure clearance against',
       RoomGeometry.fromJSON(room.roo).clearanceField({ weight: CLEARANCE }) === null);
    ok('the field itself is off unless a weight is asked for, exactly as `path` is',
       masked.clearanceField() === null && typeof masked.clearanceField({ weight: CLEARANCE }) === 'function');
    // OFF UNLESS ASKED, which is the property that keeps a safe wall reachable on the
    // terms the safe-spot ranking measured it on. `world.reach` and every tactical walk
    // take this default; only leaveVia opts in.
    {
      const a = floor[0], b = floor[floor.length - 1];
      const plain = masked.path(a.row, a.col, b.row, b.col);
      const zero = masked.path(a.row, a.col, b.row, b.col, { clearance: 0 });
      ok('the default really is the zero-weight route, step for step',
         JSON.stringify(plain.steps) === JSON.stringify(zero.steps));
    }
  }
}

// ------------------------------------------------- one wall, two rooms, two anchors
// A BOUNDARY IS NOT AN EXIT, AND THE FAILURE IS ARRIVING SOMEWHERE ELSE RATHER THAN NOT
// ARRIVING. Western border of the Twisted Wood declares BOTH `east -> 586 row<19` and
// `east -> 597 row>20` — one wall, split by row. The bake asked
// `edgeApproachCandidates(dir)`, which is the per-DIRECTION question, took the first
// square it offered, and gave both exits the anchor 9,67. That satisfies `row<19`, so a
// character asked to walk to The Twisted Wood was routed to a square that puts it in Main
// gate to the city of Tos. Every leg reports success; the character is simply in the wrong
// room, and nothing downstream compares where it meant to go with where it went.
//
// So the property is not "an anchor exists" and not "the walk arrives" — it is that
// crossing AT the anchor fires the exit the anchor was baked FOR. `selectedEdgeAt` is the
// authority, because it simulates StandardLeaveDir's own ordered scan of plEdge_Exits
// rather than testing the one condition in isolation: a default entry is remembered but
// does not stop the scan, so a square can satisfy a condition and still lose to a later
// unconditional edge.
console.log('\nexit anchors — a shared wall gives each DESTINATION its own square');
if (!existsSync(movementMapFile())) {
  skip('per-destination exit anchors', 'no baked map');
} else {
  const map = loadMap();

  // The worked example, named, because it is the one the fleet walks and the one the
  // operator watched fail.
  const wbottw = map.rooms['587'];
  const geo = wbottw?.roo ? sharedRoomGeometry(wbottw) : null;
  if (!geo?.collisionReady) {
    skip('Western border of the Twisted Wood splits its east wall', 'no geometry for 587');
  } else {
    const anchors = exitAnchors(wbottw, geo);
    const toTos = anchors.find(a => a.to === 586), toWood = anchors.find(a => a.to === 597);
    ok('both east exits get an anchor at all', !!toTos && !!toWood,
       anchors.map(a => `${a.to}@${a.row},${a.col}`).join(' '));
    if (toTos && toWood) {
      ok('and they are DIFFERENT squares', toTos.row !== toWood.row || toTos.col !== toWood.col,
         `${toTos.row},${toTos.col} vs ${toWood.row},${toWood.col}`);
      // The conditions, asserted as the game states them rather than as the anchors
      // happen to have come out: a fix that moved both anchors to the same wrong side
      // would still satisfy "different" above if the two rooms swapped.
      ok('Main gate to the city of Tos is reached from row < 19', toTos.row < 19, `row ${toTos.row}`);
      ok('The Twisted Wood is reached from row > 20', toWood.row > 20, `row ${toWood.row}`);
    }
  }

  // The general property, over every room that has geometry. This is the one that would
  // have caught it without anybody knowing which wall to look at.
  let checked = 0, wrongRoom = 0, offBoundary = 0;
  const offenders = [];
  for (const room of Object.values(map.rooms)) {
    if (!room?.roo || room.rooDimensionMismatch) continue;
    let g = null;
    try { g = sharedRoomGeometry(room); } catch { continue; }
    if (!g?.collisionReady) continue;
    let anchors = [];
    try { anchors = exitAnchors(room, g); } catch { continue; }
    for (const a of anchors) {
      if (a.kind !== 'edge') continue;
      // A staging square inland of the wall is legitimate — the condition is evaluated
      // where you LEAVE from, so only a square actually on that boundary can be asked.
      const onBoundary = (a.dir === 'west' && a.col === 1) || (a.dir === 'east' && a.col === room.cols)
                      || (a.dir === 'north' && a.row === 1) || (a.dir === 'south' && a.row === room.rows);
      if (!onBoundary) { offBoundary++; continue; }
      const sel = selectedEdgeAt(room, a.dir, a);
      if (!sel) continue;
      checked++;
      if (Number(sel.to) !== Number(a.to)) {
        wrongRoom++;
        if (offenders.length < 6)
          offenders.push(`${room.num} ${a.dir} ${a.row},${a.col} baked->${a.to} fires->${sel.to}`);
      }
    }
  }
  ok(`crossing at an anchor fires the exit it was baked for (${checked} anchors)`,
     checked > 0 && wrongRoom === 0, offenders.join(' | ') || `${wrongRoom} wrong`);
  ok('and the check had real coverage rather than passing by finding nothing',
     checked >= 200, `${checked} on-boundary anchors, ${offBoundary} staged inland`);

  // CROSS-VALIDATION AGAINST REALITY, which is the only thing here that is not derived
  // from the same .roo the anchors came from. A walk log records the square a real client
  // last stood on and the room it turned up in; the model has to agree with both.
  const book = crossingBook();
  let agree = 0, disagree = 0;
  const contradictions = [];
  for (const key of Object.keys(book)) {
    const [from, to] = key.split('>').map(Number);
    const room = map.rooms[String(from)];
    if (!room?.roo) continue;
    for (const obs of book[key]) {
      for (const d of ['west', 'east', 'north', 'south']) {
        const on = (d === 'west' && obs.col === 1) || (d === 'east' && obs.col === room.cols)
                || (d === 'north' && obs.row === 1) || (d === 'south' && obs.row === room.rows);
        if (!on) continue;
        const sel = selectedEdgeAt(room, d, obs);
        if (!sel) continue;
        if (Number(sel.to) === to) agree++;
        else {
          disagree++;
          if (contradictions.length < 4)
            contradictions.push(`${from} ${d} ${obs.row},${obs.col} model->${sel.to} walked->${to}`);
        }
      }
    }
  }
  if (!agree && !disagree) skip('the condition model against recorded crossings', 'no crossing book');
  else ok(`the condition model reproduces every recorded crossing (${agree})`,
          disagree === 0, contradictions.join(' | '));
}

// ------------------------------------------- the grid is not the authority on standing
// THE SERVER ENFORCES NOTHING ABOUT WHERE A PLAYER STANDS. `UserMove` bypasses
// `ReqSomethingMoved` — room.kod's own comment is "already been checked by client (HAHA!)"
// — so `ROOM_FLAG_WALKABLE` is a server-side convenience that nothing consults when a
// person walks. The client's BSP is the only collision detector there is.
//
// Letting that grid veto a step the BSP allows deleted real ground, and it deleted it
// exactly where the rooms are tightest. A byte cannot describe a 1024-unit square that is
// 41% floor, and Western border of the Twisted Wood — 54.9% of its wall length not
// axis-aligned, a 1-2 square wide diagonal corridor — has 61 squares that are more than
// half floor and called wall.
//
// The failure was not "a step is refused". `buildStepMask` gated on `walkable` for the
// square being LEFT as well, so such a square carried a mask byte of ZERO: a character
// standing in one had no legal step in any direction, no route anywhere, and replanned for
// ever. On the board that reads as `travelling`, next to the door it is trying to use.
console.log('\nstandable — BSP floor, not the server grid');
if (!existsSync(movementMapFile())) {
  skip('standable never removes ground', 'no baked map');
} else {
  const map = loadMap();
  const rooms = Object.values(map.rooms).filter(r => r?.roo && !r.rooDimensionMismatch);

  // 1. IT CAN ONLY EVER ADD. The grid's yes is honoured unconditionally, so nothing that
  //    planned before can stop planning. This is the assertion that keeps the change safe
  //    in the restrictive direction, and it is checked over the whole world.
  let walkableSquares = 0, notStandable = 0, added = 0, checkedRooms = 0;
  for (const room of rooms) {
    let geo = null;
    try { geo = sharedRoomGeometry(room); } catch { continue; }
    if (!geo?.collisionReady) continue;
    checkedRooms++;
    for (let r = 1; r <= room.rows; r++)
      for (let c = 1; c <= room.cols; c++) {
        if (geo.walkable(r, c)) { walkableSquares++; if (!geo.standable(r, c)) notStandable++; }
        else if (geo.standable(r, c)) added++;
      }
  }
  ok(`every walkable square is standable (${walkableSquares} across ${checkedRooms} rooms)`,
     walkableSquares > 0 && notStandable === 0, `${notStandable} walkable squares went missing`);
  ok('and it genuinely adds ground rather than being a rename',
     added > 0, `${added} squares have BSP floor the coarse grid calls wall`);

  // 2. AND IT IS NOT "EVERYTHING". A predicate that answered yes everywhere would pass the
  //    assertion above and be worthless — worse, it would send the router into solid rock.
  {
    const room = map.rooms['587'];
    const geo = room?.roo ? sharedRoomGeometry(room) : null;
    if (!geo?.collisionReady) skip('Western border of the Twisted Wood', 'no geometry for 587');
    else {
      let stand = 0, total = 0;
      for (let r = 1; r <= room.rows; r++)
        for (let c = 1; c <= room.cols; c++) { total++; if (geo.standable(r, c)) stand++; }
      ok('most of a room is still NOT standable — this is not a blanket yes',
         stand < total * 0.75, `${stand}/${total} standable`);
    }
  }

  // 3. THE OPERATOR'S OWN EVIDENCE, and the only assertion here not derived from the same
  //    .roo as the predicate. A real client stood in every one of these squares; 137 of
  //    them are squares the coarse grid calls wall. If any is not standable, the predicate
  //    is still deleting ground somebody walks on.
  {
    const walksDir = WALKS_DIR;
    const byObj = new Map();
    for (const [n, r] of Object.entries(map.rooms)) if (r.objId) byObj.set(r.objId, n);
    let stood = 0, notStood = 0, gridSaidWall = 0;
    const offenders = [];
    if (existsSync(walksDir)) {
      for (const f of readdirSync(walksDir)) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of readFileSync(join(walksDir, f), 'utf8').split('\n')) {
          if (!line) continue;
          let p; try { p = JSON.parse(line); } catch { continue; }
          const num = byObj.get(p.room); if (!num) continue;
          const room = map.rooms[num];
          if (p.row < 1 || p.col < 1 || p.row > room.rows || p.col > room.cols) continue;
          let geo = null; try { geo = sharedRoomGeometry(room); } catch { continue; }
          if (!geo?.collisionReady) continue;
          stood++;
          if (!geo.walkable(p.row, p.col)) gridSaidWall++;
          if (!geo.standable(p.row, p.col)) {
            notStood++;
            if (offenders.length < 5) offenders.push(`${num} ${p.row},${p.col}`);
          }
        }
      }
    }
    if (!stood) skip('every square a person stood in is standable', 'no walk logs here');
    else {
      ok(`every square a real client stood in is standable (${stood} positions)`,
         notStood === 0, offenders.join(' '));
      ok('and the grid would have refused a real chunk of them',
         gridSaidWall > 0, `${gridSaidWall} of ${stood} are squares the coarse grid calls wall`);
    }
  }

  // 4. A MASK FROM THE OLD PREDICATE MUST NOT BE ATTACHED. The manifest hashes GEOMETRY and
  //    cannot see the predicate change, so without this a table baked by older code
  //    verifies perfectly and encodes the wrong doors — silently, which is the one outcome
  //    this repository keeps paying for.
  ok('a table stamped with an older step-mask predicate is refused',
     stepMaskCurrent({ stepMaskVersion: STEP_MASK_VERSION }) === true
     && stepMaskCurrent({ stepMaskVersion: STEP_MASK_VERSION - 1 }) === false
     && stepMaskCurrent({}) === false,
     'an unstamped table must read as v1, not as current');
}

// ------------------------------------------------ a loop is obvious once it is in space
// NOTHING SURPRISES A WALKER IN THIS GAME. The walls are in the .roo before anybody logs
// in and they are there tomorrow, so a route that leaves a square and comes back to it
// learned nothing in between — the whole detour is waste. That is trivial to see when the
// route is laid out in SPACE and nearly invisible while it is being lived one step at a
// time, which is how the fleet bounced `4,15 -> 5,15` / `5,15 -> 4,16` eight times and
// reported itself travelling throughout.
console.log('\nelideLoops — remove the round trips, never invent a step');
{
  const sq = (row, col) => ({ row, col });
  const path = a => a.map(([r, c]) => sq(r, c));
  const same = (a, b) => a.length === b.length &&
    a.every((p, i) => p.row === b[i].row && p.col === b[i].col);

  ok('a route with no repeat is returned unchanged',
     same(elideLoops(path([[1, 1], [1, 2], [1, 3]])), path([[1, 1], [1, 2], [1, 3]])));
  ok('an empty route survives', elideLoops([]).length === 0);
  ok('a null route is not a crash', elideLoops(null).length === 0);

  // The bounce, exactly as the trail recorded it.
  ok('a two-square bounce collapses to the square it never left',
     same(elideLoops(path([[4, 15], [5, 15], [4, 15], [5, 15], [4, 15], [4, 16]])),
          path([[4, 15], [4, 16]])));

  // A long excursion that returns is removed whole, and the step across the join is one
  // the route already contained — which is the entire safety argument.
  {
    const before = path([[1, 1], [1, 2], [2, 2], [3, 2], [2, 2], [1, 2], [1, 3]]);
    const after = elideLoops(before);
    ok('an excursion that comes back is removed down to the return point',
       same(after, path([[1, 1], [1, 2], [1, 3]])));
    const wasAdjacentInInput = after.every((p, i) => {
      if (!i) return true;
      const q = after[i - 1];
      for (let k = 1; k < before.length; k++)
        if (before[k - 1].row === q.row && before[k - 1].col === q.col
            && before[k].row === p.row && before[k].col === p.col) return true;
      return false;
    });
    ok('and every surviving step was a step the original route already made',
       wasAdjacentInInput);
    ok('it never returns more than it was given', after.length <= before.length);
  }

  // THE BREADCRUMB KEY, which is a different question and the one that can lose an escape.
  // A crumb chains `to` -> the next crumb's `from`, and the retreat drops a broken trail
  // WHOLE rather than skipping, so an elision that leaves the chain unjoined does not
  // shorten the escape — it deletes it.
  {
    const crumb = (fx, fy, tx, ty) => ({ roomId: 7, from: { x: fx, y: fy }, to: { x: tx, y: ty } });
    const trail = [crumb(0, 0, 10, 0), crumb(10, 0, 20, 0), crumb(20, 0, 10, 0),
                   crumb(10, 0, 30, 0)];
    const key = cr => `${cr.roomId}:${cr.to.x},${cr.to.y}`;
    const cut = elideLoops(trail, key);
    ok('a crumb trail that returns to the same POINT loses the round trip',
       cut.length === 2 && cut[0].to.x === 10 && cut[1].to.x === 30);
    let joins = true;
    for (let i = 1; i < cut.length; i++)
      if (cut[i].from.x !== cut[i - 1].to.x || cut[i].from.y !== cut[i - 1].to.y) joins = false;
    ok('and the surviving trail still chains end to end, exactly',
       joins, 'a broken chain is dropped whole by the retreat, so this must hold');
    ok('a trail with no repeated landing point is untouched',
       elideLoops([crumb(0, 0, 10, 0), crumb(10, 0, 20, 0)], key).length === 2);
  }
}


// ---------------------------------------------- the last step into the goal
// A PLAN WHOSE FINAL STEP THE MOVER REFUSES IS NOT A ROUTE, IT IS A LOOP.
//
// `neighbors` exempts the goal square from `moverStepLands` so that a doorway the model
// dislikes is never deleted from the map — 346 of the exit anchors this bake cannot reach
// are `go` exits whose square IS the door tile. That is right, and on its own it is also
// how a walker is handed a route it can never finish: A* sees all eight approaches to the
// goal as equal, takes the cheapest, and ends on a step the mover will not make. `walkTo`
// re-sends it, lands elsewhere, replans into the same corner, and reports "kept ending up
// somewhere other than the planned square".
//
// Measured live in Deep Forest of Farol: the exit square 2,30 is reachable from FIVE of
// its eight neighbours, the planner chose the one refused diagonal (3,29), and Delta stood
// 21 steps short of a door it could see. Asking strictly first found the same 12-step
// route approached from 3,30, every step walkable. Across the world: 21,348 anchor pairs,
// 2,323 unwalkable plans repaired, and ZERO routes lost.
//
// Both halves are pinned, because each fails in a different dangerous direction — dropping
// the strict pass brings the loop back, and dropping the fallback deletes doorways.
console.log('\nthe last step into the goal — strict first, exemption as a fallback');
{
  const mk = (refuse) => {
    const g = RoomGeometry.fromJSON({
      rows: 4, cols: 4,
      flags: new Array(16).fill(1),
      grid: new Array(16).fill(0xff),
      moveGrid: new Array(16).fill(0xff),
    });
    g.standable = (r, c) => r >= 1 && r <= 4 && c >= 1 && c <= 4;
    g.moverStepLands = (fr, fc, tr, tc) => !refuse.has(`${fr},${fc}>${tr},${tc}`);
    return g;
  };
  const GOAL = '1,2';
  // Every approach to the goal is refused EXCEPT straight north from 2,2.
  const onlyNorth = new Set();
  for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++)
    if (`${r},${c}` !== '2,2') onlyNorth.add(`${r},${c}>${GOAL}`);

  const g1 = mk(onlyNorth);
  const p1 = g1.path(4, 4, 1, 2, { collision: true });
  const lastFrom1 = p1.steps && p1.steps.length > 1
    ? p1.steps[p1.steps.length - 2] : { row: 4, col: 4 };
  ok('it plans a route to the goal', p1.found === true);
  ok('and approaches it from the one square the mover accepts',
     lastFrom1.row === 2 && lastFrom1.col === 2,
     `approached from ${lastFrom1.row},${lastFrom1.col}`);
  ok('so no planned step is one the mover refuses',
     (p1.steps || []).every((st, i) => {
       const prev = i ? p1.steps[i - 1] : { row: 4, col: 4 };
       return g1.moverStepLands(prev.row, prev.col, st.row, st.col);
     }));
  ok('and it does not report itself as having used the exemption',
     p1.goal_exempt === undefined);

  // NOW THE FALLBACK: refuse EVERY approach. The doorway must not disappear.
  const all = new Set();
  for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) all.add(`${r},${c}>${GOAL}`);
  const g2 = mk(all);
  const p2 = g2.path(4, 4, 1, 2, { collision: true });
  ok('a goal no approach can reach is STILL routed to — a bake never deletes a doorway',
     p2.found === true, 'this is the half that keeps `go` exits usable');
  ok('and it says so, so a caller can make a fine-positioned correction',
     p2.goal_exempt === true);
  ok('an ordinary goal is unaffected by either pass',
     g2.path(4, 4, 3, 3, { collision: true }).found === true);
}

// The measured case, on the real bake — skipped rather than silently passed without one.
{
  const realMap = existsSync(join('substrate', 'm59-map.json')) ? await loadMap() : null;
  // The masks are what `path` plans on; without attaching them this asserts nothing.
  if (realMap) attachStepMasks(realMap, {});
  const raw556 = realMap?.rooms?.['556'] ?? realMap?.rooms?.[556];
  const g556 = raw556 ? sharedRoomGeometry(raw556) : null;
  if (!g556?.hasStepMask) {
    skip('Deep Forest of Farol plans a walkable last step into its 545 exit',
         'no baked step mask on disk — run tools/m59-routebake.mjs');
  } else {
    const p = g556.path(12, 35, 2, 30);
    let refused = 0, prev = { row: 12, col: 35 };
    for (const st of (p.steps || [])) {
      if (!st.recovered && !g556.moverStepLands(prev.row, prev.col, st.row, st.col)) refused++;
      prev = st;
    }
    ok('Deep Forest of Farol still reaches its 545 exit square', p.found === true);
    ok('and every step of that plan is one the mover will actually make', refused === 0,
       `${refused} refused — this is the walk that stalled Delta 21 steps from the door`);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
