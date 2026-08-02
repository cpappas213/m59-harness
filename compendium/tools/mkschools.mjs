#!/usr/bin/env node
// mkschools.mjs -- write content/<school>.html for the five schools that are not
// Riija.  The prose is hand-written and lives here; the spell tables are derived
// from koddb.json so they cannot drift.  Run once, or again after a kod change.
//
//   node tools/mkschools.mjs
//
// Riija has its own hand-written page and is deliberately not regenerated.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadDB, descendants, ivar, nameOf, humanize, cls, slugify,
  findMessage, parseConsPairs, esc,
} from './lib.mjs';

const SCHOOLS = {
  1: {
    slug: 'shalille', title: "Shal’ille — the School of Compassion",
    lede: `Shal'ille is the healer, and the price of the school is your alignment: every spell in
it demands karma of at least ten times its level, so the deepest Shal'ille magic requires living
at +60 on a scale that runs to +100. In exchange it is the only school that can put health back
into another person, and its power grows both with the wildness of the place you stand in and
with how good you already are.`,
    polarity: 'Good — <code class="k">karma ≥ level × +10</code>',
    stat: 'Mysticism', division: 'Magic',
    power: [
      ['Primary, 0–30', `The room's natural setting, plus a bonus inside a
       <a href="../spells/forcesoflight.html">Forces of Light</a> enchantment`],
      ['Secondary, 0–10', `<code class="k">abs(karma) / 10</code> — the same karma that gates the
       school also powers it`],
    ],
    powerCite: 'kod/object/passive/spell.kod:2107–2124',
    notes: `<h2>What the school is for</h2>
<p><strong>Healing, and only this school does it.</strong>
<a href="../spells/heal.html">Minor heal</a> costs 3 mana and one herb, works on yourself or
another player, and is described in the game's own words as being "particularly potent on those
protected by guardian angels" — and it awards karma for healing another good soul, which feeds
straight back into your spell power.</p>
<p><strong>The undead.</strong> <a href="../spells/holysymbol.html">Holy symbol</a>,
<a href="../spells/holyweapon.html">holy weapon</a> and
<a href="../spells/detectevil.html">detect evil</a> are a package aimed at one category of enemy.
Holy weapon carries <code class="k">ATCK_SPELL_HOLY</code>, which most armour has no resistance
against at all — see <a href="armor.html">Armour</a>.</p>
<p><strong>Cleanup.</strong> Cure poison, cure disease, remove curse and purify undo the status
effects that would otherwise end a long expedition early.</p>
<div class="warn">The karma gate is checked <em>at cast time</em>. Drift below +60 and your
level-6 spells stop working, with no warning and no refund. Because killing evil creatures is
what pushes you positive, a Shal'ille caster who spends a session fighting neutral monsters
slowly loses access to their own school. See <a href="karma.html">Karma</a>.</div>`,
    playing: [
      `Karma is your ammunition. It gates the spells <em>and</em> feeds the secondary power bonus,
       so a devout caster is strictly stronger than a marginal one.`,
      `Cast outdoors where you can. The primary bonus is the room's natural setting, worth up to
       30 of the 99-point spell-power scale.`,
      `Mysticism buys nothing else in the game. If you are building a Shal'ille caster, that is
       the cost of entry — budget for it at creation, because it never changes.`,
      `Herbs and elderberries carry the low levels; see <a href="../reagents/index.html">Reagents</a>.`,
    ],
  },
  2: {
    slug: 'qor', title: 'Qor — the School of Corruption',
    lede: `Qor is the mirror of Shal'ille and costs the same thing in the opposite direction:
karma at or below minus ten times the spell's level, which means living at −60 for the deepest
magic. It is a night school in the most literal sense — its power is computed from the distance
between the current hour and noon — and it is the most expensive polarity in the game to hold,
because lawful merchants notice.`,
    polarity: 'Evil — <code class="k">karma ≤ level × −10</code>',
    stat: 'Mysticism', division: 'Magic',
    power: [
      ['Primary, 0–30', `<code class="k">2 + abs(hour − 12) × 2</code> — 2 at noon, 26 at
       midnight — plus a bonus inside a <a href="../spells/darkness.html">Darkness</a> enchantment`],
      ['Secondary, 0–10', `<code class="k">abs(karma) / 10</code>`],
    ],
    powerCite: 'kod/object/passive/spell.kod:2126–2144',
    notes: `<h2>What the school is for</h2>
<p><strong>Killing things.</strong> Qor holds the deepest directly offensive magic in the game,
and spell damage largely bypasses armour: the flat reduction every worn piece grants is set to
<em>zero</em> against a pure spell attack. A fighter's armour is his largest mitigation and it
mostly does not apply to you.</p>
<p class="cite">kod/object/item/passitem/defmod.kod:110–122</p>
<p><strong>Debilitation.</strong> The curse and poison lines take an enemy apart over time rather
than at once, which suits a caster who expects to be outlasted in a straight exchange.</p>
<div class="warn">Being at −60 karma has consequences outside the spell list. Creatures flagged
<code class="k">MOB_KARMA_AG</code> will leave you alone — a real defensive benefit — but lawful
merchants become difficult, and you are a legitimate target for anyone who wants to be a hero.</div>`,
    playing: [
      `<strong>Play at night.</strong> The primary bonus swings from 2 at midday to 26 at midnight
       on the server's clock. That is a quarter of the entire spell-power scale, for free, for
       choosing when to fight.`,
      `Karma feeds the secondary bonus as well as the gate, so a committed Qor caster is stronger
       than a hesitant one. Half-measures are the worst position on this axis.`,
      `Moving karma costs at most 1.5 points per monster kill, and only creatures with a positive
       karma value move you downward. Plan for dozens of kills, not a session.`,
      `<a href="../spells/darkness.html">Darkness</a> is worth casting first: it raises the
       primary bonus for everything you cast inside it.`,
    ],
  },
  3: {
    slug: 'kraanan', title: 'Kraanan — the School of War',
    lede: `Kraanan is the school for people who were going to be fighting anyway. It is the only
one whose requisite attribute is stamina — which is also your health ceiling — and the only one
that halves the spellcasting penalty from worn armour. Its power comes from the crowd around you
and from your own health, which means it is strongest exactly where a warrior wants to be:
healthy, and in the middle of a battle.`,
    polarity: 'Neutral — no karma requirement at any level',
    stat: 'Stamina', division: 'Combat',
    power: [
      ['Primary, 0–30', 'The number of active beings in the room — a crowded fight'],
      ['Secondary, 0–10', '<code class="k">health × 10 / max_health</code> — full health, full bonus'],
    ],
    powerCite: 'kod/object/passive/spell.kod:2168–2184',
    notes: `<h2>Why it is the fighter's school</h2>
<p>Three separate concessions stack up, and together they make Kraanan the only school a heavily
armoured character can carry without compromise:</p>
<ul>
<li><strong>Stamina is its requisite attribute</strong>, and stamina is also
<code class="k">101 + stamina</code> — your permanent maximum health. Every other school asks you
to buy an attribute that does nothing else. Kraanan asks you to buy the one you wanted anyway.</li>
<li><strong>Negative item modifiers are halved.</strong> The source says why in as many words:
"Kraanan, being a combat school, doesn't take penalties from items as much." Plate armour costs
a Faren caster its full spell penalty and a Kraanan caster half of it.</li>
<li><strong>Its power scales with company.</strong> Alone in a corridor, Kraanan is weak. In a
melee with six other combatants, the primary bonus is doing real work.</li>
</ul>
<p class="cite">kod/object/passive/spell.kod:2168–2184</p>
<div class="warn">The health-based secondary bonus cuts the wrong way in a losing fight. At half
health your bonus is halved, so Kraanan gets weaker exactly as things get worse. It is a school
for winning fights, not for surviving them.</div>`,
    playing: [
      `Fight in company. The primary bonus counts bodies in the room, and it is worth up to 30 of
       the 99-point scale.`,
      `Top up before you cast, not after. The secondary bonus is proportional to current health.`,
      `You can wear real armour. Read <a href="armor.html">Armour</a> for the spell penalty each
       piece carries, then halve it.`,
      `Stamina does double duty here, which makes Kraanan the cheapest school in the game to
       build for. See <a href="attributes.html">Attributes</a>.`,
    ],
  },
  4: {
    slug: 'faren', title: 'Faren — the School of Nature',
    lede: `Faren is the elementalist: water and fire, and the room you are standing in decides how
much of either you have. It is neutral, so it costs nothing in alignment, and its secondary power
comes from vigour — the one resource in the game that refills by resting rather than by spending
money.`,
    polarity: 'Neutral — no karma requirement at any level',
    stat: 'Mysticism', division: 'Magic',
    power: [
      ['Primary, 0–30', "The room's water and fire, via <code class=\"k\">GetFarenBonus</code>"],
      ['Secondary, 0–10', '<code class="k">vigour / 20</code>'],
    ],
    powerCite: 'kod/object/passive/spell.kod:2161–2167',
    notes: `<h2>What the school is for</h2>
<p><strong>Elemental damage.</strong> Faren's attack spells carry
<code class="k">ATCK_SPELL_FIRE</code>, <code class="k">ATCK_SPELL_COLD</code> and
<code class="k">ATCK_SPELL_SHOCK</code>. That matters twice over: armour's flat damage reduction
does not apply to pure spell damage at all, and the typed resistances that <em>do</em> apply are
carried by a handful of rings — see <a href="../armor/index.html">Armour</a> for exactly which.</p>
<p><strong>Terrain.</strong> Alone among the schools, Faren's primary bonus rewards you for
reading the room before you pick a fight. The same spell is meaningfully stronger beside water or
fire than in a bare corridor.</p>
<div class="note">Vigour is the cheapest secondary bonus in the game to keep topped up — it comes
back with rest, and faction membership reduces every exertion cost by up to 30%, which keeps it
higher for free. See <a href="factions.html">Factions</a>.</div>`,
    playing: [
      `Look at where you are standing. Up to 30 points of spell power are in the terrain.`,
      `Rest before you engage. Vigour is the secondary bonus and it is free.`,
      `Faren's elemental types are resisted by specific rings rather than by armour, so a target
       who has prepared for fire is not necessarily prepared for cold.`,
      `Mysticism is the entry cost and buys nothing else — budget for it at creation.`,
    ],
  },
  6: {
    slug: 'jala', title: 'Jala — the School of Song',
    lede: `Jala is the bard's school, and it makes the single largest trade in the game: its power
bonus can reach 40 — higher than any other school's ceiling — but only while you are holding an
instrument, which means you are not holding a weapon. Everything about Jala follows from that one
exchange.`,
    polarity: 'Neutral — no karma requirement at any level',
    stat: 'Intellect', division: 'Lore',
    power: [
      ['Primary, up to 40', `The level of the instrument you are wielding. The source explains the
       larger ceiling: the good instruments "are harder to find and interfere with normal combat"`],
      ['Secondary, 0–10', '<code class="k">max_health / 12</code>'],
    ],
    powerCite: 'kod/object/passive/spell.kod:2186–2196',
    notes: `<h2>The trade</h2>
<p>Every other school's primary bonus comes from the world and is bounded at 30. Jala's comes
from an object you must carry in your hands and reaches 40. You cannot wield an instrument and a
weapon at once, so a Jala caster's melee is whatever
<a href="../skills/brawling.html">brawling</a> and <a href="../skills/punch.html">punch</a> give
them — and those two skills are exactly what the unarmed branch of the offence calculation reads.</p>
<p class="cite">kod/object/active/holder/nomoveon/battler/player.kod:4253–4256</p>
<p>The secondary bonus is maximum health over 12, which is the only place in the game where the
health progression feeds a magical one. A Jala caster who has advanced to 120 maximum health is
carrying the full 10-point secondary bonus; one at 60 is carrying half of it.</p>
<h2>What the school is for</h2>
<p>Jala's spells work on <em>other people</em> — mood, loyalty, perception, morale — and on the
room rather than on a single target. It is the school with the most effect on a group and the
least on a duel. The Jala <em>hinder</em> spells reach into another caster's success calculation
directly, altering their chance before their roll is made.</p>
<p class="cite">kod/object/passive/spell.kod:1195–1208 — <code class="k">SuccessChance</code> consults the room's Jala state</p>`,
    playing: [
      `Your instrument is your spell power. Upgrading it is worth more than most levels of
       ability, because ability is halved before it enters the calculation and the instrument
       bonus is not.`,
      `Accept that you will not melee. Build for it: intellect for the school, stamina for the
       secondary bonus and for staying alive.`,
      `Intellect pays three times — Jala's success floor, the first learning gate for everything
       you own, and reduced atrophy. It is the best requisite attribute in the game.`,
      `Jala is a party school. Its value shows up in what the group can do, which means it is a
       poor choice for a character who plays alone.`,
    ],
  },
};

const db = loadDB();

// Collect the spells of each school straight out of the class database.
const rows = {};
for (const c of descendants(db, 'Spell')) {
  const s = ivar(db, c, 'viSchool');
  if (!SCHOOLS[s]) continue;
  if (ivar(db, c, 'viSpell_num') === null) continue;
  const m = findMessage(db, c, 'ResetReagents');
  (rows[s] = rows[s] || []).push({
    lvl: ivar(db, c, 'viSpell_level') || 0,
    name: nameOf(db, c) || humanize(c.name),
    slug: slugify(c.name),
    mana: ivar(db, c, 'viMana'),
    cast: ivar(db, c, 'viCast_time'),
    reag: (m ? parseConsPairs(m.body) : []).map((r) => {
      const k = cls(db, r.cls);
      return (k ? (nameOf(db, k) || humanize(k.name)) : r.cls) + (r.count > 1 ? ` ×${r.count}` : '');
    }).join(', '),
  });
}

for (const [num, S] of Object.entries(SCHOOLS)) {
  const list = (rows[num] || []).sort((a, b) => a.lvl - b.lvl || a.name.localeCompare(b.name));
  const table = list.map((r) =>
    `<tr><td>${r.lvl}</td><td><a href="../spells/${r.slug}.html">${esc(r.name)}</a></td>` +
    `<td>${r.mana ?? '—'}</td><td>${r.cast ? r.cast.toLocaleString('en-US') + ' ms' : 'instant'}</td>` +
    `<td>${esc(r.reag) || 'none'}</td></tr>`).join('\n');
  const levels = [...new Set(list.map((r) => r.lvl))].sort((a, b) => a - b);

  const html = `<h1>${esc(S.title)}</h1>

<p class="lede">${S.lede}</p>

<h2>Where ${esc(S.title.split(' —')[0])} stands</h2>
<table class="data">
<tbody>
<tr><td>Polarity</td><td>${S.polarity}</td></tr>
<tr><td>Requisite attribute</td><td><strong>${S.stat}</strong></td></tr>
<tr><td>Learning division</td><td>${S.division}</td></tr>
<tr><td>Spells</td><td>${list.length}, across levels ${levels[0]}–${levels[levels.length - 1]}</td></tr>
</tbody>
</table>
<p class="cite">kod/object/passive/spell.kod:376 <code class="k">GetDivision</code>, :392 <code class="k">GetDivisionReq</code>, :482 <code class="k">GetRequiredKarma</code></p>

<h2>Where its power comes from</h2>
<p>Spell power is half your ability in the spell plus the bonuses below, on a scale of 1 to 99.
It decides your success chance, your mana cost, your casting speed and the strength of the
effect — see <a href="spells.html">Spells and Spellcasting</a>.</p>
<table class="data">
<thead><tr><th>Bonus</th><th>Source</th></tr></thead>
<tbody>
${S.power.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('\n')}
</tbody>
</table>
<p class="cite">${S.powerCite}</p>

${S.notes}

<h2>Every ${esc(S.title.split(' —')[0])} spell</h2>
<table class="data">
<thead><tr><th>Lvl</th><th>Spell</th><th>Mana</th><th>Cast time</th><th>Reagents</th></tr></thead>
<tbody>
${table}
</tbody>
</table>
<p class="cite">Compiled from every <code class="k">Spell</code> subclass declaring this school. Per-spell citations are on each spell's own page.</p>

<h2>Playing it</h2>
<ul>
${S.playing.map((p) => `<li>${p}</li>`).join('\n')}
</ul>

<h2>Related</h2>
<p><a href="schools.html">The Six Schools</a> · <a href="spells.html">How casting works</a> ·
<a href="../spells/index.html">Every spell</a> · <a href="../reagents/index.html">Reagents</a> ·
<a href="karma.html">Karma</a> · <a href="attributes.html">Attributes</a> ·
<a href="advancing.html">Advancing Your Character</a></p>
`;

  const out = path.join(ROOT, 'content', `${S.slug}.html`);
  fs.writeFileSync(out, html);
  console.log(`${S.slug}: ${list.length} spells`);
}
