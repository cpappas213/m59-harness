# m59-harness — instructions for an agent working in this repository

This repository lets an agent play Meridian 59 as a real player character. If
someone has just cloned it and asked you to **install the game and make them a
fleet**, this file is the whole procedure. Follow it in order.

The long version, with troubleshooting, is [`docs/INSTALL.md`](docs/INSTALL.md).

## The one-liner

```bash
node tools/setup.mjs all 10
```

That clones the server source, builds it in a container, starts it, starts the
broker, and creates ten characters. Ten to fifteen minutes, mostly compiling.

**Run `node tools/setup.mjs doctor` first** and read what it says. It reports
each prerequisite and each port, and it is the fastest way to tell which of the
steps below still need doing. Every step is idempotent — running it twice finds
what the first run made and says so.

## The steps, if you are doing them one at a time

| | command | notes |
|---|---|---|
| 1 | `node tools/setup.mjs server` | clones + builds + runs `blakserv` in Docker |
| 2 | `node tools/setup.mjs client` | finds a Steam install; **cannot install one** |
| 3 | `node tools/setup.mjs broker` | starts the MCP broker on 8901, dashboard 8902 |
| 4 | `node tools/setup.mjs fleet 10` | creates ten characters |

## Asked to shut down, stop the server, or "we're done for now"?

```bash
node tools/m59-shutdown.mjs
```

**Always this, never a bare `docker stop`.** blakserv installs no SIGTERM
handler, and `[Auto] SavePeriod` defaults to 180 minutes, so stopping the
container directly can silently throw away three hours of play.

This keeps **two** snapshots under `docker/data/checkpoints/`, then stops the
broker and the server:

- `<time>-standing` — the save already on disk when the shutdown was asked for,
  copied aside untouched.
- `<time>-checkpoint` — a fresh `save game` taken right then.

Both, because the fresh one is the one that can be bad: if the fleet just walked
into something, or a re-roll went wrong, or errands are half-finished, the
checkpoint faithfully preserves that mess and the standing save is what you
actually want back. Do not "tidy up" by keeping only one.

Useful variants: `--checkpoint` (snapshot, stop nothing), `--keep-server`
(stop the broker only), `--label "before the raid"`, `--list`, and
`--restore <id>`. Restoring refuses while the server is up, because a live
server would overwrite it at the next save.

Report where the checkpoints went. Do not delete old ones without being asked.

## Things to tell the user rather than work around

**Steam cannot be automated.** It will not install a game the user does not own,
and will not log in for them. If step 2 finds nothing, give them the link —
https://store.steampowered.com/app/893390/Meridian_59/ — and carry on. Do not
attempt to script a Steam login or download the client from anywhere else.

**The client is optional for a fleet.** Agents log in over the wire; no
`Meridian.exe` is involved. The client is for *watching* the fleet and for the
compendium's sprite art. If the user only wants a fleet, a missing client is not
a blocker and you should not present it as one.

**Either server tree works.** `setup.mjs` clones `Meridian59/Meridian59`
(upstream) by default. `tpeppers/Meridian59-deck` is a public fork adding gamepad
and Steam Deck support; it works too, from `2c6d8091` onward. Someone who wants
it sets `M59_ROOT`. Do not switch trees to "fix" an unrelated problem.

**Docker's daemon is separate from its CLI.** `docker --version` succeeding does
not mean anything can be built. If the daemon is down, say so and ask the user to
start Docker Desktop; do not try to start it yourself unless they ask.

## Traps that will waste your time if you do not know them

- **`create automated` makes a character with ZERO in every attribute.**
  Attributes are fixed at creation and never move, and stamina *is* the
  max-health ceiling (`101 + stamina`), so such a character is capped at 102 max
  health for ever. It cannot be repaired, only re-rolled. This is why
  `m59-makefleet.mjs` exists and why you should not create characters by hand.

- **The server never says no.** An out-of-budget or malformed character request
  is not refused — it is silently replaced with `3/1/4/1/5/9` and the default
  face, and you find out weeks later. Never report a character as created
  without checking `stats_as_asked` in the `reroll` result. `m59-makefleet.mjs`
  already does this; if you do it by hand, do it too.

- **Attach to the broker, do not spawn a second one.** `m59-broker.mjs` with no
  arguments serves stdio MCP *and* resumes a fleet. With one already running,
  the second is refused the lock, comes up healthy and **empty**, and answers
  every question about a fleet of nobody while the real one plays on. `.mcp.json`
  points at `m59-mcp-attach.mjs`, which forwards to an existing broker and holds
  no state. Keep it that way.

- **Never call the `leave` tool** on a fleet anyone cares about. It drops the
  roster, and the roster is the only record of the account passwords.

- **`substrate/fleet-accounts.json` is the only copy of the passwords** for
  characters `m59-makefleet.mjs` created. It is gitignored. Never commit it,
  never print its contents into a shared transcript, and never delete it.

- **`[Channel] Flush` defaults to `No`**, and with it off every server log stays
  at 0 bytes for ever. This looks exactly like a hook not firing. The container
  turns it on; a native build may not have.

## Working in this repository

- Every tool in `tools/` is standalone `.mjs`, zero dependencies, run with
  `node tools/<name>.mjs`. Only the chat responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree. The compendium's citations
  and the Python analysis scripts both read it.
- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (91)
  and `node tools/m59-chat-test.mjs` (102). The rest need a live server.
- The compendium's sprites are not committed. `python tools/pull-client-assets.py`
  decodes them from a local client. Do not commit `compendium/assets/img/`.
- Do not commit anything a running fleet writes — `fleet-state.json`,
  `history/`, `recordings/`, `commissions/`. The `.gitignore` already covers
  them; do not add exceptions.
