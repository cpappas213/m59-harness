// Pure authority primitives shared by the broker's RTS commander and commerce
// surfaces.  This module opens no socket, reads no roster, and starts no process;
// keeping the capability stores here makes expiry/replay behavior testable offline.

import { randomBytes } from 'node:crypto';

export const COMMANDER_SCHEMA = 'm59-rts-commander/v1';
export const COMMERCE_SCHEMA = 'm59-rts-commerce/v1';
export const COMMANDER_FACULTIES = Object.freeze(['work', 'movement', 'economy', 'social']);
export const COMMANDER_DEFAULT_TTL_MS = 20_000;
export const COMMANDER_MAX_TTL_MS = 30_000;
export const COMMANDER_MIN_TTL_MS = 5_000;
export const COMMERCE_DEFAULT_TTL_MS = 15_000;
export const COMMERCE_MAX_TTL_MS = 30_000;

export function fleetIdentity(value) {
  const fleet = typeof value === 'string' ? value.trim() : '';
  return fleet && fleet !== '-' ? fleet : 'default';
}

export function commanderSettings(env = process.env, fleetValue = null) {
  const fleet = fleetIdentity(fleetValue);
  return {
    schema: COMMANDER_SCHEMA,
    enabled: true,
    fleet,
    authority: 'authenticated-enabled-loopback-gateway',
  };
}

// Meridian names the same room in two deliberately different namespaces:
//
//   * roomNum is the save-stable RID used by the map, fleet snapshot, and RTS UI;
//   * roomObjectId is the live object id carried by BP_PLAYER/BP_ROOM_CONTENTS and
//     required in movement packets.  It may be renumbered by a server save.
//
// Never compare those values to each other.  Instead, compare each one to the
// authority captured for its own namespace.  Capturing the live object id at
// request entry also closes the narrow window where a character changes rooms
// after an intent was accepted but before its paced packet reaches the wire.
export function exactRtsRoomBinding({ expectedRoomNum, actualRoomNum,
                                      roomObjectId, expectedRoomObjectId = null,
                                      packet = 'control' } = {}) {
  const expected = Number(expectedRoomNum);
  const actual = Number(actualRoomNum);
  const objectId = Number(roomObjectId);
  const prefix = `RTS ${packet} authority lost`;
  if (!Number.isSafeInteger(expected) || expected < 1)
    throw new Error(`${prefix}: expected room number is not an exact positive integer`);
  if (!Number.isSafeInteger(actual) || actual < 1)
    throw new Error(`${prefix}: stable room number is unavailable`);
  if (actual !== expected)
    throw new Error(`${prefix}: session is in room ${actual}, not ${expected}`);
  if (!Number.isSafeInteger(objectId) || objectId < 1)
    throw new Error(`${prefix}: live room object id is unavailable`);
  if (expectedRoomObjectId != null) {
    const captured = Number(expectedRoomObjectId);
    if (!Number.isSafeInteger(captured) || captured < 1)
      throw new Error(`${prefix}: captured room object id is invalid`);
    if (objectId !== captured)
      throw new Error(`${prefix}: live room object changed from ${captured} to ${objectId}`);
  }
  return { room_num: actual, room_object_id: objectId };
}

const opaque = prefix => `${prefix}_${randomBytes(24).toString('base64url')}`;

function boundedTtl(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export class CommanderLeaseStore {
  constructor({ now = () => Date.now(), tokenFactory = () => opaque('m59l'),
                idFactory = () => opaque('lease').slice(0, 22), max = 64 } = {}) {
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.idFactory = idFactory;
    this.max = max;
    this.records = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [token, record] of this.records) {
      if ((record.releasedAt ?? record.expiresAt) + COMMANDER_MAX_TTL_MS < now)
        this.records.delete(token);
    }
    while (this.records.size > this.max)
      this.records.delete(this.records.keys().next().value);
  }

  activeForAgent(agent) {
    this.cleanup();
    const now = this.now();
    for (const record of this.records.values())
      if (!record.releasedAt && record.expiresAt > now && record.agents.some(row => row.agent === agent))
        return record;
    return null;
  }

  issue(claims, ttlMs = COMMANDER_DEFAULT_TTL_MS) {
    this.cleanup();
    const now = this.now();
    const ttl = boundedTtl(ttlMs, COMMANDER_DEFAULT_TTL_MS,
      COMMANDER_MIN_TTL_MS, COMMANDER_MAX_TTL_MS);
    for (const row of claims.agents || []) {
      const held = this.activeForAgent(row.agent);
      if (held) throw new Error(`${row.agent} is already held by commander lease ${held.leaseId}`);
    }
    let token;
    do { token = this.tokenFactory(); } while (this.records.has(token));
    const record = {
      ...claims,
      token,
      leaseId: this.idFactory(),
      faculties: [...COMMANDER_FACULTIES],
      createdAt: now,
      expiresAt: now + ttl,
      releasedAt: null,
    };
    this.records.set(token, record);
    this.cleanup();
    return record;
  }

  require(token, { allowExpired = false } = {}) {
    const record = typeof token === 'string' ? this.records.get(token) : null;
    if (!record) throw new Error('unknown commander lease token');
    if (record.releasedAt) throw new Error('commander lease was released');
    if (!allowExpired && record.expiresAt <= this.now()) throw new Error('commander lease expired');
    return record;
  }

  renew(token, ttlMs = COMMANDER_DEFAULT_TTL_MS) {
    const record = this.require(token);
    const ttl = boundedTtl(ttlMs, COMMANDER_DEFAULT_TTL_MS,
      COMMANDER_MIN_TTL_MS, COMMANDER_MAX_TTL_MS);
    record.expiresAt = this.now() + ttl;
    record.renewedAt = this.now();
    return record;
  }

  release(token) {
    const record = this.require(token, { allowExpired: true });
    record.releasedAt = this.now();
    return record;
  }
}

export class CommerceQuoteStore {
  constructor({ now = () => Date.now(), tokenFactory = () => opaque('m59q'),
                idFactory = () => opaque('quote').slice(0, 22),
                ttlMs = COMMERCE_DEFAULT_TTL_MS, max = 256 } = {}) {
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.idFactory = idFactory;
    this.ttlMs = boundedTtl(ttlMs, COMMERCE_DEFAULT_TTL_MS, 3_000, COMMERCE_MAX_TTL_MS);
    this.max = max;
    this.records = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [token, record] of this.records) {
      const terminal = record.usedAt ?? record.cancelledAt ?? record.expiresAt;
      if (terminal + COMMERCE_MAX_TTL_MS < now) this.records.delete(token);
    }
    while (this.records.size > this.max)
      this.records.delete(this.records.keys().next().value);
  }

  issue(claims) {
    this.cleanup();
    const now = this.now();
    let token;
    do { token = this.tokenFactory(); } while (this.records.has(token));
    const record = {
      token,
      quoteId: this.idFactory(),
      claims: structuredClone(claims),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      usedAt: null,
      cancelledAt: null,
    };
    this.records.set(token, record);
    this.cleanup();
    return record;
  }

  require(token) {
    const record = typeof token === 'string' ? this.records.get(token) : null;
    if (!record) throw new Error('unknown commerce quote token');
    if (record.usedAt) throw new Error('commerce quote token was already used');
    if (record.cancelledAt) throw new Error('commerce quote token was cancelled');
    if (record.expiresAt <= this.now()) throw new Error('commerce quote token expired');
    return record;
  }

  consume(token, validate = null) {
    const record = this.require(token);
    if (typeof validate === 'function') validate(record.claims, record);
    // JavaScript executes this validation and mark in one turn.  No await is allowed
    // between them, so two concurrent commits cannot both consume the capability.
    record.usedAt = this.now();
    return record;
  }

  cancel(token, validate = null) {
    const record = this.require(token);
    if (typeof validate === 'function') validate(record.claims, record);
    record.cancelledAt = this.now();
    return record;
  }
}

export function canonicalCommerceItems(items) {
  if (!Array.isArray(items)) throw new Error('commerce items must be an array');
  const seen = new Set();
  return items.map(value => {
    const id = Number(value?.id);
    const name = typeof value?.name === 'string' ? value.name.trim() : '';
    const quantity = Number(value?.quantity ?? value?.amount ?? 1);
    if (!Number.isSafeInteger(id) || id <= 0 || !name ||
        !Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error('every commerce item needs an exact positive id, name, and quantity');
    if (seen.has(id)) throw new Error(`duplicate commerce item id ${id}`);
    seen.add(id);
    return { id, name, quantity };
  }).sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
}

// Runtime inventory ids do not survive an offer: Meridian clones each accepted
// item into a temporary trade-table object with a new id.  A quote therefore has
// to retain BOTH identities.  Same-name source stacks are rejected because the
// server echo contains no stable field capable of proving which clone came from
// which held id; silently guessing would discard the exact provenance boundary.
export function canonicalCommerceProvenance(items) {
  const rows = canonicalCommerceItems(items);
  const names = new Set();
  for (const row of rows) {
    if (names.has(row.name))
      throw new Error(`same-name commerce stacks are ambiguous across transient trade ids: ${row.name}`);
    names.add(row.name);
  }
  return rows;
}

export function bindCommerceOfferEcho(inventoryItems, tradeItems) {
  const inventory = canonicalCommerceProvenance(inventoryItems);
  const table = canonicalCommerceProvenance(tradeItems);
  if (inventory.length !== table.length)
    throw new Error('server trade echo changed the exact offered item count');
  const tableByName = new Map(table.map(row => [row.name, row]));
  return inventory.map(source => {
    const observed = tableByName.get(source.name);
    if (!observed || observed.quantity !== source.quantity)
      throw new Error(`server trade echo changed offered ${source.name} quantity or identity`);
    return {
      inventory_id: source.id,
      table_id: observed.id,
      name: source.name,
      quantity: source.quantity,
    };
  });
}

// Recover the exact held objects behind an observed trade-table side.  The
// binding is internal broker state created only after the server echoes an
// offer; callers never get to supply it.  Acceptance is refused if either the
// observed clone ids or their names/quantities have drifted since that echo.
export function resolveCommerceInventoryOrigins(tradeItems, bindings) {
  const table = canonicalCommerceItems(tradeItems);
  if (!table.length) return [];
  if (!Array.isArray(bindings))
    throw new Error('open trade has no exact inventory provenance');
  const boundTable = bindings.map(value => ({
    id: Number(value?.table_id),
    name: typeof value?.name === 'string' ? value.name.trim() : '',
    quantity: Number(value?.quantity),
  }));
  if (!commerceItemsEqual(boundTable, table))
    throw new Error('open trade no longer matches its exact inventory provenance');
  return canonicalCommerceProvenance(bindings.map(value => ({
    id: Number(value?.inventory_id),
    name: typeof value?.name === 'string' ? value.name.trim() : '',
    quantity: Number(value?.quantity),
  })));
}

export function commerceItemsEqual(left, right) {
  try {
    return JSON.stringify(canonicalCommerceItems(left)) === JSON.stringify(canonicalCommerceItems(right));
  } catch { return false; }
}

export function tradeFingerprint(trade) {
  if (!trade) return null;
  return JSON.stringify({
    revision: Number(trade.revision),
    role: trade.role || null,
    counterparty: trade.counterparty ? {
      id: Number(trade.counterparty.id), name: String(trade.counterparty.name || ''),
    } : null,
    ours: canonicalCommerceItems(trade.ours || []),
    theirs: canonicalCommerceItems(trade.theirs || []),
    may_accept: trade.may_accept === true,
  });
}

export function redactControlArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const key of ['command_auth', 'lease_token', 'quote_token', 'control_token'])
    if (key in out) out[key] = '[redacted]';
  return out;
}

export function leaseTiming(record, now = Date.now()) {
  return {
    lease_id: record.leaseId,
    expires_at_ms: record.expiresAt,
    expires_in_ms: Math.max(0, record.expiresAt - now),
    heartbeat_after_ms: Math.max(1_000, Math.floor(Math.max(0, record.expiresAt - now) / 3)),
  };
}

export function quoteTiming(record, now = Date.now()) {
  return {
    quote_id: record.quoteId,
    quote_token: record.token,
    created_at_ms: record.createdAt,
    expires_at_ms: record.expiresAt,
    expires_in_ms: Math.max(0, record.expiresAt - now),
  };
}
