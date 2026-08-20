#!/usr/bin/env node
// GETTING SOMEWHERE UNDER A TICK — the contract test for m59-route.mjs.
//
//   node tools/m59-route-test.mjs
//
// A route is the case that most obviously does not fit a blocking model, and the thing
// under test is that it is STATE: each tick sends at most one square and returns, and
// progress is observed between ticks rather than assumed within a call.
import { Router, routeIntent } from './m59-route.mjs';
import { Actuator } from './m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake world with a known two-room map, so the leg is predictable.
function rig({ here = 10, dest = 20, col = 5, row = 5,
               standOn = { col: 8, row: 5 }, edgeTarget = { col: 9, row: 5 },
               exits = null, pathFound = true } = {}) {
  const sent = [];
  let exitCalls = 0;
  const session = {
    name: 't1', live: true,
    client: { moveToSquare: (c, r) => sent.push([c, r]) },
    // SYNCHRONOUS ON PURPOSE, in this double only. The real Pacer defers to a
    // microtask, which is what makes the actuator fire-and-forget -- and that is pinned
    // in m59-tick-test.mjs. Here it would just mean every assertion had to await, which
    // would obscure what these tests are actually about.
    pacer: { depth: 0, submit: (k, fn) => { const v = fn(); return Promise.resolve(v); } },
    world: {
      exits() {
        exitCalls++;
        return exits ?? [{ kind: 'edge', to: 20, direction: 'east',
                           stand_on: standOn, edge_target: edgeTarget, steps_away: 3 }];
      },
    },
  };
  const map = { rooms: { 10: { name: 'A' }, 20: { name: 'B' } } };
  let t = 1000;
  const router = new Router({ session, map, now: () => t });
  // findPath is imported by the module; give the router a stub leg planner by handing it
  // a map the real findPath can answer for is overkill — instead patch the one call.
  router._planLeg = (h) => pathFound
    ? { leg: { fromRoom: h, next: 20, standOn, edgeTarget, direction: 'east', startedAt: t } }
    : { why: `no route from ${h} to 20` };
  const act = new Actuator(session);
  const frame = (c, r, room = here) => ({ in_game: true, room: { num: room }, position: { col: c, row: r } });
  return { router, act, sent, frame, session,
           advance: (ms) => { t += ms; }, at: () => t, exitCalls: () => exitCalls };
}

console.log('one tick sends at most one square');
{
  const { router, act, sent, frame } = rig();
  router.to(20);
  const r = router.tick(frame(5, 5), act);
  ok('it reports moving', r.state === 'moving');
  ok('exactly one step went out', sent.length === 1, JSON.stringify(sent));
  ok('and it is ONE SQUARE toward the staging square, not the whole leg',
     sent[0][0] === 6 && sent[0][1] === 5,
     'a multi-square request is a walk we cannot interrupt or observe halfway');
}

console.log('\nprogress is observed between ticks, not assumed within a call');
{
  const { router, act, sent, frame, advance } = rig();
  router.to(20);
  router.tick(frame(5, 5), act);   // -> 6
  advance(100);
  router.tick(frame(6, 5), act);   // -> 7
  advance(100);
  router.tick(frame(7, 5), act);   // -> 8
  ok('three ticks, three single squares', sent.length === 3);
  ok('each aimed from where the SERVER said we were',
     JSON.stringify(sent) === JSON.stringify([[6, 5], [7, 5], [8, 5]]));
}

console.log('\nat the staging square it walks PAST the boundary');
{
  const { router, act, sent, frame } = rig();
  router.to(20);
  const r = router.tick(frame(8, 5), act);      // already on stand_on
  ok('it says it is crossing', r.state === 'crossing');
  ok('and aims at the edge target outside the grid', sent[0][0] === 9,
     'walking past the boundary is what triggers the room change');
}

console.log('\narriving clears the route');
{
  const { router, act, frame } = rig();
  router.to(20);
  const r = router.tick(frame(2, 2, 20), act);   // we are in the destination room
  ok('arrived', r.state === 'arrived');
  ok('and the destination is released', router.dest === null,
     'a route that stays set after arrival is a character that never stops walking');
}

console.log('\nTHE EXPENSIVE CALL RUNS ONLY ON A ROOM CHANGE');
{
  // exits() runs flood fills; its own comment records one call once taking tens of
  // seconds. Calling it per tick would put the cost back that the tick model removes.
  const { router, act, frame, advance, session } = rig();
  let planned = 0;
  const real = router._planLeg.bind(router);
  router._planLeg = (h) => { planned++; return real(h); };
  router.to(20);
  router.tick(frame(5, 5), act); advance(50);
  router.tick(frame(6, 5), act); advance(50);
  router.tick(frame(7, 5), act);
  ok('three ticks in one room planned the leg once', planned === 1, `${planned}`);
  advance(50);
  router.tick(frame(1, 1, 15), act);   // a different room
  ok('a room change replans it', planned === 2,
     'where you arrive is not where the return edge is — nothing about a leg survives a crossing');
}

console.log('\nSTUCK IS MEASURED ON THE CHARACTER, NOT ON US');
{
  const { router, act, frame, advance } = rig();
  router.to(20);
  router.tick(frame(5, 5), act);
  advance(1000); router.tick(frame(5, 5), act);   // did not move
  advance(1000); router.tick(frame(5, 5), act);
  advance(3000);
  const r = router.tick(frame(5, 5), act);
  ok('standing on the same square long enough is reported as stuck', r.state === 'stuck',
     'every other stall number here measures the DRIVER, which is busy and healthy while a character stands in a wall');
  ok('and the leg is thrown away so the next tick replans', router.leg === null);
}

console.log('\nmoving resets the stuck clock');
{
  const { router, act, frame, advance } = rig();
  router.to(20);
  router.tick(frame(5, 5), act);
  advance(3000); router.tick(frame(6, 5), act);   // moved
  advance(3000);
  const r = router.tick(frame(7, 5), act);        // moved again
  ok('a character that keeps moving is never called stuck', r.state === 'moving');
}

console.log('\nrefusals are named, never guessed');
{
  const { router, act, frame } = rig({ pathFound: false });
  router.to(20);
  const r = router.tick(frame(5, 5), act);
  ok('no route is reported as such', r.state === 'no-route');
  ok('and says which pair it could not join', /no route from 10 to 20/.test(r.why));

  const idle = rig().router;
  ok('with no destination it is idle rather than busy', idle.tick({ room: { num: 1 }, position: { col: 1, row: 1 } }, act).state === 'idle');

  const blind = rig().router;
  blind.to(20);
  ok('no position yet is blind, not stuck', blind.tick({ room: { num: 10 } }, act).state === 'blind');
}

console.log('\nthe route intent reports honestly to a decider');
{
  const { router, act, frame } = rig();
  router.to(20);
  const intent = routeIntent(router);
  const moving = intent(frame(5, 5), act);
  ok('a step sent reads as sent', moving.sent === true && /travel moving/.test(moving.what));
  const { router: r2, act: a2, frame: f2 } = rig({ pathFound: false });
  r2.to(20);
  const stuck = routeIntent(r2)(f2(5, 5), a2);
  ok('and a refusal reads as a refusal, with the reason', stuck.sent === false && /no route/.test(stuck.why),
     'so the decider can count it and give the goal up');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
