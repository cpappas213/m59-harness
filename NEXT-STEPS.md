> **CORRECTION, 2026-08-17 — THE PREMISE OF THIS DOCUMENT IS AN OFF-BY-ONE IN THE
> ANALYSIS SCRIPT, NOT A DEFECT IN THE FLOOR MODEL. Do not start the work below.**
>
> A recorded walk position is in KOD units (64 to the square); `floorBaseAtClient` wants
> client units (1024). The obvious conversion is `x * 16`, and it is wrong by exactly one
> square in both axes: `protocolToClient` is `(x - 64) * 16`, because the wire is 1-based
> and the leaves are 0-based.
>
> Re-measured with `protocolToClient`, over every walk log on this machine:
>
> | | hand conversion `x*16` | `protocolToClient` |
> |---|---|---|
> | all rooms, in-bounds recorded positions | 479 of 2084 have no floor (23.0%) | **0 of 2092 (0.00%)** |
> | room 579, the walk cited below | 37 of 206 | **0 of 206** |
>
> An offset sweep settles it rather than argues it: dx=dy=-1024 takes the count to exactly
> zero, and no other offset comes close. Ten of the twelve squares named below are already
> walkable in our own grid.
>
> It was convincing for the same reason it was wrong. **A whole-map coordinate error looks
> like a local geometry defect**, because it fails hardest exactly where the geometry is
> tightest — a one-square error in open ground still lands on floor, so the failures
> cluster in the narrow corridors where the fleet genuinely does get stuck. It survived a
> distance-to-nearest-leaf histogram (48% more than half a square from any polygon, 0%
> exactly on an edge, so it did not look like an epsilon bug) and a per-room coverage count
> before the offset sweep caught it.
>
> What survives from below, and is worth keeping: the **exit aperture / one-square
> contention** observation (`spreadEdges` has nothing to spread when an opening publishes
> one square), the **two-agents-one-fleet** gap (`m59-dm.mjs relocate` bypasses the
> broker's `claim`/`busy` model), and the **one-way overland link** question. Those do not
> depend on the floor model.
>
> The `walked` layer in `m59-overlay.mjs` is now the standing guard for this: it paints a
> square only when a person was recorded standing where we model void, and it is supposed
> to stay blank.

# NEXT STEPS — the floor model is missing real standable ground

**Status: diagnosed, reproducible, not started.**

This is one defect. It has been showing up as three or four unrelated-looking bugs for
long enough that each was worked on separately, and the boundary-crossing fixes in
`5421a69` treated two of its symptoms without touching it.

## What is wrong

`RoomGeometry.floorBaseAtClient` returns nothing — or the wrong thing — for a large
amount of ground that players demonstrably stand on. It is worst on **vertical
structure**: wall crests, ledges, and the approaches to map boundaries.

The evidence is a recorded human walk, `substrate/walks/walk-2026-08-17T18-40-23-428Z.jsonl`
— 156 positions, room 579 *An ancient place, its origin forgotten*, an operator walking
the wall-climb and drop-jump route to the mana node, three times.

**19 of those 156 positions have no floor under them in our model.** A person was
standing on every one.

    30,40  30,41  30,42  30,43  30,45  30,46  30,48      <- seven, one continuous wall
    40,34  40,36  40,38
    32,52  54,44

Column 30 across rows 40–48 is a continuous stretch of wall that we model as void.

## The three symptoms it has been mistaken for

| looks like | actually |
|---|---|
| `start_has_no_floor` — 14 of 50 failures on one boundary leg | the character is standing on ground we do not have |
| edge openings drawn far too narrow | the opening scan finds only the samples that pass a floor test the floor test gets wrong |
| the planner will not route a drop-jump | there is nothing to plan a jump *to* — the landing surface is missing |

The second one is measured. The operator confirmed in game that **554 west → 544 is the
regular exit everyone uses**; our scan calls that opening `[[400,432]]` — 33 fine units,
**0.52 squares**, narrower than a player's body. And `587 west → 576`, which the operator
describes as "an open little corridor", scans as 1.05 squares across three spans, two of
which are a single 16-unit sample.

So the rule that came out of the survey is:

> **Zero openings is a fact. A nonzero width is a floor, not a measurement.**

`574 north → 563` scans as zero and the operator confirms there is no entrance — you go
via 564. That is the one case a conservative scan gets exactly right, and it is already
used correctly: `edgeCandidatesOf` drops such an edge before route search sees it, which
is why `findPath(574 → 563)` routes via 564 rather than grinding at the wall.

## It also puts the whole fleet on one square

Observed live, three characters at the west wall of 587:

    Alpha    at 2,5          west exit stand_on: {col: 2, row: 5}
    Bravo    at 2,5          alternates:          2,5 | 2,5 | 2,5
    Charlie  at 2,4

`spreadEdges` exists to hand each character a DIFFERENT crossing square — its own comment
is *"Without it this tried the nearest square and called the whole wall refused"* — and a
one-square opening leaves it nothing to spread. Every character routed through that wall
is sent to the same square, and the published alternates are three copies of it.

The operator's name for what this looks like from inside the game is a **midwestern
stand-off**: two people each politely stepping aside, in step, and blocking each other
for it. The shape is right and the mechanism is not, which is worth writing down so
nobody fixes the wrong thing: **players do not block each other here.**
`blocksMovement` is `moveOn(flags) === MOVEON.NO`, and Alpha and Bravo were sharing
square (2,5) at distance 0 while it was happening. So this is contention for one
published target, not collision — a queue, not a deadlock.

Widening the opening fixes it for free, because `spreadEdges` already does the right
thing the moment it has more than one square to work with. `max_bots_per_safe_spot`
exists for the same problem on safe spots; there is no equivalent for exit apertures and
there should not need to be one.

## Why this is worth doing before anything else

Everything downstream is built on the floor model:

* **Travel.** After `5421a69` the 587→576 leg crosses 20/20, but 17 of those 20 still had
  to try up to four candidate squares first, and the median hop is 150s against a 20s best
  case. The crossing is fixed; the *aim* is not, and the aim is this.
* **Safe spots.** A safe spot IS the coarse grid and the BSP disagreeing. A floor model
  that invents void changes which squares qualify.
* **Anywhere a bot cannot go that a player can.** Castle Victoria and the 579 mana node
  both need drop-jump chains. Neither is reachable, and the reason is not the jump.

## What the fix has to satisfy

The walk log is the test. Any change must make **all 19 of those positions standable**,
and must not make previously-refused geometry passable — `m59-collision-test.mjs` (153)
is the guard for that half, and it must stay green.

Re-running the same trace through `floorBaseAtClient` after a change gives an immediate
pass/fail, and the boundary legs give a second measure: `substrate/transits/` already
holds the before (6/56 = 11%) and after (20/20) for 587→576, so a third number after a
floor fix says whether the aim improved.

## What is NOT the problem

Ruled out with evidence, so nobody repeats the work:

* **Not the map's declared exits.** Confirmed against the operator's own knowledge of the
  world on three boundaries.
* **Not the server.** `UserMove` bypasses `ReqSomethingMoved` for players — room.kod's own
  comment is *"already been checked by client (HAHA!)"* — so there is no server-side
  geometry validation on a player move at all. We are the only collision detector, which
  is exactly why our being wrong costs so much.
* **Not the z-carry.** `motionZ` already keeps a body's height across a dip rather than
  dropping it to the floor (`zMin = max(supplied, floor)`), and there are tests for it.
  Its real limits are that the carry expires with `collisionVertical`'s settle window
  (≤5s) and that the *planner* never proposes a drop in the first place. Worth revisiting
  AFTER the floor model, not before.
* **Not running jumps.** Confirmed by the operator: the game has no jump that gains
  height. Every gain in that route is a climb or a controlled fall.

## Open, and cheap to answer if it comes up

* The southeast corner of 579 — a `relocate` to (52,72) snapped **11.3 squares** to
  (44,64), so we believe the whole corner is void. Unverified; likely the same defect.
* **Two agents can drive one fleet with nothing arbitrating them.** This was not
  hypothetical: while writing this, another session was relocating Alpha, Bravo and
  Charlie through the 587 seam using `m59-dm.mjs relocate`, and nothing told either of us.
  The broker HAS an ownership model for exactly this — `autopilot claim`, `busy`,
  `isTakeable` — and the DM socket bypasses all of it, because it talks to the server
  rather than to the broker. `relocate` should probably refuse, or at least warn, when the
  broker reports a character held or busy. The tool is one day old and this is its first
  real design gap.
* One-way overland links. `589 → 599 → 598` is westward-only in the real game. The
  geometry already catches the `599 → 598` half (0 routable crossing squares) and misses
  the `589 → 599` half (4). There is nowhere to record a known one-way DECLARED edge —
  `substrate/m59-badexits.json` is only ever written by `forgetInferredExit`, for inferred
  reverse edges. Worth a home if more turn up; the operator could not think of others.
