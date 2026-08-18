#!/usr/bin/env node
// DROP A THING WHERE I WANT YOU TO WALK, AND TAKE IT AWAY AFTERWARDS.
//
//   node tools/m59-ping.mjs --room 587 --at 41,30 --at 39,30   two waypoints
//   node tools/m59-ping.mjs --list                             what is currently out there
//   node tools/m59-ping.mjs --clear                            remove every ping
//
// The smallest possible tool, and it exists because the expensive part of every geometry
// question this session has been getting a person to the exact square the argument is
// about. A number in a terminal is not a place. A torch on the floor is.
//
// WHY IT REMEMBERS WHAT IT DROPPED. `create object` hands back an id and nothing else ever
// mentions it again, so a ping nobody wrote down is litter in somebody's game world for as
// long as the server runs. The book is `substrate/pings.json`, and `--clear` is the only
// reason it exists — a debugging aid that cannot be undone stops being used.
//
// DELETION IS `send object N Delete`, NOT `delete object N`. The admin console has a
// `delete` subcommand and it answers `Unknown command; try 'help'.` for this, while
// `help delete` unhelpfully re-prints the top-level list. The kod message is what works,
// and it returns `: $ 0` rather than anything resembling a confirmation.
//
// LOOPBACK ONLY, by m59-dm.mjs's own guard.
import { readFileSync, writeFileSync } from 'node:fs';
import { dm, isLoopbackHost, adminTarget, roomObject, relocateCmd, rejections, clampSquare }
  from './m59-dm.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { movementMapFile } from './m59-map-path.mjs';

const BOOK = new URL('../substrate/pings.json', import.meta.url);
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { pings: [] }; } };
const save = book => writeFileSync(BOOK, JSON.stringify(book, null, 1));

if (process.argv[1]?.endsWith('m59-ping.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error('refusing: ' + target.host + ' is not loopback.');
    process.exit(2);
  }
  const book = load();

  if (has('list')) {
    if (!book.pings.length) console.log('no pings out');
    for (const p of book.pings)
      console.log('  object ' + p.id + '  room ' + p.room + '  at ' + p.col + ',' + p.row +
                  (p.note ? '  — ' + p.note : ''));
    process.exit(0);
  }

  if (has('clear')) {
    if (!book.pings.length) { console.log('nothing to clear'); process.exit(0); }
    const out = await dm(book.pings.map(p => 'send object ' + p.id + ' Delete'));
    const refused = rejections(out);
    console.log('cleared ' + book.pings.length + ' ping(s)' +
                (refused.length ? ' — ' + refused.length + ' refused' : ''));
    save({ pings: [] });
    process.exit(0);
  }

  // --at may be repeated; each is col,row.
  const ats = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === '--at' && argv[i + 1]) {
      const [col, row] = argv[i + 1].split(',').map(Number);
      if (Number.isFinite(col) && Number.isFinite(row)) ats.push({ col, row });
    }
  if (!ats.length) {
    console.error('usage: node tools/m59-ping.mjs --room 587 --at col,row [--at col,row] ' +
                  '[--klass Torch] [--note "walk between these"]');
    console.error('       --list    --clear');
    process.exit(2);
  }
  const roomNum = Number(flag('room', '587'));
  const klass = flag('klass', 'Torch');
  const note = flag('note', null);

  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const room = map.rooms[String(roomNum)];
  if (!room) { console.error('no room ' + roomNum + ' in the baked map'); process.exit(2); }
  const geometry = RoomGeometry.fromJSON(room.roo);

  const roomObj = await roomObject(roomNum);
  if (roomObj == null) { console.error('could not resolve room ' + roomNum); process.exit(1); }
  const made = await dm(ats.map(() => 'create object ' + klass));
  const ids = [...String(made).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
  const place = [];
  ats.forEach((a, i) => {
    if (ids[i] == null) return;
    const { row, col } = clampSquare(a.row, a.col, geometry.rows, geometry.cols);
    place.push(relocateCmd(ids[i], roomObj, row, col));
  });
  const placed = await dm(place);
  const refused = [...rejections(made), ...rejections(placed)];

  ats.forEach((a, i) => {
    if (ids[i] == null) return;
    book.pings.push({ id: ids[i], room: roomNum, col: a.col, row: a.row, klass, note });
  });
  save(book);

  console.log('dropped ' + ids.length + ' ' + klass + '(s) in room ' + roomNum + ':');
  ats.forEach((a, i) => {
    // Say plainly whether the marker could land where it was asked to. UtilGoNearSquare
    // searches outward and never refuses, so a ping on a square with no floor under its
    // centre lands NEXT to it — which for this particular investigation is the answer
    // rather than a defect.
    const K = 64, C = 1024, S = C / K, ctr = s => (s * K + (K >> 1) - K) * S;
    const solid = !!geometry.leafAtClient(ctr(a.col), ctr(a.row));
    console.log('  ' + a.col + ',' + a.row + '  object ' + (ids[i] ?? '?') +
                (solid ? '' : '   (no floor under this centre — it will sit BESIDE the square)'));
  });
  if (refused.length) console.log('  refused: ' + refused.slice(0, 2).join('; '));
  console.log('\n  node tools/m59-ping.mjs --clear   removes them again');
}
