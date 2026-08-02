// derive/npcs.mjs -- index only.  The people, re-cut out of the bestiary.
//
// There is no NPC class in this game.  An innkeeper is a Monster with
// MOB_NOFIGHT and a plFor_Sale list, which is why derive/creatures.mjs owns the
// pages and this module only owns the view.  The test used here is stated on
// the page itself so a reader can disagree with it.

import {
  esc, slugify, cleanText, humanize, cls, descendants, ivar, rvar, nameOf, descOf,
  constNames, flagNames, constComment, iconFor, dataTable, num,
} from '../lib.mjs';

export const meta = {
  id: 'npcs', title: 'NPCs', dir: 'npcs', order: 7, nav: true,
  blurb: 'Merchants, teachers, guards and everyone else who talks back.',
};

// kod/include/blakston.khd:1389
const MOB = {
  NOFIGHT: 0x00001, LISTEN: 0x00010, RECEIVE: 0x00020, BUYER: 0x00040,
  SELLER: 0x00080, BANKER: 0x00100, SMITH: 0x00200, TEACHER: 0x00400,
  COND_SELLER: 0x10000, PERM_QUESTER: 0x20000, VAULTMAN: 0x80000, LAWFUL: 0x40000,
};

function forSale(c) {
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

function roleOf(attrs, sale, occupation) {
  const roles = [];
  if (attrs & MOB.TEACHER || sale.spells.length || sale.skills.length) roles.push('teacher');
  if (attrs & MOB.SELLER || sale.items.length) roles.push('merchant');
  if (attrs & MOB.BUYER) roles.push('buyer');
  if (attrs & MOB.BANKER) roles.push('banker');
  if (attrs & MOB.VAULTMAN) roles.push('vault keeper');
  if (attrs & MOB.SMITH) roles.push('smith');
  if (attrs & MOB.PERM_QUESTER) roles.push('quest giver');
  if (!roles.length && (attrs & MOB.NOFIGHT)) roles.push('flavour');
  return roles;
}

export function build({ db, images }) {
  const spellBy = new Map(), skillBy = new Map();
  for (const s of descendants(db, 'Spell')) {
    const n = ivar(db, s, 'viSpell_num');
    if (n !== null) for (const name of constNames(db, 'SID_', n)) spellBy.set(name, s);
  }
  for (const s of descendants(db, 'Skill')) {
    const n = ivar(db, s, 'viSkill_num');
    if (n !== null) for (const name of constNames(db, 'SKID_', n)) skillBy.set(name, s);
  }

  const npcs = [];
  for (const c of descendants(db, 'Monster')) {
    const attrs = ivar(db, c, 'viAttributes') || 0;
    const sale = forSale(c);
    const roles = roleOf(attrs, sale, ivar(db, c, 'viOccupation'));
    if (!roles.length) continue;
    npcs.push({
      c, attrs, sale, roles,
      name: nameOf(db, c) || humanize(c.name),
      slug: slugify(c.name),
      icon: iconFor(db, images, c, { group: 1 }),
      level: ivar(db, c, 'viLevel'),
      desc: descOf(db, c),
    });
  }
  npcs.sort((a, b) => a.name.localeCompare(b.name));

  const link = (map, id, dir) => {
    const t = map.get(id);
    return t ? `<a href="../${dir}/${slugify(t.name)}.html">${esc(nameOf(db, t) || humanize(t.name))}</a>`
      : `<code class="k">${esc(id)}</code>`;
  };

  const columns = [
    { key: 'i', label: '' },
    { key: 'n', label: 'Who' },
    { key: 'r', label: 'Role' },
    { key: 'sp', label: 'Spells taught' },
    { key: 'sk', label: 'Skills taught' },
    { key: 'g', label: 'Goods' },
  ];
  const rows = npcs.map((r) => ({
    _attrs: ` data-role="${esc(r.roles[0])}"`,
    i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
    n: `<a href="../creatures/${r.slug}.html">${esc(r.name)}</a>`,
    r: esc(r.roles.join(', ')), _r: r.roles[0],
    sp: r.sale.spells.length ? r.sale.spells.map((s) => link(spellBy, s, 'spells')).join(', ') : '<span class="muted">—</span>',
    _sp: r.sale.spells.length,
    sk: r.sale.skills.length ? r.sale.skills.map((s) => link(skillBy, s, 'skills')).join(', ') : '<span class="muted">—</span>',
    _sk: r.sale.skills.length,
    g: r.sale.items.length ? r.sale.items.map((n) => {
      const k = cls(db, n);
      return k && k.chain.includes('Item')
        ? `<a href="../items/${slugify(k.name)}.html">${esc(nameOf(db, k) || humanize(k.name))}</a>` : '';
    }).filter(Boolean).join(', ') || '<span class="muted">—</span>' : '<span class="muted">—</span>',
  }));

  // ---- who teaches what, the other way round
  const teachRows = [];
  for (const [id, s] of spellBy) {
    const who = npcs.filter((n) => n.sale.spells.includes(id));
    if (!who.length) continue;
    teachRows.push({
      a: `<a href="../spells/${slugify(s.name)}.html">${esc(nameOf(db, s) || humanize(s.name))}</a>`,
      _a: nameOf(db, s) || humanize(s.name),
      k: 'spell',
      l: num(ivar(db, s, 'viSpell_level')), _l: ivar(db, s, 'viSpell_level') ?? 9,
      w: who.map((n) => `<a href="../creatures/${n.slug}.html">${esc(n.name)}</a>`).join(', '),
    });
  }
  for (const [id, s] of skillBy) {
    const who = npcs.filter((n) => n.sale.skills.includes(id));
    if (!who.length) continue;
    teachRows.push({
      a: `<a href="../skills/${slugify(s.name)}.html">${esc(nameOf(db, s) || humanize(s.name))}</a>`,
      _a: nameOf(db, s) || humanize(s.name),
      k: 'skill',
      l: num(ivar(db, s, 'viSkill_level')), _l: ivar(db, s, 'viSkill_level') ?? 9,
      w: who.map((n) => `<a href="../creatures/${n.slug}.html">${esc(n.name)}</a>`).join(', '),
    });
  }
  teachRows.sort((a, b) => (a._l - b._l) || String(a._a).localeCompare(String(b._a)));

  const roles = [...new Set(npcs.map((n) => n.roles[0]))].sort();

  const indexHtml = `<h1>NPCs</h1>
<p class="lede">${npcs.length} people you can do business with. There is no NPC class in this
game: an innkeeper is a creature with the fighting turned off and a list of goods, which is why
each of these links to a bestiary page. What separates them from the ants is a flag.</p>

<h2>How this list was chosen</h2>
<p>Every <code class="k">Monster</code> subclass whose <code class="k">viAttributes</code>
carries at least one of the trading flags, or which puts anything in
<code class="k">plFor_Sale</code>, or which is marked as never fighting:</p>
${dataTable([{ key: 'f', label: 'Flag' }, { key: 'd', label: 'Meaning' }],
    Object.entries(MOB).map(([k, v]) => ({
      f: `<code class="k">MOB_${esc(k)}</code>`,
      d: esc(constComment('MOB_' + k) || '—'),
    })), { sortable: false })}
<p class="cite">kod/include/blakston.khd:1389</p>

<div class="filterbar" data-for="npctable">
  <input type="search" placeholder="filter…" aria-label="Filter NPCs">
  <select data-filter="role"><option value="">every role</option>${
    roles.map((r) => `<option>${esc(r)}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'npctable' })}

<h2>Who teaches what</h2>
<p>The same information the other way round: if you want a particular spell or skill, this is
who has it. Sorted by level, so the early rows are what a new character can actually afford.</p>
${dataTable(
    [{ key: 'a', label: 'Ability' }, { key: 'k', label: 'Kind' }, { key: 'l', label: 'Lvl', num: true }, { key: 'w', label: 'Taught by' }],
    teachRows, { id: 'teachtable' })}

<p>See <a href="../guides/economy.html">Money and Merchants</a> for how prices are set, and
<a href="../creatures/index.html">the Bestiary</a> for the full statistics on any of these.</p>`;

  return { indexHtml, pages: [] };
}
