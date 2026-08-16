// derive/npcs.mjs -- index only.  The people, re-cut out of the bestiary.
//
// There is no NPC class in this game.  An innkeeper is a Monster with
// MOB_NOFIGHT and a plFor_Sale list, which is why derive/creatures.mjs owns the
// pages and this module only owns the view.  The test used here is stated on
// the page itself so a reader can disagree with it.

import {
  esc, slugify, cleanText, humanize, cls, descendants, ivar, rvar, nameOf, descOf,
  constNames, flagNames, constComment, iconFor, dataTable, num, inheritedAny,
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

// WHAT A MERCHANT CHARGES, AND IT IS THE SAME SIX BANDS FOR EVERYONE.
// kod/include/blakston.khd:1368-1373. `viMerchant_markup` is a small integer and the two
// multipliers are asymmetric — 20 points a step when you BUY, 10 when you SELL — so the
// round-trip spread grows much faster than either side suggests. See guides/economy.html.
const MARKUP = [
  { band: 'flat',      pay: 100, offer: 100 },
  { band: 'bargain',   pay: 120, offer:  90 },
  { band: 'discount',  pay: 140, offer:  80 },
  { band: 'normal',    pay: 160, offer:  70 },
  { band: 'expensive', pay: 180, offer:  60 },
  { band: 'ripoff',    pay: 200, offer:  50 },
];

// DECLARED, OR MERELY INHERITED? `ivar` resolves up the chain, and `Monster` itself sets
// MERCHANT_NORMAL — so every descendant answers 3 and the question "who actually chose a
// band" cannot be asked that way. `inheritedAny` names the class the value came from,
// which is the only way to tell a deliberate normal from a default one.
//
// Compared case-INSENSITIVELY, because this tree spells its own class names
// inconsistently (`barloqueVaultman` is declared with a small b and created as
// `Barloquevaultman`), and a case-sensitive compare reports every such class as inherited.
function markupOf(db, c) {
  const v = inheritedAny(db, c, 'viMerchant_markup');
  if (!v || typeof v.value !== 'number') return null;
  const row = MARKUP[v.value];
  if (!row) return null;
  return {
    ...row,
    value: v.value,
    declared: String(v.from || '').toLowerCase() === String(c.name || '').toLowerCase(),
    spread: row.offer > 0 ? row.pay / row.offer : null,
  };
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
      markup: markupOf(db, c),
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
    { key: 'm', label: 'Prices' },
    { key: 'sp', label: 'Spells taught' },
    { key: 'sk', label: 'Skills taught' },
    { key: 'g', label: 'Goods' },
  ];
  // A BAND ONLY MEANS SOMETHING TO SOMEBODY WHO QUOTES A PRICE. Every Monster inherits
  // MERCHANT_NORMAL, so rendering it for a pure flavour NPC would fill the column with a
  // number that answers no question anyone has. Shown when the class CHOSE a band, or when
  // it trades at all; a bare dash otherwise.
  const TRADES = MOB.SELLER | MOB.BUYER | MOB.BANKER | MOB.SMITH | MOB.TEACHER
               | MOB.VAULTMAN | MOB.COND_SELLER;
  const priceCell = (r) => {
    const m = r.markup;
    const trades = (r.attrs & TRADES) || r.sale.items.length || r.sale.spells.length
                 || r.sale.skills.length;
    if (!m || (!m.declared && !trades)) return { m: '<span class="muted">—</span>', _m: 99 };
    const spread = m.spread ? `×${m.spread.toFixed(2)}` : '';
    return {
      m: `<strong>${esc(m.band)}</strong> <span class="muted">${m.pay}% / ${m.offer}%, ${spread}` +
         `${m.declared ? '' : ' (inherited)'}</span>`,
      _m: m.value,
    };
  };

  const rows = npcs.map((r) => ({
    _attrs: ` data-role="${esc(r.roles[0])}"` +
            (r.markup ? ` data-band="${esc(r.markup.band)}"` : ''),
    i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
    n: `<a href="../creatures/${r.slug}.html">${esc(r.name)}</a>`,
    r: esc(r.roles.join(', ')), _r: r.roles[0],
    ...priceCell(r),
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

<h2>What they charge</h2>
<p>Every price a merchant quotes is the item's declared value run through one number,
<code class="k">viMerchant_markup</code>, and the two multipliers are <strong>asymmetric</strong>:
20 points a step when you buy, 10 when you sell. So the round-trip spread grows much faster
than either column suggests, and where you shop matters more than what you carry. The
<strong>Prices</strong> column below is sortable and filterable — sort it to put the four
bargains at the top.</p>
${dataTable([{ key: 'b', label: 'Band' }, { key: 'p', label: 'You pay' },
             { key: 'o', label: 'You are offered' }, { key: 's', label: 'Round trip' },
             { key: 'c', label: 'How many' }],
    MARKUP.map((m, v) => {
      const n = npcs.filter((r) => r.markup?.declared && r.markup.value === v).length;
      return {
        b: `<code class="k">MERCHANT_${esc(m.band.toUpperCase())}</code>`,
        p: `${m.pay}%`, o: `${m.offer}%`,
        s: m.offer > 0 ? `×${(m.pay / m.offer).toFixed(2)}` : '—',
        c: v === 3 ? `${n}, and the default everyone else inherits`
                   : (n ? String(n) : 'none in the current world'),
      };
    }), { sortable: false })}
<p class="cite">kod/include/blakston.khd:1368–1373 · counted from
<code class="k">viMerchant_markup</code> where the class DECLARES one, not where it inherits
<code class="k">Monster</code>'s default</p>

<div class="warn"><strong>A band is not an invitation to sell.</strong> Skivlat the Tos banker
sits in the <em>bargain</em> band and pays nothing at all — bankers take what you hand over and
thank you, and the two vaults are storage that sells your goods back at about a shilling. The
flags say <code class="k">buys_anything</code> for all of them and it is true and it is not a
market. See <a href="../guides/economy.html">Money and Merchants</a> for who actually pays.</div>

<div class="filterbar" data-for="npctable">
  <input type="search" placeholder="filter…" aria-label="Filter NPCs">
  <select data-filter="role"><option value="">every role</option>${
    roles.map((r) => `<option>${esc(r)}</option>`).join('')}</select>
  <select data-filter="band"><option value="">every price band</option>${
    MARKUP.filter((m) => npcs.some((r) => r.markup?.band === m.band))
      .map((m) => `<option>${esc(m.band)}</option>`).join('')}</select>
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
