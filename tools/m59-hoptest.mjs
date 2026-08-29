#!/usr/bin/env node
// TEST EVERY DOORWAY ON THE FLEET'S ITINERARY, INDEPENDENTLY, IN SECONDS EACH.
//
//   node tools/m59-hoptest.mjs --route grand --tries 4
//   node tools/m59-hoptest.mjs --rooms 50,586,587,576,566,567,568,350
//   node tools/m59-hoptest.mjs --book
//
// A JOURNEY IS A BAD UNIT OF MEASUREMENT AND A HOP IS A GOOD ONE. Walking Tos to Jasper
// takes seven minutes, tests seven boundaries, and if it stalls at the second one it says
// nothing whatever about the other five — so an hour of laps buys a handful of samples
// heavily weighted toward the early hops. `System.UtilGoNearSquare` places a character on
// an exact square in about 0.2 seconds, so each boundary can be tested on its own, from a
// fresh start, as many times as you like, with every bot working a different hop at once.
//
// That is the whole design: the expensive part of the old approach was WALKING TO THE
// THING BEING TESTED, and this repository already owns the tool that removes it.
//
// WHAT IT MEASURES IS ARRIVAL AND TIME, PER BOUNDARY. A hop that fails from three starts
// out of four is a doorway with a problem, and the failures name the square they started
// from — which is what makes it a bug report rather than a statistic. `m59-exitgap.mjs`
// asks the same question of the MODEL; this asks it of a body.
//
// THE STARTS ARE SPREAD ON PURPOSE. Placing every try on the same square measures one
// route to one anchor; the interesting failures are the ones that depend on which side of
// the room you begin. Starts are drawn from the room's main body, deterministically by
// index so a re-run is comparable.
//
// LOOPBACK ONLY, by m59-dm.mjs's own guard.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dm, resolve, roomObject, relocateCmd, isLoopbackHost, adminTarget } from './m59-dm.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { ROUTES, broker, agentFor } from './m59-circuit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/hoptests.json';
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

/** Squares in the room's main body, spread across it, deterministic. */
export function startsIn(geometry, n) {
  const floor = [];
  for (let r = 1; r <= geometry.rows; r++)
    for (let c = 1; c <= geometry.cols; c++)
      if (geometry.walkable(r, c) && geometry.neighbors(r, c, { collision: true }).length >= 3)
        floor.push({ row: r, col: c });
  if (!floor.length) return [];
  const out = [];
  // A fixed large stride rather than a random draw: comparable between runs, and it
  // walks the whole room instead of clustering wherever the list happens to start.
  const stride = Math.max(1, Math.floor(floor.length / Math.max(1, n)));
  for (let i = 0; i < n; i++) out.push(floor[(i * stride) % floor.length]);
  return out;
}

/**
 * One hop, from one square, with one bot.
 *
 * TRAVEL RATHER THAN go_through, because travel is what the fleet actually calls and it
 * is the thing under test — it picks the exit mechanism, walks to the anchor, and crosses.
 * Testing `go_through` alone would exercise the half that already works.
 */
export async function tryHop(agent, roomObj, start, to,
                              { maxMs = 180000, pollMs = 3000, name = null } = {}) {
  // THE CHARACTER NAME IS ASKED FOR, NOT LOOKED UP IN A TABLE OF FIVE. `agentNameOf` is a
  // hard-coded map of the arena fleet, so every other fleet resolved to its own agent id --
  // `show name shadow01` finds nothing, and the whole sweep came back "cannot resolve the
  // character" for a character that was in game and healthy. Same shape as this tool's
  // keeper-port sweep: a copy of a fact that moved. The caller passes the name the broker
  // itself reports; the table stays as the fallback for the fleets it does describe.
  const who = name ?? agentNameOf(agent);
  const ids = await resolve([who]);
  const id = ids[who];
  if (id == null) return { ok: false, start, why: `cannot resolve the character ${who}` };

  // CANCEL WHATEVER IT WAS DOING FIRST. A character left mid-journey by an earlier run is
  // `busy`, and the broker refuses a second travel with a sentence rather than a code —
  // so without this the whole sweep reports every boundary as failed for a reason that
  // has nothing to do with the boundary. Teleporting a busy character is worse than
  // useless: the old walk carries on from the new position.
  await broker('cancel_movement', { agent }, { timeoutMs: 30000 });
  await new Promise(r => setTimeout(r, 400));

  await dm([relocateCmd(id, roomObj, start.row, start.col)]);
  await new Promise(r => setTimeout(r, 700));

  const t0 = Date.now();
  const sent = await broker('travel', { agent, to, background: true, max_hops: 4 }, { timeoutMs: 60000 });
  // A BOT THAT WAS ALREADY BUSY IS NOT A BROKEN DOORWAY, AND SCORING IT AS ONE POISONS
  // THE WHOLE MEASUREMENT.
  //
  // `travel` refuses while the character is mid-operation — that is `busy` doing its job —
  // and the refusal arrives here looking exactly like a boundary that would not let a
  // character through. It is the artefact this file already names for `568 -> 350` ("the
  // bots were still busy; not a boundary result"), and it recurs the moment a bot is left
  // parked mid-errand by anything else: a run scored 1/4 on 587 -> The King's Way with one
  // of the three failures reading `arena2 is busy: walk to Wester…`, and that run was then
  // compared against a 33% baseline as though the numbers meant the same thing.
  //
  // Reported as `skipped`, not as a failure, because the two are opposite claims about the
  // doorway and a rate that mixes them is not a rate.
  if (sent?._error && /\bis busy\b/i.test(String(sent._error)))
    return { skipped: true, ms: 0, start,
             why: 'the bot was already busy — not a boundary result: ' + sent._error };
  if (sent?._error) return { ok: false, ms: 0, why: 'travel refused: ' + sent._error, start };

  for (;;) {
    await new Promise(r => setTimeout(r, pollMs));
    const st = await broker('status', { agent }, { timeoutMs: 30000 });
    const at = st?.where?.num ?? null;
    if (at === to) return { ok: true, ms: Date.now() - t0, start };
    if (!st?.busy) return { ok: false, ms: Date.now() - t0, start, stuck_in: at,
                            why: st?.last_action?.note ?? st?.last_action?.reason ?? 'stopped without arriving' };
    if (Date.now() - t0 > maxMs) return { ok: false, ms: Date.now() - t0, start, stuck_in: at, why: 'timed out' };
  }
}

const NAME_OF = { t0: 'TESTER', arena1: 'Alpha', arena2: 'Bravo', arena3: 'Charlie',
                  arena4: 'Delta', arena5: 'Echo' };
export const agentNameOf = a => NAME_OF[a] ?? a;

// A FAILURE WITHOUT A START IS STILL A FAILURE, AND THE REPORT MUST SURVIVE IT. One return
// path in `tryHop` carried no `start`, and the summary line dereferenced it unconditionally
// -- so a run that failed for a reason worth reading died in its own reporter with a
// TypeError, printing nothing at all. The reason is the useful half; print it either way.
const startLabel = s => (s && s.row != null && s.col != null) ? `${s.row},${s.col}` : 'start unknown';

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-hoptest.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  if (has('book')) {
    for (const r of load().runs.slice(-40))
      console.log(`${new Date(r.at).toISOString().slice(0, 16)}  ${r.from}->${r.to}  ` +
                  `${r.ok}/${r.tries} ok  median ${Math.round((r.median_ms || 0) / 1000)}s`);
    process.exit(0);
  }

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) { console.error('refusing: not loopback'); process.exit(2); }

  let rooms;
  if (flag('rooms')) rooms = flag('rooms').split(',').map(Number);
  else {
    const route = ROUTES[flag('route', 'grand')];
    if (!route) { console.error('unknown route'); process.exit(2); }
    // Expand the route's legs into the actual room-by-room sequence.
    const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
    const { findPath } = await import('./m59-map.mjs');
    rooms = [route.from];
    let at = route.from;
    for (const leg of route.legs) {
      const p = findPath(map, at, leg);
      if (!p.found) { console.error(`no route ${at} -> ${leg}: ${p.reason}`); process.exit(1); }
      for (const h of p.hops) rooms.push(h.to ?? h);
      at = leg;
    }
  }

  const tries = Number(flag('tries', 3));
  // HOW LONG A HOP MAY TAKE, BECAUSE THE CAP AND A REFUSAL LOOK THE SAME IN THE REPORT.
  // 108 -> 110 crosses in a median of 162s against a 180s default, so one bot passes 4/4 and
  // six bots -- which is the interesting case, a one-square pipe with a crowd in it -- come
  // back "timed out" whether they were blocked for ever or merely slow. A boundary this
  // close to the cap cannot be measured without moving it.
  const maxMs = Number(flag('max-s', 180)) * 1000;
  const bots = (flag('bots', 'Alpha,Bravo,Charlie,Delta,Echo')).split(',').map(s => s.trim());

  // ASK THE BROKER WHO ITS CHARACTERS ARE. The alternative is `NAME_OF`, which knows five
  // arena agents and nothing else, so every fleet outside it failed to resolve -- this run
  // reported 0/4 with "cannot resolve the character shadow01" about a character that was in
  // game and healthy, which reads exactly like a broken doorway. Same shape as the keeper
  // port sweep in this file: a copy of a fact that moved.
  //
  // One call, to the same source `m59-which.mjs` trusts. A broker that cannot answer leaves
  // the map empty and the old table still applies.
  const nameOf = new Map();
  try {
    const f = await broker('fleet', {}, { timeoutMs: 60000 });
    for (const a of (f?.fleet ?? []))
      if (a?.agent && a?.character) nameOf.set(a.agent, a.character);
  } catch { /* fall back to NAME_OF */ }
  if (nameOf.size) process.stderr.write(`the broker names ${nameOf.size} character(s)
`);

  process.stderr.write('loading the baked map...\n');
  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const byRoom = new Map();
  attachStepMasks(map, { geometryOf: r => {
    let g = byRoom.get(r); if (!g) { g = RoomGeometry.fromJSON(r.roo); byRoom.set(r, g); } return g; } });

  console.log(`\ntesting ${rooms.length - 1} boundaries, ${tries} start(s) each, ` +
              `${bots.length} bot(s) in parallel\n`);
  console.log('  from ->   to   ok/try  median   worst start that failed');

  const book = load();
  let totalOk = 0, totalTry = 0;
  const bad = [];

  for (let i = 0; i < rooms.length - 1; i++) {
    const from = rooms[i], to = rooms[i + 1];
    const geometry = byRoom.get(map.rooms[String(from)]);
    if (!geometry) { console.log(`  ${from} -> ${to}: no geometry, skipped`); continue; }
    const roomObj = await roomObject(from);
    if (roomObj == null) { console.log(`  ${from} -> ${to}: room not on this server`); continue; }

    const starts = startsIn(geometry, tries);
    if (!starts.length) { console.log(`  ${from} -> ${to}: no body squares to start from`); continue; }

    // One bot per try, all at once. They are in the same room and may block each other,
    // which is a fact about the fleet rather than a flaw in the test.
    const attempts = await Promise.all(starts.map((s, k) => {
      const a = agentFor(bots[k % bots.length]);
      return tryHop(a, roomObj, s, to, { name: nameOf.get(a) ?? null, maxMs });
    }));

    // Skipped attempts are not tries. See the note on `skipped` above: a bot that was
    // already busy tells us nothing about the doorway, so it must leave the denominator
    // as well as the numerator, or the pass rate silently understates every boundary
    // whose turn came round while something else held a character.
    const skipped = attempts.filter(r => r.skipped);
    const results = attempts.filter(r => !r.skipped);
    const ok = results.filter(r => r.ok);
    const times = ok.map(r => r.ms).sort((a, b) => a - b);
    const med = times.length ? times[Math.floor(times.length / 2)] : 0;
    totalOk += ok.length; totalTry += results.length;
    const fails = results.filter(r => !r.ok);
    if (skipped.length)
      console.log(`      (${skipped.length} attempt(s) skipped — the bot was busy, not a boundary result)`);
    console.log(`  ${String(from).padStart(4)} -> ${String(to).padStart(4)}   ` +
                `${ok.length}/${results.length}    ${String(Math.round(med / 1000) + 's').padStart(6)}   ` +
                (fails.length ? `${startLabel(fails[0].start)} — ${String(fails[0].why).slice(0, 46)}` : ''));
    if (fails.length) bad.push({ from, to, fails: fails.map(f => ({ start: f.start, why: f.why, stuck_in: f.stuck_in })) });
    book.runs.push({ at: Date.now(), from, to, tries: results.length, ok: ok.length, median_ms: med,
                     failures: fails.map(f => ({ start: f.start, why: f.why })) });
  }

  save(book);
  console.log(`\n  TOTAL ${totalOk}/${totalTry} hops crossed` +
              (totalTry ? ` (${(100 * totalOk / totalTry).toFixed(0)}%)` : ''));
  if (bad.length) {
    console.log('\n  boundaries with failures:');
    for (const b of bad) console.log(`    ${b.from} -> ${b.to}: ${b.fails.length} — ` +
      b.fails.map(f => `${startLabel(f.start)} (${String(f.why).slice(0, 40)})`).join('; '));
  }
  console.log(`\nrecorded in ${BOOK}`);
}
