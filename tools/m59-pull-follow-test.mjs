#!/usr/bin/env node
// Legacy keeper pull rotation. Offline: no broker/server/fleet mutations.

import './m59-test-ledger.mjs';
import assert from 'node:assert/strict';
import {
  Autopilot, claimExclusiveSpot, crowdedSquares, releaseSpot,
  spotClaimedByAnotherExclusive,
} from './m59-autopilot.mjs';
import { beginPullProgress } from './m59-pull-progress.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function keeper() {
  const target = { id: 10, col: 15, row: 5, nameRsc: 10 };
  const objects = new Map([[10, target], [11, { id: 11, col: 20, row: 5, nameRsc: 11 }]]);
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    policy: {}, pullTargetCooldowns: new Map(), pullsWithoutContact: 0,
    foeId: 10, hold: { room: 544, col: 5, row: 5, quarry_id: 10 },
    noWallRooms: new Map(), notes: [], progressLog: [],
    s: {
      name: 'pull-follow-test',
      client: { room: { objects }, rsc: { get: id => id === 10 ? 'rat A' : 'rat B' } },
      world: { room: { num: 544, name: 'Valley of Ileria' } },
    },
    note(what, detail) { this.notes.push({ what, ...detail }); },
    progress(what) { this.progressLog.push(what); },
    noProgress(what) { this.progressLog.push('! ' + what); },
    releaseHold() { this.hold = null; this.pendingPull = null; },
    async takeSafeSpot(_why, quarry) {
      this.takenFor = quarry.id;
      this.hold = { room: 544, col: quarry.id, row: 6, quarry_id: quarry.id };
      return { took: true, spot: this.hold };
    },
  });
  const now = 1_000;
  k.pendingPull = {
    at: now, waitUntil: now + 60_000, target: 'rat A', target_id: 10, steps: 10,
    ...beginPullProgress(target, { room: 544, col: 5, row: 5 }, { now }),
  };
  return k;
}

await test('pending pull samples the exact id and detects three non-closing positions', () => {
  const k = keeper();
  for (const now of [4_000, 7_000]) {
    const waiting = k.pendingPullWait(now);
    assert.equal(waiting.stalled, false);
  }
  const stalled = k.pendingPullWait(10_000);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.target_position.col, 15);
  assert.equal(stalled.non_closing_samples, 3);
});

await test('a closer live position resets the non-closing count', () => {
  const k = keeper();
  k.pendingPullWait(4_000);
  k.s.client.room.objects.get(10).col = 13;
  const closer = k.pendingPullWait(7_000);
  assert.equal(closer.closer, true);
  assert.equal(closer.non_closing_samples, 0);
  k.s.client.room.objects.get(10).col = 12;
  assert.equal(k.pendingPullWait(10_000).stalled, false);
});

await test('stalled quarry rotates target and wall without condemning the old wall', async () => {
  const k = keeper();
  const waiting = { ...k.pendingPull, stalled: true, non_closing_samples: 3 };
  const result = await k.switchFromStalledPull(
    waiting,
    [...k.s.client.room.objects.values()],
    'three sampled checks made no progress',
  );
  assert.equal(result.switched, true);
  assert.equal(k.takenFor, 11);
  assert.equal(k.hold.quarry_id, 11);
  assert.ok(k.pullTargetCooling(544, 10), 'old target was not cooled');
  assert.equal(k.noWallRooms.size, 0, 'stalled target condemned the room');
});

await test('contact from another id cannot close the pulled target experiment', () => {
  const k = keeper();
  assert.equal(k.pullConverted(11, 'rat B'), false);
  assert.equal(k.pendingPull.target_id, 10);
  assert.equal(k.pullConverted(10, 'rat A'), true);
  assert.equal(k.pendingPull, null);
});

await test('legacy pull occupancy still recognizes a morphed player id', () => {
  const objects = new Map([[50, { id: 50, col: 19, row: 74, flags: 0 }]]);
  const playersOnline = new Map([[50, { id: 50, name: 'morphed player' }]]);
  const blocked = crowdedSquares(objects, 99, { radius: 0, playersOnline });
  assert.equal(blocked.has('19,74'), true);
});

await test('legacy quarry walls are reserved exclusively before arrival', () => {
  const a = 'pull-follow-claim-a', b = 'pull-follow-claim-b';
  releaseSpot(a); releaseSpot(b);
  assert.equal(claimExclusiveSpot(a, 544, 19, 74), true);
  assert.equal(spotClaimedByAnotherExclusive(b, 544, 19, 74), a);
  assert.equal(claimExclusiveSpot(b, 544, 19, 74), false);
  assert.equal(claimExclusiveSpot(b, 544, 20, 74), true);
  releaseSpot(a); releaseSpot(b);
});

await test('farm caller converts the id actually fought, never the stale claimed id', () => {
  // pullConverted() already proves that a bystander cannot close rat A's experiment.
  // This pins the other half of that contract at the call site: fight() is allowed to
  // select a different urgent target than the keeper's pre-fight claim, so passFarm must
  // report fight()'s returned identity and only after confirmed contact.
  const caller = Autopilot.prototype.passFarm.toString();
  assert.match(caller,
    /if \(\(f\.landed_hits \?\? 0\) > 0 \|\| f\.killed\)\s*this\.pullConverted\(f\.target_id \?\? f\.foe_id, f\.target \?\? engageName\)/);
  assert.doesNotMatch(caller, /pullConverted\(claimedSwing/);
  assert.match(caller,
    /const quarryId = f\.nearest\?\.id \?\? claimedSwing;\s*const quarry = quarryId != null \? c\.room\.objects\.get\(quarryId\) \?\? null : null/);
});

console.log(`\n${passed} pull-follow tests passed`);
