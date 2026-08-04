---
description: Checkpoint the world and shut the fleet and server down safely
argument-hint: [label for the checkpoint]
---

Stop everything without losing the session. Arguments: `$ARGUMENTS` (an optional
label for the checkpoint, e.g. "before the raid").

**What is running, and which fleet is about to be stopped:**

!`node tools/m59-which.mjs 2>&1`

## Do this

```
node tools/m59-shutdown.mjs --label "$ARGUMENTS"
```

Drop `--label` if no arguments were given.

**There is no `--fleet` here and that is correct.** A broker holds exactly one fleet, and
this stops *the broker that is running* — found by asking `/health` which pid it is, not
by matching a process name. So it stops whatever is up, whichever fleet that is, and the
lock it releases is the one that broker actually took. Report the fleet named above so
it is on the record which one went down.

**Never use a bare `docker stop` for a deliberate shutdown.** blakserv installs
no SIGTERM handler and `[Auto] SavePeriod` defaults to 180 minutes, so stopping
the container directly can silently discard three hours of play. A hard stop is
fine when a hard stop is what is wanted — it just is not this.

## What it keeps, and why it is two things

| | |
|---|---|
| `<time>-standing` | the save already on disk when you were asked, copied aside untouched |
| `<time>-checkpoint` | a fresh `save game` taken right then |

Both, because the fresh save is the one that can be bad. If the fleet has just
walked into something, a re-roll went wrong, or errands are half-finished, the
checkpoint faithfully preserves that and the standing save is what is actually
wanted back. Do not "tidy up" by keeping only one, and do not delete old
checkpoints unless asked.

## Variants, if the user wanted something narrower

- `--checkpoint` — snapshot only, stop nothing
- `--keep-server` — stop the broker, leave the server up
- `--list` — what checkpoints exist
- `--restore <id>` — put one back (refuses while the server is running, because
  a live server would overwrite it at its next save)

## Reporting

Say where the checkpoints went and which two were made. If the checkpoint save
did not confirm, say so plainly — the tool stops rather than shutting down on an
unverified save, and the standing copy is still intact.
