// derive/creatures.mjs -- one page per Monster subclass, plus the bestiary.
//
// "Monster" in this tree means everything that walks and can be talked to or
// killed, so the innkeeper and the ant are the same class of object.  The
// bestiary lists them all; derive/npcs.mjs re-cuts the same set by role.
//
// The combat numbers on these pages are derived, not looked up.  A monster has
// no attack table: its offence, defence, health and damage all fall out of
// viLevel and viDifficulty through four short functions in monster.kod, which
// this module reimplements exactly.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, esc, slugify, cleanText, humanize, cls, descendants, ivar, rvar, nameOf, descOf,
  findMessage, ownMessage, constNames, flagNames, constComment, constValue, parsePairList,
  iconFor, spriteGroups, factGrid, dataTable, tagList, kodSource, num, heroBlock,
} from '../lib.mjs';
import { matchup, monsterDamage } from '../calc.mjs';

// Two side tables, each produced by its own extractor and each optional: the
// site must still build from koddb.json alone.
function sideTable(name) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8')); }
  catch { return null; }
}

export const meta = {
  id: 'creatures', title: 'Bestiary', dir: 'creatures', order: 6, nav: true,
  blurb: 'Every creature and NPC: level, difficulty, damage, drops and where it stands.',
};

// ---------------------------------------------------------------- the maths
//
// kod/object/active/holder/nomoveon/battler/monster.kod
//   GetOffense  :1433   3*level + 60*difficulty, bounded 1..1500
//   GetDefense   :1455   the same expression
//   GetDamage    :1488   Fuzzy(level / random(10,15))
//   GetMaxHitPoints :4079   level, or level*120/100 once level >= 40
//   Fuzzy        :4263   n - n/4 + random(0, n/2)  — that is, 75%..125%
//   Constructor  :352    max hit points are themselves Fuzzy'd

const fuzzyLow = (n) => Math.trunc(n - Math.trunc(n / 4));
const fuzzyHigh = (n) => Math.trunc(n - Math.trunc(n / 4) + Math.trunc((n * 2) / 4));

function combatOf(level, difficulty) {
  if (level === null) return null;
  const d = difficulty || 0;
  const off = Math.min(1500, Math.max(1, 3 * level + 60 * d));
  const hpBase = level < 40 ? level : Math.trunc((120 * level) / 100);
  // damage = Fuzzy(level / random(10,15)); the divisor's range widens the spread
  const dmgHi = fuzzyHigh(Math.trunc(level / 10));
  const dmgLo = Math.max(1, fuzzyLow(Math.trunc(level / 15)));
  return {
    offense: off, defense: off,
    hp: [Math.max(1, fuzzyLow(hpBase)), fuzzyHigh(hpBase)],
    damage: [dmgLo, Math.max(1, dmgHi)],
    dodge: d * 10,
  };
}

// One reference character, used identically on every page so the numbers compare.
// A mid-game build: 130 max health, dodge 50, parry 40, no shield, agility 40,
// stroke 50, proficiency 50, aim 40.  player.kod:4227 and :4294.
const REF = {
  label: 'a mid-game character — 130 max health, dodge 50, parry 40, agility 40, stroke 50, proficiency 50, aim 40',
  defense: 40 * 2 + 0 + 50 * 3 + 40 * 4 + Math.trunc((130 * 3) / 2),
  offense: 50 * 3 + 50 * 2 + 40 * 4 + Math.trunc((130 * 3) / 2),
  maxHealth: 130,
};
const EQUAL_CHANCE_HIT = 55;   // battler.kod:19

// Monster's own defaults are viLevel = 25 and viDifficulty = 0
// (monster.kod:229-230), giving attack = defence = 3 x 25 + 60 x 0 = 75. That
// number is the line between a person and a monster: nothing in the game flags
// which is which, but everything meant to fight has been given more than the
// default, and everything meant to sell you a drink has not.
const PERSON_THRESHOLD = 75;
const hitChance = (off, def) => Math.min(95, Math.max(10, Math.trunc((off * EQUAL_CHANCE_HIT) / def)));

// ---------------------------------------------------------------- helpers

function abilitiesSold(db, c) {
  const spells = new Set(), skills = new Set(), items = new Set();
  for (const m of c.messages) {
    const at = m.body.search(/plFor_sale/i);
    if (at < 0) continue;
    const chunk = m.body.slice(at);
    for (const t of chunk.match(/\bSID_[A-Z0-9_]+/gi) || []) spells.add(t.toUpperCase());
    for (const t of chunk.match(/\bSKID_[A-Z0-9_]+/gi) || []) skills.add(t.toUpperCase());
    for (const t of chunk.match(/&(\w+)/g) || []) items.add(t.slice(1));
  }
  return { spells: [...spells], skills: [...skills], items: [...items] };
}

// SID_/SKID_ constant -> the class that declares that number.
function abilityIndex(db) {
  const spellBy = new Map(), skillBy = new Map();
  for (const s of descendants(db, 'Spell')) {
    const n = ivar(db, s, 'viSpell_num');
    if (n === null) continue;
    for (const name of constNames(db, 'SID_', n)) spellBy.set(name, s);
  }
  for (const s of descendants(db, 'Skill')) {
    const n = ivar(db, s, 'viSkill_num');
    if (n === null) continue;
    for (const name of constNames(db, 'SKID_', n)) skillBy.set(name, s);
  }
  return { spellBy, skillBy };
}

function flagTable(db, prefix, value, title) {
  const flags = flagNames(db, prefix, value);
  if (!flags.length) return '';
  return `<h3>${esc(title)}</h3>` + dataTable(
    [{ key: 'f', label: 'Flag' }, { key: 'd', label: 'What it means' }],
    flags.map((f) => ({
      f: `<code class="k">${esc(f.name)}</code>`,
      d: esc(constComment(f.name) || '—'),
    })), { sortable: false }) +
    `<p class="cite">kod/include/blakston.khd</p>`;
}

// ---------------------------------------------------------------- build

// ---------------------------------------------------------------- drops

// What a kill is actually worth, given the creature's level and difficulty.
// kod/object/active/holder/nomoveon/battler/monster.kod:4938 CreateTreasure.
function rollCount(level, difficulty, oneTreasure) {
  if (oneTreasure) return [1, 1];
  const base = 1 + Math.trunc((level || 0) / 55);
  const hi = Math.min(6, base + Math.trunc((difficulty || 0) / 3));
  return [Math.max(1, Math.min(6, base)), Math.max(1, hi)];
}

function dropsSection(db, T, tidName, r) {
  if (!T || !tidName || !T.types || !T.types[tidName]) return '';
  const t = T.types[tidName];
  if (!t.items || !t.items.length) return '';
  const [lo, hi] = rollCount(r.level, r.difficulty, !!(r.attrs & 0x800));

  let h = `<h2>What it drops</h2>`;
  h += `<div class="formula">rolls  = ${(r.attrs & 0x800)
    ? '1                                   % MOB_ONE_TREASURE'
    : `bound(1 + level/55 + random(0, difficulty/3), $, 6)
       = bound(1 + ${r.level}/55 + random(0, ${r.difficulty || 0}/3), $, 6)
       = ${lo}${hi > lo ? `–${hi}` : ''} item${hi > 1 ? 's' : ''}`}
each roll:  iRnd = random(0, 100); walk the table accumulating weights;
            the first row whose running total reaches iRnd is what you get</div>`;
  h += `<p class="cite">kod/object/active/holder/nomoveon/battler/monster.kod:4964, :4973 · kod/object/passive/trestype.kod:284 <code class="k">GenerateTreasure</code>${t.classCite ? ' · ' + esc(t.classCite) : ''}</p>`;

  const rows = t.items.map((it) => {
    const k = cls(db, it.cls);
    const isMoney = it.cls === 'Money';
    return {
      n: k && k.chain.includes('Item')
        ? `<a href="../items/${slugify(k.name)}.html">${esc(nameOf(db, k) || humanize(k.name))}</a>`
        : esc(humanize(it.cls)),
      _n: it.cls,
      p: `${(it.exactChancePercent ?? it.chancePercent ?? 0).toFixed(1)}%`,
      _p: it.exactChancePercent ?? it.chancePercent ?? 0,
      x: isMoney && t.money
        ? `${t.money.min}–${t.money.max} shillings`
        : (it.count > 1 ? `×${it.count}` : ''),
      c: it.cite ? `<code>${esc(it.cite.replace(/^kod\/object\/passive\/trestype\//, ''))}</code>` : '',
    };
  });
  h += dataTable(
    [{ key: 'n', label: 'Item' }, { key: 'p', label: 'Chance per roll', num: true },
     { key: 'x', label: 'Quantity' }, { key: 'c', label: 'Declared at' }],
    rows, { sortable: true });

  if (t.money) {
    h += `<div class="formula">shillings = 1 + (MoneyFactor × 2 × bound(random(level/2, 3×level/2), 1, ∞)) / 100
          = ${t.money.min}–${t.money.max} at level ${r.level}     % MoneyFactor = 100</div>
<p class="cite">${esc(t.money.cite || 'kod/object/passive/trestype.kod:302')}</p>`;
  }
  if (t.diffSeed > 0 && t.itemAttChancePer400) {
    h += `<div class="note">Before the table is consulted at all, a player who lands the kill has a
<strong>${t.itemAttChancePer400} in 400</strong> chance of getting an item-attributed — that is,
enchanted — item instead, generated at difficulty seed ${t.diffSeed}.
<span class="cite">${esc(t.itemAttChanceCite || 'kod/object/passive/trestype.kod:270')}</span></div>`;
  }
  h += `<div class="note">Two rolls happen before either of those on every kill: a
<strong>20%</strong> check for a game token, and a <strong>3%</strong> check for a newbie signet
ring if the killer qualifies. Nothing drops at all from an illusion or a summoned creature.
<span class="cite">kod/object/passive/trestype.kod:228, :246 · monster.kod:4944</span></div>`;
  return h;
}

// ---------------------------------------------------------------- places

// Where a creature is found, linked to the zone pages so the relation reads in
// both directions: a zone page lists its creatures, and every creature page
// lists its zones.
function placesSection(Z, className) {
  const sites = (Z && Z.byMonster && Z.byMonster[className]) || [];
  if (!sites.length) {
    return `<h2>Where to find it</h2>
<p>No room in the world declares this creature. It is summoned by another creature, placed by an
administrator, or left over from content that is no longer reachable.</p>`;
  }
  const total = {};
  for (const s of sites) {
    const r = Z.rooms[s.room];
    if (!r) continue;
    const key = s.room;
    if (!total[key]) total[key] = { room: r, how: new Set(), weight: null, at: null };
    total[key].how.add(s.how);
    if (s.weight != null) total[key].weight = s.weight;
    if (s.row != null) total[key].at = `row ${s.row}, col ${s.col}`;
  }
  const list = Object.values(total).sort((a, b) =>
    a.room.region.localeCompare(b.room.region) || a.room.name.localeCompare(b.room.name));

  const rows = list.map((t) => {
    const share = t.weight != null && t.room.monsters.length
      ? Math.round((t.weight * 100) / t.room.monsters.reduce((a, m) => a + m.weight, 0)) : null;
    return {
      r: `<a href="../zones/${t.room.slug}.html">${esc(t.room.disp || t.room.name)}</a>`, _r: t.room.name,
      g: esc(t.room.region), _g: t.room.region,
      h: esc([...t.how].join(', ')), _h: [...t.how][0],
      w: share != null ? `${share}%` : (t.at ? esc(t.at) : '<span class="muted">—</span>'),
      _w: share ?? -1,
      s: `<code>${esc(t.room.file.replace(/^kod\/object\/active\/holder\/room\//, ''))}</code>`,
    };
  });
  return `<h2>Where to find it</h2>
<p>${list.length} place${list.length === 1 ? '' : 's'} in the world put this creature into play.
<em>Share</em> is its weight in that room's spawn table — how often the generator picks it over
everything else there.</p>` +
    dataTable([{ key: 'r', label: 'Zone' }, { key: 'g', label: 'Region' },
               { key: 'h', label: 'How' }, { key: 'w', label: 'Share', num: true },
               { key: 's', label: 'Declared in' }], rows);
}

export function build({ db, images }) {
  const T = sideTable('treasure.json');
  const Z = sideTable('zones.json');
  const S = sideTable('spawns.json');
  const all = descendants(db, 'Monster', { includeSelf: false })
    .sort((a, b) => a.name.localeCompare(b.name));
  const { spellBy, skillBy } = abilityIndex(db);

  const recs = all.map((c) => {
    const level = ivar(db, c, 'viLevel');
    const difficulty = ivar(db, c, 'viDifficulty');
    const sold = abilitiesSold(db, c);
    const attrs = ivar(db, c, 'viAttributes') || 0;
    return {
      c, level, difficulty, sold, attrs,
      name: nameOf(db, c) || humanize(c.name),
      kocName: (rvar(db, c, 'vrKocName') || {}).value || null,
      slug: slugify(c.name),
      desc: descOf(db, c),
      icon: iconFor(db, images, c, { group: 1 }),
      deadIcon: iconFor(db, images, c, { group: 1, varName: 'vrDead_icon' }),
      karma: ivar(db, c, 'viKarma'),
      speed: ivar(db, c, 'viSpeed'),
      wimpy: ivar(db, c, 'viWimpy'),
      attackType: ivar(db, c, 'viAttack_type') || 0,
      attackSpell: ivar(db, c, 'viAttack_spell') || 0,
      treasure: ivar(db, c, 'viTreasure_type'),
      faction: ivar(db, c, 'viFaction'),
      behavior: ivar(db, c, 'viDefault_behavior') || 0,
      questID: ivar(db, c, 'viQuestID'),
      combat: combatOf(level, difficulty),
      isNPC: !!(attrs & 0x1) || (ivar(db, c, 'viDefault_behavior') || 0) === 0 && !!(attrs & 0x400),
      teaches: sold.spells.length + sold.skills.length > 0,
      sells: sold.items.length > 0,
    };
  });

  // ------------------------------------------------------------- pages
  const pages = recs.map((r) => {
    const c = r.c;
    const K = r.combat;
    const atk = flagNames(db, 'ATCK_WEAP_', r.attackType).map((f) => f.name.replace('ATCK_WEAP_', '').toLowerCase());
    const spellAtk = flagNames(db, 'ATCK_SPELL_', r.attackSpell).map((f) => f.name.replace('ATCK_SPELL_', '').toLowerCase());
    const treasureName = r.treasure === null ? null : (constNames(db, 'TID_', r.treasure)[0] || null);
    const factionName = r.faction === null ? null : (constNames(db, 'FACTION_', r.faction)[0] || null);
    const speedName = r.speed === null ? null : (constNames(db, 'SPEED_', r.speed)[0] || null);

    const tags = [
      r.level !== null ? { text: `Level ${r.level}` } : null,
      r.difficulty ? { text: `Difficulty ${r.difficulty}` } : null,
      r.karma ? { text: r.karma < 0 ? 'Evil' : 'Good' } : { text: 'Neutral' },
      r.teaches ? { text: 'Teacher' } : null,
      r.sells ? { text: 'Merchant' } : null,
    ].filter(Boolean);

    let body = heroBlock({
      icon: r.icon, title: r.name, tags,
      lede: r.desc ? esc(r.desc) : null,
    });

    body += factGrid([
      ['Level', num(r.level)],
      ['Difficulty', num(r.difficulty)],
      ['Health', K ? `${K.hp[0]}–${K.hp[1]}` : '<span class="muted">—</span>'],
      ['Damage per hit', K ? `${K.damage[0]}–${K.damage[1]}` : '<span class="muted">—</span>'],
      ['Karma', r.karma === null ? '<span class="muted">—</span>' : String(r.karma)],
      speedName ? ['Speed', speedName.replace('SPEED_', '').toLowerCase(), true] : null,
      treasureName ? ['Treasure', treasureName.replace('TID_', '').toLowerCase(), true] : null,
      factionName ? ['Faction', factionName.replace('FACTION_', '').toLowerCase(), true] : null,
    ]);

    if (r.kocName && r.kocName !== r.name) {
      body += `<p>Known to the Koc'atan as <em>${esc(r.kocName)}</em>.</p>`;
    }

    // ---- fighting it
    if (K) {
      body += `<h2>Fighting it</h2>`;
      body += `<div class="formula">offence = defence = 3 × level + 60 × difficulty
                = 3 × ${r.level} + 60 × ${r.difficulty || 0}
                = ${K.offense}

health          = Fuzzy(${r.level < 40 ? 'level' : 'level × 120/100'}) = ${K.hp[0]}–${K.hp[1]}
damage per hit  = Fuzzy(level / random(10,15))  = ${K.damage[0]}–${K.damage[1]}
dodge           = difficulty × 10 = ${K.dodge}</div>`;
      body += `<p class="cite">kod/object/active/holder/nomoveon/battler/monster.kod:1433 <code class="k">GetOffense</code> · :1455 <code class="k">GetDefense</code> · :1488 <code class="k">GetDamage</code> · :4079 <code class="k">GetMaxHitPoints</code> · :4263 <code class="k">Fuzzy</code></p>`;
      body += dataTable(
        [{ key: 'q', label: 'Against the reference character' }, { key: 'v', label: '', num: true }],
        [
          { q: 'Its chance to hit you', v: `${hitChance(K.offense, REF.defense)}%` },
          { q: 'Your chance to hit it', v: `${hitChance(REF.offense, K.defense)}%` },
          { q: 'Swings it needs to kill you', v: String(Math.ceil(REF.maxHealth / ((K.damage[0] + K.damage[1]) / 2))) },
          { q: 'Expected damage to you per swing it takes', v: ((K.damage[0] + K.damage[1]) / 2 * hitChance(K.offense, REF.defense) / 100).toFixed(1) },
        ], { sortable: false });
      body += `<p>The reference character is ${esc(REF.label)}, giving defence ${REF.defense} and
offence ${REF.offense}. Those are the same on every page in this bestiary, so the percentages
are directly comparable between creatures. Armour is not included — see
<a href="../guides/armor.html">Armour</a> for what it subtracts.</p>`;
      if (atk.length) {
        body += `<p>It attacks with <strong>${esc(atk.join(' + '))}</strong> damage`;
        body += spellAtk.length ? `, carrying <strong>${esc(spellAtk.join(' + '))}</strong> magic` : '';
        body += `. Armour resists by type, so what you wear against this creature matters more than
how much you wear.</p>`;
      }
    }

    // ---- drops and places
    body += dropsSection(db, T, treasureName, r);
    body += placesSection(Z, c.name);

    // ---- behaviour
    const behav = flagTable(db, 'AI_', r.behavior, 'How it behaves');
    const attrs = flagTable(db, 'MOB_', r.attrs, 'What it is');
    if (behav || attrs) body += `<h2>Behaviour</h2>` + behav + attrs;

    // ---- karma
    if (r.karma) {
      body += `<h2>What killing it does to your karma</h2>
<p>Its karma is <code class="k">${r.karma}</code>, and a kill is treated as an act whose karma is the
<em>negative</em> of the victim's — so killing this creature pushes you
${r.karma < 0 ? '<strong>towards good</strong>' : '<strong>towards evil</strong>'}.</p>
<div class="formula">base   = your_karma − (−victim_karma) = your_karma ${r.karma < 0 ? '−' : '+'} ${Math.abs(r.karma)}
change = −( base³ / 2500 + 5 × base ) / (11 − swing)      % hundredths of a karma point
       bounded to ±150 for a monster kill — at most 1.5 karma per kill</div>
<p class="cite">kod/object/active/holder/nomoveon/battler/player.kod:6491 <code class="k">CalculateKarmaChangeFromAct</code> · :6524 <code class="k">CalculateKarmaChangeFromKill</code></p>
<div class="note">No karma moves at all in the newbie region, in an arena, or when the victim's
karma is neutral. And once you are already further from neutral than your victim in the same
direction, killing them does nothing to you.</div>`;
    } else {
      body += `<h2>Karma</h2><p>Neutral. Killing it moves your karma not at all.</p>
<p class="cite">kod/object/active/holder/nomoveon/battler/player.kod:6551</p>`;
    }

    // ---- what it sells and teaches
    if (r.teaches || r.sells) {
      body += `<h2>What it offers</h2>`;
      if (r.sold.spells.length) {
        body += `<h3>Spells taught</h3><p>` + r.sold.spells.map((sid) => {
          const s = spellBy.get(sid);
          return s ? `<a href="../spells/${slugify(s.name)}.html">${esc(nameOf(db, s) || humanize(s.name))}</a>`
            : `<code class="k">${esc(sid)}</code>`;
        }).join(', ') + `</p>`;
      }
      if (r.sold.skills.length) {
        body += `<h3>Skills taught</h3><p>` + r.sold.skills.map((sid) => {
          const s = skillBy.get(sid);
          return s ? `<a href="../skills/${slugify(s.name)}.html">${esc(nameOf(db, s) || humanize(s.name))}</a>`
            : `<code class="k">${esc(sid)}</code>`;
        }).join(', ') + `</p>`;
      }
      if (r.sold.items.length) {
        const known = r.sold.items.map((n) => cls(db, n)).filter((k) => k && k.chain.includes('Item'));
        if (known.length) {
          body += `<h3>Goods sold</h3><p>` + known.map((k) =>
            `<a href="../items/${slugify(k.name)}.html">${esc(nameOf(db, k) || humanize(k.name))}</a>`).join(', ') + `</p>`;
        }
      }
      body += `<p class="cite">${esc(c.file)} — <code class="k">plFor_Sale</code>: element 1 goods, element 2 skills, element 3 spells (kod/object/active/holder/nomoveon/battler/monster.kod:2773, :2797)</p>`;
    }

    // ---- sprites
    const groups = spriteGroups(db, images, c);
    if (groups.length > 1 || r.deadIcon) {
      body += `<h2>Sprites</h2><div class="gallery">`;
      for (const g of groups) {
        body += `<figure><img class="icon" src="${g.src}" alt="${esc(r.name)} group ${g.group}" loading="lazy"><figcaption>group ${g.group}${g.angles > 1 ? ` · ${g.angles} angles` : ''}</figcaption></figure>`;
      }
      if (r.deadIcon) {
        body += `<figure><img class="icon" src="${r.deadIcon.src}" alt="${esc(r.name)} corpse" loading="lazy"><figcaption>corpse</figcaption></figure>`;
      }
      body += `</div>`;
    }

    body += `<hr>` + kodSource(db, c);

    return {
      slug: r.slug, title: r.name, html: body, kind: r.teaches || r.sells ? 'npc' : 'creature',
      desc: cleanText(r.desc || `Level ${r.level} creature.`).slice(0, 160),
      icon: r.icon ? r.icon.src.replace('../', '') : null,
    };
  });

  // ------------------------------------------------------------- index
  //
  // The index is a calculator, not a list. Every creature's row is computed
  // against a reference character the reader configures; the server renders one
  // default build so the page works without JavaScript, and assets/bestiary.js
  // recomputes in place when the reader picks a different one.

  const weapons = [];
  for (const c of descendants(db, 'Weapon')) {
    const type = ivar(db, c, 'viWeaponType');
    const quality = ivar(db, c, 'viWeaponQuality');
    if (type === null || quality === null) continue;
    if (c.name === 'RangedWeapon') continue;           // abstract base
    const prof = ivar(db, c, 'viProficiency_needed');
    weapons.push({
      cls: c.name, slug: slugify(c.name), name: nameOf(db, c) || humanize(c.name),
      type, quality,
      ranged: c.chain.includes('RangedWeapon') || c.chain.includes('Bow'),
      prof: prof === null ? null : (constNames(db, 'SKID_', prof)[0] || '')
        .replace('SKID_PROFICIENCY_', '').replace('SKID_', '').toLowerCase(),
      value: ivar(db, c, 'viValue_average'),
    });
  }
  weapons.sort((a, b) => a.name.localeCompare(b.name));

  // Defence modifiers, grouped by the equipment slot they occupy.
  const SLOTS = [
    { key: 'body', bit: 'ITEM_USE_BODY', label: 'Body' },
    { key: 'head', bit: 'ITEM_USE_HEAD', label: 'Head' },
    { key: 'hand', bit: 'ITEM_USE_HAND', label: 'Shield' },
    { key: 'legs', bit: 'ITEM_USE_LEGS', label: 'Legs' },
    { key: 'shirt', bit: 'ITEM_USE_SHIRT', label: 'Shirt' },
  ];
  const armour = {};
  for (const s of SLOTS) armour[s.key] = [];
  for (const c of descendants(db, 'DefenseModifier')) {
    const defB = ivar(db, c, 'viDefense_base') || 0;
    const redB = ivar(db, c, 'viDamage_base') || 0;
    const m = findMessage(db, c, 'GetResistanceModifiers');
    const resist = {};
    if (m) {
      for (const p of parsePairList(m.body)) {
        const bit = constValue(db, p.a);
        if (bit) resist[bit] = p.b;
      }
    }
    if (!defB && !redB && !Object.keys(resist).length) continue;
    const use = ivar(db, c, 'viUse_type') || 0;
    const entry = {
      cls: c.name, slug: slugify(c.name), name: nameOf(db, c) || humanize(c.name),
      defenseBonus: defB, damageReduce: redB, resist,
      isShield: c.chain.includes('Shield'),
      value: ivar(db, c, 'viValue_average'),
    };
    for (const s of SLOTS) {
      const bit = constValue(db, s.bit);
      if (bit && (use & bit)) armour[s.key].push(entry);
    }
  }
  for (const s of SLOTS) {
    armour[s.key].sort((a, b) => (b.defenseBonus + b.damageReduce * 10) - (a.defenseBonus + a.damageReduce * 10)
      || a.name.localeCompare(b.name));
  }

  // Five builds spanning the whole range a character can occupy. The two ends
  // are fixed points: a fresh character with a mace and no armour, and a maxed
  // one with a scimitar. The three between them interpolate.
  const PRESETS = [
    { id: 'newbie', name: 'Newbie', maxHealth: 30, stat: 10, skill: 20,
      weapon: 'Mace', gear: {} },
    { id: 'apprentice', name: 'Apprentice', maxHealth: 60, stat: 20, skill: 40,
      weapon: 'ShortSword', gear: { body: 'LeatherArmor', hand: 'MetalShield' } },
    { id: 'journeyman', name: 'Journeyman', maxHealth: 100, stat: 30, skill: 60,
      weapon: 'LongSword', gear: { body: 'ChainArmor', hand: 'GoldShield', head: 'SimpleHelm' } },
    { id: 'veteran', name: 'Veteran', maxHealth: 130, stat: 40, skill: 80,
      weapon: 'Axe', gear: { body: 'ScaleArmor', hand: 'Knightshield', head: 'SimpleHelm', legs: 'Pants', shirt: 'Shirt' } },
    { id: 'maxed', name: 'Maxed', maxHealth: 151, stat: 50, skill: 99,
      weapon: 'Scimitar', gear: { body: 'PlateArmor', hand: 'GuildShield', head: 'Helm', legs: 'Pants', shirt: 'RoyalShirt' } },
  ].map((p) => ({
    ...p, builtin: true,
    stats: { might: p.stat, agility: p.stat, stamina: p.stat, intellect: p.stat, mysticism: p.stat, aim: p.stat },
    skills: { stroke: p.skill, proficiency: p.skill, parry: p.skill, block: p.skill, dodge: p.skill },
  }));

  const byCls = (list, cls) => list.find((x) => x.cls === cls) || null;
  function resolve(ref) {
    const weapon = ref.weapon ? byCls(weapons, ref.weapon) : null;
    const worn = [];
    for (const s of SLOTS) {
      const cls2 = ref.gear && ref.gear[s.key];
      if (!cls2) continue;
      const it = byCls(armour[s.key], cls2);
      if (it) worn.push(it);
    }
    return { weapon, worn };
  }

  // ---- the creature records the client recomputes against
  const beasts = recs.filter((r) => r.combat).map((r) => {
    const atk = flagNames(db, 'ATCK_WEAP_', r.attackType).map((f) => f.name.replace('ATCK_WEAP_', '').toLowerCase());
    const tid = r.treasure === null ? null : (constNames(db, 'TID_', r.treasure)[0] || null);
    const fac = r.faction === null ? null : (constNames(db, 'FACTION_', r.faction)[0] || null);
    const spd = r.speed === null ? null : (constNames(db, 'SPEED_', r.speed)[0] || null);
    const zsites = (Z && Z.byMonster && Z.byMonster[r.c.name]) || [];
    const where = [...new Set(zsites.map((s) => s.room))]
      .map((k) => (Z.rooms[k] ? { slug: Z.rooms[k].slug, name: Z.rooms[k].disp || Z.rooms[k].name } : null))
      .filter(Boolean);
    return {
      slug: r.slug, name: r.name, icon: r.icon ? r.icon.src : null,
      level: r.level || 0, difficulty: r.difficulty || 0,
      atype: r.attackType || 0, aspell: r.attackSpell || 0,
      atk: atk.join(', '), karma: r.karma ?? 0,
      speed: spd ? spd.replace('SPEED_', '').toLowerCase() : '',
      treasure: tid ? tid.replace('TID_', '').toLowerCase() : '',
      faction: fac ? fac.replace('FACTION_', '').toLowerCase() : '',
      // People and monsters are told apart by their combat statistics, because
      // the game has no flag for it. Monster's own defaults are viLevel 25 and
      // viDifficulty 0, which give attack = defence = 3×25 + 60×0 = exactly 75.
      // Every shopkeeper, guard and townsperson is left at that value; anything
      // meant to fight has been given more.
      role: r.teaches && r.sells ? 'merchant + teacher'
        : r.teaches ? 'teacher'
        : r.sells ? 'merchant'
        : (r.combat.offense > PERSON_THRESHOLD ? 'monster' : 'person'),
      where: where.map((w) => w.name), whereLinks: where,
      koc: r.kocName && r.kocName !== r.name ? r.kocName : '',
    };
  });

  // ---- columns.  `calc` columns are the ones that change with the reference
  // character; everything else is a property of the creature.
  const COLUMNS = [
    { key: 'i', label: '', fixed: true, def: true },
    { key: 'n', label: 'Creature', fixed: true, def: true },
    { key: 'lvl', label: 'Lvl', num: true, def: true },
    { key: 'diff', label: 'Diff', num: true, def: true },
    { key: 'atk', label: 'Attack', num: true, def: true },
    { key: 'def', label: 'Defence', num: true, def: true },
    { key: 'hp', label: 'Health', num: true, def: true },
    { key: 'dmg', label: 'Its damage', num: true, def: true },
    { key: 'youhit', label: 'You hit', num: true, def: true, calc: true },
    { key: 'hitsyou', label: 'Hits you', num: true, def: true, calc: true },
    { key: 'yourdmg', label: 'Your damage', num: true, calc: true },
    { key: 'dmgtoyou', label: 'Damage to you', num: true, def: true, calc: true },
    { key: 'ttk', label: 'Swings to kill', num: true, def: true, calc: true },
    { key: 'tts', label: 'Swings to die', num: true, def: true, calc: true },
    { key: 'verdict', label: 'Outcome', def: true, calc: true },
    { key: 'karma', label: 'Karma', num: true },
    { key: 'atype', label: 'Attack type' },
    { key: 'treasure', label: 'Treasure' },
    { key: 'where', label: 'Where found', def: true },
    { key: 'role', label: 'Role' },
    { key: 'speed', label: 'Speed' },
    { key: 'faction', label: 'Faction' },
    { key: 'koc', label: 'Koc’atan name' },
  ];

  // ---- server-side render, using the middle preset
  const defaultRef = PRESETS[2];
  const { weapon: dW, worn: dWorn } = resolve(defaultRef);
  const fmt1 = (v) => (isFinite(v) ? (v >= 100 ? Math.round(v) : v.toFixed(1)) : '∞');

  const rows = beasts.map((b) => {
    const m = matchup(defaultRef, dW, dWorn, b);
    const cells = {
      i: b.icon ? `<img class="icon rowicon" src="${b.icon}" alt="" loading="lazy">` : '',
      n: `<a href="${b.slug}.html">${esc(b.name)}</a>`, _n: b.name,
      lvl: String(b.level), _lvl: b.level,
      diff: String(b.difficulty), _diff: b.difficulty,
      atk: String(m.mOff), _atk: m.mOff,
      def: String(m.mDef), _def: m.mDef,
      hp: `${m.mHp[0]}–${m.mHp[1]}`, _hp: m.mHpAvg,
      dmg: `${monsterDamage(b.level)[0]}–${monsterDamage(b.level)[1]}`, _dmg: monsterDamage(b.level)[1],
      youhit: `${m.youHit}%`, _youhit: m.youHit,
      hitsyou: `${m.hitsYou}%`, _hitsyou: m.hitsYou,
      yourdmg: `${m.pDmg[0]}–${m.pDmg[1]}`, _yourdmg: m.pAvg,
      dmgtoyou: `${fmt1(m.mDmg[0])}–${fmt1(m.mDmg[1])}`, _dmgtoyou: m.mAvg,
      ttk: fmt1(m.toKill), _ttk: isFinite(m.toKill) ? m.toKill : 1e9,
      tts: fmt1(m.toDie), _tts: isFinite(m.toDie) ? m.toDie : 1e9,
      verdict: `<span class="verdict v-${m.verdict.key}">${esc(m.verdict.label)}</span>`, _verdict: m.margin,
      karma: b.karma ? String(b.karma) : '<span class="muted">—</span>', _karma: b.karma,
      atype: esc(b.atk) || '<span class="muted">—</span>',
      treasure: b.treasure ? esc(b.treasure) : '<span class="muted">—</span>',
      where: b.whereLinks && b.whereLinks.length
        ? b.whereLinks.slice(0, 2).map((w) => `<a href="../zones/${w.slug}.html">${esc(w.name)}</a>`).join('; ')
          + (b.whereLinks.length > 2 ? ` <span class="muted">+${b.whereLinks.length - 2}</span>` : '')
        : '<span class="muted">nowhere</span>',
      _where: b.where.length ? b.where[0] : 'zzz',
      role: esc(b.role), _role: b.role,
      speed: esc(b.speed) || '<span class="muted">—</span>',
      faction: esc(b.faction) || '<span class="muted">—</span>',
      koc: b.koc ? `<em>${esc(b.koc)}</em>` : '<span class="muted">—</span>',
      _attrs: ` data-slug="${b.slug}" data-role="${b.role}" data-found="${b.where.length ? 'yes' : 'no'}"`,
    };
    return cells;
  });

  const th = COLUMNS.map((c) => `<th class="${c.num ? 'num ' : ''}sortable" data-col="${c.key}"${c.def ? '' : ' hidden'}>${esc(c.label)}</th>`).join('');
  const tb = rows.map((r) => '<tr' + (r._attrs || '') + '>' + COLUMNS.map((c) => {
    const sort = r['_' + c.key];
    return `<td class="${c.num ? 'num ' : ''}" data-col="${c.key}"${c.def ? '' : ' hidden'}${sort !== undefined ? ` data-sort="${esc(sort)}"` : ''}>${r[c.key] ?? ''}</td>`;
  }).join('') + '</tr>').join('\n');

  const opt = (list, sel, none) =>
    `<option value="">${esc(none)}</option>` + list.map((x) =>
      `<option value="${esc(x.cls)}"${x.cls === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  const indexHtml = `<h1>Bestiary</h1>
<p class="lede">${beasts.length} creatures, every one of them measured against <em>your</em>
character rather than an average one. A creature has no statistics table in the source: its
attack, defence, health and damage all fall out of two numbers, so the table below can be
computed exactly — and recomputed for any build you describe.</p>

<h2>Reference character</h2>
<p>Pick a preset or build your own. The five presets span the range a character can occupy, from
a fresh one with a mace and no armour to a maxed one with a scimitar. Anything you change can be
saved; saved builds live in this browser and go nowhere else.</p>

<div id="refchar" class="refchar" data-mode="detailed">
  <div class="refhead">
    <button type="button" id="refCollapse" class="iconbtn" aria-expanded="true"
            title="Collapse or expand">&#9662;</button>
    <strong class="refttl">Reference character</strong>
    <select id="refPreset" aria-label="Saved build">${PRESETS.map((p, i) =>
      `<option value="${p.id}"${i === 2 ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <span class="seg" role="group" aria-label="Input mode">
      <button type="button" id="modeDetailed" class="segbtn on">Detailed</button
      ><button type="button" id="modeSimple" class="segbtn">Simple</button>
    </span>
    <button type="button" id="refGo" class="btn primary">Generate</button>
    <span class="refspacer"></span>
    <button type="button" id="refPop" class="btn" title="Keep this panel on screen while you scroll">Pop out</button>
  </div>

  <div class="refbody" id="refBody">
    <div class="refrow">
      <label>Save as
        <input type="text" id="refName" placeholder="my fighter" maxlength="32" autocomplete="off">
      </label>
      <button type="button" id="refClone" class="btn">Save as new</button>
      <button type="button" id="refSave" class="btn">Update</button>
      <button type="button" id="refDelete" class="btn">Delete</button>
      <button type="button" id="refReset" class="btn">Reset</button>
      <span id="refMsg" class="refmsg" role="status"></span>
    </div>

    <div class="refgrid" id="gridSimple" hidden>
      <fieldset><legend>Straight from your status screen</legend>
        <label>Offence <input type="number" id="d_off" min="1" max="1000" value="695"></label>
        <label>Defence <input type="number" id="d_def" min="1" max="1000" value="610"></label>
        <label>Damage low <input type="number" id="d_dlo" min="1" max="200" value="5"></label>
        <label>Damage high <input type="number" id="d_dhi" min="1" max="200" value="9"></label>
        <label>Max health <input type="number" id="d_hp" min="1" max="300" value="100"></label>
      </fieldset>
      <fieldset class="wide"><legend>What simple mode does not know</legend>
        <p class="fsnote">Offence, defence and damage already contain your attributes, skills and
        weapon — but not your armour's <em>flat damage reduction</em> or its <em>typed
        resistances</em>, because no single number carries those. So <strong>Damage to you</strong>
        and <strong>Swings to die</strong> are shown before armour mitigation, and are pessimistic
        by however much your armour absorbs. Switch to Detailed to model it.</p>
      </fieldset>
    </div>

    <div class="refgrid" id="gridDetailed">
      <fieldset><legend>Vitals</legend>
        <label>Max health <input type="number" id="rMaxHealth" min="1" max="300" value="${defaultRef.maxHealth}"></label>
      </fieldset>
      <fieldset><legend>Attributes</legend>
        ${['might', 'agility', 'stamina', 'intellect', 'mysticism', 'aim'].map((k) =>
          `<label>${k[0].toUpperCase() + k.slice(1)} <input type="number" id="s_${k}" min="1" max="50" value="${defaultRef.stats[k]}"></label>`).join('')}
      </fieldset>
      <fieldset><legend>Skills</legend>
        ${[['stroke', 'Stroke'], ['proficiency', 'Proficiency'], ['parry', 'Parry'], ['block', 'Block'], ['dodge', 'Dodge']].map(([k, l]) =>
          `<label>${l} <input type="number" id="k_${k}" min="0" max="99" value="${defaultRef.skills[k]}"></label>`).join('')}
      </fieldset>
      <fieldset><legend>Equipment</legend>
        <label>Weapon <select id="g_weapon">${opt(weapons, defaultRef.weapon, 'unarmed')}</select></label>
        ${SLOTS.map((s) =>
          `<label>${s.label} <select id="g_${s.key}">${opt(armour[s.key], defaultRef.gear[s.key], 'none')}</select></label>`).join('')}
      </fieldset>
    </div>
  </div>
  <div id="refSummary" class="refsummary"></div>
</div>

<div class="note">Both sides swing about once a second, so <strong>swings read as seconds</strong>.
<em>Swings to kill</em> and <em>swings to die</em> already account for missing: they are
<code class="k">health ÷ (average damage × hit chance)</code>. The damage columns are before any
enchantment; armour is applied to what the creature does to you, and nothing is applied to what
you do to it, because <strong>no creature in the game declares a resistance</strong> — only worn
items and resist spells do.</div>
<p class="cite">verified: no <code class="k">Monster</code> subclass calls <code class="k">AddResistance</code>; the only callers are kod/object/item/passitem/defmod.kod, ring/resring.kod and spell/persench/resist.kod</p>

<h2>How the numbers are reached</h2>
<div class="formula">creature:  attack = defence = 3 × level + 60 × difficulty        bounded 1…1500
           health  = Fuzzy(level)  or  Fuzzy(level × 120/100) at level ≥ 40
           damage  = Fuzzy(level / random(10,15))
           Fuzzy(n) = n − n/4 + random(0, n/2)

you:       offence = stroke×3 + proficiency×2 + aim×4 + max_health×3/2 + weapon to-hit
           defence = parry×2 + block×1 + dodge×3 + agility×4 + max_health×3/2 + armour
                     parry counts only with a weapon in hand, block only with a shield
           damage  = ((weapon base + quality) × 80/100) × (100 + bound(might−25,0,40))/100
                     + (proficiency + 1) × 5/100

either:    chance to hit = bound(attacker offence × 55 / defender defence, 10, 95) %</div>
<p class="cite">kod/object/active/holder/nomoveon/battler/monster.kod:1433, :1488, :4079, :4263 · kod/object/active/holder/nomoveon/battler/player.kod:4227, :4294 · kod/object/active/holder/nomoveon/battler.kod:19, :330 · kod/object/item/passitem/weapon.kod:184, :241 · kod/object/passive/skill/stroke.kod:201, :332</p>

<h2>Columns</h2>
<details class="colcfg" id="colcfg">
  <summary>Choose and reorder columns</summary>
  <p>Drag with the arrows to reorder, uncheck to hide. Your layout is remembered in this browser.</p>
  <ul id="colList" class="collist"></ul>
  <button type="button" class="btn" id="colReset">Restore defaults</button>
</details>

<p>The table opens on <strong>monsters that actually spawn somewhere</strong> — the things you
would go out to fight. Widen the two dropdowns to see shopkeepers, guards, and the creatures no
room places.</p>

<div class="filterbar" data-for="beasttable">
  <input type="search" placeholder="filter…" aria-label="Filter creatures">
  <select data-filter="role"><option value="">everyone</option><option selected>monster</option><option>person</option><option>merchant</option><option>teacher</option><option>merchant + teacher</option></select>
  <select data-filter="found"><option value="">anywhere</option><option value="yes" selected>has a spawn site</option><option value="no">spawns nowhere</option></select>
  <span class="count"></span>
</div>
<div class="tablewrap"><table class="data" id="beasttable">
<thead><tr>${th}</tr></thead>
<tbody>${tb}</tbody></table></div>

<h2>Level and difficulty are not the same thing</h2>
<p><strong>Level</strong> sets how much health a creature has and how hard it hits.
<strong>Difficulty</strong> sets how hard it is to hit and to be hit by — and it is weighted
twenty times more heavily than level in that calculation. A level-100 creature at difficulty 0
is a sack of health that swings hard and is easy to hit; a level-40 creature at difficulty 5 is a
wall. Sort by <em>You hit</em> to see which is which.</p>

<h2>People and monsters</h2>
<p>The game has no flag that says which is which. What it has is a default:
<code class="k">Monster</code> declares <code class="k">viLevel = 25</code> and
<code class="k">viDifficulty = 0</code>, which give attack and defence of exactly
<strong>3 × 25 + 60 × 0 = 75</strong>. Every shopkeeper, guard, councillor and urchin in the
world has been left at that number, and everything meant to fight has been given more. So the
split in the <em>Role</em> column is drawn there:</p>
<div class="formula">attack &gt; 75  ->  monster
attack = 75  ->  person   (the class default, untouched)</div>
<p class="cite">kod/object/active/holder/nomoveon/battler/monster.kod:229-230 <code class="k">viLevel</code>, <code class="k">viDifficulty</code> · :1433 <code class="k">GetOffense</code></p>
<p>Merchants and teachers are broken out separately because what they sell matters more than
what they are; all of them also sit at exactly 75. One entry falls <em>below</em> the line — the
orc pit boss's corpse, at 63 — and is filed with the people, being a body rather than a
combatant.</p>

<h2>What should I be fighting?</h2>
<p>Health only grows from killing things <strong>above your own level</strong> that actually
damaged you, so the useful target is the hardest creature you can still beat — not the safest.
Set your real build above, press <em>Generate</em>, then sort by <em>Swings to die</em> and work
down until the outcome column stops saying you win.</p>
<p class="cite">kod/object/active/holder/nomoveon/battler/player.kod:7736 <code class="k">AdvancementCheck</code> — see <a href="../guides/advancing.html">Advancing Your Character</a></p>

<p>For the people rather than the monsters, see <a href="../npcs/index.html">NPCs</a>. For what
the weapons and armour in the picker actually do, see <a href="../weapons/index.html">Weapons</a>
and <a href="../armor/index.html">Armour</a>.</p>`;

  // ---- the data and the shared arithmetic, for the browser
  const calcSrc = fs.readFileSync(path.join(ROOT, 'tools', 'calc.mjs'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '');
  const browserCalc = `// GENERATED from tools/calc.mjs by tools/derive/creatures.mjs — do not edit.\n` +
    `(function(){\n${calcSrc}\nwindow.M59Calc={bound,monsterOffense,monsterHealth,monsterDamage,` +
    `playerOffense,playerDefense,playerDamage,hitChance,damageToPlayer,matchup,effective,verdictOf,` +
    `WEAPON_TYPE,WEAPON_QUALITY};\n})();\n`;

  return {
    indexHtml,
    pages,
    // calc.js is generated below from tools/calc.mjs; bestiary.js drives the UI.
    scripts: ['calc.js', 'bestiary.js'],
    files: {
      'assets/calc.js': browserCalc,
      'creatures.json': JSON.stringify({
        columns: COLUMNS, slots: SLOTS, presets: PRESETS,
        weapons, armour, beasts,
      }),
    },
  };
}
