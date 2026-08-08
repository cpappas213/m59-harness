#!/usr/bin/env node
// Read-only benchmark for the broker-to-gateway snapshot seam. With no --broker it
// hosts a loopback fixture and compares the same five-character state through the
// legacy N JSON-RPC calls and the aggregate GET. Pass --broker only after a broker has
// deliberately been restarted onto the new endpoint to measure the real process.

import http from 'node:http';
import process from 'node:process';
import { BrokerReader, BROKER_RTS_READ_SCHEMA } from './m59-rts-gateway.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

function report(values, fetches, iterations) {
  return {
    p50_ms: Number(percentile(values, 0.50).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
    max_ms: Number(Math.max(...values).toFixed(3)),
    fetches_per_frame: Number((fetches / iterations).toFixed(2)),
  };
}

async function measure(reader, iterations, counter) {
  for (let i = 0; i < 5; i++) await reader.snapshot(counter.agents);
  counter.fetches = 0;
  const values = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await reader.snapshot(counter.agents);
    values.push(performance.now() - started);
  }
  return report(values, counter.fetches, iterations);
}

function fixture(agent, index) {
  const objects = [];
  for (let i = 0; i < 36; i++) {
    objects.push({
      id: 9000 + i,
      name: i % 4 === 0 ? 'giant rat' : `scenery ${i}`,
      col: 8 + i % 9,
      row: 8 + Math.floor(i / 9),
      x: (8 + i % 9) * 64 + 32,
      y: (8 + Math.floor(i / 9)) * 64 + 32,
      facing: 'east',
      facing_degrees: 0,
      can: i % 4 === 0 ? ['attack', 'look'] : ['look'],
    });
  }
  return {
    fleet: { agent, character: `Fixture ${index + 1}`, room: 'Marion', room_num: 200,
             level: 30 + index, activity: 'fixture', busy: null },
    look: {
      room: { num: 200, name: 'Marion', resource: 'marion.roo', size: { rows: 88, cols: 93 } },
      you: { object_id: 500 + index, col: 10 + index, row: 11, x: (10 + index) * 64 + 32,
             y: 11 * 64 + 32, angle: 0, facing: 'east', facing_degrees: 0 },
      vitals: { health: { value: 30, max: 30 }, mana: { value: 15, max: 20 },
                vigor: { value: 110, scale_max: 200 } },
      objects,
      exits: [{ kind: 'door', to: 201, to_name: 'Next room', stand_on: { col: 20, row: 21 } }],
    },
    equipment: { known: true, fresh_ms: 50, equipped: [{ id: 700 + index, name: 'mace' }] },
  };
}

async function localFixture(agentNames) {
  const fixtures = new Map(agentNames.map((agent, index) => [agent, fixture(agent, index)]));
  const fleet = { fleet: [...fixtures.values()].map(value => value.fleet) };
  const send = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/rts/v1/read') {
      const asked = url.searchParams.getAll('agent');
      const agents = asked.length ? asked.filter(agent => fixtures.has(agent)) : agentNames;
      const captured = Date.now();
      return send(res, 200, {
        schema: BROKER_RTS_READ_SCHEMA,
        read_only: true,
        observed_at: new Date(captured).toISOString(),
        sequence: `${captured}-4242`,
        health: { ok: true, pid: 4242, fleet: 'fixture', sessions: agentNames },
        fleet,
        agents,
        looks: Object.fromEntries(agents.map(agent => [agent, fixtures.get(agent).look])),
        equipment: Object.fromEntries(agents.map(agent => [agent, fixtures.get(agent).equipment])),
      });
    }
    if (req.method === 'GET' && url.pathname === '/health')
      return send(res, 200, { ok: true, pid: 4242, fleet: 'fixture', sessions: agentNames });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const name = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      let value;
      if (name === 'fleet') value = fleet;
      else if (name === 'look') value = fixtures.get(args.agent)?.look;
      else if (name === 'equipment') value = fixtures.get(args.agent)?.equipment;
      else return send(res, 400, { error: `unknown fixture tool ${name}` });
      return send(res, 200, { jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const agents = option('--agents', 't1,t2,t3,t4,t5').split(',').filter(Boolean);
if (!agents.length || agents.length > 40 || agents.some(agent => !/^[A-Za-z0-9_-]{1,64}$/.test(agent)))
  throw new Error('agents must contain 1-40 simple identifiers');
const iterations = Math.max(10, Math.min(500, Number(option('--iterations', '100')) || 100));
const brokerArg = option('--broker', '');

if (brokerArg) {
  const url = new URL(brokerArg);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
    throw new Error('live benchmark broker must be loopback');
  const counter = { agents, fetches: 0 };
  const reader = new BrokerReader({
    brokerUrl: url,
    expectedFleet: option('--fleet', process.env.M59_FLEET || 'prod'),
    readToken: process.env.M59_RTS_READ_TOKEN || '',
    fetchImpl: async (...args) => { counter.fetches++; return fetch(...args); },
  });
  const result = await measure(reader, iterations, counter);
  console.log(JSON.stringify({ mode: 'live-read-only', agents: agents.length, iterations,
    broker_read_path: reader.fastPathStatus, result }, null, 2));
} else {
  const fixtureServer = await localFixture(agents);
  try {
    const fastCounter = { agents, fetches: 0 };
    const legacyCounter = { agents, fetches: 0 };
    const fast = new BrokerReader({
      brokerUrl: fixtureServer.url,
      expectedFleet: 'fixture',
      fetchImpl: async (...args) => { fastCounter.fetches++; return fetch(...args); },
    });
    const legacy = new BrokerReader({
      brokerUrl: fixtureServer.url,
      expectedFleet: 'fixture',
      fastPath: false,
      fetchImpl: async (...args) => { legacyCounter.fetches++; return fetch(...args); },
    });
    const fastResult = await measure(fast, iterations, fastCounter);
    const legacyResult = await measure(legacy, iterations, legacyCounter);
    console.log(JSON.stringify({
      mode: 'offline-loopback-fixture',
      note: 'transport/serialization benchmark only; it sends no Meridian packets',
      agents: agents.length,
      entities_per_agent: 36,
      iterations,
      aggregate: fastResult,
      legacy: legacyResult,
      p50_speedup: Number((legacyResult.p50_ms / Math.max(0.001, fastResult.p50_ms)).toFixed(2)),
      p95_speedup: Number((legacyResult.p95_ms / Math.max(0.001, fastResult.p95_ms)).toFixed(2)),
    }, null, 2));
  } finally {
    await new Promise(resolve => fixtureServer.server.close(resolve));
  }
}
