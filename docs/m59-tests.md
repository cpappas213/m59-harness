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
  `node tools/m59-playdead-test.mjs` (23 — **the turn that makes a safe spot worth having**:
  playing dead buys safety by not acting, and the same flag that keeps the monsters off keeps
  HealthTimer off with it, so a freeze recovers vigor and NEVER health. Out in the open that is
  the whole trade. On a safe spot it is not: nothing can reach the square, so a TURN sets
  PFLAG_MOVED_SINCE_ENTRY and gives up no ground, and being unreachable AND healing is
  available there and nowhere else. So this pins that the reconnect actually TURNS — a
  reconnect is a fresh entry and the flag comes back clear — that it does not round-trip
  room-contents to verify a packet carrying no coordinates, that a second freeze from an armed
  spot is REFUSED because it would clear the flag the first one was reclaimed to set, and that
  coming back somewhere else gives up the hold rather than turning for nothing. The failure it
  guards is invisible from outside: the wall holds, nothing reaches us, and the health sits at
  four for ever) and
  `node tools/m59-follow-test.mjs` (26 — **leading the fleet by walking in front of it, and
  the one line that must not move**: say "follow me" while piloting one of your own and every
  fleet member in the room walks the squares you stood on. ONLY OUR OWN PEOPLE MAY GIVE THAT
  ORDER — `prod` is a shared server and this moves twenty bodies at once, so the speaker is
  checked against the ROSTER rather than against the text, a stranger who knows one of our
  names is still ignored, and a character will not take the order from itself. The rest is
  trail discipline: the queue is consumed from the OLDEST end, because walking AT a leader is
  a beeline and a beeline is exactly what fails in the rooms this exists for; passing near a
  crumb counts as reaching it, since insisting on the exact square is how a follower stalls on
  geometry the leader crossed at a different angle; and the last order in a batch wins, so
  "follow me" then "stop" means stop) and
  `node tools/m59-commute-test.mjs` (31 — **one rule, and every bug this driver had was a
  violation of it**: do not send a command to a character that is busy. `travel` supersedes
  whatever movement is in flight and the ledger calls that `movement cancelled by a newer
  command`; measured across three windows the commute driver was the LARGEST single cause of
  travel failure in the fleet — 54 of 183, then 18 of 34, then 33 of 56 — and what it
  cancelled were a character resting at a safe wall, one resting to full before setting out,
  and one still finishing the journey that had just delivered it. None of those three reads
  as "travelling", which is why `committed` is the authority and the activity string only a
  second opinion. Moving the busy check back after the arrival branch fails three of these) and
  `node tools/m59-blink-test.mjs` (18 — **a portal every room has, and the one way it must
  not be used**: that a kod file naming two rooms is REFUSED rather than guessed at, because a
  blink point on the wrong room would claim exits a character cannot reach; and that blink
  reachability never answers the walking question. `anchorReach` is what `transitOk` refuses
  a hop over and it still says no where walking says no; `anchorReachVia` returns the WORD
  'blink' instead, because casting costs mana, may need a rest to afford, and can fail — a
  caller handed a boolean would plan a route needing a spell and report it as a walk. Also
  that a room with no blink point recorded loses nothing, since most of the map has none) and
  `node tools/m59-tracks-test.mjs` (28 — **the monorail, which nothing tested until it was
  already wrong**: that RIDABILITY OUTRANKS TIME, in both arrival orders, because a crossing
  whose legs the mover refuses is not a quick one — it is `walkFine` groping between
  waypoints, which is the behaviour a track exists to replace — and that among equally
  ridable crossings the quicker still wins; that an unridable track is still KEPT when there
  is nothing better, and records how many of its legs cannot be sent, because a book with a
  hole beats no book; that a caller with no map gets a track marked unstraightened rather
  than one marked broken, since an unmeasurable leg is not a refused one; and that a
  struck-out track is refused while one strike short is still ridden. Ranking on time alone
  is defensible, was the rule for as long as the file existed, and left 578 The Cragged
  Mountains 31% ridable — nothing noticed, because a track that cannot be sent still looks
  exactly like a track) and
  `node tools/m59-travel-test.mjs` (24 — **one call is the whole journey**: that a refused
  doorway and an off-grid instant are re-settled and retried rather than returned, that a
  stumble is not a hop so re-settling cannot eat the room budget, that patience is bounded
  and the reason survives to the caller, that a journey whose last hop is also its last
  permitted hop reports arrival rather than "gave up", and that a cancelled movement still
  wins. It lifts the real method out of `m59-broker.mjs` by brace-matching rather than
  reimplementing it, because that file cannot be imported without taking the fleet lock) and
  `node tools/m59-travelguard-test.mjs` (32 — **one character has one body**: that a second
  travel call is REFUSED while the first is in flight, and that both arms of the tool claim
  the same slot. `background: true` took a job slot and the foreground arm did not, so two
  travel calls on one character both ran — measured on arena as two journey ids walking one
  character to one destination at identical timestamps, each replanning against the other's
  steps. It is reached by the ordinary path: a travel runs for minutes, longer than a default
  HTTP client timeout, so a caller that gives up and retries starts a second one. Half the
  suite is STRUCTURAL — that the walk is spelled exactly once — because the mechanism was
  never broken and `startJob`'s own assertions pass on the buggy code; set
  `M59_BROKER_SRC` at a copy with the old path and exactly those two go red) and
  `node tools/m59-escapable-test.mjs` (4 — **from anywhere you can get to, you can get out**.
  This was FIRST WRITTEN AS A STEP-SYMMETRY TEST and was wrong: a step you can take is not a
  step you can take back, because you drop down a cliff in the Cragged Mountains and cannot
  climb it again, and `moverStepLands` models that deliberately. It reported 8% of that room
  as a defect; the 8% was the mountains. The true property is weaker — a cliff bottom is fine,
  you walk away along the bottom — so it floods FORWARD from every boundary square for what a
  body can arrive at, BACKWARD for what can still reach one, and the difference is the traps.
  Measured 2026-08-23: **1 in the Twisted Wood, 10 in the Cragged Mountains, 0 in the other
  two** — eleven squares, not thousands. A ratchet rather than a standard, so a mover change
  that starts manufacturing traps is visible and a fix shows as a number falling. Skips
  cleanly with no .roo files) and
  `node tools/m59-sincefull-test.mjs` (24 — **what the body did since it was last
  whole, and whether the moving went anywhere**. Health falling is in every reading here;
  none of them could say what the character was DOING about it, and on a journey under
  attack the job is exactly two things — keep going forward, or get to a wall. Both are
  movement, and movement is all a stillness detector can see. So the number is PATH against
  NET: ten squares walked ending ten away scores 1.0, and the 22<->23 oscillation walks the
  SAME TEN SQUARES and scores 0. One assertion exists only to say that out loud — the two
  are indistinguishable by distance walked and separated only by the ratio. Also pins that a
  room change is not counted as fifty squares of sprinting when the coordinate system starts
  again, that reaching shelter reports the seconds it took rather than a zero, that a second
  wall does not restart that clock, and that the window is measured between OBSERVATIONS
  rather than against the wall clock — which was a real bug in the first draft and would
  have reported every bleed slowing down at the moment the keeper stopped being able to see
  one) and
  `node tools/m59-travelling-test.mjs` (64 — **a journey steers a character; it does not
  switch off its will to live**. Every assertion is one line of Cccc's death record of
  2026-08-21: a commute driver saw him "stuck in room 1" — which is the UNDERWORLD — and
  re-sent a `travel`; `travelJob` called `goInert`, which switches the survival ladder off
  for the length of the walk; the keeper walked him out of the Underworld into an inn at 11
  of 37 and the journey walked him straight back out; six things ate him over twenty-two
  seconds at 27% health against a 70% flee threshold. The old rescue could not fire because
  it ALSO demanded four seconds of stillness, and his last pulses read 23,3 / 25,5 / 26,5 /
  25,5 — a two-square shuffle that reset that timer on every sample. So this pins two
  things: that a journey takes `goTravelling` and an errand still takes `goInert`, and that
  none of the four mid-hop triggers asks whether the body is moving. The `flee` pair needs a
  character below the flee line and NOT inside two hits of death — 41 of 60, in the
  one-point gap between 40 and 42 — because Cccc at 10 of 37 was below both and is taken
  back whichever switch you throw, which is right for him and proves nothing about the
  switch. Half of it is STRUCTURAL for the same reason `m59-travelguard-test` is: the gate
  in `passUnderworld` is what routes a travelling keeper into the restricted ladder, and if
  it comes out every behavioural assertion above it still passes) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (383) and
  `node tools/m59-playbook-test.mjs` (37 — the three moments, the closed verb set, and
  the two rules that fail in the dangerous direction if inverted: silence means carry on,
  and an unknown condition never holds) and
  `node tools/m59-commitment-test.mjs` (71 — what counts as being spoken for, and the
  distinction between a bot OWNING a character and being mid-operation on it) and
  `node tools/m59-which-test.mjs` (16 — **the gate every `/m59*` command runs first, and the
  one tool that may never name the wrong fleet**. It builds a throwaway checkout in TEMP and
  runs the real `m59-which.mjs` against fake brokers, so it opens sockets only to itself and
  cannot see this machine's rosters. Two defects lived in one line — `live.find(x =>
  x.health.fleet === label) ?? live[0]` — and each fails in a different direction. The
  fallback meant that when OUR broker was slow to answer, an UNRELATED one was picked up and
  reported as the answer: measured here, prod's `/health` takes 1046ms idle and 2573ms under
  load, because it is the busy one and that is exactly what makes it the one that matters,
  while an idle broker on another port answers in 4ms — so a missed probe printed `MISMATCH:
  the broker is holding "shadow"`, naming 21 entirely different characters, about one run in
  four. The `find` matched on the fleet LABEL, which CLAUDE.md says outright is not an
  identity, and THAT one fails to an all-clear: run against the old code, a second checkout's
  broker calling its fleet "prod" while serving a different roster returns **exit 0**. So this
  pins that a broker is ours only when its `/health` state path resolves to our roster file,
  that an unreachable port is INDETERMINATE and never a statement about a fleet, that a
  disagreement between the socket and the records on disk is refused as the shape of a second
  broker on one fleet, that a lock whose live pid started long after the lock was written is a
  recycled pid rather than a holder — the process start time is 1ms from the pid file's own
  timestamp, because `m59-service.mjs` writes it as it spawns — and that nothing listening
  anywhere is still exit 0, or `./m59.sh up` could never start a fleet) and
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
  `node tools/m59-economy-test.mjs` (73 — the Economy and Skills boards, the one
  tab bar all six boards share, and the pack drill-in: that it names what is in the pack
  rather than only how full it is, and that an EMPTY pack, a character the broker is not
  holding, and a broker too old to report the list are three different sentences) and
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
  `node tools/m59-city-matrix-test.mjs` (110 — the loopback/DM safety boundary, exact
  25-pair parallel schedule, 150-leg serial schedule, exact staging square, authoritative
  in-process broker/DM identity, fresh trace lifecycle, protected report paths, and
  clean-prefix resume contract. **Opens no socket and touches no roster**) and
  `node tools/m59-collision-trace-verify-test.mjs` (44 — an entirely synthetic matrix,
  JSONL capture, map and BSP pin the offline proof: nested runner reports, stable room
  identity across object-id renumbering and reuse, exact off-map exits, collision replay,
  complete sequence evidence, trace loss, callsite and pair coverage, broker-observed
  fallback and single-writer policy, repo-rooted paths, and atomic private verdict output)
  and
  `node tools/m59-collision-trace-test.mjs` (49 — tracing is off by default, failed writes
  recover in order with durable loss markers, the physical cap survives restart, trace
  files are private, every actual send has a validated or explicitly unsafe wire row, and
  broker health publishes the effective trace and exit-fallback settings) and
  `node tools/m59-collision-test.mjs` (191 — **the fail-closed contract for all
  movement**: compact collision metadata survives a bake, legacy maps cannot authorize
  a coordinate packet, the player cylinder catches wall bodies and corners, long strides
  cannot tunnel, stock endpoint-0 slope and water-depth rules are preserved, every
  emitted packet is revalidated, and the documented Brownestone, Limping Toad, Icky,
  Farol, Ukgoth, Cor Noth, Temple, and Fey precision cases remain usable) and
  `node tools/m59-routing-test.mjs` (90 — **the contract test for planning on the map the
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
  `node tools/m59-breadcrumb-test.mjs` (51 — **the contract test for getting out of a safe
  spot**: that a crumb is recorded at the one choke point every move passes through, that a
  retreat cannot invent an impossible traversal because every step goes back through the
  fine validator, that a broken trail is dropped whole rather than skipped, that it stops
  the moment the route reappears, and that a genuine dead end still reports itself.
  **Its last section lifts `selfOrResync` and `refreshRoomIdentity` out of the broker source
  and RUNS them**, which is the only way this class of fault is visible: both sent an
  identifier that is bound nowhere in that file, so both threw ReferenceError the moment
  they were reached — and both are recovery paths, so they could only fail once something
  else had already gone wrong. Every other assertion here about losing our own position
  drives the FIXTURE's stub of that method, and passed perfectly throughout) and
  `node tools/m59-pulse-test.mjs` (47 — **is the character moving, asked of the character**.
  Every other stall number measures the KEEPER. Most of the file is the exclusions, because
  a detector that shouts when somebody sits down gets switched off before the day it was
  needed: resting, fighting, trading, waiting and holding a safe wall are all silent, and a
  wall held for a full minute raises nothing. Its newest section is the one exclusion that
  was WRONG — `inert` meant an errand or a bot owned the character, and the pulse stood down
  for it, so two characters bled out stationary in The Flatlands with `wedges: 0` and
  `stood_down_for: "travelling to The Streets of Tos"` in both post-mortems. Inert now
  excuses standing still and not standing still while losing health, with steady health,
  healing, and genuinely leaving the neighbourhood all still silent. Two assertions in that
  section exist because the first implementation was useless and only the counters said so:
  a wedge must survive a painless second, since damage and the pulse both land about once a
  second and the excused branch clears the episode; and the body test must see a character
  ALTERNATING between two squares, which the exact-square comparison reads as movement. Its
  two newest assertions guard a ring that now serves TWO questions on two widths: the ring
  was widened to six samples so `damageRate` could read half a point a second off five
  seconds of it, and `pennedIn` kept the newest three — because that test gets STRICTER as
  the ring grows, so widening it too would have switched off the handbrake it feeds while
  every assertion here stayed green. Both constants are read out of the source rather than
  copied, and the pattern that reads them uses `[0-9]` rather than an escape because it
  lives in a template literal, which eats the backslash before RegExp sees it) and
  `node tools/m59-roo-test.mjs` (74, with raw-room checks skipping without a copy of the game's
  `resource/rooms`). The rest need a live server —
  `m59-autopilot-test`, `m59-skills-test` and `m59-coop-test` all want a broker on
  8899 and fail with `ECONNREFUSED` without one, which is not a regression.
