#!/usr/bin/env node
// m59-cost-test.mjs -- costs change plans, and cost is never risk.
//
// Offline, no server:  node tools/m59-cost-test.mjs
//
// Half of this pins arithmetic. The other half pins a boundary that will erode by
// one reasonable-looking commit at a time unless something objects: COST IS EFFORT,
// COST IS NEVER RISK. A cost can be outbid; a refusal cannot. Anything that should
// stop a plan belongs in `pre`, where no arithmetic reaches it.

import { SECONDS, DEFAULT_SECONDS, costOf, priced, suspiciousCosts, REFUSAL_IN_DISGUISE }
  from './m59-cost.mjs';
import { plan as astar } from './m59-goap-planner.mjs';
import { actionsFor, planFor } from './m59-plan.mjs';
import { fakeClient } from './m59-fake-client.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\ncosts are seconds, and they come from the server\'s own timers');
{
  ok('a swing costs the swing timer', SECONDS.attack === 1.05);
  ok('a cast costs the same', SECONDS.cast === 1.05);
  ok('a posture change is nearly free — it is a packet, not a recovery',
     SECONDS.rest === 0.4 && SECONDS.stand === 0.4);
  ok('an unpriced action is NOT free, or the planner prefers whatever nobody costed',
     costOf({ atomic: 'nonesuch' }) === DEFAULT_SECONDS && DEFAULT_SECONDS > 0);
  ok('a grounded name is priced by its verb',
     costOf({ atomic: 'cast create food' }) === SECONDS.cast);
}

console.log('\nDISTANCE is a legitimate cost input, and the one that matters most');
{
  // Without this the planner treats "walk across the room" and "walk across the
  // world" alike, which is how a starving character routes through three towns.
  ok('one square costs one step', costOf({ atomic: 'step' }, { hops: 1 }) === SECONDS.step);
  ok('twenty squares cost twenty', costOf({ atomic: 'step' }, { hops: 20 })
     === SECONDS.step * 20);
  ok('and a missing hop count never costs less than one',
     costOf({ atomic: 'step' }, {}) === SECONDS.step);
}

console.log('\ncosts actually change which plan wins');
{
  // Two routes to the same goal, one action vs two. With every action at 1 the
  // planner may pick either; priced, the shorter-in-TIME one must win.
  const mk = (name, pre, effects, cost) =>
    ({ name, pre, effects, cost, node: Object.assign(() => ({}), { atomic: name }) });

  const direct = mk('eat',   ['has_food'], ['vigor_ok'], 0.9);
  const slowA  = mk('castA', [],           ['has_food'], 1.05);
  const slowB  = mk('castB', [],           ['has_food'], 40);

  const cheap = astar([direct, slowA, slowB], { has_food: false }, { vigor_ok: true });
  ok('it routes through the cheaper producer', cheap.found === true);
  ok('and the plan is two steps', cheap.steps.length === 2);
  ok('via the 1.05s cast, not the 40s one',
     cheap.steps[0].atomic === 'castA', cheap.steps[0].atomic);
}

console.log('\nthe real action set is priced end to end');
{
  const c = fakeClient({ spells: ['create food'], mana: 30, vigor: 40,
    inventory: [{ id: 1, name: 'elderberry', amount: 4 }, { id: 2, name: 'herbs', amount: 4 }] });
  const acts = actionsFor(c);
  ok('every action carries a cost', acts.every(a => typeof a.cost === 'number' && a.cost > 0));
  ok('no action is free', acts.every(a => a.cost > 0));

  const p = planFor(c, { vigor_ok: true }, { policy: {} });
  ok('the supply chain still plans', p.names.join(' -> ') === 'cast create food -> eat');
  // 1.05 + 0.9 -- a number an operator can check against a stopwatch, which is the
  // whole reason the unit is seconds rather than an abstract score.
  const total = SECONDS.cast + SECONDS.eat;
  ok('and its cost is a wall-clock estimate, ~1.95s',
     Math.abs(total - 1.95) < 0.001, String(total));
}

console.log('\nCOST IS NEVER RISK — the boundary, checked');
{
  // The obvious next feature is "this room is nasty, add 40". Weight danger at 40
  // and a goal worth 50 walks through it; weight it at 10,000 and you have written
  // a refusal in the least legible form available, one that becomes negotiable the
  // day somebody adds a bigger reward.
  const honest = actionsFor(fakeClient({ spells: ['create food'] }));
  ok('nothing in the real action set is priced anywhere near a refusal',
     suspiciousCosts(honest).length === 0);

  const smuggled = [{ name: 'attack a soldier', cost: 5000, pre: [], effects: ['!has_target'] }];
  const flagged = suspiciousCosts(smuggled);
  ok('a refusal smuggled in as a huge cost is caught', flagged.length === 1);
  ok('and the message says where it belongs instead',
     /put it in `pre`/.test(flagged[0]), flagged[0]);
  ok('the threshold is far above anything honest',
     REFUSAL_IN_DISGUISE > Math.max(...Object.values(SECONDS)) * 50);

  // And the load-bearing demonstration: the engagement ceiling is a PRECONDITION,
  // so no reward makes it plannable. There is no number to raise.
  const soldier = fakeClient({
    equipped: [{ id: 5, name: 'mace' }], selfId: 1, col: 10, row: 10,
    room: { num: 1, objects: [{ id: 9, name: 'soldier', col: 11, row: 10 }] } });
  const over = planFor(soldier, { has_target: false },
    { policy: {}, ws: { _targetId: 9, _targetLevel: 70, _threatCeiling: 30 } });
  ok('a target over the ceiling has NO PLAN at any price', over.found === false);
}

console.log('\npricing is non-destructive');
{
  // The same atomic must be priceable differently in two contexts -- a step of one
  // square and a step of twenty -- without either mutating the shared function.
  const base = [{ name: 'step', pre: [], effects: ['in_reach'] }];
  const near = priced(base, { hops: 1 });
  const far  = priced(base, { hops: 20 });
  ok('two contexts give two costs', near[0].cost !== far[0].cost);
  ok('and the original is untouched', base[0].cost === undefined);
  ok('an explicit cost is respected rather than overwritten',
     priced([{ name: 'step', cost: 99 }])[0].cost === 99);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
