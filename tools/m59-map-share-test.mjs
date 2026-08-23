#!/usr/bin/env node
// THE MAP'S SHARING CONTRACT — the regression test for the cold-start stall class.
//
//   node tools/m59-map-share-test.mjs
//
// The 24s/13s/11s recurring tick stalls all came from ONE shape of bug: loadMap()
// returned a fresh object per call, so every consumer paid its own lazy builds
// (reverse-edge table ~11s, geometry, step-mask attach) on ITS private instance —
// and the first one to do so on the tick path stalled the loop. These tests pin the
// three invariants that closed it:
//
//   1. loadMap() is memoized per file — one shared map per process, so a build paid
//      once (at startup) is paid for everyone.
//   2. The memo key includes mtime+size, so a rewritten file (tests, map updates)
//      still reloads.
//   3. inferredExits reads the shared table rather than rebuilding it, and is fast
//      after buildReverseEdges has run.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMap, buildReverseEdges, inferredExits, passableExits, findPath } from './m59-map.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const tmp = mkdtempSync(join(tmpdir(), 'm59-map-share-'));
try {
  // 1. SAME FILE -> SAME OBJECT (the sharing contract itself).
  const fixtureA = join(tmp, 'a.json');
  writeFileSync(fixtureA, JSON.stringify({ rooms: { 1: { num: 1, name: 'R1', edgeExits: [], goExits: [] } } }));
  const m1 = loadMap(fixtureA);
  const m2 = loadMap(fixtureA);
  ok('loadMap() returns the same object for the same file', m1 === m2,
     'each caller got a private instance — lazy builds re-paid per consumer');

  // 2. REWRITTEN FILE -> FRESH OBJECT (tests depend on reload-on-write).
  writeFileSync(fixtureA, JSON.stringify({ rooms: {
    1: { num: 1, name: 'R1a', edgeExits: [], goExits: [] },
    2: { num: 2, name: 'R2', edgeExits: [], goExits: [] } } }));
  const m3 = loadMap(fixtureA);
  ok('loadMap() reloads when the file is rewritten', m3 !== m1 && Object.keys(m3.rooms).length === 2,
     `m3===m1: ${m3 === m1}, rooms: ${Object.keys(m3.rooms).length}`);

  // 3. THE SHARED MAP PAYS THE REVERSE BUILD ONCE. buildReverseEdges sets the table;
  //    inferredExits must READ it, not rebuild it. The real map is the honest fixture:
  //    the build is ~11s, the read must be milliseconds.
  const real = loadMap();
  const t0 = Date.now();
  buildReverseEdges(real);
  const buildMs = Date.now() - t0;
  ok('buildReverseEdges runs and attaches a table', real.__reverse instanceof Map);
  const t1 = Date.now();
  for (const num of Object.keys(real.rooms).slice(0, 50)) inferredExits(real, num);
  const readMs = Date.now() - t1;
  ok('inferredExits reads the built table (fast after build)',
     readMs < 500, `50 reads took ${readMs}ms (build was ${buildMs}ms)`);

  // 4. A SECOND loadMap() CONSUMER GETS THE BUILT TABLE FOR FREE. This is the exact
  //    keeper bug: the Router's loadMap() created a fresh map, and its first route
  //    search re-paid the whole build on the tick.
  const t2 = Date.now();
  const again = loadMap();
  ok('a second loadMap() shares the warmed map', again === real || again.__reverse instanceof Map,
     `__reverse present: ${again.__reverse instanceof Map}`);
  const t3 = Date.now();
  for (const num of Object.keys(again.rooms).slice(0, 50)) inferredExits(again, num);
  ok('inferredExits is fast on the shared instance too', Date.now() - t3 < 500,
     `50 reads took ${Date.now() - t3}ms (shared instance)`);

  // 5. bfsPath results are stable per (from, to, avoid): the same route asked twice
  //    must be the same answer (findPath consults a cache keyed on the static graph).
  const froms = Object.keys(real.rooms).map(Number).filter(n => n !== 1016);
  const p1 = findPath(real, froms[0], 1016);
  const p2 = findPath(real, froms[0], 1016);
  ok('findPath is deterministic for the same pair',
     !!p1.found === !!p2.found && p1.hops?.length === p2.hops?.length,
     `first=${p1.found}/${p1.hops?.length} second=${p2.found}/${p2.hops?.length}`);

  // 6. passableExits never throws and always returns an array for every real room.
  let bad = 0;
  for (const num of Object.keys(real.rooms)) {
    try { const ex = passableExits(real, num); if (!Array.isArray(ex)) bad++; }
    catch { bad++; }
  }
  ok('passableExits is total over the real map', bad === 0, `${bad} rooms failed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
