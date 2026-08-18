#!/usr/bin/env node
// STAND ME IN FRONT OF THE NEXT BROKEN THING.
//
//   node tools/m59-tour.mjs                    the itinerary, worst first
//   node tools/m59-tour.mjs --next             go to the next site, mark it, say what to look for
//   node tools/m59-tour.mjs --site 3           go to a particular one
//   node tools/m59-tour.mjs --again            re-place and re-mark where you already are
//   node tools/m59-tour.mjs --room 578         tour a different room
//   node tools/m59-tour.mjs --who Alpha        tour with somebody other than TESTER
//
// THE WHOLE POINT IS THE PERSON. Every geometric claim this repository has made has been
// wrong at least once — contention, then the pocket trap, then "both maps agree there is no
// floor" — and each one was settled by somebody logging in and saying what they saw. The
// bottleneck was never the analysis, it was getting a human body to the exact square the
// analysis was arguing about. This removes that: click the shortcut, run `--next`, look.
//
// IT MOVES THE CHARACTER YOU ARE PLAYING, ON PURPOSE. `System.UtilGoNearSquare` acts on the
// character object and does not care who is driving it, so this works while you are logged
// in — the world simply changes around you. That is the fast path: walking six characters
// to a test room took twenty minutes and failed on five of them; this is 0.22 seconds.
//
// LOOPBACK ONLY, enforced by m59-dm.mjs's own guard rather than by a promise here.
//
// WHAT "MOST PROBLEMATIC" MEANS, AND WHY IT IS NOT THE TRAP COUNT. The corpus's traps are
// squares the ROUTER cannot get out of, and there are 4,823 of them — but the fault that
// actually cost this session was a different one the corpus cannot see: a square with real
// floor over most of its area whose CENTRE is inside geometry. Those are invisible to every
// instrument here, they read as perfectly ordinary corridor to a person, and every route
// the planner can express aims at a centre. So the itinerary is sorted by how much of the
// square is genuinely walkable while being unaddressable — the higher that is, the more
// certainly it is a place a person walks and a bot cannot.
import { readFileSync } from 'node:fs';
import { dm, isLoopbackHost, adminTarget, roomObject, resolve, relocateCmd, rejections,
         clampSquare } from './m59-dm.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { wedgesIn } from './m59-wedges.mjs';
import { planFor, createCmds, placeCmds } from './m59-highlight.mjs';
import { movementMapFile } from './m59-map-path.mjs';

const K = 64, C = 1024, S = C / K;
const centre = square => (square * K + (K >> 1) - K) * S;

/**
 * The itinerary for one room: every site worth a person's time, worst first.
 *
 * Pure. A site is a square plus the reason it is interesting plus what to check when you
 * are standing on it — that last field matters, because a tour that says "look at this"
 * without saying what would falsify the claim is sightseeing rather than debugging.
 */
export function itinerary(geometry, { limit = 25 } = {}) {
  const sites = [];
  const floorFraction = (col, row) => {
    let floor = 0, total = 0;
    for (let dx = -C / 2; dx < C / 2; dx += 128)
      for (let dy = -C / 2; dy < C / 2; dy += 128) {
        total++;
        if (geometry.leafAtClient(centre(col) + dx, centre(row) + dy)) floor++;
      }
    return floor / total;
  };

  // 1. THE CONFIRMED FAULT: walkable floor the planner cannot aim at.
  for (let row = 1; row <= geometry.rows; row++) {
    for (let col = 1; col <= geometry.cols; col++) {
      if (geometry.leafAtClient(centre(col), centre(row))) continue;
      const fraction = floorFraction(col, row);
      if (fraction < 0.33) continue;
      sites.push({
        kind: 'no-centre', col, row, score: fraction,
        floor: Math.round(fraction * 100) + '%',
        what: 'this square has real floor you can stand on, but nothing under its CENTRE',
        why: 'every route the planner can express aims at square centres, so it can neither ' +
             'plan through here nor plan out of here. The coarse grid marks the whole square ' +
             'unwalkable, which is why the board says a character is standing on nothing.',
        check: 'does this look like ordinary corridor or floor to you? If it does, the model ' +
               'is wrong about it and the fix is ours. If it looks like a wall or a ledge you ' +
               'are wedged against, the model is right and the fault is elsewhere.',
      });
    }
  }

  // 2. THE ROUTER'S OWN TRAPS: walk in, cannot walk out.
  const found = wedgesIn(geometry);
  for (const s of (found?.traps ?? [])) {
    sites.push({
      kind: 'trap', col: s.col, row: s.row, score: 0.3,
      floor: Math.round(floorFraction(s.col, s.row) * 100) + '%',
      what: 'the router can walk INTO this square and has no way to walk back out',
      why: 'a safe wall is exactly this shape — geometry the mover hems in — so the fleet ' +
           'seeks these out deliberately and then cannot leave.',
      check: 'walk in, then try to walk back out the way you came. If you can, the step model ' +
             'is stricter than the game and we are refusing moves that are legal.',
    });
  }

  sites.sort((a, b) => b.score - a.score);
  return sites.slice(0, limit);
}

// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith('m59-tour.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error('refusing: ' + target.host + ' is not loopback. The maintenance port has no ' +
                  'authentication, and this teleports a character and drops objects.');
    process.exit(2);
  }

  const roomNum = Number(flag('room', '587'));
  const who = flag('who', 'TESTER');
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
  const sites = itinerary(geometry);
  if (!sites.length) { console.log('room ' + roomNum + ' has nothing worth touring'); process.exit(0); }

  // WHERE WE ARE UP TO, kept in a file rather than in the shell, so `--next` means the same
  // thing from a different terminal — and so the tour survives you closing one.
  const bookmarkFile = new URL('../substrate/tour-bookmark.json', import.meta.url);
  let mark = { room: roomNum, at: -1 };
  try { mark = JSON.parse(readFileSync(bookmarkFile, 'utf8')); } catch { /* first run */ }
  if (mark.room !== roomNum) mark = { room: roomNum, at: -1 };

  if (!has('next') && !has('site') && !has('again')) {
    console.log('room ' + roomNum + ' — ' + (room.name ?? '?') + ', ' + sites.length + ' site(s)\n');
    sites.forEach((s, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' +
      (s.col + ',' + s.row).padEnd(8) + s.kind.padEnd(11) + s.floor.padStart(4) + ' floor   ' +
      s.what.slice(0, 60)));
    console.log('\n  --next goes to the one after ' + (mark.at + 1) + '. --site N picks one.');
    process.exit(0);
  }

  const index = has('site') ? Number(flag('site')) - 1
    : has('again') ? Math.max(0, mark.at)
    : mark.at + 1;
  if (index < 0 || index >= sites.length) {
    console.log('that is the end of the tour for room ' + roomNum + ' — ' + sites.length +
                ' site(s). --site 1 starts again.');
    process.exit(0);
  }
  const site = sites[index];

  // `resolve` answers a map keyed by the NAME asked for, not a positional array — which
  // matters because a name it cannot find is present as null rather than absent, so the
  // two failure modes stay distinguishable.
  const charId = (await resolve([who]))[who];
  if (charId == null) {
    console.error('could not find a character called "' + who + '" on this server. Is it ' +
                  'logged in? UtilGoNearSquare acts on the object, so it has to exist.');
    process.exit(1);
  }
  const roomObj = await roomObject(roomNum);
  if (roomObj == null) { console.error('could not resolve room ' + roomNum); process.exit(1); }

  // Mark the site first, so the markers are already there when you arrive rather than
  // appearing around you.
  const plan = planFor(geometry, { kinds: [site.kind === 'trap' ? 'trap' : 'no-centre'], limit: 6 });
  const near = { marks: plan.marks.filter(m =>
    Math.max(Math.abs(m.col - site.col), Math.abs(m.row - site.row)) <= 6).slice(0, 6) };
  if (near.marks.length) {
    const made = await dm(createCmds(near));
    const ids = [...String(made).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
    await dm(placeCmds(ids, roomObj, near, geometry));
  }

  // AIM AT THE SQUARE NEXT DOOR, NOT AT THE SITE. UtilGoNearSquare searches outward from
  // what it is given and never refuses, so asking it for a square with no floor under the
  // centre lands you somewhere it chose and did not tell you about. Asking for a neighbour
  // that IS standable puts you beside the fault, facing it, which is what a person wants.
  let stand = { col: site.col, row: site.row };
  if (!geometry.leafAtClient(centre(site.col), centre(site.row))) {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const c = site.col + dc, r = site.row + dr;
      if (geometry.leafAtClient(centre(c), centre(r))) { stand = { col: c, row: r }; break; }
    }
  }
  const { row, col } = clampSquare(stand.row, stand.col, geometry.rows, geometry.cols);
  const moved = await dm([relocateCmd(charId, roomObj, row, col)]);
  const refused = rejections(moved);

  console.log('site ' + (index + 1) + ' of ' + sites.length + ' — room ' + roomNum + ', ' +
              (room.name ?? '?'));
  console.log('  the square in question : ' + site.col + ',' + site.row +
              '   (' + site.floor + ' of it is real floor)');
  console.log('  you are standing at    : ' + col + ',' + row +
              (stand.col === site.col && stand.row === site.row
                ? '   (on it)' : '   (BESIDE it — nothing can stand on the centre of the site)'));
  console.log('\n  WHAT IT IS   ' + site.what);
  console.log('  WHY IT COSTS ' + site.why);
  console.log('\n  WHAT TO CHECK\n    ' + site.check);
  if (near.marks.length) console.log('\n  ' + near.marks.length + ' marker(s) dropped nearby.');
  if (refused.length) console.log('  refused: ' + refused.slice(0, 2).join('; '));
  console.log('\n  --next for the next one, --again to re-place yourself here.');

  const { writeFileSync } = await import('node:fs');
  writeFileSync(bookmarkFile, JSON.stringify({ room: roomNum, at: index }));
}
