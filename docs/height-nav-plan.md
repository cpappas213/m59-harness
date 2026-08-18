# Height-Aware Navigation

## Problem
Characters get stuck or die because navigation ignores the height dimension:
- Fine-grid collision lets a character stand where the coarse grid says "wall" (Kage stuck at (8,35))
- Characters can walk off ledges/cliffs and can't climb back up (death vector)
- Safe spots at ledge edges are dangerous
- Fleeing across a drop = death

## Data Source
`.roo` BSP tree: each **leaf** has a 2D convex `polygon` (fine units, 1024/cell)
and a `sectorNum` → `sector.floorHeight`. A cell's floor height = the height of the
leaf whose polygon contains the cell center.

Verified: KA1.roo (79x62=4898 cells, 751 leaves) → 4895 resolved, 16 unique heights,
build time ~30ms. Heights in units of 1024 (1.0 = one step).

## Rules
- **Climbable**: |h2 - h1| <= 1.0 (one step up or down) — allowed
- **Drop/ledge**: h1 > h2 + 1.0 (falling) — BLOCKED (refuse to walk)
- **Wall up**: h2 > h1 + 1.0 (stepping up a ledge) — BLOCKED
- Stairs (if flagged) would override, but we don't detect them yet → treat all
  >1.0 changes as blocked. This is the safe default.

## Tasks
1. [ ] `buildHeightMap(geo)` in m59-roo.mjs: cell → floorHeight (BSP point-in-poly).
      Export alongside walkability. Cache per room like the grid.
2. [x] Add `heights` to heroSnapshot room_view (packed array in cells + min/max).
      Resolves .roo by live id OR room name (live ids don't match map ids).
3. [x] 3D view: per-cell floor slabs tinted by elevation + cliff side faces; walls,
      wall-segs, entities, character all sit at their local floor height.
4. [x] Safe spots: -50 score penalty for ledge-edge cells. Verified: a top-tier (64)
      clifftop corner is demoted to rank 400+.
5. [x] Pathfinding (scavenge wander): walk cell-by-cell, stop at first wall/void/ledge
      via geo.heightStepOk. Extracted to tools/m59-wander.mjs (kept out of m59-act/ so
      the act-test's loop + one-atomic-per-file rules hold).
6. [x] Tests: m59-roo-test height section (flat single height, multi-level ledges, void
      step illegal). 79 passed.
7. [x] Restart broker; Kage's room (Valley of Ileria) renders 11 height levels,
      HMIN=2 HMAX=4.25, HEIGHTS length == cols*rows.

## Files
- tools/m59-roo.mjs          — floorHeightAtCell / heightMap / heightStepOk
- tools/m59-broker.mjs        — _geo resolver + heights in room_view
- tools/m59-room3d.mjs        — render height (slabs, cliffs, entities at floor height)
- tools/m59-safespots.mjs     — ledge-edge score penalty
- tools/m59-wander.mjs        — height-gated wander (scavenge calls it)
- tools/m59-roo-test.mjs      — height map + step tests

## Status: DONE. All touched suites green (roo 821, safespot 141, act 270, goap 18).
Pre-existing broken tests (keeper-bt 6, bt-provision 3, takesafespot 8) confirmed
failing on baseline too — unrelated to this work.

## Follow-up: fine-grid vs coarse-grid mismatch = asymmetric safe spots

The coarse grid is a coarser approximation of the wall segments. A cell the coarse grid
calls WALL but the fine grid is open in is a one-way safe spot: the player (fine-grid,
any direction) can stand there, but a monster (NSEW on the coarse grid) cannot step in.

  m59-roo.mjs
    RoomGeometry.fineWalkable(r, c) — point-in-wall-segment test (the ground-truth
    collision), returns true/false/null.
    RoomGeometry.hiddenCells() — interior cells where walkable=false but
    fineWalkable=true, height-checked reachable from a coarse-walkable neighbour.
    Valley of Ileria (d4.roo) has 246 such cells; flat Deep Woods (c4) has 0.

  m59-broker.mjs
    room_view.hidden = [[c, r], ...] — the asymmetric safe cells, resolved + cached
    the same way as heights.

  m59-room3d.mjs
    Renders hidden cells as gold floor tiles + a "N hidden" count in the HUD so a
    farming spot is visible at a glance. Live-verified: Kage's room shows 25.

## Notes
- Height only matters for multi-level rooms. Flat rooms (Deep Woods) are all one
  height → no behavior change, safe to ship.
- Don't need live Z from the client (move packet has no Z) — height is a pure
  function of (room, col, row).
- Keep coarse grid as the primary walkability; height is an ADDITIONAL gate on top.
