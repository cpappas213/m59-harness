# Progression, and how to tell it is working

For an agent playing one character over days. Everything here is computed from the
kod that enforces it, and every table in this document is reproducible:

```bash
node tools/m59-progression.mjs check                  # re-read the constants from the source
node tools/m59-progression.mjs hp --stamina 25        # kills per hit point
node tools/m59-progression.mjs ability                # uses per ability point
node tools/m59-progression.mjs climb 20 126 --stamina 25
```

`check` re-reads eight load-bearing expressions out of `C:\code\meridian59` and says
whether each still matches. If it reports BROKEN, the numbers below are stale and the
tool is right.

---

## The one-paragraph version

There are **three separate progressions** and they do not share a budget.

| | what grows it | what caps it | the signal you get |
|---|---|---|---|
| **max health** — your level | killing things **above your level** that hurt you | `101 + stamina`, forever | a message, a full heal, and `status` |
| **skill / spell ability** | *using* them, on hard targets | 99, and 10 points per ~18 min | `abilities`, and nothing else |
| **attributes** | **nothing** | fixed at character creation | `status` |

The third row is the one that ruins characters. Attributes never move after creation
(`player.kod:6369-6390` only ever reads them), and **stamina sets your health ceiling**,
so the single most consequential decision about a character is made before it has
played at all. A character created by the admin socket's `create automated` has *zero*
in every attribute — displayed as `1`, because `GetMight` bounds the raw value up — and
can therefore never exceed **102 max health**, against 171 for a stamina-70 build.
`status` now says so explicitly. There is no fix but a new character.

---

## Am I progressing normally?

Four numbers, all observable through the interface.

| measure | read it with | healthy | something is wrong |
|---|---|---|---|
| max health | `status` → `vitals.health.max` | rises every 10–100 eligible kills | flat over 200 kills |
| ability numbers | `abilities` | any one rises within ~10 uses on a hard target | flat over 30 uses |
| ability numbers falling | `abilities`, compared to last session | never | atrophy — you stopped using them |
| shillings | `inventory`, `bank` | rises across a session | you are dying and dropping it |

**Record `abilities` at the start of a session and compare at the end.** It is the only
progress signal the game gives for skills and spells, it was invisible before this tool
existed, and the deltas are small enough that memory will not do.

---

## Max health: what a kill is worth

`AdvancementCheck` (`player.kod:7736`). A kill is worth nothing unless **you damaged it**
and **it was your current target** — switching targets mid-fight discards the credit for
the old one (`player.kod:4063` resets the flags on each new attack).

Given that, with `H` = your base max health and `L` = the monster's level:

| condition | gain | rolls? |
|---|---|---|
| `L > H`, you took damage **and** landed the killing blow | 3 | yes |
| `L > H`, one of those two but not both | 2 | yes |
| `H-4 ≤ L ≤ H`, took damage **and** killing blow, and it is a monster | 1 | **no** |
| `L ≤ H-5` | 0 | no |
| any of the above, while `H < 30` | **+1** | unchanged |

Only a monster **strictly above your max health** can ever produce a hit point. An
equal-level kill banks the accumulator but cannot fire the roll. And a `gain 1` from a
near-level kill *never* rolls, so it only pays off through some later, harder kill.

The roll itself (`player.kod:7822`, `GetHighMark` at `7896`):

```
index    = H * (100 - stamina) / 100
highmark = (index + 1) * index
iNumber  = piGain_chance + bound((L - H) / 5, 0, 10)
gain a point if random(1, highmark) < iNumber   and   H < 101 + stamina
```

`piGain_chance` is the real experience bar. It is **reset to a negative number** after
every gain — `-(H/2)`, and a further `-(50-stamina)/2` once past 30 health — so each new
point starts in a hole that deepens as you level. That reset, not the roll, is the
difficulty curve.

Three consequences worth acting on:

- **Over-levelling buys almost nothing.** The `(L-H)/5` bonus caps at 10, which against a
  highmark in the thousands is a ~6% improvement at `L = H+50` versus `L = H+1`. Fight
  something *slightly* above you and safely, not something huge.
- **Landing the killing blow while taking damage is worth ~30%.** Standing back is the
  single most expensive habit.
- **A big health buff can zero your advancement entirely.** If `piMax_Health` exceeds
  twice your base, every monster below your buffed max health gives `gain/2` with the
  roll forced off — an infinite number of kills per point (`player.kod:7809`).

### Expected eligible kills per +1 max health

Computed exactly, not sampled. `node tools/m59-progression.mjs hp --stamina N`.

| max health | stamina 1 | stamina 25 | stamina 50 |
|---|---|---|---|
| 20 | 14.6 | 12.1 | 9.0 |
| 30 | 26.3 | 21.3 | 16.2 |
| 50 | 52.1 | 39.5 | 26.8 |
| 100 | 96.7 | 75.3 | 53.2 |
| 150 | — (ceiling 102) | — (ceiling 126) | 79.6 |

Cumulative, from a fresh character at 20 to the ceiling:

| stamina | ceiling | total eligible kills | at 10 s/kill | at 30 s/kill |
|---|---|---|---|---|
| 1 | 102 | 4,913 | 13.6 h | 40.9 h |
| 25 | 126 | 5,803 | 16.1 h | 48.4 h |
| 50 | 151 | 5,874 | 16.3 h | 48.9 h |

So a character reaches its ceiling in roughly **15–50 hours of actual fighting**, and
the ceiling itself is set by a number chosen at creation. Note the columns are close:
stamina barely changes the *work*, it changes the *destination*.

**When you gain a point you are told**: a message, a sound, and your health refills to
full (`player.kod:7840-7844`). A sudden full heal mid-grind is not a bug.

---

## Skills and spells: what a use is worth

`ImproveAbility` (`skill.kod:294`). Two rolls: an initial gate from the ability's own
`viChance_to_increase` scaled by your **intellect**, then a secondary chance built from
your **requisite stat**, the ability's level, how generalised you are, and **the
difficulty of what you used it on**.

```
factor = bound(2*difficulty - ability + 10, 50, 100)      difficulty = target monster's level
C      = bound((60 + req - 10*level - learnPoints) * factor / 100, 5, ...)
if ability > 2*req - 1:  C = C / SOFTCAP_PENALTY          4 for spells, 5 for skills
C      = bound(C, 1 + req/10, 99)
```

**Difficulty saturates at monster level 45.** `factor` is bounded to 100, and `2*45+10`
already reaches it. Practising on anything level 45 or above is identical; practising on
anything level 20 or below is the worst case, about twice as slow.

### The skill/spell asymmetry, which is a bug in the game

`GetSecondaryChance` reads your current ability with
`GetSpellAbility(#spell_num=viSkill_num)` (`skill.kod:414`). For a **spell** that works.
For a **skill** the number is never in `plSpells`, so it returns 0 (`player.kod:6720`
says so in its own comment). Therefore, for skills:

- the improve chance **does not fall as the skill rises** — 1→99 is as easy at 90 as at 5
- the softcap **never fires**

This is what the server computes, not a modelling choice, and `m59-progression.mjs check`
asserts the line is still there.

### Expected uses per +1 ability

| | intellect 1 | 25 | 50 | 70 |
|---|---|---|---|---|
| **skills**, target level ≤ 20 | 13.6 | 10.9 | 9.1 | 8.0 |
| **skills**, target level ≥ 45 | 6.7 | 5.4 | 4.5 | 4.0 |

| spells, requisite stat 25 | 40 | 50 |
|---|---|---|
| ability 1–25: 5.4 uses | 4.5 | 4.1 |
| ability 50 (**softcap**): 26.9 | 5.6 | 5.0 |
| ability 90: 44.9 | 36.7 | 8.1 |

A spell whose requisite stat is 50 never hits its softcap, because `2 × 50 = 100 > 99`.
That is the largest single lever in the ability system.

### The throttle binds long before the odds do

`ADVANCEMENT_LIMIT` is **10 points per window**, the window a random 15–22 minutes
(`player.kod:66-68`). Skills and spells share that budget. At ~32 points/hour standing
still, **0→99 in one ability takes at least 3 hours of wall clock** however good your
odds are — and you will hit the cap in the first few minutes of any real practice.

But the cap leaks, deliberately. `NewOwner` refunds 2 points on every room change, with
the comment *"give them a break on the botting imp cap"* (`player.kod:1465`), and when you
hit the cap the server itself hints that you should move rooms.

| room changes per window | 0 | 5 | 10 | 20 |
|---|---|---|---|---|
| points available | 10 | 20 | 30 | 50 |
| points per hour | 32 | 65 | 97 | 162 |

**So the correct practice loop is a circuit, not a room.** Fight, walk next door, fight.
An agent that farms one room is capped at a fifth of what a walking one gets.

`ROOM_HARD_LEARN` rooms divide the chance by ten — towns and safe rooms typically carry
it. Practising somewhere comfortable is practising at a tenth rate.

**Atrophy**: what you do not use decays when the window rolls over
(`AdvancementTimer`, `player.kod:7680`). Compare `abilities` between sessions.

---

## A fresh character knows nothing at all

Verified on the live server: a character made by `create automated` has `plSpells` and
`plSkills` both **empty**. Not one skill — not punch, not slash, not dodge.

That matters more than it sounds, because `ImproveAbility` returns immediately unless
`HasSkill(viSkill_num)` (`skill.kod:317`). **You cannot improve an ability you do not
have**, so a blank character gains *nothing* from fighting except max health. Every
ability curve in this document starts after a purchase.

So the first hours of a character are, in order:

1. Buy a weapon, and buy the proficiency for it — both through `shop`, from merchants
   found with `merchants {teaches: "..."}`. Skills and spells sit in a merchant's
   for-sale list alongside items and are sold at face value with no markup.
2. Only then does `attack` teach you anything.
3. `bank` the rest before going anywhere dangerous.

`abilities` returning nothing is the diagnostic: it means there is nothing to practise.

## What actually blocks you, in order

1. **Character creation.** Stamina is your health ceiling; you cannot raise it later. A
   `create automated` character is capped at 102 max health and bad at everything.
2. **Finding something above your level that you can survive.** Only `L > H` teaches you.
3. **The advancement cap**, if you practise abilities in one place.
4. **Downtime.** Health regenerates slowly; the fight is not the expensive part.

Money is *not* on this list. Skills and spells sell at face value with no markup
(`monster.kod:4880`), and the throttle costs more hours than the shillings do.

---

## Things that will make you think you are progressing when you are not

- **A god-moded character.** `abilities` flags it: if every number is identical, they were
  granted. `agent1` on this server is such a character — all 178 spells, all 19 skills,
  every ability exactly 60, and attributes at the floor. Nothing measured on it says
  anything about progression.
- **Killing easy things.** No message, no gain, and a 10% chance the game tells you your
  character spits in contempt. That message *is* the signal.
- **`status` looking healthy.** It lists the abilities you *have*. Only `abilities` shows
  how good you are at them, and only the delta means anything.
- **Practising in town.** Ten times slower, silently.
- **Standing in one room.** Capped at 10 points per ~18 minutes, silently.
