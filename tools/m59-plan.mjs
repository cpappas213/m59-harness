#!/usr/bin/env node
// m59-plan.mjs -- WHAT THIS CHARACTER CAN DO, AND A PLAN OVER IT.
//
// The join between three pieces that were each built to be useless alone:
//
//   m59-act/*          atomics -- one bounded, honest thing each, over (client, session)
//   m59-worldstate     the closed vocabulary, one producer per symbol
//   m59-goap-planner   A* over pre/effects
//
// TWO THINGS HAPPEN HERE THAT ARE THE POINT OF THE WHOLE DESIGN.
//
// 1. THE ACTION SET IS BUILT FROM WHAT THE CHARACTER ACTUALLY HAS. A character that
//    has not learned `create food` gets no cast-create-food action, so no plan can
//    contain one -- not discouraged, absent. Same for every other grounded action.
//    This is how the game itself behaves (an unlearnable skill is missing from the
//    merchant's offer list, monster.kod:4855, rather than refused), and it is the
//    mechanism the plan document calls survival-as-preconditions: a rule expressed
//    as a missing action or an unmet precondition cannot be outbid, where the same
//    rule expressed as a cost can.
//
// 2. THE ACTION SET IS VALIDATED BEFORE THE SEARCH RUNS. Every pre and effect must
//    be a symbol m59-worldstate actually produces. Without that check a typo makes
//    a plan quietly unsatisfiable and the planner can only report "no plan found",
//    which is indistinguishable from "this character genuinely cannot do it". With
//    it, the typo is named. That distinction is the difference between a five-minute
//    fix and the failure mode this repository already lived through once, when
//    policy.purpose sat outside a schema for a year with the yield audit switched
//    off behind it.

import { evaluate, unknowns, validateAll } from './m59-worldstate.mjs';
import { plan as astar } from './m59-goap-planner.mjs';

import { attack }        from './m59-act/attack.mjs';
import { step }          from './m59-act/step.mjs';
import { equip }         from './m59-act/equip.mjs';
import { rest, stand }   from './m59-act/rest.mjs';
import { eat }           from './m59-act/eat.mjs';
import { groundedCasts } from './m59-act/cast.mjs';

// The atomics that are always available -- they need no per-character grounding.
// `step` is deliberately absent: a route is planned by upstream's router (baked
// exit-to-exit paths, planned on the map the mover enforces) and executed a hop at a
// time. Putting a bare `step` in the action set would invite the planner to
// rediscover pathfinding one square at a time, badly.
const ALWAYS = [attack, equip, rest, stand, eat];

/**
 * actionsFor(client) -> [action]
 *
 * Every atomic this character can actually perform right now, grounded. Each carries
 * `pre`, `effects`, `atomic`, and `node` (the callable), which is the shape
 * m59-goap-planner expects.
 */
export function actionsFor(client, { extra = [] } = {}) {
  const all = [...ALWAYS, ...groundedCasts(client), ...extra];
  return all.map(fn => ({
    name: fn.atomic,
    pre: fn.pre ?? [],
    effects: fn.effects ?? [],
    cost: fn.cost ?? 1,
    node: fn,          // the callable atomic: (client, session, args)
    run: fn,
  }));
}

/**
 * planFor(client, goal, opts) -> {
 *   found, steps, names, ws, assumed, problems, reason
 * }
 *
 * `goal` is a plain object of symbol -> boolean, e.g. { vigor_ok: true }.
 *
 * `problems` is non-empty ONLY when the action set names something outside the
 * vocabulary, and in that case NO PLAN IS ATTEMPTED -- a search over a broken action
 * set produces a confident "no plan" for the wrong reason.
 *
 * `assumed` lists the symbols that could not be read and what they fell back to.
 * A plan built entirely on fallbacks is a plan built on no evidence, and today that
 * is invisible: it looks exactly like a confident one. Callers should surface it.
 */
export function planFor(client, goal, { session = null, policy = {}, agent = null,
                                        ws: wsIn = null, extra = [] } = {}) {
  const actions  = actionsFor(client, { extra });
  const problems = validateAll(actions);
  if (problems.length)
    return { found: false, problems, reason: 'the action set names symbols nothing produces' };

  const ctx = { client, session, policy, agent, ws: wsIn ?? {} };
  const ws  = { ...evaluate(ctx), ...(wsIn ?? {}) };

  const out = astar(actions, ws, goal);
  // astar returns `steps` as the collected `node`s; map back to names so a caller
  // can report a plan without executing it. A plan you cannot read is a plan you
  // cannot argue with.
  const names = (out.steps ?? []).map(n => n?.atomic ?? n?.name ?? 'step');

  return {
    ...out,
    names,
    ws,
    assumed: unknowns(ctx),
    problems: [],
  };
}

/**
 * A plan is a claim about a world that will hold still, and this one will not. So
 * execution is one step at a time with a re-read between each -- the caller decides
 * whether to continue, which is what makes the whole thing interruptible.
 *
 * Deliberately NOT a loop that runs a plan to completion: that would be exactly the
 * unbounded await the atomics were built to avoid, and 82% of deaths in this fleet
 * happened while the keeper was blind inside one.
 */
export async function stepPlan(client, session, planned, { index = 0, args = {} } = {}) {
  const node = planned?.steps?.[index];
  if (!node) return { done: true, index };
  const result = await node(client, session, args);
  return { done: false, index: index + 1, action: node.atomic ?? null, result };
}
