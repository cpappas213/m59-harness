#!/usr/bin/env node
// extract-treasure.mjs -- what every TID_ treasure type actually drops.
//
//   node tools/extract-treasure.mjs        write data/treasure.json
//
// Nothing here is invented.  Every number is read out of data/koddb.json or out
// of the kod source itself (for per-line citations), and every field that a
// reader could doubt carries a "kod/<file>:<line>".
//
// The drop path, in the order the server walks it:
//
//   monster.kod:3108   Killed()          -> Send(self,@CreateTreasure)
//   monster.kod:4938   CreateTreasure()  -> decides HOW MANY items roll
//   system.kod:1363    FindTreasureByNum -> the TreasureType object for viTreasure_type
//   trestype.kod:223   GenerateTreasure()-> rolls ONE item, called once per item
//   trestype.kod:33    Constructed()     -> normalises the table's weights to 100
//
// Three things can short-circuit a single roll before the weighted table is
// consulted: a game token, a newbie signet ring, and an item-attributed
// ("magic") weapon.  They are recorded in rules.preempt, not in the tables,
// because none of them is per-type data except the item-att chance.

import fs from 'node:fs';
import path from 'node:path';
import { loadDB, cls, descendants, inherited, nameOf, humanize, M59, ROOT } from './lib.mjs';

const OUT = path.join(ROOT, 'data', 'treasure.json');

// ---------------------------------------------------------------- kod maths
//
// Blakod is integer-only and '/' truncates toward zero.  Every arithmetic step
// below is written the way the server evaluates it, in source order, so the
// truncation lands in the same places.
const tdiv = (a, b) => Math.trunc(a / b);

// bound(x,lo,hi); '$' (nil) on either side means "no bound on that side".
function bound(x, lo, hi) {
  if (lo !== null && x < lo) return lo;
  if (hi !== null && x > hi) return hi;
  return x;
}

// A class variable is normally read with lib.ivar, but blakcomp lets a class
// re-declare an inherited classvar as an instance PROPERTY: the classvar slot is
// then filled with a TAG_OVERRIDE that redirects every read -- including reads
// from the parent's own code -- to that property (blakcomp/actions.c:780-810,
// blakserv/sendmsg.h:168).  Zombie is the one monster in the tree that does this,
// and it does it for viTreasure_type and viLevel, so a classvars-only lookup
// would report Zombie as dropping nothing.  Walk the chain checking both bags;
// the compiler forbids a class declaring the same name in both.
function resolveVar(db, c, varName) {
  const want = varName.toLowerCase();
  for (const step of c.chain) {
    const k = cls(db, step);
    if (!k) continue;
    for (const bag of ['classvars', 'properties']) {
      for (const [key, v] of Object.entries(k[bag])) {
        if (key.toLowerCase() !== want) continue;
        if (v.expr === '$') return null;
        return v.value ?? null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- source I/O

const srcCache = new Map();
function sourceLines(file) {
  if (!srcCache.has(file)) {
    const p = path.join(M59, file.replace(/\//g, path.sep));
    srcCache.set(file, fs.existsSync(p) ? fs.readFileSync(p, 'latin1').split(/\r?\n/) : null);
  }
  return srcCache.get(file);
}

// Strip a '%' comment without eating a '%' inside a string literal.
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === '%' && !inStr) return line.slice(0, i);
  }
  return line;
}

// Find the 1-based line of the first uncommented match of `re` in `file`.
function lineOf(file, re, from = 1, to = Infinity) {
  const lines = sourceLines(file);
  if (!lines) return null;
  for (let i = from - 1; i < Math.min(lines.length, to); i++) {
    if (re.test(stripComment(lines[i]))) return i + 1;
  }
  return null;
}

const cite = (file, line) => (line ? `${file}:${line}` : file);

// ---------------------------------------------------------------- constants

// koddb.json keeps constant values but not the line they are declared on, and a
// citation without a line is not a citation.  Read blakston.khd for the lines.
function tidLines() {
  const p = path.join(M59, 'kod', 'include', 'blakston.khd');
  const out = new Map();
  const lines = fs.readFileSync(p, 'latin1').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(TID_[A-Za-z0-9_]+)\s*=\s*(-?\d+)/i.exec(stripComment(lines[i]));
    if (m) out.set(m[1].toUpperCase(), { value: parseInt(m[2], 10), line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------- the table
//
// Every concrete TreasureType writes its table as a single list literal in its
// own constructed():
//     plTreasure = [ [ &OrcTooth, 40 ], [ &PurpleMushroom, 20 ], ... ];
// Read the pairs out of the source rather than the parsed body so that each
// entry can cite the line it is written on.
function readTable(db, c) {
  const m = c.messages.find((x) => /^constructed$/i.test(x.name));
  if (!m) return { entries: [], msgLine: null };
  const lines = sourceLines(c.file);
  if (!lines) return { entries: [], msgLine: m.line };
  const entries = [];
  for (let i = m.line - 1; i < Math.min(lines.length, m.endLine || lines.length); i++) {
    const text = stripComment(lines[i]);
    for (const p of text.matchAll(/\[\s*&(\w+)\s*,\s*(-?\d+)\s*\]/g)) {
      entries.push({ cls: p[1], weight: parseInt(p[2], 10), line: i + 1 });
    }
  }
  return { entries, msgLine: m.line };
}

// trestype.kod:44-74 -- Constructed() rewrites the weights in place so they sum
// to 100, then dumps the integer-division shortfall onto the FIRST entry.
function normalise(weights) {
  let adjust = weights.reduce((a, b) => a + b, 0);
  if (adjust === 0) adjust = 100;
  const out = weights.map((w) => tdiv(w * 100, adjust));
  const total = out.reduce((a, b) => a + b, 0);
  if (total < 100 && out.length) out[0] += 100 - total;
  return out;
}

// trestype.kod:284-310 -- iRnd = Random(0,100) is 101 equally likely values and
// the comparison is "<=", so the FIRST entry quietly gets one extra outcome and
// every entry is really out of 101, not 100.  The intended percentage and the
// real one are both reported; they differ by about 1%.
const RND_OUTCOMES = 101;
function exactChance(normWeights) {
  return normWeights.map((w, i) => {
    const hits = i === 0 ? w + 1 : w;
    return Math.round((hits / RND_OUTCOMES) * 1e5) / 1e3;   // percent, 3 dp
  });
}

// ---------------------------------------------------------------- money
//
// trestype.kod:300-306.  Money is NOT a separate roll: &Money is an ordinary
// weighted entry, and when it wins the stack size is set from the monster's
// viLevel.  Create(&Money) starts at piNumber = 1 (numbitem.kod:44) and
// AddNumber adds iNumber on top, so the pile is 1 + iNumber shillings.
const MONEY_FACTOR = 100;      // settings.kod:31, the shipped default
function moneyAt(level, factor = MONEY_FACTOR) {
  const lo = bound(tdiv(level, 2), 1, null);
  const hi = bound(tdiv(3 * level, 2), 1, null);
  return {
    min: 1 + tdiv(factor * 2 * Math.min(lo, hi), 100),
    max: 1 + tdiv(factor * 2 * Math.max(lo, hi), 100),
  };
}

// ---------------------------------------------------------------- main

const db = loadDB();
const TIDS = tidLines();
const TRES = 'kod/object/passive/trestype.kod';
const MON = 'kod/object/active/holder/nomoveon/battler/monster.kod';

// ---- which monsters route to which type, so money can be quoted in shillings.
const MOB_ONE_TREASURE = 0x00800;   // blakston.khd:1400
const monstersByTid = new Map();
for (const c of descendants(db, 'Monster')) {
  const tid = resolveVar(db, c, 'viTreasure_type');
  if (tid === null) continue;
  if (!monstersByTid.has(tid)) monstersByTid.set(tid, []);
  monstersByTid.get(tid).push({
    cls: c.name,
    name: nameOf(db, c) || humanize(c.name),
    level: resolveVar(db, c, 'viLevel'),
    oneItem: !!((resolveVar(db, c, 'viAttributes') || 0) & MOB_ONE_TREASURE),
  });
}

// ---- every concrete treasure type
const types = {};
const itemDroppedBy = {};
const problems = [];
const seenTid = new Map();

const typeClasses = descendants(db, 'TreasureType')
  .sort((a, b) => a.name.localeCompare(b.name));

for (const c of typeClasses) {
  const numProp = Object.entries(c.properties).find(([k]) => /^piTreasure_num$/i.test(k));
  if (!numProp) { problems.push(`${c.name} declares no piTreasure_num (${c.file})`); continue; }
  const tidName = String(numProp[1].expr).toUpperCase();
  const tidValue = numProp[1].value;
  if (!TIDS.has(tidName)) problems.push(`${c.name}: piTreasure_num = ${numProp[1].expr} is not a TID_ constant`);
  if (seenTid.has(tidName)) problems.push(`${tidName} is claimed by both ${seenTid.get(tidName)} and ${c.name}`);
  seenTid.set(tidName, c.name);

  // piDiff_seed / piItem_att_chance are properties, and they inherit from the
  // base class (both 0 there), so resolve them along the chain.
  const diffSeed = inherited(db, c, 'piDiff_seed', 'properties')?.value ?? 0;
  const attChance = inherited(db, c, 'piItem_att_chance', 'properties')?.value ?? 0;
  const diffLine = lineOf(c.file, /piDiff_seed\s*=/i);
  const attLine = lineOf(c.file, /piItem_att_chance\s*=/i);

  const { entries } = readTable(db, c);
  const norm = normalise(entries.map((e) => e.weight));
  const exact = exactChance(norm);

  const mobs = (monstersByTid.get(tidValue) || []).filter((m) => m.level !== null);
  const levels = mobs.map((m) => m.level);

  const items = entries.map((e, i) => {
    const target = cls(db, e.cls);
    if (!target) problems.push(`${c.name}: table names &${e.cls}, which is not a class`);
    const key = target ? target.name : e.cls;
    (itemDroppedBy[key] ||= []).push(tidName);
    return {
      cls: key,
      chancePercent: norm[i],           // the game's own normalised percent
      exactChancePercent: exact[i],     // what Random(0,100) actually delivers
      weight: e.weight,                 // as written in the source
      count: 1,                         // one Create() per winning roll
      cite: cite(c.file, e.line),
    };
  });

  // Money, if this table has any.  Money has no subclasses in the tree, so an
  // exact &Money entry is the only thing IsClass(oObj,&Money) can catch.
  const moneyIdx = entries.findIndex((e) => /^money$/i.test(e.cls));
  let money = null;
  if (moneyIdx >= 0) {
    const at = levels.length ? levels.map((l) => moneyAt(l)) : [moneyAt(1)];
    money = {
      min: Math.min(...at.map((x) => x.min)),
      max: Math.max(...at.map((x) => x.max)),
      levelRange: levels.length ? [Math.min(...levels), Math.max(...levels)] : null,
      chancePercent: norm[moneyIdx],
      formula: 'shillings = 1 + (MoneyFactor * 2 * bound(random(level/2, 3*level/2), 1, inf)) / 100'
        + `  [MoneyFactor = ${MONEY_FACTOR}]`,
      cite: cite(TRES, 302),
      notes: levels.length
        ? `min/max evaluated over viLevel ${Math.min(...levels)}..${Math.max(...levels)}, the levels of the `
          + `${levels.length} Monster subclass(es) that resolve to ${tidName}. level is the killed monster's viLevel (`
          + `${cite(MON, 4984)}); the +1 is Create(&Money)'s starting piNumber (kod/object/item/passitem/numbitem.kod:44).`
        : 'No Monster subclass resolves to this treasure type, so min/max are shown for level 1.',
    };
  }

  const oneItemMobs = (monstersByTid.get(tidValue) || []).filter((m) => m.oneItem).length;
  const notes = [];
  if (!entries.length) notes.push('Declares no plTreasure table: GenerateTreasure falls through and returns $.');
  if (diffSeed > 0) {
    notes.push(`Before the table is consulted, a player-killed monster has a `
      + `${attChance}/400 chance (MagicItemModifier 100) of an item-attributed item at difficulty seed `
      + `${diffSeed} instead (${cite(TRES, 270)}).`);
  } else {
    notes.push('piDiff_seed is 0, so this type never generates item-attributed ("magic") items.');
  }
  if (oneItemMobs) notes.push(`${oneItemMobs} monster(s) using this type carry MOB_ONE_TREASURE and roll exactly one item.`);

  types[tidName] = {
    value: tidValue,
    cite: cite('kod/include/blakston.khd', TIDS.get(tidName)?.line ?? null),
    class: c.name,
    classCite: cite(c.file, c.classLine),
    numCite: cite(c.file, numProp[1].line),
    diffSeed,
    diffSeedCite: diffSeed ? cite(c.file, diffLine) : null,
    itemAttChancePer400: attChance,
    itemAttChanceCite: attChance ? cite(c.file, attLine) : null,
    rawWeightTotal: entries.reduce((a, e) => a + e.weight, 0),
    money,
    items,
    monsters: (monstersByTid.get(tidValue) || []).map((m) => m.cls).sort(),
    notes: notes.join(' '),
  };
}

// TID_ constants that exist in blakston.khd but that no TreasureType claims.
for (const [name, info] of TIDS) {
  if (types[name]) continue;
  types[name] = {
    value: info.value,
    cite: cite('kod/include/blakston.khd', info.line),
    class: null, classCite: null, numCite: null,
    diffSeed: 0, diffSeedCite: null,
    itemAttChancePer400: 0, itemAttChanceCite: null,
    rawWeightTotal: 0,
    money: null,
    items: [],
    monsters: (monstersByTid.get(info.value) || []).map((m) => m.cls).sort(),
    notes: 'Constant is declared but no TreasureType class claims it, so FindTreasureByNum '
      + `returns $ and CreateTreasure bails with a debug line (${cite(MON, 4952)}). Dead constant.`,
  };
}

for (const k of Object.keys(itemDroppedBy)) {
  itemDroppedBy[k] = [...new Set(itemDroppedBy[k])].sort();
}

// ---------------------------------------------------------------- the rules

const ITEM_FACTOR = 100;   // settings.kod:34, the shipped default
const rules = {
  summary: [
    'A monster drops treasure only when it dies with an owner room and is neither an illusion nor summoned',
    `(${cite(MON, 4944)}). CreateTreasure picks how many items to roll: monsters flagged MOB_ONE_TREASURE roll`,
    `exactly one (${cite(MON, 4964)}); everyone else rolls 1 + viLevel/55 + random(0, viDifficulty/3), capped at 6,`,
    `then scaled by the server ItemFactor and floored at 1 (${cite(MON, 4973)}). Each of those rolls is one call to`,
    `GenerateTreasure (${cite(TRES, 223)}), which rolls the type's weighted table exactly once and returns one object;`,
    'the loop only advances when a roll returns an object, so a table that returns nil is retried forever.',
    'Money is NOT a separate roll and is not extra: &Money is an ordinary weighted row in the table, and when that row',
    `wins, the pile is sized from the dead monster's viLevel (${cite(TRES, 300)}).`,
    'Each type\'s weights are normalised to sum to 100 when the type object is constructed, with the integer-division',
    `shortfall added to the first row (${cite(TRES, 62)}); the raw numbers in the source are therefore relative weights,`,
    'not percentages, though most tables are already written to sum to 100.',
    `The roll itself is iRnd = Random(0,100) against a running total (${cite(TRES, 285)}) -- that is 101 equally likely`,
    'values against a 100-wide table, so the first row silently gains one extra outcome. chancePercent is the game\'s',
    'own normalised weight; exactChancePercent is the true probability, w/101 (and (w+1)/101 for the first row).',
    'Three things can pre-empt the table on any single roll: a game token, a newbie signet ring, and an',
    'item-attributed weapon -- see rules.preempt.',
    'Nothing scales the table itself by level or difficulty: level and difficulty change only HOW MANY items roll and',
    'HOW MUCH money a winning &Money row is worth. Which items exist is fixed per treasure type.',
  ].join(' '),
  formula: [
    'items rolled:',
    '  if (viAttributes & MOB_ONE_TREASURE)  n = 1',
    '  else  n = bound(1 + viLevel/55 + random(0, viDifficulty/3), nil, 6)',
    `        n = bound((ItemFactor * n)/100, 1, nil)          [ItemFactor = ${ITEM_FACTOR}]`,
    'per roll, in order:',
    '  1. token:  if a token game is running and the killer is an intriguing User and an open token exists,',
    '             random(1,100) <= 20 returns the token instead (TOKEN_GENERATION_CHANCE).',
    '  2. signet: if the killer is a non-PK newbie-eligible User in the default region,',
    '             random(1,100) <= 3 returns a newbie signet ring instead (GetSignetChance).',
    '  3. magic:  if piDiff_seed > 0 and the killer is a User,',
    '             random(1,400) <= (MagicItemModifier * piItem_att_chance)/100 returns an item-attributed item.',
    '             Its difficulty is bound(piDiff_seed +/- GetRandomDiffBonus, 1, 10); the bonus is 0 76% of the',
    '             time, +1 13%, +2 5%, +3 2%, +4 2%, +5 1%, and its sign is flipped 49% of the time.',
    '  4. table:  iRnd = random(0,100); walk plTreasure accumulating normalised weights; the first row whose',
    '             running total >= iRnd wins; Create(that class).',
    'weights, applied once when the type object is constructed:',
    '  adjust = sum(weights) or 100 if that is 0',
    '  w_i    = (w_i * 100) / adjust                 (integer division, truncating)',
    '  w_1   += 100 - sum(w_i)   when that sum fell short',
    'true probability of row i:  (w_1 + 1)/101 for the first row, w_i/101 for every other row',
    'money, only when the &Money row wins:',
    `  shillings = 1 + (MoneyFactor * 2 * bound(random(level/2, 3*level/2), 1, nil))/100   [MoneyFactor = ${MONEY_FACTOR}]`,
    '  level is the dead monster\'s viLevel; the leading 1 is Create(&Money)\'s starting piNumber.',
  ].join('\n'),
  cites: [
    cite(MON, 3108), cite(MON, 4938), cite(MON, 4944), cite(MON, 4962), cite(MON, 4964),
    cite(MON, 4973), cite(MON, 4975), cite(MON, 4982), cite(MON, 4984),
    cite(TRES, 33), cite(TRES, 45), cite(TRES, 62), cite(TRES, 69), cite(TRES, 101),
    cite(TRES, 176), cite(TRES, 223), cite(TRES, 228), cite(TRES, 246), cite(TRES, 270),
    cite(TRES, 284), cite(TRES, 285), cite(TRES, 289), cite(TRES, 300), cite(TRES, 302),
    'kod/util/system.kod:1201', 'kod/util/system.kod:1363',
    'kod/util/settings.kod:31', 'kod/util/settings.kod:34', 'kod/util/settings.kod:37',
    'kod/util/library.kod:743', 'kod/include/blakston.khd:1400', 'kod/include/blakston.khd:2339',
    'kod/object/item/passitem/numbitem.kod:44', 'kod/object/item/passitem/numbitem.kod:183',
    'blakserv/ccode.c:1911',
  ],
  preempt: [
    {
      what: 'game token', chance: 'random(1,100) <= 20', cite: cite(TRES, 228),
      constant: 'TOKEN_GENERATION_CHANCE = 20 (kod/include/blakston.khd:2339)',
      notes: 'Only while a token game is running, only for a User the game considers intriguing, and only if '
        + 'FindOpenToken finds a free token in the killer\'s room. Returns the token in place of a table roll; '
        + 'the monster\'s remaining rolls then run with tokengen = FALSE (' + cite(MON, 5004) + ').',
    },
    {
      what: 'newbie signet ring', chance: 'random(1,100) <= 3', cite: cite(TRES, 246),
      constant: 'piSignetChance = 3 (kod/util/library.kod:743)',
      notes: 'Killer must be a User, not PK-enabled, signet-eligible, and in RID_DEFAULT.',
    },
    {
      what: 'item-attributed ("magic") item', chance: 'random(1,400) <= (MagicItemModifier * piItem_att_chance)/100',
      cite: cite(TRES, 270),
      constant: 'MagicItemModifier = 100 (kod/util/settings.kod:37); piItem_att_chance is per treasure type',
      notes: 'Only when piDiff_seed > 0 and the killer is a User. The item class comes from SYS\'s per-difficulty '
        + 'ItemAtt list (kod/util/system.kod:5436), not from plTreasure, so it cannot be enumerated from the '
        + 'treasure tables.',
    },
  ],
  overrides: [
    { cls: 'Skeleton', cite: 'kod/object/active/holder/nomoveon/battler/monster/skel.kod:173',
      what: 'Drops a LongSword with hits set to GetHits/random(2,4) on top of its normal table roll, then propagates.' },
    { cls: 'OrcPitBossBody', cite: 'kod/object/active/holder/nomoveon/battler/monster/BossBody.kod:66',
      what: 'Drops an OrcPitBossHead on top of its normal table roll, then propagates.' },
    { cls: 'LivingStatue', cite: 'kod/object/active/holder/nomoveon/battler/monster/lvstatue.kod:1084',
      what: 'Soldiers only: random(0,100) = 59, i.e. 1 in 101, drops a Rose on top of the normal roll.' },
    { cls: 'FactionTroop', cite: 'kod/object/active/holder/nomoveon/battler/monster/troop.kod:1034',
      what: 'Does NOT propagate: ignores plTreasure entirely and instead drops each equipped item with a 20% '
          + 'chance (EQUIPMENT_DROP_PERCENT, troop.kod:33), never the shield.' },
    { cls: 'Zombie', cite: 'kod/object/active/holder/nomoveon/battler/monster/zombie.kod:63',
      what: 'Declares viTreasure_type (TID_ZOMBIE) and viLevel (55) as PROPERTIES rather than classvars, which '
          + 'blakcomp turns into a TAG_OVERRIDE redirect (blakcomp/actions.c:780). Its Constructor then sets '
          + 'viTreasure_type = TID_NONE and vbSummoned = TRUE when called with DropsTreasure = FALSE '
          + '(zombie.kod:85), so summoned zombies drop nothing.' },
    { cls: 'Avar / AvarShaman / AvarChieftain',
      cite: 'kod/object/active/holder/nomoveon/battler/monster/avar.kod:270',
      what: 'GetTreasureType returns TID_NONE while the monster stands in RID_KC3, so those spawns drop nothing.' },
  ],
  notDerivable: [
    'The contents of the item-attribute ("magic weapon") lists are built at runtime on SYS '
      + '(kod/util/system.kod:5436) and are not declared in any class, so which weapon a magic roll yields '
      + 'cannot be read out of the source tree.',
    'Server operators can change MoneyFactor, ItemFactor and MagicItemModifier at runtime '
      + '(kod/util/settings.kod:31-37); this file assumes the shipped defaults of 100. The Settings constructor '
      + 'also applies per-server overrides for server_num 101 and 102 (kod/util/settings.kod:170-188).',
    'Room-specific treasure such as the Marion crypt chest (kod/object/active/holder/room/monsroom/'
      + 'marcry3a.kod:1090) uses its own plTreasuresList and has nothing to do with the TID_ system.',
    'The per-type "monsters" list is every Monster subclass whose viTreasure_type resolves to that TID at '
      + 'compile time. It cannot account for spawns that change the value at runtime: Zombie\'s Constructor '
      + '(zombie.kod:85), the Avar family\'s RID_KC3 check (avar.kod:270), or any monster created with '
      + 'pbIllusion / vbSummoned set, all of which drop nothing (' + cite(MON, 4944) + ').',
    'Whether a given item class is reachable in play also depends on the monster actually spawning somewhere; '
      + 'this file says only what the tables contain, not what the world spawns.',
  ],
};

const payload = {
  builtFrom: { source: M59, generator: 'tools/extract-treasure.mjs', when: new Date().toISOString() },
  rules,
  types,
  itemDroppedBy,
  problems,
  counts: {
    tidConstants: TIDS.size,
    typesWithTables: Object.values(types).filter((t) => t.items.length).length,
    deadConstants: Object.values(types).filter((t) => !t.class).length,
    distinctItems: Object.keys(itemDroppedBy).length,
    tableRows: Object.values(types).reduce((a, t) => a + t.items.length, 0),
    monstersMapped: [...monstersByTid.values()].reduce((a, v) => a + v.length, 0),
  },
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(`  ${payload.counts.tidConstants} TID_ constants, `
  + `${payload.counts.typesWithTables} with tables, ${payload.counts.deadConstants} dead`);
console.log(`  ${payload.counts.tableRows} table rows, ${payload.counts.distinctItems} distinct item classes, `
  + `${payload.counts.monstersMapped} monsters mapped`);
if (problems.length) {
  console.log('  problems:');
  for (const p of problems) console.log('    - ' + p);
}
