#!/usr/bin/env node
// extract-spawns.mjs -- where every monster class appears in the world.
//
// Writes data/spawns.json:
//   { builtAt: null,
//     rooms:     { <RoomClassName>: { name, rid, file } },
//     byMonster: { <MonsterClassName>: [ { room, name, cite, how, count, chance, cap } ] } }
//
// Run:  node tools/extract-spawns.mjs      (from C:/code/m59-harness/compendium)
//
// ===========================================================================
// THE MECHANISMS, AS THE TREE ACTUALLY IMPLEMENTS THEM
// ===========================================================================
// Everything a room can put in the world goes through Room's holder plumbing:
// `Send(self,@NewHold,#what=<obj>,#new_row=..,#new_col=..)`
//   -- kod/object/active/holder/room.kod:1706 NewHold, :1769 NewHoldObject.
// So a spawn is always some code path that reaches Create(&Class) and then a
// NewHold.  There are exactly five such paths in this tree, plus one dead end:
//
// (1) "generator" -- the plMonsters weighted table on MonsterRoom.
//     kod/object/active/holder/room/monsroom.kod:57 declares
//         plMonsters = $        % "List of monsters we spawn, [class, chance]"
//     and :157-172 walks it with a running total against one Random(1,100):
//         iRoll = Random(1,100);            % monsroom.kod:149
//         iTotal = 0;
//         for lMonster_info in plMonsters {
//            iTotal = iTotal + Nth(lMonster_info,2);
//            if iRoll <= iTotal { oMonster = Create(First(lMonster_info)); ... } }
//     so the second element is a percentage weight and the weights of a room
//     are meant to sum to 100.  A room fills its table in Constructor or
//     Constructed, e.g. kod/.../room/monsroom/orccave1.kod:55
//         plMonsters = [ [&Orc, 60], [&CaveOrc, 40] ];
//     Placement is a random pick from plGenerators (monsroom.kod:216-220), a
//     list of [row,col] spawn points; with plGenerators = $ the monster lands
//     on a random square (monsroom.kod:211-212).  Some rooms load that point
//     list from a generated `include <room>.kmn` file
//     (e.g. monsroom/necarea1.kod:60 -> necarea1.kmn).  Those .kmn/.ktm files
//     were checked: they contain coordinates and ornaments only, never a
//     monster class, so they are not a source of spawn identities.
//     Volume knobs, all room properties inherited from monsroom.kod:
//       piGen_time         :26   base timer between rolls (ms)
//       piGen_percent      :48   chance the timer roll spawns anything at all
//       piInit_count_min   :42 / piInit_count_max :45  batch on FirstUserEntered
//       piMonster_count_max:51   hard cap, checked by IsMonsterCountBelowMax :242
//     Reported as how="generator", chance=<weight>, cap=<piMonster_count_max>.
//
// (2) "boss" / "henchman" -- BossRoom's respawning set piece.
//     kod/object/active/holder/room/monsroom/bossroom.kod:27-28 declares
//         plBossTemplate = $ / plHenchmenTemplate = $   % [&classname, row, col]
//     and ResetBoss (:188-205) creates one monster per entry at that exact
//     square.  ResetBoss runs at construction (:48-56) and again after the
//     boss has been killed and the room emptied for viBossResetTime
//     (:121-157).  Only two rooms use it:
//       bossroom/orcpit1.kod:105  plBossTemplate = [ [&OrcPitBoss, 24, 41] ]
//                          :106  plHenchmenTemplate = [ [&OrcWizard, ...] x2 ]
//       bossroom/sewking.kod:156  plBossTemplate = [ [&LupoggKing, 6, 32] ]
//                          :157  plHenchmenTemplate = [ [&Lupogg, ...] x3 ]
//     Reported with count = number of template entries; no chance, no cap.
//
// (3) "create" -- a literal Create(&Class) placed once when the room is built.
//     115 of the 150 monster Create() calls in room kod sit in
//     CreateStandardObjects, the hook Room documents for exactly this
//     (room.kod:811-816), a couple more in Constructor.  This is how every
//     shopkeeper, guard and priest gets into the world, e.g.
//       barlqrm/barcourt.kod:117  Create(&DukeGuard)
//       godroom.kod:68-72         Minstrel, Heretic, DarkWizard, HunterGhost, Izzio
//       guest2/newb2.kod:42-44    three Cows
//     There is no NPC placement registry: util/library.kod's plOccupations is
//     a *speech* table and GetOccupationList only looks up objects that a room
//     already created (see monsroom/kcforest/kc5.kod:107).
//     Reported with count = number of Create call sites in that handler.
//
// (4) "respawn" -- a literal Create(&Class) on a timer or a room event.
//     The other 35 Create() calls, classified by their enclosing handler:
//       nest1.kod:105       QueenGenTimer, hourly  -> &SpiderQueen
//       objroom/icecave1.kod:124  YetiGenTimer     -> &Yeti
//       throne1.kod:121     SpawnGhost             -> &Ghost
//       i9.kod:195-199      RecalcLightAndWeather at hour 0 -> 3x &StoneTroll
//       g9.kod:543-547      GenerateSkellies (puzzle) -> Skeleton/BatteredSkeleton
//       guest6.kod:330,604-613  FirstUserEntered / ResetMonstersInFinal -> Mummies
//       marcry3a.kod:477-850    StartTrapNTimer / CreateThrashers -> &Thrasher
//       marcryp1.kod:562,571    LivingStatue + 5x SpectralMummy on the final trap
//       feyforst.kod:140,145    TryCreateMonster override -> &Fairy / &EvilFairy
//                               (karma decides which; not a fixed percentage)
//       rentroom.kod:1104   DecoratorArrives       -> &Decorator
//     Reported with count = number of Create call sites in that handler.
//
// (5) "findlist" -- dungeon.kod's crate rummage.
//     kod/object/active/holder/room/dungeon.kod:58-68 sets plFind to a flat
//     list of classes; :153 picks one uniformly with
//         find = Nth(plFind,random(1,length(plFind)));
//     and :175+ holds it in the room if it turned out to be a Monster.
//     Two of the eleven entries are monsters (&SpiderBaby, &NarthylWorm), so
//     each is reported with chance = 100/11 = 9%.
//
// NOT a spawn, deliberately excluded:
//   * util/system.kod:4654+ plMonsterTemplates -- one instance of every common
//     monster created at boot and kept in limbo as a DM/admin prototype list.
//   * util/questengine.kod #monsterlist -- kill *targets* for quest nodes; the
//     engine never creates them, it counts kills.
//   * util/library.kod plOccupations / plSpeechLib -- speech tables.
//   * active/wallelem/web.kod:64 plExcludedMonsters, spell/earthqua.kod:326
//     lBossMonsters -- immunity lists.
//   * IsClass / FindListElem / CountHoldingHowMany tests.
//
// INHERITANCE.  Room classes inherit spawn behaviour, and several abstract
// bases carry all the interesting code:
//   FeyForest (monsroom/feyforst.kod) has no piRoom_num; its eight OutdoorsA1..
//   D2 children are the real rooms, and they inherit its Fairy/EvilFairy
//   TryCreateMonster.  Same for RentableRoom -> the three town rentables.
// So a site is attributed to every *concrete* room whose chain contains the
// declaring class.  A room counts as concrete when its chain resolves
// piRoom_num to something other than the bare declaration in room.kod:195 or
// `$`, or -- for the rentable rooms, whose number is assigned at runtime
// (rentroom.kod:201 piRoom_num = $) -- when it owns a prRoom resource and has
// no subclasses.  Class variables and properties are resolved along the chain,
// case-insensitively, because kod identifiers are case-insensitive and this
// tree exploits it: monsroom/kcforest/ke4.kod:118 writes &Avarshaman where
// avshaman.kod:11 declares AvarShaman, and kc4.kod:54 writes &DragonFly for
// dflyer.kod's Dragonfly.  Matching case-sensitively silently splits those
// creatures in two.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, M59, loadDB, cls, rvar, nameOf, humanize, cleanText } from './lib.mjs';

const db = loadDB();

// ---------------------------------------------------------------- the cast

// Every class whose chain contains Monster, keyed lowercase -> canonical name.
const MONSTER = new Map();
for (const c of Object.values(db.classes)) {
  const chain = c.chain.map((x) => x.toLowerCase());
  if (chain.includes('monster')) MONSTER.set(c.name.toLowerCase(), c.name);
}
const isMonster = (n) => MONSTER.has(String(n).toLowerCase());
const monName = (n) => MONSTER.get(String(n).toLowerCase());

const ROOMS = Object.values(db.classes)
  .filter((c) => c.chain.map((x) => x.toLowerCase()).includes('room'));

// ---------------------------------------------------------------- chain reads

// A property, resolved along the inheritance chain, case-insensitively.
// lib.inherited() does this for classvars; properties need the same walk.
function prop(c, name) {
  const want = name.toLowerCase();
  for (const step of c.chain) {
    const k = cls(db, step);
    if (!k) continue;
    for (const [key, v] of Object.entries(k.properties)) {
      if (key.toLowerCase() === want) return { ...v, from: k.name };
    }
  }
  return null;
}

// room.kod:195 declares `piRoom_num` with no value; rentroom.kod:201 sets it to
// `$`.  Neither is a room number.
function ridOf(c) {
  const p = prop(c, 'piRoom_num');
  if (!p || !p.expr || p.expr === '$') return null;
  return p.expr.trim();
}

function isConcrete(c) {
  if (ridOf(c)) return true;
  const ownRoo = Object.keys(c.properties).some((k) => k.toLowerCase() === 'prroom');
  return ownRoo && c.children.length === 0;
}

function roomName(c) {
  const n = nameOf(db, c);
  if (n) return n;
  const r = rvar(db, c, 'vrName');
  if (r && r.kind === 'string') return cleanText(r.value);
  return humanize(c.name);
}

const CONCRETE = ROOMS.filter(isConcrete);
// declaring class (lowercase) -> concrete rooms that inherit from it
const HEIRS = new Map();
for (const r of CONCRETE) {
  for (const step of r.chain) {
    const k = step.toLowerCase();
    if (!HEIRS.has(k)) HEIRS.set(k, []);
    HEIRS.get(k).push(r);
  }
}

// ---------------------------------------------------------------- kod reading

// Strip '%' line comments but keep every line, so line numbers stay true.
function readCode(file) {
  const p = path.join(M59, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'latin1').split(/\r?\n/).map((l) => l.replace(/%.*$/, ''));
}

// A balanced [...] starting at or after `from`; returns {text, end} or null.
function bracketed(text, from) {
  const start = text.indexOf('[', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// Which message body contains this line?  koddb gives line/endLine per message.
function messageAt(c, line) {
  for (const m of c.messages) {
    if (line >= m.line && line <= (m.endLine ?? m.line)) return m.name;
  }
  return null;
}

// CreateStandardObjects is Room's documented "objects that start out here"
// hook (room.kod:811); anything else that reaches Create() is a timer or an
// event handler, i.e. a repeat spawn.
const BUILD_HOOKS = /^(CreateStandardObjects|Constructor|Constructed)$/i;

// ---------------------------------------------------------------- extraction

// Sites keyed by the class that DECLARES them; inheritance is applied after.
// { cls, how, monster, cite, line, count, chance }
const sites = [];

for (const c of ROOMS) {
  const lines = readCode(c.file);
  if (!lines) { console.warn(`! missing source for ${c.name}: ${c.file}`); continue; }
  const text = lines.join('\n');
  const consumed = [];              // [start,end) spans already claimed by a list
  const claim = (a, b) => consumed.push([a, b]);
  const claimed = (i) => consumed.some(([a, b]) => i >= a && i < b);

  // -- (1) plMonsters = [ [&Class, weight], ... ]
  for (const m of text.matchAll(/\bplMonsters\s*=/gi)) {
    const b = bracketed(text, m.index + m[0].length);
    if (!b) continue;                                  // `plMonsters = $;`
    claim(m.index, b.end);
    const line = lineOf(text, m.index);
    for (const p of b.text.matchAll(/\[\s*&(\w+)\s*,\s*(-?\d+)\s*\]/g)) {
      if (!isMonster(p[1])) continue;
      sites.push({
        cls: c, how: 'generator', monster: monName(p[1]),
        line, count: null, chance: parseInt(p[2], 10),
      });
    }
  }

  // -- (2) plBossTemplate / plHenchmenTemplate = [ [&Class, row, col], ... ]
  for (const m of text.matchAll(/\b(plBossTemplate|plHenchmenTemplate)\s*=/gi)) {
    const b = bracketed(text, m.index + m[0].length);
    if (!b) continue;
    claim(m.index, b.end);
    const how = /henchmen/i.test(m[1]) ? 'henchman' : 'boss';
    const line = lineOf(text, m.index);
    const tally = new Map();
    for (const p of b.text.matchAll(/\[\s*&(\w+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/g)) {
      if (!isMonster(p[1])) continue;
      const k = monName(p[1]);
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    for (const [k, n] of tally) {
      sites.push({ cls: c, how, monster: k, line, count: n, chance: null });
    }
  }

  // -- (5) plFind = [ &Class, ... ]   (dungeon.kod's crate rummage)
  for (const m of text.matchAll(/\bplFind\s*=/gi)) {
    const b = bracketed(text, m.index + m[0].length);
    if (!b) continue;
    claim(m.index, b.end);
    const line = lineOf(text, m.index);
    const all = [...b.text.matchAll(/&(\w+)/g)].map((x) => x[1]);
    if (!all.length) continue;
    const pct = Math.round(100 / all.length);
    for (const n of all) {
      if (!isMonster(n)) continue;
      sites.push({ cls: c, how: 'findlist', monster: monName(n), line, count: null, chance: pct });
    }
  }

  // -- (3)/(4) Create(&Class), grouped by the handler it sits in
  const byHandler = new Map();
  for (const m of text.matchAll(/\bCreate\s*\(\s*&(\w+)/gi)) {
    if (claimed(m.index)) continue;
    if (!isMonster(m[1])) continue;
    const line = lineOf(text, m.index);
    const msg = messageAt(c, line);
    const how = msg && BUILD_HOOKS.test(msg) ? 'create' : 'respawn';
    const key = `${monName(m[1])}\u0000${how}\u0000${msg || ''}`;
    const cur = byHandler.get(key);
    if (cur) cur.count++;
    else byHandler.set(key, { cls: c, how, monster: monName(m[1]), line, count: 1, chance: null });
  }
  for (const s of byHandler.values()) sites.push(s);
}

// ---------------------------------------------------------------- assembly

const rooms = {};
for (const r of CONCRETE) {
  rooms[r.name] = { name: roomName(r), rid: ridOf(r), file: r.file };
}

// piMonster_count_max is the room's hard ceiling on live monsters
// (monsroom.kod:51, enforced at :242).  Only meaningful for the generator.
function capOf(r) {
  const p = prop(r, 'piMonster_count_max');
  if (!p || !p.expr) return null;
  return typeof p.value === 'number' ? p.value : null;
}

const byMonster = {};
for (const s of sites) {
  const heirs = HEIRS.get(s.cls.name.toLowerCase()) || [];
  for (const room of heirs) {
    const list = (byMonster[s.monster] = byMonster[s.monster] || []);
    list.push({
      room: room.name,
      name: rooms[room.name].name,
      cite: `${s.cls.file}:${s.line}`,
      how: s.how,
      count: s.count,
      chance: s.chance,
      cap: s.how === 'generator' ? capOf(room) : null,
    });
  }
}

// Stable order: by room name, then by how, then by citation.
const HOW_ORDER = ['generator', 'boss', 'henchman', 'create', 'respawn', 'findlist'];
for (const list of Object.values(byMonster)) {
  list.sort((a, b) => a.name.localeCompare(b.name)
    || HOW_ORDER.indexOf(a.how) - HOW_ORDER.indexOf(b.how)
    || a.cite.localeCompare(b.cite));
}

const out = {
  builtAt: null,
  rooms: Object.fromEntries(Object.entries(rooms).sort((a, b) => a[0].localeCompare(b[0]))),
  byMonster: Object.fromEntries(Object.entries(byMonster).sort((a, b) => a[0].localeCompare(b[0]))),
};

const dest = path.join(ROOT, 'data', 'spawns.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1));

// ---------------------------------------------------------------- report

const allMonsters = [...MONSTER.values()].filter((n) => n.toLowerCase() !== 'monster');
const placed = allMonsters.filter((n) => byMonster[n]);
const missing = allMonsters.filter((n) => !byMonster[n]);
const howCount = {};
for (const l of Object.values(byMonster)) for (const e of l) howCount[e.how] = (howCount[e.how] || 0) + 1;

console.log(`spawns.json  ->  ${dest}`);
console.log(`  room classes        ${ROOMS.length} total, ${CONCRETE.length} concrete`);
console.log(`  declaration sites   ${sites.length}`);
console.log(`  monster classes     ${placed.length}/${allMonsters.length} placed somewhere`);
console.log(`  entries by kind     ${Object.entries(howCount).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`  no site found (${missing.length}): ${missing.sort().join(', ')}`);
