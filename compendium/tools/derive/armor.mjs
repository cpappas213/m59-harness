// derive/armor.mjs -- index only.  The question this whole site exists to
// answer is on this page: how much does what I am wearing actually save me?

import {
  esc, slugify, cleanText, humanize, descendants, ivar, nameOf, descOf,
  findMessage, constNames, flagNames, parsePairList, iconFor, dataTable, num,
} from '../lib.mjs';

export const meta = {
  id: 'armor', title: 'Armour', dir: 'armor', order: 5, nav: true,
  blurb: 'What each piece of armour actually subtracts, by damage type.',
};

// The four weapon damage types a player will actually meet.
const TYPES = ['ATCK_WEAP_SLASH', 'ATCK_WEAP_THRUST', 'ATCK_WEAP_PIERCE', 'ATCK_WEAP_BLUDGEON'];
const SHORT = { ATCK_WEAP_SLASH: 'slash', ATCK_WEAP_THRUST: 'thrust', ATCK_WEAP_PIERCE: 'pierce', ATCK_WEAP_BLUDGEON: 'bludgeon' };

// kod/object/item/passitem/defmod.kod:100 ModifyDefenseDamage, then
// kod/object/active/holder/nomoveon/battler.kod:251 GetDamageFromResistance.
// The flat reduction is rolled per blow as random(r/3, r) and clamped to
// damage-1; the expected value is what we can usefully tabulate.
function damageTaken(raw, flatReduce, resistPct) {
  let d = raw;
  if (flatReduce) {
    const lo = Math.trunc(flatReduce / 3);
    d -= Math.min((lo + flatReduce) / 2, d - 1);
  }
  if (resistPct > 0) d = (d * (100 - resistPct)) / 100;
  else if (resistPct < 0) d = (d * (-100 + resistPct)) / -100;
  return Math.max(1, d);
}

function slotOf(db, c) {
  const u = ivar(db, c, 'viUse_type');
  if (!u) return null;
  return flagNames(db, 'ITEM_USE_', u).map((f) => f.name.replace('ITEM_USE_', '').toLowerCase()).join('+');
}

export function build({ db, images }) {
  const all = descendants(db, 'DefenseModifier').sort((a, b) => a.name.localeCompare(b.name));

  const recs = [];
  for (const c of all) {
    const m = findMessage(db, c, 'GetResistanceModifiers');
    const res = {};
    if (m) for (const p of parsePairList(m.body)) res[p.a] = p.b;
    const defBase = ivar(db, c, 'viDefense_base');
    const dmgBase = ivar(db, c, 'viDamage_base');
    // Skip the abstract intermediates that declare nothing of their own.
    const hasEffect = (defBase || dmgBase || Object.keys(res).length);
    recs.push({
      c, res, defBase, dmgBase, hasEffect,
      name: nameOf(db, c) || humanize(c.name),
      slug: slugify(c.name),
      icon: iconFor(db, images, c),
      slot: slotOf(db, c),
      weight: ivar(db, c, 'viWeight'),
      bulk: ivar(db, c, 'viBulk'),
      value: ivar(db, c, 'viValue_average'),
      hits: ivar(db, c, 'viHits_init_max'),
      spellMod: ivar(db, c, 'viSpell_modifier'),
      isShield: c.chain.includes('Shield'),
    });
  }
  const worn = recs.filter((r) => r.hasEffect);

  const columns = [
    { key: 'i', label: '' }, { key: 'n', label: 'Armour' }, { key: 's', label: 'Slot' },
    { key: 'df', label: 'Defence', num: true }, { key: 'fr', label: 'Flat', num: true },
    ...TYPES.map((t) => ({ key: 'r' + t, label: SHORT[t], num: true })),
    { key: 'sp', label: 'Spell', num: true },
    { key: 'w', label: 'Weight', num: true }, { key: 'b', label: 'Bulk', num: true },
    { key: 'v', label: 'Value', num: true }, { key: 'h', label: 'Hits', num: true },
  ];
  const rows = worn.map((r) => {
    const row = {
      _attrs: ` data-slot="${esc(r.slot || 'other')}"`,
      i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
      n: `<a href="../items/${r.slug}.html">${esc(r.name)}</a>`, _n: r.name,
      s: r.slot ? esc(r.slot) : '<span class="muted">—</span>', _s: r.slot || '',
      df: num(r.defBase), _df: r.defBase ?? 0,
      fr: r.dmgBase ? `${Math.trunc(r.dmgBase / 3)}–${r.dmgBase}` : '0', _fr: r.dmgBase ?? 0,
      sp: r.spellMod === null ? '<span class="muted">—</span>' : `${r.spellMod}%`, _sp: r.spellMod ?? 0,
      w: num(r.weight), _w: r.weight ?? 0,
      b: num(r.bulk), _b: r.bulk ?? 0,
      v: num(r.value), _v: r.value ?? 0,
      h: num(r.hits), _h: r.hits ?? 0,
    };
    for (const t of TYPES) {
      const pct = r.res[t] ?? (r.res.ATCK_WEAP_ALL ?? 0);
      row['r' + t] = pct ? `${pct}%` : '<span class="muted">—</span>';
      row['_r' + t] = pct;
    }
    return row;
  });

  // The headline table: a 20-point hit, per armour, per type.
  const headCols = [
    { key: 'n', label: 'Wearing' },
    ...TYPES.map((t) => ({ key: t, label: SHORT[t], num: true })),
  ];
  const headRows = [
    Object.assign({ n: '<strong>nothing</strong>' },
      ...TYPES.map((t) => ({ [t]: '20.0', ['_' + t]: 20 }))),
    ...worn.filter((r) => Object.keys(r.res).length || r.dmgBase)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => {
        const row = { n: `<a href="../items/${r.slug}.html">${esc(r.name)}</a>`, _n: r.name };
        for (const t of TYPES) {
          const pct = r.res[t] ?? (r.res.ATCK_WEAP_ALL ?? 0);
          const v = damageTaken(20, r.dmgBase || 0, pct);
          row[t] = v.toFixed(1);
          row['_' + t] = v;
        }
        return row;
      }),
  ];

  const indexHtml = `<h1>Armour</h1>
<p class="lede">Armour in this game does three separate things, and two of them can be negative.
It changes how often you are hit, it subtracts a flat amount from each blow that lands, and it
multiplies damage of specific types up or down. The heaviest armour makes you
<em>easier</em> to hit — it buys mitigation with accuracy, not on top of it.</p>

<h2>The order a hit is resolved in</h2>
<div class="formula">for each worn defence modifier:
    damage = damage − bound(random(flat/3, flat), 0, damage−1)     % flat reduction, per item
    the item takes wear on a 50% roll
resistance = largest matching resistance + worst matching weakness  % clipped to ±100
damage     = damage × (100 − resistance) / 100                      % if resistance > 0
           = damage × (−100 + resistance) / −100                    % if resistance &lt; 0
damage     = damage + attack-modifier bonuses                       % after resistance
if damage ≤ 0: damage = 1
damage     = bound(damage, $, (max_health + 2) / 3)                 % the one-third cap
damage     = bound(damage, $, 30)                                   % MAX_DAMAGE_PER_HIT</div>
<p class="cite">kod/object/item/passitem/defmod.kod:100 <code class="k">ModifyDefenseDamage</code> · kod/object/active/holder/nomoveon/battler.kod:189 <code class="k">ResistanceCheck</code>, :251 <code class="k">GetDamageFromResistance</code> · kod/object/active/holder/nomoveon/battler/player.kod:4556 <code class="k">AssessDamage</code></p>

<div class="warn"><strong>Armour does nothing against pure spell damage.</strong> The flat
reduction is set to zero when the attack has a spell type and no weapon type, and cut to two
thirds when it has both. Only typed <em>resistances</em> reach magic, and most armour has none.
<span class="cite">kod/object/item/passitem/defmod.kod:110-122</span></div>

<h2>How much does chain armour save me?</h2>
<p>Directly: a 20-point slashing hit, taken by a character wearing each of these and nothing
else. Chain armour resists slashing at 20% and subtracts a further <code class="k">random(0,2)</code>,
so 20 becomes about 15 — a quarter off. Against thrusting it resists only 5%, so the same blow
costs about 18. <strong>What you wear matters much less than what you are hit with.</strong></p>
${dataTable(headCols, headRows, { id: 'headtable' })}
<p>Figures use the expected value of the flat roll, which is rerolled every blow, and assume a
single worn item. Wearing several defence modifiers applies each one's flat reduction separately
but resolves resistance once, taking your best resistance plus your worst weakness.</p>

<h2>Why good armour has negative defence</h2>
<p>Look at the <em>Defence</em> column below and you will find large negative numbers on the
heaviest pieces. That value is added straight to your defence score, and your defence score
divides into the attacker's offence to set their chance to hit:</p>
<div class="formula">chance to hit = bound(attacker_offence × 55 / defender_defence, 10, 95)  %</div>
<p class="cite">kod/object/active/holder/nomoveon/battler.kod:19, :330</p>
<p>So −50 on a defence score of, say, 585 raises an attacker's chance to hit you by roughly
nine percent of itself. You take more blows and each one hurts less. Light armour is the
opposite trade. Neither is strictly better; it depends on whether you are being hit by one big
thing or many small ones — the flat reduction is subtracted per blow, so it is worth far more
against a swarm than against a single heavy hitter.</p>

<h2>Every defence modifier</h2>
<div class="filterbar" data-for="armtable">
  <input type="search" placeholder="filter…" aria-label="Filter armour">
  <select data-filter="slot"><option value="">every slot</option>${
    [...new Set(worn.map((r) => r.slot || 'other'))].sort().map((s) => `<option>${esc(s)}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'armtable' })}
<p><em>Defence</em> adds to your defence score. <em>Flat</em> is the range subtracted from each
landing blow. The four type columns are percentage resistances. <em>Spell</em> is the penalty
to your spellcasting for wearing it. <em>Hits</em> is the durability it starts with.</p>

<p>See <a href="../guides/armor.html">the Armour guide</a> for the full treatment,
<a href="../guides/combat.html">Combat</a> for the rest of the resolution, and
<a href="../weapons/index.html">Weapons</a> for what you will be hit with.</p>`;

  return { indexHtml, pages: [] };
}
