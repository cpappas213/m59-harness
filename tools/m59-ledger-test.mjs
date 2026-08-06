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
const { summarise, countKills, killsIn, KILL_WINDOW_MS } = await import('./m59-ledger.mjs');
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

// KILLS IN THE LAST HALF HOUR, which is a count of the record and not of a counter.
//
// The bug being pinned here had two halves and either alone was fatal. recordSample
// never wrote kills_30m, so the page's `r.kills_30m` was undefined for every character
// on every render and the template's `?? 0` turned that into a red zero — a fleet
// killing steadily looked identical to a dead one. And the value that would have been
// plumbed through is a field on the keeper, which the supervisor restarts about once a
// minute, so plumbing it would have changed a permanent zero into a near-permanent one.
//
// These timestamps are relative to NOW rather than to T0, because the window genuinely
// is. That is the property under test.
console.log('\nkills in the last half hour');
{
  const now = Date.now();
  const kill = (character, ago, extra = {}) => ({
    t: now - ago, type: 'event', character, kind: 'killed',
    creature: 'giant rat', room: 'Valley of Ileria', room_num: 544, ...extra,
  });

  // countKills is the one definition — pure, so test it on events directly.
  const evs = [
    kill('Sweetums', 60_000), kill('Sweetums', 120_000), kill('Sweetums', 400_000),
    kill('Beaker', 90_000),
    kill('Kermit', 40 * 60_000),                       // outside the window
    { t: now - 30_000, type: 'event', character: 'Beaker', kind: 'stalled' },
    { t: now - 30_000, type: 'event', kind: 'killed' },  // no character: unattributable
  ];
  const counted = countKills(evs, now - KILL_WINDOW_MS);
  ok('counts a character\'s kills inside the window', counted.get('Sweetums') === 3,
     'got ' + counted.get('Sweetums'));
  ok('counts a second character separately', counted.get('Beaker') === 1,
     'got ' + counted.get('Beaker'));
  ok('a kill older than the window is not counted', counted.get('Kermit') === undefined);
  ok('an event of another kind is not a kill', [...counted.values()].reduce((a, b) => a + b, 0) === 4);
  ok('a kill with no character is dropped rather than filed under undefined',
     !counted.has(undefined));

  // And through summarise, which is what the board actually renders.
  write([
    live('Sweetums', now - 300_000, 22, { kills: 7 }),
    live('Sweetums', now - 60_000, 22, { kills: 2 }),   // the keeper restarted in between
    live('Rowlf', now - 60_000, 28, { kills: 0 }),
    ...evs.filter(e => e.character === 'Sweetums'),
  ]);
  {
    const s = summarise({ sinceMs: 2 * 3600_000 });
    const sw = s.fleet.find(r => r.character === 'Sweetums');
    const rw = s.fleet.find(r => r.character === 'Rowlf');
    ok('the row carries kills_30m at all', sw.kills_30m === 3, 'got ' + sw.kills_30m);
    // THE REGRESSION. A high-water mark of 7 and three kills in the last half hour are
    // both true at once, and reading either as the other is what started this.
    ok('the lifetime column stays a high-water mark across the restart', sw.kills === 7,
       'got ' + sw.kills);
    ok('a character that has killed nothing reads zero, not undefined',
       rw.kills_30m === 0, 'got ' + String(rw.kills_30m));
  }

  // killsIn reads the same events off disk for callers with no ledger in hand — the
  // broker's fleet rows. maxAgeMs 0 defeats the memo, which exists for that hot path.
  {
    const by = killsIn(KILL_WINDOW_MS, 0);
    ok('killsIn counts the same kills from disk', by.get('Sweetums') === 3,
       'got ' + by.get('Sweetums'));
    ok('killsIn agrees with the row the board renders',
       by.get('Sweetums') === summarise({ sinceMs: 2 * 3600_000 })
         .fleet.find(r => r.character === 'Sweetums').kills_30m);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
