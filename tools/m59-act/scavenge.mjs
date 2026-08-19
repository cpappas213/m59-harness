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
import { readFileSync, existsSync } from 'node:fs';

// Compendium spawn data: room number -> [{creature, level, ...}].
// Used to filter targets by level when the wire protocol doesn't
// send mob HP/level data.
let _spawns = null;
function loadSpawns() {
  if (_spawns) return _spawns;
  const file = 'substrate/m59-spawns.json';
  if (!existsSync(file)) return null;
  try { _spawns = JSON.parse(readFileSync(file, 'utf8')); } catch { _spawns = null; }
  return _spawns;
}

// Find the compendium level for a mob name in a given room.
// Returns the level or null if not found.
function compendiumLevel(roomNum, mobName) {
  const spawns = loadSpawns();
  if (!spawns?.rooms) return null;
  const name = String(mobName).toLowerCase();
  // First try the specific room.
  const entries = spawns.rooms[String(roomNum)];
  if (entries) {
    const match = entries.find(e => e.creature?.toLowerCase() === name);
    if (match) return match.level;
  }
  // Fall back to a global search: the compendium may not list this
  // mob for this specific room. The level is the same regardless.
  for (const entries2 of Object.values(spawns.rooms)) {
    const match2 = entries2.find(e => e.creature?.toLowerCase() === name);
    if (match2) return match2.level;
  }
  return null;
}

export async function scavenge(client, session, opts = {}) {
  if (!client || !session)
    return { sent: false, killed: false, reason: 'no client or session' };

  const room = client?.room;
  if (!room) return { sent: false, killed: false, reason: 'no room' };

  // Threat ceiling: the GOAP keeper passes this so the scavenge uses the
  // same band definition as the planner (myLevel + threatBand). Without it,
  // fall back to myLevel * 2 (the old, looser check). This was the bug:
  // the GOAP said the rat was out of band (ceiling=20) but the scavenge's
  // own check (20*2=40) said it was fine, so the character walked toward
  // a mob it should have been running from.
  const myLevel = client?.vitals?.()?.health?.max ?? 20;
  const ceiling = opts.threatCeiling ?? myLevel * 2;

  // Find hostiles in the room.
  const objects = room.objects;
  const list = objects instanceof Map
    ? [...objects.values()]
    : Array.isArray(objects) ? objects : [];

  // HEALTH GATE: if we're below 50% HP, don't start a new fight.
  // The GOAP's hurt symbol uses 70% (restBelow), but there's a timing
  // gap where HP drops during a pass and the world state is stale.
  // This is the last line of defense: even if the GOAP says "go fight",
  // the scavenge itself refuses when the character is too hurt to
  // survive another engagement. The GOAP will re-evaluate on the
  // next pass with fresh vitals and switch to recover/flee.
  const hpNow = frac(client?.vitals?.()?.health);
  if (hpNow != null && hpNow < 0.5)
    return { sent: false, killed: false,
      reason: `HP too low to fight (${Math.round(hpNow * 100)}%) — need to recover first` };

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

  // LEVEL FILTER: the wire protocol does not send mob HP/level data.
  // The compendium (m59-spawns.json) does: it maps room -> creature -> level.
  // Filter out mobs whose compendium level is above the character's
  // hunt level. This is the only way to know a spider is level 50
  // when Kage is level 20.
  const huntLevel = opts.huntLevel ?? null;
  const band = opts.threatBand ?? Math.floor(huntLevel / 2);
  const levelCeiling = huntLevel != null ? huntLevel + band : null;
  const roomNum = opts.mapRoomNum ?? room?.num ?? room?.id ?? null;
  if (levelCeiling != null && roomNum != null) {
    const filtered = hostiles.filter(o => {
      const name = client?.rsc?.get?.(o.nameRsc) ?? '';
      const lv = compendiumLevel(roomNum, name);
      // If the compendium doesn't know this mob, REFUSE it.
      // An unknown mob could be a high-level spider that the
      // compendium doesn't list for this room. Safer to skip
      // unknowns than to walk into a spider (lv50) that
      // the lookup failed to identify.
      if (lv == null) return false;
      return lv <= levelCeiling;
    });
    if (filtered.length) {
      // Only keep mobs at or below the hunt level.
      const removed = hostiles.length - filtered.length;
      if (removed > 0)
        console.error(`[scavenge] level filter: removed ${removed} mob(s) above ceiling ${levelCeiling} in room ${roomNum}`);
      hostiles.splice(0, hostiles.length, ...filtered);
    } else if (hostiles.length > 0) {
      // ALL mobs in the room are above the ceiling. Don't fight.
      const names = hostiles.map(o => client?.rsc?.get?.(o.nameRsc) ?? '?').join(', ');
      return { sent: false, killed: false,
        reason: `all mobs in room are above ceiling ${levelCeiling} (hunt lv${huntLevel} + band ${band}) (${names}) — travel to a safer room` };
    }
  }

  if (!hostiles.length) {
    // No hostiles: walk a few steps toward where mobs are likely to be, then wait.
    // See wanderAway() — extracted so the atomic body has no loop around an await.
    wanderAway(client, session);
    return { sent: false, killed: false, reason: 'no hostiles in the room' };
  }

  // Pick the NEAREST reachable hostile. Sort by distance, then try
  // each one until the walk succeeds. The nearest mob might be behind
  // a door or across an impassable gap — in that case, try the next.
  const mePos = client?.self;
  const sorted = hostiles.sort((a, b) => {
    if (mePos) {
      const da = Math.hypot((a.col ?? 0) - mePos.col, (a.row ?? 0) - mePos.row);
      const db = Math.hypot((b.col ?? 0) - mePos.col, (b.row ?? 0) - mePos.row);
      if (Math.abs(da - db) > 3) return da - db;
    }
    return (a.max_health ?? a.health ?? 999) - (b.max_health ?? b.health ?? 999);
  });
  const hpFrac = frac(client?.vitals?.()?.health);
  const { fight: doFight } = await import('../m59-skills.mjs');

  // Try up to 3 nearest hostiles. Stop at the first one we can reach.
  let lastResult = null;
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const target = sorted[i];
    const targetName = client?.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
    const targetHp = target.max_health ?? target.health ?? '?';
    const targetCol = target.col ?? null;
    const targetRow = target.row ?? null;

    // PVP GATE
    if (target.is_player === true) {
      const armed = client?.equipment?.()?.equipped?.length > 0;
      const healthy = hpFrac != null && hpFrac >= 0.7;
      const inBand = typeof targetHp === 'number' && targetHp <= myLevel * 1.5;
      if (!armed || !healthy || !inBand) continue; // skip this player, try next
    }

    const distToTarget = (mePos && targetCol != null && targetRow != null)
      ? Math.abs(mePos.col - targetCol) + Math.abs(mePos.row - targetRow) : 0;

    const sClient = session.need();
    const foeId = target.id ?? target.obj_id ?? null;

    const r = await doFight(session, {
      target: targetName, preferId: foeId,
      rounds: 30, swingsPerRound: 4, holdPosition: false, reach: 3,
    });

    if (r?.killed || r?.won || (r?.fought && !r?.reason?.includes('could not get')))
      return {
        sent: true,
        killed: r?.killed ?? r?.won ?? false,
        reason: r?.killed || r?.won ? null : (r?.reason ?? 'fight did not end in a kill'),
      };

    // Walk failed or fight didn't start — log and try next target
    lastResult = r;
    if (r?.reason?.includes('could not get')) {
      console.error(`[scavenge] ${session.name ?? '?'} target ${i+1}/${Math.min(3,sorted.length)} ${targetName} at (${targetCol},${targetRow}) unreachable: ${r.reason}`);
      continue;
    }
    // Other failure (disengage, etc.) — don't try next target
    break;
  }

  // All targets unreachable or fight failed
  const firstTarget = sorted[0];
  const firstName = client?.rsc?.get?.(firstTarget.nameRsc) ?? firstTarget.name ?? 'creature';
  if (lastResult?.reason?.includes('could not get')) {
    console.error(`[scavenge] ${session.name ?? '?'} all ${Math.min(3,sorted.length)} targets unreachable`);
    return { sent: true, killed: false, reason: `could not reach any of ${Math.min(3,sorted.length)} nearest hostiles (nearest: ${firstName})` };
  }
  return {
    sent: true,
    killed: lastResult?.killed ?? lastResult?.won ?? false,
    reason: lastResult?.killed || lastResult?.won ? null : (lastResult?.reason ?? 'fight did not end in a kill'),
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
