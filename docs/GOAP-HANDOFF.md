# GOAP Fleet Supervisor — Handoff Notes

This document covers the GOAP external supervisor layer and the four new characters
added in August 2026. It assumes familiarity with the broker and keeper architecture
described in `CLAUDE.md`.

---

## The four new characters

| Character | Agent | Build | Karma filter | Current hunt | Room |
|---|---|---|---|---|---|
| Gountrug | t1 | Weaponcraft | none | slime | 583 |
| Kage | t2 | Shal'ille caster | `good` (kills negative-karma only) | giant rat | 586 |
| JayB | t3 | Qor caster | `evil` (kills positive-karma only) | fungus beast | 544 |
| Lee | t4 | Weaponcraft | none | giant rat | 586 |

All four are PvP-enabled (base max health ≥ 30, so `PFLAG_PKILL_ENABLE` is set).

### Karma mechanics

`karmaSafe(creatureKarma, want)` in `m59-spawns.mjs`:
- `want='good'` → only allows `creatureKarma < 0` (kills evil creatures, character moves toward good)
- `want='evil'` → only allows `creatureKarma > 0` (kills good creatures, character moves toward evil)

**Kage** is Shal'ille → must stay good → `karma: "good"` → hunts giant rat (karma −20).
**JayB** is Qor → grinding toward evil → `karma: "evil"` → hunts fungus beast (karma +10).

When `yieldCheck` fires and auto-retargets, it now passes `policy.karma` to `scorePrey`
so the replacement prey also respects the filter. This was the bug fix in `m59-autopilot.mjs`
around line 7871 — `want: this.policy.karma ?? null` added to the `scorePrey` call.

### JayB's karma progression

JayB needs karma ≤ −10 to unlock Qor level 1 spells. Positive-karma prey to hunt
as she levels, in order of difficulty:

| Level range | Hunt | Karma | Room(s) |
|---|---|---|---|
| 30–49 | fungus beast | +10 | 544, 562, 563 |
| 50+ | living tree | +40 | 534, 536, 537, 546 |
| higher | frogman | +80 | 552, 576 |

When the keeper auto-retargets (yieldCheck fires), it will pick the next positive-karma
creature in the band automatically. No manual intervention needed unless she gets stuck.

### Kage's learning queue

`substrate/loadouts/Kage.json` has a full learning queue: minor heal → Shal'ille 1–6.
The GOAP `buy_next_skill` action handles purchases automatically when funds are available.

### Weaponcraft builds (Gountrug, Lee)

- `buy_reagents: false` — no spells, so no reagents needed. Set in loadout policy.
- `sell: ["elderberry", "herb"]` — sell any reagents looted.
- Skill queue: weaponcraft level 1 → level 2 (GOAP handles purchases).
- As of 2026-08-15: Gountrug slash=34, mace fighting=22, block=21. Lee slash=16, mace fighting=6.

---

## The GOAP supervisor

**File:** `tools/m59-goap.mjs`

**Start it:** `node tools/m59-goap.mjs` (separate process, not part of the broker)

**Polls:** broker at `http://127.0.0.1:8901` every 60 seconds. Reads the `/fleet` endpoint,
derives world state for each character, plans and executes one action per character per pass.

### Actions and what triggers them

| Action | Precondition | What it does |
|---|---|---|
| `revive_inert` | `keeperRunning && inert` | Clears post-restart inert state |
| `stop_and_travel` | Off assigned room | Travels to assigned room |
| `set_purpose` | No purpose set | Sets `advance` purpose with hp goal |
| `set_prey` | No hunt or yield paying=false | Picks best prey via `prey` tool |
| `rest_in_inn` | In inn, not rested | Parks at inn to rest |
| `avoid_crowded_room` | Stalled, healthy, outsider players in room | Moves to different room |
| `retreat_to_inn` | Stalled, hurt (<70%), not at inn | Travels to inn to rest |
| `leave_capped_room` | Stall: `room capped by creatures we will not fight` | Clears assigned_room |
| `relocate_no_safe_wall` | Stall: `no safe wall here` | Clears assigned_room |
| `town_trip_bags_full` | Stall: `bags full` | Travels to town to sell/bank |
| `retarget_unreachable` | Stall: `cannot reach` or `roam limit` | Picks new prey |
| `rescue_trapped` | Stall: `trapped` or `too hurt to fight` | Evacuates to inn |
| `send_to_town_for_gear` | Stall: `unarmed — N mana` | Travels to town, keeper buys weapon |
| `buy_next_skill` | Has skill plan, has funds | Queues next skill purchase |
| `escalate_to_operator` | Stalled >5min, nothing else worked | Writes needs-operator flag |
| `leave_raza` | In Raza (rooms 1011–1018) | Walks out of Raza |

### World state fields

Derived in `deriveWorldState()`. Key ones for writing new actions:
- `stalledWhy` — the raw stall reason string from the broker
- `stallRoomCapped`, `stallNoSafeWall`, `stallBagsFull`, etc. — pre-parsed booleans
- `unarmedStall` — true when stall why starts with "unarmed"
- `learningCooldown` — true while `buy_next_skill` is cooling down (5 min)
- `gearTripCooldown` — true while `send_to_town_for_gear` is cooling down (10 min)
- `fleetNames` — Set of all fleet character names, used to identify outsiders

### Adding a new action

1. Add stall-reason booleans to `deriveWorldState()` if needed
2. Call `mk({ name, cost, pre, effect, run })` in the `buildActions()` array
3. `pre` is a JS expression string evaluated against the world state object
4. `run` is `async (state) => { ... }` — call broker tools via `callTool(name, args)`
5. Return `{ note: '...' }` on success, `null` to skip (action treated as no-op)
6. Add a comment to the `// Effect discipline` block at the bottom explaining how
   the effect removes its own precondition to avoid infinite loops

---

## Playbooks (PvP response)

**Directory:** `substrate/playbooks/` — one JSON file per character, keyed on lowercase name.

All four characters have playbooks with the same policy:
- Health ≥ 70%, single attacker → `fleet_alert` then `fight_back`
- Health < 70% OR 2+ attackers → `leave_room`
- Health < 40% → `logoff` for 5 minutes

`fight_back` and `fleet_alert` were added to the verb set in `tools/m59-playbook.mjs`
and wired into `executeVerb()` in `tools/m59-autopilot.mjs`. `fleet_alert` signals
the broker which fans out to nearby healthy fleet members to converge and fight back.

**Key point:** the `inReachOfUs()` OF.PLAYER filter stays in place — ordinary combat
never targets players. `fight_back` is only triggered by an explicit playbook rule.

---

## Loadout policy block

Loadout files now support an optional `policy` block that is applied to the keeper's
live policy on every pass (`applyLoadoutPolicyOverlay()` in `m59-autopilot.mjs`).
Fields present in the loadout overwrite the live policy on every pass. Fields absent
do not touch the live policy.

Supported fields: `buy_reagents`, `karma`, `hunt`, `assigned_room`, `pulls_before_barren`.

This means broker restarts are self-healing — no manual `autopilot set` calls needed.

---

## Known issues / things to watch

**Gountrug's broken weapon cycle:** The broker marks a weapon `known_broken` after a
failed equip attempt. If the keeper is restarted while the weapon is mid-use, it can
get stuck: the broken weapon counts as `has_weapon: true` so the unarmed stall message
fires, but `equip_best` refuses it. The GOAP `send_to_town_for_gear` handles this by
sending Gountrug to the smith. The broken weapon is auto-dropped within 2 minutes
(`dropBrokenEverySec: 120`). Root cause not fully diagnosed.

**Lee has no assigned_room in loadout:** Lee's loadout doesn't pin a room. The keeper
picks by roaming. Could add `"assigned_room": 586` to Lee's loadout policy if she
keeps ending up in bad rooms.

**Settings that still require manual set after restart (none — fixed):** All per-character
policy settings are now in loadout files and applied automatically.

---

## Swarm tasks

Use project `m59-harness` (not `game-harness`) when creating swarm tasks for this repo.

```bash
curl -s http://localhost:5001/api/tasks -X POST -H 'Content-Type: application/json' -d '{
  "project": "m59-harness",
  "task_type": "feature",
  "priority": 80,
  "description": "..."
}'
curl -s http://localhost:5001/api/spawn -X POST -H 'Content-Type: application/json' \
  -d '{"project":"m59-harness","force":true}'
```

---

## Quick diagnostics

```bash
# Fleet overview — stalls, levels, weapons
node tools/m59-which.mjs

# Character abilities
node tools/m59-abilities.mjs Gountrug Lee JayB Kage

# Tougher history (HP gains)
node tools/m59-tougher.mjs

# Check a stall reason
curl -s http://127.0.0.1:8901/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"autopilot","arguments":{"agent":"t1","action":"status"}}}' \
  | python3 -c "import sys,json; s=json.loads(json.load(sys.stdin)['result']['content'][0]['text']); print(s.get('stalled'), s.get('activity'))"

# Re-equip a character manually
node tools/m59-outfit.mjs --port 8901 --agents t1

# Broker restart (policy reloads from loadouts automatically)
node tools/m59-service.mjs restart
```
