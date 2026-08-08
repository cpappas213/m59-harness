# m59-harness

Play [Meridian 59](https://github.com/Meridian59/Meridian59) as a real player
character, from an agent.

Characters log in over the same port humans use. They see the room *and its
geometry*, walk routes through walls the server never enforces but the room
really has, travel across the world, fight, shop, talk, rest, hand each other
items and money, and hear each other. `who` lists them beside the humans. Any
MCP client — Claude Code, Codex, a local model with a `curl` loop — can drive
one.

This is a baseline, not a running fleet. Nobody's roster, character state or
chat history is in here; what is here is the protocol client, the world model,
the behaviours, and a reference compendium compiled from the game's own source.
Build your own fleet management on top.

## Install it

From nothing to ten characters playing, on Windows or Linux:

```bash
git clone https://github.com/tpeppers/m59-harness
cd m59-harness
node tools/setup.mjs all 10
```

That clones the [Meridian 59](https://github.com/Meridian59/Meridian59) source,
builds the server in a container, starts it, starts the broker, and creates ten
characters. Ten to fifteen minutes, mostly compiling. `node tools/setup.mjs
doctor` reports what is present and what is missing without changing anything.

Or open the repository in Claude Code or Codex and ask it to install the game and
make you a fleet — [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md) are the
procedure, written for an agent.

The manual, with both platforms, the native build, and troubleshooting, is
[`docs/INSTALL.md`](docs/INSTALL.md).

**The Steam client is optional.** Agents log in over the wire; no `Meridian.exe`
is involved in running a fleet. You need
[the client](https://store.steampowered.com/app/893390/Meridian_59/) to watch a
character in first person, and for the compendium's sprite art.

If you do have it, `node tools/setup.mjs shortcuts` writes one shortcut per
character — host, port, account and password already filled in, so opening
`m59-Aldric.desktop` puts you in the world as Aldric with nothing to type. They
hold real passwords, so `shortcuts/` is gitignored; the details are in
[`docs/INSTALL.md`](docs/INSTALL.md#click-to-play-shortcuts).

## What you need

| | |
|---|---|
| Node 18+ | everything. Tools in `tools/` are standalone `.mjs` with no dependencies |
| Docker | building and running the server, the same way on both platforms |
| git | fetching the server source |
| Python 3 | the sprite puller and the source-analysis scripts. Optional |
| the source tree | set `M59_ROOT` (default `C:/code/Meridian59`). The compendium's citations point into it |

One dependency exists, for the chat responder only: `npm install`.

## Start here

```bash
node tools/m59-broker.mjs --http 8901 --dashboard 8902
```

One process, N characters, 47 MCP tools. Point a client at it:

```json
{ "mcpServers": { "meridian59": {
    "command": "node",
    "args": ["C:/code/m59-harness/tools/m59-mcp-attach.mjs", "--port", "8901"]
} } }
```

`.mcp.json` in this repo does exactly that — fix the path for your checkout.
**Attach, do not spawn.** `m59-broker.mjs` with no arguments serves stdio MCP
*and* resumes a fleet; with one broker already running, a second is refused the
lock, comes up healthy and empty, and answers every question about a fleet of
nobody while the real one plays on. `m59-mcp-attach.mjs` forwards stdio MCP to
an existing broker and holds no state.

Then read [`docs/m59-agent-primer.md`](docs/m59-agent-primer.md) — the rules of
the world, written for something that is about to play it.

## The map

```
tools/setup.mjs                     doctor / server / client / broker / fleet — the bootstrapper
tools/m59-makefleet.mjs             make N characters that are worth growing
tools/m59-shortcuts.mjs             a click-to-play client shortcut per character
tools/pull-client-assets.py         decode the client's sprites into the compendium
docker/Dockerfile                   builds blakserv from either source tree, on any platform

docs/INSTALL.md                     the manual: both platforms, both build paths, traps
docs/m59-agent-primer.md            the rules of the world, for an agent that will play it
docs/m59-progression.md             how a character grows, how fast, how to tell it is working
docs/m59-mcp.md                     the broker: run it, wire it up, what the tools do
docs/m59-protocol-client.md         the wire protocol — login, perception, message formats
docs/m59-coordination-research.md   cited findings on trading, loot, PvP, kill credit
docs/m59-conversation.md            the chat bridge: hearing players, answering them
docs/m59-proxy-handoff.md           sitting between a human client and the server
docs/meridian59-bridge.md           the admin-socket control plane, runbook, and traps

tools/m59-broker.mjs        the MCP server — 47 tools, N characters, one process
tools/m59-client.mjs        a protocol client that logs in as a real player
tools/m59-parse.mjs         the server→client parsers: perception and trading
tools/m59-world.mjs         the joined world model: perception + graph + geometry
tools/m59-map.mjs           the room graph — 264 rooms, 1,343 exits, both mechanisms
tools/m59-roo.mjs           .roo geometry: walkability, walls, A*, the minimap
tools/m59-skills.mjs        composite behaviours: fight, rest, escape, sell everything
tools/m59-autopilot.mjs     the keeper — a background loop that holds baseline state
tools/m59-merchants.mjs     who buys, sells and teaches what
tools/m59-spells.mjs        spell costs, reagents and the karma gate, compiled from kod
tools/m59-safespots.mjs     squares a character can hold, and against how many
tools/m59-rsc.mjs           the resource table, id → text, straight off the wire
tools/m59.mjs               say / listen / escort / follow, over the admin socket
tools/m59-fleets.mjs        every roster on this machine: slots, server, who is holding it
tools/m59-proxy.mjs         sit between a human client and the server and watch
tools/m59-tui.mjs           interactive fleet terminal
tools/m59-dashboard.mjs     the fleet web page — /, and the tab bar for the four below
tools/m59-deaths-page.mjs   /deaths and /tougher: what killed them, what it took to gain
tools/m59-economy.mjs       purses, bank balances and reagents — /economy
tools/m59-abilities.mjs     every skill and spell number the fleet holds — /skills

substrate/m59-map.json        264 rooms with their .roo geometry, built once over the admin socket
substrate/m59-merchants.json  70 merchants: who buys, sells and teaches what
substrate/m59-spells.json     175 spells: mana, reagents, level, karma requirement
substrate/m59-spawns.json     120 creatures across 183 rooms, with danger ratings
substrate/m59-safespots.json  11 rooms of proven standing squares
```

`substrate/` here is reference data compiled once, not a running fleet's state.
A live broker writes `fleet-state.json`, `history/` and `recordings/` beside it;
all three are gitignored, because a roster carries account passwords in plain
text and recordings are one server's history rather than anything reusable.

## Tests

Offline, no server needed:

```bash
node tools/m59-safespot-test.mjs      # 91 tests — safe squares, errand pairing
node tools/m59-chat-test.mjs          # 102 tests — sanitiser and leak detection
node tools/m59-escape-test.mjs        # 29 tests — leaving and fighting from a sitting start
node tools/m59-fleets-test.mjs        # the roster inventory, against a fixture broker
node tools/m59-loadout-test.mjs       # 109 tests — loadouts, and what reaches the counter
```

Against a live server, with test accounts:

```bash
node tools/m59-perception-test.mjs    # the parser, in every room on the server
node tools/m59-play-test.mjs          # the primer's rules, re-checked
node tools/m59-coop-test.mjs          # two agents: see, walk, talk, trade, split
node tools/m59-skills-test.mjs        # fight / rest / escape, end to end
node tools/m59-autopilot-test.mjs     # three unattended minutes with nobody driving
```

## The compendium

A static reference site: every spell, skill, item and creature, plus guides to
the systems that connect them. 1,030 pages. Nothing in it is remembered or
estimated — every page is compiled from the server's own Blakod source, and every
quantitative claim carries a `file:line` citation into `M59_ROOT`.

```bash
cd compendium && node tools/serve.mjs      # http://localhost:8099/
```

The pages are committed. **The 5,355 sprites are not** — they are the client's
own art, 40 MB of it. Decode them from any local client:

```bash
python tools/pull-client-assets.py
```

It finds a source checkout or a shipped client (Steam, GOG) on its own; pass
`--resource` and `--palette` if it does not. Note that `blakston.pal` ships only
with the source tree, so a retail client alone is not enough. Until you run it,
pages render and images 404.

To rebuild the site itself from a changed source tree: `node tools/build.mjs`
inside `compendium/`. See [`compendium/README.md`](compendium/README.md).

## Telling the fleet what a character should be carrying

The compendium's **planner** is the page between the reference site and the live
fleet. It rebuilds the client's own right-hand panel — inventory, spells, skills,
stats, the same four tabs — and makes it editable, so what comes out is a
**loadout**: one file per character saying what gear it should get back to, how
many of each thing it should carry, and what it should sell on sight.

```bash
node tools/m59-compendium.mjs --open --to /planner/    # or press P in the fleet terminal
node tools/m59-loadout.mjs                             # every loadout on this machine
node tools/m59-loadout.mjs Kermit --check              # ...against what Kermit holds now
node tools/m59-loadout.mjs Kermit --init               # seed one from its character sheet
node tools/m59-loadout.mjs Kermit --gear-to-fleet      # what giving everyone its gear would do
```

The **gear** half is the one part of a loadout that is about the fleet rather than
about a character — how many reagents a caster burns is its own business, but
"fight with a short sword and wear leather" is a decision about all of them. So
the planner's *Apply gear to fleet*, and `--gear-to-fleet --apply`, write that one
field into every character's loadout and change nothing else in any of them. Both
say what they would do first: it is one file per character, and an empty gear list
is refused rather than applied, because a loadout nobody has filled in is not an
instruction to strip the fleet.

The keeper reads `substrate/loadouts/<character>.json` every pass and acts on it:
it tops up to the minimums at a counter it is already standing at, holds back
what the floors protect, sheds what the ceilings and the sell list release, and
reaches for the weapon the list names rather than whichever one it happens to be
best with. Every rule in it used to be a constant shared by all twenty-one
characters.

**A loadout adds rules; it never removes them.** A character without one behaves
exactly as it did before loadouts existed, and a loadout that mentions only
elderberry changes nothing about anything else. That is the property
`m59-loadout-test.mjs` spends most of its 126 assertions on.

## Source analysis

`tools/*.py` and `experiments/*.py` read the Blakod tree directly rather than
playing, because the interesting numbers are never sent over the wire — a spell's
mana cost, its reagents, its karma requirement, armour resistances, monster
difficulty, treasure tables are all declared in kod and enforced server-side.
Both honour `M59_ROOT` and write beside themselves.

```bash
python tools/extract_monsters.py      # kod → monsters.json
python tools/xref2.py                 # which rooms spawn what
python tools/econ_shops.py            # what merchants pay
python experiments/ladder.py          # kills-to-next-HP by stamina and level
```

## Two things that made this harder than the protocol suggested

**Silence.** The server drops illegal and too-fast actions without saying so —
three rate limits, a facing check, a range check, all quiet. The broker paces
every request, so an agent trades visible latency for invisible failure.

**The state a player actually has.** A protocol client sees a list of objects
with coordinates, which is not enough to play. The human client has a minimap,
and that minimap is drawn from the room's `.roo` file — a per-square walkability
grid and a wall-segment list the protocol never mentions. All 264 rooms of it are
parsed and baked in, so `look` returns the room's shape, what is reachable and in
how many steps, and which square to stand on to leave.

A small model does not have to orchestrate any of that. `fight("spider")` finds
the nearest match, arms itself, walks there through the geometry, turns to face,
swings on the server's clock, breaks off if it is losing, and loots the drops —
one call, every stage reported. `autopilot` is a background keeper with no model
in it at all: it rests, withdraws, escapes the Underworld after a death, and
optionally farms one named creature, journalling each decision with a reason.

## Licence

The tooling here is ours. Meridian 59 itself — its source, its art, its data —
belongs to its owners; nothing of the client's is redistributed here, which is
why the sprites are pulled rather than committed.
