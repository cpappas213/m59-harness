#!/usr/bin/env node
// m59-act/step.mjs -- ONE STEP to one square. Not a walk, and not a route.
//
// The routing is upstream's and stays there: exit-to-exit paths are baked offline
// (m59-routebake, m59-routes) and planned on the map the mover actually enforces.
// This atomic executes ONE hop of whatever that produced, so that a plan can be
// abandoned between any two squares.
//
// That is the whole reason it exists as an atomic. `travel` is one await that runs
// up to 25 hops with no observation inside it, and travelling is the largest death
// bucket in the record -- 203 deaths, mean 183 seconds since the last look, worst
// case 909. A route executed one bounded step at a time has an interruption point
// after every square, and needs no watchdog reaching into paced loops to cancel it.
//

import { isTerminalMovementReason } from '../m59-movement.mjs';

// KEPT FOR CITATION, NOT PLUMBED — AND THAT IS THE HONEST STATE OF IT.
//
// USER_WALKING_SPEED is 18 (user.kod:46); above it is running, exertion is
// EXERTION_PER_MOVE * (speed*5/6)^2 (quadratic: 1.8x at 24, 2.8x at 30), and below
// VIGOR_RUN_THRESHOLD the server does not slow you down, it SNAPS YOU BACK and logs
// you as a speedhacker.
//
// All true, and none of it reachable from here: the broker's mover is
// `step(col, row, { confirm, beforeMutation })` and takes NO speed. This atomic used
// to accept a `speed` argument and gate it on vigor, which meant an option that
// looked functional, was silently dropped by the mover, and whose guard could
// therefore never fire — the same shape as `typeof c.armed === 'function'` gating a
// branch that has never executed. A lever connected to nothing is worse than no
// lever, so the argument is gone and the knowledge stays here for whoever plumbs it.
export const WALK_SPEED          = 18;   // USER_WALKING_SPEED, user.kod:46
export const VIGOR_RUN_THRESHOLD = 10;   // below this, running is snapped back

/**
 * step(client, session, { col, row, waitMs })
 *
 * Sends one move to the centre of square (col,row) and confirms arrival by
 * reading our own position back. Returns:
 *
 *   { sent, reason, arrived, from:{col,row}, to:{col,row}, at:{col,row}, terminal }
 *
 * `arrived` is the ROOM'S answer, not the send's. A move can be refused by
 * collision with no error on the wire -- the packet goes out, nothing happens, and
 * a caller that trusted the send would carry on walking a route it never started.
 *
 * `terminal` marks a failure that cannot become legal by retrying another heading
 * (upstream's TERMINAL_MOVEMENT_REASONS). A caller must propagate those rather
 * than re-planning into the same wall.
 */
export async function step(client, session, { col, row, waitMs = 600 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  if (!Number.isInteger(col) || !Number.isInteger(row))
    return { sent: false, reason: 'invalid_move_target', terminal: true };

  const me = client.self;
  if (!me || me.col == null || me.row == null)
    return { sent: false, reason: 'own_position_unknown', terminal: true };

  const from = { col: me.col, row: me.row };
  if (from.col === col && from.row === row)
    return { sent: false, reason: 'already there', arrived: true, from, to: { col, row }, at: from };

  // THE VALIDATED MOVER IS REQUIRED, AND THERE IS NO FALLBACK ANY MORE.
  //
  // This used to fall back to client.moveToSquare -- a centre-to-centre step on the
  // grid -- and that is measured to be the wrong primitive. Stepping centre to
  // centre along a grid route in room 587:
  //
  //     218 of 311 steps FAIL
  //     200 of those 218 (92%) DO NOT MOVE THE CHARACTER AT ALL
  //
  // because 54.9% of that room's wall length is not axis-aligned (575 and 576 are
  // ~42%). An axis-aligned step between two square centres runs square into a wall
  // face at 45 degrees and the trace refuses it outright. The failure mode is the
  // nasty one: the character does not slide into a neighbouring square, it does not
  // move, so a caller replans from an unchanged position, gets the identical route,
  // and asks for the same refused step again -- "barely wiggling" against a wall,
  // for ever. Three separate diagnoses of that were wrong before it was measured.
  //
  // The grid is still the right thing to PLAN on; it is the wrong thing to STEP on.
  // session.step owns the fine-coordinate movement that actually crosses those
  // faces. So a session without it gets a refusal rather than a primitive known to
  // wiggle: no packet is better than a packet that cannot work and cannot be
  // detected failing.
  if (typeof session.step !== 'function')
    return { sent: false, reason: 'no validated mover', terminal: true, from, to: { col, row } };

  const since = client.evSeq ?? 0;
  const result = await session.step(col, row, {})
                              .catch(e => ({ moved: false, reason: e?.message }));

  await client.waitFor({ since, kinds: ['player', 'room-contents'], timeoutMs: waitMs }).catch(() => {});

  const now = client.self ?? {};
  const at = { col: now.col ?? null, row: now.row ?? null };
  const arrived = at.col === col && at.row === row;
  const reason = result?.reason ?? (arrived ? null : 'did not arrive');

  return {
    sent: true,
    arrived,
    from, to: { col, row }, at,
    reason,
    // Propagated rather than swallowed: retrying one of these just re-sends a move
    // the local geometry already refused.
    terminal: isTerminalMovementReason(reason) || undefined,
  };
}

step.pre     = [];
step.effects = ['in_reach'];   // the only vocabulary fact a single square can change
step.atomic  = 'step';
