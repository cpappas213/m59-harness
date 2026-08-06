// WHICH CHARACTERS THE FLEET IS ALREADY USING FOR SOMETHING.
//
// A fleet board is a list of characters you might pick up and drive. Most of the time
// that is true of every row. It is not true of a character that is halfway through a
// loot run, walking a signet ring across the map, standing still while `supply` drives
// both ends of a trade, or paired with somebody who is counting on it being in the same
// room — those are MULTI-CHARACTER operations, and taking one half of one is not a small
// act. It abandons the other half, silently, and the only sign is that some other
// character stands in a field waiting for a partner that is now in a client window.
//
// So the board has to be able to say "this one is spoken for". That is one question with
// one answer, and it is asked in two places at once — the keeper publishes it in its own
// status, and the terminal greys the row and steps over it — so it lives here rather than
// being written twice and drifting.
//
// Nothing in this file talks to a broker or a server. It is data in, data out, which is
// what makes the skip-and-override behaviour testable without joining anybody to a game.

// The order matters. A character can be several of these at once — an errand runs by
// making the keeper inert, so an errand is nearly always ALSO 'driven' — and the board
// has one line to say what is going on. Most specific first.
//
//   errand   this character was dispatched somewhere: a loot run, a provisioning cast,
//            a signet ring to hand back. It is travelling on the fleet's business.
//   driven   something else has the controls. `supply` holds both ends of a trade this
//            way, and so does the almoner. The keeper is awake and is not steering.
//   parked   getting behind a wall because a fleet update is about to stop everything.
//   partner  a standing arrangement rather than a journey: two keepers agreeing to fight
//            the same creature. Weakest of the four, and the only one that persists.
const ORDER = ['errand', 'driven', 'parked', 'partner'];

// Human words for the errand kinds the keeper dispatches. An unknown kind is reported as
// itself rather than dropped — a new errand type must show up on the board the day it is
// added, not the day someone remembers to update this list.
function errandLabel(e) {
  if (!e) return null;
  if (e.kind === 'provision')
    return `${e.service || 'provisioning'} for ${e.supplicant_name || e.supplicant || 'a crewmate'}`;
  // KEPT SHORT ON PURPOSE, and in the same register as the rest of the column.
  //
  // The board gives the activity column 28 characters and cuts the tail. The first
  // version of this read "returning a signet ring to Paddock in Tos", which arrives on
  // the board as "returning a signet ring to …" — every character spent on words that
  // are identical for every ring, and the two that actually vary lost. The prefix has to
  // be short enough that THE OWNER SURVIVES THE CUT for the longest name in the table
  // (Parrin Aragone, 14), because the owner is the destination.
  //
  // `signet:` also matches what the column already says elsewhere — "hunting: giant rat".
  if (e.kind === 'signet')
    return `signet: ${e.owner || 'its owner'}` + (e.town ? `, ${e.town}` : '');
  if (e.kind === 'lootrun' || e.farmer_name || e.farmer)
    return `loot run for ${e.farmer_name || e.farmer}`;
  return String(e.kind || 'an errand');
}

// The shape every consumer reads. `kind` is for logic, `label` is for a person, `detail`
// is the sentence underneath. `since` is a timestamp or null — an operation that has been
// running for forty minutes is a different thing from one that started ten seconds ago,
// and the board should be able to say so.
export function describeCommitment({ errand = null, inert = null, parked = null,
                                     partner = null } = {}) {
  if (errand && !errand.done)
    return { kind: 'errand', label: errandLabel(errand), since: errand.at ?? null,
             detail: errand.kind === 'signet'
               ? 'a returned ring pays ten times its value to a character under 30 max health'
               : 'dispatched by the fleet; taking it abandons the other end' };
  if (inert)
    return { kind: 'driven', label: inert.why || 'something else is driving',
             since: null,
             detail: 'the keeper is awake and is not steering — usually a two-sided trade' };
  if (parked)
    return { kind: 'parked', label: parked.ready ? 'parked, ready for a fleet update'
                                                 : 'parking for a fleet update',
             since: null,
             detail: 'an update is waiting on this character to get somewhere survivable' };
  if (partner)
    return { kind: 'partner', label: `fighting alongside ${partner}`, since: null,
             detail: 'both advance from one kill; a partner alone will not start a fight' };
  return null;
}

// THE TERMINAL'S SIDE, and it deliberately does not require a broker that knows about any
// of this. `ap.committed` is what a current keeper publishes; the three fields under it
// are what every keeper has published for months. So an old broker still greys the right
// rows — one fewer thing that has to be restarted before the board tells the truth.
const ERRAND_SENTENCE = /^(loot run for |create (food|weapon) for |returning a signet)/;

export function commitmentOf(row) {
  const ap = row?.ap ?? row ?? null;
  if (!ap) return null;
  if (ap.committed !== undefined) return ap.committed;      // null is an answer, not a gap
  // An old broker does not publish the errand itself, only the sentence it produces.
  // Reconstructing the kind from that sentence would be guesswork, so this does not try:
  // it reports THAT there is an errand and lets the keeper's own sentence stand as the
  // label.
  if (ERRAND_SENTENCE.test(ap.activity || ''))
    return { kind: 'errand', label: ap.activity, since: null,
             detail: 'dispatched by the fleet; taking it abandons the other end' };
  return describeCommitment({
    inert: ap.inert ?? null,
    parked: ap.parked ?? null,
    partner: ap.policy?.partner ?? null,
  });
}

// Rank, for a board that wants to sort or colour by how firmly a character is held.
export const commitmentRank = (c) => (c ? ORDER.indexOf(c.kind) : ORDER.length);

// ---------------------------------------------------------------- moving the cursor
//
// Skipping is the whole point and it has one failure mode worth guarding: a fleet where
// EVERY character is committed. Naively, the cursor then refuses to move and the terminal
// looks frozen — which is the worst possible way to discover that you need the override
// key. So a step that finds nothing selectable returns where it started, and the caller
// is expected to say why on the status line.
//
// No wrapping, because the list does not wrap today and a cursor that jumps from the
// bottom to the top while skipping rows is genuinely hard to follow.
export function stepSelection(rows, from, delta, { override = false } = {}) {
  if (!rows?.length) return 0;
  const start = Math.max(0, Math.min(rows.length - 1, from | 0));
  if (override) return Math.max(0, Math.min(rows.length - 1, start + delta));
  for (let i = start + delta; i >= 0 && i < rows.length; i += delta)
    if (!commitmentOf(rows[i])) return i;
  return start;
}

// Where the cursor should sit when the list is first drawn, or after a refresh has
// reordered it. Same rule: prefer a free character, but never point at nothing.
export function firstSelectable(rows, { override = false } = {}) {
  if (!rows?.length) return 0;
  if (override) return 0;
  const i = rows.findIndex(r => !commitmentOf(r));
  return i < 0 ? 0 : i;
}

// True when the cursor cannot move at all without the override — the case the status line
// has to explain rather than leave looking like a broken key.
export const allCommitted = (rows) => !!rows?.length && rows.every(r => !!commitmentOf(r));
