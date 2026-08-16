// TWO CHARACTERS, ONE MONSTER, ONE WALL.
//
// There is no party system in Meridian 59. There is no shared experience, no group,
// no way to tell the server that these two are together. So this is not an interface
// to a game feature — it is a convention two keepers hold in this process, and every
// benefit it produces comes from the game's ordinary rules applied deliberately.
//
// WHY IT PAYS, in the game's own terms:
//
//   BOTH GET THE KILL. Advancement requires that you damaged the creature AND that it
//   was your current target when it died (see the fight loop in m59-autopilot). Those
//   are per-character flags, not a shared pool — so two characters who both land a hit
//   on the same fungus beast BOTH advance from that one corpse. It is not split.
//   Twice the advancement for one fight, which is the whole reason to do this.
//
//   THE DAMAGE IS SHARED, THE HEALING IS NOT. A monster attacks one thing at a time.
//   Two characters swinging at it take, between them, the damage one character would
//   have taken alone — but each regenerates on its own clock. At 200 vigor that clock
//   is a point a second (((200-vigor)^2/6 + 1000) ms a point), and a slow monster
//   cannot out-damage two of those.
//
//   IT DIES TWICE AS FAST, so the exposure is halved again.
//
// THE WALL IS SHARED HERE, AND THAT IS DELIBERATE.
//
// m59-autopilot's default is ONE WALL EACH, for good reason: uncoordinated keepers all
// rank the same square first and pile onto it, and a heap of characters looks to each
// of them like a crowd of attackable things. That comment carves out the exception
// explicitly — "a player might share a wall deliberately — one tanking while another
// heals past them is a real tactic. The autopilot is not doing anything of the sort."
//
// This is the autopilot doing exactly that sort of thing. In a spot that holds, the
// only thing that can retaliate is the creature both are swinging at, and it can only
// hit one of them at a time. So partners are permitted to co-occupy, and NOBODY ELSE
// is — spotTakenByAnother still refuses every other keeper.
//
// WHO IT HITS IS NOT OURS TO CHOOSE. Nothing in the protocol says who a monster has
// targeted, and nothing lets us take a hit on purpose. So the tactic is not "one tanks"
// — it is "whoever is being hurt stops swinging and heals, and the other keeps going".
//
// AND THE ONE WHO DROPS OUT MUST NOT RE-TARGET. Breaking off costs nothing; switching
// to a different creature resets both advancement flags and throws away the credit for
// every hit already landed. Stop swinging, stay pointed at the same thing, heal.
//
// The register lives in the module rather than in a keeper, the same trick as
// claimedSpots and lastRoom: every session in a broker shares this process. It does
// NOT survive a broker restart — pairings are re-established by whoever set them up.

// agent -> record. One map, not five, because every consumer wants the partner's whole
// situation at once: what it is fighting, how hurt it is, and where it is standing.
const roster = new Map();

// A reading nobody has refreshed is worse than no reading — it produces confident
// decisions about a partner that logged out ten minutes ago. Same reasoning as
// whereIs(): stale is treated as absent.
const STALE_MS = 90_000;

const blank = (agent) => ({
  agent, partner: null, target: null, target_name: null, targetAt: 0,
  health: null, room: null, holding: null, doing: null, needs: [], at: 0,
});

function rec(agent) {
  let r = roster.get(agent);
  if (!r) roster.set(agent, r = blank(agent));
  return r;
}

// PAIRING IS SYMMETRIC AND EXCLUSIVE. A character in two parties is in none: both
// partners would wait for it and neither would get a second swinger. Pairing A with B
// therefore breaks whatever either was in first, on both sides.
export function pair(a, b) {
  if (!a || !b || a === b) return null;
  unpair(a); unpair(b);
  rec(a).partner = b;
  rec(b).partner = a;
  return { party: [a, b] };
}

export function unpair(agent) {
  const r = roster.get(agent);
  if (!r) return;
  const other = r.partner ? roster.get(r.partner) : null;
  if (other && other.partner === agent) other.partner = null;
  r.partner = null;
}

export const partnerOf = (agent) => roster.get(agent)?.partner ?? null;

export function arePartners(a, b) {
  if (!a || !b) return false;
  return roster.get(a)?.partner === b && roster.get(b)?.partner === a;
}

// WHAT THIS KEEPER IS DOING, for its partner to read. Called once a pass; the fields
// are whatever the caller knows, merged, so a caller that cannot see health does not
// erase the last reading of it.
export function report(agent, patch = {}) {
  const r = rec(agent);
  Object.assign(r, patch, { at: Date.now() });
  return r;
}

// WHO IS US — and it is this map's keys because `report` is called with `this.s.name`,
// the CHARACTER name, once a pass by every keeper in the broker.
//
// The question it answers is "is that player a fleetmate or a stranger", which nothing
// could ask before. It matters because the keeper is deliberately blind to players
// (`inReachOfUs` filters OF_PLAYER, and it should — this fleet must not start swinging at
// people on a shared server), so a stranger standing over a character was, until now,
// indistinguishable from a fleetmate standing next to one: invisible.
//
// SILENCE IS NOT PROOF OF A STRANGER. Every keeper reports on its own clock, so a
// character whose keeper has not yet had a pass is absent from this map — which is why
// the caller wants corroborating evidence before it treats anyone as hostile, and why
// this returns the set rather than a verdict.
export const knownCharacters = () => new Set(roster.keys());

// AND THE ROSTER UNDERNEATH IT, BECAUSE THE MAP ABOVE IS EMPTY AT BOOT AND THAT IS
// EXACTLY WHEN THIS IS ASKED.
//
// The map is populated by `report`, once a pass, per keeper — so for the first seconds
// after a broker restart it is EMPTY, and every one of our own characters answers
// "stranger". That is not a hypothetical: the first live run of the grudge book recorded
// six fleetmates as attackers within a minute of a restart, because a keeper starting up
// saw a fleetmate standing next to it while its own health happened to tick down.
//
// Nothing fired — the live PF flag is what gates an actual swing, and none of ours is a
// murderer — but the record was wrong, and a record of who attacked us is exactly the
// thing that must not name our own people.
//
// `resumeFleet` already learned this and wrote it down: match against the ROSTER rather
// than against sessions, because at boot there are none. So the resolver is installed by
// the broker (`fleetCharacters`, which unions the live sessions WITH the roster file) and
// consulted whenever the runtime map does not already know the name.
let rosterSource = null;
export function setRosterSource(fn) { rosterSource = typeof fn === 'function' ? fn : null; }

export const isFleetmate = (name) => {
  if (!name) return false;
  if (roster.has(name)) return true;
  try { const known = rosterSource?.(); return !!known && known.has(name); }
  catch { return false; }
};

// The partner's record, or null if there is no partner or the reading is stale.
export function mateOf(agent) {
  const p = partnerOf(agent);
  if (!p) return null;
  const r = roster.get(p);
  if (!r || !r.at || Date.now() - r.at > STALE_MS) return null;
  return r;
}

// WHAT WE SHOULD BE SWINGING AT.
//
// The partner's target wins when it is fresh, because converging is the entire point
// and the alternative — each hitting whatever is nearest — is two solo fights in one
// room, with all of the danger and none of the shared advancement.
//
// Returns null when there is nothing to converge on, which leaves the caller's own
// prey selection alone. This never invents a target: a keeper that cannot see the
// creature its partner named must still choose for itself.
export function agreedTarget(agent, { staleMs = 20_000 } = {}) {
  const m = mateOf(agent);
  if (!m || m.target == null) return null;
  if (Date.now() - (m.targetAt || 0) > staleMs) return null;
  return { id: m.target, name: m.target_name ?? null, from: m.agent };
}

export function declareTarget(agent, id, name = null) {
  const r = rec(agent);
  r.target = id ?? null;
  r.target_name = name;
  r.targetAt = id == null ? 0 : Date.now();
  return r;
}

// MAY THESE TWO STAND ON THE SAME SQUARE? Only if they are each other's partner.
// Everything else in the fleet keeps one wall each.
export function mayShareSpot(agent, other) {
  return arePartners(agent, other);
}

// WHOSE TURN IS IT TO BACK OFF.
//
// Not a rota — the monster picks, and we cannot see who it picked. The only honest
// signal is health, so the rule is simply: the hurt one heals, the healthy one swings.
// Both hurt means both heal; the creature will still be there.
//
// `floor` is the fraction below which a character should stop swinging. Returns
// 'fight' | 'heal', and 'fight' when there is no partner at all so a solo keeper is
// never told to stand about.
export function roleFor(agent, { health, floor = 0.5 } = {}) {
  if (health == null) return 'fight';
  // NO PARTNER, NO OPINION. Backing off is only useful if somebody else is still
  // swinging; a solo character that stops is just a character not fighting, and what
  // to do about being hurt alone is already decided — and decided better — by the rest
  // and flee thresholds. Answering here too would put two rules on one question.
  const m = mateOf(agent);
  if (!m) return 'fight';
  if (health < floor) return 'heal';
  return 'fight';
}

// IS MY PARTNER WITH ME? Rendezvous is a precondition for all of it: two characters
// in different rooms are not a party, they are two solo characters with a shared
// bookkeeping entry.
export function together(agent, room) {
  const m = mateOf(agent);
  if (!m || room == null || m.room == null) return false;
  return Number(m.room) === Number(room);
}

// WHAT MY PARTNER IS SHORT OF, so a town trip can be taken jointly rather than each
// discovering the same shortage twenty minutes apart. The keeper already computes its
// own wants for the fleet-wide interest board; this is that list, addressed to one
// character instead of broadcast.
export function mateNeeds(agent) {
  const m = mateOf(agent);
  return m?.needs?.length ? m.needs : [];
}

// Everyone currently paired, for a status tool. Pairs are de-duplicated so a party of
// two produces one row rather than two mirror-image ones.
export function partyBoard() {
  const seen = new Set();
  const out = [];
  for (const [agent, r] of roster) {
    if (!r.partner || seen.has(agent)) continue;
    seen.add(agent); seen.add(r.partner);
    const o = roster.get(r.partner);
    const fresh = (x) => x?.at && Date.now() - x.at <= STALE_MS;
    out.push({
      party: [agent, r.partner],
      together: r.room != null && o?.room != null && Number(r.room) === Number(o.room),
      room: r.room ?? o?.room ?? null,
      same_target: r.target != null && r.target === o?.target,
      target: r.target_name ?? o?.target_name ?? null,
      health: [r.health, o?.health ?? null],
      holding: [!!r.holding, !!o?.holding],
      fresh: [!!fresh(r), !!fresh(o)],
    });
  }
  return out;
}

// Forget everything. Used by tests; also the honest thing to call if a fleet is being
// re-paired from scratch, since a half-updated register is worse than an empty one.
export function resetParties() {
  roster.clear();
}
