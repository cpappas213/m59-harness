#!/usr/bin/env node
// THE FLEET, IN ONE LINE, FOR THE CLAUDE CODE STATUS BAR.
//
//   node tools/m59-status.mjs            one line
//   node tools/m59-status.mjs --pane     the full board, for a second terminal
//
// Wired in as `statusLine` it runs on every turn and on a refresh interval, so the
// two things that matter are that it is FAST and that it never blocks: a status line
// that hangs makes the whole prompt feel broken, and a broker that is down is a normal
// state rather than an error. Hence the short timeout and the quiet fallback.
//
// What it chooses to show is the argument. Not kills — a kill at or below your own
// level advances nothing — but the numbers that predict whether the next hour will
// produce anything: how many keepers are actually running, how many are behind a
// proven wall, how many are too tired to fight, and how many are stuck.
import { argv, env, stdout } from 'node:process';

const PORT = env.M59_BROKER_PORT || '8901';
const URL_ = `http://127.0.0.1:${PORT}/`;

async function call(name, args = {}, ms = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    return JSON.parse(j.result.content[0].text);
  } catch { return null; } finally { clearTimeout(t); }
}

// ANSI, but only when someone is looking at a terminal. The status line is rendered
// into an existing frame, so bare colour codes are safe; piping to a file is not the
// use case, and dim text beats bold everywhere here.
const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  good: s => `\x1b[32m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`,
  bad: s => `\x1b[31m${s}\x1b[0m`,
  blue: s => `\x1b[34m${s}\x1b[0m`,
};

const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

function summarise(list) {
  const A = list || [];
  const running = A.filter(a => a.running).length;
  const holding = A.filter(a => a.safe_spot).length;
  const proven = A.filter(a => a.safe_spot?.works).length;
  const stalled = A.filter(a => a.stalled).length;
  const spotDeaths = A.reduce((n, a) => n + (a.did?.deaths_in_safe_spot ?? 0), 0);
  const deaths = A.reduce((n, a) => n + (a.did?.deaths ?? 0), 0);
  const kills = A.reduce((n, a) => n + (a.did?.kills ?? 0), 0);
  const mulligans = A.reduce((n, a) => n + (a.did?.mulligans ?? 0), 0);
  const trials = A.flatMap(a => a.trials || []);
  const counted = trials.filter(t => t.counted).length;
  return { n: A.length, running, holding, proven, stalled, deaths, spotDeaths,
           kills, mulligans, trials: trials.length, counted, A };
}

async function oneLine() {
  const l = await call('autopilot', { agent: 'any', action: 'list' });
  if (!l) return C.dim('m59: broker down');
  const s = summarise(l.autopilots);
  const bits = [
    C.blue('m59'),
    `${s.running}/${s.n} up`,
    s.proven ? C.good(`${s.proven} proven wall${s.proven === 1 ? '' : 's'}`)
             : s.holding ? C.warn(`${s.holding} testing`) : C.dim('no walls'),
    `${s.kills}k/${s.deaths}d`,
    s.spotDeaths ? C.bad(`${s.spotDeaths} died in a spot`) : C.good('0 spot deaths'),
    s.mulligans ? C.dim(`${s.mulligans} mull`) : null,
    s.stalled ? C.bad(`${s.stalled} STALLED`) : null,
    C.dim(`${s.counted}/${s.trials} readings count`),
  ].filter(Boolean);
  return bits.join(C.dim(' · '));
}

// THE BOARD. Meant for a second terminal — a tmux pane above the session, or any
// window you can leave open — where there is room to show every character rather
// than a summary. Twenty-five rows plus a header fits in about thirty lines.
async function pane() {
  // The fleet snapshot walks every session and is the slow one — twenty-five
  // characters' worth of vitals and inventory. It gets a real timeout; the pane is a
  // window someone leaves open, not a prompt they are waiting on.
  const [l, f] = await Promise.all([
    call('autopilot', { agent: 'any', action: 'list' }, 8000),
    call('fleet', {}, 15000),
  ]);
  if (!l) { stdout.write('\x1b[2J\x1b[H' + C.bad('broker not answering on ' + URL_) + '\n'); return; }
  const s = summarise(l.autopilots);
  const byAgent = new Map((f?.fleet || []).map(r => [r.agent, r]));

  const rows = s.A.map(a => {
    const r = byAgent.get(a.name) || {};
    const spot = a.safe_spot
      ? (a.safe_spot.works ? C.good('WALL') : C.warn('test'))
      : C.dim('  — ');
    const hp = r.health || '?';
    const vig = (r.vigor_of || '?/200').split('/')[0];
    const flags = `${r.has_weapon ? ' ' : C.bad('!')}${r.has_food ? ' ' : C.warn('f')}`;
    return `  ${String(r.character || a.name).padEnd(10)} ${String(hp).padStart(7)} ` +
           `${String(vig).padStart(4)}v ${flags} ${spot}  ${C.dim(String(a.activity || '').slice(0, 34))}`;
  });

  const head =
    `${C.blue('MERIDIAN 59 FLEET')}  ${s.running}/${s.n} up · ` +
    `${s.proven ? C.good(s.proven + ' proven') : C.dim('0 proven')} · ` +
    `${s.kills} kills · ${s.deaths} deaths · ` +
    `${s.spotDeaths ? C.bad(s.spotDeaths + ' IN A SPOT') : C.good('none in a spot')} · ` +
    `${s.counted}/${s.trials} readings count` +
    (s.stalled ? '  ' + C.bad(s.stalled + ' STALLED') : '');

  stdout.write('\x1b[2J\x1b[H' + head + '\n' +
    C.dim('  character      health vigor  wf spot  doing') + '\n' +
    rows.join('\n') + '\n' +
    C.dim(`  ! no weapon · f no food · ${new Date().toTimeString().slice(0, 8)}`) + '\n');
}

if (argv.includes('--pane')) {
  const every = Number(argv[argv.indexOf('--pane') + 1]) || 5;
  await pane();
  setInterval(pane, every * 1000);
} else {
  stdout.write(await oneLine());
}
