#!/usr/bin/env node
// LEARN THE UKGOTH JUMP BY DOING IT TWO HUNDRED TIMES AND WRITING DOWN WHAT HAPPENED.
//
//   node tools/m59-jumptrial.mjs --fleet shadow --rounds 3
//   node tools/m59-jumptrial.mjs --fleet shadow --strategies baseline,strafe_w,clear --rounds 5
//   node tools/m59-jumptrial.mjs --report            # just read the ledger back
//
// The declared fall-jump at 36,16 -> 38,10 is the one move on the road to Castle Victoria
// that cannot be walked, and missing it is not a slow crossing — it is terminal. The body
// lands on the gulley floor at 3200, the shelf it wanted is at 3840, and 640 units of rise
// against a 384 step limit means there is no way back up. From in there the strict geometry
// reaches 681 squares and neither Castle Victoria nor the Cragged Mountains is among them.
//
// WHY A HARNESS RATHER THAN A FIX. The obstacle is not geometry, which is fixed and known,
// but TRAFFIC: Ukgoth accumulates trolls, and a Guardian of Zjiria standing on the landing
// is a moving target that a static route cannot plan around. So the question is not "what is
// the right line" but "which approach succeeds most often against a room that will not hold
// still", and that is a measurement, not an argument.
//
// THE SHAPE, which is the operator's:
//
//   * every character waits on its own safe spot, queued back from the take-off, so a
//     character waiting its turn is not itself part of the traffic;
//   * ONE goes forward at a time, attempts the jump under a named strategy, and is sent back
//     to its spot whether it made it or not;
//   * every attempt records what was in the way and whether the thing in the way was MOVING,
//     because "a troll was there" and "a troll walked into me" want different answers.
//
// The ledger is substrate/jumptrials.jsonl, append-only, one line per attempt. It never
// records a character name — see the redaction note on `line()`.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { safeSpots } from './m59-safespots.mjs';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const sub = (...p) => join(REPO, 'substrate', ...p);
const LEDGER = sub('jumptrials.jsonl');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);
const KNOWN = new Set(['fleet', 'port', 'rounds', 'strategies', 'agents', 'room',
                       'report', 'dry-run', 'walk', 'help', 'h']);
for (const a of argv) if (a.startsWith('--') && !KNOWN.has(a.slice(2))) {
  console.error(`m59-jumptrial: unknown option ${a}`);
  console.error(`known: ${[...KNOWN].map(k => '--' + k).join(' ')}`);
  process.exit(2);
}

const ROOM = Number(flag('room', 599));
const PORT = Number(flag('port', 8971));
const ROUNDS = Number(flag('rounds', 3));
const DRY = has('dry-run');
const WALK = has('walk');
const FLEET = flag('fleet', process.env.M59_FLEET
  ?? (() => { try { return readFileSync(sub('fleet-default'), 'utf8').trim(); } catch { return '-'; } })());
const ONLY = flag('agents') ? String(flag('agents')).split(',').map(x => x.trim()).filter(Boolean) : null;

// ---------------------------------------------------------------- the strategies
//
// Each says where to take off from and where to aim. `wait` is the only one that looks at the
// room before committing; the rest are deliberately blind, so the difference between them and
// `clear` measures what LOOKING is worth rather than what a different line is worth.
//
// The take-off alternatives are all on the same ledge and the same floor as 36,16 — verified
// against floorBaseAtClient, not guessed — so every one of them is a jump somebody could
// actually stand and make, not a new claim about the map.
const STRATEGIES = {
  baseline:  { from: { row: 36, col: 16 }, to: { row: 38, col: 10 },
               why: 'the declared jump, exactly as the rail attempts it' },
  strafe_n:  { from: { row: 35, col: 16 }, to: { row: 38, col: 10 },
               why: 'one square north along the ledge — same floor, shallower angle' },
  strafe_s:  { from: { row: 37, col: 15 }, to: { row: 38, col: 10 },
               why: 'one square south-west along the ledge — steeper angle' },
  land_wide: { from: { row: 36, col: 16 }, to: { row: 38, col: 11 },
               why: 'aim one square short of the declared landing, on the same shelf' },
  clear:     { from: { row: 36, col: 16 }, to: { row: 38, col: 10 }, wait: 3,
               why: 'the declared jump, but only once nothing is within 3 squares of the line' },
};
const CHOSEN = (flag('strategies') ? String(flag('strategies')).split(',') : Object.keys(STRATEGIES))
  .map(x => x.trim()).filter(Boolean);
for (const n of CHOSEN) if (!STRATEGIES[n]) {
  console.error(`m59-jumptrial: no strategy "${n}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- plumbing

function call(name, args, ms = 90000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        let text = null;
        try { text = JSON.parse(t).result.content[0].text; }
        catch { return done({ _error: `no result from ${name}` }); }
        try { done(JSON.parse(text)); }
        catch { done({ _error: String(text).trim().slice(0, 160) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dist = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

// Same ledge, not merely nearby: two squares a step apart can be a cliff apart. This is the
// same floor test the `jump` verb's guard uses, and it is what makes "one square over" mean
// a variation of the jump rather than a different drop.
function floorAt(row, col) {
  try { const pt = geo.standPoint(row, col); return pt ? geo.floorBaseAtClient(pt.x, pt.y) : null; }
  catch { return null; }
}
function sameFloorAs(a, b) {
  const x = floorAt(a.row, a.col), y = floorAt(b.row, b.col);
  return x != null && y != null && Math.abs(x - y) <= 64;
}

// Distance from a point to the take-off -> landing segment, in squares. What "on the line"
// means, and it is the number the collision column is built on.
function distToLine(p, a, b) {
  const vx = b.col - a.col, vy = b.row - a.row;
  const wx = p.col - a.col, wy = p.row - a.row;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(a.col + t * vx - p.col, a.row + t * vy - p.row);
}

// A LEDGER THAT NEVER NAMES A CHARACTER. The same rule m59-roomview.mjs follows and
// bard-guard.mjs enforces one repository over: the finding is which STRATEGY works, and a
// name adds nothing to it while being the one thing that must not leave this machine.
function line(row) {
  const { character, ...rest } = row;
  if (!DRY) appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), ...rest }) + '\n');
  return rest;
}

// ---------------------------------------------------------------- report

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function report(rows) {
  if (!rows.length) { console.log('\nno attempts on record yet.'); return; }
  console.log(`\n${rows.length} attempt(s) on record\n`);
  const by = {};
  for (const r of rows) {
    const k = r.strategy ?? '?';
    by[k] ??= { n: 0, made: 0, blocked: 0, moving: 0, still: 0, byWhat: {} };
    const b = by[k];
    b.n++;
    if (r.made) b.made++;
    if (r.collided) {
      b.blocked++;
      b[r.collided.moving ? 'moving' : 'still']++;
      const w = r.collided.name ?? '?';
      b.byWhat[w] = (b.byWhat[w] || 0) + 1;
    }
  }
  console.log('  strategy     attempts   made    rate   blocked   the blocker was');
  for (const [k, b] of Object.entries(by).sort((x, y) => y[1].made / y[1].n - x[1].made / x[1].n)) {
    const what = Object.entries(b.byWhat).sort((x, y) => y[1] - x[1])
      .map(([n, c]) => `${n} x${c}`).join(', ') || '—';
    console.log('  ' + k.padEnd(12) + String(b.n).padStart(8) + String(b.made).padStart(7) +
                String(Math.round(100 * b.made / b.n) + '%').padStart(8) +
                String(b.blocked).padStart(10) + '   ' + what +
                (b.blocked ? `  (${b.moving} moving, ${b.still} still)` : ''));
  }
  const blocked = rows.filter(r => r.collided);
  if (blocked.length) {
    const moving = blocked.filter(r => r.collided.moving).length;
    console.log(`\n  of ${blocked.length} attempts with something in the way, ${moving} of the blockers ` +
                `were MOVING and ${blocked.length - moving} were standing still.`);
    const madeAnyway = blocked.filter(r => r.made).length;
    console.log(`  ${madeAnyway} of those ${blocked.length} made the jump anyway.`);
  }
  const clean = rows.filter(r => !r.collided);
  if (clean.length)
    console.log(`  with a clear line, ${clean.filter(r => r.made).length} of ${clean.length} made it ` +
                `(${Math.round(100 * clean.filter(r => r.made).length / clean.length)}%).`);
}

if (has('report')) { report(readLedger()); process.exit(0); }

// ---------------------------------------------------------------- setup

const rosterFile = FLEET === '-' ? sub('fleet-state.json') : sub('fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) { console.error(`m59-jumptrial: ${rosterFile} does not name one game server.`); process.exit(2); }
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`m59-jumptrial: REFUSING. Fleet "${FLEET}" is on ${rostered.host}, not loopback.`);
  console.error('          This deliberately walks characters off a cliff, repeatedly.');
  process.exit(2);
}

const world = JSON.parse(readFileSync(sub('m59-map.json'), 'utf8'));
try { attachStepMasks(world); } catch {}
const room = world.rooms[String(ROOM)];
if (!room) { console.error(`m59-jumptrial: no room ${ROOM}`); process.exit(1); }
const geo = sharedRoomGeometry(room);

const jumps = (JSON.parse(readFileSync(sub('m59-falljumps.json'), 'utf8')).jumps ?? [])
  .filter(j => Number(j.room) === ROOM);
if (!jumps.length) { console.error(`m59-jumptrial: room ${ROOM} declares no fall-jump`); process.exit(1); }

const fleetNow = await call('fleet', {});
if (fleetNow._error) { console.error(`m59-jumptrial: broker on ${PORT} did not answer (${fleetNow._error})`); process.exit(1); }
let agents = (fleetNow.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) agents = agents.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
agents.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!agents.length) { console.error('m59-jumptrial: no characters matched.'); process.exit(1); }

// THE QUEUE, AND WHY IT IS NOT MADE OF SAFE SPOTS.
//
// The obvious design — and the one this started with — is one character per safe spot, queued
// back from the take-off. It does not work, and the reason is a property of what a safe spot IS.
//
// A safe wall is a square where the two grids DISAGREE: the BSP admits a body, the coarse grid
// the monsters path on refuses it. That is the whole mechanism. But the strict predicate — the
// one that matches what a walker can actually do — also requires a coarse-walkable destination.
// So a safe spot is, by construction, an ISLAND to it. Measured on the ten spots this tool
// first chose: seven strictly reach exactly ONE square, their own.
//
// Parked there, a character cannot walk to the ledge at all. The permissive predicate says it
// can — `moverStepLands` gates on `standable`, and that is true for all 4,686 squares in this
// room — so the walker sets off, meets a wall the model does not have, and grinds along it.
// Watched from the client: bodies hugging the EAST wall while the jump is to the south-west.
//
// So the queue is ordinary connected ground that STRICTLY reaches the take-off, and among
// those the squares with the most walls against them: defensible AND reachable, rather than
// defensible and marooned.
const takeoff = STRATEGIES[CHOSEN[0]].from;

function strictReach(from) {
  const seen = new Set([from.row * 1000 + from.col]);
  let frontier = [from];
  const R = room.rows, C = room.cols;
  while (frontier.length) {
    const next = [];
    for (const p of frontier)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = p.row + dr, nc = p.col + dc;
        if (nr < 1 || nc < 1 || nr > R || nc > C) continue;
        const k = nr * 1000 + nc;
        if (seen.has(k) || geo.walkable(nr, nc) !== true) continue;
        let ok = false;
        try { ok = geo._traceMoverStep(p.row, p.col, nr, nc); } catch {}
        if (!ok) continue;
        seen.add(k); next.push({ row: nr, col: nc });
      }
    frontier = next;
  }
  return seen;
}

const connected = strictReach(takeoff);
const coverAt = (r, c) => {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    if (geo.walkable(r + dr, c + dc) !== true) n++;
  }
  return n;
};
const candidates = [];
for (const k of connected) {
  const r = Math.floor(k / 1000), c = k % 1000;
  const d = dist({ row: r, col: c }, takeoff);
  if (d < 3 || d > 16) continue;
  candidates.push({ row: r, col: c, d, cover: coverAt(r, c) });
}
candidates.sort((a, b) => b.cover - a.cover || a.d - b.d);
const spots = candidates.slice(0, Math.max(agents.length, 8));
console.log(`queue: ${connected.size} squares strictly reach the take-off; ` +
            `${candidates.length} are 3-16 away; taking ${spots.length}`);

const queue = agents.map((a, i) => ({ ...a, spot: spots[i % Math.max(1, spots.length)] }));

console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(`room ${ROOM} (${room.name}), ${agents.length} character(s), ${ROUNDS} round(s)`);
console.log(`strategies: ${CHOSEN.join(', ')}`);
for (const n of CHOSEN) {
  const st = STRATEGIES[n];
  console.log(`  ${n.padEnd(11)} ${st.from.row},${st.from.col} -> ${st.to.row},${st.to.col}` +
              (st.wait ? `  (waits for a clear ${st.wait}-square line)` : '') + `  — ${st.why}`);
}
console.log();
if (DRY) {
  for (const q of queue)
    console.log(`  ${q.character.padEnd(8)} waits at ${q.spot ? q.spot.row + ',' + q.spot.col : '(nowhere)'}`);
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');

// ---------------------------------------------------------------- one attempt

async function observe(agent) {
  const l = await call('look', { agent });
  if (l._error) return null;
  return { me: l.you, objects: (l.objects ?? []).filter(o => !o.is_player || o.is_player === false) };
}

async function attempt(q, name) {
  const st = STRATEGIES[name];
  const out = { character: q.character, strategy: name,
                from: `${st.from.row},${st.from.col}`, to: `${st.to.row},${st.to.col}` };

  // 1. GET ONTO THE TAKE-OFF SQUARE, AND DO NOT LET THE WALK BE THE EXPERIMENT.
  //
  // The first version walked there and six of fifteen attempts never arrived — so most of
  // what it measured was Ukgoth's traffic between the queue and the ledge, which is a real
  // problem and a DIFFERENT one. This is about the jump. So the body is placed on the square
  // (lab server, DM powers) and `--walk` opts back into walking for anyone who wants to
  // measure the approach instead. Which one happened is recorded either way.
  out.approach = WALK ? 'walked' : 'placed';
  if (WALK) {
    const walk = await call('walk_to', { agent: q.agent, col: st.from.col, row: st.from.row }, 120000);
    if (walk?._error) out.walk_error = walk._error;
  } else {
    // RELOCATE PUTS YOU NEAR, NEVER ON. `UtilGoNearSquare` is documented in CLAUDE.md as the
    // call that never says no; what it does not do is land you on the square you asked for —
    // measured here at 35,21 / 29,19 / 34,21 for a request of 36,16. So the DM call gets the
    // body into the neighbourhood and a SHORT walk finishes it. That walk is a few squares on
    // one ledge rather than a crossing of Ukgoth, which is the confound this avoids.
    await dm.relocate([q.character], ROOM, { row: st.from.row, col: st.from.col, verify: false }).catch(() => null);
    await sleep(900);
    for (let tries = 0; tries < 3; tries++) {
      const here = await observe(q.agent);
      if (here?.me && here.me.row === st.from.row && here.me.col === st.from.col) break;
      await call('walk_to', { agent: q.agent, col: st.from.col, row: st.from.row }, 60000);
      await sleep(400);
    }
  }
  // ON THE LEDGE IS GOOD ENOUGH, AND INSISTING ON THE EXACT SQUARE THREW THE EXPERIMENT AWAY.
  //
  // The walk reliably gets within one square and reliably fails the last step onto 36,16 —
  // 37,16 and 36,17 over and over. Demanding the exact square recorded those as "never
  // reached the take-off", which is fifteen non-attempts and no data.
  //
  // A square either side is a real jump: the guard on the `jump` verb already allows the
  // one-square neighbourhood of a declared jump on the same two floors, precisely because
  // that is the variation worth measuring. So the attempt proceeds from where the body
  // actually is and RECORDS it, which is better evidence than the intention was.
  const at = await observe(q.agent);
  const onLedge = at?.me && dist(at.me, st.from) <= 1 && sameFloorAs(at.me, st.from);
  if (!onLedge) {
    out.made = false;
    out.note = `not on the ledge (${at?.me ? at.me.row + ',' + at.me.col : 'no position'})`;
    return line(out);
  }
  const takeOffAt = { row: at.me.row, col: at.me.col };
  out.took_off_from = `${takeOffAt.row},${takeOffAt.col}`;
  out.exact = takeOffAt.row === st.from.row && takeOffAt.col === st.from.col;

  // 2. WHAT IS IN THE WAY, AND IS IT MOVING. Two samples a second apart, because "a troll was
  //    standing on the landing" and "a troll walked into the landing" are different findings
  //    and only the second one argues for timing rather than for a different line.
  const first = at;
  await sleep(1000);
  const second = await observe(q.agent);
  const near = (second?.objects ?? []).filter(o =>
    distToLine({ col: o.col, row: o.row }, st.from, st.to) <= (st.wait ?? 2));
  const movedById = new Map((first.objects ?? []).map(o => [o.id, o]));
  const blockers = near.map(o => {
    const was = movedById.get(o.id);
    return { id: o.id, name: o.name, col: o.col, row: o.row,
             moving: !!(was && (was.col !== o.col || was.row !== o.row)),
             on_landing: o.col === st.to.col && o.row === st.to.row };
  });
  out.in_the_way = blockers.length;
  out.blockers = blockers.map(b => `${b.name}@${b.row},${b.col}${b.moving ? ' moving' : ''}`);

  // 3. `clear` is the only strategy that may decline. It is a strategy, not a safety rail —
  //    the others jump into whatever is there on purpose, so the difference is measurable.
  if (st.wait && blockers.length) {
    out.made = false;
    out.declined = true;
    out.collided = blockers[0] ? { name: blockers[0].name, moving: blockers[0].moving,
                                   kind: blockers[0].name === 'troll' ? 'troll'
                                       : /guardian/i.test(blockers[0].name) ? 'guardian' : 'other' } : null;
    out.note = `declined: ${blockers.length} within ${st.wait} of the line`;
    return line(out);
  }

  // 4. STILL ON THE SQUARE? The second of watching costs a second, and a body can be pushed
  //    or drift in it — one attempt jumped from 35,20 having been checked at 35,16, and the
  //    guard caught it as "not a declared fall-jump" from a square nobody meant to be on.
  //    A drifted attempt is not this strategy and is recorded as its own outcome.
  const still = await observe(q.agent);
  if (!still?.me || !sameFloorAs(still.me, st.from) || dist(still.me, st.from) > 1) {
    out.made = false;
    out.drifted = still?.me ? `${still.me.row},${still.me.col}` : 'unknown';
    out.note = `left the ledge before jumping (to ${out.drifted})`;
    return line(out);
  }
  out.took_off_from = `${still.me.row},${still.me.col}`;

  // 5. jump.
  const j = await call('jump', { agent: q.agent, to_col: st.to.col, to_row: st.to.row }, 60000);
  out.made = !!j?.made;
  out.landed = j?.landed ? `${j.landed.row},${j.landed.col}` : null;
  out.floor = j?.floor ?? null;
  out.landing_floor = j?.landing_floor ?? null;
  if (j?._error) out.note = j._error;
  else if (j?.reason) out.note = j.reason;

  // 6. WHO WAS IN THE WAY, decided after the fact against where the body ended up. A blocker
  //    that was on the line and a jump that came up short is the collision this exists to
  //    count; a blocker that was on the line and a jump that landed anyway is evidence the
  //    line is survivable, which is just as useful and used to be invisible.
  const onLanding = blockers.find(b => b.on_landing) ?? blockers[0] ?? null;
  out.collided = (!out.made && onLanding)
    ? { name: onLanding.name, moving: onLanding.moving,
        kind: onLanding.name === 'troll' ? 'troll'
            : /guardian/i.test(onLanding.name) ? 'guardian' : 'other' }
    : null;
  return line(out);
}

// ---------------------------------------------------------------- run

console.log('placing the queue…');
for (const q of queue) {
  if (!q.spot) continue;
  // DO NOT PARK. It was tried and it is worse than the problem.
  //
  // The keeper walking the body off the ledge is a real confound — a Guardian two squares from
  // the take-off means the survival ladder is doing its job and the jump never happens. But
  // parking stops the session moving AT ALL, including for this harness: with the fleet parked
  // every attempt read "not on the ledge (35,21)", which is simply where the relocate dropped
  // them, unmoved. The harness needs the character driveable and needs the keeper's own
  // opinions out of the way, and `park` gives it neither.
  //
  // So: idle, not roaming, confined to this room, and the attempt records where the body
  // actually took off from. A keeper that pulls it off the ledge shows up as `left the ledge
  // before jumping`, which is a finding rather than a failure of the harness — it is the
  // measurement of how much the survival ladder costs at this particular cliff.
  await call('autopilot', { agent: q.agent, mode: 'idle', roam: false, confine_rooms: [ROOM] });
  await call('autopilot', { agent: q.agent, action: 'unpark', why: 'jump trial: the harness drives, the keeper must not be frozen' });
  await dm.relocate([q.character], ROOM, { row: q.spot.row, col: q.spot.col, verify: false }).catch(() => null);
  try {
    const ids = await dm.resolve([q.character]);
    const max = q.max_health ?? null;
    if (ids?.[q.character] != null && max) await dm.dm([...dm.healthCmds(ids[q.character], max)], { timeoutMs: 30000 });
  } catch {}
  await sleep(200);
}
console.log(`${queue.length} placed.\n`);

let n = 0;
for (let round = 1; round <= ROUNDS; round++) {
  for (const name of CHOSEN) {
    for (const q of queue) {
      const r = await attempt(q, name);
      n++;
      console.log('  ' + String(round).padStart(2) + '  ' + name.padEnd(11) +
                  (r.made ? 'MADE  ' : r.declined ? 'declined' : 'missed') +
                  '  landed ' + String(r.landed ?? '—').padEnd(7) +
                  (r.blockers?.length ? '  in the way: ' + r.blockers.slice(0, 2).join(', ') : '') +
                  (r.note ? '  — ' + r.note : ''));
      // BACK TO THE SPOT EITHER WAY. A character that made the jump is on the far shelf and
      // would otherwise be out of the experiment; one that missed is in the gulley it cannot
      // climb out of. The relocate is the only thing that makes this a LOOP.
      await dm.relocate([q.character], ROOM, { row: q.spot.row, col: q.spot.col, verify: false }).catch(() => null);
      try {
        const ids = await dm.resolve([q.character]);
        if (ids?.[q.character] != null && q.max_health)
          await dm.dm([...dm.healthCmds(ids[q.character], q.max_health)], { timeoutMs: 30000 });
      } catch {}
      await sleep(300);
    }
  }
}

console.log(`\n${n} attempt(s) this run.`);
report(readLedger());
console.log(`\nledger: ${LEDGER}`);
