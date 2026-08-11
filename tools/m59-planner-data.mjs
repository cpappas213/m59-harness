#!/usr/bin/env node
// THE DATA A CHARACTER PLANNER NEEDS, DERIVED FROM THE KOD RATHER THAN TYPED IN.
//
//   node tools/m59-planner-data.mjs            # write compendium/data/planner.json
//   node tools/m59-planner-data.mjs --print    # show what it found, write nothing
//
// Everything here comes from compendium/data/koddb.json (all 1232 kod classes) and
// substrate/m59-spells.json. Nothing is hand-entered, because a planner that disagrees
// with the server is worse than no planner — it produces confident wrong builds.
//
// WHAT THIS IS FOR. The compendium's bestiary already recalculates against a live
// character. A planner is the other direction: what could this character become, and
// what does each point of a stat buy. Three questions it has to answer, all of which
// need the same table:
//
//   * which skills key off which stat, so hovering a stat can highlight them
//   * which spells sit at which level of which school, so the INT table can name them
//   * what a new level costs, so the INT table means something
//
// THE REQUISITE STAT IS CASE-INSENSITIVE AND INHERITED, AND BOTH MATTER.
//
// Skills declare `GetRequisiteStat` returning @GetMight, @GetAim and so on — but the
// kod is inconsistently cased and brawling writes `@getmight` in lower case. A
// case-sensitive match silently falls through to the parent chain and lands on the base
// Skill class, which answers Agility. That produced a table saying brawling is an
// agility skill, which is wrong and reads perfectly plausibly: 18 agility skills, 3 aim,
// 1 stamina. The corrected table is 13 agility, 4 aim, 4 might, 1 stamina — and the four
// might skills are exactly the heavy-weapon ones you would expect.
//
// So: match case-insensitively, and walk the parent chain only when the class itself is
// silent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
// The compendium's own readers, imported rather than reimplemented. Class variables
// INHERIT — `viWeight` is declared on a parent for most of the 324 item classes — and a
// second implementation of that walk is how the item table ends up disagreeing with the
// item pages it sits next to.
import { loadImages, descendants, ivar, nameOf, descOf, humanize,
         iconFor, ownMessage, findMessage, parseConsPairs, cleanText } from
       '../compendium/tools/lib.mjs';
// The stats pane's own table. See the stats section below.
import { STATS } from '../compendium/tools/statpane.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PRINT_ONLY = !!arg('print', false);

const here = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const KODDB = here('../compendium/data/koddb.json');
const SPELLS = here('../substrate/m59-spells.json');
const OUT = here('../compendium/data/planner.json');

const db = JSON.parse(readFileSync(KODDB, 'utf8'));
const classes = db.classes || {};
const spellFile = JSON.parse(readFileSync(SPELLS, 'utf8'));

// ---------------------------------------------------------------- stats

// The six a player rolls, named as the kod names them, because every lookup below keys off
// that spelling. Out of compendium/tools/statpane.mjs rather than declared here: the
// planner's stats pane and the fleet's /stats board both draw from that file, and a label
// or an order that lived in two places would eventually be two different panes.

// ------------------------------------------------- skills and their requisite stat

const lower = (s) => String(s || '').toLowerCase();

// Walk the chain, but only past classes that are SILENT on the question. A class that
// answers gets the answer — that is the whole point of the override.
function requisiteStat(className) {
  let c = classes[lower(className)];
  for (let hops = 0; c && hops < 12; hops++) {
    const m = (c.messages || []).find(x => lower(x.name) === 'getrequisitestat');
    if (m) {
      const g = String(m.body || '').match(/@get([a-z]+)/i);
      if (g) return lower(g[1]);
    }
    c = c.parent ? classes[lower(c.parent)] : null;
  }
  return null;
}

// The display name lives in a resource, not the class name: `maceproficiency` is shown
// as "mace fighting". Getting this wrong is the trap CLAUDE.md documents — seven of the
// eight weapon proficiencies were called something invented for a long time.
function displayName(key, c) {
  const rsc = c.resources || {};
  const named = rsc[`${key}_name_rsc`] || Object.entries(rsc).find(([k]) => /_name_rsc$/.test(k))?.[1];
  return named?.value || c.name || key;
}

// HOW MANY LEVELS THERE ARE, read before anything that needs to know. `vlLevelPoints` is
// set in System's own Constructor rather than declared as a classvar, so it is recovered
// from the message body (system.kod:414). Six entries, and both the schools table and the
// "is this a real skill level or a sentinel" test below depend on knowing that.
const sys = classes['system'];
const levelPointsBody = (sys?.messages || []).map(m => String(m.body || ''))
  .find(b => /vlLevelPoints\s*=\s*\[/.test(b));
const levelPoints = levelPointsBody
  ? JSON.parse(levelPointsBody.match(/vlLevelPoints\s*=\s*(\[[^\]]*\])/)[1])
  : null;

const skills = [];
for (const [key, c] of Object.entries(classes)) {
  if (!/\/skill\//.test(c.file || '')) continue;
  if (lower(c.name) === 'skill') continue;               // the base class is not a skill
  const stat = requisiteStat(key);
  // A CLASS WITH CHILDREN IS A CATEGORY, NOT A SKILL. `proficiency` has eight children
  // and an icon of its own, and reads exactly like a learnable skill until you notice
  // every weapon proficiency inherits from it. Offering it in a planner would let
  // someone spend points on something no trainer teaches. Kept rather than dropped,
  // because the grouping is what the weapon skills hang off.
  const abstract = (c.children || []).length > 0;
  skills.push({
    key,
    name: displayName(key, c),
    requisite_stat: stat,
    // THE SEVENTH TRACK. PlayerCanLearn sums `GetLevelLearnPoints` over the six schools AND
    // over `iWeapon` — the highest `viSkill_level` of any skill known, all of them pooled
    // (player.kod:10692) — so a character that has been learning proficiencies pays more for
    // its next spell. Without this the planner understates every such build, and it does so
    // in the direction that looks affordable.
    //
    // LEVEL 50 IS A SENTINEL, NOT A LEVEL. assess, thrust and kick declare
    // `viSkill_level = 50` and the game has six levels. `Skill.GetValue` (skill.kod:128)
    // doubles per level, so the "price" is 250 * 2^50 — nobody buys one, which is the point:
    // they are granted, not sold. Emitting that number would have put 281474976710656000sh
    // on a page as though it were a price.
    //
    // It matters for the COST too, and in the direction nobody would guess.
    // `GetLevelLearnPoints(50)` is `Nth(vlLevelPoints, 50)` on a six-element list, and Nth
    // past the end returns NIL after logging "Nth can't go past end of list"
    // (blakserv/list.c:178). So a character that knows thrust has iWeapon = 50 and its
    // weapon track contributes NOTHING — including hiding the proficiency levels it would
    // otherwise have been charged for. `levelPointsAt` reproduces that by returning 0 above
    // the table rather than clamping to the last entry, which would have been the natural
    // thing to write and would have been wrong.
    ...(() => {
      const l = ivar(db, c, 'viSkill_level');
      const real = l != null && levelPoints != null && l >= 1 && l <= levelPoints.length;
      return {
        level: l,
        for_sale: real,
        price: real ? 250 * 2 ** l : null,
        level_note: l != null && !real
          ? `viSkill_level is ${l} and the game has ${levelPoints?.length ?? '?'} levels — a `
            + 'sentinel for "granted, not sold". It contributes nothing to the learning cost '
            + 'because Nth falls off the end of vlLevelPoints and returns nil.'
          : null,
      };
    })(),
    abstract,
    learnable: !abstract,
    parent: c.parent || null,
    file: c.file || null,
    description: (c.resources || {})[`${key}_desc_rsc`]?.value
              || (c.resources || {})[`${key}_desc_text_rsc`]?.value || null,
  });
}
skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));

// ---------------------------------------------------------------- spells

// 175 rows in the file; the ones with a school and a level are the learnable ones. The
// rest are internals (TouchAttackSpell and friends) and DM commands.
const allSpells = spellFile.spells || [];
const spells = allSpells
  .filter(s => s.level != null && s.school_name && s.school_name !== 'none' && s.school_name !== 'DM command')
  .map(s => ({
    name: s.name,
    school: s.school_name,
    level: s.level,
    mana: s.mana ?? null,
    reagents: (s.reagents || []).map(r => ({ item: r.item, count: r.count })),
    prerequisites: s.prerequisites || [],
    required_karma: s.required_karma ?? 0,
    min_hit_points: s.min_hit_points ?? 0,
    // Casting keys off Mysticism for every school; the school itself does not change
    // that. Recorded per spell anyway so the planner never has to assume it.
    casting_stat: 'mysticism',
  }))
  .sort((a, b) => a.school.localeCompare(b.school) || a.level - b.level
                  || String(a.name).localeCompare(String(b.name)));

const schools = [...new Set(spells.map(s => s.school))].sort();

// -------------------------------------------------- what each stat is worth, both ways

// The index the planner's hovers read: for a stat, everything that keys off it.
const byStat = {};
for (const k of Object.keys(STATS)) byStat[k] = { skills: [], schools: [], spell_levels: [] };
// Only learnable skills go in the stat index — a hover that highlights a category
// nobody can train is noise.
for (const s of skills) if (s.learnable && s.requisite_stat && byStat[s.requisite_stat])
  byStat[s.requisite_stat].skills.push(s.name);
// Every school's spells cast off mysticism, so mysticism carries all of them. Stated as
// data rather than left implicit, because "which schools benefit from this stat" is a
// question the planner asks of every stat and the answer for five of them is "none".
byStat.mysticism.schools = schools.slice();
// Intellect is the exception that is easy to state wrongly: it is not a requisite stat
// for any single skill, and it benefits ALL of them, which is why it never appears in
// the per-skill table and must be described separately.
byStat.intellect.applies_to_everything =
  'Raises the improvement rate of every skill and every spell, and sets how many school '
  + 'levels can be learned over the character\'s lifetime. It is not the requisite stat '
  + 'of any individual skill, so it will never appear in the per-skill column.';

// ------------------------------------------------ what a level costs, and what INT buys

// From player.PlayerCanLearn:
//
//   iPoints = sum over the seven tracks (weapon skills + the six schools) of
//             GetLevelLearnPoints(highest level known in that track)
//   iNeed   = iPoints * POINTS_SLOPE
//           + (297 - MaxLearnPoints * POINTS_SLOPE)
//           - (RawIntellect * 2 * POINTS_SLOPE / 5)
//   iNeed   = bound(iNeed, MIN_NEEDED_TO_ADVANCE, $)
//
// so each point of intellect buys (2 * POINTS_SLOPE / 5) advancement points off the
// cost of the next level, and the cost rises with how much is already known.
// THREE CONSTANTS ARE NOT IN THE SNAPSHOT AND ARE READ OUT OF THE SOURCE FILE INSTEAD.
//
// POINTS_SLOPE and MIN_NEEDED_TO_ADVANCE are `constants:` in player.kod, and
// piMaxLearnPoints is a classvar on Settings. None of the three is in koddb's constant
// table — the builder folds `.khd` includes and not a class's own `constants:` block —
// so the first version of this file exported them as nulls and said, correctly, that a
// planner must refuse to draw a cost curve without them.
//
// It does not have to refuse: the tree they live in is the same tree every citation on
// this site points into, so they are read from it directly, with the line they came from
// carried alongside. A GREP IS NOT A PARSE, and that is the whole risk here — so each one
// is anchored to its own declaration syntax, and anything that does not match exactly
// stays null and goes back on the unresolved list rather than defaulting to a plausible
// number. A wrong slope produces a cost curve that looks authoritative and is invented,
// which is strictly worse than no curve at all.
const M59 = process.env.M59_ROOT || 'C:/code/Meridian59';
const PLAYER_KOD = path.join(M59, 'kod/object/active/holder/nomoveon/battler/player.kod');
const SETTINGS_KOD = path.join(M59, 'kod/util/settings.kod');

function constantFrom(file, re, label) {
  if (!existsSync(file)) return { value: null, cite: null, why: `${file} is not here` };
  const text = readFileSync(file, 'utf8');
  const m = re.exec(text);
  if (!m) return { value: null, cite: null, why: `${label} did not match its declaration in ${path.basename(file)}` };
  const line = text.slice(0, m.index).split('\n').length;
  return { value: Number(m[1]), cite: `${path.relative(M59, file).replace(/\\/g, '/')}:${line}`, why: null };
}

// `^[ \t]*` and NOT `^\s*`. `\s` matches a newline, so on a declaration preceded by a
// blank line the match starts one line early and every citation this file emits is off by
// one — which is the one kind of wrong a citation must never be, because it points at a
// real line that says something else and reads as verified.
const POINTS_SLOPE = constantFrom(PLAYER_KOD, /^[ \t]*POINTS_SLOPE[ \t]*=[ \t]*(-?\d+)/m, 'POINTS_SLOPE');
const MIN_NEEDED = constantFrom(PLAYER_KOD, /^[ \t]*MIN_NEEDED_TO_ADVANCE[ \t]*=[ \t]*(-?\d+)/m, 'MIN_NEEDED_TO_ADVANCE');
const MAX_LEARN_POINTS = constantFrom(SETTINGS_KOD, /^[ \t]*piMaxLearnPoints[ \t]*=[ \t]*(-?\d+)/m, 'piMaxLearnPoints');

const CONSTS = { POINTS_SLOPE, MIN_NEEDED_TO_ADVANCE: MIN_NEEDED, MAX_LEARN_POINTS };
const unresolved = Object.entries(CONSTS).filter(([, v]) => v.value == null).map(([k]) => k);

// -------------------------------------------------- what a character can be asked to carry
//
// The planner's inventory panel is a shopping list, so it needs the things a character
// can actually hold, with the two numbers that decide whether it can hold them.
//
// WEIGHT AND BULK ARE INHERITED AND USUALLY NOT DECLARED HERE. ElderBerry's chain is
// ElderBerry -> NumberItem -> PassiveItem -> Item, and only one of those says what a
// berry weighs. `ivar` walks that chain; reading `classvars` directly would give null for
// most of the table and a carry estimate that is quietly far too optimistic.
//
// A REAGENT IS NOT A CLASS. Nothing in the tree declares an item to BE one — an item is a
// reagent because some spell's ResetReagents names it (derive/reagents.mjs makes the same
// point). So the reagent flag is the inversion of every spell's component list, which
// also means a spell added to the game brings its components with it.
const images = (() => { try { return loadImages(); } catch { return {}; } })();

const reagentUses = new Map();                   // lowercased CLASS name -> [{spell, count}]
for (const s of descendants(db, 'Spell')) {
  if (ivar(db, s, 'viSpell_num') === null) continue;
  const m = ownMessage(s, 'ResetReagents') || findMessage(db, s, 'ResetReagents');
  for (const r of (m ? parseConsPairs(m.body) : [])) {
    const k = r.cls.toLowerCase();
    if (!reagentUses.has(k)) reagentUses.set(k, []);
    reagentUses.get(k).push({ spell: nameOf(db, s) || humanize(s.name), count: r.count });
  }
}

const inChain = (c, ancestor) => c.chain.some(x => lower(x) === lower(ancestor));

// One label per item, in the order the planner groups them. First match wins, so the
// specific slots come before the general ones — a shield is Armor too.
const KINDS = [
  ['reagent', (c) => reagentUses.has(lower(c.name))],
  ['food',    (c) => inChain(c, 'Food')],
  ['weapon',  (c) => inChain(c, 'Weapon')],
  ['shield',  (c) => inChain(c, 'Shield')],
  ['armour',  (c) => inChain(c, 'Armor')],
  ['money',   (c) => /^shilling|^coin/i.test(c.name)],
];

const items = [];
for (const c of descendants(db, 'Item')) {
  // A CLASS WITH CHILDREN IS USUALLY A CATEGORY. `Weapon`, `Food` and `Armor` are not
  // things anybody carries, and offering them in a shopping list produces a want nothing
  // in the world can satisfy. Kept only when the game gives it a name of its own AND
  // nothing inherits from it.
  if ((c.children || []).length) continue;
  const name = nameOf(db, c);
  if (!name) continue;                        // no name resource: an internal, not an item
  const kind = KINDS.find(([, test]) => test(c))?.[0] ?? 'other';
  const icon = iconFor(db, images, c);
  const uses = reagentUses.get(lower(c.name)) ?? null;
  items.push({
    name: cleanText(name),
    cls: c.name,
    kind,
    weight: ivar(db, c, 'viWeight'),
    bulk: ivar(db, c, 'viBulk'),
    value: ivar(db, c, 'viValue_average'),
    nutrition: kind === 'food' ? ivar(db, c, 'viNutrition') : null,
    // Relative to a page one directory below the site root, which is where every page
    // this feeds lives. derive/README.md's "URLs are global" rule.
    icon: icon ? icon.src.replace(/^\.\.\//, '') : null,
    reagent_for: uses,
    description: cleanText(descOf(db, c) || '') || null,
    file: c.file || null,
  });
}
items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

const out = {
  builtAt: null,          // stamped by the caller; kept null so reruns diff cleanly
  builtFrom: { koddb: db.builtFrom ?? null, spells: spellFile.builtAt ?? null },
  stats: STATS,
  by_stat: byStat,
  skills,
  spells,
  schools,
  items,
  learning: {
    level_points: levelPoints,                 // cost weight of each school level, 1..6
    max_school_level: levelPoints ? levelPoints.length : null,
    // THE SEVENTH TRACK IS THE WEAPON SKILLS, AND IT IS EASY TO MISS. PlayerCanLearn sums
    // GetLevelLearnPoints over iWeapon and the six schools (player.kod:10813) — iWeapon
    // being the highest level of any SKILL known, all of them pooled — so a planner that
    // costs only the six schools understates every build that has learned a proficiency.
    tracks: ['weapon skills', ...schools],
    points_slope: POINTS_SLOPE.value,
    min_needed_to_advance: MIN_NEEDED.value,
    max_learn_points: MAX_LEARN_POINTS.value,
    cites: Object.fromEntries(Object.entries(CONSTS).map(([k, v]) => [k, v.cite])),
    formula: 'iNeed = iPoints*POINTS_SLOPE + (297 - MaxLearnPoints*POINTS_SLOPE) '
           + '- (RawIntellect*2*POINTS_SLOPE/5), bounded below by MIN_NEEDED_TO_ADVANCE',
    // The two discounts that make the low levels reachable at all, and which a planner
    // that stops at the formula above gets wrong by a factor of three.
    scarcity: 'if the previous level holds fewer than three abilities the cost is eased: '
            + 'prev_level 1 divides iNeed by 3, prev_level 2 multiplies it by 2/3 '
            + '(player.kod:10915-10930)',
    // What you are measured against, which is NOT a pool that accumulates.
    have: 'iHave is the sum of your best THREE ability values among what you already know '
        + 'at the level below, in the same school — 297 flat for level 1. Learning succeeds '
        + 'when iHave >= iNeed (player.kod:10775)',
    intellect_effect: 'each point of intellect removes (2*POINTS_SLOPE/5) from the cost '
                    + 'of the next level',
    source: 'player.PlayerCanLearn',
    unresolved,
    note: unresolved.length
      ? `${unresolved.join(' and ')} could not be read (`
        + Object.entries(CONSTS).filter(([, v]) => v.why).map(([k, v]) => `${k}: ${v.why}`).join('; ')
        + '). Set M59_ROOT to the game source and re-derive before showing exact '
        + 'advancement-point costs; the level table and the direction of the effect are '
        + 'safe to show without them.'
      : null,
  },
};

if (PRINT_ONLY) {
  console.log(`skills ${skills.length}, spells ${spells.length}, schools ${schools.length}`);
  console.log('\nskills by requisite stat:');
  for (const [k, v] of Object.entries(byStat)) {
    if (!v.skills.length) continue;
    console.log(`  ${k.padEnd(10)} (${String(v.skills.length).padStart(2)})  ${v.skills.join(', ')}`);
  }
  const noStat = skills.filter(s => !s.requisite_stat);
  if (noStat.length) console.log(`\n  no requisite stat found: ${noStat.map(s => s.name).join(', ')}`);
  console.log('\nspells per school and level:');
  for (const sc of schools) {
    const counts = [1, 2, 3, 4, 5, 6].map(l => spells.filter(s => s.school === sc && s.level === l).length);
    console.log(`  ${sc.padEnd(12)} ${counts.join('  ')}`);
  }
  console.log(`\nlevel points: ${JSON.stringify(levelPoints)}`);
  for (const [k, v] of Object.entries(CONSTS))
    console.log(`  ${k.padEnd(22)} ${v.value ?? 'UNRESOLVED'}${v.cite ? '   ' + v.cite : ''}${v.why ? '   (' + v.why + ')' : ''}`);
  const byKind = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  console.log(`\nitems (${items.length}): ` +
              Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', '));
  console.log(`  no weight declared anywhere in the chain: ` +
              items.filter(i => i.weight == null).length);
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${OUT}`);
  console.log(`  ${skills.length} skills, ${spells.length} spells, ${schools.length} schools, ` +
              `${items.length} items`);
  if (unresolved.length) console.log(`  UNRESOLVED: ${unresolved.join(', ')} — see learning.note`);
  else console.log(`  learning constants resolved: POINTS_SLOPE ${POINTS_SLOPE.value}, ` +
                   `MIN_NEEDED_TO_ADVANCE ${MIN_NEEDED.value}, MaxLearnPoints ${MAX_LEARN_POINTS.value}`);
}
