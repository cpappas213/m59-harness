#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

import { RealtimeHub, createNativeStreamServer } from './m59-rts-gateway.mjs';

function fixture(sequence, bound) {
  return {
    schema: bound ? 'm59-rts/v2' : 'm59-rts/v1',
    sequence: String(sequence),
    observed_at: '2026-08-28T12:34:56.789Z',
    source: {
      fleet: 'fixture', broker_pid: 1234,
      ...(bound ? { map_build_identity: `M59ATLAS/1:${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}` } : {}),
    },
    agents: [{
      agent: 't1', character: 'Kermit', room_num: 200, room: 'Marion',
      room_resource: 'marion.roo', level: 3, object_id: 501, col: 10, row: 11,
      facing: 'east', facing_degrees: 90, health: {}, mana: {}, vigor: {},
      ...(bound ? { room_wire: {
        resolved_room_num: 200, room_resource_id: 4294967295,
        room_security_u32: 4294967294,
      } } : {}),
    }],
    rooms: [{ num: 200, name: 'Marion', resource: 'marion.roo', rows: 88,
      cols: 93, observed_by: ['t1'], entities: [], exits: [] }],
    errors: [],
  };
}

function collectFrames(socket, count, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const frames = [];
    const timeout = setTimeout(() => finish(new Error(`timed out after ${frames.length} frames`)), timeoutMs);
    const finish = error => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(frames);
    };
    const onError = error => finish(error);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const header = buffer.subarray(0, newline).toString('utf8').split('\t');
        if (header[0] === 'M59ERROR') return finish(new Error(buffer.toString('utf8')));
        if (header.length !== 3 || header[0] !== 'M59FRAME' || header[1] !== '1')
          return finish(new Error('bad native frame header'));
        const bytes = Number(header[2]);
        if (!Number.isSafeInteger(bytes) || bytes < 1) return finish(new Error('bad native frame length'));
        if (buffer.length < newline + 1 + bytes) break;
        frames.push(buffer.subarray(newline + 1, newline + 1 + bytes).toString('utf8'));
        buffer = buffer.subarray(newline + 1 + bytes);
        if (frames.length >= count) return finish();
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

let legacySequence = 0;
let boundSequence = 0;
const never = new Promise(() => {});
const reader = {
  fastPathStatus: { mode: 'broker-aggregate-v1' },
  async snapshot(requested) {
    assert.deepEqual(requested, ['t1']);
    return fixture(++legacySequence, false);
  },
  events() { return never; },
};
const hub = new RealtimeHub({
  reader,
  reconcileMs: 50,
  boundSnapshot: async requested => {
    assert.deepEqual(requested, ['t1']);
    if (++boundSequence > 1) throw new Error('synthetic v8 tuple became incomplete');
    return fixture(boundSequence, true);
  },
});
const server = createNativeStreamServer({ reader, hub });
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const boundSocket = net.createConnection(server.address().port, '127.0.0.1');
await once(boundSocket, 'connect');
const boundFramesPromise = collectFrames(boundSocket, 1);
boundSocket.write('M59SUB\t2\tt1\n');
const [boundFrame] = await boundFramesPromise;
assert.match(boundFrame, /^M59RTS\t8\t1\t/);
assert.match(boundFrame, /\nAGENT\tt1\t/);
assert.match(boundFrame, /\nROOM_WIRE\tt1\t200\t4294967295\t4294967294\n/);
assert.doesNotMatch(boundFrame, /^M59RTS\t7\t/);

const legacySocket = net.createConnection(server.address().port, '127.0.0.1');
await once(legacySocket, 'connect');
const legacyFramesPromise = collectFrames(legacySocket, 2);
legacySocket.write('M59SUB\t1\tt1\n');
const legacyFrames = await legacyFramesPromise;
assert.equal(legacyFrames.length, 2);
assert.ok(legacyFrames.every(frame => /^M59RTS\t7\t/.test(frame)));
assert.ok(legacySequence >= 2,
  'legacy reconciliation must continue when the simultaneous strict v8 profile fails');

boundSocket.destroy();
legacySocket.destroy();
hub.close();
server.close();
await once(server, 'close');

// Exact subscription cohorts are independent even inside the same strict profile.
// A missing tuple for t2 must neither broaden t1's frame nor freeze it.
const cohortRequests = [];
const cohortReader = {
  fastPathStatus: { mode: 'broker-aggregate-v1' },
  snapshot() { throw new Error('legacy profile was not requested'); },
  events() { return never; },
};
const cohortHub = new RealtimeHub({
  reader: cohortReader,
  reconcileMs: 1000,
  boundSnapshot: async requested => {
    cohortRequests.push([...requested]);
    if (requested.includes('t2')) throw new Error('t2 tuple incomplete');
    return fixture(99, true);
  },
});
const t1Events = [];
const t2Events = [];
const channel = events => ({
  latestGeneration: true,
  send: (event, value) => events.push({ event, value }),
  close() {},
});
const unsubscribeT1 = cohortHub.subscribeChannel(channel(t1Events), ['t1'], 2);
const unsubscribeT2 = cohortHub.subscribeChannel(channel(t2Events), ['t2'], 2);
await cohortHub.reconcile('test');
assert.deepEqual(cohortRequests, [['t1'], ['t2']]);
assert.deepEqual(t1Events.map(row => row.event), ['snapshot']);
assert.deepEqual(t1Events[0].value.agents.map(agent => agent.agent), ['t1']);
assert.deepEqual(t2Events.map(row => row.event), ['gateway-error']);
unsubscribeT1();
unsubscribeT2();
cohortHub.close();

// An optional broker event-cursor failure keeps the unversioned legacy SSE event
// name, but must not be mistaken for a terminal bound-generation failure by a
// profile-2 native channel.
let rejectEventRead;
const eventRead = new Promise((resolve, reject) => { rejectEventRead = reject; });
const eventReader = {
  fastPathStatus: { mode: 'broker-aggregate-v1' },
  snapshot: async () => fixture(100, false),
  events: () => eventRead,
};
const eventHub = new RealtimeHub({
  reader: eventReader,
  reconcileMs: 1000,
  boundSnapshot: async () => fixture(100, true),
});
const legacyEventFailures = [];
const boundEventFailures = [];
let resolveLegacyFailure;
const legacyFailureSeen = new Promise(resolve => { resolveLegacyFailure = resolve; });
const eventChannel = (events, notify = null) => ({
  latestGeneration: true,
  send(event, value) {
    events.push({ event, value });
    notify?.();
  },
  close() {},
});
const unsubscribeLegacyEvent = eventHub.subscribeChannel(
  eventChannel(legacyEventFailures, resolveLegacyFailure), ['t1'], 1);
const unsubscribeBoundEvent = eventHub.subscribeChannel(
  eventChannel(boundEventFailures), ['t1'], 2);
rejectEventRead(new Error('synthetic optional event cursor failure'));
await legacyFailureSeen;
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(legacyEventFailures.map(row => [row.event, row.value.type]),
  [['gateway-error', 'gateway-error']]);
assert.deepEqual(boundEventFailures.map(row => [row.event, row.value.type]),
  [['event-error', 'event-error']]);
assert.equal(boundEventFailures.some(row => row.event === 'gateway-error'), false,
  'profile 2 must not receive the terminal event for an optional cursor failure');
unsubscribeLegacyEvent();
unsubscribeBoundEvent();
eventHub.close();

console.log('m59 RTS native M59SUB/2 v8 isolation: PASS');
