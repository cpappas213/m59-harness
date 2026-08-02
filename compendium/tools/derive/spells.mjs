// derive/spells.mjs -- one page per spell, plus the spell index.
//
// This is the REFERENCE derive module.  Every other module in this directory
// follows the same shape:
//
//   export const meta = { id, title, dir, order, nav, blurb }
//   export function build({db, images, lib}) -> { indexHtml, pages: [ {slug, title, html, desc, icon, kind} ] }
//
// `icon` on a page is a site-root-relative path (assets/img/foo_g1.png) used by
// the search box.  `html` is the page body; the shell adds nav, crumbs, footer.

import {
  esc, slugify, cleanText, humanize, cls, descendants, inherited, ivar, rvar, nameOf, descOf,
  findMessage, ownMessage, constNames, flagNames, constValue, parseConsPairs,
  iconFor, spriteGroups, factGrid, dataTable, tagList, kodSource, num, heroBlock, heroImg,
} from '../lib.mjs';

export const meta = {
  id: 'spells', title: 'Spells', dir: 'spells', order: 1, nav: true,
  blurb: 'Every spell in the game: school, level, mana, reagents, karma gate and effect.',
};

// kod/include/blakston.khd:2027 — the school numbering the client also uses.
const SCHOOLS = {
  1: { name: 'Shal’ille', slug: 'shalille', polarity: 'good', gate: '+10 karma per spell level' },
  2: { name: 'Qor', slug: 'qor', polarity: 'evil', gate: '−10 karma per spell level' },
  3: { name: 'Kraanan', slug: 'kraanan', polarity: 'neutral', gate: 'none' },
  4: { name: 'Faren', slug: 'faren', polarity: 'neutral', gate: 'none' },
  5: { name: 'Riija', slug: 'riija', polarity: 'neutral', gate: 'none' },
  6: { name: 'Jala', slug: 'jala', polarity: 'neutral', gate: 'none' },
  7: { name: 'Administrative', slug: null, polarity: '—', gate: 'not player-castable' },
  0: { name: 'None', slug: null, polarity: '—', gate: '—' },
  '-1': { name: 'Inaccessible', slug: null, polarity: '—', gate: 'disabled on this server' },
};

// Spell.GetRequiredKarma, kod/object/passive/spell.kod:482.
function requiredKarma(school, level) {
  if (school === 2) return -10 * level;
  if (school === 1) return 10 * level;
  return 0;
}

function returnedInt(msg) {
  if (!msg) return null;
  const m = /return\s+(-?\d+)\s*;/.exec(msg.body);
  return m ? parseInt(m[1], 10) : null;
}

// Every monster that sells a spell lists it in plFor_Sale's third element;
// skills sit in the second.  SKID_ never matches /\bSID_/, so a token scan of
// the whole assignment is unambiguous.
export function teacherIndex(db) {
  const bySpell = new Map(), bySkill = new Map();
  for (const c of descendants(db, 'Monster', { includeSelf: true })) {
    for (const m of c.messages) {
      // Kod identifiers are case-insensitive and the tree writes both
      // plFor_Sale and plFor_sale; a case-sensitive match silently loses
      // whole teachers.
      const at = m.body.search(/plFor_sale/i);
      if (at < 0) continue;
      const chunk = m.body.slice(at);
      for (const t of new Set((chunk.match(/\bSID_[A-Z0-9_]+/g) || []))) {
        if (!bySpell.has(t)) bySpell.set(t, new Set());
        bySpell.get(t).add(c.name);
      }
      for (const t of new Set((chunk.match(/\bSKID_[A-Z0-9_]+/g) || []))) {
        if (!bySkill.has(t)) bySkill.set(t, new Set());
        bySkill.get(t).add(c.name);
      }
    }
  }
  return { bySpell, bySkill };
}

export function collectSpells(db, images) {
  const teachers = teacherIndex(db).bySpell;
  const out = [];
  for (const c of descendants(db, 'Spell')) {
    const numv = ivar(db, c, 'viSpell_num');
    const school = ivar(db, c, 'viSchool');
    // Abstract intermediates (PersonalEnchantment, RoomEnchantment, …) declare
    // no spell number and are not spells a player can hold.
    if (numv === null && !c.children.length) { /* still emit — some are real */ }
    const name = nameOf(db, c) || humanize(c.name);
    const level = ivar(db, c, 'viSpell_level');
    const sidNames = numv === null ? [] : constNames(db, 'SID_', numv);
    const reagentMsg = findMessage(db, c, 'ResetReagents');
    const reagents = reagentMsg ? parseConsPairs(reagentMsg.body) : [];
    const targetsMsg = findMessage(db, c, 'GetNumSpellTargets');
    out.push({
      c, name, slug: slugify(c.name),
      num: numv, sid: sidNames[0] || null,
      school, schoolInfo: SCHOOLS[school] || SCHOOLS[0],
      level, mana: ivar(db, c, 'viMana'),
      castTime: ivar(db, c, 'viCast_time'),
      postCast: ivar(db, c, 'viPostCast_time'),
      harmful: ivar(db, c, 'viHarmful') === 1,
      outlaw: ivar(db, c, 'viOutlaw') === 1,
      exertion: ivar(db, c, 'viSpellExertion'),
      chanceUp: ivar(db, c, 'viChance_To_Increase'),
      happyLand: ivar(db, c, 'vbCastable_in_HappyLand') !== 0,
      personal: ivar(db, c, 'viPersonal_ench') === 1,
      targets: returnedInt(targetsMsg),
      reagents,
      karma: school === null ? 0 : requiredKarma(school, level || 1),
      desc: descOf(db, c),
      intro: (rvar(db, c, 'vrSpell_intro') || {}).value || null,
      teachers: sidNames[0] && teachers.get(sidNames[0]) ? [...teachers.get(sidNames[0])] : [],
      abstract: numv === null,
    });
  }
  for (const s of out) s.iconInfo = iconFor(db, images, s.c);
  out.sort((a, b) => (a.school ?? 99) - (b.school ?? 99) || (a.level ?? 99) - (b.level ?? 99)
    || a.name.localeCompare(b.name));
  return out;
}

function reagentLinks(reagents, db) {
  if (!reagents.length) return '<span class="muted">none</span>';
  return reagents.map((r) => {
    const k = cls(db, r.cls);
    const nm = k ? (nameOf(db, k) || humanize(k.name)) : r.cls;
    return `<a href="../items/${slugify(r.cls)}.html">${esc(nm)}</a>${r.count > 1 ? ` ×${r.count}` : ''}`;
  }).join(', ');
}

export function build({ db, images, lib }) {
  const spells = collectSpells(db, images);
  const real = spells.filter((s) => !s.abstract);

  // ---------------------------------------------------------------- pages
  const pages = spells.map((s) => {
    const S = s.schoolInfo;
    const groups = spriteGroups(db, images, s.c);
    const facts = factGrid([
      ['School', S.slug ? `<a href="../guides/${S.slug}.html">${esc(S.name)}</a>`
        : `<span class="muted">${esc(S.name)}</span>`, true],
      ['Level', num(s.level)],
      ['Mana', num(s.mana)],
      s.karma ? ['Karma required', (s.karma > 0 ? '≥ +' : '≤ ') + s.karma] : null,
      ['Targets', s.targets === null ? '<span class="muted">—</span>' : String(s.targets)],
      s.castTime !== null ? ['Cast time', `${s.castTime} ms`] : null,
      ['Spell number', s.num === null ? '<span class="muted">—</span>' : String(s.num)],
    ]);

    const tags = [
      s.school ? { text: S.name, cls: `school-${s.school}`, href: S.slug ? `../guides/${S.slug}.html` : null } : null,
      s.level ? { text: `Level ${s.level}` } : null,
      s.harmful ? { text: 'Harmful' } : null,
      s.outlaw ? { text: 'Outlaw cast' } : null,
      s.abstract ? { text: 'Not directly castable' } : null,
      !s.happyLand ? { text: 'Banned in safe zones' } : null,
    ].filter(Boolean);

    let body = heroBlock({
      icon: s.iconInfo, alt: s.name, title: s.name,
      lede: s.intro ? esc(cleanText(s.intro)) : null, tags,
    });

    body += facts;

    if (s.desc) body += `<div class="flavor">${esc(s.desc)}</div>`;

    // -------- costs
    body += `<h2>What it costs to cast</h2>`;
    const costRows = [
      { k: 'Mana', v: s.mana === null ? '—' : String(s.mana), n: 'Deducted by <code class="k">PayCosts</code>; the cast is refused if you are short.' },
      { k: 'Reagents', v: reagentLinks(s.reagents, db), n: s.reagents.length ? 'Consumed on a successful cast.' : 'This spell needs no material component.' },
      { k: 'Karma', v: s.karma ? (s.karma > 0 ? `at least +${s.karma}` : `at most ${s.karma}`) : 'no requirement', n: s.karma ? `Derived, not stored: <code class="k">GetRequiredKarma</code> returns level × ${s.school === 2 ? '−10' : '+10'} for this school.` : '' },
      { k: 'Exertion', v: s.exertion === null ? '—' : String(s.exertion), n: 'Vigor drained per cast.' },
      { k: 'Cast time', v: s.castTime ? `${s.castTime} ms trance` : 'instant', n: s.castTime ? 'You are locked in a casting trance for this long; taking damage can break it.' : '' },
      { k: 'Recovery', v: s.postCast === null ? '—' : `${s.postCast}`, n: 'Post-cast delay before the next action.' },
    ];
    body += dataTable(
      [{ key: 'k', label: 'Cost' }, { key: 'v', label: 'Value' }, { key: 'n', label: 'Notes' }],
      costRows.map((r) => ({ k: `<strong>${r.k}</strong>`, v: r.v, n: r.n })), { sortable: false });
    body += `<p class="cite">${esc(s.c.file)} · costs enforced in kod/object/passive/spell.kod:705 <code class="k">CanPayCosts</code>, charged at :1256 <code class="k">PayCosts</code></p>`;

    // -------- learning
    body += `<h2>Learning it</h2>`;
    if (s.teachers.length) {
      body += `<p>Taught by ${s.teachers.map((t) => {
        const k = cls(db, t);
        return `<a href="../creatures/${slugify(t)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : t)}</a>`;
      }).join(', ')}.</p>`;
    } else if (s.abstract) {
      body += `<p>Not a spell you learn. <code class="k">${esc(s.c.name)}</code> has no spell number, so it never appears in a spell list; it exists to be used by other spells, by items, or by monsters.</p>`;
    } else {
      body += `<p>No teacher in the current world data offers this spell. It may be granted by a quest, by an item, or reserved for monsters and administrators.</p>`;
    }

    // -------- what it does
    const own = s.c.messages.filter((m) => !/^(Constructed|Delete|SendAnimation|SendLookAnimation|SendInventoryAnimation)$/i.test(m.name));
    if (own.length) {
      body += `<h2>What it does</h2>`;
      body += `<p>The behaviour this class defines for itself, in the order the server runs it. The full text of each handler is reproduced below under <a href="#src">In the source</a>.</p>`;
      body += `<ul>` + own.map((m) => `<li><code class="k">${esc(m.name)}</code>${m.doc ? ' — ' + esc(cleanText(m.doc)) : ''}</li>`).join('') + `</ul>`;
    }

    if (groups.length > 1) {
      body += `<h2>Sprites</h2><div class="gallery">` +
        groups.map((g) => `<figure><img class="icon" src="${g.src}" alt="${esc(s.name)} group ${g.group}" loading="lazy"><figcaption>group ${g.group}${g.angles > 1 ? ` · ${g.angles} angles` : ''}</figcaption></figure>`).join('') +
        `</div>`;
    }

    body += `<hr><a id="src"></a>` + kodSource(db, s.c);

    return {
      slug: s.slug, title: s.name, html: body, kind: 'spell',
      desc: cleanText(s.intro || s.desc || '').slice(0, 160),
      icon: s.iconInfo ? s.iconInfo.src.replace('../', '') : null,
    };
  });

  // ---------------------------------------------------------------- index
  const columns = [
    { key: 'i', label: '' },
    { key: 'n', label: 'Spell' },
    { key: 's', label: 'School' },
    { key: 'l', label: 'Lvl', num: true },
    { key: 'm', label: 'Mana', num: true },
    { key: 'k', label: 'Karma', num: true },
    { key: 't', label: 'Targets', num: true },
    { key: 'r', label: 'Reagents' },
    { key: 'd', label: 'What it does' },
  ];
  const rows = real.map((s) => ({
    _attrs: ` data-school="${s.schoolInfo.name}" data-level="${s.level ?? ''}"`,
    i: s.iconInfo ? `<img class="icon rowicon" src="${s.iconInfo.src}" alt="" loading="lazy">` : '',
    n: `<a href="${s.slug}.html">${esc(s.name)}</a>`,
    s: s.school ? `<span class="tag school-${s.school}">${esc(s.schoolInfo.name)}</span>` : '',
    _s: s.schoolInfo.name,
    l: num(s.level), _l: s.level ?? 99,
    m: num(s.mana), _m: s.mana ?? 999,
    k: s.karma ? (s.karma > 0 ? '+' + s.karma : String(s.karma)) : '<span class="muted">—</span>', _k: s.karma,
    t: num(s.targets), _t: s.targets ?? 9,
    r: s.reagents.length ? s.reagents.map((r) => {
      const k = cls(db, r.cls);
      return esc(k ? (nameOf(db, k) || humanize(k.name)) : r.cls) + (r.count > 1 ? `×${r.count}` : '');
    }).join(', ') : '<span class="muted">—</span>',
    d: esc(cleanText(s.intro || s.desc || '').slice(0, 110)),
  }));

  const schoolCounts = {};
  for (const s of real) schoolCounts[s.schoolInfo.name] = (schoolCounts[s.schoolInfo.name] || 0) + 1;

  const indexHtml = `<h1>Spells</h1>
<p class="lede">${real.length} castable spells across six schools, plus ${spells.length - real.length}
spell classes with no spell number that exist only to be invoked by items, monsters or other
spells. Mana, reagents and the karma gate are declared in the server source and are never sent
over the wire — a client cannot tell you any of this, which is why the table exists.</p>

<div class="filterbar" data-for="spelltable">
  <input type="search" placeholder="filter…" aria-label="Filter spells">
  <select data-filter="school"><option value="">every school</option>${
    Object.keys(schoolCounts).sort().map((k) => `<option>${esc(k)}</option>`).join('')}</select>
  <select data-filter="level"><option value="">every level</option>${
    [...new Set(real.map((s) => s.level).filter((x) => x != null))].sort((a, b) => a - b)
      .map((l) => `<option>${l}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'spelltable' })}

<h2>How to read this</h2>
<p><strong>Karma</strong> is not a stored property of a spell. It is derived from school and
level by <code class="k">Spell.GetRequiredKarma</code>: Qor demands karma at or below
−10 × level, Shal’ille demands karma at or above +10 × level, and the other four schools
demand nothing. Karma runs −100 to +100, so a level-6 Qor spell needs you more than half way
to the floor — and locks you out of Shal’ille entirely.</p>
<p class="cite">kod/object/passive/spell.kod:482 · gate applied at :456 <code class="k">KarmaCheck</code></p>
<p>See <a href="../guides/spells.html">Spells and Spellcasting</a> for how the cast itself
resolves, <a href="../guides/reagents.html">Reagents</a> for where components come from, and
<a href="../guides/karma.html">Karma</a> for how to move your alignment.</p>`;

  return { indexHtml, pages };
}
