#!/usr/bin/env node
// Who buys what, who sells what, and where they stand.
//
//   node tools/m59-merchants.mjs build      write substrate/m59-merchants.json
//   node tools/m59-merchants.mjs who-buys <thing>
//   node tools/m59-merchants.mjs who-sells <thing>
//   node tools/m59-merchants.mjs show <name>
//
// Merchants are picky, and the pickiness is not in the protocol. A merchant decides
// whether it wants an item in `ObjectDesired`, which is a kod METHOD overridden per
// merchant — the Barloque apothecary buys reagents but refuses gems, and it says so
// out loud rather than in any flag. So there are two halves to this catalogue and
// they come from different places:
//
//   from the RUNNING SERVER, over the admin socket:
//     which objects are merchants (viAttributes & MOB_BUYER / MOB_RECEIVE),
//     which room each is in, its markup, and its plFor_sale — the stock list, the
//     spells and skills it teaches, and any fixed prices
//
//   from the SOURCE TREE, which is the only place the buying rule exists at all:
//     each merchant class's ObjectDesired body, kept verbatim as a note, because a
//     rule expressed as code cannot be reduced to data without losing the cases
//
// plFor_sale is [ items, ?, spell/skill numbers, conditional-price list ]
// (see any SetForSale, e.g. kod/.../towns/barlqtwn/bqapoth.kod).
//
// The catalogue is a starting point, not an oracle. The authoritative test is still
// to offer the thing and read what the merchant says — `sell` with confirm:false
// quotes a price without committing, which is exactly that test.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const M59_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = process.env.M59_MERCHANTS || path.join(here, '..', 'substrate', 'm59-merchants.json');

// kod/include/blakston.khd
const MOB_BUYER = 0x00000008, MOB_RECEIVE = 0x00000010;

function adminBatch(cmds, quietMs = 900, capMs = 240000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, HOST);
    let buf = '', quiet, hard;
    const finish = () => { clearTimeout(quiet); clearTimeout(hard); s.destroy(); resolve(buf); };
    s.on('connect', () => {
      s.write(cmds.join('\r\n') + '\r\n');
      quiet = setTimeout(finish, quietMs); hard = setTimeout(finish, capMs);
    });
    s.on('data', d => { buf += d; clearTimeout(quiet); quiet = setTimeout(finish, quietMs); });
    s.on('error', e => { clearTimeout(quiet); clearTimeout(hard); reject(e); });
  });
}

function splitObjectBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /OBJECT (\d+) is CLASS (\w+)/.exec(raw);
    if (head) { cur = { id: Number(head[1]), cls: head[2], lines: [] }; blocks.push(cur); continue; }
    if (cur) cur.lines.push(raw);
  }
  return blocks;
}
const prop = (lines, name, kind = 'INT') => {
  const re = new RegExp(`${name}\\s+= ${kind} (-?\\d+)`);
  for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); }
  return null;
};

// Every merchant class the SOURCE knows about, whether or not one is standing in the
// world right now. A merchant that spawns conditionally, or lives in a room nobody
// has visited, is absent from the running server but still real — so the catalogue
// records it as known-but-unseen rather than pretending it does not exist.
function merchantClassesInSource() {
  const out = new Map();
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.kod')) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (!/^ {3}SetForSale/m.test(text)) continue;
      const cls = /^(\w+)\s+is\s+(\w+)/m.exec(text);
      if (!cls) continue;
      out.set(cls[1], {
        parent: cls[2],
        file: path.relative(M59_ROOT, full).split(path.sep).join('/'),
        // What it stocks, read straight out of SetForSale. Class names only — the
        // running world gives quantities, the source gives the roster.
        stocks: [...new Set([...text.matchAll(/Create\(&(\w+)/g)].map(m => m[1]))],
        teaches: [...new Set([...text.matchAll(/\b(SID|SKID)_(\w+)/g)].map(m => `${m[1]}_${m[2]}`))],
      });
    }
  };
  walk(path.join(M59_ROOT, 'kod'));
  return out;
}

// Pull `ObjectDesired` out of the source. It is a rule, not a table, so it is kept as
// text — an agent reading "buys reagents but not gems" learns more than it would from
// any flag we could invent for it.
function objectDesiredByClass() {
  const out = new Map();
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.kod')) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const cls = /^(\w+)\s+is\s+\w+/m.exec(text)?.[1];
      if (!cls) continue;
      const i = text.indexOf('   ObjectDesired(');
      if (i < 0) continue;
      // Take to the closing brace at METHOD indentation — kod methods are indented
      // three spaces and closed by a brace in column 4, while braces inside the body
      // are deeper. The tree is CRLF, so match the line ending rather than assuming
      // "\n" — assuming it runs the capture on into the next method.
      const rest = text.slice(i);
      const m = /\r?\n {3}\}\r?\n/.exec(rest);
      const body = m ? rest.slice(0, m.index + m[0].length) : rest.slice(0, 1200);
      out.set(cls, { file: path.relative(M59_ROOT, full).replace(/\\/g, '/'), body: body.trimEnd() });
    }
  };
  walk(path.join(M59_ROOT, 'kod'));
  return out;
}

// A merchant's stock. plFor_sale is a list of lists and `show list` prints it
// nested, so read one level and resolve object ids to names.
async function readForSale(listId) {
  if (!listId) return null;
  const dump = await adminBatch([`show list ${listId}`], 1200);
  // POSITION IS MEANING here — plFor_sale is a fixed four-slot structure
  // [ items, ?, spell/skill numbers, conditional prices ] — and an empty slot prints
  // as `$ 0`. Dropping those placeholders silently shifts every later slot left, so
  // the spells a merchant teaches would be read as though they were something else.
  const groups = [];
  let cur = null, depth = 0;
  for (const raw of dump.split(/\r?\n/)) {
    const line = raw.replace(/^:\s?/, '').trim();
    if (line === '[') { depth++; if (depth === 2) cur = []; continue; }
    if (line === ']') { if (depth === 2) { groups.push(cur); cur = null; } depth--; continue; }
    if (depth === 1 && /^\$\s+0$/.test(line)) { groups.push([]); continue; }   // empty slot
    const m = /^(?:INT|OBJECT|LIST)\s+(-?\d+)$/.exec(line);
    if (!m) continue;
    const entry = { kind: line.split(/\s+/)[0], v: Number(m[1]) };
    if (depth >= 2 && cur) cur.push(entry);
    else if (depth === 1) groups.push([entry]);
  }
  return groups;
}

async function build() {
  process.stderr.write('reading the room registry...\n');
  const sys = await adminBatch(['show object 0'], 900);
  const roomListId = prop(sys.split(/\r?\n/), 'plRooms', 'LIST');
  const roomDump = await adminBatch([`show list ${roomListId}`], 1500);
  const roomIds = [...new Set([...roomDump.matchAll(/OBJECT (\d+)/g)].map(m => Number(m[1])))];

  // Merchants live in rooms, so sweep each room's active list rather than guessing an
  // object-id range — the same reason the room graph uses SYS.plRooms.
  process.stderr.write(`sweeping ${roomIds.length} rooms for their contents...\n`);
  const roomInfo = new Map();
  const activeLists = [];
  for (let i = 0; i < roomIds.length; i += 300) {
    const slice = roomIds.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(id => `show object ${id}`)))) {
      const num = prop(b.lines, 'piRoom_num');
      if (num === null) continue;
      const active = prop(b.lines, 'plActive', 'LIST');
      roomInfo.set(b.id, { objId: b.id, cls: b.cls, num });
      if (active) activeLists.push({ room: b.id, list: active });
    }
    process.stderr.write(`\r  ${Math.min(i + 300, roomIds.length)}/${roomIds.length}`);
  }
  process.stderr.write('\n');

  process.stderr.write('reading room contents...\n');
  const candidates = [];
  for (let i = 0; i < activeLists.length; i += 200) {
    const slice = activeLists.slice(i, i + 200);
    const text = await adminBatch(slice.map(x => `show list ${x.list}`), 1500);
    const parts = text.split(/(?=show list \d+)/);
    for (const part of parts) {
      const lid = Number(/^show list (\d+)/.exec(part.trim())?.[1]);
      const owner = slice.find(x => x.list === lid);
      if (!owner) continue;
      for (const m of part.matchAll(/OBJECT (\d+)/g)) candidates.push({ id: Number(m[1]), room: owner.room });
    }
    process.stderr.write(`\r  ${Math.min(i + 200, activeLists.length)}/${activeLists.length} rooms`);
  }
  process.stderr.write(`\n  ${candidates.length} objects standing in rooms\n`);

  process.stderr.write('checking which are merchants...\n');
  const merchants = [];
  const uniq = [...new Map(candidates.map(c => [c.id, c])).values()];
  for (let i = 0; i < uniq.length; i += 300) {
    const slice = uniq.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(c => `show object ${c.id}`)))) {
      const attrs = prop(b.lines, 'viAttributes');
      const forSale = prop(b.lines, 'plFor_sale', 'LIST');
      const wanted = prop(b.lines, 'plWantedItems', 'LIST');
      // viAttributes is a classvar and does not appear in `show object`; fall back to
      // the presence of a stock list, which only merchants carry.
      const looksLikeMerchant = forSale || wanted ||
        (attrs !== null && (attrs & (MOB_BUYER | MOB_RECEIVE)));
      if (!looksLikeMerchant) continue;
      const home = uniq.find(c => c.id === b.id);
      merchants.push({
        id: b.id, cls: b.cls,
        roomObjId: home?.room ?? null,
        roomNum: home ? roomInfo.get(home.room)?.num ?? null : null,
        markup: prop(b.lines, 'viMerchant_markup'),
        forSaleList: forSale, wantedList: wanted,
      });
    }
    process.stderr.write(`\r  ${Math.min(i + 300, uniq.length)}/${uniq.length}, ${merchants.length} merchants`);
  }
  process.stderr.write('\n');

  // Stock lists, and names for everything in them.
  process.stderr.write('reading stock lists...\n');
  const itemIds = new Set();
  for (const m of merchants) {
    m.forSale = await readForSale(m.forSaleList);
    for (const g of m.forSale || []) for (const e of g) if (e.kind === 'OBJECT') itemIds.add(e.v);
  }
  const nameById = new Map();
  const ids = [...itemIds];
  for (let i = 0; i < ids.length; i += 300) {
    const slice = ids.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(id => `show object ${id}`)))) {
      nameById.set(b.id, { cls: b.cls, number: prop(b.lines, 'piNumber') });
    }
  }

  const desired = objectDesiredByClass();
  process.stderr.write(`${desired.size} classes define ObjectDesired in the source\n`);

  // Spell and skill NUMBERS are what plFor_sale carries, but nobody thinks in
  // numbers. blakston.khd declares them as SID_/SKID_ constants, which is the same
  // place m59-godmode reads them from.
  const spellNames = new Map(), skillNames = new Map(), constNums = new Map();
  try {
    const khd = fs.readFileSync(path.join(M59_ROOT, 'kod/include/blakston.khd'), 'utf8');
    for (const m of khd.matchAll(/^\s*(SID|SKID)_(\w+)\s*=\s*(\d+)/gm)) {
      const pretty = m[2].toLowerCase().replace(/_/g, ' ');
      (m[1] === 'SID' ? spellNames : skillNames).set(Number(m[3]), pretty);
      constNums.set(`${m[1]}_${m[2]}`, Number(m[3]));
    }
  } catch { /* names are a convenience; the numbers still work without them */ }
  process.stderr.write(`${spellNames.size} spells and ${skillNames.size} skills named\n`);

  const inSource = merchantClassesInSource();
  process.stderr.write(`${inSource.size} merchant classes defined in the source\n`);

  const out = { builtAt: new Date().toISOString(), merchants: [] };
  for (const m of merchants) {
    const stock = [];
    const teaches = [];
    (m.forSale || []).forEach((group, gi) => {
      for (const e of group) {
        if (e.kind === 'OBJECT') {
          const info = nameById.get(e.v);
          stock.push({ id: e.v, cls: info?.cls ?? null, quantity: info?.number ?? null });
        } else if (gi === 2) {
          // Group 3 of plFor_sale is spell and skill NUMBERS, not objects — this is
          // how a merchant teaches. Buying one calls AddSkill/AddSpell.
          teaches.push(e.v);
        }
      }
    });
    const od = desired.get(m.cls);
    out.merchants.push({
      seen: true,
      id: m.id, cls: m.cls, room: m.roomNum, markup: m.markup,
      sells: stock,
      // A number appears in both tables when a spell and a skill share it, so both
      // candidate names are offered rather than one being guessed.
      teaches: teaches.map(n => ({
        num: n,
        spell: spellNames.get(n) || undefined,
        skill: skillNames.get(n) || undefined,
      })),
      buying_rule: od ? { source: od.file, kod: od.body } : null,
      buys_anything: !od,     // the base Monster.ObjectDesired returns TRUE
    });
  }
  // Anything the source defines but the world was not showing. Its room may simply
  // not have been visited, or it may spawn only for a quest — either way an agent
  // asking "who buys gems" deserves to hear about it, flagged as unconfirmed.
  const seen = new Set(out.merchants.map(m => m.cls));
  for (const [cls, info] of inSource) {
    if (seen.has(cls)) continue;
    if (cls === 'Monster') continue;            // the base class, not a merchant
    const od = desired.get(cls);
    out.merchants.push({
      seen: false,
      id: null, cls, room: null, markup: null,
      sells: info.stocks.map(c => ({ id: null, cls: c, quantity: null })),
      teaches: info.teaches.map(name => {
        const num = constNums.get(name);
        return { num: num ?? null, spell: num != null ? spellNames.get(num) : undefined,
                 skill: num != null ? skillNames.get(num) : undefined, constant: name };
      }),
      buying_rule: od ? { source: od.file, kod: od.body } : null,
      buys_anything: !od,
      source: info.file,
      note: 'defined in the source but no instance was standing in the world when this was built',
    });
  }

  return out;
}

// --------------------------------------------------------------------- query

export function loadMerchants(file = OUT) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const cat = m => `${m.cls}${m.room != null ? ` (room ${m.room})` : ''}`;

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'build') {
    const data = await build();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
    console.log(`\nwrote ${OUT}`);
    console.log(`${data.merchants.length} merchants ` +
                `(${data.merchants.filter(m => m.seen).length} standing in the world, ` +
                `${data.merchants.filter(m => !m.seen).length} known from the source only)`);
    console.log(`${data.merchants.filter(m => m.sells.length).length} with stock, ` +
                `${data.merchants.filter(m => m.teaches.length).length} teaching spells or skills`);
    console.log(`${data.merchants.filter(m => m.buying_rule).length} with a specific buying rule; ` +
                `${data.merchants.filter(m => m.buys_anything).length} inherit the default (buy anything)`);
    process.exit(0);
  }

  const data = loadMerchants();

  if (cmd === 'who-teaches') {
    const q = rest.join(' ').toLowerCase();
    const hits = data.merchants.filter(m => m.teaches.some(t =>
      (t.spell || '').includes(q) || (t.skill || '').includes(q) || String(t.num) === q));
    console.log(hits.length ? `${hits.length} merchant(s) teach something matching "${q}":` : `nothing matches "${q}"`);
    for (const m of hits) {
      const t = m.teaches.filter(x => (x.spell || '').includes(q) || (x.skill || '').includes(q) || String(x.num) === q);
      console.log(`  ${cat(m).padEnd(38)} ${t.map(x => x.spell || x.skill || '#' + x.num).join(', ')}`);
    }
    console.log('\nBuying a spell or skill is the same shop transaction as buying an item.');
    process.exit(0);
  }

  if (cmd === 'who-sells') {
    const q = rest.join(' ').toLowerCase();
    const hits = data.merchants.filter(m => m.sells.some(s => (s.cls || '').toLowerCase().includes(q)));
    console.log(hits.length ? `${hits.length} merchant(s) sell something matching "${q}":` : `nothing matches "${q}"`);
    for (const m of hits) {
      const items = m.sells.filter(s => (s.cls || '').toLowerCase().includes(q));
      console.log(`  ${cat(m).padEnd(38)} ${items.map(i => i.cls + (i.quantity > 1 ? ` x${i.quantity}` : '')).join(', ')}`);
    }
    process.exit(0);
  }

  if (cmd === 'who-buys') {
    const q = rest.join(' ').toLowerCase();
    // The rule is CODE, so this greps the code. It cannot tell "buys gems" from
    // "buys anything except gems" — the Barloque apothecary's rule mentions gems
    // precisely in order to refuse them — so negations are flagged rather than
    // silently counted as matches.
    const hits = data.merchants.filter(m =>
      m.buying_rule ? m.buying_rule.kod.toLowerCase().includes(q) : false);
    console.log(`${hits.length} merchant rule(s) MENTION "${q}" — mentioning is not the same as accepting:`);
    for (const m of hits) {
      const line = m.buying_rule.kod.split(/\r?\n/).find(l => l.toLowerCase().includes(q)) || '';
      const negated = /\bNOT\b/i.test(line);
      console.log(`  ${cat(m).padEnd(36)} ${negated ? 'EXCLUDES it: ' : ''}${line.trim().slice(0, 70)}`);
    }
    const anyone = data.merchants.filter(m => m.buys_anything);
    console.log(`\n${anyone.length} merchant(s) inherit the default ObjectDesired and will consider anything:`);
    for (const m of anyone.slice(0, 12)) console.log(`  ${cat(m)}`);
    console.log('\nThe only certain test is to offer it: sell with confirm:false quotes a price without committing.');
    process.exit(0);
  }

  if (cmd === 'show') {
    const q = rest.join(' ').toLowerCase();
    const m = data.merchants.find(x => x.cls.toLowerCase().includes(q) || String(x.room) === q);
    if (!m) { console.error(`no merchant matches "${q}"`); process.exit(1); }
    console.log(`${m.cls}  room ${m.room}  markup ${m.markup ?? '(default)'}`);
    if (m.sells.length) console.log(`sells: ${m.sells.map(s => s.cls + (s.quantity > 1 ? ` x${s.quantity}` : '')).join(', ')}`);
    if (m.teaches.length) console.log(`teaches: ${m.teaches.map(t =>
      t.spell ? `${t.spell} (spell ${t.num})` : t.skill ? `${t.skill} (skill ${t.num})` : `#${t.num}`).join(', ')}`);
    console.log(m.buying_rule
      ? `\nbuying rule (${m.buying_rule.source}):\n${m.buying_rule.kod}`
      : '\nno ObjectDesired override — inherits the default, which accepts anything');
    process.exit(0);
  }

  console.error('usage: m59-merchants.mjs build | who-sells <thing> | who-buys <thing> | who-teaches <thing> | show <class|room>');
  process.exit(1);
}
