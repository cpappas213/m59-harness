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

// How long a character may stand on the same square, while it has somewhere to be,
// before the leg is treated as wrong rather than slow. WALL CLOCK, not ticks: ticks
// coalesce under load, so a tick-count deadline gets longer exactly when the loop is
// already struggling.
const STUCK_MS = Number(process.env.M59_ROUTE_STUCK_MS || 4000);
// How long a leg may take before it is replanned even without being visibly stuck.
const LEG_MAX_MS = Number(process.env.M59_ROUTE_LEG_MAX_MS || 30000);

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
  }

  to(roomNum) {
    const n = Number(roomNum);
    if (!Number.isFinite(n)) return false;
    if (this.dest !== n) { this.dest = n; this.leg = null; this.mark = null; }
    return true;
  }

  clear() { this.dest = null; this.leg = null; this.mark = null; this.lastState = 'idle'; }

  status() {
    return { dest: this.dest, state: this.lastState,
             leg: this.leg ? { to: this.leg.next, stand_on: this.leg.standOn } : null };
  }

  // THE EXPENSIVE HALF, run only on a room change.
  _planLeg(here) {
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
    const exit = exits.find(e => Number(e.to) === Number(next) && e.stand_on);
    if (!exit) return { why: `no usable exit from ${here} toward ${next}` };

    return { leg: { fromRoom: here, next, standOn: exit.stand_on,
                    edgeTarget: exit.edge_target ?? null,
                    direction: exit.direction ?? null, startedAt: this.now() } };
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
    const here = frame?.room?.num ?? frame?.room?.id ?? null;
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
      this.leg = null;
      this.mark = null;
      return this._say('stuck', { why: `same square for ${Math.round((t - this.mark?.at ?? 0) / 1000)}s` });
    }

    // At the staging square: the crossing is triggered by walking PAST the boundary,
    // so the target is the square outside the grid rather than the one we stand on.
    const at = me.col === this.leg.standOn.col && me.row === this.leg.standOn.row;
    const aim = at && this.leg.edgeTarget ? this.leg.edgeTarget : this.leg.standOn;

    // ONE SQUARE. Not the whole leg: a multi-square request is a walk we cannot
    // interrupt and cannot observe halfway through.
    const nx = me.col + sign(aim.col - me.col);
    const ny = me.row + sign(aim.row - me.row);
    if (nx === me.col && ny === me.row && !at)
      return this._say('arrived-waypoint');

    act.step(nx, ny);
    return this._say(at ? 'crossing' : 'moving', { to: { col: nx, row: ny }, next: this.leg.next });
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
