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

  // Pick the NEAREST hostile, not the weakest. The weakest mob might be
  // across the room and unreachable (geometry blocks the walk). The
  // nearest mob is the one we can actually reach and fight. If the
  // nearest is too strong, fight() disengages and we try again next
  // pass — or the GOAP routes us to a better room.
  const mePos = client?.self;
  const weak = hostiles.sort((a, b) => {
    if (mePos) {
      const da = Math.hypot((a.col ?? 0) - mePos.col, (a.row ?? 0) - mePos.row);
      const db = Math.hypot((b.col ?? 0) - mePos.col, (b.row ?? 0) - mePos.row);
      if (Math.abs(da - db) > 3) return da - db;  // prefer nearest (within 3 cells tie)
    }
    return (a.max_health ?? a.health ?? 999) - (b.max_health ?? b.health ?? 999);
  })[0];
  const target = weak;
  const hpFrac = frac(client?.vitals?.()?.health);

  const targetName = client?.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
  const targetHp = target.max_health ?? target.health ?? '?';

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

  // COMBAT STRATEGY: FIGHT FROM THE SAFE SPOT (PULL-TO-WALL).
  //
  // The character is already at a wall/corner (takeSafeSpot above).
  // Instead of walking to the mob (leaving the safety of the wall),
  // we swing from the wall. The first swing aggro's the mob, and it
  // walks toward us. When it's close enough (within reach), we start
  // dealing damage with the wall at our back.
  //
  // This is the "pull to wall" strategy:
  //   1. Hold position at the wall, swing at the target.
  //   2. If out of reach, the swing still aggro's the mob (the server
  //      processes the attack even if it misses for range).
  //   3. Wait 2-3s for the mob to walk toward us.
  //   4. Swing again. Repeat until the mob is in reach or dead.
  //
  // Max 3 pull attempts before giving up and doing a normal approach.
  const { fight: doFight } = await import('../m59-skills.mjs');
  const foeId = target.id ?? target.obj_id ?? null;
  const mePos2 = client?.self;
  const targetDist = mePos2 && target.col != null && target.row != null
    ? Math.hypot(target.col - mePos2.col, target.row - mePos2.row)
    : null;

  // If the target is already in reach (<= 3 cells), fight in place.
  // 30 rounds is enough to kill an in-band mob. If the mob survives
  // 30 rounds, it's out of our damage range — disengage and let
  // the GOAP re-plan (travel to a weaker mob, rest, etc).
  if (targetDist != null && targetDist <= 3) {
    const r = await doFight(session, {
      target: targetName, preferId: foeId,
      rounds: 30, swingsPerRound: 4, holdPosition: true, reach: 3,
    });
    return {
      sent: true,
      killed: r?.killed ?? r?.won ?? false,
      reason: r?.killed || r?.won ? null : (r?.reason ?? 'fight did not end in a kill'),
    };
  }

  // Target is more than 3 cells away. Walk to it using fine-grid
  // movement (moveTo with x,y) instead of moveToSquare (which snaps
  // to cell centers and can get stuck in corridors). Fine-grid
  // movement allows sub-cell positioning and handles narrow passages.
  {
    const c = session.need();
    let meNow = c.self;
    let foeNow = c.room.objects.get(foeId);
    if (meNow && foeNow) {
      for (let step = 0; step < 60; step++) {
        const mx = meNow?.x ?? 0;
        const my = meNow?.y ?? 0;
        const fx = foeNow?.x ?? 0;
        const fy = foeNow?.y ?? 0;
        const dx = fx - mx;
        const dy = fy - my;
        const dist = Math.hypot(dx, dy) / 1024; // in cells
        if (dist <= 3) break; // in reach
        // Walk one cell (1024 fine-grid units) toward the target
        const stepSize = 1024;
        const distRaw = Math.hypot(dx, dy);
        if (distRaw === 0) break;
        const sx = Math.round((dx / distRaw) * stepSize);
        const sy = Math.round((dy / distRaw) * stepSize);
        const nx = mx + sx;
        const ny = my + sy;
        try {
          await c.moveTo(nx, ny);
        } catch { break; }
        await new Promise(res => setTimeout(res, 200));
        // Re-read position and target
        const c2 = session.need();
        meNow = c2.self;
        foeNow = c2.room.objects.get(foeId);
        if (!foeNow) break; // target gone
      }
    }
    // Now fight in place (target should be in reach or we walked as close as we could)
    const r = await doFight(session, {
      target: targetName, preferId: foeId,
      rounds: 30, swingsPerRound: 4, holdPosition: true, reach: 3,
    });
    return {
      sent: true,
      killed: r?.killed ?? r?.won ?? false,
      reason: r?.killed || r?.won ? null : (r?.reason ?? 'fight did not end in a kill'),
    };
  }
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
