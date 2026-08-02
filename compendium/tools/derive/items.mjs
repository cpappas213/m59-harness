// derive/items.mjs -- one page per item, plus the master item index.
//
// Every class descending from Item gets a page, including the letters and the
// junk: "what is this thing and is it worth carrying" is a real question, and
// the answer for most of the tree is "no", which is worth being able to look up.

import {
  esc, slugify, cleanText, humanize, cls, descendants, ivar, rvar, nameOf, descOf,
  findMessage, ownMessage, constNames, flagNames, parseConsPairs, parsePairList,
  iconFor, spriteGroups, factGrid, dataTable, tagList, kodSource, num, heroBlock,
} from '../lib.mjs';

export const meta = {
  id: 'items', title: 'Items', dir: 'items', order: 3, nav: true,
  blurb: 'Every object in the game: weight, bulk, value, durability and what it does.',
};

// kod/object/item/passitem/weapon.kod:29-40 — the whole of a weapon's base damage.
const WEAPON_DAMAGE = {
  0: { name: 'bludgeon', min: 4, max: 8, hitmod: 75, range: 2, disarm: -5, spell: 0 },
  1: { name: 'thrust', min: 3, max: 8, hitmod: 125, range: 3, disarm: 10, spell: -10 },
  2: { name: 'slash', min: 5, max: 11, hitmod: 0, range: 2, disarm: 0, spell: -15 },
};
const WEAPON_QUALITY = {
  0: { name: 'low', dmg: -1, hit: 0, range: 0 },
  1: { name: 'normal', dmg: 0, hit: 0, range: 0 },
  2: { name: 'high', dmg: +1, hit: 50, range: 0 },
  3: { name: 'nerudite', dmg: +1, hit: 25, range: 0 },
};
// Stroke.FindDamage multiplies by the stroke's viDamage_factor; a weapon with no
// override swings Slash, which is 80. kod/object/passive/skill/stroke/slash.kod:43
const DEFAULT_STROKE_FACTOR = 80;

// ---------------------------------------------------------------- taxonomy

// The `kind` facet, in priority order: the first rule that matches wins.  It is
// derived from the inheritance chain first (which is what the game actually
// branches on) and only falls back to viItem_type.
const KIND_RULES = [
  ['Ammo', 'ammunition'], ['RangedWeapon', 'weapon'], ['Bow', 'weapon'], ['Weapon', 'weapon'],
  ['Shield', 'shield'], ['Armor', 'armour'], ['Helmet', 'helmet'], ['FaceMask', 'mask'],
  ['Robe', 'clothing'], ['Shirt', 'clothing'], ['Pants', 'clothing'],
  ['Ring', 'jewellery'], ['Necklace', 'jewellery'], ['Totem', 'totem'],
  ['Potion', 'potion'], ['Wand', 'wand'], ['Scroll', 'scroll'], ['SpellItem', 'spell item'],
  ['Food', 'food'], ['Instrument', 'instrument'], ['FactionFlag', 'faction'],
  ['Offering', 'offering'], ['HeartStone', 'heartstone'], ['Key', 'key'],
  ['RoomKeyCopy', 'key'], ['Letter', 'letter'], ['InscriptionItem', 'letter'],
  ['Token', 'token'], ['MiniGame', 'game'], ['Healer', 'healer'],
  ['AttackModifier', 'attack modifier'], ['DefenseModifier', 'defence modifier'],
  ['NumberItem', 'stackable'], ['ActiveItem', 'active'],
];
const TYPE_KIND = {
  ITEMTYPE_REAGENT: 'reagent', ITEMTYPE_GEM: 'gem', ITEMTYPE_MONEY: 'money',
  ITEMTYPE_SCROLL: 'scroll', ITEMTYPE_POTION: 'potion', ITEMTYPE_WAND: 'wand',
  ITEMTYPE_FOOD: 'food', ITEMTYPE_AMMO: 'ammunition', ITEMTYPE_TOKEN: 'token',
  ITEMTYPE_GAME: 'game', ITEMTYPE_SUNDRY: 'sundry', ITEMTYPE_SPECIAL: 'special',
  ITEMTYPE_MASK: 'mask', ITEMTYPE_RING: 'jewellery', ITEMTYPE_NECKLACE: 'jewellery',
  ITEMTYPE_ARMOR: 'armour', ITEMTYPE_WEAPON: 'weapon',
};

function kindOf(db, c) {
  const chain = new Set(c.chain);
  for (const [anc, kind] of KIND_RULES) if (chain.has(anc)) return kind;
  const t = ivar(db, c, 'viItem_type');
  if (t) {
    for (const n of constNames(db, 'ITEMTYPE_', t)) if (TYPE_KIND[n]) return TYPE_KIND[n];
  }
  return 'sundry';
}

// ---------------------------------------------------------------- indices

// Which spells consume this item as a reagent.
function reagentIndex(db) {
  const by = new Map();
  for (const s of descendants(db, 'Spell')) {
    const m = ownMessage(s, 'ResetReagents') || findMessage(db, s, 'ResetReagents');
    if (!m) continue;
    for (const r of parseConsPairs(m.body)) {
      if (!by.has(r.cls.toLowerCase())) by.set(r.cls.toLowerCase(), []);
      by.get(r.cls.toLowerCase()).push({ spell: s, count: r.count });
    }
  }
  return by;
}

// Which merchants stock this item.  plFor_Sale's first element is a list of
// class references; the second and third are skill and spell numbers.
function vendorIndex(db) {
  const by = new Map();
  for (const c of descendants(db, 'Monster', { includeSelf: true })) {
    for (const m of c.messages) {
      const at = m.body.search(/plFor_sale/i);
      if (at < 0) continue;
      // Take only up to the first SKID_/SID_ token so we do not pull class
      // references out of the ability lists' surrounding code.
      const chunk = m.body.slice(at);
      for (const t of new Set(chunk.match(/&(\w+)/g) || [])) {
        const name = t.slice(1).toLowerCase();
        if (!by.has(name)) by.set(name, new Set());
        by.get(name).add(c.name);
      }
    }
  }
  return by;
}

// ---------------------------------------------------------------- derived

function weaponNumbers(db, c) {
  const type = ivar(db, c, 'viWeaponType');
  const quality = ivar(db, c, 'viWeaponQuality');
  const T = WEAPON_DAMAGE[type], Q = WEAPON_QUALITY[quality];
  if (!T || !Q) return null;
  const baseMin = T.min + Q.dmg, baseMax = T.max + Q.dmg;
  // Stroke.FindDamage: damage = base * factor / 100, then DamageFactors adds
  // (prof+1)*viMaxProficiencyDamage/100 and scales by might.
  const f = DEFAULT_STROKE_FACTOR;
  const swing = (base, prof, might) => {
    const d = Math.trunc((base * f) / 100);
    const profBonus = Math.trunc(((prof + 1) * 5) / 100);
    return Math.max(1, profBonus + Math.trunc(((100 + Math.min(Math.max(might - 25, 0), 40)) * d) / 100));
  };
  return {
    type, quality, T, Q, baseMin, baseMax,
    novice: [swing(baseMin, 0, 25), swing(baseMax, 0, 25)],
    veteran: [swing(baseMin, 99, 65), swing(baseMax, 99, 65)],
    hitmod: T.hitmod + Q.hit,
    range: T.range + Q.range,
    disarm: T.disarm, spellmod: T.spell,
  };
}

function resistanceRows(db, c) {
  const m = findMessage(db, c, 'GetResistanceModifiers');
  if (!m) return [];
  return parsePairList(m.body).map((p) => ({ type: p.a, pct: p.b }));
}

// Battler.AssessDamage order: every worn item's flat reduction first, then the
// typed resistance percentage.  kod/object/item/passitem/defmod.kod:100-124 and
// kod/object/active/holder/nomoveon/battler.kod:251-263.
function damageAfterArmour(raw, flatReduce, resistPct) {
  let d = raw;
  if (flatReduce) {
    // random(r/3, r), bounded to damage-1: report the expected value.
    const lo = Math.trunc(flatReduce / 3);
    const avg = (lo + flatReduce) / 2;
    d = d - Math.min(avg, d - 1);
  }
  if (resistPct > 0) d = (d * (100 - resistPct)) / 100;
  else if (resistPct < 0) d = (d * (-100 + resistPct)) / -100;
  return Math.max(1, d);
}

// ---------------------------------------------------------------- build

export function build({ db, images }) {
  const items = descendants(db, 'Item').sort((a, b) => a.name.localeCompare(b.name));
  const reagents = reagentIndex(db);
  const vendors = vendorIndex(db);

  const recs = items.map((c) => {
    const kind = kindOf(db, c);
    const useType = ivar(db, c, 'viUse_type');
    const itemType = ivar(db, c, 'viItem_type');
    return {
      c, kind,
      name: nameOf(db, c) || humanize(c.name),
      slug: slugify(c.name),
      desc: descOf(db, c),
      icon: iconFor(db, images, c),
      weight: ivar(db, c, 'viWeight'),
      bulk: ivar(db, c, 'viBulk'),
      value: ivar(db, c, 'viValue_average'),
      hitsMin: ivar(db, c, 'viHits_init_min'),
      hitsMax: ivar(db, c, 'viHits_init_max'),
      spellMod: ivar(db, c, 'viSpell_modifier'),
      rarity: ivar(db, c, 'viRarity'),
      useType, useNames: useType ? flagNames(db, 'ITEM_USE_', useType).map((f) => f.name) : [],
      itemType, typeNames: itemType ? flagNames(db, 'ITEMTYPE_', itemType).map((f) => f.name) : [],
      defenseBase: ivar(db, c, 'viDefense_base'),
      damageBase: ivar(db, c, 'viDamage_base'),
      resist: resistanceRows(db, c),
      weapon: c.chain.includes('Weapon') ? weaponNumbers(db, c) : null,
      attackType: ivar(db, c, 'piAttack_type') ?? (() => {
        const p = c.properties.piAttack_type || c.properties.piattack_type;
        return p ? p.value : null;
      })(),
      prof: ivar(db, c, 'viProficiency_needed'),
      usedBy: reagents.get(c.name.toLowerCase()) || [],
      soldBy: [...(vendors.get(c.name.toLowerCase()) || [])],
    };
  });

  // ------------------------------------------------------------- pages
  const pages = recs.map((r) => {
    const c = r.c;
    const tags = [
      { text: r.kind },
      ...r.useNames.map((n) => ({ text: n.replace('ITEM_USE_', '').toLowerCase() })),
      r.rarity ? { text: (constNames(db, 'ITEM_RARITY_GRADE_', r.rarity)[0] || '').replace('ITEM_RARITY_GRADE_', '').toLowerCase() } : null,
    ].filter(Boolean);

    let body = heroBlock({
      icon: r.icon, title: r.name, tags,
      lede: r.desc ? esc(r.desc) : null,
    });

    body += factGrid([
      ['Weight', num(r.weight)],
      ['Bulk', num(r.bulk)],
      ['Value', r.value === null ? '<span class="muted">—</span>' : `${r.value} sh`],
      ['Durability', r.hitsMin === null ? '<span class="muted">—</span>'
        : (r.hitsMin === r.hitsMax ? String(r.hitsMin) : `${r.hitsMin}–${r.hitsMax}`)],
      r.spellMod ? ['Spell penalty', `${r.spellMod}%`] : null,
      r.useNames.length ? ['Worn on', r.useNames.map((n) => n.replace('ITEM_USE_', '').toLowerCase()).join(', '), true] : null,
    ]);

    // ---- weapon
    if (r.weapon) {
      const w = r.weapon;
      body += `<h2>As a weapon</h2>`;
      body += `<div class="formula">base       = random(${w.T.min}, ${w.T.max})            % ${w.T.name} weapon
quality    ${w.Q.dmg >= 0 ? '+' : ''}${w.Q.dmg}                           % ${w.Q.name} quality
stroke     × ${DEFAULT_STROKE_FACTOR}/100                     % Slash stroke damage factor
might      × (100 + bound(might−25, 0, 40))/100
proficiency+ (proficiency + 1) × 5/100</div>`;
      body += `<p class="cite">kod/object/item/passitem/weapon.kod:241 <code class="k">GetBaseDamage</code> · kod/object/passive/skill/stroke.kod:201 <code class="k">FindDamage</code> · :332 <code class="k">DamageFactors</code></p>`;
      body += dataTable(
        [{ key: 'k', label: 'Wielder' }, { key: 'd', label: 'Damage per hit', num: true }, { key: 'n', label: '' }],
        [
          { k: 'novice — 0 proficiency, might 25', d: `${w.novice[0]}–${w.novice[1]}`, n: 'before the target’s armour' },
          { k: 'expert — 99 proficiency, might 65', d: `${w.veteran[0]}–${w.veteran[1]}`, n: 'before the target’s armour' },
        ], { sortable: false });
      const atk = r.attackType ? flagNames(db, 'ATCK_WEAP_', r.attackType).map((f) => f.name.replace('ATCK_WEAP_', '').toLowerCase()) : [];
      body += factGrid([
        ['Weapon type', w.T.name, true],
        ['Quality', w.Q.name, true],
        ['To-hit bonus', `+${w.hitmod}`],
        ['Reach', String(w.range)],
        ['Disarm', String(w.disarm)],
        ['Spell penalty', `${w.spellmod}%`],
        atk.length ? ['Damage type', atk.join(' + '), true] : null,
        r.prof !== null ? ['Proficiency', (constNames(db, 'SKID_', r.prof)[0] || '').replace('SKID_PROFICIENCY_', '').replace('SKID_', '').toLowerCase(), true] : null,
      ]);
      body += `<p>Damage type matters because armour resists by type. See
<a href="../guides/armor.html">Armour</a> for what each armour does to each type, and
<a href="../weapons/index.html">Weapons</a> to compare this against everything else.</p>`;
    }

    // ---- armour
    if (r.defenseBase !== null && (r.defenseBase !== 0 || r.damageBase !== 0 || r.resist.length)) {
      body += `<h2>As protection</h2>`;
      body += factGrid([
        ['Defence bonus', r.defenseBase === null ? '—' : String(r.defenseBase)],
        ['Flat reduction', r.damageBase ? `random(${Math.trunc(r.damageBase / 3)}, ${r.damageBase})` : '0', true],
      ]);
      if (r.defenseBase < 0) {
        body += `<div class="warn">This item's defence bonus is <strong>negative</strong>: wearing it
makes you <em>easier</em> to hit. The trade is that it absorbs damage when a hit lands. Heavy
armour in this game buys mitigation with accuracy, not on top of it.</div>`;
      }
      if (r.resist.length) {
        body += dataTable(
          [{ key: 't', label: 'Attack type' }, { key: 'p', label: 'Resistance', num: true },
           { key: 'd', label: 'A 20-point hit becomes', num: true }],
          r.resist.map((x) => ({
            t: `<code class="k">${esc(x.type)}</code>`,
            p: `${x.pct}%`, _p: x.pct,
            d: damageAfterArmour(20, r.damageBase || 0, x.pct).toFixed(1),
          })), { sortable: false });
        body += `<p class="cite">${esc(c.file)} <code class="k">GetResistanceModifiers</code> · applied by kod/object/active/holder/nomoveon/battler.kod:189 <code class="k">ResistanceCheck</code> and :251 <code class="k">GetDamageFromResistance</code></p>`;
        body += `<p>The "20-point hit" column assumes this is the only thing you are wearing and
uses the average of the flat reduction, which is rolled fresh every blow. Unarmoured, the same
hit costs you the full 20.</p>`;
      }
    }

    // ---- reagent use
    if (r.usedBy.length) {
      body += `<h2>Spells that consume it</h2><ul>` + r.usedBy
        .sort((a, b) => (nameOf(db, a.spell) || '').localeCompare(nameOf(db, b.spell) || ''))
        .map((u) => `<li><a href="../spells/${slugify(u.spell.name)}.html">${esc(nameOf(db, u.spell) || humanize(u.spell.name))}</a>${u.count > 1 ? ` — ${u.count} per cast` : ''}</li>`)
        .join('') + `</ul>`;
    }

    // ---- vendors
    if (r.soldBy.length) {
      body += `<h2>Where to buy it</h2><p>` + r.soldBy.map((v) => {
        const k = cls(db, v);
        return `<a href="../creatures/${slugify(v)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : v)}</a>`;
      }).join(', ') + `</p>`;
    }

    // ---- sprites
    const groups = spriteGroups(db, images, r.c);
    if (groups.length > 1) {
      const label = { 1: 'group 1', 2: 'group 2', 3: 'group 3' };
      const inv = ivar(db, c, 'viInventory_group'), gnd = ivar(db, c, 'viGround_group'), brk = ivar(db, c, 'viBroken_group');
      body += `<h2>Sprites</h2><div class="gallery">` + groups.map((g) => {
        const what = g.group === inv ? 'inventory' : g.group === gnd ? 'on the ground'
          : g.group === brk ? 'broken' : (label[g.group] || `group ${g.group}`);
        return `<figure><img class="icon" src="${g.src}" alt="${esc(r.name)} ${what}" loading="lazy"><figcaption>${esc(what)}</figcaption></figure>`;
      }).join('') + `</div>`;
    }

    body += `<hr>` + kodSource(db, c);

    return {
      slug: r.slug, title: r.name, html: body, kind: r.kind,
      desc: cleanText(r.desc || '').slice(0, 160),
      icon: r.icon ? r.icon.src.replace('../', '') : null,
    };
  });

  // ------------------------------------------------------------- index
  const kinds = [...new Set(recs.map((r) => r.kind))].sort();
  const columns = [
    { key: 'i', label: '' },
    { key: 'n', label: 'Item' },
    { key: 'k', label: 'Kind' },
    { key: 's', label: 'Slot' },
    { key: 'w', label: 'Weight', num: true },
    { key: 'b', label: 'Bulk', num: true },
    { key: 'v', label: 'Value', num: true },
    { key: 'h', label: 'Durability', num: true },
    { key: 'd', label: 'Notes' },
  ];
  const rows = recs.map((r) => ({
    _attrs: ` data-kind="${esc(r.kind)}"`,
    i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
    n: `<a href="${r.slug}.html">${esc(r.name)}</a>`,
    k: esc(r.kind), _k: r.kind,
    s: r.useNames.length ? esc(r.useNames.map((x) => x.replace('ITEM_USE_', '').toLowerCase()).join(', ')) : '<span class="muted">—</span>',
    w: num(r.weight), _w: r.weight ?? -1,
    b: num(r.bulk), _b: r.bulk ?? -1,
    v: num(r.value), _v: r.value ?? -1,
    h: r.hitsMin === null ? '<span class="muted">—</span>' : (r.hitsMin === r.hitsMax ? String(r.hitsMin) : `${r.hitsMin}–${r.hitsMax}`),
    _h: r.hitsMax ?? -1,
    d: r.weapon ? `${r.weapon.novice[0]}–${r.weapon.novice[1]} dmg`
      : r.resist.length ? esc(r.resist.map((x) => `${x.type.replace('ATCK_WEAP_', '').toLowerCase()} ${x.pct}%`).join(', '))
      : esc(cleanText(r.desc || '').slice(0, 90)),
  }));

  const indexHtml = `<h1>Items</h1>
<p class="lede">All ${recs.length} object classes in the game, from the plate armour to the
tax letters. Weight, bulk and value are declared per class and never sent to the client, so
this table is the only place the numbers exist outside the server.</p>

<h2>What the three numbers mean</h2>
<p><strong>Weight</strong> and <strong>bulk</strong> are separate limits and you can hit either
one first: weight is mass, bulk is how much room a thing takes up. A stack of ${recs.length ? '' : ''}coins is
heavy and compact; a shield is light and enormous. <strong>Value</strong> is the average price
the class is worth — merchants derive both their asking price and their offer from it, so an
item's value tells you what you will be charged and roughly a fraction of that when you sell.</p>
<p class="cite">kod/object/item.kod — <code class="k">viWeight</code>, <code class="k">viBulk</code>, <code class="k">viValue_average</code></p>
<p><strong>Durability</strong> is <code class="k">piHits</code>, rolled at creation between
<code class="k">viHits_init_min</code> and <code class="k">viHits_init_max</code>. Weapons lose
hits when they strike and armour when it is struck — a defence modifier takes wear on
50% of the blows it absorbs. At zero the item breaks and switches to its broken sprite.</p>
<p class="cite">kod/object/item/passitem/defmod.kod:15 <code class="k">DAMAGE_CHANCE = 50</code></p>

<div class="filterbar" data-for="itemtable">
  <input type="search" placeholder="filter…" aria-label="Filter items">
  <select data-filter="kind"><option value="">every kind</option>${
    kinds.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'itemtable' })}

<p>For the comparisons rather than the catalogue, see <a href="../weapons/index.html">Weapons</a>
and <a href="../armor/index.html">Armour</a>. For what an item is worth to a merchant, see
<a href="../guides/economy.html">Money and Merchants</a>.</p>`;

  return { indexHtml, pages };
}
