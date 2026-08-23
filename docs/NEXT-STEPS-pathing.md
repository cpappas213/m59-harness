# NEXT STEPS — the safe-spot pocket trap

**Status 2026-08-16 (second pass): the escape is built and pinned offline. NOT YET RUN
AGAINST A LIVE FLEET.** The prod fleet is still deliberately stopped. What has changed is
that the fault now has a fix with a test behind it; what has not changed is that nobody
has watched a character walk out of room 587.

Everything below was established by measurement or by watching a character in the client;
where something is inference it says so.

---

## The fault, in one paragraph

The safe-spot chooser parks characters on squares the **collision view** considers
unreachable. Those squares are not an accident — a safe wall *is* the coarse grid and the
BSP disagreeing, which is exactly what makes it safe, and the fleet seeks them out. Since
the routing work made the router plan on that same collision view
(`attachStepMasks`, *"the one call that changes how the fleet walks"*), a character on such
a square **cannot plan a route out**. It tries, is refused, replans, tries again, forever.
The keeper pass never returns, so the board reports `travelling` while the character stands
in a corner twitching.

Confirmed in the client 2026-08-16: TESTER in room 587, *"jiggling in the corner… like a
person pretending to get stuck trying to find their way out the door right next to it."*

`node tools/m59-routes.mjs --room 587` — **68 regions, and both exits are in region 0.**
Anything standing in the other 67 is walled in as far as the router is concerned. There are
**17,402 such pockets world-wide**, and `m59-routes.mjs` already calls them
"the safe-spot candidates".

## Why it looked like everything else first

Two full wrong diagnoses, both worth knowing so they are not repeated:

1. **"Another machine is holding the fleet."** 86 log lines reading
   `dropped again 0s after rejoining — something else may be holding this character`.
   That message is an **inference** of contention, not an observation of one, and a
   saturated event loop produces the identical symptom. Disproved by logging in one
   character by hand: it held 90s clean, which is impossible if something else is bumping it.
2. **"Travel is slow / the character is frozen."** `watchdog.blocked_now_ms` climbing to
   1090s with `passes: 0` reads as *frozen*. The character was in fact frantically busy.
   **A CPU profile is structurally blind to this** — the flailing is cheap, ~38% CPU — and
   an idle-looking `await` is exactly what a profiler cannot see.

The instrument that finally separated them was a human looking at the screen. Ten minutes
of that beat hours of telemetry, because every wrong hypothesis predicted the same numbers.

## What was fixed on the way (already shipped)

`3031c62` — **`collisionReady` was a getter that rescanned every wall and leaf per
pathfinding step.** 96.6% of broker CPU, 87% of it in nine lines. Only 2–3 of 21 characters
could reach the world; `/health` timed out, which also made the broker invisible to
`m59-service.mjs stop` (it identifies a broker *by* `/health`) and it had to be killed by
pid twice. After: 21/21 logged in within 105s, CPU ~38%. **This is real and unrelated to the
pocket trap** — it was hiding it.

`c6d2e7f` — a wall-clock bound on `confirmPosition`, whose per-reply timeout only fires if
replies *stop*. Correct on its own merits; **explicitly not the fix**, and labelled so.

---

## Done in this pass

### 1. Breadcrumbs — the escape — **BUILT, offline-tested, unproven live**

`queueValidatedMove` keeps the last 64 moves it sent — the one choke point every move in
the broker passes through, and the only place that knows both the position the packet left
from and the clipped endpoint it asked for. `Session.retreatAlongBreadcrumbs` replays them
in reverse; `walkTo` calls it when the router finds no route, at the start of a walk and
once more mid-walk, then re-plans from wherever that lands.

It is safe for a reason that matters: every step replayed was already accepted by the fine
validator on the way in, so it **cannot invent an impossible traversal** — it can only undo
one. If a character reached a pocket by a route that should not have been legal, the
breadcrumbs walk it back out the same way and the trap closes without widening the hole.

Four behaviours worth knowing before editing it: a broken trail is dropped whole rather
than skipped; the retreat stops the moment the route reappears; a refused reverse step ends
it honestly rather than being forced; and it runs once per walk, because undoing the trail
twice unwinds the journey.

`node tools/m59-breadcrumb-test.mjs` (32) pins it, including the one-way ledge — the case
that must stop rather than teleport.

### 2. A negative-assertion suite — **BUILT: `m59-impossible-test.mjs` (126)**

**The 153 collision assertions are all positive** — the Brownestone, Limping Toad, Icky,
Farol, Ukgoth, Cor Noth, Temple and Fey cases all assert that legitimate moves *remain
usable*, so **the suite passes cleanly on the day the walls stop working**.

The new suite is checked-in `traceFineMoveClient` fixtures across the King's Way, both
Cragged Mountains, the Twisted Wood and its western border, Ukgoth, the Sentinel, the Icky
Cave and the four floors of Castle Victoria — each asserting a refusal **and naming the wall
index that refused it**, so "still refused, for a completely different reason" cannot pass
as unchanged. It also asserts that the upstairs of Castle Victoria stays sealed west from
east under `moverStepLands`, with the castle's other three floors as the control.

Every room carries **controls out of the same bake**, because a suite that only asserts
refusals passes perfectly when everything is refused, which is the fleet standing still.

**Observation cannot be the oracle here.** Players legitimately appear to phase through
walls from another client's view — lag compensation — so "I watched it happen" proves
nothing about legality. Assert against our own validator.

**One planned case was dropped after measuring, and the reason matters.** The intended
assertion was that the Cragged Mountains cliff is one-way. It measures as one-way — and so
does the south exit anchor of *every* room checked (576, 578, 597, 598), because those
anchors sit on the room's outermost row, where the mover routinely steps off a square it
cannot step back onto. That is a property of the room boundary, not of the cliff. Asserting
it as the cliff would have pinned the wrong fact with a confident name on it.

### 3. Clearance — do not hug the wall on the way past it — **BUILT**

Not in the original plan; it came out of the same mechanism. A safe spot is a square the
geometry hems in, which makes it the last thing worth routing *through* — and A* with a
flat step cost is indifferent between the middle of a gap and the tight side of it, so it
threads characters along the wall, where a step slides and the bounce begins.

`RoomGeometry.clearanceField` costs a square by how much of its step ring the **mover**
refuses, measured off the baked mask. Measured across random routes: mean blocked
neighbours per step **1.35 -> 0.72 in room 587**, 1.28 -> 0.49 in 597, 0.23 -> 0.05 in 544,
for 6–8% more steps. It is cost and never a prohibition, the destination is exempt so a
wall corner is still routable, and with no mask the weight is zero.

**It is OFF unless the caller asks, and the first version was not.** A safe wall is a tight
square by definition — that is the mechanism — so a preference for open ground is, if it
reaches the tactical questions, a preference against the best squares in the game. It did:
`world.reach` measures how far a wall is and `nearestSafeSpot` ranks at -0.5 a step, and
with the preference on **36.7% of walks to a recorded held wall came back longer, worst +9
steps — 4.5 points against a proof bonus of 20**, biased against the walls that are hardest
to walk into. `path` and `clearanceField` now default to weight zero; `leaveVia` opts in at
0.6, because crossing a room to a boundary is the long routing where the wedge happens.

### 4. A test that actually tests a safe wall — **BUILT: `m59-safewall-test.mjs` (15)**

There was not one. The 141 safe-spot assertions are about the BOOK-KEEPING — proving a
square, disproving one, the settle grace, the pull detector — and the mechanism itself was
tested only on synthetic 15x15 grids in `m59-combat-test.mjs`. Nothing asserted that what
the fleet stands on in the real world is a safe wall.

This one reads the baked map and the recorded book: every one of the held squares is still
nominated by `safeSpots`, the broken line of sight is real geometry rather than a score, and
a held square offers **3.24 unanswerable shots against 1.49 for ordinary floor in the same
rooms** and **3.46 back cover against 0.85**, across 37 rooms and 256 squares. Its last
section is the regression guard for the paragraph above — flip the clearance default back on
and it goes red on 302 of 395 walks.

### NOT this: a coarse-grid escape hatch

Considered and **rejected**, and still rejected. Falling back to the server's walkable grid
to escape a pocket would relax collision *precisely where the two grids disagree most* —
which is the mechanism that let bots climb cliffs and cross map boundaries no client can.
The concern was never that a bot slips a little too deep into a safe spot; it is that bots
have done traversals a human player cannot. Do not reopen that.

---

## Still to do

### Prove it live — the only step that matters now

Nothing here has met a server. Room 587 reproduces the wedge on demand: travel a character
from 60 to 544, on the arena fleet at `127.0.0.1:15959`. **Reproduce there, never on prod.**

```bash
node tools/m59-trace.mjs --seconds 60 --interval 15
```

Read-only, no restart, ~1 minute. Success is precise:

- `maxblock` **stops climbing** (it currently tracks broker uptime — the first pass never ends)
- `passes` **advances** for everyone, not just the character that never left its safe spot
- the `WEDGED` section empties

The control case all session was **Bunsen**: the one character *holding* a safe spot rather
than trying to leave one, running 8 passes and killing while 17 others were stuck.

### The safe-spot book as a destination — measured, and mostly already true

The plan was to make `flee` and `rest` ask `substrate/m59-safespots.json` for the nearest
held pocket instead of searching from scratch. On inspection they already do:
`withdraw()` and every rest path go through `takeSafeSpot` -> `searchSafeSpot` ->
`nearestSafeSpot`, which is handed the book, skips discredited squares, keeps a proven
square eligible below the defensibility gate, and ranks proof at +20..+30 (a human-verified
square at +60) over pure geometry.

The one gap that would have justified new code was measured and **does not exist**: of the
256 recorded held-and-never-failed squares, **0 are missing from what `safeSpots()`
nominates**. There is no held pocket the model refuses to consider.

What is left is genuinely open and needs (1) proven live first: a held pocket the ROUTER
cannot reach is still rejected as unreachable-to-us, because `reach` is `world.reach`.
Breadcrumbs solve the way *out*; the way *in* still needs the router, and relaxing that is
the coarse-grid hatch under another name. Do not start it before the live trace is clean.

### Out of scope for now

The jump in *"Ancient Place, its origin forgotten"* to reach the mana node. That is Z-axis
ballistics with fall limits; what is baked is sector heights, slope and water depth for
*stepping*. Teaching a jump while characters cannot reliably leave a corner is the wrong
order of work.

## State as of writing

- prod broker **down**, 0 sockets, roster intact at 21 slots, **deaths 325 and flat**
- arena fleet on the local server (`127.0.0.1:15959`) is the test bed — 6 throwaway
  characters, TESTER/Alpha/Bravo/Charlie/Delta/Echo. **Reproduce there, never on prod.**
- launchers for watching in the client: `shortcuts/arena-*.bat` (gitignored). Note the
  committed `m59-shortcuts.mjs` writes `127.0.0.1:5959` for every character — **wrong port
  for the local server and wrong host for prod** — and takes no `--fleet`. Worth fixing.
- room 587 reproduces the wedge on demand: travel a character from 60 to 544.


---

# 2026-08-17 — MEASURED. COLLISION ROUTING IS NOT DANGEROUS, IT IS UNRELIABLE.

**Do not turn this on for prod yet.** Three independent measurements agree and the
number that matters is arrival, not speed or death.

## What was measured

`m59-circuit.mjs`, Streets of Tos -> East Jasper, five bots kitted to the prod fleet's
own profile (max_health 56, block 90, stamina 50 — read off `substrate/sheets/` and
`substrate/abilities/`, where prod runs 46-62 health and block median 97):

    1/5 arrived    median 559s    0 deaths    135 swings taken

**Speed is not the problem and neither is danger.** 559s against a 984s baseline is 43%
FASTER, and nothing died in any run all night. Four of five simply never got there.

`m59-hoptest.mjs` then asked the same question per BOUNDARY rather than per journey —
`UtilGoNearSquare` places a body on an exact square in 0.2s, so each doorway is tested on
its own from spread starts, in parallel:

    7/21 hops crossed (33%)

      50 -> 586   3/3   median 11s
     586 -> 587   0/3   stopped without arriving, from all three starts
     587 -> 576   0/3   timed out / stopped
     576 -> 566   2/3   median 77s
     566 -> 567   0/3   timed out / stopped
     567 -> 568   2/3   median 152s
     568 -> 350   0/3   TOOL ARTEFACT — the bots were still busy; not a boundary result

So the broken boundaries are **586->587, 587->576 and 566->567**, which is exactly where
the live journey stalled and exactly where an operator watching the client saw characters
"barely wiggling" at the western edge of 587.

## Where the risk actually lives, and it is not where this file has been looking

`m59-walktrial.mjs --plan-only`, hundreds of planned routes per room, stratified by
whether the START is a safe wall (`exposureAt().attackers === 0`):

    room                       NO ROUTE from a fortress square    from ordinary
    50  The Streets of Tos                41.7%                       0.0%
    586 Main gate to Tos                   0.0%                       0.0%
    587 W. border Twisted Wood             0.0%                       0.0%
    576 The King's Way                     0.8%                       0.8%
    566 Off the beaten path               20.0%                       8.4%
    567 Off the beaten path               10.0%                       3.4%
    568 Lake of Jala's Song                0.8%                       0.0%
    350 East Jasper                        0.8%                       0.0%

**From ordinary squares the router is essentially perfect.** The failure is specific to
starting on a safe wall — and the fleet SEEKS THOSE SQUARES OUT to rest on, so it begins
its journeys from precisely the places the router handles worst. That is the mechanism,
and it is a much narrower claim than "the fleet gets stuck near safe walls".

Offline over the 13 rooms the fleet uses, a fortress square is **145x** more likely to be
one the router cannot step off at all (5.21% against 0.04%) and 6.3x more likely to be a
trap or isolated. The correlation this document has always asserted is real — FOR
PLAN-TIME REFUSALS. It did not explain either live failure observed tonight.

## Two live failures that were NOT the safe wall, and cost hours to tell apart

**A corridor plugged with monsters.** The same three-step walk read `steps: 40,
replans: 0` with eleven rats across a two-wide corridor and `steps: 3, arrived` once they
moved. `walkTo` counted a body-blocked step as `learned`, which SUPPRESSES the replan
counter, so a walk entirely consumed by squeezing past bodies returned "stopped after 40
steps" — byte-identical to one that merely had too small a budget. Now counted and named
(`monster_blocked`, `blocked_by_bodies_at`) on every reply including successful ones.

**Two characters meeting head-on.** `sidestepAround` was added to go round a blocker, and
made it worse: both run the identical rule, so both dodge the same way, collide, and
mirror each other. Watched live: *"like two people stuck in a hallway — I'll go left, no
you go left, no my left, no your left."* Broken now on the mover's object id, plus jitter
on the retry so they do not decide in lockstep.

## Corrections to this document

- **587 is not the wedge room.** It has **zero traps** and 23 isolated squares of 1406
  walkable (1.6%), and its safe-wall routing is 0% failure. Its boundaries are broken;
  its floor is fine. The reputation came from this document, not from the corpus.
- **17,402 is a count of strongly-connected COMPONENTS, not of places to get stuck.**
  The trap count is 4,823.
- **The trap-dense rooms are towns**: West Jasper has **795 traps** — the worst in the
  world, and on every Jasper bank run. The Streets of Tos is 41.7% unroutable from its
  safe walls.
- **Castle Victoria does not need a jump to enter.** Its three `go` exits at (3..5, 44)
  are all walkable, in the main body, with five mover-neighbours each. The hazard in
  Outside Castle Victoria is that 277 of 576 walkable squares are isolated and only 225
  are in the main body. Ukgoth's north boundary is reachable from 8 of its 12 squares.

## The next thing to do

Find out why 586->587 and 587->576 fail from EVERY start when 587's own floor routes
perfectly. It is a boundary problem, not a floor problem, and `m59-exitgap.mjs` asks the
model the same question `m59-hoptest.mjs` now asks a body — the pair should localise it.

---

# 2026-08-17 (later) — THE BOUNDARY PROBLEM IS A SQUARE WHOSE CENTRE IS INSIDE THE WALL

This answers the question the section above ends on: *why do 586->587 and 587->576 fail
from every start when 587's own floor routes perfectly?* It is neither the floor nor the
boundary. It is one square on the approach, and the refusal is about where the character
IS rather than where it is going.

## The mechanism

`traceFineMoveClient` tests the BSP leaf under the **origin** before it tests a single
wall, and answers `start_has_no_floor` when there is none. That answer is the same for
every heading, so `walkFine` fans nine headings at four reaches, collects it thirty-six
times, and **sends zero packets**. `walkTo`'s off-grid recovery routes through the same
call, which is why it reports `could not step back onto solid ground`. A character whose
position reads as such a point cannot be moved by any path this repository owns.

Room 587's west exit staging is `2,5`; the approach passes `2,4`. **21 of 64 points
sampled inside `2,4` have floor** — an operator walked it and called it ordinary corridor —
but its **centre does not**, and the centre is the only address the planner has.

Reproduced offline, no server, driving the real `walkFine` against the real baked geometry:

    from 2,5  -> arrived, 3 packets
    from 2,4  -> FAILED, "every heading refused", 0 packets, start_has_no_floor
    from 3,4  -> arrived, 5 packets
    from 3,5  -> arrived, 5 packets
    from the parts of 2,4 that DO have floor -> arrived, 3-4 packets

That last line is the whole thing: the same square succeeds or fails depending only on
whether the position used is the square's centre.

**The server never had an opinion.** It does not validate player movement at all, so the
only thing holding the character still was our own check, run from an origin the check
itself calls invalid — failing closed on no information.

## The fix

`validateFineTarget`: when the trace refuses with `start_has_no_floor`, the DESTINATION
decides. Only for that reason; the destination must have a leaf, checked by the same
geometry; at most one square; reported as `recovered_from_no_floor`. It also carries
through the quantizer, which re-traces from the same origin and would undo it otherwise.

From `2,4` the walk to the west exit now arrives in **4 packets, off by 0.0**.
`m59-collision-test.mjs` (162) pins it, including that a distant target and a neighbour
with no floor are both still refused.

Four of the five interior refusals a walk trace exposed in western 587 are this same
cause seen from either side (`1,6 -> 1,5`, `1,6 -> 2,5` are origin-side; `1,5 -> 1,6`,
`3,5 -> 2,6` are destination-side). The fifth, `4,4 -> 3,5`, is genuine: both centres have
floor and the mover slides short to `3,4`. Still unexplained.

## And `neighbors()` was asking the monster map

Separate defect, same investigation. `neighbors()` iterated `openDirections()` — the
server's coarse grid, which is what MONSTERS move on — and applied the mover's answer only
as a second filter, so the coarse grid held a silent veto. Measured against a human walking
587 at a run: `53,28 -> 52,27` and `33,20 -> 34,20` both have `moverStepLands TRUE` and
coarse grid FALSE, and the router refused both. With a mask, `moverStepLands` is now the
authority; with no mask nothing changes.

| | before | after |
|---|---|---|
| squares in the main body | 185,211 | **235,588** (+50,377 = 19.5% of all floor) |
| pockets world-wide | 17,402 | **2,492** |
| traps | 4,823 | 3,600 |
| stranded exit anchors | 383 of 1,293 | 181 of 1,290 |
| room 50, planned NO ROUTE from a fortress square | 41.7% | **3.3%** |

That last row is measured with `m59-walktrial.mjs --plan-only --compare`, the same tool
the section above used, so it is directly comparable. Room 587 now reports 1.5% and
**0.0% coarse-only**.

## Corrections to earlier entries

- **Deaths are 323, not 325.** The 325 was carried from an older handoff and never
  re-measured; `m59-postmortems.mjs` reports 323.
- **`m59-shortcuts.mjs` does not hardcode 5959** — it takes `--host`/`--port`, and 5959 is
  only the default. But its `--fleet` is a NAME FILTER, not a fleet selector: it silently
  matched nothing against the prod roster. `M59_FLEET=arena` is the resolver that works.
- **`m59-postmortems.mjs` reported the wrong fleet's deaths** — 3 instead of 323 — because
  `fleetScope`'s lone-broker shortcut adopted whichever broker was answering, overriding
  `--fleet`, `M59_FLEET` and `substrate/fleet-default`. Fixed; `m59-fleetscope-test.mjs`
  (33) pins it. The first line of that tool is what the fleet check-in reads as its safety
  gate, so it was wrong at exactly the moment it mattered.

## Still open

- **Live confirmation.** Everything here is our model agreeing with itself. The one thing
  that has ever broken this open is a person walking and saying what they saw.
- `4,4 -> 3,5`, above.
- **The position pulse does not cover keeperless movement.** It lives on the keeper's
  watchdog, so a bare `travel` call — which is how this fault was reproduced — raises no
  `!` at all. That gap cost a measurement in this investigation.

---

# 2026-08-20 — THE FLEET WAS NOT WALLED IN. IT HAD FORGOTTEN WHO IT WAS.

Everything here was measured on the **arena server** (`127.0.0.1:15959`) with the **shadow
fleet** — 21 characters, Aaaa..Uuuu, copies of prod's roster — walking the operator's cycle
**Tos → Castle Victoria → Cor Noth → Barloque → Tos**. Nothing below touches prod.

## The one-line finding

`BP_SEND_PLAYER` was **not bound anywhere in `m59-broker.mjs`**. Both call sites — the new
`selfOrResync` and `refreshRoomIdentity`, which has had the line since the initial commit —
threw `ReferenceError` the moment they were reached, and both are recovery paths, so they
could only fail once something else had already gone wrong.

## What that looked like from outside

Aaaa walked from Outside Castle Victoria to the Streets of Tos in 390s, eight hops, zero
stumbles. The next leg failed in eleven seconds:

    The Streets of Tos    -> Main gate to Tos   go    ok      0.9s
    Main gate to Tos      -> W. border Twisted  edge  FAIL    9.4s   own_position_unknown
    (x6) cannot find the exit to Western border of the Twisted Wood from here

and `look` then said, for the next four minutes:

    you: { object_id: 7420, note: "not present in room contents yet — call look" }
    objects: [ ..., { id: 7400, name: "Aaaa", col: 1, row: 47, is_player: true }, ... ]

**The server had renumbered the character from 7420 to 7400**, which it does when it
garbage-collects, which it does on every save — `[Auto] SavePeriod` is 15 minutes on this
server, and the flight recorder carries the line: `System is saving; please wait.`
`client.self` is `room.objects.get(selfId)`, so a stale `selfId` reads exactly like "I do
not know where I am", and **re-reading the room can never fix it**: the new contents are
keyed by the new id.

`c.requestPlayer()` is the fix — a method on the client rather than a constant the broker
sends by hand, because a missing method fails at load and a free variable fails only when
the world has already gone wrong.

**`m59-breadcrumb-test.mjs` now lifts the real `selfOrResync` and `refreshRoomIdentity` out
of the source and RUNS them** (51 assertions). Every earlier assertion about losing our own
position drove the fixture's own stub, so the suite passed perfectly while the real method
could not execute at all.

## The second cause of being stuck: the step budget was the plan length

`walkTo` allowed `plan.steps.length + 10` packets. That is right where the mover lands
where the router aims it, and wrong where it does not: the router validates a step
centre-to-centre, the mover SLIDES, and after the first slide the body is never on a centre
again. Measured offline against the real baked geometry — driving the real `path`,
`standPoint` and `traceFineMoveClient` with the fine position carried forward, from random
floor to each room's own baked exit anchors, 12 walks a room:

|  | plan-length budget | ×3 |
|---|---|---|
| 598 The Cragged Mountains | 4/12 | 6/12 |
| 599 Ukgoth | 3/12 | 5/12 |
| 575 The King's Way | 5/12 | 8/12 |
| all 21 cycle rooms | 203/252 | 211/252 |
| of which failed on the step budget | 33 | 8 |

The rooms that do not slide measure a steps/plan ratio of **1.00** and are unaffected, so
this is a ceiling that stops binding rather than a loosening. `OFF_PLAN_STEP_BUDGET` = 3.

**The bounce is reproducible offline with no server at all.** In room 598, from 19,8 to
64,19, the walker oscillates 23,16 ↔ 23,17 for ever: from 23,17 the plan says go south to
24,17 and the mover slides BACKWARDS into 23,16; from 23,16 the plan says go east to 23,17
and it slides forward again. Both moves are `geometry_blocked`. Watched live at the same
time, Aaaa did the same thing at col 8, rows 17–19.

## Ukgoth: the anchor was on a five-square island in the rock

`m59-clipsweep.mjs` asked whether the anchor SQUARE was grid-solid and reported Ukgoth
CLEAN, in the same run whose header calls Ukgoth the worst case in the world. Room 599's
north anchor to Outside Castle Victoria was baked at **row 1, col 62**, and that square is
grid-walkable — it is also one of **five** grid-walkable squares with no coarse-grid
connection to the other **1,679**. The east anchor to 598 sits on the same island.

So the anchor was fine and the APPROACH was the cheat. The question a doorway has to answer
is *can a body get here from the rest of the room without crossing ground the coarse grid
calls solid*, which is a CONNECTIVITY question. `coarseComponents` answers it, and
world-wide **116 of 264 rooms had an exit anchor only a clip can reach** — 96 after the
bake learned to prefer a coarse-connected staging square, below.

**Rebaking moved Ukgoth's north anchor off the island.** The table on disk was stale in a way
the manifest cannot detect: it hashes the GEOMETRY, and what had changed was the
anchor-selection code.

**And then the finding had to be put INTO the bake, because rebaking alone landed on 2,26 —
a ONE-square island.** `exitAnchors` preferred a stage the room's body can reach, and "the
body" there is the COLLISION view: the permissive one, the one that walks the rock. So it
was satisfied by a square only a clip reaches. It now prefers, above that, a stage in the
coarse grid's own main component — `playerReachable`, ordered and never filtered, because a
bake must never be the reason a doorway disappears. Ukgoth's north exit publishes 2,26 first
and **1,27** second, and 1,27 is the square the operator names as the only doorway to Castle
Victoria. That is what the bake picks now.

Its east exit to 598 stays on the five-square island, and that is the rule working rather
than failing: every candidate that exit publishes is on it, so there is nowhere better and
the doorway is kept.

**Across the world it moved twenty rooms' doorways onto ground a player can reach**:
`m59-clipsweep.mjs` counted **116 of 264** rooms with a clip-only exit anchor before the
rule and **96** after, on the same map, with `m59-routing-test` still green.

## The clip is priced now, not forbidden

`CLIP_STEP_COST` = 2 charges a planned step onto ground the coarse grid calls solid. It is a
cost and never a prohibition, because 137 of the 2,164 positions in the operator's own walk
logs are squares the coarse grid calls wall with real BSP floor under every one: refusing
those would refuse the ground a person was standing on.

Dose–response in Ukgoth, from the 598 arrival to the north doorway:

    clipCost 0    110 steps, 27 of them on grid-solid rock
    clipCost 2    118 steps,  7
    clipCost 8    153 steps,  0

**AND IT BARELY CHANGES ARRIVAL, WHICH IS WORTH SAYING PLAINLY.** An earlier draft of this
entry claimed 83.7% -> 85.7% -> 86.1% from a scratch benchmark; `m59-walksim.mjs --cycle`,
which anyone can re-run, measures **217/252 -> 218/252 -> 219/252** across the twenty-one
cycle rooms, with no room worse and 36.4 steps per arrival either way. The scratch figure
was taken against a half-rebaked table and is withdrawn. Buy this for HONESTY — routes that
stop crossing rock — and not for a success rate.

Where it does show up is per-walk, in the room it was aimed at. Room 598, 19,8 -> 64,19,
`m59-walksim.mjs --trace`:

    clipCost 0    ARRIVED  plan 50, walked 72, 12 off-plan, 12 fine detours, 12 edges learned
                  ... 22,16* 23,17 23,16* 23,17 23,16* 23,17 ...   the bounce, twice
    clipCost 2    ARRIVED  plan 52, walked 52,  0 off-plan,  0 fine detours,  0 edges learned

The squares it was bouncing between were the grid-solid ones. Two is the default because it
is what flips Ukgoth; eight measured a shade better on the cycle and is left for a wider
sweep to justify.

## And the declared fall-jumps are NOT load-bearing, which is a correction

`substrate/m59-falljumps.json` says the router "either cannot reach the far side or reaches
it through a wall" without them. The first half is not true. With every clip step refused
outright, Ukgoth still routes and **never uses a declared jump**:

    2,27 -> south exit    84 steps, 0 rock, 0 falls
    4,63 -> north door   153 steps, 0 rock, 0 falls

The table is additive, cited and harmless, and it does not currently carry any route the
fleet takes. Keep it; do not claim it is holding anything up.

## The bake could not spell a jump, and dropped the route rather than saying so

`pathString` encodes a route as one letter per step in `STEP_DIRS` — the eight unit
directions. A fall is a single move of two or three squares, `LETTER.get('3,-3')` is
undefined, and the whole pair produced **no entry at all**. `bakedPath` then answered null,
and `m59-world.mjs` reads that as "walking cannot join these two exits".

Ukgoth again, and it is where it costs most: the 83-step route from the Castle Victoria
doorway to the Sentinel doorway BEGINS with a fall, `2,26 -> 5,23`. So the transit check
refused a crossing the mover makes every lap, and `m59-routing-test`'s *"the directed answer
still offers the way that works"* went red the moment the north anchor moved off the rock.

The bake now records `reach` — a BFS answer per ordered anchor pair, kept whether or not the
steps can be spelled — plus `unspellable`, because a bake that quietly omits a thing is how
this went unnoticed. `anchorReach()` is what `transitOk` asks; `bakedPath` still answers
"which squares" and is still null for these.

## Deaths: the keeper stood down for a driver that had stopped driving

Two of five characters died on one leg, both in The Flatlands, both stationary — 268 and 111
seconds — with four ants on them and health falling about half a point a second. Neither
fled, neither swung, and both post-mortems say the same two things:

    stood_down_for: "travelling to The Streets of Tos"
    wedges: 0

`goInert` is how an outside operation takes a character, and `pulsePosition` — the one
instrument that reads the CHARACTER's own clock rather than the keeper's — excused `inert`
outright, on the argument that this keeper stood down deliberately and does not get to call
the thing it stood down for a stall. **That is right about the instrument and wrong about
the rescue.** The handbrake could not reach it either: it is armed by the KEEPER's pass
being stuck inside one await, and while something else owns the character this keeper's
passes finish in milliseconds. So the character bled out inside a healthy-looking keeper.

Inert now excuses standing still and **does not excuse standing still while losing health**.
That combination is not somebody else driving; it is somebody else having stopped. The
watchdog cancels the movement and stops being inert, and decides nothing else — the next
ordinary pass runs the survival ladder with real numbers, which is the same contract the
handbrake has.

**Two things had to be right before it fired once, and both were found by watching the
counters rather than by reading the code.**

*A wedge must survive a painless second.* Damage lands about once a second and so does the
pulse, so half the ticks see no drop — and the excused branch CLEARS the wedge. The first
version reset the episode on every quiet tick, so it never aged past one pulse and the
rescue four seconds later could never fire: live, `wedges` climbed to 8 while `rescues`
stayed at 0 and the character died anyway. A wedge ends when the BODY moves, not when a
second happens to be painless.

*And the body test must see the BOUNCE.* `stillHere` compares consecutive pulses on the
exact square, which is blind to a character alternating between two of them. Cccc died in
the Cragged Mountains with its last three pulses reading **35,33 / 34,33 / 35,33** — moving,
by that test, for ever, with fifteen things in the room. `pennedIn` asks the whole ring
instead: every sample, same room, all within one square of the newest. A character walking
somewhere leaves that neighbourhood in three seconds; one oscillating never does. It is used
only on the inert branch, because widening an instrument and widening a handbrake are
different decisions and only one of them has been measured.

`m59-pulse-test.mjs` (43) pins both halves, including the five cases that must stay quiet:
steady health, healing, genuinely walking out of the neighbourhood, an errand crossing a
quiet room, and a safe wall held for a full minute.

**It fires, and the character lives.** On the arena fleet with all of the above: Cccc took a
rescue after 14 wedges and finished the leg at full health in Marion, where the same
character had previously died stationary.

## Two things that were NOT bugs, recorded so nobody looks again

- **Twenty characters stranded at 10,10 in the Cibilo Creek Inn.** `walk_to` answered
  `start_has_no_floor` for every heading and the one-square recovery could not help: the
  nearest floor is 9,8, two squares away, and `traceFineMoveClient` finds **wall index 76**
  between them. They were inside the inn's wall, put there by `m59-shadow.mjs dress`
  replaying prod positions through `UtilGoNearSquare` — which never says no. The model was
  right; widening the recovery would have walked them through a wall. `m59-dm.mjs relocate`
  is the fix, and shadow-fleet setup should verify placement lands on standable ground.
- **Four suites already fail at HEAD**, checked in a detached worktree so the claim is not
  an assumption: `m59-combat-test` (9 — Castle Victoria's upstairs wings),
  `m59-region-exit-test` (3 — the Icky Cave region exit), `m59-travel-ab-test` (2 — the
  resting-cap gate) and `m59-route-test` (throws). Four separate threads, none of them any
  of the above. `m59-path-test` did NOT fail at HEAD — the uncommitted `m59-falljump.mjs`
  broke it by hand-building a `file://` URL from `process.argv[1]`, and it is fixed.

## Still open

- **THE BOUNCE IS THE WHOLE OF WHAT IS LEFT.** `m59-walksim.mjs --cycle`, once it models
  walkTo's own relaxation ladder, puts **20 of 34** remaining failures on `bouncing` and
  only 3 on `no route mid-walk` — the ladder converts one into the other, which means the
  walker does not lose the route, it oscillates on it. Nothing tried here moves that number:
  not the step budget, not the clip cost, not a larger fine-detour cap, not forgetting the
  learned edges. The next person should start from `--from … --to … --trace` on one of them.
- **578 The Cragged Mountains is the worst room on the cycle** (3/12 to its own anchors,
  against 12/12 for the towns), with 599 Ukgoth at 4/12 next. Its east anchor to 826 sits on
  a four-square coarse-grid island.
- **AND 598 IS WALKABLE AND EXPENSIVE, WHICH IS A DIFFERENT PROBLEM FROM UNWALKABLE.** The
  exact crossing a live character stalled on — 30,24 to the 599 doorway at 64,19 — arrives
  offline, and costs **93 steps against a 36-step plan**, 14 off-plan landings, 14 learned
  edges and **12 fine detours, which is the whole of `FINE_DETOUR_MAX`**. The trail bounces
  at 29,24/30,24, then 33,24/34,24, then 33,35/33,34. Live that room also holds fourteen
  monsters, each of which eats budget. So the fleet does not fail to cross the Cragged
  Mountains; it crosses at 2.6x the price with every recovery mechanism at its limit, and a
  travel call gives up before it gets there. Raising `FINE_DETOUR_MAX` was tried and
  measured nothing on the whole-cycle sweep; the honest next step is the bounce itself.
- **THE CYCLE'S ONE REMAINING KILLING GROUND IS 598's NORTH-WEST CORNER, AND IT IS THE
  BOUNCE PLUS TROLLS.** On the last verification lap three of five died there — Cccc at
  8,15, Dddd at 8,7, Eeee at 8,8 — all with the same six killers named and
  `most_at_once: 14`. It is the same corner Aaaa bounced in at col 8, rows 17-19 on the
  first run of the day. Two of the three were NOT inert (`stood_down_for: null`), so the
  keeper owned them and the ordinary pulse alarm was firing — `wedges: 6` and **26** — and
  the ordinary alarm is only an instrument. The keeper's own answer to being cornered is
  `townTripIfCornered`, which is a WALK, and a walk is the thing that is failing.
  
  So the shape of the next fix is: a character that is wedged AND taking hits should reach
  the answers that do not require walking — `breakOut`'s reconnect, `blinkFree`, the logoff —
  regardless of who is driving. The inert half of that shipped today; the keeper-driven half
  did not, and `wedges: 26` on a corpse is the number that says so.
- **NOBODY WATCHES A STUCK CHARACTER THAT IS NOT BEING HURT, AND THAT IS THE LAST HOLE.**
  The inert rescue is gated on losing health, deliberately — it is survival code and it
  takes the character back from its driver, which is not a thing to do on a hunch. So a
  character that is inert, stationary and at 100% health is invisible to it. Dddd sat at
  17,40 in Under the shadow of the Sentinel for two whole legs, `busy: walk to Cor Noth`,
  `wedges: 0`, full health, never moving.
  
  `m59-supervise.mjs` is the 60s unsticker and it stands off for exactly the same reason
  the pulse used to: *"an operation is in flight and its keeper is inert on purpose … and
  `ms_since_moved` measures the keeper, not the character"*. Both are reasoning from the
  keeper's clock about a question only the body can answer, and the predicate that answers
  it now exists — `pennedIn` needs no health at all. The shape of the fix is to publish an
  inert wedge whether or not it is bleeding, and let the supervisor's stand-off rule read
  the CHARACTER's clock instead of assuming the errand is working. That is a supervisor
  change, not a keeper one: standing still safely is not an emergency and must not be
  handled by taking survival back.
- **`m59-shadow.mjs` does not verify placement** against the floor model, which is what
  stranded the fleet in an inn wall.
- **`m59-walksim.mjs` is new and is the instrument behind every number above.** It drives
  the real `path`, `standPoint`, `traceFineMoveClient`, `finePath` and the real edge
  learning, with the fine position carried forward, and it predicted the live bounce before
  anybody watched one. `m59-walktrial.mjs --plan-only` asks the ROUTER; this asks the
  WALKER, and that was the half nothing measured. It has no test of its own yet.

---

# 2026-08-20 (later) — THE CRAGGED MOUNTAINS WAS NOT A BOUNCE. IT WAS A PREFERENCE.

`598 -> 599` is the boundary the Castle Victoria road turns on: **both** directions of
Castle Victoria ↔ Barloque cross it. The transit ledger recorded it failing **49 times in a
row**, always with the same words:

    598 - The Cragged Mountains -> 599 - Ukgoth   0 crossed, 49 failed
    every square for that exit refused (4 tried)   ~110s of walking, 5 squares covered

Five squares in a hundred and ten seconds is not a refused doorway. It is a walk that never
arrived at one, and `leaveViaAny` then blames the exit.

## Three things were tried and only the third was it

**Aim into the square, not at its stand point.** `moverStepLands` prices a step stand point
to stand point and the body is never on a stand point after the first slide, so the aim was
being taken from a position the router never asked about. `Session.aimInto` now proves a
handful of points inside the target square with the mover's own trace and takes the nearest
usable one. It is right, it is cheap, and **on this walk it changed nothing**: from the fine
position the bounce leaves you in, no point in the target square is reachable — not by a
straight line, not with sliding, and `finePath` cannot find one either. The square is
genuinely not enterable from there and the walker's answer, learning the edge, was correct.

**Measure progress on the route rather than the crow fly.** `gainedGround` was Chebyshev
distance to the goal, and a mountain room's way out goes AWAY from the goal first — traced
offline, nine consecutive correct steps that all read as "no ground gained", which is most
of a replan budget. It is `re.steps.length < shortestRoute` now, and `re` is computed before
the budget decides instead of twenty lines after it. Also right; also not the cause.

**And then: `leaveVia` opts into `clearance: 0.6`.** That is a preference for open ground,
and the room is a mountain. `m59-walksim.mjs --cycle --clearance 0,0.6`, same starts, twelve
walks a room to each room's own baked exit anchors:

|  | clearance 0 | clearance 0.6 |
|---|---|---|
| **598 The Cragged Mountains** | **7/12** | **2/12** |
| 578 The Cragged Mountains | 4/12 | 3/12 |
| 585 The border of the Badlands | 12/12 | 11/12 |
| every other cycle room | unchanged | unchanged |
| **all 21 rooms** | **218/252 — 86.5%** | **211/252 — 83.7%** |
| steps per arrival | 36.2 | 37.9 |

**No room is better with it on.** On the single walk a live character kept failing — 598,
30,24 to the Ukgoth doorway at 64,19 — it is 93 steps and arrives flat, and 118 steps and
runs out of budget at 0.6, with off-plan landings going 14 to 26.

## Why the original measurement did not catch this

It measured the right mechanism and the wrong outcome. The number behind 0.6 was PLAN-TIME
blocked neighbours per step — 1.35 to 0.72 in room 587 — on the reasoning that a walker
threaded along a wall is where a slid step starts the bounce. That reasoning is sound and
the proxy is not the thing: fewer blocked neighbours in the plan does not mean more arrivals
for the body, and in the two rooms where the fleet actually gets stuck it means fewer.

`LEAVE_VIA_CLEARANCE` is 0, named rather than deleted, because the mechanism is real and
somebody may find the right weight. **The number to beat is 218/252 and `m59-walksim.mjs` is
how to beat it.** `path`'s own default is untouched and `m59-safewall-test`'s regression
guard — flip that one back on and 302 of 395 walks to a held wall get longer — still passes.

## The instrument that found it

`m59-walksim.mjs` grew a `--clearance` sweep for this, and the finding is a straight
argument for what the tool is for: the router's own numbers said 0.6 was an improvement for
a year. The only thing that disagreed was walking.

## AND THE CRAGGED MOUNTAINS IS ONE-WAY, WHICH IS WHY THE TWO DIRECTIONS ARE DIFFERENT ROUTES

Measured on the baked geometry, room 598, between its own two doorways:

    1,18  (from The Twisted Wood)   ->  65,19 (to Ukgoth)    59-64 steps, ZERO off-plan
    65,19 (from Ukgoth)             ->  1,18  (to Twisted Wood)   NO ROUTE AT ALL
    the same pair on the coarse grid                          59-64 steps either way

It is a mountain. The way down is a chain of drops that `fallTargets` offers and
`enforceStepHeight` refuses to climb, so the collision view is right and the coarse grid —
which has no idea how high anything is — is not. The bake records it honestly:
`anchorReach(598, from-599-anchor, to-597-anchor)` is **false** and `sameRegion` agrees,
because a strongly connected component is exactly what a one-way drop breaks.

**So the transit check does the right thing and the two directions are not the same road:**

    38 Castle Victoria -> 101 North Barloque    2, 599, 589, 579, 578, 576, 587, 586, 585, 584, 583, 593, 102, 101
    101 North Barloque -> 38 Castle Victoria    102, 593, 583, 584, 585, 586, 587, 597, 598, 599, 2, 38

Outbound goes AROUND 598 by the Sentinel and the other Cragged Mountains (578); inbound
crosses 598 in the direction that works. Confirmed live against the running broker, not just
against the map: `map --to 101` from a character standing in Castle Victoria returns the
thirteen-hop route with 598 absent.

**The 49 consecutive `598 -> 597` refusals in the ledger were therefore not the router
asking for something impossible.** They were characters standing in 598 — put there by a
death, a recovery, or the Tos leg — being asked to leave the way they came in. Which they
cannot. `walkTo` falls back to the coarse grid when the collision view has no route, the
coarse grid happily offers the climb, and every step of it is refused: that is the whole
110-seconds-for-five-squares reading.

**Still open, and it is the honest gap:** a character stranded in the lower half of 598 has
no walking route out to the north, and nothing tells it so. `leaveViaAny` reports "every
square for that exit refused", which reads as a doorway problem. The room's own answer is
the other door — south to Ukgoth — and the keeper should take it rather than grinding at a
climb the model has already said is impossible. `UNREACHABLE_EXIT` exists for exactly this
shape and is matched on the message; a one-way room ought to be answering it from the bake.

---

# 2026-08-20 (later still) — THE ROUTER PROVED THE FALL IN ONE MODE AND THE MOVER ATTEMPTED IT IN ANOTHER

The operator's question was the right one: *why does the fleet deviate from its plan at all,
when the walls do not move?* Almost nothing about a room is dynamic, so almost every
collision could be — and already is — simulated in advance. So a deviation is a bug, and the
tax on it is real: every second above the minimum crossing time is a second something gets
another swing in.

**Measured against the theoretical minimum, which is not a guess.** A running character
covers five squares a second (`MOVEUNITS`/`MOVE_DELAY`, move.c:49,184), so the floor on any
exit-to-exit crossing is `planned squares / 5`. Driving the real `path`, `standPoint` and
`traceFineMoveClient` with the fine position carried forward, every room on the Castle
Victoria ↔ Barloque road, entered at the square the map says a body arrives on:

| | before | after |
|---|---|---|
| 38 -> 101, rooms crossed | 11/12 | **12/12** |
| 38 -> 101, whole leg | 105s minimum / one room impassable | **115s minimum, 129s walked — 1.12x** |
| 101 -> 38, rooms crossed | 9/10 | **10/10** |
| 101 -> 38, whole leg | 82s minimum / one room impassable | **106s minimum, 122s walked — 1.16x** |
| rooms at exactly 1.00x | 18 of 22 | **19 of 22** |

**Nineteen of the twenty-two crossings are now exactly the theoretical minimum: zero
deviations, one packet per planned square.** The three that are not are named below and both
of the remaining costs are understood.

**"Crossed" here means the direction the leg uses, not both ways.** Four of these rooms are
strictly one-way and that is exactly why the two legs are different roads — see the
bidirectional table at the end of this entry before quoting any of these numbers.

## The one thing that separated a good room from a bad one

    room                                    plan   jumps   walked   tax
    598 The Cragged Mountains  6,17->65,19    59      0       59     1.00x
    587 W. border Twisted Wood 8,66->46,67    64      0       64     1.00x
    576 The King's Way        128,71->115,87  45      0       45     1.00x
    578 The Cragged Mountains 46,18->1,13     48      4      FAILED  bouncing
    599 Ukgoth                4,63->1,27     119      1      FAILED  bouncing

**Every room that crossed at exactly the minimum had ZERO multi-square jumps in its plan.
Every room that failed had them, and the first deviation was always the first jump.**

## The mechanism, in three lines

`fallTargets` offers a two-or-three square drop only after proving it — but it proves it
with a different predicate from the one the mover uses:

    traceFineMoveClient(45,16 -> 43,16, { slide: false, fall: true })   ARRIVED
    traceFineMoveClient(45,16 -> 43,16, { slide: false })               blocked by wall 669
    traceFineMoveClient(45,16 -> 43,16, { slide: true })                blocked by wall 669, slid sideways

So the router planned a ledge the mover could not leave. The body slid along the cliff face
instead, the walker replanned into the same ledge, and room 578 bounced 45,16 ↔ 45,17 until
its budget ran out — **every crossing, in both directions, for as long as the room has
existed**. This is the repository's own rule — *the router must plan on the map the mover
enforces* — broken for exactly one kind of step.

**And the plan was throwing the flag away.** `neighbors` marks a drop `fall: true`;
`RoomGeometry.path` reconstructed its route from `came` keeping `row`, `col` and `dir` and
nothing else. So even a walker that wanted to ask could not: `next.fall` was `undefined`
everywhere. The flag is carried now, from `neighbors` through `came` and `steps`, into
`Session.step`, `queueValidatedMove` and `validateFineTarget`'s trace options.

## And a refused fall is a bad APPROACH, not a bad ledge

Threading the flag was not enough on its own, and the reason is worth writing down. The
proof is anchored at the take-off square's STAND POINT, and a body that slid into a corner
of that square is not on it. Sampled inside 578's 45,16: **36 of 64 points make the fall to
43,16 land correctly** — the ledge is fine and the body is in one of the other 28. From
there nothing works: no point in the landing square, no neighbouring landing square, and
`finePath` cannot even reach the take-off point. It is wedged against the cliff.

Learning the edge `45,16 > 43,16` — which is what the walker did — deletes the only way down
that room has. Learning the edge that BROUGHT US TO 45,16 sends the router at the same ledge
from a different neighbour, which puts the body on a different fine point, and most of them
work. Offline that single change turns 578's crossing from "bouncing" into an arrival.

## What is left, and it is two things

- **578 The Cragged Mountains, 2.40x.** Four jumps in a 48-square plan, and each one costs
  an approach that has to be re-learned. It arrives; it is not free.
- **599 Ukgoth entering from 598, 1.71x.** This is the crossing to the Castle Victoria
  doorway, and it is the one route on the road that still goes over ground the coarse grid
  calls solid — 119 squares against 154 for the honest way round. Pricing the clip higher
  helps it (2.36x at clip 0, 1.50x at clip 8) and does not fix it.

Everything else on both legs is 1.00x.

## What genuinely cannot be pre-computed

The operator's question deserves a short, honest list. Everything static — walls, floor
heights, slopes, water depth, which straight lines a body can complete — is in the `.roo`
and is already computed offline by `stringPull` at bake time. What is not:

- **A body in the way.** `blocksMovement` is the one collision that is not in the `.roo`.
  A troll standing on a pivot is not knowable in advance.
- **A room that animates.** `m59-mutable.mjs` names them and 598 is on the list — the Temple
  of Qor door cycles faster than the eight-second collision-invalidation window. A moving
  sector really does change the geometry the proof was taken against.
- **Where the body is when it arrives.** The proof is anchored at a point. A character
  dropped somewhere else by a death, a rescue, or a boundary that lands wide has to walk
  onto the spine first, and that first stretch is unproved. This is most of the residual
  tax, and it is why the exit-to-exit numbers above are so much better than a fleet-wide
  average: a character that dies halfway is not making an exit-to-exit crossing any more.

Nothing else. Every wall this fleet has ever slid on was static and already known.

## "EVERY ROOM CROSSES" MEANS EVERY CROSSING THE ROUTES USE — NOT EVERY ROOM BOTH WAYS

The table above walks the crossing each LEG requires, and 22 of 22 now succeed. That is a
weaker claim than "the room works both ways" and the difference matters, because the reason
the outbound and return legs are DIFFERENT ROADS is that four of these rooms are strictly
one-way. Asked the harder question — the same pair of doorways, forwards and back:

    room                                       A -> B                 B -> A
    599 Ukgoth   Castle Victoria <-> Sentinel   87 steps 17.4s 1.04x   NO ROUTE
    589 Under the shadow of the Sentinel        51 steps 10.2s 1.00x   NO ROUTE
    578 The Cragged Mountains                  119 steps 23.8s 2.38x   NO ROUTE
    598 The Cragged Mountains                   64 steps 12.8s 1.00x   NO ROUTE
    599 Ukgoth   Cragged Mtns <-> Castle Vic   206 steps 41.2s 1.69x   45 steps 9.0s 1.00x
    579 An ancient place                        88 steps 17.6s 1.00x   91 steps 18.2s 1.03x
    576 The King's Way                          46 steps  9.2s 1.00x   46 steps  9.2s 1.00x
    587 W. border Twisted Wood (both pairs)      1.00x                  1.00x
    597 The Twisted Wood                        64 steps 12.8s 1.00x   64 steps 12.8s 1.00x
    586, 585, 584, 583, 593, 102, 2             1.00x                  1.00x

**13 pairs work both ways, 4 work one way only, 0 neither.**

The four are `no route` — the ROUTER refusing, not the walker failing. They are the highland
rooms, and the asymmetry is gravity: `fallTargets` offers the drop and `enforceStepHeight`
refuses the climb back. That is the collision view being right where the coarse grid, which
knows nothing about height, cheerfully offers the same 59-64 squares in both directions.

Note that Ukgoth is one-way by ONE pair of its doors and two-way by another: the Castle
Victoria door reaches the Sentinel door and not the reverse, while the Cragged Mountains
door and the Castle Victoria door join in both directions. So "Ukgoth is one-way" would be
wrong too; the honest unit is the door PAIR, which is what `anchorReach` records and what
`transitOk` asks.

---

## The last mile into a safe spot: the fine grid is stricter, not better

The reasoning that led here is sound and the conclusion it produces is wrong, which is
worth writing down because it will be re-derived by the next person.

A safe wall **is** the coarse grid and the BSP disagreeing. That is not incidental — it is
the whole mechanism, and the reason the fleet seeks these squares out: the coarse grid
calls the square open, the BSP hems it in, and a monster's pathing cannot follow. From
which it follows, apparently, that the square router is the wrong tool for the approach and
the fine grid should own the last mile. `returnToSpot` half-knew it already: *"the square
router cannot express the last bit"* — but its fine step only ran AFTER `walkTo` had landed
on the square, so when the walk failed the fine tools never ran at all.

Measured over 107 approaches to nominated safe spots, in the eleven rooms this fleet uses,
starting from ordinary floor within ten squares:

| tool | reaches the wall | |
|---|---|---|
| `walkTo` | **91/107 (85%)** | the square lattice |
| `walkFine` | 74/107 (69%) | greedy fan of nine headings, slides on purpose |
| `finePath` | 25/107 (23%) | A* on the quarter-square lattice |

The square walker is the **best** of the three, and the tool that looks most like "plan the
last mile properly" is by far the worst. One line of `m59-finepath.mjs` explains it:

```js
if (Math.hypot(t.x - x1, t.y - y1) > ARRIVE_WITHIN) return null;
```

`moveLands` refuses any move whose slide ends more than 128 units off its aim, because an
edge that goes somewhere else is not the edge being put in the graph. That is correct for a
route across open floor and fatal here, because **a pocket the BSP hems in is a place where
every move slides**. The fine lattice has no edges at all in exactly the squares that make
a safe spot safe.

Two hypotheses were tested and disproved on the way:

- *Quantisation.* `finePath` steps in 256-unit increments and arrives within 128, so the
  nearest lattice point to an arbitrary goal can be 181 units away — outside the radius.
  Measured: goal-to-lattice distance median 0, max 89, **never** over `ARRIVE_WITHIN`.
  Snapping the goal to the lattice changed the result from 20/89 to 21/89.
- *Reach.* Maybe the hold picks walls too far away. A nearer wall IS reached more reliably
  (88% at four squares against 83% at ten) but is found so much less often that the share
  of characters ending up on any wall at all falls from 68% to 51%. `travel_hold_within`
  stays at ten.

Shipped: `Session.approachFine` is the sliding fan, and it is a **fallback** — worse on
average, +2 walls in the Cragged Mountains, free when the square walk works.

## walksim was dividing by the wrong number

`planLen` is the length of the FIRST plan, made before a single edge had been tried. So
"2.40x the theoretical minimum" measured how wrong that plan was, not how the walk went —
and a walker that never moved at all would score 1.00x. `simulateWalk` now also replans
from the start with everything the walk learned, which is the shortest crossing anybody
could have planned knowing what we now know, and `--why` prints both.

Measured, the two are nearly always equal. **The tax is the walker leaving a sound plan,
not recovering from a bad one** — which matters, because it points the fix at the route
book rather than at the planner.

Related, and smaller than it looks: asking the mover's own question of every planned leg
finds 6 impossible legs out of 707 in 578, and **zero** in 598 and 599. All six are the
same thing — the goal-exempt last step into an exit anchor:

```
(49,12)->(26,50)  leg 51/51  <-- LAST STEP (goal-exempt)
(1,13)->(35,1)    leg 36/36  <-- LAST STEP (goal-exempt)
```

The plan is sound to the doorstep and then asks for one square the mover refuses. `aimInto`
mitigates it at runtime. It is the same last-mile defect as the safe spots, at the other
end of the journey.

## The monorail was already the answer, and nobody had re-laid it

`m59-tracks.mjs` learns *"the quickest crossing anybody has actually walked, per room and
pair of doors, straightened against the baked BSP"*, and `rideTrack` consults it on every
hop. It is exactly the precomputed route the planner keeps failing to be. Four things were
wrong with it and none of them were the idea.

**Stale.** `substrate/m59-tracks.json` was baked on the 19th, and re-baking meant chewing
1.4 million samples for twenty minutes, so nobody did. `--since` fixes that, with the
spelling `m59-transits.mjs` already uses: `--since 6h` reads 88k samples in seconds and
learns 138 tracks from one afternoon.

**Thin.** 72 usable tracks across the two routes — 3 for 578 Cragged against 20 ordered
door pairs, 1 for 599 Ukgoth against 6. A full re-bake takes that to 115.

**Condemned.** A strike is filed under `room:from>to` — the pair of DOORS — so it outlives
the waypoints it was earned against, and every freshly learned track inherits the failures
of the one it replaces. 57 of 209 tracks were at or past `STRIKES_BEFORE_REJECT`, so a
better crossing learned this afternoon would have arrived pre-condemned and been refused on
its first ride, silently, while the book looked re-laid. `--save` now clears the record of
any crossing whose waypoints moved and leaves it where they did not.

**Unridable, which is the big one.** The book's own note says a track "cannot contain a
step the mover refuses". Checked with `straighten`'s exact predicate — the same `lands`
test, `protocolToClient` both ends, tolerance 40 — **105 of 321 tracks carry a leg that
fails it, 19.5% of all legs**, and in 578 The Cragged Mountains it is 14 legs of 18:

```
 14/ 18 legs refused  578:579>576    The Cragged Mountains
 14/ 19 legs refused  578:?>579      The Cragged Mountains
 14/ 22 legs refused  578:568>579    The Cragged Mountains
  8/ 20 legs refused  599:598>2      Ukgoth, Holy Land of Trolls
```

The cause is in `straighten` itself. When no long leg raycasts from the current anchor it
falls back to `best = anchor + 1` and pushes the next raw sample **without proving that leg
lands** — and consecutive trail samples can be seconds and several squares apart, around a
corner a straight line does not survive. `rideTrack` then sends each leg as a single
`stepFine`, fails, and falls back to `walkFine` groping between waypoints, which is the
exact behaviour the track existed to replace. So the monorail in the worst room on the road
is mostly not a monorail.

`comb` ranked on TIME ALONE, which is right about deaths — monsters wander, so dying says
nothing about a route — and silent about whether the route can be SENT. It now prefers the
crossing with fewer refused legs and lets time decide between equals, and a stitch that
would make ridability worse is discarded rather than taken for being shorter.

### Still open

- `straighten`'s fallback should not emit an unproved leg at all. Ranking around it is a
  mitigation; the fix is for it to either keep the intermediate samples that would make the
  leg raycast, or mark the leg so the ride goes straight to `walkFine` instead of spending
  a refused `stepFine` on it first.
- 578 may simply not have a ridable crossing in the samples we hold, in which case the
  answer is to walk one deliberately and bake it, rather than to keep re-combing trails
  recorded while characters were fighting.
