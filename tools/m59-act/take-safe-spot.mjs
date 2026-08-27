#!/usr/bin/env node
// m59-act/take-safe-spot.mjs -- THE TAKE-SAFE-SPOT ATOMIC.
// Move to a wall or corner to reduce the number of directions
// enemies can attack from. This is a tactical repositioning step
// before or during combat.
//
// CONTRACT: (client, session) -> { sent, at_wall, reason, spot }
//   - sent: true when a move was attempted
//   - at_wall: true when the character is now adjacent to a wall
//   - spot: { col, row } of the safe spot, if found
//   - reason: null on success, a description of what went wrong
//
// HOW IT WORKS:
//   1. If already at a wall (2+ non-walkable neighbors), done.
//   2. Scan a 12-cell radius around the character for cells that are
//      standable AND have 2+ non-walkable neighbors (wall corners).
//   3. Walk to the nearest such cell. Walk the FULL distance, not 2 steps.
//   4. If no wall-adjacent cell is found in the radius, walk toward the
//      nearest non-walkable cell (a wall) and stop next to it.
//
// THE WALK IS IDEMPOTENT: if the character is already moving toward
// a safe spot (same target), don't start a new walk. The GOAP keeper
// re-plans every second; without this, each pass cancels the previous
// walk and the character never arrives.

import { evaluate } from '../m59-worldstate.mjs';
import { OF, blocksMovement } from '../m59-parse.mjs';
import { nearestSafeSpot, coarseCombatReachFrom } from '../m59-safespots.mjs';
import {
  claimFileSpot, fileSpotClaimSnapshot, fileSpotClaimsEnabled, releaseFileSpot,
} from '../m59-spotclaims.mjs';

// Module-level cache: the selected quarry/wall pair per character. A bounded walk issues
// another leg on the next pass but never re-aims at a newly-nearest wall mid-approach.
const _lastTarget = new Map();
const _failedTargets = new Map();
const _localClaimByAgent = new Map();
const _localClaimOwners = new Map();
const FAILED_TARGET_TTL_MS = 30_000;

const spotKey = (room, col, row) => `${room ?? '?'}:${col},${row}`;

function localClaim(agent, room, col, row) {
  const key = spotKey(room, col, row);
  const owners = _localClaimOwners.get(key);
  if (owners && [...owners].some(name => name !== agent)) return false;
  const old = _localClaimByAgent.get(agent);
  if (old && old !== key) {
    const oldOwners = _localClaimOwners.get(old);
    oldOwners?.delete(agent);
    if (!oldOwners?.size) _localClaimOwners.delete(old);
  }
  const next = owners ?? new Set();
  next.add(agent);
  _localClaimOwners.set(key, next);
  _localClaimByAgent.set(agent, key);
  return true;
}

function claimPullSpot(agent, room, col, row) {
  if (!fileSpotClaimsEnabled()) return localClaim(agent, room, col, row);
  try {
    // Pull walls follow the literal no-other-person rule, including partners.
    return !!claimFileSpot(agent, room, col, row,
      { cap: 1, partner: null, mayShare: () => false });
  } catch { return false; }
}

function releasePullSpot(agent) {
  if (fileSpotClaimsEnabled()) {
    try { return releaseFileSpot(agent); } catch { return 0; }
  }
  const key = _localClaimByAgent.get(agent);
  if (!key) return 0;
  _localClaimByAgent.delete(agent);
  const owners = _localClaimOwners.get(key);
  owners?.delete(agent);
  if (!owners?.size) _localClaimOwners.delete(key);
  return 1;
}

function claimedByOthers(agent, room) {
  const out = new Set();
  if (fileSpotClaimsEnabled()) {
    try {
      for (const claim of fileSpotClaimSnapshot()?.claims ?? []) {
        if (claim.agent === agent || Number(claim.room) !== Number(room)) continue;
        out.add(`${claim.col},${claim.row}`);
      }
    } catch { /* the atomic claim below fails closed if the store is unavailable */ }
    return out;
  }
  for (const [key, owners] of _localClaimOwners) {
    const prefix = `${room ?? '?'}:`;
    if (!key.startsWith(prefix) || ![...owners].some(name => name !== agent)) continue;
    out.add(key.slice(prefix.length));
  }
  return out;
}

function failedFor(agent, room, now = Date.now()) {
  const perAgent = _failedTargets.get(agent);
  const out = new Set();
  if (!perAgent) return out;
  const prefix = `${room ?? '?'}:`;
  for (const [key, until] of perAgent) {
    if (until <= now) { perAgent.delete(key); continue; }
    if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
  }
  if (!perAgent.size) _failedTargets.delete(agent);
  return out;
}

function rememberFailed(agent, room, col, row, now = Date.now()) {
  const perAgent = _failedTargets.get(agent) ?? new Map();
  perAgent.set(spotKey(room, col, row), now + FAILED_TARGET_TTL_MS);
  _failedTargets.set(agent, perAgent);
}

function bodyBlockedSquares(client) {
  const out = new Set();
  const objects = client?.room?.objects instanceof Map
    ? client.room.objects.values() : (client?.room?.objects || []);
  for (const object of objects) {
    if (!object || object.id === client?.selfId) continue;
    const isPlayer = !!(object.flags & OF.PLAYER) || !!client?.playersOnline?.has?.(object.id);
    if (!isPlayer && !blocksMovement(object.flags ?? 0)) continue;
    if (Number.isFinite(object.col) && Number.isFinite(object.row))
      out.add(`${object.col},${object.row}`);
  }
  return out;
}

/**
 * Check if a cell is "at a wall": standable, with 2+ of its 4 cardinal
 * neighbors being non-walkable. This is a corner or alcove.
 */
function wallScore(r, c, isWalkable) {
  let walls = 0;
  if (!isWalkable(r + 1, c)) walls++;
  if (!isWalkable(r - 1, c)) walls++;
  if (!isWalkable(r, c + 1)) walls++;
  if (!isWalkable(r, c - 1)) walls++;
  return walls;
}

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .walkTo, .s)
 */
export async function takeSafeSpot(client, session, _opts = {}) {
  if (!client || !session)
    return { sent: false, at_wall: false, reason: 'no client or session' };

  const c = client;
  const s = session.s ?? session;
  const me = c.self;
  if (!me) return { sent: false, at_wall: false, reason: 'own position unknown' };
  const charName = c.me?.name ?? s.name ?? session.name ?? 'unknown';
  const roomNum = s.world?.room?.num ?? _opts.mapRoomNum
    ?? c.room?.num ?? c.room?.id ?? null;

  // Build a walkable checker from the session's geometry.
  // Uses the union of coarse (standable) and fine (fineWalkable) grids.
  const geo = s.world?.geometry ?? null;
  const isWalkable = (r, c) => {
    if (geo) {
      const coarse = geo.standable?.(r, c) ?? false;
      const fine = geo.fineWalkable?.(r, c) ?? false;
      return coarse || fine;
    }
    // Fallback: use the world's reach()
    const reach = s.world?.reach?.(c, r);
    return reach?.reachable ?? true;
  };

  // Pull combat supplies the already-selected quarry. In that mode the quarry, not our
  // current body, anchors the search: choose the nearest canonical safe wall that nobody
  // else occupies and whose coarse monster component can reach our combat disc there.
  const requestedQuarry = _opts.target ?? null;
  if (requestedQuarry && (requestedQuarry.col == null || requestedQuarry.row == null))
    return { sent: false, at_wall: false,
             reason: 'the selected quarry has no usable position' };
  const quarry = requestedQuarry;
  let target = null;
  let canonicalTarget = false;
  if (quarry) {
    const quarryReach = coarseCombatReachFrom(geo, quarry);
    if (!quarryReach)
      return { sent: false, at_wall: false,
               reason: 'could not validate the quarry on the coarse movement grid' };

    const blocked = bodyBlockedSquares(c);
    for (const key of failedFor(charName, roomNum)) blocked.add(key);
    for (const key of claimedByOthers(charName, roomNum)) blocked.add(key);

    const quarryId = quarry.id ?? quarry.obj_id ?? `${quarry.col},${quarry.row}`;
    const cached = _lastTarget.get(charName);
    const cachedKey = cached ? `${cached.col},${cached.row}` : null;
    if (cached?.canonical && String(cached.room) === String(roomNum)
        && String(cached.quarry_id) === String(quarryId) && !blocked.has(cachedKey)
        && claimPullSpot(charName, roomNum, cached.col, cached.row)) {
      target = { ...cached };
      canonicalTarget = true;
    } else if (cached?.canonical) {
      _lastTarget.delete(charName);
    }

    // Reservation closes the read/walk race between keeper processes. If somebody wins
    // the same deterministic wall after our snapshot, add it to this search and choose
    // the next closest valid candidate instead of sending both bodies to one square.
    let claimCollisions = 0;
    while (!target && claimCollisions < 16) {
      const spot = nearestSafeSpot(geo, me, {
        within: Math.max(geo?.rows ?? 0, geo?.cols ?? 0) || 64,
        toward: { col: quarry.col, row: quarry.row },
        quarryReach,
        strictQuarryReach: true,
        closestToToward: true,
        unreachable: blocked,
        // Supply the actual route, not just a component membership set: winding rooms can
        // need materially more steps than straight-line distance, and that number budgets
        // the bounded walk below.
        reach: typeof s.world?.reach === 'function'
          ? (col, row) => s.world.reach(col, row)
          : null,
      });
      if (!spot) break;
      if (claimPullSpot(charName, roomNum, spot.col, spot.row)) {
        target = {
          ...spot,
          dist: spot.steps_away ?? Math.hypot(spot.col - me.col, spot.row - me.row),
          canonical: true, quarry_id: quarryId, room: roomNum,
          approach_best_distance: Math.hypot(spot.col - me.col, spot.row - me.row),
          approach_non_closing: 0,
        };
        _lastTarget.set(charName, target);
        canonicalTarget = true;
        break;
      }
      blocked.add(`${spot.col},${spot.row}`);
      claimCollisions++;
    }
    if (!target) {
      if (cached?.canonical) releasePullSpot(charName);
      return { sent: false, at_wall: false,
               reason: claimCollisions >= 16
                 ? 'could not reserve an unoccupied safe spot after concurrent claims'
                 : 'no unoccupied safe spot is reachable by this quarry within combat distance' };
    }
  }

  if (!target) {
    // Step 1: are we already at a wall?
    const hereWalls = wallScore(me.row, me.col, isWalkable);
    if (hereWalls >= 2) {
      return { sent: false, at_wall: true, reason: null, spot: { col: me.col, row: me.row } };
    }
    // Adjacent to at least one wall? Good enough for holding position.
    if (hereWalls >= 1) {
      return { sent: false, at_wall: true, reason: 'already at a wall', spot: { col: me.col, row: me.row } };
    }

    // Step 2: scan for nearby wall-adjacent cells (corners/alcoves).
    const radius = 12;
    let best = null;
    let bestDist = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = me.row + dr, c2 = me.col + dc;
        if (!isWalkable(r, c2)) continue;
        const ws = wallScore(r, c2, isWalkable);
        if (ws < 2) continue;
        const d = Math.hypot(dr, dc);
        // Prefer corners (3+ walls) at same distance
        const score = d - ws * 0.5;
        if (score < bestDist) {
          bestDist = score;
          best = { col: c2, row: r, walls: ws, dist: d };
        }
      }
    }

    // Step 3: if no corner found, walk toward the nearest wall.
    target = best;
    if (!target) {
      // Find the nearest non-walkable cell and step next to it.
      let nearestWall = null;
      let nearestWallDist = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const r = me.row + dr, c2 = me.col + dc;
          if (isWalkable(r, c2)) continue;
          const d = Math.hypot(dr, dc);
          if (d < nearestWallDist) {
            nearestWallDist = d;
            nearestWall = { row: r, col: c2 };
          }
        }
      }
      if (nearestWall) {
        // Step from the character toward the wall, stopping 1 cell short.
        const dx = nearestWall.col - me.col;
        const dy = nearestWall.row - me.row;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const step = Math.min(1, dist - 1);
        target = {
          col: me.col + Math.round((dx / dist) * step),
          row: me.row + Math.round((dy / dist) * step),
          walls: 1,
          dist: dist - 1,
        };
        // Only use it if the target cell is actually walkable
        if (!isWalkable(target.row, target.col)) target = null;
      }
    }
  }

  if (!target) {
    return { sent: false, at_wall: false, reason: 'no wall found within radius' };
  }

  // Step 4: walk one bounded leg toward the selected target. Target-first calls retain
  // their exact quarry/wall pair in `_lastTarget`; the next GOAP pass issues the next leg
  // toward that same wall instead of re-aiming from a wandering quarry position.
  const alreadyThere = canonicalTarget
    ? me.col === target.col && me.row === target.row
    : Math.hypot(me.col - target.col, me.row - target.row) <= 1.5;
  if (alreadyThere) {
    _lastTarget.delete(charName);
    return { sent: false, at_wall: true, reason: null, spot: { col: me.col, row: me.row } };
  }

  const requestedMax = Number(_opts.maxSteps);
  const maxSteps = Math.min(
    Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : Infinity,
    Math.ceil(target.dist) + 6,
  );
  const walk = await s.walkTo(target.col, target.row, { maxSteps })
                      .catch(() => ({ arrived: false, reason: 'walk failed' }));

  // Only check left_room — the room ID comparison fails because
  // c.room.id is the live objId (e.g. 1511) while s.world.room.id
  // may be the map num (e.g. 557). The walkTo already handles
  // actual room changes via left_room.
  if (walk.left_room) {
    _lastTarget.delete(charName);
    if (canonicalTarget) releasePullSpot(charName);
    return { sent: true, at_wall: false, reason: 'room changed during walk' };
  }

  const me2 = c.self;
  if (!me2) {
    _lastTarget.delete(charName);
    if (canonicalTarget) releasePullSpot(charName);
    return { sent: true, at_wall: false, reason: 'lost position' };
  }

  if (canonicalTarget && me2.col === target.col && me2.row === target.row) {
    // Stranger players do not participate in the claim store, and any body can enter
    // during the awaited walk. Accept the wall only after a fresh exact-cell check.
    if (bodyBlockedSquares(c).has(`${target.col},${target.row}`)) {
      _lastTarget.delete(charName);
      releasePullSpot(charName);
      return {
        sent: true, at_wall: false,
        reason: 'the selected safe spot became occupied during the walk',
        spot: { col: target.col, row: target.row },
      };
    }
    _lastTarget.delete(charName);
    return { sent: true, at_wall: true, reason: null, spot: { col: me2.col, row: me2.row } };
  }

  const nowWalls = wallScore(me2.row, me2.col, isWalkable);
  // A bounded target-first walk can pass another wall on the way. That intermediate
  // square was never validated against this quarry's coarse component and must not be
  // reported as the selected pull spot merely because it happens to touch geometry.
  if (!canonicalTarget && nowWalls >= 1) {
    _lastTarget.delete(charName);
    return { sent: true, at_wall: true, reason: null, spot: { col: me2.col, row: me2.row } };
  }

  let inProgress = false;
  if (canonicalTarget) {
    const moved = me2.col !== me.col || me2.row !== me.row;
    let resumable = !walk.arrived && (
      walk.reason === 'ran out of steps' || walk.reason === 'raw walk made progress'
      || walk.cancelled || moved || Number(walk.steps ?? 0) > 0
    );
    if (resumable) {
      const gap = Math.hypot(target.col - me2.col, target.row - me2.row);
      const best = Number.isFinite(target.approach_best_distance)
        ? target.approach_best_distance : Infinity;
      const closer = gap <= best - 0.25;
      target = {
        ...target,
        approach_best_distance: closer ? gap : best,
        approach_non_closing: closer ? 0 : (target.approach_non_closing ?? 0) + 1,
      };
      // A bounded leg may legitimately pause once or twice. Three legs without a new
      // distance low is an approach stall, including lateral wall sliding that still
      // changes squares and would otherwise masquerade as movement forever.
      resumable = target.approach_non_closing < 3;
      if (resumable) _lastTarget.set(charName, target);
    }
    if (!resumable) {
      // A real no-progress destination failure is remembered briefly. The next pass
      // chooses the next closest quarry-valid wall instead of driving into this one again.
      rememberFailed(charName, roomNum, target.col, target.row);
      _lastTarget.delete(charName);
      releasePullSpot(charName);
    } else inProgress = true;
  } else if (walk.arrived) {
    _lastTarget.delete(charName);
  }
  return {
    sent: true,
    at_wall: false,
    reason: walk.arrived ? 'at target but not at a wall' : (walk.reason ?? 'could not reach a wall'),
    from: { col: me.col, row: me.row },
    to: { col: me2.col, row: me2.row },
    spot: { col: target.col, row: target.row },
    in_progress: inProgress || undefined,
  };
}

// GOAP metadata.
takeSafeSpot.pre     = [];
takeSafeSpot.effects = [];  // tactical repositioning, no world-state change
takeSafeSpot.mutates  = true;  // sends movement packets
takeSafeSpot.atomic  = 'take_safe_spot';
