#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { RealtimeHub, createNativeStreamServer } from './m59-rts-gateway.mjs';

function fixture(sequence) {
  return {
    schema: 'm59-rts/v1',
    sequence: String(sequence),
    observed_at: new Date().toISOString(),
    source: { fleet: 'prod', broker_pid: 1234 },
    agents: [{
      agent: 't1', character: 'Kermit', room_num: 200, room: 'Marion',
      room_resource: 'marion.roo', level: 3, object_id: 501, col: 10, row: 11,
      facing: 'east', facing_degrees: 90, health: {}, mana: {}, vigor: {},
    }],
    rooms: [{ num: 200, name: 'Marion', resource: 'marion.roo', rows: 88,
      cols: 93, observed_by: ['t1'], entities: [], exits: [] }],
    errors: [],
  };
}

let sequence = 0;
const never = new Promise(() => {});
const reader = {
  fastPathStatus: { mode: 'broker-aggregate-v1' },
  async snapshot(requested) {
    assert.deepEqual(requested, ['t1']);
    return fixture(++sequence);
  },
  events() { return never; },
};
const hub = new RealtimeHub({ reader, reconcileMs: 50 });
const server = createNativeStreamServer({ reader, hub });
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const socket = net.createConnection(server.address().port, '127.0.0.1');
await once(socket, 'connect');
socket.write('M59SUB\t1\tt1\n');

let buffer = Buffer.alloc(0);
const frames = [];
const started = performance.now();
for await (const chunk of socket) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const newline = buffer.indexOf(10);
    if (newline < 0) break;
    const header = buffer.subarray(0, newline).toString('utf8').split('\t');
    if (header[0] !== 'M59FRAME' || header[1] !== '1') throw new Error('bad native frame header');
    const bytes = Number(header[2]);
    if (buffer.length < newline + 1 + bytes) break;
    const payload = buffer.subarray(newline + 1, newline + 1 + bytes).toString('utf8');
    buffer = buffer.subarray(newline + 1 + bytes);
    frames.push({ at: performance.now(), payload });
  }
  if (frames.length >= 3) break;
  if (performance.now() - started > 1500) throw new Error('native stream did not reconcile in time');
}

assert.equal(frames.length, 3);
assert.match(frames[0].payload, /^M59RTS\t7\t1\t/);
assert.match(frames[1].payload, /^M59RTS\t7\t2\t/);
assert.match(frames[2].payload, /^M59RTS\t7\t3\t/);
assert.equal(hub.timing().effective_ms, 50,
  'the native newest-generation channel unlocks the aggregate 50ms cadence');
assert.ok(frames[2].at - frames[0].at < 250,
  'three aggregate/native generations should arrive within the 50ms-cadence envelope');

socket.destroy();
hub.close();
server.close();
await once(server, 'close');
console.log(`m59 RTS native stream: 3 framed generations in ${Math.round(frames[2].at - frames[0].at)}ms`);
