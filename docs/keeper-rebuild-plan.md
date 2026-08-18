# Rebuilding the keeper: GOAP over honest atomics

A plan to replace `m59-autopilot.mjs` as the decision-maker, in a way that can be
verified at every step and abandoned at any step without losing a fleet.

**Decision, 2026-08-17: GOAP plans everything, and survival lives in
PRECONDITIONS — never in goals, never in costs.** An earlier revision of this
document split the work between a reactive ladder at one second and a planner
above it. That was two decision systems for one question, which is the shape this
repository keeps paying for. §2 is the argument and the invariant; it is the part
to read before changing anything else.

---

## 0. Where we are

**On `trunk-upstream`, based on `upstream/main`.** The fork was abandoned as a
trunk on 2026-08-17: it and upstream had run apart for three days and collided in
102 conflict hunks over twelve files, and the loadout conflict was both sides
having independently built the same feature. Upstream is the healthier line — its
tree passes `travel`, `routing`, `collision` and `testbed`, all of which fail on
the fork; it has routing work this plan originally proposed writing from scratch;
and its BT surface delegates back to the keeper 4 times against the fork's 141.

The fork's work is preserved at tag `fork-before-upstream-trunk`, on branches
`bt-extraction` and `reconcile-upstream`, and in
`/Users/costas/workspace/m59-fork-reference/`.

**Why the fork could not simply be merged forward, which is also the lesson this
plan is built on.** Of the 71 legacy methods the fork's BT modules called, 49
existed upstream and 25 did not — 17 of them `_bt*` shims written to feed the
trees. The modules were welded to one fork's private surface and could not run
anywhere else. Had they composed atomics over the client, they would have dropped
onto this trunk unchanged, because `m59-client.mjs` is identical on both sides.
**The wrapper debt and the fork were the same bill.**

Done so far on this trunk:

| | |
|---|---|
| `skills.isArmed(client)` | `Autopilot.armed()` extracted verbatim — a move, not a fix |
| `m59-fake-client` + test | 45 assertions; one client-shaped fake, compared against `M59Client` itself |
| `m59-bt-delegation-test` | the delegation ratchet + orphan report; baseline 4 |
| `m59-worldstate` + test | 97 assertions; the closed vocabulary |
| `m59-act/attack` + `m59-act-test` | 29 assertions; the first atomic and the conformance sweep |

Still true of the trunk, and not yet addressed:

- **`m59-bt-nodes.mjs:100` guards `wielding_weapon` on `client.armed()`**, and a
  client has never had one — so that condition answers false for every character.
  `m59-autopilot.mjs`'s `useBT` branch is guarded on
  `typeof c.armed === 'function'` and has therefore **never executed**. Left dead
  deliberately: activating it is a decision to take against one character and
  watch, not a side effect of a refactor.

---

## 1. The facts that must survive

**The structure is disposable. These are not.** Every one was paid for in dead
characters or in hours of debugging, and a rebuild that does not carry them
forward will re-earn them. Port each with its citation.

### Space and reach
- **Melee reach is a disc of radius 2–3 on SQUARE coordinates.** Both sides run
  `SquaredDistanceTo <= GetAttackRange^2` (`nomoveon.kod:121`,
  `monster.kod:1682`, `weapon.kod:52`). Up to 28 squares can hit you, not 8.
- **Fine coordinates are read by nothing that matters.** `piFine_row`/`piFine_col`
  exist; the only consumer in the tree is `MonsterOrient`, choosing the angle a
  monster is *drawn* facing (`monster.kod:2189`). Sub-square positioning is inert.
- **The safe wall is an asymmetry in who checks line of sight.**
  `Monster.CanReach` calls `Room.LineOfSight` (`monster.kod:1782`);
  `Player.TargetWithinSightAndRange` (`player.kod:4115`) does not. That gap is
  `free_shots`. Only lich and revenant ignore walls (`AI_FIGHT_THROUGH_WALLS`).
- **EXITS ARE NOT 1:1.** Walking A→B does not put you where the return edge is.
  A route that worked outbound failing on the return leg is the NORMAL case, not
  a one-way door. Do not conclude "sealed area" from a failed return trip.

### Time and evidence
- **`SETTLE_GRACE_MS` is 250ms**, measured from the later of "stopped moving" and
  "claimed the square". A blow already in the air can land after we report
  standing on the spot, and a failure is **permanent** (`discredited()`), so one
  bad reading retires a good square forever. Discard, don't forgive.
- **`WATCH_MS` 8s** is "could the keeper have acted"; **`TRUST_MS` 30s** is "does
  this reading still place a death". Different questions, do not merge.
- **`ms_since_moved` measures the KEEPER, not the character.** It climbs while an
  errand walks the character perfectly well.
- **A counter on the keeper is not a rate** — keepers restart about once a minute.
  Kills come from the ledger (`countKills`), never from `tally.kills`.

### The server lies by omission
- **A merchant refusal is a sentence spoken to the room, never an error on the
  wire.** No error has never meant success. Measure the purse.
- **Object ids are not stable** — renumbered on every save, every 15 minutes.
  Resolve names in the same batch that uses them; never cache across a call.
- **A `send` reply names its receiver before its answer**, so a bare
  `/OBJECT (\d+)/` reads the wrong number.
- **Equipment is `plUsing`, not the inventory.** `client.equipment()` is the only
  authority. Wielding what you already wield is *refused*.
- **`BP_USERCOMMAND` arrives as well as departs.** A packet nobody parses is
  indistinguishable from a packet nobody sends — the trap behind both live bugs.

### Survival arithmetic
- **Level is not danger.** `GetAttackAbility = 3*viLevel + 60*viDifficulty`. A
  fungus beast (50/1) rates 210; a centipede (30/4) rates 390.
- **Hit chance is `offense * 55 / defence` bounded to [10,95]** (`battler.kod:331`).
  Against anything that pins us at 95, extra defence buys nothing and only
  absorption works.
- **Bare is worse than bad armour.** Expected damage/swing at this fleet's stats:
  bare 1.34, chain 1.18, leather 1.17, scale 0.71. Keep the floor.
- **Threat ceiling is a proportion and fails CLOSED.** Unknown max health returns
  null and every caller reads null as refuse. Default `{percent, 150}`.
- **Faction soldiers are level 70–145**, not 50. `SetEquipment` overwrites the
  declared numbers at creation (`troop.kod:215`). Never fightable by this fleet.
- **Vigor**: `REST_VIGOR_CAP` 80, `MIN_FIGHT_VIGOR` 100, `VIGOR_MAX` 200.
  Everything above 80 must be eaten. `create food` = 2 elderberry AND 2 herbs, so
  castings are `min(elder, herb)/2` — read the per-character minimum, never the sum.

### Doctrine
- **A planned trip accepts the risk of death; the way out is always through.**
  This is about *who may cancel* (survival only, never an errand), not about how
  many hops fit in one await. The two were tangled, which is why both previous
  "fixes" were reverted.
- **The four protected faculties** — identity, mortality, survival, recovery —
  decide at 1s and stay in this repository. A bot gets them only with roster
  consent (`PROTECTED_FACULTIES`, `may_yield`). `m59-unattended-test.mjs` is the
  guard and **should fail the day somebody moves a survival decision out**.
- **Selling is an allowlist, not a check.** Skivlat takes what you hand him and
  gives nothing back, and nothing on the wire distinguishes it from a sale.

---

## 2. Target architecture: GOAP for all

**One decision system, not two.** A reactive ladder beside a planner is two homes
for "what should this character do now", and a quantity with two homes in this
repository has always ended up with two answers — the engagement ceiling had four
copies, and the second answer to that one is a dead character.

So: GOAP plans everything, over atomics, replanning continuously. There is no
second ladder to disagree with it.

### THE INVARIANT: survival lives in PRECONDITIONS

**Never in goals. Never in costs. This is the rule the whole design rests on, and
it is the one that will be "optimised" away by somebody who sees a precondition
making plans fail and relaxes it into a weight.**

The two natural ways to put survival in a planner are both wrong:

- **As a goal** — `stay_alive` at highest priority. Then the planner is always
  planning to stay alive and never hunts; or it is ranked, and ranked means it can
  lose.
- **As a cost** — danger adds +1000. **A cost can be outbid.** A large enough
  reward beats it, and you learn which fights were worth dying for by reading the
  death log.

Every survival rule this repository has paid for is a **refusal**, not a
preference. `threatCeiling()` returns null on unknown max health and *every caller
reads null as refuse*. `leaveHold` refuses a discretionary departure below the
rest threshold. Selling is an allowlist rather than a check. None of those survive
translation into a weight.

A precondition is a refusal with a planner's face on:

```javascript
attack.pre = ['armed', 'has_target', 'in_reach', 'target_in_band'];
```

`target_in_band` as a precondition means the planner **cannot generate** a plan
that swings at a faction soldier. Not discouraged — impossible, because no valid
plan exists. That is strictly better than the four hand-written copies of the
ceiling it replaces, because a planner cannot forget to check one.

Combined with §3's per-symbol `whenUnknown`, a planner running on half-known state
— the normal case here, 82% of deaths had the keeper blind — plans conservatively
by construction rather than optimistically.

**Corollary, and it is an API boundary rather than a detail:** whoever supplies
goals must be unable to remove a precondition. A bot may say what to want; it may
not say what is safe. That is the same carve-out `PROTECTED_FACULTIES` and
`may_yield` already express, and `m59-unattended-test.mjs` is its guard.

### Two action sets, two granularities, both legitimate

Conflating these is what made the earlier design confusing.

| | granularity | examples | clock | driven from |
|---|---|---|---|---|
| **errands** | coarse MCP verbs | `travel_to`, `buy_item`, `pick_prey`, `ensure_funded` | minutes | outside, over MCP |
| **acts** | wire-level atomics | `attack`, `step`, `cast`, `rest`, `equip` | seconds | inside the keeper |

`m59-atomics.mjs` (on the fork, 14 `ATOMIC_NAMES`) is already the errand set.
`tools/m59-act/` is the act set. Both carry `pre`/`effects` from the vocabulary,
so the same planner serves both — it is one engine over two libraries, not two
engines.

### What upstream's `m59-goap.mjs` is, and why it stays

It is the **goal interface for the bot repositories**, driving from outside over
MCP, and its own source says being unreferenced is the expected state rather than
an oversight. That remains correct and is unaffected: it supplies goals. This plan
changes what happens *underneath* a goal — a planner over atomics instead of a
sequential ladder — not who is entitled to set one.

### Roles, and why they need no second system

Healer / ranged / melee / crowd-control split cleanly across the two clocks:

- *"you are the healer"* — assignment, minutes, a goal from outside.
- *"my partner is at 30%, heal now"* — execution, seconds, in-process.

`m59-party.mjs` already carries the second: `declareTarget`/`agreedTarget` is
focus fire with 20-second staleness, in shared memory across every keeper in one
broker. No round trip, the same principle as the playbooks — **the keeper asks, it
does not call.** Role variance that touches survival (a crowd-controller
deliberately takes hits; a healer must not flee while its partner dies) goes
through `may_yield` on the roster, never by forking the ladder or by weakening a
precondition.

## 3. The world-state vocabulary — **done**

`tools/m59-worldstate.mjs`, 97 assertions. Twelve symbols, one producer each, and
an unknown answer that fails in the safe direction **per symbol** — `armed`
unknown reads true (a timed-out inventory read must not idle the fleet mid-fight),
`target_in_band` unknown reads false (a ceiling that defaults open is the one that
kills somebody). The test pins that those two fail in *opposite* directions,
because a refactor making them agree would be wrong in a way nothing else catches.

`validate()` enforces the closed set: an action naming a symbol nobody produces is
reported by name. Without it a plan is unsatisfiable for the dullest possible
reason — a typo — and the planner can only say "no plan".

**Open question, to be decided deliberately:** the errand set derives symbols from
fleet rows over MCP, the act set from a live client. Same names, two sources. That
is two producers for one symbol, which §3's own rule forbids. Either two
vocabularies, or one vocabulary with an explicitly polymorphic context. Do not let
it happen by accident.

## 4. The atomic layer — contract done, one atomic written

`tools/m59-act/` with `m59-act-test.mjs` sweeping every file in it. Four rules,
enforced mechanically, each a failure already paid for:

1. **Takes `(client, session)`, never the keeper.** Checked in the source, since a
   signature cannot say it. This is the rule that makes an atomic portable — see §0.
2. **Declares `pre`/`effects` from the closed vocabulary.**
3. **No loop around an await.** Looping is the caller's job, so it can be
   interrupted between iterations.
4. **Refuses by returning, never by throwing.** A refusal that throws must be
   caught by every caller and the ones that forget read it as success — which is
   how "no error" came to mean "the merchant sold it".

Verified to bite: a planted atomic violating all four fails all four
independently, exit 1.

Written: `attack` (one swing, reports what the room says afterwards rather than
what the send returned). Remaining: `step`, `move_within`, `take_square`, `cast`,
`equip`, `unequip`, `rest`, `stand`, `pick_up`, `drop`, `give`, `buy`, `sell`,
`deposit`, `withdraw`.

## 5. Navigation — **superseded by upstream**

This section originally proposed building `route()` + `StepHop` + `NavigateTree`.
Upstream has done it: exit-to-exit paths baked offline (`m59-routebake`,
`m59-routes`), planning on the map the mover actually enforces, the two grids
disagreeing recognised *as* the safe wall, and `TERMINAL_MOVEMENT_REASONS` for
failures that cannot become legal by retrying. Adopt it; do not write a third router.

The act-set atomics wrap it (`step`, `move_within`) rather than pathfinding again.

## 6. Phases

Each phase has a measurable gate, and — the rule that keeps this from becoming the
last effort — **any phase that does not leave `m59-autopilot.mjs` shorter than it
found it is not that phase.**

**Phase 1 — vocabulary and harness. DONE.** Fake client, ratchet, world state,
atomic contract.

**Phase 2 — the act set.** The remaining atomics above, each through the sweep,
each wrapping upstream's movement layer where movement is involved.
*Gate:* every atomic conforms; `m59-act-test` covers each one's refusals.

**Phase 3 — the planner.** Port `m59-goap-planner.mjs` (188 lines, pure
`plan(actions, ws, goal)`, zero keeper reaches) onto the trunk and wire it to the
vocabulary, so `validate()` rejects an unconnectable action set *before* the search.
Add a cost model — uniform cost makes a walk across the world and a swing
interchangeable.
*Gate:* a plan over the act set is produced, validated and executed offline against
the fake client.

**Phase 4 — drive the directional layer first.** Let the planner drive errands,
where being wrong costs a wasted trip rather than a character. Merge the fork's
`deriveWorldState`/`buildActionLibrary`/`selectGoal` into upstream's supervisor.
*Gate:* a character completes a gear trip under the planner, per-character opt-in.

**Phase 5 — plan survival.** Only once the act set covers the ladder's ground.
Survival enters as **preconditions on atomics**, never as goals or costs (§2).
*Gate:* `m59-unattended-test.mjs` (55) and `m59-combat-test.mjs` (480) pass,
unchanged wherever possible. A rule that had to become a cost to make a plan work
is a **failed** gate, not a tuning exercise.

**Phase 6 — roles.** Widen `m59-party.mjs` from two roles to four. Survival
variance through `may_yield`, never by weakening a precondition.
*Gate:* a four-role party clears a room no worse than four solo characters.

**Phase 7 — delete the ladder.** The sequential `pass()` goes when the planner
covers every case. Instrument the fallback rate from Phase 4 onward; it is the
definition of done.
*Gate:* fallback rate 0 across the fleet for a week.

## 7. Migration safety

- **Per-character opt-in**, the existing strangler seam.
- **The ledger is the referee.** Kills/minute from `countKills`, never a keeper's
  own tally — that field is emptied in the constructor and keepers restart about
  once a minute. Deaths from `m59-postmortems.mjs`.
- **Back up the rosters before each phase.** `node tools/m59-backup.mjs
  --credentials-only` takes seconds, and the rosters are the only record of the
  account passwords.
- **Keep the shared-file footprint at one commit.** Everything else is new files,
  so an incoming upstream push can only collide in one place.

## 8. Risks

| risk | how it shows up | detection |
|---|---|---|
| a survival refusal becomes a cost | plans succeed, deaths rise, nothing errors | §2 invariant; Phase 5 gate is the test suites unchanged |
| rebuilt atomics repeat the fixture bug | tests green, fleet idle | one shared fake, shape-conformance against `M59Client` |
| planner thrashes on stale state | plans churn, nothing completes | plan-changes-per-minute on status |
| goals can remove a precondition | a bot makes a character suicidal | the goal API cannot express preconditions at all |
| the rebuild stalls half-done | two systems for ever | the ratchet + fallback rate |

## 9. Definition of done

```
m59-autopilot.mjs        < 3,000 lines   (session/socket/pacer/journal host)
delegation ratchet       0
planner fallback rate    0
world-state symbols      one registry, one producer each
survival expressed as    preconditions only — no goal, no cost term
kills/minute             >= pre-rebuild fleet median
deaths/1000 obs          <= pre-rebuild
```
