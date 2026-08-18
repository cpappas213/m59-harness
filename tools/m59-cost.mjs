#!/usr/bin/env node
// m59-cost.mjs -- WHAT AN ACTION COSTS, IN SECONDS OF A CHARACTER'S LIFE.
//
// Every action costing 1 makes a swing and a walk across the world interchangeable,
// so the planner will cheerfully route a starving character through three towns to
// save one cast. Cost is what stops that, and the unit is TIME: expected seconds.
//
// Seconds rather than an abstract score, for three reasons. It is measurable
// against the wire (SWING_MS is 1050 because that is the server's swing timer). It
// composes — a plan's cost is how long the plan takes, which is a sentence an
// operator can check. And it has an obvious meaning when two plans tie.
//
// ── THE BOUNDARY THAT MUST NOT MOVE ─────────────────────────────────────────
//
// COST IS EFFORT. COST IS NEVER RISK.
//
// The obvious next feature is a danger term: this room is nasty, add 40. Do not.
// docs/keeper-rebuild-plan.md §2 is built on the opposite:
//
//   A COST CAN BE OUTBID. A REFUSAL CANNOT.
//
// Weight danger at 40 and a goal worth 50 walks straight through it. Weight it at
// 10,000 and you have written a refusal in the least legible way available, one
// that silently becomes negotiable the day somebody adds a bigger reward. Every
// survival rule this repository has paid for is a refusal — threatCeiling() returns
// null on unknown max health and every caller reads null as refuse; leaveHold
// refuses a discretionary departure below the rest threshold; selling is an
// allowlist. Those live in `pre`, where no arithmetic reaches them.
//
// So the rule, and it is checkable: an action's cost may depend on DISTANCE, on
// REPETITION, and on the SERVER'S OWN TIMERS. It may not depend on what might
// happen to the character. If a fact should stop a plan, it is a precondition.
//
// ── WHY THESE NUMBERS ───────────────────────────────────────────────────────
//
// They are the atomics' own pacing, which is the server's:
//
//   attack  1.05s  the swing timer the keeper paces to
//   cast    1.05s
//   eat     0.9s
//   equip   0.7s   a use, plus waiting for the use list to come back
//   step    0.6s   ONE square; a route of n hops costs n times this
//   rest    0.4s   the posture change only — SITTING is not modelled here
//   stand   0.4s
//
// `rest` is the one to be careful with. The ACTION is a posture change and costs
// almost nothing; the RECOVERY is minutes, and it is not this atomic. Charging rest
// 0.4s is honest about what the atomic does and would be dishonest as a model of
// healing — which is exactly why restUntil is not an atomic (it loops) and why
// "am I recovered" is a precondition question rather than a sleep.

export const SECONDS = Object.freeze({
  attack: 1.05,
  cast:   1.05,
  eat:    0.9,
  equip:  0.7,
  step:   0.6,
  rest:   0.4,
  stand:  0.4,
});

// A plain fallback, deliberately not 0: an unpriced action must not look free, or
// the planner will prefer whatever nobody has costed yet. One second is the rough
// scale of everything on this wire.
export const DEFAULT_SECONDS = 1.0;

/**
 * costOf(action, ctx) -> seconds
 *
 * `action` is either an atomic function (tagged `.atomic`) or a descriptor with
 * `.name`. Grounded actions carry names like "cast create food", so the base verb
 * is the first word.
 *
 * ctx may carry:
 *   hops   number   for `step`, how many squares the leg is (default 1)
 */
export function costOf(action, ctx = {}) {
  const name = String(action?.atomic ?? action?.name ?? '');
  const verb = name.split(' ')[0];
  const base = SECONDS[verb] ?? DEFAULT_SECONDS;

  // DISTANCE IS A LEGITIMATE COST INPUT and it is the one that matters most: a leg
  // of twenty squares really is twenty times a leg of one, and without this the
  // planner treats "walk across the room" and "walk across the world" alike.
  if (verb === 'step') return base * Math.max(1, ctx.hops ?? 1);

  return base;
}

/**
 * priced(actions, ctx) -> actions with `.cost` filled in.
 *
 * Non-destructive: returns new descriptors, so the same atomic can be priced
 * differently in two contexts (a step of one square and a step of twenty) without
 * either mutating the module-level function.
 */
export function priced(actions, ctx = {}) {
  return actions.map(a => ({ ...a, cost: a.cost ?? costOf(a, ctx) }));
}

/**
 * Does any action's cost depend on something it must not?
 *
 * This is a TEST HOOK, not a runtime guard, and it exists because the boundary
 * above is the kind that erodes by one reasonable-looking commit at a time. It
 * reports any action whose declared cost is large enough to be a refusal wearing a
 * number — the shape somebody reaches for when they want a precondition but write
 * a weight instead.
 */
export const REFUSAL_IN_DISGUISE = 100;   // seconds; nothing honest here is near it

export function suspiciousCosts(actions) {
  return actions
    .filter(a => Number(a.cost) >= REFUSAL_IN_DISGUISE)
    .map(a => `${a.name ?? a.atomic}: cost ${a.cost}s is not a cost, it is a refusal — ` +
              'put it in `pre`, where arithmetic cannot reach it');
}
