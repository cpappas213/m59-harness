# m59-harness — instructions for an agent working in this repository

Read this if you are Codex, or any agent that does not read `CLAUDE.md`. The two
files carry the same instructions; `CLAUDE.md` is the fuller version and
[`docs/INSTALL.md`](docs/INSTALL.md) is the manual with troubleshooting.

This repository lets an agent play Meridian 59 as a real player character.

## Asked to install the game and make a fleet?

```bash
node tools/setup.mjs doctor      # read this first — it says what is missing
node tools/setup.mjs all 10      # clone + build + run server, start broker, make 10 characters
```

Ten to fifteen minutes, mostly compiling. Every step is idempotent. Individually:

| | command |
|---|---|
| 1 | `node tools/setup.mjs server` — clones + builds + runs `blakserv` in Docker |
| 2 | `node tools/setup.mjs client` — finds a Steam install; **cannot install one** |
| 3 | `node tools/setup.mjs broker` — MCP broker on 8901, dashboard 8902 |
| 4 | `node tools/setup.mjs fleet 10` — creates ten characters |

## Tell the user, do not work around

- **Steam cannot be automated.** It will not install a game the user does not own
  or log in for them. If step 2 finds nothing, give them
  https://store.steampowered.com/app/893390/Meridian_59/ and carry on. Do not
  script a Steam login or fetch the client from anywhere else.
- **The client is optional for a fleet.** Agents log in over the wire; no
  `Meridian.exe` is involved. It is for watching the fleet and for compendium
  art. A missing client does not block anything and should not be presented as
  if it does.
- **Either server tree works.** `setup.mjs` clones `Meridian59/Meridian59`
  (upstream) by default. `tpeppers/Meridian59-deck` is a public fork adding
  gamepad and Steam Deck support and works too, from `2c6d8091` onward. Set
  `M59_ROOT` to prefer it. Do not switch trees to "fix" an unrelated problem.
- **Docker's daemon is separate from its CLI.** `docker --version` succeeding
  proves nothing can be built. If the daemon is down, ask the user to start
  Docker Desktop rather than starting it yourself.

## Traps

- **`create automated` makes a character with ZERO in every attribute.** They are
  fixed at creation and never move, and stamina *is* the max-health ceiling
  (`101 + stamina`), so it is capped at 102 max health for ever. Unrepairable;
  only re-rollable. Use `m59-makefleet.mjs` rather than creating characters by
  hand.
- **The server never says no.** A malformed or over-budget character request is
  silently replaced with `3/1/4/1/5/9`. Never report a character as created
  without checking `stats_as_asked` in the `reroll` result.
- **Attach to the broker, never spawn a second.** `m59-broker.mjs` with no
  arguments serves stdio MCP *and* resumes a fleet; a second one is refused the
  lock, comes up healthy and **empty**, and answers about a fleet of nobody while
  the real one plays on. Use `tools/m59-mcp-attach.mjs`, which holds no state.
- **Never call the `leave` tool** on a fleet anyone cares about — it drops the
  roster, and the roster is the only record of the passwords.
- **`substrate/fleet-accounts.json` is the only copy of the account passwords.**
  Gitignored. Never commit it, never print it into a shared transcript, never
  delete it.
- **`[Channel] Flush` defaults to `No`**, and with it off every server log stays
  at 0 bytes for ever — which looks exactly like a hook not firing. The container
  turns it on; a native build may not have.

## Working here

- Every tool in `tools/` is standalone `.mjs`, zero dependencies. Only the chat
  responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree.
- Offline tests, safe any time: `node tools/m59-safespot-test.mjs` (91),
  `node tools/m59-chat-test.mjs` (102). The rest need a live server.
- Sprites are not committed; `python tools/pull-client-assets.py` decodes them
  from a local client. Do not commit `compendium/assets/img/`.
- Do not commit what a running fleet writes — `fleet-state.json`, `history/`,
  `recordings/`, `commissions/`. `.gitignore` covers them; add no exceptions.
