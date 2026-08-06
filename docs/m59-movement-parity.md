# Movement parity — why the fleet crosses a map five times slower than a person

Measured 2026-08-06 against the `prod` fleet on the live shared server, with the operator
playing Statler and five fleet characters standing in the same room as instruments.

## The claim that started it

The fleet's own transit record said crossing **West Merchant Way through Ilerian Woods
(535)** cost up to **285 seconds**. The operator's response was that there is no way
running across 535 takes three minutes, and that almost any map in this game goes exit to
exit in under a minute.

That turned out to be exactly right, and the gap decomposes into two separate problems
rather than one.

## What a person actually does

`tools/m59-watch.mjs` times a named player using a fleet character already standing in the
room as a read-only instrument. It never drives anything and it never touches the character
being watched — it reads the movement packets the server already sends everyone in earshot.

84 samples of the operator crossing 535 repeatedly, exit to exit:

| | |
|---|---|
| sustained speed | **2.28 squares/second** |
| median leg | 3.24 squares/second |
| median stride per broadcast | **4.5 squares** |
| moving | 102.7s |
| standing still | 112.7s |
| room extent observed | 42 × 54 squares, **~68 corner to corner** |

Against the same room, the fleet's own Zoot was measured at **0.55 squares/second**, one
square every 1.8–2.9 seconds.

## Two multipliers, stacked

### 1. One square per packet, against a real client's five

The operator's position arrives in consistent **~5-square jumps**. That is the granularity
the server broadcasts a moving player at, and it means a real client is issuing movement in
strides rather than square by square.

`Session.step()` issues exactly one square:

```js
await this.pacer.submit('move', () => c.moveToSquare(col, row, speed), MOVE_INTERVAL_MS);
```

### 2. A full room re-read after every square

```js
await this.pacer.submit('read', () => c.roomContents());
await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
```

Measured round-trip for `roomContents`, four samples each:

| room | objects | round-trips |
|---|---|---|
| 535 | 15 | 1786ms, 2601ms, 1767ms, 5565ms |
| The Streets of Tos | 2 | 2505ms, 2795ms, 3896ms, 1246ms |

**It is not packet size.** A room with two objects costs the same as one with fifteen, so
this is round-trip and queue latency, not payload. One of these per square is the whole of
the difference between the 250ms `MOVE_INTERVAL_MS` that was carefully tuned and the ~2s
per square actually observed.

`MOVE_INTERVAL_MS` carries a long comment about how walking at one square a second was
costing us characters, and it was lowered to 250ms to fix that. **It never took effect**,
because it was never the binding constraint. The per-square room re-read was.

### Why the re-read is there, and why the reason looks wrong

`stepFine` states it plainly: *"CONFIRM EVERY STEP BY RE-READING. The server does not echo
your own accepted move, so cached position goes stale."*

`m59-client.mjs` contradicts it in the BP_MOVE handler: *"Our own moves confirm what the
server accepted, which is the only trustworthy position."* One of the two is wrong.

A test walk did produce a self `moved` event — but **one**, on a character whose keeper was
also running, so it may not have been from the walk at all. This is suggestive and is NOT
established. It is the first thing to settle, because if the server does echo the mover,
the entire per-square room re-read collapses into waiting for one tiny packet.

## What the numbers say the fix is worth

Room 535 at ~68 squares corner to corner:

| | speed | crossing |
|---|---|---|
| operator | 2.28 sq/s | **30s** |
| fleet | 0.55 sq/s | 124s |
| fleet, observed worst | — | **285s** |

Two conclusions, and the second is the one that would have been missed:

- **~124s of the 285s is the step loop.** Stride and the re-read together.
- **The remaining ~160s is not walking at all.** It is failed exit-square attempts,
  re-planning and the arrival settle. `m59-transits.mjs` already shows 535 at 2 exit
  squares per crossing and Deep Woods of Ileria at 2.4, meaning exits are being refused and
  retried. **Fixing the step rate alone takes a 285s crossing to about 160s, not to 30s.**

## Fix 1, shipped: the room re-read is capped at once per 6s

`Session.step()` no longer re-reads the room after every square. It predicts its own
position and resyncs on a clock — `ROOM_RESYNC_MS`, 6000ms, a hard cap rather than a
target. `step(col, row, { confirm: true })` forces a real read for the one caller that
needs to know whether a step *happened* rather than where we now are: the recovery from
standing off the floor, where a predicted yes would report solid ground under a character
that is still not on any.

**Prediction is safe here, and it was measured rather than assumed.** Two facts:

- **The server does not echo a user's own accepted move.** A six-square walk produced
  **one** self `moved` event. So there was never a cheap confirmation available to swap the
  re-read for — the choice was the re-read or prediction, and the earlier note in
  `m59-client.mjs` claiming our own moves come back was wrong.
- **There is nothing to confirm.** `UserMove` calls `Room.SomethingMoved` directly and
  `ReqSomethingMoved` is bypassed for users; room.kod's comment is *"already been checked
  by client (HAHA!)"*. No geometry, distance or occupancy validation on a user move. The
  only thing that snaps you back is speed above walking pace with vigor under the run
  threshold, which `moveSpeed()` already guards.

`predicted: true` is set on the object and cleared by anything the server says about it, so
a predicted position is never mistaken for a confirmed one.

**Measured before and after, same character, same room:**

| | squares | time | speed |
|---|---|---|---|
| before | 6 | 11.5s | 0.52 sq/s |
| after | 12 | 10.2s | **1.18 sq/s** |

**2.3×.** Real, and not enough — the operator sustains 4.1.

## What is still missing: stride

12 steps for 12 squares. **We still send one square per packet**, and each carries a `face`
turn packet ahead of it, so it is two paced sends per square against a 12/s global budget
plus the 250ms move gap. The operator's client covers a median of **4.5 squares per
broadcast**.

`m59-roo.mjs` already records why this is available: `CanMoveInRoom` has two surprising
allowances, and one of them is that *"a jump of more than one square is waved through as a
teleport"*. Multi-square moves are accepted. Sending one square at a time is our choice,
not the protocol's.

That is the next fix, and on the arithmetic it is the larger half of what remains.

## What this is not

It is **not** an argument for aborting travel on damage. There is no safe travel in
Meridian 59 and there is not meant to be — human players die crossing the world constantly,
and the world is expected to get more dangerous as other players hunt these characters.
Taking hits on the road is a normal feature of the game.

Speed is the point precisely because it is the honest lever: a character that crosses a map
in 30 seconds instead of 124 stands next to a quarter as many things on the way. Damage
falls out of the speed fix rather than being managed directly.

## Caveats on the measurement

- The 2.28 sq/s is a **floor**. The server broadcasts other players' positions only every
  ~5 squares, so movement inside each stride is invisible and the real figure is higher.
- 68 squares is the extent **observed**, not the room's true bounds. A bigger room widens
  the gap.
- The 24 sq/s peak in the raw trace is a sampling artefact — two broadcasts landing 0.21s
  apart — not a real burst. The median leg of 3.24 sq/s is the honest number.

## The instruments, which stay

- `tools/m59-watch.mjs` — time any player crossing any room, using a fleet character
  already standing there. `--anyone` locks onto the first non-fleet player that moves;
  `--who <name>` is needed when the person is piloting one of ours.
- `tools/m59-transits.mjs` — per-room crossing times for the fleet, with `walk_ms` split
  out from `ms` so planning time is separable from walking time.
- `tools/m59-hits.mjs` — where damage lands, off the event stream rather than the keeper,
  so it keeps recording through a travel await and through an inert hold.
- `m59-client.mjs` now emits `player-moved` for other players. Players only: every monster
  emits the same packet several times a second and the event ring is shared with combat.

Keeping all four is the point. Parity is a claim, and a claim needs a number that can be
re-measured on demand.
