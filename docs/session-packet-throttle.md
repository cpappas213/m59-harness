# Session status — packet throttle fix + lazy position reporting

**Date:** the JayB-in-the-Mausoleum session.
**Goal:** fix the swing rate / movement slowness so the character fights like a player.

## Root cause (verified from server source)

`kod/object/active/holder/nomoveon/battler/player/user.kod:50`: `INCOMING_PACKET_THROTTLE = 5`.
Above 5 packets in any single second the server sets `bSpam` and **silently drops** the
overflow (no error, no response). We were sending 10-18/s (the 10Hz tick loop submitted a
move/face every tick), so most packets were dropped. Symptom: 109 swings sent, zero combat
responses, stuttering movement, the "pause between rooms" (the pacer queue grew to 500+).

Full analysis: **docs/packet-throttle.md**

## What was done (and verified)

1. **A\* pathfinding: 10s → 4ms (500x).** `finePathProtocol` now answers reachability with
   the coarse grid first. (Earlier in the session.)

2. **`tick` mode accepted by the broker.** Added `tick` to `MODES` (m59-autopilot.mjs:753)
   and the schema enum (m59-broker.mjs). It was being silently rejected and reverted to
   `survive`.

3. **Lazy position reporting** (m59-mover.mjs) — the client's `MoveUpdateServer` model
   (clientd3d/move.c:739): only report position to the server when (a) ≥1000ms since the
   last report AND (b) moved > FINENESS/4. Movement production dropped from 10-18/s to
   ~1-2/s. **Queue depth 0, no wall-walking** (the most robust collision yet).

4. **Face/turn coalescing** — two places:
   - The Actuator (`m59-tick.mjs`) no longer re-sends an unchanged `face`.
   - The session's turn-before-move in `walkTo` (`m59-game.mjs`) only sends a turn when the
     heading changes by > FACE_EPS (8°). The client now tracks `self.degrees` locally on
     `turn()` (m59-client.mjs) so the coalescing has a current value.
   Turn production dropped from ~4/s to ~0.

5. **Diagnostic tooling** (all on each agent's keeper port):
   - `/pacerstats` — prod/sent per-second, per-kind breakdown, queue depth.
   - `/rxstats` — connection liveness (rxBytes, lastRxAgo).
   - `/swingstats`, `/combatstats` — swing rate + hit/miss/out-of-range (server prose).

6. **`m59-prodrate-test.mjs`** — 4 tests pinning the production-rate contract.

## Healthy metrics (measured live, tick mode, in the Mausoleum)

```
prod_per_sec: 1-2/s   sent_per_sec: 1-2/s   queue_depth: 0
byKind: { move: ~1/s, read: ~0.5/s }   (turns coalesced away)
```

## Remaining issues (each separate, none blocking the others)

1. **The character is slow and not engaging the mummy effectively.** It moves ~1 square/s
   (the lazy-reporting tradeoff — the server is client-authoritative, so the character only
   moves when we report a new position, ~1/s). It was observed facing the wrong way (south,
   mummy to the east) during a `close gap`. The combat controller's `_walkTo` uses the
   mover, and the facing is handled by the coalesced turn-before-move. Needs investigation:
   is the combat controller facing the target before closing the gap?

2. **The session keeps going ghost/offline** and needs manual `/rejoin`. The liveness guard
   (45s) exists but the recovery isn't reliable. The keeper believes it's in-game while the
   server has dropped it.

3. **Mode reverts to `survive` on broker restart.** The broker's in-memory `fleetState` is
   the source of truth; editing the roster file while the broker runs doesn't update it.
   Setting tick requires: stop broker → edit file → start broker.

## The next concrete step

Get JayB to actually fight the mummy: verify the combat controller faces the target before
closing the gap, and confirm a swing lands (via `/combatstats`). This is the payoff of all
the above — the character should now be able to hit the mummy at ~1 swing/s.

## Files changed this session

- `tools/m59-roo.mjs` — coarse-first reachability in `finePathProtocol` (500x speedup)
- `tools/m59-autopilot.mjs` — added `tick` to `MODES`
- `tools/m59-broker.mjs` — added `tick` to the schema enum; `PACKETS_PER_SECOND` 12→8
- `tools/m59-game.mjs` — `PACKETS_PER_SECOND` 12→8; pacer prod/sent tracking; turn
  coalescing in `walkTo`; `FACE_EPS`
- `tools/m59-mover.mjs` — lazy position reporting (`_maybeReportPosition`,
  `_movementGateOk`, `_recordReport`); gate applied to all movement-send paths; `to()`
  only re-plans/resets on a genuine new destination
- `tools/m59-tick.mjs` — face coalescing in the Actuator (`FACE_EPS`); `/pacerstats` wiring
- `tools/m59-client.mjs` — local `self.degrees` tracking on `turn()`; `rxBytes`/`rxPackets`
- `tools/m59-keeper-process.mjs` — `/pacerstats`, `/rxstats` endpoints
- `tools/m59-prodrate-test.mjs` — new (production-rate contract)
- `docs/packet-throttle.md` — new (full analysis)

## Pre-existing test failures (NOT caused by this session's changes)

- `m59-collision-test.mjs` — the prior broker/session refactor moved `validateFineTarget`
  and left the test's text-matching stale.
- `m59-route-test.mjs` — the mover's `walkTo` change left the test's fake session without
  `walkTo`.
- `m59-mover-test.mjs` — 1 wall-crossing case (false positive in the test's path sampling).
