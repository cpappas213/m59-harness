#!/usr/bin/env node
// Tier 0: the deterministic responder. There is no language model anywhere in this file.
//
// A character that never answers when spoken to is not neutral — it reads as broken, or
// rude, and either way it tells every human on the server that the thing in front of them
// is not worth talking to. But the naive fix, handing every sentence a stranger types to a
// model that also holds a shell, is the whole prompt-injection problem in one step.
//
// So this layer does the part that needs no judgement:
//
//   * it turns to face whoever spoke, which costs nothing and is the clearest possible
//     signal that a thing has noticed you
//   * it acknowledges, in a way that depends on what the character is actually doing
//   * it answers a small fixed vocabulary — greetings, "who are you", "where are you",
//     "are you a bot" — from a table, with no generation at all
//   * everything else it marks `escalated` and leaves alone
//
// The table is not there to be clever. It is there because roughly half of what humans
// say to a stranger in a game is one of six things, and answering those six from a lookup
// costs nothing, cannot be injected, and returns an answer in under a second — which is
// faster and safer than any model will ever be.
//
// The honesty in the table is also a control. "Are you a bot?" is answered "yes", always,
// because a human who knows they are talking to a bot is markedly harder to socially
// engineer through it, and because the alternative is having the fleet lie to people.

import { inboxFor, AUTO_REPLY_CHANNELS, sanitizeOutbound } from './m59-inbox.mjs';
import { isLoopbackHost } from './m59-dm.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => (v && v.max ? v.value / v.max : null);

// -------------------------------------------------------------- small talk

// Each entry is a matcher and a reply builder. The builder gets the character's real
// state, so "where are you" answers with the room the character is actually standing in
// rather than a canned sentence — the reply is grounded even though nothing generated it.
//
// Order matters: the first match wins, so the specific patterns come before the loose
// ones. `bot` is first because "hey, are you a bot?" starts with a greeting.
export const SMALL_TALK = [
  // ASK IT WHAT IS WRONG, STANDING NEXT TO IT.
  //
  // The three states this answers for — no defensible square, could not reach the safe
  // spot, the play-dead freeze — are the ones that survived a round of fixes without
  // being explained, and the reason is that a journal line does not carry what the
  // character could SEE. Being in the room with it and asking is a different instrument
  // from reading a post-mortem afterwards.
  //
  // FIRST in the table, because "debug" would otherwise be swallowed by nothing in
  // particular and because a question from the operator outranks small talk.
  //
  // GATED ON isOperator, which is a live local pid rather than a name: this answer states
  // room, position, health, what the keeper is doing and why it refused, and that is a
  // map of how the fleet works. A stranger on a shared server asking "debug" gets the
  // ordinary escalation path, which is the same answer they got before this existed.
  {
    intent: 'debug',
    re: /^\s*(debug|status|diag|what'?s wrong|why are you stuck|wtf)\b/i,
    reply: (ctx) => {
      if (!ctx.isOperator) return null;          // not for strangers; falls through
      if (!ctx.debugReport) return `Nothing flagged — I'm not in one of the three states being chased.`;
      return ctx.debugReport;                    // an array: one line per send

    },
  },
  {
    intent: 'identity',
    // `what are you` must not swallow `what are you doing` — the activity rule below
    // is the one that wants that, and this rule is first.
    re: /\b(are|r) ?(you|u|ya) ?(an? )?(bot|ai|npc|robot|script|llm|claude|human|real|player)\b|\bwhat are you\b(?!\s+(doing|up|working))|\bbot\?/i,
    reply: (ctx) => `yes — I'm a bot. ${ctx.character} is run by a program, not a person at a keyboard.`,
  },
  {
    intent: 'operator',
    re: /\bwho (owns|runs|controls|made|built|operates) (you|this|that)\b|\bwhose bot\b|\bwho'?s? (behind|driving)\b/i,
    reply: () => `I'm an automated character. My operator reads what's said to me, so leave a message and it'll get through.`,
  },
  {
    intent: 'whereabouts',
    re: /\bwhere are (you|u)\b|\bwhere ?r ?u\b|\bwhat room\b|\bwhere u at\b/i,
    reply: (ctx) => ctx.room ? `I'm in ${ctx.room}.` : `I'm not sure where I am at the moment.`,
  },
  {
    intent: 'activity',
    re: /\bwhat (are|r) (you|u) (doing|up to)\b|\bwyd\b|\bwhatcha doing\b/i,
    reply: (ctx) => {
      if (ctx.fighting) return `Fighting something right now — talk in a moment.`;
      if (ctx.autopilot?.mode === 'farm') return `Hunting${ctx.autopilot.hunt ? ` ${ctx.autopilot.hunt}` : ''} around ${ctx.room ?? 'here'}.`;
      if (ctx.autopilot?.mode === 'survive') return `Just keeping myself alive in ${ctx.room ?? 'here'}.`;
      return `Standing about in ${ctx.room ?? 'here'}.`;
    },
  },
  {
    intent: 'health',
    re: /\b(you )?(ok|okay|alright|alive|hurt|dying)\b\??$|\bhow('?s| is) your health\b|\bhp\?/i,
    reply: (ctx) => ctx.health == null ? `I'm about.`
      : ctx.health < 0.35 ? `Not great — ${Math.round(ctx.health * 100)}% health.`
      : `Fine — ${Math.round(ctx.health * 100)}% health.`,
  },
  {
    intent: 'greeting',
    re: /^(hi|hello|hey+|yo|hail|sup|greetings|good (morning|evening|day|afternoon)|howdy|ahoy)\b/i,
    reply: (ctx) => ctx.speakerName ? `Hello, ${ctx.speakerName}.` : `Hello.`,
  },
  {
    intent: 'farewell',
    re: /^(bye|goodbye|cya|see ?ya|later|gtg|g2g|farewell|night)\b/i,
    reply: () => `Take care.`,
  },
  {
    intent: 'thanks',
    re: /^(thanks|thank you|ty|thx|cheers|nice one)\b/i,
    reply: () => `Any time.`,
  },
];

export function matchSmallTalk(text) {
  for (const rule of SMALL_TALK) if (rule.re.test(text)) return rule;
  return null;
}

// ------------------------------------------------ calling a bot into the arena
//
// SAY A CHARACTER'S NAME IN THE ARENA AND IT ENTERS THE BOUT. Registering five bots as
// combatants means five `say challenge`s through the broker, which is a script and a
// terminal for something that should be a word. This makes it a word.
//
// It is NOT a small-talk rule, and it could not be: every entry in that table is a fixed
// regex over the sentence alone, and this one has to match a name the table cannot know
// and then check where in the world the character is standing. Keeping SMALL_TALK static
// is worth more than the reuse — a table of constant patterns is a table nothing typed by
// a stranger can reach into.
//
// THREE GUARDS, AND THE FIRST TWO ARE WHY THIS IS SAFE TO HAVE ON BY DEFAULT.
//
//  * THE SERVER MUST BE ON THIS MACHINE. `challenge` is a word spoken out loud to the
//    room, and on `prod` the room contains real people — a fleet that shouts a game
//    command at strangers because somebody said its name is a fleet that has to be
//    turned off. prod is 76.214.42.186, so this cannot fire there by construction rather
//    than by remembering to configure it.
//  * IT MUST BE STANDING IN AN ARENA. Outside one the word means nothing to anybody and
//    is just noise in the room.
//  * THE WHOLE UTTERANCE MUST BE THE NAME. Not a substring: a bot called Echo would
//    otherwise answer "echo location", and — worse — the keeper's own status reply opens
//    with the character's name, so a substring test would let two bots call each other
//    into the ring for ever. Trailing punctuation is allowed because people type "Alpha!"
//    and mean the same thing.
//
// The reply is the LITERAL `challenge`, which is what the Watcher matches with
// StringEqual (`tswatch.kod:224`). Not a template, and not `challenger` — near misses
// match nothing and the Watcher says nothing about it, which is indistinguishable from
// having worked.

export const ARENA_ROOMS = new Set([60, 73]);
export const ARENA_CHALLENGE_WORD = 'challenge';

// Imported rather than restated: m59-dm.mjs owns "is this server on this machine",
// because its own DM socket gates on the same fact and two copies of that answer is
// exactly how one of them ends up permissive.
export const isLocalServer = isLoopbackHost;

// Pure, so the guards can be argued about without a server or a socket in the room.
// Returns the word to say, or null.
export function arenaCall({ text, character, roomNum, host } = {}) {
  if (!character) return null;
  if (!isLocalServer(host)) return null;
  if (!ARENA_ROOMS.has(Number(roomNum))) return null;
  // Strip surrounding whitespace and the punctuation people put round a name when they
  // are calling someone. Nothing else: no substring search, see the note above.
  const said = String(text ?? '').trim().replace(/^[\s"'!.,:;?-]+|[\s"'!.,:;?-]+$/g, '');
  if (!said) return null;
  return said.toLowerCase() === String(character).trim().toLowerCase()
    ? ARENA_CHALLENGE_WORD : null;
}

// ------------------------------------------------------------------- acks

// What to say when we have noticed someone but have nothing prepared. Deliberately not
// "..." — three dots reads as being ignored, which is worse than saying nothing at all.
// An emote reads as a state, which is what it actually is.
const ACK = {
  fighting: '*is fighting, and glances over*',
  hurt:     '*is catching its breath*',
  resting:  '*looks up*',
  idle:     '*turns to listen*',
};

// ---------------------------------------------------------------- chatter

export const DEFAULT_CHATTER_POLICY = {
  // Acknowledge at all. Off makes the character silent but still fills the inbox, which
  // is the right setting for a character that should be observed and not seen.
  ack: true,
  // How long before the same speaker gets another bare acknowledgement. An ack is a
  // social gesture, and repeating it every sentence is worse than not doing it.
  ackCooldownMs: 45_000,
  // Answer the small-talk table. Off leaves everything to the model tier.
  smallTalk: true,
  // Turn to face whoever spoke, when they are in the room. Free, and unambiguous.
  faceSpeaker: true,
  // Answer to our own name, in an arena, on a server running on this machine, by saying
  // `challenge`. See arenaCall — the guards are what make this safe to default on, and
  // this switch exists for turning it off during a test that wants the silence.
  arenaChallenge: true,
  // Hand unmatched speech to the model tier. Off makes this the whole system: the
  // character answers six things and records the rest without ever calling a model.
  escalate: true,
  // How long the pump sleeps when there is nothing waiting.
  idleMs: 700,
  journal: 200,
};

export class Chatter {
  // `hooks` is how the broker tells this object about the world outside its own session:
  // which object ids belong to characters we run, and what the keeper is currently doing.
  // Injected rather than imported so this file stays testable with no broker at all.
  constructor(session, { policy = {}, inboxPolicy = {}, hooks = {} } = {}) {
    this.s = session;
    this.agent = session.name;
    this.policy = { ...DEFAULT_CHATTER_POLICY, ...policy };
    this.hooks = hooks;
    this.inbox = inboxFor(session.name, inboxPolicy);
    this.queue = [];
    this.running = false;
    this.attached = false;
    this.prevOnSaid = null;
    this.log = [];
    this.did = { heard: 0, acked: 0, answered: 0, escalated: 0, refused: 0, faced: 0 };
    this.lastAck = new Map();     // speaker id -> ms
    this.startedAt = Date.now();
  }

  note(what, why, extra = {}) {
    this.log.push({ at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), what, why, ...extra });
    if (this.log.length > this.policy.journal) this.log.shift();
  }

  // The client calls this from inside its packet parser. It must not block and must not
  // await anything: a socket handler that waits on the pacer stops reading the socket.
  // So this only decides whether to keep the line, and the pump does the rest.
  attach() {
    const c = this.s.client;
    if (!c || this.attached) return this;
    // Remember which client we bound to. `detach` must unhook THAT one, not whatever
    // `session.client` happens to be later — after a rejoin they are different objects,
    // and unhooking the wrong one leaves a dead socket holding a live handler.
    this.boundClient = c;
    this.prevOnSaid = c.onSaid ?? null;
    c.onSaid = (said) => {
      try { this.prevOnSaid?.(said); } catch { /* not ours to fix */ }
      try { this.hear(said); } catch (e) { this.note('error', String(e?.message ?? e)); }
    };
    this.attached = true;
    this.running = true;
    this.pump();
    return this;
  }

  detach() {
    if (this.boundClient && this.attached) this.boundClient.onSaid = this.prevOnSaid;
    this.boundClient = null;
    this.attached = false;
    this.running = false;
  }

  // Is this speaker one of our own characters? Two auto-responders that greet each other
  // will greet each other until one of them logs out, and the server will not intervene
  // because speech is not rate limited.
  isPeer(speakerId) {
    if (speakerId == null) return false;
    try { return !!this.hooks.isPeer?.(speakerId); } catch { return false; }
  }

  // Re-bind to a freshly built client. `Session.rejoin` throws the socket away and logs
  // in again — which is the documented cure for a save-game renumber — and the new
  // client has no onSaid on it, so a chatter that does not do this goes quietly deaf.
  reattach() {
    this.detach();          // unhooks the OLD client, whichever one we were bound to
    return this.attach();   // binds session.client, which by now is the new one
  }

  hear(said) {
    const c = this.s.client;
    // AN INSTRUCTION FROM THE OPERATOR, NOT SOMETHING A STRANGER SAID.
    //
    // When the human is playing one of these characters himself, what he types to the
    // others is direction, not conversation — and answering "give me your money" with
    // small talk is the wrong response to both. The hook decides; it says yes only for a
    // speaker whose client this machine spawned and whose process is still alive, which
    // is a fact about this computer rather than a claim carried over the wire.
    //
    // Everything else, including anything merely CLAIMING to be him, falls through to
    // the ordinary untrusted path below.
    try {
      if (this.hooks.operatorInstruction?.(said)) {
        this.did.instructed = (this.did.instructed ?? 0) + 1;
        this.note('operator', 'took it as an instruction', { said: said?.text });
        return;
      }
    } catch (e) { this.note('error', 'operator routing: ' + String(e?.message ?? e)); }
    const res = this.inbox.admit(said, { selfId: c?.selfId ?? null, isPeer: (id) => this.isPeer(id) });
    if (!res.admitted) { this.note('refused', res.why); return; }
    this.did.heard++;
    this.queue.push(res.item.id);
  }

  // What the character actually is right now, as the small-talk table sees it. Read from
  // the cached world view, so it costs nothing and cannot fail on the wire.
  context(item) {
    const c = this.s.client;
    let view = null;
    try { view = this.s.view(); } catch { /* not in game, or no map */ }
    const vitals = c?.vitals?.() ?? null;
    const health = pct(vitals?.health);
    const hostileNear = view
      ? view.objects.some(o => !o.is_player && Array.isArray(o.can) && o.can.includes('attack') && (o.distance ?? 99) <= 3)
      : false;
    return {
      character: c?.me?.name ?? this.agent,
      room: view?.room?.name ?? (c ? c.rsc.get(c.roomNameRsc) : null),
      // The room NUMBER, which is not `client.room.id` — that is the room object's id.
      // The view resolves the number through the map, which is the only place the two
      // are related.
      roomNum: view?.room?.num ?? null,
      // WHICH SERVER THIS CHARACTER IS ON, from the session's own credentials rather
      // than from M59_HOST: one broker can hold characters on several servers at once,
      // so an environment variable is an answer about the process, not about the
      // character. arenaCall gates on this.
      host: this.s.credentials?.host ?? null,
      speakerName: item.speaker_name,
      speakerInRoom: view ? view.objects.some(o => o.id === item.speaker) : false,
      speakerObject: view?.objects.find(o => o.id === item.speaker) ?? null,
      health,
      mana: vitals?.mana?.value ?? 0,
      // Dying empties the mana bar and every reply spends from it, so being dead
      // changes what is worth saying — see the "where did you die" path.
      dead: /underworld/i.test(view?.room?.name ?? (c ? c.rsc.get(c.roomNameRsc) : '') ?? ''),
      fighting: hostileNear,
      autopilot: (() => { try { return this.hooks.autopilotStatus?.() ?? null; } catch { return null; } })(),
      // WHO IS ASKING, and it decides whether the debug answer is available at all. True
      // only for a speaker whose client this machine spawned and whose pid is still
      // alive — the same local fact operatorInstruction trusts, never a name off the
      // wire. A stranger asking "debug" gets the ordinary escalation path.
      isOperator: (() => { try { return !!this.hooks.isOperator?.(item.speaker); } catch { return false; } })(),
      // Playing dead. Every reply is refused while this is true — see channelFor.
      frozen: (() => { try { return !!this.hooks.keeperFrozen?.(); } catch { return false; } })(),
      debugReport: (() => { try { return this.hooks.debugReport?.() ?? null; } catch { return null; } })(),
      view,
    };
  }

  // Which channel to answer on. Never `broadcast`: a reply that reaches the whole server
  // is never the right answer to one person, and it costs a share of max mana besides.
  channelFor(item, ctx) {
    // PLAYING DEAD OUTRANKS BEING POLITE.
    //
    // A frozen character is one that logged off and back on to buy the entry grace
    // period, and it is spending that period sitting perfectly still because it is too
    // hurt to survive the room noticing it. Speech ends the period: UserSay and
    // UserSayGroup both open with `if NOT (piFlags & PFLAG_MOVED_SINCE_ENTRY)
    // { Send(self,@NotifyMonstersOfPresence); }` (user.kod:4052, 4171).
    //
    // So a stranger saying "hi" to a character playing dead would, before this, get a
    // courteous "*is catching its breath*" back and kill it. Silence here is not
    // rudeness, it is the whole point of the state.
    if (ctx.frozen) return { kind: null, why: 'playing dead — speaking would wake the room' };
    if (item.channel === 'group' || item.channel === 'group-one') {
      // A tell costs one mana per recipient and is refused outright below that
      // (player.kod), and the refusal arrives as prose rather than as an error — so a
      // broke character's replies simply evaporate. Check first, and fall back to
      // ordinary speech when we are standing in front of them anyway.
      if (ctx.mana >= 1) return { kind: 'tell', to: item.speaker };
      if (ctx.speakerInRoom) return { kind: 'say' };
      return { kind: null, why: 'no mana for a tell and the speaker is not in the room' };
    }
    if (item.channel === 'yell' && !ctx.speakerInRoom) return { kind: 'yell' };
    if (ctx.speakerInRoom) return { kind: 'say' };
    return { kind: null, why: 'speaker is not in the room' };
  }

  async send(text, channel) {
    const s = this.s, c = s.need();
    const clean = sanitizeOutbound(text);
    if (!clean) return null;
    if (channel.kind === 'tell') await s.pacer.submit('say', () => c.sayGroup([channel.to], clean));
    else if (channel.kind === 'yell') await s.pacer.submit('say', () => c.say(clean, 2));
    else await s.pacer.submit('say', () => c.say(clean, 1));
    return clean;
  }

  // One item, start to finish. Every exit from here resolves the item to some state, so
  // nothing sits in `pending` forever with no record of why.
  async handle(id) {
    const item = this.inbox.byId(id);
    if (!item || item.state !== 'pending') return;

    if (item.duplicate_of && item.duplicate_of !== this.agent) {
      this.inbox.resolve(id, 'refused', { tier: 0, note: `duplicate broadcast, claimed by ${item.duplicate_of}` });
      this.did.refused++;
      return;
    }
    // `answerPeers` lives on the inbox policy and is off by default. It is honoured here
    // rather than being decided here, so that "should our characters talk to each other"
    // is one setting in one place — and so that turning it on for a test does not mean
    // editing this file.
    if (item.is_peer && !this.inbox.policy.answerPeers) {
      this.inbox.resolve(id, 'refused', { tier: 0, note: 'another character we run — never answered, to avoid a loop' });
      this.did.refused++;
      return;
    }
    if (!this.s.live) {
      this.inbox.resolve(id, 'escalated', { note: 'not in game when it arrived' });
      this.did.escalated++;
      return;
    }

    const ctx = this.context(item);

    // A broadcast is recorded and never answered automatically. It reaches every
    // character we run, and twelve automatic replies to one line is a spam source.
    if (!AUTO_REPLY_CHANNELS.has(item.channel)) {
      this.inbox.resolve(id, this.policy.escalate ? 'escalated' : 'refused',
                         { tier: 0, note: `${item.channel} is never answered automatically` });
      this.did.escalated++;
      return;
    }

    const budget = this.inbox.canReply(item.speaker);

    // Face them first. It is not a reply, it costs no budget, and it is the part a human
    // reads as "it noticed me" — so it happens even when we have nothing to say.
    if (this.policy.faceSpeaker && ctx.speakerObject) {
      try { await this.s.faceToward(ctx.speakerObject); this.did.faced++; }
      catch { /* turning is not important enough to fail an answer over */ }
    }

    const hit = this.policy.smallTalk ? matchSmallTalk(item.text) : null;
    const channel = this.channelFor(item, ctx);

    // CALLED INTO THE RING BY NAME.
    //
    // Answered on `say` WHATEVER CHANNEL THE CALL ARRIVED ON, and that is the part worth
    // getting right. The Watcher hears the room — SomeoneSaid (tswatch.kod:1375) tests
    // the words and nothing else, no distance and no addressee — so a `challenge` sent
    // back as a tell would reach the one person who asked and register nothing. It would
    // look exactly like it had worked: the reply is in the transcript, the Watcher is
    // silent, and the Watcher is silent when it succeeds too.
    //
    // channelFor is therefore bypassed, which means its two refusals have to be made
    // here instead: playing dead outranks this (speech spends the entry grace period and
    // wakes the room), and the reply budget still applies.
    const called = this.policy.arenaChallenge
      ? arenaCall({ text: item.text, character: ctx.character,
                    roomNum: ctx.roomNum, host: ctx.host })
      : null;
    if (called && budget.ok && !ctx.frozen) {
      const spoken = await this.send(called, { kind: 'say' });
      this.inbox.noteReply(item.speaker);
      this.inbox.resolve(id, 'answered', { tier: 0, reply: spoken, note: 'arena: called by name' });
      this.did.answered++;
      this.note('answered', 'arena-challenge',
                { to: item.speaker_name, said: item.text, reply: spoken });
      return;
    }

    // DEAD AND ASKED "WHERE?" — ANSWER WITH THE PLACE, NOTHING ELSE.
    //
    // A death is broadcast to everyone and the reflexive reply is "where?". The
    // corpse is the one person who cannot answer at scale, because dying costs all
    // your mana and a broadcast costs mana — but a tell is cheap, and whoever asked
    // still has theirs. So the protocol is: tell one person, they broadcast, the
    // room fills up.
    //
    // Which makes spending one of the few remaining mana points on
    // "*is catching its breath*" close to the worst possible use of it. It answers
    // nothing, it cannot be relayed, and it consumes the budget that the real answer
    // needed. When we are dead and someone asks where, the location IS the reply.
    const ap = this.hooks?.autopilotStatus?.();
    const death = ap?.last_death;
    const askedWhere = /where|what room|which room|loc|location/i.test(item.text || '');
    if (death && askedWhere && ctx.dead !== false && budget.ok && channel.kind) {
      const at = death.at_col != null ? `, near col ${death.at_col} row ${death.at_row}` : '';
      const by = death.killed_by?.length ? ` Killed by ${death.killed_by.join(' and ')}.` : '';
      const reply = `${death.died_in || 'I am not sure where'}${at}.${by} ` +
                    `No mana to broadcast it — please pass it on.`;
      const spoken = await this.send(reply, { ...channel, kind: 'tell' });
      this.inbox.noteReply(item.speaker);
      this.inbox.resolve(id, 'answered', { tier: 0, reply: spoken, note: 'death location' });
      this.did.answered++;
      this.note('answered', 'where-i-died', { to: item.speaker_name, reply: spoken });
      return;
    }

    // A RULE MAY DECLINE. `reply` returning null means "this rule matched the words but
    // not the asker" — the debug rule does exactly that for anyone who is not at the
    // controls — and a declined rule has to fall through to the ordinary ack-and-escalate
    // path rather than sending the word "null" to a stranger.
    const prepared = hit && budget.ok && channel.kind ? hit.reply(ctx) : null;
    if (prepared) {
      // An array is several lines, sent one at a time. The server truncates a long say,
      // and for the debug answer the tail is the part worth having.
      const lines = [].concat(prepared).filter(Boolean);
      let spoken = null;
      for (const line of lines) spoken = await this.send(line, channel);
      this.inbox.noteReply(item.speaker);
      this.inbox.resolve(id, 'answered', { tier: 0, reply: spoken, note: `small talk: ${hit.intent}` });
      this.did.answered++;
      this.note('answered', hit.intent, { to: item.speaker_name, said: item.text,
                                          reply: lines.length > 1 ? `${lines.length} lines` : spoken });
      return;
    }

    // Nothing prepared. Acknowledge — once per speaker per cooldown — so the silence
    // that follows is a considered one rather than an unresponsive one, then escalate.
    if (this.policy.ack && budget.ok && channel.kind) {
      const last = this.lastAck.get(item.speaker) ?? 0;
      if (Date.now() - last > this.policy.ackCooldownMs) {
        // Dying empties the mana bar, and every reply costs from it. An emote that
        // conveys nothing is not worth a point we may need to answer a real question.
        if (ctx.dead) { this.inbox.resolve(id, 'escalated', { note: 'dead; saving mana' }); return; }
        const mood = ctx.fighting ? 'fighting'
          : (ctx.health != null && ctx.health < 0.5) ? 'hurt'
          : 'idle';
        const spoken = await this.send(ACK[mood], { ...channel, kind: channel.kind === 'tell' ? 'tell' : channel.kind });
        this.lastAck.set(item.speaker, Date.now());
        this.inbox.noteReply(item.speaker);
        this.did.acked++;
        this.note('acked', mood, { to: item.speaker_name, said: item.text, reply: spoken });
      }
    }

    if (this.policy.escalate) {
      this.inbox.resolve(id, 'escalated', { tier: 0, note: budget.ok ? null : budget.why });
      this.did.escalated++;
    } else {
      this.inbox.resolve(id, 'refused', { tier: 0, note: 'no small-talk match and escalation is off' });
      this.did.refused++;
    }
  }

  async pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.running) {
        const id = this.queue.shift();
        if (!id) { await sleep(this.policy.idleMs); continue; }
        try { await this.handle(id); }
        catch (e) {
          this.note('error', String(e?.message ?? e), { id });
          this.inbox.resolve(id, 'escalated', { note: `tier 0 failed: ${e?.message ?? e}` });
        }
      }
    } finally { this._pumping = false; }
  }

  status() {
    return {
      agent: this.agent,
      attached: this.attached,
      running: this.running,
      policy: this.policy,
      queued: this.queue.length,
      did: { ...this.did },
      inbox: this.inbox.stats(),
      recent: this.log.slice(-12),
    };
  }
}

// ------------------------------------------------------------------ registry

const chatters = new Map();

export function chatterFor(session, opts) {
  let ch = chatters.get(session.name);
  if (!ch) { ch = new Chatter(session, opts); chatters.set(session.name, ch); }
  else if (opts?.policy) Object.assign(ch.policy, opts.policy);
  return ch;
}
export function dropChatter(name) {
  const ch = chatters.get(name);
  if (ch) ch.detach();
  return chatters.delete(name);
}
export const chatterIfAny = (name) => chatters.get(name) ?? null;
export const allChatters = () => [...chatters.values()];
