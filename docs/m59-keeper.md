# The keeper: what it can see, and what it cannot

Split out of [`CLAUDE.md`](../CLAUDE.md). Postmortems, the watchdog, the yield check, and the counters that are not rates.

## What a death record can and cannot say

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

## The watchdog, and the counters that are not rates

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

## Being spoken for, and earning nothing

- **A CHARACTER CAN BE SPOKEN FOR, AND THE BOARD HAS TO SAY SO.** A loot run, a
  provisioning cast, a signet errand and a pairing all have another end, and pulling a
  character out of one abandons that end silently. `m59-commitment.mjs` is the single
  rule for what counts; the keeper publishes it as `committed` on its status and on the
  fleet row, and `m59-tui.mjs` greys those rows and steps over them, with `X` to override
  and take one back. Add a new errand kind and it shows up on the board that day — an
  unrecognised kind is reported as itself rather than dropped, which is what stops a new
  operation being invisible to the one thing meant to protect it.

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

