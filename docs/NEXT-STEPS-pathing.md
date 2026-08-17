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
