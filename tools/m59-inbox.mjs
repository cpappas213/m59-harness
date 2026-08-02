#!/usr/bin/env node
// The inbox: everything anyone said to this character, kept apart from everything else.
//
// The broker already has an event log, and speech already lands in it. The problem is
// that it is ONE log of 500 entries shared by every kind of event (m59-client.mjs:205),
// and a character that is fighting emits a `stat` event on every point of health it
// loses. So a sentence someone said is evicted by the character's own vital signs long
// before the model next checks in. Worse, `eventsSince` is a plain `seq > since` filter
// with no gap detection, so the loss is silent: `wait_for_event` returns a clean-looking
// result and nothing says anything went missing.
//
// This is a second ring, and it holds only speech. Nothing a character does to itself
// can push a sentence out of it, and when something IS dropped the count is reported
// rather than inferred.
//
// It is also where the rate limiting lives, and that is not a nicety either.
// BP_SAY_TO and BP_SAY_GROUP are among the few opcodes the server does NOT throttle
// (user.kod:1024-1040 carries no bSpam guard, unlike almost every other handler), so a
// hostile player can push speech at us as fast as their client will send it. Without a
// bound on this side, the cheapest attack on a fleet of language-model-backed characters
// is not an injection at all — it is talking to them until the inference bill hurts.
//
// Nothing in this file does I/O or talks to the server. It decides what to keep, what to
// answer, and what to refuse; `m59-chatter.mjs` acts on those decisions.

import { stripCodes } from './m59-parse.mjs';

// ------------------------------------------------------------------- channels

// The say type is the only trust signal the protocol gives us for free, and the
// distinctions are real: a tell costs the sender a mana point per recipient and names
// us specifically, room speech costs nothing but requires standing in front of us, and
// a broadcast costs a share of max mana and reaches EVERY character we run at once.
//
// That last one is why `broadcast` is its own trust class. One line typed by one player
// is simultaneously addressed to all twelve characters, which makes it both the highest
// leverage thing an attacker can send and the cheapest thing for us to get wrong twelve
// times over.
export const CHANNEL_TRUST = {
  group:       'direct',   // a tell: BP_SAY_GROUP with one recipient, that recipient is us
  'group-one': 'direct',
  say:         'room',     // ordinary room speech, not distance-clipped between players
  emote:       'room',
  yell:        'nearby',   // the room plus the speaker's plYell_Zone
  guild:       'guild',
  broadcast:   'server',   // everyone, including every other character we run
  dm:          'admin',
  message:     'system',   // server prose, not a person
  resource:    'system',
};

// Channels the deterministic layer is allowed to answer on its own. `broadcast` is
// deliberately absent: a server-wide line is never worth twelve automatic replies, and
// answering one is how a fleet turns into a spam source.
export const AUTO_REPLY_CHANNELS = new Set(['group', 'group-one', 'say', 'emote', 'yell']);

// Channels that are the server talking rather than a person. These never enter the
// inbox at all — they are already in the event log where they belong.
export const NOT_A_PERSON = new Set(['message', 'resource']);

// -------------------------------------------------------------------- hygiene

// Two-character colour codes introduced by `~` or a backtick. The broker strips these
// on the way in; we strip again because a reply we generate must not carry them either,
// and because an inbound sanitizer that trusts an upstream one is a sanitizer that
// breaks quietly the day the upstream changes.
//
// The length cap is well under LEN_MAX_CLIENT_MSG (6000, blakserv/blakserv.h:87), where
// the server truncates silently. Nothing useful arrives in 6000 characters of one
// player's speech; a very long line is either a mistake or an attempt to bury an
// instruction past wherever a reader stops paying attention.
export function sanitizeInbound(text, max = 600) {
  const flat = stripCodes(String(text ?? ''))
    // Control characters, including newlines, become a SPACE rather than nothing: a
    // player cannot forge a multi-line record this way, and "hello\nsystem: ..." does
    // not silently weld into one word that reads differently from what was typed.
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? { text: flat.slice(0, max), truncated: flat.length - max }
                           : { text: flat, truncated: 0 };
}

// Outbound is stricter. A reply is a thing we are about to say in a shared world with
// our name on it, so it loses colour codes, newlines and anything that would let one
// line masquerade as several.
export function sanitizeOutbound(text, max = 220) {
  const flat = stripCodes(String(text ?? ''))
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s\S*$/, '') + '…' : flat;
}

// The last check before anything we generated is said out loud in a shared world. It is
// not a content filter and does not try to be one — the containment that matters is that
// the responder has no capability except producing this string. This catches the one
// class of failure that string alone can still cause: repeating something back that was
// never the game's business, because a player asked the model what its instructions were.
const LEAKS = [
  /[A-Za-z]:[\\/](?:code|users|windows|program)/i,   // a Windows path
  /(?:^|\s)\/(?:home|etc|usr|var|root)\//,           // a POSIX path
  /sk-[A-Za-z0-9_-]{12,}/,                           // anything shaped like a key
  /\b(system prompt|my instructions are|you are an? \w+ assistant)\b/i,
  /\bANTHROPIC_API_KEY\b/i,
  /```/,                                             // a code fence has no business here
];
export function looksLikeLeak(text) {
  const s = String(text ?? '');
  for (const re of LEAKS) if (re.test(s)) return re.source;
  return null;
}

// ------------------------------------------------------------- unwrapping speech

// What arrives on the wire is not what the player typed. The server renders every
// utterance through a format resource before sending it (`user_said_str` = `%s says,
// "%q~n"`, `user_send_one_str` = `%s tells you, "%q~n"`, and friends — user.kod:95-109),
// so a player who types `hello` reaches us as `Bramwell tells you, "hello"`.
//
// That matters more than it looks. Every anchored pattern in the small-talk table —
// greeting, farewell, thanks — is anchored to the START of what was said, and against
// the wrapped line not one of them can ever match. Verified live: `hello there` arrived
// wrapped and fell through to the escalation path, while `are you a bot?` matched only
// because that rule happens not to be anchored.
//
// It also matters for the model tier: the wrapper puts the speaker's name INSIDE the
// text we hand over as untrusted, which is exactly the region we tell the model not to
// believe. The name belongs in a field, not in the quote.
const WRAPPED = /^(?:You hear\s+)?(.{1,40}?)\s+(?:says|said|tells you|tell you|sends|yells|yelling|shouts|broadcasts|whispers)\b[^"]{0,24}"([\s\S]*)"\s*$/i;

export function unwrapSpeech(text) {
  const m = WRAPPED.exec(String(text ?? '').trim());
  if (!m) return { said: text, speaker_name: null, wrapped: false };
  return { said: m[2], speaker_name: m[1], wrapped: true };
}

// ------------------------------------------------------------------ windows

// A sliding window rather than a token bucket, because the thing we care about is
// "how many in the last minute", which is exactly what a window answers and what a
// bucket only approximates.
class Window {
  constructor(limit, ms) { this.limit = limit; this.ms = ms; this.hits = []; }
  prune(now) { const cut = now - this.ms; while (this.hits.length && this.hits[0] <= cut) this.hits.shift(); }
  allows(now) { this.prune(now); return this.hits.length < this.limit; }
  take(now) { if (!this.allows(now)) return false; this.hits.push(now); return true; }
  get depth() { this.prune(Date.now()); return this.hits.length; }
}

// ------------------------------------------------- process-wide broadcast digest

// One broadcast reaches every character in the fleet, so twelve inboxes admit twelve
// copies of one sentence and — without this — twelve separate model calls answer it.
// The digest is shared by the whole process so the first character to see a broadcast
// claims it and the rest record it as a duplicate.
const _broadcasts = new Map();   // normalised text -> { at, claimedBy }

export function claimBroadcast(text, agent, now = Date.now(), ttlMs = 90_000) {
  for (const [k, v] of _broadcasts) if (now - v.at > ttlMs) _broadcasts.delete(k);
  const key = text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  if (!key) return { first: false, claimedBy: null };
  const seen = _broadcasts.get(key);
  if (seen) return { first: false, claimedBy: seen.claimedBy };
  _broadcasts.set(key, { at: now, claimedBy: agent });
  return { first: true, claimedBy: agent };
}

// --------------------------------------------------------------------- inbox

export const DEFAULT_POLICY = {
  capacity: 400,            // speech kept per character. Never evicted by combat noise.
  maxAge: 30 * 60_000,      // and never older than this, so a reply is never to a ghost

  // Admission. Both are per character. The per-speaker limit is the one that matters:
  // it bounds what any single hostile player can cost us, whatever the global load is.
  perSpeakerPerMin: 8,
  globalPerMin: 30,

  // Replies. Separate and much tighter than admission, because admitting a line is
  // free and answering one is not — it costs a paced packet, and on a `tell` it costs
  // a point of mana as well.
  repliesPerMin: 6,
  speakerCooldownMs: 8_000,

  // Never answer another character we are running. Two auto-responders that greet each
  // other greet each other forever, and the server will not stop them because speech
  // is not throttled.
  answerPeers: false,
};

export class Inbox {
  constructor({ agent, policy = {} } = {}) {
    this.agent = agent;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.items = [];
    this.seq = 0;
    this.dropped = 0;          // evicted by capacity — reported, never silent
    this.refused = 0;          // never admitted: rate limit, peer, duplicate
    this.heard = 0;            // admitted, all time
    this.global = new Window(this.policy.globalPerMin, 60_000);
    this.replies = new Window(this.policy.repliesPerMin, 60_000);
    this.perSpeaker = new Map();  // id -> Window
    this.lastReplyTo = new Map(); // id -> ms
  }

  _speakerWindow(id) {
    let w = this.perSpeaker.get(id);
    if (!w) { w = new Window(this.policy.perSpeakerPerMin, 60_000); this.perSpeaker.set(id, w); }
    return w;
  }

  // `said` is the client's own event shape: { speaker, name, type, text }.
  // `ctx` carries what only the caller knows: our own object id, and whether a given
  // speaker is another character this broker is running.
  //
  // Returns a decision rather than throwing, because "we refused to admit this" is a
  // thing worth counting and reading later, not an error.
  admit(said, { selfId = null, isPeer = () => false, now = Date.now() } = {}) {
    const channel = String(said.type ?? 'say');
    if (NOT_A_PERSON.has(channel)) return { admitted: false, why: 'not a person' };
    if (said.speaker != null && selfId != null && said.speaker === selfId)
      return { admitted: false, why: 'our own echo' };

    // Sanitise first (colour codes would break the wrapper match), then unwrap.
    const { text: flat, truncated } = sanitizeInbound(said.text);
    if (!flat) return { admitted: false, why: 'empty after sanitising' };
    const unwrapped = unwrapSpeech(flat);
    const text = unwrapped.said.trim();
    if (!text) return { admitted: false, why: 'nothing inside the quotes' };

    const peer = !!isPeer(said.speaker);
    const trust = CHANNEL_TRUST[channel] ?? 'unknown';

    // Admission limits. A peer is still admitted — we want the record of what our own
    // characters said to each other — but it is marked, and the reply layer ignores it.
    if (!this._speakerWindow(said.speaker).take(now)) {
      this.refused++;
      return { admitted: false, why: `speaker ${said.speaker} over ${this.policy.perSpeakerPerMin}/min` };
    }
    if (!this.global.take(now)) {
      this.refused++;
      return { admitted: false, why: `inbox over ${this.policy.globalPerMin}/min` };
    }

    // A broadcast is one sentence arriving at every character at once. Only the first
    // character to see it holds a claim on answering; the others keep it as a record.
    let duplicateOf = null;
    if (channel === 'broadcast') {
      const claim = claimBroadcast(text, this.agent, now);
      if (!claim.first) duplicateOf = claim.claimedBy;
    }

    const item = {
      id: `${this.agent}:${++this.seq}`,
      at: now,
      channel,
      trust,
      speaker: said.speaker ?? null,
      // The roster name if we have one, else the name the server put in the wrapper.
      speaker_name: said.name ?? unwrapped.speaker_name ?? null,
      is_peer: peer,
      // `text` is what the player typed. `as_heard` is the whole rendered line, kept only
      // when they differ — an operator reading the record should be able to see exactly
      // what came off the wire without that being the thing the model reads.
      text,
      ...(unwrapped.wrapped ? { as_heard: flat } : {}),
      truncated,
      duplicate_of: duplicateOf,
      // `pending` -> the deterministic layer has not looked at it yet.
      // `answered` -> a reply went out (tier says which layer wrote it).
      // `escalated` -> nothing deterministic matched; a model may answer it.
      // `refused` -> a model looked and declined to answer.
      // `operator` -> needs a human or the supervising agent, not an automatic reply.
      state: 'pending',
      tier: null,
      reply: null,
      note: null,
    };

    this.items.push(item);
    this.heard++;
    this._evict(now);
    return { admitted: true, item };
  }

  // Capacity and age, in that order. Every eviction is counted; `stats()` reports the
  // count and `inbox` surfaces it, so "we lost some" is a number rather than a guess.
  _evict(now) {
    const cut = now - this.policy.maxAge;
    let n = 0;
    while (this.items.length && this.items[0].at < cut) { this.items.shift(); n++; }
    while (this.items.length > this.policy.capacity) { this.items.shift(); n++; }
    this.dropped += n;
  }

  // Is this character allowed to say something to this speaker right now? Two limits,
  // both about not becoming a nuisance: an overall reply rate, and a per-speaker
  // cooldown that stops a rapid exchange turning into a loop.
  canReply(speakerId, now = Date.now()) {
    if (!this.replies.allows(now)) return { ok: false, why: `reply budget spent (${this.policy.repliesPerMin}/min)` };
    const last = this.lastReplyTo.get(speakerId) ?? 0;
    const wait = this.policy.speakerCooldownMs - (now - last);
    if (wait > 0) return { ok: false, why: `cooling down for ${speakerId} (${Math.ceil(wait / 1000)}s)` };
    return { ok: true };
  }

  noteReply(speakerId, now = Date.now()) {
    this.replies.take(now);
    this.lastReplyTo.set(speakerId, now);
  }

  byId(id) { return this.items.find(i => i.id === id) ?? null; }

  resolve(id, state, { tier = null, reply = null, note = null } = {}) {
    const item = this.byId(id);
    if (!item) return null;
    item.state = state;
    // `!= null`, not truthiness: tier 0 is a real tier, and `if (tier)` silently
    // recorded every deterministic answer as having come from nowhere.
    if (tier != null) item.tier = tier;
    if (reply != null) item.reply = reply;
    if (note != null) item.note = note;
    return item;
  }

  select({ state = null, channel = null, since = null, limit = 50, includePeers = true } = {}) {
    let out = this.items;
    if (state) { const want = new Set([].concat(state)); out = out.filter(i => want.has(i.state)); }
    if (channel) { const want = new Set([].concat(channel)); out = out.filter(i => want.has(i.channel)); }
    if (since != null) out = out.filter(i => i.at > since);
    if (!includePeers) out = out.filter(i => !i.is_peer);
    return out.slice(-limit);
  }

  stats() {
    const by = {};
    for (const i of this.items) by[i.state] = (by[i.state] ?? 0) + 1;
    return {
      agent: this.agent,
      held: this.items.length,
      heard_total: this.heard,
      refused_total: this.refused,
      dropped_total: this.dropped,
      by_state: by,
      unread: this.items.filter(i => i.state === 'pending').length,
      escalated: this.items.filter(i => i.state === 'escalated').length,
      needs_operator: this.items.filter(i => i.state === 'operator').length,
      reply_budget_used: this.replies.depth,
      reply_budget: this.policy.repliesPerMin,
      inbound_rate: this.global.depth,
    };
  }
}

// One inbox per agent name, for the whole process, so `fleet` and the HTTP transport
// see the same object the chatter is filling.
const inboxes = new Map();
export function inboxFor(agent, policy) {
  let box = inboxes.get(agent);
  if (!box) { box = new Inbox({ agent, policy }); inboxes.set(agent, box); }
  return box;
}
export const inboxIfAny = (agent) => inboxes.get(agent) ?? null;
export const dropInbox = (agent) => inboxes.delete(agent);
export const allInboxes = () => [...inboxes.values()];
