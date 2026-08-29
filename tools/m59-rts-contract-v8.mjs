// Strict, topology-bindable RTS snapshot projection.
//
// Legacy M59RTS/7 remains in m59-rts-contract.mjs.  This module deliberately
// wraps that stable projection instead of changing its JSON or native bytes.
// V8 adds only the evidence needed to join one live BP_PLAYER room tuple to one
// frozen static map generation.

import {
  RTS_SCHEMA,
  buildRtsSnapshot,
  toNativeSnapshot,
} from './m59-rts-contract.mjs';

export const RTS_V8_SCHEMA = 'm59-rts/v2';
export const RTS_V8_NATIVE_VERSION = 8;

const ROOM_WIRE_KEYS = Object.freeze([
  'resolved_room_num',
  'room_resource_id',
  'room_security_u32',
]);

export class RtsSnapshotV8Error extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'RtsSnapshotV8Error';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new RtsSnapshotV8Error(code, message, status);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveRoom(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
    fail('invalid-room-wire', `${label} must be a positive signed 32-bit room number`);
  return value;
}

function uint32(value, label, { nonzero = false } = {}) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) ||
      value < (nonzero ? 1 : 0) || value > 0xffffffff)
    fail('invalid-room-wire', `${label} must be ${nonzero ? 'a nonzero ' : 'an '}unsigned 32-bit integer`);
  return value;
}

function exactRoomWire(value, label) {
  if (!record(value)) fail('missing-room-wire', `${label} must be an exact room_wire object`);
  const keys = Object.keys(value).sort();
  const expected = [...ROOM_WIRE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    fail('invalid-room-wire', `${label} must contain exactly ${ROOM_WIRE_KEYS.join(', ')}`);
  return Object.freeze({
    resolved_room_num: positiveRoom(value.resolved_room_num, `${label}.resolved_room_num`),
    room_resource_id: uint32(value.room_resource_id, `${label}.room_resource_id`, { nonzero: true }),
    room_security_u32: uint32(value.room_security_u32, `${label}.room_security_u32`),
  });
}

function lookEntries(looks) {
  if (looks instanceof Map) return [...looks.entries()];
  if (record(looks)) return Object.entries(looks);
  fail('invalid-input', 'looks must be a Map or object', 503);
}

function exactBinding(generation, wire, agent) {
  if (!generation || typeof generation.getRoomBinding !== 'function')
    fail('map-generation-unavailable', 'a frozen atlas map generation is required', 503);
  const binding = generation.getRoomBinding(wire.resolved_room_num);
  if (!record(binding))
    fail('map-room-unavailable', `${agent} room ${wire.resolved_room_num} is absent from the frozen map`, 503);
  if (binding.room_num !== wire.resolved_room_num)
    fail('map-room-conflict', `${agent} frozen room number does not match ROOM_WIRE`);
  if (binding.room_resource_id !== wire.room_resource_id)
    fail('map-room-conflict', `${agent} room resource does not match the frozen room`);
  if (typeof binding.roo_file !== 'string' || !binding.roo_file ||
      !Number.isSafeInteger(binding.rows) || binding.rows < 1 || binding.rows > 4096 ||
      !Number.isSafeInteger(binding.cols) || binding.cols < 1 || binding.cols > 4096) {
    fail('map-room-unavailable', `${agent} frozen room lacks a bounded filename or dimensions`, 503);
  }
  return binding;
}

function validateObservedRoom(look, wire, binding, agent) {
  const room = record(look?.room) ? look.room : null;
  const size = record(room?.size) ? room.size : null;
  if (!room || room.num !== wire.resolved_room_num)
    fail('observation-conflict', `${agent} observed room number does not match ROOM_WIRE`);
  if (room.resource !== binding.roo_file)
    fail('observation-conflict', `${agent} observed room resource does not match the frozen room`);
  if (!size || size.rows !== binding.rows || size.cols !== binding.cols)
    fail('observation-conflict', `${agent} observed room dimensions do not match the frozen room`);
}

function sameWire(left, right) {
  return left.resolved_room_num === right.resolved_room_num &&
    left.room_resource_id === right.room_resource_id &&
    left.room_security_u32 === right.room_security_u32;
}

// Build one complete v8 generation.  All BP_PLAYER-derived fields arrive through
// `look.room_wire`; the frozen map is used only to validate and supply local
// filename/dimension facts.  It is never allowed to fill a missing wire field.
export function buildRtsSnapshotV8({ generation, ...legacyInput }) {
  const entries = lookEntries(legacyInput.looks);
  const rawByAgent = new Map();
  const boundByAgent = new Map();
  const roomWires = new Map();

  for (const [rawAgent, result] of entries) {
    const agent = String(rawAgent || '');
    if (!agent || rawByAgent.has(agent))
      fail('invalid-input', 'v8 look agents must be nonempty and unique', 503);
    rawByAgent.set(agent, result);
    if (result instanceof Error || result?.error)
      fail('observation-unavailable', `${agent} has no complete cached perception`, 503);
    const wire = exactRoomWire(result?.room_wire, `${agent}.room_wire`);
    const binding = exactBinding(generation, wire, agent);
    validateObservedRoom(result, wire, binding, agent);
    const prior = roomWires.get(wire.resolved_room_num);
    if (prior && !sameWire(prior, wire))
      fail('merged-room-conflict', `room ${wire.resolved_room_num} has conflicting live wire tuples`);
    roomWires.set(wire.resolved_room_num, wire);
    boundByAgent.set(agent, { wire, binding });
  }

  const legacy = buildRtsSnapshot(legacyInput);
  const projectedAgents = new Map((legacy.agents || []).map(agent => [agent.agent, agent]));
  if (projectedAgents.size !== rawByAgent.size ||
      [...rawByAgent.keys()].some(agent => !projectedAgents.has(agent))) {
    fail('incomplete-generation', 'v8 requires one projected AGENT for every requested look', 503);
  }

  const agents = legacy.agents.map(agent => {
    const bound = boundByAgent.get(agent.agent);
    if (!bound || agent.room_num !== bound.wire.resolved_room_num)
      fail('observation-conflict', `${agent.agent} projected room does not match ROOM_WIRE`);
    return {
      ...agent,
      room_num: bound.binding.room_num,
      room_resource: bound.binding.roo_file,
      room_wire: bound.wire,
    };
  });

  const rooms = legacy.rooms.map(room => {
    const wire = roomWires.get(room.num);
    if (!wire) fail('incomplete-generation', `room ${room.num} has no accepted ROOM_WIRE`, 503);
    const firstAgent = agents.find(agent => agent.room_num === room.num);
    const binding = firstAgent ? boundByAgent.get(firstAgent.agent)?.binding : null;
    if (!binding) fail('incomplete-generation', `room ${room.num} has no bound agent`, 503);
    return {
      ...room,
      resource: binding.roo_file,
      rows: binding.rows,
      cols: binding.cols,
    };
  });

  const mapBuildIdentity = typeof generation.map_build_identity === 'string'
    ? generation.map_build_identity : null;
  if (!mapBuildIdentity)
    fail('map-generation-unavailable', 'frozen map generation omitted map_build_identity', 503);

  return {
    ...legacy,
    schema: RTS_V8_SCHEMA,
    source: { ...legacy.source, map_build_identity: mapBuildIdentity },
    agents,
    rooms,
  };
}

function serializerWire(agent) {
  if (!record(agent)) fail('invalid-snapshot', 'v8 AGENT must be an object', 503);
  if (typeof agent.agent !== 'string' || !agent.agent)
    fail('invalid-snapshot', 'v8 AGENT name is missing', 503);
  return exactRoomWire(agent.room_wire, `${agent.agent}.room_wire`);
}

function serializerRoom(room, index) {
  if (!record(room)) fail('invalid-snapshot', `v8 ROOM ${index} must be an object`, 503);
  if (!Number.isSafeInteger(room.num) || room.num < 1 || room.num > 0x7fffffff)
    fail('invalid-snapshot', `v8 ROOM ${index} has an invalid room number`, 503);
  if (typeof room.resource !== 'string' || !room.resource)
    fail('invalid-snapshot', `v8 ROOM ${room.num} has no bound resource`, 503);
  if (!Number.isSafeInteger(room.rows) || room.rows < 1 || room.rows > 4096 ||
      !Number.isSafeInteger(room.cols) || room.cols < 1 || room.cols > 4096) {
    fail('invalid-snapshot', `v8 ROOM ${room.num} has invalid dimensions`, 503);
  }
  if (!Array.isArray(room.observed_by))
    fail('invalid-snapshot', `v8 ROOM ${room.num} has no observed_by membership`, 503);
  const observedBy = new Set();
  for (const agent of room.observed_by) {
    if (typeof agent !== 'string' || !agent || observedBy.has(agent))
      fail('invalid-snapshot', `v8 ROOM ${room.num} has invalid observed_by membership`, 503);
    observedBy.add(agent);
  }
  return { room, observedBy };
}

function validateSerializerBindings(snapshot, agents) {
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : null;
  if (!rooms?.length) fail('invalid-snapshot', 'v8 snapshot contains no rooms', 503);

  const roomsByNumber = new Map();
  for (const [index, room] of rooms.entries()) {
    const accepted = serializerRoom(room, index);
    if (roomsByNumber.has(room.num))
      fail('invalid-snapshot', `duplicate v8 ROOM ${room.num}`, 503);
    roomsByNumber.set(room.num, accepted);
  }

  const wires = new Map();
  const wireByRoom = new Map();
  const agentsByRoom = new Map();
  for (const agent of agents) {
    const wire = serializerWire(agent);
    if (wires.has(agent.agent)) fail('invalid-snapshot', `duplicate v8 AGENT ${agent.agent}`, 503);
    if (agent.room_num !== wire.resolved_room_num)
      fail('invalid-snapshot', `${agent.agent} AGENT room does not match ROOM_WIRE`, 503);
    const acceptedRoom = roomsByNumber.get(wire.resolved_room_num);
    if (!acceptedRoom)
      fail('invalid-snapshot', `${agent.agent} ROOM_WIRE has no matching ROOM`, 503);
    if (typeof agent.room_resource !== 'string' || !agent.room_resource ||
        agent.room_resource !== acceptedRoom.room.resource) {
      fail('invalid-snapshot', `${agent.agent} bound resource does not match ROOM`, 503);
    }
    const priorWire = wireByRoom.get(wire.resolved_room_num);
    if (priorWire && !sameWire(priorWire, wire))
      fail('invalid-snapshot', `v8 ROOM ${wire.resolved_room_num} has conflicting ROOM_WIRE tuples`, 503);
    wireByRoom.set(wire.resolved_room_num, wire);
    if (!agentsByRoom.has(wire.resolved_room_num)) agentsByRoom.set(wire.resolved_room_num, new Set());
    agentsByRoom.get(wire.resolved_room_num).add(agent.agent);
    wires.set(agent.agent, wire);
  }

  if (roomsByNumber.size !== agentsByRoom.size)
    fail('invalid-snapshot', 'v8 ROOM membership does not exactly match AGENT rooms', 503);
  for (const [roomNumber, acceptedRoom] of roomsByNumber) {
    const expected = agentsByRoom.get(roomNumber);
    if (!expected || expected.size !== acceptedRoom.observedBy.size ||
        [...expected].some(agent => !acceptedRoom.observedBy.has(agent))) {
      fail('invalid-snapshot', `v8 ROOM ${roomNumber} observed_by does not match its AGENT membership`, 503);
    }
  }
  return wires;
}

// Reuse the v7 serializer for every pre-existing record, then change the owned
// payload header and insert the one new fixed record.  This makes byte-for-byte
// legacy stability mechanically enforceable instead of duplicating 100+ fields.
export function toNativeSnapshotV8(snapshot) {
  if (!record(snapshot) || snapshot.schema !== RTS_V8_SCHEMA)
    fail('invalid-snapshot', `expected ${RTS_V8_SCHEMA} snapshot`, 503);
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (!agents.length) fail('invalid-snapshot', 'v8 snapshot contains no agents', 503);
  const wires = validateSerializerBindings(snapshot, agents);

  const legacy = toNativeSnapshot({ ...snapshot, schema: RTS_SCHEMA });
  const input = legacy.split('\n');
  if (input.at(-1) !== '') fail('invalid-snapshot', 'legacy serializer omitted its final newline', 503);
  input.pop();
  const header = input[0]?.split('\t') || [];
  if (header.length !== 6 || header[0] !== 'M59RTS' || header[1] !== '7')
    fail('invalid-snapshot', 'legacy serializer returned an unexpected header', 503);
  header[1] = String(RTS_V8_NATIVE_VERSION);

  const output = [header.join('\t')];
  const emitted = new Set();
  for (const line of input.slice(1)) {
    output.push(line);
    if (!line.startsWith('AGENT\t')) continue;
    const fields = line.split('\t');
    let agent;
    try { agent = decodeURIComponent(fields[1]); }
    catch { fail('invalid-snapshot', 'legacy serializer emitted an invalid AGENT name', 503); }
    const wire = wires.get(agent);
    if (!wire || emitted.has(agent))
      fail('invalid-snapshot', `native AGENT ${agent || '?'} has no unique ROOM_WIRE`, 503);
    emitted.add(agent);
    output.push([
      'ROOM_WIRE', encodeURIComponent(agent), wire.resolved_room_num,
      wire.room_resource_id, wire.room_security_u32,
    ].join('\t'));
  }
  if (emitted.size !== wires.size)
    fail('invalid-snapshot', 'one or more v8 ROOM_WIRE records could not be placed', 503);
  return `${output.join('\n')}\n`;
}
