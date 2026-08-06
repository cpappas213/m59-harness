#!/usr/bin/env node
// THE FLEET, IN A TERMINAL YOU CAN DRIVE.
//
//   node tools/m59-tui.mjs
//
// The dashboard answers "how is the fleet doing?" from a browser, and a browser is the
// wrong place to end that question. What you actually want to do next is start the
// game as one of these characters, and a web page cannot start a program — it can only
// offer you a script to copy somewhere else. A terminal has no such problem.
//
// So this is the same information with the last step joined on: arrow keys to pick a
// character, Enter for its full sheet, L to LAUNCH the client logged in as it with the
// agent DLL injected, C to open the COMPENDIUM with that character's real numbers in
// it. No copying, no pasting.
//
// Zero dependencies and no framework. It draws with ANSI, reads raw keys, and repaints
// the whole screen on a timer — twenty-five rows is far too little to need anything
// cleverer, and a dependency here would be a dependency in the one tool you reach for
// when things are already broken.
import { stdin, stdout, env, exit, argv } from 'node:process';
import { spawn } from 'node:child_process';
import { readFileSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { ensureServing, openBrowser, importUrl, COMPENDIUM_PORT } from './m59-compendium.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Which roster this TUI is looking at. Must match the broker it is talking to —
// pass --fleet <name> to both, or neither.
const { label: FLEET_LABEL, stateFile: STATE_FILE } = resolveFleet();

const PORT = env.M59_BROKER_PORT || '8901';
const URL_ = `http://127.0.0.1:${PORT}/`;
const REFRESH_MS = Number(env.M59_TUI_REFRESH_MS || 5000);

// ------------------------------------------------------------------ broker

async function call(name, args = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) return { __error: j.result.content[0].text };
    return JSON.parse(j.result.content[0].text);
  } catch (e) { return { __error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ drawing

const ESC = '\x1b[';
const alt = on => stdout.write(on ? ESC + '?1049h' : ESC + '?1049l');
const cursor = on => stdout.write(on ? ESC + '?25h' : ESC + '?25l');
const home = () => stdout.write(ESC + 'H');
const clear = () => stdout.write(ESC + '2J' + ESC + 'H');

const c = {
  dim: s => `${ESC}2m${s}${ESC}0m`,
  bold: s => `${ESC}1m${s}${ESC}0m`,
  green: s => `${ESC}32m${s}${ESC}0m`,
  red: s => `${ESC}31m${s}${ESC}0m`,
  yellow: s => `${ESC}33m${s}${ESC}0m`,
  blue: s => `${ESC}34m${s}${ESC}0m`,
  cyan: s => `${ESC}36m${s}${ESC}0m`,
  inv: s => `${ESC}7m${s}${ESC}0m`,
};
// Width without the escape sequences, so padding lines up once colour is applied.
const wide = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wide(s)));
const cut = (s, n) => (wide(s) <= n ? s : s.slice(0, n - 1) + '…');

// The same five-square bar the fleet page draws, for the same reason: fixed width so
// the column stays scannable, colour carrying the value.
function bar(value, max, blue = false) {
  if (!max || value == null) return c.dim('█████');
  const p = Math.max(0, Math.min(1, value / max));
  let out = '';
  for (let i = 1; i <= 5; i++) {
    const top = i / 5, bottom = (i - 1) / 5;
    out += p >= top ? (blue ? c.blue('█') : c.green('█'))
         : p > bottom ? c.yellow('█') : c.red('█');
  }
  return out;
}
const num = s => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s ?? ''));
  return m ? { v: +m[1], max: +m[2] } : { v: null, max: null };
};

// ------------------------------------------------------------------ state

const S = {
  view: 'list',          // 'list' | 'hero'
  sel: 0,
  rows: [],              // merged autopilot + fleet rows
  hero: null,
  detail: null,
  status: '',
  loading: true,
  lastError: null,
};

async function refresh() {
  const [l, f] = await Promise.all([call('autopilot', { agent: 'any', action: 'list' }, 8000),
                                    call('fleet', {}, 15000)]);
  if (l?.__error) { S.lastError = 'broker: ' + l.__error; S.loading = false; return; }
  S.lastError = null;
  const by = new Map((f?.fleet || []).map(r => [r.agent, r]));
  S.rows = (l.autopilots || []).map(a => ({ ...by.get(a.name), agent: a.name, ap: a }))
    .sort((x, y) => (y.level ?? 0) - (x.level ?? 0));
  if (S.sel >= S.rows.length) S.sel = Math.max(0, S.rows.length - 1);
  S.loading = false;
}

async function loadHero(row) {
  S.detail = { loading: true };
  draw();
  const [inv, ab] = await Promise.all([
    call('inventory', { agent: row.agent }, 8000),
    call('abilities', { agent: row.agent }, 8000),
  ]);
  S.detail = { loading: false, inv: inv?.items || [], skills: ab?.skills || [], spells: ab?.spells || [] };
}

// ------------------------------------------------------------------ views

function listView() {
  const L = [];
  const up = S.rows.filter(r => r.ap?.running).length;
  const walls = S.rows.filter(r => r.ap?.safe_spot?.works).length;
  const dead = S.rows.filter(r => r.in_game === false).length;
  const spotDeaths = S.rows.reduce((n, r) => n + (r.ap?.did?.deaths_in_safe_spot ?? 0), 0);

  L.push(c.bold(c.cyan('  MERIDIAN 59 FLEET')) + '   ' + c.dim([
    `${up}/${S.rows.length} keepers up`,
    walls ? c.green(`${walls} proven walls`) : c.dim('0 proven walls'),
    dead ? c.red(`${dead} NOT IN GAME`) : c.green('all in game'),
    spotDeaths ? c.red(`${spotDeaths} died in a spot`) : c.green('0 spot deaths'),
  ].join(' · ')));
  L.push('');
  L.push(c.dim('  ' + pad('character', 11) + pad('lvl', 4) + pad('health', 14) +
               pad('mana', 13) + pad('vigor', 14) + pad('w/f', 5) + pad('spot', 7) + 'doing'));

  for (let i = 0; i < S.rows.length; i++) {
    const r = S.rows[i];
    const hp = num(r.health), mp = num(r.mana), vg = num(r.vigor_of);
    const spot = r.ap?.safe_spot
      ? (r.ap.safe_spot.works ? c.green('WALL ') : c.yellow('test '))
      : c.dim('  -  ');
    const wf = (r.has_weapon ? c.green('w') : c.red('w')) + (r.has_food ? c.green('f') : c.red('f'));
    // THE ONE A CLIENT IS HOLDING. Worth marking because everything else on this row
    // reads as a fault when it is true: the keeper is deliberately stopped while a person
    // plays, so "no keeper", zero kills and a stalled activity are all correct and none
    // of them are a problem to go and fix.
    const mine = !!r.piloted;
    const line =
      pad(mine ? c.cyan(r.character ?? r.agent) : (r.character ?? r.agent), 11) +
      pad(String(r.level ?? '?'), 4) +
      pad(bar(hp.v, hp.max) + ' ' + c.dim(pad(r.health ?? '—', 7)), 14) +
      pad(bar(mp.v, mp.max, true) + ' ' + c.dim(pad(r.mana ?? '—', 6)), 13) +
      pad(bar(vg.v, vg.max) + ' ' + c.dim(pad(String(vg.v ?? '—'), 7)), 14) +
      pad(wf, 5) + pad(spot, 7) +
      (mine ? c.cyan('YOU — ') : '') + c.dim(cut(r.ap?.activity ?? '', mine ? 28 : 34));
    // Two different marks in one gutter: ▸ is where the cursor is, ◆ is where the person
    // is. They are independent — you can be scrolled somewhere else entirely — so one
    // must not hide the other.
    const gutter = i === S.sel ? c.inv(mine ? '◆ ' : '▸ ') : (mine ? c.cyan('◆ ') : '  ');
    L.push(gutter + line);
  }
  L.push('');
  L.push(c.dim('  ↑↓/jk move · ⏎ open · L launch client · C compendium for the selected · r refresh · q quit'));
  if (S.status) L.push('  ' + S.status);
  if (S.lastError) L.push('  ' + c.red(S.lastError));
  return L;
}

function heroView() {
  const r = S.hero;
  const a = r.ap || {};
  const L = [];
  const hp = num(r.health), mp = num(r.mana), vg = num(r.vigor_of);
  L.push(c.bold(c.cyan('  ' + (r.character ?? r.agent))) + '  ' +
         c.dim(`${r.agent} · ${a.policy?.strategy ?? '—'} · ${r.room ?? '?'} [room ${r.room_num ?? '?'}]`));
  L.push('');
  L.push('  ' + pad('health', 9) + bar(hp.v, hp.max) + '  ' + pad(r.health ?? '—', 10) +
         c.dim('max health is the level'));
  L.push('  ' + pad('mana', 9) + bar(mp.v, mp.max, true) + '  ' + pad(r.mana ?? '—', 10));
  L.push('  ' + pad('vigor', 9) + bar(vg.v, vg.max) + '  ' + pad(r.vigor_of ?? '—', 10) +
         c.dim('resting alone stops at 80'));
  L.push('');
  L.push('  ' + c.dim('doing    ') + (a.activity ?? '—'));
  L.push('  ' + c.dim('weapon   ') + (r.has_weapon ? c.green('yes') : c.red('NO — punching things')) +
         c.dim('   food  ') + (r.has_food ? c.green('yes') : c.red('NO — vigor capped at 80')));
  L.push('  ' + c.dim('carrying ') + `${r.carrying ?? '?'} / ${a.policy?.maxCarry ?? '?'}`);
  L.push('');

  const s = a.safe_spot;
  L.push(c.bold('  SAFE SPOT'));
  if (s) {
    L.push('  ' + c.dim('at       ') + `${s.at.col},${s.at.row}  ` +
           (s.works ? c.green('holds under attack') : c.yellow('untested')));
    L.push('  ' + c.dim('evidence ') + cut(s.evidence, 68));
    L.push('  ' + c.dim('on us    ') +
           `${a.threat?.in_swing_range ?? 0} in range, ${a.threat?.camped_on_us ?? 0} camped ` +
           c.dim((a.threat?.what || []).join(', ')));
  } else L.push(c.dim('  not holding one'));
  L.push('');

  L.push(c.bold('  SURVIVAL') + c.dim(`   ${a.did?.deaths ?? 0} deaths · ` +
    `${a.did?.deaths_in_safe_spot ?? 0} in a safe spot · ${a.did?.mulligans ?? 0} mulligans · ` +
    `${a.did?.logoffs ?? 0} logoffs`));
  L.push('');

  const d = S.detail;
  if (d?.loading) L.push(c.dim('  loading pack…'));
  else if (d) {
    L.push(c.bold('  CARRYING') + '  ' +
      c.dim(d.inv.length ? d.inv.map(i => i.name + (i.amount ? ` x${i.amount}` : '')).join(', ') : 'nothing'));
    const ab = [...d.skills.map(x => x.name), ...d.spells.map(x => x.name)];
    L.push(c.bold('  KNOWS   ') + '  ' + c.dim(ab.length ? ab.join(', ') : 'nothing'));
  }
  L.push('');
  L.push(c.bold('  READINGS') + c.dim('  the safe-spot experiment, newest last'));
  for (const t of (a.trials || []).slice(-6))
    L.push('   ' + (t.counted ? (/HIT/.test(t.verdict) ? c.red('counted') : c.green('counted'))
                              : c.dim('skipped')) + ' ' + c.dim(cut(t.verdict, 66)));
  L.push('');
  L.push(c.bold('  RECENT'));
  for (const e of (a.recent || []).slice(-8)) L.push('   ' + c.dim(cut(e.what, 74)));
  L.push('');
  L.push(c.dim('  ⏎/q back · ') + c.bold(c.yellow('L')) + c.dim(' LAUNCH the client as this character · r refresh'));
  if (S.status) L.push('  ' + S.status);
  return L;
}

function draw() {
  const lines = S.loading ? [c.dim('  talking to the broker…')]
              : S.view === 'hero' ? heroView() : listView();
  const rows = stdout.rows || 40;
  home();
  const out = [];
  for (let i = 0; i < rows - 1; i++) out.push((lines[i] ?? '') + ESC + 'K');
  stdout.write(out.join('\n'));
}

// ------------------------------------------------------------------ launching
//
// THE POINT OF BEING IN A TERMINAL. A web page can offer a script; a terminal can run
// it. This starts the real client already logged in as the selected character and then
// injects the agent DLL, so the same character is playable by hand AND drivable by the
// MCP — which is the thing that was worth five minutes of copy-paste every time.
function launch(row) {
  const creds = rosterFor(row.agent);
  if (!creds) { S.status = c.red('no credentials on file for ' + row.agent); return; }
  const exe = env.M59_CLIENT_EXE ||
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Meridian 59\\Meridian.exe';
  // THE CHARACTER'S OWN SERVER, not this machine's.
  //
  // A roster entry records the host and port it was joined against, because a fleet is
  // per-server and one broker can hold characters on several. Reading the environment
  // instead sent the client to 127.0.0.1 for every character in it — fine while the
  // only server was local, and silently wrong the moment one was not. It does not fail
  // cleanly either: the client opens, finds nothing on that port, and sits there, which
  // reads as the launch key doing nothing rather than as connecting to the wrong place.
  //
  // The environment stays as the fallback for a roster written before host and port
  // were recorded.
  const host = creds.host || env.M59_HOST || '127.0.0.1';
  const port = String(creds.port || env.M59_PORT || '5959');
  const inject = join(REPO, 'tools', 'm59-inject.ps1');
  // LAUNCH IT FROM ITS OWN DIRECTORY. The client resolves `resource\` relative to the
  // working directory, so started from the repo it cannot find the module DLLs it is
  // told to load and takes an access violation shortly after BP_LOAD_MODULE — which
  // reads as a stall, because the last thing on the wire is a healthy ping exchange.
  // Start-Process inherits OUR cwd unless told otherwise, so it has to be told.
  const args = [`'/H:${host}'`, `'/P:${port}'`,
                `'/U:${creds.account}'`, `'/W:${creds.password}'`, `'/Q'`];
  // /S means "this is a Steam install" and stops the client reading a download_time of
  // 9999 as a real download (config.c:445-470); without it a Steam build tries to patch
  // itself instead of connecting. Both of these are settled in m59-fleet.mjs — this is
  // the same launch, and the two must not drift.
  if (/steam/i.test(exe)) args.push(`'/S'`);
  // Start the client, give it time to come up, then inject. Done in one detached
  // PowerShell so closing this TUI does not take the client with it.
  const ps = [
    `Write-Output "=== $(Get-Date -Format o) launching `
      + `${row.character ?? row.agent} (${creds.account}) ==="`,
    `if (-not (Test-Path '${exe}')) { Write-Output 'NO CLIENT AT THAT PATH'; exit 1 }`,
    `$p = Start-Process -FilePath '${exe}' -WorkingDirectory '${dirname(exe)}' `
      + `-ArgumentList ${args.join(',')} -PassThru`,
    // WAIT FOR THE WINDOW RATHER THAN GUESSING AT IT. A fixed sleep was the reason this
    // key looked broken: a cold Steam start takes upwards of fifteen seconds to become
    // a process with a window, the injector ran at six, found nothing, and exited 1 —
    // leaving a client that is perfectly playable by hand and invisible to the MCP,
    // which is the exact failure that is easiest to misread as "L did nothing".
    // Wait on OUR pid, not on "any Meridian": several clients run at once here, and
    // waiting for any of them returns instantly when one is already up, injecting into
    // the old client and leaving the new one bare. Injection itself is idempotent —
    // m59-inject.ps1 skips a client that already carries the module — so the sweep it
    // does afterwards is safe.
    // CLAIM THE CHARACTER THE MOMENT THE CLIENT EXISTS, and do it from here rather
    // than from the TUI: this script already holds the pid, and it runs whether or not
    // the terminal is still open. The claim stops the keeper and tells the reconciler
    // to leave the character alone; the broker then polls this pid and gives the
    // character back on its own when the client is closed.
    `$body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pilot",'`
      + `+ '"arguments":{"action":"claim","agent":"${row.agent}","pid":' + $p.Id + '}}}'`,
    `try { Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/' -Method Post `
      + `-ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null; `
      + `Write-Output "claimed ${row.agent} for pid $($p.Id)" } `
      + `catch { Write-Output "pilot claim FAILED: $_" }`,
    `$t=0; while ($t -lt 120 -and -not $p.HasExited -and $p.MainWindowHandle -eq 0) `
      + `{ Start-Sleep -Milliseconds 500; $p.Refresh(); $t++ }`,
    `Write-Output "waited $($t*0.5)s for a window; pid $($p.Id); exited $($p.HasExited)"`,
    // A window exists; give it a moment to finish coming up before writing to it.
    'Start-Sleep -Seconds 3',
    `& powershell -NoProfile -ExecutionPolicy Bypass -File '${inject}'`,
  ].join('; ');
  // KEEP THE OUTPUT. Throwing it away is what made a failed launch indistinguishable
  // from a slow one — the injector reports its verdict on stdout and exits 1 on trouble,
  // and with stdio ignored none of that survived to be read. It goes to a log instead,
  // which the status line names so there is somewhere to look.
  const logPath = join(REPO, 'substrate', 'm59-launch.log');
  let stdio = 'ignore';
  try { const fd = openSync(logPath, 'a'); stdio = ['ignore', fd, fd]; } catch { /* keep going */ }
  // NOT detached — that is what made this key do nothing at all. `detached: true` on
  // Windows means DETACHED_PROCESS, which gives the child no console; powershell.exe
  // needs one and dies on the spot, before running a single statement. With stdio
  // ignored as well, it failed in perfect silence. Verified directly: a detached
  // PowerShell told to write a file never wrote it, while the same command attached
  // ran fine.
  //
  // Nothing is lost by staying attached. The client is started by Start-Process, which
  // makes it a process of its own that outlives all of this regardless, and unref lets
  // the TUI exit whenever it likes. Only the ~20s launcher is tied to us now.
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                      { stdio, windowsHide: true });
  child.unref();
  child.on('error', e => { S.status = c.red('could not start powershell: ' + e.message); draw(); });
  S.status = c.green(`launching ${row.character ?? row.agent}…`) + ' ' +
             c.dim('~20s · log: substrate\\m59-launch.log · keep the client focused or it drops movement');
}

// The same path the L key takes, without the terminal:
//
//   node tools/m59-tui.mjs --launch q4
//
// A full-screen app is the worst place from which to diagnose a launch, because the
// thing that went wrong is on a stream the app is not showing. This runs the identical
// function and prints where the log is.
const li = argv.indexOf('--launch');
if (li >= 0) {
  const agent = argv[li + 1];
  if (!agent) { console.error('usage: m59-tui.mjs --launch <agent>'); exit(2); }
  launch({ agent });
  console.log(S.status.replace(/\x1b\[[0-9;]*m/g, ''));
  exit(0);
}

// The roster is the only place the passwords live, and it is read here rather than
// fetched, because the broker deliberately does not serve them over the network.
function rosterFor(agent) {
  try {
    // Resolved from this file and the --fleet flag, never from cwd. The TUI is often
    // launched from somewhere else entirely — from a parent repository that vendors
    // this one, or by a shortcut with no working directory set. Reading cwd gave a
    // missing file, which this reports as "no credentials" — indistinguishable from
    // a character that genuinely has none.
    const f = STATE_FILE;
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return s[agent]?.credentials ?? null;
  } catch { return null; }
}

// ------------------------------------------------------------- the compendium
//
// The compendium's bestiary already recalculates every row against a reference
// character — but that character is a preset you type in by hand, and the real one is
// on the line above the cursor. So C hands it over: it starts the loopback server if
// nothing is serving, then opens the browser at an endpoint that reads the character
// out of the broker, sets a cookie with it, and redirects to the bestiary.
//
// A character not in game gets the compendium anyway, without the import. The pages
// are worth reading on their own, and an error page would be a worse answer to a key
// than a working one with a note.
async function compendium(row) {
  const live = row?.in_game !== false && row?.agent;
  S.status = c.dim('opening the compendium…');
  draw();
  try {
    const how = await ensureServing(COMPENDIUM_PORT);
    const url = live ? importUrl(row.agent, '/creatures/', COMPENDIUM_PORT)
                     : `http://127.0.0.1:${COMPENDIUM_PORT}/creatures/`;
    openBrowser(url);
    S.status = c.green(how.already ? 'compendium already serving' : 'started the compendium')
      + ' ' + c.dim(`· 127.0.0.1:${COMPENDIUM_PORT} · `)
      + (live ? c.cyan(`bestiary computed for ${row.character ?? row.agent}`)
              : c.yellow('no character imported — that one is not in game'));
  } catch (e) {
    S.status = c.red('compendium: ' + e.message);
  }
  draw();
}

// ------------------------------------------------------------------ keys

function onKey(str, key) {
  if (key.ctrl && key.name === 'c') return quit();
  if (S.view === 'list') {
    if (key.name === 'q' || key.name === 'escape') return quit();
    if (key.name === 'down' || key.name === 'j') S.sel = Math.min(S.rows.length - 1, S.sel + 1);
    else if (key.name === 'up' || key.name === 'k') S.sel = Math.max(0, S.sel - 1);
    else if (key.name === 'return') {
      S.hero = S.rows[S.sel]; S.view = 'hero'; S.status = '';
      loadHero(S.hero).then(draw);
    } else if (str === 'L' || str === 'l') launch(S.rows[S.sel]);
    else if (str === 'C' || str === 'c') compendium(S.rows[S.sel]);
    else if (str === 'r') { S.status = c.dim('refreshing…'); refresh().then(draw); }
  } else {
    if (key.name === 'q' || key.name === 'escape' || key.name === 'return') {
      S.view = 'list'; S.detail = null; S.status = '';
    } else if (str === 'L' || str === 'l') launch(S.hero);
    else if (str === 'C' || str === 'c') compendium(S.hero);
    else if (str === 'r') { refresh().then(() => { S.hero = S.rows.find(r => r.agent === S.hero.agent) ?? S.hero; draw(); }); }
  }
  draw();
}

function quit() {
  clearInterval(timer);
  cursor(true); alt(false);
  exit(0);
}

// ------------------------------------------------------------------ go

alt(true); cursor(false); clear();
const readline = await import('node:readline');
readline.emitKeypressEvents(stdin);
if (stdin.isTTY) stdin.setRawMode(true);
stdin.on('keypress', onKey);
stdout.on('resize', draw);

draw();
await refresh();
draw();
const timer = setInterval(async () => {
  await refresh();
  if (S.view === 'hero') S.hero = S.rows.find(r => r.agent === S.hero?.agent) ?? S.hero;
  draw();
}, REFRESH_MS);
