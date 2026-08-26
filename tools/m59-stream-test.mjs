#!/usr/bin/env node
// THE TWO THINGS THE CLIENT KEEPS THAT ARE NOT THE EVENT LOG. Offline, no server,
// safe to run any time:
//
//   node tools/m59-stream-test.mjs
//
// Both exist because a single 500-entry event ring was being asked to be three
// different things at once, and was quietly bad at two of them.
//
//   1. WHAT IS EQUIPPED. The server keeps this in plUsing and sends it whole on
//      BP_USE_LIST, plus a line per change on BP_USE / BP_UNUSE. The client used to
//      handle none of the three — the opcodes were in the table and fell through the
//      switch — so every answer to "what is it wielding" was inferred from what we had
//      asked for, and inference does not survive a refusal.
//
//   2. WHAT PEOPLE SAID. Speech and combat text arrive on the same socket at wildly
//      different rates. One fight writes more lines than a character hears in an hour,
//      so a shared ring means somebody's sentence is gone before anyone polls for it.
//
// These drive the REAL client through REAL packet bytes rather than a fake, because the
// bug being fixed was in the byte handling: a fake that calls noteUsing directly would
// have passed against the broken version.

import { M59Client } from './m59-client.mjs';
import { parseUseList, parseObjectId } from './m59-parse.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? `  ${extra}` : ''}`); }
};
const eq = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// include/proto.h
const BP_USE = 203, BP_UNUSE = 204, BP_USE_LIST = 205, BP_SAID = 206, BP_MESSAGE = 32;
const BP_ROOM_CONTENTS = 134;   // m59-client.mjs BP table - the read confirmPosition waits on

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const pstr = s => Buffer.concat([u16(Buffer.byteLength(s, 'latin1')), Buffer.from(s, 'latin1')]);

// ToCliUseList, user.kod:2647 — a count, then one id each.
const useList = (...ids) => Buffer.concat([u16(ids.length), ...ids.map(u32)]);

// The resource table the client resolves names through. 400 is the "%q" format string
// that carries a player's own words; everything else is a name.
const RSC = new Map([
  [400, '%q'], [401, 'a sign reads: %q'],
  [900, 'long sword'], [901, 'chain mail'], [902, 'ring of the sun'],
  [910, 'Gonzo'], [911, 'Beaker'],
]);

// BP_SAID: speaker, name rsc, say type, format rsc, then the format's arguments.
const said = (speaker, nameRsc, sayType, text, fmt = 400) =>
  Buffer.concat([u32(speaker), u32(nameRsc), Buffer.from([sayType]), u32(fmt), pstr(text)]);

function client({ inventory = [], selfId = 55 } = {}) {
  const c = new M59Client({ resources: RSC, verbose: false });
  c.selfId = selfId;
  c.inventory = inventory;
  return c;
}
const pack = (id, nameRsc) => ({ id, nameRsc, flags: 0 });

// --------------------------------------------------------------- the wire itself

console.log('\nparsing the three equipment opcodes');
{
  const r = parseUseList(useList(7, 9, 11));
  ok('a use list round-trips', r.exact && r.count === 3, JSON.stringify(r));
  eq('and keeps the ids', r.ids, [7, 9, 11]);

  const empty = parseUseList(useList());
  ok('an empty use list is valid, not an error', empty.exact && empty.count === 0);
  eq('and means nothing is equipped', empty.ids, []);

  ok('one id and nothing else parses', parseObjectId(u32(42)).id === 42);
  // HandleUseList returns false on a payload that does not land exactly at the end,
  // and so must we — a short read here is a desync, not an empty hand.
  ok('a truncated use list is refused rather than read as empty',
     !parseUseList(Buffer.concat([u16(3), u32(7)])).exact);
  ok('trailing bytes are refused too', !parseObjectId(Buffer.concat([u32(7), u32(8)])).exact);
}

// ------------------------------------------------------------------- equipment

console.log('\nwhat is equipped, before anyone has asked');
{
  const c = client();
  const eqp = c.equipment();
  ok('is not reported as "nothing"', eqp.known === false, JSON.stringify(eqp));
  ok('the list is empty but the answer is "unknown"', eqp.equipped.length === 0);
  ok('and it says so out loud', /NOT YET KNOWN/.test(eqp.note || ''), eqp.note);
  ok('freshness is null rather than 0', eqp.fresh_ms === null);
}

console.log('\na use list makes it known');
{
  const c = client({ inventory: [pack(7, 900), pack(9, 901), pack(11, 902)] });
  c.onGameMessage(BP_USE_LIST, useList(7, 9));
  const eqp = c.equipment();
  ok('known becomes true', eqp.known === true);
  eq('and the names resolve from the pack',
     eqp.equipped.map(e => e.name), ['chain mail', 'long sword']);
  ok('freshness is a number now', typeof eqp.fresh_ms === 'number' && eqp.fresh_ms < 1000);
  ok('the item not in the list is not reported as equipped',
     !eqp.equipped.some(e => e.id === 11));
}

console.log('\nBP_USE and BP_UNUSE move one item');
{
  const c = client({ inventory: [pack(7, 900), pack(9, 901)] });
  c.onGameMessage(BP_USE_LIST, useList(7));
  c.onGameMessage(BP_USE, u32(9));
  eq('a use adds it', c.equipment().equipped.map(e => e.name), ['chain mail', 'long sword']);
  c.onGameMessage(BP_UNUSE, u32(7));
  eq('an unuse removes it', c.equipment().equipped.map(e => e.name), ['chain mail']);
  c.onGameMessage(BP_UNUSE, u32(9));
  const eqp = c.equipment();
  ok('and taking everything off is KNOWN empty, not unknown',
     eqp.known === true && eqp.equipped.length === 0, JSON.stringify(eqp));
}

console.log('\nthe event fires on change and not on repetition');
{
  const c = client({ inventory: [pack(7, 900)] });
  const seen = [];
  c.onEvent = ev => { if (ev.kind === 'equipment') seen.push(ev); };

  c.onGameMessage(BP_USE_LIST, useList(7));
  ok('the first snapshot is a change', seen.length === 1, `${seen.length}`);
  eq('and names what arrived', seen[0].added.map(a => a.name), ['long sword']);

  // The keepalive asks for the inventory every 20s and the server answers it with a use
  // list. Emitting for those would put a heartbeat in the agent's event stream for ever
  // — the same junk the INVENTORY case goes out of its way not to emit.
  c.onGameMessage(BP_USE_LIST, useList(7));
  c.onGameMessage(BP_USE_LIST, useList(7));
  ok('an identical snapshot emits nothing', seen.length === 1, `${seen.length}`);

  const before = c.usingChangedAt;
  ok('but it still counts as confirmation', c.usingAt >= before);

  c.onGameMessage(BP_USE_LIST, useList());
  ok('a snapshot that differs does emit', seen.length === 2);
  eq('and names what went', seen[1].removed.map(r => r.name), ['long sword']);
}

console.log('\nequipped but not in our copy of the pack');
{
  // What a cursed item looks like between equipping itself and the next inventory read.
  const c = client({ inventory: [] });
  c.onGameMessage(BP_USE_LIST, useList(77));
  const item = c.equipment().equipped[0];
  ok('it is still reported as equipped', item.id === 77);
  ok('with a null name rather than an invented one', item.name === null);
  ok('and says why it cannot name it', /not in our copy of the pack/.test(item.note || ''), item.note);
}

// ------------------------------------------------------------------------ chat

console.log('\nspeech goes to the chat stream');
{
  const c = client();
  c.onGameMessage(BP_SAID, said(910, 910, 1, 'anyone selling a shield?'));
  eq('the line is in chat', c.chat.map(l => l.text), ['anyone selling a shield?']);
  eq('with its channel', c.chat[0].channel, 'say');
  eq('and who said it', c.chat[0].name, 'Gonzo');
  ok('it is still in the event stream too, so waitFor keeps working',
     c.events.some(e => e.kind === 'said' && e.text === 'anyone selling a shield?'));
}

console.log('\nwhich channels count as somebody talking');
{
  const c = client();
  // blakston.khd:2179. 5 is SAY_RESOURCE and 7 is SAY_MESSAGE — the server narrating
  // through an object. Filing those under speech is how the untrusted-input banner
  // stops meaning anything.
  for (const [type, text] of [[1, 'say'], [2, 'yell'], [3, 'broadcast'], [4, 'group'],
                              [6, 'emote'], [8, 'group-one'], [9, 'dm'], [10, 'guild'],
                              [5, 'RESOURCE'], [7, 'MESSAGE']])
    c.onGameMessage(BP_SAID, said(910, 910, type, text, type === 5 || type === 7 ? 401 : 400));

  const heard = c.chat.map(l => l.text);
  ok('the eight a person can produce are all kept', heard.length === 8, JSON.stringify(heard));
  ok('server narration on the say opcode is not', !heard.includes('RESOURCE') && !heard.includes('MESSAGE'),
     JSON.stringify(heard));
  ok('an admin talking to you is still somebody talking', heard.includes('dm'));
  ok('and the narration is not lost, just filed elsewhere',
     c.events.filter(e => e.kind === 'said').length === 10);
}

console.log('\nsystem prose is never chat');
{
  const c = client();
  c.onGameMessage(BP_MESSAGE, Buffer.concat([u32(401), pstr('you hit the rat for 4')]));
  ok('a server message emits an event', c.events.some(e => e.kind === 'message'));
  ok('and puts nothing in the transcript', c.chat.length === 0, JSON.stringify(c.chat));
}

console.log('\nour own speech is marked, not hidden');
{
  const c = client({ selfId: 55 });
  c.onGameMessage(BP_SAID, said(55, 911, 1, 'on my way'));
  c.onGameMessage(BP_SAID, said(910, 910, 1, 'where are you?'));
  ok('both are kept', c.chat.length === 2);
  ok('ours is flagged', c.chat[0].self === true);
  ok('theirs is not', c.chat[1].self === false);
  eq('and it can be filtered out', c.chatSince(0, { includeSelf: false }).map(l => l.text),
     ['where are you?']);
}

console.log('\nthe cursor, and the channel filter');
{
  const c = client();
  c.onGameMessage(BP_SAID, said(910, 910, 1, 'first'));
  const mark = c.chatSeq;
  c.onGameMessage(BP_SAID, said(910, 910, 2, 'second'));
  c.onGameMessage(BP_SAID, said(910, 910, 1, 'third'));
  eq('a cursor returns only what is new', c.chatSince(mark).map(l => l.text), ['second', 'third']);
  eq('and channels filter', c.chatSince(0, { channels: 'yell' }).map(l => l.text), ['second']);

  // The two cursors must not be interchangeable. Anything that is not speech advances
  // the event sequence and leaves the chat sequence alone, so a caller that saved one
  // and passed it to the other would silently skip or repeat lines.
  const chatBefore = c.chatSeq;
  for (let i = 0; i < 5; i++) c.emit('message', { text: `you hit the rat for ${i}` });
  ok('combat advances the event sequence', c.evSeq === chatBefore + 5, `ev=${c.evSeq}`);
  ok('and leaves the chat sequence exactly where it was', c.chatSeq === chatBefore,
     `chat=${c.chatSeq}, was ${chatBefore}`);
  eq('so an event cursor read as a chat cursor would lose the lot',
     c.chatSince(c.evSeq).map(l => l.text), []);
  eq('while the real chat cursor still resumes correctly',
     c.chatSince(mark).map(l => l.text), ['second', 'third']);
}

// THE POINT OF THE WHOLE EXERCISE.
console.log('\na fight cannot evict what somebody said');
{
  const c = client();
  c.onGameMessage(BP_SAID, said(910, 910, 1, 'meet me at the gate'));
  // A busy fight: the event ring is 500 and a character emits one per point of health.
  for (let i = 0; i < 700; i++) c.emit('message', { text: `you hit the rat for ${i}` });

  ok('the event ring has rolled over', c.events.length === c.maxEvents);
  ok('and the sentence is gone from it',
     !c.events.some(e => e.text === 'meet me at the gate'));
  ok('but the transcript still has it',
     c.chat.some(l => l.text === 'meet me at the gate'), JSON.stringify(c.chat));
  ok('which is the entire reason it is a separate stream', c.chat.length === 1);
}

console.log('\nthe transcript has its own bound too');
{
  const c = client();
  for (let i = 0; i < c.maxChat + 50; i++)
    c.onGameMessage(BP_SAID, said(910, 910, 1, `line ${i}`));
  ok('it is capped', c.chat.length === c.maxChat, `${c.chat.length}`);
  ok('keeping the newest', c.chat[c.chat.length - 1].text === `line ${c.maxChat + 49}`);
  ok('and the sequence keeps counting past the cap', c.chatSeq === c.maxChat + 50);
}

// ---------------------------------------------------- the read that never recovers
//
// THE MOST EXPENSIVE BUG THIS FLEET HAS RECORDED, AND IT IS TWO COUNTERS.
//
// `roomContents()` hands out an ordinal and the BP_ROOM_CONTENTS handler counts replies, so
// "has my read landed" is `received >= request`. Correct while every request gets a reply,
// and unrecoverable when one does not: the requested side climbs on every ask and the
// received side cannot, so ONE lost reply puts them permanently out of step and every later
// read waits on an ordinal that can never arrive.
//
// Measured on the shadow fleet: two characters, 600 hops each, 0% success, 1,180
// consecutive `position_confirmation_timeout` across four and a half hours - 80% of
// everything the fleet logged. Fresh keepers in the SAME room confirmed in 345ms, which is
// what proves it was session state rather than geometry.
//
// This drives the real client, because the bug was in the real bookkeeping.
console.log('\na lost room-contents reply must not poison every later read');
{
  const c = client();
  // `roomContents()` puts a real packet on the wire, and these fixtures have no wire. The
  // ordinals are the subject here, not the bytes, so the socket is a sink.
  c.sock = { write() {} };
  const first = c.roomContents();
  ok('a request hands out an ordinal', first === 1, 'got ' + first);
  ok('and nothing has been received yet', c.roomContentsReceived === 0);

  // The reply never comes - the ordinary case when the walker is over the five-packet
  // throttle and the server discards the request.
  const second = c.roomContents();
  ok('the next request climbs regardless', second === 2, 'got ' + second);
  ok('so the received side is now behind', c.roomContentsReceived < second);

  // A reader that has waited out its deadline knows those replies are not coming.
  const lost = c.retireRoomContents(second);
  eq('retiring says how many were given up on', lost, 2);
  ok('and the two sides are level again', c.roomContentsReceived === second);
  ok('the loss is counted rather than hidden', c.roomContentsLost === 2);

  // THE POINT OF ALL OF IT: a later read can succeed again.
  const third = c.roomContents();
  c.roomContentsReceived++;                     // one real reply arrives
  ok('a later read is satisfiable again', c.roomContentsReceived >= third,
     'received ' + c.roomContentsReceived + ', wanted ' + third);

  // Retiring must never run the counter BACKWARDS: a late reply landing after its ordinal
  // was retired must not un-count a good read.
  const before = c.roomContentsReceived;
  eq('retiring an old ordinal is a no-op', c.retireRoomContents(1), 0);
  ok('and cannot lower the received count', c.roomContentsReceived === before);
}

console.log('\nand a reply that cannot be parsed still moves the ordinal');
{
  const c = client();
  c.sock = { write() {} };
  const request = c.roomContents();
  // A reply the server really sent and this end cannot use: a well-formed header with a
  // trailing byte, so it parses but lands `exact: false` and `check` rejects it. That is
  // the branch that mattered — breaking out of it without touching the counter is the
  // second way to fall permanently behind, and it needs no dropped packet at all.
  //
  // Deliberately NOT a short buffer: `parseRoomContents` THROWS on one of those rather
  // than returning a failed check, which is a different fault with a different remedy.
  c.onGameMessage(BP_ROOM_CONTENTS, Buffer.concat([u32(1), u16(0), Buffer.from([0xff])]));
  ok('the unreadable reply is retired rather than ignored',
     c.roomContentsReceived >= request,
     'received ' + c.roomContentsReceived + ', requested ' + request);
  ok('and it is counted as a loss, not as a good read', (c.roomContentsLost ?? 0) >= 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
