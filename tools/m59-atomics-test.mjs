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
const _tests = [];
function test(name, fn) {
  _tests.push({ name, fn });
}
async function runTests() {
  for (const { name, fn } of _tests) {
    try {
      await fn();
      _passed++;
      console.log(`PASS  ${name}`);
    } catch (err) {
      _failed++;
      console.log(`FAIL  ${name}: ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    }
  }
  console.log('');
  console.log(`${_passed}/${_passed + _failed} passing`);
  process.exit(_failed > 0 ? 1 : 0);
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
      case 'inventory':  return { items: [{ name: 'shillings', amount: (globalThis.__purse ?? 0) }] };
      case 'bank':       return globalThis.__bankFails ? { error: 'no bank in this room' } : { balance: 500 };
      case 'sell_all':   return { total_received: globalThis.__sellFor ?? 0 };
      case 'shop':       return globalThis.__shopStock ?? { items: [] };
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
    // Arm-errand primitives. In-process reads come off the live client inventory;
    // the mock re-reads globalThis so a test can vary the purse between steps.
    client: { get inventory() { return globalThis.__purseInv ?? [{ name: 'shillings', amount: 0 }]; } },
    async bank(action, amount)          { calls.push(['bank', action, amount]);
      return globalThis.__bankFails ? { error: 'no bank in this room' } : { balance: 500 }; },
    async sellAll(merchant, keep)       { calls.push(['sellAll', merchant, keep]);
      return { total_received: globalThis.__sellFor ?? 0 }; },
    async shop(seller, buyIds)          { calls.push(['shop', seller, buyIds]);
      if (buyIds) return { bought: buyIds.length }; return globalThis.__shopStock ?? { items: [] }; },
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

test('ensure_funded_withdraws_when_purse_short', async () => {
  const b = makeBroker();
  globalThis.__purse = 10;              // starts short of 500
  const ctx = brokerDriver('http://x', b.callTool);
  const res = await runAtomic('ensure_funded', ctx, { agent: 't1', need: 500, withdraw: 1000 });
  delete globalThis.__purse;
  // The mock re-read returns the same purse (no real money moves), so funded stays
  // false -- the point is the withdraw was ATTEMPTED and the step recorded, not a
  // hang or a throw, and that a failed withdrawal is NOT mislabeled as a withdrawal.
  assert(res.steps.includes('bank said yes, purse did not grow'), 'a silent-failed withdraw is reported honestly, not as a sale');
  assert(b.calls.some(c => c.name === 'bank' && c.args.action === 'withdraw'), 'bank withdraw was issued');
});

test('ensure_funded_reports_no_bank_without_throwing', async () => {
  const b = makeBroker();
  globalThis.__purse = 0;
  globalThis.__bankFails = true;
  const ctx = brokerDriver('http://x', b.callTool);
  const res = await runAtomic('ensure_funded', ctx, { agent: 't1', need: 500 });
  delete globalThis.__purse; delete globalThis.__bankFails;
  assertEq(res.funded, false, 'still short');
  assert(res.steps.includes('no withdrawal here'), 'the failed withdrawal is reported, not thrown');
});

test('ensure_funded_sells_to_make_up_difference', async () => {
  const b = makeBroker();
  globalThis.__purse = 0;
  globalThis.__bankFails = true;       // no bank here
  globalThis.__sellFor = 600;          // selling covers the need
  const ctx = brokerDriver('http://x', b.callTool);
  const res = await runAtomic('ensure_funded', ctx, { agent: 't1', need: 500 });
  delete globalThis.__purse; delete globalThis.__bankFails; delete globalThis.__sellFor;
  assertEq(res.funded, true, 'selling made it funded');
  assert(res.steps.some(s => s.startsWith('sold for')), 'the sale was recorded');
  assert(b.calls.some(c => c.name === 'sell_all'), 'sell_all was issued');
});

test('buy_item_buys_cheapest_matching_from_stock', async () => {
  const b = makeBroker();
  globalThis.__shopStock = { items: [
    { id: 11, name: 'fine long sword', cost: 900 },
    { id: 12, name: 'long sword', cost: 150 },
    { id: 13, name: 'leather armor', cost: 800 },
  ] };
  const ctx = brokerDriver('http://x', b.callTool);
  const res = await runAtomic('buy_item', ctx, { agent: 't1', seller: 'smith', want: /long sword/i });
  delete globalThis.__shopStock;
  assertEq(res.bought, true, 'bought something');
  assertEq(res.id, 12, 'the cheapest matching item, not the fine one');
  assertEq(res.cost, 150, 'paid the right price');
  const buy = b.calls.find(c => c.name === 'shop' && c.args.buy_ids);
  assert(buy, 'a buy call was issued');
  assertEq(buy.args.buy_ids[0], 12, 'bought id 12');
});

test('buy_item_falls_back_and_reports_missing', async () => {
  const b = makeBroker();
  globalThis.__shopStock = { items: [{ id: 21, name: 'chain armor', cost: 1800 }] };
  const ctx = brokerDriver('http://x', b.callTool);
  // want leather (absent), fallback matches chain -> buys it
  const r1 = await runAtomic('buy_item', ctx, { agent: 't1', seller: 's', want: /leather/i, fallback: /chain/i });
  assertEq(r1.bought, true, 'fallback matched');
  // want leather, no fallback, absent -> clean { bought:false }, not a throw
  const r2 = await runAtomic('buy_item', ctx, { agent: 't1', seller: 's', want: /leather/i });
  assertEq(r2.bought, false, 'missing item is a clean miss');
  delete globalThis.__shopStock;
});

test('buy_item_times_out_without_hanging_the_errand', async () => {
  // The regression this whole decomposition exists for: a hung shop call must not
  // hang the errand forever. The mock broker blocks forever on the shop call.
  const b = makeBroker();
  const ctx = brokerDriver('http://x', async (name, args) => {
    if (name === 'shop' && !args.buy_ids) return new Promise(() => {});   // hang
    return { items: [] };
  });
  const t0 = Date.now();
  const res = await runAtomic('buy_item', ctx, { agent: 't1', seller: 's', want: /sword/i });
  const ms = Date.now() - t0;
  assertEq(res.bought, false, 'a hang reads as a miss, not a hang');
  assert(ms < 21000, `returned at the 20s bound (took ${ms}ms), not hung forever`);
});

test('atomic_names_include_the_arm_errand_atoms', () => {
  for (const n of ['ensure_funded', 'buy_item'])
    assert(ATOMIC_NAMES.includes(n), `atomic ${n} should exist`);
});

test('bt_travelToAction_wraps_atomic_into_running_slot', async () => {
  // A BT Action node built on the travel_to atomic must follow the RUNNING/slot
  // protocol: tick 0 kicks off and returns RUNNING, a later tick reports SUCCESS.
  const { k, calls } = makeKeeper();
  const bb = { client: null, session: k, _bt: {} };
  const action = travelToAction(k, 52);
  assertEq(action.tick(bb), RUNNING, 'first tick kicks off and returns RUNNING');
  // The travel call is fire-and-forget; it resolves on a macrotask, not a microtask,
  // so a single Promise.resolve() is not enough for the slot to settle.
  await new Promise(r => setTimeout(r, 10));
  assertEq(action.tick(bb), SUCCESS, 'second tick reports SUCCESS');
  assertEq(calls[0][0], 'travel', 'travel method called');
  assertEq(calls[0][1], 52, 'travel to=52');
});

test('bt_reviveKeeperAction_reports_success', async () => {
  const { k, calls } = makeKeeper();
  const bb = { client: null, session: k, _bt: {} };
  const action = reviveKeeperAction(k);
  assertEq(action.tick(bb), RUNNING, 'kick off');
  await new Promise(r => setTimeout(r, 10));
  assertEq(action.tick(bb), SUCCESS, 'revive succeeded');
  assertEq(calls[0][0], 'revive', 'revive method called');
});

runTests();
