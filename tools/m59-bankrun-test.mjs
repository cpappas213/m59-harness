#!/usr/bin/env node
// m59-bankrun-test.mjs -- offline tests for the bankRun decomposition.
//
//   node tools/m59-bankrun-test.mjs

import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Mock session and keeper
// ---------------------------------------------------------------------------

function mockSession(overrides = {}) {
  return {
    name: 't1',
    need: () => ({
      inventory: [],
      rsc: { get: () => 'shilling' },
      ...overrides.client,
    }),
    world: {
      room: { num: 100 },
      route: (to) => ({ found: true, hops: [100, 101, to] }),
      exits: () => [],
    },
    pacer: { submit: async () => {} },
    bankKnown: () => ({ balance: 0 }),
    ...overrides,
  };
}

function mockKeeper(overrides = {}) {
  const s = mockSession(overrides.session);
  // Create a minimal object that has the Autopilot prototype methods
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    s,
    policy: {
      bankAbove: 500,
      maxCarry: 14,
      hungryFloor: 100,
      walkingMoney: 400,
      purchases: { food: true },
      ...overrides.policy,
    },
    name: 't1',
    note: () => {},
    progress: () => {},
    noProgress: () => {},
    doing: null,
    money: { trips: 0, trips_failed: 0, why_not: [] },
    coordination: { cleanup: { refused: 0 } },
    pendingFarmDelivery: null,
    lastTownServiceAt: 0,
    foodTripAt: 0,
    sellTripAt: 0,
    bankTripAt: 0,
    notedBroke: false,
    notedStarving: false,
    notedPurse: 0,
    warnedNoBank: false,
    // Methods that the tests override
    checkIfShouldSell: () => ({ sell: false, trigger: null }),
    reagentCount: () => ({ elderberry: 0, herbs: 0 }),
    larder: () => [],
    purchaseEnabled: (p, key) => p.purchases?.[key] ?? true,
    prepareFarmDelivery: () => {},
    farmCleanupBeforeSale: async () => {},
    leaveHold: async () => ({ refused: false }),
    travel: async () => ({ arrived: true }),
    contributeGuildWants: async () => {},
    sellInTown: async () => ({}),
    guildTitheFromSale: async () => {},
    bankSurplus: async () => {},
    withdrawForFood: async () => {},
    restockInTown: async () => {},
    buyFoodInTown: async () => {},
    buyReagentsInTown: async () => {},
    buyFarmDeliveryCargo: async () => {},
    vaultRunIfPassing: async () => {},
  });
  Object.assign(k, overrides);
  return k;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-bankrun-test.mjs\n');

// --- _bankRunShouldGo ---

t('_bankRunShouldGo: go=false when bankAbove is 0', () => {
  const k = mockKeeper({ policy: { bankAbove: 0 } });
  const r = k._bankRunShouldGo();
  if (r.go !== false) throw new Error(`expected go=false, got ${r.go}`);
  if (r.reason !== 'disabled') throw new Error(`expected reason=disabled, got ${r.reason}`);
});

t('_bankRunShouldGo: go=false when carrying under threshold', () => {
  const k = mockKeeper({
    session: { client: { inventory: [{ nameRsc: 1, amount: 100 }] } },
  });
  k.s.need = () => ({ inventory: [{ nameRsc: 1, amount: 100 }], rsc: { get: () => 'shilling' } });
  k.checkIfShouldSell = () => ({ sell: false, trigger: null });
  const r = k._bankRunShouldGo();
  if (r.go !== false) throw new Error(`expected go=false, got ${r.go}`);
});

t('_bankRunShouldGo: go=true when carrying over threshold', () => {
  const k = mockKeeper();
  k.s.need = () => ({ inventory: [{ nameRsc: 1, amount: 600 }], rsc: { get: () => 'shilling' } });
  k.checkIfShouldSell = () => ({ sell: false, trigger: null });
  const r = k._bankRunShouldGo();
  if (r.go !== true) throw new Error(`expected go=true, got ${r.go}`);
  if (r.reason !== 'carrying_enough') throw new Error(`expected reason=carrying_enough, got ${r.reason}`);
});

t('_bankRunShouldGo: go=true when pack full', () => {
  const k = mockKeeper();
  k.s.need = () => ({ inventory: [{ nameRsc: 1, amount: 100 }], rsc: { get: () => 'shilling' } });
  k.checkIfShouldSell = () => ({ sell: true, trigger: 'weight' });
  const r = k._bankRunShouldGo();
  if (r.go !== true) throw new Error(`expected go=true, got ${r.go}`);
  if (r.packFull !== true) throw new Error(`expected packFull=true, got ${r.packFull}`);
});

t('_bankRunShouldGo: go=true when starving', () => {
  const k = mockKeeper();
  k.s.need = () => ({ inventory: [{ nameRsc: 1, amount: 200 }], rsc: { get: () => 'shilling' } });
  k.checkIfShouldSell = () => ({ sell: false, trigger: null });
  k.larder = () => [];
  k.reagentCount = () => ({ elderberry: 0, herbs: 0 });
  k.s.bankKnown = () => ({ balance: 0 });
  const r = k._bankRunShouldGo();
  if (r.go !== true) throw new Error(`expected go=true, got ${r.go}`);
  if (r.starving !== true) throw new Error(`expected starving=true, got ${r.starving}`);
});

t('_bankRunShouldGo: go=true when broke with goods', () => {
  const k = mockKeeper();
  k.s.need = () => ({ inventory: [{ nameRsc: 1, amount: 100 }], rsc: { get: () => 'shilling' } });
  k.checkIfShouldSell = () => ({ sell: true, trigger: 'broke' });
  const r = k._bankRunShouldGo();
  if (r.go !== true) throw new Error(`expected go=true, got ${r.go}`);
  if (r.brokeWithGoods !== true) throw new Error(`expected brokeWithGoods=true, got ${r.brokeWithGoods}`);
});

// --- _bankRunRankDestinations ---

t('_bankRunRankDestinations: ranks banks by hops', () => {
  const k = mockKeeper();
  k.s.world.route = (to) => {
    const distances = { 2: 3, 54: 5, 376: 7 };
    return { found: true, hops: Array.from({ length: distances[to] || 99 }, () => 0) };
  };
  const options = k._bankRunRankDestinations({ packFull: false, brokeWithGoods: false, starving: false, carried: 600 });
  if (options.length === 0) throw new Error('expected at least one destination');
  // Should be sorted by hops
  for (let i = 1; i < options.length; i++) {
    if (options[i].hops < options[i-1].hops) {
      throw new Error(`options not sorted by hops: ${options[i-1].hops} > ${options[i].hops}`);
    }
  }
});

t('_bankRunRankDestinations: goes to market when pack full', () => {
  const k = mockKeeper();
  k.s.world.route = (to) => ({ found: true, hops: [0, 0, to] });
  const options = k._bankRunRankDestinations({ packFull: true, brokeWithGoods: false, starving: false, carried: 100 });
  // Should include a market
  const hasMarket = options.some(o => o.room === 110); // Roq is room 110
  if (!hasMarket) throw new Error('expected a market in destinations when pack full');
});

t('_bankRunRankDestinations: goes to food shop when starving', () => {
  const k = mockKeeper();
  k.s.world.route = (to) => ({ found: true, hops: [0, 0, to] });
  const options = k._bankRunRankDestinations({ packFull: false, brokeWithGoods: false, starving: true, carried: 100 });
  // Should include the food shop (room 103)
  const hasFoodShop = options.some(o => o.room === 103);
  if (!hasFoodShop) throw new Error('expected food shop in destinations when starving');
});

// --- _bankRunDoTownBusiness ---

t('_bankRunDoTownBusiness: calls all town business methods', async () => {
  const calls = [];
  const k = mockKeeper({
    contributeGuildWants: async () => { calls.push('contributeGuildWants'); },
    sellInTown: async () => { calls.push('sellInTown'); return {}; },
    guildTitheFromSale: async () => { calls.push('guildTitheFromSale'); },
    bankSurplus: async () => { calls.push('bankSurplus'); },
    withdrawForFood: async () => { calls.push('withdrawForFood'); },
    restockInTown: async () => { calls.push('restockInTown'); },
    buyFoodInTown: async () => { calls.push('buyFoodInTown'); },
    buyReagentsInTown: async () => { calls.push('buyReagentsInTown'); },
    buyFarmDeliveryCargo: async () => { calls.push('buyFarmDeliveryCargo'); },
    vaultRunIfPassing: async () => { calls.push('vaultRunIfPassing'); },
  });
  await k._bankRunDoTownBusiness();
  const expected = ['contributeGuildWants', 'sellInTown', 'guildTitheFromSale', 'bankSurplus',
                    'withdrawForFood', 'restockInTown', 'buyFoodInTown', 'buyReagentsInTown',
                    'buyFarmDeliveryCargo', 'vaultRunIfPassing'];
  for (const method of expected) {
    if (!calls.includes(method)) throw new Error(`expected ${method} to be called`);
  }
});

t('_bankRunDoTownBusiness: sets lastTownServiceAt', async () => {
  const k = mockKeeper();
  const before = k.lastTownServiceAt;
  await k._bankRunDoTownBusiness();
  if (k.lastTownServiceAt <= before) throw new Error('expected lastTownServiceAt to be updated');
});

// --- bankRun (integration) ---

t('bankRun: returns false when already at a bank', async () => {
  const k = mockKeeper({
    session: { room: { num: 54 } }, // Jasper's bank
  });
  k.s.world.room = { num: 54 };
  const r = await k.bankRun();
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

t('bankRun: returns false when bankAbove is 0', async () => {
  const k = mockKeeper({ policy: { bankAbove: 0 } });
  const r = await k.bankRun();
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

// ---------------------------------------------------------------------------

run();
