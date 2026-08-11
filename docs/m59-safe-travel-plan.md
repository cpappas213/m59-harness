# Safe-spot-aware travel — a plan

Travel is where this fleet dies. Eight of thirteen deaths in the last day happened while
`travelling`, and **not one happened while fighting**. This is the plan for the only fix
that can work, and an argument for why the obvious alternatives cannot.

Status: the seam is built (`onHop`, below). The behaviour described here is not.

---

## What we measured first

From the transit book, prod-scoped: 12,600 crossings, 3,059 journeys.

| | |
|---|---|
| one room crossing | median **8.9s**, p90 17.6s, p99 32.7s |
| of which walking | **99.9%** (routing and exit choice are 8ms) |
| journey | median **3 hops / 24.8s**, p90 **10 hops / 87s**, p99 181s, worst 657s |
| journeys longer than the keeper's own 8s resync | **85%** |
| hops that fail outright | 6.2% — median 8.1s wasted, p90 29s |
| hops needing more than one exit square | 10.7% |

## Three things that cannot fix it

**Walking faster.** `walkTo` already coalesces up to 8 collinear squares into one packet
and paces to 5 squares/second, which is the real client's speed. That pacing is deliberate:
`prod` is a shared server with human players on it, and moving faster than a person can
move is speedhacking and is visible as such. ~9s a room is a floor.

**Abandoning the journey.** A character that gives up between two towns is not safe — it is
stranded in a worse room than either end, with the same walk still ahead and less health to
do it with. The journey has to complete.

**Avoiding the danger.** There isn't a safe route. Every second inside a map is a second
something can reach you; that is what the transit book measures and why crossing time is
the number worth having.

## The one thing that can

**Safe spots are the only place outside a town where health comes back without a fight.**
The asymmetry is real and cited: `Monster.CanReach` calls `Room.LineOfSight`
(`monster.kod:1782`); `Player.TargetWithinSightAndRange` (`player.kod:4115`) never does. A
square whose line to a patch of floor is broken, while that floor is still inside weapon
range, lets you hit what stands there and take nothing back. Only lich and revenant ignore
walls (`AI_FIGHT_THROUGH_WALLS`).

So: **travel does not stop being dangerous, it gains somewhere to stop.**

---

## Is it affordable?

Recovery is priced by the server, `CalculateHealthTime` (`player.kod:5611`), and the
answer decides the whole design. Seconds to regain 15 health on a 44-max character:

| vigor | cost | against a p90 journey of 87s |
|---|---|---|
| 80 (the resting cap) | **87s** | doubles it |
| 130 | 46s | half again |
| 200 | 26s | cheap |

**Vigor gates the hold, not just health.** At the resting cap a top-up costs as much as the
entire journey, and the character is exposed the whole time. This is the same vigor economy
that already runs the fleet — and it means a hold is a thing a *fed* character can afford
and a starving one cannot.

## The trap that would make it do nothing

`HealthTimer` only awards a point if `PFLAG_MOVED_SINCE_ENTRY` is set (`player.kod:2639`).
**Walk into a room, stand still, and you regenerate nothing, for ever** — one of ours sat in
an inn at 5 of 26 and rested twenty-nine times without gaining a point.

Walking to a safe spot sets the flag, so the design below is safe *because* it walks. A
"just stop where you are" variant would look identical, cost the same time, and heal
nothing. Any implementation must not shortcut the walk when the character happens to be
standing on a good square already.

---

## The design

### The seam (built)

`Session.travel` takes `onHop`, awaited once per room, after the arrival settle and before
the next exit is chosen. It is a **pause point, not an abort**: the return value is ignored
and the journey always continues. A hook that throws is logged against the hop and the walk
carries on — a character halfway between two towns is the worst place to discover a bug in
a hook. `Autopilot.travel` is the single funnel all eight `s.travel(...)` call sites go
through, and it already writes a frame per room there.

### 1. When to hold

At a hop boundary, hold if **all** of:

- health is below `holdBelow` (start at 0.75 — above `fleeBelow`, because the point is to
  never reach the flee line mid-journey), **and**
- vigor is high enough for the recovery to be worth the exposure (start at 100 — below
  that, walking on is genuinely better than standing still), **and**
- there is more than one hop left (arriving hurt is fine; the destination is a decision
  someone else made), **and**
- a spot exists in this room, **and**
- nothing is already in reach of us — if something is, this is a fight or a flight, and
  `pass()` handles both better than a hold does.

### 2. Where to stand

`nearestSafeSpot(geo, from, { book, room })`. Measured: **all 264 rooms have geometry, 13
of the 16 busiest transit rooms yield a spot, at 3.6ms**. Cost is not a concern.

**But the book is empty for every one of them.** It holds 29 rooms, all places the fleet
*fights*; a spot in a transit room is derived from walls and has never been stood on. So a
travel hold is acting on a geometric guess, and the plan has to say what that is worth.

### 3. How long

Until `holdUntil` — health back above a resume threshold (0.9), or a cap, whichever first.
The cap matters more than the threshold: **3 minutes**, matching the existing hold cap, and
tighter when vigor is low because the arithmetic above says the points will not come.

Abort the hold early and walk on if damage lands while held. A spot that is being hit is
not a spot, and the walk is the better of two bad options at that point.

### 4. Resuming

`leaveHold` currently **refuses a discretionary departure below the rest threshold**, which
is correct for roaming and wrong here: continuing a journey the fleet asked for is not
discretionary, and refusing would strand the character at the wall — the exact failure this
plan exists to avoid, arrived at from the other side. Travel's resume must pass `force`, or
be a recognised kind that `m59-commitment.mjs` knows has another end.

---

## What it must not do

**Travel failures DO discredit, and they are tagged.** *(This reverses an earlier draft of
this document, which said travel outcomes should be kept out of the fight book. That was
wrong twice over.)*

It was wrong on the facts: the book writes go through `this.hold`, and a travel hold calls
`takeSafeSpot`, which sets `this.hold` — so travel outcomes were already being written by
construction. The document described a separation the code did not have.

It was also wrong on the merits. A square that let a blow through is a bad square whether
the character was fighting from it or resting at it part-way through a journey, and the
asymmetry that governs this whole book applies unchanged: **being wrong about a bad square
costs a character, being wrong about a good one costs a walk to the next corner.**

What is true is that the two are not the *same* evidence — a travel hold happens in a room
nobody chose, with whatever followed you through the door, on a wall derived from geometry
that has never been stood on. So the verdict is kept and the judge is recorded:
`failed_via` / `held_via` name the most recent one and `failed_by` / `held_by` count them.
A square that holds twice in fights and fails once in travel reads as exactly that, and the
travel-only rejections can be fished back out with one filter:

```js
book.list(room).filter(r => book.discredited(r) && r.failed_by && !r.failed_by.fight)
```

Records written before the tag existed carry no `failed_by` and are untouched — they read
as they always did rather than defaulting into anybody's pile.

**It must not hold in a room it is passing through in one square.** Some hops are two steps
across a corner. Holding there costs the walk to the wall and back for nothing.

**It must not turn a journey into a residence.** Total held time per journey needs its own
cap, or a ten-hop route through hostile ground becomes half an hour.

---

---

# The A/B — running now

Shipped as an experiment rather than as a change, because standing still in a hostile room
is not obviously safer than walking through it and nothing offline can settle it.

## The outcome is deaths. Only deaths.

This is the part that decides everything else, and the obvious metric is the wrong one.

**The hypothesis players state is that fighting from a wall means you take MORE damage and
die LESS.** If that is true, then any measurement built on damage taken shows the treatment
arm looking *worse* exactly when it is working, and the experiment rejects the one
intervention worth having. Health lost is n=5,091 segments a day and beautifully powered,
and it is still the wrong question.

So: deaths, and damage demoted to a **mechanism check**. If the holding arm is not taking
more damage, the holds are not engaging and nothing is being tested.

The price of that choice is time, and the tool says so on every run. Travelling deaths run
at about **one per 1,180 journeys**. Detecting a halving needs ~30 deaths in the control
arm; at ~6,800 multi-hop journeys a day, split two ways, that is the better part of a week.
A two-hour read is not a result and `m59-travel-ab.mjs` refuses to call one.

## Randomised per journey, not per character

The twenty-one characters differ by max health, hunting ground and strategy, so a split by
character would be confounded by all three and would need modelling to undo. Per journey,
every character contributes to both arms and the differences cancel.

The arm comes from a hash of `character-pass-timestamp`, so it is stable within a journey
and reproducible from the record.

> **A bug worth recording.** The first version took the low bit of FNV-1a. FNV-1a's last
> step multiplies by an odd constant, and the low bit of a product with an odd number is
> just the low bit of the other operand — so the arm was `(running hash) XOR (last
> character)` and nothing else in the seed reached it. Seeds differing only in their final
> character alternated arms in lockstep. In production the seed ends in a millisecond
> timestamp, so **the split would have looked perfect at 50/50** while the experiment was
> actually randomising on one bit of the clock, with the character and pass contributing
> nothing — and any later change to the seed's tail could have frozen every journey into a
> single arm without the split looking any different until the deaths came in. Fixed with
> an fmix32 avalanche; pinned by `m59-travel-ab-test.mjs`.

## The two arms

Both arms evaluate the same gate at every interior hop boundary and both write down what
they found. A control arm that records nothing gives you a comparison between "journeys
where we held" and "all journeys", which is not a comparison.

| | |
|---|---|
| **walk** (control) | records the moment and the wall it would have used, then walks on |
| **hold** (treatment) | `takeSafeSpot` → `restUntil(0.9, cap 90s)` → `leaveHold(force)` → carries on |

A moment is a candidate only when health is under 75%, vigor is at least 100, there is more
than one hop left, and nothing is already in reach. Each refusal states its reason, because
a gate that silently never fires is an experiment that measures nothing.

## Guardrails

- **180s of holding per journey**, total. A journey that keeps stopping never arrives.
- **90s per hold**, and `restUntil` aborts on damage — a wall being hit is not a wall.
- **Travel verdicts count, and say who made them.** The journey itself is recorded in the
  ledger as `travel_pause` / `travel_hold`; a square that fails under a travel hold is
  discredited permanently, exactly as a fight failure is, and tagged `failed_by.travel` so
  the travel-only rejections stay fishable. See the guard above for why keeping them out
  was the wrong instinct.
- **Kill switch with no restart**: `autopilot` tool, `travel_hold: off | observe | ab`.

## Reading it

```bash
node tools/m59-travel-ab.mjs            # deaths per 1000 journeys, by arm, and whether to believe it
node tools/m59-travel-ab.mjs --hours 72
```

Deaths are joined to arms through `summary.travel_arm`, which the keeper stamps for as long
as a journey is in flight. Deaths off a journey are excluded rather than split.

Alongside the outcome, three things say whether the experiment is *working* rather than
whether the intervention is:

- **candidate moments per arm** — zero means the gate is too tight and the arms are running
  identical code.
- **holds taken** — candidates with no holds means no room offered a wall, or
  `takeSafeSpot` is refusing.
- **health gained per hold** — a hold that hits the cap having gained two points is a hold
  that should not have been taken.

## If it wins

v3 is routing: prefer routes through rooms whose walls have held. It needs the data this
produces and should not be built before it, because a route chosen for its walls is longer,
and longer is more seconds exposed.

---

The watchdog is now recorded in every postmortem (`summary.watchdog`, read back as
`keeper.handbrake`), so from here a travelling death can say whether the handbrake fired,
never fired, or stood down for an errand. Those are three different faults and until now
they rendered identically.
