# Handoff: the GOAP keeper rebuild

You are picking up a rebuild of this repository's decision-making layer. This
document is written for a version of you with **no memory of the work**. Read it
before touching `tools/m59-act/`, `m59-worldstate.mjs`, `m59-plan.mjs` or
`m59-goap-planner.mjs`.

Read `docs/keeper-rebuild-plan.md` next — it is the plan; this is the orientation.

**If you change the shape of this work, update or delete this file.** Its
predecessor (`docs/bt-goap-handoff.md`) survived long enough to describe an
orphaned module with a live bug as "the path forward", and was deleted for it.

---

## 1. What is being built, in one paragraph

`tools/m59-autopilot.mjs` is a ~13,000-line keeper: one sequential ladder of
if/return decisions driving a character. The rebuild replaces the ladder with a
**GOAP planner over small honest atomics**. The planner searches over actions
declared with preconditions and effects, in a **closed vocabulary of world-state
symbols**, and replans continuously. The old ladder still runs the fleet; nothing
here has replaced it yet.

---

## 2. The one rule that must not be broken

**Survival lives in PRECONDITIONS. Never in goals, never in costs.**

The two natural ways to put survival in a planner are both wrong:

- *as a goal* — `stay_alive` at top priority means the planner never hunts; ranked,
  it can lose.
- *as a cost* — danger adds +1000, and **a cost can be outbid**. A large enough
  reward beats it, and you find out which fights were worth dying for from the
  death log.

Every survival rule this repository has paid for is a **refusal**:
`threatCeiling()` returns null on unknown max health and *every caller reads null
as refuse*; `leaveHold` refuses a discretionary departure below the rest
threshold; selling is an allowlist rather than a check.

A precondition is a refusal with a planner's face on:

```javascript
attack.pre = ['armed', 'has_target', 'in_reach', 'target_in_band'];
```

`target_in_band` there means the planner **cannot generate** a plan that swings at
a faction soldier. Not discouraged — impossible, because no valid plan exists.
`m59-plan-test.mjs` and `m59-cost-test.mjs` both pin this; if you ever find
yourself adding a danger weight to make a plan come out right, stop.

`m59-cost.mjs` has `suspiciousCosts()`, which flags any action priced near 100s as
"a refusal wearing a number" and tells you to put it in `pre`.

---

## 3. The map

| file | what it is |
|---|---|
| `tools/m59-act/*.mjs` | the atomics: `attack`, `step`, `equip`, `rest`/`stand`, `cast`, `eat` |
| `tools/m59-act-test.mjs` | **the conformance sweep** — runs over every file in `m59-act/` |
| `tools/m59-worldstate.mjs` | the ACT vocabulary (live client, ~1s clock), 14 symbols |
| `tools/m59-errandstate.mjs` | the ERRAND vocabulary (fleet rows over MCP, minutes), 8 symbols |
| `tools/m59-plan.mjs` | the join: builds the action set, validates it, plans, steps it |
| `tools/m59-goap-planner.mjs` | A\* over pre/effects (salvaged from the abandoned fork) |
| `tools/m59-cost.mjs` | costs in expected seconds |
| `tools/m59-fake-client.mjs` | **one** client-shaped fake for every offline test |
| `tools/m59-bt-delegation-test.mjs` | ratchet: how often new code calls back into the monolith |
| `tools/m59-atomics.mjs` | the 14 coarse MCP errand verbs (**not yet given pre/effects**) |

Everything runs offline. No broker, no server, no fleet:

```bash
node tools/m59-act-test.mjs          # 142
node tools/m59-plan-test.mjs         #  25
node tools/m59-cost-test.mjs         #  23
node tools/m59-worldstate-test.mjs   # 107
node tools/m59-errandstate-test.mjs  #  37
node tools/m59-fake-client-test.mjs  #  51
node tools/m59-bt-delegation-test.mjs
```

---

## 4. The atomic contract

Four rules, **enforced mechanically** by `m59-act-test.mjs` over every file in
`m59-act/`. Each exists because of a failure already paid for here:

1. **Takes `(client, session)`, never the keeper.** Checked in the source, since a
   signature cannot say it. The previous attempt's modules took a keeper and called
   71 of its methods; 25 existed on one fork only, so they could not be carried to
   another trunk at all. An atomic over the client is portable because
   `m59-client.mjs` is identical everywhere.
2. **Declares `pre`/`effects` from the closed vocabulary.**
3. **No loop around an await.** 82% of deaths had the keeper blind, worst case 909
   seconds inside one call. Looping belongs to the caller so it can be interrupted.
4. **Refuses by returning, never by throwing.** A refusal that throws must be caught
   by every caller, and the ones that forget read it as success — which is how "no
   error" came to mean "the merchant sold it", when a refusal here is a sentence
   spoken to the room and never an error on the wire.

Verified to bite: plant an atomic violating all four and the sweep fails all four
independently.

---

## 5. Traps specific to THIS work

**THE FAKE IS THE MOST DANGEROUS FILE.** Three bugs so far were fixture bugs, not
logic bugs, and each passed its own suite:

- `client.equipment()` is a *method returning `{known, equipped[]}`*, not a Map.
  Two modules read it as a Map with `.keys()`, got an empty set unconditionally, and
  therefore reported every character as wearing nothing — forever.
- `client.armed()` **has never existed**. Two call sites asked for it; both answered
  false for every character, and one gated a branch that has never executed.
- A real spell entry carries **`nameRsc`, not `name`**. The fake supplied `name`, so
  the live resolution path never ran once.

`m59-fake-client-test.mjs` now compares the fake against `M59Client` itself and
asserts that the invented methods are absent from **both**. When you add an atomic
that calls a new client method, **add it to that list** or you are back here.

**TWO VOCABULARIES, AND NO NAME MAY BE SHARED.** `m59-worldstate` reads a live
client (pushed, true now); `m59-errandstate` reads a `fleet` row (minutes old).
Sharing a name lets a plan chain a one-second fact to a five-minute-old one
silently. A test pins that the two name sets are disjoint. This repository already
paid for that once: `ms_since_moved` measures the KEEPER, was read as the
CHARACTER, invented a stall that was not there, and got two correct behaviours
reverted.

**UNKNOWN FAILS SAFE, AND SAFE IS PER SYMBOL.** `armed` unknown reads **true** (a
timed-out inventory read must not idle the fleet mid-fight). `target_in_band`
unknown reads **false** (a ceiling that defaults open kills somebody). They are
deliberately opposite and a test pins that. If a refactor ever makes them agree,
one of them is wrong and it is not obvious which.

**THE GRID IS FOR PLANNING, NOT FOR STEPPING.** Upstream measured 218 of 311
centre-to-centre grid steps failing in room 587, and **92% of the failures did not
move the character at all** — so a caller replans from an unchanged position and
asks for the same refused step for ever. `m59-act/step` therefore requires
`session.step` (the broker's fine-coordinate mover) and refuses without it.

**DO NOT ADD AN OPTION THE MOVER DROPS.** `step` used to take a `speed` and gate it
on vigor. The broker's mover is `step(col, row, { confirm, beforeMutation })` and
takes no speed, so the argument was silently discarded and the guard could never
fire. A lever connected to nothing is worse than no lever.

---

## 6. State: what works, what is unproven

**Working, offline.** The supply chain plans and is derived rather than written
down:

```
goal { vigor_ok: true }  ->  cast create food  ->  eat        (~1.95s)
```

And the refusals, which matter more:

| | |
|---|---|
| never learned the spell | **no plan** — the action does not exist |
| 94 herbs + 1 elderberry | **no plan** — `min(pair)`, never the sum |
| no mana | **no plan** |
| target above the ceiling | **no plan at any price** |

**NOTHING HAS EVER BEEN TESTED AGAINST A LIVE SERVER.** Not one packet. Every
assertion is against the fake. Specifically unverified:

- every `waitMs` is a guess
- whether `create food` produces something matching `FOOD_RE` (an invented regex)
- whether a use list arrives inside `equip`'s window
- whether `apply(food, selfId)` is actually how eating works
- whether the plan feeds a character at all

Treat "the design is coherent" and "the design works" as different claims. Only the
first is currently supported.

---

## 7. Environment, and one thing to be careful about

**There are two fleets and the default is remote.**

```
local      4 slots   127.0.0.1:5959       <- Docker, this machine
default    5 slots   76.214.42.186:5959   <- SOMEBODY ELSE'S MACHINE, and it is
                                             what every tool picks with no --fleet
```

Controlled experiments belong on `--fleet local`. On the remote one the fleet is
being driven, so the subject walks away mid-experiment — five shop candidates in a
row were walked out before a second purchase could be measured. `node
tools/m59-which.mjs` before anything, and it exits non-zero on a mismatch.

The broker is currently **stopped**. `node tools/m59-service.mjs start --fleet local`.

**Before anything risky:** `node tools/m59-backup.mjs --credentials-only`. The
rosters are the only record of the account passwords — no reset, no email, no way
to ask the server.

---

## 8. Next steps, in order

1. **The live pass.** One character on `--fleet local`: `planFor(client, {vigor_ok:
   true})`, `stepPlan` twice, then compare vigor/pack/purse against what the atomics
   *claimed* happened. This is the highest-value thing available and the only way to
   move from claim (6) to fact.
2. **Give `m59-atomics.mjs` real `pre`/`effects`** from `m59-errandstate`. Its 14
   verbs currently declare `effect` as prose (`'room=to, health readable'`), so the
   coarse layer cannot be planned over at all. This is what makes the two-library
   claim true rather than asserted.
3. **More atomics** — `pick_up`, `drop`, `buy`, `sell`, `deposit`, `withdraw` — each
   through the same sweep.
4. **Wire a planner-driven character behind a per-character opt-in**, directional
   errands first, where being wrong costs a wasted trip rather than a character.

---

## 9. Working agreements that have held up

- **Keep the shared-file footprint to one commit.** Everything else is new files,
  so an upstream push can only ever collide in one place. A 21-commit upstream
  movement branch merged into 46 files with zero conflicts because of this.
- **Any step that does not leave `m59-autopilot.mjs` shorter is not migration**, it
  is a parallel implementation. That is how the last attempt added 1,450 lines to
  the monolith while "decomposing" it.
- **The ledger is the referee** for anything live: kills/minute from `countKills`,
  never a keeper's own tally, which is emptied in the constructor while keepers
  restart about once a minute.
