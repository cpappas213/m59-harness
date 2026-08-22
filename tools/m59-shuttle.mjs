#!/usr/bin/env node
// SHUTTLE THE FLEET BETWEEN TWO ROOMS, OVER AND OVER, AND WRITE DOWN WHERE IT STOPS.
//
//   node tools/m59-shuttle.mjs --laps 4                  Castle Victoria <-> Tos, four laps
//   node tools/m59-shuttle.mjs --laps 8 --a 38 --b 50
//   node tools/m59-shuttle.mjs --dry-run                 who would go where, sends nothing
//   node tools/m59-shuttle.mjs --report                  what previous runs found
//
// THE QUESTION IS NOT "DOES TRAVEL WORK". It is WHERE it stops working, and that needs the
// same road walked enough times for the failures to repeat. One journey that stalls is an
// anecdote; the fourth character to stall in the same room is a bug with an address.
//
// SO THE OUTPUT IS A HISTOGRAM, NOT A VERDICT. Every leg records the room it gave up in,
// the reason the mover gave, and the rooms it did reach — and the summary sorts by which
// room ate the most journeys. That is the thing you can go and look at.
//
// WHY BOTH DIRECTIONS, ALWAYS. `exits are not doors and are not 1:1` (docs/m59-routing.md):
// a route that works one way and fails the other is the normal case, not evidence of a
// one-way door, and a shuttle that only ever measured A->B would call that a flaky route.
// Each lap sends every character to the far end and then swaps, so both directions get the
// same number of attempts from the same bodies.
//
// IT REFUSES A GAME SERVER THAT IS NOT LOOPBACK. This drives characters in circles for
// as long as you ask it to, which is a fine thing to do to a lab fleet and not a thing to
// do to a shared server with other players on it. The check is on the BROKER'S OWN
// /health, not on a port number or a fleet label, because two checkouts can each hold a
// fleet called `prod` and only the endpoint says which server the bodies are actually on.
// Same rule, and the same reason, as m59-dm.mjs.
//
// IT PUTS THE FLEET BACK. Parked characters are unparked to travel and re-parked at the
// end — including on Ctrl-C — because a fleet left mid-shuttle keeps walking after the
// instrument has gone, and the next person to look finds twenty-one characters in the
// wrong place with nothing to explain it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BOOK = join(REPO, 'substrate', 'shuttle-runs.json');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};

const PORT    = Number(flag('port', process.env.M59_BROKER_PORT || 8971));
const A       = Number(flag('a', 38));           // Castle Victoria
const B       = Number(flag('b', 50));           // The Streets of Tos
const LAPS    = Number(flag('laps', 4));
const MAX_MS  = Number(flag('max-ms', 600000));  // per leg
const POLL_MS = Number(flag('poll-ms', 5000));
const ONLY    = flag('agents', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const DRY     = has('dry-run');

// CV-side and Tos-side are NEIGHBOURHOODS, not single rooms. A character upstairs in the
// castle (39) or outside it (2) is at the A end for the purpose of "which way should this
// one go first"; sending it to 38 as its first leg would be a no-op disguised as a pass.
const NEAR_A = new Set([38, 39, 2]);
const NEAR_B = new Set([50, 52, 586]);

const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

// ------------------------------------------------------------------ transport
// Same one-socket-per-request shape as m59-circuit.mjs, and for the same reason: pooled
// keep-alive sockets left open at process.exit() crash Node on Windows with an assertion,
// AFTER the output has printed correctly. See the long note in that file.
function postJson(port, payload, timeoutMs) {
  return new Promise((done) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: timeoutMs,
    }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(); done({ error: `no reply within ${timeoutMs}ms` }); });
    req.on('error', e => done({ error: e.message }));
    req.end(body);
  });
}

function getJson(port, path, timeoutMs = 5000) {
  return new Promise((done) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { connection: 'close' }, agent: false, timeout: timeoutMs }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => { try { done(JSON.parse(text)); } catch { done(null); } });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

async function call(name, args, timeoutMs = 120000) {
  const r = await postJson(PORT, { jsonrpc: '2.0', id: 1, method: 'tools/call',
                                   params: { name, arguments: args } }, timeoutMs);
  if (r.error) return { _error: r.error };
  try {
    const j = JSON.parse(r.text);
    if (j.error) return { _error: j.error.message };
    try { return JSON.parse(j.result?.content?.[0]?.text ?? '{}'); }
    catch { return { _text: j.result?.content?.[0]?.text }; }
  } catch (e) { return { _error: 'bad json: ' + e.message }; }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// ------------------------------------------------------------------ report only
if (has('report')) {
  const book = load();
  if (!book.runs.length) { console.log('no shuttle runs recorded yet'); process.exit(0); }
  for (const r of book.runs.slice(-20)) {
    console.log(`${new Date(r.at).toISOString().slice(0, 16)}  ${r.a}<->${r.b}  ` +
      `${r.laps} lap(s)  ${r.legs} leg(s)  ${r.arrived}/${r.legs} arrived  ` +
      `${r.deaths} death(s)`);
    for (const [room, n] of (r.stuck_rooms ?? []).slice(0, 5))
      console.log(`      stuck in ${room}: ${n}`);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ preflight
const health = await getJson(PORT, '/health');
if (!health?.ok) {
  console.error(`shuttle: no broker answering on 127.0.0.1:${PORT}.`);
  console.error(`         start one:  node tools/m59-service.mjs start --fleet shadow --http 8971 --dashboard 8972`);
  process.exit(1);
}

// THE REFUSAL. Read the endpoint the sessions are actually on, never the fleet label.
const endpoints = Object.values(health.session_game_servers ?? {});
const hosts = [...new Set(endpoints.map(e => String(e.host).toLowerCase()))];
if (!hosts.length) {
  console.error('shuttle: the broker reports no session endpoints — nothing is logged in.');
  process.exit(1);
}
const offside = hosts.filter(h => !LOOPBACK.has(h));
if (offside.length) {
  console.error(`shuttle: REFUSING. This broker's characters are on ${offside.join(', ')}, which is not loopback.`);
  console.error(`         Walking a fleet in circles is for a lab server. Point --port at one.`);
  process.exit(2);
}

console.log(`shuttle: fleet "${health.fleet}" on ${hosts.join(', ')} via broker :${PORT}`);
console.log(`         ${A} <-> ${B}, ${LAPS} lap(s), ${MAX_MS / 1000}s per leg\n`);

// m59-circuit.mjs reads its port from the environment at module load, so it has to be set
// before the import rather than after it.
process.env.M59_BROKER_PORT = String(PORT);
const circuit = await import('./m59-circuit.mjs');

// ------------------------------------------------------------------ who, and which way
const fleet = await call('fleet', {});
// `r.character` as well as `r.agent`: a character caught between logout and rejoin is in
// the fleet list with its name, level and room still null, and planning a leg for it puts
// a row reading `null  undefined  -> 38` in the results — a leg that can never arrive,
// counted against the road. Same trap m59-shadow.mjs's snapshot hit.
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character && r.room_num != null);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
if (!rows.length) { console.error('shuttle: no characters matched.'); process.exit(1); }

// A character already at the A end goes to B first; everybody else goes to A first. That
// includes the ones at neither end — they join the shuttle from wherever they are, which
// is the honest starting condition and also the one most likely to break something.
const plan = rows.map(r => ({
  agent: r.agent, character: r.character,
  room: r.room_num, room_name: r.room,
  target: NEAR_A.has(r.room_num) ? B : A,
}));

console.log('  character    at                              first leg');
for (const p of plan)
  console.log(`  ${String(p.character).padEnd(12)} ${String(p.room_name).slice(0, 30).padEnd(31)} -> ${p.target}` +
    (NEAR_A.has(p.room) || NEAR_B.has(p.room) ? '' : '   (neither end)'));

if (DRY) { console.log('\n--dry-run: nothing was sent.'); process.exit(0); }

// ------------------------------------------------------------------ unpark, and put back
// Remembered per character rather than assumed fleet-wide: some may be parked and some not,
// and re-parking one that was never parked leaves the fleet in a state nobody chose. The
// confinement is read in the same pass for the same reason.
const wasParked = new Set();
const confinedTo = new Map();
for (const p of plan) {
  const st = await call('autopilot', { agent: p.agent, action: 'status' }, 30000);
  if (st?.parked) wasParked.add(p.agent);
  const c = st?.policy?.confineRooms ?? st?.policy?.confine_rooms ?? null;
  if (Array.isArray(c) && c.length) confinedTo.set(p.agent, c.map(Number));
}
if (wasParked.size) {
  console.log(`\nunparking ${wasParked.size} character(s) so they can travel`);
  for (const a of wasParked) await call('autopilot', { agent: a, action: 'unpark' }, 30000);
}

// A CONFINED CHARACTER IS NOT A STUCK ONE, AND THE INSTRUMENT MUST NOT CONFLATE THEM.
//
// `confine_rooms` is honoured by the journey: a destination outside the list is refused
// outright, before a step is taken. That is the operator's instruction working, not the
// travel code failing — but it is invisible from here, because `travel` with
// `background: true` returns `{started: true}` for exactly the request that the FOREGROUND
// call answers `{refused: true, confined: true}`. The background arm discards the job's
// promise, and the refusal is in that promise (m59-broker.mjs, the `if (a.background)`
// branch of `travel`). Reproduced on two characters, three calls each, deterministic.
//
// So this measured 10 of 21 legs as "stopped being busy without arriving" in the room they
// started in, and every one of them was a refusal nobody was told about. Ask the policy
// directly rather than trusting the reply.
if (confinedTo.size)
  console.log(`\n${confinedTo.size} character(s) are confined; e.g. ` +
    `${[...confinedTo][0][0]} -> ${JSON.stringify([...confinedTo][0][1])}`);

const FREE = has('free');
const freed = [];
if (FREE && confinedTo.size) {
  console.log(`--free: lifting the confinement for the run, and putting it back afterwards`);
  for (const [agent, rooms] of confinedTo) {
    const r = await call('autopilot', { agent, confine_rooms: [] }, 30000);
    if (!r?._error) freed.push([agent, rooms]);
  }
  console.log(`        lifted on ${freed.length} of ${confinedTo.size}`);
}

let restoring = false;
async function restore() {
  if (restoring) return;
  restoring = true;
  // The confinement goes back FIRST. It is the operator's standing instruction and the
  // reason it exists is that journeys out of it were killing characters; a crash between
  // the two restores should leave a parked-but-confined fleet, never a freed one.
  if (freed.length) {
    console.log(`\nrestoring the confinement on ${freed.length} character(s)`);
    for (const [agent, rooms] of freed)
      await call('autopilot', { agent, confine_rooms: rooms }, 30000).catch(() => {});
  }
  if (!wasParked.size) return;
  console.log(`re-parking ${wasParked.size} character(s)`);
  for (const a of wasParked) await call('autopilot', { agent: a, action: 'park' }, 30000).catch(() => {});
}
process.on('SIGINT', async () => { console.log('\n^C — putting the fleet back'); await restore(); process.exit(130); });

// ------------------------------------------------------------------ the laps
const legs = [];
for (let lap = 1; lap <= LAPS; lap++) {
  console.log(`\n=== lap ${lap} of ${LAPS} ===`);
  const results = await Promise.all(plan.map(async (p) => {
    // Answered here rather than by watching a character fail to move for twenty seconds.
    // A refusal is a fact the broker already knows and will not volunteer over the
    // background arm; spending a leg's worth of wall clock rediscovering it, and then
    // filing it under the same word as a real stall, is how this looked like a travel bug.
    const confine = FREE ? null : confinedTo.get(p.agent);
    if (confine && !confine.includes(p.target)) {
      const now = await call('status', { agent: p.agent }, 30000);
      return { lap, character: p.character, agent: p.agent, to: p.target,
               from: now?.room?.num ?? p.room, arrived: false, refused: true, ms: 0,
               rooms: [], swings: 0, deaths: 0,
               why: `refused: confined to ${confine.join('/')}`, stuck_in: null };
    }
    const r = await circuit.runLeg(p.agent, p.target, { pollMs: POLL_MS, maxMs: MAX_MS });
    return { lap, character: p.character, ...r };
  }));

  for (const r of results) {
    const secs = (r.ms / 1000).toFixed(0).padStart(4);
    if (r.arrived) {
      console.log(`  ok    ${String(r.character).padEnd(12)} ${r.from} -> ${r.to}  ${secs}s  ` +
        `${r.rooms?.length ?? 0} room(s)  ${r.swings ?? 0} swing(s)`);
    } else if (r.refused) {
      console.log(`  NOSEND ${String(r.character).padEnd(11)} ${r.from} -> ${r.to}         ${r.why}`);
    } else {
      console.log(`  STUCK ${String(r.character).padEnd(12)} ${r.from} -> ${r.to}  ${secs}s  ` +
        `in ${r.stuck_in ?? '?'}  ${r.why ?? ''}${r.note ? '  — ' + r.note : ''}`);
      console.log(`        reached: ${(r.rooms ?? []).join(' -> ')}`);
    }
    legs.push(r);
  }

  // Swap ends. Every character turns round wherever it actually is, including the ones
  // that did not arrive — a stuck character being asked to go back the other way is the
  // interesting case, not one to skip.
  for (const p of plan) p.target = p.target === A ? B : A;
}

await restore();

// ------------------------------------------------------------------ what it found
const arrived = legs.filter(l => l.arrived).length;
const refused = legs.filter(l => l.refused).length;
const deaths = legs.reduce((n, l) => n + (l.deaths ?? 0), 0);
const stuckRooms = new Map(), reasons = new Map();
for (const l of legs) {
  // Refusals are counted separately and kept OUT of the stuck histogram. A journey that
  // was never started has no room that ate it, and putting it in the same column as one
  // that walked into a corridor and stopped is the exact confusion this tool exists to
  // avoid making.
  if (l.arrived || l.refused) continue;
  const room = l.stuck_in ?? '?';
  stuckRooms.set(room, (stuckRooms.get(room) ?? 0) + 1);
  const why = l.why ?? 'unknown';
  reasons.set(why, (reasons.get(why) ?? 0) + 1);
}
const byRoom = [...stuckRooms].sort((a, b) => b[1] - a[1]);

console.log(`\n================ ${legs.length} leg(s): ${arrived} arrived, ` +
  `${legs.length - arrived - refused} stuck, ${refused} refused before setting out, ${deaths} death(s)`);
if (refused)
  console.log(`(${refused} were refused by confine_rooms — re-run with --free to test the road itself)`);
if (byRoom.length) {
  console.log('\nwhere they stopped, worst first:');
  for (const [room, n] of byRoom) console.log(`  ${String(n).padStart(3)}  room ${room}`);
  console.log('\nwhat the mover said:');
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}  ${why}`);
} else {
  console.log('\nNothing got stuck. If that is a surprise, run more laps — a route that');
  console.log('fails one time in ten needs more than four legs to show it.');
}

const book = load();
book.runs.push({ at: Date.now(), a: A, b: B, laps: LAPS, legs: legs.length, arrived, deaths,
  stuck_rooms: byRoom, fleet: health.fleet,
  detail: legs.map(l => ({ lap: l.lap, character: l.character, from: l.from, to: l.to,
    arrived: !!l.arrived, ms: l.ms, stuck_in: l.stuck_in ?? null, why: l.why ?? null,
    note: l.note ?? null, rooms: l.rooms ?? [], swings: l.swings ?? 0, deaths: l.deaths ?? 0 })) });
save(book);
console.log(`\nwritten to ${BOOK} — \`--report\` reads it back`);
