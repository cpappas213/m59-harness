#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mergeTuiRow, fleetFreshness } from './m59-tui-state.mjs';

const row = {
  agent: 't15', activity: 'idle', deaths: 0, deaths_since_keeper_start: 0,
  deaths_24h: 2, deaths_in_safe_spot: 1, deaths_in_proven_safe_spot: 0,
  kills: 4, kills_30m: 3, snapshot_age_ms: 1700,
  policy: { hunt: null }, autopilot: { mode: 'farm', running: true },
  last_death: { at: 9, died_in: 'Upstairs' },
};
const keeper = {
  __port: 8938, as_of_ms: 300,
  goap: { running: true, mode: 'survive' },
  autopilot_status: {
    activity: 'holding safe spot', safe_spot: { works: true },
    did: { deaths: 1, mulligans: 2 }, policy: { hunt: 'stale hunt' },
  },
};
const merged = mergeTuiRow(row, keeper);
assert.equal(merged.ap.mode, 'survive');
assert.equal(merged.ap.activity, 'holding safe spot');
assert.equal(merged.ap.safe_spot.works, true);
assert.equal(merged.ap.did.deaths, 0);
assert.equal(merged.ap.did.deaths_24h, 2);
assert.equal(merged.ap.did.deaths_in_safe_spot, 1);
assert.equal(merged.ap.did.mulligans, 2);
assert.equal(merged.ap.did.kills_30m, 3);
assert.deepEqual(merged.ap.last_death, row.last_death);
assert.equal(merged.snapshot_age_ms, 1700);
assert.equal(merged.keeper_port, 8938);

const fresh = fleetFreshness([merged, { snapshot_age_ms: 12_000 }, {}]);
assert.equal(fresh.known, 2);
assert.equal(fresh.unknown, 1);
assert.equal(fresh.stale.length, 1);
assert.equal(fresh.max_age_ms, 12_000);

console.log('m59-tui-state-test: 14/14');
