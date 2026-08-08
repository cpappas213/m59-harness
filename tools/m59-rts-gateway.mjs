#!/usr/bin/env node
// Loopback-only adapter from the existing MCP broker to the versioned RTS state
// contract. It owns no Meridian sessions, passwords, or authoritative state.

import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RTS_NATIVE_VERSION, RTS_SCHEMA, buildRtsSnapshot, toNativeSnapshot } from './m59-rts-contract.mjs';
import { RoomSceneStore, toNativeRoomScene } from './m59-rts-scene.mjs';
import {
  RTS_SAFE_SPELL_NAMES,
  rtsSafeSpellRule,
  rtsSpellTargetAllowed,
} from './m59-rts-safety.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const BROKER_RTS_READ_SCHEMA = 'm59-broker-rts-read/v1';
export const CONTEXT_ACTION_LIST = [
  'stand', 'rest_here', 'recover_here', 'grab_nearby', 'take', 'cast',
  'approach', 'face', 'equip_best', 'wear_best', 'eat_best', 'prepare',
  'item_use', 'item_unuse', 'item_eat', 'safety_on',
];
const CONTEXT_ACTIONS = new Set(CONTEXT_ACTION_LIST);
// Keep idempotency keys compact and limited to transport-safe identifier bytes.
// Ownership tokens are separately generated opaque values and never embed this id.
const ORDER_ID = /^[A-Za-z0-9._:-]{8,80}$/;

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function cleanAgent(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

// The control endpoint must be named exactly; it no longer has to be loopback. Every
// write path compares this against the broker's own reported game server and against
// each individual session's credentials, so the value's job is to be unambiguous, not
// to be local. A remote shared server is an ordinary control target.
export function parseControlServer(value) {
  const raw = String(value || '').trim();
  const match = raw.startsWith('[')
    ? /^\[([^\]]+)\]:(\d+)$/.exec(raw)
    : /^([^:]+):(\d+)$/.exec(raw);
  if (!match) throw new Error('--control-server must be an explicit host:port');
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!/^[a-z0-9.\-:]{1,255}$/.test(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('--control-server must name an exact game endpoint');
  return { host, port };
}

function endpoint(value) {
  if (!value || typeof value !== 'object') return null;
  const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
  const port = Number(value.port);
  return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

function sameEndpoint(left, right) {
  const a = endpoint(left), b = endpoint(right);
  return !!a && !!b && a.host === b.host && a.port === b.port;
}

function validOrderId(value) {
  return typeof value === 'string' && ORDER_ID.test(value) ? value : null;
}

function authorizedBearer(req, token) {
  const supplied = String(req.headers.authorization || '');
  const expected = `Bearer ${token}`;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostFromHeader(header) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1).toLowerCase();
  return raw.split(':')[0].toLowerCase();
}

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  const remoteLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return remoteLocal && LOOPBACK.has(hostFromHeader(req.headers.host));
}

function ageEquipment(value, ageMs) {
  if (!value || value instanceof Error || typeof value !== 'object' ||
      !Number.isFinite(value.fresh_ms)) return value;
  return {
    ...value,
    fresh_ms: Math.max(0, Math.trunc(value.fresh_ms + Math.max(0, ageMs))),
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value, null, 2));
}

export class BrokerReader {
  constructor({ brokerUrl = 'http://127.0.0.1:8901', expectedFleet = 'prod', fetchImpl = fetch,
                ordersEnabled = false, controlServer = null, controlToken = '', equipmentCacheMs = 5000,
                fastPath = true, fastPathRetryMs = 30000,
                readToken = process.env.M59_RTS_READ_TOKEN || '', allowedAgents = [],
                now = Date.now } = {}) {
    const url = new URL(brokerUrl);
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
      throw new Error('RTS gateway may attach only to a loopback HTTP broker');
    }
    this.url = url;
    this.expectedFleet = expectedFleet;
    this.fetch = fetchImpl;
    this.ordersEnabled = !!ordersEnabled;
    const controlServerText = typeof controlServer === 'string' ? controlServer
      : controlServer && typeof controlServer.host === 'string'
        ? `${controlServer.host.includes(':') ? `[${controlServer.host}]` : controlServer.host}:${controlServer.port}`
        : '';
    this.controlServer = controlServer ? parseControlServer(controlServerText) : null;
    this.controlToken = String(controlToken || '');
    // Cancellation ownership must survive retries without becoming reusable across
    // distinct commands.  The HTTP dedupe retains the result (and therefore these
    // tokens) for an exact retry, while a per-process random prefix plus a monotonic
    // allocation makes a newly admitted order unique even when a UI reuses order_id
    // after the dedupe TTL or after restarting the gateway.
    this.controlInstanceNonce = randomBytes(16).toString('hex');
    this.controlTokenCounter = 0;
    const rawAllowedAgents = Array.isArray(allowedAgents) ? allowedAgents : [];
    const cleanAllowedAgents = rawAllowedAgents.map(cleanAgent);
    if (cleanAllowedAgents.some(agent => !agent) || cleanAllowedAgents.length > 40)
      throw new Error('RTS control agents must be 1-40 simple identifiers');
    this.allowedAgents = new Set(cleanAllowedAgents);
    if (this.ordersEnabled) {
      // The fleet must still be NAMED — a gateway that inherited a default would be
      // arming writes against whichever roster the broker happened to hold — but which
      // fleet it names is no longer restricted. Production is an ordinary named fleet.
      if (!this.expectedFleet)
        throw new Error('RTS orders require an explicit --fleet name');
      if (!this.controlServer)
        throw new Error('RTS orders require --control-server with the exact game endpoint');
      if (this.controlToken.length < 16)
        throw new Error('RTS orders require M59_RTS_CONTROL_TOKEN (at least 16 characters)');
      if (!this.allowedAgents.size)
        throw new Error('RTS orders require an explicit non-empty --agents control roster');
    }
    this.equipmentCacheMs = Math.max(1000, Number(equipmentCacheMs) || 5000);
    this.now = typeof now === 'function' ? now : Date.now;
    this.fastPathEnabled = fastPath !== false;
    this.fastPathRetryMs = Math.max(1000, Number(fastPathRetryMs) || 30000);
    this.readToken = String(readToken || '');
    this.fastPathUnavailableUntil = 0;
    this.fastPathStatus = {
      mode: this.fastPathEnabled ? 'probing' : 'legacy-disabled',
      reason: this.fastPathEnabled ? null : 'disabled by configuration',
    };
    this.fleetCache = null;
    this.healthCache = null;
    this.equipmentCache = new Map();
    this.equipmentBrokerPid = null;
    this.controlStatus = {
      configured: this.ordersEnabled,
      armed: false,
      reason: this.ordersEnabled ? 'broker endpoint not yet verified' : 'orders disabled',
    };
  }

  async health(maxAgeMs = 1000) {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at <= maxAgeMs) return this.healthCache.value;
    const response = await this.fetch(new URL('/health', this.url), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`broker health returned ${response.status}`);
    const health = await response.json();
    if (health.fleet !== this.expectedFleet) {
      throw new Error(`broker holds fleet ${health.fleet ?? 'unknown'}, expected ${this.expectedFleet}`);
    }
    this.healthCache = { at: now, value: health };
    return health;
  }

  async tool(name, args, timeout = 90000) {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`broker ${name} returned ${response.status}`);
    const envelope = await response.json();
    if (envelope.error) throw new Error(envelope.error.message || `broker ${name} failed`);
    const content = envelope.result?.content || [];
    const payload = content.find(item => item.type === 'text' && typeof item.text === 'string')?.text;
    if (envelope.result?.isError) throw new Error(payload || `broker ${name} failed`);
    if (!payload) return null;
    try { return JSON.parse(payload); }
    catch { throw new Error(`broker ${name} returned a non-JSON payload`); }
  }

  async fleetState(maxAgeMs = 5000) {
    const now = Date.now();
    if (this.fleetCache && now - this.fleetCache.at <= maxAgeMs) return this.fleetCache.value;
    const value = await this.tool('fleet', {});
    this.fleetCache = { at: now, value };
    return value;
  }

  async aggregateState(requestedAgents) {
    if (!this.fastPathEnabled) {
      if (this.readToken)
        throw new Error('RTS read token requires the broker aggregate endpoint; legacy fallback is disabled');
      return null;
    }
    if (this.now() < this.fastPathUnavailableUntil) {
      if (this.readToken)
        throw new Error('RTS read token forbids legacy fallback while the aggregate endpoint is unavailable');
      return null;
    }
    const url = new URL('/rts/v1/read', this.url);
    for (const agent of requestedAgents) url.searchParams.append('agent', agent);
    let response;
    try {
      response = await this.fetch(url, {
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(this.readToken ? { authorization: `Bearer ${this.readToken}` } : {}),
        },
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      if (this.readToken)
        throw new Error(`token-gated broker aggregate read failed closed: ${error.message}`);
      this.fastPathUnavailableUntil = this.now() + this.fastPathRetryMs;
      this.fastPathStatus = { mode: 'legacy-fallback', reason: `aggregate read failed: ${error.message}` };
      return null;
    }
    if ([404, 405, 501].includes(response.status)) {
      if (this.readToken)
        throw new Error('RTS read token is configured but this broker has no token-gated aggregate endpoint');
      this.fastPathUnavailableUntil = this.now() + this.fastPathRetryMs;
      this.fastPathStatus = {
        mode: 'legacy-fallback',
        reason: `broker does not expose ${BROKER_RTS_READ_SCHEMA} (HTTP ${response.status})`,
      };
      return null;
    }
    // A configured token or a loopback policy failure must fail closed. Falling back
    // to the broker's broader MCP surface would turn an authorization error into access.
    if (response.status === 401 || response.status === 403)
      throw new Error(`broker aggregate read refused authorization (${response.status})`);
    if (!response.ok) {
      if (this.readToken)
        throw new Error(`token-gated broker aggregate read failed closed (HTTP ${response.status})`);
      this.fastPathUnavailableUntil = this.now() + this.fastPathRetryMs;
      this.fastPathStatus = {
        mode: 'legacy-fallback',
        reason: `broker aggregate read returned ${response.status}`,
      };
      return null;
    }

    const payload = await response.json();
    if (payload?.schema !== BROKER_RTS_READ_SCHEMA || payload.read_only !== true)
      throw new Error('broker aggregate read returned an invalid or non-read-only contract');
    const health = payload.health;
    if (!health || !Number.isInteger(health.pid))
      throw new Error('broker aggregate read omitted broker identity');
    if (health.fleet !== this.expectedFleet)
      throw new Error(`broker holds fleet ${health.fleet ?? 'unknown'}, expected ${this.expectedFleet}`);
    const agents = Array.isArray(payload.agents) ? payload.agents.map(cleanAgent) : [];
    if (agents.some(agent => !agent) || !agents.length || agents.length > 40)
      throw new Error('broker aggregate read returned an invalid agent set');
    if (!payload.fleet || typeof payload.looks !== 'object' || typeof payload.equipment !== 'object')
      throw new Error('broker aggregate read omitted cached fleet state');

    const at = this.now();
    if (this.equipmentBrokerPid !== null && this.equipmentBrokerPid !== health.pid)
      this.equipmentCache.clear();
    this.equipmentBrokerPid = health.pid;
    this.healthCache = { at, value: health };
    this.fleetCache = { at, value: payload.fleet };
    for (const agent of agents) {
      if (payload.equipment[agent] !== undefined)
        this.equipmentCache.set(agent, { at, value: payload.equipment[agent] });
    }
    this.fastPathStatus = { mode: 'broker-aggregate-v1', reason: null };
    return payload;
  }

  equipmentState(agent) {
    const now = this.now();
    const cached = this.equipmentCache.get(agent);
    if (cached && Object.hasOwn(cached, 'value') && now - cached.at <= this.equipmentCacheMs) {
      return ageEquipment(cached.value, now - cached.at);
    }

    if (!cached?.pending) {
      // This is deliberately refresh:false and deliberately detached from the render
      // promise. Broker tool latency can spike while keepers are busy; equipment is
      // hero-panel telemetry and must never hold up positions or combat perception.
      const previous = cached && Object.hasOwn(cached, 'value') ? cached.value : null;
      const previousAt = cached?.at ?? now;
      const pending = this.tool('equipment', { agent, refresh: false }).then(
        value => this.equipmentCache.set(agent, { at: this.now(), value }),
        error => this.equipmentCache.set(agent, { at: this.now(), value: error }));
      this.equipmentCache.set(agent, { at: previousAt, value: previous, pending });
    }
    // First frame is honestly unknown. A stale known value remains usable while its
    // background refresh runs, with freshness continuing to age.
    const current = this.equipmentCache.get(agent);
    return ageEquipment(current?.value, now - (current?.at ?? now));
  }

  async events(agent, since) {
    return this.tool('wait_for_event', {
      agent,
      ...(since === undefined ? {} : { since }),
      timeout_ms: 30000,
    }, 35000);
  }

  async order(name, args) {
    if (!this.ordersEnabled) throw new Error('RTS gateway orders are disabled');
    return this.tool(name, args);
  }

  issueControlToken(orderId, agent) {
    if (!this.ordersEnabled) throw new Error('RTS gateway orders are disabled');
    if (this.controlTokenCounter >= Number.MAX_SAFE_INTEGER)
      throw new Error('RTS control token sequence exhausted; restart the gateway');
    const counter = (++this.controlTokenCounter).toString(36);
    const binding = createHash('sha256')
      .update(`${this.controlInstanceNonce}\0${counter}\0${orderId}\0${agent}`)
      .digest('hex').slice(0, 24);
    return `rts.${this.controlInstanceNonce}.${counter}.${binding}`;
  }

  assertControlHealth(health) {
    try {
      if (!this.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
      if (!sameEndpoint(health?.game_server, this.controlServer))
        throw orderError(403, 'broker fleet is not wholly attached to the allowed local game server');
      const agents = Array.isArray(health.sessions) ? health.sessions.map(cleanAgent) : [];
      if (!agents.length || agents.some(agent => !agent))
        throw orderError(503, 'RTS control requires at least one valid broker session');
      for (const agent of agents) {
        if (!sameEndpoint(health.session_game_servers?.[agent], this.controlServer))
          throw orderError(403, `${agent || 'a broker session'} is not attached to the allowed local game server`);
      }
      this.controlStatus = { configured: true, armed: true, reason: null };
      return health;
    } catch (error) {
      this.controlStatus = { configured: this.ordersEnabled, armed: false, reason: error.message };
      throw error;
    }
  }

  async assertControlReady() {
    return this.controlState([...this.allowedAgents]);
  }

  async controlState(requestedAgents) {
    try {
      if (!this.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
      const agents = [...new Set(requestedAgents.map(cleanAgent).filter(Boolean))];
      if (!agents.length || agents.length !== requestedAgents.length)
        throw orderError(400, 'control agents must be simple unique identifiers');
      const outside = agents.find(agent => !this.allowedAgents.has(agent));
      if (outside)
        throw orderError(403, `${outside} is outside this gateway's configured RTS control roster`);
      // Writes deliberately have no legacy fallback. The aggregate generation carries
      // both each actor's own perception and its game-server identity; an older broker
      // cannot prove either and therefore remains read-only.
      const aggregate = await this.aggregateState(agents);
      if (!aggregate)
        throw orderError(503, 'RTS control requires the broker aggregate endpoint; legacy brokers are read-only');
      if (agents.some(agent => !aggregate.agents.includes(agent)))
        throw orderError(409, 'one or more control agents are no longer present in the broker fleet');
      const health = this.assertControlHealth(aggregate.health);
      for (const agent of agents) {
        if (!sameEndpoint(health.session_game_servers?.[agent], this.controlServer))
          throw orderError(403, `${agent} is not attached to the allowed local game server`);
        const row = Array.isArray(aggregate.fleet?.fleet)
          ? aggregate.fleet.fleet.find(value => value?.agent === agent) : null;
        if (row?.autopilot?.running && !/^inert\b/i.test(String(row.activity || '')))
          throw orderError(409, `${agent} still has an active keeper; make it inert before RTS control`);
      }
      return aggregate;
    } catch (error) {
      this.controlStatus = {
        configured: this.ordersEnabled,
        armed: false,
        reason: error.message,
      };
      throw error;
    }
  }

  async snapshot(requestedAgents = []) {
    const requested = [...new Set(requestedAgents.map(cleanAgent).filter(Boolean))];
    if (requested.length > 40) throw new Error('RTS snapshots are limited to 40 agents');
    const aggregate = await this.aggregateState(requested);
    if (aggregate) {
      const agents = aggregate.agents;
      return buildRtsSnapshot({
        health: aggregate.health,
        fleetPayload: aggregate.fleet,
        looks: new Map(agents.map(agent => [agent,
          aggregate.looks[agent] ?? { error: 'aggregate read omitted cached perception' }])),
        equipment: new Map(agents.map(agent => [agent,
          aggregate.equipment[agent] ?? { error: 'aggregate read omitted cached equipment' }])),
        spells: new Map(agents.map(agent => [agent,
          aggregate.spells?.[agent] ?? []])),
        inventory: new Map(agents.map(agent => [agent,
          aggregate.inventory?.[agent] ?? []])),
        observedAt: aggregate.observed_at,
        sequence: aggregate.sequence,
      });
    }

    const [health, fleetPayload] = await Promise.all([this.health(), this.fleetState()]);
    if (this.equipmentBrokerPid !== null && this.equipmentBrokerPid !== health.pid) {
      this.equipmentCache.clear();
    }
    this.equipmentBrokerPid = health.pid;
    const fleetRows = Array.isArray(fleetPayload?.fleet) ? fleetPayload.fleet : [];
    const fleetAgents = fleetRows.map(row => cleanAgent(row?.agent)).filter(Boolean);
    const agents = requested.length ? requested.filter(agent => fleetAgents.includes(agent)) : fleetAgents;
    if (!agents.length) throw new Error('no requested agents are present in the broker fleet');
    if (agents.length > 40) throw new Error('RTS snapshots are limited to 40 agents');
    const equipmentEntries = agents.map(agent => [agent, this.equipmentState(agent)]);
    const lookEntries = await Promise.all(agents.map(async agent => {
      try { return [agent, await this.tool('look', { agent, cached: true, projection: 'render' })]; }
      catch (error) { return [agent, error]; }
    }));
    const looks = new Map(lookEntries);
    const equipment = new Map(equipmentEntries);
    const now = new Date();
    return buildRtsSnapshot({
      health,
      fleetPayload,
      looks,
      equipment,
      spells: new Map(),
      inventory: new Map(),
      observedAt: now.toISOString(),
      sequence: `${now.getTime()}-${health.pid}`,
    });
  }
}

function orderError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw orderError(400, `${label} must be a JSON object`);
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !permitted.has(key));
  if (unexpected.length)
    throw orderError(400, `${label} contains unsupported field${unexpected.length === 1 ? '' : 's'}: ` +
      unexpected.join(', '));
}

function exactInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function issuedControlToken(reader, orderId, agent) {
  if (typeof reader?.issueControlToken !== 'function')
    throw orderError(503, 'RTS control token issuer is unavailable');
  const token = reader.issueControlToken(orderId, agent);
  if (typeof token !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(token))
    throw orderError(503, 'RTS control token issuer returned an invalid token');
  return token;
}

function orderId(body) {
  const id = validOrderId(body?.order_id);
  if (!id) throw orderError(400, 'order_id is required (8-80 identifier characters)');
  return id;
}

function generationInfo(body, now) {
  const generation = typeof body?.generation === 'string'
    ? /^(\d+)-(\d+)$/.exec(body.generation) : null;
  if (!generation) throw orderError(409, 'missing or malformed snapshot generation');
  const observedAt = Number(generation[1]);
  const brokerPid = Number(generation[2]);
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(brokerPid) ||
      observedAt > now + 1000 || now - observedAt > 2000)
    throw orderError(409, 'snapshot generation is stale');
  return { observedAt, brokerPid };
}

function batch(body, type, allowedKeys = ['type', 'generation', 'order_id', 'orders']) {
  assertExactKeys(body, allowedKeys, `${type} request`);
  if (!body || body.type !== type || !Array.isArray(body.orders))
    throw orderError(400, `expected a ${type} order batch`);
  if (!body.orders.length || body.orders.length > 10)
    throw orderError(400, `${type} batches require 1-10 orders`);
}

function uniqueAgents(rows, type) {
  if (new Set(rows.map(row => row.agent)).size !== rows.length)
    throw orderError(400, `a ${type} batch may contain only one order per agent`);
}

function rawLook(state, agent) {
  const look = state.looks?.[agent];
  if (!look || look instanceof Error || look.error)
    throw orderError(409, `${agent} has no current broker perception`);
  return look;
}

async function settledDispatch(reader, tool, rows, argsFor) {
  const settled = await Promise.allSettled(rows.map(row => reader.order(tool, argsFor(row))));
  const outcomes = settled.map((result, index) => result.status === 'fulfilled'
    ? { agent: rows[index].agent, accepted: true, result: result.value }
    : { agent: rows[index].agent, accepted: false,
        error: String(result.reason?.message || result.reason).slice(0, 240) });
  return {
    accepted: outcomes.every(outcome => outcome.accepted),
    accepted_count: outcomes.filter(outcome => outcome.accepted).length,
    rejected_count: outcomes.filter(outcome => !outcome.accepted).length,
    outcomes,
  };
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw orderError(413, 'order request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw orderError(400, 'order request is not valid JSON'); }
}

export async function dispatchAttackOrder(reader, body, { now = Date.now() } = {}) {
  if (!reader.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
  batch(body, 'attack');
  const id = orderId(body);
  const { brokerPid } = generationInfo(body, now);
  for (const order of body.orders)
    assertExactKeys(order, ['agent', 'room', 'target_id', 'swings'], 'attack order');
  const normalized = body.orders.map(order => ({
    agent: cleanAgent(order?.agent),
    room: order?.room,
    target: order?.target_id,
    swings: order?.swings === undefined ? 20 : order.swings,
  }));
  if (normalized.some(order => !order.agent || !exactInteger(order.room) || order.room < 1 ||
      !exactInteger(order.target) || order.target < 1 ||
      !exactInteger(order.swings) || order.swings < 1 || order.swings > 20))
    throw orderError(400,
      'attack orders require a string agent, numeric positive integer room/target_id, and numeric 1-20 integer swings');
  uniqueAgents(normalized, 'attack');

  const state = await reader.controlState(normalized.map(order => order.agent));
  if (state.health.pid !== brokerPid)
    throw orderError(409, 'broker restarted after this snapshot generation');
  for (const order of normalized) {
    const look = rawLook(state, order.agent);
    if (Number(look.room?.num) !== order.room)
      throw orderError(409, `${order.agent} is no longer in room ${order.room}`);
    const target = (Array.isArray(look.objects) ? look.objects : [])
      .find(entity => Number(entity?.id) === order.target);
    if (!target || !Array.isArray(target.can) || !target.can.includes('attack'))
      throw orderError(409, `${order.agent} no longer perceives target ${order.target} as attackable`);
    if (target.is_player !== false)
      throw orderError(403, 'RTS control is PvE-only; player or unknown target kinds are refused');
  }

  const dispatch = await settledDispatch(reader, 'attack_intent', normalized, order => ({
    agent: order.agent, room: order.room, target: order.target, swings: order.swings,
    control_token: issuedControlToken(reader, id, order.agent),
    server_host: reader.controlServer.host, server_port: reader.controlServer.port,
  }));
  return {
    schema: RTS_SCHEMA,
    ...dispatch,
    order_id: id,
    generation: body.generation,
    accepted_at: new Date(now).toISOString(),
  };
}

export async function dispatchMoveOrder(reader, body, { now = Date.now(), sceneStore = null } = {}) {
  if (!reader.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
  batch(body, 'move');
  const id = orderId(body);
  const { brokerPid } = generationInfo(body, now);
  for (const order of body.orders)
    assertExactKeys(order, ['agent', 'room', 'col', 'row', 'max_steps'], 'move order');
  const normalized = body.orders.map(order => ({
    agent: cleanAgent(order?.agent),
    room: order?.room,
    col: order?.col,
    row: order?.row,
    maxSteps: order?.max_steps === undefined ? 120 : order.max_steps,
  }));
  if (normalized.some(order => !order.agent || !exactInteger(order.room) || order.room < 1 ||
      !exactInteger(order.col) || !exactInteger(order.row) ||
      !exactInteger(order.maxSteps) || order.maxSteps < 1 || order.maxSteps > 400))
    throw orderError(400,
      'move orders require a string agent and numeric integer room/col/row/max_steps (1-400)');
  uniqueAgents(normalized, 'move');

  const state = await reader.controlState(normalized.map(order => order.agent));
  if (state.health.pid !== brokerPid)
    throw orderError(409, 'broker restarted after this snapshot generation');
  for (const order of normalized) {
    const look = rawLook(state, order.agent);
    if (Number(look.room?.num) !== order.room)
      throw orderError(409, `${order.agent} is no longer in room ${order.room}`);
    const rows = Number(look.room?.size?.rows), cols = Number(look.room?.size?.cols);
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) ||
        order.row < 1 || order.row > rows || order.col < 1 || order.col > cols)
      throw orderError(409, `${order.agent}'s destination ${order.col},${order.row} is outside room ${order.room}`);
    if (sceneStore) {
      const scene = sceneStore.get(order.room);
      const flags = scene?.planes?.flags ? Buffer.from(scene.planes.flags, 'base64') : null;
      const index = (order.row - 1) * (scene?.cols ?? 0) + order.col - 1;
      if (!scene || scene.rows !== rows || scene.cols !== cols || !flags || !(flags[index] & 0x01))
        throw orderError(409, `destination ${order.col},${order.row} is not on the walkable room floor`);
    }
  }
  const dispatch = await settledDispatch(reader, 'move_intent', normalized, order => ({
    agent: order.agent, room: order.room, col: order.col, row: order.row,
    max_steps: order.maxSteps, control_token: issuedControlToken(reader, id, order.agent),
    server_host: reader.controlServer.host, server_port: reader.controlServer.port,
  }));
  return {
    schema: RTS_SCHEMA,
    ...dispatch,
    order_id: id,
    generation: body.generation,
    accepted_at: new Date(now).toISOString(),
  };
}

export async function dispatchContextOrder(reader, body, { now = Date.now(), sceneStore = null } = {}) {
  if (!reader.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
  batch(body, 'context', ['type', 'action', 'generation', 'order_id', 'orders']);
  const id = orderId(body);
  const { brokerPid } = generationInfo(body, now);
  const action = typeof body.action === 'string' ? body.action : '';
  if (!CONTEXT_ACTIONS.has(action))
    throw orderError(400, `context action must be one of: ${CONTEXT_ACTION_LIST.join(', ')}`);

  const groundAction = action === 'rest_here' || action === 'recover_here';
  const targetAction = action === 'take' || action === 'approach' || action === 'face';
  const itemAction = action === 'item_use' || action === 'item_unuse' || action === 'item_eat';
  const contextKeys = ['agent', 'room',
    ...(groundAction ? ['col', 'row'] : []),
    ...(targetAction || action === 'cast' ? ['target_id'] : []),
    ...(itemAction ? ['item_id'] : []),
    ...(action === 'cast' ? ['spell'] : []),
  ];
  for (const order of body.orders)
    assertExactKeys(order, contextKeys, `${action} context order`);

  const normalized = body.orders.map(order => ({
    agent: cleanAgent(order?.agent),
    room: order?.room,
    col: order?.col === undefined ? null : order.col,
    row: order?.row === undefined ? null : order.row,
    target: order?.target_id === undefined ? null : order.target_id,
    item: order?.item_id === undefined ? null : order.item_id,
    spell: typeof order?.spell === 'string' ? order.spell.trim() : '',
  }));
  if (normalized.some(order => !order.agent || !exactInteger(order.room) || order.room < 1))
    throw orderError(400, 'context orders require a string agent and numeric positive integer room');
  if (groundAction && normalized.some(order =>
      !exactInteger(order.col) || !exactInteger(order.row)))
    throw orderError(400, `${action} orders require numeric integer col/row`);
  if (targetAction && normalized.some(order =>
      !exactInteger(order.target) || order.target < 1))
    throw orderError(400, `${action} orders require a numeric positive integer target_id`);
  if (itemAction && normalized.some(order =>
      !exactInteger(order.item) || order.item < 1))
    throw orderError(400, `${action} orders require a numeric positive integer item_id`);
  if (action === 'cast' && normalized.some(order => !order.spell || order.spell.length > 120 ||
      /[\x00-\x1f\x7f]/.test(order.spell) ||
      (order.target !== null && (!exactInteger(order.target) || order.target < 1))))
    throw orderError(400, 'cast orders require an exact string spell and an optional numeric positive target_id');
  if (!groundAction && normalized.some(order => order.col !== null || order.row !== null))
    throw orderError(400, `${action} orders do not accept col/row`);
  if (!targetAction && action !== 'cast' && normalized.some(order => order.target !== null))
    throw orderError(400, `${action} orders do not accept target_id`);
  if (!itemAction && normalized.some(order => order.item !== null))
    throw orderError(400, `${action} orders do not accept item_id`);
  if (action !== 'cast' && normalized.some(order => order.spell))
    throw orderError(400, `${action} orders do not accept spell`);
  uniqueAgents(normalized, 'context');

  const state = await reader.controlState(normalized.map(order => order.agent));
  if (state.health.pid !== brokerPid)
    throw orderError(409, 'broker restarted after this snapshot generation');

  for (const order of normalized) {
    const look = rawLook(state, order.agent);
    if (Number(look.room?.num) !== order.room)
      throw orderError(409, `${order.agent} is no longer in room ${order.room}`);
    const objects = Array.isArray(look.objects) ? look.objects : [];

    if (action === 'rest_here' || action === 'recover_here') {
      const rows = Number(look.room?.size?.rows), cols = Number(look.room?.size?.cols);
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) ||
          order.row < 1 || order.row > rows || order.col < 1 || order.col > cols)
        throw orderError(409,
          `${order.agent}'s rest destination ${order.col},${order.row} is outside room ${order.room}`);
      if (sceneStore) {
        const scene = sceneStore.get(order.room);
        const flags = scene?.planes?.flags ? Buffer.from(scene.planes.flags, 'base64') : null;
        const index = (order.row - 1) * (scene?.cols ?? 0) + order.col - 1;
        if (!scene || scene.rows !== rows || scene.cols !== cols || !flags || !(flags[index] & 0x01))
          throw orderError(409,
            `${action} destination ${order.col},${order.row} is not on the walkable room floor`);
      }
    } else if (action === 'take') {
      const target = objects.find(entity => Number(entity?.id) === order.target);
      if (!target || !Array.isArray(target.can) || !target.can.includes('get'))
        throw orderError(409,
          `${order.agent} no longer perceives target ${order.target} as gettable`);
    } else if (action === 'approach' || action === 'face') {
      const target = objects.find(entity => Number(entity?.id) === order.target);
      if (!target || typeof target.col !== 'number' || !Number.isFinite(target.col) ||
          typeof target.row !== 'number' || !Number.isFinite(target.row))
        throw orderError(409,
          `${order.agent} no longer perceives positioned target ${order.target}`);
    } else if (itemAction) {
      const inventory = state.inventory?.[order.agent];
      if (!Array.isArray(inventory))
        throw orderError(409, `${order.agent} has no current cached inventory`);
      const item = inventory.find(value => Number(value?.id) === order.item);
      if (!item || typeof item.name !== 'string' || !item.name)
        throw orderError(409, `${order.agent} no longer carries inventory item ${order.item}`);
      const safe = Array.isArray(item.safe_actions) ? item.safe_actions : [];
      const required = action === 'item_use' ? 'use' : action === 'item_unuse' ? 'unuse' : 'eat';
      if (!safe.includes(required))
        throw orderError(409,
          `${item.name} is not currently classified for safe ${required} by ${order.agent}`);
      order.itemName = item.name;
    } else if (action === 'equip_best' || action === 'wear_best' || action === 'eat_best') {
      const inventory = state.inventory?.[order.agent];
      if (!Array.isArray(inventory))
        throw orderError(409, `${order.agent} has no current cached inventory`);
      const roles = action === 'equip_best' ? new Set(['weapon'])
        : action === 'wear_best' ? new Set(['armor', 'shield', 'helmet'])
        : new Set(['food']);
      if (!inventory.some(item => roles.has(item?.role)))
        throw orderError(409, `${order.agent} has no cached ${action.replace('_best', '')} candidate`);
    } else if (action === 'grab_nearby') {
      const youCol = typeof look.you?.col === 'number' ? look.you.col : NaN;
      const youRow = typeof look.you?.row === 'number' ? look.you.row : NaN;
      order.gettableCandidates = objects
        .filter(entity => Number.isSafeInteger(Number(entity?.id)) && Number(entity.id) > 0 &&
          Array.isArray(entity.can) && entity.can.includes('get'))
        .map(entity => {
          const col = typeof entity?.col === 'number' ? entity.col : NaN;
          const row = typeof entity?.row === 'number' ? entity.row : NaN;
          const positionsKnown = Number.isFinite(youCol) && Number.isFinite(youRow) &&
            Number.isFinite(col) && Number.isFinite(row);
          const manhattan = positionsKnown ? Math.abs(col - youCol) + Math.abs(row - youRow) : null;
          const observedDistance = typeof entity?.distance === 'number' ? entity.distance : NaN;
          return {
            id: Number(entity.id),
            distance: manhattan ?? (Number.isFinite(observedDistance) ? observedDistance : Infinity),
            inRange: manhattan === null || manhattan <= 7,
          };
        })
        .filter(candidate => candidate.inRange)
        .sort((left, right) => left.distance - right.distance || left.id - right.id);
    } else if (action === 'cast') {
      const spells = state.spells?.[order.agent];
      if (!Array.isArray(spells))
        throw orderError(409, `${order.agent} has no current cached spell list`);
      const wanted = order.spell.toLowerCase();
      const spell = spells.find(value => typeof value?.name === 'string' &&
        value.name.toLowerCase() === wanted);
      if (!spell)
        throw orderError(409, `${order.agent} does not currently know the exact spell "${order.spell}"`);
      const targets = Number(spell.targets);
      if (!Number.isSafeInteger(targets) || targets < 0)
        throw orderError(409, `${order.agent}'s cached target count for ${spell.name} is unavailable`);
      const rule = rtsSafeSpellRule(spell.name, targets);
      if (!rule)
        throw orderError(403, `${spell.name} is not classified as safe for RTS casting`);
      const target = order.target === null ? null
        : objects.find(entity => Number(entity?.id) === order.target) || null;
      const selfId = Number(look.you?.object_id);
      if (!rtsSpellTargetAllowed(rule, {
        targetId: order.target,
        selfId: Number.isSafeInteger(selfId) ? selfId : null,
        targetIsPlayer: target?.is_player ?? null,
      })) {
        if (rule.target_mode === 'none')
          throw orderError(409, `${spell.name} accepts no target`);
        if (rule.target_mode === 'self')
          throw orderError(403, `${spell.name} may target only ${order.agent}'s own controlled character`);
        if (!target)
          throw orderError(409, `${order.agent} no longer perceives spell target ${order.target}`);
        throw orderError(403, 'RTS context casting is PvE-only; player or unknown targets are refused');
      }
      // Send the server-observed spelling, never a free-form or partial client label.
      order.spell = spell.name;
    }
  }

  let dispatchRows = normalized;
  let skipped = [];
  if (action === 'grab_nearby') {
    // A group grab is an assignment, not five identical races. One observed item goes
    // to the nearest eligible actor; ties are stable by agent name. If that actor has
    // reached the twelve-item cap, the next nearest eligible actor gets it.
    const assignments = new Map(normalized.map(order => [order.agent, []]));
    const candidatesByItem = new Map();
    for (const order of normalized) {
      for (const candidate of order.gettableCandidates || []) {
        const key = `${order.room}:${candidate.id}`;
        if (!candidatesByItem.has(key)) candidatesByItem.set(key, []);
        candidatesByItem.get(key).push({ order, candidate });
      }
    }
    const items = [...candidatesByItem.entries()].sort(([left, leftChoices], [right, rightChoices]) => {
      const leftDistance = Math.min(...leftChoices.map(choice => choice.candidate.distance));
      const rightDistance = Math.min(...rightChoices.map(choice => choice.candidate.distance));
      const [leftRoom, leftId] = left.split(':').map(Number);
      const [rightRoom, rightId] = right.split(':').map(Number);
      return leftDistance - rightDistance || leftRoom - rightRoom || leftId - rightId;
    });
    for (const [, choices] of items) {
      choices.sort((left, right) => left.candidate.distance - right.candidate.distance ||
        left.order.agent.localeCompare(right.order.agent));
      const chosen = choices.find(choice => assignments.get(choice.order.agent).length < 12);
      if (chosen) assignments.get(chosen.order.agent).push(chosen.candidate.id);
    }
    for (const order of normalized) order.targetIds = assignments.get(order.agent);
    dispatchRows = normalized.filter(order => order.targetIds.length);
    skipped = normalized.filter(order => !order.targetIds.length)
      .map(order => ({ agent: order.agent, reason: 'no unassigned gettable objects within pickup range' }));
    if (!dispatchRows.length)
      throw orderError(409, 'no selected agent perceives an unassigned gettable object within pickup range');
  }

  const dispatch = await settledDispatch(reader, 'context_intent', dispatchRows, order => ({
    agent: order.agent,
    room: order.room,
    action,
    ...((action === 'rest_here' || action === 'recover_here') ?
      { col: order.col, row: order.row } : {}),
    ...((action === 'take' || action === 'approach' || action === 'face') ?
      { target: order.target } : {}),
    ...(action === 'grab_nearby' ? { targets: order.targetIds } : {}),
    ...(itemAction ? { item: order.item, expected_item_name: order.itemName } : {}),
    ...(action === 'cast' ? {
      spell: order.spell,
      ...(order.target === null ? {} : { target: order.target }),
    } : {}),
    control_token: issuedControlToken(reader, id, order.agent),
    server_host: reader.controlServer.host,
    server_port: reader.controlServer.port,
  }));
  return {
    schema: RTS_SCHEMA,
    ...dispatch,
    action,
    ...(skipped.length ? { skipped_count: skipped.length, skipped } : {}),
    order_id: id,
    generation: body.generation,
    accepted_at: new Date(now).toISOString(),
  };
}

export async function dispatchCancelOrder(reader, body, { now = Date.now() } = {}) {
  if (!reader.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
  batch(body, 'cancel', ['type', 'order_id', 'orders']);
  const id = orderId(body);
  for (const order of body.orders)
    assertExactKeys(order, ['agent', 'control_token'], 'cancel order');
  const normalized = body.orders.map(order => ({
    agent: cleanAgent(order?.agent),
    controlToken: typeof order?.control_token === 'string' ? order.control_token : '',
  }));
  if (normalized.some(order => !order.agent || !/^[A-Za-z0-9._:-]{8,160}$/.test(order.controlToken)))
    throw orderError(400, 'cancel orders require agent and the owned control_token');
  uniqueAgents(normalized, 'cancel');
  await reader.controlState(normalized.map(order => order.agent));
  const dispatch = await settledDispatch(reader, 'cancel_action', normalized, order => ({
    agent: order.agent, control_token: order.controlToken,
    server_host: reader.controlServer.host, server_port: reader.controlServer.port,
  }));
  return {
    schema: RTS_SCHEMA,
    ...dispatch,
    order_id: id,
    accepted_at: new Date(now).toISOString(),
  };
}

export function dispatchControlOrder(reader, body, options = {}) {
  if (body?.type === 'attack') return dispatchAttackOrder(reader, body, options);
  if (body?.type === 'move') return dispatchMoveOrder(reader, body, options);
  if (body?.type === 'context') return dispatchContextOrder(reader, body, options);
  if (body?.type === 'cancel') return dispatchCancelOrder(reader, body, options);
  throw orderError(400, 'order type must be attack, move, context, or cancel');
}

export class OrderDedupe {
  constructor({ maxEntries = 512, ttlMs = 60_000, now = Date.now } = {}) {
    this.maxEntries = Math.max(16, Math.min(4096, Number(maxEntries) || 512));
    this.ttlMs = Math.max(1000, Math.min(10 * 60_000, Number(ttlMs) || 60_000));
    this.now = now;
    this.entries = new Map();
  }

  execute(id, value, fn) {
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (at - entry.at > this.ttlMs) this.entries.delete(key);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw orderError(409, 'order_id was already used for a different payload');
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing.promise;
    }
    const promise = Promise.resolve().then(fn);
    this.entries.set(id, { at, fingerprint, promise });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value);
    return promise;
  }
}

function writeSse(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function nativeFrame(snapshot) {
  const payload = toNativeSnapshot(snapshot);
  return `M59FRAME\t1\t${Buffer.byteLength(payload)}\n${payload}`;
}

function nativeChannel(socket) {
  let blocked = false;
  let pending = null;
  const flush = () => {
    if (blocked || pending === null || socket.destroyed) return;
    const frame = pending;
    pending = null;
    blocked = !socket.write(frame);
  };
  socket.on('drain', () => {
    blocked = false;
    flush();
  });
  return {
    // A native subscriber never queues a history of complete worlds. At most one
    // newest frame waits behind the kernel buffer, which is the property the hub
    // requires before allowing a 50ms reconciliation cadence.
    latestGeneration: true,
    send(event, value) {
      if (event !== 'snapshot' || socket.destroyed) return;
      const frame = nativeFrame(value);
      // Rendering old world states is worse than dropping them. A slow client
      // gets the newest complete generation once its kernel buffer drains.
      if (blocked) pending = frame;
      else blocked = !socket.write(frame);
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
}

export class RealtimeHub {
  constructor({ reader, reconcileMs = 250 } = {}) {
    this.reader = reader;
    this.reconcileMs = Math.max(50, Number(reconcileMs) || 250);
    this.subscribers = new Set();
    this.loops = new Map();
    this.timer = null;
    this.nextReconcileAt = null;
    this.reconciling = false;
    this.reconcileAgain = false;
  }

  fastReconcileEligible() {
    return this.reader?.fastPathStatus?.mode === 'broker-aggregate-v1' &&
      this.subscribers.size > 0 &&
      [...this.subscribers].every(subscriber => subscriber.channel.latestGeneration === true);
  }

  effectiveReconcileMs() {
    // 50ms means as many as twenty five-character snapshots a second. Permit that
    // only for the one-fetch broker path and only when slow consumers retain one
    // newest generation instead of growing an output queue. An old broker, SSE, or
    // an unclassified channel keeps the former 100ms floor.
    return Math.max(this.fastReconcileEligible() ? 50 : 100, this.reconcileMs);
  }

  timing() {
    const fast = this.fastReconcileEligible();
    return {
      requested_ms: this.reconcileMs,
      effective_ms: this.effectiveReconcileMs(),
      minimum_ms: fast ? 50 : 100,
      fast_eligible: fast,
      broker_read_path: this.reader?.fastPathStatus?.mode || 'unknown',
      latest_generation_backpressure: this.subscribers.size > 0 &&
        [...this.subscribers].every(subscriber => subscriber.channel.latestGeneration === true),
    };
  }

  nextReconcileDeadline(deadline, now = performance.now()) {
    const interval = this.effectiveReconcileMs();
    const scheduled = deadline + interval;
    if (scheduled >= now) return scheduled;
    // A negotiated aggregate/native path may run again as soon as a slow read ends:
    // it is one bounded GET and the output retains only newest state. Legacy MCP and
    // ordinary output get a full interval after an overrun, preventing a slow old
    // broker from being driven continuously merely because 50ms was requested.
    return this.fastReconcileEligible() ? now : now + interval;
  }

  interested(agent) {
    for (const subscriber of this.subscribers) if (subscriber.agents.has(agent)) return true;
    return false;
  }

  publish(event, value, agent = null) {
    for (const subscriber of this.subscribers) {
      if (agent && !subscriber.agents.has(agent)) continue;
      subscriber.channel.send(event, value);
    }
  }

  ensureLoop(agent) {
    if (this.loops.has(agent)) return;
    const state = { agent, cursor: undefined, running: true };
    this.loops.set(agent, state);
    this.runLoop(state).finally(() => this.loops.delete(agent));
  }

  async runLoop(state) {
    while (state.running && this.interested(state.agent)) {
      try {
        const result = await this.reader.events(state.agent, state.cursor);
        state.cursor = result.cursor;
        // The first call establishes a cursor and may contain historical backlog. The
        // subscriber already received a newer full snapshot, so publishing those old
        // deltas would roll its view backwards. Subsequent calls are live.
        if (state.bootstrapped) {
          this.publish('events', {
            schema: RTS_SCHEMA,
            type: 'events',
            agent: state.agent,
            cursor: result.cursor,
            dropped: result.dropped || 0,
            events: result.events || [],
            observed_at: new Date().toISOString(),
          }, state.agent);
          if ((result.events || []).length || result.dropped) void this.reconcile('event');
        } else {
          state.bootstrapped = true;
          this.publish('cursor', {
            schema: RTS_SCHEMA,
            type: 'cursor',
            agent: state.agent,
            cursor: result.cursor,
          }, state.agent);
          if (!result.backlog && (result.events || []).length) {
            this.publish('events', {
              schema: RTS_SCHEMA,
              type: 'events',
              agent: state.agent,
              cursor: result.cursor,
              dropped: result.dropped || 0,
              events: result.events,
              observed_at: new Date().toISOString(),
            }, state.agent);
            void this.reconcile('event');
          }
        }
      } catch (error) {
        this.publish('gateway-error', {
          schema: RTS_SCHEMA,
          type: 'gateway-error',
          agent: state.agent,
          message: error.message,
          observed_at: new Date().toISOString(),
        }, state.agent);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  ensureTimer(deadline = performance.now() + this.effectiveReconcileMs()) {
    if (this.timer || !this.subscribers.size) return;
    this.nextReconcileAt = deadline;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.reconcile('timer');
      if (this.subscribers.size) {
        // Advance from the prior deadline, not from when Windows happened to wake the
        // timer. That compensates the platform's coarse timer ticks instead of adding
        // their overshoot to every frame. Overruns remain single-flight; the helper
        // below also gives legacy/ordinary paths a full cooling interval.
        const next = this.nextReconcileDeadline(deadline);
        this.ensureTimer(next);
      }
    }, Math.max(0, deadline - performance.now()));
    this.timer.unref?.();
  }

  rescheduleTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextReconcileAt = null;
    this.ensureTimer();
  }

  async reconcile(reason = 'timer') {
    if (!this.subscribers.size) return;
    if (this.reconciling) {
      if (reason === 'event') this.reconcileAgain = true;
      return;
    }
    const agents = [...new Set([...this.subscribers].flatMap(subscriber => [...subscriber.agents]))];
    if (!agents.length) return;
    this.reconciling = true;
    try {
      const snapshot = await this.reader.snapshot(agents);
      this.publish('snapshot', snapshot);
    } catch (error) {
      this.publish('gateway-error', {
        schema: RTS_SCHEMA,
        type: 'gateway-error',
        message: error.message,
        observed_at: new Date().toISOString(),
      });
    } finally {
      this.reconciling = false;
      if (this.reconcileAgain) {
        this.reconcileAgain = false;
        queueMicrotask(() => this.reconcile('event'));
      }
    }
  }

  subscribeChannel(channel, agents) {
    const subscriber = { channel, agents: new Set(agents) };
    this.subscribers.add(subscriber);
    for (const agent of agents) this.ensureLoop(agent);
    // Subscriber capabilities can change the safe floor (native-only 50ms versus
    // SSE/mixed 100ms), so do not leave a timer armed at the old population's rate.
    this.rescheduleTimer();
    return () => {
      this.subscribers.delete(subscriber);
      for (const state of this.loops.values()) {
        if (!this.interested(state.agent)) state.running = false;
      }
      this.rescheduleTimer();
    };
  }

  subscribe(res, agents) {
    return this.subscribeChannel({
      send: (event, value) => writeSse(res, event, value),
      close: () => res.end(),
    }, agents);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextReconcileAt = null;
    for (const state of this.loops.values()) state.running = false;
    for (const subscriber of this.subscribers) subscriber.channel.close();
    this.subscribers.clear();
  }
}

export function createGatewayServer({ reader, reconcileMs = 250, hub = null, sceneStore = null,
                                      orderDedupe = null }) {
  hub ||= new RealtimeHub({ reader, reconcileMs });
  orderDedupe ||= new OrderDedupe();
  const server = http.createServer(async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'RTS gateway is loopback-only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/v1/orders') {
      try {
        if (!reader.ordersEnabled) throw orderError(403, 'RTS gateway orders are disabled');
        if (req.headers.origin)
          throw orderError(403, 'browser-origin order requests are refused');
        const mediaType = String(req.headers['content-type'] || '')
          .split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/json')
          throw orderError(415, 'orders require application/json');
        if (!authorizedBearer(req, reader.controlToken))
          throw orderError(401, 'RTS control bearer token required');
        const body = await readJsonBody(req);
        const id = orderId(body);
        const result = await orderDedupe.execute(id, body,
          () => dispatchControlOrder(reader, body, { sceneStore }));
        return sendJson(res, 202, result);
      } catch (error) {
        return sendJson(res, error.status || 503, { error: error.message, schema: RTS_SCHEMA });
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'unsupported gateway method' });
    try {
      if (url.pathname === '/health') {
        let health = await reader.health();
        let controlError = null;
        if (reader.ordersEnabled) {
          try {
            const aggregate = await reader.controlState([...reader.allowedAgents]);
            health = aggregate.health;
          }
          catch (error) { controlError = error; }
        }
        return sendJson(res, controlError ? 503 : 200, {
          ok: !controlError,
          schema: RTS_SCHEMA,
          gateway_pid: process.pid,
          broker: { pid: health.pid, fleet: health.fleet, sessions: health.sessions?.length ?? null,
                    game_server: health.game_server ?? null },
          broker_read_path: reader.fastPathStatus,
          reconciliation: hub.timing(),
          writes: reader.controlStatus.armed,
          pvp: false,
          control: {
            configured: reader.ordersEnabled,
            enabled: reader.controlStatus.armed,
            fleet: reader.expectedFleet,
            game_server: reader.controlServer,
            bearer_required: reader.ordersEnabled,
            reason: reader.controlStatus.reason,
          },
        });
      }
      if (url.pathname === '/v1/contract') {
        if (reader.ordersEnabled) {
          try { await reader.controlState([...reader.allowedAgents]); }
          catch { /* reflected as writes:false below */ }
        }
        const writes = reader.controlStatus.armed;
        return sendJson(res, 200, {
          schema: RTS_SCHEMA,
          authority: 'meridian59-broker',
          transport: ['application/json', 'application/x-m59-rts-snapshot',
                      'm59-rts-native-stream/v1'],
          capabilities: ['fleet', 'rooms', 'entities', 'exits', 'perception-provenance',
                          'event-cursors', 'cached-position-reconciliation', 'roo-room-scenes',
                          'server-observed-equipment', 'broker-aggregate-cached-read',
                          'cached-inventory', 'per-agent-action-outcomes',
                          'adaptive-50ms-native-reconciliation',
                          ...(writes ? ['local-pve-attack', 'local-room-move',
                                        'local-context-stand', 'local-context-rest',
                                        'local-context-loot', 'local-context-cast',
                                        'local-context-positioning', 'local-context-recovery',
                                        'local-context-loadout', 'local-context-safe-items',
                                        'local-context-safety-on',
                                        'owned-action-cancel'] : [])],
          writes,
          pvp: false,
          action_catalogue: {
            typed_only: true,
            batches: ['attack', 'move', 'context', 'cancel'],
            context: CONTEXT_ACTION_LIST,
            confirmation_required: [],
            deliberately_absent: ['drop', 'safety_off', 'buy', 'sell', 'trade'],
          },
          rts_cast_policy: {
            fail_closed: true,
            exact_names: RTS_SAFE_SPELL_NAMES,
            target_spells: false,
          },
          control_server: reader.controlServer,
        });
      }
      if (url.pathname === '/v1/scene' || url.pathname === '/v1/scene.tsv') {
        if (!sceneStore) throw new Error('room scene store is not configured');
        const room = Number(url.searchParams.get('room'));
        const scene = sceneStore.get(room);
        if (!scene) return sendJson(res, 404, { error: `no ROO scene for room ${room}` });
        if (url.pathname.endsWith('.tsv')) {
          const native = toNativeRoomScene(scene);
          res.writeHead(200, {
            'content-type': 'application/x-m59-rts-room; version=1; charset=utf-8',
            'content-length': Buffer.byteLength(native),
            'cache-control': 'public, max-age=3600, immutable',
            'x-content-type-options': 'nosniff',
          });
          return res.end(native);
        }
        return sendJson(res, 200, scene);
      }
      if (url.pathname === '/v1/events') {
        const requested = [...url.searchParams.getAll('agent'),
          ...(url.searchParams.get('agents') || '').split(',')].filter(Boolean);
        const snapshot = await reader.snapshot(requested);
        const agents = snapshot.agents.map(agent => agent.agent);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        });
        writeSse(res, 'snapshot', snapshot);
        const unsubscribe = hub.subscribe(res, agents);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        heartbeat.unref?.();
        res.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      if (url.pathname === '/v1/snapshot' || url.pathname === '/v1/snapshot.tsv') {
        const agents = [...url.searchParams.getAll('agent'),
          ...(url.searchParams.get('agents') || '').split(',')].filter(Boolean);
        const snapshot = await reader.snapshot(agents);
        if (url.pathname.endsWith('.tsv')) {
          const native = toNativeSnapshot(snapshot);
          res.writeHead(200, {
            'content-type': `application/x-m59-rts-snapshot; version=${RTS_NATIVE_VERSION}; charset=utf-8`,
            'content-length': Buffer.byteLength(native),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return res.end(native);
        }
        return sendJson(res, 200, snapshot);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, 503, { error: error.message, schema: RTS_SCHEMA });
    }
  });
  server.on('close', () => hub.close());
  return server;
}

export function createNativeStreamServer({ reader, hub }) {
  if (!hub) throw new Error('native stream server requires a shared realtime hub');
  return net.createServer(socket => {
    const remote = socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setTimeout(3000);
    let request = '';
    const fail = message => {
      if (!socket.destroyed) socket.end(`M59ERROR\t1\t${encodeURIComponent(message)}\n`);
    };
    const onData = chunk => {
      request += chunk.toString('utf8');
      if (request.length > 4096) return fail('subscription request is too large');
      const newline = request.indexOf('\n');
      if (newline < 0) return;
      socket.removeListener('data', onData);
      const line = request.slice(0, newline).replace(/\r$/, '');
      const fields = line.split('\t');
      if (fields.length !== 3 || fields[0] !== 'M59SUB' || fields[1] !== '1') {
        return fail('expected M59SUB version 1 handshake');
      }
      const rawRequested = fields[2] ? fields[2].split(',') : [];
      const requested = rawRequested.map(cleanAgent);
      if (requested.some(agent => !agent)) return fail('agent names must be simple identifiers');
      if (requested.length > 40) return fail('native subscriptions are limited to 40 agents');
      reader.snapshot(requested).then(snapshot => {
        if (socket.destroyed) return;
        const agents = snapshot.agents.map(agent => agent.agent);
        if (!agents.length) return fail('subscription contains no broker fleet agents');
        socket.setTimeout(0);
        const channel = nativeChannel(socket);
        channel.send('snapshot', snapshot);
        const unsubscribe = hub.subscribeChannel(channel, agents);
        socket.once('close', unsubscribe);
        socket.once('error', unsubscribe);
      }).catch(error => fail(error.message));
    };
    socket.on('data', onData);
    socket.on('timeout', () => fail('subscription handshake timed out'));
    socket.on('error', () => {});
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const ordersEnabled = argv.includes('--enable-orders');
  const fleetIndex = argv.indexOf('--fleet');
  const explicitFleet = fleetIndex >= 0 ? String(argv[fleetIndex + 1] || '') : '';
  if (ordersEnabled && !explicitFleet)
    throw new Error('--enable-orders requires an explicit --fleet <non-production-name>');
  if (ordersEnabled && /^prod(?:uction)?$/i.test(explicitFleet))
    throw new Error('production fleets cannot be write-enabled through the RTS gateway');
  if (ordersEnabled && argv.includes('--allow-pvp'))
    throw new Error('RTS control is PvE-only; --allow-pvp is not supported');
  const controlServer = option(argv, '--control-server', '');
  if (ordersEnabled && !controlServer)
    throw new Error('--enable-orders requires --control-server <exact-loopback-host:port>');
  const requestedAgents = (option(argv, '--agents', '') || '').split(',').filter(Boolean);
  if (ordersEnabled && !requestedAgents.length)
    throw new Error('--enable-orders requires an explicit non-empty --agents control roster');
  const reader = new BrokerReader({
    brokerUrl: option(argv, '--broker', process.env.M59_BROKER_URL || 'http://127.0.0.1:8901'),
    expectedFleet: option(argv, '--fleet', process.env.M59_FLEET || 'prod'),
    ordersEnabled,
    controlServer,
    allowedAgents: requestedAgents,
    // Environment-only: a write credential must not be visible in process listings.
    controlToken: process.env.M59_RTS_CONTROL_TOKEN || '',
    fastPath: !argv.includes('--no-fast-read'),
    // Environment-only: a command-line token is visible to every process lister.
    readToken: process.env.M59_RTS_READ_TOKEN || '',
  });
  // Do not bind a port or advertise write capability until the updated broker has
  // proven that the entire active fleet is on the exact explicitly allowed test server.
  if (ordersEnabled) await reader.assertControlReady();
  if (argv.includes('--once')) {
    const snapshot = await reader.snapshot(requestedAgents);
    process.stdout.write(argv.includes('--native') ? toNativeSnapshot(snapshot) : JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }
  const port = Number(option(argv, '--port', process.env.M59_RTS_PORT || 8910));
  const nativePort = Number(option(argv, '--native-port', process.env.M59_RTS_NATIVE_PORT || port + 1));
  const reconcileMs = Number(option(argv, '--reconcile-ms', process.env.M59_RTS_RECONCILE_MS || 250));
  const hub = new RealtimeHub({ reader, reconcileMs });
  const mapPath = option(argv, '--map', fileURLToPath(new URL('../substrate/m59-map.json', import.meta.url)));
  const sceneStore = RoomSceneStore.fromFile(mapPath);
  const server = createGatewayServer({ reader, reconcileMs, hub, sceneStore });
  const nativeServer = createNativeStreamServer({ reader, hub });
  server.listen(port, '127.0.0.1', () => {
    console.error(`m59 RTS gateway on http://127.0.0.1:${port} — ${RTS_SCHEMA}, ` +
                  `${ordersEnabled ? `local PvE control for ${controlServer}` : 'read-only'}, ` +
                  `${hub.reconcileMs}ms requested reconciliation (50ms only for aggregate/latest-native)`);
  });
  nativeServer.listen(nativePort, '127.0.0.1', () => {
    console.error(`m59 RTS native stream on 127.0.0.1:${nativePort} — newest-generation backpressure`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`m59 RTS gateway failed: ${error.message}`);
    process.exitCode = 1;
  });
}
