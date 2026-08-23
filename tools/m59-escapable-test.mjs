#!/usr/bin/env node
// FROM ANYWHERE YOU CAN GET TO, YOU CAN GET OUT.
//
//   node tools/m59-escapable-test.mjs
//   node tools/m59-escapable-test.mjs --dirs C:/code/Meridian59/resource/rooms
//
// Offline. Reads .roo files if it can find them and SKIPS CLEANLY if it cannot, because a
// fresh clone has no game resources and a test that fails for want of them teaches nothing.
//
// ==================== WHAT THIS MEASURES, AND WHAT IT REPLACED ====================
//
// This file was first written as a STEP SYMMETRY test — whether `moverStepLands(a,b)` agreed
// with `moverStepLands(b,a)` — and it reported thousands of disagreements as a defect, with
// The Cragged Mountains at eight percent held up as the worst room in the fleet's path.
//
// THAT WAS WRONG. A step you can take is not necessarily a step you can take back. You drop
// down a cliff in the Cragged Mountains or in Ukgoth and you cannot climb back up it, and
// `moverStepLands` models precisely that on purpose — `FALL_MAX_SQUARES` and
// `MAX_STEP_HEIGHT` ARE the asymmetry. The eight percent was the Cragged Mountains having
// mountains in it, and the test was asserting something false about the game.
//
// The property that is actually true is weaker and more useful: you can LEAVE anywhere you
// can GET TO. A cliff bottom is fine — you walk away along the bottom. What cannot happen is
// a square a body can arrive at and never leave.
//
// So flood FORWARD from every boundary square for everything a body could arrive at, flood
// BACKWARD from the same squares for everything that can still reach one, and the difference
// is the genuine traps. Measured 2026-08-23:
//
//     597  The Twisted Wood         reachable 1092   can-get-out 1112   TRAPPED   1
//     598  The Cragged Mountains    reachable 2728   can-get-out 2720   TRAPPED  10
//     587  Western border           reachable 1620   can-get-out 1705   TRAPPED   0
//     586  Main gate to Tos         reachable 2334   can-get-out 2336   TRAPPED   0
//
// Eleven squares across four rooms, not thousands. The safe-spot search already refuses
// squares it cannot escape from, so nothing sits on one deliberately; this is here so that a
// mover change which starts MANUFACTURING traps is visible the day it lands, and so that a
// fix shows up as a number going down rather than as nothing happening.
//
// A NOTE ON 5,35 IN THE TWISTED WOOD, which started all of this. It is not in the trapped
// set — because it is not in the REACHABLE set either. No flood from any boundary square
// gets there. And yet the safe-spot book records a character having HELD on it. A body
// reached a square the mover says cannot be reached, which is a disagreement between the
// fine walker and the step predicate, and it is still unexplained.
// `node tools/m59-exitgap.mjs` is the instrument pointed at that class of thing.

import { loadRoo, DEFAULT_ROO_DIRS } from './m59-roo.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const dirs = flag('dirs') ? [flag('dirs')] : DEFAULT_ROO_DIRS;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const ROOMS = [
  [597, 'i7.roo', 'The Twisted Wood'],
  [598, 'i8.roo', 'The Cragged Mountains'],
  [587, 'h7.roo', 'Western border of the Twisted Wood'],
  [586, 'h6.roo', 'Main gate to the city of Tos'],
];

// A RATCHET, NOT A STANDARD. The counts on the day it was written.
const BASELINE = { 597: 1, 598: 10, 587: 0, 586: 0 };

console.log('');
console.log('FROM ANYWHERE YOU CAN GET TO, YOU CAN GET OUT');
console.log('  (a cliff you cannot climb back up is the game working, not a trap)');

let checkedAny = false;
for (const [num, file, name] of ROOMS) {
  let geo = null;
  try { geo = loadRoo(file, dirs); } catch { geo = null; }
  if (!geo || !geo.collisionReady || typeof geo.moverStepLands !== 'function') {
    console.log(`  --   ${file} not available here — skipped`);
    continue;
  }
  checkedAny = true;
  const key = (r, c) => r + ',' + c;
  const step = (a, b, c, d) => { try { return geo.moverStepLands(a, b, c, d); } catch { return false; } };

  const edge = [];
  for (let r = 1; r <= geo.rows; r++) for (const c of [1, geo.cols]) {
    try { if (geo.standable(r, c)) edge.push([r, c]); } catch { /* not standable */ }
  }
  for (let c = 1; c <= geo.cols; c++) for (const r of [1, geo.rows]) {
    try { if (geo.standable(r, c)) edge.push([r, c]); } catch { /* not standable */ }
  }

  // `reverse` asks the step the other way round: can THAT square step into THIS one, which
  // is what "can still reach a boundary" means when the walk is unwound.
  const flood = (reverse) => {
    const seen = new Set(); const q = [];
    for (const [r, c] of edge) if (!seen.has(key(r, c))) { seen.add(key(r, c)); q.push([r, c]); }
    while (q.length) {
      const [r0, c0] = q.shift();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = r0 + dr, c = c0 + dc;
        if (!geo.inBounds(r, c)) continue;
        const k = key(r, c);
        if (seen.has(k)) continue;
        if (!(reverse ? step(r, c, r0, c0) : step(r0, c0, r, c))) continue;
        seen.add(k); q.push([r, c]);
      }
    }
    return seen;
  };

  const arrivable = flood(false);
  const escapable = flood(true);
  const trapped = [...arrivable].filter(k => !escapable.has(k));
  console.log(`  ${String(num).padEnd(5)} ${name.padEnd(36)} ` +
              `reachable ${String(arrivable.size).padStart(5)}  ` +
              `can-get-out ${String(escapable.size).padStart(5)}  ` +
              `TRAPPED ${String(trapped.length).padStart(4)}` +
              (trapped.length ? '   e.g. ' + trapped.slice(0, 4).join(' ') : ''));
  const allowed = BASELINE[num] ?? 0;
  ok(`${name}: no more traps than the day this was written`, trapped.length <= allowed,
     `${trapped.length} against a ratchet of ${allowed}`);
}

if (!checkedAny) {
  console.log('  no .roo files found — nothing measured, and that is not a failure.');
  console.log('  point it at a client or server tree:  --dirs <path to resource/rooms>');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
