#!/usr/bin/env node
// THE PLAYBOOK — what the keeper does at the moments it has no opinion about. Offline,
// no server, no broker, safe any time:
//
//   node tools/m59-playbook-test.mjs
//
// Everything here is fixtures against a pure function, which is the point: the moments
// this table covers are a player attacking you, dying, and gaining a level. Testing them
// for real means arranging all three on a live shared server, so in practice they would
// be tested by hoping.
//
// What is pinned, in order of how expensive being wrong would be:
//
//   1. AN ABSENT PLAYBOOK CHANGES NOTHING. Silence resolves to null and the keeper does
//      what it did before this file existed. Getting this backwards — silence meaning
//      "do nothing" rather than "carry on" — would replace the survival ladder with
//      paralysis at exactly the moments it is most needed.
//   2. AN UNKNOWN CONDITION NEVER HOLDS, and a typo therefore disables a rule rather
//      than promoting it to unconditional.
//   3. THE VERBS ARE A CLOSED SET. A bot cannot hand the keeper an arbitrary act.
//   4. THE TWO OUTWARD VERBS need a literal message, because `prod` is a shared server
//      and the text is visible to strangers and attributable to the account.

import { decide, validate, VERBS, TRIGGERS, unknownVerbs } from './m59-playbook.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const clean = pb => validate(pb).length === 0;
const problems = pb => validate(pb).map(p => p.where).join(',');

console.log('\nsilence means carry on');
{
  const facts = { who: 'somebody', health_pct: 0.3, room: 71, attackers: 1, in_safe_spot: false };
  ok('no playbook at all', decide('attacked_by_player', null, facts) === null);
  ok('a playbook with no `on`', decide('attacked_by_player', {}, facts) === null);
  ok('a playbook that covers a different moment',
     decide('attacked_by_player', { on: { died: [{ do: 'nothing' }] } }, facts) === null);
  ok('an empty rule list', decide('attacked_by_player', { on: { attacked_by_player: [] } }, facts) === null);
  // The distinction that matters: DECLARED nothing is not the same as nothing declared.
  // One of them is a decision somebody made and belongs in the journal.
  const declared = decide('attacked_by_player', { on: { attacked_by_player: [{ do: 'nothing' }] } }, facts);
  ok('but an explicit `nothing` is an answer, not a silence', declared?.verb === 'nothing');
  ok('an unknown trigger is null rather than a throw', decide('invented', { on: {} }, {}) === null);
}

console.log('\nattacked by a player');
{
  // The worked example from the design: run if it is one attacker and we are healthy,
  // log off for five minutes if we are losing. A player who has to wait five minutes
  // usually goes elsewhere; a player you merely walked away from does not.
  const pb = { on: { attacked_by_player: [
    { when: { health_pct_below: 0.5 }, do: 'logoff', stay_off_s: 300,
      why: 'they came for a fight now, and will not wait five minutes for one' },
    { when: { attackers_at_least: 2 }, do: 'logoff', stay_off_s: 300 },
    { do: 'retreat' },
  ] } };
  ok('the playbook is valid', clean(pb), problems(pb));

  const hurt = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.3, attackers: 1, room: 71, in_safe_spot: false });
  ok('badly hurt logs off', hurt.verb === 'logoff' && hurt.args.stay_off_s === 300);
  ok('and carries the reason into the journal', /will not wait five minutes/.test(hurt.why));

  const ganged = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.9, attackers: 3, room: 71, in_safe_spot: false });
  ok('healthy but outnumbered also logs off', ganged.verb === 'logoff' && ganged.rule === 1);

  const fine = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.9, attackers: 1, room: 71, in_safe_spot: false });
  ok('healthy and alone retreats', fine.verb === 'retreat' && fine.rule === 2);

  // FIRST MATCH WINS, so a doctrine reads top to bottom.
  ok('and the first matching rule is the one that runs', hurt.rule === 0);
}

console.log('\nconditions that nobody can evaluate');
{
  // THE DANGEROUS DIRECTION. An unrecognised condition must fail CLOSED: a typo disables
  // its rule rather than promoting it to unconditional. The opposite convention turns
  // `health_pct_bellow: 0.5` into "log off every single time a player is nearby".
  const typo = { on: { attacked_by_player: [
    { when: { health_pct_bellow: 0.5 }, do: 'logoff', stay_off_s: 60 },
    { do: 'retreat' },
  ] } };
  const got = decide('attacked_by_player', typo,
    { who: 'x', health_pct: 0.1, attackers: 1, room: 71, in_safe_spot: false });
  ok('a misspelled condition does not fire its rule', got.verb === 'retreat');
  ok('and validation says so, naming the fields that exist',
     validate(typo).some(p => /when.health_pct_bellow/.test(p.where) && /never fire/.test(p.why)),
     JSON.stringify(validate(typo)));

  // A fact the trigger does supply, but which this event did not carry.
  const missing = { on: { died: [{ when: { level_at_least: 30 }, do: 'nothing' }] } };
  ok('a condition on a fact that came back null does not hold',
     decide('died', missing, { killed_by: 'a rat', level: null }) === null);
}

console.log('\nthe verbs are a closed set');
{
  const invented = { on: { attacked_by_player: [
    { do: 'cast_fireball_at_them' },
    { do: 'retreat' },
  ] } };
  const got = decide('attacked_by_player', invented,
    { who: 'x', health_pct: 1, attackers: 1, room: 71, in_safe_spot: false });
  ok('a verb this harness does not know is skipped, not guessed at', got.verb === 'retreat');
  ok('and is reportable rather than silent',
     JSON.stringify(unknownVerbs(invented)) === '["cast_fireball_at_them"]');
  ok('and validation refuses it', validate(invented).some(p => /\.do$/.test(p.where)));

  // There is deliberately no way to say "stand still". A playbook ADDS a response; it
  // cannot remove the survival floor, which is the whole promise of the carve-out.
  ok('there is no verb for standing still',
     !Object.keys(VERBS).some(v => /stand_still|ignore|do_nothing|suppress/.test(v)));
  ok('and none of them is an arbitrary tool call',
     Object.values(VERBS).every(v => Array.isArray(v.args)));
}

console.log('\nspeaking to a shared server');
{
  // `prod` has real players on it. Anything the fleet says is visible to strangers and
  // attributable to whoever owns the account, so the text is a literal somebody chose in
  // advance and never something assembled from what the world said back to us.
  ok('say with no message is refused',
     validate({ on: { died: [{ do: 'say' }] } }).some(p => /message/.test(p.where)));
  ok('tell with no recipient is refused',
     validate({ on: { died: [{ do: 'tell', message: 'hello' }] } }).some(p => /\.to$/.test(p.where)));
  ok('a literal message is fine',
     clean({ on: { died: [{ do: 'tell', to: 'a-role', message: 'I died at the crossroads.' }] } }));
  ok('something that looks like a template is refused',
     validate({ on: { died: [{ do: 'say', message: 'I died in ${room}' }] } })
       .some(p => /message/.test(p.where)));
  ok('and so is one longer than the game will send',
     validate({ on: { died: [{ do: 'say', message: 'x'.repeat(200) }] } })
       .some(p => /message/.test(p.where)));
}

console.log('\nthe one verb that blocks');
{
  // `ask_for_orders` is the escape hatch and its whole cost is latency. It has to be
  // possible — that is what makes hands-on LLM supervision work at all — and it has to
  // be impossible to reach for by accident at the moment it is most expensive.
  ok('a short wait on a slow trigger is fine',
     clean({ on: { improved: [{ do: 'ask_for_orders', wait_s: 20 }] } }));
  ok('a long wait is refused anywhere',
     validate({ on: { improved: [{ do: 'ask_for_orders', wait_s: 120 }] } })
       .some(p => /wait_s/.test(p.where)));
  ok('and on attacked_by_player even a moderate one is refused, because the answer ' +
     'would arrive after the fight',
     validate({ on: { attacked_by_player: [{ do: 'ask_for_orders', wait_s: 20 }] } })
       .some(p => /wait_s/.test(p.where) && /after the fight/.test(p.why)));
  ok('five seconds there is allowed',
     clean({ on: { attacked_by_player: [{ do: 'ask_for_orders', wait_s: 5 }] } }));
}

console.log('\nlogging off is not free');
{
  ok('a stay-off window is required', validate({ on: { attacked_by_player: [{ do: 'logoff' }] } })
       .some(p => /stay_off_s/.test(p.where)));
  ok('and an absurd one is refused — a character that is off is not being defended, ' +
     'not earning, and not on the board',
     validate({ on: { attacked_by_player: [{ do: 'logoff', stay_off_s: 7200 }] } })
       .some(p => /stay_off_s/.test(p.where)));
  ok('five minutes is fine',
     clean({ on: { attacked_by_player: [{ do: 'logoff', stay_off_s: 300 }] } }));
}

console.log('\nthe three moments');
{
  ok('are attacked_by_player, died and improved',
     JSON.stringify(Object.keys(TRIGGERS)) ===
     JSON.stringify(['attacked_by_player', 'died', 'improved']));
  ok('and each states what it knows, so a `when` can be checked against it',
     Object.values(TRIGGERS).every(t => Array.isArray(t.facts) && t.facts.length && t.why));

  // A block for a trigger that does not exist can never run, and nothing else would say so.
  ok('a block for a trigger that does not exist is reported',
     validate({ on: { attacked_by_monster: [{ do: 'retreat' }] } })
       .some(p => /can never run/.test(p.why)));

  // The worked case for `improved`: max health IS the level, and a kill only pays when
  // the creature's level is strictly above it — so a gain can make the current prey
  // worthless without anything else changing.
  const retask = { on: { improved: [
    { when: { what_is: 'max_health', to_at_least: 50 }, do: 'ask_for_orders', wait_s: 20,
      why: 'a level-50 creature cannot advance a level-50 character; the prey needs re-picking' },
  ] } };
  ok('gaining into a new band asks for orders',
     decide('improved', retask, { what: 'max_health', from: 49, to: 50, hunting: 'fungus beast', room: 544 })
       ?.verb === 'ask_for_orders');
  ok('and a smaller gain does not',
     decide('improved', retask, { what: 'max_health', from: 40, to: 41, hunting: 'x', room: 544 }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
