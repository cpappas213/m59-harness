#!/usr/bin/env node
// Offline timing probe for RealtimeHub's adaptive reconciliation. It opens no socket,
// broker, roster, or Meridian session; the reader is a bounded-latency fixture.

import { RealtimeHub } from './m59-rts-gateway.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

async function scenario({ name, mode, latestGeneration, frames, snapshotMs }) {
  let sequence = 0;
  let active = 0;
  let maxActive = 0;
  const never = new Promise(() => {});
  const reader = {
    fastPathStatus: { mode },
    events: () => never,
    snapshot: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (snapshotMs) await new Promise(resolve => setTimeout(resolve, snapshotMs));
      active--;
      return { schema: 'm59-rts/v1', sequence: String(++sequence), agents: [], rooms: [], errors: [] };
    },
  };
  const hub = new RealtimeHub({ reader, reconcileMs: 50 });
  const received = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const channel = {
    latestGeneration,
    send(event) {
      if (event !== 'snapshot') return;
      received.push(performance.now());
      if (received.length >= frames) finish();
    },
    close() {},
  };
  const unsubscribe = hub.subscribeChannel(channel, ['t1', 't2', 't3', 't4', 't5']);
  const timing = hub.timing();
  let timeout;
  try {
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} timed out`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    hub.close();
  }
  const intervals = received.slice(1).map((at, index) => at - received[index]);
  return {
    requested_ms: timing.requested_ms,
    effective_ms: timing.effective_ms,
    broker_read_path: mode,
    latest_generation_backpressure: latestGeneration,
    frames: received.length,
    interval_ms: {
      min: Number(Math.min(...intervals).toFixed(2)),
      mean: Number((intervals.reduce((sum, value) => sum + value, 0) / intervals.length).toFixed(2)),
      p50: Number(percentile(intervals, 0.50).toFixed(2)),
      p95: Number(percentile(intervals, 0.95).toFixed(2)),
      max: Number(Math.max(...intervals).toFixed(2)),
    },
    max_snapshot_reads_in_flight: maxActive,
  };
}

const frames = Math.max(10, Math.min(100, Number(option('--frames', '30')) || 30));
const snapshotMs = Math.max(0, Math.min(100, Number(option('--snapshot-ms', '2')) || 0));
const aggregateLatest = await scenario({
  name: 'aggregate-latest-native', mode: 'broker-aggregate-v1', latestGeneration: true,
  frames, snapshotMs,
});
const aggregateOrdinary = await scenario({
  name: 'aggregate-ordinary-output', mode: 'broker-aggregate-v1', latestGeneration: false,
  frames, snapshotMs,
});
const legacyLatest = await scenario({
  name: 'legacy-latest-native', mode: 'legacy-fallback', latestGeneration: true,
  frames, snapshotMs,
});
const legacySlowOverrun = await scenario({
  name: 'legacy-slow-overrun', mode: 'legacy-fallback', latestGeneration: true,
  frames: Math.min(frames, 12), snapshotMs: 120,
});

console.log(JSON.stringify({
  mode: 'offline-realtime-hub-fixture',
  note: 'timer/single-flight benchmark only; no broker or Meridian session is opened',
  agents: 5,
  synthetic_snapshot_ms: snapshotMs,
  aggregate_latest_native: aggregateLatest,
  aggregate_ordinary_output: aggregateOrdinary,
  legacy_latest_native: legacyLatest,
  legacy_slow_overrun: legacySlowOverrun,
}, null, 2));
