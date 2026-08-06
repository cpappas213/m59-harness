#!/usr/bin/env node
// WATCH A PERSON CROSS A MAP, AND TIME IT.
//
//   node tools/m59-watch.mjs --who Kermit
//   node tools/m59-watch.mjs --who Kermit --room 535
//   node tools/m59-watch.mjs --who Kermit --room 535 --for 300
//   node tools/m59-watch.mjs --list                    who is visible to the fleet right now
//
// WHY. The fleet's own transit record says it takes a median of 51 seconds to cross a
// map and a p99 of nearly five minutes — 285 seconds through West Merchant Way through
// Ilerian Woods in one case. The operator says almost any map in this game goes exit to
// exit in under a minute. Both of those can be true and the gap can be anywhere: the
// router, the pacer, the walk, or an assumption about how fast a character moves at all.
//
// There is exactly one way to settle it, and it is to watch a person do it. This is the
// harness for that. It does not drive anything and it does not touch the character being
// watched — it uses a fleet character standing in the same room as an INSTRUMENT, reading
// the movement packets the server already sends everyone in earshot.
//
// WHAT IT MEASURES
//
//   * every position the watched player was seen at, with a timestamp
//   * total path length in squares, against the straight-line distance — the ratio is how
//     much of the journey was not in the direction of travel
//   * speed: squares per second, sustained and peak, over the moving parts only
//   * where the time went: moving vs standing still, and every pause over a second
//
// The speed number is the one to take away. If a person sustains N squares a second and
// the fleet manages a fraction of that, the fleet's problem is not routing.
//
// HOW IT SEES ANYTHING. `m59-client.mjs` publishes a `player-moved` event for other
// players — added for this, and players only, because every monster in a room emits the
// same packet several times a second and the event ring is shared with combat. The watcher
// polls `wait_for_event` on the observer character, which is read-only and never acts.
//
// PICK AN OBSERVER THAT IS ALREADY THERE. This will not walk a character into the room for
// you: sending a keeper somewhere mid-measurement is the sort of interference that would
// make the number worthless, and a character that walks in late misses the start. Stand
// one there first (or let `--room` find one that already is) and then start running.

const RPC = process.env.M59_RPC || 'http://127.0.0.1:8901/rpc';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

let id = 0;
async function call(name, args = {}, timeoutMs = 120_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    const text = j.result?.content?.[0]?.text;
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
};
const pad = (s, w) => String(s).padEnd(w);

// ------------------------------------------------------------------ finding an observer

async function fleetRows() {
  const f = await call('fleet', {}, 60_000);
  return (f.fleet || f || []).filter(r => r.character);
}

// WHO CAN SEE WHOM. `look` on a character reports the room's contents, and other players
// are in it — so this is how we find a character standing where the action will be, and
// also how we find the watched player without asking the watched player anything.
async function playersVisibleTo(agent) {
  const l = await call('look', { agent }, 60_000).catch(() => null);
  const objs = l?.room?.objects || l?.objects || [];
  return objs.filter(o => o.is_player || /player/i.test(String(o.flags_named || '')) ||
                          o.can?.includes?.('player'))
             .map(o => ({ id: o.id, name: o.name, col: o.col, row: o.row }));
}

// ------------------------------------------------------------------ the measurement

const dist = (a, b) => Math.hypot(a.col - b.col, a.row - b.row);

function summarise(trace, { room = null } = {}) {
  if (trace.length < 2) return { samples: trace.length, note: 'not enough movement to measure' };
  const first = trace[0], last = trace[trace.length - 1];
  const wall = (last.at - first.at) / 1000;

  let path = 0;
  const legs = [];
  for (let i = 1; i < trace.length; i++) {
    const d = dist(trace[i - 1], trace[i]);
    const dt = (trace[i].at - trace[i - 1].at) / 1000;
    path += d;
    legs.push({ d, dt, speed: dt > 0 ? d / dt : null, at: trace[i].at });
  }
  // MOVING TIME, NOT WALL TIME. Standing still is a decision a person makes and is not
  // evidence about how fast the world lets you travel, so the sustained speed is computed
  // over the legs that were actually movement. Both numbers are reported, because the gap
  // between them is itself the answer to "was it slow, or was it stopped".
  const moving = legs.filter(l => l.d > 0 && l.dt > 0);
  const movingTime = moving.reduce((t, l) => t + l.dt, 0);
  const speeds = moving.map(l => l.speed).sort((a, b) => a - b);
  const straight = dist(first, last);
  // A pause is a gap with no movement in it. Anything over a second is worth naming —
  // that is where a client is being fiddled with, or where something interrupted.
  const pauses = legs.filter(l => l.d === 0 && l.dt >= 1)
                     .map(l => ({ at: l.at, seconds: +l.dt.toFixed(1) }));

  return {
    room,
    samples: trace.length,
    seconds_wall: +wall.toFixed(1),
    seconds_moving: +movingTime.toFixed(1),
    seconds_standing_still: +(wall - movingTime).toFixed(1),
    from: { col: first.col, row: first.row },
    to: { col: last.col, row: last.row },
    straight_line_squares: +straight.toFixed(1),
    path_squares: +path.toFixed(1),
    // 1.0 is a straight line. Above about 1.3 the route is wandering, which is a routing
    // observation rather than a speed one.
    wander: straight > 0 ? +(path / straight).toFixed(2) : null,
    squares_per_second: movingTime > 0 ? +(path / movingTime).toFixed(2) : null,
    squares_per_second_peak: speeds.length ? +speeds[speeds.length - 1].toFixed(2) : null,
    squares_per_second_median: speeds.length
      ? +speeds[Math.floor(speeds.length / 2)].toFixed(2) : null,
    pauses,
    // THE NUMBER THIS EXISTS FOR. Given the observed sustained speed, how long SHOULD a
    // crossing of this size take? Anything the fleet spends above this is ours, not the
    // game's.
    note: 'squares_per_second over MOVING time is the baseline. Compare it against the ' +
          'fleet\'s own crossings in m59-transits.mjs — the fleet\'s p99 for room 535 is ' +
          '285 seconds, and a person covering the same ground at this speed is the ' +
          'measurement that says how much of that is the map and how much is us.',
  };
}

// ------------------------------------------------------------------ main

// WATCH WHOEVER TURNS UP. Without this the harness has to be told the character name
// before the person has logged in, which is a round trip in the middle of a demo. Every
// name in the roster is ours, so anything moving that is NOT in it is the person — and if
// they are piloting one of ours, `--who` names it explicitly and this is skipped.
const ANYONE = has('anyone') || String(arg('who', '')).toLowerCase() === 'any';
const who = ANYONE ? null : arg('who');
const roomWanted = arg('room') != null ? Number(arg('room')) : null;
const seconds = Number(arg('for', 600));

const rows = await fleetRows();

if (has('list') || (!who && !ANYONE)) {
  console.log(c.bold('fleet characters, and where they are standing:'));
  const byRoom = new Map();
  for (const r of rows) {
    const k = `${r.room} (${r.room_num})`;
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(r.character);
  }
  for (const [room, names] of [...byRoom.entries()].sort())
    console.log('  ' + pad(room, 46) + names.join(', '));
  console.log('');
  console.log('An observer must ALREADY be standing in the room you mean to run across —');
  console.log('walking one in mid-measurement is the interference that makes the number');
  console.log('worthless. Then:  node tools/m59-watch.mjs --who <your character> --room <n>');
  process.exit(0);
}

// Choose the observer: a fleet character in the requested room, else any that can already
// see the named player.
let observer = null;
if (roomWanted != null) {
  const there = rows.filter(r => r.room_num === roomWanted);
  if (!there.length) {
    console.error(c.red(`no fleet character is standing in room ${roomWanted}.`));
    console.error('Nothing can see that room, so nothing can time it. Options:');
    console.error(`  - run  node tools/m59-watch.mjs --list  and pick a room one is already in`);
    console.error(`  - or park a character there first, then start this and then run`);
    process.exit(1);
  }
  observer = there[0];
  console.log(c.dim(`observer: ${observer.character} (${observer.agent}), already in ` +
                    `${observer.room} — it is not being moved or given orders`));
} else {
  for (const r of rows) {
    const seen = await playersVisibleTo(r.agent);
    if (seen.some(p => String(p.name).toLowerCase() === String(who).toLowerCase())) {
      observer = r; break;
    }
  }
  if (!observer) {
    console.error(c.red(`no fleet character can currently see "${who}".`));
    console.error('Pass --room <n> with a room one of ours is standing in, and run across that.');
    process.exit(1);
  }
  console.log(c.dim(`observer: ${observer.character} (${observer.agent}) in ${observer.room}`));
}

// Everyone in the roster is ours. Used only in --anyone mode, to tell the person from the
// five bots standing in the same room.
const ours = new Set(rows.map(r => String(r.character).toLowerCase()));

console.log(c.bold(`\nwatching ${who ?? 'anyone who is not one of ours'} for up to ` +
                   `${seconds}s — run whenever you are ready.`));
console.log(c.dim('Ctrl-C to stop early and print the summary.\n'));

// In --anyone mode the trace belongs to whoever moved first and is not ours; a second
// stranger walking past must not have their steps folded into the same measurement.
let locked = null;
const trace = [];
let cursor;
let stopped = false;
const finish = () => {
  if (stopped) return;
  stopped = true;
  const sum = summarise(trace, { room: observer.room });
  console.log('\n' + c.bold('--- summary ---'));
  console.log(JSON.stringify(sum, null, 1));
  process.exit(0);
};
process.on('SIGINT', finish);

const until = Date.now() + seconds * 1000;
while (Date.now() < until && !stopped) {
  const r = await call('wait_for_event',
                       { agent: observer.agent, since: cursor,
                         kinds: ['player-moved'], timeout_ms: 5000 }, 30_000)
              .catch(e => ({ events: [], error: e.message }));
  cursor = r.cursor ?? cursor;
  for (const ev of r.events || []) {
    const name = String(ev.who ?? '').toLowerCase();
    if (who) {
      if (name !== String(who).toLowerCase()) continue;
    } else {
      if (!name || ours.has(name)) continue;          // one of ours, not the person
      if (!locked) { locked = name; console.log(c.cyan(`  locked on "${ev.who}"\n`)); }
      if (name !== locked) continue;
    }
    const prev = trace[trace.length - 1];
    trace.push({ at: ev.at, col: ev.col, row: ev.row });
    const d = prev ? dist(prev, { col: ev.col, row: ev.row }) : 0;
    const dt = prev ? (ev.at - prev.at) / 1000 : 0;
    console.log('  ' + pad(new Date(ev.at).toISOString().slice(11, 23), 14) +
                pad(`${ev.col},${ev.row}`, 10) +
                (prev ? c.dim(`+${d.toFixed(1)} sq in ${dt.toFixed(2)}s` +
                              (dt > 0 ? ` = ${(d / dt).toFixed(2)} sq/s` : '')) : c.cyan('start')));
  }
}
finish();
