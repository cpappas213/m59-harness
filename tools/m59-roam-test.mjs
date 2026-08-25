#!/usr/bin/env node
// m59-roam-test.mjs -- offline tests for the roam decomposition.
//   node tools/m59-roam-test.mjs

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
    client: {
      vitals: () => ({ health: { max: 100 } }),
    },
    world: {
      room: { num: 100 },
      map: {},
      exits: () => [],
      ...overrides.world,
    },
    pacer: { submit: async () => {} },
    leaveVia: async () => ({ left: true, arrived_in: 101 }),
    ...overrides,
  };
}

function mockKeeper(overrides = {}) {
  const s = mockSession(overrides.session);
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    s,
    policy: {
      roamLimit: 10,
      hunt: 'giant rat',
      ...overrides.policy,
    },
    name: 't1',
    note: () => {},
    doing: null,
    homeRoom: null,
    emptyPasses: 0,
    tally: { rooms_moved: 0 },
    visited: new Set(),
    unreachable: new Set(),
    progress: () => {},
    noProgress: () => {},
    threatCeiling: () => 50,
    preyRooms: () => [],
    ...overrides,
  });
  return k;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-roam-test.mjs\n');

// --- _roamShouldGoHome ---

t('_roamShouldGoHome: false when no homeRoom', () => {
  const k = mockKeeper();
  const r = k._roamShouldGoHome({ num: 100 });
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

t('_roamShouldGoHome: true when in different room', () => {
  const k = mockKeeper({ homeRoom: 100 });
  const r = k._roamShouldGoHome({ num: 200 });
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

t('_roamShouldGoHome: false when in same room', () => {
  const k = mockKeeper({ homeRoom: 100 });
  const r = k._roamShouldGoHome({ num: 100 });
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

// --- _roamHitLimit ---

t('_roamHitLimit: false when under limit', () => {
  const k = mockKeeper({ policy: { roamLimit: 10 }, });
  k.roamedRooms = 5;
  const r = k._roamHitLimit();
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

t('_roamHitLimit: true when at limit', () => {
  const k = mockKeeper({ policy: { roamLimit: 10 }, });
  k.roamedRooms = 10;
  const r = k._roamHitLimit();
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

t('_roamHitLimit: true when over limit', () => {
  const k = mockKeeper({ policy: { roamLimit: 10 }, });
  k.roamedRooms = 15;
  const r = k._roamHitLimit();
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

// --- _roamFilterExits ---

t('_roamFilterExits: returns all exits when no map', () => {
  const k = mockKeeper();
  k.s.world.map = null;
  const all = [{ to: 101, to_name: 'Room 101', steps_away: 5 }];
  const r = k._roamFilterExits(all);
  if (r.exits.length !== 1) throw new Error(`expected 1 exit, got ${r.exits.length}`);
  if (r.dangerous.length !== 0) throw new Error(`expected 0 dangerous, got ${r.dangerous.length}`);
});

t('_roamFilterExits: filters out dangerous rooms', () => {
  const k = mockKeeper({
    _roamIsTooDangerous: (to) => to === 200 ? { creature: 'thrasher', level: 150 } : null,
    _roamIsEscapable: (to, from) => true,
  });
  const all = [
    { to: 101, to_name: 'Room 101', steps_away: 5 },
    { to: 200, to_name: 'Room 200', steps_away: 3 },
  ];
  const r = k._roamFilterExits(all);
  if (r.exits.length !== 1) throw new Error(`expected 1 exit, got ${r.exits.length}`);
  if (r.dangerous.length !== 1) throw new Error(`expected 1 dangerous, got ${r.dangerous.length}`);
});

// --- _roamPickExit ---

t('_roamPickExit: returns null when no exits', () => {
  const k = mockKeeper();
  const r = k._roamPickExit([]);
  if (r !== null) throw new Error(`expected null, got ${r}`);
});

t('_roamPickExit: picks unvisited over visited', () => {
  const k = mockKeeper();
  k.visited = new Set([101]);
  const exits = [
    { to: 101, steps_away: 5 },
    { to: 102, steps_away: 10 },
  ];
  const r = k._roamPickExit(exits);
  if (r.to !== 102) throw new Error(`expected room 102, got ${r.to}`);
});

t('_roamPickExit: picks closest when all visited', () => {
  const k = mockKeeper();
  k.visited = new Set([101, 102]);
  const exits = [
    { to: 101, steps_away: 10 },
    { to: 102, steps_away: 5 },
  ];
  const r = k._roamPickExit(exits);
  if (r.to !== 102) throw new Error(`expected room 102, got ${r.to}`);
});

// ---------------------------------------------------------------------------

run();
