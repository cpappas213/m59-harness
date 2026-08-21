#!/usr/bin/env node
// BLINK AS A ROUTING FACT, PINNED.
//
// Offline: no kod tree, no map, no socket. The two things worth pinning are that the kod is
// parsed conservatively, and that blink reachability can never be mistaken for walking.
//
// The second is the one that matters. Blink costs mana, may need a rest to afford, and can
// fail and need repeating — so a caller that gets `true` where it expected "you can walk
// there" will plan a route that needs a spell and report it as a walk. That is why the wider
// question returns a WORD.

import { blinkIn } from './m59-blink.mjs';
import { anchorReach, anchorReachVia } from './m59-routes.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('reading a blink point out of the kod');
{
  const jaswest = `
    room_name_JasperWest="West Jasper"
    room_JasperWest = jas-west.roo
    vrName = room_name_JasperWest
    viTeleport_row = 37
    viTeleport_col = 25
    viTeleport_angle = 512
  `;
  const b = blinkIn(jaswest);
  ok('the pair is read', b && b.row === 37 && b.col === 25, JSON.stringify(b));
  ok('and attributed to the .roo the file names', b && b.roo === 'jas-west.roo');
  ok('the angle comes along when declared', b && b.angle === 512);

  ok('a room with no teleport pair is not invented', blinkIn('vrName = "somewhere"\nx = a.roo') === null);
  ok('half a pair is not half an answer', blinkIn('viTeleport_row = 4\nx = a.roo') === null);

  // A KOD FILE NAMING TWO ROOMS IS REFUSED RATHER THAN GUESSED AT. A blink point attached to
  // the wrong room is worse than none: it would claim exits a character cannot reach, and
  // the router would plan through a door that is not there.
  const two = 'a = one.roo\nb = two.roo\nviTeleport_row = 3\nviTeleport_col = 4';
  const amb = blinkIn(two);
  ok('two .roo names in one file is refused', !!amb && Array.isArray(amb.ambiguous));
  ok('and says which two, rather than dropping them silently',
     !!amb && amb.ambiguous.length === 2 && amb.ambiguous.includes('two.roo'));

  ok('case in a .roo name does not matter',
     blinkIn('X = JAS-WEST.ROO\nviTeleport_row=1\nviTeleport_col=2')?.roo === 'jas-west.roo');
}

console.log('');
console.log('blink is never mistaken for walking');
{
  // West Jasper in miniature: the north doorway walks nowhere, and the blink point reaches
  // everything.
  const NORTH = { row: 1, col: 60 };
  const INN = { row: 44, col: 26 };
  const WEST = { row: 54, col: 1 };
  const table = { rooms: { 382: {
    reach: { '54,1>44,26': 1, '44,26>54,1': 1 },     // the two real doors join, both ways
    blink: { row: 37, col: 25, squares: 1464, reaches: ['1,60', '44,26', '54,1'] },
  } } };

  ok('a walkable pair still answers walk', anchorReachVia(table, 382, WEST, INN) === 'walk');
  ok('and anchorReach still answers it as a plain boolean', anchorReach(table, 382, WEST, INN) === true);

  ok('a pair only blink can join answers blink', anchorReachVia(table, 382, NORTH, INN) === 'blink');
  // THE OLD QUESTION MUST NOT HAVE CHANGED ITS MIND. `transitOk` refuses a hop on this, and
  // it plans on walking.
  ok('while the walking question still says no', anchorReach(table, 382, NORTH, INN) === false);

  ok('where the caster stands is irrelevant to a portal it casts from anywhere',
     anchorReachVia(table, 382, NORTH, WEST) === 'blink');

  const nowhere = { row: 99, col: 99 };
  ok('a destination the blink point cannot walk to is still false',
     anchorReachVia(table, 382, INN, nowhere) === false);

  // A ROOM WITH NO BLINK POINT MUST NOT BECOME UNREACHABLE. Most of the map has no entry —
  // an older table, a clone with no kod tree — and absence has to mean "no extra offer",
  // never "no".
  const noBlink = { rooms: { 382: { reach: { '54,1>44,26': 1 } } } };
  ok('with no blink recorded, a walkable pair is still walk',
     anchorReachVia(noBlink, 382, WEST, INN) === 'walk');
  ok('and an unwalkable one is false rather than a throw',
     anchorReachVia(noBlink, 382, NORTH, INN) === false);

  // A TABLE THAT CANNOT SAY IS NOT A TABLE THAT SAYS NO — the same distinction anchorReach
  // draws, carried through, because only the first is safe to fall back from.
  const old = { rooms: { 382: {} } };
  ok('a table with no reach map answers null, not false',
     anchorReachVia(old, 382, WEST, INN) === null);
  ok('an unknown room answers null', anchorReachVia(table, 999, WEST, INN) === null);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
