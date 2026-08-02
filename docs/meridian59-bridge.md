# Meridian 59 as an interface — operating manual

A working two-way chat bridge between a running Meridian 59 world and a Claude
Code session. You speak in-game; Claude reads it and answers into the same world.

The game is not the subject. It is a **spatial index into a codebase**: you stand
somewhere, ask about what is in front of you, and the answer is grounded in the
live game state at the moment you asked.

---

## The loop, as built

```
  you type in the M59 client
        │
        ▼
  UserSay (user.kod)  ── MOD: Debug("CHAT|", self, "|", type, "|", string)
        │
        ▼
  debug channel file   ── requires [Channel] Flush = Yes  ← the whole blocker
        │
        ▼
  tools/m59.mjs watch|bridge   (tails the file, parses, files a commission)
        │
        ▼
  Claude Code reads commissions/<id>/brief.md, writes report.md
        │
        ▼
  tools/m59.mjs say "..."  →  admin socket :9998  →  `send users`
        │
        ▼
  text appears in your client
```

Everything outbound uses only commands the maintenance socket is allowed to run.
The single game-code modification is one `Debug()` line in `UserSay`.

---

## Runbook

```bash
# server (Windows, native)
cd C:/code/meridian59/run/server && ./blakserv.exe

# every session, until it is persisted in the cfg — see "Flush" below
node tools/m59.mjs admin "set config boolean [Channel] Flush yes"

node tools/m59.mjs status          # server + who + debug channel size
node tools/m59.mjs who
node tools/m59.mjs say "text"      # speak into the world
node tools/m59.mjs watch           # print player speech as it happens
node tools/m59.mjs bridge          # same, but file each utterance as a commission
node tools/m59.mjs account <name> <password>
node tools/m59.mjs admin "<any maintenance command>"

# client
cd C:/code/meridian59/run/localclient
./meridian.exe /U:<name> /W:<password> /H:localhost /P:5959
```

---

## Things that cost time to find out

### 1. `[Channel] Flush` defaults to `No`, and it is the whole ballgame

`blakserv/config.c:77`. With `Flush = No`, **every channel log is buffered and
never reaches disk** — `DebugDisk Yes` is not sufficient. Debug, error and log
files are created at startup and stay at 0 bytes indefinitely.

This masquerades as "my hook isn't firing". It is not. The hook fires; the output
is sitting in a buffer.

```
set config boolean [Channel] Flush yes
```

is runtime-settable **over the maintenance socket**, and takes effect instantly —
including flushing everything already buffered. Persisted now in
`run/server/blakserv.cfg` and in the Dockerfile.

Diagnostic: `admin "mark"` writes a dashed line to every channel. If file sizes
stay at 0 after a `mark`, flushing is off.

### 2. The admin surface is split A / A|M — and parent gates are *not* enforced

`blakserv/adminfn.c`. Every command carries `A` (Windows GUI Administration tab)
or `A|M` (also the maintenance socket on :9998).

The important subtlety: **subcommand tables have `A`-only parents, but the parent
flag is not checked when descending.** Only the leaf's flag matters. `send` is
`A`-only yet `send users` (`A|M`) works fine over the socket. So when something is
refused, look at the leaf, not the group.

| available over the socket | GUI-only |
|---|---|
| `send object` / `users` / `class` | `trace on` / `off` |
| `show *` | `create object` |
| `create automated` / `user` / `dm` / `listnode` / `timer` | `create resource` |
| `set config boolean` / `integer` / `string` | `create account` |
| `set class` / `set object` | `create admin` |
| `reload system`, `save game`, `mark`, `read` | `add credits`, `kickoff` |
| `who`, `lock`, `unlock`, `hangup`, `say` | `mail`, `page` |

`trace on User UserSay` cannot be run from the socket **and does not exist in a
headless container at all**, which is why the kod hook is the right mechanism
rather than tracing.

### 3. `nmake Bkod` empties `run/server/loadkod/`

Running `nmake RELEASE=1 Bkod` on its own leaves `run/server/loadkod/` containing
nothing but `.gitignore`. The 1231 `.bof` files build into the `kod/` tree and are
**not** copied across. A running server survives on its in-memory classes, so the
damage is invisible until the next restart, which then comes up with no game code.

After any kod build, re-deploy explicitly:

```bash
find kod -name "*.bof" -exec cp {} run/server/loadkod/ \;
find kod -name "*.rsc" -exec cp {} run/server/rsc/ \;
node tools/m59.mjs admin "reload system"
```

`reload system` is `A|M`, so hot-reloading game code needs no GUI.

### 4. `send users` truncates at ~118 characters, silently

Undocumented; the tail of the parameter is simply dropped. `m59.mjs say` chunks at
100 characters on word boundaries and sends sequentially.

### 5. `vswhere -latest` hides Build Tools

`vswhere -latest -property installationPath` returns empty even with MSVC
installed, because BuildTools is not in the default product set. Use:

```
vswhere -all -products '*' -property installationPath
```

Build with `vcvars32.bat` (32-bit) then `nmake RELEASE=1`.

### 6. Server and client read rooms from different places

- client artwork/rooms/audio → `run/localclient/resource/`
- **server** rooms → `resource/rooms/` (`[Path] Rooms = ..\..\resource\rooms\`)

Content is not in the repo and not covered by its licence. Sourced here from a
Steam install: 2516 `.bgf`, 515 `.ogg`, 266 `.roo`. Best-fit is fine — version
mismatch against this source tree is tolerable for interface purposes.

### 7. `MaintenanceMask` is byte-wise with zero as wildcard

`blakserv/async.c:CheckMaintenanceMask`. Each non-zero byte of the mask must match;
zero bytes match anything. So `127.0.0.1` matches `127.*.*.1`, and `172.0.0.0`
matches any `172.x.x.x` (the docker bridge). Semicolon-separated, max 15 entries.
There is **no password** on the maintenance port — IP mask is the only gate, which
is why the container publishes 9998 on loopback only.

### 8. Object ids change across `reload system`

`varuka` was object 4598, then 4577 after a reload. Never cache an object id across
a reload; re-read it from `who` or `show`.

---

## Content split-brain: `.roo` files must match on both sides

Symptom: *"There is a problem with your file duke3.roo, please contact your system
administrator"* and a black screen, with the player stuck in that room.

Cause: the server and the client read rooms from **different directories**, and
they had drifted apart.

| | reads rooms from |
|---|---|
| server | `resource/rooms/` |
| client | `run/localclient/resource/` |

When Steam content was copied in, the server's directory was populated with
`cp -n` so the repo's own `.roo` files survived, while the client's directory had
no `.roo` at all and took Steam's wholesale. Result: the server serves the repo's
room, the client tries to load Steam's, and the client rejects the mismatch.

Out of 265 rooms, **exactly one differed** — `duke3.roo`, 42089 bytes (repo) vs
42063 (Steam). Fix is to make the client match the server:

```bash
cp resource/rooms/duke3.roo run/localclient/resource/duke3.roo
```

Audit for the rest before they bite:

```bash
for f in resource/rooms/*.roo; do b=$(basename $f)
  [ -f "run/localclient/resource/$b" ] && { cmp -s "$f" "run/localclient/resource/$b" || echo "DIFFERS: $b"; }
done
```

**Rescuing a stuck player.** `GotoHomeroom` and `TeleportHome` are *not* messages
on `User` — both are refused. `GodRoom`'s `Teleport` accepts the send but does not
move a player. What works is placing them directly:

```
send object 94 NewHold what OBJECT <player> new_row INT 4 new_col INT 6
```

The move is server-side only; the client is not told to reload, so it must be
**fully restarted** (relogin is not enough) before the player sees anything.

## Two fork modifications for the control plane

**`MAX_ADMIN_COMMAND`: 120 → 4096** (`blakserv/admin.h`). This was the real cause
of every truncation, and it is a limit on the *whole command line including its
prefix*, silently discarding the remainder:

| command | prefix | payload left of 118 |
|---|---|---|
| `send users <text>` | 11 | ~107 |
| `send object <room> SomeoneSaidRoom what OBJECT <id> type INT 1 string Q <text>` | 68 | ~50 |

Both sum to 118, which is what gave the puzzle away. `LEN_TEMP_STRING` is already
6000 (`blakserv/bstring.h`), so nothing downstream needed changing. `m59.mjs`
budgets chunks from the prefix length rather than a fixed number, so it stays
correct at either buffer size.

**`vrDesc` as a property on `User`** (`user.kod`). It is declared a classvar on
`Object`, so it was shared by every user and `set object <id> vrDesc ...` was
accepted while doing nothing. Redeclared alongside `vrName`/`vrIcon`.

## Object ids are not stable — resolve by account

Ids are reassigned by `reload system`, by a restart, **and by `save game`** — which
garbage-collects first, compacting the object table. That last one is the dangerous
case, because saving feels like a read-only checkpoint and happens constantly.

This fails **silently**. A stale id points at unrelated furniture and the commands
still report success, because `set object <id> <prop>` on a class without that
property is simply ignored.

Observed: object 4348 became a `QuestNode`. 5315 became a `QuestX`. And mid-session,
a player at 4559 moved to 4557 across one `save game` while **4559 became that
player's own Money object** — five `set object 4559 piHealth ...` writes went to a
coin stack and were quietly discarded.

**Rule: never carry an object id across a `save game`, `reload system`, or restart.
Re-resolve from the account every time, and verify *before* saving, not after.**

Account numbers are stable. `show account <n>` reports the account's current
object, and `m59.mjs` resolves the body that way on every invocation:

```
show account 5
  Acct Object  Class   Name
     5    5220 User    Claude
```

Dynamic resources (`create resource`) and property values **do** survive a
save/restart — the ghost icon and the name persisted.

## The chat line format

The `UserSay` hook emits:

```
Jul 29 2026 14:18:08|[user.bof (4046)] CHAT|,ACCOUNT 4 OBJECT 4577,|,3,|,can you hear me
```

kod's `Debug()` joins its arguments with commas, which is where the `,|,`
separators come from. Parsed by:

```js
/CHAT\|,ACCOUNT (\d+) OBJECT (\d+),\|,(\d+),\|,(.*)$/
```

Say types (`kod/include/blakston.khd`):

| | | | | |
|---|---|---|---|---|
| 1 say | 2 yell | 3 broadcast | 4 group | 5 resource |
| 6 emote | 7 message | 8 group-one | 9 dm | 10 guild |

---

## `send object` — calling kod from outside

This is the control plane. It invokes any kod message on any object and prints the
return value, which means the socket can both **drive** and **read** the world.

```
send object <id> <Message> [<param> <TAG> <value>]...
```

Parameters are **space-separated name/tag/value triples** — not `#name=value` and
not `name=value`, both of which are rejected. The name must be a real kod
identifier. Tags (`blakserv/term.c`): `INT`, `OBJECT`, `RESOURCE`, `STRING`,
`TEMP_STRING`, `NIL`.

`TEMP_STRING` is special: it consumes the **rest of the line** as a literal string,
so it must come last. It removes the need to `create resource` first for
throwaway text.

```
send object 4577 GetName
  :< return from OBJECT 4577 MESSAGE GetName (10040)
  : RESOURCE 1000003
  :   == "Varuka"
```

**Reading game state is the important half.** Any accessor works — name, room
(`poOwner`), position, inventory, current target — either via `show object <id>`
for the full property dump or `send object <id> <Getter>` for a single value. That
is what makes "where is the code that calculates this damage" answerable about
*the mummy you are actually hitting*, rather than about mummies in general.

`create resource <text>` returns a dynamic resource id (`1000004 (dynamic) = ...`)
for text that needs to persist beyond one call.

## Giving Claude a body

A visible, named character standing in the room, driven entirely from the socket.
No custom kod class was needed.

```bash
# 1. a body. `create automated` makes account + User object and prints the id.
create automated claudebody <unused-password>      #  -> 5315 User

# 2. a name. vrName is a resource, so make a dynamic one and point at it.
create resource Claude                             #  -> 1000006 (dynamic)
set object 5315 vrName RESOURCE 1000006
send object 5315 GetName                           #  -> "Claude"

# 3. into the room, beside the player
send object 94 NewHold what OBJECT 5315 new_row INT 4 new_col INT 10

# 4. speak, in-room, as Claude
send object 94 SomeoneSaidRoom what OBJECT 5315 type INT 1 string Q Hello.
```

Wrapped up as `m59.mjs roomsay|follow|where`.

**`NewHold` vs `SomethingMoved`.** `NewHold` puts an object into a room it is not
currently in, and is a **silent no-op** if it is already there — it returns
cleanly and the body simply does not move. Moving *within* a room is
`SomethingMoved`. Same parameters. Using only `NewHold` looks like it works.

**The body has `pbLogged_on = 0`** and no session. It still holds a room position
and speech attributed to it renders correctly.

**Incoming text carries client formatting codes** — `~B` bold, `~b` colour, and so
on, mostly on broadcasts. Stripped with `/~./g` before the text is used.

## Awaiting speech

Filing chat into `commissions/` is a one-way feed — nothing wakes the reader, so
utterances pile up unanswered. `await` is the fix and is what makes conversation
possible:

```
node tools/m59.mjs await [seconds]     # default 240
```

It blocks until something is said, then keeps collecting until **2.5s of silence**
so a multi-line thought arrives as one unit rather than as fragments. Exit `0`
means speech, exit `3` means the window closed in silence.

Because it blocks, calling it *is* awaiting — no polling loop, no missed lines.

## Client formatting codes

Introduced by **either `~` or a backtick** (`clientd3d/say.c`); the code is the
single following character, and **case matters**.

| | |
|---|---|
| `~B` `~I` `~U` | bold / italic / underline — **toggles**, re-issue to close |
| `~r` `~g` `~b` | red / green / blue |
| `~k` `~K` | exist; meaning not yet established here |

These carry the speaker's intent, so **do not strip them**. `m59.mjs` converts
B/I/U toggles to markdown, preserves anything else as a visible `{marker}` so
nothing is lost silently, and keeps the untouched original in `raw`.

The client also rate-limits them: `MAX_CODES`, `MAX_CODERUN` and `MAX_SPACES` in
`say.c` drop codes beyond a threshold.

## Appearance and description

Resource names resolve over the socket, which makes appearance easy:

```
show resource ghost_icon_rsc      #  -> 23812  ghost.bgf
set object 5315 vrIcon RESOURCE 23812
```

Handy ids: `ghost_icon_rsc` 23812, `lich_icon_rsc` 24239, `duke_icon_rsc` 25528,
`princess_icon_rsc` 25540.

**`vrDesc` cannot be set per object.** `vrName`, `vrIcon` and `vrDesc` are all
declared as **classvars** on `Object` (`kod/object.kod:64`); the player classes
redeclare name and icon as properties, but not `vrDesc`. So `set object <id>
vrDesc ...` is accepted and silently does nothing, and the object keeps reporting
*"You are looking at an object"*.

`set class User vrDesc ...` would work but rewrites the description for **every**
user, including the human player. The correct fix is to declare `vrDesc` as a
property on the player class alongside `vrName`/`vrIcon`, then rebuild kod.

## The modification

`kod/object/active/holder/nomoveon/battler/player/user.kod`, top of `UserSay`:

```
Debug("CHAT|", self, "|", type, "|", string);
```

`C_Debug` (`blakserv/ccode.c:142`) resolves `TAG_RESOURCE`, so the player's typed
text is printed as text rather than as a resource id.

**Privacy note:** this logs the speech of every player on the server. Fine for a
local single-player instance; revisit before anyone else logs in.

---

## Docker

`docker/Dockerfile`, built against the M59 tree. Full Linux build from source —
blakcomp → kod → blakserv, no Windows artifacts — so it runs anywhere docker
does, Steam Deck included (SteamOS is x86_64). `tools/setup.mjs server` builds
the image and starts it with a plain `docker run` — no compose binary required.
`docker/docker-compose.yml` is an optional convenience that mounts the same
volumes and publishes the same ports.

```
node tools/setup.mjs server        # build + docker run, no compose needed
```

- `5959` published openly, `9998` on loopback only
- `[Path]` rewritten to container-absolute paths, `Flush` forced on
- `MaintenanceMask` widened to the docker bridge and LAN ranges
- `channel/` and `savegame/` are volumes, so the bridge tails chat from the host
- `-Werror` stripped for the build only — upstream's policy is right for upstream,
  wrong for a portability build on an arbitrary g++

Deck plan: server in the container, client under Proton, both on localhost.

---

## Local hearing

The `UserSay` hook sees **every** utterance on the server regardless of where it
happened, which makes an avatar's position meaningless. `User` already handles
`SomeoneSaid` (`user.kod`), and that message arrives *only* if the object is in the
room where something was said — so the engine does the location filtering.

```
Debug("HEARD|", self, "|", what, "|", type, "|", string);
```

Placed **above the `if pbLogged_on` guard**. An avatar driven over the admin socket
has no session, so `pbLogged_on` is FALSE and anything inside that block never runs
for it. This is easy to get wrong and fails silently.

```
HEARD|,ACCOUNT 5 OBJECT 5220,|,ACCOUNT 4 OBJECT 4557,|,1,|,hello
       ^ listener                ^ speaker
```

`m59.mjs await` filters to the body as listener and drops anything the body itself
said, or it answers its own remarks. `await <secs> global` opts back into hearing
everything.

## Escort

`follow` is a snapshot — it moves the body once. `escort <account>` subscribes:
polls the target every 1.6s, uses `SomethingMoved` within a room and `NewHold`
across rooms, and **re-resolves both object ids from their accounts every ~40
ticks** so a `save game` reassigning ids does not strand the body beside the wrong
object.

```
node tools/m59.mjs escort 4        # follow account 4 until killed
```

## Small things

- **`create object` replies `Created object 6452.`** — lowercase, and not the
  `OBJECT <n>` form every other command uses. Parsing for `OBJECT (\d+)` silently
  matches nothing.
- **`NumberItem` stacks via `piNumber`.** Reagents, coins and gems are all
  quantities on one object, so `create object Emerald number INT 100` beats making
  a hundred stones.
- **Room audit came back clean** — 0 differing, 0 server-only, 0 client-only across
  265 rooms once `duke3.roo` was fixed.

## Not done yet

- **Local hearing.** Claude currently hears *every* utterance on the server via the
  `UserSay` hook, regardless of where the body is standing. A Claude avatar class
  with its own `SomeoneSaid` handler would hear only what is said in its room,
  which is the more honest model and the one that makes position mean something.
  The innkeeper pattern (`kod/util/rntmaint.kod:ParseInnkeeperCommands`) is the
  existing idiom for an NPC that parses player speech.
- **Auto-follow.** `follow` is a single manual step; nothing yet watches the
  player's room and moves the body when they walk out.
- **Game state as context.** `show object <id>` already exposes room (`poOwner`),
  position, inventory and target. Reading that at the moment of a question is what
  turns "where is the damage code" into an answer about *the mummy you are hitting
  with a mace* — this is the actual point and it is not built yet.
- **Launching VSCode** from a chat message (`code -g <file>:<line>`).
