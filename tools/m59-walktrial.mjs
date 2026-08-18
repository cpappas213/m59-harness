#!/usr/bin/env node
// MAKE A BOT WALK A HUNDRED ROUTES AND WRITE DOWN WHICH ONES IT CANNOT.
//
//   node tools/m59-walktrial.mjs --room 575 --who Echo --routes 30
//   node tools/m59-walktrial.mjs --room 575 --plan-only --routes 500     offline, no server
//   node tools/m59-walktrial.mjs --room 575 --plan-only --compare        collision vs coarse
//   node tools/m59-walktrial.mjs --book
//
// THE QUESTION IS WHETHER THE SAFE WALLS AND THE ROUTING FAILURES ARE THE SAME PLACES,
// AND UNTIL NOW THAT WAS AN ASSUMPTION. Every document in this repository connects them —
// "a safe wall IS the coarse grid and the BSP disagreeing, and the fleet seeks those
// squares out" — and the connection is plausible, mechanistic and completely untested
// against a walking character. Plausible-and-untested is how this repository got
// "another machine is holding the fleet", "travel is frozen" and "17,402 pockets", each
// of which was believed, acted on, and wrong.
//
// Measured offline first, over the 13 rooms the fleet actually uses: a square nothing can
// reach is 145x more likely to be one the ROUTER cannot step off (5.21% against 0.04%)
// and 6.3x more likely to be a trap or isolated (7.81% against 1.24%). So the geometry
// says yes. This is the other half — a body, walking, being refused.
//
// TWO MODES, AND THE OFFLINE ONE IS NOT A LESSER VERSION. `--plan-only` asks the router
// the same question the walker would and needs no server, no broker and no character, so
// it can run five hundred routes in a minute and cover a room properly. The live mode
// walks perhaps thirty in the same time and is the only thing that can catch the router
// being right and the MOVER disagreeing — which is the failure that produced the
// two-square bounce. Run the cheap one to find the candidates, the expensive one to
// believe them.
//
// WHAT IT RECORDS IS THE PAIR, NOT THE FAILURE. "Bot could not get there" is what the
// fleet board already says. This writes down where it STARTED, where it was going, what
// class each of those squares is, and which of the several distinguishable refusals came
// back — because the whole finding is a correlation between the class of a square and the
// kind of refusal, and neither half alone is worth anything.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { exposureAt } from './m59-safespots.mjs';
import { wedgesIn } from './m59-wedges.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { dm, resolve, roomObject, relocateCmd, isLoopbackHost, adminTarget } from './m59-dm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/walktrials.json';
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { trials: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

const AGENTS = { TESTER: 't0', Alpha: 'arena1', Bravo: 'arena2', Charlie: 'arena3',
                 Delta: 'arena4', Echo: 'arena5' };
export const agentFor = n => AGENTS[n] ?? n;

export async function broker(name, args, { port = Number(process.env.M59_BROKER_PORT || 8961) } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) return { _error: `broker answered ${r.status}` };
    const j = await r.json();
    if (j.error) return { _error: j.error.message };
    return JSON.parse(j.result?.content?.[0]?.text ?? '{}');
  } catch (e) { return { _error: e.message }; }
}

/**
 * Classify every walkable square in a room once.
 *
 * ONE PASS, CACHED, because `exposureAt` is the expensive call here and a trial asks
 * about the same squares hundreds of times. Classes are deliberately not exclusive —
 * a square can be both a fortress and a trap, and that combination is the interesting
 * one — so this returns a set per square rather than a label.
 */
export function classifyRoom(geometry) {
  const w = wedgesIn(geometry) || { traps: [], isolated: [], detours: [] };
  const trap = new Set(w.traps.map(s => `${s.row},${s.col}`));
  const iso = new Set(w.isolated.map(s => `${s.row},${s.col}`));
  const of = new Map();
  const floor = [];
  for (let r = 1; r <= geometry.rows; r++)
    for (let c = 1; c <= geometry.cols; c++) {
      if (!geometry.walkable(r, c)) continue;
      const k = `${r},${c}`;
      const tags = new Set();
      let ex = null; try { ex = exposureAt(geometry, r, c); } catch { /* unscoreable */ }
      if (ex && ex.attackers === 0 && (ex.free_shots ?? 0) > 0) tags.add('fortress');
      if (trap.has(k)) tags.add('trap');
      if (iso.has(k)) tags.add('isolated');
      if (geometry.neighbors(r, c, { collision: true }).length === 0) tags.add('locked');
      if (!tags.size) tags.add('ordinary');
      of.set(k, tags);
      floor.push({ row: r, col: c, tags });
    }
  return { of, floor };
}

/**
 * Ask the router, exactly as `walkTo` would.
 *
 * INCLUDING THE COARSE FALLBACK, because that is what the walker actually does
 * (m59-broker.mjs:3312-3317) and a trial that omitted it would report failures the fleet
 * never sees. The distinction is kept though: a route that only exists on the coarse
 * grid is one the MOVER will refuse step by step, which is the bounce.
 */
export function planBetween(geometry, from, to) {
  let p = geometry.path(from.row, from.col, to.row, to.col);
  if (p.found) return { kind: 'collision', steps: p.steps.length, expanded: p.expanded };
  const collisionRefused = !!p.collision_view;
  let q = geometry.path(from.row, from.col, to.row, to.col, { collision: false });
  if (q.found) return { kind: collisionRefused ? 'coarse-only' : 'coarse', steps: q.steps.length,
                        reason: p.reason };
  return { kind: 'no-route', reason: p.reason ?? q.reason };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-walktrial.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  if (has('book')) {
    const b = load();
    for (const t of b.trials.slice(-20))
      console.log(`${new Date(t.at).toISOString().slice(0, 16)}  room ${t.room}  ${t.mode}  ` +
                  `${t.routes} routes  ` + Object.entries(t.byClass || {})
                    .map(([k, v]) => `${k} ${v.fail}/${v.n}`).join('  '));
    process.exit(0);
  }

  const room = Number(flag('room', 575));
  const routes = Number(flag('routes', 200));
  const who = flag('who', 'Echo');

  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const byRoom = new Map();
  attachStepMasks(map, { geometryOf: r => {
    let g = byRoom.get(r); if (!g) { g = RoomGeometry.fromJSON(r.roo); byRoom.set(r, g); } return g; } });
  const geometry = byRoom.get(map.rooms[String(room)]);
  if (!geometry) { console.error(`no geometry for room ${room}`); process.exit(1); }
  if (!geometry.hasStepMask) { console.error('no baked step mask — the trial would test the coarse grid'); process.exit(1); }

  process.stderr.write('classifying the room...\n');
  const { of, floor } = classifyRoom(geometry);
  const forts = floor.filter(s => s.tags.has('fortress'));
  const ord = floor.filter(s => s.tags.has('ordinary'));
  console.log(`room ${room}: ${floor.length} walkable, ${forts.length} fortress, ${ord.length} ordinary\n`);

  // DELIBERATELY STRATIFIED. Sampling uniformly would put 6% of the routes on fortress
  // squares and the comparison would rest on a handful; the whole question is whether
  // those squares behave differently, so both arms get the same number of routes.
  const pick = a => a[Math.floor((a.length * (Math.random ? Math.random() : 0.5)))] ?? a[0];
  const arms = [
    { name: 'from fortress', pool: forts },
    { name: 'from ordinary', pool: ord },
  ];

  const byClass = {};
  const failures = [];
  for (const arm of arms) {
    if (!arm.pool.length) continue;
    byClass[arm.name] = { n: 0, fail: 0, coarseOnly: 0 };
    for (let i = 0; i < routes; i++) {
      const from = arm.pool[i % arm.pool.length];
      const to = ord[(i * 7919) % ord.length];       // a fixed stride, so runs are comparable
      if (!to || (to.row === from.row && to.col === from.col)) continue;
      const p = planBetween(geometry, from, to);
      byClass[arm.name].n++;
      if (p.kind === 'no-route') {
        byClass[arm.name].fail++;
        failures.push({ arm: arm.name, from: `${from.row},${from.col}`, to: `${to.row},${to.col}`,
                        tags: [...from.tags], reason: p.reason });
      } else if (p.kind === 'coarse-only') byClass[arm.name].coarseOnly++;
    }
  }

  console.log('=== PLANNED ROUTES (the question walkTo asks before sending a packet) ===\n');
  console.log('  arm                routes   NO ROUTE          coarse-only (mover will fight it)');
  for (const [k, v] of Object.entries(byClass))
    console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(6)}   ` +
                `${(v.fail + ' (' + (100 * v.fail / v.n).toFixed(1) + '%)').padStart(15)}   ` +
                `${v.coarseOnly} (${(100 * v.coarseOnly / v.n).toFixed(1)}%)`);
  const f = byClass['from fortress'], o = byClass['from ordinary'];
  if (f && o && o.fail > 0)
    console.log(`\n  relative risk of NO ROUTE from a safe wall: ` +
                `${((f.fail / f.n) / (o.fail / o.n)).toFixed(1)}x`);
  else if (f && o)
    console.log(`\n  ordinary squares failed ${o.fail} times; fortress ${f.fail}`);

  if (failures.length) {
    console.log('\n  first failures:');
    for (const x of failures.slice(0, 8))
      console.log(`    ${x.arm}  ${x.from} -> ${x.to}  [${x.tags.join(',')}]  ${x.reason}`);
  }

  const b = load();
  b.trials.push({ at: Date.now(), room, mode: has('plan-only') ? 'plan' : 'plan+walk',
                  routes, byClass, failures: failures.slice(0, 200) });
  save(b);

  if (has('plan-only')) { console.log(`\nrecorded in ${BOOK}`); process.exit(0); }

  // ---- the live half
  const target = adminTarget();
  if (!isLoopbackHost(target.host)) { console.error('refusing: not loopback'); process.exit(2); }
  const roomObj = await roomObject(room);
  const ids = await resolve([who]);
  if (ids[who] == null || roomObj == null) { console.error('cannot find the bot or the room'); process.exit(1); }

  const live = Number(flag('live', 12));
  console.log(`\n=== WALKING ${live} of them for real, as ${who} ===\n`);
  const walked = { fortress: { n: 0, fail: 0 }, ordinary: { n: 0, fail: 0 } };
  for (const arm of arms) {
    const key = arm.name.includes('fortress') ? 'fortress' : 'ordinary';
    for (let i = 0; i < live; i++) {
      const from = arm.pool[(i * 13) % arm.pool.length];
      const to = ord[(i * 7919) % ord.length];
      if (!from || !to) continue;
      await dm([relocateCmd(ids[who], roomObj, from.row, from.col)]);
      await new Promise(r => setTimeout(r, 900));
      const r = await broker('walk_to', { agent: agentFor(who), col: to.col, row: to.row, max_steps: 80 });
      walked[key].n++;
      const okd = !!r?.arrived;
      if (!okd) {
        walked[key].fail++;
        console.log(`  ${key.padEnd(9)} ${from.row},${from.col} -> ${to.row},${to.col}  ` +
                    `FAILED: ${r?.reason ?? r?.note ?? r?._error ?? 'unknown'}`);
      }
    }
  }
  console.log('\n  walked   from-fortress ' + walked.fortress.fail + '/' + walked.fortress.n +
              ' failed   from-ordinary ' + walked.ordinary.fail + '/' + walked.ordinary.n + ' failed');
  console.log(`\nrecorded in ${BOOK}`);
}
