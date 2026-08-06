#!/usr/bin/env node
// Does the .roo parse actually hold the room's RELIEF, and do we obey the climb limit?
//
//   node tools/m59-roo-test.mjs
//
// The sector section is the part of a .roo we were reading the offset of and then
// throwing away. Without it every floor is at height zero, which is a lie that never
// announces itself: a staircase and a cliff edge look identical, both read as "wall",
// and a route planned up one is refused by our own collision check for a reason the
// logs render as the server saying no.
//
// Two things here are worth a test rather than a read-through.
//
// THE SECTOR RECORD IS VARIABLE-LENGTH. bspload.c LoadSectors appends a 46-byte slope
// block per sector for a sloped floor and another for a sloped ceiling, INLINE, inside
// the same loop. A parser that assumes a stride reads correctly right up to the first
// sloped sector and garbage from there on — and 80 of the 266 rooms in the tree have
// at least one. So the synthetic files below deliberately put a sloped sector in the
// MIDDLE, because a stride bug is invisible if the variable-length record is last.
//
// A PASSABLE WALL IS NOT A CROSSABLE WALL. move.c:551 is a three-part AND, and this
// repository had been treating the third part as the whole test. A wall flagged
// WF_PASSABLE still blocks when the step up exceeds MAX_STEP_HEIGHT or the headroom is
// under the player's height — which is exactly how the format distinguishes a step
// from a cliff, and the distinction is the entire point of parsing heights at all.
import fs from 'node:fs';
import path from 'node:path';
import {
  RoomGeometry,
  parseRoo, parseRooSectors, setWallHeights, canCrossWall,
  floorHeightAt, ceilingHeightAt,
  MAX_STEP_HEIGHT, MAX_STEP_HEIGHT_KOD, SECTOR_DEPTHS, sectorDepth, SF, WF,
  CLIENT_FINENESS, KOD_FINENESS, PLAYER_HEIGHT, PLAYER_RADIUS, PLAYER_WIDTH,
  heightKodToClient, DEFAULT_ROO_DIRS,
} from './m59-roo.mjs';

let pass = 0, fail = 0, skipped = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};
const skip = (label, why) => { skipped++; console.log(`  --   ${label} — ${why}`); };

// ------------------------------------------------------- the constants, from source
//
// These are pinned because they are the numbers a future reader is most likely to
// "clean up" into something rounder, and every one of them is load-bearing.
console.log('constants, against the C the client actually compiles');
ok('MAX_STEP_HEIGHT is 24 kod units', MAX_STEP_HEIGHT_KOD === 24, 'move.c:55');
ok('...which is 384 client units', MAX_STEP_HEIGHT === 384, `${MAX_STEP_HEIGHT}`);
ok('height conversion shifts by 4', heightKodToClient(1) === 16, 'drawdefs.h:60');
ok('wading depths are {0,204,409,614}', SECTOR_DEPTHS.join(',') === '0,204,409,614', 'draw3d.c:80');
ok('depth is the low two flag bits', sectorDepth(0x0403) === 3 && sectorDepth(0x0400) === 0, 'bsp.h:70');
ok('player width 496, radius 248', PLAYER_WIDTH === 496 && PLAYER_RADIUS === 248, 'game.c:261, move.c:122');
ok('player height 768', PLAYER_HEIGHT === 768, 'game.c:262');
ok('fineness 1024 client / 64 kod', CLIENT_FINENESS === 1024 && KOD_FINENESS === 64, 'drawdefs.h:42,52');

// ------------------------------------------------------- the variable-length walk
//
// A sector section built by hand, so the expected bytes are known rather than
// inferred. Sector 1 is flat, sector 2 is SLOPED, sector 3 is flat again — and the
// test is whether sector 3 comes back with its own numbers or with the tail of
// sector 2's slope block reinterpreted as a header.
function sectorBytes({ id, floorKod, ceilKod, flags, slopes = 0 }) {
  const fixed = Buffer.alloc(20);
  fixed.writeInt16LE(id, 0);
  fixed.writeInt16LE(0, 2); fixed.writeInt16LE(0, 4);   // floor/ceiling bitmap types
  fixed.writeInt16LE(0, 6); fixed.writeInt16LE(0, 8);   // tx, ty
  fixed.writeInt16LE(floorKod, 10);
  fixed.writeInt16LE(ceilKod, 12);
  fixed.writeUInt8(64, 14);                              // light
  fixed.writeInt32LE(flags, 15);
  fixed.writeUInt8(0, 19);                               // speed (version >= 10)
  if (!slopes) return fixed;
  // A slope block: a,b,c,d then p0.x,p0.y then the texture angle then 18 junk bytes.
  const blocks = [];
  for (let i = 0; i < slopes; i++) {
    const s = Buffer.alloc(46);
    s.writeInt32LE(0, 0); s.writeInt32LE(0, 4);          // a, b — level plane...
    s.writeInt32LE(1024, 8);                             // c
    s.writeInt32LE(-1024 * 500, 12);                     // d, so z = 500 everywhere
    s.writeInt32LE(0, 16); s.writeInt32LE(0, 20);        // p0
    s.writeInt32LE(0, 24);                               // angle
    blocks.push(s);
  }
  return Buffer.concat([fixed, ...blocks]);
}

// Offset 0 legitimately means "no sector section", so the synthetic files put the
// count somewhere real — as a file would.
const SEC_OFF = 4;
function section(...records) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(records.length, 0);
  return Buffer.concat([Buffer.alloc(SEC_OFF), count, ...records]);
}

console.log('\nthe sector record is variable-length');
{
  const buf = section(
    sectorBytes({ id: 11, floorKod: 100, ceilKod: 300, flags: 0 }),
    sectorBytes({ id: 22, floorKod: 200, ceilKod: 400, flags: SF.SLOPED_FLOOR, slopes: 1 }),
    sectorBytes({ id: 33, floorKod: 150, ceilKod: 350, flags: SF.DEPTH_MASK & 2 }),
  );
  const secs = parseRooSectors(buf, 12, SEC_OFF);

  ok('all three sectors read', secs.length === 3, `${secs.length}`);
  ok('the flat one before the slope is right', secs[0]?.serverId === 11 && secs[0]?.floorHeight === heightKodToClient(100));
  ok('the sloped one is right', secs[1]?.serverId === 22 && !!secs[1]?.slopedFloor);
  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  ok('the flat one AFTER the slope is right', secs[2]?.serverId === 33 && secs[2]?.floorHeight === heightKodToClient(150),
     secs[2] ? `id=${secs[2].serverId} floor=${secs[2].floorHeight}` : 'missing');
  ok('a sloped floor solves its plane', floorHeightAt(0, 0, secs[1]) === 500, `${floorHeightAt(0, 0, secs[1])}`);
  ok('a flat floor ignores x,y', floorHeightAt(9999, 9999, secs[0]) === heightKodToClient(100));
  ok('two slope blocks are both consumed',
     parseRooSectors(section(
       sectorBytes({ id: 7, floorKod: 1, ceilKod: 2, flags: SF.SLOPED_FLOOR | SF.SLOPED_CEILING, slopes: 2 }),
       sectorBytes({ id: 8, floorKod: 3, ceilKod: 4, flags: 0 }),
     ), 12, SEC_OFF)[1]?.serverId === 8);
  // Negative floors are ordinary. Read as unsigned they come back as ~65000 and every
  // step onto them becomes an unclimbable cliff.
  const neg = parseRooSectors(section(sectorBytes({ id: 1, floorKod: -40, ceilKod: 100, flags: 0 })), 12, SEC_OFF);
  ok('floor heights are signed', neg[0].floorHeight === heightKodToClient(-40), `${neg[0].floorHeight}`);
  // Truncation must lose sectors, not invent them: the header claims nine, one is present.
  const short = section(sectorBytes({ id: 1, floorKod: 1, ceilKod: 2, flags: 0 }));
  short.writeUInt16LE(9, SEC_OFF);
  ok('a truncated section stops rather than guessing', parseRooSectors(short, 12, SEC_OFF).length === 1);
}

// ------------------------------------------------------- wall heights from sectors
console.log('\nwall heights come off the sectors either side');
{
  const low  = { floorHeight: 0,    ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const step = { floorHeight: 320,  ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };  // 20 kod — climbable
  const cliff= { floorHeight: 1024, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };  // 64 kod — not
  const sectors = [low, step, cliff];
  const wall = (posSector, negSector) => setWallHeights(
    { x0: 0, y0: 0, x1: 1024, y1: 0, posSector, negSector }, sectors);

  ok('a wall with no sectors gets the defaults', (w => w.z0 === 0 && w.z2 === CLIENT_FINENESS)(wall(0, 0)));
  ok('a one-sided wall takes the sector it has', (w => w.z0 === 320 && w.z1 === 320)(wall(2, 0)));
  ok('z1 is the HIGHER floor, z0 the lower', (w => w.z1 === 320 && w.z0 === 0)(wall(2, 1)));
  ok('...whichever side it is on', (w => w.z1 === 320 && w.z0 === 0)(wall(1, 2)));
  ok('z2 is the LOWER ceiling', (w => w.z2 === 4096)(wall(1, 2)));
  ok('a cliff reports its real step', (w => w.z1 - w.z0 === 1024)(wall(1, 3)));
}

// ------------------------------------------------------- the crossing rule
console.log('\ncrossing a wall is three tests, not one');
{
  const flat  = { floorHeight: 0,   ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const up20  = { floorHeight: 320, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const up64  = { floorHeight: 1024, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const deep  = { floorHeight: 0,   ceilingHeight: 4096, depth: SECTOR_DEPTHS[3], slopedFloor: null, slopedCeiling: null };
  const build = (negSectorObj, { flags = WF.PASSABLE, belowType = 1, aboveType = 0 } = {}) => {
    const sd = { flags, belowType, aboveType };
    const w = { x0: 0, y0: 0, x1: 1024, y1: 0, posSector: 1, negSector: 2,
                posSidedefRec: sd, negSidedefRec: sd };
    return setWallHeights(w, [flat, negSectorObj]);
  };

  ok('a passable wall onto a small step is crossable', canCrossWall(build(up20), 0, 'pos'));
  ok('a passable wall onto a CLIFF is not', !canCrossWall(build(up64), 0, 'pos'),
     'this is the case `passable` alone got wrong');
  ok('exactly MAX_STEP_HEIGHT is allowed',
     canCrossWall(build({ ...flat, floorHeight: MAX_STEP_HEIGHT }), 0, 'pos'));
  ok('one unit above it is not',
     !canCrossWall(build({ ...flat, floorHeight: MAX_STEP_HEIGHT + 1 }), 0, 'pos'));
  ok('an impassable wall is never crossable', !canCrossWall(build(up20, { flags: 0 }), 0, 'pos'));
  ok('no below texture means no step test at all',
     canCrossWall(build(up64, { belowType: 0 }), 0, 'pos'), 'move.c short-circuits on a null bitmap');
  ok('standing higher makes a tall step crossable', canCrossWall(build(up64), 1024 - MAX_STEP_HEIGHT, 'pos'));
  // Wading LOWERS the far side, so deep water is easier to climb out of than the
  // number alone suggests — move.c subtracts the depth before the comparison.
  ok('wading depth reduces the effective step',
     canCrossWall(build({ ...up64, depth: SECTOR_DEPTHS[3], floorHeight: MAX_STEP_HEIGHT + 100 }), 0, 'pos'));
  ok('headroom under the player height blocks',
     !canCrossWall(build(up20, { aboveType: 1 }), 0, 'pos', { playerHeight: 99999 }));
  ok('a null sidedef is skipped, as move.c does',
     canCrossWall({ ...build(up64), posSidedefRec: null }, 0, 'pos'));
}

// ------------------------------------------------------- routing round monsters
//
// A monster is not a wall, and the two failure modes are opposite. Treating it as a
// wall strands a character whenever the only corridor has something in it — the same
// shape of bug as the coarse grid sealing a doorway. Treating it as nothing walks the
// character through its attack radius at a walking pace, which is where this fleet's
// travel deaths come from.
//
// So: cost, not prohibition. The radii are the monster's own (`monster.kod:1676`,
// `:1682`) — vision 4 + difficulty/2, reach Bound(2 + difficulty/6, 2, 3).
console.log('\nrouting treats monsters as cost, not as wall');
{
  const open = (rows, cols, mask = null) => {
    const flags = Buffer.alloc(rows * cols, 0);
    if (mask) mask(flags, cols); else flags.fill(1);
    return new RoomGeometry({ file: 'synthetic', version: 13, rows, cols,
      grid: Buffer.alloc(rows * cols, 0xff), flags, monsterGrid: null,
      walls: [], sidedefs: [], sectors: [], clientSize: null });
  };
  const g = open(21, 21);
  const threat = [{ row: 11, col: 11, vision: 6, reach: 3 }];
  const closest = p => Math.min(...p.steps.map(s => Math.hypot(s.row - 11, s.col - 11)));

  const straight = g.path(11, 1, 11, 21);
  ok('without threats the route goes straight through it',
     straight.found && straight.steps.some(s => s.row === 11 && s.col === 11));

  const dodged = g.path(11, 1, 11, 21, { threats: threat });
  ok('with a threat the route stays outside its vision', dodged.found && closest(dodged) >= 6,
     `closest approach ${closest(dodged).toFixed(2)} squares`);
  // The detour is FREE in an open room, because diagonals let it arc. That is worth
  // asserting: if this ever costs steps, the penalty is mis-tuned rather than the
  // geometry being tight.
  ok('...and in the open that costs no extra steps',
     dodged.steps.length === straight.steps.length,
     `${straight.steps.length} -> ${dodged.steps.length}`);

  // WHEN YOU HAVE TO, YOU HAVE TO. One-square corridor, monster sitting in it.
  const corridor = open(21, 21, (f, cols) => { for (let c = 0; c < cols; c++) f[(11 - 1) * cols + c] = 1; });
  const forced = corridor.path(11, 1, 11, 21, { threats: threat });
  ok('a route that only exists through its reach is still taken', forced.found,
     forced.found ? `${forced.steps.length} steps` : forced.reason);

  // A hard `avoid` on the same square would refuse — which is the behaviour this is
  // deliberately NOT.
  const blocked = corridor.path(11, 1, 11, 21, { avoid: new Set(['11,11']) });
  ok('...where a hard avoid would have refused it', !blocked.found, blocked.reason);

  ok('no threats means no cost map at all', g.threatField([]) === null);
  ok('the penalty tapers with distance', (() => {
    const f = g.threatField(threat);
    return f(11, 14) > f(11, 16) && f(11, 16) > 0 && f(11, 18) === 0;
  })(), 'full weight inside reach, nothing outside vision');
  ok('two monsters stack', (() => {
    const one = g.threatField([{ row: 11, col: 11, vision: 6, reach: 3 }])(11, 11);
    const two = g.threatField([{ row: 11, col: 11, vision: 6, reach: 3 },
                               { row: 11, col: 12, vision: 6, reach: 3 }])(11, 11);
    return two > one;
  })());
}

// ------------------------------------------------------- against the real tree
//
// Everything above runs anywhere. This part needs the game's own room files, so it
// SKIPS rather than fails when they are absent — a clone without M59_ROOT is not a
// broken checkout.
const roomsDir = DEFAULT_ROO_DIRS.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
console.log('\nagainst the real rooms');
if (!roomsDir) {
  skip('every room parses', 'no resource/rooms directory on this machine');
  skip('the slope stride is right', 'ditto');
  skip('the Limping Toad', 'ditto');
} else {
  const files = fs.readdirSync(roomsDir).filter(f => f.toLowerCase().endsWith('.roo'));
  let parsed = 0, threw = 0, withSectors = 0, sloped = 0, wading = 0;
  const deltas = new Map();
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(roomsDir, f)); } catch { continue; }
    try {
      const g = parseRoo(buf, f);
      parsed++;
      const h = g.heightSummary;
      if (h) { withSectors++; if (h.sloped) sloped++; if (h.wading) wading++; }
    } catch { threw++; continue; }
    // Where the variable-length walk ENDS. A wrong stride shows up here as a delta
    // that differs between flat rooms and sloped ones, which is the only signal
    // available without reimplementing the BSP to check the file's own checksum.
    const version = buf.readInt32LE(4), mainOff = buf.readInt32LE(12);
    const sectorOff = buf.readInt32LE(mainOff + 8 + 16);
    let q = sectorOff; const n = buf.readUInt16LE(q); q += 2;
    let hadSlope = false;
    for (let i = 0; i < n; i++) {
      const flags = buf.readInt32LE(q + 15);
      q += 19 + (version >= 10 ? 1 : 0);
      if (flags & SF.SLOPED_FLOOR) { q += 46; hadSlope = true; }
      if (flags & SF.SLOPED_CEILING) { q += 46; hadSlope = true; }
    }
    const key = `${buf.readInt32LE(16) - q}`;
    const bucket = deltas.get(key) || { flat: 0, sloped: 0 };
    bucket[hadSlope ? 'sloped' : 'flat']++;
    deltas.set(key, bucket);
  }
  ok('every room parses without throwing', threw === 0, `${parsed} parsed, ${threw} threw`);
  ok('every room yields sectors', withSectors === parsed, `${withSectors}/${parsed}`);
  ok('the tree really does contain slopes', sloped > 0, `${sloped} rooms sloped, ${wading} wading`);
  // THE STRIDE PROOF. Sloped rooms must land on the same boundary as flat ones. If the
  // 46 were wrong, every sloped room would be displaced by a multiple of the error and
  // would land in its own bucket.
  const slopedBuckets = [...deltas.entries()].filter(([, v]) => v.sloped > 0);
  const flatBuckets = [...deltas.entries()].filter(([, v]) => v.flat > 0);
  const shared = slopedBuckets.every(([k]) => flatBuckets.some(([j]) => j === k));
  ok('sloped rooms end where flat rooms end', shared && slopedBuckets.length === 1,
     [...deltas.entries()].map(([k, v]) => `${k}:${v.flat}f/${v.sloped}s`).join(' '));

  // ------------------------------------------------- the Limping Toad, and a correction
  //
  // docs/m59-geometry-plan.md set this room as task 0's acceptance test, on the
  // expectation that its unreachable-but-walkable squares were a HEIGHT problem and
  // that parsing sectors would show them reachable. It is not, and it does not.
  //
  // The floors either side of the boundary that strands them are both at 3200, dead
  // flat. What actually strands them is a wall covering HALF of one square's edge:
  // the .roo carries movement as one byte per square, so "half of this edge is
  // blocked" has nowhere to live and the whole edge reads as blocked. Heights are
  // real and worth having — this room has a raised area with genuine stairs and
  // genuine cliffs — but they are not this bug, and the raycast is.
  //
  // Pinned so the claim in the plan cannot quietly drift back.
  const toad = path.join(roomsDir, 'marinn.roo');
  if (!fs.existsSync(toad)) skip('the Limping Toad', 'marinn.roo not present');
  else {
    const g = parseRoo(fs.readFileSync(toad), 'marinn.roo');
    const h = g.heightSummary;
    ok('the Toad has sectors and relief', h.sectors === 30 && h.floorMax > h.floorMin,
       `${h.sectors} sectors, floors ${h.floorMin}..${h.floorMax}`);
    ok('it has both climbable steps and real cliffs', h.steps > 0 && h.cliffs > 0,
       `${h.steps} steps, ${h.cliffs} cliffs`);
    // The boundary that strands the perimeter: col 12|13 at row 5.
    const onLine = g.walls.filter(w => w.x0 === 12288 && w.x1 === 12288);
    ok('one wall covers half of that edge', onLine.length === 1
       && Math.abs(onLine[0].y1 - onLine[0].y0) === CLIENT_FINENESS / 2,
       onLine.map(w => `y ${Math.min(w.y0, w.y1)}..${Math.max(w.y0, w.y1)}`).join(''));
    ok('and both floors there are level', onLine.every(w => w.z1 - w.z0 === 0),
       'so height is NOT what blocks it');
    const walkable = [];
    for (let r = 1; r <= g.rows; r++) for (let c = 1; c <= g.cols; c++) if (g.walkable(r, c)) walkable.push([r, c]);
    const seen = new Set(['8,8']); const q = [[8, 8]];
    while (q.length) { const [r, c] = q.pop();
      for (const nb of g.neighbors(r, c)) { const k = `${nb.row},${nb.col}`; if (!seen.has(k)) { seen.add(k); q.push([nb.row, nb.col]); } } }
    ok('the coarse grid still strands part of the room', walkable.length - seen.size > 0,
       `${walkable.length - seen.size} of ${walkable.length} walkable squares unreachable from (8,8)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
