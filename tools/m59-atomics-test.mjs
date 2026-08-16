#!/usr/bin/env node
// m59-atomics-test.mjs -- offline tests for the GOAP atomic layer.
//
// Proves that tools/m59-atomics.mjs is a single shared implementation of the
// primitive keeper operations that both the GOAP planner and the behavior tree
// delegate to:
//
//   - brokerDriver issues broker MCP tool calls over HTTP (mock fetch).
//   - keeperDriver issues in-process keeper method calls (mock keeper).
//   - each atomic runs against BOTH drivers with the same params and name.
//   - the relocate_then_revive composite is the exact stop->travel->revive
//     triple the five GOAP town-trip actions used to copy-paste.
//   - innDest has one home (the <400 ? 52 : 370 rule).
//   - runAtomic rejects an unknown atomic name rather than silently no-opping.
//   - a BT action node wraps an atomic promise into the RUNNING/slot protocol.
//
// Pure in-memory. No broker, no client, no real HTTP -- fetch is stubbed.
//
// Run with:   node tools/m59-atomics-test.mjs

import {
  brokerDriver, keeperDriver, runAtomic, relocateThenRevive, innDest,
  ATOMIC_NAMES,
} from './m59-atomics.mjs';
import { RUNNING, SUCCESS, FAILURE } from './m59-bt.mjs';
import { travelToAction, reviveKeeperAction } from './m59-bt-nodes.mjs';

// Tiny test harness.
let _passed = 0;
let _failed = 0;
function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    _failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// Mock broker tool: records calls, resolves with a canned result per tool.
// ---------------------------------------------------------------------------

function makeBroker() {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    switch (name) {
      case 'autopilot': return {};
      case 'travel':    return { arrived: true };
      case 'prey':      return { candidates: [{ creature: 'ant', best_room: 5 }] };
      case 'who':       return { here: [{ name: 'Fleetmate' }] };
      case 'inn':       return {};
      case 'buy_next_planned_skills': return { results: [{ queued: true, ability: 'blink', price: 500 }] };
      case 'leave_raza': return { left: true };
      default: return null;
    }
  };
  return { calls, callTool };
}

// ---------------------------------------------------------------------------
// Mock keeper: records method calls, resolves fixed results.
// ---------------------------------------------------------------------------

function makeKeeper() {
  const calls = [];
  const k = {
    policy: {},
    async armSelf(why)                  { calls.push(['armSelf', why]); return true; },
    async makeWeapon(why)               { calls.push(['makeWeapon', why]); return true; },
    async buyWeaponsAtNearestSmith(o)   { calls.push(['buySmith', o && o.why]); return true; },
    async travel(to)                    { calls.push(['travel', to]); return { arrived: true }; },
    async revive(why)                   { calls.push(['revive', why]); return true; },
    async stop(why)                     { calls.push(['stop', why]); return true; },
  };
  return { k, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('broker_driver_issues_tool_calls', async () => {
  const b = makeBroker();
  const ctx = brokerDriver('http://x', b.callTool);
  await runAtomic('travel_to', ctx, { agent: 't2', to: 52 });
  assertEq(b.calls.length, 1, 'one tool call');
  assertEq(b.calls[0].name, 'travel', 'travel tool');
  assertEq(b.calls[0].args.to, 52, 'to=52');
  assertEq(b.calls[0].args.agent, 't2', 'agent carried');
});

test('broker_driver_set_policy_spreads_fields', async () => {
  const b = makeBroker();
  const ctx = brokerDriver('http://x', b.callTool);
  await runAtomic('set_policy', ctx, { agent: 't2', fields: { hunt: 'ant', assigned_room: 5 } });
  assertEq(b.calls[0].name, 'autopilot', 'autopilot tool');
  assertEq(b.calls[0].args.action, 'set', 'action=set');
  assertEq(b.calls[0].args.hunt, 'ant', 'hunt spread');
  assertEq(b.calls[0].args.assigned_room, 5, 'assigned_room spread');
});

test('keeper_driver_calls_keeper_methods', async () => {
  const { k, calls } = makeKeeper();
  const ctx = keeperDriver(k);
  await runAtomic('equip_best', ctx, { agent: 't2', why: 'BT: equip from pack' });
  await runAtomic('conjure_weapon', ctx, { agent: 't2', why: 'BT: conjure weapon' });
  await runAtomic('buy_weapon', ctx, { agent: 't2', why: 'BT: travel and buy' });
  assertEq(calls.length, 3, 'three keeper calls');
  assertEq(calls[0][0], 'armSelf', 'equip_best -> armSelf');
  assertEq(calls[1][0], 'makeWeapon', 'conjure_weapon -> makeWeapon');
  assertEq(calls[2][0], 'buySmith', 'buy_weapon -> buyWeaponsAtNearestSmith');
});

test('same_atomic_works_via_both_drivers', async () => {
  // travel_to is the same atomic regardless of driver: the broker driver issues
  // `travel {to}`, the keeper driver calls keeper.travel(to).
  const b = makeBroker();
  const bctx = brokerDriver('http://x', b.callTool);
  const res = await runAtomic('travel_to', bctx, { agent: 't2', to: 52 });
  assertEq(res.arrived, true, 'broker travel returns arrived');

  const { k, calls } = makeKeeper();
  const kctx = keeperDriver(k);
  const res2 = await runAtomic('travel_to', kctx, { agent: 't2', to: 52 });
  assertEq(res2.arrived, true, 'keeper travel returns arrived');
  assertEq(calls[0][1], 52, 'keeper travel got to=52');
});

test('relocate_then_revive_is_stop_travel_revive', async () => {
  const b = makeBroker();
  const ctx = brokerDriver('http://x', b.callTool);
  await relocateThenRevive(ctx, {
    agent: 't2', to: 370,
    stopWhy: 'hurt', reviveWhy: 'arrived',
  });
  assertEq(b.calls.length, 3, 'exactly three tool calls');
  assertEq(b.calls[0].name, 'autopilot', 'stop first');
  assertEq(b.calls[0].args.action, 'stop', 'action=stop');
  assertEq(b.calls[0].args.why, 'hurt', 'stop why');
  assertEq(b.calls[1].name, 'travel', 'travel second');
  assertEq(b.calls[1].args.to, 370, 'to=370');
  assertEq(b.calls[2].name, 'autopilot', 'revive third');
  assertEq(b.calls[2].args.action, 'revive', 'action=revive');
  assertEq(b.calls[2].args.why, 'arrived', 'revive why');
});

test('innDest_has_one_home', () => {
  assertEq(innDest(100), 52, 'west of 400 -> Tos inn 52');
  assertEq(innDest(399), 52, '399 still Tos');
  assertEq(innDest(400), 370, 'east of 400 -> Jasper inn 370');
  assertEq(innDest(900), 370, 'far east -> Jasper');
  assertEq(innDest(0), 52, 'unknown room defaults west');
});

test('runAtomic_rejects_unknown_atomic', async () => {
  const b = makeBroker();
  const ctx = brokerDriver('http://x', b.callTool);
  let threw = false;
  try { await runAtomic('definitely_not_an_atomic', ctx, {}); }
  catch (e) { threw = true; assert(/unknown atomic/.test(e.message), 'message names the typo'); }
  assert(threw, 'unknown atomic must throw');
  assertEq(b.calls.length, 0, 'no tool call issued for an unknown atomic');
});

test('atomic_names_cover_both_systems', () => {
  // Every primitive the GOAP planner and the get_armed BT use is present.
  for (const n of ['revive_keeper', 'stop_keeper', 'travel_to', 'set_policy',
                   'pick_prey', 'claim_inn', 'buy_skills', 'leave_raza', 'who_in_room',
                   'equip_best', 'conjure_weapon', 'buy_weapon']) {
    assert(ATOMIC_NAMES.includes(n), `atomic ${n} should exist`);
  }
});

test('bt_travelToAction_wraps_atomic_into_running_slot', async () => {
  // A BT Action node built on the travel_to atomic must follow the RUNNING/slot
  // protocol: tick 0 kicks off and returns RUNNING, tick 1 reports SUCCESS.
  const { k, calls } = makeKeeper();
  const bb = { client: null, session: k, _bt: {} };
  const action = travelToAction(k, 52);
  const first = action.tick(bb);
  assertEq(first, RUNNING, 'first tick kicks off and returns RUNNING');
  // The travel call is fire-and-forget; let the microtask land.
  await Promise.resolve();
  const second = action.tick(bb);
  assertEq(second, SUCCESS, 'second tick reports SUCCESS');
  assertEq(calls[0][0], 'travel', 'travel method called');
  assertEq(calls[0][1], 52, 'travel to=52');
});

test('bt_reviveKeeperAction_reports_success', async () => {
  const { k, calls } = makeKeeper();
  const bb = { client: null, session: k, _bt: {} };
  const action = reviveKeeperAction(k);
  assertEq(action.tick(bb), RUNNING, 'kick off');
  await Promise.resolve();
  assertEq(action.tick(bb), SUCCESS, 'revive succeeded');
  assertEq(calls[0][0], 'revive', 'revive method called');
});

console.log('');
console.log(`${_passed}/${_passed + _failed} passing`);
if (_failed > 0) process.exit(1);
process.exit(0);
