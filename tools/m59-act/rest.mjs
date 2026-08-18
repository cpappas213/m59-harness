#!/usr/bin/env node
// m59-act/rest.mjs -- SIT DOWN, or STAND UP. One posture change.
//
// Resting is how a character heals, and it is a USERCOMMAND rather than a main
// opcode (sprocket.c usercommand_def_table) -- which is why it looks missing if you
// grep the protocol table for it.
//
// THIS IS NOT skills.restUntil, AND THE DIFFERENCE IS THE POINT. restUntil sits
// still for up to two and a half minutes, polling every three seconds, and aborts
// on damage. That is a LOOP, it belongs to a caller that can be interrupted, and it
// is exactly the shape the atomic contract forbids: an unbounded await is how the
// keeper goes blind, and 153 deaths happened while recovering with a mean of 73
// seconds since the last observation.
//
// So this sends one posture change and returns. A planner that wants to rest until
// whole re-plans; the vocabulary already carries `can_rest_higher` and `hurt`, so
// "am I done" is a precondition question rather than a sleep.
//
// TWO THINGS RESTING CANNOT DO, both of which look like bugs from outside:
//
//   IT STOPS AT 80 VIGOR. REST_VIGOR_CAP is 80 of 200 (see m59-localpolicy.mjs),
//   so everything above it has to be EATEN -- `create food` is 2 elderberry AND 2
//   herbs. A character holding out for a vigor no amount of resting can deliver
//   looks on the board exactly like a character that is working. `can_rest_higher`
//   is the symbol that says whether sitting down can still pay.
//
//   IT DOES NOT STOP ANYTHING HITTING YOU. Resting has no defensive effect at all;
//   the only evidence a rest is going badly is that health is going DOWN. Zoot once
//   rested 61 seconds on a square proven against fewer attackers than were now
//   standing on him, went from 17 health to 3, and every read saw it falling.
//   Whether it is safe to sit is a PRECONDITION, and it belongs to whoever plans.

/**
 * rest(client, session, { waitMs })   -- sit down
 * stand(client, session, { waitMs })  -- get up
 *
 * Returns { sent, reason }. Posture is not reported by any packet this client
 * parses, so neither claims to confirm it: they report that the command went, and
 * the evidence of resting working is health rising, which the caller watches.
 * Claiming a confirmation nobody sent would be the `UC_LOOK_PLAYER` mistake again.
 */
export async function rest(client, session, { waitMs = 400 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  await session.pacer.submit('rest', () => client.rest(), waitMs).catch(() => {});
  return { sent: true, posture_confirmed: false };
}

rest.pre     = [];
rest.effects = ['can_rest_higher'];
rest.atomic  = 'rest';

export async function stand(client, session, { waitMs = 400 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  await session.pacer.submit('stand', () => client.stand(), waitMs).catch(() => {});
  return { sent: true, posture_confirmed: false };
}

stand.pre     = [];
// Standing is what makes fighting and moving possible again; in the vocabulary the
// nearest honest fact is that we are no longer committed to recovering.
stand.effects = ['!can_rest_higher'];
stand.atomic  = 'stand';
