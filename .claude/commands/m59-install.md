---
description: Install the Meridian 59 server and client from scratch, then create a fleet
---

Bring up everything from a bare clone: the server, the broker, and a fleet of
characters. Arguments: `$ARGUMENTS` (a character count, default 10).

## Where things stand right now

!`node tools/setup.mjs doctor 2>&1`

## What to do

Read the report above, then act on it. **Every step is idempotent** — anything
already marked `ok` needs nothing, so do not redo it.

If everything is `ok` except the fleet, go straight to step 4.

| | if this is missing | run |
|---|---|---|
| 1 | server source, or `:5959` | `node tools/setup.mjs server` |
| 2 | steam client | `node tools/setup.mjs client` |
| 3 | broker `:8901` | `node tools/setup.mjs broker` |
| 4 | the fleet itself | `node tools/m59-makefleet.mjs --count <N>` |
| 5 | client shortcuts | `node tools/setup.mjs shortcuts` |

Or `node tools/setup.mjs all <N>` for all five in order.

Step 1 builds a container and takes ten minutes or so the first time. Run it in
the background and report progress rather than sitting silent.

## Judgement calls, decided in advance

- **A missing Steam client is not a blocker.** Agents log in over the wire; no
  `Meridian.exe` is involved in running a fleet. Report it, hand over
  https://store.steampowered.com/app/893390/Meridian_59/, and carry on to the
  broker and the fleet. Do not stop, and do not try to script a Steam login.
- **A failed clone of `tpeppers/Meridian59-deck` is expected** for anyone who is
  not its owner — it is private. `setup.mjs` falls back to the public upstream on
  its own. Do not report it as a failure.
- **If Docker's daemon is down**, say so and ask the user to start it. Do not
  start Docker Desktop yourself unless they ask.
- **Before creating characters, confirm the count** if the user did not give one.
- **Step 5 is last and is never a blocker.** It needs a client *and* a roster; with
  either missing there is nothing to make a shortcut out of, and it says so and
  exits 0. Never pass `--show` — it prints the passwords.

## Reporting the result

Show `node tools/m59-fleet.mjs` and the dashboard link
(http://127.0.0.1:8902/fleet). Say plainly how many characters were made and how
many failed — `m59-makefleet.mjs` verifies each one's stats actually landed, and
a character it reports as FAILED is a real failure, not noise.

Tell the user their account passwords are in `substrate/fleet-accounts.json`,
that it is gitignored, and that it is the only copy. **Do not print the passwords
themselves.**

If shortcuts were written, say where they are and that opening one logs that
character in with no typing — and that each file holds a password in plain text,
which is why `shortcuts/` is gitignored too. Mention `--desktop` if they would
like them on the Desktop.
