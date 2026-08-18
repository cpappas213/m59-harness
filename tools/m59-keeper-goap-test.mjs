#!/usr/bin/env node
// m59-keeper-goap-test.mjs -- tests for the GOAP keeper.
//
// Offline, no server:  node tools/m59-keeper-goap-test.mjs

import { fakeClient, fakeSession } from './m59-fake-client.mjs';
import { GOAPKeeper } from './m59-keeper-goap.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('GOAPKeeper: constructor\n');

{
  let threw = false;
  try { new GOAPKeeper({}); } catch { threw = true; }
  ok('no client throws', threw);

  threw = false;
  try { new GOAPKeeper({ client: fakeClient() }); } catch { threw = true; }
  ok('no session throws', threw);
}

console.log('GOAPKeeper: pass() reads world state and plans\n');

{
  // A character at vigor 40 (under the cap of 80) with no food and no
  // reagents. The goal vigor_ok is false. The planner should find no plan
  // (no way to eat or cast).
  const c = fakeClient({ vigor: 40, mana: 25, spells: [], inventory: [] });
  const s = fakeSession(c);
  const notes = [];
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: (msg, data) => notes.push({ msg, data }),
  });

  const r = await keeper.pass();
  ok('no plan: acted is false', r.acted === false);
  ok('no plan: reason mentions no plan', /no plan|not reachable/.test(r.reason ?? ''), r.reason);
}

{
  // A character at vigor 20 (under the cap) with no food. The goal
  // can_rest_higher is true (20 < 80). The planner should find a plan: rest.
  const c = fakeClient({ vigor: 20, mana: 25, spells: [], inventory: [] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'can_rest_higher',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('goal already satisfied: acted is false', r.acted === false);
  ok('goal already satisfied: reason says so', /already satisfied/.test(r.reason ?? ''), r.reason);
}

{
  // A character at vigor 40 (under the cap). Goal can_rest_higher is true
  // (40 < 80). Already satisfied.
  const c = fakeClient({ vigor: 40, mana: 25, spells: [], inventory: [] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'can_rest_higher',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('under the cap: goal satisfied, no action', r.acted === false);
}

console.log('GOAPKeeper: at the cap, rest is still planned (the planner cannot know the cap)\n');

{
  // A character at vigor 80 (at the cap). Goal can_rest_higher is false
  // (80 is not < 80). The planner finds: rest. Rest's effect is
  // can_rest_higher, so the planner thinks resting will establish the goal.
  // This is a known limitation: the planner does not model the cap. The
  // step executes, the world state re-evaluates, and can_rest_higher is
  // still false. The next pass() re-plans and finds the same plan. The
  // caller (autopilot) is responsible for detecting the stall.
  const c = fakeClient({ vigor: 80, mana: 25, spells: [], inventory: [] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'can_rest_higher',
    note: () => {},
  });

  const r = await keeper.pass();
  // The planner finds rest as a plan. It will execute, but the cap means
  // vigor won't rise. This is a stall, not a bug — the caller detects it.
  ok('at the cap: planner finds rest (the cap is not in the vocabulary)', r.acted === true);
}

console.log('GOAPKeeper: goal is configurable\n');

{
  // A character with a weapon equipped. Goal armed is true.
  const c = fakeClient({
    vigor: 40, mana: 25, spells: [], inventory: [],
    equipped: [{ id: 3, name: 'mace' }],
  });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'armed',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('armed: goal satisfied, no action', r.acted === false);
  ok('armed: reason says satisfied', /already satisfied/.test(r.reason ?? ''), r.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
