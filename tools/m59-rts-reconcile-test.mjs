#!/usr/bin/env node
import assert from 'node:assert/strict';
import { RealtimeHub } from './m59-rts-gateway.mjs';

const never = new Promise(() => {});
const reader = mode => ({
  fastPathStatus: { mode },
  events: () => never,
  snapshot: async () => ({ schema: 'm59-rts/v1', agents: [], rooms: [], errors: [] }),
});
const latest = () => ({ latestGeneration: true, send() {}, close() {} });
const ordinary = () => ({ send() {}, close() {} });

function subscribed(mode, reconcileMs, channel = latest()) {
  const hub = new RealtimeHub({ reader: reader(mode), reconcileMs });
  const unsubscribe = hub.subscribeChannel(channel, ['t1']);
  return { hub, unsubscribe };
}

{
  const { hub, unsubscribe } = subscribed('broker-aggregate-v1', 50);
  assert.equal(hub.reconcileMs, 50);
  assert.equal(hub.effectiveReconcileMs(), 50);
  assert.equal(hub.timing().fast_eligible, true);
  assert.equal(hub.nextReconcileDeadline(1000, 1040), 1050,
    'ordinary timer jitter advances from the prior deadline');
  assert.equal(hub.nextReconcileDeadline(1000, 1200), 1200,
    'an overrun on the bounded fast path may continue immediately, but never overlaps');
  unsubscribe(); hub.close();
}
{
  const { hub, unsubscribe } = subscribed('legacy-fallback', 50);
  assert.equal(hub.effectiveReconcileMs(), 100,
    'an old broker retains the former reconciliation floor');
  assert.equal(hub.timing().fast_eligible, false);
  assert.equal(hub.nextReconcileDeadline(1000, 1200), 1300,
    'an overrun on an old broker receives a full cooling interval');
  unsubscribe(); hub.close();
}
{
  const { hub, unsubscribe } = subscribed('broker-aggregate-v1', 50, ordinary());
  assert.equal(hub.effectiveReconcileMs(), 100,
    'an output channel without latest-generation backpressure retains the safe floor');
  unsubscribe(); hub.close();
}
{
  const { hub, unsubscribe } = subscribed('broker-aggregate-v1', 20);
  assert.equal(hub.reconcileMs, 50, 'requests below 50ms are clamped');
  assert.equal(hub.effectiveReconcileMs(), 50);
  unsubscribe(); hub.close();
}
{
  const { hub, unsubscribe } = subscribed('broker-aggregate-v1', 250);
  assert.equal(hub.effectiveReconcileMs(), 250, 'the default cadence remains unchanged');
  unsubscribe(); hub.close();
}
{
  const state = subscribed('broker-aggregate-v1', 50);
  const second = state.hub.subscribeChannel(ordinary(), ['t1']);
  assert.equal(state.hub.effectiveReconcileMs(), 100, 'one SSE-like subscriber raises the shared floor');
  second();
  assert.equal(state.hub.effectiveReconcileMs(), 50, 'removing it restores native fast eligibility');
  state.unsubscribe(); state.hub.close();
}

// Reconciliation is a single-flight latest-state operation. Timer ticks are dropped
// while busy; any number of event requests collapse to exactly one follow-up.
let calls = 0;
let active = 0;
let maxActive = 0;
const releases = [];
const controlledReader = {
  fastPathStatus: { mode: 'broker-aggregate-v1' },
  events: () => never,
  snapshot: () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise(resolve => releases.push(() => {
      active--;
      resolve({ schema: 'm59-rts/v1', agents: [], rooms: [], errors: [] });
    }));
  },
};
const controlled = new RealtimeHub({ reader: controlledReader, reconcileMs: 1000 });
const unsubscribe = controlled.subscribeChannel(latest(), ['t1']);
const first = controlled.reconcile('manual');
await Promise.resolve();
await controlled.reconcile('timer');
void controlled.reconcile('event');
void controlled.reconcile('event');
assert.equal(calls, 1);
releases.shift()();
await first;
for (let i = 0; i < 20 && calls < 2; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 2, 'event pressure produces one coalesced follow-up generation');
assert.equal(maxActive, 1, 'snapshot reads never overlap');
releases.shift()();
for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 2, 'no reconciliation queue accumulated');
unsubscribe(); controlled.close();

console.log('m59 RTS adaptive reconciliation: 18 assertions passed');
