#!/usr/bin/env node
// PUT A BACKUP BACK, WITHOUT DESTROYING WHAT IS THERE NOW.
//
//   node tools/m59-restore.mjs --list                     what is available
//   node tools/m59-restore.mjs --from <dir>                say what it WOULD do (default)
//   node tools/m59-restore.mjs --from <dir> --apply        do it
//   node tools/m59-restore.mjs --from <dir> --what credentials --apply
//   node tools/m59-restore.mjs --latest --apply            newest backup on any destination
//
// A RESTORE IS THE DANGEROUS HALF, AND IT IS DANGEROUS IN A SPECIFIC WAY.
//
// The rosters are the only record of the account passwords, so the thing you must never do
// is overwrite a GOOD roster with an OLD one. That is not hypothetical here: a roster gains
// entries over time (a new character, a character's name written back after its first
// login), and a backup from last week is a smaller, older, entirely valid-looking file. It
// restores cleanly and silently loses whatever was added since.
//
// So four rules, enforced rather than documented:
//
// 1. IT PLANS BY DEFAULT AND CHANGES NOTHING. `--apply` is required. Every destructive tool
//    in this repository that did not do this eventually surprised somebody.
//
// 2. IT REFUSES WHILE A BROKER HOLDS THE FLEET. The broker owns the roster and rewrites it
//    from memory as characters log in and out — restore under a live one and your file
//    survives for seconds before being overwritten by the state you were trying to replace.
//    Same reason m59-shutdown.mjs refuses to restore a checkpoint while the server is up.
//
// 3. IT COPIES ASIDE WHAT IT IS ABOUT TO OVERWRITE, always, to
//    substrate/.before-restore-<stamp>/. The restore you regret is the one you cannot
//    reverse, and this is cheap.
//
// 4. IT WARNS WHEN THE BACKUP IS OLDER OR SMALLER THAN WHAT IS ON DISK. Not a refusal —
//    restoring an older roster is sometimes exactly the intent — but it is stated per file,
//    loudly, because "this will lose 6 accounts" is the sentence you want before you type
//    --apply rather than after.
//
// Every file is checked against the manifest's hash before it is used. A backup that does
// not verify is refused outright: putting back bytes that are not the bytes that were taken
// is worse than not restoring.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DESTS, CATEGORIES, listBackups, verifyBackup, stamp } from './m59-backup.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REPO = path.resolve(here('..'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const human = (n) => n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}K` : `${(n / 1048576).toFixed(1)}M`;

// Where each backup path goes back to. The inverse of CATEGORIES' from/to, derived from it
// rather than written out again — two lists of the same mapping drift, and the direction
// they drift in is "restores a file to the wrong place".
export function targetFor(backupPath) {
  for (const cat of CATEGORIES) {
    for (const e of cat.entries) {
      const to = e.to.replace(/\/$/, '');
      if (backupPath === to) return { rel: e.from, category: cat.key };
      if (backupPath.startsWith(to + '/'))
        return { rel: e.from + '/' + backupPath.slice(to.length + 1), category: cat.key };
    }
  }
  return null;
}

// IS A BROKER HOLDING A FLEET RIGHT NOW? Asked over /health rather than by looking for a
// process called something — this repository has already killed the wrong broker once by
// matching on a process name across checkouts.
export async function brokerHolding(port = Number(process.env.M59_BROKER_PORT || 8901)) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return { up: true, pid: j.pid, fleet: j.fleet ?? null, sessions: (j.sessions || []).length };
  } catch { return { up: false }; }
}

// ------------------------------------------------------------------ the plan

export function planRestore(dir, { what = null, repo = REPO } = {}) {
  const v = verifyBackup(dir);
  const want = what ?? CATEGORIES.map(c => c.key);
  const actions = [];

  for (const f of v.manifest.files || []) {
    const t = targetFor(f.path);
    if (!t) { actions.push({ backup: f.path, skip: 'nothing in this checkout maps to it' }); continue; }
    if (!want.includes(t.category)) continue;

    const target = path.join(repo, ...t.rel.split('/'));
    let current = null;
    try {
      const st = fs.statSync(target);
      current = { size: st.size, mtime: st.mtimeMs,
                  sha256: sha256(fs.readFileSync(target)) };
    } catch { /* not there — a pure add */ }

    const a = { backup: f.path, target: t.rel, category: t.category,
                size: f.size, sha256: f.sha256, current };
    if (!current) a.change = 'new';
    else if (current.sha256 === f.sha256) a.change = 'identical';
    else {
      a.change = 'overwrite';
      // THE WARNING THAT MATTERS. A roster that shrinks is accounts disappearing, and the
      // restored file looks perfectly valid afterwards.
      if (f.size < current.size) {
        a.shrinks = current.size - f.size;
        if (/fleet-state\.json$|fleets[\\/]|fleet-accounts\.json$/.test(t.rel)) a.roster_shrinks = true;
      }
      if (current.mtime > Date.parse(v.manifest.at)) a.current_is_newer = true;
    }
    actions.push(a);
  }
  return { dir, verified: v, actions,
           changing: actions.filter(a => a.change === 'overwrite' || a.change === 'new'),
           identical: actions.filter(a => a.change === 'identical').length };
}

// ------------------------------------------------------------------ doing it

export function applyRestore(plan, { repo = REPO, now = new Date() } = {}) {
  const asideDir = path.join(repo, 'substrate', `.before-restore-${stamp(now)}`);
  const done = [], failed = [], kept = [];

  for (const a of plan.changing) {
    const target = path.join(repo, ...a.target.split('/'));
    const source = path.join(plan.dir, ...a.backup.split('/'));
    try {
      const buf = fs.readFileSync(source);
      // Re-check at the moment of use. The verify pass may have been minutes ago and the
      // medium may be a USB disk; hashing twice costs nothing next to restoring garbage.
      if (sha256(buf) !== a.sha256)
        throw new Error('the file changed since it was verified — refusing to restore it');

      // ALWAYS KEEP WHAT WE ARE ABOUT TO REPLACE. This is the whole reason a restore here
      // is not frightening.
      if (a.current) {
        const aside = path.join(asideDir, ...a.target.split('/'));
        fs.mkdirSync(path.dirname(aside), { recursive: true });
        fs.copyFileSync(target, aside);
        kept.push(a.target);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      if (process.platform !== 'win32' && /credentials/.test(a.category))
        { try { fs.chmodSync(target, 0o600); } catch { /* best effort */ } }
      done.push(a.target);
    } catch (e) { failed.push(`${a.target}: ${e.message}`); }
  }
  return { restored: done.length, done, failed, kept,
           aside: kept.length ? asideDir : null };
}

// ---------------------------------------------------------------------- the CLI

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'm59-restore.mjs';

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  const val = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv[i + 1] ?? null; };

  if (flag('list') || (!flag('from') && !flag('latest'))) {
    const rows = listBackups(DEFAULT_DESTS);
    if (!rows.length) {
      console.log(`no backups under ${DEFAULT_DESTS.join(' or ')}`);
      console.log('make one with: node tools/m59-backup.mjs');
      process.exit(flag('list') ? 0 : 1);
    }
    console.log('when                      files    size  rosters  dir');
    for (const b of rows)
      console.log(`${String(b.at).slice(0, 19).replace('T', ' ')}  ${String(b.files).padStart(6)}  ` +
                  `${human(b.bytes).padStart(6)}  ${String(b.rosters).padStart(7)}  ${b.dir}`);
    if (!flag('list')) {
      console.log('\nsay which: --from <dir>, or --latest for the newest.');
      console.log('It plans and changes nothing until you add --apply.');
      process.exit(1);
    }
    process.exit(0);
  }

  const dir = flag('latest') ? listBackups(DEFAULT_DESTS)[0]?.dir : val('from');
  if (!dir) { console.error('no backup found to restore from'); process.exit(1); }

  // VERIFY BEFORE ANYTHING ELSE. Putting back bytes that are not the bytes that were taken
  // is worse than not restoring at all.
  let plan;
  try { plan = planRestore(dir, { what: val('what') ? val('what').split(',') : null }); }
  catch (e) { console.error(`cannot read that backup: ${e.message}`); process.exit(1); }

  const v = plan.verified;
  console.log(`${dir}\n  taken ${v.at}\n  ${v.ok} of ${v.checked} file(s) match their recorded hash`);
  if (!v.intact) {
    console.error(`\nREFUSING: this backup does not verify — ${v.bad.length} changed, ` +
                  `${v.missing.length} missing.\nRestoring bytes that are not the bytes that ` +
                  `were taken is worse than not restoring. Try another backup: ` +
                  `node tools/m59-restore.mjs --list`);
    process.exit(1);
  }

  const broker = await brokerHolding();
  if (broker.up) {
    console.error(`\nREFUSING: a broker is running (pid ${broker.pid}, holding "${broker.fleet}", ` +
                  `${broker.sessions} session(s)).\nIt owns the roster and rewrites it from memory ` +
                  `as characters come and go, so a file restored underneath it survives for\n` +
                  `seconds. Stop it first:\n\n    node tools/m59-service.mjs stop --fleet ${broker.fleet}\n\n` +
                  `then restore, then start it again.`);
    process.exit(1);
  }

  console.log(`\n${plan.changing.length} file(s) would change; ${plan.identical} already identical.`);
  const roster = plan.changing.filter(a => /fleet/.test(a.target));
  if (roster.length) {
    console.log('\nrosters — the only record of the account passwords:');
    for (const a of roster) {
      const note = a.change === 'new' ? 'NEW — nothing there now'
        : a.roster_shrinks ? `SHRINKS by ${a.shrinks} bytes — THIS WILL LOSE ACCOUNTS`
        : a.current_is_newer ? 'the file on disk is NEWER than this backup'
        : 'differs';
      console.log(`  ${a.target.padEnd(40)} ${note}`);
    }
  }
  const byCat = {};
  for (const a of plan.changing) byCat[a.category] = (byCat[a.category] || 0) + 1;
  console.log('\nby category: ' + (Object.entries(byCat).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'));

  if (!flag('apply')) {
    console.log('\nThis changed nothing. Add --apply to do it.');
    console.log('Whatever it replaces is copied to substrate/.before-restore-<stamp>/ first.');
    process.exit(0);
  }

  if (plan.changing.some(a => a.roster_shrinks) && !flag('force')) {
    console.error('\nREFUSING: a roster would SHRINK, which means accounts in the file on disk ' +
                  'are not in this backup.\nThose passwords exist nowhere else. If that is really ' +
                  'what you want, re-run with --force.');
    process.exit(1);
  }

  const out = applyRestore(plan);
  console.log(`\nrestored ${out.restored} file(s)`);
  if (out.aside) console.log(`what was replaced is in ${out.aside}`);
  if (out.failed.length) {
    console.error(`${out.failed.length} FAILED:`);
    for (const f of out.failed) console.error('  ' + f);
    process.exit(1);
  }
  console.log('\nStart the broker again with: node tools/m59-service.mjs start --fleet <name>');
  process.exit(0);
}
