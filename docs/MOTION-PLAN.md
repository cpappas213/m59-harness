# Motion planning for Meridian 59 — a specification

**For someone picking this up cold.** You do not need the rest of this repository's
history. You need this file, and the four commands in §2 that let you reproduce every
claim in it yourself. If a claim here is wrong, the command that produced it is given so
you can prove it wrong rather than argue about it.

**Scope: get a character from where it is to somewhere else, legally and reliably.**
Nothing about combat, economy, or the decision layer above.

---

## 1. The one thing to understand first

**MERIDIAN 59 IS CLIENT-AUTHORITATIVE FOR MOVEMENT.** The server does not check where you
say you are. It records it.

Measured on the live server, 2026-08-20:

```
asked 41,23 -> 41,19   ( 4 squares)   landed 41,19   1393ms
asked 41,19 -> 41,29   (10 squares)   landed 41,29   1288ms
asked 41,29 -> 65,29   (24 squares)   landed 65,29   1283ms   <-- one packet
```

A 24-square jump in a single packet, granted exactly, in the same wall-clock time as a
four-square move. We also moved a character INTO a wall (`fineWalkable == false`) and out
again; both were accepted without complaint.

The codebase already said so, in `m59-game.mjs` `stepFine`:

> *"VALIDATE BEFORE SENDING. The server accepts player coordinates; a room read is
> confirmation of state, never a collision oracle."*

**Three consequences, and they define the whole job:**

1. **There is no oracle.** No refusal to learn from, no failure to detect, no "the server
   said no". Any design built on reacting to server rejection is dead on arrival — this
   was tried in an earlier draft and removed.
2. **Collision is entirely ours.** If we do not enforce geometry, nothing does, and the
   character walks through fences.
3. **Speed is entirely ours.** If we do not rate-limit, we are cheating.

**AND THE SERVER DOES NOT PUSH OUR OWN POSITION.** Three consecutive landed moves produced
zero events and left `client.self` unchanged; only `session.confirmPosition()` (a
`roomContents` round trip) revealed the new position. Reading `client.self` after sending
a move tells you where you *were*. This surprises everyone; it cost this project two
wrong architectures.

---

## 2. Reproduce it yourself

```bash
# offline: compare the planners against each other. No server, no game install.
node tools/m59-motion-probe.mjs --room 1012 --pairs 14 --seed 3

# live: what does the server do with a move? (bumps a broker off that character)
node tools/m59-move-probe.mjs --agent t3 --moves 70 --settle 300 --i-mean-it
```

`M59_ROOT=/Users/costas/Documents/Projects/Meridian59` gives you the game source (265
`.roo`, 1,232 `.kod`) for citations. **You do not need it for motion planning** — the
collision model is baked into `substrate/` and loads with the variable unset.

---

## 3. The two obligations

### 3a. Enforce geometry — with the FINE model, never the coarse one

The coarse grid is a server artifact and it does not contain the walls. In Raza:

```
wall segments:                 760   impassable: 466
non-standable squares:           0   <-- the coarse grid sees NO walls at all
cells fineWalkable() == false: 280 of 1792   (15.6%)
```

A fence is a wall **segment between** squares, not a blocked square. Anything planning on
`standable()` is planning on a map with the walls deleted.

**This is the single most important pitfall in this document**, because the two obvious
APIs are both built on the coarse grid:

| API | uses | verdict |
|---|---|---|
| `geo.path(r,c,r2,c2)` | coarse squares, `moverStepLands` | **blind to segment walls** |
| `geo.moverStepLands(...)` | `standable()` + trace | partially blind |
| `geo.fineWalkable(r,c)` | wall segments, 256-unit player radius | **use this** |
| `geo.traceFineMoveClient(x0,y0,x1,y1)` | the real collision trace | **use this** |
| `geo.finePathProtocol(fx,fy,tx,ty)` | A* over the fine trace | correct but see §5 |
| `geo.stringPull(points)` | smooths, verifying each leg with the trace | **use this** |

**The player is a CIRCLE of radius 256 fine units**, not a point (`fineWalkable`). That is
why square centres are the wrong thing to aim at, and why a square whose centre is clear
can still be untraversable.

### 3b. Move at a legal speed

From the game's own client source:

```c
FINENESS   = 1024            // clientd3d/drawdefs.h:42   client units per square
MOVEUNITS  = FINENESS >> 2   // clientd3d/draw3d.h:53     = 256 units
MOVE_DELAY = 100             // clientd3d/move.c:49       ms between MOVEUNITS
move_distance = MOVEUNITS        // walking
move_distance = 2 * MOVEUNITS    // running        move.c:184
// wading scales by 3/4, 1/2, 1/4 with depth      move.c:196-201
```

| | per 100ms | per second | protocol units per 100ms |
|---|---|---|---|
| walking | 0.25 squares | 2.5 squares | 16 |
| running | 0.50 squares | 5.0 squares | 32 |

**`MOVE_DELAY` is 100ms, so the real client's movement loop is a 10hz tick.** This
repository's `TickLoop` (`tools/m59-tick.mjs`) already runs at 10hz, so **one tick is
exactly one legal move step**. Enforce the budget as "at most one `MOVEUNITS` per tick"
and no separate accounting is needed.

Note the protocol/client unit split: `KOD_FINENESS = 64` per square on the wire,
`FINENESS = 1024` in the client. `client.self.x/.y` and `client.moveTo(x,y)` are
**protocol** units; `traceFineMoveClient` takes **client** units. `protocolToClient()`
converts. Getting this wrong silently plans in the wrong scale.

---

## 4. What to build

A `MotionPlanner` that, given a destination in the current room, produces the next
legal move each tick.

```
plan(from, to)        -> waypoints, verified by traceFineMoveClient
nextStep(now, budget) -> ONE move of at most MOVEUNITS toward the current waypoint
observe(position)     -> advance/replan; position comes from confirmPosition, not self
```

Requirements:

1. **Plan on the fine model.** `traceFineMoveClient` decides whether a leg is walkable.
2. **String-pull the result.** Few waypoints, each verified. `stringPull` reports
   `unverified` — a path with unverified legs must not be treated as verified.
3. **Never exceed the budget.** At most `MOVEUNITS` (or `2 * MOVEUNITS` running) per
   100ms tick. A waypoint is somewhere to walk toward, not a place to appear.
4. **Position is polled, not pushed.** Decide how often to confirm; every step is
   correct but expensive (`CONFIRM_DEADLINE_MS` is 8s in the worst case), and never is
   wrong. Dead reckoning between confirmations is legitimate — objects carry a
   `predicted` flag for exactly this.
5. **Refuse honestly.** "No route" and "route hit the search cap" are different answers
   and must not both be reported as not-found (see §5).

---

## 5. What has already been tried and does not work

Do not spend time rediscovering these.

- **Beeline stepping** (`me.col + sign(target.col - me.col)`). Walks into fences and
  re-sends the same refused move for ever. Watched live.
- **Learning from server refusals.** There are none. See §1.
- **`finePathProtocol` as the primary planner.** Measured across 40 pairs in 5 rooms: it
  found a route in **40%** of cases against the coarse planner's **72.5%**, never found
  one the coarse planner could not (`fine-only: 0`), and cost **median 168ms, p90 1278ms**
  with the node cap hit 4 times. It exhausts `maxNodes: 20000` on room-crossing distances
  and returns "not found", which is indistinguishable from genuinely unreachable. It is
  excellent for SHORT legs — it short-circuits to **1ms** when the straight line is clear.
- **Coarse corridor + `stringPull` as-is.** Looked perfect in one room (2.0 points, 0
  unverified) and fell apart across five (22.0 points, **178 unverified legs**). The idea
  may still be right; the naive version is not, and the failure is invisible unless you
  check `unverified`.
- **Waiting for a `moved` event after sending.** The packet never arrives. See §1.
- **`walkTo`/`stepFine` as a foundation.** They carry `_bruteForceExit`, a "TRULY STUCK"
  path, and an 8s blocking confirm. They work, and they are compensations for never having
  planned on the right model. Use them as a reference, not a base.

---

## 6. Traps that will cost you a day

- **`standable()` is blind to walls.** §3a. This is the big one.
- **Protocol units vs client units.** §3b.
- **A SITTING CHARACTER IS REFUSED EVERY MOVE, SILENTLY** (`PFLAG_NO_MOVE`). From outside
  it is indistinguishable from a collision refusal. Stand first. This produced a 120/120
  "did not move" result that looked like a geometry catastrophe.
- **A MOVE IS NOT INSTANTANEOUS.** The server walks the body at `speed`. A fixed short
  settle reads position mid-stride, and every sample lands on the PREVIOUS target — an
  off-by-one that reads as "moved but never arrived" for every move. Confirm until
  position stops changing.
- **THE LIVE ROOM ID IS NOT A MAP NUMBER, AND THEY COLLIDE.** A character in "Raza"
  reports live id 2013, and map room 2013 is "The East Tower" — a real room on the other
  side of the world. Resolve with `resolveRoomNum()` in `m59-route.mjs` (objId table,
  then name, then the raw number LAST). `m59-keeper-goap.mjs:resolveMapRoom` gets this
  wrong: it trusts the raw number whenever it happens to be a map key.
- **`exits()` is expensive.** It runs flood fills; its own comment records one call taking
  tens of seconds. Cache it per room, never call it per tick.
- **EXITS ARE NOT 1:1.** Walking A→B does not put you where the B→A edge is. Recompute on
  every room change; never reverse a leg.

---

## 7. Testing

**Offline, against synthetic geometry.** `tools/m59-collision-test.mjs` already constructs
`new RoomGeometry({file, version, rows, cols, grid, flags, walls, ...})` by hand. Build
fixtures rather than depending on one server's map — in particular a room whose square
CENTRES are all clear but which has an impassable segment across the middle, because that
is the case the coarse planner gets wrong and the whole specification turns on.

**Live**, `tools/m59-move-probe.mjs` measures what the server actually did. It is safe:
single moves, no combat, no purchases.

---

## 8. Definition of done

1. A planner that routes around a segment wall in a synthetic fixture, verified by
   `traceFineMoveClient`, with a test that fails if it plans through the wall.
2. Never exceeds `MOVEUNITS` per 100ms, with a test that fails if it does.
3. Reports "no route" and "search exhausted" as different answers.
4. A character completes a real journey across a room containing a fence, watched.
5. The offline probe (§2) shows a route-discovery rate at least as good as the coarse
   planner's 72.5%, with zero legs the fine trace rejects.

---

## 9. Open questions — genuinely unknown, worth deciding early

- **How often must position be confirmed?** Every step is correct and expensive; the
  right cadence is unmeasured. What is the drift between dead reckoning and truth after
  N ticks?
- **Is any wall a trap?** We walked into one wall and out again. One wall.
- **What does the server do about a body inside geometry** over a longer period — for
  monsters' line of sight, for other players, for the room's own logic? Unknown.
- **Should the planner refuse to enter `fineWalkable == false` ground at all**, or treat
  it as high-cost? A character can end up there by other means and must be able to leave.
