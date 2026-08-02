// derive/skills.mjs -- one page per skill, plus the skill index.
//
// Skills and spells are near-identical machinery in this game: both are passive
// objects with a number, a school, a level, an exertion cost and an ability that
// grows with use.  The difference is that a skill costs vigour rather than mana
// and is never gated on karma.

import {
  esc, slugify, cleanText, humanize, cls, descendants, ivar, rvar, nameOf, descOf,
  findMessage, ownMessage, constNames, iconFor, spriteGroups,
  factGrid, dataTable, tagList, kodSource, num, heroBlock,
} from '../lib.mjs';
import { teacherIndex } from './spells.mjs';

export const meta = {
  id: 'skills', title: 'Skills', dir: 'skills', order: 2, nav: true,
  blurb: 'Every skill: what it does, what it costs, who teaches it and how it improves.',
};

// A skill's "school" is a discipline, not one of the six magical schools.
function schoolName(db, n) {
  if (n === null) return null;
  const c = constNames(db, 'SKS_', n)[0];
  return c ? c.replace('SKS_', '').toLowerCase() : String(n);
}

// The three families, which behave differently in play.
function familyOf(c) {
  if (c.chain.includes('Stroke')) return 'stroke';
  if (c.chain.includes('Proficiency')) return 'proficiency';
  return 'skill';
}

const FAMILY_NOTE = {
  stroke: `A <strong>stroke</strong> is a way of swinging. You do not invoke it; the weapon
picks one, and its ability decides both how often you connect and how hard. Improving a stroke
improves every weapon that uses it.`,
  proficiency: `A <strong>proficiency</strong> is a weapon class. It contributes to your
chance to hit and adds a small flat bonus to damage — <code class="k">(proficiency + 1) × 5 / 100</code>
per swing — and it is what the weapon checks before you can use it well at all.`,
  skill: `A <strong>skill</strong> proper is something you invoke, or that fires automatically
when its condition is met. It costs vigour, it can fail, and its ability is both the success
chance and the size of the effect.`,
};

// Which weapon classes route to this stroke or proficiency.
function weaponUsers(db, skillNum, kind) {
  const out = [];
  for (const w of descendants(db, 'Weapon')) {
    if (kind === 'proficiency') {
      if (ivar(db, w, 'viProficiency_needed') === skillNum) out.push(w);
    } else {
      const m = ownMessage(w, 'GetDefaultStrokeNumber') || findMessage(db, w, 'GetDefaultStrokeNumber');
      if (!m) continue;
      const g = /return\s+(SKID_[A-Za-z0-9_]+)/i.exec(m.body);
      if (!g) continue;
      const names = constNames(db, 'SKID_', skillNum).map((x) => x.toUpperCase());
      if (names.includes(g[1].toUpperCase())) out.push(w);
    }
  }
  return out;
}

export function build({ db, images }) {
  const teachers = teacherIndex(db).bySkill;
  const skills = descendants(db, 'Skill').sort((a, b) => a.name.localeCompare(b.name));

  const recs = skills.map((c) => {
    const numv = ivar(db, c, 'viSkill_num');
    const skidNames = numv === null ? [] : constNames(db, 'SKID_', numv);
    const family = familyOf(c);
    return {
      c, family,
      name: nameOf(db, c) || humanize(c.name),
      slug: slugify(c.name),
      num: numv, skid: skidNames[0] || null,
      school: ivar(db, c, 'viSchool'),
      schoolName: schoolName(db, ivar(db, c, 'viSchool')),
      level: ivar(db, c, 'viSkill_level'),
      chanceUp: ivar(db, c, 'viChance_to_Increase'),
      exertion: ivar(db, c, 'viskillExertion'),
      checkExertion: ivar(db, c, 'vbCheck_Exertion') !== 0,
      automatic: ivar(db, c, 'vbAutomatic') === 1,
      hitFactor: ivar(db, c, 'viHit_Factor'),
      damageFactor: ivar(db, c, 'viDamage_factor'),
      maxProfDamage: ivar(db, c, 'viMaxProficiencyDamage'),
      desc: descOf(db, c),
      intro: (rvar(db, c, 'vrSkill_intro') || {}).value || null,
      icon: iconFor(db, images, c),
      teachers: skidNames[0] && teachers.get(skidNames[0]) ? [...teachers.get(skidNames[0])] : [],
      weapons: numv === null ? [] : weaponUsers(db, numv, family),
      abstract: numv === null,
    };
  });

  const pages = recs.map((r) => {
    const c = r.c;
    const tags = [
      { text: r.family },
      r.schoolName ? { text: r.schoolName } : null,
      r.level ? { text: `Level ${r.level}` } : null,
      r.automatic ? { text: 'Automatic' } : null,
    ].filter(Boolean);

    let body = heroBlock({
      icon: r.icon, title: r.name, tags,
      lede: r.intro ? esc(cleanText(r.intro)) : null,
    });

    body += factGrid([
      ['Discipline', r.schoolName ? esc(r.schoolName) : '<span class="muted">—</span>', true],
      ['Level', num(r.level)],
      ['Vigour per use', num(r.exertion)],
      ['Improve chance', r.chanceUp === null ? '<span class="muted">—</span>' : `${r.chanceUp}%`],
      ['Skill number', num(r.num)],
      r.hitFactor !== null ? ['Hit factor', String(r.hitFactor)] : null,
      r.damageFactor !== null ? ['Damage factor', `${r.damageFactor}%`] : null,
    ]);

    if (r.desc) body += `<div class="flavor">${esc(r.desc)}</div>`;

    body += `<h2>What kind of skill this is</h2><p>${FAMILY_NOTE[r.family]}</p>`;

    if (r.damageFactor !== null || r.hitFactor !== null) {
      body += `<h2>What it is worth in a fight</h2>`;
      const parts = [];
      if (r.damageFactor !== null) {
        parts.push(`<div class="formula">damage = weapon_base × ${r.damageFactor} / 100</div>
<p class="cite">kod/object/passive/skill/stroke.kod:210 <code class="k">FindDamage</code></p>`);
      }
      if (r.hitFactor !== null) {
        parts.push(`<p>Its hit factor is <code class="k">${r.hitFactor}</code>; the default for a stroke
is 100, so this stroke is ${r.hitFactor > 100 ? 'easier' : r.hitFactor < 100 ? 'harder' : 'exactly as easy'}
to land than an ordinary one.</p>
<p class="cite">kod/object/passive/skill/stroke.kod:61</p>`);
      }
      if (r.maxProfDamage !== null) {
        parts.push(`<p>Proficiency adds at most <code class="k">(99 + 1) × ${r.maxProfDamage} / 100 = ${Math.trunc((100 * r.maxProfDamage) / 100)}</code>
damage at a perfect ability of 99.</p>
<p class="cite">kod/object/passive/skill/stroke.kod:342</p>`);
      }
      body += parts.join('\n');
    }

    if (r.weapons.length) {
      body += `<h2>Weapons that use it</h2><p>` + r.weapons
        .map((w) => `<a href="../items/${slugify(w.name)}.html">${esc(nameOf(db, w) || humanize(w.name))}</a>`)
        .join(', ') + `</p>`;
    }

    body += `<h2>Learning and improving it</h2>`;
    if (r.teachers.length) {
      body += `<p>Taught by ` + r.teachers.map((t) => {
        const k = cls(db, t);
        return `<a href="../creatures/${slugify(t)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : t)}</a>`;
      }).join(', ') + `.</p>`;
    } else if (r.abstract) {
      body += `<p>This class has no skill number, so it is never taught and never appears in your
ability list. It exists as a base class for the ones that are.</p>`;
    } else {
      body += `<p>No teacher in the world data offers this skill. It is either granted at creation,
awarded by a quest, or reserved for monsters.</p>`;
    }
    if (!r.abstract) {
      body += `<p>Ability runs 0–99 and rises by <em>use against something hard enough to matter</em>,
with a ${r.chanceUp ?? '—'}% roll on each qualifying use. It also atrophies: stop using a skill and
the number falls. See <a href="../guides/advancing.html">Advancing Your Character</a>.</p>`;
    }

    const own = c.messages.filter((m) => !/^(Constructed|Delete|Send\w*Animation)$/i.test(m.name));
    if (own.length) {
      body += `<h2>What it does</h2><ul>` + own.map((m) =>
        `<li><code class="k">${esc(m.name)}</code>${m.doc ? ' — ' + esc(cleanText(m.doc)) : ''}</li>`).join('') + `</ul>`;
    }

    body += `<hr>` + kodSource(db, c);

    return {
      slug: r.slug, title: r.name, html: body, kind: 'skill',
      desc: cleanText(r.intro || r.desc || '').slice(0, 160),
      icon: r.icon ? r.icon.src.replace('../', '') : null,
    };
  });

  const real = recs.filter((r) => !r.abstract);
  const columns = [
    { key: 'i', label: '' },
    { key: 'n', label: 'Skill' },
    { key: 'f', label: 'Family' },
    { key: 's', label: 'Discipline' },
    { key: 'l', label: 'Lvl', num: true },
    { key: 'v', label: 'Vigour', num: true },
    { key: 'c', label: 'Improve', num: true },
    { key: 't', label: 'Taught by' },
    { key: 'd', label: 'What it does' },
  ];
  const rows = real.map((r) => ({
    _attrs: ` data-family="${esc(r.family)}"`,
    i: r.icon ? `<img class="icon rowicon" src="${r.icon.src}" alt="" loading="lazy">` : '',
    n: `<a href="${r.slug}.html">${esc(r.name)}</a>`,
    f: esc(r.family), _f: r.family,
    s: r.schoolName ? esc(r.schoolName) : '<span class="muted">—</span>',
    l: num(r.level), _l: r.level ?? 99,
    v: num(r.exertion), _v: r.exertion ?? 0,
    c: r.chanceUp === null ? '<span class="muted">—</span>' : `${r.chanceUp}%`, _c: r.chanceUp ?? 0,
    t: r.teachers.length ? r.teachers.map((t) => {
      const k = cls(db, t);
      return `<a href="../creatures/${slugify(t)}.html">${esc(k ? (nameOf(db, k) || humanize(k.name)) : t)}</a>`;
    }).join(', ') : '<span class="muted">—</span>',
    d: esc(cleanText(r.intro || r.desc || '').slice(0, 100)),
  }));

  const indexHtml = `<h1>Skills</h1>
<p class="lede">${real.length} skills, in three families that behave completely differently:
strokes decide how your weapon swings, proficiencies decide how well you handle a class of
weapon, and skills proper are things you invoke. All three share one number — an ability from
0 to 99 that rises with use and falls with neglect.</p>

<h2>The three families</h2>
<dl>
<dt>Stroke</dt><dd>${FAMILY_NOTE.stroke}</dd>
<dt>Proficiency</dt><dd>${FAMILY_NOTE.proficiency}</dd>
<dt>Skill</dt><dd>${FAMILY_NOTE.skill}</dd>
</dl>
<p class="cite">kod/object/passive/skill.kod · kod/object/passive/skill/stroke.kod · kod/object/passive/skill/profic</p>

<h2>What ability is worth</h2>
<p>Ability enters combat in three places, and it is worth knowing which, because they are not
equally valuable. Your <em>stroke</em> ability is multiplied by 3 in your offence; your
<em>proficiency</em> by 2; your aim by 4. Defence weights dodge by 3, parry by 2 and block by 1.</p>
<div class="formula">offence = stroke×3 + proficiency×2 + aim×4 + max_health×3/2
defence = parry×2 + block×1 + dodge×3 + agility×4 + max_health×3/2
chance to hit = bound(attacker_offence × 55 / defender_defence, 10, 95)  %</div>
<p class="cite">kod/object/active/holder/nomoveon/battler/player.kod:4227 and :4294 · kod/object/active/holder/nomoveon/battler.kod:19,330</p>
<p>The consequence: <strong>dodge is the single most valuable defensive skill</strong> and it
needs no equipment, while block requires a shield and parry requires a weapon in hand.</p>

<div class="filterbar" data-for="skilltable">
  <input type="search" placeholder="filter…" aria-label="Filter skills">
  <select data-filter="family"><option value="">every family</option><option>stroke</option><option>proficiency</option><option>skill</option></select>
  <span class="count"></span>
</div>
${dataTable(columns, rows, { id: 'skilltable' })}

<p>See <a href="../guides/combat.html">Combat</a> for how these numbers resolve a swing, and
<a href="../guides/advancing.html">Advancing Your Character</a> for how to raise them.</p>`;

  return { indexHtml, pages };
}
