// HOW FAR CAN THE WEAKEST CHARACTER IN THE FLEET ACTUALLY GET.
//
//   node tools/m59-mule.mjs --agent shadow02 --port 8971
//   node tools/m59-mule.mjs --agent shadow02 --tour 50,38,50,200,150,101,50
//   node tools/m59-mule.mjs --agent shadow02 --laps 3 --retries 4
//   node tools/m59-mule.mjs --report                        the book, no walking
//
// THE QUESTION IS REACH, NOT SURVIVAL, AND THEY NEED SEPARATING. A twenty-health
// character dies constantly and that tells you almost nothing on its own: what an
// operator actually wants to know is WHICH LEG it dies on, how far along, and whether it
// ever gets through at all given enough goes. So death here is not the end of the run —
// it is one data point in a leg's record. The mule is put back at the START of the leg it
// died on, healed, and sent again, up to `--retries` times. A leg that needs four goes and
// a leg that never completes are different answers and the old shape could not tell them
// apart, because the first death ended the experiment.
//
// TWENTY HEALTH AND EIGHTY VIGOR, ON PURPOSE. Eighty is where resting stops awarding
// vigor (everything above it has to be EATEN), so it is the state a character actually
// travels in rather than a best case that never occurs. Health is set to the character's
// own maximum, whatever that is; the mule is weak because it IS weak, not because this
// handicaps it.
//
// LOOPBACK ONLY. Resurrecting uses the maintenance port, which is unauthenticated, and
// this kills a character over and over on purpose. Neither belongs on a shared server.
//
// GIVING UP IS ASKED OF THE KEEPER, NEVER INFERRED FROM A MISSING FIELD. `!busy` has now
// lied twice in m59-circuit.mjs — once from a timed-out probe, once because
// `KeeperProxy.jobReport()` was a hardcoded null — and it is structurally unable to stop:
// `rtsJobReport` returns undefined when there is no job, so absence is the normal case.
// A leg here ends on the keeper's own `stuck`, on death, or on the clock.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { fleetName, stateFileFor, rosterGameEndpoint } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PORT     = Number(arg('port', 8971));
const AGENT    = arg('agent', 'shadow02');
const FLEET    = arg('fleet', null) ?? fleetName();
const LAPS     = Number(arg('laps', 1));
const RETRIES  = Number(arg('retries', 3));
const MAX_LEG  = Number(arg('max-leg', 480)) * 1000;
const VIGOR    = Number(arg('vigor', 80));
const POLL     = Number(arg('poll', 3000));
const BOOK     = join(REPO, 'substrate', `mule-${FLEET ?? 'default'}.json`);
const TOUR     = (arg('tour', '50,38,50,200,150,101,50'))
  .split(',').map(x => Number(x.trim())).filter(Number.isFinite);

const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { try { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); } catch {} };

// ------------------------------------------------------------------ the report
function report() {
  const b = load();
  if (!b.runs.length) { console.log('no mule runs recorded yet'); return; }
  for (const run of b.runs.slice(-Number(arg('report', 3) === true ? 3 : arg('report', 3)))) {
    console.log(`\n${new Date(run.at).toISOString().replace('T', ' ').slice(0, 19)}  ` +
                `${run.character ?? run.agent}  ${run.max_health ?? '?'} health  ` +
                `tour ${run.tour.join(' -> ')}  x${run.laps} lap(s)`);
    console.log('  ' + 'leg'.padEnd(26) + 'got there'.padStart(11) + 'tries'.padStart(7) +
                'deaths'.padStart(8) + 'median'.padStart(9) + 'lowest hp'.padStart(11));
    for (const l of run.legs) {
      const ms = l.arrivals.length ? l.arrivals.slice().sort((a, x) => a - x)[Math.floor(l.arrivals.length / 2)] : null;
      console.log('  ' + `${l.from} -> ${l.to}`.padEnd(26) +
        `${l.arrivals.length}/${l.attempts}`.padStart(11) +
        String(l.attempts).padStart(7) + String(l.deaths).padStart(8) +
        (ms == null ? '—' : Math.round(ms / 1000) + 's').padStart(9) +
        (l.lowest == null ? '—' : l.lowest + '%').padStart(11));
    }
  }
}

if (has('report')) { report(); process.exit(0); }

// ------------------------------------------------------------------ guards
const endpoint = (() => { try { return rosterGameEndpoint(stateFileFor(FLEET)); } catch { return null; } })();
const host = String(endpoint?.host ?? '');
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
  console.error(`refusing: fleet "${FLEET}" plays on ${host || '(unknown)'}, which is not loopback.`);
  console.error('This kills a character repeatedly and resurrects it over the maintenance port.');
  process.exit(1);
}

function call(name, args = {}, ms = 60000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) return done({ _error: text.slice(7) });
          done(JSON.parse(text));
        } catch { done({ _error: 'unparseable' }); }
      });
    });
    req.on('error', e => done({ _error: e.message }));
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.end(body);
  });
}

const isDead = s => /underworld/i.test(String(s?.where?.name ?? '')) || Number(s?.where?.num) === 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// PUT IT BACK WHERE THE LEG STARTED, NOT WHERE IT DIED. A corpse wakes in the Underworld
// and walking out of there is a different experiment; this one is about the leg.
async function resurrect(character, roomNum) {
  const dm = await import('./m59-dm.mjs');
  const ids = await dm.resolve([character]).catch(() => ({}));
  const obj = ids[character];
  if (!obj) return { error: `cannot resolve ${character}` };
  const reads = [`show object ${obj}`];
  const blocks = dm.split(await dm.dm(reads), reads);
  const { maxHealth, maxMana } = dm.parseCeilings(blocks[0]);
  const cmds = [];
  if (Number.isFinite(maxHealth)) cmds.push(dm.setProp(obj, 'piHealth', maxHealth));
  if (Number.isFinite(maxMana)) cmds.push(dm.setProp(obj, 'piMana', maxMana));
  // Eighty rather than two hundred: see the note at the top. This is the state a
  // character travels in, and a full-vigor mule is a mule nobody has.
  cmds.push(dm.setProp(obj, 'piVigor', VIGOR), dm.setProp(obj, 'piExertion', 0));
  cmds.push(`send object ${obj} NewHealth`, `send object ${obj} NewMana`, `send object ${obj} NewVigor`);
  await dm.dm(cmds, { timeoutMs: 60000 }).catch(() => null);
  const moved = await dm.relocate([character], roomNum, { verify: true }).catch(e => ({ error: e.message }));
  return { max_health: maxHealth, moved };
}

// ------------------------------------------------------------------ one leg
async function runLeg(from, to, leg) {
  const t0 = Date.now();
  let lowest = 100, deaths = 0, rooms = new Set(), lastRoom = null, lastMoved = Date.now();
  const started = await call('travel', { agent: AGENT, to, background: true });
  if (started?._error) return { ok: false, why: `travel refused: ${started._error}`, ms: 0, lowest: null, deaths: 0, rooms: 0 };

  for (;;) {
    await sleep(POLL);
    const s = await call('status', { agent: AGENT });
    if (s?._error) continue;
    const hp = s.vitals?.health;
    if (hp?.max) lowest = Math.min(lowest, Math.round(100 * hp.value / hp.max));
    const num = s.where?.num ?? null;
    if (num !== lastRoom) { lastRoom = num; lastMoved = Date.now(); if (num != null) rooms.add(num); }

    if (isDead(s)) return { ok: false, why: 'died', ms: Date.now() - t0, lowest, deaths: 1,
                            rooms: rooms.size, died_in: leg.lastLiveRoom ?? null };
    leg.lastLiveRoom = num;

    if (num === to && !s.busy)
      return { ok: true, ms: Date.now() - t0, lowest, deaths, rooms: rooms.size };

    // The keeper's own verdict, not this end guessing from an absent field.
    if (s.stuck && Date.now() - lastMoved > POLL * 4)
      return { ok: false, why: `stuck: ${s.stuck.why ?? '?'} (${s.stuck.seconds}s)`,
               ms: Date.now() - t0, lowest, deaths, rooms: rooms.size, stopped_in: num };

    if (Date.now() - t0 > MAX_LEG)
      return { ok: false, why: 'ran out of time', ms: Date.now() - t0, lowest, deaths,
               rooms: rooms.size, stopped_in: num };
  }
}

// ------------------------------------------------------------------ the run
const s0 = await call('status', { agent: AGENT });
if (s0?._error) { console.error(`cannot read ${AGENT}: ${s0._error}`); process.exit(2); }
const character = s0.character ?? AGENT;
const maxHealth = s0.vitals?.health?.max ?? null;

console.log(`mule run: ${character} (${AGENT}), ${maxHealth ?? '?'} max health, vigor set to ${VIGOR} on each go`);
console.log(`tour ${TOUR.join(' -> ')}   x${LAPS} lap(s)   up to ${RETRIES} tries per leg   ` +
            `${MAX_LEG / 1000}s per try`);
console.log(`starting from ${s0.where?.num} ${s0.where?.name ?? ''}\n`);

const legs = [];
for (let lap = 0; lap < LAPS; lap++) {
  for (let i = 0; i + 1 < TOUR.length; i++) {
    const from = TOUR[i], to = TOUR[i + 1];
    const rec = { from, to, attempts: 0, arrivals: [], deaths: 0, lowest: null,
                  whys: [], lastLiveRoom: null };
    // Always begin the leg from its own start room, so every attempt measures the same
    // journey. Without this a leg that began where the last one gave up is a different
    // walk each time and the medians mean nothing.
    await resurrect(character, from);
    await sleep(4000);

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      rec.attempts++;
      const r = await runLeg(from, to, rec);
      if (r.lowest != null) rec.lowest = rec.lowest == null ? r.lowest : Math.min(rec.lowest, r.lowest);
      const stamp = new Date().toISOString().slice(11, 19);
      if (r.ok) {
        rec.arrivals.push(r.ms);
        console.log(`${stamp}  ${from} -> ${to}  try ${attempt}  ARRIVED ${Math.round(r.ms / 1000)}s  ` +
                    `${r.rooms} room(s)  lowest ${r.lowest}%`);
        break;
      }
      if (r.why === 'died') rec.deaths++;
      rec.whys.push(r.why + (r.stopped_in ? ` in ${r.stopped_in}` : r.died_in ? ` around ${r.died_in}` : ''));
      console.log(`${stamp}  ${from} -> ${to}  try ${attempt}  ${r.why.toUpperCase()}` +
                  ` after ${Math.round(r.ms / 1000)}s  ${r.rooms} room(s)  lowest ${r.lowest ?? '?'}%` +
                  (r.stopped_in ? `  stopped in ${r.stopped_in}` : '') +
                  (r.died_in ? `  last alive in ${r.died_in}` : ''));
      if (attempt < RETRIES) { await resurrect(character, from); await sleep(4000); }
    }
    delete rec.lastLiveRoom;
    legs.push(rec);
  }
}

const book = load();
book.runs.push({ at: Date.now(), agent: AGENT, character, max_health: maxHealth,
                 tour: TOUR, laps: LAPS, retries: RETRIES, vigor: VIGOR, legs });
save(book);

console.log('\n' + '='.repeat(72));
const done = legs.filter(l => l.arrivals.length).length;
const allMs = legs.flatMap(l => l.arrivals).sort((a, b) => a - b);
console.log(`${done}/${legs.length} legs completed at least once, ` +
            `${legs.reduce((a, l) => a + l.deaths, 0)} death(s), ` +
            `${legs.reduce((a, l) => a + l.attempts, 0)} attempt(s)`);
if (allMs.length)
  console.log(`arrival times: median ${Math.round(allMs[Math.floor(allMs.length / 2)] / 1000)}s, ` +
              `fastest ${Math.round(allMs[0] / 1000)}s, slowest ${Math.round(allMs[allMs.length - 1] / 1000)}s`);
console.log(`recorded in ${BOOK}`);
report();
