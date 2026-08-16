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
broker, creates ten characters, and — if a client is installed — writes a
click-to-play shortcut for each of them. Ten to fifteen minutes, mostly
compiling.

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
| 5 | `node tools/setup.mjs shortcuts` | one click-to-play shortcut per character |

Step 5 needs both of the others: a client to launch and a roster to read. It is
skipped harmlessly when either is missing, and `all` runs it last for that reason.

## Click-to-play shortcuts

`node tools/m59-shortcuts.mjs` writes one shortcut per character into
`shortcuts/` — a `.desktop` file on Linux, a `.lnk` on Windows — carrying that
character's **host, port, account and password** on the client's command line, so
opening it drops you into the world as that character with no dialog:

```
Meridian.exe /H:127.0.0.1 /P:5959 /U:fleet01 /W:<password> /Q /S
```

- `--desktop` copies them to the user's Desktop as well.
- `--proxy` points them at `m59-proxy.mjs` (5961) instead of the server, which is
  what you want if the broker should keep driving while a human is inside.
- `--list` shows the roster; `--show` prints the real command lines.

**Each shortcut is a plaintext password**, so `shortcuts/` is gitignored and
written `0700`, exactly like `substrate/fleet-accounts.json`. Terminal output
masks the password unless `--show` is given — do not pass `--show` in a shared
transcript, and do not commit or paste the files.

**On Linux the shortcut can only be `steam -applaunch 893390 …`**, because the
client is a Windows binary and Proton belongs to Steam. A non-Steam copy on Linux
is reported honestly rather than guessed at. Steam **Game Mode** does not show
`.desktop` files at all; there, put one character's arguments in the title's
Properties → Launch Options.

**Logging in bumps the broker off that character** — Meridian allows one
connection per character. That is expected, and is how `m59-fleet.mjs spec`
works; use `--proxy` when you do not want it.

## The boundary: what this repository decides, and what it does not

Behaviour is split across three repositories and **the split is by CLOCK, not by
importance**. Anything that has to be right within a second stays here. Anything with no
single right answer, that can be re-decided in five minutes, belongs to whoever the
operator pointed at the fleet.

| | decides at | owner | examples |
|---|---|---|---|
| identity, mortality, survival, recovery | **1s** | **this repository, always** | am I dead; something is hitting me; sit down while I am hurt and safe; get out of the Underworld |
| unstick a stalled keeper | 60s | **this repository** | `m59-supervise.mjs`. Telling a deliberate refusal from a stall needs keeper internals, and it runs on bot-held characters too |
| work, movement, economy, social | minutes | **a bot**, when one is attached | what to hunt; which room; which errands to stop for; when to bank |

`meridian59-dum-bot` is the deterministic driver of the third row and
`meridian59-llm-bot` is the hands-on one. Neither may take the first row silently: the
four protected faculties are refused unless the **roster** consents
(`PROTECTED_FACULTIES`, `may_yield`), because an unattended character — one whose bot
crashed, was `Ctrl-C`'d, or was never started — must still run from a fight it is losing.

`node tools/m59-unattended-test.mjs` (44) is the guard, and it is the cheapest insurance
here: with nothing attached, every faculty answers `keeper`, a bot asking for all eight
gets only the directional four, an expired lease is the keeper's again, and the override
takes a character back from a bot rather than letting its next heartbeat reclaim it.
**It should fail the day somebody moves a survival decision out of this repository.**

### The three moments the keeper asks about — `m59-playbook.mjs`

The table above is about *standing* decisions. There are also **moments** where the
keeper has no opinion and should not invent one, and where the fleet's director might.
A **playbook** is that answer, declared per character in
`substrate/playbooks/<character>.json`:

| trigger | why the keeper cannot answer it |
|---|---|
| `attacked_by_player` | the keeper is **structurally blind** to this. `inReachOfUs()` filters `OF.PLAYER` out — correctly, since without it the retaliation branch picked a *fleetmate* 131 times in one sample — so a stranger standing over a character was not merely unanswered, it was unobserved. A monster and a player are not the same problem: a monster does not follow you to another town, does not wait, and does not come back tomorrow |
| `died` | recovering is `mortality` and is unchanged. What the *fleet* does about it — whether somebody rich re-arms the corpse, whether the room comes off the list — is not answerable from inside one character |
| `improved` | max health **is** the level, and a kill only pays when the creature's level is strictly above it. A gain can make the current prey worthless, and the keeper's answer to that is to carry on hunting it, reporting kills, indefinitely |

**THE KEEPER ASKS, IT DOES NOT CALL.** A playbook is a table this process already holds,
read from disk and cached on mtime, consulted with a synchronous function call. There is
no network round trip and there must never be one — the first trigger is precisely the
moment a thirty-second round trip is worth nothing. `ask_for_orders` is the one verb that
waits; it is bounded, opt-in per trigger, and validation refuses more than 5s of it on
`attacked_by_player` because the answer would arrive after the fight.

Three properties, each of which is easy to undo:

- **Silence means the behaviour that was already there, never paralysis.** With no
  playbook, `decide` returns null and the ordinary survival ladder runs exactly as
  before. A playbook ADDS a response; **there is deliberately no verb for standing
  still**, and none for suppressing the floor.
- **The verbs are a closed set** — `nothing, retreat, leave_room, logoff, say, tell,
  ask_for_orders, stand_down`. A bot may not hand the keeper a tool call or a script. An
  unrecognised verb falls through to the next rule and is reported, never guessed at.
- **An unknown condition never holds**, so a typo disables its rule rather than promoting
  it to unconditional — and `validate()` names the fields that trigger actually knows.

The two outward verbs put text in front of real people on a shared server, so the message
must be a **literal written in the playbook**; anything template-shaped is refused,
because text assembled at the moment is how a fleet says something nobody chose.

`node tools/m59-playbook-test.mjs` (37) pins all of it against fixtures — which is the
point, since testing these for real means arranging a player attack, a death and a level
gain on a live shared server.

### Owning a character and being busy with it are different facts

This is the distinction the whole split runs on, and conflating it deadlocks the bot that
asked for it.

- **`claim`** — a bot holds `work`/`movement` on a character for its whole run. The board
  shows `held_by`, and the character stays **takeable**: a bot steering nine characters
  must not grey nine rows, and `m59-supervise.mjs`'s unstick round must keep running on
  them.
- **`busy`** — the holder says an operation is *in flight*. This is the one that makes
  everything step over the character, and it exists because **an external errand walks a
  character with its keeper inert by design**: `ms_since_moved` measures the KEEPER, so it
  climbs while the character is moving perfectly well, and every stall detector in the
  fleet reads it as standing still and restarts the keeper out from under the errand.

```bash
autopilot action=claim faculties=[work,movement] by=<who> lease_ms=120000
autopilot action=busy  by=<who> kind=crate-check label="checking the crate"
autopilot action=free  by=<who>
```

**`busy` is a WINDOW THE HOLDER ESTIMATES, and it extends as the work goes.** A flat lease
is wrong in both directions: too short and a supervisor round walks in halfway through a
trip across the world, too long and a thirty-second errand blocks the unstick round for
ten minutes. So a holder asks for what its remaining work expects — padded, because a leg
that goes *slightly* wrong is the ordinary case and is exactly when being interrupted
costs the whole errand — and re-declares before each step with only what is left. The
harness caps one ask at `BUSY_MAX_MS`, which is `INERT_MAX_MS` (15 min) on purpose: both
answer "how long may something else hold a character before this repository takes it
back", and two answers to that would be two opinions about when a fleet is unattended.
The cap **clamps and says so** rather than refusing, because a refused declaration leaves
the errand unannounced, which is the worse of the two.

Both are **leased and fail back to the keeper**, checked on read rather than on a timer,
so a bot that dies leaves nothing owned and nothing marked busy. Only the holder may
declare or clear `busy`; an operator with no name may always clear it, which is what the
fleet board's override key does — and that override drops the **claim** as well, or the
bot's next heartbeat quietly takes the character back thirty seconds later.

Consumers ask `isTakeable(committed)`, never `!committed`. Those were the same question
for exactly as long as the only commitments were operations; `m59-commitment.mjs` has the
argument and `m59-commitment-test.mjs` (71) pins the regression.

## Which fleet — check this before you touch anything

A fleet is a named roster, one per server, and **passing the wrong one operates on the
wrong fleet quietly**. Nothing errors; you just get a healthy broker holding characters
nobody is playing. So every fleet tool resolves the name the same way, most explicit
first:

| | |
|---|---|
| `--fleet <name>` | what this invocation said |
| `M59_FLEET=<name>` | what this shell said |
| `substrate/fleet-default` | what this checkout cares about — one line, gitignored |
| nothing | `substrate/fleet-state.json`, as it always was |
| `--fleet -` | that unnamed fleet, asked for on purpose |

```bash
node tools/m59-which.mjs            # which fleet, which roster, what the broker holds
```

Read-only, and it **exits non-zero on a mismatch** — when the broker is holding one fleet
and your next command would act on another. Every `/m59*` command runs it first for that
reason. If it reports a mismatch, stop: that is the failure that once took down a live
46-session broker while every step reported success.

`m59-which.mjs` answers for **one** fleet — the one the next command would touch. When
the question is *which fleets does this machine have at all*, ask the other one:

```bash
node tools/m59-fleets.mjs           # every roster here: slots, server, who is holding it
node tools/m59-fleets.mjs --json    # the same, for a launcher
```

A roster file **is** the credential store, so "the fleets with local credentials" is
exactly "the roster files under `substrate/`". It lists every one of them — named and
unnamed — with its slot names, the game server all its credentials agree on, whether a
broker is holding it and on which loopback HTTP port, and whether it is eligible for
local control. It never prints an account, a password or a character name, and it never
starts a broker. A broker is matched to a roster by the **state path** that broker's own
`/health` reports, never by fleet label: two checkouts can each hold a fleet called
`prod` and they are not the same characters.

`maps/m59-boswars`'s commander client is the first consumer — its main menu offers what
this reports rather than only what somebody typed on a command line.

## Running the broker as a service

```bash
node tools/m59-service.mjs start   --fleet prod     # detached, survives this terminal
node tools/m59-service.mjs status  --fleet prod     # up/down, pid, how many are in game
node tools/m59-service.mjs restart --fleet prod
node tools/m59-service.mjs stop    --fleet prod
node tools/m59-service.mjs logs    --fleet prod --follow
```

**Start it this way rather than by hand.** A broker started from a terminal belongs to
that terminal. One was found running with its whole ancestry dead — it had survived only
because Windows does not cascade-kill children — while its log went to a temp directory
that gets cleaned up. This gives it a pid file, a log in `substrate/broker-<fleet>.log`,
and a stop that finds it by `/health` rather than by process name.

It does **not** survive a reboot. `start` is one command; a Windows service would have
meant a third-party binary in a repository where every other tool is dependency-free.

**Every keeper runs inside the broker.** Stopping it logs out every character; there is
no separate keeper process to survive it.

### The page has buttons, on the broker machine only

The fleet page carries Rejoin / Restart / Stop when it is opened on `127.0.0.1`. It binds
to every interface so it can be read from a phone, so the controls are rendered only for
loopback **and** the POST behind them is refused at the socket for anything else — a
hidden button is not a permission check. There is no Start button and there cannot be:
when the broker is down, nothing is serving that page.

### It looks before it logs anybody in

A resume logs in every character in the roster, and Meridian allows one connection each —
so a restart is exactly the thing that throws a person out of the world. It happened here:
a restart to load new code bumped the operator off Zoot mid-sentence, and the auto-claim
only noticed twenty seconds later, because it matches against live sessions and at boot
there are none.

So before the first login, `resumeFleet` reads the command line of every running
`meridian.exe` (`/U:` is the account — `m59-shortcuts.mjs` puts it there), matches it
against the **roster** rather than against sessions, and claims those agents as piloted.
A claim is what the reconciler honours, so one call keeps the character out of the resume
*and* out of the 45s rejoin sweep.

Then it checks. A command line says what a process was *asked* to do, not that anyone
reached the world, so another character reads the who list and looks for that name — and
if the character is **not** online, the claim is released and the character resumed after
all. Otherwise a client left at the login screen would strand a character out of the fleet
for as long as its window stayed open, silently, because standing down looks exactly like
working correctly.

The who list speaks names and the roster speaks accounts, which is why a successful login
now writes the character's name back into the roster entry. That is also why the resume
log says `resumed t1 (Kermit)` rather than `resumed t1 (?)`.

### The roster never shrinks by accident

`substrate/fleets/<fleet>.json` is the only record of the account passwords, and a save
writes whatever `fleetState` currently holds — which *during a resume* is "everyone
processed so far". Anything saving inside that loop, and a keeper starting does, published
a truncated roster to disk for a few seconds: watched live it went 13 of 21 and back. The
old guard noticed, kept a `.prev`, and wrote the smaller file anyway. Now entries on disk
that this process has not loaded are carried forward, and only `forget` removes one.

### It puts back characters that fall out

The broker rejoins sessions that drop, every 45s, and restarts their keepers. This exists
because twenty-one characters once sat logged out for twenty-five minutes while the
broker reported itself healthy and holding twenty-one sessions, every one of them
answering "not in game". Three things it will not do:

- **Undo a `leave`.** Without `forget` that means "out until a restart", and it is honoured.
- **Fight a human.** One connection per character, so a click-to-play shortcut bumps the
  broker off. A character that drops again within 90s of being rejoined is read as
  contention and the wait doubles, to a 15-minute cap. To play one yourself, `leave` it
  first or use `--proxy` shortcuts.
- **Restore orders that were stopped on purpose.** It restarts the keeper that was
  running when the drop happened, not whatever the roster last wrote down.

`--no-rejoin` or `M59_REJOIN=0` turns it off.

## The two front ends, and the one command that starts everything

```bash
./m59.sh                 # the fleet terminal (m59.ps1 on Windows)
./m59.sh up              # broker + field command page, for this checkout's fleet
./m59.sh status          # both of them, and which fleet
./m59.sh down            # both of them again
./m59.sh field           # just open the page
```

`npm run terminal|start|stop|status|field` are the same commands for anyone who reaches
for npm first. **Nothing lives in these scripts** — every behaviour is in `tools/`, so
prefer changing the tool.

There are two views of the same fleet and neither replaces the other. `m59-tui.mjs` is a
list and a keyboard: it is the only one that can start a program, which is what `L`, `B`,
`C` and `F` are for. **`maps/m59-strategy-game` is a map in a browser** — the world, the
roster on it, and a small order set that becomes ordinary broker calls. It holds no
credentials, starts no broker, pins itself to `127.0.0.1`, and its worker refuses
non-loopback hosts, because it is a control plane rather than a dashboard.

`m59-webui.mjs` owns its lifecycle, and `m59-service.mjs` starts and stops it with the
broker — **after** the broker answers, since a page that comes up first spends its first
seconds reporting a fleet that is not there. `F` in the terminal ensures it is running and
then opens a browser at it. `node tools/setup.mjs webui` installs it; `all` runs that.

Four things it does rather than documents:

- **IT NEVER BLOCKS THE BROKER.** The broker holds twenty-one irreplaceable sessions and a
  web page failing to build is not a reason for the fleet not to come up. An absent
  sibling, an uninstalled one and a failed start are all reported and `start` still exits 0.
- **IT IS A SEPARATE REPOSITORY AND MAY NOT BE HERE** — same arrangement `B` has with
  `maps/m59-boswars`. `M59_STRATEGY_DIR` names it when it does not live beside us, and
  "absent", "not installed" and "somebody else is on the port" are three different answers
  that the tool says apart.
- **IT NEVER STOPS SOMETHING IT DID NOT START.** The pid file is the authority; a port
  answering with no pid file of ours is reported as somebody else's and left alone. Stop
  signals the process GROUP, because `npm run dev` is npm with a child and a bare kill
  leaves the dev server orphaned and holding the port — which then reads as "not ours" for
  ever after.
- **It runs `npm run dev`, not the bundler directly**, because that script's `predev`
  refreshes the page's generated world and room maps out of this harness. Skipping it
  serves whatever the map looked like the last time somebody built.

A one-shot HTTP GET in that module has a hard timer under it and settles on `close` as
well as on `end`. The first version capped the body with `req.destroy()`, which emits no
`end` — so the promise never settled, the status line silently stopped printing, and the
only symptom was Node's "Detected unsettled top-level await" on the one code path where it
happened to be the last thing running.

## The collision map is EVIDENCE ABOUT A SERVER, NEVER AUTHORITY OVER ONE

`substrate/m59-map.json` carries baked BSP, sidedefs, sector heights and wall chains, and
the broker validates every in-room move against them with the same rules the stock client
uses — because the server accepts whatever coordinates you send and expects the CLIENT to
enforce collision. Using the server as a collision oracle is how bots walked through walls.

**A move that cannot be validated is refused, not retried.** `TERMINAL_MOVEMENT_REASONS`
in `m59-movement.mjs` is the closed list of failures that no other heading can fix —
`collision_geometry_unavailable`, `room_geometry_mismatch`, `room_security_unknown` and the
rest. They propagate instead of looping, which is what stops a bad route being learned.

**THE BAKE IS LOCAL AND THE SERVER IS NOT.** The map is generated from a source tree here;
`prod` is somebody else's machine and can be patched on a Tuesday without telling us. Two
consequences the design turns on:

- **A stale map is a WARNING at startup, not a refusal.** It used to `return 1` — no
  broker at all. But the per-move validator already fails closed one room at a time,
  against the server's own announced security value, so refusing to start adds no safety
  and enormous blast radius: a map that drifted in four rooms would cost twenty-one
  characters, every room, and everything that is not movement. `--require-map` (or
  `M59_REQUIRE_MAP=1`) restores the refusal for a machine that should not run a fleet it
  cannot fully validate. It is opt-in because the failure it prevents is smaller than the
  one it causes.
- **Drift is recorded and reported, not merely refused.** Every room whose live security
  disagrees with the bake is written down and surfaced on `/health` as `geometry_drift`
  and on `m59-service.mjs status`. A refusal says a character did not walk; the record is
  what says the WORLD changed, which is the half anyone can act on. Refresh with
  `node tools/setup.mjs server`.

Two things to know before editing that path:

- **`validateFineTarget` and `queueValidatedMove` are LIFTED OUT OF `m59-broker.mjs` BY
  TEXT and evaluated** by `m59-collision-test.mjs`, because the broker cannot be imported
  without taking the fleet lock. So **any module-scope symbol either of them calls must be
  declared in that test's `dependencies` map** — a free identifier that is fine at runtime
  is a `ReferenceError` in the test, which is how this was caught. `validateFineTarget`
  stays PURE and returns its evidence; the caller writes it down.
- **The map costs real memory.** Measured on this machine: 26.8 MB on disk, **5.6 s and
  ~399 MB RSS** to load and validate 264/264 rooms at broker start. The PR that introduced
  it measured 3.2 s and 303 MB elsewhere, so budget for the machine rather than the number.

`node tools/m59-collision-test.mjs` (150) pins it, and **10 of those skip without the raw
`.roo` files** — set `M59_ROO_DIR` (or `M59_ROOT`) to a tree containing `resource/rooms`
or the suite quietly reports 137 and calls it a pass.

## Backing the fleet up, and putting it back

```bash
node tools/m59-backup.mjs                 # every destination, everything
node tools/m59-backup.mjs --list          # what exists, where, and how many rosters
node tools/m59-backup.mjs --credentials-only    # just the irreplaceable part, seconds
node tools/m59-backup.mjs --verify <dir>  # re-hash a backup against its own manifest
```

Two destinations by default — `C:\m59\backups` and `D:\m59\backups`, override with
`M59_BACKUP_DIRS` or repeated `--to` — because a backup on the same disk as the original
protects against somebody deleting a file and against nothing else.

**What is actually at risk, in order.** The **rosters** (`substrate/fleets/<name>.json`,
`substrate/fleet-state.json`, `substrate/fleet-accounts.json`) are the only record of the
account passwords: no reset, no email on the account, no way to ask the server. Lose one
and those characters are not deleted, just permanently unreachable. Then the **character
sheets**, which are the only snapshot of `prod` — `m59-shutdown.mjs` copies the *server's*
savegame aside, and prod's server is somebody else's machine, so run against prod it copies
a stale local save and reports success. Then the **records** (abilities, banks, tougher,
descriptions, history), none of which can be backfilled.

The backup refreshes the character export first (`m59-sheet.mjs --checkpoint`), and carries
on without it if the broker is down — saying so — because a backup that refuses to run when
the fleet is down is missing exactly when the rosters most need copying.

Four things it enforces rather than documents:

- **A backup with no roster in it is refused.** The failure that matters is not a crash, it
  is a nightly job reporting success while containing everything except the one file nobody
  can regenerate.
- **`*.lock` is never backed up.** `prod.json.lock` is 32 bytes naming a pid; restored it is
  a stale claim that stops a broker starting. It was also being *counted as a roster*, so a
  directory holding nothing but a lock would have satisfied the guard above.
- **Nothing is written inside the repository** — in there it is either committed (plaintext
  passwords in git, for ever) or gitignored and deleted by the next clean.
- **What was written is read back**, hashed. That caught a real bug on the first live run:
  hashing each file once but re-reading the source per destination gave D: different bytes
  for `substrate/hits/*.json`, which the running broker rewrites every few seconds. Sources
  are now read once and the same bytes go to every destination, so the copies are identical.

```bash
node tools/m59-restore.mjs --list
node tools/m59-restore.mjs --latest          # says what it WOULD do, changes nothing
node tools/m59-restore.mjs --latest --apply
```

**Restore is the dangerous half, in a specific way.** A roster gains entries over time — a
new character, a name written back after a first login — so a week-old backup is a smaller,
older, entirely valid-looking file that restores cleanly and silently loses every account
added since. So: it plans by default and needs `--apply`; it **refuses while a broker holds
the fleet**, which owns the roster and rewrites it from memory (stop it with
`m59-service.mjs stop` first); it copies whatever it replaces to
`substrate/.before-restore-<stamp>/` — gitignored, and holding rosters, so it is as secret
as the originals; and **a roster that would shrink is refused outright** unless you pass
`--force`. A backup that does not verify against its manifest is never restored at all.

`node tools/m59-backup-test.mjs` (42) pins all of that against scratch directories.

## Setting a test scenario up — DM powers, and a scenario in one file

Everything in this section is for a server running **on this machine**, and all three tools
refuse a host that is not loopback rather than trusting you to remember. The maintenance
port is unauthenticated and IP-restricted and that is its entire security model, so
pointing it at `prod` — somebody else's machine, with real players on it — is not a
configuration choice.

```bash
node tools/m59-dm.mjs where TESTER Alpha           # names -> object ids
node tools/m59-dm.mjs relocate Alpha,Bravo 60 --at 13,16 --verify
node tools/m59-dm.mjs kit TESTER --stats 50 --health 151 --karma -60 --spells 99
node tools/m59-dm.mjs heal Alpha,Bravo
node tools/m59-testbed.mjs up    scenarios/arena.json     # the whole scenario
node tools/m59-testbed.mjs reset scenarios/arena.json     # between rounds
node tools/m59-patrol.mjs --agents arena1,arena2 --room 60 --radius 5
```

**WALKING IS THE WRONG TOOL FOR PLACING A TEST CHARACTER.** Getting six characters from the
newbie island to the Tos arena by travelling took about twenty minutes and failed halfway
on five of them; the same placement over this socket is **0.22 seconds, verified**. The
primitive is `System.UtilGoNearSquare` (`util.kod:20`), whose own docstring is "Move any
object anywhere in any room" and which is what the DM rescue spell uses.

**A SCENARIO FILE IS A CREDENTIAL STORE**, because creating the account is the one step that
cannot go over the game protocol. `/scenarios/*.json` is gitignored for the same reason a
roster is; `*.example.json` is the exception and its passwords are placeholders.

Five things these tools do that are not obvious:

- **THE SOCKET NEEDS NO PACING AT ALL, and every other caller in this repository paces
  itself.** 70ms in `m59-godmode.mjs`, 400ms in `m59-makefleet.mjs` — and that pacing IS
  their runtime. Measured: **2000 commands written as one buffer got 2000 replies**, with
  no elapsed time beyond the settle wait the measurement itself imposed. `m59-dm.mjs`
  writes a batch in one go and reads until a sentinel, so a full character kit went from
  fourteen seconds to under one.
- **OBJECT IDS ARE NOT STABLE. The server renumbers them when it garbage-collects, which it
  does on every save** — `[Auto] SavePeriod` is 15 minutes here. In one session a character
  resolved as 7218, was configured as 7218 successfully, and half an hour later object 7218
  was a heartstone while the character had become 7124. Nothing errored. So resolve names in
  the same batch that uses them and **never cache an id across a call**; a broker holding
  stale ids goes quietly deaf and the cure is `m59-service.mjs restart`.
- **`reset` IS THE VERB THAT MATTERS**, because it runs between every round rather than once
  per scenario. It is deliberately the cheap one — ceilings, heal, place, all pure
  maintenance-socket batches, no broker, no walking, no logins.
- **A SPEC STATES AN END STATE, NOT AN ERRAND** — the same shape as the guild wants, and for
  the same reason. `reagents: 50` means "carries 50", so `give` reads the pack and creates
  only the shortfall. The first live `up` re-run doubled every stack to 100 before this was
  fixed, which is what a delivery does and not what a spec means. It tops up and never takes
  away: trimming would mean deleting objects out of a character to satisfy a number.
- **SAY A BOT'S NAME IN AN ARENA AND IT SAYS `challenge`.** `arenaCall` in `m59-chatter.mjs`,
  guarded on a loopback server AND an arena room AND the whole utterance being the name —
  not a substring, or a bot called Echo answers "echo location" and the keeper's own status
  line (which opens with the character's name) calls every bot in the room into the ring for
  ever. The keeper's `social()` stands down when it matches rather than answering first,
  which it used to: asked to challenge, Alpha replied "Alpha: not hunting anything, 88/50
  health."

## Asked for a "minimal summary"?

```bash
node tools/m59-minimal.mjs            # min/max/avg max health and kills per minute
node tools/m59-minimal.mjs --minutes 60
node tools/m59-minimal.mjs --json
```

Six numbers and nothing else, so the same request gives the same shape every time and
two readings can be compared. Max health because it IS the level here; kills per minute
because it is the rate that vigor, supply, safe spots and room choice all exist to
protect.

**Kills come from the ledger, never from a keeper's own tally.** `Autopilot.tally.kills`
is emptied in the constructor and keepers restart constantly, so that field means "since
the last restart" and cannot answer "is this character earning now". Do not answer this
question by averaging `fleet` rows.

## Who is not fighting, and what is stopping them

```bash
node tools/m59-overhead.mjs           # worst first: travel + trade against fighting
```

Overhead is travel plus trade. A character at 90% overhead and 0% fighting is not idle
and not stalled — it is busy doing something that is not the job, and the fleet board
cannot show that because every row looks healthy.

**Read the castings column, never the reagent pair.** Castings are
`min(elderberry, herbs) / 2`, so 3/94 is ONE casting and reads as well stocked to
anything that sums or averages. Measured on this fleet: every character at or below 3
castings ran 76-100% overhead with 0-8% fighting, and every character above 18 castings
ran under 55% overhead. Characters without reagents spend all their time getting reagents.

**And read the band.** `walking_money` is both the float kept after banking and the floor
`restockReagents` refuses to spend below, so what a character can actually spend is
`bank_above - walking_money`. At the shipped 500/400 that band is 100 shillings: purses
sat at 0-586 against bank balances of 10,000-36,000, restocks arrived 150 shillings at a
time against a 3,360sh full fill, and trading reached 54% of all active time against 17%
fighting. Raising `walking_money` makes it worse, not better — it is a floor.

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
`Meridian.exe` is involved. The client is for *watching* the fleet, for the
click-to-play shortcuts, and for the compendium's sprite art. If the user only
wants a fleet, a missing client is not a blocker and you should not present it as
one.

**Either server tree works.** `setup.mjs` clones `Meridian59/Meridian59`
(upstream) by default. `tpeppers/Meridian59-deck` is a public fork adding gamepad
and Steam Deck support; it works too, from `2c6d8091` onward. Someone who wants
it sets `M59_ROOT`. Do not switch trees to "fix" an unrelated problem.

**Docker's daemon is separate from its CLI.** `docker --version` succeeding does
not mean anything can be built. If the daemon is down, say so and ask the user to
start Docker Desktop; do not try to start it yourself unless they ask.

## Traps that will waste your time if you do not know them

- **A `send` REPLY NAMES ITS RECEIVER BEFORE IT NAMES ITS ANSWER, so a bare
  `/OBJECT (\d+)/` reads the wrong number.** The maintenance socket answers

      :< return from OBJECT 0 MESSAGE FindRoomByNum (10268)
      : OBJECT 267
      :   is CLASS TosArena (10374)

  and the first match in that is the object the message was SENT TO. Asking for the arena
  therefore returned **0**, and six characters were relocated into the system object while
  every reply said success — because `UtilGoNearSquare` never says no either: handed a
  target square of (99,99) in a 24x24 room it searches outward, lands somewhere else, and
  returns 1. `returnedObject` in `m59-dm.mjs` takes the line that is only a colon and an
  object; `m59-godmode.mjs` had the same fallback for its money lookup, where it would have
  matched the player. **Verify a placement by reading the character back**, which
  `relocate --verify` does — a reply of 1 means "somebody was moved somewhere".

- **THREE MESSAGES FOR REFILLING A VITAL LOOK RIGHT AND ARE NOT.** `GainHealth` is not the
  one whose docstring says it stops at the maximum: it caps at **twice** `piMax_health`
  ("some attempt here to quell the vamp touch bugs"), so a flat `GainHealth 10000` leaves a
  50-health character reading **88/50**. `GainMana` does not clamp **at all** unless passed
  `bCapped`, which defaults FALSE. And `GainHealthNormal`, the one that does clamp, returns
  0 and changes nothing when health is already over the maximum — so it cannot undo the
  first. `m59-dm.mjs heal` reads each character's own ceiling and SETS the property, which
  is the only thing that brings an over-max character back down.

- **MAX MANA IS DERIVED, AND IT LOOKS STORED.** `piMax_Mana` is declared at 20 and the only
  thing that visibly writes it is `GainMaxMana`, so grepping for writers says "stored" —
  which is what this file's author concluded out loud, and it is wrong.
  `ComputeMaxMana` (`player.kod:6116`) throws the number away and rebuilds it from
  `GetInitialMaxMana = 15 + mysticism/5`, plus melded mana nodes, worn items and
  enchantments; it runs **on login**, on an equipment change and on an enchantment change.
  So a character set to 200 reads 200 for as long as you watch it and comes back from the
  next relog at 25. The durable lever is mana nodes — `piNodelist`, what `m59-mananode.mjs`
  exists to earn. For a test character the ceiling is the test bed's to maintain, which is
  why `m59-testbed.mjs reset` re-asserts it before healing.

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

- **What you CARRY and what you are WEARING are two different lists.** Equipment
  lives in `plUsing`, not the inventory, and the server volunteers it: whole on
  `BP_USE_LIST`, one line per change on `BP_USE`/`BP_UNUSE`, and free behind every
  inventory request (`user.kod:955`). `client.equipment()` is the only authoritative
  answer — do not re-derive it from what a `use` was asked to do. Wielding something
  you already wield is **refused** ("your hands are too full", `player.kod:131`), so
  "no error" has never meant "equipped".

- **Ability levels are pushed, so do not poll for them.** `ChangeSkillAbility` calls
  `DrawStatSkill` on every change (`player.kod:7343`), which sends `BP_STAT` for the
  one slot that moved. Reading them costs four requests and 1.2s — the spell and skill
  LISTS have to be re-read first, because a group-3 packet is positional against
  `plSpells` and against a stale list every number is mislabelled silently. So it is
  read once after login and kept: `substrate/abilities/<character>.json`, one file per
  character, `node tools/m59-abilities.mjs` to read it.

- **The skill names are not what they sound like.** Seven of the eight weapon
  proficiencies were invented in this repository until recently: the mace one is
  called **"mace fighting"**, the sword one **"fencing"**, and axe/scimitar/hammer are
  **"wielding"** rather than "proficiency". Take them from `WEAPON_PROFICIENCY` in
  `m59-skills.mjs`, which cites each kod file. A name nothing answers to is
  indistinguishable from a skill the character has not learned — both come back null,
  which is why it survived so long.

- **A stat's `name` only exists for groups 1 and 2.** `STAT_NAMES` covers condition
  and attributes, so `statsById` files a group-3/4 stat under `"4.7"` and nothing
  else. Any by-name search of that map for a skill returns null — which is also the
  legitimate "not read yet" answer, which is why it went unnoticed for so long. Use
  `client.abilityOf(name)`, which is keyed off the object id the stat actually carries.

- **`emit(kind, data)` spreads `data` over the event.** A payload field called `kind`
  replaces the event's own, and every listener waiting on the real kind silently
  starves while the emit itself looks fine. The ability event carries `what`, not
  `kind`, for exactly this reason.

  The ledger's `recordEvent(character, kind, detail)` had the same shape and the same
  bug: a purchase whose detail carried `kind: 'elderberry'` filed itself as an
  elderberry event, so nothing searching for `bought` ever found one — and the write
  succeeded. It now applies `type`/`character`/`kind` *after* the spread, so a detail
  field of the same name is inert instead of silent. The purchase payload is
  `item_kind`. `m59-spellaudit-test.mjs` pins both halves.

- **EXITS ARE NOT DOORS, AND THEY ARE NOT 1:1.** Walking from room A to room B through
  an edge does NOT put you where the return trip starts. You arrive somewhere in B, and
  the edge back to A can be a long way from there — often most of a room away. There is
  no turning round and stepping back through the way you came.

  This breaks the intuition every routing bug in this repo has been debugged with. A
  route that worked outbound failing on the return leg is the NORMAL case, not evidence
  of a one-way door, a broken boundary, or an unmapped region. `no floor anywhere on the
  <dir> boundary` in particular means only that the boundary column the router chose has
  no standable square — the connection can still be perfectly traversable by walking to
  where the real exit actually is.

  Do not conclude "unidirectional travel" or "sealed area" from a failed return trip.
  The map graph records that A and B connect; it does not record that the two ends are
  in the same place, and they usually are not.

- **One or two of the five Underworld portals are unlit, not all of them.**
  `ResetPuzzle` (`uworld.kod:460`) lights all five and turns one or two off at
  random, so three or four work at any moment and each has a fixed, known
  destination. An unlit one is silent, which is why the old code read a working
  pentagram as a dead one. `node tools/m59-underworld.mjs` prints the table.

- **"BUYS ANYTHING" IS USUALLY A ROBBERY, AND BOTH THE FLAGS AND THE INDEX SAY IT
  CHEERFULLY.** `substrate/m59-merchants.json` reports `buys_anything: true` for the
  bankers, and the object's affordances include `buy`. Both are accurate and neither
  means it will pay you. **Skivlat takes what you hand him, says thank you, and gives
  nothing back** — it is a trick played on new players, and nothing on the wire
  distinguishes it from a sale. This nearly emptied the fleet: a town-selling change
  was one trip away from handing twenty-one packs, 1,864 units of mushroom, gem and
  tooth, to a banker for nothing.

  Three different NPCs answer to "buys anything" and only one is a market:

  - **Roq** — the only NPC known to buy an unlimited quantity of anything. It is the
    Barloque assassin (`assassin.kod`, `Assassin is BarloqueTown`) and it is **not in
    the merchant index at all**, which is why nothing has ever sold to it. **Izzio** and
    the island vendor are close to it with rules of their own.
  - **The two vaults**, one mainland (Barloque) and one on the island. They "buy"
    anything and sell it back for about a shilling. They are **storage, not a market** —
    and storage that SURVIVES DEATH, which is the only thing in the game that does. That
    makes them the right tool for holding something the fleet will need later rather
    than dropping it on the next corpse, and for one character to leave something where
    another can collect it. Never sell into one by accident.
  - **Everyone else claiming it** — assume the robbery.

  So selling is an ALLOWLIST, not a check: `SELL_TO` and `NEVER_SELL_TO` in
  `m59-skills.mjs`, via `trustedBuyer()`. Being wrong about a buyer costs the whole
  pack; being wrong about a walk costs a walk.

- **A BANK BALANCE IS PROSE, IT IS SENT ONCE, AND A WITHDRAWAL DOES NOT STATE IT.**
  There is no packet for the balance. The banker says it out loud — `Lm_bnkr_balance`,
  `monster.kod:136` — and never mentions it again, so the only way to *read* one is to
  walk a character to a counter and ask. That is why it is caught off the event stream
  and written to `substrate/banks/<character>.json` the moment it goes past, exactly as
  abilities are. `node tools/m59-bank.mjs` reads the whole fleet's balances back without
  moving anybody; the `fleet` tool carries `purse` and `banked` on every row.

  Two things about it are counter-intuitive. **A withdrawal reports the amount handed
  over, not the new balance** (`Lm_bnkr_did_withdraw`, `monster.kod:144`), so that one
  figure is arithmetic against the last stated balance and is flagged
  `observed: false` — do not report a derived number as though a banker said it. And
  **there are two accounts, not one per town**: Jasper and Tos both pay into bank 1,
  because `BANK_BASIC` and `BID_TOS` are both `1` (`blakston.khd:1275`) and `JasperBanker`
  is created with `#bid=BID_TOS`, while Ko'catan is bank 2. "But you only have N shillings
  in your **possession**" is the purse, not the account, and differs from the account line
  by one word.

  **Correction, 2026-08-12: this used to say Barloque was a third counter on bank 1, and
  there is no bank in Barloque at all.** `BarloqueBanker` — "Setag'lib", `bqbanker.kod:11` —
  is declared, compiled and present in `kodbase.txt`, and `Create(&BarloqueBanker)` occurs
  **nowhere in the room tree**; only `jasbank.kod`, `tosbank.kod` and `kocbank.kod` ever
  place one. A class that exists is not an NPC that stands somewhere, and a source-derived
  table cannot tell the two apart — which is how a banker nobody has ever spoken to got into
  three documents. The tooling was always right: `BANKS` in `m59-autopilot.mjs` lists 54 and
  376 and no Barloque room. Only the prose was wrong.

- **LOOKING AT A PLAYER IS NOT `BP_LOOK`.** `Player.TryLook` (`user.kod:4374`) diverts to
  `SendLookPlayer`, which answers with **`BP_USERCOMMAND` / `UC_LOOK_PLAYER` (2)** —
  object, an editable byte, a formatted description, then two plain strings
  (`merintr.c:1501`). This client sent `BP_USERCOMMAND` and never parsed an incoming one,
  so every `look_at` on a character timed out and blamed `OF_NOEXAMINE`, **and I read that
  silence as proof the protocol could not answer.** It can. A packet nobody parses is
  indistinguishable from a packet nobody sends, and the difference is a whole command
  space. A player in another room is refused (`user.kod:4383`); a player looking at
  *itself* is not, which is exactly what the real client's right-click-your-own-portrait
  dialog does.

- **A DESCRIPTION REPLACES THE LOOK TEXT.** The bio another player sees is
  `psPlayerDescription`, set with `BP_CHANGE_DESCRIPTION` (126) and saved with the
  character. `Player.ShowDesc` (`player.kod:1521`) sends it under the `"%q"` resource and
  **returns**, never reaching the propagate that builds the default prose — so a character
  carrying one stops announcing its own level and guild to anyone who looks. The server
  acknowledges the write with nothing at all, so `describe` records what it sent to
  `substrate/descriptions/<character>.json` and `m59-describe.mjs --verify` goes and looks:
  the record is the claim, the look is the evidence.

  Two traps. **Clearing is not undoing** — `""` is not `$`, so an empty description is a
  *blank* bio, not the default text, and there is no way back short of a re-roll
  (`user.kod:4444` reads a nil string as "keep the old one"). And **the wire is Latin-1**:
  `pstr` is `Buffer.from(s, 'latin1')`, which keeps the LOW BYTE of anything above
  U+00FF, so an em dash goes out as `0x14` and nothing errors. `cleanDescription` folds
  the punctuation people actually type and drops what it cannot fold.

- **A POSTMORTEM KNOWS WHAT KILLED IT AND USUALLY DOES NOT KNOW WHERE.** The two halves of
  a death have completely different evidence behind them and must never be read the same
  way. **What** is announced by the server to the whole world — `### X was just killed by a
  Y.` (`system.kod:49-57`, caught as `killed_by_broadcast`), an observation. **Where** is
  reconstructed from the keeper's last frame, and a keeper pass can be a single `await`
  lasting minutes, so the record names the last place anybody looked. Measured over 637
  deaths: the last frame is more than a minute stale in 203 of them, worst case 17 minutes.
  That is why the raw data lists inns as places characters died. Nobody died in an inn.

  `m59-postmortems.mjs` refuses to place a death unless an independent observation lands
  within 30 seconds of the killing blow — a `hits` segment first, because the event stream
  keeps recording while the keeper is blind, then the last frame. The window is measured,
  not chosen: 30s keeps 384 of 637 and leaks no inn, 60s starts letting them back in. The
  253 it cannot place are reported as a count, never as a room.

- **"WAS THE KEEPER UP" IS THE WRONG QUESTION. IT USUALLY WAS, AND IT USUALLY WAS NOT
  LOOKING.** Of 715 deaths, 645 had a keeper the uptime ledger says was running — and
  **521 of those 645 (81%) had it BLIND at the moment of death**, median gap 18 seconds,
  p90 219 seconds. A pass can be a single `await` lasting minutes (a travel loops up to 25
  hops with no observation in it), so the keeper goes on deciding against a view of the
  world that stopped changing. Every one of those decisions includes "should I flee".

  `keeperOf()` in `m59-postmortems.mjs` therefore answers both halves, and the deaths page
  shows `Y 3s` / `Y blind 18s` / `N` rather than a bare Y. The blind threshold is
  **`WATCH_MS`, 8s — the keeper's own `resyncMs` default**, the longest it is designed to
  go without re-asking the server. It is deliberately NOT `TRUST_MS` (30s): that one asks
  whether a reading still places a death, this one asks whether the keeper could have acted
  on it, and a character can bleed out entirely inside a window that still places it.

  The worked example is Camilla, 2026-08-06 23:59. The keeper was up continuously for 16
  minutes either side. At −18.0s it saw 69% health, took a safe spot and refused to rest in
  the open. **0.2 seconds later, in the same pass, the room check fired — "this room cannot
  produce our prey — leaving now" — and it gave up the wall it had just taken (`held_s: 0`)
  and walked.** Its last frame reads 22/29, above its own flee threshold of 0.69. The
  event stream recorded the next 18 seconds — 22 → 19 → 18 → 16 → 14 → 11 → 10 → 5 → 4 → 0
  — while she ping-ponged across the 574/584 boundary taking a hit from each room's
  monsters on every crossing. She never swung once; `ms_since_swung` was 409783.

  **`leaveHold` now refuses a DISCRETIONARY departure below the rest threshold** — routing,
  roaming, banking and errands all go through it, and the room will still be the wrong room
  in thirty seconds. `force: true` keeps the withdraw path open, because a hurt character
  is exactly who is withdrawing. `readyToLeaveSanctuary` is the same rule for inns and does
  not cover this: it returns true immediately unless `sanctuary()`, and a monster room with
  a proven wall in it is not one — though it is the safest square in the world to be hurt
  in, which is precisely why leaving was the mistake. The refusal cannot deadlock (the rest
  gate above rests to full on the wall) and is capped at three minutes anyway.

- **THE KEEPER IS A LONG-AWAIT MACHINE, AND THE WATCHDOG IS THE ONLY THING WATCHING
  DURING ONE.** `pass()` is one async function and a single `await` inside it can run for
  minutes. Measured across 703 deaths with a usable frame: **82% had the keeper blind
  (>8s since its last observation) at the moment of death**, and the last thing it was
  doing breaks down as

  | doing | deaths | mean blind | worst |
  |---|---|---|---|
  | travelling | 203 | 183s | 909s |
  | recovering | 153 | 73s | 736s |
  | stalled | 120 | 40s | 1043s |
  | fighting | 87 | 44s | 540s |

  **Bracketing the await does not fix it, and travel already brackets.** `Autopilot.travel`
  records 'setting off' and 'arrived' frames either side; Camilla's last frame reads
  `why: "setting off"` 17.8s before she died, and the `finally` frame never described
  anything because she died inside. A bracket tells you when the blindness started.

  So the fix is a timer, not another await. `startWatchdog()` ticks every 500ms
  independently of the pass — free, because the server PUSHES health, so `client.vitals()`
  is live whatever the call stack is blocked on. It writes a frame on every health change
  and at least every 8s, and if health crosses the flee line while a pass has been blocked
  over 3s it calls `Session.cancelMovement()`, which travel honours in twelve places
  including inside the paced step loops. **It decides nothing** — it interrupts, and the
  ordinary pass, which already knows how to flee and rest, decides with fresh numbers.

  Worth knowing before extending it: `restUntil` already polls every 3s and aborts on
  damage, and `fight` already aborts below `disengageAt`. **Travel was the only long await
  with nothing watching health**, which is why it is both the largest bucket above and the
  one the interrupt targets. An interrupt that costs an errand its attempt is the correct
  outcome, not a bug to route around.

- **"YOU SUDDENLY FEEL A LITTLE TOUGHER." IS THE ONLY ANNOUNCEMENT OF THE ONLY THING THIS
  FLEET IS FOR, AND NOTHING WAS LISTENING.** `player_improve_maxhealth` (`player.kod:144`)
  is sent the instant `GainBaseMaxHealth` fires, inside the killing blow. The ledger
  instead INFERRED gains by diffing five-minute samples, so two points in one window were
  one event, a point gained and lost in the same window was no event, and anything during a
  broker outage never happened. `m59-tougher.mjs` catches the line and attributes it to the
  kill that paid for it — which the diff could never do.

  **Attribution is symmetric in time and that is not fussiness.** The kill is written down
  after `fight()` returns; the message is read off the event ring on the next pass. So the
  kill usually lands a few milliseconds AFTER the announcement it caused. Requiring it to
  come first filed the fleet's very first real gain — Lew 22→23 in The Queen's Way — as
  "cause unknown" with the kill sitting in the feed 40ms later.

- **A COUNTER THAT LIVES ON THE KEEPER IS NOT A RATE, BECAUSE THE KEEPER IS RESTARTED
  ABOUT ONCE A MINUTE.** `Autopilot.tally.kills` and `killTimes` are both fields set to
  empty in the constructor, and the external supervisor stops and restarts keepers
  continuously — so both mean "since the last restart" and neither can answer "is this
  character earning now". The board's `kills/30m` was worse than wrong: `recordSample`
  never wrote the field at all, so `r.kills_30m` was undefined on every render, `?? 0`
  made it a number, and the template paints zero in the colour reserved for a broken row.
  Twenty-one characters that had killed at least 26 things in half an hour rendered as a
  page of red zeroes, and plumbing the keeper's own figure through would only have
  changed a permanent zero into a near-permanent one.

  Kills are therefore appended to the ledger as `killed` events at the moment of the
  kill, and `countKills` in `m59-ledger.mjs` is the **only** definition of the number —
  the web board and the broker's live rows both count the same events, because a
  quantity with two homes in this repository has always ended up with two answers.
  `kills` beside it is still a high-water mark over the whole window (`Math.max`, for
  exactly the same restart reason), so a row honestly reading `134` and `0` is not a
  contradiction: the two columns are on different clocks and neither is the other's rate.

- **A SIGNET RING IS WORTH TEN TIMES MORE IN A SMALL CHARACTER'S HANDS, AND THE OWNER
  USUALLY HAS AN ADDRESS.** Returning one pays its value ten times over to a character
  that has not enabled player-killing and plain value to one that has (`ringsgnt.kod:94`)
  — and nobody here enables that deliberately. `EvaluatePKStatus` (`player.kod:11047`)
  sets it *for* you the moment base max health reaches 30, or you join a guild. Max health
  is the level here, so **a ring returned by a character under level 30 is worth ten times
  the same ring returned by anyone else**: up to 1500 shillings against up to 150. Which
  of them is holding it is decided by whoever happened to loot it, so `signets
  action=redistribute` moves them down and `action=return` sends them to be cashed.

  Three things about it read backwards. **1500 is a ceiling, not a price** — `GetValue`
  scales with a condition this class refuses to show (`vbShow_condition = FALSE`), so the
  real payout is anywhere from 100 to 1500 and cannot be predicted; read the purse
  afterwards. **The owners mostly do not wander** — I recorded that they did and that an
  NPC-location table would not help, and that was wrong: `CreateSignetRing`
  (`library.kod:4245`) draws from nineteen NPCs, fifteen of which stand in a fixed room in
  Barloque, Cor Noth, Jasper, Marion or Tos. `SIGNET_OWNERS` in `m59-skills.mjs` is that
  table, and two classes that exist in the kod are deliberately absent from it because
  nothing ever creates them. **And they expire** — the world holds twenty signets, and a
  twenty-first deletes the oldest out of whoever is carrying it (`library.kod:4288`), so
  hoarding one loses it.

- **A FACTION IS A SUBSCRIPTION, THE BILL IS ONE SENTENCE, AND THE CLOCK RUNS WHILE THE
  CHARACTER IS LOGGED OUT.** `FactionServiceTimer` (`player.kod:11238`) re-arms every 20
  minutes and accumulates **wall-clock** unserved time. At `FACTION_WARN_TIME` (72000s,
  20h) it sends `player_faction_time` — *"Your liege is no longer convinced of your
  loyalty. You should visit your liege at court again."* At `FACTION_RESIGN_TIME` (86400s,
  24h) it calls `ResignFaction`. **Four hours between them**, and the expulsion announces
  itself only afterwards.

  There is no packet, no stat and nothing to poll — it is `MsgSendUser` prose, so it is
  caught off the event stream and written to `substrate/faction-status/<character>.json`
  exactly as a bank balance is. `node tools/m59-loyalty.mjs` reads the fleet back without
  moving anybody; `--serve <name>` plans the errand.

  Five things that read backwards:

  - **THE WARNING IS WHAT CREATES THE QUEST.** Service quests declare
    `QT_SCHEDULE_CHANCE = 0` (`questengine.kod:1657`), so the ordinary quest timer never
    makes one. Only `JoinFaction`, a completed previous service, and the warning branch
    itself (`#override=TRUE`) do. Saying "loyalty" to a liege that has not warned you does
    nothing at all, silently — and the warning is reliable evidence that a node is waiting.
  - **THE WARNING REPEATS EVERY 20 MINUTES AND IT IS THE SAME DEADLINE.** Re-dating on
    each repeat pushes the due time forward for ever, and the character is expelled while
    the record says it has hours left. `noteLoyaltyWarning` refuses to re-date an open one.
  - **ASKING TRADES FOUR HOURS FOR ONE, AND THE PENALTY IS EXPULSION.** Every faction's
    last node carries `#penaltylist = [[QN_PRIZETYPE_FACTION, QN_PRIZE_FACTION_NEUTRAL]]`
    on a one-hour timer (half an hour for the Duke), and arriving one second late awards
    the penalty rather than the prize (`questnode.kod:846`). Make the trade anyway — not
    asking loses the membership with certainty — but **carry the payment first**.
  - **THE LIEGE NAMES ONE ITEM OUT OF SEVEN.** `pCargo` is a single
    `GetRandomCargoFromQuestNodeTemplate` (`questnode.kod:226`) compared by CLASS
    (`:699`), so carrying a candidate is a one-in-seven head start, not readiness. Rook in
    **room 154** is the only reliable counter — `CorNothSergeant` does not declare
    `vbSellFromInventory`, so he cannot run out of long swords. Izzio can, and wanders.
  - **A SOLDIER IS WARNED FOR EVER AND NEVER EXPELLED.** `UpdateFactionService`
    (`player.kod:11203`) clamps the counter at the warn threshold while a `SoldierShield`
    is worn. Read naively that sends every soldier on the errand every 20 minutes for ever,
    so `loyaltyDebt` reports a soldier's debt with **no deadline** rather than as no debt.

  **A quest node is deaf beyond five squares and says nothing about it** — `SquaredDistanceTo
  > Q_NPC_CLOSE_ENOUGH^2` is checked before the message is (`questnode.kod:650`), so in a
  large chamber the word is spoken, the room hears it and the quest does not. Checked before
  speaking. **And a node belongs to ONE character** (`questnode.kod:800`): a fleet all
  shouting "loyalty" at one liege gets one quest and twenty silences.

  **The Duke is recognised and deliberately not automated** — his middle leg is "say `tax`
  to whichever townsperson I name", which would need a speech allowlist covering three
  towns, on two half-hour timers. `node tools/m59-faction-test.mjs` (63 more assertions)
  pins all of the above; the DUM side is `factions.keep_membership`.

- **A CHARACTER CAN BE SPOKEN FOR, AND THE BOARD HAS TO SAY SO.** A loot run, a
  provisioning cast, a signet errand and a pairing all have another end, and pulling a
  character out of one abandons that end silently. `m59-commitment.mjs` is the single
  rule for what counts; the keeper publishes it as `committed` on its status and on the
  fleet row, and `m59-tui.mjs` greys those rows and steps over them, with `X` to override
  and take one back. Add a new errand kind and it shows up on the board that day — an
  unrecognised kind is reported as itself rather than dropped, which is what stops a new
  operation being invisible to the one thing meant to protect it.

- **A CHARACTER CAN BECOME UNABLE TO RECEIVE, AND IT LOOKS EXACTLY LIKE A BROKEN TRADE
  PROTOCOL.** It can still GIVE, still fight, and reads as completely healthy on the board —
  but every attempt to hand it a new item fails, with `supply` reporting only *"the trade
  did not complete — nothing moved"*. Nothing names the pack.

  This cost two check-ins on one character. Lew sat at zero kills for five of them, unarmed,
  standing in a room where one fleetmate carried 22 weapons and another 19. Its keeper said
  so plainly — `UNARMED_NO_DONOR`, *"unarmed — 10 mana, needs 15 to make one"*, remedy
  *"hand it a weapon"* — and thirteen donors in the same room all failed identically.
  **Shedding four heavy stacks fixed it instantly** and it killed something within a minute.

  **CORRECTION, same day: this entry first said the limit was 14 STACKS. That is WRONG.**
  Written from one character at 14 that could not receive and could at 10, which is a sample
  of one and a coincidence of counting. Measured across the fleet an hour later: characters
  routinely carry **26, 28, 30, 34 and 35 stacks**, and one that had just failed to receive
  at 22 accepted an item at 19 — while another accepted at 28. There is no 14. What the
  successful fix actually removed was **WEIGHT and BULK**: the four stacks shed from Lew were
  55 red mushrooms, 59 mushrooms and 34 emeralds, and its pack went from 74% to 35% in one
  step. `pack.binding` on the fleet row already says which of the two is the live ceiling,
  and it differs per character (`1700 + might*20`, so 2000–2700 here).

  The honest state of this trap: **a character that cannot receive is nearly always full,
  the board's `pack.percent` and `pack.binding` are the numbers to read, and shedding the
  heaviest stacks is the fix.** Do not go looking for a stack count. And note what the wrong
  version cost — nothing, because the remedy was the same either way, which is exactly why
  it survived a commit without anybody noticing.

  **Every diagnosis that fits the symptom is wrong in a way that wastes a session.** It is
  not the keeper (it fails with the keeper stopped). It is not the room (`supply` checks,
  and says so when they are apart). It is not the trade tooling: the CONTROL matters
  here, and it is one call. Ask three questions, not one:

  | | Lew | reading |
  |---|---|---|
  | can it RECEIVE a light item? | no | — |
  | can it GIVE? | **yes** | so its session and the protocol are fine |
  | can two OTHER characters trade? | **yes** | so the tooling is fine |

  One-directional failure is the signature. **`pack.percent` and `pack.binding` are the
  numbers to read — not `carrying`**, which is what the first version of this entry said and
  is what led it to invent a stack limit that does not exist.

  **`trade` lies in BOTH directions and must never be trusted over a re-read.** It returned
  `offered: false` on an offer that had in fact landed with the item on the table — so the
  natural response, retrying, cancels a working trade. It then returned `accepted: true`
  with `carried_before` equal to `carried_after`, having transferred nothing. Watch the
  recipient's `mayAccept`: it stayed **false** through a successful counter, so the giver's
  accept was the only one and it ENDED the trade rather than completing it. **Use `supply`**
  — it drives both ends and verifies the receiver actually holds the goods afterwards, which
  is the whole reason it exists.

- **"BOUGHT X BUT WON'T WIELD IT" IS ALMOST ALWAYS "CAN'T PUT DOWN Y", AND THERE ARE
  EXACTLY TWO THINGS THAT DO IT.** A character that buys a mace and keeps swinging a long
  sword is not a ranking bug and not a failed purchase — something already in its hands
  refuses to come off, and both culprits are silent about it in the ways this file keeps
  warning about.

  **A CURSED WEAPON CANNOT BE PUT DOWN, EVER.** `WeapAttCursed.ItemReqUnuse`
  (`wacursed.kod:97`) tests nothing at all — it returns FALSE unconditionally and says
  *"%s%s seems to cling to your hand!"* — and `ItemReqLeaveOwner` refuses the drop for as
  long as the item is in `getplayerusing`. So **wielding one is the only irreversible
  mistake in this repository**: no swap, no sale, no handover, no drop, for the life of
  the character.

  And it is a **downgrade, not a trade-off**: `ModifyDamage` and `ModifyHitRoll` both
  return `x - 2*power`, so it is strictly worse than what it replaced at hitting *and* at
  hurting. There is no upside to weigh against being stuck with it.

  Nothing in the harness knew the attribute existed. The name is `"cursed %s"`, so a
  cursed long sword matches `/long ?sword/` and scored **7** — ahead of every mace in the
  pack. It is **10% of the item-attribute treasure table**
  (`AddToItemAttTreasureTable(#percent=10)`) and this fleet loots a weapon from almost
  every kill, so it is a live hazard rather than a curiosity. `isCursed` in
  `m59-skills.mjs` keeps it out of `weaponRanking`.

  **The guard is on WIELDING only, and that is deliberate.** One that is merely carried is
  harmless and still sellable — `ItemReqLeaveOwner` refuses only while it is in the use
  list — so it stays a weapon to `weaponScore`, `sellable` and the equipment plan, and the
  ordinary sell rules shed it. Scoring it zero would make it invisible to the very code
  that should be getting rid of it. **Unwieldable, not invisible.**

  **The other culprit is a TOKEN**, which takes both hand slots and is already on the
  fleet row as `holding_token` — see the note in `m59-broker.mjs` about why it is a flag
  rather than a reading. Check that first; it is free.

- **A SMITH DOES NOT BUY MUSHROOMS, AND OFFERING HIM ONE IS A SUCCESSFUL CALL THAT RETURNS
  A SILENCE.** What a merchant deals in is `ObjectDesired`, declared per class.
  `Monster.ObjectDesired` (`monster.kod:4707`) returns TRUE and its own docstring says
  *"This is set in individual buyers. It allows them to pick and choose what they want to
  buy."* — **fifteen classes in the tree override it**, each in a couple of lines of
  category tests. That is the whole vocabulary, and `m59-buyers.mjs` is it with citations.

  The categories are **not** the item kinds, and nothing else groups them this way:

  | predicate | is | `monster.kod` |
  |---|---|---|
  | `IsObjectWeapon` | Weapon | :4142 |
  | `IsObjectWearable` | Armor, Helmet, Gauntlet, Necklace, **Shield**, Pants | :4183 |
  | `IsObjectSundry` | Torch, Flask, Mug, **Food** | :4152 |
  | `IsObjectMisc` | Chalice, Scepter, SpecialWand, SpellItem, Book, Arsenic, SpiderEgg(Shell), Key | :4165 |
  | `IsObjectGem` | JewelofFroz, Emerald, Ruby, Sapphire, Diamond, **Ring** | :4198 |
  | `IsObjectReagent` | `IsItemType(ITEMTYPE_REAGENT)` — asks the item | :4213 |

  **A GEM IS ALSO A REAGENT**, which is why three of the four apothecaries name the
  exclusion explicitly (`TsApoth.kod:66`, `bqapoth.kod:128`, `kcapoth.kod:49`) and why
  **Hazar is the only apothecary that takes one** (`hzapoth.kod:55`). `Ring` counting as a
  gem is how a signet ring gets refused by a counter buying every other reagent. And the
  smiths are not interchangeable: five buy weapons *and* wearables, but **Marion's buys
  weapons and shields and no body armour** (`MrSmith.kod:80`), so folding the six into one
  rule sells his leather to a silence.

  **`buys_anything` on the merchant row does not answer this and inverts it.** It is
  computed as "did this class override `ObjectDesired`", which is accurate and is a
  different question: it is TRUE for the bankers who take your goods and thank you, and
  FALSE for every merchant actually worth walking to.

  This cost real trips. `sell_all` offered whatever the loadout marked sellable to whoever
  was standing there, so a run at Quintor's Smithy in Jasper offered him sapphires,
  mushrooms and water skins — each a full offer/cancel round trip plus 900ms of pacing,
  each returning `no counteroffer came back`, and together burying the one line that
  mattered. It now partitions first and returns **`not_offered`** beside `sold` and
  `refused`, with a reason and a citation per item.

  ```bash
  node tools/m59-buyers.mjs                              # the whole table
  node tools/m59-buyers.mjs Quintor "long sword" sapphire
  node tools/m59-buyers.mjs --who-buys sapphire          # who takes it — ask BEFORE the walk
  ```

  The MCP tool is `who_buys`, and it moves nobody. **`refused` and `not_offered` are
  different facts**: the first was turned down at the counter, the second never left the
  pack and is still saleable somewhere else.

  **CANNOT SAY IS NOT NO, and that asymmetry is the whole safety argument.** An
  unrecognised merchant class or an item missing from the index answers `null`, and every
  caller offers it anyway. Being wrong about a category costs a round trip; holding
  something back that would have sold costs the sale **invisibly** — the trip reports
  success, the goods are still in the pack, and nothing says why.

- **TWO MERCHANTS HOLD A REAL INVENTORY AND CAN RUN OUT — OF STOCK, AND OF SHELF SPACE.**
  Every other merchant assembles its list on demand and cannot run dry: `monster.kod`
  declares `vbSellFromInventory = FALSE` and only two classes in the whole tree override
  it, both `MOB_BUYER | MOB_SELLER` with `MAX_FORSALE = 25`.

  | | file | when full it says |
  |---|---|---|
  | **Izzio**, the wanderer | `izzio.kod:54` | "Look at my pack. Where would I put it?" |
  | **Ko'catan shopkeeper**, the island vendor that buys anything | `kcshopk.kod:54` | "I wish I could take that off of your hands for you, but mine are all full too!" |

  This cuts BOTH ways and the selling half is the one that will catch you. Each has three
  separate refusals — full (`length(lForSale) < MAX_FORSALE`), already-have-one
  (no duplicates), and *"I already have several of those for sale"* — and **every one of
  them is a sentence spoken to the room, not an error on the wire**. So a `sell_all` at
  these two can decline item by item while the call reports success, which is why
  `m59-reagents.mjs` reads the PURSE afterwards rather than trusting what the buy or sell
  was asked to do. Fill one up and it stops buying until somebody clears it.

  **Do not generalise a "the shop had none" reading to a merchant that is not one of these
  two.** I did, from a real run: Beaker and Sweetums were told "202 sells no elderberry or
  herbs after all", and 202 is MarionInnkeeper, which inherits `FALSE` and cannot run out
  — Statler bought twelve from that same counter seconds later. The tell that it was a
  failed interaction rather than an empty shop is that both had an UNCHANGED PURSE: every
  character that sold also bought. **Roq is Rook** (`cnsarge.kod:19`,
  `cornothsergeant_name_rsc = "Rook"`) and he does not declare it either.
  `m59-merchants.mjs` now resolves the flag and puts `finite_stock` on the row, so ask it
  rather than assuming.

  **And CLASS NAMES ARE CASE-INSENSITIVE TOO — that is the third kind of name in this
  tree that is, after resource names and property names.** `crnthtwn.kod` declares
  `CorNothTown`; `cngrocer.kod` says `CornothGrocer is CornothTown`. `kodbase.txt` lists
  it once, so they are one class to the compiler and were two keys to a plain `Map` —
  which stopped every walk up that chain at the first hop, silently and in the direction
  that looks like a legitimate answer. `descendsFrom` had been returning false for it all
  along, so Solomon in Cor Noth was reported as stationary whether or not he is. The class
  map is now case-insensitive on lookup while keeping the file's own spelling on iteration.

- **THE ENGAGEMENT CEILING IS A PROPORTION NOW, IT HAS ONE HOME, AND IT USED TO HAVE FOUR.**
  `refuseEngagement` and the three other gates that decide what a character may be hit by
  all spelled `level + (maxThreatOver ?? 6)` separately — four copies of the quantity this
  repository has learned always ends up with two answers, and this is the one where the
  second answer is a dead character. They now all call `threatCeiling()`.

  **A FLAT BAND IS A DIFFERENT BET AT EACH END OF A ROSTER.** `+24` widens a 45-health
  character by 53% and an 88-health one by 27%, so one policy was reckless for the small and
  timid for the large. The default is now `{mode: 'percent', value: 150}` — max health IS
  the level here, so 150% is the same bet everywhere. `{mode: 'flat', value: 25}` is still
  available and is the right answer when a fleet is levelling past a fixed prey and wants
  the band to stop growing with it. **The mode is explicit** so the two can never silently
  disagree, and it is settable over MCP (`autopilot threat_ceiling=…`) and from a doctrine
  (`prey.threat_ceiling`).

  Two directions it deliberately fails safe. **An unknown max health returns null and every
  caller reads null as "refuse"** — a ceiling that defaults open is the one that kills
  somebody. And **an unusable setting falls back to 150%, never to "no ceiling"**.

  `max_threat_over` is still accepted, still stored, and **no longer consulted** — and the
  broker says so in its reply rather than letting it become a silent no-op, which is the
  failure this file exists to keep naming.

- **A GUILD WANT IS AN END STATE, NOT AN ERRAND, AND THAT IS WHAT MAKES IT SAFE TO GIVE TO
  TWENTY-ONE CHARACTERS.** A loadout says what one character should carry; a guild want says
  what should end up IN THE HALL, and it is answered by whoever walks past with the right
  thing. `substrate/guild-plan.json` holds it — per chest, per item, a target — written by
  the planner's **Guild hall** sheet and read by the keeper on every town trip.

  Stating it as "chest 2 should hold 300 mushrooms" rather than "take 40 mushrooms to chest
  2" is the whole design: the shortfall shrinks as others contribute, nobody owns the
  errand, it cannot double-count, and **a satisfied plan produces no work and no walk**.
  That last part is the point — a check-in that walked to the hall on every sale to look at
  a full chest would be a tax on every town trip. `m59-guildwants.mjs` owns it and
  `contributionPlan(...).walk` is what the keeper honours.

  **THE ORDER IS pack -> the character's own floor -> the guild's chests -> sold -> banked**,
  and it has to be that order. A mushroom sold in the first line of a town trip cannot be
  un-sold into a chest in the last, so contributing runs BEFORE `sellInTown`; and a bank
  balance is the only unlimited store in the game and the only one that survives death, so
  it is where overflow ends up. **Guild-wanted items are protected from the vendor exactly
  while a chest is still short of them and become sellable the moment the target is met** —
  without the release half, a full hall would mean a fleet that could never sell anything
  again.

  Four refusals, each of which is the cheap mistake:

  - **It does nothing at all without a guild AND a hall**, checked from the cache, and it
    reports WHICH is missing rather than a bare false — "nobody has asked Frular" and "this
    guild has no hall" have different fixes. The planner sheet and the POST that saves it
    are gated the same way, because a plan against a hall the fleet does not own would sit
    on disk holding items back from every vendor for a chest that does not exist.
  - **The contributor keeps its own loadout floor.** A guild is not entitled to the
    elderberry a caster eats with — the same rule `deliverableSpare` follows.
  - **An unopened chest is never read as empty.** `never_opened` means nobody looked, which
    is the opposite fact, and treating it as empty would send the whole fleet to fill a
    chest that may already be full. The keep test goes the other way for the same reason:
    an unopened chest holds its whole target back, because selling is not reversible.
  - **Two chests wanting the same item cannot each be promised the whole stack**, and two
    lines for one item in one chest are a contradiction rather than a sum — the larger is
    kept and the collision is reported.

  **The hall is a SHEET, not a character.** It is `compendium/planner/guild-hall.html` and
  `/_guildplan`, not a loadout under a reserved name: a character called "GUILD HALL" would
  be indistinguishable from a real one to every tool that iterates loadouts, and the first
  of those to run would try to give it a weapon.

  `node tools/m59-guildwants-test.mjs` (39) pins all of it, including that an empty pack
  never walks and that a met target releases the item to the vendor.

- **FOUR CONTAINERS, FOUR DIFFERENT RULES, AND ONLY ONE OF THEM HAS TWO CEILINGS.**
  `m59-storage.mjs` owns all of it, because the arithmetic is different in each case and a
  page that averaged them would be confidently wrong four ways:

  | | limited by | ceiling | scope |
  |---|---|---|---|
  | a pack | **weight AND bulk** | `1700 + might*20` | one character |
  | a vault | bulk only | 3000 | **one character**, not one vault |
  | a guild chest | bulk only | **24000** | the whole hall |
  | a store box | bulk only | 4000 | the hall |

  **A pack is full when EITHER ceiling is reached** (`holder.kod:259` -> `:281`), so its
  fullness is the WORSE of the two fractions and the board says which one binds. The other
  three declare `viWeight_hold_max = $` — nil, meaning unlimited — so weighing them at all
  would invent a limit the server does not have. **A vault's 3000 is per depositor**:
  `CanDepositItems` sums `GetCurrentBulkStored(#who=who)` (`storage.kod:88-99`), so
  twenty-one characters have twenty-one separate 3000s in the same vault. A chest is one
  pool. The Bookmaker's hall builds **three** chests (`guildh14.kod:518,520,522`) and a hall
  may hold four, so the board keeps four slots.

  **NONE OF RENT, VAULT CONTENTS OR CHEST CONTENTS IS PUSHED**, so all three are the
  `substrate/banks/` pattern — caught when somebody happens to be told, written to
  `substrate/storage/`, and never rendered as current. Two consequences the board must keep:
  **"never looked" and "empty" are opposite facts** (an unopened chest renders hatched, not
  0%), and **rent's SIGN is its whole meaning** — positive is a debt that loses the hall,
  negative is credit, and an answer nobody parsed stores as `null` rather than as a guild
  that owes nothing.

  **`BP_WITHDRAWAL_LIST` (231) was declared and never parsed**, which is the `UC_LOOK_PLAYER`
  trap again: a packet nobody parses is indistinguishable from a packet nobody sends, so the
  vault looked unreadable. It carries the BUY_LIST shape (`user.kod:5741`), where the per-item
  u32 is `GetVaultRetrievalFee` rather than a price. Chest contents still have no such packet
  parsed — a look answers with prose — so a chest slot fills only when something records one.

  `node tools/m59-storage-test.mjs` (37) pins the ceilings against their citations and both
  never-looked-is-not-empty rules, against scratch directories.

- **THERE ARE SIX BOARDS AND ONE TAB BAR, AND A PURSE HAS NO RECORD BUT THE SAMPLE.**
  `/` (fleet), `/deaths`, `/tougher`, `/economy`, `/skills` and `/stats`, all on the
  dashboard port (8902 — the MCP port serves only the fleet page). The nav, the stylesheet
  and the inlined treemap live in **`m59-page-chrome.mjs`**: a new board is one line in
  `TABS`, and it is one line because six hand-written copies of a tab list means the seventh
  board is invisible from whichever copy nobody remembered to edit. That had already
  happened once — the fleet page and the deaths page carried two separate copies.

  What each board can answer is decided by whether the quantity leaves a trace.
  **A bank balance does** — a banker says it aloud and `substrate/banks/` catches it — so
  `/economy` can report it with the broker down. **A purse and a pack do not.** Nothing
  announces an inventory, so their only record is the ledger sample, `recordSample` writes
  them, and a purse column full of dashes means the broker predates that code rather than
  that the fleet is broke. `/economy` is therefore the ONE board that asks the running
  fleet: the broker passes live rows in and they win, and the record answers when nothing
  is running. Reagents have a third source — every `cast` and `cast_declined` event states
  the caster's stock — and the row says which of the three it got, because a two-hour-old
  figure and a live one must not render identically.

  `/skills` reads `substrate/abilities/`, which exists because the numbers are PUSHED.
  **Read it for the atrophy**, which is the half nothing else would show: over a week the
  fleet gained 1846 points and lost 1558, with `relay` and `blink` losing hundreds and
  gaining nothing. The page never nets the two, because a fleet gaining 40 and losing 38
  is standing still and one number cannot say so.

  **`/stats` IS THE ONE BOARD WITH NO CLOCK ON IT, AND IT GROUPS RATHER THAN LISTS.**
  Attributes are fixed at creation and never move, so unlike a purse or a bank balance a
  reading of them cannot go stale — it reads `substrate/sheets/` and needs nothing live,
  carries no freshness pill, and takes no `?hours=`. It draws the client's own stats screen,
  read-only, one pane per **set of attributes** with every character rolled that way beside
  it: twenty-one characters here are **four builds** — 8, 5, 4 and 4 — and that shape is the
  finding, because it says how many bets this fleet has actually placed and a row-per-character
  table hid it behind a wall of repeated numbers. Two things it refuses to flatten. **A sheet
  with no attributes is not a build**: it is named apart, because `create automated` really
  does roll zeroes and "nobody has read this" must not render as "it rolled nothing". And
  **the tallest bar is not what a build is for** — every character in this fleet was rolled
  with 50 stamina, so stamina is the tallest bar in three of the four and distinguishes none
  of them; an attribute every build shares is stated once above the panes (one ceiling of 151
  for the whole fleet, which is why nine characters being stuck is a fleet-wide fact) and left
  out of the per-build line, where what remains is the attributes that build holds the fleet's
  best of. One build here leads in nothing at all, and no pane on its own could say so.

  The pane itself is **`compendium/tools/statpane.mjs`** — the same file the planner draws
  from, imported in node and inlined into `assets/statpane.js` + `assets/statpane.css` for the
  browser. Both panes therefore agree on the six stats, their order, the CSS and the three
  derived numbers (`101 + stamina`, `1700 + might*20`, points spent). The board's copy has no
  slider and no hatching, deliberately: attributes cannot move, so a bar you could drag would
  be offering a re-roll, which is the planner's job and not a board's.

- **A SKILL IS BOUGHT LIKE A HAT, AND FOR A YEAR NO LIVE MERCHANT APPEARED TO SELL ONE.**
  `plFor_sale` is four positional slots and `AssembleForSaleList` names them in its own
  docstring — **"(items, skills, spells, conditionals)"** (`monster.kod:4819`).
  `m59-merchants.mjs` read slot 3 as the abilities and called slot 2 `?`, so every skill
  sold by a merchant standing in the world was dropped on the floor. Nothing errored;
  `who-teaches block` simply answered with a WANDERER, because the only surviving trace
  of block was a source-derived entry for a class nobody had seen. The man who actually
  sells it — Jonas D'Accor — has been standing still in Pietro's Wicked Brews the whole
  time. Recovering slot 2 also found Rook in Cor Noth teaching **ten** skills, including
  every weapon proficiency.

  **A merchant is a CLASS; a person can wear more than one.** `RebelLiege` and
  `JealousGeneral` are both "Jonas D'Accor" and differ only in that one stands still and
  one walks a circuit — on the wire that is two ids and two class names and nothing else.
  The catalogue links them by NAME RESOURCE, and calls it the same man only when the ICON
  agrees too: the Barloque and Tos blacksmiths are both "Fehr'loi Qan" and are two
  different people, which is the counter-example that stops the name alone being trusted.

  **And the price is fixed by LEVEL with no markup** (`Skill.GetValue` skill.kod:128,
  `Monster.GetPrice` monster.kod:4880) — `250 * 2^level`, so a level 1 skill is **500**,
  not 250. That is why `m59-outfit.mjs --learn <name>` can withdraw the right amount at a
  bank before setting off, which it must: nobody in this fleet carries 500 shillings.

- **THE OFFER LIST IS FILTERED PER BUYER, AND A REFUSAL IS SILENCE.** A skill you already
  have, or cannot yet learn, is not refused — it is simply ABSENT from the shop list
  (`monster.kod:4855-4861`), with no message of any kind. So "the buy did not complain"
  means nothing, exactly as it means nothing for equipping. `--learn` re-reads
  `abilities` after every purchase and reports `paid N and DID NOT GET IT` rather than
  assuming. Whether a character *can* learn one is `PlayerCanLearn` (`player.kod:10509`),
  and it short-circuits to SUCCESS if you already know two abilities in that school at
  that level — which every character here does for weaponcraft, via *mace fighting* and
  *slash*.

- **EVERY BUY, SELL, KEEP AND DROP RULE USED TO BE ONE CONSTANT FOR TWENTY-ONE CHARACTERS.**
  `WANTS` in `m59-outfit.mjs` (a mace, leather, a shield). `KEEP` in `m59-reagents.mjs`.
  The `keep` regex in `makeRoom`. `REAGENT_TARGET` in the keeper. So a caster that needs
  forty mushrooms and a fighter that needs none were told the same number, and the only way
  to change it for one character was to edit a tool and restart the broker — which logs out
  the fleet.

  A **loadout** is that answer per character: `substrate/loadouts/<character>.json`, written
  in the compendium's planner (`P` on the fleet terminal, or
  `node tools/m59-compendium.mjs --open --to /planner/`) and read by the keeper every pass.
  `node tools/m59-loadout.mjs <name> --check` says what a character is short of; the
  `loadout` MCP tool says the same thing to an agent.

  **IT IS AN OVERLAY, NOT A REPLACEMENT, and that is the property to preserve.** Silence
  means "carry on as before" — every helper returns `null` for an absent or empty loadout,
  and `null` means "the behaviour that was already there", never "protects nothing". A
  loadout saying only "twenty-four elderberry" must not start a character selling its
  armour. `m59-loadout-test.mjs` pins that directly: with no loadout, `skills.sellable`
  gives exactly its pre-loadout answer.

  Four things about it that read backwards:

  - **A NAMED WANT IS NOT SATISFIED BY THE FAMILY.** The fleet default says "a mace" and
    means "some weapon" — its fallback is `/sword|axe|hammer|mace/`, because one answer for
    twenty-one characters cannot be fussier. A loadout says "short sword", and a character
    holding a mace *is* missing it. The first version widened the loadout's fallback to the
    slot's family and thereby made every loadout mean what the default meant: Kermit, whose
    list says short sword and whose pack held a mace, reported `already stocked`.
  - **A FLOOR PROTECTS THE STACK UP TO THE FLOOR, so the keep test has to be able to count.**
    Twelve elderberry under a floor of twelve are all protected and the thirteenth is not.
    Asked without a pack it protects the whole stack, which is the safe direction.
  - **A CEILING BELOW A FLOOR IS A LOOP, NOT A PREFERENCE** — buy up to the floor, sell down
    to the ceiling, pay the vendor spread on every lap, for ever. `normalise` raises the
    ceiling and says so rather than honouring a pair that cannot both be satisfied.
  - **THE SELL LIST BEATS THE NAME GUARD, deliberately.** `keep` protects anything that
    *looks* like equipment or money, which is right by default and is why a character
    carrying fifty-six sapphires it will never cast with could not shed them without editing
    a regex twenty-one characters share. Worn still beats everything: `plUsing` is the
    server's own answer and no list can sell the shield off your arm.

  Keyed on the **character name**, never the agent handle — `t1` is this checkout's word for
  a roster slot, and a loadout follows the character. `loadoutFor` caches on mtime, so the
  per-pass cost is a `stat()`.

  **THE GEAR HALF IS THE ONE PART THAT IS ABOUT THE FLEET RATHER THAN ABOUT A CHARACTER**,
  and so it is the one part worth handing to all of them at once — *Apply gear to fleet* in
  the planner, or `node tools/m59-loadout.mjs <name> --gear-to-fleet --apply`. How many
  reagents a caster burns is its own business; "fight with a short sword and wear leather" is
  a decision about how the fleet plays, and saying it twenty-one times is how it ends up said
  twenty-one slightly different ways. Four things it does rather than documents:

  - **It copies `gear` and nothing else.** Every carry list, school plan, sell list, keep
    list, note and purse floor it passes over is left exactly as it was found, which is what
    makes it safe against characters somebody has already planned by hand.
  - **An empty gear list is REFUSED.** That is the ordinary state of a loadout nobody has
    filled in — not an instruction to clear twenty-one weapon preferences — and applying it
    would have reported success. `allowEmpty` is how somebody says they meant it.
  - **It plans first and the plan is the same function as the write**, `applyGearToAll` with
    `apply: false`. A preview computed by different code from the write it previews is a
    preview of something else, and this one writes a file per character.
  - **A loadout that will not parse is left alone**, not replaced with one holding only gear:
    the carry list that went missing would look like something nobody ever wrote.

  `gear.from` records which plan a character's gear arrived from, and the planner clears it
  the moment somebody edits the list — a line claiming the gear came from Kermit, over a list
  Kermit never had, is worse than no line.

- **A SHORTFALL THE BOARD CANNOT STATE IS INVISIBLE TO THE ONLY THING THAT FETCHES IT, AND
  A FLEET SWIMMING IN ONE HALF OF A RECIPE LOOKS WELL SUPPLIED.** `create food` is 2
  elderberry AND 2 herbs, so what a character can cast is `min(elder, herb) / 2` — and the
  fleet total is the one number that cannot say so. Measured 2026-08-11: 61 elderberry and 160
  herbs across twenty-one characters, and **twenty of them could cast zero times**, because
  the herb-rich (1/28, 1/26, 1/23) were standing next to the elderberry-rich (6/1, 6/1, 5/0).
  Read the per-character minimum, never the sum.

  Farm delivery is what is supposed to fix that, and three things stopped it:

  - **`declareInterest` merged the loadout's `wants` and `spare` but not its `needs`** — and
    `needs` is the only field `demandsForRoom` filters on. So only the two reagents with a
    hard-coded target could ever be delivered, and a caster short of forty mushrooms was
    unreachable by the mechanism built to reach it. `wantsOf` now returns quantities;
    **`wants` is a name for "may somebody sell this", `needs` is a number for "how many
    should a courier buy", and a want with no quantity is not a delivery order.**
  - **The recipient list was frozen at pickup.** A courier polls, walks to the apothecary,
    walks back — minutes — and the fleet has moved. Iterating the frozen list and looking
    each name up gave "farmer left the room or is dead" and carried the goods home. A
    delivery is now **addressed to a PLACE**: the board is re-read on arrival and the cargo
    goes to whoever is standing there and short, polled or not.
  - **It was addressed to one room**, so a character one door away got nothing.
    `radius_rooms` (default 2, capped at 3) lets the courier walk the neighbourhood, nearest
    first, stopping the moment the cargo is gone. `roomsWithin` in `m59-map.mjs` walks the
    same three exit sources the router does, so "next door" cannot drift from what `travel`
    believes.

  Two things it now reports rather than swallows. **A counter that does not stock a kind is
  named** (`counter_did_not_stock`) — the run that exposed all this hit one counter with no
  elderberry and another with no herbs and still reported itself loaded. And **what left the
  pack is counted, not what the offer asked for**: a trade that handshakes and moves nothing
  is the same family as Skivlat saying thank you, and only the count tells them apart.

  `node tools/m59-coordination-test.mjs` (25) pins all of it, including that a stale
  declaration and a zero shortfall are both refused as delivery orders.

- **A GUILD COMMAND IS REFUSED BY TOTAL SILENCE — NOT A SENTENCE SPOKEN TO THE ROOM, WHICH
  IS THE REFUSAL EVERYTHING ELSE IN THIS FILE WARNS ABOUT, BUT NOTHING AT ALL.**
  `User.UserGuildCommand` (`user.kod:4848`) tests the caller's command bitmask and, when the
  bit is absent, takes the else branch: `Debug("Player ... trying to use a guild command he
  doesn't have!!!")` and returns. That line goes to the **server log**. The player is sent no
  message, no resource string, nothing on the wire. So for fourteen commands — invite, exile,
  set_rank, abdicate, vote, disband, the four alliance/war verbs, abandon_hall, set_password
  — an under-ranked send is **byte-for-byte identical to one that worked**.

  `m59-guild.mjs` is therefore a permission check that runs BEFORE the send, against
  `piGuild_commands` as the server itself handed it over in `UC_GUILDINFO`. Ask with the
  FLAGS, not with the rank: `ResetPowers` only re-runs on a rank change (`guild.kod:562`) and
  `RemoveGuildCommand` exists, so a bit can be missing from a rank the table says holds it.
  `mayI()` accepts either and says which it used.

  **The rank table has an asymmetry somebody will try to tidy up.** Invite is **LORD (3)**
  while exile and set_rank are **LIEUTENANT (4)** — there is a rank that can recruit and
  neither expel nor promote. `set_password` declares no `viRank_needed` of its own and
  inherits `GuildCommand`'s default of **MASTER** (`guildcmd.kod:41`); reading the absent
  declaration as "unrestricted" is the natural mistake and is wrong in the permissive
  direction.

  Four more things that read backwards:

  - **THE INVITATION IS AN OBJECT IN THE INVITEE'S PACK AND IT DIES IF EITHER OF THEM WALKS.**
    `SomethingLeft` and `OwnerChangedOwner` (`invitat.kod:145,155`) both delete it when the
    inductor OR the inductee leaves the room. It lives **two minutes** — `SELF_DELETE_DELAY`
    is 120000, and the invite command's own description resource saying "1 minute"
    (`gcinvite.kod:22`) is wrong. And `CheckInvitationList` allows the inviter exactly **one
    outstanding invitation**, refused with `return FALSE` and no message. So inducting a
    fleet is strictly serial with both parties standing still; a fan-out reports twenty
    successes and inducts one. `guild action=induct` is that choreography, and it plans
    unless `apply` is true.
  - **JOINING NEEDS `PFLAG_PKILL_ENABLE`, AND SO DOES FOUNDING.** Base max health 30 sets it
    (`EvaluatePKStatus`, `player.kod:11047`). Under that, `use` on the invitation is refused
    — *after* the inviter has burned its one slot for two minutes. Every character in this
    fleet is well past it.
  - **A HALL NEEDS THE GUILD MATURE, WHICH IS TICKS AND NOT A CLOCK.** 30 maintenance ticks
    of 6 minutes — three hours — for a plain guild, 60 for a secret one, and the tick only
    counts down while a member is logged on (`guild.kod:692`). **The last tick is conditional
    on three members** (`guild.kod:705`): a two-member guild holds at 1 for ever, three hours
    in, looking finished. Price is `quality * 5000`; `GetRentValue` is **hourly** but the
    packet carries `24 *` it, so the wire figure is a day.
  - **THE 50,000 WAR FORFEIT IS PREPAID RENT, NOT A PURSE.** `declare_war` is refused unless
    the guild's rent account is that far in credit (`guild.kod:2290`), so no character
    carrying the sum satisfies it. And only a **mutual** war can cost it: `UC_GUILD_LIST`
    carries four id lists and the last two are the one-sided `declared_*` forms, which the
    `guild list` action keeps separate for exactly that reason.

  Founding is 5,000 from the **purse**, not a bank balance (`system.kod:243`), standing next
  to Frular in **room 700, The Guildmaster's Hall** in Barloque. **There is no way to rename a
  guild** — the only correction is disband and pay again — so `validateGuild` checks the name
  and all ten rank titles first. Ten, not five: five ranks × two genders, flat, in the order
  `user.kod:1697` reads them, and the wrong order does not error, it gives every woman in the
  guild a man's title for the life of the guild.

  **SPREADING A GUILD ACROSS A FLEET IS A DIFFERENT OPERATION FROM GATHERING ONE, AND ONLY
  ONE OF THEM IS FREE.** `guild action=induct` walks everybody to one room, which costs each
  of them its errand. `guild action=spread` walks nobody: it asks each guilded character who
  is ALREADY standing next to it, invites those, and promotes them so they can do the same
  wherever they drift. A fleet that hunts together converts itself over a few rounds for the
  price of no travel at all — and a round that invites nobody stops early rather than
  spinning.

  **`promote_to` defaults to 4, lieutenant, and 3 would not do.** Rank 3 (lord) is enough to
  invite but NOT to promote — `set_rank` needs 4 — so a fleet promoted only to lord would
  recruit one generation and then dead-end, every new member able to invite and none able to
  pass the power on. That asymmetry is reported per invitee rather than silently leaving a
  member who cannot continue the chain.

  **WHO COUNTS AS OURS IS MATCHED BY OBJECT ID AGAINST THIS BROKER'S OWN LIVE SESSIONS,
  NEVER BY NAME.** `prod` is a shared server with real players on it and an invitation is an
  outward-facing act addressed to a stranger. Names are chosen by their owners and two
  characters can be made confusingly alike; a session's object id is the server's own answer
  to "is this a character this broker is driving". The map is rebuilt every call, because a
  rejoin changes the object id and a stale one could carry an id that now belongs to somebody
  else.

  **A RANK IS A SEAT AS WELL AS A PERMISSION, AND ONLY ONE RANK IS RATIONED.**
  `MAX_LIEUTENANT = 2` (`guild.kod:49`): `NewLieutenantOkay` counts the members already at
  rank 4 and refuses the third. `NewLordOkay` is two lines whose own docstring says
  *"Currently, always returns TRUE"*, so **lord is unlimited**. Measured live 2026-08-12:
  Piggy promoted Lew to lieutenant and was then refused for five more, all of whom stayed
  apprentices — **and the refusal goes to the PROMOTER, so from the member's side it is
  silent**, which is how a spread can report five promotions and produce one. So "promote
  everyone to the second-highest rank so they can recruit too" is not possible and is not
  needed: **invite needs only LORD**, which is uncapped. `promote_to` defaults to 3 for that
  reason, and `guild action=promote` exists separately because a promotion — unlike an
  invitation — needs neither the same room nor the same moment.

  **THE HALL LIST AND THE FOUNDING PRICES ARE PUSH-ONLY, AND WHAT TRIGGERS THEM IS A
  SHOPPING REQUEST THAT DELIBERATELY SELLS NOTHING.** There is no `UC_GUILD_HALLS` request:
  `merintr.c` lists it in the incoming table and NOT in `user_msg_table`, and `user.kod` has
  no branch for it — sending one reaches *"got unknown UserCommand"*. This repository had
  such a sender and it was silent in the usual way. What produces both dialogs is
  `GuildCreator.GetForSale`, whose own docstring calls itself hacky: *"user.kod:UserBuy()
  aborts if it gets $ returned from here, so we can use it as a hook"* (`gcreator.kod:250`).
  So **`shop` at Frular looks like a merchant with nothing for sale, and that is the same
  call**. A hall list can only be obtained standing in front of him.

  **AND THE SILENT-REFUSAL RULE IS NOT ONLY ABOUT PERMISSION BITS.** `guild action=spread`
  had two live failures that both came from trusting the wrong source for membership. A
  fresh broker found ZERO inviters inside a guild of six, because `client.guild` is filled
  only by `UC_GUILDINFO` and **nothing volunteers guild membership at login** — unlike
  health or equipment. Then a whole round spent eleven inviters on one character who was
  already a member, each told *"This person already belongs to your guild"* and none getting
  a scroll, which the slot-guard read as a burnt slot. **The roster is the answer to both**:
  `UC_GUILDINFO` carries every member's OBJECT ID (`user.kod:2020`), the same id our sessions
  carry, so one read identifies the whole fleet exactly. Ask the guild, not the characters.

  **PAYING RENT IS AN OFFER THAT THE SERVER REFUSES, AND THE REFUSAL IS THE SUCCESS.**
  `GuildCreator.ReqOffer` (`gcreator.kod:325`) intercepts the offer, sums its value,
  subtracts it from the payer's purse, credits the guild with `PayRent`, says *"I thank thee
  for thy payment"* — and returns FALSE, which cancels the trade. So the dialog closing with
  nothing handed over is exactly what a successful payment looks like, and the only proof is
  the purse going down. **`m59-tithe.mjs` owns all of that** — the payment, the rent parser,
  Frular's constants, a durable once-per-day book keyed `<fleet>-<agent>`, and the
  `guild_tithe` keeper policy that lets a bot tithe out of its sale proceeds without being
  asked. `m59-guild.mjs` re-exports the rent half rather than keeping a second copy: both
  files grew a `parseRentLine` on the same afternoon, from the same kod, and agreed by luck.
  The broker's `tithe` tool is a thin wrapper over that module and writes to the book **only
  the verified purse delta**, never the amount offered — recording the offer would make a
  refused tithe look paid for the rest of the day, which is exactly the day the fleet would
  then skip. The book's fleet name goes through `fleetName()`, the same resolver as every
  other fleet tool: the keeper had its own argv/env reading with a literal `default`
  fallback, so a broker started with no `--fleet` but a recorded `substrate/fleet-default`
  wrote `default-t14` while the tool read `prod-t14`, and `paid_today` would have read zero
  all day. **And the balance is prose sent once, exactly like a bank balance**: no packet,
  Frular answers the spoken word `rent` (`gcreator.kod:97`).

  **UNVERIFIED, 2026-08-12: Frular did not in fact answer `rent` when asked.** Piggy, a
  guildmaster standing in room 700, said it twice and got back only its own echo — and got
  nothing for the other keyword branch either (a guildmate's name, which `SomeoneSaid` should
  answer with active/inactive for a speaker of rank LORD or above). `MOB_LISTEN` is set
  (`gcreator.kod:74`), so either the speech never reaches his `SomeoneSaid` or something
  earlier in `Monster.SomeoneSaid` (`monster.kod:2581`) returns first. **Do not treat
  `tithe action=status` as working until somebody reproduces it**; the parser is pinned
  against the three sentences and is fine, but nothing has yet produced one. The paying half
  does not depend on it — `ReqOffer` is a different path entirely — though that too is
  untested against a guild that actually owes rent.

  THE SIGN IS THE WHOLE
  MEANING — *"owes N coins"* is a debt, *"has a positive balance of N"* is credit already
  negated for display. Worse, *"Thou belongest to no guild, and thus owest no rent"* CONTAINS
  the zero-rent phrase, so a parser that tests for zero first reads "this character has no
  guild" as "this guild owes nothing".

  **The Bookmaker's Guild House is room 714 and the general price formula gets its rent
  wrong.** Quality 5, so 25,000 to buy — but it overrides `GetRentValue` with a doubling of
  its own (`guildh14.kod:191`), giving 500/hour and **12,000 a day**. On a non-PK server
  that coincides with the non-PK doubling and one of the two is invisible; on a PK server the
  general formula would understate it by half. `KNOWN_HALLS` carries the real numbers with
  the citation, and `guild action=fund_hall` plans the pooling — **plan only, always**,
  because executing it is a dozen bank trips by characters whose keepers own their movement
  and money already moved cannot be rolled back. A hall is paid from the **buyer's purse**,
  so every banked contribution is a detour to Tos or Jasper first — never Barloque.

  `node tools/m59-guild-test.mjs` (192) pins the permission check, the four packet layouts
  against server-built fixtures, the title ordering, the rent sign and its overlapping
  sentences, the Bookmaker's override, and the pooling arithmetic.

- **THE RED NAME IS ALREADY ON THE WIRE, AND `PF_*` IS AN ENUM RATHER THAN A BITMASK — SO
  THE OBVIOUS TEST OPENS FIRE ON EVERY DUNGEON MASTER.** The client colours a player's
  name from nothing but its object flags (`GetPlayerNameColor`, `clientd3d/color.c:619`):
  red for a killer, orange for an outlaw. Every room description we already receive
  carries it; this repository simply never read it.

  The bits live in `OF.PLAYER_MASK` (0x1C000) as an **enumerated field**, and
  **`PF.DM` is 0xC000, which is exactly `PF.KILLER | PF.OUTLAW`**. So `flags & PF.KILLER`
  is true for every DM on the server. The game's own client `switch`es on the masked
  value; `playerClass()` in `m59-parse.mjs` does the same, and `flaggedAggressor()` is the
  only predicate anything defensive should ask.

- **THE SERVER IS THE SAFETY, AND THE RIGHT MOVE IS TO LEAVE IT ON.** `PFLAG_SAFETY` is a
  real server-side flag, not a client courtesy, and `Player.CheckStatusAndSafety`
  (`player.kod:3767`) says what it does in its own docstring: *"PFLAG_SAFETY prevents
  accidental attacks. **You can always successfully hit a murderer or outlaw, though.**"*

  So with safety ON the server does exactly the discrimination a defensive fleet wants:

  | | with our safety ON |
  |---|---|
  | attack an ordinary player | **refused** — *"Hey! You almost hit %s%s! Good thing your safety was on!"* (`player.kod:177`) |
  | attack a murderer or outlaw | allowed, and the outlaw-granting branch is skipped entirely (`player.kod:3816`) |
  | **kill** a murderer or outlaw | `piJustified_kill_count`, **no** murderer flag, **no** outlaw flag, no faction loss (`player.kod:4841`, `:4856`) |

  Turning safety off to fight back would be strictly worse: it buys nothing we need and
  removes the interlock. `defend_against_players` therefore never touches it.

- **A MONSTER DOES NOT COME BACK TOMORROW, SO SELF-DEFENCE NEEDS A MEMORY AND THE MEMORY
  IS THE FLEET'S.** `m59-grudge.mjs` records who attacked us, fleet-wide, for an hour. One
  character being hit is everybody's information — that is what lets eight fleetmates in
  the room defend the one that got hit, and what lets any of them recognise the same
  person later in another town.

  **Three things must all hold before a swing**, and only the first is ours to get wrong:

  1. the **grudge** — this name attacked one of ours inside the hour;
  2. the **live flag** — the object in front of us is carrying `PF_KILLER` or `PF_OUTLAW`
     *right now*, re-read every time and never taken from the record;
  3. the **server's own safety**, above.

  **It is keyed on the NAME, which is the weaker key, and deliberately.** Everything else
  here insists on the object id — but that rule exists because a live session gives the
  server's own answer, and **a stranger gives us no session**, while object ids are
  renumbered on every save. An hour-long grudge keyed on an id would outlive the id. The
  cost is bounded by rule 2: to be hit under a coincidental name you must *also* be
  currently flagged, which the server permits and penalises nobody for.

  `node tools/m59-grudge.mjs` reads the book; `--forgive <name>` and `--clear` empty it.
  It is **gitignored**, because every row is an accusation against a named real person.

  `node tools/m59-grudge-test.mjs` (48) is the contract test, and the DM assertion in it
  should never be deleted.

- **A TRIP THAT CANNOT FIX THE THING THAT OPENED IT WILL RUN FOR EVER, AND EVERY LAP OF IT
  REPORTS SUCCESS.** `bankRun` has five doors and they have different remedies: a full pack
  is fixed by SELLING, a reagent shortfall only by BUYING, and buying needs money. The
  `supply` trigger was added to `checkIfShouldSell` long after `bankRun` learned to read
  that function's answer as `packFull`, so a shortfall was routed to a **market** — Roq
  buys and sells nothing — and the character arrived with an empty pack, sold nothing,
  walked one room to the apothecary with the two shillings it set out with, was refused,
  and walked back with the condition exactly as true as when it started.

  Measured 2026-08-16: **Fozzie made the 110 → 104 round trip every thirty-five seconds for
  over five hours** — 155 `buy_declined` in one day, every one reading `spendable: 2`, 0
  kills in the last half hour — **while holding 27,282 shillings in the bank**. Twelve of
  twenty-one were in the same loop and the fleet was sitting on **666,540 banked
  shillings**. Nothing errored, nothing stalled, and `m59-supervise.mjs` had nothing to
  unstick because the character was moving perfectly well.

  Three things kept it invisible, and all three are the general lesson:

  - **Every trip that was not the food one logged `going to the bank`**, including the ones
    walking to a market. The one line an operator had named neither the destination nor the
    reason, so an hour of ping-pong read as a fleet doing its banking. The note now names
    the errand and carries the trigger and the bill.
  - **THE CHARACTER WAS NOT POOR, IT WAS ILLIQUID** — and the door for that already existed.
    `needsCashFirst` sends a character to a bank before the shop and was written for hunger;
    nobody wired it to supply. A balance buys nothing while it is in the bank.
  - **The comment saying this trip "cannot spin, because it always achieves something" was
    true when it was written** and stopped being true when the trigger was added. A cooldown
    was declined on that reasoning, so the loop ran at one lap per keeper pass.

  `townDestinations` is now the single ordered answer to "which counter", written as a table
  so the next door added is a row rather than another arm of a nested conditional, and
  `reagentGapCost` is the single answer to "what does this errand cost" — the trip and the
  withdrawal both read it, and two answers there is how a character draws pocket money for
  an 8,400sh fill and is back on the road inside the hour. There is a cooldown as well as a
  destination, because the destination fix assumes there is a balance to fetch: with an
  empty bank too, the shortfall is real and unfixable this hour and the character should be
  farming rather than walking.

- **A KEEPER EARNING NOTHING LOOKS EXACTLY LIKE A HEALTHY ONE, AND THE CHECK THAT SAYS SO
  WAS UNREACHABLE FOR A YEAR.** `noProgress()` fires when nothing WORKS. `yieldCheck()` fires
  when everything works and none of it is worth anything — the keeper kills something every
  pass, so `progress()` fires, so the stall detector never trips, and the board reads
  `hunting: giant rat` for as long as you leave it.

  It never ran. The guard was `if (purpose !== 'advance') return null`, **`null` means "no
  opinion"**, and `policy.purpose` was not in the `autopilot` tool's schema — so every keeper
  in the fleet ran at `purpose: null` and the audit was off. Both halves are fixed: `purpose`
  and `goals` are settable over MCP, and an **unrecognised** purpose is now reported as such
  rather than silently disabling the check.

  There are two, and the second exists because **advancement is not the only reason to be
  out**. Ten characters are at max health 50 and a level-50 fungus beast cannot advance them
  (the rule is strictly greater) — which does not make their day worthless, it makes it a
  different job:

  | `purpose` | asks | from |
  |---|---|---|
  | `advance` | can this creature still raise what `goals` names? | the spawn index |
  | `equip` | does this creature drop anything this character is still short of? | **the loadout** |

  `equip` reads the gear gap rather than a constant, because "what this character needs" is
  exactly what a loadout is for and a second definition would drift from the first. Three
  things it does deliberately:

  - **A missing loadout is not an empty one.** Everywhere else in the keeper a null loadout
    means "carry on as before"; here it means the question cannot be asked, because the list
    *is* the loadout. Reporting a gap of zero would read as "finished".
  - **FINISHED AND FUTILE ARE BOTH "NOT PAYING" AND ONLY ONE IS BAD NEWS.** A character whose
    list is complete renders as `list complete, nothing left to fetch` and wants re-tasking;
    one grinding prey that can never drop what it needs renders as `PAYS NOTHING`.
  - **A treasure share is not a per-kill chance.** The table is rolled `1 + level/55 +
    random(0, difficulty/3)` times, so `per_roll_percent` is one roll's share; carried gear
    (`per_kill_percent`) is the real thing. They are kept under separate names so nobody
    averages the two columns.

  And the reason this needed the spawn work first: **every faction troop is `TID_NONE`** —
  the treasure table honestly says they drop nothing, because their gear is `plUsing` dropped
  by `DropEquipment` on a roll the extractor never saw. Asked "does a soldier drop leather"
  from `loot` alone, the answer was a confident no.

- **THE PLANNER IS THE ONLY PAGE IN THE COMPENDIUM THAT CAN WRITE, and it looks like the
  game because it is editing the game's own four screens.** `compendium/planner/` rebuilds
  the client's right-hand panel — inventory, spells, skills, stats, same order, same stat
  bars, same stack counts in the corner of each cell — and everything in it is editable.
  It deliberately ignores the site's light/dark theme: the point is that it looks like the
  thing next to it on the desktop.

  `node tools/m59-planner-data.mjs` writes `compendium/data/planner.json`, which is what it
  reads: 22 skills with their requisite stat and level, 150 spells with school and level,
  202 items with weight, value and sprite, and the constants `PlayerCanLearn` runs on.

  **ITS STATS TAB IS NOT ONLY ITS OWN** — the fleet's `/stats` board draws the same pane,
  read-only, so `compendium/tools/statpane.mjs` owns the six stats, their order, the labels,
  the frame and bar CSS, and the three derived numbers. Same arrangement as `learn.mjs`
  below: imported in node by `m59-planner-data.mjs` and `m59-stats-page.mjs`, inlined into
  `assets/statpane.js` + `assets/statpane.css` for the browser. `planner.css` keeps only the
  editable half — the tab strip, the draggable bar, the hatching for a typed value — so a
  rule about the bars belongs in `statpane.mjs` or the two panes will drift.

  **THE LEARNING ARITHMETIC HAS ONE HOME**, `compendium/tools/learn.mjs`, imported by
  `m59-loadout.mjs` and inlined into `assets/learn.js` by the page's build — the same trick
  `creatures.mjs` uses for `calc.mjs`, and for the same reason. Three things about it:

  - **`POINTS_SLOPE` (7), `MIN_NEEDED_TO_ADVANCE` (75) and `piMaxLearnPoints` (16) are not
    in `koddb.json`** — the builder folds `.khd` includes and not a class's own `constants:`
    block. They are read out of the source tree with the line they came from, and stay
    `null` when it is absent: an invented cost curve reads as authoritative, which is worse
    than none. Anchor the regexes with `^[ \t]*`, not `^\s*` — `\s` matches a newline, so a
    declaration preceded by a blank line cites the wrong line, which is the one kind of
    wrong a citation must never be.
  - **THERE ARE SEVEN TRACKS, NOT SIX.** `iNeed` sums `GetLevelLearnPoints` over the six
    schools *and* over `iWeapon`, the highest `viSkill_level` of any skill known
    (`player.kod:10813`). A planner costing only the schools understates every build that
    has learned a proficiency.
  - **LEVEL 50 IS A SENTINEL AND IT IS FREE.** assess, thrust and kick declare
    `viSkill_level = 50` on a six-entry table — "granted, not sold", since `GetValue`
    doubles per level and 250·2⁵⁰ is nobody's price. `Nth(vlLevelPoints, 50)` falls off the
    end and returns NIL (`blakserv/list.c:178`), so that track contributes **nothing** —
    and because `iWeapon` is a MAX, knowing thrust *hides* the proficiency levels the
    character would otherwise be charged for. Clamping to the last entry is the natural
    thing to write and is wrong in the expensive direction.

  Two discounts sit outside the formula and are worth a factor of three: when the level
  below holds fewer than three abilities you cannot reach 297 at all, so `iNeed` is divided
  by 3 (prev level 1) or multiplied by 2/3 (prev level 2), `player.kod:10915`. That is why
  Faren level 2 costs Kermit 43 and Kraanan level 2 costs 129.

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

## LENDING CHARACTERS OVER THE INTERNET WITHOUT LENDING THE PASSWORD

The fleet cannot be handed over the way a session is handed over, and the server source
says why. `SynchedAcceptLogin` (`blakserv/synched.c:321`) is the whole of authentication —
`a = AccountLoginByName(name)` then `a->password != password` — re-checked on every TCP
connect. **There is no resume verb in the AP table**, so there is no session to pass. The
wire carries `MD5(password)` rather than the plaintext (`m59-client.mjs`, `mdpass`), but
that digest IS the credential: it is compared directly against what is stored, so shipping
digests instead of passwords moves the same authority under a different name.

Nor can the live connection travel. Every session holds anti-spoof state — `seeds[]`,
`secure_token`, `sliding_token` — advancing on **every packet** in lockstep with the server
(`commcli.c:160-177`); one step out of line sets `seeds_hacked` and the server drops you
silently. And the IP is not the obstacle people expect: it appears only in a ban list and
in `MaxPerIPAddress` (default `0`, unlimited), never binding a session to an address.

**So what moves is AUTHORITY.** The broker stays here holding the roster and the sockets;
somebody else drives part of it through a door that can be shut.

```bash
node tools/m59-handoff.mjs mint --to "a guildmate" --agents t1,t2 --for 4h   # owner
node tools/m59-lend.mjs --port 8931                                          # owner, behind a tunnel
node tools/m59-mcp-attach.mjs --host <tunnel> --port 8931 --token m59g_...   # borrower
```

The borrowed characters then appear in the borrower's own tooling as ordinary MCP tools.
`node tools/m59-handoff.mjs list` shows every grant and what it has been used for;
`revoke <id>` ends it on the next request.

- **A grant is FULL CONTROL by default**, including what cannot be undone. That is
  deliberate: half-lending a character produces a bot that stalls on the verb you withheld,
  and you find out from a silence rather than an error. `--safe` opts into withholding the
  irreversible ones (`leave`, `forget`, `reroll`, `pilot`, `describe`, and the destructive
  guild verbs). **`leave` and `forget` are the worst of them** — they drop the roster entry,
  and the roster is the only record of the account password.
- **What a grant still is not, even at full control**, is the reason it beats telling
  somebody the password: it is revocable in one command, it expires on its own, it is
  scoped to named characters rather than the account, every use is attributed — and the
  holder never learns the credential, so revoking actually ends it.
- **The token is never stored**, only a salted SHA-256, so a leaked grant file names who was
  trusted and grants nothing.
- **`fleet` comes back filtered** to the characters the grant covers. A borrower of two
  characters gets a board of two; otherwise every lend leaks the whole roster's positions,
  health and money.
- **`m59-lend.mjs` is a separate process from the broker and must stay one.** The broker's
  own port has no authentication — its controls render only for loopback and the POST is
  refused at the socket for anything else — which is right for something holding twenty-one
  irreplaceable accounts, and exactly what you do not bolt an internet-facing auth layer
  onto. The lend door owns no sessions, no roster and no lock, and can do nothing a local
  operator could not.
- **There is no TLS here.** Put it behind a VPN or an SSH tunnel; never expose either port
  directly. `substrate/grants/` is gitignored, like the roster.

## A NUMBER THAT IS THIS CHECKOUT'S OPINION DOES NOT BELONG IN GIT

`fight_above_vigor: 180` was two different claims wearing one coat, and they have
opposite homes.

One is **mechanics**: resting stops awarding vigor at 80 of 200 (`RestTimer`, and
`REST_VIGOR_CAP` here), so everything above 80 has to be EATEN, and `create food` costs 2
elderberry **and** 2 herbs. That is not an opinion, it is what the game does, and it
belongs in the repository with its citation.

The other is a **bet**: that this fleet's apothecary run is working well enough to keep
twenty-one characters fed past the cap. That is true on a good afternoon and false on a
bad one — measured 2026-08-14, herbs were **zero on all 21 characters** with 10
elderberry between them, so not one of them could cast it — and it was never true for
anybody else's roster at all. Committed, it ships as advice to a stranger whose fleet it
will get killed, and the history fills with an argument about a number that was only ever
local.

So the bet moves out:

```bash
node tools/m59-localpolicy.mjs             # what this checkout overrides, and what it does not
node tools/m59-localpolicy.mjs --explain   # the overridable surface, and the mechanics behind each key
node tools/m59-localpolicy.mjs --example   # a starter file to copy
```

`substrate/policy.local.json` is gitignored and holds this machine's answer, per block —
`valley_orders` and `lowland_orders` are the two `m59-supervise.mjs` deploys with. The
committed defaults in that file are untouched and remain **exactly what a fresh clone
runs**. `meridian59-dum-bot` has the same split already and now uses it the same way: the
committed doctrine keeps 180 as its documented example, `doctrines/local/` carries what
prod actually runs, and `loadDoctrine`'s provenance names the local file so you can see
which one won.

Four properties, each of which is the cheap mistake:

- **Silence means the behaviour that was already there, never an empty policy.** An
  absent file, an empty one, a block this build has no name for — all three return the
  committed orders object unchanged. Returning `{}` would strip every flee threshold off
  a live fleet while looking like doing nothing, which is the same failure the loadout
  overlay is built to avoid.
- **A file that will not parse is not an empty file.** It keeps the committed defaults
  *and says so*, because the operator who just edited it is the last person who would
  suspect that their broken JSON silently reverted the fleet.
- **An unusable value keeps the committed one rather than unsetting it.** `flee_below: 35`
  is somebody typing a percentage; it must not become a threshold of 3500% and it must not
  quietly remove the floor. Falling back to the default is the safe direction.
- **An unrecognised key is reported, never applied and never dropped.** A setting that
  silently does nothing is how `purpose` stayed out of a schema for a year while every
  keeper in the fleet ran with an audit switched off that everyone believed was on.

And the **mechanics are not overridable**. `VIGOR_MAX`, `REST_VIGOR_CAP` and
`MIN_FIGHT_VIGOR` are exported for citation and a local file naming one is refused —
but a floor **above** the cap is *allowed* and **warned about**, naming the recipe,
because a fleet holding out for a vigor no amount of resting can deliver looks on the
board exactly like a fleet that is working. That warning is the whole reason the module
exists: it is the sentence that would have been printed on the round the fleet sat at
exactly 80 vigor with an empty larder, reading as twenty-one healthy characters.

`MIN_FIGHT_VIGOR` (100) sits **above** `REST_VIGOR_CAP` (80), so the two are not the ends
of a quiet middle band — there is no setting that clears both. Written as an either/or,
every value warned about something, which reads the same as nothing. They are independent
remarks and a value may collect both.

## Working in this repository

- **A CLAIM THAT CONTRADICTS WHAT IS ALREADY WRITTEN DOWN NEEDS A REPRODUCTION BEFORE
  ANYTHING IS DECIDED ON IT — and the private server is where that reproduction goes.**
  Not every fact needs an experiment; most observations are just observations, and
  demanding proof of each would stop the work. The bar is **two things at once**: the
  claim cuts against this file, the kod, or the extracted indexes, **and** something is
  about to be decided on it. Contradicting the literature about a detail nobody acts on
  can wait. Contradicting it about a number a resupply plan rests on cannot.

  The failure this exists to stop, **and it was checked and is WRONG**: *"Meidei only
  sells one item per call"* went into a fleet report as a constraint on feeding
  twenty-one characters. It contradicted a source-cited fact three sections above, and
  the source settles it — `monster.kod:238` declares `vbSellFromInventory = FALSE` for
  every merchant in the tree, exactly **two** classes override it to TRUE
  (`kcshopk.kod:54`, `izzio.kod:54`), and Meidei is `BarloqueBartender is BarloqueTown`
  (`bqbart.kod:11`), which is neither. **She assembles her list on demand and cannot run
  out.** Ask again and she sells again.

  The evidence for overturning the literature had been ONE ambiguous reading: a `shop`
  call whose `got` field listed a single item, with no second call, no purse reading, and
  no catalogue check afterwards. The same session had already logged `apple x10` from
  that same merchant and did not notice the contradiction. **An inventory line saying
  `x1` is a STACK SIZE, not a refusal**, and the two are indistinguishable unless you
  measure the purse. Reading a one-item response as an empty shop also had a cost beyond
  being wrong: it argued for a second food vendor the fleet does not need.

  So when the bar is met: **measure the thing that must change if the claim is true** —
  the purse before and after each call, not the wording of one response — and **repeat
  the call**, because "it stopped after one" and "I only asked once" produce identical
  evidence. A merchant refusal is a sentence spoken to the room (see the Izzio/Ko'catan
  note above), never an error on the wire, so no error has never meant success here.

  **Prod cannot answer this kind of question at all: the fleet is being driven, so the
  subject walks away mid-experiment.** Five candidates in a row were walked out of the
  shop before a second buy. That is not a flaky test, it is the bot holding movement —
  and it is why the controlled reading has to happen on the private server.

- **The private server is on `127.0.0.1:15959`, not 5959.** It is a native Windows
  `blakserv.exe`, its admin port moves with it (19998), and `docker ps` reports nothing
  because there is no container. A bare port check against 5959 returns `ECONNREFUSED`
  and reads exactly like "the server is down" — which is what the parent repository's
  notes still say, and it is wrong. Check the listening port of the running process
  before concluding anything is down.

- Every tool in `tools/` is standalone `.mjs`, zero dependencies, run with
  `node tools/<name>.mjs`. Only the chat responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree. The compendium's citations
  and the Python analysis scripts both read it.
- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (116),
  `node tools/m59-chat-test.mjs` (128) and
  `node tools/m59-rest-test.mjs` (38) and
  `node tools/m59-ledger-test.mjs` (25) and
  `node tools/m59-localpolicy-test.mjs` (71 — **the contract test for the overlay that
  separates this checkout's opinions from this repository's**: that an absent, empty or
  unparseable local file all mean the committed behaviour rather than an empty policy,
  that an unusable value keeps the committed one instead of unsetting it, that an
  unrecognised key is reported rather than dropped, and that no local file can move a
  mechanic or throw hard enough to stop a supervisor round) and
  `node tools/m59-handoff-test.mjs` (112 — **the contract test for lending a character
  without lending the password**: that the token is never on disk so a leaked grant file is
  an audit record rather than a key, that expiry is decided on USE and revocation on the
  next request, that `read` cannot order and an agent allowlist actually excludes, that a
  grant is FULL CONTROL by default and `--safe` is opt-in, and that a restricted tool whose
  destructive verbs are chosen by an argument is refused when the argument is omitted. It
  caught a real intermittent auth bug: ids were base64url, whose alphabet contains the
  token separator) and
  `node tools/m59-travel-test.mjs` (24 — **one call is the whole journey**: that a refused
  doorway and an off-grid instant are re-settled and retried rather than returned, that a
  stumble is not a hop so re-settling cannot eat the room budget, that patience is bounded
  and the reason survives to the caller, that a journey whose last hop is also its last
  permitted hop reports arrival rather than "gave up", and that a cancelled movement still
  wins. It lifts the real method out of `m59-broker.mjs` by brace-matching rather than
  reimplementing it, because that file cannot be imported without taking the fleet lock) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (383) and
  `node tools/m59-playbook-test.mjs` (37 — the three moments, the closed verb set, and
  the two rules that fail in the dangerous direction if inverted: silence means carry on,
  and an unknown condition never holds) and
  `node tools/m59-commitment-test.mjs` (71 — what counts as being spoken for, and the
  distinction between a bot OWNING a character and being mid-operation on it) and
  `node tools/m59-unattended-test.mjs` (44 — **the contract test for the carve-out**: with
  no bot attached every faculty answers `keeper`, a bot asking for all eight gets only the
  directional four, an expired lease is the keeper's again, and the override takes a
  character back rather than letting the next heartbeat reclaim it. It should fail the day
  somebody moves a survival decision out of this repository) and
  `node tools/m59-deaths-test.mjs` (82) and
  `node tools/m59-stream-test.mjs` (54) and
  `node tools/m59-ability-test.mjs` (44) and
  `node tools/m59-compendium-test.mjs` (42) and
  `node tools/m59-prey-test.mjs` (56) and
  `node tools/m59-spellaudit-test.mjs` (28) and
  `node tools/m59-localclient-test.mjs` (65 — the last ten spawn REAL processes named
  `Meridian.exe`, because every failure mode of the POSIX scan is invisible to a fixture.
  **A PROTON LAUNCH IS SIX PROCESSES, NOT ONE** — reaper, srt-bwrap, pv-adverb, proton,
  steam.exe, the game — all repeating one command line, so a naive count reads six clients
  and refuses to claim any of them; the identity is the ACCOUNT. Only the last of the six
  has the executable at `argv[0]`, and that is the one a claim must bind to, because a
  claim is released when its pid exits. A process that merely mentions the client, like a
  grep or `m59-shortcuts.mjs --show`, must not be claimed off flags that are only quoted
  text. And the cap counts CLIENTS, not processes: at eight raw matches the second
  person's launch truncates mid-chain. The fixture symlinks `/bin/bash`, because a
  `#!/bin/bash` script runs with `argv[0]` = `/bin/bash` and would have tested the wrong
  shape. **The scan reads the whole machine**, so the assertions are scoped to accounts
  nobody plays — a live Kermit failed five of them by being correctly detected) and
  `node tools/m59-bank-test.mjs` (52) and
  `node tools/m59-describe-test.mjs` (52) and
  `node tools/m59-party-test.mjs` (57) and
  `node tools/m59-hits-test.mjs` (41) and
  `node tools/m59-loadout-test.mjs` (126 — the loadout format, the learning arithmetic, the
  composed sell decision, and the fleet-wide gear write, against scratch directories; it sets
  `M59_LOADOUT_DIR` so it never reads the real one, which a live keeper is reading every
  pass) and
  `node tools/m59-coordination-test.mjs` (25 — what the fleet is short of, who is near
  enough to be handed it, and how far a courier walks: that a loadout shortfall of any kind
  reaches the board with its quantity, that the neighbourhood is polled nearest-first, and
  that a stale declaration and a zero shortfall are both refused as delivery orders) and
  `node tools/m59-grudge-test.mjs` (48 — **the contract test for the only code here that
  can make a character hit a real person**: that `PF_*` is read as an enum so a Dungeon
  Master is never mistaken for a murderer, that a grudge and a live flag are BOTH required
  and neither alone is enough, that the hour is measured from the last blow, and that a
  fleetmate is refused before anything else is asked) and
  `node tools/m59-townrun-test.mjs` (15 — **which counter a town trip is aimed at, and what
  the errand costs**: that a reagent shortfall goes to the apothecary and never to a market
  that cannot sell it anything, that an empty purse sends it to a bank FIRST, that a full
  pack still goes to Roq, and that the bill the trip and the withdrawal both read has one
  home. See the trap below on a trip that cannot fix the thing that opened it) and
  `node tools/m59-guild-test.mjs` (192 — **the contract test for a command space that
  refuses in total silence**: that the permission check runs off the server's own bitmask
  rather than the rank table, that invite is LORD while exile is LIEUTENANT, that
  `set_password` inherits MASTER from a declaration it does not make, that UC_GUILDINFO's
  conditional password branch reads to the last byte on both shapes, that the ten rank
  titles are five ranks × two genders in packet order, that mutual enemies and one-sided
  declared enemies stay apart, and that induction is serial because the game makes it so.
  that the rent sign survives two overlapping negative sentences, and that the Bookmaker's
  own rent override is not the non-PK doubling in disguise. Founding costs 5,000 and cannot be
  undone and a hall is 25,000, so none of it can be learned live) and
  `node tools/m59-economy-test.mjs` (61 — the Economy and Skills boards, and the one
  tab bar all six boards share) and
  `node tools/m59-stats-test.mjs` (60 — the Stats board and the pane it shares with the
  planner: that grouping is the six numbers and not the level, that a sheet with no
  attributes is never folded in as a zero roll, that a roster character with no sheet at all
  is named rather than silently absent from a page of percentages, that the read-only pane
  carries neither a slider nor the hatching that marks a typed value, and that the ceiling and
  carry arithmetic have one home. Runs against scratch sheets, never the fleet's own) and
  `node tools/m59-backup-test.mjs` (42 — backing the rosters up and putting them back,
  against scratch directories; never touches a real fleet) and
  `node tools/m59-testbed-test.mjs` (104 — the DM command vocabulary, the patrol ring, the
  scenario spec and the arena reply. **Opens no socket, deliberately**: every live failure
  these three tools have had was "the command we sent was not the command we meant" — a
  room object id read out of a reply header, a karma figure a hundred times too small, a
  name with a digit in it that the server accepts and silently replaces — and all of those
  are decidable from a string) and
  `node tools/m59-buyers-test.mjs` (38 — **what a merchant will actually buy**: that a gem
  is also a reagent and the apothecaries' exclusion turns on it, that Marion's smith takes
  no body armour, that an exclusive rule excludes a sibling of the same family, and above
  all that "cannot say" falls through to OFFERING. The two failure directions are not
  symmetric — a wasted offer costs a round trip, a wrongly withheld item costs the sale and
  is invisible) and
  `node tools/m59-merchants-test.mjs` (77, dropping to 43 without `M59_ROOT`) and
  `node tools/m59-collision-test.mjs` (148 — **the fail-closed contract for all
  movement**: compact collision metadata survives a bake, legacy maps cannot authorize
  a coordinate packet, the player cylinder catches wall bodies and corners, long strides
  cannot tunnel, stock endpoint-0 slope and water-depth rules are preserved, every
  emitted packet is revalidated, and the documented Brownestone, Limping Toad, Icky,
  Farol, Ukgoth, Cor Noth, Temple, and Fey precision cases remain usable) and
  `node tools/m59-roo-test.mjs` (74, with raw-room checks skipping without a copy of the game's
  `resource/rooms`). The rest need a live server —
  `m59-autopilot-test`, `m59-skills-test` and `m59-coop-test` all want a broker on
  8899 and fail with `ECONNREFUSED` without one, which is not a regression.
- **Do not `import` `m59-broker.mjs` to check it.** Importing runs it: it tries to
  take the fleet lock and start rejoin timers. `node --check tools/m59-broker.mjs`
  is the syntax check. `m59-supervise.mjs` had the same problem and now guards its
  main loop on being the entry point, so it can be imported for its pure helpers.

- **MELEE REACH IS A DISC OF RADIUS 2–3 SQUARES, AND FINE COORDINATES DO NOT EXIST TO IT.**
  Both sides run the same test: `SquaredDistanceTo <= GetAttackRange^2`, where the
  distance is `(piRow-row)^2 + (piCol-col)^2` on **square** coordinates
  (`nomoveon.kod:121`) and the range is `Bound(2 + viDifficulty/6, 2, 3)` for a monster
  (`monster.kod:1682`) or 2–3 by weapon type for us (`weapon.kod:52`). So up to 28
  squares can hit you, not the 8 that touch you.

  `piFine_row`/`piFine_col` exist on every object and **nothing about being hit reads
  them** — the only consumer in the whole tree is `MonsterOrient`, choosing the angle a
  monster is *drawn* facing (`monster.kod:2189`). Standing hard against a wall inside a
  square is therefore worth exactly nothing, and an earlier "hug the wall by 24 of 64
  fine units" change was inert by construction. Do not reach for sub-square positioning
  to explain a safe spot; the answer is always in the squares.

- **The safe wall is an asymmetry in who checks line of sight.** `Monster.CanReach`
  calls `Room.LineOfSight` (`monster.kod:1782`); `Player.TargetWithinSightAndRange`
  (`player.kod:4115`) checks range and a facing cone and **never calls it**. So a square
  whose line to a patch of floor is broken, while that floor is still inside your weapon
  range, lets you hit what stands there and take nothing back. `free_shots` in
  `m59-safespots.mjs` counts exactly those. Only lich and revenant ignore walls
  (`AI_FIGHT_THROUGH_WALLS`).

  **And a blow already in the air is not the wall's fault.** Being hit is resolved on the
  server and reaches us as a packet; our arrival travels the other way. So a blow resolved
  while we were still a square short can land after we have reported standing on the spot,
  and the reading blames the square. A failure is **permanent** (`discredited()`), so one
  such reading retires a good square for ever and nothing about it looks wrong afterwards.
  `SETTLE_GRACE_MS` (250ms, `m59-autopilot.mjs`) discards any window that opens before we
  have been settled that long, measured from the LATER of "stopped moving" and "claimed
  the square". Both clocks, because the walked-in path was already covered by accident —
  `takeSafeSpot` stamps `movedAt` on arrival, so the first window is thrown out for "we
  moved" — while `steps_away === 0`, claiming a square we were already standing on, walks
  nowhere, stamps nothing, and opened a countable window the instant the hold was taken.

  The window is **discarded, not forgiven**: the same packet delay that hides a hit until
  later is what would make the square look quiet now, so a reading we will not trust for
  damage is not one we may trust for proof. And the grace is deliberately narrower than
  the round trip can be, because the asymmetry runs the other way — being wrong about a
  bad square costs a character, being wrong about a good one costs a walk to the next
  corner. `settled_ms`/`min_settled_ms` are recorded on every real failure so the width
  can be argued from the record rather than from intuition; widen it only against those.

- **A PLANNED TRIP ACCEPTS THE RISK OF DEATH, AND ABANDONING ONE IS NOT AN OPTION. THE WAY
  OUT OF AN ATTACK DURING TRAVEL IS ALWAYS THROUGH.** When a journey is planned the risk is
  taken at that moment; a character being attacked on the way does not get to reconsider it.
  It completes the journey AS FAST AS POSSIBLE WHILE BEING ATTACKED. It does not stop to
  fight, it does not turn back, and nothing else may cancel the trip on its behalf.

  This is doctrine, not an optimisation, and it is written down because the obvious-looking
  fixes all violate it. Two were tried here on one afternoon and both were reverted: giving
  the character back to its keeper when health dropped below a threshold (that ends the
  trip), and putting a timeout on the errand's calls so a "hung" leg could be retried (that
  was a fix for a hang which, on inspection, had never happened). A trip that is abandoned
  costs the character its armour money AND leaves it wherever it stopped, which is usually
  worse than the room it was walking to.

  **AND `ms_since_moved` IS ABOUT THE KEEPER, NOT THE CHARACTER — it is what made both of
  those look justified.** A post-mortem showing `doing: "stalled"` with eight minutes since
  it last moved reads exactly like a character standing still being eaten. It was not: the
  frames put that character in three different rooms over the same span. The field measures
  when the KEEPER last moved it, and during an errand the keeper is inert by design, so the
  number climbs while the errand walks. `watchdog.stood_down_for` on the same record says so
  outright, and `pass_blocked_ms` was 5.6 seconds rather than the eight minutes the other
  field implied. Read those three together or the instrument will invent a stall for you.

  What actually happened is what the doctrine describes: an errand walked a character at 1
  of 49 health through rooms holding six to nine things, and it died going through. That is
  an accepted outcome of a planned trip, not a defect to engineer around.

- **SOLDIERS ARE NOT SPAWNED BY ROOMS, THEY ARE SUMMONED BY FLAGPOLES — AND A NEUTRAL
  FLAGPOLE SUMMONS NOTHING.** `substrate/m59-spawns.json` lists one huntable soldier in the
  whole world (a rebel soldier in the Sewers of Jasper) and that is not an omission: troops
  have no room spawn table. `flag.kod` generates them on a timer from the flagpole object —
  `FACTION_DUKE -> &DukeTroop`, `FACTION_PRINCESS -> &PrincessTroop`, rebel likewise — and
  the function returns immediately `if piFaction = FACTION_NEUTRAL`. Troop availability is a
  property of the TERRITORY GAME, not of the map: it depends on which flagpoles players have
  claimed, and it changes without warning.

  Setting `hunt` to a soldier when none are present is therefore not a harmless miss. The
  keeper finds nothing, roams looking for it, and roams somewhere it has no business being —
  which sent Sweetums out of Ileria into the Decaying City of Brax, where six narthyl worms
  killed it, and left three others stalled on "no safe wall here and nowhere better to go".

  **The flagpoles are already under the fleet's feet.** Thirty-one rooms declare
  `viFlag_row`/`viFlag_col` and thirty are rooms this fleet already hunts in or walks
  through — 534 Deep Woods of Ileria, 544 Valley of Ileria, 562 the sandy shores, 583
  Outskirts of Barloque, 586 Main gate to Tos, 596 Outskirts of Tos, plus 535, 545, 552,
  556, 557, 576, 584, 585, 587, 593, 603 and the four town rooms. They are the paths BETWEEN
  the towns, which is where the territory game is played. Nothing needs to travel somewhere
  new to find troops; the flagpole beside it needs to be claimed.

  **All three factions match the word `soldier`** — `soldier of the Princess' army`,
  `soldier of the Duke's army`, `rebel soldier` — so one substring catches them all and
  naming a faction would miss two thirds.

  **THEY ARE NOT LEVEL 50, AND THIS ENTRY USED TO SAY THEY WERE.** It read the declared
  `viLevel = 50 / viDifficulty = 2` off `duketr.kod` and concluded they were "barely more
  dangerous than the current prey" at a rating of 270 against a fungus beast's 210. That
  is wrong, and it is wrong in the direction that sends a fleet somewhere it cannot come
  back from. `FactionTroop.Constructor` (`troop.kod:215`) calls `SetEquipment`, which
  **overwrites both numbers at the moment of creation**:

  | roll | | sets |
  |---|---|---|
  | weapon — Longsword 35%, Axe 20%, Hammer 10%, Mace 10%, ShortSword 15%, Scimitar 10% | `+1..+4` | `viDifficulty = piBaseDifficulty + bonus` |
  | armour — Leather 35%, Chain 35%, Scale 30% | `+20/+50/+75` | `viLevel = piBaseLevel + bonus` |
  | gauntlets, 19% (`if iRandomNumber < 20`) | | `viLevel +20` **and** `viDifficulty +1` |

  So a soldier is level **70–145**, difficulty **3–7**, attack rating **390–855, mean 572**
  — between a zombie (405) and a groundworm (600), and *harder than the graveyard night
  shift rather than easier*. The necromancer troop is 540–1005. **The level bonus comes
  from the armour**, so the 30% carrying the best prize are also the worst to meet.

  The death record always agreed: faction soldiers were present at 241 of the 403 attended
  deaths on disk, which is not what a rating of 270 looks like. `m59-spawns.mjs` now
  computes the range (`rolledTroopStats`, and `rolled` on the creature row); the top-level
  `level`/`difficulty`/`attack_rating` carry the **worst** case, because every consumer of
  those is a safety gate. Ask `rolled.level.min` for the floor.

  **THEY ARE ABOVE THE BAND FOR EVERY CHARACTER THIS FLEET HAS EVER HAD.** `refuseEngagement`
  refuses anything whose level exceeds `max_health + maxThreatOver` (6). The weakest possible
  soldier is level 70; the strongest character here is 50. There is no roll of the dice that
  produces a soldier a level-50 character may fight, and raising `maxThreatOver` to 95 to
  permit it would permit everything else in the world too.

  And what they carry is worth less than it looks. **`EQUIPMENT_DROP_PERCENT = 20`**
  (`troop.kod:33`), rolled per item, and what does not drop is `Delete`d — so any body
  armour is 1 kill in 5, and *leather specifically* is `0.35 × 0.20` = **7%, about fourteen
  soldiers per leather**. **The shield never drops at all**: `AND (NOT
  IsClass(oUsedItem,vcShieldClass))`, commented *"Don't drop the shield! It's a
  quest/special item!"* (`troop.kod:1043`). This entry claimed a shield on every soldier
  and that they dropped on death; both were wrong.

  **SO DO NOT FARM SOLDIERS FOR ARMOUR — THE SPIDER AND THE ORC ARE BOTH BETTER AND BOTH
  FIGHTABLE.** Every creature in the world that drops body armour, by how dangerous it is:

  | | level | rating | per kill | in the band? |
  |---|---|---|---|---|
  | **spider** | 50 | **390** | leather 2% + chain 1% per roll, ~1.5 rolls -> **~4.5%** | **yes** |
  | zombie | 55 | 405 | chain 1%/roll | no |
  | **orc** | 45 | **495** | leather 5%/roll, ~2 rolls -> **~10%** | **yes** |
  | troll | 100 | 750 | scale 3%/roll | no |
  | faction soldier | 70–145 | 572 mean | **20%** — best rate in the game | **NO, never** |

  The soldier has by far the best drop rate and is the only one on the list a character
  here may not fight. The orc beats it on leather anyway (10% against 7%) at a lower
  rating. **A fungus beast drops no armour at all**, which is why a fleet farming them can
  grind for a week and stay bare.

  Take spiders from **536 Forest of Farol** (70%, cap 12) or **556 Deep Forest of Farol**
  (55%, cap 16) — nothing in either table rates above 390. **Not 596 Outskirts of Tos**
  (groundworm, 600), **not 597 The Twisted Wood** (troll, 750), and **not 35 The Spider
  Nest**, where the queen rates 1035.

- **THE GRAVEYARD OF TOS IS OPEN THIRTY-FIVE MINUTES IN EVERY TWO HOURS, AND THE CLOCK IS
  ARITHMETIC ON THE WALL CLOCK.** `tosgrave.kod` holds
  `plMonsters = [[&Zombie, 85], [&Skeleton, 15]]` and gates creation on
  `iHour = Send(SYS,@GetHour); if iHour < 5 or iHour > 21` — outside that window
  `TryCreateMonster` returns without propagating and the room generates nothing at all. A
  fleet parked there by day is standing in an empty field.

  The hour needs no packet. `system.kod` derives it from real time and says so in its own
  comment: `iTime = GetTime() - 5*HOUR`, `iMinutes = (iTime mod (2*HOUR))/60` ("our day is 2
  hours long now"), `piHour = iMinutes/5`. A game day is TWO REAL HOURS, a game hour is FIVE
  REAL MINUTES, and the undead window is 35 real minutes in every 120.
  `BP_LIGHT_AMBIENT` (220) is pushed by the server on every light change and this client does
  not parse it; it would corroborate the clock but is not needed to compute it.
  `tools/m59-nightshift.mjs` is that arithmetic.

  **A window that short is shorter than the walk to it.** Re-tasking the fleet at the edge
  put one character in room 70 and killed zero undead; the other twenty spent the window
  walking from Ileria. The shift sets off with a lead (default 20 minutes), which costs the
  tail of the day shift and is the cheap end to spend.

  The prey is a real step up — zombie level 55 difficulty 4 (405), skeleton level 75
  difficulty 5 (525), against 210 — and worth it, because nine characters are stuck at 50
  and a level-50 fungus beast cannot advance them (the rule is STRICTLY greater). It is also
  roughly twice the incoming hit rate, so armour stops being optional.

- **A creature's LEVEL is not how dangerous it is.** Level sets hit points and what
  the kill pays; what it hits you *with* is `viDifficulty`, via
  `GetAttackAbility = 3*viLevel + 60*viDifficulty` (`monster.kod`). A fungus beast is
  level 50 and difficulty 1, so it rates 210 — against a centipede's 390 at level 30.
  Damage is `Fuzzy(viLevel/Random(10,15))`, 3–5 against 2–3. The level-50 creature is
  the *safer* fight, and the `prey` band, which sorts on level alone, will not offer
  it. `tools/m59-supervise.mjs` documents the full arithmetic.

- **Heavy armour is worse here — BUT BARE IS WORSE THAN ALL OF IT, AND THAT IS A
  DIFFERENT QUESTION.** Each piece carries `viDefense_base` (how often you are hit) and
  `viDamage_base` (absorption). They pull opposite ways: leather is +50/0, plate is
  -200/6 with a -30 spell modifier. On a scale where a monster's whole attack rating is
  ~210, -200 is enormous — and a character fighting from a safe spot intends to be hit
  zero times, which absorption does nothing about. `wear_best` ranks on that, so it buys
  leather over plate deliberately.

  What that ranking was also doing, wrongly, was **refusing to wear anything at all**
  when the only armour in the pack scored below zero — leaving fourteen of twenty-one
  characters bare while carrying chain or scale. Bare skin is not the neutral baseline
  the score treats it as: it has no defence bonus **and** no absorption. Worked against
  this fleet (agility 45, base max health 50, block 90, so `iDefense` = 345,
  `player.kod:4320`), expected damage per fungus-beast swing is **bare 1.34, chain 1.18,
  leather 1.17, scale 0.71** — bare is last. So there is now a **floor**: with the slot
  EMPTY, the best available piece is worn provided it absorbs something, it is reported
  as `floor: true` rather than silently, and a negative piece is no longer stripped down
  to skin when nothing better exists.

  Two things the arithmetic depends on, both of which cut against absorption and are
  priced in above. It is `random(reduce/3, reduce)`, not the face value, and it is
  bounded to `damage-1` (`defmod.kod:108`) — **a blow always lands for at least 1**.

  **And the hit chance is `offense * 55 / defence` BOUNDED TO [10,95]** (`battler.kod:331`).
  That bound is why "more defence" is not always the answer: against anything that pins
  us at 95% — a faction soldier at 572 does, leather or not — extra defence buys
  *literally nothing* and absorption is the only thing still working. Against a fungus
  beast the bound does not bind and leather wins. `ABSORB_IS_WORTH` (10) was deliberately
  **not** raised, because anything over 25 flips leather-versus-scale fleet-wide as a side
  effect, and that question turns on block, on shields, and on the spell modifier the
  create-food loop runs on. See `ARMOUR` and `absorbsSomething` in `m59-skills.mjs`.
- The compendium's sprites are not committed. `python tools/pull-client-assets.py`
  decodes them from a local client. Do not commit `compendium/assets/img/`.
- Do not commit anything a running fleet writes — `fleet-state.json`,
  `history/`, `recordings/`, `commissions/`. The `.gitignore` already covers
  them; do not add exceptions.
