#!/usr/bin/env node
// WHO IS AT THE CONTROLS, worked out from a command line. Offline, no server:
//
//   node tools/m59-localclient-test.mjs
//
// The pilot claim is the only thing that promotes a player's speech to instruction, so
// being wrong here is not a cosmetic failure: it either denies the operator the
// privileges they should have — which is what happened, five "safe spot here"s heard by
// a room full of characters and acted on by none — or grants them over a process that is
// playing somebody else.
//
// The claiming itself lives in the broker and cannot be unit tested, because importing
// m59-broker.mjs RUNS it. The parsing and the matching are the parts that can be quietly
// wrong, so they live in m59-localclient.mjs and are pinned here.
import { parseClientCommand, soleClientAgent, createClientWatch,
         clientsHoldingRoster, localClients, identifyClients } from './m59-localclient.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ------------------------------------------------------------------ the command line

console.log('\nreading a client command line');
{
  // The real one, verbatim from a Steam launch on the machine this was written for.
  const steam = '"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Meridian 59\\Meridian.exe" ' +
                '/H:76.214.42.186 /P:5959 /U:t5 /W:t5 /Q /S';
  const p = parseClientCommand(steam);
  ok('the account comes off /U:', p.account === 't5', JSON.stringify(p));
  ok('the host comes off /H:', p.host === '76.214.42.186');
  ok('the port comes off /P: as a number', p.port === 5959);

  // The exe path contains spaces and is quoted; that must not confuse the flag scan.
  ok('a quoted exe path with spaces does not break it', parseClientCommand(steam).account === 't5');

  ok('a shortcut written by m59-shortcuts.mjs reads the same',
     parseClientCommand('Meridian.exe /H:127.0.0.1 /P:5959 /U:fleet01 /W:hunter2 /Q /S').account === 'fleet01');
  ok('flags are case-insensitive, because Windows shortcuts are not consistent',
     parseClientCommand('meridian.exe /u:t9 /h:127.0.0.1').account === 't9');
  ok('a quoted value is unwrapped', parseClientCommand('/U:"t 9"').account === 't 9');

  const bare = parseClientCommand('Meridian.exe');
  ok('a client launched with no flags says nothing', bare.account === null && bare.host === null);
  ok('and neither does an empty command line', parseClientCommand('').account === null);
  ok('nor undefined', parseClientCommand(undefined).account === null);
  ok('a missing port is null, not NaN', parseClientCommand('/U:t1').port === null);
}

// ------------------------------------------------------------------ one client, or none

console.log('\nmatching a client to a character');
{
  const known = (a) => ['t1', 't5', 't21'].includes(a);
  const one = [{ pid: 31296, account: 't5', host: '76.214.42.186', port: 5959 }];

  const hit = soleClientAgent(one, known);
  ok('a single recognised client is claimed', hit.agent === 't5' && hit.pid === 31296);
  ok('and it carries the host through for the caller to check', hit.host === '76.214.42.186');

  ok('no client at all is refused', soleClientAgent([], known).agent === null);
  ok('and says so plainly', /no Meridian client/.test(soleClientAgent([], known).why));
  ok('null is treated as none', soleClientAgent(null, known).agent === null);

  // THE CASE THE OLD CODE GOT WRONG BY LUCK. It took the first pid tasklist reported and
  // claimed whichever character was rejoining, so with two clients open it would hand
  // instruction privileges to a process playing somebody else.
  const two = [{ pid: 1, account: 't5' }, { pid: 2, account: 't1' }];
  ok('two clients are refused rather than guessed between', soleClientAgent(two, known).agent === null);
  ok('and the refusal says why', /refusing to guess/.test(soleClientAgent(two, known).why));
  ok('two clients are refused even when both are ours', soleClientAgent(two, () => true).agent === null);

  const anon = [{ pid: 5, account: null }];
  ok('a client that does not say who it is, is refused', soleClientAgent(anon, known).agent === null);
  ok('and the refusal names the missing flag', /without \/U:/.test(soleClientAgent(anon, known).why));

  const stranger = [{ pid: 6, account: 'someone_elses_account' }];
  ok('an account outside the fleet is refused', soleClientAgent(stranger, known).agent === null);
  ok('and the refusal quotes it back', /someone_elses_account/.test(soleClientAgent(stranger, known).why));

  ok('an entry with no pid is not a client', soleClientAgent([{ account: 't5' }], known).agent === null);
  // A dead entry alongside a live one must not read as "two clients" and block the claim.
  ok('a pid-less entry does not count toward the crowd',
     soleClientAgent([{ account: 't1' }, { pid: 7, account: 't5' }], known).agent === 't5');
}

// ------------------------------------------------------------------ when to look at all

// THE SCAN USED TO RUN FOR EVER. A 4s pilot tick behind an 8s cache meant a `tasklist`
// spawn every 8-12 seconds for the life of the broker, on a machine where no client had
// been launched all day — and because the broker has no console of its own, each one
// flashed a terminal window on the desktop. The window is fixed with `windowsHide`; the
// spawning is fixed here, by making the look an event rather than a timer.
//
// Counting `looks` is the point of every test below: the thing being pinned is HOW MANY
// TIMES A PROCESS WOULD HAVE BEEN SPAWNED, which is invisible in the return value.
console.log('\ndeciding whether to look for a client at all');
{
  const watcher = (answers) => {
    let looks = 0;
    const w = createClientWatch({ scan: async () => { looks++; return answers.shift() ?? []; } });
    return { w, looks: () => looks };
  };

  // Armed at boot: a client can already be running when the broker comes up, and that
  // operator should not have to do anything to be recognised.
  {
    const { w, looks } = watcher([[{ pid: 1, account: 't5' }]]);
    ok('the watch starts armed', w.armed === true);
    const r = await w.look();
    ok('so the first tick does look', looks() === 1 && r.scanned === true);
    ok('and passes the clients back', r.clients.length === 1 && r.clients[0].account === 't5');
    ok('a look that found somebody stays armed', w.armed === true);
  }

  // The whole point: one empty answer and it stops.
  {
    const { w, looks } = watcher([[], [], []]);
    await w.look();
    ok('a look that finds nobody disarms the watch', w.armed === false);
    ok('and says why in words a person can read', /launched from the terminal/.test(w.why()));
    await w.look();
    await w.look();
    ok('so no further tick spawns anything', looks() === 1);
  }

  // "We did not look" and "we looked and there was nobody" must not be the same answer.
  {
    const { w } = watcher([[]]);
    await w.look();
    const r = await w.look();
    ok('a disarmed look reports that it did not look', r.scanned === false);
    ok('rather than reporting an empty room', r.clients.length === 0 && r.scanned !== true);
  }

  // Launching from the terminal is the documented way back in.
  {
    const { w, looks } = watcher([[], [{ pid: 9, account: 't1' }]]);
    await w.look();
    ok('disarmed after finding nobody', w.armed === false && looks() === 1);
    w.arm('the terminal launched t1');
    ok('rearming turns it back on', w.armed === true);
    ok('and records what did it', /terminal launched t1/.test(w.why()));
    const r = await w.look();
    ok('the next look spawns again and finds the client', looks() === 2 && r.clients[0].account === 't1');
    ok('and having found one, stays armed', w.armed === true);
  }

  // A claim ending is the other re-arming event — closing a client and opening it as
  // somebody else is how an evening of this actually goes. It is worth ONE more look,
  // and then it must go quiet again on its own rather than polling for the relaunch.
  {
    const { w, looks } = watcher([[], []]);
    await w.look();
    w.arm("t5's client went away");
    await w.look();
    ok('a re-arm that finds nobody disarms again', w.armed === false);
    ok('so a released claim costs exactly one extra scan', looks() === 2);
    await w.look();
    ok('and not a scan per tick thereafter', looks() === 2);
  }

  // Disarming by hand is what a caller does when it knows there is nothing to find.
  {
    const { w, looks } = watcher([[{ pid: 3, account: 't5' }]]);
    w.disarm('asked to stop looking');
    const r = await w.look();
    ok('an explicit disarm is honoured even with a client present', looks() === 0 && r.scanned === false);
  }
}

// ------------------------------------------------- standing down at startup
//
// A DIFFERENT QUESTION FROM "WHO MAY GIVE ORDERS", and it has to be answered for every
// client rather than refused when there are two. `soleClientAgent` guards a privilege,
// so with two clients open it declines to guess and that is right. This guards a login:
// a broker that logs in a character somebody is playing has already thrown them out of
// the world, and there is nothing cautious about doing that to both of them.
{
  console.log('\nwhich roster characters a person is already holding');
  const roster = { t1: '76.214.42.186', t5: '76.214.42.186', t9: null };
  const host = (a) => (a in roster ? roster[a] : undefined);

  const two = clientsHoldingRoster([{ pid: 10, account: 't1', host: '76.214.42.186' },
                                    { pid: 11, account: 't5', host: '76.214.42.186' }], host);
  eq('two clients are BOTH stood down for', two.held.map(h => h.agent), ['t1', 't5']);
  eq('and nothing is left unexplained', two.unknown.length, 0);

  const foreign = clientsHoldingRoster([{ pid: 12, account: 't1', host: '127.0.0.1' }], host);
  eq('a client on another server is not our operator', foreign.held.length, 0);
  ok('and the reason says which server it is on',
     /pointed at 127\.0\.0\.1/.test(foreign.unknown[0]?.why || ''), foreign.unknown[0]?.why);

  const stranger = clientsHoldingRoster([{ pid: 13, account: 'somebodyelse', host: '76.214.42.186' }], host);
  eq('an account outside this roster is left alone', stranger.held.length, 0);
  ok('and named as not ours', /not in this roster/.test(stranger.unknown[0]?.why || ''));

  const nameless = clientsHoldingRoster([{ pid: 14, account: null, host: null }], host);
  eq('a client with no /U: cannot be matched', nameless.held.length, 0);
  ok('but is still REPORTED — something is running that we could not name',
     nameless.unknown[0]?.pid === 14);

  // A roster entry with no host recorded must not become a reason to log a person out.
  const hostless = clientsHoldingRoster([{ pid: 15, account: 't9', host: '76.214.42.186' }], host);
  eq('an entry with no host on record is trusted, not refused', hostless.held.map(h => h.agent), ['t9']);

  // A hand-typed launch gives no /H: at all, and that is the commonest way in after a
  // shortcut. Refusing it would bump exactly the person most likely to be experimenting.
  const noflag = clientsHoldingRoster([{ pid: 16, account: 't1', host: null }], host);
  eq('a client that gave no /H: is trusted', noflag.held.map(h => h.agent), ['t1']);

  eq('nothing running means nothing held', clientsHoldingRoster([], host).held.length, 0);
  eq('and a missing list is not a crash', clientsHoldingRoster(null, host).held.length, 0);
}

// ------------------------------------------------------- the POSIX scan, against REAL pids
//
// THE ONE PART OF THIS FILE THAT IS NOT PURE, and it has to be: the scan's whole job is to
// read processes, and the two ways it can be wrong are invisible to a fixture. It can miss
// a Proton launch — which is a CHAIN of processes all repeating the same arguments, so a
// naive count reports four clients and `soleClientAgent` refuses to claim anything. Or it
// can match a process that merely MENTIONS the client, like a grep or a shell running
// `m59-shortcuts.mjs --show`, and claim off somebody else's flags quoted as text.
//
// So it spawns real executables named Meridian.exe carrying real client flags, DIRECTLY
// rather than through a shell — a shell wrapper's own command string would contain the
// flags and is precisely the false positive under test.
if (process.platform !== 'win32') {
  console.log('\nthe POSIX scan (real processes)');
  const dir = mkdtempSync(join(tmpdir(), 'm59-localclient-'));
  // SYMLINKS TO A REAL BINARY, NOT SHEBANG SCRIPTS. A `#!/bin/bash` script runs with
  // argv[0] = "/bin/bash" and the script's own path at argv[1], which is precisely NOT the
  // shape under test — Proton puts the executable at argv[0]
  // ("Z:\...\Meridian.exe -s /H:... /U:t1"). A fixture that got that wrong would have
  // passed a test of the wrong thing. `-s` makes bash read from stdin, which never
  // arrives, so each of these simply waits — and `-s` is what the real launch passes too.
  const exe = join(dir, 'Meridian.exe');
  const wrapper = join(dir, 'reaper');
  symlinkSync('/bin/bash', exe);
  symlinkSync('/bin/bash', wrapper);

  const kids = [];
  const FLAGS = (acct) => ['-s', '/H:192.168.1.242', '/P:5959', `/U:${acct}`, '/W:secret', '/Q', '/S'];
  const start = (acct) => kids.push(spawn(exe, FLAGS(acct), { stdio: ['pipe', 'ignore', 'ignore'] }));
  // A WRAPPER, exactly as Steam's reaper and Proton's python3 appear: it NAMES the client
  // as an argument it is about to run, and is not the client. Recorded off a real Deck
  // launch, where one click produced six such processes and only the last was the game.
  const startWrapper = (acct) => kids.push(spawn(wrapper,
    ['-s', 'SteamLaunch', 'AppId=893390', '--', exe, ...FLAGS(acct)],
    { stdio: ['pipe', 'ignore', 'ignore'] }));
  const stopAll = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch {} } };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // THE SCAN READS THE WHOLE MACHINE, SO THE TEST MUST OWN ITS SUBJECTS. A person playing
  // the fleet while this runs is a real Meridian client on this host, and the scan is
  // right to find it — so these assertions are scoped to accounts nobody plays, and the
  // "nothing is running" case asks about THOSE rather than about the machine. Written
  // after exactly that: a live Kermit failed five assertions by being correctly detected.
  const A = 'ztest1', B = 'ztest2';
  const mine = (list) => list.filter(c => c.account === A || c.account === B);

  try {
    // The real shape: wrappers first, the game last — the order a launch actually
    // produces, and the order in which "lowest pid" gives the WRONG answer.
    startWrapper(A); startWrapper(A);
    start(A);
    await wait(500);
    let clients = mine(await localClients({ ttlMs: 0 }));
    eq('a three-process launch chain is ONE client', clients.length, 1);
    eq('and it carries the account', clients[0]?.account, A);
    // THE PID IS THE GAME, NOT THE REAPER THAT NAMED IT.
    ok('and the pid is the client itself, not a wrapper that names it',
       clients[0]?.pid === kids[kids.length - 1].pid,
       `got ${clients[0]?.pid}, want ${kids[kids.length - 1].pid}`);
    eq('the host is read off the command line', clients[0]?.host, '192.168.1.242');
    eq('and the port', clients[0]?.port, 5959);
    eq('so the claim resolves', soleClientAgent(clients, a => a === A).agent, A);

    start(B);
    await wait(500);
    clients = mine(await localClients({ ttlMs: 0 }));
    eq('two ACCOUNTS are still two clients', clients.length, 2);
    const two = soleClientAgent(clients, a => [A, B].includes(a));
    ok('and two accounts refuses to guess', two.agent === null && /refusing to guess/.test(two.why));
    const named = new Set(mine(await identifyClients()).map(c => c.account));
    ok('identifyClients names both', named.has(A) && named.has(B));

    stopAll();
    await wait(600);
    eq('and they are gone once they exit', mine(await localClients({ ttlMs: 0 })).length, 0);
  } finally {
    stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
