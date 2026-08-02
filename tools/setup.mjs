#!/usr/bin/env node
// BRING UP EVERYTHING, FROM A BARE CLONE. Zero dependencies, Windows and Linux.
//
//   node tools/setup.mjs doctor        what is present, what is missing, what to do
//   node tools/setup.mjs server        clone + build + run the server
//   node tools/setup.mjs client        find (or install) the Steam client
//   node tools/setup.mjs broker        start the MCP broker
//   node tools/setup.mjs fleet 10      create ten characters
//   node tools/setup.mjs all 10        all of the above, in order
//
// Every step is idempotent: running it twice finds what the first run made and
// says so rather than making a second one.
//
// WHAT NEEDS A HUMAN, AND WHY. Two things here cannot be automated honestly:
//
//   * Steam will not install a game you do not own, and it will not log in for
//     you. `client` finds an existing install, and otherwise hands you the URL.
//   * Building the server natively on Windows needs Visual Studio and a
//     developer shell. The container path avoids that entirely, which is why it
//     is the default on both platforms.
//
// THE CLIENT IS OPTIONAL FOR A FLEET. Agents log in over the wire with
// tools/m59-client.mjs; no Meridian.exe is involved. You need the Steam client
// to *watch* the fleet with your own eyes, and for the compendium's sprites.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WIN = process.platform === 'win32';

// Upstream first, and deliberately. It is public, and it is the tree the
// container path is actually tested against — build, run, admin socket, account
// creation and a real fleet, end to end. The Deck fork is private (so most
// people cannot clone it at all) and its Linux server currently exits during
// startup, so preferring it would hand most users a server that does not run.
// Point M59_ROOT at the fork if you have it and want it.
const SERVER_REPOS = [
  { url: 'https://github.com/Meridian59/Meridian59', name: 'Meridian59' },
];

const STEAM_APPID = '893390';

const CLIENT_GUESSES = [
  process.env.M59_CLIENT,
  'C:/Program Files (x86)/Steam/steamapps/common/Meridian 59',
  'C:/Program Files/Steam/steamapps/common/Meridian 59',
  join(process.env.HOME || '', '.steam/steam/steamapps/common/Meridian 59'),
  join(process.env.HOME || '', '.local/share/Steam/steamapps/common/Meridian 59'),
  join(process.env.HOME || '', '.var/app/com.valvesoftware.Steam/data/Steam/steamapps/common/Meridian 59'),
  '/run/media/mmcblk0p1/steamapps/common/Meridian 59',
];

// ------------------------------------------------------------------ helpers

const c = {
  ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
};

// No `shell: true`. Everything spawned here is a real executable (git.exe,
// docker.exe, node.exe), so the shell buys nothing and would make every argument
// — including paths with spaces, which "C:/Program Files (x86)/..." always has —
// a quoting problem.
function have(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    if (r.error) return null;
    if (r.status !== 0 && !r.stdout) return null;
    return (r.stdout || r.stderr || '').split('\n')[0].trim();
  } catch { return null; }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) { console.error(`  cannot run ${cmd}: ${r.error.message}`); return false; }
  return r.status === 0;
}

// Is the daemon actually up? `docker info` talks to it; `docker --version` does not.
function dockerReady() {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
                        { encoding: 'utf8', timeout: 25000 });
    return !r.error && r.status === 0 && !!(r.stdout || '').trim();
  } catch { return false; }
}

function portOpen(port, host = '127.0.0.1', ms = 2000) {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(ms);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

function findServerSrc() {
  const guesses = [
    process.env.M59_ROOT,
    join(REPO, '..', 'Meridian59-deck'),
    join(REPO, '..', 'Meridian59'),
    'C:/code/Meridian59',
    join(process.env.HOME || '', 'Meridian59'),
  ].filter(Boolean);
  for (const g of guesses) {
    // A source tree, not just any directory: these four are what the container build needs.
    if (existsSync(join(g, 'blakserv')) && existsSync(join(g, 'kod')) &&
        existsSync(join(g, 'common.mak.linux')) && existsSync(join(g, 'resource', 'rooms'))) {
      return g;
    }
  }
  return null;
}

function findClient() {
  for (const g of CLIENT_GUESSES) {
    if (!g) continue;
    const res = join(g, 'resource');
    try {
      if (existsSync(res) && readdirSync(res).some(f => f.toLowerCase().endsWith('.bgf'))) return g;
    } catch { /* unreadable, keep looking */ }
  }
  return null;
}

// ------------------------------------------------------------------ doctor

async function doctor() {
  const rows = [];
  const add = (name, val, hint) => rows.push({ name, val, hint });

  add('node', have('node'), 'https://nodejs.org — 18 or newer');
  add('git', have('git'), 'https://git-scm.com');
  add('python', have('python3') || have('python'), 'only for the sprite puller and source analysis');
  // `docker --version` only proves the CLI is on the path. The daemon is a
  // separate thing that is very often not running, and reporting "ok" for a
  // stopped Docker Desktop sends you off to debug the wrong layer entirely.
  add('docker', dockerReady() ? have('docker') : null,
      have('docker') ? 'the CLI is installed but the daemon is not responding — start Docker Desktop'
                     : 'https://docs.docker.com/get-docker/ — the portable server path');

  const src = findServerSrc();
  add('server source', src, `node tools/setup.mjs server  (clones one)`);

  const client = findClient();
  add('steam client', client, `node tools/setup.mjs client  (finds or explains)`);

  const sprites = existsSync(join(REPO, 'compendium', 'assets', 'img'));
  add('compendium sprites', sprites ? 'present' : null, 'python tools/pull-client-assets.py');

  const game = await portOpen(5959);
  add('server :5959', game ? 'listening' : null, 'node tools/setup.mjs server');
  const adminSock = await portOpen(9998);
  add('admin :9998', adminSock ? 'listening' : null, 'published by docker/docker-compose.yml');
  const broker = await portOpen(8901);
  add('broker :8901', broker ? 'listening' : null, 'node tools/setup.mjs broker');

  const w = Math.max(...rows.map(r => r.name.length));
  console.log('');
  for (const r of rows) {
    const mark = r.val ? c.ok('  ok  ') : c.bad(' MISS ');
    console.log(`${mark} ${r.name.padEnd(w)}  ${r.val ? c.dim(String(r.val).slice(0, 60)) : c.warn(r.hint)}`);
  }
  const missing = rows.filter(r => !r.val);
  console.log('');
  if (!missing.length) {
    console.log(c.ok('everything is up. `node tools/setup.mjs fleet 10` makes characters.'));
    return 0;
  }
  console.log(`${missing.length} thing(s) not ready. \`node tools/setup.mjs all 10\` does the rest.`);
  return 0;
}

// ------------------------------------------------------------------ server

async function server() {
  if (await portOpen(5959)) {
    console.log(c.ok('a server is already listening on 5959; leaving it alone.'));
    return 0;
  }

  let src = findServerSrc();
  if (!src) {
    if (!have('git')) { console.error(c.bad('git is required to fetch the server source.')); return 1; }
    const parent = join(REPO, '..');
    for (const r of SERVER_REPOS) {
      const dest = join(parent, r.name);
      if (existsSync(dest)) continue;
      console.log(`\ncloning ${r.url} ...`);
      // The fork is private; failing over to upstream is the expected path for
      // anyone who is not its owner, so a failure here is not an error.
      if (run('git', ['clone', '--depth', '1', r.url, dest])) { src = dest; break; }
      console.log(c.warn(`  could not clone ${r.name} (private, or no access) — trying the next one`));
    }
    if (!src) src = findServerSrc();
  }
  if (!src) {
    console.error(c.bad('\nno server source, and none could be cloned.'));
    console.error('  clone it yourself and set M59_ROOT:');
    console.error('    git clone https://github.com/Meridian59/Meridian59');
    return 1;
  }
  console.log(`server source: ${src}`);

  if (!dockerReady()) {
    if (have('docker')) {
      console.error(c.bad('\ndocker is installed but its daemon is not responding.'));
      console.error('  start Docker Desktop (Windows/Mac) or `sudo systemctl start docker` (Linux),');
      console.error('  wait for it to finish starting, and run this again.');
    } else {
      console.error(c.bad('\ndocker is not installed.'));
      console.error('  it is the only server path that is the same on Windows and Linux.');
      console.error('  https://docs.docker.com/get-docker/');
    }
    console.error('\n  to build natively instead, see docs/INSTALL.md — Windows needs');
    console.error('  Visual Studio and `nmake`; Linux needs `make -C blakserv -f makefile.linux`.');
    return 1;
  }

  console.log('\nbuilding the server image (first run takes a few minutes)...');
  if (!run('docker', ['build', '-f', join(REPO, 'docker', 'Dockerfile'),
                      '-t', 'm59-blakserv:local', src])) {
    console.error(c.bad('the image build failed. The output above is the reason.'));
    return 1;
  }

  mkdirSync(join(REPO, 'docker', 'data', 'channel'), { recursive: true });
  mkdirSync(join(REPO, 'docker', 'data', 'savegame'), { recursive: true });

  console.log('\nstarting it...');
  if (!run('docker', ['compose', '-f', join(REPO, 'docker', 'docker-compose.yml'), 'up', '-d'])) {
    console.error(c.bad('docker compose failed.'));
    return 1;
  }

  // The server takes a moment to load the kod and open its ports; reporting
  // success before it listens would be a lie the next step trips over.
  process.stdout.write('waiting for :5959 ');
  for (let i = 0; i < 60; i++) {
    if (await portOpen(5959)) {
      console.log(c.ok('\nserver is up: game 5959, admin 9998 (loopback only).'));
      return 0;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error(c.bad('\nthe container started but nothing is listening on 5959.'));
  console.error('  docker compose -f docker/docker-compose.yml logs');
  return 1;
}

// ------------------------------------------------------------------ client

function client() {
  const found = findClient();
  if (found) {
    console.log(c.ok(`steam client: ${found}`));
    console.log(`\n  watch a character:  node tools/m59-fleet.mjs spec <name>`);
    if (!existsSync(join(REPO, 'compendium', 'assets', 'img')))
      console.log(`  decode its sprites: python tools/pull-client-assets.py`);
    return 0;
  }
  console.log(c.warn('no Meridian 59 client install found.'));
  console.log('\nThe client is on Steam, and Steam will not install a game you do not');
  console.log('own or log in on your behalf, so this part is yours:');
  console.log(`\n  https://store.steampowered.com/app/${STEAM_APPID}/Meridian_59/`);
  console.log(`\n  already own it?   steam://install/${STEAM_APPID}`);
  console.log('  on Linux, it runs under Proton — enable it for the title in Steam.');
  console.log('\nThen re-run this. Or point at an install directly:');
  console.log('  M59_CLIENT="/path/to/Meridian 59" node tools/setup.mjs client');
  console.log(c.dim('\nA fleet does not need this. Agents speak the protocol directly;'));
  console.log(c.dim('the client is for watching them, and for the compendium art.'));
  return 0;
}

// ------------------------------------------------------------------ broker

async function broker() {
  if (await portOpen(8901)) {
    console.log(c.ok('a broker is already listening on 8901; leaving it alone.'));
    return 0;
  }
  if (!await portOpen(5959)) {
    console.error(c.bad('no server on 5959 — start it first: node tools/setup.mjs server'));
    return 1;
  }
  console.log('starting the broker (detached)...');
  const out = join(REPO, 'substrate');
  mkdirSync(out, { recursive: true });
  const child = spawn(process.execPath,
    [join(HERE, 'm59-broker.mjs'), '--http', '8901', '--dashboard', '8902'],
    { detached: true, stdio: 'ignore', cwd: REPO });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (await portOpen(8901)) {
      console.log(c.ok('broker up: rpc 8901, dashboard http://127.0.0.1:8902/fleet'));
      return 0;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error(c.bad('the broker did not come up on 8901.'));
  console.error('  run it in the foreground to see why:');
  console.error('    node tools/m59-broker.mjs --http 8901 --dashboard 8902');
  return 1;
}

// ------------------------------------------------------------------ fleet

async function fleet(n) {
  if (!await portOpen(8901)) {
    const rc = await broker();
    if (rc) return rc;
  }
  return run(process.execPath, [join(HERE, 'm59-makefleet.mjs'), '--count', String(n)],
             { cwd: REPO }) ? 0 : 1;
}

// ------------------------------------------------------------------ main

const [cmd = 'doctor', arg] = process.argv.slice(2);
const n = Number(arg) || 10;

const commands = {
  doctor,
  server,
  client: async () => client(),
  broker,
  fleet: () => fleet(n),
  all: async () => {
    let rc = await server(); if (rc) return rc;
    client();
    rc = await broker(); if (rc) return rc;
    return fleet(n);
  },
};

if (!commands[cmd]) {
  console.error(`unknown command: ${cmd}`);
  console.error(`usage: node tools/setup.mjs [doctor|server|client|broker|fleet N|all N]`);
  process.exit(2);
}
process.exit(await commands[cmd]());
