// derive/reagents.mjs -- index only.  Both directions of the reagent question:
// "what does this spell need" and "what is this mushroom for".
//
// Nothing declares an item to BE a reagent; an item is a reagent because some
// spell's ResetReagents names it.  So the list is derived by inverting every
// Spell subclass, which also means it cannot drift out of date.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, esc, slugify, cleanText, humanize, cls, descendants, ivar, nameOf, descOf,
  findMessage, ownMessage, constNames, parseConsPairs, iconFor, dataTable, num,
} from '../lib.mjs';

export const meta = {
  id: 'reagents', title: 'Reagents', dir: 'reagents', order: 8, nav: true,
  blurb: 'Every spell component, what it costs, where it drops and what needs it.',
};

const SCHOOL = {
  1: 'Shal’ille', 2: 'Qor', 3: 'Kraanan', 4: 'Faren', 5: 'Riija', 6: 'Jala', 7: 'Admin',
};

function sideTable(name) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8')); }
  catch { return null; }
}

export function build({ db, images }) {
  const T = sideTable('treasure.json');

  // spell -> [{cls, count}], and the inversion.
  const spells = [];
  const byReagent = new Map();          // lowercased class name -> [{spell, count}]
  for (const s of descendants(db, 'Spell')) {
    if (ivar(db, s, 'viSpell_num') === null) continue;
    const m = ownMessage(s, 'ResetReagents') || findMessage(db, s, 'ResetReagents');
    const list = m ? parseConsPairs(m.body) : [];
    if (!list.length) continue;
    const rec = {
      s, name: nameOf(db, s) || humanize(s.name), slug: slugify(s.name),
      school: ivar(db, s, 'viSchool'), level: ivar(db, s, 'viSpell_level'),
      mana: ivar(db, s, 'viMana'), list,
    };
    spells.push(rec);
    for (const r of list) {
      const k = r.cls.toLowerCase();
      if (!byReagent.has(k)) byReagent.set(k, []);
      byReagent.get(k).push({ spell: rec, count: r.count });
    }
  }

  // Who sells it.
  const vendors = new Map();
  for (const c of descendants(db, 'Monster', { includeSelf: true })) {
    for (const m of c.messages) {
      const at = m.body.search(/plFor_sale/i);
      if (at < 0) continue;
      for (const t of new Set(m.body.slice(at).match(/&(\w+)/g) || [])) {
        const n = t.slice(1).toLowerCase();
        if (!vendors.has(n)) vendors.set(n, new Set());
        vendors.get(n).add(c.name);
      }
    }
  }

  // Which creatures drop it, via the treasure tables.
  const droppedBy = new Map();
  if (T && T.types) {
    for (const [tid, t] of Object.entries(T.types)) {
      for (const it of t.items || []) {
        const k = it.cls.toLowerCase();
        if (!droppedBy.has(k)) droppedBy.set(k, []);
        droppedBy.get(k).push({ tid, chance: it.exactChancePercent ?? it.chancePercent ?? 0, monsters: t.monsters || [] });
      }
    }
  }

  // ---------------------------------------------------------- reagent rows
  const reagents = [...byReagent.entries()].map(([k, uses]) => {
    const c = cls(db, k);
    const drops = droppedBy.get(k) || [];
    const creatures = [...new Set(drops.flatMap((d) => d.monsters))];
    return {
      k, c, uses,
      name: c ? (nameOf(db, c) || humanize(c.name)) : humanize(k),
      slug: c ? slugify(c.name) : k,
      icon: c ? iconFor(db, images, c) : null,
      weight: c ? ivar(db, c, 'viWeight') : null,
      bulk: c ? ivar(db, c, 'viBulk') : null,
      value: c ? ivar(db, c, 'viValue_average') : null,
      vendors: c ? [...(vendors.get(c.name.toLowerCase()) || [])] : [],
      bestDrop: drops.sort((a, b) => b.chance - a.chance)[0] || null,
      creatures,
    };
  }).sort((a, b) => b.uses.length - a.uses.length || a.name.localeCompare(b.name));

  const rCols = [
    { key: 'i', label: '' }, { key: 'n', label: 'Reagent' },
    { key: 'u', label: 'Spells', num: true },
    { key: 'v', label: 'Value', num: true },
    { key: 'w', label: 'Weight', num: true },
    { key: 'b', label: 'Bulk', num: true },
    { key: 'd', label: 'Best drop chance', num: true },
    { key: 'f', label: 'Dropped by' },
    { key: 's', label: 'Sold by' },
  ];
  const rRows = reagents.map((r) => ({
    i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
    n: r.c ? `<a href="../items/${r.slug}.html">${esc(r.name)}</a>` : esc(r.name),
    _n: r.name,
    u: String(r.uses.length), _u: r.uses.length,
    v: num(r.value), _v: r.value ?? -1,
    w: num(r.weight), _w: r.weight ?? -1,
    b: num(r.bulk), _b: r.bulk ?? -1,
    d: r.bestDrop ? `${r.bestDrop.chance.toFixed(1)}%` : '<span class="muted">—</span>',
    _d: r.bestDrop ? r.bestDrop.chance : -1,
    f: r.creatures.length
      ? r.creatures.slice(0, 3).map((m) => {
        const k = cls(db, m);
        return `<a href="../creatures/${slugify(m)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : m)}</a>`;
      }).join(', ') + (r.creatures.length > 3 ? ` <span class="muted">+${r.creatures.length - 3}</span>` : '')
      : '<span class="muted">—</span>',
    s: r.vendors.length
      ? r.vendors.slice(0, 3).map((m) => {
        const k = cls(db, m);
        return `<a href="../creatures/${slugify(m)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : m)}</a>`;
      }).join(', ')
      : '<span class="muted">—</span>',
  }));

  // ---------------------------------------------------------- spell rows
  spells.sort((a, b) => (a.school ?? 9) - (b.school ?? 9) || (a.level ?? 9) - (b.level ?? 9)
    || a.name.localeCompare(b.name));
  const sCols = [
    { key: 'n', label: 'Spell' }, { key: 'c', label: 'School' },
    { key: 'l', label: 'Lvl', num: true }, { key: 'm', label: 'Mana', num: true },
    { key: 'r', label: 'Needs, per cast' },
    { key: 'v', label: 'Component cost', num: true },
  ];
  const sRows = spells.map((r) => {
    let cost = 0, known = true;
    const parts = r.list.map((x) => {
      const k = cls(db, x.cls);
      const v = k ? ivar(db, k, 'viValue_average') : null;
      if (v === null) known = false; else cost += v * x.count;
      return k
        ? `<a href="../items/${slugify(k.name)}.html">${esc(nameOf(db, k) || humanize(k.name))}</a>${x.count > 1 ? ` ×${x.count}` : ''}`
        : `${esc(humanize(x.cls))}${x.count > 1 ? ` ×${x.count}` : ''}`;
    });
    return {
      _attrs: ` data-school="${esc(SCHOOL[r.school] || '—')}"`,
      n: `<a href="../spells/${r.slug}.html">${esc(r.name)}</a>`, _n: r.name,
      c: esc(SCHOOL[r.school] || '—'), _c: SCHOOL[r.school] || '',
      l: num(r.level), _l: r.level ?? 9,
      m: num(r.mana), _m: r.mana ?? 0,
      r: parts.join(', '),
      v: known ? `${cost} sh` : '<span class="muted">?</span>', _v: known ? cost : -1,
    };
  });

  const totalRows = spells.reduce((n, s) => n + s.list.length, 0);

  const indexHtml = `<h1>Reagents</h1>
<p class="lede">${reagents.length} things are spell components, and nothing in the game says so.
An item is a reagent because some spell names it in <code class="k">ResetReagents</code> — there
is no reagent flag, no reagent class, no reagent shop sign. Both tables below are derived by
inverting all ${spells.length} spells that need one.</p>

<h2>How components are spent</h2>
<div class="formula">on a successful cast:  every listed reagent is consumed, in the listed quantity
on a failed cast:       half the mana, half the exertion, NO reagents</div>
<p class="cite">kod/object/passive/spell.kod:626 <code class="k">CanPayReagents</code>, :1256 <code class="k">PayCosts</code></p>
<p>Failing is therefore cheap in materials and expensive only in time. Running <em>out</em> is the
real cost: <code class="k">CanPayCosts</code> refuses the cast outright, before the trance, so a
caster who has run dry mid-fight simply stops working.</p>

<h2>Every reagent</h2>
<p>Sorted by how many spells want it, which is the order in which you should stock up. The
<em>Best drop chance</em> column is the highest per-roll probability across every treasure table
that contains it — see <a href="../creatures/index.html">the bestiary</a> for what to kill.</p>
<div class="filterbar" data-for="reagtable">
  <input type="search" placeholder="filter…" aria-label="Filter reagents">
  <span class="count"></span>
</div>
${dataTable(rCols, rRows, { id: 'reagtable' })}

<h2>What each spell needs</h2>
<p>${spells.length} spells consume components, ${totalRows} component requirements in total.
<em>Component cost</em> is the sum of the average values of what a single cast destroys — a
rough floor on what casting costs you per use, before you count mana.</p>
<div class="filterbar" data-for="spellreagtable">
  <input type="search" placeholder="filter…" aria-label="Filter spells">
  <select data-filter="school"><option value="">every school</option>${
    [...new Set(spells.map((s) => SCHOOL[s.school]).filter(Boolean))].sort()
      .map((s) => `<option>${esc(s)}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable(sCols, sRows, { id: 'spellreagtable' })}

<h2>Carrying them</h2>
<p>Reagents are ordinary items and cost you ordinary weight and bulk. A caster who wants to stay
out for a long session is carrying dozens of them, and bulk is usually the limit that bites
first. One school turns that around: <strong>Riija's secondary spell-power bonus is
<code class="k">bulk_held × 10 / bulk_max</code></strong> — the fuller your pack, the stronger you
cast.</p>
<p class="cite">kod/object/passive/spell.kod:2158</p>

<p>See <a href="../guides/spells.html">Spells and Spellcasting</a> for the rest of a cast's cost,
<a href="../items/index.html">Items</a> for the components themselves, and
<a href="../npcs/index.html">NPCs</a> for who sells them.</p>`;

  return { indexHtml, pages: [] };
}
