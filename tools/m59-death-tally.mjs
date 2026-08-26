// Durable recent-death counts from the keeper post-mortems.
//
// A keeper's in-memory `tally.deaths` is useful for diagnosing one process lifetime,
// but it is not a fleet-board count: a rolling keeper restart resets it to zero.  The
// post-mortem is written at the death boundary, before escape/rejoin can erase the
// evidence, and one file represents one observed death.  This module keeps the small
// filesystem/read/shape rule outside the broker so it can be tested without starting a
// live fleet.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEATH_WINDOW_MS = 24 * 60 * 60 * 1000;

export function countRecentDeaths(records = [], {
  now = Date.now(), sinceMs = DEATH_WINDOW_MS,
} = {}) {
  const cutoff = now - sinceMs;
  const by = new Map();
  for (const record of records) {
    const at = Number(record?.at);
    const character = String(record?.character || '').trim();
    if (!character || !Number.isFinite(at) || at < cutoff || at > now + 60_000) continue;
    const row = by.get(character) ?? {
      count: 0, in_safe_spot: 0, in_proven_safe_spot: 0, last: null,
    };
    row.count++;
    if (record?.was?.in_safe_spot) {
      row.in_safe_spot++;
      if (record.was.in_safe_spot?.proven === true) row.in_proven_safe_spot++;
    }
    if (!row.last || at > row.last.at) {
      row.last = {
        at,
        reason: record.reason ?? 'died',
        died_in: record.where?.room ?? null,
        room_num: record.where?.num ?? null,
        col: record.where?.col ?? null,
        row: record.where?.row ?? null,
        level: record.vitals?.level ?? null,
        last_health: record.vitals?.last_health ?? null,
        last_vigor: record.vitals?.last_vigor ?? null,
        hunting: record.was?.hunting ?? null,
        strategy: record.was?.strategy ?? null,
        in_safe_spot: record.was?.in_safe_spot ?? false,
      };
    }
    by.set(character, row);
  }
  return by;
}

export function readRecentDeaths(dir, options = {}) {
  if (!dir || !existsSync(dir)) return new Map();
  const records = [];
  for (const file of readdirSync(dir)) {
    if (!/\.json$/i.test(file)) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      records.push(record);
    } catch { /* a partial/corrupt post-mortem is not a death we can prove */ }
  }
  return countRecentDeaths(records, options);
}

const cache = new Map();
export function recentDeathsIn(dir, {
  now = Date.now(), sinceMs = DEATH_WINDOW_MS, maxAgeMs = 5000,
} = {}) {
  const key = `${dir}\0${sinceMs}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAgeMs) return hit.by;
  const by = readRecentDeaths(dir, { now, sinceMs });
  cache.set(key, { at: now, by });
  return by;
}
