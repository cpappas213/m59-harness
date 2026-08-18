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

// ROOMS THAT HAVE SHOPS. A shop is any room where a merchant with a buy
// list can be found. We use room names as a proxy: inns, taverns, shops,
// banks, smithies, and apothecaries all have merchants.
const SHOP_RE = /inn|tavern|shop|store|market|apothecary|smith|armourer|jeweller|bank|pawn|general|merchant/i;

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
function nearestShop(fromNum, { avoid } = {}) {
  const shops = shopRooms();
  if (!shops.length) return null;
  try {
    const map = loadMap();
    let best = null;
    for (const to of shops) {
      if (to === fromNum) continue;
      const p = findPath(map, fromNum, to, { avoid });
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
  }

  /**
   * Take one hop toward a destination room. Uses the legacy router to
   * find the next exit and the session to walk it. This is the travel
   * primitive the planner uses: one room at a time, re-planning after
   * each hop.
   */
  async _travelOneHop(to) {
    const c = this.client;
    const here = c?.room?.num;
    if (here == null || here === to)
      return { sent: false, reason: 'already there or unknown room' };

    try {
      const map = loadMap();
      const p = findPath(map, here, to);
      if (!p?.found || !p.hops?.length)
        return { sent: false, reason: `no route from ${here} to ${to}` };

      // The first hop is the next room.
      const next = p.hops[0];
      // Use the legacy travel method for one hop. maxHops:1 ensures
      // we only take one step.
      const r = await this.session.travel(next, { maxHops: 1 });
      if (r?.arrived)
        return { sent: true, reason: null };
      return { sent: false, reason: r?.reason ?? 'hop refused' };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

  /**
   * One pass: evaluate, plan, execute one step.
   *
   * Returns { acted: boolean, action: string|null, reason: string|null }
   * so the autopilot can log what happened.
   */
  async pass() {
    const c = this.client;
    if (!c) {
      return { acted: false, action: null, reason: 'no client' };
    }
    // Note: the autopilot checks s.live before calling pass(). The GOAP keeper
    // does not re-check state because the fake client used in tests does not
    // set it, and the autopilot is the one that knows whether the session is
    // alive.

    this._passCount++;

    // 1. Read the world state.
    const ws = evaluate({ client: c, policy: this.policy, agent: this.policy.agent });

    // Visible log: every GOAP pass is logged to the broker console so the
    // journal (in-memory, lost on restart) is not the only record.
    const wsSummary = Object.entries(ws).filter(([,v]) => v !== null)
      .map(([k,v]) => `${k}=${v}`).join(' ');
    const who = this.policy.agent ?? this.session?.s?.name ?? this.session?.name ?? '?';

    // 2. GOAL STACK. Try goals in priority order. The first goal that
    //    is NOT satisfied becomes the effective goal. This is the
    //    "what should I be doing right now" question.
    //
    //    Priority: survival (underworld) > safety (armed) > sustenance
    //    (has_food) > primary goal (vigor_ok or configured).
    const goalStack = [
      { goal: '!in_underworld', when: ws.in_underworld === true },
      { goal: 'armed',         when: ws.armed === false },
      // has_food: only try when the character CAN get food (has
      // reagents to cast create food, or has money to buy).
      // Otherwise, skip to the next goal: rest to the cap (80).
      { goal: 'has_food',      when: ws.has_food === false && (ws.has_reagents === true || ws.has_money === true) },
      { goal: 'has_money',     when: ws.has_money === false && ws.has_loot === true },
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
    console.error(`[goap] ${who} pass ${this._passCount} room=${c.room?.name ?? '?'}(${c.room?.num ?? '?'}) goal=${effectiveGoal} ${wsSummary}`);

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
      // Inject scavenge when the character is unarmed and there are
      // hostiles in the room. This is the "punch rats" fallback:
      // fight a weak creature to loot money.
      if (ws.armed === false && ws.has_target === true) {
        const { scavenge } = await import('./m59-act/scavenge.mjs');
        extra.push(scavenge);
      }
      // Inject travel_to when we need to get to a shop. This covers
      // two cases: (1) we need money (has_money=false, has_loot=true)
      // to sell, and (2) we need food (has_food=false, has_money=true)
      // to buy.
      const needsShop = (ws.at_shop === false && ws.has_money === true)
                      || (ws.at_shop === false && ws.has_loot === true && ws.has_money === false);
      if (needsShop) {
        const here = c.room?.num;
        if (here != null) {
          const shop = nearestShop(here);
          if (shop) {
            const travelToShop = (client, session) => {
              return this._travelOneHop(shop.to);
            };
            travelToShop.atomic = 'travel_to';
            travelToShop.pre = [];
            travelToShop.effects = ['at_shop'];
            travelToShop.cost = 1;
            extra.push(travelToShop);
          }
        }
      }
    }

    const p = planFor(c, { [effectiveGoal]: true }, { session: this.session, policy: this.policy, agent: this.policy.agent, extra });
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
    const result = await stepPlan(c, this.session, p, { index: 0 });
    console.error(`[goap] ${who} pass ${this._passCount} EXEC done acted=${result.acted} reason=${result.reason ?? 'none'}`);

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
