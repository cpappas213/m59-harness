#!/usr/bin/env node
// THE LANE PAST A BODY, AGAINST THE JAM THAT WAS ACTUALLY RECORDED.
//
//   node tools/m59-lane-test.mjs
//
// Offline: it reads a committed fixture and the baked map, opens no socket and touches no
// roster.
//
// WHAT THIS PINS. `tools/fixtures/sewers-108-row27.json` is seventy seconds of a real
// traffic deadlock -- six giant rats one per square centre on row 27 of the Sewers of
// Barloque, 64 wire units apart, that never moved, while three fleet characters oscillated
// in the gaps and NOBODY GOT PAST A RAT. The question this file answers is why, and whether
// the answer is a thing the mover can do.
//
// It is not that the corridor is blocked. There is room to pass -- half a unit of it on each
// side -- and because the wire carries integers, exactly one aim point per side. A walker
// that thinks in SQUARES cannot express that aim, which is why `sidestepAround` returns
// nothing here and the walk falls through to marking the square taken and replanning.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanePastBodies, gapAlongLine, MIN_NOMOVEON, PLAYER_RADIUS,
         CLIENT_FINENESS, KOD_FINENESS, sharedRoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, why) => { skipped++; console.log('  --   ' + name + ' — ' + why); };

const PER_KOD = CLIENT_FINENESS / KOD_FINENESS;      // 16 client units to one wire unit
const NOMOVEON = MIN_NOMOVEON / PER_KOD;             // 16, in wire units
const RADIUS = PLAYER_RADIUS / PER_KOD;              // 15.5, in wire units

console.log('\nthe recorded jam — Sewers of Barloque, row 27');

const FIX = join(HERE, 'fixtures', 'sewers-108-row27.json');
if (!existsSync(FIX)) {
  skip('the jam fixture is on disk', 'tools/fixtures/sewers-108-row27.json is missing');
} else {
  const jam = JSON.parse(readFileSync(FIX, 'utf8'));
  const rats = (jam.static ?? []).filter(o => o.kind === 'monster');

  ok('six monsters were recorded, one per square, and none of them moved',
     rats.length === 6 && rats.every(r => r.row === 27),
     JSON.stringify(rats.map(r => `${r.row},${r.col}`)));

  // 64 wire units apart is one square apart, which is what makes this a wall of bodies
  // rather than a crowd: there is no square between two of them to aim at.
  // Four of the five gaps are exactly one square; the westernmost rat sits a little off
  // its centre (x 2579, y 1755) and makes the first gap 77. Asserting all five were 64 was
  // an assertion about a tidier jam than the one that was recorded.
  const xs = rats.map(r => r.x).sort((a, b) => a - b);
  const spacing = xs.slice(1).map((x, i) => x - xs[i]);
  const oneSquare = spacing.filter(d => Math.abs(d - KOD_FINENESS) <= 8).length;
  ok('they stand one square apart, so there is no gap SQUARE to aim at',
     oneSquare >= spacing.length - 1 && spacing.every(d => d <= KOD_FINENESS + 16),
     JSON.stringify(spacing));

  // NOBODY GOT PAST. Two characters were recorded moving, and between them they visited
  // three squares in seventy seconds.
  //
  // Per character, not pooled: the two of them were at opposite ends of the rat wall, so
  // the union of their squares is five and says nothing. What matters is that NEITHER
  // crossed it -- each stayed inside a two-column stretch on its own side.
  const moved = (jam.moving ?? []).filter(m => m.kind === 'player');
  const spans = moved.map(m => {
    const cols = m.points.map(p => p.col);
    return { who: m.name, from: Math.min(...cols), to: Math.max(...cols) };
  });
  ok('neither moving character got past the rats in seventy seconds',
     spans.length === 2 && spans.every(s2 => s2.to - s2.from <= 1) && (jam.seconds ?? 0) >= 60,
     JSON.stringify(spans) + ' over ' + jam.seconds + 's');

  // ---------------------------------------------------------------- the arithmetic
  //
  // Taken from the recording rather than assumed: the corridor's floor spans one square in
  // y, and a rat sits on the centre line of it.
  const ratY = 1760, wallLo = 1728, wallHi = 1792;
  ok('a rat sits on the centre line of a corridor exactly one square tall',
     rats.some(r => Math.abs(r.y - ratY) <= 8) && (wallHi - wallLo) === KOD_FINENESS,
     `rat y ${rats.map(r => r.y).join(',')} in ${wallLo}..${wallHi}`);

  const standLo = wallLo + RADIUS, standHi = wallHi - RADIUS;
  const feasible = [];
  for (let y = Math.ceil(standLo); y <= Math.floor(standHi); y++)
    if (Math.abs(y - ratY) >= NOMOVEON) feasible.push(y);

  // THE FINDING. Half a unit of room on each side, and the wire carries integers.
  ok('there is exactly ONE integer aim point on each side of a centred body',
     feasible.length === 2 && feasible[0] === 1744 && feasible[1] === 1776,
     JSON.stringify({ standLo, standHi, feasible }));

  ok('and a square centre is NOT one of them, which is what the walker aims at',
     !feasible.includes(wallLo + KOD_FINENESS / 2),
     'the centre is ' + (wallLo + KOD_FINENESS / 2));

  // ---------------------------------------------------------------- the lane finds it
  const bodies = rats.map(r => ({ x: r.x, y: r.y, name: r.name }));
  const hasFloor = (_x, y) => y >= wallLo && y <= wallHi;
  const lane = lanePastBodies({
    fromX: 2513, fromY: 1760,          // where a recorded character actually stood
    toX: 2900, toY: 1760,              // east, past the whole row of rats
    bodies, hasFloor,
  });
  ok('the lane finds a way past a wall of bodies the sidestep cannot express',
     !!lane && Math.abs(lane.off) >= NOMOVEON && feasible.includes(lane.y),
     JSON.stringify(lane));

  ok('and it aims at one of the two integers the arithmetic allows',
     !!lane && (lane.y === 1744 || lane.y === 1776), JSON.stringify(lane?.y));

  // Straight down the middle is refused, which is the state the recording captured.
  const straight = gapAlongLine(2513, 1760, 2900, 1760, bodies);
  ok('while the straight line through them is refused',
     straight.gap < NOMOVEON, JSON.stringify(straight));

  // ---------------------------------------------------------------- and on the real map
  const map = (() => { try { return loadMap(); } catch { return null; } })();
  if (!map?.rooms?.['108']) {
    skip('the corridor is one square wide on the baked map', 'no room 108 geometry on disk');
  } else {
    attachStepMasks(map);
    const geo = sharedRoomGeometry(map.rooms['108']);
    const widths = [39, 40, 41].map(c => {
      let n = 0;
      for (let r = 25; r <= 29; r++) if (geo.standPoint(r, c)) n++;
      return n;
    });
    ok('cols 39-41 are one square wide on the baked map, so there IS no side square',
       widths.every(w => w === 1), JSON.stringify(widths));
  }
}

console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ''));
process.exit(fail ? 1 : 0);
