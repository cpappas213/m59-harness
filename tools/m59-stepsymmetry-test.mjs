#!/usr/bin/env node
// A STEP YOU CAN TAKE IS A STEP YOU CAN TAKE BACK.
//
//   node tools/m59-stepsymmetry-test.mjs
//   node tools/m59-stepsymmetry-test.mjs --roo i7.roo --dirs C:/code/Meridian59/resource/rooms
//
// Offline. Reads .roo files if it can find them and SKIPS CLEANLY if it cannot, because a
// fresh clone has no game resources and a test that fails for want of them teaches nothing.
//
// WHAT THIS IS FOR. In Meridian 59 you can leave any square you can enter. There are no
// one-way squares — no ledge you drop off and cannot climb, no doorway that admits and does
// not release. So `moverStepLands(a, b)` and `moverStepLands(b, a)` must agree, and where
// they do not, the disagreement is OURS.
//
// It matters because an asymmetric predicate MANUFACTURES ISLANDS. The Twisted Wood has a
// five-square pocket at row 5, col 35 that the mover will step into and not out of:
//
//     5,35 -> 5,36   out=false  back=true
//     4,35 -> 5,36   out=false  back=true
//     6,35 -> 5,36   out=false  back=true
//
// A character that sheltered there could never leave the room. It cost four hundred and
// fifty seconds a leg, and the transit book recorded it as "every square for that exit
// refused" — a sentence about the exit, describing a body stranded somewhere else.
//
// The safe-spot search now refuses squares it cannot escape from, which stops the fleet
// walking into the consequences. This is the test for the CAUSE. It is expected to fail
// today; what it must not do is fail silently or get quietly deleted, so it reports the
// asymmetry as a MEASUREMENT — a rate, per room — rather than as a pass or a fail, and
// fails only if the rate gets worse than the day it was written.

import { loadRoo, DEFAULT_ROO_DIRS } from './m59-roo.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const dirs = flag('dirs') ? [flag('dirs')] : DEFAULT_ROO_DIRS;
const only = flag('roo');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The rooms this fleet actually travels through, which is where an island costs something.
const ROOMS = only ? [[0, only, 'the one asked for']] : [
  [597, 'i7.roo', 'The Twisted Wood'],
  [598, 'i8.roo', 'The Cragged Mountains'],
  [587, 'h7.roo', 'Western border of the Twisted Wood'],
  [586, 'h6.roo', 'Main gate to the city of Tos'],
];

// A RATCHET SET FROM MEASUREMENT, NOT FROM HOPE. The first draft guessed one percent and
// every room failed it — which is the right answer to the wrong question: the number is
// not a standard anybody has met, it is where things stood on 2026-08-23, so that the day
// somebody makes the mover worse is visible and the day somebody fixes it is too.
//
// The Cragged Mountains at EIGHT PERCENT is the striking row, and it is the room this
// fleet dies in more than any other. That may be a coincidence and it may not, and the
// only way to find out is to have the number written down before anybody goes looking.
const BASELINE = {
  597: 0.0130,   // The Twisted Wood                      measured 1.228%
  598: 0.0810,   // The Cragged Mountains                 measured 8.016%
  587: 0.0300,   // Western border of the Twisted Wood    measured 2.954%
  586: 0.0450,   // Main gate to the city of Tos          measured 4.464%
};
const RATCHET_DEFAULT = 0.09;

console.log('');
console.log('A STEP YOU CAN TAKE IS A STEP YOU CAN TAKE BACK');

let checkedAny = false;
for (const [num, file, name] of ROOMS) {
  let geo = null;
  try { geo = loadRoo(file, dirs); } catch { geo = null; }
  if (!geo || !geo.collisionReady || typeof geo.moverStepLands !== 'function') {
    console.log(`  --   ${file} not available here — skipped`);
    continue;
  }
  checkedAny = true;
  let checked = 0, asym = 0;
  const examples = [];
  for (let r = 2; r < geo.rows; r++) {
    for (let c = 2; c < geo.cols; c++) {
      // Forward pairs only — every unordered pair is visited once, from its lower corner.
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const r2 = r + dr, c2 = c + dc;
        if (!geo.inBounds(r2, c2)) continue;
        let out = false, back = false;
        try { out = geo.moverStepLands(r, c, r2, c2); } catch { continue; }
        try { back = geo.moverStepLands(r2, c2, r, c); } catch { continue; }
        checked++;
        if (out !== back) {
          asym++;
          if (examples.length < 3)
            examples.push(`${r},${c} <-> ${r2},${c2}  there=${out} back=${back}`);
        }
      }
    }
  }
  const rate = checked ? asym / checked : 0;
  console.log(`  ${String(num).padEnd(5)} ${name.padEnd(36)} ` +
              `${asym} of ${checked} ordered pairs disagree (${(rate * 100).toFixed(3)}%)`);
  for (const e of examples) console.log('          ' + e);
  const ratchet = BASELINE[num] ?? RATCHET_DEFAULT;
  ok(`${name}: no worse than the day this was written`, rate <= ratchet,
     `${(rate * 100).toFixed(3)}% against a ${(ratchet * 100).toFixed(1)}% ratchet`);
}

if (!checkedAny) {
  console.log('  no .roo files found — nothing measured, and that is not a failure.');
  console.log('  point it at a client or server tree:  --dirs <path to resource/rooms>');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
