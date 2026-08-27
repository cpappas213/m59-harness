#!/usr/bin/env node
// RUNNING FOR COVER, AND THE THREE THINGS A POSTMORTEM COULD NOT SAY.
//
//   node tools/m59-shelter-test.mjs
//
// Offline. Writes to a temp directory, opens no socket, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// The travel doctrine answers everything except a person and dying the same way: take the next
// route-adjacent wall, rest to full, carry on. On 2026-08-27 a run of twenty-one produced twelve
// deaths and NOTHING ON DISK could say whether that doctrine had fired — whether a wall was ever
// chosen, how hurt the character was when it chose, how far away the wall was, or whether it got
// there. Those are four different faults with four different fixes and they all render as "died
// travelling".
//
// The operator asked for three things and each is one group below:
//
//   (A) the health at the moment the decision is made, with BOTH squares, so the run for cover
//       can be recreated rather than inferred
//   (B) how far away the chosen wall is — and the distance that matters is how far the
//       character has to WALK, not how far the wall sits off the planned road
//   (C) distance per second around the time of death: was it still making progress
//
// And one rule change: seek shelter below 100% health rather than below 95%.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const DIR = mkdtempSync(path.join(tmpdir(), 'm59-shelter-'));
process.env.M59_SHELTER_DIR = DIR;
const { recordShelterRun, shelterRuns, pairRuns, shelterFile } =
  await import('./m59-shelter.mjs');

const AUTOPILOT_SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

console.log('\n(A) THE DECISION IS RECORDED WHEN THE WALL IS CHOSEN, NOT WHEN IT IS REACHED');
{
  // A ledger written on arrival cannot see the runs that never arrive — and those are exactly
  // the ones that end in a postmortem. This is the whole reason there are two rows.
  ok('the divert handler writes a `chose` row',
     /onDivert: \(stop, at\) => \{[\s\S]{0,2000}recordShelterRun\(\{[\s\S]{0,200}kind: 'chose'/
       .test(AUTOPILOT_SRC));
  ok('and it carries the health at that moment, not at arrival',
     /kind: 'chose'[\s\S]{0,600}health_pct: hp/.test(AUTOPILOT_SRC));
  ok('and BOTH squares — where we are and where the wall is',
     /kind: 'chose'[\s\S]{0,900}from, to: \{ row: stop\.row, col: stop\.col \}/.test(AUTOPILOT_SRC));
  // WHAT IT WAS LOSING, because a character at 80% falling fast and one at 80% that stopped
  // bleeding two rooms ago are not the same decision and the threshold cannot tell them apart.
  ok('and the rate it was losing health at',
     /kind: 'chose'[\s\S]{0,700}health_per_second: this\.healthRate/.test(AUTOPILOT_SRC));
  ok('and what was standing there',
     /kind: 'chose'[\s\S]{0,800}threats: \(this\.threatsHere/.test(AUTOPILOT_SRC));
}

console.log('\n(B) HOW FAR IT HAS TO WALK, WHICH IS NOT HOW FAR THE WALL IS OFF THE ROAD');
{
  // `detour` is the number `travelShelterDetour` caps, and it answers a different question:
  // how far the wall sits from the planned path. What costs health is the walk from where the
  // body actually IS, and after a fight that is rarely on the path.
  ok('the walk distance is measured from the body, not from the route',
     /const squares = from && Number\.isFinite\(stop\.row\)[\s\S]{0,220}Math\.max\(Math\.abs\(stop\.row - from\.row\)/
       .test(AUTOPILOT_SRC));
  ok('and Chebyshev, because that is how a step moves',
     /Math\.max\(Math\.abs\(stop\.row - from\.row\),\s*Math\.abs\(stop\.col - from\.col\)\)/
       .test(AUTOPILOT_SRC));
  ok('and both numbers are kept, so the cap can be judged against the cost',
     /detour: stop\.detour \?\? null, squares/.test(AUTOPILOT_SRC));
}

console.log('\n(C) WAS IT STILL GOING ANYWHERE WHEN IT DIED');
{
  ok('the postmortem carries a movement block',
     /movement: \(\(\) => \{/.test(AUTOPILOT_SRC));
  ok('and it reports squares per second over the last frames',
     /squares_per_second_at_the_end/.test(AUTOPILOT_SRC));
  // THE SHUFFLE DETECTOR. CLAUDE.md's own warning: a stall detector that requires STILLNESS
  // misses the commonest way to stand still, because a two-square shuffle against a wall resets
  // every timer it meets. Gross against net is what sees it.
  ok('and net against gross, so a shuffle against a wall is not read as travel',
     /net_squares: net/.test(AUTOPILOT_SRC) && /shuffled: net != null/.test(AUTOPILOT_SRC));
  ok('and a room change is skipped rather than counted as a forty-square leap',
     /if \(f\[i\]\.num !== f\[i - 1\]\.num\) \{ steps\.push\(null\); continue; \}/.test(AUTOPILOT_SRC));
  ok('and it does not lean on ms_since_moved, which measures the keeper',
     /movement: \(\(\) => \{[\s\S]{0,2000}Chebyshev/.test(AUTOPILOT_SRC));
}

console.log('\nTHE BAR IS "HAVE I TAKEN A HIT", NOT A FRACTION');
{
  // The operator's rule: seek roadside shelter below 100% health. 0.95 is a threshold
  // pretending to be a rule — there is no mechanism that makes 96% fine.
  ok('the divert fires below full health',
     /return hp < \(this\.policy\.travelDivertBelow \?\? 1\);/.test(AUTOPILOT_SRC));
  ok('and it is still overridable, because it is a number and numbers are this machine\'s',
     /travelDivertBelow/.test(AUTOPILOT_SRC));
  // AND IT IS NOT THE CANCELLATION THRESHOLD. Both used to read one number, so every moment
  // worth a free detour was also a moment worth tearing the crossing down — and the
  // cancellation won, because it runs in the keeper on a one-second clock.
  ok('and it is a different number from the one that could end a crossing',
     /SO THIS IS NOT THE SAME NUMBER AS `travelShelterBelow`/.test(AUTOPILOT_SRC));
}

console.log('\nTHE LEDGER ITSELF');
{
  const run = 'Tttt-1';
  recordShelterRun({ run, kind: 'chose', character: 'Tttt', room: 598,
    room_name: 'The Cragged Mountains', health: 12, max_health: 20, health_pct: 0.6,
    vigor: 48, health_per_second: -0.29, threats: ['troll', 'troll'],
    from: { row: 21, col: 17 }, to: { row: 24, col: 19 }, detour: 2, squares: 3 });
  let rows = shelterRuns({ thisEpochOnly: false });
  ok('a decision row lands on disk', rows.length === 1, JSON.stringify(rows));
  ok('with both squares intact',
     rows[0].from.row === 21 && rows[0].from.col === 17
     && rows[0].to.row === 24 && rows[0].to.col === 19);
  ok('and the health at the decision, not a fraction on its own',
     rows[0].health === 12 && rows[0].max_health === 20 && rows[0].health_pct === 0.6);
  ok('and it is stamped with the movement epoch it was measured under',
     typeof rows[0].epoch === 'string' && rows[0].epoch.length > 0, rows[0].epoch);

  // A RUN WITH NO OUTCOME IS THE INTERESTING ONE, and it must not be silently dropped.
  ok('a run with no outcome row still pairs, and says so',
     pairRuns(rows).length === 1 && pairRuns(rows)[0].settled === undefined);

  recordShelterRun({ run, kind: 'settled', character: 'Tttt', room: 598,
    arrived: true, ms: 4200, rested_to: 1, hp_gained: 8 });
  rows = shelterRuns({ thisEpochOnly: false });
  const paired = pairRuns(rows);
  ok('the outcome row pairs with its decision',
     paired.length === 1 && paired[0].settled?.arrived === true && paired[0].chose.health === 12);
  ok('and the two rows are both kept — append-only, because how it turned out is the finding',
     rows.length === 2);

  // NEVER THROWS. This is a notebook, not a dependency: a keeper that cannot write it still has
  // to run for cover, and an exception here would be raised inside the survival path.
  ok('a malformed row is dropped rather than thrown',
     recordShelterRun({ run: 'x', from: 'not a square', to: null }) !== undefined);
  ok('and a square that is not a square records as absent rather than as garbage',
     shelterRuns({ thisEpochOnly: false }).at(-1).from === null);

  ok('the file is per fleet, so two fleets do not pool their roads',
     shelterFile('a') !== shelterFile('b'));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
