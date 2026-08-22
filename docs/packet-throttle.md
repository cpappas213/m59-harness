# The 5-packet-per-second server throttle

## The fact (from source, not behavior)

`kod/object/active/holder/nomoveon/battler/player/user.kod:50`:

```kod
INCOMING_PACKET_THROTTLE = 5
```

`user.kod:863-884` (per incoming packet):

```kod
bSpam = FALSE;
if piLastPacketTime <> GetTime() {
   piLastPacketTime = GetTime();
   piPacketsPerSecond = 1;
} else {
   piPacketsPerSecond = piPacketsPerSecond + 1;
   if piPacketsPerSecond > INCOMING_PACKET_THROTTLE
      AND NOT Send(self,@PlayerIsImmortal)
   {
      bSpam = TRUE;
   }
}
```

Then, for **every** command that matters (attack at line 1097, move, turn, go, cast,
use, look, ...):

```kod
if bSpam { return; }   // SILENTLY DROPPED. No message, no error, no response.
```

**Above 5 packets in any single second, the server marks the client a spammer and
silently drops the overflow packets.** There is no "out of range" or "too fast" message
— the packet simply never gets processed.

## Why the real client is fine

A human-paced client never sends 5 packets in a second. Movement is paced by
`MOVE_DELAY` (`move.c`), attacks by `ATTACK_DELAY = 1000ms` (`gameuser.c:53`). A player
clicking a door, turning, and swinging is well under 5/s. The throttle exists to stop
bots, and a human never trips it.

## Why we were tripping it

Two compounding causes, both ours:

1. **The tick loop at 10Hz submits an action every 100ms** regardless of whether it
   changed anything. Walking to a destination submits `moveToSquare` *every tick* (a
   re-issue of the same target), and the combat controller re-issues `face` every tick.
   That is up to 10 submissions/second *before* the pacer.

2. **The pacer's global rate was 12/s** (`PACKETS_PER_SECOND`, `m59-game.mjs:66`),
   happily draining the queue at 12 packets/second — 2.4× the server's limit.

Net: we were sending 10-12 packets/second. The server counted 5, then set `bSpam`, and
silently dropped the rest. That is why:

- **109 swings sent, zero combat responses** (`/swingstats` vs `/combatstats`).
- **Movement was slow and stuttering** — most move packets dropped; the character
  "wiggled" as the stuck-detector's blink/escape fallback fired when moves didn't land.
- **Swing rate ~0.2/s** — most attacks dropped; the occasional one that landed was when
  we happened to be under 5/s for that second.

## The wrong fix (what we tried first)

Capping the pacer at 5/s. This stops the *server-side* drops but creates a **client-side
backlog**: the tick loop still *produces* 10/s, the pacer now only *drains* 5/s, so the
queue grows unbounded. Attacks wait behind a flood of redundant move/face packets and
never get sent. JayB got *worse* (HP 21→1, fled, and `total_swings: 0` despite the log
saying `_fight -> swing`).

## The right fix

**Stop producing more than ~5 packets/second.** The tick loop must only submit an action
when it actually changes state:

- **Move:** don't re-submit the same `moveToSquare(col,row)` every tick. Submit once,
  then only re-submit if the character has stopped making progress (stuck) or the
  destination changed.
- **Face:** don't re-submit `face(deg)` every tick if we're already within a few degrees
  of the target heading.
- **Swing:** already paced by `SWING_MS` (950ms) in the combat controller — that part
  is fine. The problem is the move/face noise around it.

The pacer rate (`PACKETS_PER_SECOND`) is a *second* line of defense, set to 8 as a
stopgap (high enough to avoid a backlog while the production fix lands, low enough to
reduce server-side drops). It is **not** the fix — the production rate is.

## Measuring it

The keeper exposes `/pacerstats` on each agent's port:

```
prod_per_sec   what the tick loop SUBMITS per second (the bug: >5)
sent_per_sec   what actually leaves the socket per second (what the server counts)
queue_depth    pacer queue length (>0 and growing = backlog)
min_gap_ms     the pacer's global inter-packet gap (1000 / PACKETS_PER_SECOND)
```

Healthy: `prod_per_sec <= ~5`, `sent_per_sec <= 5`, `queue_depth` bounded (0-2).
Broken: `prod_per_sec >> sent_per_sec` (backlog) or `sent_per_sec > 5` (server drops).

During combat in the Mausoleum, measure both before and after the production fix.
The goal is `prod_per_sec` at or under 5 with `queue_depth` bounded, and a swing rate
near 1/s (one per `SWING_MS`) with combat responses actually arriving.
