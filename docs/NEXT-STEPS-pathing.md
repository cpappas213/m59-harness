# NEXT STEPS — the safe-spot pocket trap

**Status: diagnosed, not fixed. The prod fleet is deliberately stopped.** Bringing it up
before this is fixed resumes losing a character roughly every five minutes.

Written 2026-08-16. Everything below was established by measurement or by watching a
character in the client; where something is inference it says so.

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

## The plan

### 1. Breadcrumbs — the escape (do this first)

Keep the last N validated fine moves per character. On a route-out failure, **replay them
in reverse**.

This is safe for a reason that matters: every step being replayed was already accepted by
the fine validator on the way in, so it **cannot invent an impossible traversal** — it can
only undo one. If a character reached a pocket by a route that should not have been legal,
the breadcrumbs walk it back out the same way and the trap closes without widening the hole.

### 2. A negative-assertion suite — `m59-impossible-test.mjs`

**The existing 153 collision assertions are all positive** — the documented Brownestone,
Limping Toad, Icky, Farol, Ukgoth, Cor Noth, Temple and Fey cases assert that legitimate
moves *remain usable*. Almost nothing asserts the opposite polarity, so **the suite passes
cleanly on the day the walls stop working**. That is the failure the collision bake exists
to prevent, and it is the untested half.

Each case is a `traceFineMoveClient` against the baked geometry asserting **refusal**, no
server needed:

- King's Way -> Cragged Mountains -> Castle Brax
- Icky Cave -> Island, without dispel magic
- Upstairs Castle Victoria, far west -> far east without using the door
- every sealed room in Castle Victoria, doors excluded
- Under the Shadow of the Sentinel -> Ukgoth -> Twisted Woods (the cliff climb)

**Observation cannot be the oracle here.** Players legitimately appear to phase through
walls from another client's view — lag compensation — so "I watched it happen" proves
nothing about legality. Assert against our own validator.

### 3. Promote the safe-spot book to a destination

`substrate/m59-safespots.json` already holds **920 squares recorded as held**, with
`free_shots` per square, and nothing uses it as a *target*. Make `flee` and `rest` ask it for
the nearest held pocket instead of searching from scratch.

The mechanism is real and is the strongest defensive move available: `Monster.CanReach`
calls `Room.LineOfSight`; `Player.TargetWithinSightAndRange` **never does**. Wedging into
unreachable geometry when hurt is correct play, not a bug. Once (1) exists, getting out is
solved, so the pocket becomes a tactical asset rather than a trap.

### NOT this: a coarse-grid escape hatch

Considered and **rejected**. Falling back to the server's walkable grid to escape a pocket
would relax collision *precisely where the two grids disagree most* — which is the mechanism
that let bots climb cliffs and cross map boundaries no client can. The concern was never
that a bot slips a little too deep into a safe spot; it is that bots have done traversals a
human player cannot. Do not reopen that.

### Out of scope for now

The jump in *"Ancient Place, its origin forgotten"* to reach the mana node. That is Z-axis
ballistics with fall limits; what is baked is sector heights, slope and water depth for
*stepping*. Teaching a jump while characters cannot reliably leave a corner is the wrong
order of work.

## How to know it worked

```bash
node tools/m59-trace.mjs --seconds 60 --interval 15
```

Read-only, no restart, ~1 minute. Success is precise:

- `maxblock` **stops climbing** (it currently tracks broker uptime — the first pass never ends)
- `passes` **advances** for everyone, not just the character that never left its safe spot
- the `WEDGED` section empties

The control case all session was **Bunsen**: the one character *holding* a safe spot rather
than trying to leave one, running 8 passes and killing while 17 others were stuck.

## State as of writing

- prod broker **down**, 0 sockets, roster intact at 21 slots, **deaths 325 and flat**
- arena fleet on the local server (`127.0.0.1:15959`) is the test bed — 6 throwaway
  characters, TESTER/Alpha/Bravo/Charlie/Delta/Echo. **Reproduce there, never on prod.**
- launchers for watching in the client: `shortcuts/arena-*.bat` (gitignored). Note the
  committed `m59-shortcuts.mjs` writes `127.0.0.1:5959` for every character — **wrong port
  for the local server and wrong host for prod** — and takes no `--fleet`. Worth fixing.
- room 587 reproduces the wedge on demand: travel a character from 60 to 544.
