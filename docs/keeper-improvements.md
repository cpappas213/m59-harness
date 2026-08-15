# Keeper Improvement Notes

Observations from initial fleet run with Gountrug, Kage, JayB and Lee.

## 1. Map graph gaps

Raza sub-rooms (1011–1018) and the Mausoleum (1016) are not connected to the
world graph. `travel` fails silently and characters get stranded with "no route
from X to Y" errors. The `leave_raza` tool exists as a one-way workaround but
cannot navigate back in.

**Fix:** Add Raza pocket rooms and their inter-connections to `m59-map.json`.
Any room that is a sub-pocket needs either graph entries or a dedicated
bidirectional escape tool.

## 2. Safe spot competition between fleetmates

Two characters in the same room independently pick the highest-scoring spot and
stack on top of each other. The keeper has no awareness of where fleetmates are
standing. Both characters then pull from the same mummies and break off without
kills.

**Fix:** Implement a `maxBotsPerSafeSpot` reservation signal. The field already
exists in the autopilot schema but is not enforced. Before claiming a spot,
check whether a fleetmate is already holding it and pick the next best
alternative.

## 3. Maze and tight-room navigation

Characters assigned to rooms like the Sewers of Jasper (377) can get stuck
trying to reach a safe spot that the router cannot path to, even if the room is
technically reachable. Blink helps but does not solve all cases.

**Fix:** Improve pathfinding inside rooms with tight geometry. Consider falling
back to a different assigned room if no safe spot can be reached after N
attempts, rather than stalling indefinitely.

## 4. Target locking during combat

**Largely already implemented.** `fight()` in `m59-skills.mjs` takes a
`preferId` parameter and the keeper passes `this.foeId` through it. The quarry
claim system (`claimQuarry`/`rankQuarries`) also coordinates between fleetmates
so they don't all converge on the same creature. `OF_PLAYER` is filtered in
`findCreature()` by default (`includePlayers = false`).

**Real issue: round limit too low.** `fight()` defaults to `rounds = 12`. A
mummy at level 25 has ~125 HP; without weapon skills each swing does ~3–6
damage, requiring 20–40 rounds. Characters break off at 12 every time before
the kill. JayB and Lee were stuck at 21 kills for this reason.

**Fix:** Make the round limit configurable via autopilot policy
(`fightsRounds`), or increase the default. Characters without weapon skills need
more rounds per engagement to finish a kill.

## 6. Broker restart loses game server and crashes on missing credentials

When the broker is restarted via `m59-service.mjs restart`, two things can go
wrong:

1. **`game_server: null` in `/health`** — this is cosmetic: the field only
   populates once sessions are logged in. The broker does have the right
   `M59_HOST`/`M59_PORT` from env. Not a real problem but confusing to read.

2. **Crash on login: `pstr(undefined)`** — if `fleet-state.json` was written
   mid-session without credentials (e.g. during a truncation window), the broker
   restores sessions with no account/password and crashes the moment it tries to
   log one in. The `.prev` file saved us here: credentials were intact in it.

**Fix:** The roster save path must always carry credentials forward. The
`fleet-state.json.prev` backup is the safety net but it should never be needed
— the save should be atomic (write to `.tmp`, rename) so a crash mid-write
cannot produce a credentialless file. Also: `start-broker.sh` is the correct
restart path; calling `m59-service.mjs` directly without the env vars silently
drops `M59_HOST`/`M59_PORT` — this caused the original half-hour outage.

## 5. Banking blocked by player in path

Gountrug stalled for ~200 passes trying to reach the Royal Bank of Jasper
because a player character was physically blocking the corridor. The "guardian
angel" message was the tell. The keeper had no way to wait, retry a different
path, or defer the trip.

**Fix:** On a "guardian angel" block, wait a short interval and retry rather
than counting it as a routing failure and stalling.

**Related:** Target locking (issue 4) partially mitigates this. A keeper with a
locked combat target will not attempt a banking trip mid-fight, so it only walks
corridors between fights when player traffic is less likely to be a problem.
