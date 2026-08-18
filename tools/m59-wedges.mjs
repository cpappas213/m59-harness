#!/usr/bin/env node
// EVERY PLACE IN THE WORLD A CHARACTER CAN GET STUCK, WRITTEN DOWN.
//
//   node tools/m59-wedges.mjs                    the whole world, worst rooms first
//   node tools/m59-wedges.mjs --room 587         one room, every pocket in it
//   node tools/m59-wedges.mjs --save             write substrate/m59-wedges.json
//   node tools/m59-wedges.mjs --scenario 12      a testbed scenario placing 12 characters
//   node tools/m59-wedges.mjs --json
//
// OFFLINE. No server, no broker, no accounts, no logins. This is the point: a wedge is a
// statement about GEOMETRY, and geometry is on this disk. The live half — putting a real
// character on one of these squares and watching it try to leave — is a second step that
// only some of these need, and `--scenario` writes the file for it.
//
// WHAT A WEDGE IS, EXACTLY. Take the mover's own step relation (`moverStepLands`, the
// question that decides what the router may plan, not `stepAllowedByCollision`, which
// asks about a line between two square centres and answers a question about a line). It
// is a DIRECTED graph: a step from A to B being legal does not make the step back legal,
// which is what a ledge is. Seed from the room's main body and flood it twice:
//
//   forward   which squares the body can walk INTO
//   backward  which squares can walk back OUT to the body
//
// That gives four kinds of square, and conflating them is what a flood fill did before:
//
//   | in | out |                                                            |
//   |----|-----|------------------------------------------------------------|
//   | Y  |  Y  | the body. Ordinary floor.                                  |
//   | Y  |  N  | **TRAP** — you can walk in and you cannot walk out. This is |
//   |    |     | the one that costs a character, and it is the one the fleet |
//   |    |     | walks into on purpose, because a safe wall IS geometry the  |
//   |    |     | mover hems in.                                             |
//   | N  |  Y  | detour — you can leave it but the body cannot reach it. A   |
//   |    |     | character that spawns or teleports there walks out fine.    |
//   | N  |  N  | isolated — neither. Usually a doorway tile or a ledge only  |
//   |    |     | reachable by blink.                                        |
//
// ONLY THE SECOND ROW IS A TRAP, and separating it from the other two is the whole value
// here: 73,258 squares sit outside the main body world-wide and treating all of them as
// hazards would be a number nobody can act on.
//
// A COUNT IS NOT A CORPUS. `m59-routes.mjs` already reports "17,402 pockets" and that is
// where this started — but the bake stores the COUNT and not the squares, so there was
// nothing to test against, nothing to place a character on, and no way to tell whether a
// fix had covered a case. This writes the squares.
//
// AND THE MODEL IS STRICTER THAN THE WORLD, always. A square listed here is one the
// COLLISION VIEW cannot route out of; the server has no such opinion and a person may
// well walk out of it easily. That is why `--scenario` exists — the list is a hypothesis
// generator, and the live placement is what decides. Do not read this file as a map of
// places the game traps people.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { components } from './m59-routebake.mjs';
import { movementMapFile } from './m59-map-path.mjs';

const argv = process.argv.slice(2);
const has = name => argv.includes('--' + name);
const flag = (name, fallback = null) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEDGE_FILE = () => HERE + '/../substrate/m59-wedges.json';

/**
 * Every square outside a room's main body, classified by which way it is one-way.
 *
 * Pure, and it takes the geometry rather than a room number, so a test can hand it a
 * fixture. Returns null for a room with no step mask: without one the mover's own step
 * relation is unavailable and the coarse grid would answer a different question — and
 * answering a different question confidently is the failure this repository keeps naming.
 */
export function wedgesIn(geometry) {
  if (!geometry?.hasStepMask) return null;
  const { rows, cols } = geometry;
  const key = (r, c) => (r - 1) * cols + (c - 1);
  const floor = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++)
    if (geometry.walkable(r, c)) floor.push({ row: r, col: c });
  if (!floor.length) return { rows, cols, walkable: 0, body: 0, traps: [], detours: [], isolated: [] };

  // The step relation, both ways round, built once.
  //
  // FROM `neighbors()`, WHICH IS THE CALL THE ROUTER MAKES — not from `moverStepLands`
  // directly, however much the latter looks like the primitive. `neighbors` gates on the
  // coarse grid's open directions FIRST and only then asks the mover, so it is strictly
  // the smaller edge set, and a corpus built on the larger one describes a graph nothing
  // walks on. Measured while writing this: room 587 came out with 1403 of 1406 squares in
  // the body and NO traps at all, against the bake's own 1318 — a confident, tidy, wrong
  // answer that said the wedge room contains no wedges.
  //
  // This is the same "one quantity, two homes" failure the comment below warns about, one
  // function later. If the router's neighbour rule changes, this follows it for free.
  const out = new Map(), into = new Map();
  for (const at of floor) {
    const from = key(at.row, at.col);
    for (const n of geometry.neighbors(at.row, at.col, { collision: true })) {
      const to = key(n.row, n.col);
      (out.get(from) ?? out.set(from, []).get(from)).push(to);
      (into.get(to) ?? into.set(to, []).get(to)).push(from);
    }
  }
  const flood = (seed, edges) => {
    const seen = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
      const at = queue.pop();
      for (const next of edges.get(at) ?? [])
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen;
  };

  // THE BODY IS THE BIGGEST STRONGLY-CONNECTED LUMP, AND IT MUST BE FOUND RATHER THAN
  // SEEDED. The obvious shortcut — flood from the largest undirected component and call
  // what comes back mutually reachable "the body" — picks whatever square it started on,
  // and if that square is itself inside a one-way pocket the entire room is reported as a
  // giant trap. Measured while writing this: room 589 came out with a body of ONE square
  // and 984 traps, which is not a room, it is a bug with a confident number on it.
  //
  // `components()` in m59-routebake.mjs is already Tarjan over the MOVER's neighbours and
  // is what the bake's own region counts come from. Reused rather than reimplemented: two
  // definitions of "the body" is how the corpus and the router would come to disagree
  // about which squares are pockets, and neither would be obviously wrong.
  const scc = components(geometry, { collision: true });
  let bodyLabel = -1, bodyBest = -1;
  for (let id = 0; id < scc.sizes.length; id++)
    if (scc.sizes[id] > bodyBest) { bodyBest = scc.sizes[id]; bodyLabel = id; }
  const inBody = at => scc.label[scc.at(at.row, at.col)] === bodyLabel;
  const bodySeed = floor.find(inBody);
  if (!bodySeed) return { rows, cols, walkable: floor.length, body: 0,
                          traps: [], detours: [], isolated: [] };
  const seed = key(bodySeed.row, bodySeed.col);
  const bodyIn = flood(seed, out), bodyOut = flood(seed, into);

  const traps = [], detours = [], isolated = [];
  let body = 0;
  for (const at of floor) {
    const k = key(at.row, at.col);
    const reachable = bodyIn.has(k);       // the body can walk in
    const escapes = bodyOut.has(k);        // it can walk back out
    if (reachable && escapes) { body++; continue; }
    const square = { col: at.col, row: at.row };
    if (reachable && !escapes) traps.push(square);
    else if (!reachable && escapes) detours.push(square);
    else isolated.push(square);
  }
  return { rows, cols, walkable: floor.length, body, traps, detours, isolated };
}

// ---------------------------------------------------------------------------
export function surveyWorld({ mapFile = movementMapFile() } = {}) {
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const byRoom = new Map();
  const attached = attachStepMasks(map, { geometryOf: room => {
    let geometry = byRoom.get(room);
    if (!geometry) { geometry = RoomGeometry.fromJSON(room.roo); byRoom.set(room, geometry); }
    return geometry;
  } });
  const rooms = [];
  for (const [num, room] of Object.entries(map.rooms)) {
    const geometry = byRoom.get(room);
    const found = geometry ? wedgesIn(geometry) : null;
    if (!found) continue;
    rooms.push({ room: Number(num), name: room.name ?? null, ...found });
  }
  rooms.sort((a, b) => b.traps.length - a.traps.length);
  return { attached, manifest: map.geometryManifestSha256 ?? null, rooms };
}

// ---------------------------------------------------------------------------
// A SCENARIO IS A PLACEMENT, AND PLACEMENT IS THE ONLY PART THAT NEEDS A SERVER.
//
// Walking six characters from the newbie island to a test room took twenty minutes and
// failed on five of them; `System.UtilGoNearSquare` — which is what the DM rescue spell
// uses — does it in 0.22 seconds, verified. So the live half of a wedge test is: put a
// body on the square, tell it to leave, watch. `m59-testbed.mjs` already owns that
// choreography and `m59-dm.mjs relocate` is the primitive.
//
// LOOPBACK ONLY, AND THE FILE SAYS SO IN ITS OWN TEXT. The maintenance socket is
// unauthenticated and IP-restricted and that is its whole security model, so this shape
// of test cannot be pointed at prod — a shared server with real players on it — and the
// emitted scenario carries 127.0.0.1 rather than accepting a host.
//
// The accounts are deliberately the cheapest thing that can stand somewhere: `create
// automated` rolls ZERO in every attribute, which caps such a character at 102 max health
// for ever and cannot be repaired. For a fleet that is a disaster and is why
// m59-makefleet.mjs exists; for a body whose entire job is to stand on a square and try
// to walk off it, it is exactly right, and it is what makes a1..a9999 affordable.
export function scenarioFor(rooms, { count = 12, prefix = 'a', start = 1 } = {}) {
  const targets = [];
  for (const room of rooms) {
    for (const square of room.traps) {
      targets.push({ room: room.room, room_name: room.name, ...square });
      if (targets.length >= count) break;
    }
    if (targets.length >= count) break;
  }
  return {
    _: [
      'GENERATED by tools/m59-wedges.mjs --scenario. One throwaway character per wedge,',
      'placed on it by the maintenance socket rather than walked there.',
      '',
      '  node tools/m59-testbed.mjs up   scenarios/wedges.json',
      '',
      'LOOPBACK ONLY. The maintenance port is unauthenticated and IP-restricted and that',
      'is its entire security model; this is not a thing to point at a shared server.',
      '',
      'THE PASSWORDS HERE ARE THE ACCOUNT NAMES. That is fine for throwaway bodies on a',
      'server on this machine and is nothing to copy anywhere else — a scenario file is a',
      'credential store, which is why /scenarios/ is gitignored.',
      '',
      'Every character is `create automated`, which rolls ZERO in every attribute and caps',
      'it at 102 max health permanently. That is correct here: the job is to stand on a',
      'square and try to walk off it.',
    ],
    fleet: 'wedges',
    server: { host: '127.0.0.1', port: 15959, admin: 19998 },
    broker: { http: 8941, dashboard: 8942 },
    characters: targets.map((t, i) => ({
      agent: `${prefix}${start + i}`,
      account: `${prefix}${start + i}`,
      password: `${prefix}${start + i}`,
      roll: 'automated',
      place: { room: t.room, col: t.col, row: t.row },
      note: `wedge in ${t.room} (${t.room_name ?? '?'}) at ${t.col},${t.row}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Run as a command, or imported for `wedgesIn` — and importing must not run the survey.
// `process.argv[1]` is undefined under `node -e`, which is how a test or a one-liner
// reaches for the export, so it is checked before it is read.
if (process.argv[1]?.endsWith('m59-wedges.mjs')) {
  const survey = surveyWorld();
  if (!survey.attached.ok) {
    console.error(`no usable step masks — ${survey.attached.why}`);
    console.error('a wedge is a statement about the MOVER\'s step relation, and without a');
    console.error('baked mask the only thing available is the coarse grid, which answers a');
    console.error('different question. Run: node tools/m59-routebake.mjs');
    process.exit(1);
  }
  const only = flag('room');
  const rooms = only ? survey.rooms.filter(r => r.room === Number(only)) : survey.rooms;

  if (has('save')) {
    const file = WEDGE_FILE();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      format: 'm59-wedges/1', builtAt: new Date().toISOString(),
      geometryManifestSha256: survey.manifest, rooms: survey.rooms }, null, 0));
    console.log(`wrote ${file}`);
  }

  if (has('scenario')) {
    const count = Number(flag('scenario', '12')) || 12;
    console.log(JSON.stringify(scenarioFor(rooms, { count }), null, 2));
    process.exit(0);
  }

  if (has('json')) { console.log(JSON.stringify(rooms)); process.exit(0); }

  const total = k => rooms.reduce((n, r) => n + r[k].length, 0);
  if (only) {
    for (const r of rooms) {
      console.log(`room ${r.room} — ${r.name ?? '?'}  ${r.rows}x${r.cols}, ` +
                  `${r.walkable} walkable, ${r.body} in the main body`);
      const show = (label, list) => {
        if (!list.length) return;
        console.log(`  ${label} (${list.length}): ` +
          list.slice(0, 24).map(s => `${s.col},${s.row}`).join(' ') +
          (list.length > 24 ? ` … +${list.length - 24}` : ''));
      };
      show('TRAP — walk in, cannot walk out', r.traps);
      show('detour — can leave, body cannot enter', r.detours);
      show('isolated — neither', r.isolated);
    }
  } else {
    console.log(`${rooms.length} room(s) with baked masks\n`);
    console.log('  room  traps  detour  isolated  body/walkable  name');
    for (const r of rooms.slice(0, 25))
      console.log(`  ${String(r.room).padStart(4)} ${String(r.traps.length).padStart(6)} ` +
        `${String(r.detours.length).padStart(7)} ${String(r.isolated.length).padStart(9)}  ` +
        `${String(r.body + '/' + r.walkable).padStart(13)}  ${r.name ?? ''}`);
    console.log(`\n  TRAPS world-wide: ${total('traps')} — squares the body can walk INTO ` +
                `and not back out of.`);
    console.log(`  detours: ${total('detours')}, isolated: ${total('isolated')}.`);
    console.log('\n  Only the traps can strand a character that walked there itself. The');
    console.log('  model is stricter than the world, so treat these as candidates to go and');
    console.log('  look at — `--scenario` writes the file that puts a body on one.');
  }
}
