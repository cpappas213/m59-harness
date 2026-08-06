# Plan: move on the real geometry

Written 2026-08-06. This is the working plan for replacing grid-stepping with movement
against the game's own `.roo` geometry. It is meant to be picked up cold — start here.

## The premise, in one line

**We are the client, and the client is the collision detector.** Everything slow or wrong
about our movement is self-imposed.

`UserMove` (`user.kod:2914`) does exactly three things: bumps a speedhack counter that only
writes a log line, snaps you back if `speed > USER_WALKING_SPEED` while vigor is under
`VIGOR_RUN_THRESHOLD`, and snaps you back if `PFLAG_NO_MOVE`. **There is no geometry check.**
`ReqSomethingMoved` is bypassed for users; `room.kod`'s comment is *"already been checked by
client (HAHA!)"*.

So the `.roo` is authoritative not because the server makes us obey it, but because we
choose to be a legitimate client. **We could walk through walls and nothing would stop us.
We must not.** This is a shared server with real people on it; clipping through geometry is
cheating whether or not anything refuses it. Anyone reading "the server doesn't check" as
permission has misread this document.

## Why speed is the point

Measured 2026-08-06, operator vs fleet in the same room (`docs/m59-movement-parity.md`):

| | speed | crossing room 535 (~68 squares) |
|---|---|---|
| operator, unimpeded | **4.1 sq/s** | 17s |
| fleet, before | 0.55 sq/s | 124s |
| fleet, after the resync cap | 1.18 sq/s | 58s |

The speedhack comment gives away the real client's shape: *"Normal players only send 1
movement packet per second."* The operator's position arrives in **~4.5-square strides**. So
a real client sends **~1 packet/second covering several squares**; we send **~4 packets/second
covering one square each**. More packets, less ground.

**For travel, speed IS the safety mechanism.** New players sprint the Badlands *because*
they are scared. Our harness has this backwards — it treats slow and careful as safe, which
is true when fighting from a wall and exactly wrong when crossing ground. Our own data: 20
deaths at "The border of the Badlands", 17 of the last 23 travel deaths outbound to a
hunting ground. A character that crosses in 17s instead of 124s stands next to a seventh as
many things.

## What a "safe wall" actually is, mechanically

Worth stating because it is not obvious and the routing has to know it.

It is **an asymmetry in who checks line of sight.**

- `Monster.CanReach` calls `Room.LineOfSight` (`monster.kod:1782`).
- `Player.TargetWithinSightAndRange` (`player.kod:4115`) checks range and a facing cone and
  **never calls it**.

So a square whose line to a patch of floor is *broken*, while that floor is still inside
your weapon range, lets you hit what stands there and take nothing back. Melee range is a
disc: `SquaredDistanceTo <= GetAttackRange^2` on **square** coordinates
(`nomoveon.kod:121`), radius 2–3. Fine coordinates are not read by anything that hits you —
the only consumer of `piFine_row`/`piFine_col` in the tree is `MonsterOrient`, choosing a
drawing angle.

Exceptions: lich and revenant carry `AI_FIGHT_THROUGH_WALLS`.

This is why safe walls are a *geometry* fact and belong in this work rather than beside it.

## The operator's model of how the game is actually played

Two safety mechanisms, and we currently implement half of one:

1. **Speed.** Run everywhere at full pace.
2. **Safe walls as waypoints.** Memorise where they are per area. When injured, run to the
   nearest one, rest to full there, optionally pop offline/online to shed anything with more
   than one attacker on it, then run at full speed to either the next safe wall or the zone
   exit — routing a path and dodging walls on the way.

So a route is not "shortest path to the destination". It is **a chain of safe-wall waypoints
with full-speed runs between them**, chosen so no leg is longer than the character can
survive at speed.

## What we already have

- **`tools/m59-roo.mjs` parses the walls.** `parseRooWalls` reads sidedefs and walls from the
  client section, faithful to `clientd3d/bspload.c LoadWalls`. Wall flags (`WF`), drawable /
  passable / map-never classification, `renderWalls`. **This is the thing we need and it is
  already on disk.**
- The coarse grid (`flags[rows][cols]`, bit 0 = floor) and `monsterGrid`.
- `path()` — grid A*. **This is what routing uses today and it is the lossy layer.**
- `monsterCanReach` / LOS, used by the safe-spot book.
- `substrate/m59-safespots.json` — the learned safe-wall side-car.
- `tools/m59-transits.mjs`, `m59-hits.mjs`, `m59-watch.mjs` — the measurement harness, so
  every step of this is verifiable against a human baseline.

## What we do NOT yet have — check first

- **Sector heights.** `parseRooWalls` reads `sectorOff` but does not appear to build sectors.
  The `.roo` is DOOM-shaped: a height-relief map, with a maximum Z step a character can climb
  for stairs and cliffs. **Task 0 is to confirm whether heights are parsed, and parse them if
  not** — without them a ray can be clipped by a wall it could actually walk over, and stairs
  will read as obstacles.
- **BSP nodes.** `nodeOff` is read; the tree is probably not built. A ray cast against a flat
  wall list is O(walls) and fine for one room; the tree only matters if that turns out slow.
- **The kod constant for max climb height.** Not yet located. Find it before writing the Z
  check rather than guessing a number.

## The work, in order

### 0. Confirm the geometry we hold — DONE 2026-08-06, and it corrected this plan twice

Parsed. `tools/m59-roo.mjs` now builds sectors, and `tools/m59-roo-test.mjs` (42) pins it.
Three things came back different from what this section predicted, and they are written
here rather than edited away because two of them change what task 1 has to do.

**Heights were absent, as suspected.** `sectorOff` was read and dropped. Now
`parseRooSectors` walks it and `setWallHeights` puts `z0..z3` on every wall, faithful to
`bspload.c SetWallHeights`. All 266 rooms parse; 80 have sloped sectors and 66 have wading.

**The sector record is variable-length, which is the trap in this format.** A 46-byte
slope block is appended INLINE per sector for a sloped floor and again for a sloped
ceiling, inside the same loop. Anything assuming a stride is correct until the first
sloped sector and garbage after it — and since a room is either flat or not, testing on a
flat room proves nothing. The stride is verified across the whole tree: every one of the
80 sloped rooms ends at the same offset relative to the server section as the flat ones.

**The max-climb constant is NOT IN kod.** It is `clientd3d/move.c:55` —
`MAX_STEP_HEIGHT (HeightKodToClient(24))`, 24 kod units, 384 client units. Looking for it
in kod was the wrong instinct and it follows from this document's own premise: `UserMove`
does no geometry, so the step limit only ever needed to exist in the collision detector,
and the collision detector is the client. If we do not enforce 24, then for us it does
not exist.

**And a passable wall is not a crossable wall.** `move.c:551` is a three-part AND — the
step up must be within `MAX_STEP_HEIGHT`, there must be `player.height` of headroom, AND
the sidedef must be `WF_PASSABLE`. This repository treated the third as the whole test.
That is exactly how the format tells a staircase from a cliff, so `canCrossWall` now does
all three.

#### The Limping Toad was the wrong counter-example, and the right one

The claim above — that its stranded squares would turn out to be a height problem — is
**false**. Measured: 47 of 135 walkable squares are unreachable from the middle under the
coarse grid (not 76; that figure is unsourced and should be dropped). But the boundary
that strands them, the col 12|13 edge at row 5, has floors at **3200 on both sides, dead
level**. Heights change nothing there.

What actually strands them is a wall covering `y 4096..4608` — **exactly half of one
square's edge**. The `.roo` carries movement as one byte per square, so "half of this
edge is blocked" has nowhere to live and the whole edge reads as blocked.

So the room is a perfectly good acceptance test, just for **task 1 rather than task 0**:
it is a fine-coordinate problem and the raycast is what recovers those squares. The
heights are still worth having on their own merits — this room has a raised area with 10
genuinely climbable steps and 27 genuine cliffs — but they were never this bug.

### 1. Raycast — and the acceptance test is the Brownestone Inn, not the Toad

Found 2026-08-06 while clearing the `cant_go` failures, and it is a much better test than
the Limping Toad because a character is **actually stuck in it right now**.

Camilla sits in the Brownestone Inn (`barinn.roo`, room 106) and cannot leave. The exit to
North Barloque has `stand_on` = (12,17). **The entire row 17 is walkable floor and entirely
unreachable in the coarse grid** — 37 of 198 walkable squares are cut off, and they are the
doorway. Every `go` answers "You are unable to go anywhere." because
`Room.SomethingTryGo` matches on the server's `piRow`, and we are on row 16.

The real geometry says the crossing is legal. The wall on that boundary
(`x 10752..12800, y 16384`) is:

| | |
|---|---|
| `WF_PASSABLE` | yes |
| step, `z1 - z0` | **256** — against `MAX_STEP_HEIGHT` 384 |
| headroom, `z2 - z0` | **1472** — against `player.height` 768 |

`canCrossWall` returns **true from both sides**. It is a doorway with a low step, exactly
the thing the height parse was built to recognise, and a real client walks over it without
noticing. What blocks us is our own one-byte-per-square projection, which has nowhere to
record "there is a 16-unit step here" and so records "no".

**So this is not a wall we would be clipping through — it is a step we are refusing to
take.** That distinction is the whole reason task 0 had to come first, and it is the
difference between the fix being legitimate and being cheating.

The test for task 1: Camilla leaves the Brownestone Inn. The existing `stepFine` is
probably most of the machinery; what it lacked was any way to know the step was climbable.

### 1a. Raycast: "move as far along this heading as I can"
Against the wall segments, in fine coordinates (`KOD_FINENESS` = 64/square; the client's own
is `CLIENT_FINENESS` = 1024 — mind the conversion). Clip at the first intersection, respect
the Z step limit. Returns a point, not a square. This is the primitive everything else sits
on, and it is the direct answer to "why isn't it just pythagoras".

### 2. Visibility-graph routing
Nodes are wall-segment corners (inset by the character's radius) plus start and goal. An
edge exists where the straight line between two nodes clears geometry — which is task 1 with
a target instead of a heading. Then Dijkstra. This replaces `path()`'s grid A* for movement.

Keep the grid: it is still the right structure for "is there floor here" and for the
safe-spot search. It stops being the thing we route on.

### 3. One packet per second, covering real distance — SHIPPED 2026-08-06, partially

Done without the raycast, by coalescing **collinear** runs of the existing grid route into
one packet, capped at 8 squares, paced by distance at the client's own rate. Collinear
only: every square skipped is a square the router already accepted, so the line we skip
along is the line we planned. Coalescing across a turn would cut the corner — through
whatever the turn was avoiding — and that is the one way this could put a character
through a wall on purpose. Task 1 replaces the route underneath; the packet shape is
already right.

**The numbers, all from the client rather than guessed** (`move.c:184`, `:49`, `:53`,
`draw3d.h:53`): `MOVEUNITS` is `FINENESS>>2` = 256 client units, doubled for a *FAST
action, per `MOVE_DELAY` = 100ms. So **running is 5.0 squares/second** and walking 2.5,
and `MOVE_INTERVAL` = 1000ms is how often it tells the server. One packet, five squares.

**We were sending one square per packet at four packets a second** — more packets than a
person, less ground, and permanently over the speedhack counter (`piMovesCounter` grows
by one per packet and decays one per second against a threshold of 2, so any sustained
rate above 1/s trips it). It only writes a log line, but it writes it on a shared server
under our own account names, which is not a thing to leave running.

**The hop cap is a real rule, not taste.** `user.kod:3072` logs a suspected teleport and
**drains vigor as a penalty** when squared distance from the last second-boundary reaches
200 with under 3 seconds elapsed — about 14 squares. A second of running is 5, squared
25. Eight squares is 64. Both are comfortably inside it.

### 3a. We were not running, and the reason was a mispriced resource

`moveSpeed()` sent the run speed only in rooms the spawn index called dangerous, and
walked everywhere else. The spawn index describes where we go to **fight**; it says
nothing about the ground between, and the ground between is where this fleet dies — 20
deaths at the border of the Badlands, 17 of the last 23 travel deaths outbound.

The saving was never priced. Exertion is charged once per second as
`EXERTION_PER_MOVE * (speed*5/6)^2` with `EXERTION_PER_MOVE = 2` (`user.kod:26`, `:3020`),
and `necroam.kod:518` gives the scale — 20000 units commented as "2 vigor points", so
10000 units is one point:

| | exertion/s | vigor/s | a full minute of it |
|---|---|---|---|
| walking, speed 18 | 450 | 0.045 | 2.7 vigor |
| running, speed 36 | 1800 | 0.18 | **11 vigor** |

Eleven vigor for a minute of sprinting, against a death that costs the character its
equipment, its position and the rest of the hour. So the gate is now affordability rather
than location: run everywhere, floor at 25 vigor so arriving still leaves enough to fight.

Also: the speed we sent when we did run was **24**, which is not a number any client
emits. `USER_RUNNING_SPEED` is 36 (`user.kod:47`). Now 36.

**One thing this does NOT fix, and it must not be read as fixing:** the `speed` byte does
not make anybody move faster. The server never moves you — you tell it where you are, and
that field only picks the snap-back check, the exertion rate, and the animation other
clients draw. Distance per packet is the only thing that is actually speed.

### 4. Safe walls as waypoints
Route as a chain: current position → safe wall → safe wall → zone exit, full speed between.
Consult `m59-safespots.json` during routing rather than only when already hurt. Keep it a
**side-car, not baked into the `.roo`** — the `.roo` is the game's file and should stay
droppable-in on an update, and our safe-spot data is learned and falsifiable (a square that
gets someone killed is retired), so it wants its own lifecycle.

### 5. Re-measure against the human baseline
`node tools/m59-watch.mjs --who <operator> --room 535`, same room, same method. Target is
4.1 sq/s. `m59-transits.mjs` gives the fleet-wide before/after.

## Open bug, must fix regardless — and it is cheap

**`PFLAG_NO_MOVE` is set by `IsResting`** (`player.kod:1162`). **A seated character cannot
`go`.** `UserGo` (`user.kod:5657`) returns `user_cant_go` — *"You are unable to go
anywhere."* — for exactly two reasons: that flag (or Blind), or the room refusing `go` from
the square **the server thinks you are on** (`#row=piRow, #col=piCol, ...`).

That message is **589 of our 700 failed hops.** Two distinct causes, needing opposite fixes:

- **We are sitting down.** At least one path sits without standing: the unarmed branch's
  "sitting down anywhere to regain mana" issues `rest()` and holds it 60s. **Stand before
  `go`.** Trivial, and worth doing whatever else happens.
- **We are not where we think we are.** `SomethingTryGo` reads the server's position, so a
  predicted square we did not reach produces this. Introduced by the resync cap: cant-go went
  **36% → 52% of all crossings** after it shipped (1379 records before, 204 after). The fix
  is to confirm position once *before crossing out of a room*, not once per square — one read
  per hop, keeping nearly all of the speed win.

Task 1–3 make this mostly moot, since a raycast move lands where geometry says it lands. But
the `stand()` fix should go in immediately and independently.

## Standing constraints

- **Never abort travel on damage.** There is no safe travel in this game; human players die
  crossing the world constantly and it is expected to get more dangerous. Damage in transit
  is normal. It is minimised by speed, evasion and route choice — never by stopping.
- **Never walk through walls on purpose**, per the top of this document — and the
  operator has since drawn the line more precisely than "never", which matters because
  the strict reading would make task 2 refuse legal routes.

  The rule is *don't try to cheat*, not *be provably flush with every surface*. Real
  clients clip a few fine units through a protruding edge under lag and nobody can tell
  that from intent. So: clipping a corner by one to three fine units is not worth
  contorting a route to avoid, and the inset for the visibility graph should aim at the
  **closest legal point on the edge** rather than a conservative radius that walls off
  ground a person would walk. `min_distance` is `player.width/2` = 248 client units
  (`move.c:122`), which is what the real client keeps off a wall — match it, do not
  inflate it.

  What stays absolutely out: crossing a boundary we know is shut to get somewhere we
  could not otherwise reach. Walking into a guild hall through its wall is cheating at
  any tolerance. Following someone in through the door and taking what is lying there is
  the game.
- The fleet is live on a shared server. Roll out with `m59-service.mjs restart --fleet prod`
  and re-measure; do not scale up traffic without being asked.
