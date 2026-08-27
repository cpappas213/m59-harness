#!/usr/bin/env node
// m59-safespot-test.mjs already exists. This tests the new decomposition methods.
//   node tools/m59-takesafespot-test.mjs

import { Autopilot } from './m59-autopilot.mjs';
import { crowdedSquares } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';

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
// A wall square is only worth walking to if the walk can end on it, and the fine walker
// cannot route around a body. So squares other players stand on — or next to — are skipped
// for this pass, exactly like squares we recently failed to reach. Players only: a monster
// next to a wall is what the wall is for. Castle Victoria, 2026-08-26: six characters in
// one 2x3 block, two on the same square, all "NOT MOVING".

t('crowdedSquares: another player excludes their square and its eight neighbours', () => {
  const objects = new Map([
    [1, { id: 1, col: 12, row: 10, flags: OF.PLAYER }],
    [2, { id: 2, col: 5, row: 5, flags: OF.ATTACKABLE }],   // a monster: not a crowd
    [99, { id: 99, col: 20, row: 20, flags: OF.PLAYER }],   // ourselves
  ]);
  const out = crowdedSquares(objects, 99);
  for (const k of ['12,10', '11,9', '13,11', '12,11'])
    if (!out.has(k)) throw new Error('missing ' + k);
  if (out.has('5,5')) throw new Error('a monster was treated as a crowd');
  if (out.has('20,20')) throw new Error('we excluded our own square');
  if (out.size !== 9) throw new Error('expected 9 squares, got ' + out.size);
});

t('crowdedSquares: no players, or no objects at all, is an empty set', () => {
  if (crowdedSquares(new Map(), 1).size !== 0) throw new Error('empty map');
  if (crowdedSquares(null, 1).size !== 0) throw new Error('null');
  if (crowdedSquares([{ id: 2, col: 1, row: 1, flags: OF.ATTACKABLE }], 1).size !== 0)
    throw new Error('monster only');
});

t('spotExclusions: recently unreachable squares and crowded squares are one set', () => {
  const k = mockKeeper({
    unreachableIn: () => new Set(['1,1']),
    session: { client: { selfId: 99,
      self: { col: 10, row: 10 },
      room: { objects: new Map([[7, { id: 7, col: 12, row: 10, flags: OF.PLAYER }]]) } } },
  });
  const out = k.spotExclusions(100);
  if (!out.has('1,1')) throw new Error('lost the remembered unreachable square');
  if (!out.has('12,10') || !out.has('11,10')) throw new Error('missing the crowd');
});

t('spotExclusions: with nobody around, the remembered set is returned as-is (may be null)', () => {
  const k = mockKeeper({ unreachableIn: () => null,
    session: { client: { selfId: 99, self: { col: 10, row: 10 }, room: { objects: new Map() } } } });
  if (k.spotExclusions(100) !== null) throw new Error('expected null through');
});

// ---------------------------------------------------------------------------

run();
