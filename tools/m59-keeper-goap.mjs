#!/usr/bin/env node
// m59-keeper-goap.mjs -- THE GOAP KEEPER. A planner-driven loop that replaces
// the sequential pass() for one character.
//
// WHAT THIS IS: a thin driver that, on each pass(), reads the world state,
// plans toward a goal, executes one step, and lets the next pass() re-plan.
// The planner is m59-plan.mjs (A* over preconditions/effects in the closed
// vocabulary). The atomics are tools/m59-act/*.mjs. The world state is
// m59-worldstate.mjs.
//
// WHAT THIS IS NOT:
//   NOT A REPLACEMENT FOR THE SAFETY LADDER. Underworld, arming, and the
//   engagement ceiling are PRECONDITIONS in the vocabulary, not goals. A
//   character that is dead, in the Underworld, or unarmed cannot plan its
//   way out of those states — the legacy safety shell (passUnderworld,
//   passArm) still runs before the planner, the same way the BT keeper
//   routed them before the trees.
//
//   NOT A BROKER CLIENT. It runs inside the broker's existing session, which
//   means it has the fine-coordinate mover (session.step) that the standalone
//   m59-goap-run.mjs deliberately lacks.
//
//   NOT A FLEET-WIDE CHANGE. The policy.useGOAP flag is per-character. The
//   fleet stays on the proven sequential code unless somebody flipped the
//   lever on a specific character.
//
// THE GOAL IS CONFIGURABLE. The default is vigor_ok: keep the character
// fed. That is the goal the fleet actually lives on — resting stops at 80
// of 200, so everything above it has to be eaten, and a character that is
// not fed will not fight, farm, or travel.
//
// REPLANNING IS EVERY PASS. A plan is a claim about a world that will not
// hold still. The planner re-runs from the current world state on every
// pass, so a character that eats and is now fed re-plans toward the next
// goal rather than repeating a completed step.

import { evaluate, unknowns, SYMBOL_NAMES } from './m59-worldstate.mjs';
import { planFor, stepPlan } from './m59-plan.mjs';
import { loadMap, findPath } from './m59-map.mjs';
import { objIdToNum } from './m59-hunt-room.mjs';
import { readFileSync, existsSync } from 'node:fs';

// Compendium spawn data for level lookups.
let _spawns = null;
function _loadSpawns() {
  if (_spawns) return _spawns;
  const file = 'substrate/m59-spawns.json';
  if (!existsSync(file)) return null;
  try { _spawns = JSON.parse(readFileSync(file, 'utf8')); } catch { _spawns = null; }
  return _spawns;
}
function _compendiumLevel(roomNum, mobName) {
  const spawns = _loadSpawns();
  if (!spawns?.rooms) return null;
  const name = String(mobName).toLowerCase();
  // First try the specific room.
  const entries = spawns.rooms[String(roomNum)] ?? null;
  if (entries) {
    const match = entries.find(e => e.creature?.toLowerCase() === name);
    if (match) return match.level;
  }
  // Fall back to a global search: the compendium may not list this
  // mob for this specific room, but it might be listed for a
  // neighbouring room. The level is the same regardless of room.
  for (const entries2 of Object.values(spawns.rooms)) {
    const match2 = entries2.find(e => e.creature?.toLowerCase() === name);
    if (match2) return match2.level;
  }
  return null;
}
import { affordances, OF } from './m59-parse.mjs';

// ROOMS THAT HAVE SHOPS. A shop is any room where a merchant with a buy
// list can be found. We use room names as a proxy: inns, taverns, shops,
// banks, smithies, and apothecaries all have merchants.
const SHOP_RE = /inn|tavern|shop|store|market|apothecary|smith|armourer|jeweller|bank|pawn|general/i;

let _shopRooms = null;
function shopRooms() {
  if (_shopRooms) return _shopRooms;
  try {
    const map = loadMap();
    const rooms = map?.rooms ?? {};
    _shopRooms = [];
    for (const [num, r] of Object.entries(rooms)) {
      if (SHOP_RE.test(r?.name ?? '')) {
        _shopRooms.push(Number(num));
      }
    }
  } catch {
    _shopRooms = [];
  }
  return _shopRooms;
}

// Find the nearest shop from a given room.
// Returns { to, hops } or null if no shop is reachable.
//
// Room IDs in the live server can differ from the movement map (the
// server reassigns IDs on each startup). This helper resolves the
// live room ID to a map room ID by name before calling findPath.
let _roomNameToMapNum = null;
function roomNameToMapNum() {
  if (_roomNameToMapNum) return _roomNameToMapNum;
  _roomNameToMapNum = new Map();
  try {
    const map = loadMap();
    for (const [num, r] of Object.entries(map?.rooms ?? {})) {
      if (r?.name) _roomNameToMapNum.set(r.name, Number(num));
    }
  } catch { _roomNameToMapNum = new Map(); }
  return _roomNameToMapNum;
}

// Resolve a live room ID to a movement-map room ID.
// If the live ID is already in the map, return it as-is.
// Otherwise, look up by room name.
function resolveMapRoom(liveNum, roomName) {
  try {
    const map = loadMap();
    if (map?.rooms?.[liveNum]) return liveNum;
  } catch {}
  if (roomName) {
    const nameMap = roomNameToMapNum();
    const mapNum = nameMap.get(roomName);
    if (mapNum != null) return mapNum;
  }
  // LAST RESORT: try objIdToNum. The live room id (e.g. 1548) may not be a map
  // key, but objIdToNum knows the mapping from the server's object ids to map
  // numbers. This covers the case where the room name hasn't been resolved yet
  // (RSC timing) but the objId mapping is known.
  try {
    const mapped = objIdToNum(liveNum);
    if (mapped != null) return mapped;
  } catch {}
  return liveNum;
}

function nearestShop(fromNum, roomName, { avoid } = {}) {
  const shops = shopRooms();
  if (!shops.length) return null;
  try {
    const map = loadMap();
    let best = null;
    const mapFrom = resolveMapRoom(fromNum, roomName);
    for (const to of shops) {
      if (to === mapFrom) continue;
      const p = findPath(map, mapFrom, to, { avoid });
      if (p?.found && p.hops?.length) {
        if (!best || p.hops.length < best.hops.length) {
          best = { to, hops: p.hops };
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The GOAP keeper. One instance per character, created by the autopilot
 * when policy.useGOAP is true.
 *
 * pass() is called by the autopilot's loop, the same way the legacy
 * sequential pass() is called. It reads the world state, plans toward the
 * current goal, executes one step, and returns. The next pass() re-plans
 * from the new world state.
 */
export class GOAPKeeper {
  /**
   * @param {object} opts
   * @param {object} opts.client  - the M59Client for this character
   * @param {object} opts.session - the broker session (has .step for movement)
   * @param {object} opts.policy  - the character's policy (includes useGOAP)
   * @param {string} [opts.goal='vigor_ok'] - the world-state symbol to plan toward
   * @param {function} [opts.note] - logging function (keeper.note)
   */
  _roomName() {
    try { return this.client?.rsc?.get?.(this.client?.roomNameRsc) ?? null; }
    catch { return null; }
  }

  constructor({ client, session, policy, goal = 'vigor_ok', note = () => {} }) {
    if (!client) throw new Error('GOAPKeeper: no client');
    if (!session) throw new Error('GOAPKeeper: no session');
    this.client = client;
    this.session = session;
    this.policy = policy ?? {};
    this.goal = goal;
    this.note = note;
    this._lastPlan = null;
    this._passCount = 0;
    this._shopDest = null; // cached shop destination room num
  }

  /**
   * Current plan and goal, for the dashboard / hero page. A visible
   * plan is the only plan you can argue with. Returns null when no
   * pass has run yet.
   */
  state() {
    return this._lastPlan ?? null;
  }

  /**
   * Check if any shop is reachable from the character's current room.
   * Returns true if at least one shop has a valid path. Used by the
   * goal stack to decide whether the has_money goal is actionable:
   * if no shop is reachable, selling is impossible and the goal
   * falls through to the next one.
   */
  _shopReachable() {
    const c = this.client;
    const hereRaw = c?.room?.num ?? c?.room?.id;
    if (hereRaw == null) return false;
    // Dynamic import to avoid circular dependency at module load time.
    let objIdToNum, loadMap, findPath;
    try {
      ({ objIdToNum } = require_esm('./m59-hunt-room.mjs'));
      ({ loadMap, findPath } = require_esm('./m59-map.mjs'));
    } catch { return false; }
    const here = objIdToNum(hereRaw) ?? hereRaw;
    // If we're already at a shop, it's reachable.
    if (this._shopDest === here) return true;
    // Check if the cached shop dest is still reachable.
    if (this._shopDest) {
      try {
        const { loadMap, findPath } = require('./m59-map.mjs');
        const map = loadMap();
        const p = findPath(map, resolveMapRoom(here, this._roomName()), this._shopDest);
        return p?.found === true;
      } catch { return false; }
    }
    // No cached dest: check if any shop is reachable.
    return nearestShop(here, this._roomName()) != null;
  }

  /**
   * Take one hop toward a destination room. Uses the legacy router to
   * find the next exit and the session to walk it. This is the travel
   * primitive the planner uses: one room at a time, re-planning after
   * each hop.
   */
  async _travelOneHop(to) {
    const c = this.client;
    const hereRaw = c?.room?.num ?? c?.room?.id;
    if (hereRaw == null)
      return { sent: false, reason: 'unknown room' };

    // Convert objId to map num.
    const { objIdToNum } = await import('./m59-hunt-room.mjs');
    const here = objIdToNum(hereRaw) ?? hereRaw;
    if (here === to)
      return { sent: false, reason: 'already there' };

    // Use the broker's travel() first. The broker handles routing
    // internally (BFS, hazard avoidance, exit walking, etc.).
    let travelResult;
    try {
      // maxHops: 1 — move to the NEXT room only. The GOAP keeper re-plans from the new
      // room on the next pass (the _travelInFlight guard clears when the room changes),
      // so a multi-room journey is a chain of single-hop travels, each re-planned. This
      // is how we get past the broker's maxHops limit: we don't ask it to route the whole
      // journey, we ask it for one room at a time.
      travelResult = await this.session.travel(to, { maxHops: 1 });
      if (travelResult?.arrived)
        return { sent: true, reason: null };
    } catch (e) {
      travelResult = { arrived: false, reason: e.message };
    }

    // Broker travel failed. Try a brute force exit: send raw
    // moveToSquare commands toward and PAST the room boundary.
    // The server clips movement to the wall and triggers the
    // room change when the character crosses an edge opening.
    //
    // The brute force exit needs the NEXT room (first hop), not
    // the final destination. The broker's travel() routes multi-hop
    // and fails on the first hop, so we need to find what that
    // first hop is.
    let nextHop = to;
    try {
      const { loadMap, findPath } = await import('./m59-map.mjs');
      const map = loadMap();
      const p = findPath(map, resolveMapRoom(here, this._roomName()), to);
      if (p?.found && p.hops?.length > 1)
        nextHop = p.hops[0].to;
    } catch {}
    const bruteResult = await this._bruteForceExit(nextHop);
    if (bruteResult?.sent)
      return bruteResult;

    return { sent: false, reason: travelResult?.reason ?? 'travel refused' };
  }

  /**
   * Brute force exit: when the broker's travel() can't get the
   * character to an exit square (local grid says wall), send raw
   * moveToSquare commands toward and past the boundary. The
   * server handles collision and will trigger the room change
   * when the character crosses an edge opening.
   */
  async _bruteForceExit(to) {
    const c = this.client;
    const world = this.session?.world;
    const room = world?.room;
    if (!room || !c)
      return { sent: false, reason: 'no room data' };

    // Find an exit from the current room to the destination.
    // Use the map's edge exits (more reliable than world.exits()
    // which requires the character to be in a valid position).
    const { loadMap } = await import('./m59-map.mjs');
    const map = loadMap();
    const roomNum = room.num ?? room.id;
    const mapRoom = map?.rooms?.[roomNum];
    let exit = null;
    if (mapRoom) {
      exit = (mapRoom.edgeExits ?? []).find(e => e.to === to);
    } else {
      // Unmapped room: use the broker's world.exits() which reads the room's actual
      // geometry (edgeOpenings). This works for rooms not in the movement map.
      const exits = this.session?.world?.exits?.() ?? [];
      exit = exits.find(e => e.to === to || e.to === Number(to));
      if (exit) {
        // world.exits() gives us the exit but not the map-style fields. Adapt.
        // exit has: to, kind, leaveName (direction), approach (square to stand on)
      }
    }
    if (!exit)
      return { sent: false, reason: `no exit to room ${to}` };

    // Get the character's current position (kod 1-based).
    const me = c.self;
    const myCol = me?.col ?? 1;
    const myRow = me?.row ?? 1;
    // For mapped rooms, use the map dimensions. For unmapped rooms, use the live room
    // dimensions from the client (c.room.cols/rows) or the geometry.
    const rows = mapRoom?.rows ?? c.room?.rows ?? 1;
    const cols = mapRoom?.cols ?? c.room?.cols ?? 1;
    // Direction: map edgeExits use leaveName; world.exits() may use a different field.
    const dir = exit.leaveName ?? exit.dir ?? exit.direction ?? '';
    if (!dir) {
      // No explicit direction: try to infer from the exit's approach square or
      // fall back to a simple heuristic (which edge the exit is near).
      if (exit.approach) {
        const ap = exit.approach;
        const midC = cols / 2, midR = rows / 2;
        if (ap.col >= cols - 2) dir = 'east';
        else if (ap.col <= 1) dir = 'west';
        else if (ap.row <= 1) dir = 'north';
        else if (ap.row >= rows - 2) dir = 'south';
      }
      if (!dir) return { sent: false, reason: 'no exit direction available' };
    }

    // Determine the target square: one past the boundary.
    // The server clips movement to the wall and triggers the
    // room change when the character crosses the edge opening.
    let targetCol, targetRow;
    if (dir === 'east') {
      targetCol = cols;       // one past the last col (0-based: cols-1)
      targetRow = myRow;      // stay on the same row
    } else if (dir === 'west') {
      targetCol = 0;          // or -1, but 0 is the first col
      targetRow = myRow;
    } else if (dir === 'north') {
      targetCol = myCol;
      targetRow = 0;
    } else if (dir === 'south') {
      targetCol = myCol;
      targetRow = rows;
    } else {
      return { sent: false, reason: `unknown exit direction: ${dir}` };
    }

    // Check the exit condition (row> or row<).
    // The condition is on the row where the character exits.
    if (exit.condition) {
      const { name, threshold } = exit.condition;
      const exitRow = targetRow; // the row we'll be at when exiting
      if (name === 'row>' && exitRow <= (threshold ?? 0))
        return { sent: false, reason: `exit condition row>${threshold} not met (row ${exitRow})` };
      if (name === 'row<' && exitRow >= (threshold ?? 999))
        return { sent: false, reason: `exit condition row<${threshold} not met (row ${exitRow})` };
    }

    console.error(`[goap] brute force exit: ${dir} to room ${to}, from (${myCol},${myRow}) to (${targetCol},${targetRow})`);

    try {
      // Send the move command. The server will clip the movement
      // and trigger the room change if the character crosses an
      // edge opening.
      c.moveToSquare(targetCol, targetRow, 18);

      // Wait for the room to change (up to 10 seconds).
      const startRoom = c.room?.id;
      const { events } = await c.waitFor({
        kinds: 'room-entered',
        timeoutMs: 10000,
      });

      const entered = events.find(e => e.kind === 'room-entered');
      if (entered && c.room?.id !== startRoom) {
        console.error(`[goap] brute force exit SUCCESS: entered ${c.room?.name ?? 'new room'}`);
        return { sent: true, reason: null };
      }

      // Room didn't change. Try one more step further past the boundary.
      console.error(`[goap] brute force exit: room didn't change, trying further`);
      let target2Col = targetCol, target2Row = targetRow;
      if (dir === 'east') target2Col = cols + 1;
      else if (dir === 'west') target2Col = 0;
      else if (dir === 'north') target2Row = 0;
      else if (dir === 'south') target2Row = rows + 1;

      c.moveToSquare(target2Col, target2Row, 18);
      const { events: events2 } = await c.waitFor({
        kinds: 'room-entered',
        timeoutMs: 10000,
      });
      const entered2 = events2.find(e => e.kind === 'room-entered');
      if (entered2 && c.room?.id !== startRoom) {
        console.error(`[goap] brute force exit SUCCESS (2nd try): entered ${c.room?.name ?? 'new room'}`);
        return { sent: true, reason: null };
      }

      return { sent: false, reason: `brute force exit failed: room didn't change after moving to (${targetCol},${targetRow}) and (${target2Col},${target2Row})` };
    } catch (e) {
      return { sent: false, reason: 'brute force exit error: ' + e.message };
    }
  }

  /**
   * One pass: evaluate, plan, execute one step.
   *
   * Returns { acted: boolean, action: string|null, reason: string|null }
   * so the autopilot can log what happened.
   */
  async pass(wsOverride = null) {
    const c = this.client;
    if (!c) {
      return { acted: false, action: null, reason: 'no client' };
    }

    this._passCount++;

    // TRAVEL IN PROGRESS: if the last action was a travel_to that
    // hasn't completed yet (the character is still moving between
    // rooms), don't re-plan. Each new travel_to cancels the previous
    // one, so re-planning every pass causes the character to cancel
    // its own movement and never complete a room transition.
    // Let the movement finish, then re-plan on the next pass.
    if (this._travelInFlight) {
      // Check if the character is still moving (room hasn't changed
      // since we started the travel, or the broker reports movement
      // in progress).
      const c = this.client;
      const curRoom = c?.room?.num ?? c?.room?.id;
      const elapsed = Date.now() - (this._travelStartedAt ?? 0);
      if (curRoom === this._travelFromRoom && elapsed < 60000) {
        // Still in the same room and less than 60s elapsed —
        // movement might still be in progress. Don't block ALL GOAP
        // activity (the character still needs to flee, fight, etc).
        // Instead, set a flag so the planner filters out travel_to.
        this._blockTravel = true;
      } else {
        // Room changed (travel completed) or 60s elapsed (timeout).
        this._travelInFlight = false;
        this._travelFromRoom = null;
        this._travelStartedAt = null;
        this._blockTravel = false;
      }
    } else {
      this._blockTravel = false;
    }

    // 1. Read the world state. The caller can override symbols that
    //    the client cannot see yet (e.g. in_underworld after a
    //    reconnect, when the client's room is stale but the broker's
    //    room tracking is authoritative).
    const who = this.policy.agent ?? this.session?.s?.name ?? this.session?.name ?? '?';
    const ws = { ...evaluate({ client: c, policy: this.policy, agent: this.policy.agent }), ...(wsOverride ?? {}) };

    // 1b. TARGET DETECTION. The GOAP keeper must set _targetId so
    //     that has_target, in_reach, and target_in_band are produced
    //     from the actual room contents.
    {
      const room = c.room;
      if (room?.objects) {
        const list = room.objects instanceof Map
          ? [...room.objects.values()]
          : Array.isArray(room.objects) ? room.objects : [];
        // The engagement ceiling is based on the character's ACTUAL
        // level (max HP), NOT a hardcoded huntLevel. The game level IS
        // the max HP. As the character levels up, the ceiling goes up
        // with it, and he can fight stronger mobs.
        //
        // The huntLevel from the loadout can override this (for
        // specific farming targets), but the default is the character's
        // own level — fight mobs at or near your level.
        const charLevel = c.vitals?.()?.health?.max ?? 20;
        const huntLevel = this.policy.huntLevel ?? charLevel;
        const band = this.policy?.threatBand ?? Math.floor(charLevel / 2); // +50% of level
        const ceiling = huntLevel + band;

        const hostiles = list.filter(o => {
          // Raw room objects have o.flags (bit flags), NOT o.can (action list).
          // The action list is derived from flags via affordances(). Using o.can
          // directly was the bug: it was always undefined, so no hostile was ever
          // found, and the GOAP never saw any mobs in the room.
          const can = affordances(o.flags ?? 0);
          const name = c.rsc?.get?.(o.nameRsc) ?? '';
          return can.includes('attack')
            && !/friendly|pet|tame/i.test(name)
            && !(o.flags & OF.PLAYER); // players are handled separately by the PVP gate
        });



        if (hostiles.length && !ws._targetId) {
          // Pick the target: when hurt, the NEAREST threat is the one
          // eating us — not the weakest one in the corner. When healthy,
          // pick the weakest (safest prey). This is the difference between
          // "a rat is biting my leg" and "I'm choosing what to hunt."
          const me0 = c.self;
          let target;
          if (ws.hurt && me0) {
            // NEAREST first: the mob actually attacking us
            target = hostiles.sort((a, b) => {
              const da = Math.hypot((a.col ?? 0) - me0.col, (a.row ?? 0) - me0.row);
              const db = Math.hypot((b.col ?? 0) - me0.col, (b.row ?? 0) - me0.row);
              return da - db;
            })[0];
          } else {
            // WEAKEST first: safest prey for hunting. Use the
            // compendium level (max_health/health are never sent by
            // the wire protocol, so they're always null and the sort
            // is a no-op — the first hostile found wins). The
            // compendium has the real levels.
            const liveNum0 = c.room?.num ?? c.room?.id ?? null;
            const mapNum0 = liveNum0 != null ? resolveMapRoom(liveNum0, this._roomName()) : null;
            target = hostiles.sort((a, b) => {
              const nameA = c.rsc?.get?.(a.nameRsc) ?? '';
              const nameB = c.rsc?.get?.(b.nameRsc) ?? '';
              const lvlA = (mapNum0 != null ? _compendiumLevel(mapNum0, nameA) : null) ?? 999;
              const lvlB = (mapNum0 != null ? _compendiumLevel(mapNum0, nameB) : null) ?? 999;
              return lvlA - lvlB;
            })[0];
          }
          const targetName = c.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
          const isPlayer = !!(target.flags & OF.PLAYER);

          // The wire protocol does not send mob HP/level. Use the
          // compendium (m59-spawns.json) to look up the target's level.
          // Without this, targetLevel is always null and target_in_band
          // is always false — the 3D view shows a FLEE ring for every
          // mob, even ones the character can fight.
          //
          // The compendium is keyed by MAP room number, not the live
          // objId. Resolve the live ID to the map num first.
          const liveRoomNum = c.room?.num ?? c.room?.id ?? null;
          const mapRoomNum = liveRoomNum != null ? resolveMapRoom(liveRoomNum, this._roomName()) : null;
          const compLevel = mapRoomNum != null ? _compendiumLevel(mapRoomNum, targetName) : null;
          const targetLevel = target.max_health ?? target.health ?? compLevel ?? null;

          ws._targetId = target.id ?? target.obj_id;
          ws._targetLevel = targetLevel;
          ws._threatCeiling = ceiling;
          ws._targetIsPlayer = isPlayer;

          // Re-derive the target-dependent symbols now that _targetId is set.
          // evaluate() already ran without it, so has_target/in_reach/
          // target_in_band are stale. Update them manually.
          ws.has_target = !!c?.room?.objects?.has?.(ws._targetId);
          // in_reach: check distance to target
          if (ws.has_target) {
            const tgt = c.room.objects.get(ws._targetId);
            const myPos = c.self;
            if (tgt && myPos) {
              const dx = (tgt.col ?? 0) - (myPos.col ?? 0);
              const dy = (tgt.row ?? 0) - (myPos.row ?? 0);
              ws.in_reach = Math.hypot(dx, dy) <= 2;
            } else {
              ws.in_reach = false;
            }
          } else {
            ws.in_reach = false;
          }
          ws.target_in_band = targetLevel != null ? targetLevel <= ceiling : false;

          console.error(`[goap] ${who} target detected: ${targetName} (lv${targetLevel ?? '?'}, ${isPlayer ? 'PLAYER' : 'npc'}, hunt lv${huntLevel}, ceiling ${ceiling})`);
        } else if (!hostiles.length && ws._targetId) {
          // Target is gone. Clear it and the derived symbols.
          delete ws._targetId;
          delete ws._targetLevel;
          delete ws._threatCeiling;
          delete ws._targetIsPlayer;
          ws.has_target = false;
          ws.in_reach = false;
          ws.target_in_band = false;
        }
      }
    }

    // Visible log: every GOAP pass is logged to the broker console so the
    // journal (in-memory, lost on restart) is not the only record.
    const wsSummary = Object.entries(ws).filter(([,v]) => v !== null)
      .map(([k,v]) => `${k}=${v}`).join(' ');

    // 2. GOAL STACK. Try goals in priority order. The first goal that
    //    is NOT satisfied becomes the effective goal. This is the
    //    "what should I be doing right now" question.
    //
    //    Priority: survival (underworld) > safety (armed) > sustenance
    //    (has_food) > primary goal (vigor_ok or configured).
    const goalStack = [
      { goal: '!in_underworld', when: ws.in_underworld === true },
      { goal: 'armed',         when: ws.armed === false },
      // HEALTHY: if the character is hurt, stop what it's doing,
      // flee from combat if there's a target, and rest to recover.
      // This is priority 3 because a hurt character that keeps
      // travelling or fighting will die.
      { goal: 'healthy',       when: ws.hurt === true },
      // has_food: only try when the character CAN get food (has
      // reagents to cast create food, or has money to buy).
      // Otherwise, skip to the next goal: rest to the cap (80).
      { goal: 'has_food',      when: ws.has_food === false && (ws.has_reagents === true || ws.has_money === true) },
      // has_money: earn or sell. The character needs money whether
      // it has loot to sell or not. But only trigger when the
      // character CAN make money: it has loot to sell and a shop
      // is reachable, or it's armed (can scavenge for gold).
      // When the shop is unreachable (blocked by a hazard), selling
      // is impossible, so the goal falls through to the next one.
      { goal: 'has_money',     when: ws.has_money === false && (ws.has_loot === true && this._shopReachable() || ws.armed === true) },
      { goal: 'can_rest_higher', when: ws.can_rest_higher === true },
      { goal: this.goal,       when: ws[this.goal] !== true },
    ];
    const active = goalStack.find(g => g.when);

    if (!active) {
      // All goals satisfied. Idle.
      this.note('goap idle', { goal: this.goal, reason: 'all goals satisfied', pass: this._passCount });
      console.error(`[goap] ${who} pass ${this._passCount} goal=${this.goal} ${wsSummary} [idle: all goals satisfied]`);
      return { acted: false, action: null, reason: 'all goals satisfied' };
    }

    const effectiveGoal = active.goal;
    const _roomName = c?.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? '?') : (c.room?.name ?? '?');
    console.error(`[goap] ${who} pass ${this._passCount} room=${_roomName}(${c.room?.id ?? '?'}) goal=${effectiveGoal} ${wsSummary}`);

    // 3. Plan.
    // 3a. Inject travel_to when the goal requires at_shop but we're not
    //     at a shop. Find the nearest shop and create a parameterized
    //     travel_to action with the destination pre-set.
    let extra = [];
    if (ws.in_underworld === true) {
      // Inject the escape_underworld atomic.
      const { escapeUnderworldAtomic } = await import('./m59-act/escape-underworld.mjs');
      extra.push(escapeUnderworldAtomic);
    } else {
      // Inject combat atomics. The character needs these whenever
      // there's a hostile in the room (has_target), OR when the
      // goal is healthy (flee/rest to recover), OR when the
      // character is armed and the goal is has_money/has_loot
      // (scavenge to earn gold).
      const combatGoal = effectiveGoal === 'has_money' || effectiveGoal === 'has_loot';
      // Only inject scavenge when there's actually a target to fight, or when we're
      // hurt (and might need to engage), OR when we're in the hunt room (hops=0, mobs
      // respawning). When we're armed, far from the hunt room, and have no target,
      // scavenge is a dead action (no hostiles here) and the planner will pick it over
      // travel_to because it directly achieves has_money — trapping the character in a
      // mobless room. The travel_to injection below is the right action in that case.
      const here = c.room?.num ?? c.room?.id;
      const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
      const levelCeiling2 = level + (this.policy?.threatBand ?? Math.floor(level / 2));

      let inHuntRoom = false;
      if (ws.armed === true && combatGoal && ws.has_target === false && here != null) {
        try {
          const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
          const resolvedHere = resolveMapRoom(here, this._roomName());
          const hunt = nearestHuntRoom(resolvedHere, levelCeiling2);
          inHuntRoom = !!(hunt && hunt.hops === 0);
        } catch {}
      }
      // When the target is out of band (too high level) and the character
      // is NOT hurt, scavenge is a dead action (it will refuse every pass).
      // Don't inject it — let the planner use travel_to to find a room
      // with in-band prey. When hurt, still inject scavenge + flee so the
      // character can disengage.
      const targetEngageable = ws.has_target === true && (ws.target_in_band === true || ws.hurt === true);
      if (targetEngageable || ws.hurt === true || (ws.armed === true && combatGoal && inHuntRoom)) {
        const { attackOf } = await import('./m59-act/attack.mjs');
        const { scavenge } = await import('./m59-act/scavenge.mjs');
        const { takeSafeSpot } = await import('./m59-act/take-safe-spot.mjs');
        const { flee } = await import('./m59-act/flee.mjs');
        extra.push(attackOf(ws), scavenge, takeSafeSpot, flee);

        // When the goal is 'healthy', inject a composite 'recover'
        // atomic. The strategy depends on the threat:
        //   1. Under attack by a PLAYER: flee, then rest. Do not
        //      engage — a player can one-shot.
        //   2. Under attack by a MOB: take a safe spot (wall/corner),
        //      then rest there. A proven wall holds under attack.
        //   3. NOT under attack: travel to the nearest inn and rest
        //      there. Resting in the open is how characters die.
        if (effectiveGoal === 'healthy') {
          const { rest } = await import('./m59-act/rest.mjs');

          if (ws.has_target === true && ws._targetIsPlayer) {
            // Case 1: under attack by a player. Flee, then rest.
            const recover = async (client, session) => {
              const fleeResult = await flee(client, session);
              if (!fleeResult?.sent && fleeResult?.reason !== 'no target') {
                return { acted: false, reason: 'flee failed: ' + (fleeResult?.reason ?? 'unknown') };
              }
              await takeSafeSpot(client, session).catch(() => {});
              const restResult = await rest(client, session);
              return { acted: restResult?.sent === true || fleeResult?.sent === true, reason: restResult?.reason ?? null };
            };
            recover.atomic = 'recover';
            recover.pre = [];
            recover.effects = ['healthy'];
            recover.cost = 2;
            extra.push(recover);
          } else if (ws.has_target === true) {
            // Case 2: under attack by a mob. If the mob is out of band
            // (too high level), flee first — taking a safe spot against
            // a mob 10+ levels above is a death sentence.
            //
            // If we're ALREADY at a wall and still being hit, the wall
            // is not saving us (the mob is adjacent and the wall blocks
            // our escape). In that case, break off the wall and run
            // into the open — a damaged character in the open can still
            // outrun a mob, but one pinned at a wall cannot.
            const shouldFleeFirst = ws.target_in_band === false || ws.hurt === true;
            const recover = async (client, session) => {
              if (shouldFleeFirst) {
                const fleeResult = await flee(client, session);
                if (fleeResult?.sent === true) {
                  // Successfully fled. Now take a safe spot and rest.
                  await takeSafeSpot(client, session).catch(() => {});
                  const restResult = await rest(client, session);
                  return { acted: true, reason: restResult?.reason ?? null };
                }
                // Flee failed (e.g. 'no hostiles' or 'could not move').
                // If we're at a wall, try to break away from it.
                if (fleeResult?.reason?.includes('no hostiles')) {
                  // No hostiles found — just rest.
                  const restResult = await rest(client, session);
                  return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                }
              }
              const spotResult = await takeSafeSpot(client, session).catch(() => (null));
              const restResult = await rest(client, session);
              return { acted: restResult?.sent === true, reason: restResult?.reason ?? (spotResult?.reason ?? null) };
            };
            recover.atomic = 'recover';
            recover.pre = [];
            recover.effects = ['healthy'];
            recover.cost = 2;
            extra.push(recover);
          } else {
            // Case 3: not under attack. Travel to nearest inn and rest.
            const here = c.room?.num ?? c.room?.id;
            let alreadyInn = false;
            if (here != null) {
              const { objIdToNum } = await import('./m59-hunt-room.mjs');
              const mapNum = objIdToNum(here) ?? here;
              const { loadMap } = await import('./m59-map.mjs');
              const map = loadMap();
              const room = map.rooms?.[mapNum];
              if (room && /inn|tavern/i.test(room.name ?? '')) {
                alreadyInn = true;
              } else {
                // Find the nearest reachable inn.
                const { findPath } = await import('./m59-map.mjs');
                let bestInn = null;
                for (const [num, r] of Object.entries(map.rooms ?? {})) {
                  if (!/inn|tavern/i.test(r.name ?? '')) continue;
                  if (num === String(mapNum)) continue;
                  const resolvedFrom = resolveMapRoom(mapNum, this._roomName());
                  const p = findPath(map, resolvedFrom, Number(num));
                  if (!p.found) continue;
                  if (!bestInn || p.hops.length < bestInn.hops.length) {
                    bestInn = { num: Number(num), name: r.name, hops: p.hops };
                  }
                }
                if (bestInn) {
                  this._innDest = bestInn.num;
                  console.error(`[goap] ${who} recovering to inn: ${mapNum} -> ${bestInn.num} (${bestInn.name}) hops=${bestInn.hops.length}`);
                  const travelToInn = (client, session) => {
                    return this._travelOneHop(bestInn.hops[0] ?? bestInn.num);
                  };
                  travelToInn.atomic = 'travel_to';
                  travelToInn.pre = [];
                  travelToInn.effects = ['at_inn'];
                  travelToInn.cost = 1;
                  extra.push(travelToInn);

                  const restAtInn = async (client, session) => {
                    const restResult = await rest(client, session);
                    return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                  };
                  restAtInn.atomic = 'rest_at_inn';
                  restAtInn.pre = ['at_inn'];
                  restAtInn.effects = ['healthy'];
                  restAtInn.cost = 1;
                  extra.push(restAtInn);
                } else {
                  // No reachable inn. Rest in place.
                  const recover = async (client, session) => {
                    const restResult = await rest(client, session);
                    return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                  };
                  recover.atomic = 'recover';
                  recover.pre = [];
                  recover.effects = ['healthy'];
                  recover.cost = 1;
                  extra.push(recover);
                }
              }
            }
            if (alreadyInn) {
              const recover = async (client, session) => {
                const restResult = await rest(client, session);
                return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
              };
              recover.atomic = 'recover';
              recover.pre = [];
              recover.effects = ['healthy'];
              recover.cost = 1;
              extra.push(recover);
            }
          }
        }
      }
      // Rest is already in ALWAYS (the standard action set), so
      // no need to inject it here. The can_rest_higher goal
      // already has rest available.
      // Inject travel_to a hunt room when the character is armed but
      // has no target. The character needs to go fight something to
      // generate money/loot. Find the nearest room with huntable mobs
      // at or below the character's level.
      if (ws.armed === true && (ws.has_target === false || ws.target_in_band === false)) {
        const here = c.room?.num ?? c.room?.id;
        const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
        const levelCeiling3 = level + (this.policy?.threatBand ?? Math.floor(level / 2));
        if (here != null) {
          const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
          const resolvedHere = resolveMapRoom(here, this._roomName());
          const hunt = nearestHuntRoom(resolvedHere, levelCeiling3);
          if (hunt && hunt.hops > 0) {
            // Travel to a hunt room with mobs.
            const travelToHunt = (client, session) => {
              return this._travelOneHop(hunt.path[0] ?? hunt.room);
            };
            travelToHunt.atomic = 'travel_to';
            travelToHunt.pre = [];
            // Reaching the hunt room is a step toward both has_target (mobs are there)
            // and has_money (we scavenge there). Declaring both lets the planner chain
            // travel_to directly for the has_money goal without needing scavenge to be
            // injected in the destination room (the planner is room-local).
            travelToHunt.effects = ['has_target', 'has_money'];
            travelToHunt.cost = 1;
            extra.push(travelToHunt);
            console.error(`[goap] ${who} hunting: room=${here} -> hunt=${hunt.room} (${hunt.creature} lv${hunt.level}) hops=${hunt.hops}`);
          }
          // If hunt.hops === 0, we're already in a hunt room.
          // Mobs may be respawning; inject scavenge so the planner
          // can plan scavenge -> has_money. When mobs respawn, scavenge
          // finds a target and fights. When there are none, it returns
          // { acted: false, reason: 'no target' } and the character
          // waits for the next pass.
          if (hunt && hunt.hops === 0) {
            const { scavenge } = await import('./m59-act/scavenge.mjs');
            extra.push(scavenge);
            console.error(`[goap] ${who} in hunt room ${hunt.room} (${hunt.creature} lv${hunt.level}), waiting for mobs`);
          }
        }
      }
      // Inject travel_to a shop ONLY when the character is not
      // armed. An armed character earns money by scavenging
      // (fighting), not by walking to a shop to sell loot. The
      // shop travel is the fallback for unarmed characters who
      // have loot but can't fight.
      if (effectiveGoal === 'has_money' && ws.at_shop === false && ws.armed === false) {
        const here = c.room?.num ?? c.room?.id;
        if (here != null) {
          const { objIdToNum } = await import('./m59-hunt-room.mjs');
          const mapNum = objIdToNum(here) ?? here;
          // Use cached shop destination if we have one, otherwise
          // pick the nearest shop and cache it. This prevents
          // oscillation where the character bounces between rooms
          // because the nearest shop changes direction each pass.
          if (!this._shopDest || this._shopDest === mapNum) {
            const shop = nearestShop(mapNum, this._roomName());
            if (shop) {
              this._shopDest = shop.to;
              console.error(`[goap] ${who} shop dest cached: room=${mapNum} -> shop=${shop.to} hops=${shop.hops.length}`);
            } else {
              // No reachable shop. Clear any stale cache so the
              // character can fall through to other goals.
              if (this._shopDest) {
                console.error(`[goap] ${who} no reachable shop from ${mapNum}, clearing shop cache`);
                this._shopDest = null;
              }
            }
          }
          if (this._shopDest && this._shopDest !== mapNum) {
            const dest = this._shopDest;
            const travelToShop = (client, session) => {
              return this._travelOneHop(dest);
            };
            travelToShop.atomic = 'travel_to';
            travelToShop.pre = [];
            travelToShop.effects = ['at_shop'];
            travelToShop.cost = 1;
            extra.push(travelToShop);
          }
          // Clear the cache when we arrive at the shop.
          if (ws.at_shop === true) this._shopDest = null;
        }
      }
    }

    // When a hostile is present and the goal is 'healthy', remove plain `rest`
    // from the action set so the planner is forced to use `recover` (which
    // includes fleeing / safe-spot before resting). Resting in the open while
    // a mob is in reach is how characters die.
    const planFilter = new Set();
    if (effectiveGoal === 'healthy' && ws.has_target === true) planFilter.add('rest');
    if (this._blockTravel) planFilter.add('travel_to');
    const p = planFor(c, { [effectiveGoal]: true }, { session: this.session, policy: this.policy, agent: this.policy.agent, extra, filter: planFilter.size ? planFilter : null });
    // Record the plan for the dashboard / hero page. A visible plan is
    // the only plan you can argue with.
    this._lastPlan = {
      goal: effectiveGoal,
      found: p.found,
      names: p.names ?? [],
      reason: p.reason ?? null,
      ws: wsSummary,
      pass: this._passCount,
      at: Date.now(),
      // Target info for the 3D view: which object is being engaged,
      // whether it's in band, and whether it's a player.
      target: ws._targetId ? {
        id: ws._targetId,
        in_band: ws.target_in_band,
        is_player: ws._targetIsPlayer,
      } : null,
    };
    console.error(`[goap] ${who} pass ${this._passCount} PLAN found=${p.found} names=[${(p.names ?? []).join(', ')}] steps=${p.steps?.length ?? 0} problems=${(p.problems ?? []).length}`);

    if (p.problems?.length) {
      console.error(`[goap] ${who} pass ${this._passCount} PROBLEMS: ${p.problems.join('; ')}`);
      this.note('goap plan problems', { problems: p.problems });
      return { acted: false, action: null, reason: p.problems.join('; ') };
    }

    if (!p.found) {
      // No plan. This is an answer, not a failure: something the plan needs
      // is absent. The character idles until the world changes.
      this.note('goap no plan', { goal: this.goal, reason: p.reason ?? 'goal not reachable', pass: this._passCount });
      console.error(`[goap] ${this.policy.agent ?? this.session?.s?.name ?? '?'} pass ${this._passCount} NO PLAN: ${p.reason ?? 'goal not reachable'}`);
      return { acted: false, action: null, reason: `no plan: ${p.reason ?? 'goal not reachable'}` };
    }

    // 4. Execute one step.
    if (!p.steps?.length) {
      console.error(`[goap] ${who} pass ${this._passCount} PLAN EMPTY: found=${p.found} names=[${(p.names ?? []).join(', ')}]`);
      return { acted: false, action: null, reason: 'plan is empty' };
    }

    console.error(`[goap] ${who} pass ${this._passCount} EXEC step=${p.steps[0]?.atomic ?? '?'}`);
    // Pass the threat ceiling to atomics that need it (scavenge uses it
    // for its band check). Without this, the scavenge uses myLevel*2
    // which is looser than the GOAP's myLevel+threatBand, and the
    // character walks toward a mob it should be running from.
    const charLevel2 = c.vitals?.()?.health?.max ?? 20;
    const mapRoomNum = resolveMapRoom(c.room?.num ?? c.room?.id ?? null, this._roomName());
    const execArgs = { threatCeiling: ws._threatCeiling ?? null, targetInBand: ws.target_in_band ?? null, huntLevel: this.policy.huntLevel ?? charLevel2, threatBand: this.policy.threatBand ?? Math.floor(charLevel2 / 2), mapRoomNum };
    const result = await stepPlan(c, this.session, p, { index: 0, args: execArgs });
    console.error(`[goap] ${who} pass ${this._passCount} EXEC done acted=${result.acted} reason=${result.reason ?? 'none'}`);

    // Track travel in progress: if this step WAS a travel_to
    // (regardless of whether it completed), mark it so the next
    // pass doesn't cancel it with a new travel command. The
    // broker's travel() can take many seconds, and a new travel
    // issued during that time cancels the old one.
    const stepName = p.names?.[0] ?? result.action ?? '';
    // Only track travel in progress when the travel ACTUALLY SENT A PACKET
    // (acted=true). If the travel was refused (acted=false), do NOT set the guard —
    // let the next pass re-plan immediately, possibly with a different approach.
    // A refused travel means nothing is in motion, so there is no movement to protect.
    if (stepName === 'travel_to' && result.acted === true) {
      this._travelInFlight = true;
      this._travelFromRoom = c?.room?.num ?? c?.room?.id;
      this._travelStartedAt = Date.now();
      console.error(`[goap] ${who} travel in flight from room=${this._travelFromRoom}`);
    } else if (stepName === 'travel_to' && result.acted !== true) {
      // Travel refused: clear any stale guard so the next pass re-plans.
      this._travelInFlight = false;
      this._travelFromRoom = null;
      this._travelStartedAt = null;
    }

    const actionName = result.action ?? p.names?.[0] ?? 'unknown';
    this.note('goap step', {
      action: actionName,
      result: result.result,
      acted: result.acted,
      pass: this._passCount,
      plan: p.names ?? [],
    });
    console.error(`[goap] ${this.policy.agent ?? this.session?.s?.name ?? '?'} pass ${this._passCount} ACTION=${actionName} plan=[${(p.names ?? []).join(' -> ')}] ${result.acted ? 'acted' : 'refused: ' + (result.reason ?? '?')}`);

    return {
      acted: result.acted === true,
      action: actionName,
      reason: result.reason ?? null,
    };
  }
}
