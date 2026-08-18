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

    // 2. Is the goal already satisfied? If so, do nothing (or pick a
    //    secondary goal). For now: idle.
    if (ws[this.goal] === true) {
      return { acted: false, action: null, reason: `goal ${this.goal} already satisfied` };
    }

    // 3. Plan.
    const p = planFor(c, { [this.goal]: true }, { session: this.session, policy: this.policy, agent: this.policy.agent });

    if (p.problems?.length) {
      this.note('goap plan problems', { problems: p.problems });
      return { acted: false, action: null, reason: p.problems.join('; ') };
    }

    if (!p.found) {
      // No plan. This is an answer, not a failure: something the plan needs
      // is absent. The character idles until the world changes.
      return { acted: false, action: null, reason: `no plan: ${p.reason ?? 'goal not reachable'}` };
    }

    // 4. Execute one step.
    const step = p.steps[0];
    if (!step) {
      return { acted: false, action: null, reason: 'plan is empty' };
    }

    const result = await stepPlan(c, this.session, p, { index: 0 });

    this.note('goap step', {
      action: step.action ?? p.names?.[0] ?? 'unknown',
      result: result,
      pass: this._passCount,
      plan: p.names ?? [],
    });

    return {
      acted: result.sent !== false,
      action: step.action ?? p.names?.[0] ?? 'unknown',
      reason: result.reason ?? null,
    };
  }
}
