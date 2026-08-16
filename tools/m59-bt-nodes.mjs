#!/usr/bin/env node
// m59-bt-nodes.mjs -- behavior tree node factories wired from keeper internals.
//
// The primitives in m59-bt.mjs are pure tree mechanics. This file is where the
// trees become meaningful: each leaf here reads the live Meridian 59 client /
// session on every tick, and each action delegates to an existing keeper
// method so the policy surface stays in one place.
//
// Factories return BT nodes (Condition / Action / Sequence / Selector from
// m59-bt.mjs). Each factory takes the minimal references it needs:
//
//   - Conditions read from bb.client (the live MeridianClient). The blackboard
//     is the contract: trees see the world through it and never reach behind
//     it for live state.
//   - Actions call keeper methods, with the keeper passed in explicitly so
//     these nodes are testable against a mock keeper in unit tests.
//
// THE GET-ARMED SUBTREE (proof of concept -- see docs/BT-PLAN.md).
//
// The previous keeper loop waited forever for mana to cast create_weapon even
// when the character did not know the spell. The selector below falls through
// to travel_and_buy immediately in that case:
//
//     Selector
//       Condition: wielding_weapon           (bb.client.armed())
//       Sequence:   equip_from_pack
//                   Condition: weapon_in_inventory
//                   Action:    equip_best
//       Sequence:   conjure_weapon
//                   Condition: knows_create_weapon   <-- fails fast if absent
//                   Condition: mana >= 15
//                   Action:    cast_create_weapon
//       Action:     travel_and_buy                  (walks to nearest smith)
//
// The conjure_weapon sequence fails on its first tick when knows_create_weapon
// is false. That failure propagates up through its parent sequence and into
// the outer selector, which advances to travel_and_buy. No waiting, no loop.

import {
  Condition, Action, Sequence, Selector,
  selector, sequence,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';
import { keeperDriver, runAtomic } from './m59-atomics.mjs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Pull a numeric mana reading off the blackboard, returning 0 when unknown.
// The keeper logs vitals as {value, max}; while the broker is reconnecting
// that object is null and any defensive code that treats null as "no mana"
// would loop the whole fleet through conjure_weapon until it burned out.
function _mana(bb) {
  const v = bb?.client?.vitals?.()?.mana?.value;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

// True when the live client's spell list contains "create weapon". Names are
// resolved through the rsc table the same way the keeper does it; the lookup
// is case-insensitive to mirror the existing behaviour in m59-autopilot.mjs.
function _knowsCreateWeapon(bb) {
  const c = bb?.client;
  if (!c) return false;
  return !!(c.spells || []).find(
    sp => (c.rsc?.get?.(sp.nameRsc) || '').toLowerCase() === 'create weapon');
}

// True when the inventory carries at least one weapon. Matches the shape of
// skills.weaponsOf(c) but is duplicated here so this file is self-contained
// and does not import m59-skills.mjs at module load time (skills pulls in
// m59-client and a lot of network code, which would defeat offline tests).
export function _hasWeaponInInventory(bb) {
  const c = bb?.client;
  if (!c) return false;
  const inv = c.inventory || [];
  for (const o of inv) {
    const name = (c.rsc?.get?.(o.nameRsc) || '').toLowerCase();
    // Any of these classes is enough to swing at a monster. The list mirrors
    // the weapon-name regex set the keeper uses elsewhere; if a new weapon
    // class is added it should land in both places in the same commit.
    if (/(mace|sword|axe|hammer|staff|bow|dagger|spear|halberd|scimitar|wand|fang|claws|talisman)/i
          .test(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Condition factories
// ---------------------------------------------------------------------------

// wielding_weapon: true when the live client reports it is already armed.
// Reads bb.client.armed() -- the same predicate the keeper has used for years
// to decide whether the empty hand needs filling. Pass-through on the use
// list's "cannot answer" case (armed() returns true then), which is the
// right default for a fight reflex but would be wrong for leaving safety;
// the BT here is only ticked after a hibernate_until_whole sequence, by
// which time the use list is populated.
export function wieldingWeaponCondition() {
  return new Condition(bb => !!(bb.client && bb.client.armed && bb.client.armed()));
}

// weapon_in_inventory: true when the pack contains something wieldable.
// Used inside the equip_from_pack sequence to skip the cast when we already
// have the weapon we need on us.
export function weaponInInventoryCondition() {
  return new Condition(bb => _hasWeaponInInventory(bb));
}

// knows_create_weapon: true when the spell is in the live spell list. THIS
// is the predicate whose absence caused the overnight failure. When it is
// false, conjure_weapon must fail immediately -- on the very first tick --
// so the outer selector falls through to travel_and_buy. A condition that
// ever returns RUNNING here, or one that tries to wait for mana first, would
// recreate the original bug at a higher level of abstraction.
export function knowsCreateWeaponCondition() {
  return new Condition(bb => _knowsCreateWeapon(bb));
}

// mana >= 15: mirrors the hard floor on create_weapon in m59-autopilot.mjs
// (the spell refuses silently below 15, so the check is on mana BEFORE the
// cast, not on the absence of an item after it). Returns SUCCESS when mana
// is at least the floor, FAILURE otherwise. Never RUNNING -- a character
// that cannot yet cast will simply fail this tick and be reticked later by
// the surrounding sequence, at which point the predicate is re-read.
export function manaAtLeastCondition(threshold = 15) {
  return new Condition(bb => _mana(bb) >= threshold);
}

// ---------------------------------------------------------------------------
// Action factories -- all delegate to the GOAP atomic layer
// ---------------------------------------------------------------------------

// atomicAction: build a BT Action node that runs ONE GOAP atomic against a
// keeper driver. This is the seam the atomics refactor exists for: the BT and
// GOAP now share a single implementation of each primitive operation (see
// m59-atomics.mjs), and a BT action node is a thin wrapper that adapts the
// atomic's promise into the tree's RUNNING/slot protocol.
//
// On the first tick it kicks the atomic off fire-and-forget and returns RUNNING.
// The promise's eventual status lands on the slot; the next tick reads it and
// resolves to SUCCESS / FAILURE (and clears the slot, so a Retry of the
// surrounding sequence starts clean).
//
// IMPORTANT: the fn returns RUNNING synchronously. If it returned the promise
// directly, m59-bt.mjs's Action.tick would intercept the promise and replace
// our slot with `{promise: out}`, breaking the "read slot.done next tick"
// pattern. Run fire-and-forget side effects via .then() instead.
function atomicAction(keeper, atomicName, params, { key, name }) {
  const ctx = keeperDriver(keeper);
  return new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false, error: null };
      bb._bt[key] = slot;
      Promise.resolve()
        .then(() => runAtomic(atomicName, ctx, params))
        .then(r => { slot.ok = !!r; slot.done = true; })
        .catch(err => { slot.error = err; slot.ok = false; slot.done = true; });
      return RUNNING;
    }
    // Subsequent tick: report what happened. Clear the slot so a retry of the
    // surrounding sequence (via Retry, etc.) starts clean.
    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name });
}

// equip_best: runs the `equip_best` GOAP atomic -- wraps keeper.armSelf or,
// failing that, skills.equipBest. The keeper driver supplies the mechanism; the
// atomic is the single shared definition (see m59-atomics.mjs).
export function equipBestAction(keeper) {
  return atomicAction(keeper, 'equip_best',
    { agent: null, why: 'BT: equip from pack' },
    { key: 'bt_equip_best', name: 'equip_best' });
}
// Hoist the action key onto the factory so tests can find / clear the slot
// without holding a reference to the constructed action.
equipBestAction._key = 'bt_equip_best';

// cast_create_weapon: runs the `conjure_weapon` GOAP atomic -- wraps
// keeper.makeWeapon (which stands the character up, checks mana, requests the
// spell list, casts, and verifies the weapon landed before equipBest runs).
// Returns RUNNING while the cast is in flight, then SUCCESS if a weapon
// appeared, FAILURE otherwise. The keeper already does the mana and spell
// checks; the BT only guards against the case the keeper's "wait for mana"
// branch used to spin on forever, and that guard lives in the conjure_weapon
// SEQUENCE's conditions.
export function castCreateWeaponAction(keeper) {
  return atomicAction(keeper, 'conjure_weapon',
    { agent: null, why: 'BT: conjure weapon' },
    { key: 'bt_cast_create_weapon', name: 'cast_create_weapon' });
}
castCreateWeaponAction._key = 'bt_cast_create_weapon';

// travel_and_buy: runs the `buy_weapon` GOAP atomic -- wraps
// keeper.buyWeaponsAtNearestSmith, which spawns m59-outfit.mjs as a child
// process (the same mechanism the broker uses for ability buying). The outfit
// script stops the keeper, walks to the smith, buys, then restarts the keeper.
// Returns SUCCESS when the character is armed afterwards.
export function travelAndBuyAction(keeper) {
  return atomicAction(keeper, 'buy_weapon',
    { agent: null, why: 'BT: travel and buy' },
    { key: 'bt_travel_and_buy', name: 'travel_and_buy' });
}
travelAndBuyAction._key = 'bt_travel_and_buy';

// travel_to: runs the `travel_to` GOAP atomic -- wraps keeper.travel(to).
// Spans ticks via the RUNNING/slot pattern; SUCCESS when the travel call
// reports arrival. Not wired into get_armed (that subtree uses travelAndBuy);
// this is the node the next subtrees (banking, errands, retreat) build on.
export function travelToAction(keeper, to) {
  return atomicAction(keeper, 'travel_to',
    { agent: null, to },
    { key: `bt_travel_to_${Math.random().toString(36).slice(2, 8)}`, name: 'travel_to' });
}

// revive_keeper: runs the `revive_keeper` GOAP atomic -- wraps keeper.revive.
// Used by a BT recovery arm to un-inert a keeper that stopped without a revive.
export function reviveKeeperAction(keeper) {
  return atomicAction(keeper, 'revive_keeper',
    { agent: null, why: 'BT: un-inert keeper' },
    { key: 'bt_revive_keeper', name: 'revive_keeper' });
}

// stop_keeper: runs the `stop_keeper` GOAP atomic -- wraps keeper.stop.
// Soft-stop (goInert); an intermediate of the relocate composite, exposed as a
// node for a BT arm that needs to park a keeper before an errand.
export function stopKeeperAction(keeper) {
  return atomicAction(keeper, 'stop_keeper',
    { agent: null, why: 'BT: park keeper' },
    { key: 'bt_stop_keeper', name: 'stop_keeper' });
}

// ---------------------------------------------------------------------------
// Subtree factories
// ---------------------------------------------------------------------------

// equip_from_pack: a sequence that only succeeds when the pack contains a
// weapon AND we can equip it. The two-step gate keeps the BT honest: a pack
// with no weapons falls through to the next selector arm, and a pack with a
// broken weapon that equipBest refuses falls through too.
export function equipFromPackSequence(keeper) {
  return sequence(
    weaponInInventoryCondition(),
    equipBestAction(keeper),
  );
}

// conjure_weapon: a sequence whose FIRST condition is knows_create_weapon.
// This is the fix: a character that does not know the spell fails this
// sequence on its very first tick, which propagates up through the outer
// selector and lands on travel_and_buy. There is no "wait for mana" branch
// here, because the previous bug was the wait branch itself.
export function conjureWeaponSequence(keeper) {
  return sequence(
    knowsCreateWeaponCondition(),
    manaAtLeastCondition(15),
    castCreateWeaponAction(keeper),
  );
}

// get_armed: the proof-of-concept subtree. Tries each arm in priority order:
//
//   1. Already wielding a weapon -> SUCCESS, nothing to do.
//   2. A weapon in the pack -> equip it.
//   3. Knows create weapon AND has 15 mana -> conjure one.
//   4. Otherwise -> walk to a smith and buy the cheapest one.
//
// arms 2 and 3 are sequences, so they fail (and fall through) the moment any
// one of their conditions is false. Arm 4 is unconditional -- it is the
// thing that was missing overnight, when characters without the spell sat
// forever waiting for mana to arrive.
//
// Pass `{ keeper }` (or both `{ session, keeper }` if the keeper is reached
// via a session object) and tick the returned tree against a blackboard
// shaped like `{ client, session }`.
export function getArmedTree(opts = {}) {
  const keeper = opts.keeper || opts.session?.keeper;
  if (!keeper) {
    throw new Error('getArmedTree requires opts.keeper (or opts.session.keeper)');
  }
  return selector(
    wieldingWeaponCondition(),
    equipFromPackSequence(keeper),
    conjureWeaponSequence(keeper),
    travelAndBuyAction(keeper),
  );
}

// updateBlackboard: a thin convenience that snapshots the live client into a
// plain blackboard object before each tick. Trees should never reach behind
// `bb.client` for state, but GOAP writes strategic fields (assigned_room,
// purpose, etc.) here so a single helper can rebuild the snapshot in one
// place. Currently unused by getArmedTree -- the conditions read the live
// client directly -- but exported for the wiring step (refactor that lives
// behind the next task).
export function updateBlackboard(bb, { client, session, policy } = {}) {
  if (!bb) return bb;
  if (client !== undefined) bb.client = client;
  if (session !== undefined) bb.session = session;
  if (policy !== undefined) bb.policy = policy;
  if (!bb._bt) bb._bt = {};
  return bb;
}
