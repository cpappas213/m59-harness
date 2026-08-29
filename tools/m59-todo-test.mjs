#!/usr/bin/env node
// THE THINGS WE KNOW ARE BROKEN, AS A SUITE THAT NEVER FAILS.
//
//   node tools/m59-todo-test.mjs            prints the TODOs, exits 0, always
//   node tools/m59-todo-test.mjs --strict   turns them into failures, for the day they are due
//
// A KNOWN BLOCKER HAS NOWHERE TO LIVE IN A GREEN SUITE. Written as an ordinary test it goes
// red, and a suite with a permanent red in it stops being read at all -- so the honest
// failures around it lose their audience. Left out entirely it becomes a sentence in a commit
// message that was true on the day and is now neither true nor false, which is how this
// repository lost the claim that room 108's gully could not be escaped: it was right when
// written, wrong within the hour, and quoted for days afterwards.
//
// So a TODO is a first-class row here. It prints loudly, it names the command that
// reproduces it, and it EXITS ZERO -- this file is safe to put in front of every other suite
// and will never be the reason somebody skips them.
//
// WHAT IT DOES ASSERT. Each case carries an `offline` check for the part that needs no
// server: not whether the blocker still blocks, which takes a fleet and minutes, but whether
// its PREMISE still holds. The crowded-pipe case is about a corridor one square wide; if that
// corridor is ever three wide the case is not fixed, it is meaningless, and it needs
// rewriting rather than re-running. Those checks print `still true` or `PREMISE CHANGED`, and
// even the second one is not a failure -- it is a summons.
//
// THE REGISTRY LIVES IN m59-repro.mjs, deliberately. One description per blocker, imported by
// both, so the list you read and the thing that reproduces it cannot drift apart.
import { CASES } from './m59-repro.mjs';
import { loadMap } from './m59-map.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const STRICT = process.argv.includes('--strict');

let todos = 0, held = 0, changed = 0, unchecked = 0;

// GEOMETRY IS BUILT THE WAY THE FLEET BUILDS IT, masks and all. A premise checked against a
// different map from the one the mover walks is not a check, and the step masks are exactly
// the part that a predicate change invalidates -- see STEP_MASK_VERSION.
let map = null, attached = null;
const cache = new Map();
try {
  map = loadMap();
  attached = attachStepMasks(map);
} catch (e) {
  map = null;
}
const geometryFor = num => {
  if (!map) return null;
  if (cache.has(num)) return cache.get(num);
  const room = map.rooms?.[String(num)] ?? map.rooms?.[num];
  const geo = room?.roo ? sharedRoomGeometry(room) : null;
  cache.set(num, geo);
  return geo;
};

console.log('\nKNOWN BLOCKING CASES — this suite reports them and never fails');
if (attached && attached.ok === false)
  console.log(`  (step masks not attached: ${attached.why} — premises are checked on the ` +
              `coarse grid, which is not what the fleet walks)`);
else if (attached)
  console.log(`  (step masks: ${attached.attached}/${attached.rooms} rooms, ` +
              `${attached.refused ?? 0} refused)`);

for (const [id, c] of Object.entries(CASES)) {
  todos++;
  console.log(`\n  TODO  ${id} — ${c.title}`);
  console.log(`        blocks:   ${c.blocking}`);
  console.log(`        measured: ${c.measured.at}, epoch ${c.measured.epoch}`);
  for (const [k, v] of Object.entries(c.measured))
    if (k !== 'at' && k !== 'epoch') console.log(`                  ${k}: ${v}`);
  if (c.hint) console.log(`        idea:     ${c.hint}`);

  if (typeof c.offline !== 'function') {
    unchecked++;
    console.log('        premise:  not checkable offline');
    continue;
  }
  let r;
  try { r = c.offline({ geometryFor, map }); }
  catch (e) { r = { checked: false, why: 'the premise check threw: ' + e.message }; }

  if (!r?.checked) { unchecked++; console.log(`        premise:  UNCHECKED — ${r?.why ?? 'no reason given'}`); }
  else if (r.ok)   { held++;      console.log(`        premise:  still true — ${r.detail}`); }
  else {
    changed++;
    console.log(`        premise:  PREMISE CHANGED — ${r.detail}`);
    console.log('                  this case is not fixed, it is out of date. Re-measure it and');
    console.log('                  rewrite or delete it rather than re-running it as written.');
  }
  console.log(`        repro:    node tools/m59-repro.mjs ${id} --fleet shadow`);
}

console.log(`\n  ${todos} known blocker(s): ${held} premise(s) still true, ` +
            `${changed} changed, ${unchecked} unchecked`);
console.log('  reproduce any of them: node tools/m59-repro.mjs --list');

if (STRICT && todos) {
  console.log(`\n  --strict: failing on ${todos} outstanding blocker(s)`);
  process.exit(1);
}
// EXIT ZERO IS THE WHOLE POINT. See the header: a suite that goes red for something already
// known and accepted trains people to ignore red.
process.exit(0);
