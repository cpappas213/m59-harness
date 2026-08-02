#!/usr/bin/env node
// Does the room-object parser actually work? Not "does it produce plausible
// output" — a packed stream with no per-item length produces plausible output
// from a desynchronised cursor too. The only real test is the invariant the C
// client itself uses (HandleRoomContents, clientd3d/server.c:672):
//
//     after parsing `count` objects, exactly zero bytes must remain
//
// So: walk one logged-in agent through as many genuinely different rooms as the
// server has, request contents in each, and require the invariant everywhere.
// Rooms differ in exactly the ways that break this parser — monsters carry
// cycling animations and overlays, lit objects carry the dLighting block,
// stacked coins carry the CLIENT_TAG_NUMBER amount field — so breadth is the
// test, not depth.
//
//   node tools/m59-perception-test.mjs <user> <pass> [maxRooms]
//
// Teleporting is done over the admin socket (`NewHold`), which is a test
// affordance and not how an agent moves: it bypasses the geometry the server
// would otherwise validate. That is fine here — the point is to reach varied
// rooms cheaply, and the protocol client still perceives them as a player.

import net from 'node:net';
import { M59Client } from './m59-client.mjs';
import { describeObject } from './m59-parse.mjs';

const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);

// The shared admin helper in m59.mjs paces commands 400ms apart, which is right
// for interactive use and far too slow for a thousand probes. The maintenance
// socket is happy to be pipelined, so write everything and read until quiet.
function adminBatch(cmds, quietMs = 900, capMs = 120000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, HOST);
    let buf = '';
    let quiet, hard;
    const finish = () => { clearTimeout(quiet); clearTimeout(hard); s.destroy(); resolve(buf); };
    s.on('connect', () => {
      s.write(cmds.join('\r\n') + '\r\n');
      quiet = setTimeout(finish, quietMs);
      hard = setTimeout(finish, capMs);
    });
    s.on('data', d => {
      buf += d;
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    });
    s.on('error', e => { clearTimeout(quiet); clearTimeout(hard); reject(e); });
  });
}

// A room is any object that answers with piRoom_num. Scanning for that is
// cheaper than adding an admin command, and it needs no server rebuild — which
// matters, because a restart would renumber every object id (trap 3).
async function findRooms(from, to, chunk = 250) {
  const rooms = [];
  for (let base = from; base <= to; base += chunk) {
    const top = Math.min(base + chunk - 1, to);
    const cmds = [];
    for (let id = base; id <= top; id++) cmds.push(`show object ${id}`);
    const out = await adminBatch(cmds);
    // Replies are blocks headed by "OBJECT n is CLASS X"; split on that.
    const blocks = out.split(/(?=:?<? ?OBJECT \d+ is CLASS )/);
    for (const b of blocks) {
      const head = /OBJECT (\d+) is CLASS (\w+)/.exec(b);
      if (!head) continue;
      const num = /piRoom_num\s+= INT (-?\d+)/.exec(b);
      const rsc = /prRoom\s+= RESOURCE (\S+)/.exec(b);
      const rows = /piRows\s+= INT (\d+)/.exec(b);
      const cols = /piCols\s+= INT (\d+)/.exec(b);
      if (!num || !rsc) continue;
      rooms.push({ id: Number(head[1]), cls: head[2], roomNum: Number(num[1]),
                   rsc: rsc[1], rows: rows && Number(rows[1]), cols: cols && Number(cols[1]) });
    }
    process.stderr.write(`\r  scanned ${top}/${to}, found ${rooms.length} rooms`);
  }
  process.stderr.write('\n');
  return rooms;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const [user, pass, maxArg] = process.argv.slice(2);
if (!user || !pass) {
  console.error('usage: m59-perception-test.mjs <user> <pass> [maxRooms]');
  process.exit(1);
}
const maxRooms = Number(maxArg || 0) || Infinity;

console.log('scanning for room objects over the admin socket...');
const rooms = await findRooms(1, 1600);
console.log(`${rooms.length} rooms found\n`);

const c = new M59Client({ host: HOST, verbose: false });
await c.login(user, pass);
await sleep(1200);
console.log(`logged in as object ${c.selfId}, ${c.rsc.size} resources loaded\n`);

// Every room the parser is asked about, and what it said. A room that is empty
// of everything but us is a weak test, so those are counted separately — a run
// that only ever saw empty rooms has proved very little.
const results = [];
let totalObjects = 0, richRooms = 0;

// Sort so nearby ids (which tend to be thematically grouped) do not dominate the
// head of the run; a spread gives more variety earlier if the run is cut short.
const order = rooms.slice().sort((a, b) => (a.id * 7919) % 10007 - (b.id * 7919) % 10007);

for (const room of order.slice(0, maxRooms)) {
  if (room.id === c.room.id) { /* already here */ }
  else {
    // NewHold moves an object into a room. Row/col are 1-based kod squares;
    // the middle of the room is always inside it.
    const row = Math.max(1, Math.floor((room.rows || 4) / 2));
    const col = Math.max(1, Math.floor((room.cols || 4) / 2));
    await adminBatch([
      `send object ${room.id} NewHold what OBJECT ${c.selfId} new_row INT ${row} new_col INT ${col}`,
    ], 350);
  }

  const before = c.parseErrors.length;
  c.roomContents();
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });

  const failed = c.parseErrors.length > before;
  const objs = [...c.room.objects.values()];
  const others = objs.filter(o => o.id !== c.selfId);
  totalObjects += others.length;
  if (others.length >= 2) richRooms++;

  results.push({
    room: room.id, cls: room.cls, rsc: room.rsc,
    reported: c.room.id, count: objs.length, failed,
    why: failed ? c.parseErrors.at(-1).why : null,
    sample: others.slice(0, 4).map(o => describeObject(o, c.lookup)),
  });

  process.stderr.write(`\r  ${results.length}/${Math.min(order.length, maxRooms)} rooms probed, ` +
                       `${c.parseErrors.length} failures, ${totalObjects} objects seen`);
}
process.stderr.write('\n\n');

const bad = results.filter(r => r.failed);
const mismatched = results.filter(r => !r.failed && r.reported !== r.room);

console.log(`rooms probed:          ${results.length}`);
console.log(`objects parsed:        ${totalObjects}`);
console.log(`rooms with 2+ objects: ${richRooms}`);
console.log(`invariant failures:    ${bad.length}`);
console.log(`wrong room reported:   ${mismatched.length}`);

// Which distinct things did we actually name? A parser can hold the invariant on
// a hundred copies of one simple object and still be wrong about a hard one, so
// the variety of names seen is part of the evidence.
const namesSeen = new Set();
for (const r of results) for (const s of r.sample) namesSeen.add(s.replace(/ \(id \d+\).*/, ''));
console.log(`distinct things named: ${namesSeen.size}`);

console.log('\nrichest rooms:');
for (const r of results.filter(x => !x.failed).sort((a, b) => b.count - a.count).slice(0, 12)) {
  console.log(`  ${String(r.room).padStart(5)} ${r.rsc.padEnd(26)} ${String(r.count).padStart(3)} obj  ${r.sample.slice(0, 3).join(', ')}`);
}

if (bad.length) {
  console.log(`\nFAILURES:`);
  for (const r of bad.slice(0, 20)) console.log(`  room ${r.room} (${r.rsc}): ${r.why}`);
  process.exit(2);
}
if (mismatched.length) {
  console.log('\nROOM ID MISMATCHES (parser read a different room than we teleported to):');
  for (const r of mismatched.slice(0, 10)) console.log(`  asked ${r.room}, parsed ${r.reported}`);
}

console.log('\nthe end-of-payload invariant held in every room.');
process.exit(0);
