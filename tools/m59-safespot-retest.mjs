#!/usr/bin/env node
// GIVE THE WALLS ANOTHER CHANCE, because the last test was conducted from the wrong
// place.
//
//   node tools/m59-safespot-retest.mjs --dry-run     # what it would clear
//   node tools/m59-safespot-retest.mjs               # clear them, keeping a backup
//   node tools/m59-safespot-retest.mjs --only-unheld # only squares that never held
//
// A failure in the book means "we stood here, did not swing, and were hit anyway",
// which is sound evidence and is treated as permanent — one failure and the square is
// never recommended again. The asymmetry is deliberate: being wrong about a bad spot
// costs a character, being wrong about a good one costs a walk.
//
// THE EVIDENCE WAS COLLECTED FROM THE WRONG POSITION. The safe-spot mechanic is finer
// than the movement grid — it lives in the BSP walls and the angles — and a square is
// entered by walkTo, which aims at the CENTRE of the square (col*64+32). A spot that
// works by hugging a wall can be most of a square away from that centre. Only a
// remembered spot carried a fine position, and a square gets a remembered position by
// holding first, so EVERY FIRST TEST of every candidate was made from the middle of
// the floor rather than against the wall.
//
// That is a mechanism for manufacturing false failures out of good walls, and the
// shape of the data matches: of 431 recorded failures, 74% happened against a SINGLE
// attacker, and 98 of them are on squares that had also successfully held. A square
// that both holds and fails against one attacker is not a bad square; it is a square
// tested from two different places.
//
// takeSafeSpot now aims at the wall on first contact, so those readings were taken
// under conditions that no longer apply. Clearing them is not forgetting evidence, it
// is discarding a measurement whose method was wrong. `held` history is kept — that
// evidence was always valid, because holding is holding wherever you stood.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const arg = (n) => process.argv.includes('--' + n);
const DRY = arg('dry-run');
const ONLY_UNHELD = arg('only-unheld');

const FILE = new URL('../substrate/m59-safespots.json', import.meta.url).pathname
               .replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(FILE)) { console.error('no safe-spot book at ' + FILE); process.exit(1); }

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const rooms = book.rooms || {};

let cleared = 0, kept = 0, squares = 0, alsoHeld = 0;
const perRoom = {};
for (const [room, spots] of Object.entries(rooms)) {
  for (const rec of Object.values(spots)) {
    squares++;
    if (!(rec.failed > 0)) continue;
    // --only-unheld is the cautious half: squares that failed AND never held are the
    // ones with no positive evidence at all, so leaving them out keeps the change to
    // the squares we have direct reason to doubt.
    if (ONLY_UNHELD && rec.held > 0) { kept++; continue; }
    if (rec.held > 0) alsoHeld++;
    cleared++;
    perRoom[room] = (perRoom[room] || 0) + 1;
    if (!DRY) {
      // Keep the history rather than erasing it: what was measured, and that the
      // measurement was retired, both matter to whoever reads this next.
      rec.failed_before_wallhug = (rec.failed_before_wallhug || 0) + rec.failed;
      rec.failed = 0;
      rec.damage_taken = 0;
      rec.retested_at = 0;      // no clock in here; the keeper stamps it when it next holds
    }
  }
}

console.log(`${squares} squares in the book across ${Object.keys(rooms).length} rooms`);
console.log(`${cleared} failure record(s) ${DRY ? 'would be' : ''} cleared` +
            (ONLY_UNHELD ? ` (${kept} kept: they have held before)` : ''));
if (!ONLY_UNHELD) console.log(`  of those, ${alsoHeld} are squares that had ALSO held — the clearest ` +
                              'sign the failure was a positioning artefact');
const top = Object.entries(perRoom).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [room, n] of top) console.log(`  room ${String(room).padStart(5)}: ${n}`);

if (DRY) { console.log('\ndry run — nothing written'); process.exit(0); }

const backup = FILE.replace(/\.json$/, `.before-retest.json`);
copyFileSync(FILE, backup);
writeFileSync(FILE, JSON.stringify(book, null, 0));
console.log(`\nwritten. backup: ${backup}`);
console.log('The broker holds this book in memory — restart it so the change takes effect:');
console.log('  node tools/m59-service.mjs restart --fleet prod');
