#!/usr/bin/env node
// THE /stats BOARD AND THE PANE IT SHARES WITH THE PLANNER, OFFLINE. No server, no broker:
//
//   node tools/m59-stats-test.mjs
//
// Everything runs against a scratch directory of character sheets, so it never reads the
// fleet's own — which the broker rewrites while this would be running.
//
// What is actually worth pinning here, in order of how badly each fails silently:
//
//   * A CHARACTER WITH NO ATTRIBUTES IS NOT A CHARACTER THAT ROLLED ZEROES. `create
//     automated` really does produce a zero build and caps it at 102 max health for ever, so
//     the two readings must never render alike: an unread sheet is reported as itself and
//     never grouped.
//   * GROUPING IS THE SIX NUMBERS AND NOTHING ELSE. Level moves — it is max health — so two
//     characters with the same roll and different levels are one build, and folding level in
//     would silently split every group as the fleet played.
//   * THE PANE HAS NO SLIDER AND NO HATCHING. Attributes are fixed at creation; a board that
//     carried the planner's editable bar would be offering a re-roll it cannot perform.
//   * ONE HOME FOR THE ARITHMETIC. The planner and this board both print the ceiling and the
//     carry cap. If the two ever compute them separately they will eventually disagree, and
//     the number nobody can check is the one that will be wrong.
//   * THE TAB BAR NAMES THIS BOARD. A board with no tab is a board nobody opens.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'm59-stats-test-'));
mkdirSync(dir, { recursive: true });

// A sheet as m59-sheet.mjs writes one, cut down to what this board reads.
const sheet = (character, stats, level, { caps = 70, agent = null } = {}) => {
  const detail = {};
  if (stats) for (const [k, v] of Object.entries(stats))
    detail[k] = { value: v, display_scale: 50, hard_cap: caps };
  writeFileSync(join(dir, character + '.json'), JSON.stringify({
    _format: 'm59-sheet/1', character, agent, level,
    attributes: stats ? { ...stats, note: 'fixed at creation', detail } : {},
  }));
};

// FIGHTER, three of them, and one is further along than the others. Same build.
const FIGHTER = { might: 50, intellect: 10, stamina: 50, agility: 45, mysticism: 15, aim: 30 };
// CASTER, two of them. Same stamina as the fighter, so the ceiling does not distinguish them.
const CASTER  = { might: 15, intellect: 45, stamina: 50, agility: 30, mysticism: 50, aim: 10 };
// ARCHER, one of them — a build of one is the ordinary case and must not be hidden.
const ARCHER  = { might: 25, intellect: 15, stamina: 50, agility: 40, mysticism: 20, aim: 50 };
// A build that leads in nothing: beaten or matched in every attribute that varies.
const MIDDLE  = { might: 35, intellect: 30, stamina: 50, agility: 35, mysticism: 30, aim: 20 };

sheet('Fighter1', FIGHTER, 47);
sheet('Fighter2', FIGHTER, 30);
sheet('Fighter3', FIGHTER, 30);
sheet('Caster1', CASTER, 33);
sheet('Caster2', CASTER, 30);
sheet('Archer1', ARCHER, 31);
sheet('Middle1', MIDDLE, 32);
// No attributes at all — a sheet written before the read landed.
sheet('Unread', null, 30);

const { readBuilds, groupBuilds, renderStatsBoard } = await import('./m59-stats-page.mjs');
const SP = await import('../compendium/tools/statpane.mjs');

// ------------------------------------------------------------------ grouping
console.log('\ngrouping by the six numbers');
{
  const rows = readBuilds({ dir });
  ok('every sheet is read', rows.length === 8, `got ${rows.length}`);
  const g = groupBuilds(rows);
  ok('four builds, not eight', g.groups.length === 4, `got ${g.groups.length}`);
  ok('largest first', g.groups[0].count === 3 && g.groups[1].count === 2);
  ok('a build of one is still a build',
     g.groups.filter(x => x.count === 1).length === 2);
  ok('the key is the numbers themselves', g.groups[0].key === '50/10/50/45/15/30',
     g.groups[0].key);
  ok('a different level does not split a build',
     g.groups[0].members.map(m => m.character).sort().join(',') === 'Fighter1,Fighter2,Fighter3');
  ok('the level range is kept, not averaged',
     g.groups[0].worst_level === 30 && g.groups[0].best_level === 47);
  ok('members are ordered by how far they have got',
     g.groups[0].members[0].character === 'Fighter1');
  ok('the totals count characters, not builds', g.total === 8 && g.known === 7);

  // THE ONE THAT MUST NOT BE FOLDED IN.
  ok('a sheet with no attributes is not a build', g.unknown.length === 1);
  ok('and it is named rather than counted as zeroes',
     g.unknown[0].character === 'Unread' && g.unknown[0].stats === null);
  ok('so no group claims a zero roll',
     !g.groups.some(x => x.key === '0/0/0/0/0/0'));

  // The caps come off the sheet, not off a constant in the page.
  ok('hard_cap is read from the sheet', g.groups[0].caps.might === 70);
}

console.log('\nwhat distinguishes a build');
{
  const g = groupBuilds(readBuilds({ dir }));
  ok('an attribute every build shares is called out once, not per row',
     g.uniform.join(',') === 'stamina', g.uniform.join(','));
  const by = Object.fromEntries(g.groups.map(x => [x.key, x]));
  ok('ties at the fleet best are all reported',
     g.groups.every(x => x.best_at.includes('stamina')));
  ok('but a shared attribute is not what a build is FOR',
     !g.groups.some(x => x.distinctive.includes('stamina')));
  ok('the fighter leads on might and agility',
     by['50/10/50/45/15/30'].distinctive.join(',') === 'might,agility',
     by['50/10/50/45/15/30'].distinctive.join(','));
  ok('the archer leads on aim, and on aim alone',
     by['25/15/50/40/20/50'].distinctive.join(',') === 'aim');
  ok('the caster leads on intellect and mysticism',
     by['15/45/50/30/50/10'].distinctive.join(',') === 'intellect,mysticism');
  ok('and the balanced roll leads in nothing',
     by['35/30/50/35/30/20'].distinctive.length === 0);
}

// ------------------------------------------------------------------ the page
console.log('\nthe page');
{
  const html = renderStatsBoard({ dir });
  ok('one pane per build', (html.match(/class="m59 m59-statpane"/g) || []).length === 4);
  ok('the pane CSS travels with the page — no external asset to fail to arrive',
     html.includes('--m59-trough'));
  ok('the share is written out, not left as a percentage to reverse',
     html.includes('out of 8 characters'));
  ok('and the count is the group, not the fleet', /<span class="n">3<\/span>/.test(html));
  ok('names link to their own pages', html.includes('href="/hero/Fighter1"'));
  ok('every named character is linked',
     ['Fighter1', 'Fighter2', 'Fighter3', 'Caster1', 'Caster2', 'Archer1', 'Middle1', 'Unread']
       .every(n => html.includes(`href="/hero/${n}"`)));
  ok('the unread character is shown apart from the builds', html.includes('Not grouped'));
  ok('it carries its own tab', /class="tabs"/.test(html) && /href="\/stats" class="on"/.test(html));

  // ATTRIBUTES ARE FIXED AT CREATION, so nothing here may look adjustable.
  ok('no slider on a read-only pane', !html.includes('type="range"'));
  ok('and no hatching, which means a value somebody typed',
     !/m59-bar[^"]*\bplanned\b/.test(html));
  ok('the bars say they are observed', /m59-bar observed/.test(html));

  // The board must not invent a freshness it does not have — and must not need one.
  ok('it says why it needs nothing live', /cannot go out of date/.test(html));

  // THE ROSTER IS THE OTHER HALF OF THE POPULATION, and a character in it with no sheet
  // would otherwise be simply absent — which on a page of percentages is indistinguishable
  // from not existing. A different failure from a sheet with no attributes, and a different
  // fix, so the two are never merged.
  const roster = new Set(['Fighter1', 'Caster1', 'Ghost', 'AlsoGhost']);
  const filtered = renderStatsBoard({ dir, characters: roster });
  ok('the roster filters the board', filtered.includes('out of 2 characters')
     && !filtered.includes('href="/hero/Middle1"'));
  ok('a roster character with no sheet is named, not dropped',
     filtered.includes('href="/hero/Ghost"') && filtered.includes('href="/hero/AlsoGhost"'));
  ok('and counted', /2 in the roster with no sheet/.test(filtered));
  ok('the shares say what their denominator is',
     /of the\s+2 characters on file/.test(filtered));
  ok('no missing character invents a build',
     (filtered.match(/class="m59 m59-statpane"/g) || []).length === 2);
  ok('and with nobody missing there is nothing to explain',
     !renderStatsBoard({ dir, characters: new Set(['Fighter1']) }).includes('no sheet at all'));

  // ONE BUILD HAS NOTHING TO BE COMPARED AGAINST. "best in the fleet at" all six is
  // vacuously true and reads as a boast; "best at nothing" would be worse still.
  const alone = renderStatsBoard({ dir, characters: new Set(['Fighter1', 'Fighter2']) });
  ok('a fleet of one build says so instead of claiming every attribute',
     alone.includes('the only build in the fleet')
     && !alone.includes('best in the fleet at')
     && !alone.includes("the fleet's best at nothing"));
  ok('and nothing is called shared when there is nothing to share it with',
     !alone.includes('Every build here rolled the same'));

  // Every sheet unreadable is not the same as no sheets at all.
  const noAttrs = mkdtempSync(join(tmpdir(), 'm59-stats-test-blank-'));
  writeFileSync(join(noAttrs, 'A.json'), JSON.stringify({ character: 'A', level: 30, attributes: {} }));
  const blank = renderStatsBoard({ dir: noAttrs });
  ok('a record of sheets with no attributes renders no build and says who',
     !blank.includes('m59-statpane') && blank.includes('href="/hero/A"')
     && !/No character sheet on disk yet/.test(blank));
  rmSync(noAttrs, { recursive: true, force: true });

  const empty = renderStatsBoard({ dir: join(dir, 'nope') });
  ok('an empty record says which command writes one',
     /No character sheet on disk yet/.test(empty) && /m59-sheet\.mjs/.test(empty));
  ok('and does not render a build out of nothing',
     !/class="m59 m59-statpane"/.test(empty));
}

// ------------------------------------------------------------------ the shared pane
//
// THE PLANNER DRAWS THIS SAME PANE. Everything below is imported from the file both of them
// use, so a copy made for either page would fail here rather than drift quietly.
console.log('\nthe pane, and the arithmetic under it');
{
  ok('six stats in the client order',
     SP.STAT_ORDER.join(',') === 'might,intellect,stamina,agility,mysticism,aim');
  ok('every one has a label', SP.STAT_ORDER.every(k => SP.STATS[k]?.label));

  // 101 + stamina (player.kod:7830). The one number this fleet is entirely about.
  ok('the ceiling is 101 + stamina', SP.healthCeiling(50) === 151);
  ok('an unknown stamina has no ceiling, rather than a ceiling of 101',
     SP.healthCeiling(null) === null);
  // 1700 + might*20 (player.kod:10456), and it bounds weight AND bulk.
  ok('the carry cap is 1700 + might*20', SP.carryCapacity(50) === 2700);
  ok('no might known means the floor, not zero', SP.carryCapacity(null) === 1700);
  ok('points spent sums the six', SP.pointsSpent(FIGHTER) === 200);

  ok('the key is order-independent of the object',
     SP.statsKey({ aim: 30, mysticism: 15, agility: 45, stamina: 50, intellect: 10, might: 50 })
       === '50/10/50/45/15/30');
  ok('a build missing a stat has no key at all', SP.statsKey({ might: 50 }) === null);
  ok('and null is not a key', SP.statsKey(null) === null);
  ok('same six, same build', SP.sameStats(FIGHTER, { ...FIGHTER }));
  ok('one different number, different build',
     !SP.sameStats(FIGHTER, { ...FIGHTER, aim: 31 }));

  const bars = SP.statBars(FIGHTER, { caps: { might: 70 } });
  ok('a bar is drawn against the cap, not against the fleet best',
     bars.includes('width:71.4%'), bars.slice(0, 120));
  ok('a stat with no cap falls back to 70',
     SP.statBars({ aim: 35 }).includes('width:50.0%'));
  ok('the footer is the three derived numbers',
     /max health ceiling 151/.test(SP.statFoot(FIGHTER))
     && /200 points spent/.test(SP.statFoot(FIGHTER))
     && /carry 2700/.test(SP.statFoot(FIGHTER)));
  ok('the pane can be drawn without its footer',
     !SP.statPane(FIGHTER, { foot: false }).includes('m59-foot'));
  ok('the CSS is a string the page can inline', SP.PANE_CSS.includes('.m59-bar'));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
