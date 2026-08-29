#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildRtsSnapshot, toNativeSnapshot } from './m59-rts-contract.mjs';
import {
  RTS_V8_NATIVE_VERSION,
  RTS_V8_SCHEMA,
  RtsSnapshotV8Error,
  buildRtsSnapshotV8,
  toNativeSnapshotV8,
} from './m59-rts-contract-v8.mjs';

const binding = Object.freeze({
  room_num: 200,
  room_resource_id: 0xffffffff,
  room_resource_symbol: 'room_marion',
  roo_file: 'marion.roo',
  static_token_kind: 'roo-security-u32',
  static_token_value: '4294967294',
  rows: 2,
  cols: 3,
  roo_security_u32: 0xfffffffe,
});
const generation = {
  map_build_identity: `M59ATLAS/1:${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}`,
  getRoomBinding: room => room === 200 ? binding : null,
};

function look(agent, { security = 0xfffffffe, resource = 'marion.roo', rows = 2,
                       cols = 3, extraWire = null } = {}) {
  return {
    room: { num: 200, name: 'Marion', resource, size: { rows, cols } },
    room_wire: {
      resolved_room_num: 200,
      room_resource_id: 0xffffffff,
      room_security_u32: security,
      ...(extraWire ? { extra: extraWire } : {}),
    },
    you: { object_id: agent === 't1' ? 501 : 502, col: 1, row: 1 },
    vitals: {},
    objects: [],
    exits: [],
  };
}

function input(overrides = {}) {
  const looks = overrides.looks ?? new Map([['t1', look('t1')], ['t2', look('t2')]]);
  return {
    generation: overrides.generation ?? generation,
    health: { fleet: 'fixture', pid: 1234 },
    fleetPayload: { fleet: [
      { agent: 't2', character: 'Gonzo' },
      { agent: 't1', character: 'Kermit' },
    ] },
    looks,
    equipment: new Map(),
    spells: new Map(),
    inventory: new Map(),
    commander: null,
    control: new Map(),
    commerce: new Map(),
    observedAt: '2026-08-28T12:34:56.789Z',
    sequence: 'fixture-v8-1',
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof RtsSnapshotV8Error);
    assert.equal(error.code, code);
    return true;
  });
}

const source = input();
const legacy = buildRtsSnapshot(source);
const legacyBytes = toNativeSnapshot(legacy);
const snapshot = buildRtsSnapshotV8(source);
assert.equal(snapshot.schema, RTS_V8_SCHEMA);
assert.equal(snapshot.source.map_build_identity, generation.map_build_identity);
assert.deepEqual(snapshot.agents.map(agent => agent.agent), ['t1', 't2']);
assert.deepEqual(snapshot.agents[0].room_wire, {
  resolved_room_num: 200,
  room_resource_id: 0xffffffff,
  room_security_u32: 0xfffffffe,
});
assert.equal(snapshot.agents[0].room_resource, 'marion.roo');
assert.deepEqual({ resource: snapshot.rooms[0].resource, rows: snapshot.rooms[0].rows,
                   cols: snapshot.rooms[0].cols },
  { resource: 'marion.roo', rows: 2, cols: 3 });

const native = toNativeSnapshotV8(snapshot);
assert.match(native, new RegExp(`^M59RTS\\t${RTS_V8_NATIVE_VERSION}\\tfixture-v8-1\\t`));
const lines = native.trimEnd().split('\n');
for (const agent of ['t1', 't2']) {
  const at = lines.findIndex(line => line.startsWith(`AGENT\t${agent}\t`));
  assert.ok(at > 0);
  assert.equal(lines[at + 1], `ROOM_WIRE\t${agent}\t200\t4294967295\t4294967294`);
}
assert.equal(lines.filter(line => line.startsWith('ROOM_WIRE\t')).length, 2);
assert.match(native, /\nEND\n$/);
assert.equal(toNativeSnapshot(buildRtsSnapshot(source)), legacyBytes,
  'building v8 must not mutate or change the legacy v7 projection');

const missing = input({ looks: new Map([['t1', { ...look('t1'), room_wire: undefined }],
                                       ['t2', look('t2')]]) });
expectCode(() => buildRtsSnapshotV8(missing), 'missing-room-wire');

const extra = input({ looks: new Map([['t1', look('t1', { extraWire: true })],
                                     ['t2', look('t2')]]) });
expectCode(() => buildRtsSnapshotV8(extra), 'invalid-room-wire');

const conflict = input({ looks: new Map([['t1', look('t1')],
                                        ['t2', look('t2', { security: 7 })]]) });
expectCode(() => buildRtsSnapshotV8(conflict), 'merged-room-conflict');

const wrongResource = input({ looks: new Map([['t1', look('t1', { resource: 'wrong.roo' })],
                                             ['t2', look('t2')]]) });
expectCode(() => buildRtsSnapshotV8(wrongResource), 'observation-conflict');

const wrongDimensions = input({ looks: new Map([['t1', look('t1', { rows: 9 })],
                                               ['t2', look('t2')]]) });
expectCode(() => buildRtsSnapshotV8(wrongDimensions), 'observation-conflict');

const wrongBinding = {
  ...generation,
  getRoomBinding: () => ({ ...binding, room_resource_id: 3 }),
};
expectCode(() => buildRtsSnapshotV8(input({ generation: wrongBinding })), 'map-room-conflict');

const failedLook = input({ looks: new Map([['t1', new Error('offline fixture failure')],
                                          ['t2', look('t2')]]) });
expectCode(() => buildRtsSnapshotV8(failedLook), 'observation-unavailable');

expectCode(() => toNativeSnapshotV8({ ...snapshot, agents: [
  { ...snapshot.agents[0], room_wire: { ...snapshot.agents[0].room_wire,
    room_security_u32: 0x100000000 } },
] }), 'invalid-room-wire');

const negativeZero = structuredClone(snapshot);
negativeZero.agents[0].room_wire.room_security_u32 = -0;
expectCode(() => toNativeSnapshotV8(negativeZero), 'invalid-room-wire');

const wrongAgentRoom = structuredClone(snapshot);
wrongAgentRoom.agents[0].room_num = 201;
expectCode(() => toNativeSnapshotV8(wrongAgentRoom), 'invalid-snapshot');

const missingRoom = structuredClone(snapshot);
missingRoom.rooms = [];
expectCode(() => toNativeSnapshotV8(missingRoom), 'invalid-snapshot');

const extraRoom = structuredClone(snapshot);
extraRoom.rooms.push({ ...extraRoom.rooms[0], num: 201, observed_by: [] });
expectCode(() => toNativeSnapshotV8(extraRoom), 'invalid-snapshot');

const conflictingWire = structuredClone(snapshot);
conflictingWire.agents[1].room_wire.room_security_u32 = 7;
expectCode(() => toNativeSnapshotV8(conflictingWire), 'invalid-snapshot');

const wrongAgentResource = structuredClone(snapshot);
wrongAgentResource.agents[0].room_resource = 'wrong.roo';
expectCode(() => toNativeSnapshotV8(wrongAgentResource), 'invalid-snapshot');

const invalidNativeDimensions = structuredClone(snapshot);
invalidNativeDimensions.rooms[0].rows = 0;
expectCode(() => toNativeSnapshotV8(invalidNativeDimensions), 'invalid-snapshot');

const duplicateRoom = structuredClone(snapshot);
duplicateRoom.rooms.push({ ...duplicateRoom.rooms[0], cols: 4 });
expectCode(() => toNativeSnapshotV8(duplicateRoom), 'invalid-snapshot');

const wrongMembership = structuredClone(snapshot);
wrongMembership.rooms[0].observed_by = ['t1'];
expectCode(() => toNativeSnapshotV8(wrongMembership), 'invalid-snapshot');

console.log('m59 RTS snapshot v8 binding tests: PASS');
