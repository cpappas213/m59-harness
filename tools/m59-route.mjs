#!/usr/bin/env node
// m59-route.mjs -- GETTING SOMEWHERE, UNDER A TICK.
//
// A route is the thing that most obviously does not fit a blocking model, and it is why
// the old one looked reasonable for so long: "walk to room 52" reads like one operation.
// It is not. It is a hundred decisions taken a tenth of a second apart, and writing it
// as one call is what produced `walkTo(maxSteps: 30)` inside `for (attempt of 5)` --
// 150 steps in a single await, with nothing sampling health.
//
// THE WHOLE IDEA HERE IS THAT A ROUTE IS STATE, NOT A LOOP. The router holds a
// destination and a current leg; each tick it looks at where the server says we are,
// decides the single next square, sends it, and returns. Progress is OBSERVED between
// ticks rather than assumed within a call, which is what makes it interruptible: any
// tick can decide to do something else entirely and nothing has to be unwound.
//
// ---------------------------------------------------------------------------
// WHAT IS EXPENSIVE AND WHAT IS NOT
// ---------------------------------------------------------------------------
//
// `World.exits()` runs flood fills to price every staging square -- its own comment
// records that a fresh A* per opening once made one call take tens of seconds. That is
// fine occasionally and ruinous every tick. So it is called ONLY when the leg changes,
// which is when the room changes, and the answer is cached as the leg.
//
// The per-tick cost after that is arithmetic: compare two coordinates, pick a direction,
// send one square. `findPath` and `resolveRoom` are synchronous and in-memory, and they
// too only run on a room change.
//
// ---------------------------------------------------------------------------
// EXITS ARE NOT DOORS AND THEY ARE NOT 1:1
// ---------------------------------------------------------------------------
//
// Walking from A to B does not put you where the return trip starts, and the edge back
// to A can be most of a room away from where you arrive. So the leg is recomputed from
// scratch on every room change rather than reversed, inverted, or remembered.
import { loadMap, findPath } from './m59-map.mjs';
import { objIdToNum } from './m59-hunt-room.mjs';
import { Mover } from './m59-mover.mjs';
import { KOD_FINENESS } from './m59-roo.mjs';

// WHICH MAP ROOM ARE WE ACTUALLY IN.
//
// The live room id and the map's room numbers are different namespaces that OVERLAP, and
// the overlap is silent. Watched live: JayB standing in "Raza" with a live id of 2013,
// which is a perfectly real map room called "The East Tower" -- so a router that trusted
// the number planned a route from a tower on the other side of the world and reported
// "no route" for ever.
//
// So the order is EVIDENCE FIRST and the raw number LAST:
//
//   1. the bake's own objId -> map num table. The server's object id is unambiguous.
//   2. the room NAME. The server tells us what the room is called; a name that matches
//      exactly one map room settles it.
//   3. the raw number, ONLY if the map knows it AND nothing above disagreed.
//
// m59-keeper-goap.mjs's resolveMapRoom has the same job and tries the raw number FIRST,
// returning it whenever it happens to be a map key -- which is exactly the case that is
// wrong, and is the bug above.
let _byName = null;
export function resolveRoomNum({ id = null, num = null, name = null } = {}, map = null) {
  const m = map ?? loadMap();
  const byObj = objIdToNum(id ?? num);
  if (byObj != null && m?.rooms?.[byObj]) return byObj;

  if (name) {
    if (!_byName) {
      _byName = new Map();
      for (const [n, r] of Object.entries(m?.rooms ?? {})) {
        if (!r?.name) continue;
        // A name that belongs to more than one room settles nothing, so it is dropped
        // rather than guessed between.
        _byName.set(r.name, _byName.has(r.name) ? null : Number(n));
      }
    }
    const hit = _byName.get(name);
    if (hit != null) return hit;
  }

  if (num != null && m?.rooms?.[num]) return Number(num);
  if (id != null && m?.rooms?.[id]) return Number(id);
  return null;
}

// How long a character may stand on the same square, while it has somewhere to be,
// before the leg is treated as wrong rather than slow. WALL CLOCK, not ticks: ticks
// coalesce under load, so a tick-count deadline gets longer exactly when the loop is
// already struggling.
const STUCK_MS = Number(process.env.M59_ROUTE_STUCK_MS || 4000);
// How long a leg may take before it is replanned even without being visibly stuck.
const LEG_MAX_MS = Number(process.env.M59_ROUTE_LEG_MAX_MS || 30000);
// MULTI-LEG BOUNDS. When the leg's standOn is not directly fine-reachable (a fence, a
// ledge, a walled alcove), the router decomposes the approach into sub-legs: a chain of
// intermediate waypoints, each individually reachable. These cap the decomposition so a
// genuinely unreachable standOn cannot loop the planner forever.
const SUBLEG_MAX = Number(process.env.M59_ROUTE_SUBLEG_MAX || 32);      // max waypoints in a chain
const SUBLEG_REPLAN_MS = Number(process.env.M59_ROUTE_SUBLEG_REPLAN_MS || 8000); // no-progress before re-plan
const SUBLEG_MAX_REPLANS = Number(process.env.M59_ROUTE_SUBLEG_REPLANS || 3);   // re-plans before giving up
// How far (in squares) to search outward from the standOn for the nearest reachable
// approach point. The door of a walled alcove is usually 1-4 squares from the closest
// square the character can actually stand on.
const APPROACH_SEARCH_RADIUS = Number(process.env.M59_ROUTE_APPROACH_RADIUS || 4);

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export class Router {
  constructor({ session, map = null, stuckMs = STUCK_MS, legMaxMs = LEG_MAX_MS,
                now = () => Date.now() } = {}) {
    if (!session) throw new Error('Router: no session');
    this.session = session;
    this.map = map ?? loadMap();
    this.stuckMs = stuckMs;
    this.legMaxMs = legMaxMs;
    this.now = now;
    this.dest = null;
    this.leg = null;
    this.mark = null;      // { col, row, at } -- the last place we noticed we were
    this.lastState = 'idle';
    this.mover = new Mover(session);
    // MULTI-LEG STATE. When the leg's standOn needs an intra-room sub-journey (around a
    // fence, up a ledge), `subWp` holds the ordered waypoints to reach, in squares. The
    // router walks to subWp[0] first; on arrival it shifts and re-plans the rest. `subWp`
    // ends at the standOn itself, so reaching the end IS reaching the door. The
    // `_subWpPlanAt`/`_subWpReplans` fields bound the no-progress re-planning.
    this.subWp = null;        // [ {col,row}, ... ] or null when the leg is a plain walk
    this._subWpPlanAt = 0;    // wall-clock ms of the last sub-leg (re)plan
    this._subWpReplans = 0;   // how many times we've re-planned the current leg's sub-legs
  }

  to(roomNum) {
    const n = Number(roomNum);
    if (!Number.isFinite(n)) return false;
    if (this.dest !== n) { this.dest = n; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0; }
    return true;
  }

  clear() { this.dest = null; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0; this.lastState = 'idle'; }

  status() {
    return { dest: this.dest, state: this.lastState,
             leg: this.leg ? { to: this.leg.next, stand_on: this.leg.standOn } : null };
  }

  // THE EXPENSIVE HALF, run only on a room change.
  _planLeg(here) {
    // A new room: the reachability cache (keyed by room) is for the old room now.
    this._reachCache = null;
    const world = this.session?.world;
    if (!world) return { why: 'no world' };
    let hops = null;
    try {
      const p = findPath(this.map, here, this.dest);
      if (p?.found) hops = p.hops ?? [];
    } catch (e) { return { why: `route failed: ${e.message}` }; }
    if (!hops) return { why: `no route from ${here} to ${this.dest}` };

    const next = hops.length ? (hops[0].to ?? hops[0]) : this.dest;
    let exits = [];
    try { exits = world.exits() ?? []; } catch (e) { return { why: `exits failed: ${e.message}` }; }
    // PREFER EXITS WHOSE STAND_ON IS REACHABLE. A go/edge exit whose stand_on square
    // is walled off (a fence, a ledge) makes the leg target an unreachable square and
    // the character oscillates against the wall forever. `reachable` is computed by
    // world.exits() via this.reach(). If the primary is unreachable but the exit
    // carries alternates (other squares on the same boundary), try those first — a
    // wide edge often has a passable square even when the nearest one is blocked.
    const cands = exits.filter(e => Number(e.to) === Number(next) && e.stand_on);
    const byReach = (a, b) => ((b.reachable === true) - (a.reachable === true))
      || ((a.steps_away ?? 1e9) - (b.steps_away ?? 1e9));
    cands.sort(byReach);
    const exit = cands.find(e => e.reachable !== false) ?? cands[0];
    if (!exit) return { why: `no usable exit from ${here} toward ${next}` };
    // If the chosen exit's stand_on is unreachable and it has alternates, fall back to
    // the first reachable alternate.
    let standOn = exit.stand_on;
    if (exit.reachable === false && Array.isArray(exit.alternates) && exit.alternates.length) {
      const alt = exit.alternates.find(a => a.reachable !== false && a.stand_on)
        ?? exit.alternates.find(a => a.stand_on);
      if (alt?.stand_on) standOn = alt.stand_on;
    }

    // Compute an edge target if the exit doesn't provide one.
    // The edge target is one square beyond the staging square,
    // in the direction of the exit. Walking to it triggers
    // the room change.
    let edgeTarget = exit.edge_target ?? null;
    if (!edgeTarget && exit.direction) {
      const dir = exit.direction.toLowerCase();
      const dx = dir === 'east' ? 1 : dir === 'west' ? -1 : 0;
      const dy = dir === 'south' ? 1 : dir === 'north' ? -1 : 0;
      edgeTarget = { col: standOn.col + dx, row: standOn.row + dy };
    }

    return { leg: { fromRoom: here, next, standOn,
                    edgeTarget,
                    direction: exit.direction ?? null,
                    kind: exit.kind ?? 'walk',
                    startedAt: this.now() } };
  }

  // The room's fine geometry, or null. The sub-leg planner needs it to test reachability
  // of intermediate squares. Read fresh each call (the room can change under us).
  _geo() { return this.session?.world?.geometry ?? null; }

  // Is square (col,row) reachable from (fromCol,fromRow) on the COARSE grid? The coarse
  // grid is a fast (sub-ms) reachability oracle. It is deliberately used here rather than
  // the fine model: the fine finePathProtocol takes ~1.8s per BLOCKED square, which would
  // stall the tick loop. The coarse grid can over-promise (it misses thin fences/ledges),
  // but the Mover re-validates every step with the fine model when actually walking, so a
  // coarse false-positive just costs one re-plan, not a correctness failure. A
  // coarse false-negative (rare) is bounded by the approach search radius.
  _reachable(geo, fromCol, fromRow, toCol, toRow) {
    if (!geo?.path) return null;  // no oracle: caller treats as "unknown"
    // path() is 1-indexed. Guard against out-of-bounds squares.
    if (toCol < 1 || toRow < 1 || toCol > geo.cols || toRow > geo.rows) return false;
    if (fromCol < 1 || fromRow < 1 || fromCol > geo.cols || fromRow > geo.rows) return false;
    try {
      const r = geo.path(fromRow, fromCol, toRow, toCol, { fine: false, maxNodes: 4000 });
      return r?.found === true;
    } catch { return null; }
  }

  // Is a single step from (c1,r1) to the adjacent (c2,r2) allowed by the FINE model?
  // This is a CHEAP check (a single traceFineMoveClient, ~1ms) unlike finePathProtocol
  // (a full A*, ~1.8s per blocked square). It is what the Mover effectively enforces
  // step-by-step, so an approach point found with this oracle is one the Mover can
  // actually stand on. Returns true/false, or null if the geometry can't answer.
  _fineStep(geo, c1, r1, c2, r2) {
    if (!geo?.traceFineMoveClient) return null;
    if (c2 < 0 || r2 < 0) return false;
    // Square centres in CLIENT units, using the TRUE centre of each square: col c centre
    // is c * CLIENT_FINENESS + CLIENT_FINENESS/2. This is the absolute position the
    // geometry's wall coordinates are in, so the trace checks the real squares (not the
    // Mover's offset protocol convention, which places square c at the client position of
    // square c-1). traceFineMoveClient takes client units directly.
    const CF = 1024, H = 512;
    const x1 = c1 * CF + H, y1 = r1 * CF + H;
    const x2 = c2 * CF + H, y2 = r2 * CF + H;
    try {
      const t = geo.traceFineMoveClient(x1, y1, x2, y2, { slide: false });
      return t?.arrived === true;
    } catch { return null; }
  }

  // The set of squares fine-reachable from (fromCol,fromRow), found by a BOUNDED BFS
  // using single-step fine traces as the edge test. Bounded by maxSteps (total squares
  // visited) so it cannot run away. Returns a Set of "col,row" keys. This matches the
  // Mover's fine model (unlike the coarse grid, which over-promises across fences/ledges)
  // while staying fast (~1ms per edge).
  //
  // CACHED PER (room, start square): the reachability set is a property of the room's
  // geometry + the start position, both of which are stable while the character is in
  // the room working toward a standOn. Without the cache, every leg re-plan (triggered
  // by the stuck-detection when the character holds at the approach point) re-runs the
  // 400-step BFS, stalling the tick loop (observed: 1.7s decide() sustained).
  _fineReachableSet(geo, fromCol, fromRow, maxSteps = 400) {
    const roomKey = this.session?.world?.room?.num ?? this.session?.client?.room?.id ?? '?';
    const cacheKey = `${roomKey}:${fromCol},${fromRow}`;
    if (!this._reachCache) this._reachCache = new Map();
    const hit = this._reachCache.get(cacheKey);
    if (hit) return hit.set;
    const seen = new Set();
    const queue = [[fromCol, fromRow]];
    seen.add(`${fromCol},${fromRow}`);
    const DIRS = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let visited = 0;
    while (queue.length && visited < maxSteps) {
      const [c, r] = queue.shift();
      visited++;
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        const key = `${nc},${nr}`;
        if (seen.has(key)) continue;
        const ok = this._fineStep(geo, c, r, nc, nr);
        if (ok !== true) continue;  // fine model refuses the step (wall/ledge)
        seen.add(key);
        queue.push([nc, nr]);
      }
    }
    // Bound the cache (room changes + a handful of start squares); evict the oldest.
    if (this._reachCache.size > 32) {
      const oldest = this._reachCache.keys().next().value;
      this._reachCache.delete(oldest);
    }
    this._reachCache.set(cacheKey, { set: seen, at: Date.now() });
    return seen;
  }

  // The CLOSEST square to `standOn` that is FINE-reachable from `me`. This is the
  // approach point: where the character should be before the final (possibly
  // fine-blocked) push into the standOn. It handles the "door is a walled alcove" case
  // — the standOn itself is fine-unreachable, but a nearby square is, and from there the
  // Mover's direct-step fallback (the server is client-authoritative) closes the gap.
  //
  // Uses the FINE model (via a bounded BFS of single-step traces), NOT the coarse grid:
  // the coarse grid over-promises across fences/ledges (it said the door was reachable
  // when the Mover's fine model refused it), which is exactly the disagreement that
  // produced the oscillation. The BFS is bounded (maxSteps) so it stays fast (~1ms per
  // edge). Searches outward from the standOn in expanding rings, returning the first ring
  // that contains a fine-reachable square, and within it the closest such square.
  _findApproach(me, standOn) {
    const geo = this._geo();
    if (!geo) return { col: standOn.col, row: standOn.row, dist: 0 };
    // One bounded BFS gives the whole fine-reachable region from `me`.
    const reach = this._fineReachableSet(geo, me.col, me.row, 400);
    // The standOn itself, if reachable, is the best approach point.
    if (reach.has(`${standOn.col},${standOn.row}`))
      return { col: standOn.col, row: standOn.row, dist: 0 };
    for (let radius = 1; radius <= APPROACH_SEARCH_RADIUS; radius++) {
      let best = null;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;  // this ring only
          const c = standOn.col + dc, r = standOn.row + dr;
          if (!reach.has(`${c},${r}`)) continue;
          const dist = Math.hypot(c - standOn.col, r - standOn.row);
          if (!best || dist < best.dist) best = { col: c, row: r, dist };
        }
      }
      if (best) return best;
    }
    // Nothing within the radius is fine-reachable: fall back to the standOn itself. The
    // Mover will do its best (direct-step fallback); the sub-leg bound keeps this bounded.
    return { col: standOn.col, row: standOn.row, dist: Infinity };
  }

  // Build a BOUNDED chain of waypoints from `me` to `target`, each consecutive pair
  // fine-reachable (a single fine step). Uses a BFS on the fine model (via _fineStep) with
  // PARENT TRACKING, so it finds the actual shortest fine-reachable path — including routes
  // that must go AWAY from the target first to go around a fence/ledge (the greedy monotone
  // expansion could not do this: hill-climbing can't navigate an obstacle that requires a
  // detour). If `target` is directly fine-reachable, the chain is [target]. If it is not
  // (a fine island, like a door), the chain ends at the closest fine-reachable square to the
  // target (the approach point); the Mover's raw-door-push closes the final fine-blocked gap.
  //
  // Bounded: the BFS visits at most maxSteps squares, and the returned chain is capped at
  // SUBLEG_MAX waypoints (the rest are implied by the Mover's per-tick stepping). Returns
  // { chain, complete } where complete is true only if the last waypoint is the target.
  _planSubLegs(me, target) {
    const geo = this._geo();
    if (!geo) return { chain: [{ col: target.col, row: target.row }], complete: true };
    // BFS from `me` with parent tracking, using _fineStep as the edge test.
    const startKey = `${me.col},${me.row}`;
    const parent = new Map([[startKey, null]]);  // key -> parent key
    const queue = [[me.col, me.row]];
    const DIRS = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let visited = 0;
    const maxSteps = 800;  // bounded: 800 fine steps, ~0.2ms each = ~160ms worst case
    const goalKey = `${target.col},${target.row}`;
    let foundGoal = false;
    while (queue.length && visited < maxSteps) {
      const [c, r] = queue.shift(); visited++;
      const key = `${c},${r}`;
      if (key === goalKey) { foundGoal = true; break; }
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        const nk = `${nc},${nr}`;
        if (parent.has(nk)) continue;
        if (this._fineStep(geo, c, r, nc, nr) !== true) continue;  // fine model refuses
        parent.set(nk, key);
        queue.push([nc, nr]);
      }
    }
    if (foundGoal) {
      // Reconstruct the path from `me` to `target`.
      const path = [];
      let cur = goalKey;
      while (cur) {
        const [c, r] = cur.split(',').map(Number);
        path.unshift({ col: c, row: r });
        cur = parent.get(cur);
      }
      // Drop the start (we're already there) and cap at SUBLEG_MAX waypoints.
      const chain = path.slice(1);
      if (chain.length <= SUBLEG_MAX) return { chain, complete: true };
      // Too long: return the first SUBLEG_MAX waypoints (the Mover walks the rest).
      return { chain: chain.slice(0, SUBLEG_MAX), complete: false };
    }
    // The target is fine-unreachable. Find the closest fine-reachable square to it
    // (INCLUDING the start — if we're already at the closest fine-reachable square, the
    // chain is empty and the raw-door-push handles the final gap).
    let best = null;
    for (const key of parent.keys()) {
      const [c, r] = key.split(',').map(Number);
      const d = Math.hypot(c - target.col, r - target.row);
      if (!best || d < best.d) best = { c, r, d };
    }
    if (!best) return { chain: [{ col: target.col, row: target.row }], complete: false };
    // Reconstruct the path from `me` to the approach point.
    const path = [];
    let cur = `${best.c},${best.r}`;
    while (cur) {
      const [c, r] = cur.split(',').map(Number);
      path.unshift({ col: c, row: r });
      cur = parent.get(cur);
    }
    const chain = path.slice(1);
    if (chain.length <= SUBLEG_MAX) return { chain, complete: false };
    return { chain: chain.slice(0, SUBLEG_MAX), complete: false };
  }

  // Set up the sub-leg chain for a freshly planned leg. If the standOn is directly
  // fine-reachable from `me`, there is nothing to decompose (subWp stays null and the
  // leg is a plain walk). Otherwise, plan a bounded chain from `me` toward the standOn;
  // the chain ends at the closest fine-reachable square (the approach point) when the
  // standOn itself is an island. The final push from the approach point into the standOn
  // is left to the Mover's direct-step fallback (the server is client-authoritative, so
  // it accepts a step the fine model refuses).
  _initSubLegs(me) {
    this.subWp = null;
    this._subWpReplans = 0;
    this._subWpPlanAt = this.now();
    const geo = this._geo();
    const standOn = this.leg?.standOn;
    if (!geo || !standOn) return;
    // Fast path: is the standOn directly fine-reachable? (One bounded BFS.)
    const reach = this._fineReachableSet(geo, me.col, me.row, 400);
    if (reach.has(`${standOn.col},${standOn.row}`)) return;  // plain walk
    // The standOn is fine-unreachable: plan a bounded chain toward it. The chain ends at
    // the approach point (closest fine-reachable square); the Mover pushes the last gap.
    const { chain } = this._planSubLegs(me, standOn);
    if (chain.length) this.subWp = chain;
  }

  // We reached the current sub-waypoint (subWp[0]). Advance the chain: drop it, and if
  // the rest is no longer valid (the geometry or our position shifted), re-plan the
  // remainder. Bounded by SUBLEG_MAX_REPLANS so a no-progress loop cannot run forever.
  _advanceSubLeg(me) {
    if (!this.subWp || !this.subWp.length) return;
    this.subWp.shift();
    if (!this.subWp.length) return;  // chain exhausted: the Mover now pushes the door
    // Re-plan the remainder from where we actually are, in case the original chain is
    // stale. Bounded: if we've re-planned too many times, drop the sub-legs and let the
    // Mover's direct fallback + the leg's stuck-detection take over.
    const now = this.now();
    if (now - this._subWpPlanAt > SUBLEG_REPLAN_MS && this._subWpReplans < SUBLEG_MAX_REPLANS) {
      this._subWpReplans++;
      this._subWpPlanAt = now;
      const geo = this._geo();
      const target = this.subWp[this.subWp.length - 1];
      const chain = this._planSubLegs(me, target);
      if (chain.chain.length) this.subWp = chain.chain;
    }
  }

  /**
   * ONE TICK OF TRAVEL. Sends at most one step and returns; never awaits.
   *
   * The returned state is what a decider reads to know whether to keep going, and it is
   * deliberately observational: 'moving' means a step went out, not that it landed.
   */
  tick(frame, act) {
    const t = this.now();
    if (this.dest == null) return this._say('idle');
    const here = resolveRoomNum(frame?.room ?? {}, this.map);
    const me = frame?.position;
    if (here == null || !me) return this._say('blind', { why: 'no room or position yet' });

    if (Number(here) === Number(this.dest)) { this.clear(); return this._say('arrived'); }

    // A ROOM CHANGE INVALIDATES THE LEG, always. Where you arrive is not where the
    // return edge is, so nothing about the old leg survives the crossing.
    if (!this.leg || Number(this.leg.fromRoom) !== Number(here)) {
      const r = this._planLeg(here);
      if (!r.leg) return this._say('no-route', { why: r.why });
      this.leg = r.leg;
      this.mark = { col: me.col, row: me.row, at: t };
      // MULTI-LEG: if the standOn is not directly fine-reachable from where we are,
      // decompose the approach into a chain of sub-waypoints (around a fence, up a
      // ledge, etc.). If it IS reachable, subWp is empty and the leg is a plain walk.
      this._initSubLegs(me);
    }

    if (t - this.leg.startedAt > this.legMaxMs) {
      this.leg = null;
      return this._say('replan', { why: 'leg took too long' });
    }

    // STUCK IS MEASURED ON THE CHARACTER, NOT ON US. Every other stall number in this
    // repository measures the driver -- which is busy and healthy while a character
    // stands in a wall. This compares the SERVER'S position to the last one it gave us.
    if (this.mark && (me.col !== this.mark.col || me.row !== this.mark.row)) {
      this.mark = { col: me.col, row: me.row, at: t };
    } else if (this.mark && t - this.mark.at > this.stuckMs) {
      // Measure BEFORE clearing. Reading this.mark after nulling it printed "NaNs",
      // which is a diagnostic that tells you nothing at the exact moment you need one.
      const held = Math.round((t - this.mark.at) / 1000);
      const where = { col: me.col, row: me.row };
      const aim = this.leg?.standOn ?? null;
      this.leg = null;
      this.mark = null;
      return this._say('stuck', { why: `same square (${where.col},${where.row}) for ${held}s` +
                                       (aim ? `, aiming at (${aim.col},${aim.row})` : '') });
    }

    // At the staging square: the crossing is triggered by walking PAST the boundary, so
    // the target is the square outside the grid rather than the one we stand on.
    // For "go" exits, the crossing is triggered by the go command, not by walking.
    //
    // Use client.self (the current position) for the `at` check — the frame's me
    // (world.position) can lag behind, so a character standing on the standOn would
    // not be detected as `at`, and the crossing (or the walk-past-boundary) would never
    // trigger. client.self is updated by every position packet and is the source the
    // probe/room-view use.
    const selfPosAt = this.session?.client?.self;
    const at = (me.col === this.leg.standOn.col && me.row === this.leg.standOn.row)
      || (selfPosAt && selfPosAt.col === this.leg.standOn.col && selfPosAt.row === this.leg.standOn.row);

    if (at && this.leg.kind === 'go') {
      // Fire the go command to transition rooms.
      act.go();
      return this._say('crossing', { next: this.leg.next, why: 'go command fired' });
    }

    // MULTI-LEG: if there is a sub-waypoint chain, the current target is the NEXT
    // sub-waypoint, not the standOn. Reaching it advances the chain. We advance when the
    // character's CURRENT position (client.self, the source the probe uses — more current
    // than world.position, which can lag) is on the sub-waypoint. The frame's position
    // (world.position) can lag behind, which otherwise stalls the advancement and makes
    // the character oscillate at the approach point.
    const sub = this.subWp && this.subWp.length ? this.subWp[0] : null;
    if (sub) {
      const selfPos = this.session?.client?.self;
      const onSub = (selfPos && selfPos.col === sub.col && selfPos.row === sub.row)
        || (me.col === sub.col && me.row === sub.row);
      if (onSub) this._advanceSubLeg({ col: sub.col, row: sub.row });
    }
    const aim = this.subWp && this.subWp.length ? this.subWp[0]
      : (at && this.leg.edgeTarget ? this.leg.edgeTarget : this.leg.standOn);
    if (process.env.M59_ROUTE_DEBUG === '1')
      console.error(`[routedbg] t3 here=${here} me=(${me.col},${me.row}) standOn=(${this.leg.standOn?.col},${this.leg.standOn?.row}) sub=(${sub?sub.col+','+sub.row:'-'}) aim=(${aim.col},${aim.row}) dir=${this.leg.direction} kind=${this.leg.kind} subWp=${this.subWp?this.subWp.length:0}`);

    // Hand the aim to the FINE-MODEL MOVER. It plans on wall segments,
    // moves at most MOVEUNITS per tick, and reports blocked when the
    // geometry says no. The actuator is still used for the actual send
    // (the mover goes through the session's pacer).
    this.mover.to(aim.col, aim.row);
    const mr = this.mover.tick({ col: me.col, row: me.row, x: me.x, y: me.y });
    if (mr.state === 'blocked')
      return this._say('blocked', { why: mr.why, next: this.leg.next });
    if (mr.state === 'standing')
      return this._say('standing', { next: this.leg.next });
    if (mr.state === 'arrived') {
      // Reached the aim. If the aim was a sub-waypoint, advance the chain. If it was the
      // standOn (chain empty), the crossing fires via the 'at' check next tick.
      if (sub) this._advanceSubLeg({ col: me.col, row: me.row });
      if (at) return this._say('crossing', { next: this.leg.next });
      return this._say('moving', { to: aim, next: this.leg.next, why: 'sub-leg reached' });
    }
    if (mr.state === 'blinked') {
      // The blink worked: the character is in a new position.
      // Replan from here: clear the current leg and re-plan.
      this.leg = null;
      this.mark = null;
      return this._say('replanning', { why: 'blink changed position, replanning' });
    }
    if (mr.state === 'blink' || mr.state === 'raw-move' || mr.state === 'stuck') {
      // The mover is trying to escape a geometry pocket.
      // Let it continue: report as moving so the decider
      // doesn't interrupt.
      return this._say('moving', { to: aim, next: this.leg.next, why: mr.state });
    }
    return this._say(at ? 'crossing' : 'moving', { to: aim, next: this.leg.next });
  }

  _say(state, extra = {}) { this.lastState = state; return { state, ...extra }; }
}

// A route intent for m59-decide.mjs. The router is held by the caller, because a route
// is a COMMITMENT that outlives one decision -- putting it in the intent table would
// rebuild it every tick and it would never get anywhere.
export function routeIntent(router) {
  return (frame, act) => {
    const r = router.tick(frame, act);
    const sent = r.state === 'moving' || r.state === 'crossing';
    return { sent, what: sent ? `travel ${r.state} -> ${router.dest}` : null,
             why: sent ? null : (r.why ?? r.state) };
  };
}
