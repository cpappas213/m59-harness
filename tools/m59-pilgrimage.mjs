#!/usr/bin/env node
// SCATTER THE FLEET ACROSS THE MAINLAND AND ASK HOW MANY GET HOME.
//
//   node tools/m59-pilgrimage.mjs --fleet shadow --to 2
//   node tools/m59-pilgrimage.mjs --fleet shadow --to 2 --seed 7 --timeout 600
//   node tools/m59-pilgrimage.mjs --dry-run
//
// `m59-solo-run.mjs` answers "can ONE character walk THIS road", one at a time, from one
// square, because twenty-one characters crossing together measure contention as much as
// they measure the road. This asks the other question, which is the one the fleet actually
// lives: everybody starts somewhere different and everybody goes to the same place.
//
// WHY THE FIVE INNS. They are the mainland's fixed points — the rooms the Underworld's
// portals land in (CITY_INNS in m59-underworld.mjs, RIDs from blakston.khd), so they are
// where a dead character comes back to and where a journey starts in practice. Scattering
// across all five means the run measures a spread of roads rather than one, and the report
// says which city's road is the bad one instead of averaging it away.
//
// LOOPBACK ONLY, and it refuses otherwise. This relocates bodies with the DM tools, which
// is a lab-server power; the same run against prod would need the fleet to walk to the inns
// first, and that is a different experiment.
//
// Everything it reports is measured from the character, not from the request: `arrived`
// means the room read back as the destination. See docs/m59-operations.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { CITY_INNS } from './m59-underworld.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNDERWORLD = 1;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? fallback : argv[i + 1];
};
const has = name => argv.includes('--' + name);

const KNOWN = new Set(['fleet', 'to', 'port', 'timeout', 'seed', 'agents', 'inns',
                       'dry-run', 'help', 'h']);
for (const a of argv) {
  if (!a.startsWith('--')) continue;
  if (!KNOWN.has(a.slice(2))) {
    console.error(`m59-pilgrimage: unknown option ${a}`);
    console.error(`known: ${[...KNOWN].map(k => '--' + k).join(' ')}`);
    process.exit(2);
  }
}
if (has('help') || has('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const FLEET = flag('fleet', process.env.M59_FLEET
  ?? (() => { try { return readFileSync(join(REPO, 'substrate', 'fleet-default'), 'utf8').trim(); }
              catch { return '-'; } })());
const PORT = Number(flag('port', 8971));
const TO = Number(flag('to', 2));
const TIMEOUT = Number(flag('timeout', 600)) * 1000;
const DRY = has('dry-run');
const ONLY = flag('agents') ? String(flag('agents')).split(',').map(s => s.trim()).filter(Boolean) : null;

// The mainland five, in the canonical table's own order. Ko'catan is across the sea and is
// not a mainland road, so it is left out unless somebody names it.
const MAINLAND = ['Tos', 'Barloque', 'Cornoth', 'Marion', 'Jasper'];
const CITIES = flag('inns') ? String(flag('inns')).split(',').map(s => s.trim()) : MAINLAND;
for (const c of CITIES) if (!CITY_INNS[c]) {
  console.error(`m59-pilgrimage: no inn known for "${c}". Known: ${Object.keys(CITY_INNS).join(', ')}`);
  process.exit(2);
}

// A SEEDED SHUFFLE, so a run can be repeated against a change rather than compared with a
// different draw. `--seed` is printed in the header for exactly that reason.
const SEED = Number(flag('seed', 1));
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

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
        catch (e) { return done({ _error: `no result from ${name}: ${String(t).slice(0, 80)}` }); }
        // A TOOL THAT REFUSES ANSWERS IN PROSE. `travel` replies "error: <agent> is not in
        // game" as bare text, and parsing that as JSON reports a SyntaxError — which reads
        // like a broken tool instead of a refused request, and put three characters in the
        // first run's report as "Unexpected token 'e'".
        try { done(JSON.parse(text)); }
        catch { done({ _error: String(text).trim().slice(0, 120) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`m59-pilgrimage: ${rosterFile} does not name one game server.`);
  process.exit(2);
}
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`m59-pilgrimage: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, not loopback.`);
  console.error('          Relocating bodies is a lab-server power. On a real server the fleet');
  console.error('          has to WALK to the inns, which is a different experiment.');
  process.exit(2);
}

const fleet = await call('fleet', {});
if (fleet._error) { console.error(`m59-pilgrimage: broker on ${PORT} did not answer (${fleet._error})`); process.exit(1); }
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
rows.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!rows.length) { console.error('m59-pilgrimage: no characters matched.'); process.exit(1); }

// Deal the cities round-robin over a shuffled roster rather than choosing independently at
// random per character: an independent draw over 21 characters routinely leaves a city with
// one traveller and another with seven, and then the per-city column is noise.
const draw = rng(SEED);
const order = rows.map((r, i) => ({ r, k: draw(), i }))
                  .sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.r);
const assignment = new Map();
order.forEach((r, n) => assignment.set(r.agent, CITIES[n % CITIES.length]));

const destName = fleet.rooms?.[String(TO)]?.name ?? null;
console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(`${rows.length} character(s) scattered over ${CITIES.length} inn(s), all bound for ` +
            `room ${TO}${destName ? ` (${destName})` : ''}, ${TIMEOUT / 1000}s each, seed ${SEED}`);
for (const c of CITIES) {
  const n = [...assignment.values()].filter(v => v === c).length;
  console.log(`  ${c.padEnd(10)} inn ${String(CITY_INNS[c].inn).padStart(4)}  ${CITY_INNS[c].innName.padEnd(34)} ${n} traveller(s)`);
}
console.log();
if (DRY) {
  for (const r of order) console.log(`  ${r.character.padEnd(8)} (${r.agent})  from ${assignment.get(r.agent)}`);
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');

async function launch(r) {
  const city = assignment.get(r.agent);
  const inn = CITY_INNS[city].inn;
  const out = { character: r.character, agent: r.agent, city, inn,
                began: Date.now(), rooms: new Set(), low: null, outcome: 'running' };
  // Idle, unparked and NOT roaming: a character that wanders off to hunt is not measuring
  // the road, and `roam` is the one setting that quietly reintroduces that.
  await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  await call('autopilot', { agent: r.agent, action: 'unpark' });
  await dm.relocate([r.character], inn, { verify: false }).catch(() => null);

  // WHOLE, AND ALL THREE VITALS. `recoverUntilWhole` is set by a death and stays set until
  // health, mana AND vigor are back; while it is up, the first rung of the ladder ends every
  // tick and `travel` is refused the instant it is asked. A leg that starts under that hold
  // measures the hold. See the same argument in m59-solo-run.mjs.
  try {
    const ids = await dm.resolve([r.character]);
    const max = r.max_health ?? r.maxHealth ?? null;
    if (ids?.[r.character] != null && max) {
      const cmds = [...dm.healthCmds(ids[r.character], max)];
      if (typeof dm.manaCmds === 'function') cmds.push(...dm.manaCmds(ids[r.character], 50));
      await dm.dm(cmds, { timeoutMs: 60000 });
    }
  } catch { /* healing is a courtesy; the leg is still a leg without it */ }

  const sent = await call('travel', { agent: r.agent, to: TO, max_hops: 30, background: true,
                                      run_errands: false });
  if (sent?._error || sent?.ok === false) {
    out.outcome = 'refused';
    out.why = sent?.why ?? sent?.error ?? sent?._error ?? 'travel refused';
    out.ms = Date.now() - out.began;
  }
  return out;
}

// ONE POLL FOR THE WHOLE FLEET, NOT ONE PER CHARACTER.
//
// The first version asked `autopilot action=status` per character every five seconds — 21
// requests a cycle into a broker whose event loop the same 21 keepers are already sharing,
// to answer a question that one `fleet` call answers for everybody. It also read the wrong
// field: a fleet row's `room` is the room's NAME and `room_num` is the number, so every
// reading came back NaN and the whole first run reported "timed out ... NaN".
async function watchAll(outs) {
  const live = new Map(outs.filter(o => o.outcome === 'running').map(o => [o.agent, o]));
  const began = Date.now();
  while (live.size && Date.now() - began < TIMEOUT) {
    await sleep(5000);
    const snap = await call('fleet', {}, 60000);
    if (snap?._error) continue;
    for (const row of (snap.fleet ?? [])) {
      const o = live.get(row.agent);
      if (!o) continue;
      const room = Number(row.room_num ?? NaN);
      if (Number.isFinite(room)) { o.rooms.add(room); o.ended = room; o.endedName = row.room ?? null; }
      const hp = Number(row.health ?? NaN);
      if (Number.isFinite(hp)) o.low = o.low === null ? hp : Math.min(o.low, hp);
      const max = Number(row.max_health ?? row.health_max ?? NaN);
      if (Number.isFinite(max)) o.max = max;
      if (room === TO) { o.outcome = 'arrived'; o.ms = Date.now() - o.began; live.delete(row.agent); continue; }
      // THE UNDERWORLD IS A DEATH, and it is the only honest way to see one from here: the
      // journey does not report it, the room read does.
      if (room === UNDERWORLD) { o.outcome = 'died'; o.ms = Date.now() - o.began; live.delete(row.agent); }
    }
  }
  for (const o of live.values()) { o.outcome = 'timed out'; o.ms = Date.now() - o.began; }
  return outs;
}

console.log('launching…');
const launched = [];
for (const r of order) {
  launched.push(await launch(r));
  await sleep(400);           // the pacer is per character; this is only to be kind to the DM port
}
const results = await watchAll(launched);

// ------------------------------------------------------------------ the report
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log('\n  character  from        outcome      s   ended            low');
for (const o of results.sort((a, b) => a.city.localeCompare(b.city) || a.character.localeCompare(b.character)))
  console.log('  ' + pad(o.character, 10) + pad(o.city, 11) + pad(o.outcome, 11) +
              String(Math.round(o.ms / 1000)).padStart(4) + '   ' +
              pad(String(o.ended ?? '?') + (o.endedName ? ' ' + o.endedName : ''), 17) +
              (o.low === null ? '' : ' ' + o.low + (o.max ? '/' + o.max : '')) +
              (o.why ? '  — ' + o.why : ''));

const n = results.length;
const arrived = results.filter(o => o.outcome === 'arrived');
const died = results.filter(o => o.outcome === 'died');
const refused = results.filter(o => o.outcome === 'refused');
const out = results.filter(o => o.outcome === 'timed out');
console.log('\nFLEET');
console.log(`  set off   ${n}`);
console.log(`  arrived   ${arrived.length}  (${Math.round(100 * arrived.length / n)}%)`);
console.log(`  died      ${died.length}`);
console.log(`  timed out ${out.length}`);
if (refused.length) console.log(`  refused   ${refused.length}`);
if (arrived.length) {
  const t = arrived.map(o => o.ms).sort((a, b) => a - b);
  console.log(`  of those that arrived: fastest ${Math.round(t[0] / 1000)}s, ` +
              `median ${Math.round(t[t.length >> 1] / 1000)}s, slowest ${Math.round(t[t.length - 1] / 1000)}s`);
}

console.log('\nBY THE ROAD THEY TOOK');
for (const c of CITIES) {
  const mine = results.filter(o => o.city === c);
  if (!mine.length) continue;
  const ok = mine.filter(o => o.outcome === 'arrived').length;
  const d = mine.filter(o => o.outcome === 'died').length;
  console.log(`  ${pad(c, 10)} ${ok}/${mine.length} arrived` + (d ? `, ${d} died` : '') +
              '   ' + '#'.repeat(ok) + '.'.repeat(mine.length - ok));
}

const stuck = {};
for (const o of results) {
  if (o.outcome === 'arrived') continue;
  const k = (o.ended ?? '?') + (o.endedName ? ' ' + o.endedName : '');
  stuck[k] = (stuck[k] || 0) + 1;
}
if (Object.keys(stuck).length) {
  console.log('\nWHERE THE REST ENDED UP');
  for (const [k, v] of Object.entries(stuck).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  ${k}`);
}
