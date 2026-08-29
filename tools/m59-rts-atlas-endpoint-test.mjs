#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

import {
  AtlasMapGeneration,
  geometryManifestForRooms,
} from './m59-atlas-topology.mjs';
import { createGatewayServer } from './m59-rts-gateway.mjs';

const room = {
  num: 200,
  roomRsc: 22001,
  rsc: 'room_marion',
  rooFile: 'marion.roo',
  rows: 2,
  cols: 3,
  edgeExits: [],
  goExits: [],
  roo: {
    file: 'marion.roo', security: 4294967294, rows: 2, cols: 3,
    collision: { digest: '11'.repeat(32) },
  },
};
const rooms = { 200: room };
const generation = AtlasMapGeneration.fromMap({
  ...geometryManifestForRooms(rooms),
  geometrySource: 'offline endpoint fixture',
  rooms,
});

const reader = {
  ordersEnabled: false,
  controlStatus: { armed: false },
  controlServer: null,
  fastPathStatus: { mode: 'offline-fixture' },
  async health() { return { fleet: 'fixture', pid: 1234, sessions: [] }; },
  async snapshot() { throw new Error('snapshot is outside this endpoint test'); },
  events() { return new Promise(() => {}); },
};

async function start(atlasGeneration) {
  const server = createGatewayServer({ reader, atlasGeneration });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

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

const server = await start(generation);
try {
  const hash = generation.summary.sha256;
  const valid = await request(server, `/v1/atlas.v1.tsv?sha256=${hash}`);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers['content-type'],
    'application/x-m59-atlas-topology; version=1; charset=utf-8');
  assert.equal(valid.headers['content-length'], String(Buffer.byteLength(generation.artifact)));
  assert.equal(valid.headers['x-content-type-options'], 'nosniff');
  assert.equal(valid.headers['content-encoding'], undefined);
  assert.equal(valid.headers['transfer-encoding'], undefined);
  assert.equal(valid.headers.location, undefined);
  assert.equal(valid.body.toString('utf8'), generation.artifact);
  assert.equal(createHash('sha256').update(valid.body).digest('hex'), hash);

  const wrong = await request(server, `/v1/atlas.v1.tsv?sha256=${'00'.repeat(32)}`);
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.location, undefined);

  for (const path of [
    '/v1/atlas.v1.tsv',
    `/v1/atlas.v1.tsv?sha256=${hash}&sha256=${hash}`,
    `/v1/atlas.v1.tsv?sha256=${hash}&extra=1`,
    `/v1/atlas.v1.tsv?sha256=%62${hash.slice(1)}`,
    `/v1/atlas.v1.tsv?sha256=${hash.toUpperCase()}`,
  ]) {
    const invalid = await request(server, path);
    assert.equal(invalid.status, 400, path);
    assert.equal(invalid.headers.location, undefined);
  }
} finally {
  server.close();
  await once(server, 'close');
}

const unavailable = await start(null);
try {
  const response = await request(unavailable,
    `/v1/atlas.v1.tsv?sha256=${generation.summary.sha256}`);
  assert.equal(response.status, 503);
} finally {
  unavailable.close();
  await once(unavailable, 'close');
}

console.log('m59 RTS content-addressed atlas endpoint: PASS');
