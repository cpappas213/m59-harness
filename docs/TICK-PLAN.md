# The real-time bot: a tick loop over pushed state

**Status: the core is built and green offline; nothing drives a character with it yet.**
This is the plan for the next iteration. Read `docs/HANDOFF.md` first for the GOAP
layer it reuses, and `CLAUDE.md` for the rules that outrank everything here.

---

## 0. Where we are

Three drivers now exist in the tree. Only the first runs the fleet.

| | file | state |
|---|---|---|
| the ladder | `m59-autopilot.mjs` | **drives every character today.** 13,196 lines |
| GOAP-in-the-ladder | `m59-keeper-goap.mjs` | opt-in via `policy.useGOAP`, a branch INSIDE `pass()` |
| the tick loop | `m59-tick.mjs` + `m59-decide.mjs` + `m59-route.mjs` | **built, tested, wired to nothing** |

The first two share a defect that is architectural rather than a bug:

```
loop { ws = evaluate(client); plan = planFor(ws); await stepPlan(...) }
```

Sensing happens only at the top of a pass and the act phase blocks the next one, so **how
often the agent looks at the world is decided by how long it spent not looking**.
Measured across 11,854 GOAP passes on this fleet: median 80ms, p99 16.6s, worst 207s.
82% of deaths had the keeper blind at the moment of death.

---

## 1. The facts this rests on — each verified, not assumed

- **The server pushes everything we need.** `BP_MOVE` writes our own position into
  `room.objects` with `predicted` cleared; `BP_STAT` carries vitals, vigor and ability
  levels; `BP_USE_LIST`/`BP_USE`/`BP_UNUSE` carry equipment. `client.vitals()` and
  `client.self` are in-memory reads.
- **The sense and decide halves were ALREADY synchronous.** `Session.snapshot()`,
  `view()` and `perception()` are not even declared `async`. `evaluate()` and `planFor()`
  are synchronous. Nothing in sense-or-decide ever needed to block.
- **Only actuation blocked**, and mostly for nothing: `confirmPosition()` sends
  `roomContents()` and waits up to `CONFIRM_DEADLINE_MS` (8s) to learn a position the
  server had already pushed. Live, one step cost 7.2 seconds that way.
- **The collision model is baked into `substrate/`.** With `M59_ROOT` explicitly unset:
  `sharedRoomGeometry(map.rooms[1012])` returns geometry with `collisionReady: true` and
  a step mask attached, and `geo.path(24,42 -> 8,44)` returns a **16-step route** —
  which is JayB's real route to the Mausoleum staging square, around the fence.
  **Motion planning needs no game install and no server.**
- **`M59_ROOT` is on this machine** at `/Users/costas/Documents/Projects/Meridian59`
  (265 `.roo`, 1,232 `.kod`). Worth exporting for kod citations and the compendium; it
  is NOT required for routing.

---

## 2. The model

```
every 100ms, never blocking:
  frame  = sensor.read()        // free: pushed state only, sends nothing
  intent = decide(frame)        // pure, synchronous, no awaits
  actuate(intent)               // enqueue one command; do not await
```

### The five rules (enforced by `m59-tick-test.mjs`, 29 assertions)

1. **A tick never awaits an actuation.** A `decide()` returning a promise is reported and
   NOT awaited — awaiting it restores the blocking loop while every counter still reads
   "tick".
2. **The sensor never sends.** Built on `snapshot()`/`perception()`, never `view()`,
   which runs A* per object: a sensor that slowed as the room got busier would put us
   back where we started.
3. **Effects are observed, not returned.** The actuator reports what it SENT. Whether it
   worked is the next frame's question. This makes *"no error has never meant success"*
   structural rather than remembered — there is no return value left to misread.
4. **The tick rate is fixed.** Latency changes when a command lands, never how often we
   look.
5. **A slow decide skips.** A backlog of decisions is a backlog of decisions about a
   world that is gone.

### Ticks are a sampling cadence, not a simulation step

**We do not integrate.** A game engine needs `dt` because it carries state forward
(`position += velocity * dt`). We carry nothing: the server owns position and pushes the
result. A dead-reckoned copy would be a second, wrong world.

**Therefore every duration is WALL CLOCK, never a tick count.** Ticks coalesce under
load — measured, a 60ms decide at 100hz yields ~4 ticks in 250ms, not 25 — so anything
counted in ticks stretches exactly when the loop is already struggling. This rule was
broken once already (`skipFor = 30` ticks in the decider) and is now `skipForMs`.

The frame carries `dt_ms` anyway, for observability: a frame 2s after the last means we
were blind for 2s, and some decisions deserve to know.

---

## 3. What is built and green

| file | assertions | what it is |
|---|---|---|
| `m59-tick.mjs` | 29 | `Sensor`, `Actuator`, `TickLoop` |
| `m59-decide.mjs` | 19 | `evaluate` → `planFor` → `intend`, synchronous |
| `m59-route.mjs` | 20 | a route as STATE: destination + leg, one step per tick |
| `m59-watchdog.mjs` | 16 | the out-of-band guard, hosted by either driver |
| `m59-tick-run.mjs` | — | run one character; **ran JayB at 9.8 ticks/s, longest decide 4ms** |

The live run is the number that matters: **737 ticks in 75s, 0 skipped, 0 errors, longest
decide 4ms**, against the old model's p99 of 16.6s.

---

## 4. What is missing, in order

### 4a. MOTION PLANNING — the next piece, and the reason for this document

**The mover is not proven and must not be built on.** `walkTo`/`stepFine` carry
`_bruteForceExit`, "TRULY STUCK", and a `confirmPosition` that blocks 8s. Upstream
measured **218 of 311** centre-to-centre steps failing in room 587, 92% of them not
moving the character at all.

**And the naive alternative is worse.** The first tick router computed
`me.col + sign(target.col - me.col)` — a beeline — and walked JayB into a fence, where he
stood re-sending the same refused step. Watched from the client; invisible in the log.

The fix is to plan on the model the mover enforces, which is present and free:

1. **Plan.** `geo.path(fromRow, fromCol, toRow, toCol)` — A* that consults
   `moverStepLands`, which is an **array index** when a step mask is baked
   (`attachStepMasks`, 264 rooms). Produces a route that can actually be walked.
2. **Verify.** `moverStepLands(from → to)` before every send. A step we cannot justify
   is never sent.
3. **Learn.** If the pushed position does not change after a step we believed in, record
   that edge in `blockedEdges` — which `geo.path()` already accepts — and replan. **A
   fence becomes knowledge instead of a thing we retry for ever.**

Tested against **synthetic** `RoomGeometry` fixtures (`m59-collision-test.mjs` already
builds them), so the planner is tested rather than one server's map.

**Two traps to keep:**

- **EXITS ARE NOT 1:1.** Where you arrive is not where the return edge is, so a leg is
  recomputed on every room change and never reversed or remembered.
- **`exits()` IS EXPENSIVE.** It runs flood fills; its own comment records one call
  taking tens of seconds. It runs on a room change only, cached as the leg. Per-tick cost
  must stay arithmetic.

### 4b. THE HUNT GOAL — "why do I have to assign a destination?"

Right now `m59-tick-run.mjs --to 1016` is a **test harness**, not the design. The decider's
`DEFAULT_GOALS` are survival-shaped only (healthy / armed / vigor / food), so a healthy
armed character correctly reports `idle — nothing to do`.

The automatic half is a goal that picks a hunt room from the spawn index and hands it to
the router — the job `m59-keeper-goap.mjs` does with its hunt-room selection. Port it as
a goal whose `when` is "nothing better to do" and whose action is a destination.

### 4c. THE SURVIVAL FLOOR ON THE TICK DRIVER

`m59-watchdog.mjs` already takes a host interface and `m59-tick-run.mjs` already starts
it. What is missing is the rest of the first row of CLAUDE.md's split — **mortality and
recovery**: death, the Underworld, and `passPlaybook`'s three moments. None may be left
behind when a character moves to this driver.

### 4d. WIRING, ONE CHARACTER, BEHIND A FLAG

`m59-keeper-process.mjs` constructs `autopilotFor(session)`. Add a mode that constructs
the tick driver instead, per character, opt-in. The legacy keeper stays the default and
the fallback.

### 4e. ONLY THEN: DELETE FROM THE MONOLITH

`m59-autopilot.mjs` has gone 13,355 → 13,196 (the watchdog extraction). Until a concern
is **removed** from it, this is a parallel implementation rather than a migration — the
repo's own working agreement. The first honest deletion is whichever lifecycle concern
the tick driver covers end to end.

---

## 5. What is unproven

Stated plainly, because "the design is coherent" and "the design works" are different
claims and only the first is fully supported.

- **The tick driver has never fought anything.** It has sensed, planned and idled live at
  9.8hz. It has never swung, eaten, fled or died.
- **The router has never completed a journey.** It planned, and it walked into a fence.
- **One tick of staleness is accepted, not measured.** The collision validator reads the
  latest pushed position, which may be one tick old. The server is the authority and
  refuses illegal moves silently, so the cost of being wrong is a tick — but nobody has
  counted how often it is wrong.
- **No character has run on this for an hour.** Every number above is minutes.

---

## 6. Live bugs found on the way, still open

- **`FOOD_RE` matches `\bmushroom\b`**, so `pickFood` feeds the fleet its farmed loot.
  Policy question, not an atomic bug — left for a decision.
- **`m59-backup.mjs --credentials-only` cannot run on this machine.** It defaults to
  `C:\m59\backups` and `D:\m59\backups`, which are treated as relative paths inside the
  repo and refused. One tool also defaults `M59_ROOT` to `'C:/code/meridian59'`. Same
  family: Windows defaults on a darwin machine, failing at the moment they are needed.
- **`m59-keeper-goap.mjs:resolveMapRoom` trusts a colliding room number.** It returns
  the live id whenever it happens to be a map key, without checking the name — and live
  ids collide with unrelated map numbers (JayB in "Raza", live id 2013, which is map room
  "The East Tower"). `m59-route.mjs:resolveRoomNum` does it correctly: objId table, then
  name, then the raw number last.
- **~10 orphaned suites** from the discarded BT keeper still fail, and the delegation
  ratchet is red because of them.

---

## 7. Definition of done for this iteration

1. `geo.path`-based motion planning, tested against synthetic geometry, that routes
   around an obstacle and records what it learns.
2. JayB completes a journey to the Raza Mausoleum on the tick driver, watched.
3. A hunt goal, so no destination has to be assigned by hand.
4. The survival floor complete on this driver.
5. One character running it for an hour, with the pass-duration distribution measured
   the same way as the baseline in §0.
