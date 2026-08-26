#!/usr/bin/env node
// Pure planner tests: no broker, sockets, keepers, or production state.
import assert from 'node:assert/strict';
import {
  createSingleFlight,
  PHASE_CADENCE_MS,
  planShelterRedistribution,
  validateExactTransferContract,
} from './m59-shelter-quartermaster.mjs';

const item = (id, name, amount = 0, tag = amount > 0 ? 1 : 0, extra = {}) =>
  ({ id, name, amount, tag, ...extra });
const keeperSample = (extra = {}) => ({
  source: "keeper snapshot, plus the keeper's own room view",
  as_of_ms: 250,
  in_game: true,
  connected: true,
  room: { num: 39 },
  hp: { value: 50, max: 50 },
  you: { col: 5, row: 5 },
  goap: { goal: null, action: null, target: null },
  job: null,
  target: null,
  ...extra,
});
const row = (agent, inventory, visible, extra = {}) => ({
  agent,
  character: agent.toUpperCase(),
  room_num: 39,
  in_game: true,
  health: '50/50',
  activity: 'idle',
  loadPercent: 20,
  inventory,
  equipment: { known: true, equipped: [] },
  visibleCharacters: visible.map(name => name.toUpperCase()),
  keeperSamples: [keeperSample(), keeperSample()],
  ...extra,
});

assert.deepEqual(PHASE_CADENCE_MS, {
  food: 5 * 60_000,
  weapons: 10 * 60_000,
  gear: 15 * 60_000,
});

// Food is moved by exact partial-stack quantity and never below the donor's
// nutrition reserve. Two wheels (30 each) fill the empty recipient to 60.
{
  const rows = [
    row('giver', [item(1, 'wheel of cheese', 6)], ['hungry']),
    row('hungry', [], ['giver']),
  ];
  const plan = planShelterRedistribution(rows, { phase: 'food', foodReserve: 60 });
  assert.equal(plan.transfers.length, 1);
  assert.deepEqual(plan.transfers[0].what, [{ id: 1, amount: 2 }]);
  assert.equal(plan.transfers[0].who_travels, 'neither');
  assert.equal(validateExactTransferContract(rows, plan.transfers).ok, true);
}

// One baseline weapon stays with the donor. The least-scored spare goes first;
// the better spare remains available for the donor.
{
  const rows = [
    row('giver', [item(10, 'mace'), item(11, 'long sword'), item(12, 'dagger')], ['bare']),
    row('bare', [], ['giver']),
  ];
  const plan = planShelterRedistribution(rows, { phase: 'weapons', weaponReserve: 1 });
  assert.equal(plan.transfers.length, 1);
  assert.deepEqual(plan.transfers[0].what, [12]);
}

// A name-only KeeperProxy equipment record is ambiguous. Every identical carried
// object is withheld, so the planner cannot accidentally offer the wielded one.
{
  const rows = [
    row('giver', [item(20, 'mace'), item(21, 'mace')], ['bare'],
      { equipment: { known: true, equipped: [{ id: -1, name: 'mace' }] } }),
    row('bare', [], ['giver']),
  ];
  const plan = planShelterRedistribution(rows, { phase: 'weapons' });
  assert.equal(plan.transfers.length, 0);
}

// Armour and shield are independent floors, helmets are outside this phase, and
// donor equipment/baseline pieces are retained.
{
  const rows = [
    row('giver', [
      item(30, 'leather armor'), item(31, 'chain armor'),
      item(32, 'small round shield'), item(33, 'gold round shield'),
      item(34, 'simple helm'),
    ], ['bare']),
    row('bare', [], ['giver']),
  ];
  const plan = planShelterRedistribution(rows, { phase: 'gear' });
  assert.equal(plan.transfers.length, 1);
  assert.deepEqual(new Set(plan.transfers[0].what), new Set([31, 32]));
  assert.equal(plan.transfers[0].what.includes(34), false);
}

// A room number is not enough: split-room islands must see one another in both
// fresh room views. Hurt, non-full, busy, and >=75%-load rows are also unavailable.
{
  const noVisibility = [row('a', [item(40, 'dagger'), item(41, 'mace')], []), row('b', [], [])];
  assert.equal(planShelterRedistribution(noVisibility, { phase: 'weapons' }).transfers.length, 0);
  const unsafe = [
    row('a', [item(42, 'dagger'), item(43, 'mace')], ['b'], { recent_hurt: true }),
    row('b', [], ['a']),
  ];
  assert.equal(planShelterRedistribution(unsafe, { phase: 'weapons' }).transfers.length, 0);
  assert.throws(() => planShelterRedistribution(noVisibility, { room: 38 }), /confined to room 39/);
}

// The current broker inventory shape omits `tag`; --go must therefore stop before
// mutation instead of guessing from amount.
{
  const rows = [row('giver', [{ id: 50, name: 'wheel of cheese', amount: 3 }], ['hungry']),
    row('hungry', [], ['giver'])];
  const plan = planShelterRedistribution(rows, { phase: 'food' });
  const contract = validateExactTransferContract(rows, plan.transfers);
  assert.equal(contract.ok, false);
  assert.match(contract.problems.join('\n'), /no authoritative object tag/);
}

// An absent use list means "unknown", not "nothing equipped"; such a row cannot
// donate or receive until a fresh equipment read proves its state.
{
  const rows = [
    row('giver', [item(60, 'dagger'), item(61, 'mace')], ['bare'],
      { equipmentKnown: false, equipment: { known: false, equipped: [] } }),
    row('bare', [], ['giver']),
  ];
  const plan = planShelterRedistribution(rows, { phase: 'weapons' });
  assert.equal(plan.transfers.length, 0);
  assert.match(plan.excluded[0].reason, /equipment state is unknown/);
}

// Unknown load/activity and stale or moving keeper telemetry all fail closed. A
// projected idle broker row is not enough to authorize a live trade.
{
  const base = [item(70, 'dagger'), item(71, 'mace')];
  const peer = row('bare', [], ['giver']);
  for (const unsafe of [
    row('giver', base, ['bare'], { loadPercent: null }),
    row('giver', base, ['bare'], { activity: '' }),
    row('giver', base, ['bare'], { keeperSamples: [keeperSample()] }),
    row('giver', base, ['bare'], {
      keeperSamples: [keeperSample(), keeperSample({ as_of_ms: 8_000 })],
    }),
    row('giver', base, ['bare'], {
      keeperSamples: [keeperSample(), keeperSample({ you: { col: 6, row: 5 } })],
    }),
  ]) {
    const plan = planShelterRedistribution([unsafe, peer], { phase: 'weapons' });
    assert.equal(plan.transfers.length, 0);
    assert.equal(plan.participants, 1);
  }
}

// Single-flight queues simultaneous phase triggers; it never overlaps workers.
{
  let active = 0, peak = 0;
  const run = createSingleFlight(async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value;
  });
  assert.deepEqual(await Promise.all([run(1), run(2), run(3)]), [1, 2, 3]);
  assert.equal(peak, 1);
  assert.equal(run.stats().maxActive, 1);
}

console.log('m59-shelter-quartermaster: 9 planner/safety tests passed');
