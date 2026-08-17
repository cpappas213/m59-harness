#!/usr/bin/env node
// THINGS THE WALLS MUST REFUSE — the negative half of the collision contract.
//
//   node tools/m59-impossible-test.mjs
//
// Offline, no server, no broker, no fleet. It reads `substrate/m59-map.json` and asks the
// baked geometry the question nothing else here asks.
//
// WHY IT EXISTS. `m59-collision-test.mjs` carries 153 assertions and they are ALL POSITIVE
// — Brownestone's doorway, the Limping Toad's half-wall, Icky, Farol, Ukgoth, Cor Noth,
// the Temple, the Fey precision cases — every one of them asserting that a legitimate move
// REMAINS USABLE. That is the right thing to protect, and it means the suite passes
// cleanly on the day the walls stop working. A collision bake exists to refuse; nothing
// was testing the refusing.
//
// The two failure directions are not symmetric and both are covered here:
//
//   * A wall that stops refusing is how a bot climbs a cliff, crosses a boundary no client
//     can, and walks into geometry a person cannot reach. That is the failure this file is
//     the guard against, and the REFUSALS below are it.
//   * A suite that only asserts refusals passes perfectly when EVERYTHING is refused,
//     which is the fleet standing still. So every room here also carries CONTROLS — real
//     traces across real floor that must still arrive. Both halves, in the same file, out
//     of the same fixtures, or the next person tightens one and silently breaks the other.
//
// OBSERVATION CANNOT BE THE ORACLE HERE, and that is why every case is a trace against our
// own validator rather than a report of what somebody saw. Players legitimately appear to
// phase through walls from another client's view — that is lag compensation, and it means
// "I watched it happen" proves nothing whatever about legality. What is asserted is what
// THIS repository will authorise, which is the only thing this repository controls.
//
// The fixtures are checked in rather than searched for at run time. A test that hunts for
// a blocked pair each time finds a different one each time, and a fixture that moves is a
// fixture that cannot fail. They were generated once against this bake and each carries
// the wall index the trace reported: if the geometry is rebaked and a wall genuinely moves,
// this file is supposed to go red and be re-read by a person.
import { readFileSync } from 'node:fs';
import { RoomGeometry, CLIENT_FINENESS } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
const centre = square => square * CLIENT_FINENESS + CLIENT_FINENESS / 2;
const geometryOf = room => RoomGeometry.fromJSON(map.rooms[String(room)].roo);

// ---------------------------------------------------------------------------
// THE CASES. Each `refuse` is a straight fine trace, at least eight squares long, between
// two squares the coarse grid calls floor, with a wall in the way — the shape of every
// traversal a bot has ever been caught making that a player cannot. `wall` is the wall
// index the trace blamed, asserted alongside the refusal so that "still refused, for a
// completely different reason" cannot pass as unchanged.
//
// The rooms are the ones the pathing work named: the road south from the King's Way, the
// Cragged Mountains at both of its numbers (the one place in the world genuinely joined
// only by blink), the Twisted Wood and its western border, Ukgoth and the Sentinel that
// stands before it, the Icky Cave, and the four floors of Castle Victoria.
// ---------------------------------------------------------------------------
const CASES = [
  { room: 575, name: "The King's Way",
    refuse: [{ from: [9, 25], to: [14, 47], wall: 546 },
             { from: [46, 24], to: [4, 36], wall: 277 },
             { from: [37, 18], to: [27, 16], wall: 353 }],
    allow:  [{ from: [24, 12], to: [38, 3] }, { from: [20, 24], to: [11, 32] }] },
  { room: 576, name: "The King's Way, the long stretch to the mountains",
    refuse: [{ from: [16, 127], to: [25, 31], wall: 651 },
             { from: [58, 24], to: [16, 127], wall: 114 },
             { from: [29, 26], to: [47, 106], wall: 112 }],
    allow:  [{ from: [57, 18], to: [54, 31] }, { from: [39, 40], to: [28, 123] }] },
  { room: 578, name: 'The Cragged Mountains',
    refuse: [{ from: [37, 43], to: [2, 11], wall: 767 },
             { from: [7, 35], to: [33, 36], wall: 792 },
             { from: [2, 10], to: [32, 2], wall: 470 }],
    allow:  [{ from: [29, 43], to: [29, 32] }, { from: [35, 33], to: [23, 38] }] },
  { room: 598, name: 'The Cragged Mountains, by its other number',
    refuse: [{ from: [25, 47], to: [6, 62], wall: 214 },
             { from: [1, 7], to: [35, 15], wall: 362 },
             { from: [31, 53], to: [11, 22], wall: 76 }],
    allow:  [{ from: [17, 55], to: [5, 58] }, { from: [18, 4], to: [35, 17] }] },
  { room: 597, name: 'The Twisted Wood',
    refuse: [{ from: [47, 43], to: [29, 24], wall: 29 },
             { from: [17, 3], to: [23, 23], wall: 322 },
             { from: [32, 40], to: [13, 24], wall: 187 }],
    allow:  [{ from: [13, 22], to: [26, 21] }, { from: [30, 36], to: [31, 49] }] },
  { room: 587, name: 'Western border of the Twisted Wood — where the wedge was watched',
    refuse: [{ from: [41, 20], to: [57, 9], wall: 415 },
             { from: [31, 13], to: [61, 26], wall: 191 },
             { from: [62, 26], to: [50, 28], wall: 291 }],
    allow:  [{ from: [48, 13], to: [39, 19] }, { from: [44, 36], to: [46, 52] }] },
  { room: 589, name: 'Under the shadow of the Sentinel',
    refuse: [{ from: [7, 14], to: [24, 31], wall: 195 },
             { from: [16, 47], to: [13, 28], wall: 359 },
             { from: [7, 2], to: [25, 7], wall: 139 }],
    allow:  [{ from: [36, 38], to: [19, 37] }, { from: [19, 28], to: [14, 28] }] },
  { room: 599, name: 'Ukgoth, Holy Land of Trolls',
    refuse: [{ from: [27, 5], to: [48, 24], wall: 237 },
             { from: [52, 40], to: [30, 19], wall: 389 },
             { from: [53, 34], to: [38, 25], wall: 381 }],
    allow:  [{ from: [53, 39], to: [50, 47] }, { from: [24, 7], to: [39, 13] }] },
  { room: 27, name: 'A Deep, Dark, Spooky, Icky Cave',
    refuse: [{ from: [38, 24], to: [25, 40], wall: 747 },
             { from: [21, 34], to: [23, 45], wall: 414 },
             { from: [46, 48], to: [1, 11], wall: 934 }],
    allow:  [{ from: [20, 42], to: [18, 48] }, { from: [28, 41], to: [22, 30] }] },
  { room: 38, name: 'Castle Victoria',
    refuse: [{ from: [46, 16], to: [10, 13], wall: 670 },
             { from: [32, 5], to: [30, 14], wall: 598 },
             { from: [25, 12], to: [34, 13], wall: 739 }],
    allow:  [{ from: [35, 11], to: [23, 12] }, { from: [35, 12], to: [43, 20] }] },
  { room: 39, name: 'Upstairs in Castle Victoria',
    refuse: [{ from: [17, 3], to: [44, 6], wall: 196 },
             { from: [18, 6], to: [12, 14], wall: 182 },
             { from: [41, 9], to: [4, 11], wall: 6 }],
    allow:  [{ from: [27, 7], to: [43, 7] }, { from: [24, 11], to: [18, 10] }] },
  { room: 40, name: 'The Throne Room of Victoria Castle',
    refuse: [{ from: [1, 10], to: [4, 20], wall: 33 },
             { from: [8, 5], to: [8, 20], wall: 2 },
             { from: [1, 21], to: [5, 7], wall: 54 }],
    allow:  [{ from: [8, 11], to: [1, 22] }, { from: [1, 14], to: [6, 4] }] },
  { room: 41, name: 'Underbasement of Victoria',
    refuse: [{ from: [11, 20], to: [8, 4], wall: 144 },
             { from: [14, 24], to: [4, 8], wall: 110 },
             { from: [13, 16], to: [14, 6], wall: 121 }],
    allow:  [{ from: [23, 19], to: [14, 12] }, { from: [12, 19], to: [21, 24] }] },
];

console.log('the walls refuse — and are blamed by name');
let refusals = 0, controls = 0;
for (const kase of CASES) {
  const geometry = geometryOf(kase.room);
  ok(`room ${kase.room} has collision-ready geometry`, geometry.collisionReady);
  const trace = ([col, row], [toCol, toRow]) => geometry.traceFineMoveClient(
    centre(col), centre(row), centre(toCol), centre(toRow), { slide: false });

  for (const c of kase.refuse) {
    const t = trace(c.from, c.to);
    refusals++;
    // NOT ARRIVED IS THE ASSERTION. `moved` is allowed to be true: the trace may travel
    // right up to the wall and stop, which is what a person walking into one does. What
    // may never happen is the far end being handed back as a legal endpoint, because that
    // endpoint is what `validateFineTarget` would put in a movement packet.
    ok(`${kase.name} (${kase.room}) refuses ${c.from} -> ${c.to}`,
       t.arrived !== true, JSON.stringify(t));
    ok(`  and it is wall ${c.wall} that refuses it`, t.wallIndex === c.wall,
       `blamed ${t.wallIndex} for ${t.reason}`);
  }

  // THE OTHER POLARITY, IN THE SAME ROOM AND OUT OF THE SAME BAKE. Without these, a
  // geometry that refused every move in the world would pass this file with full marks.
  for (const c of kase.allow) {
    const t = trace(c.from, c.to);
    controls++;
    ok(`${kase.name} (${kase.room}) still allows ${c.from} -> ${c.to}`,
       t.arrived === true, JSON.stringify(t));
  }
}
ok('every case carries both polarities', refusals === CASES.length * 3
   && controls === CASES.length * 2, `${refusals} refusals, ${controls} controls`);

// ---------------------------------------------------------------------------
// A SEALED HALF OF A FLOOR IS A STRONGER CLAIM THAN A BLOCKED LINE, and the upstairs of
// Castle Victoria is the case the pathing work named: far west to far east WITHOUT USING
// THE DOOR. One blocked trace says a wall is in the way of one line; this says no sequence
// of steps the mover would make gets from one end of that floor to the other at all.
//
// Asked with `moverStepLands`, deliberately — the question of what the MOVER will land,
// not `stepAllowedByCollision`, which asks about a line between two square centres and
// answers a question about a line rather than about a character. Room 150 comes out in 159
// disconnected pieces asked the wrong way and 15 asked this one.
// ---------------------------------------------------------------------------
console.log('\na sealed floor stays sealed');
{
  const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const bodyFrom = (geometry, start) => {
    const seen = new Set([`${start.row},${start.col}`]);
    const queue = [start];
    while (queue.length) {
      const at = queue.pop();
      for (const [dr, dc] of STEPS) {
        const row = at.row + dr, col = at.col + dc, key = `${row},${col}`;
        if (row < 0 || col < 0 || row >= geometry.rows || col >= geometry.cols) continue;
        if (seen.has(key) || !geometry.walkable(row, col)) continue;
        if (!geometry.moverStepLands(at.row, at.col, row, col)) continue;
        seen.add(key); queue.push({ row, col });
      }
    }
    return seen;
  };

  const upstairs = geometryOf(39);
  const west = { row: 8, col: 1 }, east = { row: 3, col: 46 };
  ok('both ends of the upstairs floor are floor',
     upstairs.walkable(west.row, west.col) && upstairs.walkable(east.row, east.col));
  const body = bodyFrom(upstairs, west);
  ok('the far east end cannot be walked to from the far west end',
     !body.has(`${east.row},${east.col}`));
  // NEITHER END IS A BOUNDARY ARTEFACT. A square on the outermost row or column of a room
  // is routinely one-way in the bake — you can step off it and not back onto it — and an
  // assertion built on one of those would be pinning a property of the room edge while
  // claiming to pin a wall. Both of these are interior columns of a 48-wide floor.
  ok('and neither end is on the room boundary',
     west.col > 0 && east.col < upstairs.cols - 1);
  ok('the sealed half is a real half rather than a corner',
     body.size > 200 && body.size < 500, `${body.size} squares`);

  // The two halves are exactly what the two `go` doors serve, which is what makes this a
  // SEAL rather than a wall: the way across that floor is through room 38 and back.
  const doors = [{ row: 9, col: 27 }, { row: 9, col: 24 }];
  ok('the two upstairs doors land in different halves',
     body.has(`${doors[1].row},${doors[1].col}`) !== body.has(`${doors[0].row},${doors[0].col}`),
     JSON.stringify(doors.map(d => body.has(`${d.row},${d.col}`))));

  // AND THE CASTLE'S OTHER FLOORS ARE NOT SEALED, which is the control for the control:
  // if every room came out in halves this assertion would mean nothing about room 39.
  for (const room of [38, 40, 41]) {
    const geometry = geometryOf(room);
    const floor = [];
    for (let row = 0; row < geometry.rows; row++)
      for (let col = 0; col < geometry.cols; col++)
        if (geometry.walkable(row, col)) floor.push({ row, col });
    const sorted = floor.slice().sort((a, b) => a.col - b.col);
    const reached = bodyFrom(geometry, sorted[0]);
    const far = sorted[sorted.length - 1];
    ok(`room ${room} is NOT sealed end to end`, reached.has(`${far.row},${far.col}`));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
