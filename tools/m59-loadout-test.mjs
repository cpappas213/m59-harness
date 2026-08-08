#!/usr/bin/env node
// THE LOADOUT FORMAT AND THE RECONCILER, AGAINST SCRATCH DIRECTORIES. Offline, safe any
// time — it never reads the real loadout directory, never starts a broker, and never
// touches the network:
//
//   node tools/m59-loadout-test.mjs
//
// What is pinned here is every way a loadout can look right and mean something else.
//
//   * A LOADOUT THAT SAYS NOTHING MUST CHANGE NOTHING. It is an overlay: every helper
//     returns null for an empty one, and null means "the behaviour that was already
//     there", not "protects nothing". Getting that backwards would have a character with
//     an empty loadout sell its armour the first time it stood at a counter.
//   * SUBSTRING MATCHING. This repository has paid for it twice — `keep: ['mace']`
//     protected the item literally called "broken mace", and a junk list containing
//     "mushroom" would sell the edible ones, which are food.
//   * A MAX BELOW A MIN, which is not a preference but a loop: buy up to the min, sell
//     down to the max, pay the vendor spread on every lap, for ever.
//   * A FLOOR THAT PROTECTS THE WHOLE STACK. Twelve elderberry with a floor of twelve are
//     all protected and the thirteenth is not, so the keep test has to be able to count.
//   * THE LEARNING COST WITH NO CONSTANTS. planner.json exports nulls when the source tree
//     is absent, and a planner that substitutes a plausible slope prints an authoritative
//     invented number, which is worse than printing none.
//   * A CACHE THAT DOES NOT NOTICE THE FILE CHANGED. The keeper reads this every pass; a
//     loadout edited in the planner and not picked up is indistinguishable from one that
//     was never saved.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-loadout-test-'));
process.env.M59_LOADOUT_DIR = join(root, 'loadouts');

const L = await import('./m59-loadout.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const pack = (...pairs) => pairs.map(([name, amount = 1]) => ({ name, amount }));

console.log('names on the filesystem');
{
  ok('a character name becomes a slug', L.slugOf('Kermit') === 'kermit');
  ok('spaces and punctuation fold', L.slugOf("Miss Piggy's") === 'miss-piggy-s');
  ok('A TRAVERSAL IS NOT ESCAPED, IT IS DROPPED — nothing can walk out of the directory',
     L.slugOf('../../substrate/fleets/prod') === 'substrate-fleets-prod');
  ok('a name with nothing usable in it is refused rather than defaulted',
     L.slugOf('../..') === null && L.slugOf('') === null && L.slugOf('   ') === null);
  ok('and a refused name has no path', L.loadoutPath('...') === null);
}

console.log('\nan empty loadout changes nothing');
{
  const empty = L.blank('Nobody');
  ok('there is no keep test', L.keepTest(empty) === null);
  ok('there is no sell test', L.sellTest(empty) === null);
  ok('there is no drop ranking', L.dropRank(empty) === null);
  ok('and none of them is offered for a missing loadout either',
     L.keepTest(null) === null && L.sellTest(null) === null &&
     L.dropRank(null) === null && L.reconcile(null) === null);
  const r = L.reconcile(empty, { items: pack(['mace'], ['rat pelt', 9]) });
  ok('reconciling an empty loadout asks for nothing and sheds nothing',
     r.buy.length === 0 && r.sell.length === 0 && r.ok);
}

console.log('\nmatching is exact unless it is asked not to be');
{
  ok('the display name matches itself, whatever the casing',
     L.entryMatches({ item: 'Leather Armor' }, 'leather armor'));
  ok('A BROKEN MACE IS NOT A MACE. The keep list that protected one is the reason every ' +
     'character hauled its shattered weapons around for ever',
     !L.entryMatches({ item: 'mace' }, 'broken mace'));
  ok('an edible mushroom is not a mushroom', !L.entryMatches({ item: 'mushroom' }, 'edible mushroom'));
  ok('...and the plain mushroom still is', L.entryMatches({ item: 'mushroom' }, 'mushroom'));
  ok('contains is available, and has to be asked for',
     L.entryMatches({ item: 'mushroom', match: 'contains' }, 'blue mushroom'));
  ok('prefix too', L.entryMatches({ item: 'leather', match: 'prefix' }, 'leather armor') &&
     !L.entryMatches({ item: 'armor', match: 'prefix' }, 'leather armor'));
}

console.log('\nnormalising what somebody typed');
{
  const { loadout, problems } = L.normalise({
    character: 'Kermit',
    plan: { schools: { Kraanan: 3, Riija: 'nine', Faren: 9 } },
    carry: [{ item: 'elderberry', min: 20, max: 4 }, { item: 'elderberry', min: 1 },
            { item: 'herb', min: -3 }],
    sell: ['emerald', 'herb', ''],
    keep: ['herb'],
    gear: { weapon: ['mace'], slots: { body: ['leather armor'], tail: ['a hat'] } },
  });
  const said = (re) => problems.some(p => re.test(p));
  ok('a school level that is not a number is refused', !('Riija' in loadout.plan.schools) && said(/not a level/));
  ok('a seventh school level is refused — the game has six', !('Faren' in loadout.plan.schools) && said(/the game has six/));
  ok('a real one survives', loadout.plan.schools.Kraanan === 3);
  ok('A MAX BELOW A MIN IS RAISED, not honoured — the pair cannot both be satisfied and ' +
     'the keeper would buy and sell the same item for ever',
     loadout.carry[0].max === 20 && said(/buy and sell the same item for ever/));
  ok('a duplicate is reported', said(/listed twice/));
  ok('a negative floor is read as zero', loadout.carry.find(c => c.item === 'herb').min === 0);
  ok('an empty entry in a name list is reported, not silently dropped', said(/empty entry in sell/));
  ok('sell and keep at once is reported and KEEP WINS — keeping something we should have ' +
     'sold costs a slot, selling something we meant to keep costs the item',
     said(/both the sell and keep lists — kept/));
  ok('a slot nothing here knows is carried through rather than dropped',
     loadout.gear.slots.tail?.[0] === 'a hat' && said(/slot "tail" is not one/));
  ok('a wrong format is read anyway, and said so',
     L.normalise({ format: 'something-else', character: 'x' }).problems.some(p => /format is/.test(p)));
}

console.log('\nan item nothing in the game answers to');
{
  const { problems } = L.normalise({ character: 'x', carry: [{ item: 'sword of plot armour', min: 1 }] });
  const flagged = problems.some(p => /not in the item catalogue/.test(p));
  // The catalogue is compiled from a source tree that may not be here. When it is absent
  // the check cannot run, and NOT running a check is different from passing it.
  ok(L.catalogue().size ? 'an unknown item is reported and kept anyway — the server is the ' +
       'authority, not this snapshot' : 'no catalogue here, so no name check was claimed',
     L.catalogue().size ? flagged : !flagged);
}

console.log('\nthe keep test knows how to count');
{
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 12, max: 24 }],
    keep: ['signet ring'], gear: { weapon: ['mace'], slots: { body: ['leather armor'] } } });

  const atFloor = L.keepTest(loadout, pack(['elderberry', 12]));
  ok('at the floor, the stack is protected', !!atFloor('elderberry'));
  const over = L.keepTest(loadout, pack(['elderberry', 13]));
  ok('ABOVE the floor it is not — that is what a maximum is for', !over('elderberry'));
  const blind = L.keepTest(loadout);
  ok('WITHOUT A PACK IT CANNOT COUNT, so it protects the whole stack: it declines to sell ' +
     'something it might need rather than selling something it does', !!blind('elderberry'));
  ok('the keep list is protected outright', !!blind('signet ring'));
  ok('so is the gear', !!blind('mace') && !!blind('leather armor'));
  ok('and it says why, because a protected item with no reason is unauditable',
     /keep list/.test(blind('signet ring')) && /fight with/.test(blind('mace')));
  ok('anything unmentioned is not protected here — the caller\'s own rules still apply',
     blind('rat pelt') === null);
}

console.log('\nthe sell list, and what outranks it');
{
  const { loadout } = L.normalise({ character: 'x', sell: ['emerald', 'mace'], gear: { weapon: ['mace'] } });
  const s = L.sellTest(loadout);
  ok('sell-fodder is named', !!s('emerald'));
  ok('but not when it is also the character\'s weapon', s('mace') === null);
  ok('and a loadout with no sell list has no opinion', L.sellTest(L.blank('x')) === null);
}

console.log('\nreconciling against a real pack');
{
  const { loadout } = L.normalise({ character: 'Kermit',
    carry: [{ item: 'elderberry', min: 20, max: 40 }, { item: 'herb', min: 20, max: 40 }],
    sell: ['blue mushroom'],
    gear: { weapon: ['mace', 'short sword'], slots: { body: ['leather armor'] } },
    purse: { float: 400 } });
  const items = pack(['shilling', 455], ['herb', 42], ['short sword'], ['blue mushroom', 10]);
  const r = L.reconcile(loadout, { items, equipped: [{ name: 'short sword' }] });

  ok('what is short is asked for', r.buy.some(b => b.item === 'elderberry' && b.short === 20));
  ok('what is over the ceiling is shed, down to the ceiling and no further',
     r.sell.some(s => s.item === 'herb' && s.over === 2));
  ok('sell-fodder is shed entirely', r.sell.some(s => s.item === 'blue mushroom' && s.over === 10));
  ok('HOLDING THE SECOND CHOICE IS NOT MISSING THE GEAR — it is one upgrade short, and ' +
     'reporting them alike is how an outfitting run buys a mace for somebody holding one',
     r.gear.weapon.have === 'short sword' && !r.gear.weapon.missing &&
     r.gear.weapon.upgrade_to?.[0] === 'mace');
  ok('and it knows the second choice is actually being wielded', r.gear.weapon.worn === true);
  ok('a slot with nothing in it IS missing, and lands on the buy list',
     r.gear.slots.body.missing && r.buy.some(b => b.item === 'leather armor' && b.gear));
  ok('the purse is read, and the float is not counted as spendable',
     r.purse.have === 455 && r.purse.spendable === 55);
  ok('a floor price is offered for the trip', typeof r.at_least === 'number');
  ok('and the summary does not claim to be fine', r.ok === false && /short/.test(r.summary));
}

console.log('\nwhat the fleet\'s interest board is told');
{
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 20, max: 40 }, { item: 'herb', min: 20, max: 40 }] });
  const w = L.wantsOf(loadout, pack(['herb', 60], ['elderberry', 2]));
  ok('what is short is a want', w.wants.includes('elderberry'));
  ok('what is over the ceiling is spare, by the amount over it', w.spare.get('herb') === 20);
  ok('and something between the two is neither',
     L.wantsOf(loadout, pack(['herb', 30])).wants.length === 1 &&
     L.wantsOf(loadout, pack(['herb', 30])).spare.size === 0);
}

console.log('\nthe order things are given up in');
{
  const { loadout } = L.normalise({ character: 'x', sell: ['blue mushroom'],
    carry: [{ item: 'elderberry', min: 12 }], gear: { weapon: ['mace'] } });
  const rank = L.dropRank(loadout, pack(['elderberry', 12]));
  ok('sell-fodder goes first, ahead of anything the caller had in mind', rank('blue mushroom') === -1);
  ok('protected things go last', rank('elderberry') === 3 && rank('mace') === 3);
  ok('AND SILENCE IS AN ANSWER: anything unmentioned returns null so the keeper\'s own ' +
     'ranking decides, rather than being flattened to the middle of this one',
     rank('rat pelt') === null);
}

console.log('\nthe learning cost');
{
  const none = L.learnCost({ school: 'Qor', level: 2, intellect: 30, constants: {} });
  ok('WITH NO CONSTANTS IT REFUSES TO PRODUCE A NUMBER — an invented cost curve reads as ' +
     'authoritative and is worse than none', none.need === null && /not resolved/.test(none.why));

  // The server's own arithmetic (player.kod:10837): iNeed = iPoints*7 + (297-16*7)
  // - int*14/5, floored at 75.
  const C = { points_slope: 7, min_needed_to_advance: 75, max_learn_points: 16,
              level_points: [1, 2, 4, 6, 8, 10] };
  const a = L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1,
                          intellect: 30, knowOneAtLevel: true, constants: C });
  ok('one level-1 school known is one point: 7 + 185 - 84 = 108', a.need === 108, `got ${a.need}`);
  const b = L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1,
                          intellect: 30, knowOneAtLevel: false, constants: C });
  ok('entering a level nothing is known at yet costs the difference up front — 1 more ' +
     'point, so 7 more', b.need === 115, `got ${b.need}`);
  ok('THE SEVENTH TRACK IS THE WEAPON SKILLS and it is charged like a school',
     L.learnCost({ trackLevels: { weapon: 2, Kraanan: 1 }, school: 'Qor', level: 1,
                   intellect: 30, knowOneAtLevel: true, constants: C }).need === 108 + 2 * 7);
  // Measured somewhere the floor is not in the way. At one point of track the whole cost
  // is under MIN_NEEDED_TO_ADVANCE by 50 intellect, so the difference there is the floor's
  // and not intellect's — which is exactly the reading a planner must not print.
  const deep = { trackLevels: { Kraanan: 3, Qor: 3 }, school: 'Faren', level: 1,
                 knowOneAtLevel: true, constants: C };
  ok('intellect buys the cost down, 14/5 a point',
     L.learnCost({ ...deep, intellect: 30 }).need - L.learnCost({ ...deep, intellect: 50 }).need
       === Math.trunc(50 * 14 / 5) - Math.trunc(30 * 14 / 5),
     `${L.learnCost({ ...deep, intellect: 30 }).need} vs ${L.learnCost({ ...deep, intellect: 50 }).need}`);
  ok('...and once the floor is reached, more intellect buys nothing — a planner that ' +
     'reports the difference there is reporting the bound, not the stat',
     L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1, intellect: 50,
                   knowOneAtLevel: true, constants: C }).need === 75);
  ok('and the floor holds it above MIN_NEEDED_TO_ADVANCE',
     L.learnCost({ trackLevels: {}, school: 'Qor', level: 1, intellect: 99,
                   knowOneAtLevel: true, constants: C }).need === 75);
  const scarce = L.learnCost({ trackLevels: { Qor: 1 }, school: 'Qor', level: 2, intellect: 30,
                               knowOneAtLevel: true, prevLevelCount: 1, constants: C });
  const full = L.learnCost({ trackLevels: { Qor: 1 }, school: 'Qor', level: 2, intellect: 30,
                             knowOneAtLevel: true, prevLevelCount: 3, constants: C });
  ok('a thin level below eases the cost to a third (player.kod:10915)',
     scarce.need === Math.trunc(full.need / 3), `${scarce.need} vs ${full.need}`);
  ok('level 1 is measured against the maximum outright, so it says so',
     L.learnCost({ trackLevels: {}, school: 'Qor', level: 1, intellect: 30, constants: C }).have_max === 297);

  // assess, thrust and kick declare viSkill_level = 50 on a table with six entries. The
  // server asks Nth(vlLevelPoints, 50), which falls off the end and returns NIL
  // (blakserv/list.c:178), so they cost nothing — and because iWeapon is a MAX, knowing one
  // HIDES the proficiency levels the character would otherwise be charged for.
  ok('A LEVEL PAST THE END OF THE TABLE IS FREE, not clamped to the last entry',
     L.levelPointsAt(C.level_points, 50) === 0 && L.levelPointsAt(C.level_points, 6) === 10);
  ok('...so a character that knows thrust pays nothing for its weapon track, and the ' +
     'proficiency it also knows disappears into the same max',
     L.learnCost({ trackLevels: { weapon: 50, Kraanan: 1 }, school: 'Qor', level: 1,
                   intellect: 30, knowOneAtLevel: true, constants: C }).need === 108);
  ok('and level 0 — nothing known in that track — is free too',
     L.levelPointsAt(C.level_points, 0) === 0);
}

console.log('\ncan this character learn it');
{
  const C = { points_slope: 7, min_needed_to_advance: 75, max_learn_points: 16,
              level_points: [1, 2, 4, 6, 8, 10] };
  ok('level 1 is reachable from nothing, because iHave is 297 flat there',
     L.canLearn({ have: 0, trackLevels: {}, school: 'Qor', level: 1, intellect: 30,
                  knowOneAtLevel: true, constants: C }).can === true);
  const hard = { have: 60, trackLevels: { Qor: 1, Kraanan: 3 }, school: 'Qor', level: 2,
                 intellect: 10, knowOneAtLevel: false, constants: C };
  ok('a higher level is not, until the abilities below it are good enough',
     L.canLearn(hard).can === false && L.canLearn(hard).short > 0);
  ok('...and it says how far short, which is the number that decides what to grind',
     L.canLearn(hard).short === L.canLearn(hard).need - 60);
  ok('with no constants it will not claim either way',
     L.canLearn({ have: 200, school: 'Qor', level: 2, constants: {} }).can === null);
}

console.log('\nschools, read off a character sheet');
{
  const sheet = { character: 'x', spells: [
    { name: 'create food', school: 'Kraanan', level: 1 },
    { name: 'shield of the fallen', school: 'Kraanan', level: 3 },
    { name: 'blink', school: 'Riija', level: 1 },
    { name: 'a spell nobody has heard of', school: 'Qor' },
  ] };
  const s = L.schoolLevels(sheet, []);
  ok('the highest level in each school is what counts', s.Kraanan === 3);
  ok('BLINK IS NOT COUNTED — the server excludes it from a school\'s level ' +
     '(player.kod:10735) so a planner may not count it either', !('Riija' in s));
  ok('a spell with no level contributes nothing rather than a guessed one', !('Qor' in s));
}

console.log('\nreading and writing');
{
  const res = L.writeLoadout('Kermit', { character: 'Kermit', carry: [{ item: 'herb', min: 5 }] });
  ok('it lands under the slug', existsSync(join(process.env.M59_LOADOUT_DIR, 'kermit.json')));
  ok('and is stamped', !!res.loadout.updated);
  ok('no half-written file is left behind',
     !existsSync(join(process.env.M59_LOADOUT_DIR, 'kermit.json.tmp')));
  const back = L.readLoadout('Kermit');
  ok('it reads back the same', back.loadout.carry[0].min === 5);
  ok('a name with nothing usable in it is refused rather than written somewhere else',
     (() => { try { L.writeLoadout('../..', {}); return false; } catch { return true; } })());
  ok('A TRAVERSAL CANNOT ESCAPE — it is flattened into the directory, not resolved',
     L.loadoutPath('../../prod') === join(process.env.M59_LOADOUT_DIR, 'prod.json'));
  ok('TWO NAMES THAT SLUG TO ONE FILE DO NOT SILENTLY OVERWRITE EACH OTHER',
     (() => { try { L.writeLoadout('Kermit!', { character: 'Kermit!' }); return false; }
              catch (e) { return /already holds "Kermit"/.test(e.message); } })());
  ok('...while a difference the slug keeps is a different character and a different file',
     L.loadoutPath('Kermit the Frog') !== L.loadoutPath('Kermit'));
  ok('...and case alone is the SAME character, not a collision to refuse',
     (() => { try { L.writeLoadout('KERMIT', { character: 'KERMIT' }); return true; } catch { return false; } })());
  ok('...unless that is what was meant',
     (() => { try { L.writeLoadout('Kermit', { character: 'Kermit', carry: [{ item: 'herb', min: 5 }] },
                                   { force: true }); return true; } catch { return false; } })());
  ok('reading one that is not there is null, not a throw', L.readLoadout('Nobody') === null);
  ok('listing finds it', L.listLoadouts().some(r => r.loadout?.character === 'Kermit'));

  writeFileSync(join(process.env.M59_LOADOUT_DIR, 'broken.json'), '{ not json');
  const rows = L.listLoadouts();
  ok('AND A BROKEN FILE IS LISTED AS BROKEN rather than taking the listing down with it',
     rows.some(r => r.loadout === null && r.problems.length) &&
     rows.some(r => r.loadout?.character === 'Kermit'));
}

console.log('\nthe cache the keeper leans on');
{
  const p = join(process.env.M59_LOADOUT_DIR, 'kermit.json');
  ok('the first read finds it', L.loadoutFor('Kermit')?.carry[0].min === 5);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  raw.carry[0].min = 99;
  writeFileSync(p, JSON.stringify(raw));
  // mtime resolution is coarse enough on some filesystems that a write inside the same
  // millisecond leaves it unchanged, which would make this test pass for the wrong reason.
  const later = new Date(Date.now() + 4000);
  utimesSync(p, later, later);
  ok('A CHANGE IS PICKED UP. A loadout edited in the planner and not noticed is ' +
     'indistinguishable from one that was never saved', L.loadoutFor('Kermit')?.carry[0].min === 99);
  writeFileSync(p, '{ still not json');
  utimesSync(p, new Date(Date.now() + 8000), new Date(Date.now() + 8000));
  ok('and a file that goes bad returns null rather than throwing into the keeper\'s pass',
     L.loadoutFor('Kermit') === null);
  ok('a character with no loadout is null every time', L.loadoutFor('Nobody') === null);
}

console.log('\nwhat actually reaches the counter');
{
  // The composed decision the keeper runs, in the order it runs it. This is the one that
  // can lose a character its armour, so each rule is pinned against the rule below it.
  const S = await import('./m59-skills.mjs');
  const KEEP = /shilling|coin|diamond|ruby|emerald|sapphire|armor|armour|shield|sword|mace|hammer|axe|bow|helm|gauntlet/i;
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 12, max: 24 }],
    sell: ['emerald', 'short sword'], keep: ['orc tooth'],
    gear: { weapon: ['mace'] } });
  const pack = pack1();
  function pack1() {
    return [{ name: 'elderberry', amount: 12 }, { name: 'emerald', amount: 6 },
            { name: 'short sword', amount: 1 }, { name: 'orc tooth', amount: 3 },
            { name: 'rat pelt', amount: 9 }, { name: 'leather armor', amount: 1 }];
  }
  const ask = (name, worn = false) => S.sellable({ name, worn, keepRe: KEEP, loadout, pack });

  ok('WORN BEATS EVERY LIST — nothing can sell the shield off your arm',
     ask('emerald', true).sell === false && /worn or wielded/.test(ask('emerald', true).why));
  ok('a floor protects the stack up to the floor',
     ask('elderberry').sell === false && /loadout/.test(ask('elderberry').why));
  ok('THE SELL LIST BEATS THE NAME GUARD — this is the only way to shed gems and spare ' +
     'weapons without editing a regex twenty-one characters share',
     ask('emerald').sell === true && ask('short sword').sell === true);
  ok('the keep list protects something the name guard never would',
     ask('orc tooth').sell === false);
  ok('the character\'s own weapon is protected even though it is not on the keep list',
     ask('mace').sell === false);
  ok('the name guard still protects armour nobody mentioned', ask('leather armor').sell === false);
  ok('and ordinary loot still goes', ask('rat pelt').sell === true);

  // The overlay property, stated as a test rather than as a comment: with no loadout, the
  // answer is exactly the pre-loadout answer.
  const bare = (name) => S.sellable({ name, worn: false, keepRe: KEEP, loadout: null, pack });
  ok('WITH NO LOADOUT NOTHING CHANGES: the gems and the sword are protected again, and ' +
     'the loot still goes',
     bare('emerald').sell === false && bare('short sword').sell === false &&
     bare('elderberry').sell === true && bare('rat pelt').sell === true);
  ok('above the floor the surplus is sellable, which is what a ceiling is for',
     S.sellable({ name: 'elderberry', worn: false, keepRe: KEEP, loadout,
                  pack: [{ name: 'elderberry', amount: 30 }] }).sell === true);
}

console.log('\nwhat an outfitting run goes shopping for');
{
  const O = await import('./m59-outfit.mjs');
  const fleetDefault = O.wantsFor(null);
  ok('NO LOADOUT IS THE FLEET DEFAULT, unchanged — a mace, leather and a shield',
     fleetDefault.length === 3 && fleetDefault.some(w => w.what === 'a mace'));
  ok('and so is a loadout that says nothing about gear',
     O.wantsFor(L.normalise({ character: 'x', carry: [{ item: 'herb', min: 5 }] }).loadout)
       === fleetDefault);

  const { loadout } = L.normalise({ character: 'x',
    gear: { weapon: ['war hammer', 'mace'], slots: { body: ['leather armor'] } } });
  const w = O.wantsFor(loadout);
  ok('a loadout replaces it with this character\'s own list',
     w.length === 2 && w[0].what === 'war hammer' && w[1].what === 'leather armor');
  ok('AN ITEM NAME IS DATA, NOT A REGEX. An apostrophe or a bracket in a name would ' +
     'otherwise compile to something that matches nothing while looking like it should',
     O.wantsFor(L.normalise({ character: 'x', gear: { weapon: ["wizard's staff (+1)"] } }).loadout)[0]
       .re.test("Wizard's Staff (+1)"));
  ok('the second choice satisfies the want — a character holding a mace is not missing ' +
     'its weapon just because a war hammer was listed first',
     w[0].fallback.test('mace') && w[0].fallback.test('war hammer'));
  ok('...and something in neither list does not', !w[0].fallback.test('rat pelt'));
  // The bug this replaced: widening a loadout's fallback to the slot's FAMILY made every
  // loadout mean what the fleet default means. Kermit, whose list says short sword and
  // whose pack holds a mace, reported "already stocked".
  const named = O.wantsFor(L.normalise({ character: 'x',
    gear: { weapon: ['short sword'] } }).loadout)[0];
  ok('A NAMED WANT IS NOT SATISFIED BY THE FAMILY. Getting back to the weapon the list ' +
     'names is the thing the list is for',
     !named.fallback.test('mace') && named.fallback.test('short sword'));
  ok('...while the fleet default still means "some weapon", because one answer for ' +
     'twenty-one characters cannot be fussier than that',
     fleetDefault.find(x => x.slot === 'weapon').fallback.test('long sword'));
}

console.log('\nseeding one from a sheet');
{
  const sheet = { character: 'Piggy', agent: 't2',
    equipment: { worn: [{ name: 'leather armor' }, { name: 'mace' }] },
    spells: [{ name: 'create food', school: 'Kraanan', level: 1 }] };
  const l = L.starterFrom(sheet);
  ok('it is the character, not a template', l.character === 'Piggy' && l.agent === 't2');
  ok('worn gear becomes the gear it is meant to get back to',
     l.gear.weapon.includes('mace') && l.gear.slots.body?.includes('leather armor'));
  ok('the two reagents the whole fleet turns on are seeded',
     l.carry.some(c => c.item === 'elderberry') && l.carry.some(c => c.item === 'herb'));
  ok('and it says it is an observation rather than a plan', /not a plan yet/.test(l.note));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
