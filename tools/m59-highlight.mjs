#!/usr/bin/env node
// PAINT THE GEOMETRY THE ROUTER IS ARGUING ABOUT, IN THE ACTUAL GAME.
//
//   node tools/m59-highlight.mjs 587                    what it WOULD paint, changes nothing
//   node tools/m59-highlight.mjs 587 --apply            repaint it, live, for everyone in the room
//   node tools/m59-highlight.mjs 587 --clear --apply    put the original textures back
//   node tools/m59-highlight.mjs 587 --kind no-centre   pick which fault to paint
//
// THE POINT. Every argument in this repository about geometry has been conducted in
// numbers — 68 regions, 17,402 pockets, `walkable(4,2) === false` — and every one of those
// numbers has been wrong at least once in a way that took a person looking at the screen
// to catch. Three diagnoses of one hang were wrong before somebody logged in and said "it
// looks like a normal corridor to me", which settled it in one sentence. This turns the
// model's claims into something you can stand in front of.
//
// IT PLACES OBJECTS, AND THE ROUTE IT DOES NOT TAKE IS THE INTERESTING PART.
//
// The obvious way to mark geometry in the 3D world is to repaint it:
// `Room.ChangeTexture(id, new_texture, flags)` (`room.kod:2601`) pushes a texture override
// to everyone in the room and stores it for later arrivals, and the harness already parses
// the resulting packet. It cannot work here, and the reason is worth writing down rather
// than discovering twice.
//
// **ChangeTexture ADDRESSES SURFACES BY SERVER ID, AND ALMOST NOTHING HAS ONE.** A server
// id is assigned by the room designer to surfaces kod needs to talk to — a door, a puzzle
// floor. Measured on the raw .roo files:
//
//   587 Western border of the Twisted Wood   0 of 15 sectors, 0 of 27 sidedefs
//   578 The Cragged Mountains                0 of 157 sectors, 0 of 6 sidedefs
//   38  Castle Victoria                      0 of 116 sectors, 0 of 48 sidedefs
//   27  A Deep, Dark, Spooky, Icky Cave      6 of 120 sectors, 0 of 46 sidedefs
//
// So in every room this repository has argued about, there is nothing to repaint. A tool
// built on it would have run cleanly and painted nothing, which is the failure mode this
// codebase keeps naming: the call succeeded and the world did not change.
//
// SO IT PLACES AN OBJECT INSTEAD, one per flagged square, through the same
// `System.UtilGoNearSquare` that puts a test character on an exact square in 0.22s. That
// needs no server ids, works in every room, is visible in the 3D view rather than only on
// the map, and comes back off with a delete. It is also per-SQUARE, which a wall can never
// be — and the fault we are chasing is about squares.
//
// ONE THING TO KNOW ABOUT THE PLACEMENT: `UtilGoNearSquare` searches OUTWARD until it
// finds somewhere the object will fit and never says no, so a marker for a square with no
// floor under its centre — the exact case worth marking — lands NEXT to it rather than on
// it. That is not a bug to route around, it is the fault demonstrating itself, and the
// report says which markers landed off-target so you are not misled by where they sit.
//
// LOOPBACK ONLY, and not as a courtesy. The maintenance port is unauthenticated and
// IP-restricted and that IS its security model, so this is refused against anything else —
// the same guard `m59-dm.mjs` runs, imported rather than re-implemented. Pointing it at
// prod, a shared server with real players on it, would be repainting somebody else's
// world.
//
// TWO THINGS IT WILL DO THAT LOOK LIKE BUGS AND ARE NOT:
//
//   * A MARKER IS AN OBJECT, SO IT IS LOOTABLE AND IT DECAYS. Anything droppable can be
//     picked up by whoever walks past, and the server garbage-collects. Re-run it rather
//     than trusting yesterday's markers, and never leave them where a working fleet is.
//   * IT CHANGES NO GEOMETRY. An object on the floor moves no wall and no height, so it
//     cannot make a wedge better or worse — which is what makes it safe to switch on while
//     debugging the very thing it is describing.
import { readFileSync } from 'node:fs';
import { dm, isLoopbackHost, adminTarget, roomObject, relocateCmd, rejections, clampSquare }
  from './m59-dm.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { wedgesIn } from './m59-wedges.mjs';
import { movementMapFile } from './m59-map-path.mjs';

// WHAT TO DROP ON EACH KIND. Distinct, obviously artificial, and cheap to create — the
// point is legibility from across a room, not realism.
export const MARK = {
  trap:        { klass: 'Torch',   why: 'walk in, cannot walk out — the router can enter and not leave' },
  detour:      { klass: 'Flask',   why: 'can leave, the body cannot enter' },
  isolated:    { klass: 'Mug',     why: 'neither — a doorway tile or a blink-only ledge' },
  'no-centre': { klass: 'Scepter', why: 'real floor, but its CENTRE is inside geometry, so every ' +
                                        'route the planner can express aims into a wall' },
};
export const KINDS = Object.keys(MARK);

/**
 * Which squares to mark, and why each one.
 *
 * Pure — geometry in, plan out — so the half worth arguing about is testable without a
 * socket or a server. `no-centre` is computed here rather than taken from the wedge corpus
 * because it is a DIFFERENT QUESTION from the corpus's three: not "can the body reach this
 * square" but "can the planner even AIM at it". That is what bit us in room 587, it is
 * invisible to every other instrument in this repository, and it is exactly what a person
 * standing in the corridor reports as completely normal.
 */
export function planFor(geometry, { kinds = KINDS, limit = 40 } = {}) {
  const found = wedgesIn(geometry);
  const K = 64, C = 1024, S = C / K;
  const centre = square => (square * K + (K >> 1) - K) * S;
  const marks = [];
  const take = (kind, squares) => {
    for (const s of squares) {
      if (marks.length >= limit) return;
      marks.push({ kind, col: s.col, row: s.row, klass: MARK[kind].klass, why: MARK[kind].why,
                   // Whether the marker can land ON the square at all. `UtilGoNearSquare`
                   // never says no, so this is the difference between a marker whose
                   // position can be trusted and one that will sit next door.
                   centre_has_floor: !!geometry.leafAtClient(centre(s.col), centre(s.row)) });
    }
  };
  if (kinds.includes('trap')) take('trap', found?.traps ?? []);
  if (kinds.includes('detour')) take('detour', found?.detours ?? []);
  if (kinds.includes('isolated')) take('isolated', found?.isolated ?? []);

  if (kinds.includes('no-centre')) {
    const offCentre = [];
    for (let row = 1; row <= geometry.rows && marks.length + offCentre.length < limit; row++) {
      for (let col = 1; col <= geometry.cols; col++) {
        if (geometry.leafAtClient(centre(col), centre(row))) continue;   // centre is fine
        let floor = 0, total = 0;
        for (let dx = -C / 2; dx < C / 2; dx += 128)
          for (let dy = -C / 2; dy < C / 2; dy += 128) {
            total++;
            if (geometry.leafAtClient(centre(col) + dx, centre(row) + dy)) floor++;
          }
        // A THIRD OF THE SQUARE IS THE BAR, and it is deliberately generous: the case that
        // cost a session was 41% floor, and a square that is one-tenth floor is a corner
        // nobody walks through. Under this is not worth a person's attention.
        if (floor / total >= 0.33)
          offCentre.push({ col, row, floor_fraction: Math.round(100 * floor / total) + '%' });
      }
    }
    for (const s of offCentre) {
      if (marks.length >= limit) break;
      marks.push({ kind: 'no-centre', ...s, klass: MARK['no-centre'].klass,
                   why: MARK['no-centre'].why, centre_has_floor: false });
    }
  }
  return { marks, off_target: marks.filter(m => !m.centre_has_floor).length };
}

/**
 * The maintenance-socket batches for a plan.
 *
 * ONE BATCH, NOT ONE ROUND TRIP PER MARKER. The socket needs no pacing at all — 2000
 * commands written as one buffer got 2000 replies — and every other caller here that paced
 * itself was paying for nothing. Creation and placement are two batches rather than one
 * only because the new object's id has to be read back in between.
 */
export const createCmds = plan => plan.marks.map(m => `create object ${m.klass}`);
export const placeCmds = (ids, roomObj, plan, dims) => plan.marks.map((m, i) => {
  const { row, col } = clampSquare(m.row, m.col, dims?.rows, dims?.cols);
  return ids[i] == null ? null : relocateCmd(ids[i], roomObj, row, col);
}).filter(Boolean);

// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith('m59-highlight.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const roomNum = Number(argv.find(a => /^[0-9]+$/.test(a)));
  if (!roomNum) {
    console.error('usage: node tools/m59-highlight.mjs <room> [--kind trap,no-centre] [--apply]');
    process.exit(2);
  }
  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error('refusing: the maintenance port is unauthenticated and IP-restricted, and ' +
                  target.host + ' is not loopback. This drops objects into a world other ' +
                  'people are standing in.');
    process.exit(2);
  }

  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const byRoom = new Map();
  attachStepMasks(map, { geometryOf: room => {
    let g = byRoom.get(room);
    if (!g) { g = RoomGeometry.fromJSON(room.roo); byRoom.set(room, g); }
    return g;
  } });
  const room = map.rooms[String(roomNum)];
  if (!room) { console.error('no room ' + roomNum + ' in the baked map'); process.exit(2); }
  const geometry = byRoom.get(room);

  const kinds = (flag('kind') ?? KINDS.join(',')).split(',').map(x => x.trim()).filter(Boolean);
  const bad = kinds.filter(k => !KINDS.includes(k));
  if (bad.length) {
    console.error('unknown kind(s): ' + bad.join(', ') + ' — known: ' + KINDS.join(', '));
    process.exit(2);
  }
  const plan = planFor(geometry, { kinds, limit: Number(flag('limit', '40')) });

  console.log('room ' + roomNum + ' — ' + (room.name ?? '?'));
  for (const kind of kinds) {
    const mine = plan.marks.filter(m => m.kind === kind);
    if (!mine.length) { console.log('  ' + kind + ': nothing to mark'); continue; }
    console.log('  ' + kind + ': ' + mine.length + ' square(s), marked with a ' +
                MARK[kind].klass + ' — ' + MARK[kind].why);
    console.log('    ' + mine.slice(0, 12).map(m => m.col + ',' + m.row +
      (m.floor_fraction ? '(' + m.floor_fraction + ' floor)' : '')).join(' ') +
      (mine.length > 12 ? ' … +' + (mine.length - 12) : ''));
  }
  if (plan.off_target)
    console.log('  ' + plan.off_target + ' marker(s) cannot land on their own square — no ' +
                'floor under the centre, so UtilGoNearSquare will put them NEXT to it. That ' +
                'is the fault demonstrating itself; read those as "beside", not "on".');

  if (!has('apply')) {
    console.log('\n  nothing was sent. --apply drops the markers into the live room.');
    process.exit(0);
  }

  const roomObj = await roomObject(roomNum);
  if (roomObj == null) {
    console.error('could not resolve room ' + roomNum + ' on this server');
    process.exit(1);
  }
  const made = await dm(createCmds(plan));
  // `create object` HAS ITS OWN REPLY SHAPE, and it is not the one every other reader in
  // this repository is written against. A `send` answers `:< return from OBJECT 0 MESSAGE
  // …` then `: OBJECT 267`, which is why `returnedObject` takes the bare-colon line — and
  // reading `create` with that rule silently returns nothing, which is exactly what
  // happened here: twelve objects were created on the server and none were placed. This
  // is the admin console's own sentence, and it is the only thing that names a new object.
  const ids = [...String(made).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
  if (ids.length !== plan.marks.length)
    console.log('  warning: asked for ' + plan.marks.length + ' objects and read back ' +
                ids.length + ' ids');
  const placed = await dm(placeCmds(ids, roomObj, plan, geometry));
  const refused = [...rejections(made), ...rejections(placed)];
  console.log('\n  placed ' + Math.min(ids.length, plan.marks.length) + ' marker(s) in room ' +
              roomNum + (refused.length ? ' — ' + refused.length + ' refused: ' +
              refused.slice(0, 3).join('; ') : ''));
  console.log('  they are ordinary objects: lootable, and the server garbage-collects them.');
}
