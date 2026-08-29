#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  AtlasMapGeneration,
  geometryManifestForRooms,
} from './m59-atlas-topology.mjs';
import { buildRtsSnapshotV8 } from './m59-rts-contract-v8.mjs';
import { createGatewayServer } from './m59-rts-gateway.mjs';
import { RoomSceneV3Store } from './m59-rts-scene-v3.mjs';

const plane = Buffer.from([1, 1, 1, 1, 1, 1]).toString('base64');
const sourceRoom = {
  num: 200,
  name: 'Marion',
  roomRsc: 22001,
  rsc: 'room_marion',
  rooFile: 'marion.roo',
  rows: 2,
  cols: 3,
  edgeExits: [],
  goExits: [],
  roo: {
    file: 'marion.roo', security: 4294967294, version: 13, rows: 2, cols: 3,
    grid: plane, flags: plane, walls: [[0, 0, 3072, 0, 1]],
    collision: { digest: '11'.repeat(32) },
    sectors: [{
      id: 1, serverId: 71, floorType: 301, ceilingType: 302, tx: 4, ty: 5,
      floorHeight: 160, ceilingHeight: 3200, light: 192, flags: 0, speed: 0,
      depth: 0, slopedFloor: null, slopedCeiling: null,
    }],
    leaves: [{
      node: 1, sector: 1, bbox: [0, 0, 3072, 2048],
      polygon: [[0, 0], [3072, 0], [3072, 2048], [0, 2048]],
    }],
  },
};
const verifiedRoo = JSON.parse(JSON.stringify(sourceRoom.roo));
const verifiedLoader = () => ({
  toJSON: () => JSON.parse(JSON.stringify(verifiedRoo)),
});
const rooms = { 200: sourceRoom };
const generation = AtlasMapGeneration.fromMap({
  ...geometryManifestForRooms(rooms),
  geometrySource: 'offline bound gateway fixture',
  rooms,
});
const boundSceneStore = new RoomSceneV3Store(generation, { loadRooImpl: verifiedLoader });
assert.equal(boundSceneStore.status.ready, true);

const otherGeneration = AtlasMapGeneration.fromMap({
  ...geometryManifestForRooms({ 201: { ...sourceRoom, num: 201 } }),
  geometrySource: 'different offline bound gateway fixture',
  rooms: { 201: { ...sourceRoom, num: 201 } },
});
const otherStore = new RoomSceneV3Store(otherGeneration, { loadRooImpl: verifiedLoader });
assert.throws(() => createGatewayServer({
  reader: {}, atlasGeneration: generation, boundSceneStore: otherStore,
}), /share one frozen generation/);

function boundSnapshot() {
  return buildRtsSnapshotV8({
    generation,
    health: { fleet: 'fixture', pid: 1234 },
    fleetPayload: { fleet: [{ agent: 't1', character: 'Kermit' }] },
    looks: new Map([['t1', {
      room: { num: 200, name: 'Marion', resource: 'marion.roo', size: { rows: 2, cols: 3 } },
      room_wire: {
        resolved_room_num: 200,
        room_resource_id: 22001,
        room_security_u32: 4294967294,
      },
      you: { object_id: 501, col: 1, row: 1 },
      vitals: {}, objects: [], exits: [],
    }]]),
    equipment: new Map(), spells: new Map(), inventory: new Map(),
    commander: null, control: new Map(), commerce: new Map(),
    observedAt: '2026-08-28T12:34:56.789Z',
    sequence: 'bound-gateway-1',
  });
}

const reader = {
  ordersEnabled: false,
  controlStatus: { armed: false },
  controlServer: null,
  fastPathStatus: { mode: 'offline-fixture' },
  async health() { return { fleet: 'fixture', pid: 1234, sessions: ['t1'] }; },
  async snapshotV8(agents, acceptedGeneration) {
    assert.deepEqual(agents, ['t1']);
    assert.strictEqual(acceptedGeneration, generation);
    return boundSnapshot();
  },
  async snapshot() { throw new Error('legacy snapshot is outside this bound endpoint test'); },
  events() { return new Promise(() => {}); },
};

function request(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port: server.address().port, path,
      headers: { host: `127.0.0.1:${server.address().port}` },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
  });
}

const server = createGatewayServer({ reader, atlasGeneration: generation, boundSceneStore });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const contractResponse = await request(server, '/v1/contract');
  assert.equal(contractResponse.status, 200);
  const contract = JSON.parse(contractResponse.body);
  assert.equal(contract.scene_contracts.available, true);
  assert.equal(contract.scene_contracts.map_build_identity, generation.map_build_identity);
  assert.equal(contract.scene_contracts.snapshot.native_version, 8);
  assert.equal(contract.scene_contracts.scene.native_version, 3);
  assert.equal(contract.scene_contracts.atlas.maximum_bytes, 16 * 1024 * 1024);

  const jsonSceneResponse = await request(server, '/v1/scene.v3?room=200');
  assert.equal(jsonSceneResponse.status, 200);
  const jsonScene = JSON.parse(jsonSceneResponse.body);
  assert.equal(jsonScene.schema, 'm59-rts-scene/v3');
  assert.equal(jsonScene.binding.atlas_artifact_sha256, generation.summary.sha256);
  assert.equal(jsonScene.binding.room_resource_id, 22001);
  assert.equal(jsonScene.binding.roo_security_u32, 4294967294);

  const nativeSceneResponse = await request(server, '/v1/scene.v3.tsv?room=200');
  assert.equal(nativeSceneResponse.status, 200);
  assert.equal(nativeSceneResponse.headers['content-type'],
    'application/x-m59-rts-room; version=3; charset=utf-8');
  assert.equal(nativeSceneResponse.headers['content-length'], String(nativeSceneResponse.body.length));
  assert.equal(nativeSceneResponse.headers['content-encoding'], undefined);
  assert.equal(nativeSceneResponse.headers['transfer-encoding'], undefined);
  const nativeScene = nativeSceneResponse.body.toString('utf8');
  const sceneLines = nativeScene.split('\n');
  assert.match(sceneLines[0], /^M59ROOM\t3\t200\t/);
  assert.match(sceneLines[1], /^M59BIND\t1\tM59ATLAS%2F1\t/);
  assert.equal(sceneLines.filter(line => line.startsWith('M59BIND\t')).length, 1);
  assert.match(nativeScene, /\nENDROOM\n$/);

  const jsonSnapshotResponse = await request(server, '/v1/snapshot.v8?agent=t1');
  assert.equal(jsonSnapshotResponse.status, 200);
  const jsonSnapshot = JSON.parse(jsonSnapshotResponse.body);
  assert.equal(jsonSnapshot.schema, 'm59-rts/v2');
  assert.equal(jsonSnapshot.source.map_build_identity, generation.map_build_identity);
  assert.deepEqual(jsonSnapshot.agents[0].room_wire, {
    resolved_room_num: 200,
    room_resource_id: 22001,
    room_security_u32: 4294967294,
  });

  const nativeSnapshotResponse = await request(server, '/v1/snapshot.v8.tsv?agent=t1');
  assert.equal(nativeSnapshotResponse.status, 200);
  assert.equal(nativeSnapshotResponse.headers['content-type'],
    'application/x-m59-rts-snapshot; version=8; charset=utf-8');
  const nativeSnapshot = nativeSnapshotResponse.body.toString('utf8');
  assert.match(nativeSnapshot, /^M59RTS\t8\tbound-gateway-1\t/);
  assert.match(nativeSnapshot, /\nAGENT\tt1\t[^\n]+\nROOM_WIRE\tt1\t200\t22001\t4294967294\n/);

  for (const path of [
    '/v1/snapshot.v8?agent=not!valid',
    '/v1/snapshot.v8?agent=',
    '/v1/snapshot.v8?agent=t1&agent=t1',
    '/v1/snapshot.v8?agent=t1&extra=x',
  ]) {
    const response = await request(server, path);
    assert.equal(response.status, 400, path);
  }

  for (const path of [
    '/v1/scene.v3',
    '/v1/scene.v3?room=200&room=200',
    '/v1/scene.v3?room=%32%30%30',
    '/v1/scene.v3?room=999',
  ]) {
    const response = await request(server, path);
    assert.equal(response.status, path.endsWith('999') ? 404 : 400, path);
    assert.equal(response.headers.location, undefined);
  }
} finally {
  server.close();
  await once(server, 'close');
}

console.log('m59 RTS bound v8/v3 gateway endpoints: PASS');
