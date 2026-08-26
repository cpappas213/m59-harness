#!/usr/bin/env node
// Cross-process safe-wall reservations. Offline: every file is under a fresh temp
// directory, and no broker, roster, keeper, or game socket is opened.

import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const workerAt = process.argv.indexOf('--worker');

if (workerAt >= 0) {
  const agent = process.argv[workerAt + 1];
  const api = await import('./m59-autopilot.mjs');
  process.on('message', message => {
    const { id, command, args = {} } = message;
    try {
      let value;
      if (command === 'partner')
        value = api.rememberSpotClaimPartner(agent, args.partner ?? null);
      else if (command === 'claim')
        value = api.claimSpot(agent, args.room, args.col, args.row,
          { cap: args.cap, partner: args.partner });
      else if (command === 'release') value = api.releaseSpot(agent);
      else if (command === 'taken')
        value = api.spotTakenByAnother(agent, args.room, args.col, args.row, args.cap);
      else if (command === 'occupancy')
        value = api.spotOccupancy(agent, args.room, args.col, args.row);
      else if (command === 'held') value = api.spotHeldBy(agent);
      else if (command === 'list') value = api.claimedSpotList();
      else throw new Error(`unknown worker command: ${command}`);
      process.send({ id, ok: true, value });
    } catch (e) {
      process.send({ id, ok: false, error: e.message });
    }
  });
  process.send({ ready: true, agent });
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'm59-spotclaims-'));
  const workers = [];
  let requests = 0, passed = 0;

  function ok(message) { passed++; console.log('  ok   ' + message); }

  function start(agent, namespace = 'fleet-a') {
    const child = fork(SELF, ['--worker', agent], {
      cwd: join(HERE, '..'),
      env: {
        ...process.env,
        M59_SPOT_CLAIMS_DIR: scratch,
        M59_SPOT_CLAIMS_NAMESPACE: namespace,
        M59_LEDGER_DIR: join(scratch, `ledger-${agent}-${namespace}`),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => {
        if (message?.ready) { resolve(); return; }
        const request = pending.get(message?.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.ok) request.resolve(message.value);
        else request.reject(new Error(message.error));
      });
      child.once('error', reject);
      child.once('exit', code => {
        for (const request of pending.values())
          request.reject(new Error(`${agent} exited with ${code}`));
        pending.clear();
      });
    });
    const worker = {
      agent, child, ready,
      async ask(command, args = {}) {
        await ready;
        const id = ++requests;
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.send({ id, command, args });
        });
      },
      async stop() {
        if (child.exitCode != null || child.signalCode != null) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      },
    };
    workers.push(worker);
    return worker;
  }

  try {
    const a = start('alpha'), b = start('bravo'), c = start('charlie');
    await Promise.all([a.ready, b.ready, c.ready]);

    // Two selectors race for a cap-one wall. Count-and-reserve is serialized by the
    // store lock, so exactly one succeeds even though neither process shares memory.
    const race = await Promise.all([
      a.ask('claim', { room: 800, col: 10, row: 10, cap: 1 }),
      b.ask('claim', { room: 800, col: 10, row: 10, cap: 1 }),
    ]);
    assert.equal(race.filter(Boolean).length, 1);
    ok('a cap-one race has exactly one winner');
    const winner = race[0] ? a : b, loser = race[0] ? b : a;
    assert.equal(await c.ask('taken', { room: 800, col: 10, row: 10, cap: 1 }), winner.agent);
    ok('the winner is visible from a third process');

    assert.equal(await loser.ask('claim', { room: 800, col: 20, row: 20, cap: 1 }), true);
    assert.deepEqual(await loser.ask('held'), { room: 800, col: 20, row: 20 });
    ok('the loser can reserve a second wall');

    await winner.ask('release');
    assert.equal(await loser.ask('claim', { room: 800, col: 10, row: 10, cap: 1 }), true);
    assert.equal(await c.ask('taken', { room: 800, col: 20, row: 20, cap: 1 }), null);
    ok('release and one-claim-per-agent movement make a wall reusable');

    await Promise.all([a.ask('release'), b.ask('release')]);
    const capTwo = await Promise.all([
      a.ask('claim', { room: 800, col: 30, row: 30, cap: 2 }),
      b.ask('claim', { room: 800, col: 30, row: 30, cap: 2 }),
    ]);
    assert.deepEqual(capTwo, [true, true]);
    assert.equal(await c.ask('occupancy', { room: 800, col: 30, row: 30 }), 2);
    assert.equal(await c.ask('claim', { room: 800, col: 30, row: 30, cap: 2 }), false);
    ok('cap two admits two atomically and refuses the third');

    // Partner metadata is symmetric and file-backed too. Partners do not crowd each
    // other, while both still count for an unrelated third keeper.
    await Promise.all([a.ask('release'), b.ask('release'), c.ask('release')]);
    await Promise.all([
      a.ask('partner', { partner: 'bravo' }),
      b.ask('partner', { partner: 'alpha' }),
    ]);
    assert.equal(await a.ask('claim', {
      room: 800, col: 40, row: 40, cap: 1, partner: 'bravo',
    }), true);
    assert.equal(await b.ask('claim', {
      room: 800, col: 40, row: 40, cap: 1, partner: 'alpha',
    }), true);
    assert.equal(await b.ask('occupancy', { room: 800, col: 40, row: 40 }), 0);
    assert.equal(await c.ask('claim', { room: 800, col: 40, row: 40, cap: 1 }), false);
    ok('mutual partners share while a stranger is still refused');

    const listed = await c.ask('list');
    assert.deepEqual(listed.filter(x => x.at === '800:40,40').map(x => x.agent).sort(),
      ['alpha', 'bravo']);
    ok('the exported claim list preserves both occupants');

    // No TTL guesses: a live long-held wall stays claimed. A dead owner is detected by
    // PID and pruned on the next read, so a crashed keeper cannot reserve it forever.
    const doomed = start('doomed');
    await doomed.ready;
    assert.equal(await doomed.ask('claim', { room: 800, col: 50, row: 50, cap: 1 }), true);
    await doomed.stop();
    assert.equal(await c.ask('taken', { room: 800, col: 50, row: 50, cap: 1 }), null);
    ok('a killed owner is pruned and its wall becomes available');

    // A different fleet/server namespace sharing the same parent directory must neither
    // see nor block this fleet's reservations.
    assert.equal(await a.ask('claim', { room: 800, col: 60, row: 60, cap: 1 }), true);
    const isolated = start('isolated', 'fleet-b');
    await isolated.ready;
    assert.equal(await isolated.ask('taken', { room: 800, col: 60, row: 60, cap: 1 }), null);
    assert.equal(await isolated.ask('claim', { room: 800, col: 60, row: 60, cap: 1 }), true);
    ok('different namespaces are isolated');

    console.log(`\n${passed} passed, 0 failed`);
  } finally {
    await Promise.allSettled(workers.map(worker => worker.stop()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

