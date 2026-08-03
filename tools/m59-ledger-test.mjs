#!/usr/bin/env node
// AN OFFLINE FLEET IS NOT AN EMPTY FLEET. Offline, no server, safe any time:
//
//   node tools/m59-ledger-test.mjs
//
// A character that is not in game still gets sampled every thirty seconds, and every
// field of that sample is null. Letting those nulls win turned the fleet page into a
// list of characters with no level, no health and no room — which reads as "they are
// all gone" rather than "we cannot see them just now".
//
// The distinction matters because a logged-off character is OUT OF THE WORLD: nothing
// can move it, hurt it or heal it. Its last known state is not merely the freshest
// guess available, it is still the true one, and stays true until it logs back in.
//
// Uses M59_LEDGER_DIR against a scratch directory, so it never reads or writes a real
// fleet's history.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-ledger-test-'));
process.env.M59_LEDGER_DIR = dir;

const T0 = 1785780000000;                       // a fixed instant; nothing here is "now"
const day = new Date(T0).toISOString().slice(0, 10);

// A healthy reading, and the all-null shape the broker writes when nobody is in game.
const live = (character, t, level, extra = {}) => ({
  t, type: 'sample', character, level, kills: 3, room: 'Mausoleum', room_num: 1016,
  health: `${level}/${level}`, mana: '18/18', vigor_of: '150/200',
  has_weapon: true, has_food: false, activity: 'hunting: mummy',
  stalled: null, strategy: 'baseline', ...extra,
});
const dark = (character, t) => ({
  t, type: 'sample', character, level: null, kills: 0, room: null, room_num: null,
  health: null, mana: null, vigor_of: null, has_weapon: null, has_food: null,
  activity: null, stalled: 'not in game', strategy: null,
});

function write(rows) {
  writeFileSync(join(dir, `fleet-${day}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Import AFTER the env var is set: the ledger resolves its directory once, at load.
const { summarise } = await import('./m59-ledger.mjs');
// The window has to reach back to T0, which is in the past relative to whenever this
// runs. Generous rather than clever — the point here is the null handling.
const WINDOW = { sinceMs: Date.now() - T0 + 3600_000 };

// Kermit climbs to 24, then the connection goes and three null samples arrive.
write([
  live('Kermit', T0, 20), live('Kermit', T0 + 60_000, 24),
  dark('Kermit', T0 + 120_000), dark('Kermit', T0 + 180_000), dark('Kermit', T0 + 240_000),
]);
{
  const s = summarise(WINDOW);
  const k = s.fleet.find(r => r.character === 'Kermit');
  ok('level survives the nulls', k.level === 24, 'got ' + k.level);
  ok('health survives the nulls', k.health === '24/24', 'got ' + k.health);
  ok('room survives the nulls', k.room === 'Mausoleum', 'got ' + k.room);
  ok('activity survives the nulls', k.activity === 'hunting: mummy', 'got ' + k.activity);
  ok('strategy survives the nulls', k.strategy === 'baseline', 'got ' + k.strategy);
  ok('gained is measured from the first REAL level', k.gained === 4, 'got ' + k.gained);
  ok('the row knows it is not live', k.online === false);
  ok('and when it was last really seen', k.last_in_game === T0 + 60_000);
  ok('fleet reports nobody online', s.online === 0, 'got ' + s.online);
  ok('offline_since is when the last one dropped', s.offline_since === T0 + 60_000);
}

// One of two still in game: not a fleet-wide outage, so no banner.
write([
  live('Kermit', T0, 24), dark('Kermit', T0 + 120_000),
  live('Piggy', T0, 22), live('Piggy', T0 + 120_000, 23),
]);
{
  const s = summarise(WINDOW);
  ok('one live character keeps offline_since null', s.offline_since === null);
  ok('and is counted as online', s.online === 1, 'got ' + s.online);
  ok('while the dark one still reports its last state',
     s.fleet.find(r => r.character === 'Kermit').level === 24);
}

// Nothing but healthy samples that simply stopped: the broker died rather than
// reporting. offline_since cannot see this — last_sample_at is what catches it.
write([live('Kermit', T0, 24), live('Piggy', T0, 22)]);
{
  const s = summarise(WINDOW);
  ok('a silent broker leaves offline_since null', s.offline_since === null);
  ok('but last_sample_at exposes the silence', s.last_sample_at === T0, 'got ' + s.last_sample_at);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
