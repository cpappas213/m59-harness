#!/usr/bin/env node
// m59-bt-farm.mjs -- behavior-tree nodes for the keeper's farm (hunting) pass.
//
// Decomposes the ~1,300-line sequential passFarm() into a tree of small,
// testable nodes. Each node has a clear precondition and a single effect.
// The tree is ticked in priority order (selector): the highest-priority
// concern that applies this pass wins, and the rest is skipped.
//
// Priority order (highest first):
//   1. provision       -- eat food if hungry
//   2. auto_retarget   -- prey pays nothing, switch
//   3. room_invalid    -- this room can't spawn the prey, travel
//   4. bags_full       -- sell/drop junk
//   5. cap_blocked     -- room at spawn cap, clear or leave
//   6. no_hunt_target  -- nothing named to hunt, hibernate
//   7. no_target_found -- empty room, wait or roam
//   8. unarmed         -- arm self
//   9. too_hurt        -- heal or ask for help
//   10. too_tired      -- rest up
//   11. safe_wall      -- take/require a wall
//   12. fight          -- engage, pull, loot
//
// Each node is a factory: it takes a keeper reference and returns a BT node.
// The blackboard (bb) carries the live session state, refreshed by
// updateBlackboard() before each tick.
//
// No broker, no I/O -- the nodes call keeper methods that do the I/O.

import {
  Selector, Sequence, Condition, Action,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';
import { updateBlackboard } from './m59-bt-nodes.mjs';
import * as skills from './m59-skills.mjs';

// The combat/rest skill set, shaped the way the nodes below consume it. This is
// the module that used to be m59-combat.mjs -- it was renamed to m59-skills.mjs
// when the bt-keeper branch merged, and these dynamic imports still pointed at the
// old name. The .catch(() => ({ skills: null })) swallowed the failed import, so
// tooTiredNode called restUntil() on undefined and the character logged "resting"
// every pass while never once sitting. Import statically and hand the nodes a
// live object instead.
const getSkills = () => skills;

// AsyncAction: wraps an async function into a BT Action node.
// The async tick() on the tree handles the awaiting.
class AsyncAction {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `aa_${Math.random().toString(36).slice(2, 10)}`;
    this._name = opts.name || 'AsyncAction';
  }
  // Synchronous tick: starts the promise, returns RUNNING.
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.done) { delete bb._bt[this.key]; return slot.result; }
    if (slot && slot.promise) return RUNNING;
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      bb._bt[this.key] = { promise: p, done: false, result: null };
      p.then(r => { bb._bt[this.key].done = true; bb._bt[this.key].result = r; },
             e => { bb._bt[this.key].done = true; bb._bt[this.key].result = FAILURE; });
      return RUNNING;
    }
    return p ?? FAILURE;
  }
  // Async tick: awaits the promise and returns its result.
  async tickAsync(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.promise) {
      try {
        const result = await slot.promise;
        delete bb._bt[this.key];
        return result;
      } catch {
        delete bb._bt[this.key];
        return FAILURE;
      }
    }
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      try { return await p; } catch { return FAILURE; }
    }
    return p ?? FAILURE;
  }
}

// Helper: create an AsyncAction from an async function
const asyncAction = (fn, opts) => new AsyncAction(fn, opts);

// ---------------------------------------------------------------------------
// Helper: read vitals from the blackboard
// ---------------------------------------------------------------------------

function vitals(bb) {
  return bb.session?.s?.client?.vitals?.() ?? {};
}
function hpFrac(bb) {
  const v = vitals(bb);
  return v.health?.max ? v.health.value / v.health.max : null;
}
function vigorOf(bb) {
  const v = vitals(bb);
  return v.vigor?.value ?? null;
}

// ---------------------------------------------------------------------------
// Node: provision (eat food if hungry)
// ---------------------------------------------------------------------------

export function provisionNode(keeper) {
  return asyncAction(async (bb) => {
    const plan = keeper._btFarmStrategy();
    const result = await keeper.provision(plan, vitals(bb));
    // Only a real meal ends the pass; "stomach full" falls through.
    if (result === 'ate') {
      return SUCCESS;
    }
    return FAILURE;
  });
}

// ---------------------------------------------------------------------------
// Node: auto_retarget (prey pays nothing, switch)
// ---------------------------------------------------------------------------

export function autoRetargetNode(keeper) {
  return asyncAction(async (bb) => {
    const p = keeper.policy;
    if (!p.purpose || !p.hunt) return FAILURE;
    const yc = keeper.yieldCheck();
    if (!yc || yc.paying !== false) return FAILURE;

    const { loadSpawns, scorePrey } = await import('./m59-spawns.mjs');
    const spawns = loadSpawns(keeper._btFarmSpawnFile());
    const maxHealth = keeper.s.client?.vitals?.()?.health?.max ?? 0;
    const stamina = keeper.s.client?.statsById?.get?.('stamina')?.value;
    if (!spawns || !maxHealth) return FAILURE;

    const result = scorePrey(spawns, {
      maxHealth,
      stamina: Number.isFinite(stamina) && stamina > 0 ? stamina : 0,
      purpose: p.purpose,
      goals: p.goals ?? [],
      over: typeof p.maxThreatOver === 'number' ? p.maxThreatOver : 20,
      limit: 1,
      want: p.karma ?? null,
    });
    const best = result.candidates?.[0];
    if (!best || best.creature === p.hunt) return FAILURE;

    keeper.note('auto-retarget: prey pays nothing, switching', {
      was: p.hunt, now: best.creature,
      reason: (yc.why ? [].concat(yc.why).join('; ') : 'yieldCheck: paying=false'),
      best_room: best.best_room,
      purpose: p.purpose,
    });
    p.hunt = best.creature;
    if (p.assignedRoom != null) {
      keeper.note('auto-retarget: clearing assignedRoom that was for old prey', {
        cleared: p.assignedRoom });
      p.assignedRoom = null;
    }
    keeper.unreachable.clear();
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: room_invalid (this room can't spawn the prey, travel)
// ---------------------------------------------------------------------------

export function roomInvalidNode(keeper) {
  return asyncAction(async (bb) => {
    const room = bb.room;
    if (!room) return FAILURE;
    const p = keeper.policy;

    const { loadSpawns, creatureMatchesHunt } = await import('./m59-spawns.mjs');
    const spawns = loadSpawns(keeper._btFarmSpawnFile());
    const here = (spawns?.rooms?.[room.num] || []).filter(x => x.huntable);
    const preyHere = here.some(x => creatureMatchesHunt(x, p.hunt));

    const denied = keeper._btFarmDeniedRooms();
    const offAssignment = keeper._btFarmShouldRelocate(room, denied);

    if (preyHere && !offAssignment) return FAILURE;

    const known = keeper.preyRooms(room);
    if (!known.length) return FAILURE;
    const target = known[0];

    if (!await keeper.readyToLeaveSanctuary(target.room_name)) return RUNNING;

    keeper.note(offAssignment ? 'leaving for the explicitly assigned farming room'
                              : 'this room cannot produce our prey -- leaving now', {
      room: room.name, hunting: p.hunt,
      going_to: target.room_name,
    });
    keeper.doing = 'travelling';
    const hold = await keeper.leaveHold('travelling to a room that generates our prey');
    if (hold.refused) return RUNNING;

    const r0 = await keeper.travel(target.room, { maxHops: 14 })
                         .catch(e => ({ arrived: false, reason: e.message }));
    if (r0.arrived) {
      keeper.homeRoom = target.room;
      keeper.emptyPasses = 0;
      keeper.progress('moved to a room that generates the prey');
    } else {
      keeper.noProgress('cannot reach anywhere that generates ' + p.hunt);
    }
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: bags_full (sell/drop junk)
// ---------------------------------------------------------------------------

export function bagsFullNode(keeper) {
  return asyncAction(async (bb) => {
    const c = bb.client;
    const p = keeper.policy;
    // Sweep broken gear first (cheap, runs on its own clock)
    await keeper.sweepBroken().catch(() => {});
    await keeper.sweepGearCondition().catch(() => {});

    if (c.inventory.length < p.maxCarry) return FAILURE;
    const freed = await keeper.makeRoom();
    keeper.note('bags full -- ' + freed.did, {
      carrying: c.inventory.length, max: p.maxCarry, ...freed.detail });
    if (freed.ok) keeper.progress('made room in bags');
    else keeper.noProgress('bags full and could not make room');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: cap_blocked (room at spawn cap, clear or leave)
// ---------------------------------------------------------------------------

export function capBlockedNode(keeper) {
  return asyncAction(async (bb) => {
    const room = bb.room;
    if (!room || keeper.policy.clearWeak === false) return FAILURE;
    const capped = keeper.capBlockers(room);
    if (!capped?.should_clear && !(capped?.full && !capped.clearable.length && capped.blocked.length))
      return FAILURE;

    if (capped.should_clear && capped.clearable.length) {
      const target = capped.clearable[0];
      const shot = keeper._btFarmFindCreature(target.name);
      if (shot.length) {
        keeper.clearing = target.name;
        keeper.note('clearing the room so it can spawn again', {
          killing: target.name, of_them: target.count,
          room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
        });
        // Fall through to the fight node by returning FAILURE
        return FAILURE;
      }
    }

    if (capped.full && !capped.clearable.length && capped.blocked.length) {
      const reason = `spawn cap ${capped.present}/${capped.cap} is occupied by ` +
        capped.blocked.map(b => `${b.count}x ${b.name}`).join(', ');
      (keeper.cappedRooms ??= new Map()).set(room.num, reason);
      keeper.note('this room is capped by things we will not fight', {
        room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
      });
      const elsewhere = keeper.preyRooms(room);
      if (elsewhere.length) {
        keeper.doing = 'travelling';
        await keeper.leaveHold('leaving a room whose spawn cap cannot recover',
                               { force: true }).catch(() => {});
        const go = elsewhere[0];
        const moved = await keeper.travel(go.room, { maxHops: 14 })
                                .catch(e => ({ arrived: false, reason: e.message }));
        if (moved.arrived) {
          keeper.homeRoom = go.room;
          keeper.emptyPasses = 0;
          keeper.progress('left a room whose spawn cap cannot recover');
          return SUCCESS;
        }
      }
      keeper.noProgress('room capped by creatures we will not fight');
      return SUCCESS;
    }
    return FAILURE;
  });
}

// ---------------------------------------------------------------------------
// Node: no_hunt_target (nothing named to hunt)
// ---------------------------------------------------------------------------

export function noHuntTargetNode(keeper) {
  return asyncAction(async (bb) => {
    if (keeper.policy.hunt) return FAILURE;
    if (await keeper.hibernate('farm mode with nothing named to hunt').catch(() => false))
      return SUCCESS;
    keeper.note('idle: nothing to hunt', { hint: 'set policy.hunt to a creature name' });
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: no_target_found (empty room, wait or roam)
// ---------------------------------------------------------------------------

export function noTargetFoundNode(keeper) {
  return asyncAction(async (bb) => {
    const room = bb.room;
    const found = keeper._btFarmFoundTargets();
    if (found.length) return FAILURE;

    // Holding a wall in a spawning room: waiting is the job -- and a waiting
    // character SITS. Standing still regens nothing, so without this the
    // character idles at whatever vigor a fight left it at, with no path back to
    // fighting strength. Sitting is always safe in a proven spot, and restUntil()
    // aborts the moment every vital is at its cap or something hits us.
    const waitingInASpot = !!keeper.hold && keeper.holdWorks() && !keeper.sanctuary(room);
    if (waitingInASpot) {
      keeper.doing = 'waiting';
      const v = vitals(bb);
      const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max : null;
      const hp = v.health?.max ? v.health.value / v.health.max : 1;
      const whole = (vigPct ?? 1) >= 0.4 && (hp ?? 1) >= 0.98;
      if (!whole) {
        await keeper._btFarmRestWhileWaiting?.().catch(() => {});
        keeper.tally.rests = (keeper.tally.rests || 0) + 1;
        keeper.note('resting in a proven spot while we wait for a spawn', {
          vigor: v.vigor?.value, health: v.health?.value,
        });
      }
      return SUCCESS;
    }

    keeper.emptyPasses++;
    const barren = keeper.sanctuary(room);
    if (barren && keeper.emptyPasses >= 2) {
      const home = keeper.policy.assignedRoom ?? keeper.homeRoom;
      if (home != null && home !== room?.num) {
        if (!await keeper.readyToLeaveSanctuary(home)) return RUNNING;
        keeper.note('this room spawns nothing at all -- going back to work', {
          room: room?.name, going_to: home });
        keeper.doing = 'travelling';
        const moved = await keeper.travel(home, { maxHops: 20 })
                              .catch(e => ({ arrived: false, reason: e.message }));
        if (moved.arrived) { keeper.emptyPasses = 0; keeper.progress('left a room that spawns nothing'); return SUCCESS; }
      }
    }
    if (keeper.policy.roam && keeper.emptyPasses >= keeper.policy.roamAfterEmptyPasses) {
      await keeper.roam(room);
    } else {
      // In the right room, nothing to fight yet: wait for a spawn. Standing still
      // regens nothing, so if we are below the regen ceiling we sit and recover
      // vigor/health/mana while the room cycles. restUntil() aborts the moment a
      // rat spawns in reach or anything hits us, so a spawn never delays the fight
      // by more than one 3s tick. (Same call as the hold-a-spot branch above -- a
      // character with no hold is the more common case: it is here, not holding.
      //) Without this, a character parked in a valid room with no rat present idled
      // at whatever vigor a fight left it at, for ever, doing nothing.
      const v = vitals(bb);
      const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max
                                    : (v.vigor?.scale_max ? v.vigor.value / v.vigor.scale_max : null);
      const hp = v.health?.max ? v.health.value / v.health.max : 1;
      const whole = (vigPct ?? 1) >= 0.4 && (hp ?? 1) >= 0.98;
      if (!whole) {
        keeper.doing = 'waiting';
        await keeper._btFarmRestWhileWaiting?.().catch(() => {});
        keeper.tally.rests = (keeper.tally.rests || 0) + 1;
        keeper.note('resting while we wait for a spawn', {
          looking_for: keeper.policy.hunt, room: room?.name,
          vigor: v.vigor?.value, health: v.health?.value,
        });
      } else {
        keeper.note('nothing to hunt here', {
          looking_for: keeper.policy.hunt, room: room?.name,
          empty_passes: keeper.emptyPasses,
        });
      }
    }
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: unarmed (arm self)
// ---------------------------------------------------------------------------

export function unarmedNode(keeper) {
  return asyncAction(async (bb) => {
    const c = bb.client;
    const skills = getSkills();
    if (!skills) {
      // Fall back to the keeper's own check
      if (keeper.armed()) return FAILURE;
    }
    const weapons = skills ? skills.weaponsOf(c) : (keeper.armed() ? [c] : []);
    if (weapons.length) {
      keeper.clearRefusal('UNARMED_NO_DONOR');
      if (keeper.waitingOn?.code === 'MANA_FOR_CREATE_WEAPON') keeper.doneWaiting();
      return FAILURE;
    }
    const armed = await keeper.armSelf().catch(() => false);
    if (!armed) {
      keeper.note('about to fight unarmed', {
        mana: c?.vitals?.()?.mana?.value,
      });
    }
    return armed ? SUCCESS : FAILURE;
  });
}

// ---------------------------------------------------------------------------
// Node: too_hurt (heal or ask for help)
// ---------------------------------------------------------------------------

export function tooHurtNode(keeper) {
  return asyncAction(async (bb) => {
    const hp = hpFrac(bb);
    if (hp == null) return FAILURE;
    const safe = keeper.safety();
    if (hp >= safe.engageAt) return FAILURE;

    const skills = getSkills();
    if (!skills) return FAILURE;
    const h = await skills.healUp(keeper.s, { target: 0.95 }).catch(() => ({ healed: false }));
    keeper.recordHealUse(h, 'too hurt to start the fight in front of us');
    if (h.healed) {
      keeper.note('healed before engaging', { used: h.used, health: h.health });
      return FAILURE; // healed, fall through to fight
    }
    keeper.note('too hurt to start a fight', {
      health: Math.round(hp * 100) + '%',
      need: Math.round(safe.engageAt * 100) + '%',
    });
    if (hp < 0.35)
      await keeper.askForHelp('badly hurt and out of flasks').catch(() => {});
    keeper.doing = 'recovering';
    keeper.progress('recovering to fighting strength');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: too_tired (rest up)
// ---------------------------------------------------------------------------

export function tooTiredNode(keeper) {
  return asyncAction(async (bb) => {
    const v = vigorOf(bb);
    const floor = keeper.fightFloor();
    if (v == null || v >= floor) return FAILURE;

    keeper.vigor.waited++;
    keeper.doing = 'recovering';
    if (!keeper.hold && keeper.policy.useSafeSpots && bb.room)
      await keeper.takeSafeSpot('too tired to fight -- need somewhere safe to rest', null).catch(() => {});
    const skills = getSkills();
    const r = skills
      ? await skills.restUntil(keeper.s, { health: 0.98, vigor: 0.4, maxSeconds: 120 }).catch(() => null)
      : null;
    keeper.tally.rests++;
    keeper.note('too tired to start a fight', {
      vigor: v, need: floor,
    });
    keeper.progress('resting up to fighting vigor');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: fight (engage, pull, loot)
// ---------------------------------------------------------------------------

export function fightNode(keeper) {
  return asyncAction(async (bb) => {
    const c = bb.client;
    const room = bb.room;
    const found = keeper._btFarmFoundTargets();
    if (!found.length) return FAILURE;

    // Rank quarries
    const { rankQuarries, claimQuarry, releaseQuarry, party } = await import('./m59-fleet.mjs').catch(() => ({}));
    if (rankQuarries && claimQuarry) {
      const agreed = party?.agreedTarget?.(keeper.s.name);
      const preferId = found.some(o => o.id === keeper.foeId) ? keeper.foeId
        : found.some(o => o.id === agreed?.id) ? agreed.id : null;
      const ranked = rankQuarries(keeper.s.name, room?.num, found, { preferId });
      claimQuarry(keeper.s.name, room?.num, ranked[0]?.id);
    } else {
      releaseQuarry?.(keeper.s.name);
    }

    // Check for bystander (something hitting us)
    const adjacent = keeper.inReachOfUs?.() ?? [];
    const want = String(keeper.clearing || keeper.policy.hunt || '').toLowerCase();
    const bystander = adjacent.find(o =>
      !(c.rsc.get(o.nameRsc) || '').toLowerCase().includes(want));

    let engageName = bystander ? c.rsc.get(bystander.nameRsc)
                               : (keeper.clearing || keeper.policy.hunt);

    // Fight
    const safe = keeper.safety();
    const f = await keeper._btFarmFight(engageName, found, room, safe);

    // The legacy fight path (m59-autopilot.mjs:9776) does four things after fight() that
    // this node used to skip. Skipping them is why a BT character fights worse than a
    // legacy one in the same room: it never resumes the rat it was already wounding
    // (foe_id is thrown away, so the next fight re-picks a healed rat), it never sets
    // swungAt (the stall detector reads that), it treats a stale object id as a lost
    // fight, and when it breaks off at low health it just sits and waits to be hit
    // again instead of resting behind the wall or retreating.
    keeper.swungAt = Date.now();
    keeper.foeId = f.foe_id ?? null;

    if (f.killed) {
      releaseQuarry?.(keeper.s.name);
      keeper.tally.kills++;
      keeper.progress('killed something');
      keeper.note('killed', { target: f.target, rounds: f.rounds });
    } else if (f.died) {
      releaseQuarry?.(keeper.s.name);
      keeper.noProgress('died in a fight');
      keeper.note('died', { target: f.target, rounds: f.rounds });
    } else if (f.stale_identity) {
      // fight() proved the character is alive; its object id just went stale (a save
      // renumbered ids under a live session). Reconnect for a fresh id rather than
      // looping forever on a fight that reads as lost.
      keeper.note('stale object id during a fight -- reconnecting', { why: f.note });
      await keeper.reconnect('clearing a stale object id mid-fight').catch(() => {});
      keeper.noProgress('reconnected after a stale object id');
    } else if (f.disengaged) {
      // Broke off at low health mid-fight. The recovery move depends on where we stand.
      // Behind a proven safe spot, sitting still IS the heal (nothing can hit us unless
      // we swing first), so rest here. Otherwise the monster is still hostile and we
      // must leave the room before resting, or it keeps hitting us.
      const holding = !!keeper.hold && keeper.holdWorks?.();
      if (holding) {
        keeper.note('broke off behind the wall -- resting here rather than running', {
          at_health: f.disengaged.at_health, mid_round: !!f.disengaged.mid_round });
        const skills = getSkills();
        await skills.restUntil(keeper.s, { health: 0.95, vigor: 0.4, maxSeconds: 120 }).catch(() => null);
        keeper.progress('rested after breaking off a fight');
      } else {
        await keeper.retreatToSafety?.({
          because: 'broke off a fight at ' + (f.disengaged.at_health ?? '?'),
          mid_round: !!f.disengaged.mid_round,
        }).catch(() => {});
        keeper.progress('retreated after breaking off a fight');
      }
    } else {
      // A fight that ended with no kill, no death, no disengage, no stale id: it ran
      // the rounds out or the target slipped out of reach. Name what actually happened
      // instead of the generic line.
      const why = f.drifted_out_of_reach
        ? 'broke off -- the prey moved out of reach while holding position'
        : (f.landed_hits > 0
           ? 'broke off with hits landed but no kill (resuming the wounded prey)'
           : 'broke off without a landed hit or a kill');
      keeper.noProgress(why);
      keeper.note(f.drifted_out_of_reach ? 'prey drifted out of reach' : 'broke off', {
        target: f.target, rounds: f.rounds, landed_hits: f.landed_hits ?? 0,
      });
    }
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// The farm tree
// ---------------------------------------------------------------------------

/**
 * Build the farm behavior tree.
 *
 * @param {object} opts
 * @param {object} opts.session - the keeper instance
 * @returns {Selector} the farm tree root
 */
export function getFarmTree(opts = {}) {
  const keeper = opts.session?.keeper;
  if (!keeper) throw new Error('getFarmTree: no keeper supplied');

  const children = [
    provisionNode(keeper),
    autoRetargetNode(keeper),
    roomInvalidNode(keeper),
    bagsFullNode(keeper),
    capBlockedNode(keeper),
    noHuntTargetNode(keeper),
    noTargetFoundNode(keeper),
    unarmedNode(keeper),
    tooHurtNode(keeper),
    tooTiredNode(keeper),
    fightNode(keeper),
  ];

  return {
    // Synchronous tick (for compatibility with the existing BT framework)
    tick: (bb) => {
      for (const child of children) {
        const r = child.tick(bb);
        if (r === SUCCESS || r === RUNNING) return r;
      }
      return FAILURE;
    },
    // Async tick: awaits each node's promise before moving to the next
    tickAsync: async (bb) => {
      for (const child of children) {
        if (typeof child.tickAsync === 'function') {
          const r = await child.tickAsync(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        } else {
          const r = child.tick(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        }
      }
      return FAILURE;
    },
  };
}
