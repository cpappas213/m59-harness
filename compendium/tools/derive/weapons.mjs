// derive/weapons.mjs -- index only.  The comparison table, not the catalogue;
// the per-weapon pages live in items/ because a weapon is an item and links
// should not have to know which.

import {
  esc, slugify, cleanText, humanize, cls, descendants, ivar, nameOf, descOf,
  findMessage, ownMessage, constNames, flagNames, iconFor, dataTable, num,
} from '../lib.mjs';

export const meta = {
  id: 'weapons', title: 'Weapons', dir: 'weapons', order: 4, nav: true,
  blurb: 'Every weapon side by side: damage, reach, proficiency and price.',
};

// kod/object/item/passitem/weapon.kod:29-52
const TYPE = {
  0: { name: 'bludgeon', min: 4, max: 8, hit: 75, range: 2, disarm: -5, spell: 0 },
  1: { name: 'thrust', min: 3, max: 8, hit: 125, range: 3, disarm: 10, spell: -10 },
  2: { name: 'slash', min: 5, max: 11, hit: 0, range: 2, disarm: 0, spell: -15 },
};
const QUALITY = {
  0: { name: 'low', dmg: -1, hit: 0 },
  1: { name: 'normal', dmg: 0, hit: 0 },
  2: { name: 'high', dmg: 1, hit: 50 },
  3: { name: 'nerudite', dmg: 1, hit: 25 },
};
const STROKE_FACTOR = 80;   // Slash, the default stroke — stroke/slash.kod:43

const swing = (base, prof, might) => {
  const d = Math.trunc((base * STROKE_FACTOR) / 100);
  return Math.max(1, Math.trunc(((prof + 1) * 5) / 100)
    + Math.trunc(((100 + Math.min(Math.max(might - 25, 0), 40)) * d) / 100));
};

export function build({ db, images }) {
  const weapons = descendants(db, 'Weapon').sort((a, b) => a.name.localeCompare(b.name));

  const rows = [];
  for (const c of weapons) {
    const t = ivar(db, c, 'viWeaponType'), q = ivar(db, c, 'viWeaponQuality');
    const T = TYPE[t], Q = QUALITY[q];
    if (!T || !Q) continue;
    const icon = iconFor(db, images, c);
    const prof = ivar(db, c, 'viProficiency_needed');
    const profName = prof === null ? null
      : (constNames(db, 'SKID_', prof)[0] || '').replace('SKID_PROFICIENCY_', '').replace('SKID_', '').toLowerCase();
    const lo = T.min + Q.dmg, hi = T.max + Q.dmg;
    const nov = [swing(lo, 0, 25), swing(hi, 0, 25)];
    const exp = [swing(lo, 99, 65), swing(hi, 99, 65)];
    const ranged = c.chain.includes('RangedWeapon') || c.chain.includes('Bow');
    rows.push({
      _attrs: ` data-type="${T.name}" data-quality="${Q.name}"`,
      i: icon ? `<img class="icon rowicon" src="${icon.src}" alt="" loading="lazy">` : '',
      n: `<a href="../items/${slugify(c.name)}.html">${esc(nameOf(db, c) || humanize(c.name))}</a>`,
      _n: nameOf(db, c) || humanize(c.name),
      t: esc(T.name), _t: T.name,
      q: esc(Q.name), _q: q,
      p: profName ? esc(profName) : '<span class="muted">—</span>',
      dn: `${nov[0]}–${nov[1]}`, _dn: nov[1],
      de: `${exp[0]}–${exp[1]}`, _de: exp[1],
      h: `+${T.hit + Q.hit}`, _h: T.hit + Q.hit,
      r: String(T.range), _r: T.range,
      s: `${T.spell}%`, _s: T.spell,
      w: num(ivar(db, c, 'viWeight')), _w: ivar(db, c, 'viWeight') ?? 0,
      v: num(ivar(db, c, 'viValue_average')), _v: ivar(db, c, 'viValue_average') ?? 0,
      u: num(ivar(db, c, 'viHits_init_max')), _u: ivar(db, c, 'viHits_init_max') ?? 0,
      k: ranged ? 'ranged' : 'melee',
    });
  }

  const columns = [
    { key: 'i', label: '' }, { key: 'n', label: 'Weapon' },
    { key: 't', label: 'Type' }, { key: 'q', label: 'Quality' },
    { key: 'p', label: 'Proficiency' },
    { key: 'dn', label: 'Novice dmg', num: true },
    { key: 'de', label: 'Expert dmg', num: true },
    { key: 'h', label: 'To-hit', num: true },
    { key: 'r', label: 'Reach', num: true },
    { key: 's', label: 'Spell', num: true },
    { key: 'w', label: 'Weight', num: true },
    { key: 'v', label: 'Value', num: true },
    { key: 'u', label: 'Hits', num: true },
    { key: 'k', label: '' },
  ];

  const indexHtml = `<h1>Weapons</h1>
<p class="lede">${rows.length} weapons, and the whole of what separates them is two class
variables. Everything below — damage, accuracy, reach, the penalty to your spellcasting — falls
out of <code class="k">viWeaponType</code> and <code class="k">viWeaponQuality</code>. There are
no hidden per-weapon numbers.</p>

<h2>The damage a swing does</h2>
<div class="formula">base       = random(min, max)              % by weapon TYPE, table below
           + quality modifier                % −1 low, 0 normal, +1 high, +1 nerudite
           + weapon attribute bonuses        % enchantments, if the item has any
stroke     × 80 / 100                        % the Slash stroke's damage factor
might      × (100 + bound(might − 25, 0, 40)) / 100
proficiency+ (proficiency + 1) × 5 / 100
           bounded to at least 1</div>
<p class="cite">kod/object/item/passitem/weapon.kod:241 <code class="k">GetBaseDamage</code> · :280 <code class="k">GetDamage</code> · kod/object/passive/skill/stroke.kod:201 <code class="k">FindDamage</code> · :332 <code class="k">DamageFactors</code> · kod/object/passive/skill/stroke/slash.kod:43</p>

<h2>Weapon type is the whole decision</h2>
<p>The three types are a genuine trade, not a ranking. Slash hits hardest and is the worst at
landing; thrust hits softest and is the best at landing, reaches a square further, and is the only
type that helps you disarm. Bludgeon sits between them and is the only type with no penalty to
your spellcasting.</p>
${dataTable(
    [{ key: 't', label: 'Type' }, { key: 'd', label: 'Base damage', num: true },
     { key: 'h', label: 'To-hit', num: true }, { key: 'r', label: 'Reach', num: true },
     { key: 'x', label: 'Disarm', num: true }, { key: 's', label: 'Spell penalty', num: true },
     { key: 'n', label: 'What that means' }],
    [
      { t: '<strong>slash</strong>', d: '5–11', h: '+0', r: '2', x: '0', s: '−15%',
        n: 'The most damage in the game and no accuracy help at all. A slashing weapon in an unskilled hand misses a lot.' },
      { t: '<strong>bludgeon</strong>', d: '4–8', h: '+75', r: '2', x: '−5', s: '0%',
        n: 'Middling damage, real accuracy, and the only type that costs your spellcasting nothing. The caster-fighter’s weapon.' },
      { t: '<strong>thrust</strong>', d: '3–8', h: '+125', r: '3', x: '+10', s: '−10%',
        n: 'The least damage, bought back with the largest to-hit bonus, an extra square of reach, and the disarm bonus.' },
    ], { sortable: false })}
<p class="cite">kod/object/item/passitem/weapon.kod:184 <code class="k">ModifyHitRoll</code>, :241 <code class="k">GetBaseDamage</code>, :307 <code class="k">GetRange</code>, :346 <code class="k">GetDisarmBonus</code>, :385 <code class="k">GetBaseSpellModifier</code>; constants at :31-52</p>
<div class="note">Damage and accuracy are deliberately opposed, and which wins depends on the
target. Against something you already hit 90% of the time, slash is strictly better. Against
something you hit 25% of the time, +125 to-hit is worth far more than +3 damage — and the
to-hit bonus is added to a number that then divides into the defender's defence, so it compounds.
Use the bestiary's per-creature hit percentages to decide.</div>
<div class="warn">Weapon type also sets what <em>kind</em> of damage you deal, and armour resists
by kind. Chain armour resists slashing at 20% and thrusting at only 5% — so against an armoured
target the ranking can invert again. See <a href="../armor/index.html">Armour</a>.</div>

<h2>Quality</h2>
${dataTable(
    [{ key: 'q', label: 'Quality' }, { key: 'd', label: 'Damage', num: true }, { key: 'h', label: 'To-hit', num: true }],
    [
      { q: 'low', d: '−1', h: '+0' }, { q: 'normal', d: '±0', h: '+0' },
      { q: 'high', d: '+1', h: '+50' }, { q: 'nerudite', d: '+1', h: '+25' },
    ], { sortable: false })}
<p class="cite">kod/object/item/passitem/weapon.kod:56-70</p>
<p>A point of quality damage is worth more than it looks: it is applied to the base
<em>before</em> the stroke factor and the might multiplier, so a high-quality weapon in a strong
hand is meaningfully better than the raw +1 suggests.</p>

<h2>Every weapon</h2>
<p><strong>Novice</strong> is 0 proficiency and might 25 — a fresh character. <strong>Expert</strong>
is 99 proficiency and might 65 — the practical ceiling. Both are before the target's armour.</p>
<div class="filterbar" data-for="weptable">
  <input type="search" placeholder="filter…" aria-label="Filter weapons">
  <select data-filter="type"><option value="">every type</option><option>slash</option><option>thrust</option><option>bludgeon</option></select>
  <select data-filter="quality"><option value="">every quality</option><option>low</option><option>normal</option><option>high</option><option>nerudite</option></select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'weptable' })}

<h2>Wear and breaking</h2>
<p>A weapon rolls its durability at creation between <code class="k">viHits_init_min</code> and
<code class="k">viHits_init_max</code> — 250 to 300 for an ordinary one — and loses hits as it
strikes, at a 75% chance per relevant event. At zero it breaks and switches to its broken
sprite. Most weapons can be mended.</p>
<p class="cite">kod/object/item/passitem/weapon.kod:20 <code class="k">WEAPON_TAKE_DAMAGE_PCT = 75</code>, :74</p>

<p>See <a href="../guides/combat.html">Combat</a> for how a swing resolves,
<a href="../skills/index.html">Skills</a> for the proficiencies, and
<a href="../items/index.html">Items</a> for anything not listed here.</p>`;

  return { indexHtml, pages: [] };
}
