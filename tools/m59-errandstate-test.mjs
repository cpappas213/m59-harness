#!/usr/bin/env node
// m59-errandstate-test.mjs -- the errand vocabulary, and the wall between it and
// the act vocabulary.
//
// Offline, no server:  node tools/m59-errandstate-test.mjs
//
// The wall is the point. Both registries answer questions about the same character
// and some of them sound identical -- "does it have reagents", "where is it" -- but
// one reads a live client on a one-second clock and the other reads a `fleet` row
// fetched by a supervisor every few minutes. Sharing a name lets a plan chain a
// fact that is true now to one that was true five minutes ago, silently.
//
// This repository has already paid for that exact mistake once: ms_since_moved
// measures the KEEPER, was read as though it measured the CHARACTER, invented a
// stall that was not there, and got two correct behaviours reverted before anybody
// noticed the two questions had one name.

import { ERRAND_SYMBOLS, ERRAND_SYMBOL_NAMES, evaluateErrand, errandUnknowns,
         validateErrand, validateErrands, RAZA_ROOMS } from './m59-errandstate.mjs';
import { SYMBOL_NAMES } from './m59-worldstate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const row = (over = {}) => ({
  agent: 't1', character: 'Kermit', room_num: 60, purse: 500,
  reagents: { elderberry: 4, herbs: 4 }, level: 30, max_health: 50,
  keeper_running: true, stalled: false, policy: { hunt: 'mummy', assignedRoom: 60 },
  ...over,
});

console.log('\nthe registry is well formed, and separate');
{
  ok('it has symbols', ERRAND_SYMBOL_NAMES.length > 0);
  for (const [n, s] of Object.entries(ERRAND_SYMBOLS)) {
    ok(`${n} describes itself and states its unknown answer`,
       !!s.describe && typeof s.whenUnknown === 'boolean' && !!s.why_unknown);
  }
  // THE WALL. If these ever intersect, a plan can cross clocks without saying so.
  const shared = ERRAND_SYMBOL_NAMES.filter(n => SYMBOL_NAMES.includes(n));
  ok('NO SYMBOL NAME IS SHARED WITH THE ACT VOCABULARY', shared.length === 0,
     'shared: ' + shared.join(', '));
}

console.log('\nan errand naming an ACT symbol is a scope error, and says so');
{
  const p = validateErrand({ name: 'travel_to', pre: ['armed'], effects: ['out_of_raza'] });
  ok('it is rejected', p.length === 1);
  ok('and the message explains the two clocks rather than just "unknown symbol"',
     /fleet row that may be minutes old/.test(p[0]), p[0]);
  ok('an errand symbol validates fine',
     validateErrand({ name: 'x', pre: ['out_of_raza'], effects: ['funded'] }).length === 0);
  ok('negation works too',
     validateErrand({ name: 'x', pre: ['!stalled'] }).length === 0);
  ok('validateErrands checks a whole set',
     validateErrands([{ name: 'a', pre: ['nope'] }, { name: 'b', effects: ['in_reach'] }]).length === 2);
}

console.log('\nunknown fails safe — and a missing ROW is the common case');
{
  // A logged-out character has no row at all, so this direction matters more here
  // than in the act vocabulary, not less.
  const blind = evaluateErrand({});
  ok('no keeper seen means NOT running — two drivers on one character is the risk',
     blind.keeper_running === false);
  ok('no reading means NOT stalled — a missing reading is not evidence of a stall',
     blind.stalled === false);
  ok('unknown room means NOT out of raza', blind.out_of_raza === false);
  ok('unknown room means NOT at the assigned room', blind.at_assigned_room === false);
  ok('unreadable purse means NOT funded', blind.funded === false);
  ok('unreadable pack means NOT stocked', blind.stocked === false);
  ok('and every one of them fails CLOSED, because an errand acting on a guess ' +
     'walks a real character somewhere',
     Object.values(blind).every(v => v === false));
}

console.log('\nout_of_raza knows the island');
{
  ok('the newbie island is 1011-1018', RAZA_ROOMS.length === 8 && RAZA_ROOMS[0] === 1011);
  ok('inside it is not out', evaluateErrand({ row: row({ room_num: 1014 }) }).out_of_raza === false);
  ok('the mainland is out', evaluateErrand({ row: row({ room_num: 60 }) }).out_of_raza === true);
}

console.log('\nfunded takes the price from the CALLER, not from a constant');
{
  // A weapon, a skill and a hall are three different prices. One "enough money"
  // threshold would be a number with two meanings.
  const r = row({ purse: 500 });
  ok('500 covers a 400 purchase', evaluateErrand({ row: r, need: 400 }).funded === true);
  ok('and does not cover 5000', evaluateErrand({ row: r, need: 5000 }).funded === false);
  ok('a skill at 500 is exactly affordable — level 1 is 250*2, not 250',
     evaluateErrand({ row: r, need: 500 }).funded === true);
}

console.log('\ncan_advance is STRICTLY above max health');
{
  // Max health is the level here, and AdvancementCheck needs the creature strictly
  // above it -- which is why characters stuck at 50 could farm a level-50 fungus
  // beast indefinitely and gain nothing while every row read healthy.
  const r = row({ max_health: 50 });
  ok('a level 50 creature against 50 max health pays NOTHING',
     evaluateErrand({ row: r, preyLevel: 50 }).can_advance === false);
  ok('51 does', evaluateErrand({ row: r, preyLevel: 51 }).can_advance === true);
  ok('and an unknown prey level refuses rather than assuming a gain',
     evaluateErrand({ row: r }).can_advance === false);
}

console.log('\nstocked is min(elderberry, herbs), from a row instead of a pack');
{
  ok('two of each is a casting',
     evaluateErrand({ row: row({ reagents: { elderberry: 2, herbs: 2 } }) }).stocked === true);
  // The same measured failure as the act vocabulary, seen through the other source.
  ok('NINETY-FOUR HERBS AND ONE ELDERBERRY IS NOT',
     evaluateErrand({ row: row({ reagents: { elderberry: 1, herbs: 94 } }) }).stocked === false);
  ok('and the singular field name still counts',
     evaluateErrand({ row: row({ reagents: { elderberry: 4, herb: 4 } }) }).stocked === true);
}

console.log('\nerrandUnknowns says what was guessed');
{
  const u = errandUnknowns({});
  ok('it reports the symbols it could not answer', u.length === ERRAND_SYMBOL_NAMES.length);
  ok('with what each assumed and why', u.every(x => typeof x.assumed === 'boolean' && x.why));
  ok('and a full row leaves nothing guessed',
     errandUnknowns({ row: row(), need: 1, preyLevel: 60 }).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
