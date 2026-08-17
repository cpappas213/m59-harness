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

import { existsSync } from 'node:fs';
import { RoomGeometry, protocolToward, STEP_MASK_DIRS, KOD_FINENESS, CLIENT_FINENESS,
         sharedRoomGeometry } from './m59-roo.mjs';
import { components, exitAnchors } from './m59-routebake.mjs';
import { loadMap, selectedEdgeAt } from './m59-map.mjs';
import { crossingBook } from './m59-crossings.mjs';

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
    ok('and it refuses only a small minority of them',
       moverRefused / pairs < 0.05, `${(100 * moverRefused / pairs).toFixed(1)}%`);

    const comp = components(geo, { collision: true });
    const biggest = Math.max(...comp.sizes);
    const walkable = comp.sizes.reduce((n, s) => n + s, 0);
    ok('most of the room is one body of floor under the mover view',
       biggest / walkable > 0.6, `${biggest}/${walkable} in ${comp.count} region(s)`);
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
    ok('and on the Cragged Mountains the body reaches every exit that is not blink-only',
       reach(chosen) === 3,
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
        if (masked.inBounds(r, c) && masked.walkable(r, c)
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

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
