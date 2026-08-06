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
- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (93),
  `node tools/m59-chat-test.mjs` (128) and
  `node tools/m59-rest-test.mjs` (38) and
  `node tools/m59-ledger-test.mjs` (25) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (351) and
  `node tools/m59-commitment-test.mjs` (49) and
  `node tools/m59-deaths-test.mjs` (70) and
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
  `node tools/m59-roo-test.mjs` (42, of which 9 skip without a copy of the game's
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
