#!/usr/bin/env node
// DID THE BODY ACTUALLY WALK THE GROUND BETWEEN TWO EXITS, OR DID IT ARRIVE?
//
//   node tools/m59-traversal-test.mjs --agent shadow02 --room 598
//   node tools/m59-traversal-test.mjs --agent shadow02 --room 599 --seconds 120
//
// Samples one character's square every 500ms and fills in a punch card of the coarse
// squares it stood on, in order. Then it asks the two questions a timing number cannot:
//
//   CONTIGUITY  is each sample adjacent to the last, or did the character appear somewhere
//               it could not have walked to? A gap is a teleport, a clip through geometry,
//               or a boundary crossing — and only the third is legitimate.
//   PACE        the client runs at about five coarse squares a second (one packet a second
//               moving roughly five squares; the speed byte does not move you). So a
//               half-second sample can legitimately advance about 2.5 squares and no more.
//               Anything beyond that did not walk.
//
// WHY THIS EXISTS. A crossing was reported as taking one second in the Cragged Mountains —
// a 2,450-square room whose exit-to-exit line is 112 squares, which is twenty-odd seconds at
// a run. That number came from a metric that measured traced move ATTEMPTS rather than
// presence, so a room the character barely entered scored the same as one it crossed. A
// timing that can be produced without walking is not evidence of walking.
//
// It EXITS NON-ZERO on a violation, so it can be used as a gate rather than as a report.

import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync } from 'node:fs';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { activeRoutes, anchorFor, attachStepMasks } from './m59-routes.mjs';
import { loadMap } from './m59-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const PORT    = Number(flag('port', 8971));
const FLEET   = flag('fleet', 'shadow');
const AGENT   = flag('agent', 'shadow02');
const ROOM    = flag('room', null) === null ? null : Number(flag('room'));
const SECONDS = Number(flag('seconds', 90));
const EVERY   = Number(flag('every', 500));

// A HALF SECOND AT A RUN. Five squares a second is the client's own pace, so 2.5 squares is
// the honest ceiling for one sample. Rounded up to 3 rather than 2.5 because a sample lands
// where it lands and half a square of jitter is not a teleport.
const MAX_SQUARES_PER_SAMPLE = Number(flag('max-step', 3));

// THE ROOMS WORTH SHOUTING ABOUT. Both Cragged Mountains — 578 and 598 — because they are
// where the fleet dies and where a stall has a chance of being about the GROUND rather than
// about traffic. Ukgoth stalls too, but it stalls at a cliff jump that is supposed to be
// hard, so the signal there is mostly noise. Overridable, and empty means every room.
const WATCH_ROOMS = new Set(String(flag('watch', '578,598')).split(',')
  .map(n => Number(n.trim())).filter(Number.isFinite));
// How long a character may fail to get nearer the door before it is worth a line. One
// second: at a run that is five squares, so a second of no progress is not sampling jitter.
const STALL_MS = Number(flag('stall-ms', 1000));
const WATCH_LOG = join(REPO, 'substrate', 'cragged-stalls.jsonl');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered || !LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`traversal: REFUSING — fleet "${FLEET}" is not on loopback.`);
  process.exit(2);
}

function call(name, args, ms = 20000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => { try { done(JSON.parse(JSON.parse(t).result.content[0].text)); }
                            catch (e) { done({ _error: e.message }); } });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// RESTING IS NOT STALLING, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS WARNING.
//
// A character healing on a proven safe spot is the survival ladder working; a character
// standing still because the mover cannot find a step is the fault being hunted. Both look
// identical to a distance-to-the-door measure, and the first live run of this fired sixteen
// warnings at a character that was deliberately resting — which is a rubber stamp pointed
// the other way. The clock pauses while it rests and the time is KEPT, because "spent two
// minutes healing" and "spent two minutes stuck" are both worth knowing and are not the
// same number.
const RESTING = /rest|holding a (proven|untested) safe spot|healing|recovering/i;

console.log(`watching ${AGENT} every ${EVERY}ms for ${SECONDS}s` +
            (ROOM ? `, room ${ROOM} only` : '') +
            `; a sample may advance at most ${MAX_SQUARES_PER_SAMPLE} square(s)\n`);

// WHICH DOOR. Asked by DESTINATION through `anchorFor`, never by direction — a wall can
// carry two exits to two different rooms and asking by direction silently picks the wrong
// one. `--door row,col` overrides for a room the table cannot answer for.
let door = null;
if (flag('door')) {
  const [r0, c0] = String(flag('door')).split(',').map(Number);
  if (Number.isFinite(r0) && Number.isFinite(c0)) door = { row: r0, col: c0 };
} else if (ROOM != null && flag('toward')) {
  try {
    attachStepMasks(await loadMap());
    const a = anchorFor(activeRoutes(), ROOM, Number(flag('toward')));
    if (a) door = { row: a.row, col: a.col };
  } catch { door = null; }
}
if (door) console.log(`progress is measured toward the door at ${door.col},${door.row}`);

const started = Date.now();
const stalls = [];
let best = null, bestAt = Date.now(), restedMs = 0;
const card = [];            // the punch card: one entry per sample that moved
const violations = [];
let last = null, samples = 0;
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  await sleep(EVERY);
  const st = await call('status', { agent: AGENT });
  const room = st?.where?.num ?? null, col = st?.position?.col ?? null, row = st?.position?.row ?? null;
  if (room == null || col == null || row == null) { last = null; continue; }   // unreadable: no claim
  samples++;
  if (ROOM != null && room !== ROOM) { last = null; continue; }
  if (last && last.room === room) {
    const d = Math.max(Math.abs(col - last.col), Math.abs(row - last.row));
    if (d > MAX_SQUARES_PER_SAMPLE) {
      violations.push({ kind: 'leap', from: `${last.col},${last.row}`, to: `${col},${row}`,
                        squares: d, room });
    }
    if (d > 0) card.push({ room, col, row, d });
  } else if (last && last.room !== room) {
    // A boundary crossing is the one legitimate discontinuity — rooms have their own grids.
    card.push({ room, col, row, d: null, crossed_from: last.room });
  } else {
    card.push({ room, col, row, d: 0 });
  }
  // ---- NO PROGRESS TOWARD THE DOOR, IN THE ROOMS WHERE THAT MEANS SOMETHING ----
  //
  // Distance to the exit anchor is the only honest measure of progress here. A character
  // can be moving briskly — every sample advancing, every move sent, nothing refused — and
  // still be going nowhere, which is precisely the shape the Cragged Mountains produced:
  // thirty-two moves sent, none refused, sixty seconds, three squares. Timing said it was
  // busy. Movement said it was walking. Only the DOOR says whether any of it counted.
  if (door && (!WATCH_ROOMS.size || WATCH_ROOMS.has(room))) {
    const dist = Math.max(Math.abs(col - door.col), Math.abs(row - door.row));
    if (best === null || dist < best) { best = dist; bestAt = Date.now(); }
    else if (Date.now() - bestAt >= STALL_MS) {
      const ap = await call('autopilot', { agent: AGENT, action: 'status' }, 15000);
      // THE CLOCK PAUSES. Resting is a deliberate stop, so it neither warns nor accrues
      // against the stall — but it is counted, so a leg can be read as "healed for 90s"
      // rather than silently forgiven.
      if (RESTING.test(String(ap?.activity ?? ''))) {
        restedMs += EVERY;
        bestAt = Date.now();
        last = { room, col, row };
        continue;
      }
      const rec = {
        at: Date.now(), agent: AGENT, room,
        square: { col, row }, door: { col: door.col, row: door.row },
        distance: dist, best_distance: best,
        stalled_ms: Date.now() - bestAt,
        health: st?.vitals?.health?.value ?? null,
        activity: ap?.activity ?? null,
        // The features worth correlating against a position later: what is next to us, what
        // the keeper thinks it is doing, and the last thing it said. A stall that always
        // happens on the same squares with the same neighbours is a fact about the ground.
        adjacent: (st?.here?.attackable ?? null),
        last_note: (ap?.recent ?? []).slice(-1)[0]?.what ?? null,
      };
      stalls.push(rec);
      try { mkdirSync(dirname(WATCH_LOG), { recursive: true }); appendFileSync(WATCH_LOG, JSON.stringify(rec) + String.fromCharCode(10)); }
      catch { /* a warning that cannot be written must not stop the watch */ }
      console.log(`  WARN ${((Date.now() - started) / 1000).toFixed(1)}s  ${col},${row} in ${room} — ` +
                  `${dist} from the door, no closer for ${(rec.stalled_ms / 1000).toFixed(1)}s` +
                  (rec.activity ? `  [${String(rec.activity).slice(0, 28)}]` : ''));
      bestAt = Date.now();          // one line per stall period, not one per sample
    }
  }

  last = { room, col, row };
}

const moved = card.filter(c => c.d > 0);
const squares = new Set(card.map(c => `${c.room}:${c.col},${c.row}`));
console.log(`${samples} sample(s), ${squares.size} distinct square(s), ${moved.length} that advanced`);
if (moved.length) {
  const ds = moved.map(c => c.d).sort((a, b) => a - b);
  console.log(`advance per half-second: median ${ds[Math.floor(ds.length / 2)]}, max ${ds[ds.length - 1]}`);
}
if (door) {
  console.log(`${stalls.length} stall warning(s) — logged to ${WATCH_LOG}`);
  console.log(`${(restedMs / 1000).toFixed(1)}s resting — paused, not counted as stalling`);
  if (stalls.length) {
    const bySquare = {};
    for (const v of stalls) bySquare[`${v.square.col},${v.square.row}`] =
      (bySquare[`${v.square.col},${v.square.row}`] ?? 0) + 1;
    console.log('squares it stalled on, worst first:');
    for (const [sq, n] of Object.entries(bySquare).sort((a, b) => b[1] - a[1]).slice(0, 8))
      console.log(`  ${String(n).padStart(3)}x  ${sq}`);
  }
}
const crossings = card.filter(c => c.crossed_from != null);
for (const c of crossings) console.log(`  crossed ${c.crossed_from} -> ${c.room} at ${c.col},${c.row}`);

// A CLEAN BILL FROM A CHARACTER THAT NEVER MOVED IS NOT A CLEAN BILL.
//
// The first run of this watched a character that had already finished its leg: twenty
// samples, one square, zero advances — and it reported that every advance was one a body
// could walk. True, and meaningless. "No violations" and "nothing happened" have to read
// differently or this becomes a rubber stamp, which is the same failure as a measurement
// that degrades to a plausible number instead of to an absence.
if (!moved.length) {
  console.log('\nNOTHING TO CHECK — the character did not advance a single square in this');
  console.log('window, so this run is not evidence that traversal is sound. Point it at a');
  console.log('character while it is actually crossing, or widen --seconds.');
  process.exit(3);
}
if (!violations.length) {
  console.log(`\nno leap larger than the run pace across ${moved.length} advance(s) — every one`);
  console.log('is a move a body could have walked');
  process.exit(0);
}
console.log(`\n${violations.length} LEAP(S) NO WALK CAN EXPLAIN:`);
for (const v of violations.slice(0, 12))
  console.log(`  room ${v.room}: ${v.from} -> ${v.to} — ${v.squares} squares in ${EVERY}ms`);
console.log('\nA body cannot cover that at a run. Either it clipped through geometry, it was');
console.log('teleported, or the position being reported is not the position it is standing on.');
process.exit(1);
