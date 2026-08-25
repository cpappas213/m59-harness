#!/usr/bin/env node
// m59-safespot-test.mjs already exists. This tests the new decomposition methods.
//   node tools/m59-takesafespot-test.mjs

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
      self: { col: 10, row: 10 },
      room: { objects: new Map() },
    },
    world: {
      room: { num: 100 },
      geometry: {
        rows: 20, cols: 20,
        walkable: () => true,
        monsterCanReach: () => true,
      },
      map: {},
      exits: () => [],
    },
    pacer: { submit: async () => {} },
    ...overrides,
  };
}

function mockKeeper(overrides = {}) {
  const s = mockSession(overrides.session);
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    s,
    policy: {
      maxBotsPerSafeSpot: null,
      los: 0,
      ...overrides.policy,
    },
    name: 't1',
    note: () => {},
    doing: null,
    noWallRooms: new Map(),
    barrenSpots: new Map(),
    searchSafeSpot: () => null,
    crossSameRoomIsland: async () => ({ arrived: true }),
    ...overrides,
  });
  return k;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-takesafespot-test.mjs\n');

// --- _takeSafeSpotCheckNoWall ---

t('_takeSafeSpotCheckNoWall: returns null when not in noWallRooms', () => {
  const k = mockKeeper();
  k.noWallRooms = new Map();
  const r = k._takeSafeSpotCheckNoWall(null, 'fight');
  if (r !== null) throw new Error(`expected null, got ${r}`);
});

t('_takeSafeSpotCheckNoWall: returns reason when in noWallRooms', () => {
  const k = mockKeeper();
  k.noWallRooms = new Map([[100, 'all walls failed']]);
  k.s.world.room = { num: 100 };
  const r = k._takeSafeSpotCheckNoWall(null, 'fight');
  if (r !== 'all walls failed') throw new Error(`expected 'all walls failed', got ${r}`);
});

t('_takeSafeSpotCheckNoWall: returns null for non-fight source', () => {
  const k = mockKeeper();
  k.noWallRooms = new Map([[100, 'all walls failed']]);
  k.s.world.room = { num: 100 };
  const r = k._takeSafeSpotCheckNoWall(null, 'other');
  if (r !== null) throw new Error(`expected null for non-fight source, got ${r}`);
});

// --- _takeSafeSpotAllBarren ---

t('_takeSafeSpotAllBarren: returns false when no eligible spots', () => {
  const k = mockKeeper();
  const r = k._takeSafeSpotAllBarren({ eligible: 0, empirically_barren: 0 });
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

t('_takeSafeSpotAllBarren: returns true when all eligible are barren', () => {
  const k = mockKeeper();
  const r = k._takeSafeSpotAllBarren({ eligible: 5, empirically_barren: 5 });
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

t('_takeSafeSpotAllBarren: returns false when some are not barren', () => {
  const k = mockKeeper();
  const r = k._takeSafeSpotAllBarren({ eligible: 5, empirically_barren: 3 });
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

// --- _takeSafeSpotSearch ---

t('_takeSafeSpotSearch: returns null when searchSafeSpot finds nothing', () => {
  const k = mockKeeper({
    searchSafeSpot: () => null,
  });
  const geo = { rows: 20, cols: 20 };
  const me = { col: 10, row: 10 };
  const room = { num: 100 };
  const r = k._takeSafeSpotSearch(geo, me, room, {});
  if (r.spot !== null) throw new Error(`expected null spot, got ${r.spot}`);
});

t('_takeSafeSpotSearch: returns spot when searchSafeSpot finds one', () => {
  const k = mockKeeper({
    searchSafeSpot: (geo, me, room, opts) => ({ col: 12, row: 8, steps_away: 5 }),
  });
  const geo = { rows: 20, cols: 20 };
  const me = { col: 10, row: 10 };
  const room = { num: 100 };
  const r = k._takeSafeSpotSearch(geo, me, room, {});
  if (r.spot === null) throw new Error('expected a spot');
  if (r.spot.col !== 12 || r.spot.row !== 8) throw new Error('expected spot at (12, 8)');
});

// ---------------------------------------------------------------------------

run();
