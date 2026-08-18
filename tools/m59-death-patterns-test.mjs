#!/usr/bin/env node
// m59-death-patterns-test.mjs -- tests for the death pattern detector.
//
//   node tools/m59-death-patterns-test.mjs
//
// Offline tests. No ledger, no server. They verify detectPatterns() with
// synthetic death events: that it flags repeated rooms, killers, prey, and
// room+prey combos, that it respects the minDeaths threshold, and that it
// ignores deaths with missing fields.

import { detectPatterns } from './m59-death-patterns.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Helper: make a death event
const d = (character, died_in, hunting, killed_by) =>
  ({ character, died_in, hunting, killed_by, kind: 'died' });

console.log('\ndetectPatterns: basic detection');
{
  // Three deaths in the same room, same prey, same killer.
  const deaths = [
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
  ];
  const f = detectPatterns(deaths, 3);
  check('finds one character with patterns', f.length === 1 && f[0].name === 'Lee');
  const types = f[0].findings.map(x => x.type);
  check('flags repeated room', types.includes('room'));
  check('flags repeated killer', types.includes('killer'));
  check('flags repeated prey', types.includes('prey'));
  check('flags room+prey combo', types.includes('room+prey'));
  const roomFinding = f[0].findings.find(x => x.type === 'room');
  check('room count is 3', roomFinding.count === 3);
  check('room label is the room name', roomFinding.label === 'Main gate to Tos');
}

console.log('\ndetectPatterns: minDeaths threshold');
{
  // Only two deaths in the same room -- below the threshold of 3.
  const deaths = [
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
  ];
  const f = detectPatterns(deaths, 3);
  check('no findings below threshold', f.length === 0);

  // But with threshold 2, it should flag.
  const f2 = detectPatterns(deaths, 2);
  check('finds patterns at lower threshold', f2.length === 1);
}

console.log('\ndetectPatterns: multiple characters');
{
  // Two characters, each with their own pattern.
  const deaths = [
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('Lee', 'Main gate to Tos', 'giant rat', 'giant rat'),
    d('JayB', 'Ilerian Woods', 'fungus beast', 'baby spider'),
    d('JayB', 'Ilerian Woods', 'fungus beast', 'baby spider'),
    d('JayB', 'Ilerian Woods', 'fungus beast', 'baby spider'),
  ];
  const f = detectPatterns(deaths, 3);
  check('finds two characters', f.length === 2);
  const names = f.map(x => x.name).sort();
  check('both Lee and JayB are found', names.includes('Lee') && names.includes('JayB'));
}

console.log('\ndetectPatterns: no pattern (spread out deaths)');
{
  // Three deaths, all in different rooms/prey -- no pattern.
  const deaths = [
    d('Lee', 'Room A', 'giant rat', 'giant rat'),
    d('Lee', 'Room B', 'fungus beast', 'baby spider'),
    d('Lee', 'Room C', 'orc', 'orc'),
  ];
  const f = detectPatterns(deaths, 3);
  check('no findings when deaths are spread out', f.length === 0);
}

console.log('\ndetectPatterns: missing fields are ignored');
{
  // Deaths with null died_in / hunting should not create patterns for those fields,
  // but the character should still be counted.
  const deaths = [
    d('Lee', null, 'giant rat', 'giant rat'),
    d('Lee', null, 'giant rat', 'giant rat'),
    d('Lee', null, 'giant rat', 'giant rat'),
  ];
  const f = detectPatterns(deaths, 3);
  check('character is found', f.length === 1);
  const types = f[0].findings.map(x => x.type);
  check('no room finding (died_in is null)', !types.includes('room'));
  check('no room+prey finding (died_in is null)', !types.includes('room+prey'));
  check('prey finding still present', types.includes('prey'));
  check('killer finding still present', types.includes('killer'));
}

console.log('\ndetectPatterns: empty input');
{
  const f = detectPatterns([], 3);
  check('empty input -> no findings', f.length === 0);
}

console.log('\ndetectPatterns: totalDeaths is correct');
{
  const deaths = [
    d('Lee', 'Room A', 'giant rat', 'giant rat'),
    d('Lee', 'Room A', 'giant rat', 'giant rat'),
    d('Lee', 'Room A', 'giant rat', 'giant rat'),
    d('Lee', 'Room B', 'orc', 'orc'),   // a different death, no pattern
  ];
  const f = detectPatterns(deaths, 3);
  check('totalDeaths counts all deaths for the character', f[0].totalDeaths === 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
