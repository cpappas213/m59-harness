// m59-bt-recover.mjs -- post-death loot recovery node for the BT flee tree.
//
// When a character dies, everything it was carrying drops on the floor at the
// death location. The character respawns in the Underworld, escapes to the
// nearest city, and starts farming again with an empty pack. The dropped items
// (weapon, gold, reagents, gems) are gone unless someone goes back and picks
// them up.
//
// This node handles that. It sits in the flee tree, after `doomed` and
// `flee_threshold` but before `sanctuary_settle`. It fires when:
//   1. The character just died (lastDeath is recent, < 30 minutes)
//   2. The character is alive and has recovered enough HP to travel
//   3. The death room is reachable from the current position
//   4. The character hasn't already recovered from this death
//
// When it fires, it:
//   1. Travels to the death room
//   2. Looks for dropped items on the floor
//   3. Picks them up
//   4. Returns to the assigned room (or the nearest town)
//   5. Marks the death as recovered
//
// The node returns RUNNING while travelling/picking up, and SUCCESS when the
// recovery is complete. It returns FAILURE when there's nothing to recover
// (no recent death, or the character is still in the Underworld).

import { FAILURE, SUCCESS, RUNNING } from './m59-bt.mjs';

// Local AsyncAction helper (same pattern as m59-bt-flee.mjs).
class AsyncAction {
  constructor(fn) { this.fn = fn; }
  tick() { return RUNNING; }
  async tickAsync(bb) { return this.fn(bb); }
}
const asyncAction = (fn) => new AsyncAction(fn);

// How long after a death the recovery window stays open. Items on the floor
// persist until looted or cleaned up by the room. The window must cover the full
// cycle: death -> underworld escape -> travel to inn -> regen to 80% HP ->
// travel back to the death room. Thirty minutes covers that with margin.
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;

// Minimum HP fraction to attempt recovery. Travelling through hostile rooms
// with 50% HP is a second death waiting to happen. 80% is the line: enough
// to fight if ambushed, not so high that recovery is blocked for an hour.
const MIN_HP_FRACTION = 0.8;

export function lootRecoveryNode(keeper) {
  return asyncAction(async (bb) => {
    const k = keeper;
    const lastDeath = k.lastDeath;

    // 1. No recent death: nothing to recover.
    if (!lastDeath) return FAILURE;
    const age = Date.now() - lastDeath.at;
    if (age > RECOVERY_WINDOW_MS) return FAILURE;

    // 2. Already recovered from this death: don't loop.
    if (k._recoveredDeathAt === lastDeath.at) return FAILURE;

    // 3. Need enough HP to travel safely.
    const c = k.s?.client;
    if (!c?.self) return FAILURE;
    const hp = c.self.health ?? 0;
    const maxHp = c.self.maxHealth ?? 1;
    if (hp / maxHp < MIN_HP_FRACTION) {
      // Not ready yet. Throttle the note.
      if (!k._recoverNotReadyNotedAt || Date.now() - k._recoverNotReadyNotedAt > 30_000) {
        k._recoverNotReadyNotedAt = Date.now();
        k.note?.('loot recovery: waiting for HP', {
          hp, maxHp, need: Math.round(MIN_HP_FRACTION * 100) + '%',
          death_age_s: Math.round(age / 1000),
        });
      }
      return FAILURE;
    }

    // 4. Need a death room to travel to.
    const deathRoom = lastDeath.room_num;
    if (!deathRoom) return FAILURE;

    // 5. Are we already in the death room? (e.g. died and respawned nearby)
    const currentRoom = k.s?.world?.room?.num;
    if (currentRoom === deathRoom) {
      // Pick up items in the current room.
      const picked = await k._pickUpDropped?.() ?? [];
      if (picked.length) {
        k._recoveredDeathAt = lastDeath.at;
        return SUCCESS;
      }
      k._recoveredDeathAt = lastDeath.at;
      return FAILURE;
    }

    // 6. Travel to the death room.
    const started = Date.now();
    const result = await k.travelToRoom?.(deathRoom, { maxHops: 20 });

    if (result?.arrived) {
      // Arrived at the death room. Pick up items.
      const picked = await k._pickUpDropped?.() ?? [];
      if (picked.length) {
        k.note?.('loot recovery: picked up dropped items', {
          room: lastDeath.died_in,
          death_age_s: Math.round(age / 1000),
          items: picked,
        });
        k._recoveredDeathAt = lastDeath.at;
        // Return to the assigned room.
        const assigned = k.policy?.assignedRoom;
        if (assigned && assigned !== deathRoom) {
          await k.travelToRoom?.(assigned, { maxHops: 20 }).catch(() => {});
        }
        return SUCCESS;
      }
      // Nothing to pick up (already looted or cleaned up).
      k.note?.('loot recovery: nothing to pick up', {
        room: lastDeath.died_in,
        hint: 'items may have been looted by another player or cleaned up',
      });
      k._recoveredDeathAt = lastDeath.at;
      return FAILURE;
    }

    // Travel failed.
    if (!result?.arrived) {
      if (!k._recoverTravelFailNotedAt || Date.now() - k._recoverTravelFailNotedAt > 60_000) {
        k._recoverTravelFailNotedAt = Date.now();
        k.note?.('loot recovery: cannot reach death room', {
          death_room: lastDeath.died_in,
          death_room_num: deathRoom,
          reason: result?.reason || 'no route',
        });
      }
      return FAILURE;
    }

    return RUNNING;
  });
}
