# Behavior Tree Replacement for the Keeper Pass Loop

## Why

The keeper's `pass()` method is ~2,800 lines of sequential if/return chains. Each
branch only knows about itself — when one path is permanently blocked (e.g. "wait
for mana to cast create weapon" when the character doesn't know the spell), it loops
forever with no fallback. This caused all four characters to sit unarmed in inns all
night on 2026-08-15.

A behavior tree fixes this structurally: a `Selector` tries children left-to-right
and returns on the first success. A `Sequence` fails immediately if any condition
fails. So "try to conjure a weapon, but only if you know the spell" is a two-node
sequence that fails instantly and falls through to "go buy one" — no waiting, no
loop.

## What stays in the keeper (event-driven, sub-second)

These react faster than any polling loop. They stay as direct event handlers on the
client, outside the BT:

- **Watchdog**: health drops while pass is blocked → interrupt and flee
- **Flee below threshold**: fires on any health event, not just during a pass
- **Rest on damage**: same
- **Fight back when hit**: same
- **Death / Underworld escape**: driven by room-change events

## What moves to the BT (the strategic pass loop)

Everything in `pass()` that is not a reflex. The BT ticks every ~1s and executes the
current goal. It never makes strategic choices — those belong to GOAP.

## GOAP sits above the BT

GOAP runs every ~30s and writes to the blackboard: `assigned_room`, `hunt`,
`purpose`, `goals`. The BT reads these as conditions and pursues them. GOAP makes
strategy; the BT executes it.

## Proposed tree

```
Root: Selector  (priority order, tick every ~1s)
  │
  ├── is_frozen        → Sequence: sit, wait
  ├── is_dead          → Sequence: escape_underworld
  ├── is_inert         → Sequence: check_deadline, wait
  ├── is_recovering    → Sequence: hibernate_until_whole
  │
  ├── Selector: get_armed
  │     ├── Condition: wielding_weapon
  │     ├── Sequence: equip_from_pack
  │     │     ├── Condition: weapon_in_inventory
  │     │     └── Action: equip_best
  │     ├── Sequence: conjure_weapon
  │     │     ├── Condition: knows_create_weapon
  │     │     ├── Condition: mana >= 15
  │     │     └── Action: cast_create_weapon
  │     └── Action: travel_and_buy          ← what was missing overnight
  │
  ├── Selector: handle_threat
  │     ├── Condition: safe                 → FAILURE (fall through to farming)
  │     ├── Sequence: doomed               → Action: panic_logoff
  │     ├── Sequence: fleeing              → Action: run_or_mulligan
  │     └── Sequence: hurt
  │           ├── Selector: get_wall
  │           ├── Action: retreat_to_inn
  │           └── Action: rest
  │
  ├── Condition: has_errand                 → Action: run_errand
  ├── Action: banking_and_delivery
  │
  └── Selector: farm                        (only when mode === 'farm')
        ├── Action: eat_if_hungry
        ├── Selector: ensure_prey
        │     ├── Condition: prey_paying
        │     └── Action: retarget_prey
        ├── Selector: ensure_room
        │     ├── Condition: in_right_room
        │     └── Action: travel_to_room
        ├── Condition: bags_full            → Action: make_room
        ├── Selector: fight_or_roam
        │     ├── Sequence: fight
        │     │     ├── Condition: prey_in_room
        │     │     └── Action: pull_and_fight
        │     └── Action: roam
        └── Action: idle_wait
```

## Node interface

Async nodes with cooperative yielding. Each node is an async function returning
`SUCCESS | FAILURE | RUNNING`. Actions that take time (travel, cast, buy) return
`RUNNING` and are re-entered on the next tick with internal state preserved via a
closure on the blackboard.

```javascript
// tick(blackboard) → 'SUCCESS' | 'FAILURE' | 'RUNNING'

// Condition — always sync, no side effects
const wieldingWeapon = {
  tick: (bb) => bb.client.armed() ? SUCCESS : FAILURE,
};

// Action — async, spans many ticks via blackboard state
const travelAndBuy = {
  tick: async (bb) => {
    if (!bb._buyState) {
      bb._buyState = { done: false, ok: false };
      buyWeaponAtSmith(bb.session).then(ok => {
        bb._buyState.done = true;
        bb._buyState.ok = ok;
      });
    }
    if (!bb._buyState.done) return RUNNING;
    const ok = bb._buyState.ok;
    bb._buyState = null;
    return ok ? SUCCESS : FAILURE;
  },
};
```

Blackboard is a plain object updated at the start of each tick from `client` and
`policy`. Nodes read it; they do not write to it except for their own `_privateState`
keys. GOAP writes strategic fields (`assignedRoom`, `hunt`, `purpose`) between ticks.

## Implementation order

### Step 1 — `tools/m59-bt.mjs` (primitives, ~150 lines)
Node types: `Selector`, `Sequence`, `Condition`, `Action`.
Decorators: `Inverter`, `Timeout(maxMs)`, `Retry(n)`.
All testable offline with mock blackboards — no broker, no client.

### Step 2 — `tools/m59-bt-nodes.mjs` (the actual tree)
Wire conditions and actions from keeper internals. Conditions read from `client` /
`session`. Actions call existing keeper methods — `armSelf`, `makeWeapon`,
`takeSafeSpot`, `roam`, etc. — wrapped as nodes. These do not need to be rewritten,
just wrapped.

Start with `get_armed` subtree as proof of concept:
- Proves the interface works end-to-end
- Directly fixes the overnight failure
- Small enough to test completely offline

### Step 3 — `tools/m59-bt-test.mjs`
Unit tests for each subtree against mock blackboards. The "get armed" tree is a
one-page test. Threat ladder tests use the existing `m59-combat-test.mjs` assertions
as acceptance criteria.

### Step 4 — Refactor `pass()`
```javascript
async pass() {
  this.blackboard.update(this.client, this.policy);
  await this.tree.tick(this.blackboard);
}
```
The 2,800-line chain becomes a thin dispatcher. Do this subtree by subtree, keeping
old code paths behind a flag (`policy.useBT = true`) until each subtree is proven.

### Step 5 — Translate the threat ladder last
The threat ladder has subtle priority ordering that the flat if/return chain implicitly
enforces. Translate it last, with the existing combat tests as the gate. The BT
priority order must exactly match the current keeper order — wrong priority here means
characters dying, not stalling.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Threat ladder priority wrong | Translate last; gate on existing 471 combat tests |
| Long-running actions block tick | Async + RUNNING pattern; timeout decorator |
| GOAP writes conflict with BT reads mid-tick | Blackboard snapshot at tick start; GOAP writes only between ticks |
| Existing keeper methods have hidden state | Wrap, don't rewrite; keep `this` context intact |
| `pass()` flag complexity | Remove flag and old code once each subtree passes its tests |

## Files

| File | Role |
|---|---|
| `tools/m59-bt.mjs` | Primitives: node types, tick protocol, decorators |
| `tools/m59-bt-nodes.mjs` | The actual tree, wired from keeper internals |
| `tools/m59-bt-test.mjs` | Offline unit tests for every subtree |
| `tools/m59-autopilot.mjs` | `pass()` becomes a thin BT dispatcher; methods stay |

## Current fleet context (as of 2026-08-15)

The four characters (Gountrug/t1, Kage/t2, JayB/t3, Lee/t4) are at level 30 max
health, farming giant rat / fungus beast. Kage and Lee are currently unarmed — the
exact failure this BT is designed to prevent recurring. Lee is stuck in room 555
(The Forest Shrine) which has a broken west edge exit; she needs blink (mana regen
first) or the broker to rejoin her somewhere else.
