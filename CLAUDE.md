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
  **there are two accounts, not one per town**: Jasper, Tos *and Barloque* all pay into
  bank 1, because `BANK_BASIC` and `BID_TOS` are both `1` (`blakston.khd:1275`), while
  Ko'catan is bank 2. "But you only have N shillings in your **possession**" is the
  purse, not the account, and differs from the account line by one word.

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

- **A CHARACTER CAN BE SPOKEN FOR, AND THE BOARD HAS TO SAY SO.** A loot run, a
  provisioning cast, a signet errand and a pairing all have another end, and pulling a
  character out of one abandons that end silently. `m59-commitment.mjs` is the single
  rule for what counts; the keeper publishes it as `committed` on its status and on the
  fleet row, and `m59-tui.mjs` greys those rows and steps over them, with `X` to override
  and take one back. Add a new errand kind and it shows up on the board that day — an
  unrecognised kind is reported as itself rather than dropped, which is what stops a new
  operation being invisible to the one thing meant to protect it.

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

- **THERE ARE FIVE BOARDS AND ONE TAB BAR, AND A PURSE HAS NO RECORD BUT THE SAMPLE.**
  `/` (fleet), `/deaths`, `/tougher`, `/economy` and `/skills`, all on the dashboard port
  (8902 — the MCP port serves only the fleet page). The nav, the stylesheet and the
  inlined treemap live in **`m59-page-chrome.mjs`**: a new board is one line in `TABS`,
  and it is one line because five hand-written copies of a tab list means the sixth board
  is invisible from whichever copy nobody remembered to edit. That had already happened
  once — the fleet page and the deaths page carried two separate copies.

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

- **THE PLANNER IS THE ONLY PAGE IN THE COMPENDIUM THAT CAN WRITE, and it looks like the
  game because it is editing the game's own four screens.** `compendium/planner/` rebuilds
  the client's right-hand panel — inventory, spells, skills, stats, same order, same stat
  bars, same stack counts in the corner of each cell — and everything in it is editable.
  It deliberately ignores the site's light/dark theme: the point is that it looks like the
  thing next to it on the desktop.

  `node tools/m59-planner-data.mjs` writes `compendium/data/planner.json`, which is what it
  reads: 22 skills with their requisite stat and level, 150 spells with school and level,
  202 items with weight, value and sprite, and the constants `PlayerCanLearn` runs on.

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

## Working in this repository

- Every tool in `tools/` is standalone `.mjs`, zero dependencies, run with
  `node tools/<name>.mjs`. Only the chat responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree. The compendium's citations
  and the Python analysis scripts both read it.
- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (116),
  `node tools/m59-chat-test.mjs` (128) and
  `node tools/m59-rest-test.mjs` (38) and
  `node tools/m59-ledger-test.mjs` (25) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (383) and
  `node tools/m59-commitment-test.mjs` (49) and
  `node tools/m59-deaths-test.mjs` (82) and
  `node tools/m59-stream-test.mjs` (54) and
  `node tools/m59-ability-test.mjs` (44) and
  `node tools/m59-compendium-test.mjs` (42) and
  `node tools/m59-prey-test.mjs` (56) and
  `node tools/m59-spellaudit-test.mjs` (28) and
  `node tools/m59-localclient-test.mjs` (55) and
  `node tools/m59-bank-test.mjs` (52) and
  `node tools/m59-describe-test.mjs` (52) and
  `node tools/m59-party-test.mjs` (57) and
  `node tools/m59-hits-test.mjs` (41) and
  `node tools/m59-loadout-test.mjs` (126 — the loadout format, the learning arithmetic, the
  composed sell decision, and the fleet-wide gear write, against scratch directories; it sets
  `M59_LOADOUT_DIR` so it never reads the real one, which a live keeper is reading every
  pass) and
  `node tools/m59-economy-test.mjs` (61 — the Economy and Skills boards, and the one
  tab bar all five boards share) and
  `node tools/m59-backup-test.mjs` (42 — backing the rosters up and putting them back,
  against scratch directories; never touches a real fleet) and
  `node tools/m59-merchants-test.mjs` (77, dropping to 43 without `M59_ROOT`) and
  `node tools/m59-roo-test.mjs` (57, of which 9 skip without a copy of the game's
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

  Worth the trouble for what they carry: `troop.kod` creates a `Mace` or `ShortSword`, a
  `LeatherArmor`, `ChainArmor` or `ScaleArmor`, and a shield on every soldier, and drops
  them on death. Leather costs 480 to 1800 at a smith and this fleet has repeatedly been
  unable to afford it. `wear_best` will refuse the chain and scale — negative defence here,
  see ARMOUR in m59-skills.mjs — so only the leather and shields are worth collecting.

  They are barely more dangerous than the current prey: level 50, difficulty 2, so
  `3*viLevel + 60*viDifficulty` is 270 against a fungus beast's 210. The necromancer troop
  is the exception at level 60, difficulty 4 -> 420.

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

- **Heavy armour is worse here.** Each piece carries `viDefense_base` (how often you
  are hit) and `viDamage_base` (a flat absorb). They pull opposite ways: leather is
  +50/0, plate is -200/6 with a -30 spell modifier. On a scale where a monster's whole
  attack rating is ~210, -200 is enormous — and a character fighting from a safe spot
  intends to be hit zero times, which absorption does nothing about. `wear_best` ranks
  on that, so it buys leather over plate deliberately. See `ARMOUR` in `m59-skills.mjs`.
- The compendium's sprites are not committed. `python tools/pull-client-assets.py`
  decodes them from a local client. Do not commit `compendium/assets/img/`.
- Do not commit anything a running fleet writes — `fleet-state.json`,
  `history/`, `recordings/`, `commissions/`. The `.gitignore` already covers
  them; do not add exceptions.
