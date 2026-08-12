#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-strategy-stats-'));
process.env.M59_STRATEGY_STATS_DIR = dir;

try {
  const stats = await import(`./m59-strategy-stats.mjs?test=${Date.now()}`);
  const settings = { enabled: true, retention_hours: 24, default_window_hours: 2,
    crate_check: true, travel: true, fighting: true, trading: true,
    vault_accumulation: true, create_food: true, farm_cleanup: true, farm_delivery: true };

  assert.equal(stats.detailSettings({ strategyStats: settings }, 'travel'), settings);
  assert.equal(stats.detailSettings({ strategyStats: settings }, 'unknown'), null);
  assert.equal(stats.detailSettings({}, 'travel'), null);

  stats.recordStrategyStat('Gonzo', 'travel', 'trip', {
    duration_ms: 12_000, damage: 4, safe_spot_stops: 1, legs: 2,
    maps: [{ room: 38, duration_ms: 8_000, damage: 4 }],
  }, settings);
  stats.recordStrategyStat('Gonzo', 'travel', 'trip', {
    duration_ms: 50_000, damage: 40, safe_spot_stops: 0, legs: 1,
    maps: [{ room: 38, duration_ms: 25_000, damage: 20 },
           { room: 39, duration_ms: 25_000, damage: 20 }],
  }, settings);
  stats.recordStrategyStat('Gonzo', 'fighting', 'session', {
    duration_ms: 10_000, safe_spot_ms: 7_500, damage: 2,
  }, settings);
  stats.recordStrategyStat('Gonzo', 'trading', 'session', {
    duration_ms: 4_000, earned: 90, spent: 10, banked: 50,
  }, settings);
  stats.recordStrategyStat('Gonzo', 'vault_accumulation', 'deposit', {
    deposited: [{ name: 'Inky Cap Mushroom', amount: 3 }],
  }, settings);
  stats.saveVaultSnapshot('Gonzo', { at: Date.now(), items: [{ name: 'Inky Cap Mushroom', amount: 12 }] });
  const cleanupPolicy = { farmCleanup: { enabled: true } };
  const cleanupSettings = stats.detailSettings(cleanupPolicy, 'farm_cleanup');
  assert.equal(cleanupSettings.retention_hours, 24);
  stats.recordStrategyStat('Gonzo', 'farm_cleanup', 'run', {
    dropped: [{ name: 'broken mace' }], picked: [{ name: 'inky cap mushroom', amount: 3 }],
    protected: [{ name: 'inky cap mushroom', amount: 3 }], value: 90,
  }, cleanupSettings);
  const deliveryPolicy = { farmDelivery: { enabled: true } };
  const deliverySettings = stats.detailSettings(deliveryPolicy, 'farm_delivery');
  stats.recordStrategyStat('Gonzo', 'farm_delivery', 'trip', {
    bought: { herb: 6, elderberry: 2 }, retained: { herb: 1, elderberry: 0 },
    delivered: [{ character: 'Kermit', delivered: { herb: 5, elderberry: 2 } }],
  }, deliverySettings);

  const report = stats.strategyStatsReport({ hours: 2 });
  assert.equal(report.travel.trips, 1);
  assert.equal(report.travel.duration_ms, 12_000);
  assert.equal(report.travel.damage, 4);
  assert.equal(report.travel.safe_spot_stops, 1);
  assert.equal(report.fighting.safe_spot_pct, 75);
  assert.equal(report.trading.earned, 90);
  assert.equal(report.vault.items_deposited, 3);
  assert.equal(report.vault.latest[0].items[0].amount, 12);
  assert.equal(report.farm_cleanup.protected_picked, 3);
  assert.equal(report.farm_delivery.herbs_delivered, 5);
  assert.equal(report.farm_delivery.herbs_retained, 1);

  const off = { ...settings, travel: false };
  assert.equal(stats.recordStrategyStat('Gonzo', 'travel', 'trip', {}, off), null);
  assert.equal(stats.strategyStatsReport({ hours: 2 }).travel.trips, 1);
  console.log('strategy stats: 18 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
