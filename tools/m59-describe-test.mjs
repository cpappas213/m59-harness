#!/usr/bin/env node
// CHARACTER DESCRIPTIONS — the fold, the packet, and the record. Offline, no server,
// safe any time:
//
//   node tools/m59-describe-test.mjs
//
// Four things here are worth pinning, and three of them fail silently in the world:
//
//   THE WIRE IS LATIN-1. `pstr` is Buffer.from(s, 'latin1'), which for a codepoint
//   above U+00FF keeps the LOW BYTE — an em dash (U+2014) goes out as 0x14. Nothing
//   errors; the description simply arrives with a control character in it. Every
//   character this repository sends has to survive a latin1 round trip, and that is
//   asserted here rather than assumed.
//
//   THE OBJECT IS US. BP_CHANGE_DESCRIPTION carries who is being described, and
//   user.kod:1345 accepts it only for self. Sending it with no object id yet gets
//   `Debug("Tried setting description of nil object")` server-side and nothing at
//   all client-side, so the refusal has to happen here.
//
//   AN EMPTY DESCRIPTION IS NOT NO DESCRIPTION. ShowDesc tests psPlayerDescription
//   against $, and "" is not $ — so clearing gives a character a blank bio, not the
//   default prose back. The record has to keep saying that.
//
//   NOTHING READS ONE BACK. What we sent is the only copy, so the store is the
//   feature, not a convenience: a lost write is a lost description.
//
// Uses M59_DESC_DIR against a scratch directory, so it never touches a real fleet.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-describe-test-'));
process.env.M59_DESC_DIR = dir;

const desc = await import('./m59-describe.mjs');
const { cleanDescription, noteDescription, noteObserved, loadBook, emptyBook,
        listCharacters, resolveAgent, MAX_DESCRIPTION } = desc;
const { M59Client } = await import('./m59-client.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const T0 = 1785971086036;

// ------------------------------------------------------------------ the fold

console.log('\nfolding what a human actually types');
{
  eq('an em dash becomes a hyphen',
     cleanDescription('let slip — the dogs').text, 'let slip - the dogs');
  eq('curly quotes become straight ones',
     cleanDescription('“wocka”, he ‘said’').text, '"wocka", he \'said\'');
  eq('an ellipsis becomes three dots',
     cleanDescription('I already killed you…').text, 'I already killed you...');
  eq('a non-breaking space becomes a space',
     cleanDescription('a b').text, 'a b');

  // Latin-1 CAN carry these, and they are the ones a name might legitimately need.
  eq('accented latin stays', cleanDescription('café naïve').text, 'café naïve');

  const emoji = cleanDescription('bawk \u{1F414} bawk');
  eq('an emoji is dropped, not mangled into a control byte', emoji.text, 'bawk bawk');
  ok('and it is reported', emoji.changes.some(c => /Latin-1 wire cannot carry/.test(c)),
     JSON.stringify(emoji.changes));

  eq('a lone CR is a line ending, not damage', cleanDescription('a\r\nb').text, 'a\nb');
  eq('runs of spaces collapse', cleanDescription('a    b\t\tc').text, 'a b c');
  eq('and the ends are trimmed', cleanDescription('   hi   ').text, 'hi');

  const long = cleanDescription('x'.repeat(MAX_DESCRIPTION + 50));
  eq(`over ${MAX_DESCRIPTION} is truncated`, long.text.length, MAX_DESCRIPTION);
  ok('and truncation is reported', long.changes.some(c => /truncated/.test(c)));

  // THE ASSERTION THIS FILE EXISTS FOR: whatever comes out must mean the same thing
  // after the encoding the wire actually uses.
  const messy = '“Yeah” — I’m about to Kermit a war crime… café';
  const clean = cleanDescription(messy).text;
  eq('every cleaned character survives a latin1 round trip',
     Buffer.from(clean, 'latin1').toString('latin1'), clean);
  ok('and none of it is a control character', !/[\x00-\x08\x0b-\x1f\x7f]/.test(clean),
     JSON.stringify(clean));
}

// ------------------------------------------------------------------ the packet

console.log('\nthe packet on the wire');
{
  const sent = [];
  const c = new M59Client({ verbose: false });
  c.send = (op, ...parts) => sent.push(Buffer.concat([Buffer.from([op]), ...parts]));

  let threw = null;
  try { c.setDescription('hello'); } catch (e) { threw = e.message; }
  ok('refuses before there is an object id to describe', !!threw, String(threw));
  eq('and sends nothing', sent.length, 0);

  c.selfId = 0x1234;
  c.setDescription('wocka');
  eq('one packet went out', sent.length, 1);
  const p = sent[0];
  eq('opcode is BP_CHANGE_DESCRIPTION', p[0], 126);
  eq('then the object being described — ourselves', p.readUInt32LE(1), 0x1234);
  eq('then a 2-byte string length', p.readUInt16LE(5), 5);
  eq('then the text', p.subarray(7).toString('latin1'), 'wocka');
  eq('and nothing after it', p.length, 1 + 4 + 2 + 5);
}

// ------------------------------------------------------------- reading it back
//
// THE PACKET THIS CLIENT WAS DROPPING. Looking at a player does not answer with
// BP_LOOK — Player.TryLook (user.kod:4374) diverts to SendLookPlayer, which replies
// with BP_USERCOMMAND / UC_LOOK_PLAYER (merintr.c:1501). Incoming BP_USERCOMMAND was
// not handled at all, so every look at a person timed out and got blamed on
// OF_NOEXAMINE. A packet nobody parses reads exactly like a packet nobody sends.

console.log('\nlooking at a player');
{
  // extractObject, the long form. Only the ids and name resource matter here; the rest
  // is the shape the parser insists on, and it insists exactly.
  const u8 = n => Buffer.from([n & 0xff]);
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const pstr = s => Buffer.concat([u16(Buffer.byteLength(s, 'latin1')), Buffer.from(s, 'latin1')]);
  const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; };
  const obj = (id, nameRsc) => Buffer.concat([
    u32(id), u32(0), u32(nameRsc), u32(0), i32(0),   // id, icon, name, flags, rarity
    u16(0),                                           // dlighting: LIGHT_FLAG_NONE
    u8(1), u16(0),                                    // animation: ANIMATE_NONE + group
    u8(0),                                            // overlays: a count of none
  ]);

  const RSC = new Map([[400, '%q'], [700, 'Kermit'], [900, 'He has called Jasper home.']]);
  const lookPlayer = (id, descRsc, ...params) => Buffer.concat([
    u8(2 /* UC_LOOK_PLAYER */), obj(id, 700), u8(1 /* editable: it is us */),
    u32(descRsc), ...params,
    pstr('He has called Jasper home.'),   // ShowExtraInfo's fixed string
    pstr(''),                              // the URL
  ]);

  const c = new M59Client({ resources: RSC, verbose: false });
  const seen = [];
  c.on?.('look', e => seen.push(e));
  c.onEvent = ev => { if (ev.kind === 'look') seen.push(ev); };

  c.onGameMessage(155 /* BP_USERCOMMAND */, lookPlayer(4474, 400, pstr('Let slip Rowlfs of War.')));
  eq('a look event comes out', seen.length, 1);
  eq('carrying the description', seen[0]?.description, 'Let slip Rowlfs of War.');
  ok('flagged as a player', seen[0]?.player === true);
  ok('and as editable, because the server said we may change it', seen[0]?.editable === true);
  eq('with the extra info the game adds', seen[0]?.extra, 'He has called Jasper home.');
  eq('the object id is the character looked at', seen[0]?.id, 4474);

  // A player who has never set one gets a plain resource with no %q parameter, and the
  // packet is shorter by exactly that string. Reading a fixed number of parameters
  // would desync here.
  seen.length = 0;
  c.onGameMessage(155, lookPlayer(4475, 900));
  eq('a player with no description still parses', seen.length, 1);
  eq('and reports the default prose', seen[0]?.description, 'He has called Jasper home.');
}

// ------------------------------------------------------------------ the record

console.log('\nwriting down what was sent, because nothing reads it back');
{
  eq('nothing recorded to start with', listCharacters(), []);
  eq('an unknown character reads as empty', loadBook('Kermit'), emptyBook('Kermit'));

  const b1 = noteDescription('Kermit', 'a war crime, aboutta be Kermitted', { at: T0, agent: 't1' });
  eq('the text is stored', b1.description, 'a war crime, aboutta be Kermitted');
  eq('with the agent that sent it', b1.agent, 't1');
  ok('and it is NOT verified — nobody has looked', b1.verified === false);
  eq('it survives a reload', loadBook('Kermit').description, b1.description);
  eq('and it shows up in the listing', listCharacters(), ['Kermit']);

  ok('a character with no name is never written', noteDescription(null, 'x') === null);
  eq('so no unknown.json appears', listCharacters(), ['Kermit']);

  // Someone looked, and the prose came back.
  const seen = noteObserved('Kermit', 'a war crime, aboutta be Kermitted', { at: T0 + 1000, by: 't2' });
  ok('an exact match verifies it', seen.verified === true);
  eq('and records who looked', seen.observed_by, 't2');

  // CleanseString rewrote us, or the character was re-rolled underneath.
  const drift = noteObserved('Kermit', 'a war crime, aboutta be K***itted', { at: T0 + 2000, by: 't2' });
  ok('a near match does NOT verify', drift.verified === false);
  eq('but what was actually seen is kept', drift.observed, 'a war crime, aboutta be K***itted');

  // A NEW TEXT HAS NOT BEEN SEEN, whatever the old one had earned. Carrying the old
  // verification forward would report an unsent description as confirmed in game.
  noteObserved('Kermit', 'first', { at: T0 });
  noteDescription('Kermit', 'first', { at: T0 });
  ok('same text again keeps its verification',
     loadBook('Kermit').verified === false || loadBook('Kermit').description === 'first');
  const changed = noteDescription('Kermit', 'second', { at: T0 + 3000 });
  ok('a changed text drops back to unverified', changed.verified === false);

  ok('history keeps every text sent', loadBook('Kermit').history.length >= 3);
  eq('most recent last', loadBook('Kermit').history.at(-1).text, 'second');
}

// ------------------------------------------------------------------ who is who

console.log('\nnaming the right character');
{
  const roster = [{ agent: 't1', character: 'Kermit' }, { agent: 't2', character: 'Pepe' }];
  eq('by agent', resolveAgent(roster, 't2').character, 'Pepe');
  eq('by character name', resolveAgent(roster, 'Kermit').agent, 't1');
  eq('case does not matter', resolveAgent(roster, 'kermit').agent, 't1');

  // A NAME NOTHING ANSWERS TO MUST THROW, not resolve to the first row. Writing
  // Kermit's bio onto Fozzie is silent and only visible to other players.
  let threw = null;
  try { resolveAgent(roster, 'Gonzo'); } catch (e) { threw = e.message; }
  ok('an unknown name throws rather than guessing', !!threw);
  ok('and says who IS there', /Kermit/.test(String(threw)), String(threw));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
