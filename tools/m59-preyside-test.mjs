#!/usr/bin/env node
// DOES A CHARACTER REMEMBER WHICH SIDE OF A SPLIT ROOM ITS PREY IS ON?
//
//   node tools/m59-preyside-test.mjs
//
// Offline. Drives the real module against a throwaway file in TEMP; opens no socket, starts
// no broker, and never touches this machine's own book.
//
// WHY THIS FILE EXISTS. Upstairs Castle Victoria is two islands sharing a room number, and
// Castle Victoria's four doors into it land on only two squares, one per island. Which door
// a character takes decides whether its quarry is reachable when it arrives — and the choice
// has to be made at TRAVEL time, from the next room, where nothing can see the prey. The
// spawn index carries no coordinates. A sighting is the only evidence there is.
//
// The first version of this kept the side on the keeper, set when a bridge was planned from
// INSIDE the room. A restart wiped it, and a character stranded in the via room — exactly
// where these wedge — came back through whichever door was nearest, having forgotten why it
// left. So the rule being pinned is: the memory OUTLIVES THE PROCESS, a fresher sighting
// wins, and an answer it cannot give is null rather than a guess.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(process.env.TEMP || tmpdir(), 'm59-preyside-'));
process.env.M59_PREYSIDE_FILE = join(DIR, 'prey-sides.json');

const { notePreySide, preySideFor, allPreySides, _resetPreySideCache, PREY_SIDE_FILE } =
  await import('./m59-preyside.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

console.log('an empty book has no opinion, and says so');
{
  ok('nothing for a room never visited', preySideFor(39, 'battered skeleton') === null);
  ok('and no throw for a null room', preySideFor(null, null) === null);
  ok('writing nothing is refused rather than recorded',
     notePreySide(39, 'battered skeleton', null) === false);
  ok('so is a square with no coordinates',
     notePreySide(39, 'battered skeleton', { col: undefined, row: 3 }) === false);
}

console.log('\na sighting is remembered');
{
  notePreySide(39, 'battered skeleton', { col: 23, row: 14 });
  const got = preySideFor(39, 'battered skeleton');
  ok('the square comes back', got?.col === 23 && got?.row === 14, JSON.stringify(got));
  ok('with a timestamp', Number.isFinite(got?.at) && got.at > 0);
  ok('the creature name is matched case-insensitively',
     preySideFor(39, 'Battered Skeleton')?.col === 23);
  ok('a different room is still unknown', preySideFor(544, 'battered skeleton') === null);
}

console.log('\nAND IT OUTLIVES THE PROCESS — the whole reason this is a file');
{
  ok('the book is on disk', existsSync(PREY_SIDE_FILE));
  // A restart is what wiped the previous, in-memory version of this. Simulated by dropping
  // the memo so the file is re-read from scratch, which is what a fresh keeper does.
  _resetPreySideCache();
  const after = preySideFor(39, 'battered skeleton');
  ok('and a keeper that has just started still knows the side',
     after?.col === 23 && after?.row === 14, JSON.stringify(after));
}

console.log('\na fresher sighting wins');
{
  notePreySide(39, 'battered skeleton', { col: 34, row: 15 }, { now: Date.now() + 120_000 });
  const got = preySideFor(39, 'battered skeleton');
  ok('the newest square is the answer', got?.col === 34 && got?.row === 15, JSON.stringify(got));
  // Rewriting the same square every pass would mean a file written twice a second across a
  // fleet of twenty-one. Same square, recently: nothing to say.
  ok('but re-seeing the SAME square does not rewrite the book',
     notePreySide(39, 'battered skeleton', { col: 34, row: 15 }) === false);
}

console.log('\ntwo creatures in one room are two answers');
{
  notePreySide(39, 'zombie', { col: 28, row: 8 });
  ok('the skeleton side is unchanged', preySideFor(39, 'battered skeleton')?.col === 34);
  ok('and the zombie has its own', preySideFor(39, 'zombie')?.col === 28);
  // A room with one generator answers the general question the same way as the specific
  // one; a room with two answers the specific one when it can.
  ok('an unnamed hunt falls back to whatever was last seen there',
     preySideFor(39, null)?.col === 28, JSON.stringify(preySideFor(39, null)));
  ok('and the book can be listed', allPreySides().length >= 2,
     JSON.stringify(allPreySides()));
}

console.log('\na corrupt or unreadable book is an empty one, never a throw');
{
  writeFileSync(PREY_SIDE_FILE, '{ this is not json', 'utf8');
  _resetPreySideCache();
  ok('a file that will not parse reads as no opinion',
     preySideFor(39, 'battered skeleton') === null);
  ok('and writing to it still works afterwards',
     notePreySide(39, 'battered skeleton', { col: 1, row: 2 }) === true &&
     preySideFor(39, 'battered skeleton')?.col === 1);
  // The file is JSON on disk, so a human and the next tool can both read it.
  ok('and what it wrote is valid JSON', (() => {
    try { return !!JSON.parse(readFileSync(PREY_SIDE_FILE, 'utf8')).rooms; }
    catch { return false; }
  })());
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* TEMP will get it */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
