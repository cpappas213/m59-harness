#!/usr/bin/env node
// LEAD THE FLEET BY WALKING IN FRONT OF IT.
//
// Say "follow me" while piloting one of your own characters and every fleet member in the
// room walks YOUR TRAIL — the squares you actually stood on, in the order you stood on them
// — until you say stop. It is for leading a group through rooms whose doors the router keeps
// getting wrong, which is a thing a person can see and the router cannot.
//
// WHY THE TRAIL AND NOT THE LEADER. Walking AT someone is a beeline, and a beeline is
// precisely what fails in the rooms this exists for: the Cragged Mountains pocket whose only
// exit is a door 21 crossings have failed at, the Ukgoth wedge where a body can step in four
// directions and none of them is the one it wants. A person threading that pass solves it by
// knowing where to put their feet, and the whole value here is copying the feet. So the trail
// is a QUEUE and it is consumed from the OLDEST end: the follower goes where the leader went,
// not where the leader is.
//
// FOLLOWING THROUGH A DOOR FALLS OUT OF THAT FOR FREE. When the leader leaves the room its
// last few trail points are the approach to the doorway, so a follower walking them arrives
// at the door and goes through it. Nothing here needs to know what a door is.
//
// ── ONLY OUR OWN PEOPLE MAY GIVE THIS ORDER ─────────────────────────────────────────────
//
// `prod` is a SHARED SERVER with real players on it, and this is a command that moves twenty
// bodies. A stranger who worked out the phrase could walk the fleet into open ground, into a
// PK trap, or simply away from what it was doing — so the speaker must be on our own roster,
// checked with the same `party.isFleetmate` the safe-spot PvP gate uses. A name is not proof
// of anything on its own, which is why the check is against the roster and not against the
// text. Anyone else saying it is heard and ignored.

export const FOLLOW_PHRASES = [/\bfollow me\b/i, /\bon me\b/i, /\bwith me\b/i];
export const STOP_PHRASES = [/\bstop following\b/i, /\bhold (up|here|position)\b/i,
                             /\bstay (here|put)\b/i, /\bstop\b/i, /\bwait here\b/i];

// How far from a trail point counts as having reached it. Generous on purpose: this is a
// breadcrumb to walk past, not a square to land on, and insisting on the exact square is how
// a follower stalls on geometry the leader crossed at a slightly different angle.
export const REACHED_WITHIN = 1.6;
// Two squares of leader movement before a new crumb is dropped. Finer than this and the queue
// fills with jitter from a body shuffling on the spot; coarser and a tight corner is cut.
export const CRUMB_EVERY = 2;
// A queue this long is about a minute of walking. Older than that and the leader has gone
// somewhere the follower can no longer usefully retrace.
export const MAX_TRAIL = 64;

/**
 * Did one of ours just give a follow order, and which?
 *
 * `events` are `said` events. `isOurs(name)` must answer for the ROSTER — see the note above
 * about why a stranger may not command the fleet. `self` is the hearer's own object id, so a
 * character does not take orders from itself.
 *
 * Returns { order: 'follow'|'stop', leaderId, leaderName, text } or null. The LAST matching
 * order in the batch wins, because a person who says "follow me" and then "stop" in one pass
 * meant stop.
 */
export function heardOrder(events, { isOurs, self = null } = {}) {
  if (!Array.isArray(events) || typeof isOurs !== 'function') return null;
  let found = null;
  for (const e of events) {
    if (!e || e.kind !== 'said') continue;
    if (self != null && e.speaker === self) continue;
    const text = String(e.text ?? '');
    const name = e.name ?? e.speaker_name ?? null;
    if (!name || !isOurs(name)) continue;          // strangers are heard and ignored
    if (STOP_PHRASES.some(r => r.test(text)))
      found = { order: 'stop', leaderId: e.speaker ?? null, leaderName: name, text };
    else if (FOLLOW_PHRASES.some(r => r.test(text)))
      found = { order: 'follow', leaderId: e.speaker ?? null, leaderName: name, text };
  }
  return found;
}

/**
 * Add the leader's current square to the trail, if it has moved far enough to be worth a
 * crumb. Returns the trail — mutated in place, because it is the follower's own state and
 * copying it every pass for tidiness would be the only allocation in the loop.
 */
export function dropCrumb(trail, at, { every = CRUMB_EVERY, max = MAX_TRAIL } = {}) {
  if (!Array.isArray(trail) || !at || !Number.isFinite(at.row) || !Number.isFinite(at.col))
    return trail ?? [];
  const last = trail[trail.length - 1];
  if (last && Math.max(Math.abs(last.row - at.row), Math.abs(last.col - at.col)) < every)
    return trail;
  trail.push({ row: at.row, col: at.col, at: at.at ?? null });
  while (trail.length > max) trail.shift();
  return trail;
}

/**
 * WHERE TO PUT THE NEXT FOOT, and how much of the trail is now behind us.
 *
 * Consumes from the oldest end: everything within `REACHED_WITHIN` of the follower is dropped
 * — including crumbs it never explicitly aimed at, because passing near one IS reaching it —
 * and the next one along is the aim. Returns null when the trail is empty, which means
 * "caught up, stand still" rather than "lost".
 */
export function nextStep(trail, me, { within = REACHED_WITHIN } = {}) {
  if (!Array.isArray(trail) || !trail.length || !me) return null;
  while (trail.length) {
    const head = trail[0];
    const d = Math.max(Math.abs(head.row - me.row), Math.abs(head.col - me.col));
    if (d <= within) { trail.shift(); continue; }
    return head;
  }
  return null;
}

/**
 * THE LEADER VANISHED. WHICH DOOR DID THEY TAKE?
 *
 * A trail ends where the leader stopped being visible, and walking it to the end leaves a
 * follower standing in an empty room having done exactly what it was told and achieved
 * nothing. That is the gap: the crumbs get you to the doorway and then say nothing about
 * going through it.
 *
 * The inference is small and it is sound. The leader is STILL ONLINE — they did not log out,
 * they left the map — and the last place we saw them was next to a door. People do not
 * evaporate; they walk through the nearest exit. So once the trail is walked out, take the
 * exit closest to where they were last seen.
 *
 * IT IS DELIBERATELY NOT CLEVER. No pathfinding, no "which room would they plausibly want",
 * no guessing from the direction of travel — those are all ways to be confidently wrong and
 * end up a zone away from the group. Nearest door to the last sighting, and a `within` that
 * refuses the inference entirely when the leader vanished in open ground far from any exit,
 * because that is not a door, that is a leader who died or logged out.
 *
 * `exits` are the room's own, each { row, col, to } — locked ones filtered by the caller,
 * since a locked door is not somewhere anybody walked.
 */
export function exitTakenFrom(exits, lastSeen, { within = 8, rows = null, cols = null } = {}) {
  if (!Array.isArray(exits) || !exits.length || !lastSeen) return null;
  if (!Number.isFinite(lastSeen.row) || !Number.isFinite(lastSeen.col)) return null;
  let best = null, bestD = Infinity, bestAt = null;
  for (const e of exits) {
    if (!e) continue;
    let d = Infinity, at = null;
    if (Number.isFinite(e.row) && Number.isFinite(e.col)) {
      // A `go` exit: a door on a specific square.
      d = Math.max(Math.abs(e.row - lastSeen.row), Math.abs(e.col - lastSeen.col));
      at = { row: e.row, col: e.col };
    } else if (e.leaveName && Number.isFinite(rows) && Number.isFinite(cols)) {
      // AN EDGE EXIT IS A WHOLE WALL, NOT A DOORWAY, and reading it as one was the bug.
      //
      // The Cragged Mountains has FIVE exits and every one of them is an edge: they carry a
      // direction and an arriveRow/arriveCol in the DESTINATION room, and nothing at all
      // about where you stand in this one. Requiring a row/col filtered all five out, so a
      // follower walked to the wall its leader had just crossed and then reported, correctly
      // and uselessly, that there was no door near where they vanished.
      //
      // The crossing point is the last sighting PROJECTED ONTO THAT WALL — you leave a room
      // by walking off the edge wherever you happen to be standing, so the nearest point of
      // the north wall to somebody at row 2 col 40 is row 1 col 40, not some staging square
      // the router likes on the far side of the room.
      if (e.leaveName === 'north')      { d = lastSeen.row - 1;    at = { row: 1, col: lastSeen.col }; }
      else if (e.leaveName === 'south') { d = rows - lastSeen.row; at = { row: rows, col: lastSeen.col }; }
      else if (e.leaveName === 'west')  { d = lastSeen.col - 1;    at = { row: lastSeen.row, col: 1 }; }
      else if (e.leaveName === 'east')  { d = cols - lastSeen.col; at = { row: lastSeen.row, col: cols }; }
      if (d < 0) d = 0;
    }
    if (d < bestD) { bestD = d; best = e; bestAt = at; }
  }
  if (!best || !Number.isFinite(bestD) || bestD > within) return null;
  return { ...best, at: bestAt, squares_from_last_sighting: bestD };
}

/** How far behind the leader this follower is, in crumbs still to walk. */
export const behindBy = trail => (Array.isArray(trail) ? trail.length : 0);
