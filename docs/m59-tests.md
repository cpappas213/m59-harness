# The offline test suites, and what each one pins

Split out of [`CLAUDE.md`](../CLAUDE.md). All of these are safe to run any time; they open no socket and touch no roster.

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
  `node tools/m59-travelguard-test.mjs` (29 — **one character has one body**: that a second
  travel call is REFUSED while the first is in flight, and that both arms of the tool claim
  the same slot. `background: true` took a job slot and the foreground arm did not, so two
  travel calls on one character both ran — measured on arena as two journey ids walking one
  character to one destination at identical timestamps, each replanning against the other's
  steps. It is reached by the ordinary path: a travel runs for minutes, longer than a default
  HTTP client timeout, so a caller that gives up and retries starts a second one. Half the
  suite is STRUCTURAL — that the walk is spelled exactly once — because the mechanism was
  never broken and `startJob`'s own assertions pass on the buggy code; set
  `M59_BROKER_SRC` at a copy with the old path and exactly those two go red) and
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
  home. See [`m59-economy.md`](m59-economy.md) on a trip that cannot fix the thing that
  opened it) and
  `node tools/m59-tuning-test.mjs` (43 — **the contract test for a config surface built to be
  edited in a hurry**: that an absent, empty or unparseable tuning file all mean the profile
  rather than an empty policy, that `flee_below: 60` (somebody typing a percentage) is refused
  rather than applied as 6000%, that a typo'd key is reported while the good key beside it
  still applies, that a character line beats a profile line beats a default and the plan says
  WHICH won, and that a refused `--set` leaves the file exactly as it was) and
  `node tools/m59-profiles-test.mjs` (87 — **the contract test for a posture whose whole
  value is in what it REFUSES**: that the town is a curated room set rather than a name
  match (the Deep Dark Woods *of Tos* is wilderness; Familiars and The Crypt are indoors
  and say neither), that a farm room outside the walls and a character standing outside
  them are both refused rather than quietly walked, that an unknown current room is the one
  thing allowed to be a note instead, and above all that every one of the thirteen policy
  fields which can walk a character out of a room is still suppressed — a list that grew
  one death at a time and passes cleanly if somebody adds a fourteenth) and
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
  `node tools/m59-routing-test.mjs` (38 — **the contract test for planning on the map the
  mover enforces**: that `moverStepLands` and not `stepAllowedByCollision` is the question
  that decides anything, that the quantizer has one answer for the planning half and the
  sending half, that a mask round-trips bit for bit and one of the wrong size is refused
  rather than mis-indexed, that with no mask the router plans exactly as it did before any
  of this existed, that a refusal removes an EDGE and not a SQUARE, that the tiny pockets
  against the walls are kept because they are the safe-spot signal, and that an exit a bake
  cannot reach is still OFFERED — a bake must never be the reason a doorway disappears, and
  that the clearance preference routes further from the walls while never removing a route) and
  `node tools/m59-impossible-test.mjs` (126 — **the polarity the 153 collision assertions do
  not cover**: every one of those asserts a legitimate move REMAINS USABLE, so that suite
  passes cleanly on the day the walls stop working. This one asserts refusals, by checked-in
  fine traces that each name the wall index that refused them, with controls in the same
  rooms out of the same bake — because a suite that only asserts refusals passes perfectly
  when everything is refused, which is the fleet standing still. Observation cannot be the
  oracle: another client's view of a player phasing through a wall is lag compensation) and
  `node tools/m59-safewall-test.mjs` (15 — **the mechanism, on real geometry, against
  squares characters actually held**. The other 141 safe-spot assertions are about the
  BOOK-KEEPING and the mechanism itself is tested only on synthetic grids, so nothing
  asserted that what the fleet stands on in the real world is a safe wall. It reads the
  book and the baked map: every held square is still nominated, a held square offers
  materially more unanswerable shots and more wall at its back than ordinary floor in the
  SAME room (3.24 vs 1.49 and 3.46 vs 0.85 across 37 rooms), and the chooser still lands on
  one. Its last section is the guard against the routing preference leaking back into the
  tactical questions and teaching the fleet off the walls — flip `path`'s clearance default
  back on and it goes red on 302 of 395 walks) and
  `node tools/m59-breadcrumb-test.mjs` (32 — **the contract test for getting out of a safe
  spot**: that a crumb is recorded at the one choke point every move passes through, that a
  retreat cannot invent an impossible traversal because every step goes back through the
  fine validator, that a broken trail is dropped whole rather than skipped, that it stops
  the moment the route reappears, and that a genuine dead end still reports itself) and
  `node tools/m59-roo-test.mjs` (74, with raw-room checks skipping without a copy of the game's
  `resource/rooms`). The rest need a live server —
  `m59-autopilot-test`, `m59-skills-test` and `m59-coop-test` all want a broker on
  8899 and fail with `ECONNREFUSED` without one, which is not a regression.
