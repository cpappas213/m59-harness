#!/usr/bin/env node
// DOES THE SERVER AGREE THAT YOU CAN STAND ON THE SQUARE WE AIM EVERY WALK AT?
//
//   node tools/m59-anchorprobe.mjs --who Uuuu            every baked anchor, every room
//   node tools/m59-anchorprobe.mjs --who Uuuu --room 597
//   node tools/m59-anchorprobe.mjs --report              re-read the last run, no server
//
// LOOPBACK ONLY. It drives `UtilGoNearSquare` over the maintenance socket, which is
// unauthenticated and IP-restricted, and it MOVES the character it is given a hundred
// times a minute. Never point it at a fleet anybody is playing.
//
// WHY THIS EXISTS. `exitAnchors` bakes ONE staging square per exit and `m59-world.mjs`
// ranks it first, so every character leaving a room by a given door walks to the same
// square. That is a monorail, and the terminus has never been checked against the server.
// Our own geometry says whether a square is walkable; this asks the SERVER, which is the
// only opinion that decides where a character actually ends up.
//
// THE MEASUREMENT IS THE DISPLACEMENT, NOT THE RETURN VALUE. `UtilGoNearSquare` never says
// no: handed a square it will not stand you on, it searches OUTWARD until it finds one it
// will, puts you there, and returns 1. So asking it to place a character and reading the
// reply proves nothing at all. The only evidence is reading the character's own row and
// col back afterwards and comparing. A displacement of zero is agreement; anything else is
// the server telling us our anchor is not a place a body can be.
//
// That distinction is not hypothetical here. `m59-dm.mjs relocate --verify` reports the
// square it ASKED for, having checked only that the character is in the right room — so it
// reported success while putting a character 21 rows away, and the whole point of this file
// is that nobody notices that until they read the coordinates back.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dm, resolve as dmResolve, relocateCmd, roomObject, isLoopbackHost,
         adminTarget } from './m59-dm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TABLE = join(REPO, 'substrate', 'm59-routes.json');
const OUT   = join(REPO, 'substrate', 'anchor-probe.json');

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// ---------------------------------------------------------------- read the character back
//
// `show object <id>` is the server's own view of its own properties, and piRow/piCol are
// what every distance and reach check in the game reads. Nothing else is evidence.
async function positionOf(objId) {
  const out = await dm([`show object ${objId}`], { timeoutMs: 30000 });
  const row = /piRow\s+=\s+INT\s+(-?\d+)/.exec(String(out));
  const col = /piCol\s+=\s+INT\s+(-?\d+)/.exec(String(out));
  const own = /poOwner\s+=\s+OBJECT\s+(\d+)/.exec(String(out));
  return { row: row ? Number(row[1]) : null, col: col ? Number(col[1]) : null,
           room_object: own ? Number(own[1]) : null };
}

async function main() {
  if (argv.includes('--report')) return report();

  const who = arg('--who');
  if (!who) { console.error('--who <character> is required: it is the body this moves around'); return 2; }

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error(`REFUSING: the maintenance socket is ${target.host}, not loopback.`);
    return 2;
  }

  const t = JSON.parse(readFileSync(TABLE, 'utf8'));
  const onlyRoom = arg('--room') ? Number(arg('--room')) : null;

  const ids = await dmResolve([who]);
  const objId = ids[who];
  if (objId == null) { console.error(`no character called "${who}" on the server`); return 1; }
  const home = await positionOf(objId);
  console.log(`probing with ${who} (object ${objId}), starting in room object ${home.room_object}\n`);

  const rows = [];
  const roomNums = Object.keys(t.rooms)
    .map(Number).filter(n => onlyRoom == null || n === onlyRoom).sort((a, b) => a - b);

  for (const num of roomNums) {
    const r = t.rooms[num] ?? t.rooms[String(num)];
    const anchors = r?.anchors ?? [];
    if (!anchors.length) continue;
    // The ROOM OBJECT, not the room number: the server counts objects and the harness
    // counts rooms, and `poOwner` above is an object id on both sides.
    let roomObj = null;
    try { roomObj = await roomObject(num); } catch { /* reported below */ }
    if (roomObj == null) {
      rows.push({ room: num, anchor: null, why: 'could not resolve the room object' });
      continue;
    }
    for (const a of anchors) {
      // Place, then READ BACK, IN ONE BATCH. The reply to the placement is worthless —
      // it is 1 whether or not we ended up where we asked — so the read is the whole
      // measurement, and it has to follow the write on the same socket or the pacing
      // dominates: 1300 anchors at two round trips each is most of an hour, and at one
      // batch each it is minutes. The socket needs no pacing; that is measured.
      const out = await dm([relocateCmd(objId, roomObj, a.row, a.col),
                            `show object ${objId}`], { timeoutMs: 30000 });
      const s = String(out);
      const mr = /piRow\s+=\s+INT\s+(-?\d+)/.exec(s), mc = /piCol\s+=\s+INT\s+(-?\d+)/.exec(s);
      const mo = /poOwner\s+=\s+OBJECT\s+(\d+)/.exec(s);
      const at = { row: mr ? Number(mr[1]) : null, col: mc ? Number(mc[1]) : null,
                   room_object: mo ? Number(mo[1]) : null };
      const landedHere = at.room_object === roomObj;
      const dr = landedHere && at.row != null ? at.row - a.row : null;
      const dc = landedHere && at.col != null ? at.col - a.col : null;
      const dist = dr == null ? null : Math.max(Math.abs(dr), Math.abs(dc));
      rows.push({ room: num, kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                  want: { row: a.row, col: a.col },
                  got: landedHere ? { row: at.row, col: at.col } : null,
                  wrong_room: !landedHere, displaced: dist,
                  region: a.region ?? null, from_body: a.from_body ?? null });
      if (dist !== 0)
        console.log(`  ${String(num).padStart(4)} ${String(a.kind).padEnd(5)} ` +
          `${String(a.dir ?? '').padEnd(6)}-> ${String(a.to).padEnd(5)} ` +
          `want ${a.col},${a.row}`.padEnd(16) +
          (landedHere ? ` got ${at.col},${at.row}  displaced ${dist}` : ' LANDED IN ANOTHER ROOM'));
    }
    if (roomNums.length > 1 && num % 25 === 0) console.log(`  ... through room ${num}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    _what: 'Every baked exit anchor, placed on the live loopback server and read back. ' +
           '`displaced` is the Chebyshev distance between the square we aim walks at and ' +
           'the square the server actually stands a body on. Zero is agreement.',
    probed_at: new Date().toISOString(), character: who, rows,
  }, null, 2));
  console.log(`\nwrote ${OUT}`);
  return summarise(rows);
}

function summarise(rows) {
  const usable = rows.filter(r => r.anchor !== null && !r.why);
  const agree = usable.filter(r => r.displaced === 0);
  const moved = usable.filter(r => r.displaced != null && r.displaced > 0);
  const wrong = usable.filter(r => r.wrong_room);
  console.log(`\n${usable.length} anchor(s) probed`);
  console.log(`  ${agree.length} the server stands a body on exactly`);
  console.log(`  ${moved.length} the server MOVED us off, by up to ` +
              `${moved.reduce((m, r) => Math.max(m, r.displaced), 0)} square(s)`);
  if (wrong.length) console.log(`  ${wrong.length} put us in a different room entirely`);
  const bad = moved.slice().sort((a, b) => b.displaced - a.displaced).slice(0, 15);
  if (bad.length) {
    console.log('\nworst first — these are squares every walk to that exit aims at:');
    for (const r of bad)
      console.log(`  room ${String(r.room).padStart(4)} ${String(r.dir ?? r.kind).padEnd(6)} ` +
        `-> ${String(r.to).padEnd(5)} want ${r.want.col},${r.want.row}` +
        `  got ${r.got ? r.got.col + ',' + r.got.row : '?'}  displaced ${r.displaced}`);
  }
  return moved.length ? 1 : 0;
}

function report() {
  const j = JSON.parse(readFileSync(OUT, 'utf8'));
  console.log(`probe of ${j.probed_at} with ${j.character}`);
  return summarise(j.rows);
}

main().then(c => process.exit(c || 0), e => { console.error(e.message); process.exit(1); });
