#!/usr/bin/env node
// THE BACKUP AND THE RESTORE, AGAINST SCRATCH DIRECTORIES. Offline, safe any time:
//
//   node tools/m59-backup-test.mjs
//
// A backup tool is the one thing you cannot test by using it: you find out whether it
// worked on the day the original is gone. So the guarantees are pinned here instead, and
// every case below is a way a backup can look like it worked and not have:
//
//   * A BACKUP WITH NO ROSTER IN IT. The rosters are the only record of the account
//     passwords, and the failure that matters is not a crash — it is a nightly job that
//     reports success while containing everything except the file nobody can regenerate.
//   * A LOCK FILE COUNTED AS A ROSTER. `prod.json.lock` sits beside the roster and is 32
//     bytes naming a pid. Backed up it is useless; RESTORED it is a stale claim on a fleet
//     that stops a broker starting — and while it was being counted, a directory holding
//     nothing but a lock would have satisfied the guard above.
//   * A RESTORE THAT SHRINKS A ROSTER. A week-old roster is smaller, older and entirely
//     valid-looking. It restores cleanly and silently loses every account added since.
//   * A RESTORE UNDER A LIVE BROKER, which owns the roster and rewrites it from memory.
//   * A DESTINATION INSIDE THE REPOSITORY, which is either committed — plaintext passwords
//     in git, permanently — or gitignored and deleted by the next clean.
//
// Nothing here touches a real fleet, a real backup directory, or the network.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const root = mkdtempSync(join(tmpdir(), 'm59-backup-test-'));
const repo = join(root, 'repo');
const destA = join(root, 'diskA'), destB = join(root, 'diskB');

// A checkout, as far as this tool is concerned: rosters, a shortcut, a sheet, a record.
const write = (rel, body) => {
  const p = join(repo, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
};
mkdirSync(repo, { recursive: true });
write('substrate/fleets/prod.json', JSON.stringify({ agents: [
  { agent: 't1', character: 'Kermit', account: 't1', password: 'REDACTED-IN-TEST-1' },
  { agent: 't2', character: 'Fozzie', account: 't2', password: 'REDACTED-IN-TEST-2' },
] }));
write('substrate/fleets/prod.json.prev', '{"agents":[]}');
write('substrate/fleets/prod.json.lock', '{"pid":4242}');
write('substrate/fleet-state.json', '{"agents":[{"agent":"a1","password":"REDACTED-IN-TEST-3"}]}');
write('substrate/fleet-default', 'prod\n');
write('shortcuts/m59-Kermit.lnk', 'binary-ish');
write('substrate/sheets/Kermit.json', '{"character":"Kermit"}');
write('substrate/abilities/Kermit.json', '{"skills":{}}');
write('substrate/history/fleet-2026-08-07.jsonl', '{"t":1}\n');

const backup = await import('./m59-backup.mjs');
const restore = await import('./m59-restore.mjs');

// ------------------------------------------------------------------ the plan

console.log('\nwhat a backup contains, and what it refuses to contain');
{
  const p = backup.planBackup({ repo });
  ok('every category is collected', p.categories.length === 4, p.categories.join(','));
  ok('the rosters are found and counted', p.rosters === 3,
     JSON.stringify(p.files.filter(f => f.roster).map(f => f.rel)));
  // A LOCK IS NOT A ROSTER, and it is not a backup artefact at all.
  ok('A LOCK FILE IS NOT BACKED UP', !p.files.some(f => /\.lock/.test(f.rel)),
     p.files.map(f => f.rel).filter(r => /lock/.test(r)).join(','));
  ok('and is not counted as a roster', !p.files.some(f => f.roster && /\.lock/.test(f.rel)));
  ok('a .prev copy of a roster IS kept — it is another copy of the irreplaceable thing',
     p.files.some(f => f.rel.endsWith('prod.json.prev')));
  ok('the shortcuts come too, because each carries a password',
     p.files.some(f => f.rel.includes('shortcuts')));
}
{
  // The category filter is what --credentials-only uses.
  const p = backup.planBackup({ repo, categories: ['credentials'] });
  ok('--credentials-only takes the rosters and nothing bulky',
     p.rosters === 3 && !p.files.some(f => f.category !== 'credentials'));
}

console.log('\nwhere a backup may not go');
{
  let threw = null;
  try { backup.checkDestination(join(repo, 'substrate', 'backups'), repo); }
  catch (e) { threw = e.message; }
  ok('A DESTINATION INSIDE THE REPOSITORY IS REFUSED', !!threw, String(threw).slice(0, 60));
  ok('and the refusal says why rather than silently relocating',
     /plaintext passwords|committed/i.test(threw || ''));
  ok('the repo root itself is refused', (() => {
    try { backup.checkDestination(repo, repo); return false; } catch { return true; }
  })());
  ok('somewhere outside is fine', !!backup.checkDestination(destA, repo));
}

console.log('\nA BACKUP WITH NO ROSTER IS AN ERROR, NOT A WARNING');
{
  const empty = join(root, 'emptyrepo');
  mkdirSync(join(empty, 'substrate'), { recursive: true });
  writeFileSync(join(empty, 'substrate', 'fleet-default'), 'prod\n');
  let threw = null;
  try { backup.runBackup({ dests: [destA], repo: empty, refresh: false }); }
  catch (e) { threw = e.message; }
  ok('a checkout with no roster refuses to produce a backup', !!threw);
  ok('and says the rosters are the only record of the passwords',
     /only record of the account passwords/i.test(threw || ''), String(threw).slice(0, 80));
}
{
  // The nastier version: a fleets/ directory holding ONLY a lock file. Before the lock was
  // excluded this satisfied the guard and produced a rosterless "successful" backup.
  const lockOnly = join(root, 'lockonly');
  mkdirSync(join(lockOnly, 'substrate', 'fleets'), { recursive: true });
  writeFileSync(join(lockOnly, 'substrate', 'fleets', 'prod.json.lock'), '{"pid":1}');
  let threw = null;
  try { backup.runBackup({ dests: [destA], repo: lockOnly, refresh: false }); }
  catch (e) { threw = e.message; }
  ok('A DIRECTORY HOLDING ONLY A LOCK DOES NOT COUNT AS HAVING A ROSTER', !!threw,
     'a rosterless backup reported success');
}

// ------------------------------------------------------------------ writing it

console.log('\nwriting, to two disks at once');
const made = backup.runBackup({ dests: [destA, destB], repo, refresh: false });
{
  ok('both destinations came out clean', made.all_ok,
     JSON.stringify(made.results.map(r => ({ d: r.dest, f: r.failed, m: r.mismatched }))));
  ok('every file was verified by re-reading it',
     made.results.every(r => r.verified === r.wrote && r.wrote > 0));
  // The bug the live run caught: hashing once but re-reading the source per destination
  // gives the second disk different bytes for anything being written concurrently.
  const [a, b] = made.results.map(r => JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8')));
  ok('THE TWO COPIES DESCRIBE THE SAME BYTES, not two nearby moments',
     JSON.stringify(a.files) === JSON.stringify(b.files));
  ok('the manifest records a hash for every file', a.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
  ok('and marks which files are rosters', a.files.filter(f => f.roster).length === 3);
  ok('and warns, in the file itself, what it holds', /PLAINTEXT ACCOUNT PASSWORDS/.test(a._warning));
}

console.log('\nverifying');
{
  const v = backup.verifyBackup(made.results[0].dir);
  ok('a fresh backup verifies', v.intact && v.ok === v.checked);
  // Corrupt one byte and it must be caught — the whole point of the manifest.
  const victim = join(made.results[1].dir, 'credentials', 'fleets', 'prod.json');
  writeFileSync(victim, readFileSync(victim, 'utf8').replace('Kermit', 'Kermlt'));
  const v2 = backup.verifyBackup(made.results[1].dir);
  ok('A SINGLE ALTERED BYTE IS CAUGHT', !v2.intact && v2.bad.includes('credentials/fleets/prod.json'),
     JSON.stringify(v2.bad));
  // Restore must refuse it rather than put the altered bytes back.
  const p = restore.planRestore(made.results[1].dir, { repo });
  ok('and the restore plan carries that failure so the CLI can refuse', !p.verified.intact);
}

// ------------------------------------------------------------------ putting it back

console.log('\nrestoring');
{
  const dir = made.results[0].dir;                    // the good copy
  const rosterPath = join(repo, 'substrate', 'fleets', 'prod.json');
  const original = readFileSync(rosterPath, 'utf8');

  // Nothing has changed yet, so the plan should be a no-op.
  const p0 = restore.planRestore(dir, { repo });
  ok('restoring over an unchanged checkout changes nothing',
     p0.changing.length === 0 && p0.identical > 0,
     JSON.stringify(p0.changing.map(a => a.target)));

  // Now lose the roster, the way you actually lose it.
  rmSync(rosterPath);
  const p1 = restore.planRestore(dir, { repo });
  const a1 = p1.changing.find(a => a.target.endsWith('fleets/prod.json'));
  ok('a deleted roster shows up as something to put back', !!a1 && a1.change === 'new');

  const out = restore.applyRestore(p1, { repo });
  ok('it is restored', existsSync(rosterPath) && readFileSync(rosterPath, 'utf8') === original);
  ok('and the restore reports what it did', out.restored >= 1 && !out.failed.length,
     JSON.stringify(out.failed));
}
{
  // THE DANGEROUS CASE. The roster on disk has grown — a character was added since the
  // backup — and the backup is a smaller, older, entirely valid-looking file.
  const dir = made.results[0].dir;
  const rosterPath = join(repo, 'substrate', 'fleets', 'prod.json');
  writeFileSync(rosterPath, JSON.stringify({ agents: [
    { agent: 't1', character: 'Kermit', account: 't1', password: 'REDACTED-IN-TEST-1' },
    { agent: 't2', character: 'Fozzie', account: 't2', password: 'REDACTED-IN-TEST-2' },
    { agent: 't3', character: 'Gonzo', account: 't3', password: 'REDACTED-IN-TEST-4' },
  ] }));
  const p = restore.planRestore(dir, { repo });
  const a = p.changing.find(x => x.target.endsWith('fleets/prod.json'));
  ok('A RESTORE THAT WOULD SHRINK A ROSTER IS FLAGGED', a?.roster_shrinks === true,
     JSON.stringify({ change: a?.change, shrinks: a?.shrinks }));
  ok('and it says how much would be lost', a.shrinks > 0);
  ok('and notices the file on disk is newer than the backup', a.current_is_newer === true);

  // Applying it anyway must keep the thing it replaces.
  const out = restore.applyRestore(p, { repo });
  ok('WHAT IT REPLACED IS KEPT, so a wrong restore is reversible', !!out.aside && existsSync(out.aside));
  const aside = join(out.aside, 'substrate', 'fleets', 'prod.json');
  ok('and the kept copy is the file that was there', existsSync(aside) &&
     JSON.parse(readFileSync(aside, 'utf8')).agents.length === 3);
  ok('while the restored file is the backup\'s',
     JSON.parse(readFileSync(join(repo, 'substrate', 'fleets', 'prod.json'), 'utf8')).agents.length === 2);
}

console.log('\nthe mapping back is derived from the mapping out');
{
  // Two lists of one mapping drift, and the direction they drift is "restores to the
  // wrong place". targetFor is the inverse of CATEGORIES, not a second copy of it.
  ok('a roster maps home', restore.targetFor('credentials/fleets/prod.json')?.rel ===
     'substrate/fleets/prod.json');
  ok('a nested record maps home', restore.targetFor('records/abilities/Kermit.json')?.rel ===
     'substrate/abilities/Kermit.json');
  ok('a single-file entry maps home', restore.targetFor('credentials/fleet-default')?.rel ===
     'substrate/fleet-default');
  ok('and each carries its category, so --what can filter',
     restore.targetFor('sheets/Kermit.json')?.category === 'sheets');
  ok('SOMETHING THIS CHECKOUT DOES NOT RECOGNISE IS NOT GUESSED AT',
     restore.targetFor('who/knows/what.json') === null);
}

console.log('\nlisting');
{
  const rows = backup.listBackups([destA, destB]);
  ok('both backups are listed', rows.length === 2);
  ok('newest first', rows[0].at >= rows[1].at);
  ok('with the roster count, which is the number worth scanning for',
     rows.every(r => r.rosters === 3));
  ok('a directory that is not a backup is simply not listed',
     (mkdirSync(join(destA, 'not-a-backup'), { recursive: true }),
      backup.listBackups([destA]).length === 1));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
