#!/usr/bin/env node
// A split-room shortcut still leaves the room, so it must honour confineRooms.
// Offline: no socket, broker, roster, or live fleet is touched.

import { strict as assert } from 'node:assert';
import { Autopilot, quarryPermittedByConfinement } from './m59-autopilot.mjs';

function fixture(confineRooms) {
  let roomNum = 39;
  let leaves = 0;
  const self = { col: 10, row: 10 };
  const client = {
    evSeq: 0,
    self,
    room: { objects: new Map() },
    waitFor: async () => ({}),
  };
  const world = {
    get room() { return { num: roomNum, name: roomNum === 39 ? 'Upstairs' : 'Castle' }; },
    geometry: { path: () => ({ found: true }) },
    exits: () => roomNum === 39
      ? [{ kind: 'go', to: 38, stand_on: { col: 1, row: 1 } }]
      : [{ kind: 'go', to: 39, stand_on: { col: 2, row: 2 } }],
  };
  const session = {
    client,
    world,
    pacer: { submit: async (_kind, fn) => fn() },
    leaveViaAny: async exits => {
      leaves++;
      roomNum = exits[0].to;
      return { left: true };
    },
  };
  const keeper = Object.create(Autopilot.prototype);
  Object.assign(keeper, {
    s: session,
    policy: { confineRooms },
    note: () => {},
    doing: null,
    movedAt: 0,
  });
  return { keeper, leaves: () => leaves, room: () => roomNum };
}

const plan = {
  fromRoom: 39,
  fromName: 'Upstairs in Castle Victoria',
  viaRoom: 38,
  viaName: 'Castle Victoria',
  target: { col: 20, row: 10 },
  leaveDoors: [{ col: 1, row: 1 }],
  returnDoors: [{ col: 2, row: 2 }],
  why: 'the quarry is on the other connected side',
};

// Two disconnected halves of room 39. The only player route from west to east is
// through room 38; the monster path grid itself never joins those halves.
const map = { rooms: {
  39: {
    num: 39,
    name: 'Upstairs in Castle Victoria',
    goExits: [{ row: 1, col: 1, to: 38, locked: false }],
  },
  38: {
    num: 38,
    name: 'Castle Victoria',
    goExits: [{
      row: 2, col: 2, to: 39, locked: false,
      arriveRow: 1, arriveCol: 20,
    }],
  },
} };
const geo = {
  walkable: () => true,
  nearestWalkable: (row, col) => ({ row, col }),
  path: (_fromRow, fromCol, _toRow, toCol) => {
    const found = (fromCol < 10) === (toCol < 10);
    return { found, steps: found ? Array(Math.abs(toCol - fromCol)).fill({}) : [] };
  },
};
const west = { col: 3, row: 1 };
const localQuarry = { id: 101, col: 5, row: 1 };
const eastQuarry = { id: 102, col: 20, row: 1 };

{
  const visible = [localQuarry, eastQuarry];
  const permitted = visible.filter(target => quarryPermittedByConfinement({
    map, room: map.rooms[39], geo, from: west, target, confineRooms: [39],
  }));
  assert.deepEqual(permitted.map(x => x.id), [101],
    'strict room confinement must retain same-component prey and exclude remote prey');
}

{
  assert.equal(quarryPermittedByConfinement({
    map, room: 39, geo, from: west, target: eastQuarry, confineRooms: [39],
  }), false, 'remote-only prey must not induce a forbidden bridge crossing');
}

{
  assert.equal(quarryPermittedByConfinement({
    map, room: 39, geo, from: west, target: eastQuarry, confineRooms: [39, 38],
  }), true, 'explicitly permitting the bridge room must preserve cross-wing hunting');
}

{
  assert.equal(quarryPermittedByConfinement({
    map, room: 39, geo, from: west, target: eastQuarry, confineRooms: null,
  }), true, 'an unconstrained keeper must preserve existing split-room behaviour');
}

{
  const f = fixture([39]);
  const result = await f.keeper.crossSameRoomIsland(plan);
  assert.equal(result.arrived, false);
  assert.equal(result.confined, true);
  assert.equal(f.leaves(), 0, 'a forbidden bridge must not take even its first exit');
  assert.equal(f.room(), 39);
}

{
  const f = fixture([39, 38]);
  const result = await f.keeper.crossSameRoomIsland(plan);
  assert.equal(result.arrived, true);
  assert.equal(f.leaves(), 2, 'an explicitly permitted bridge still crosses out and back');
  assert.equal(f.room(), 39);
}

console.log('6 passed, 0 failed');
