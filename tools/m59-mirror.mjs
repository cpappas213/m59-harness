#!/usr/bin/env node
// REBUILD A PROD CHARACTER ON THE LOCAL SERVER, WHERE WE ARE ADMIN.
//
//   node tools/m59-mirror.mjs plan                      what it would send, touching nothing
//   node tools/m59-mirror.mjs plan --character Animal
//   node tools/m59-mirror.mjs commands --character Animal   just the console lines
//   node tools/m59-mirror.mjs apply --object 1234 --character Animal --i-mean-it
//
// m59-sheet.mjs is the export; this is the import. Prod is a server we do not run and
// cannot snapshot — see the header of m59-sheet.mjs for why the savegame checkpoint does
// not cover it. Locally we ARE the admin, so a mirror does not have to be earned: the
// maintenance socket can set the values directly.
//
// THIS DOES NOT RE-ROLL ANYTHING. An earlier draft recreated characters through `reroll`
// and then reported everything that could not carry over, because attributes are fixed at
// creation. That was the wrong shape for a server we administer: re-rolling SUICIDES the
// character to get a fresh one, and here there is nothing to work around — blakserv's
// admin console will set the properties on the character that already exists.
//
// THE TWO LEVERS, both from the server's own source:
//
//   set object <id> <property> INT <value>          adminfn.c:396 (AdminSetObject)
//     Attributes live on the player object as piMight, piIntellect, piStamina,
//     piAgility, piMysticism and piAim (player.kod:796-801). These are the part that
//     cannot be earned at all — fixed at creation, never move — so they are the part a
//     mirror most needs and the part `set` handles exactly.
//
//   send object <id> ChangeSkillAbility ...         adminfn.c:433 (AdminSendObject)
//     Skills and spells are LIST nodes (plSkills / plSpells, player.kod:767-770), not
//     properties, so `set object` cannot reach them. The kod exposes the mutator, and it
//     already has a DM door in its signature:
//       ChangeSkillAbility(Skill_num, amount, report, refigureschools, bDM)
//                                                            player.kod:7290
//     bDM is the flag that says this is an administrator setting a value rather than a
//     character earning one.
//
// It emits commands rather than running them by default, because the thing that reads
// them should be able to check them first — these set a character's permanent statistics
// on a server, and a typo in a property name is silently accepted by `set object`.
//
// ============================================================================
// IT REFUSES ANY TARGET THAT IS NOT LOOPBACK, AND CHECKS TWICE.
// ============================================================================
//
// The first check is the maintenance host it was told to talk to. The second is what the
// broker's characters are actually connected to, read back from that broker — and the
// second is the one that matters, because a broker on 127.0.0.1:8901 is EXACTLY what prod
// looks like from this machine. The broker is local; the server is not. Every one of the
// fleet's connections is outbound to 76.214.42.186. A check that only looked at the URL
// would pass on the single configuration this exists to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEET_DIR } from './m59-sheet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

// The six, and the property each lands on. player.kod:796-801.
export const ATTR_PROPERTY = {
  might: 'piMight', intellect: 'piIntellect', stamina: 'piStamina',
  agility: 'piAgility', mysticism: 'piMysticism', aim: 'piAim',
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function isLoopbackHost(host) {
  return !!host && LOOPBACK.has(String(host).trim().toLowerCase());
}
export function brokerHostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// Both gates as one answer. An empty session list is not permission, it is an unknown.
export function refuseUnlessLocal({ brokerUrl, sessionHosts }) {
  const bh = brokerHostOf(brokerUrl);
  if (!isLoopbackHost(bh))
    return `the broker at ${brokerUrl} is not on loopback (${bh ?? 'unparseable'})`;
  if (!Array.isArray(sessionHosts))
    return 'could not read what that broker\'s sessions are connected to';
  const remote = [...new Set(sessionHosts.filter(h => !isLoopbackHost(h)))];
  if (remote.length)
    return `that broker's characters are connected to ${remote.join(', ')} — a LOCAL broker ` +
           'holding a REMOTE fleet is exactly what prod looks like from here';
  if (!sessionHosts.length)
    return 'that broker is holding no sessions, so there is nothing to prove it is local';
  return null;
}

export function readSheets({ character = null } = {}) {
  let files = [];
  try { files = fs.readdirSync(SHEET_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SHEET_DIR, f), 'utf8'));
      if (character && s.character !== character) continue;
      out.push(s);
    } catch { /* a half-written sheet is skipped, not fatal */ }
  }
  return out.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
}

// The console lines that would make object `objectId` match this sheet.
//
// `objectId` is the LOCAL character's object id, not the one in the sheet — the sheet
// records prod's id and it means nothing on another server. Object ids are also reissued
// by `save game`, so this is asked for per run rather than remembered.
export function commandsFor(sheet, objectId) {
  const lines = [];
  const notes = [];
  const a = sheet.attributes ?? {};

  for (const [k, prop] of Object.entries(ATTR_PROPERTY)) {
    const v = a[k];
    if (!Number.isFinite(v)) { notes.push(`no ${k} in the sheet — left alone`); continue; }
    lines.push(`set object ${objectId} ${prop} INT ${v}`);
  }

  // Abilities. `id` is the skill/spell number the server itself gave us on BP_STAT, so
  // this does not depend on any name table of ours being right.
  for (const kind of ['skills', 'spells']) {
    for (const row of sheet[kind] || []) {
      const want = row.ability;
      if (!Number.isFinite(want) || want <= 0) continue;
      if (!Number.isFinite(row.id)) { notes.push(`${row.name}: no id recorded, cannot set`); continue; }
      lines.push(`send object ${objectId} ChangeSkillAbility Skill_num INT ${row.id} ` +
                 `amount INT ${want} report INT 0 refigureschools INT 1 bDM INT 1` +
                 `   # ${kind.slice(0, -1)}: ${row.name}`);
    }
  }

  // Level IS maximum health (101 + stamina is the ceiling, not the value), so setting
  // stamina does not set the level. Say so rather than leave a reader to wonder why the
  // mirror came out at level 3.
  if (sheet.level != null)
    notes.push(`level ${sheet.level} is maximum health and is earned; setting piStamina ` +
               `only raises the CEILING to ${a.health_ceiling ?? '?'}. Nothing here sets it.`);
  notes.push('karma, money, items and room are not touched — they are not part of what ' +
             'makes this character this character.');
  return { lines, notes };
}

async function rpc(brokerUrl, name, args = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(brokerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(j.result.content[0].text);
    return JSON.parse(j.result.content[0].text);
  } finally { clearTimeout(t); }
}

// What the target broker's characters are connected to. Read from the broker rather than
// from any file here, because the question is about the running thing.
export async function sessionHostsOf(brokerUrl) {
  const f = await rpc(brokerUrl, 'fleet', {});
  const hosts = (f.fleet || []).map(r => r.host ?? r.credentials?.host ?? null).filter(Boolean);
  if (hosts.length) return hosts;
  try {
    const h = await (await fetch(new URL('/health', brokerUrl))).json();
    const g = h.game_server ?? h.server ?? null;
    if (g) return [String(g).split(':')[0]];
  } catch { /* unknown */ }
  return [];
}

// ---------------------------------------------------------------------- cli
if (process.argv[1] && path.basename(process.argv[1]) === 'm59-mirror.mjs') {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'plan';
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const only = arg('--character');
  const brokerUrl = arg('--broker', 'http://127.0.0.1:8899');
  const objectId = arg('--object');

  const sheets = readSheets({ character: only });
  if (!sheets.length) {
    console.error(`no sheets in ${path.relative(REPO, SHEET_DIR)} — run: node tools/m59-sheet.mjs`);
    process.exit(1);
  }

  if (cmd === 'plan' || cmd === 'commands') {
    const id = objectId ?? '<LOCAL-OBJECT-ID>';
    for (const s of sheets) {
      const { lines, notes } = commandsFor(s, id);
      if (cmd === 'commands') { lines.forEach(l => console.log(l)); continue; }
      const a = s.attributes ?? {};
      console.log(`\n=== ${s.character} (level ${s.level ?? '?'}, sheet ${s.captured_at_iso ?? '?'}) ===`);
      console.log(`  attributes  ${Object.keys(ATTR_PROPERTY).map(k => `${k[0]}${k[1]}:${a[k] ?? '?'}`).join(' ')}`);
      console.log(`  ${lines.length} console line(s) to make a local character match`);
      for (const n of notes) console.log(`  note: ${n}`);
    }
    if (cmd === 'plan') {
      console.log(`\n${sheets.length} sheet(s). To see the lines:`);
      console.log('  node tools/m59-mirror.mjs commands --character <name> --object <local object id>');
      console.log('Find the local object id with the admin console: `show object <id>`, or from');
      console.log('the broker\'s `status` for that character on the LOCAL server.');
    }
    process.exit(0);
  }

  if (cmd === 'apply') {
    if (!argv.includes('--i-mean-it')) {
      console.error('`apply` writes permanent statistics onto a character. Re-run with --i-mean-it.');
      console.error('See what it would send first: node tools/m59-mirror.mjs commands --character <name> --object <id>');
      process.exit(2);
    }
    if (!objectId) { console.error('apply needs --object <local object id>'); process.exit(2); }
    let hosts = null;
    try { hosts = await sessionHostsOf(brokerUrl); }
    catch (e) { console.error(`cannot reach a broker at ${brokerUrl}: ${e.message}`); process.exit(1); }
    const refusal = refuseUnlessLocal({ brokerUrl, sessionHosts: hosts });
    if (refusal) {
      console.error('REFUSING TO APPLY.');
      console.error(`  ${refusal}`);
      console.error('');
      console.error('  This sets permanent statistics through the maintenance socket. Against prod');
      console.error('  it would rewrite live characters on a server shared with other people.');
      process.exit(2);
    }
    console.error(`target looks local (broker ${brokerHostOf(brokerUrl)}, sessions on ` +
                  `${[...new Set(hosts)].join(', ')})`);
    console.error('');
    console.error('NOT IMPLEMENTED YET: there is no local server running to develop this against.');
    console.error('The maintenance socket is 9998 and was not answering when this was written, so');
    console.error('the send path is unwritten rather than written-and-untested. The commands are');
    console.error('correct against the source; paste them into the admin console, or bring a local');
    console.error('server up and this can be finished against it.');
    for (const s of sheets) commandsFor(s, objectId).lines.forEach(l => console.log(l));
    process.exit(0);
  }

  console.error(`unknown command "${cmd}" — use plan, commands or apply`);
  process.exit(1);
}
