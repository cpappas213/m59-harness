#!/usr/bin/env node
// m59-act/scavenge.mjs -- THE SCAVENGE ATOMIC. Fight the weakest
// creature in the room to loot money or items.
//
// This is the "punch rats" fallback: when a character is unarmed,
// broke, and can't cast create weapon, the only way to get money
// is to fight something weak and loot what it drops.
//
// WHAT THE ATOMIC DOES:
//   1. Finds the weakest hostile in the room (lowest max HP).
//   2. Refuses if the target is above the character's level band
//      (fighting a level 50 fungus beast with bare fists is not
//      scavenging, it is suicide).
//   3. Delegates to the legacy fight() for the actual combat.
//   4. After the fight, picks up any dropped items.
//
// CONTRACT: (client, session) -> { sent, killed, reason }
//   - sent: true when the fight was started
//   - killed: true when the target died
//   - reason: null on success, a description of what went wrong

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .fight, .step, etc.)
 */

// Health fraction: 0..1, or null if unreadable.
function frac(v) {
  const val = v?.value, max = v?.max;
  if (val == null || max == null || max === 0) return null;
  return val / max;
}

import { wanderAway } from '../m59-wander.mjs';
import { affordances, OF } from '../m59-parse.mjs';

export async function scavenge(client, session) {
  if (!client || !session)
    return { sent: false, killed: false, reason: 'no client or session' };

  const room = client?.room;
  if (!room) return { sent: false, killed: false, reason: 'no room' };

  // Find hostiles in the room.
  const objects = room.objects;
  const list = objects instanceof Map
    ? [...objects.values()]
    : Array.isArray(objects) ? objects : [];

  const hostiles = list.filter(o => {
    // Raw room objects have o.flags (bit flags), NOT o.can (action list).
    // The action list is derived from flags via affordances().
    if (o.id === client?.selfId) return false; // never target self
    if (o.flags & OF.PLAYER) return false; // players are handled by the PVP gate, not scavenge
    const can = affordances(o.flags ?? 0);
    if (!can.includes('attack')) return false;
    const name = client?.rsc?.get?.(o.nameRsc) ?? '';
    if (/friendly|pet|tame/i.test(name)) return false;
    return true;
  });

  if (!hostiles.length) {
    // No hostiles: walk a few steps toward where mobs are likely to be, then wait.
    // See wanderAway() — extracted so the atomic body has no loop around an await.
    wanderAway(client, session);
    return { sent: false, killed: false, reason: 'no hostiles in the room' };
  }

  // Pick the weakest (lowest max HP, or lowest HP as a fallback).
  const myLevel = client?.vitals?.()?.health?.max ?? 20;
  const hpFrac = frac(client?.vitals?.()?.health);
  const weak = hostiles
    .filter(h => {
      const hp = h.max_health ?? h.health ?? null;
      return hp == null || hp <= myLevel * 1.5;
    })
    .sort((a, b) => (a.max_health ?? a.health ?? 999) - (b.max_health ?? b.health ?? 999))[0];

  const target = weak ?? hostiles.sort((a, b) =>
    (a.max_health ?? a.health ?? 999) - (b.max_health ?? b.health ?? 999))[0];

  const targetName = client?.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
  const targetHp = target.max_health ?? target.health ?? '?';
  const tooStrong = targetHp > myLevel * 2;

  if (tooStrong)
    return { sent: false, killed: false,
      reason: `weakest hostile (${targetName} hp=${targetHp}) is still above the band (my level=${myLevel})` };

  // PVP GATE: if the target is a player, only fight if we can take
  // them on. The character runs from players unless it is armed,
  // healthy, and the player is in its level band. This is the
  // "run unless you can win" policy for farming characters.
  if (target.is_player === true) {
    const armed = client?.equipment?.()?.equipped?.length > 0;
    const healthy = hpFrac != null && hpFrac >= 0.7;
    const inBand = typeof targetHp === 'number' && targetHp <= myLevel * 1.5;
    if (!armed || !healthy || !inBand)
      return { sent: false, killed: false,
        reason: `player target (${targetName}) — not engaging (armed=${armed}, healthy=${healthy}, inBand=${inBand}); flee instead` };
  }

  // TAKE A SAFE SPOT BEFORE FIGHTING. A wall or corner reduces the
  // number of directions enemies can attack from. Skip this when the
  // target is far away (> 10 cells) — crossing the room to a wall
  // first wastes time and can trap the character in an unwalkable
  // pocket (Twisted Wood geometry mismatch). Close-range fights
  // still take the safe spot.
  const mePos = client?.self;
  const targetCol = target.col ?? null;
  const targetRow = target.row ?? null;
  const distToTarget = (mePos && targetCol != null && targetRow != null)
    ? Math.abs(mePos.col - targetCol) + Math.abs(mePos.row - targetRow)
    : 0;
  const shouldTakeSafeSpot = distToTarget <= 10;
  if (shouldTakeSafeSpot) {
    if (session.s?.takeSafeSpot && typeof session.s.takeSafeSpot === 'function') {
      await session.s.takeSafeSpot({ maxSteps: 10 }).catch(() => {});
    } else if (session.takeSafeSpot && typeof session.takeSafeSpot === 'function') {
      await session.takeSafeSpot({ maxSteps: 10 }).catch(() => {});
    }
  }

  // Delegate to the skills.fight() function. It takes the broker
  // session and a creature NAME (not an ID) and handles the full
  // combat loop (walk to target, swing, check result, repeat).
  const { fight: doFight } = await import('../m59-skills.mjs');
  const r = await doFight(session, { target: targetName, preferId: target.id ?? target.obj_id ?? null, rounds: 12, swingsPerRound: 4 });
  return {
    sent: true,
    killed: r?.killed ?? r?.won ?? false,
    reason: r?.killed || r?.won ? null : (r?.reason ?? 'fight did not end in a kill'),
  };
}

// No precondition: scavenge is always available. When there is no
// target, it waits for the next pass (mobs may be respawning).
// The planner can always plan scavenge to satisfy has_money/has_loot,
// and the execution either fights or idles.
scavenge.pre = [];

// Effect: optimistically, the fight produced loot. The next pass
// re-evaluates has_loot from the actual inventory.
scavenge.effects = ['has_loot', 'has_money'];  // fighting drops gold AND items

scavenge.atomic = 'scavenge';
scavenge.mutates = true;  // sends combat packets; the room and inventory change
scavenge.cost = 3;        // a fight is expensive: time, risk, vigor
