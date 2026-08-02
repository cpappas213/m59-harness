#!/usr/bin/env node
// Walk a character that is connected through m59-proxy, over the real room
// geometry, to another room.
//
//   node tools/m59-drive.mjs --to "The Crypt"
//   node tools/m59-drive.mjs --to 71 --control 8910 --player 4551
//
// WHY THIS IS A SEPARATE TOOL AND NOT PART OF THE PROXY
//
// The proxy is the thing holding a live human's connection. Every change to it costs
// a restart and therefore a disconnect, so routing logic — the part that actually
// needs iterating — lives out here where it can be rewritten while somebody is
// playing. The proxy stays dumb: it moves one square and forges one packet.
//
// WHERE THE FACTS COME FROM
//
// Only two sources, both of which work against an unmodified server:
//   - the control channel's /status, whose room and position were learned from the
//     player's own BP_REQ_MOVE packets
//   - substrate/m59-map.json, for geometry and the room graph
//
// The admin socket is deliberately NOT used. It was useful for diagnosing whether a
// bug was in the parsing or the injection, but it is a fork-only, loopback-only
// control plane, and nothing on the driving path should depend on it.
import { loadMap, findPath, resolveRoom, exitsOf, LEAVE, LEAVE_NAME } from './m59-map.mjs';

// exitsOf() and inferredExits() both normalise an edge exit to a DIRECTION NAME
// ('west'), not the numeric LEAVE_* the room record carries. Reading `leave` off a
// hop gets undefined, and the failure is a confusing one — "no reachable square on
// the undefined edge" — because it surfaces as a pathing problem rather than a
// missing field. Map the name back once, here.
const LEAVE_BY_NAME = Object.fromEntries(
  Object.entries(LEAVE_NAME).map(([n, name]) => [name, Number(n)]));
const leaveOf = hop => hop.leave ?? LEAVE_BY_NAME[hop.direction];
import { RoomGeometry } from './m59-roo.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CONTROL = Number(arg('--control', 8910));
const PLAYER  = arg('--player') ? Number(arg('--player')) : null;
const PACE    = Number(arg('--pace', 260));       // ms between squares
const DRY     = process.argv.includes('--dry');

// SAFE MODE, FOR WHEN A HUMAN IS WATCHING.
//
// Forging BP_MOVE is what makes a driven walk visible: the server never tells the
// mover it moved, so without it the spectator sees nothing until the next room. But
// every forged packet is a coordinate WE chose being fed to the client's
// GetFloorBase(x, y), which indexes the current room's floor grid — and the client
// takes an access violation on anything that room cannot contain
// (Meridian.exe+0x27fd5, reading a fixed 0x994000, reproduced across three dumps).
//
// With --no-forge we drive the server only. Room changes still show up, because a
// transition is one of the few things the server does push to the mover, complete
// with a fresh room. In-room walking becomes invisible — the spectator sees a jump
// at each doorway rather than a walk — and in exchange the client is only ever
// rendering coordinates the server sent it.
const NO_FORGE = process.argv.includes('--no-forge');

const qs = PLAYER ? `?player=${PLAYER}` : '';
// EVERYTHING EXCEPT /status IS A POST.
//
// This used to fall back to a GET whenever there was no body, which quietly turned
// the one call that takes no arguments — /go — into a 405 the driver never looked
// at. So `go` was never once sent: the character walked the whole way to the exit
// square and stopped there, and every symptom pointed at the exit being wrong.
// The tell was arithmetic: `injected` came to exactly the number of walk steps,
// with nothing left over for the go.
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${CONTROL}${path}${qs}`,
    path === '/status' ? {} : { method: 'POST', body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

// A square is KOD_FINENESS = 64 fine units, and the wire value carries a further
// + KOD_FINENESS. Verified against a live character: row 37 <-> y 2400 = 37*64 + 32.
// Centring on +32 keeps us mid-square, which is where a real client sits.
const SQUARE = 64;
const toWire = (row, col) => ({ y: row * SQUARE + 32, x: col * SQUARE + 32 });
const toGrid = (y, x) => ({ row: Math.floor(y / SQUARE), col: Math.floor(x / SQUARE) });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// WAIT FOR THE SERVER TO AGREE BEFORE WALKING ANY FURTHER.
//
// A hop either worked or it did not, and until this existed there was no way to
// tell: the driver asserted the destination and carried on, so a failed transition
// meant every later step was injected against the wrong room — silently dropped,
// while the forged packets kept the screen looking convincing. `server_room` comes
// only from a BP_ROOM_CONTENTS the server actually sent, so it cannot be wishful.
// ASK, DO NOT WAIT TO BE TOLD.
//
// A room change does NOT push a BP_ROOM_CONTENTS. Traced across a live transition,
// the burst the server sends after BP_REQ_GO contains no opcode 134 anywhere — it
// carries op 191 and a crowd of per-object updates instead. Opcode 134 does arrive
// unprompted at login, which is what made passive listening look like it worked.
//
// So confirmation has to be requested: BP_SEND_ROOM_CONTENTS (42) is answered with a
// BP_ROOM_CONTENTS, which is the same path the broker's perception uses and the same
// parser that has been verified across 167 rooms. Polling is paced at ~1s because
// the request counts against INCOMING_PACKET_THROTTLE (5/second) and a tighter loop
// would get its own answers discarded.
// ...but opcode 134 is AMBIGUOUS once the client's modules are loaded. Captured off
// the wire, a 20-byte "134" reads
//     86 | 24 1c 00 00 | 61 42 0f 00 | 05 00 | "Osric" | 0d 02 00 00
// which is a player-name announcement, not a room. merintr and mailnews share the
// opcode space with the core protocol, so a request for room contents cannot be
// reliably matched to its answer by opcode alone, and the post-transition room data
// travels in op 191, still undecoded.
//
// So there are two grades of evidence and this returns which one it got. Strict:
// server_room, parsed from a message that checked out exactly. Provisional: the
// server answered BP_REQ_GO with a burst, and a burst of this size is what a room
// change looks like — 35 packets, against 1-2 for an ignored request. Provisional is
// reported as provisional; the caller does not get to mistake it for a fact.
// NEVER INJECT A QUERY INTO A SPECTATED SESSION.
//
// The obvious way to confirm is to ask: inject BP_SEND_ROOM_CONTENTS and read the
// answer. It does not work here, and the reason is structural rather than a bug. We
// are a passthrough server->client, so the ANSWER to anything we ask is delivered to
// the human's client as well — and their client never asked. An unsolicited reply
// gets routed to whichever loaded module is willing to take it, which in practice
// meant a buy panel and then a "Newsgroup: <Unknown>" window opening by themselves
// while somebody was trying to play.
//
// A query is therefore not read-only from the spectator's point of view. Confirmation
// has to be made of things the server was already going to send.
//
// What that leaves is the burst: BP_REQ_GO answers with ~35 packets when the room
// changes and 1-2 when it does not, so the size separates the two cleanly. It is
// evidence of A transition rather than proof of WHICH room, so it is reported as
// provisional and never as fact.
// A refused `go` is answered with essentially nothing; a room change is answered with
// a room's worth of objects. The gap is wide, but the burst's SIZE depends on how
// crowded the room is — 35 packets for a busy one, 19 for a room holding three
// objects — so a fixed threshold picked from one measurement gets the quiet rooms
// wrong. Wait for the burst to stop growing, then judge; 10 sits well clear of the
// 1-2 packets an ignored request produces.
const BURST_IS_A_ROOM_CHANGE = 10;

async function confirmRoom(objIdWanted, name, packetsBefore, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null, burst = 0, previous = -1, settled = 0;
  for (;;) {
    await sleep(600);
    last = await api('/status');
    burst = last.fromServer - packetsBefore;
    // If a genuine BP_ROOM_CONTENTS did land, take it — that is the strong answer.
    if (last.server_room === objIdWanted) return { st: last, how: 'confirmed by the server' };
    settled = burst === previous ? settled + 1 : 0;
    previous = burst;
    if (settled >= 2 || Date.now() > deadline) break;
  }
  if (burst >= BURST_IS_A_ROOM_CHANGE)
    return { st: last, how: `provisional, ${burst}-packet burst` };
  throw new Error(`no sign of arrival in ${name}: the server reported room ` +
                  `${last.server_room} and answered with only ${burst} packets — ` +
                  `too few to be a room change. Stopping rather than walking on.`);
}

const map = loadMap();
const byObjId = new Map(Object.values(map.rooms).map(r => [r.objId, r]));

function geometryOf(room) {
  if (!room?.roo) return null;
  return RoomGeometry.fromJSON(room.roo);
}

// Walk a computed path one square at a time. Each step is a /move, which is both an
// injected BP_REQ_MOVE to the server and a forged BP_MOVE back to the client, so the
// world and the player's own screen stay in agreement.
// NEVER FORGE WHILE THE HUMAN IS WALKING.
//
// Spectating and co-driving are the same connection, so both of us can be moving the
// same character at once — and we are not symmetric. The person at the keyboard moves
// the client, which tells the server; we move the server AND forge the client's view.
// Doing that mid-stride overwrites a position the client is interpolating from, and
// it crashed the client in practice.
//
// `human_driving` is a client-originated BP_REQ_MOVE within the last few seconds, and
// since we never make the client send, that is unambiguously the person. Yield to
// them: they are the one who can see the room.
async function yieldToHuman(maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  let announced = false;
  for (;;) {
    const st = await api('/status');
    if (!st.human_driving) return;
    if (!announced) { console.log('  (you are moving — holding off)'); announced = true; }
    if (Date.now() > deadline)
      throw new Error('you kept the controls for 30s; stopping rather than fighting you for them');
    await sleep(1000);
  }
}

async function walkSquares(steps, label) {
  for (const [i, s] of steps.entries()) {
    const { y, x } = toWire(s.row, s.col);
    if (DRY) { console.log(`  [dry] ${label} ${i + 1}/${steps.length} -> ${s.row},${s.col}`); continue; }
    await yieldToHuman();
    const r = await api('/move', NO_FORGE ? { y, x, forge: false } : { y, x });
    if (!r.ok) throw new Error(`step to ${s.row},${s.col} refused: ${r.why ?? JSON.stringify(r)}`);
    if (i % 5 === 0 || i === steps.length - 1)
      console.log(`  ${label} ${i + 1}/${steps.length} -> row ${s.row}, col ${s.col}`);
    await sleep(PACE);
  }
}

// Leaving by a room edge is a different action from using a door: you simply walk
// onto a square outside piRows/piCols and the server treats it as leaving. Which
// edge is in the exit record; the square to aim for is the nearest walkable one on
// that edge, because most of an edge is usually wall.
function edgeTarget(geo, leave, fromRow, fromCol) {
  const cands = [];
  if (leave === LEAVE.NORTH) for (let c = 1; c <= geo.cols; c++) cands.push([1, c]);
  if (leave === LEAVE.SOUTH) for (let c = 1; c <= geo.cols; c++) cands.push([geo.rows, c]);
  if (leave === LEAVE.WEST)  for (let r = 1; r <= geo.rows; r++) cands.push([r, 1]);
  if (leave === LEAVE.EAST)  for (let r = 1; r <= geo.rows; r++) cands.push([r, geo.cols]);
  let best = null;
  for (const [r, c] of cands) {
    if (!geo.walkable(r, c)) continue;
    const p = geo.path(fromRow, fromCol, r, c);
    if (!p.found) continue;
    if (!best || p.steps.length < best.steps.length) best = { row: r, col: c, steps: p.steps };
  }
  return best;
}

// One square beyond the edge, which is what actually triggers the transition.
const beyond = (leave, row, col, geo) =>
  leave === LEAVE.NORTH ? { row: 0, col } :
  leave === LEAVE.SOUTH ? { row: geo.rows + 1, col } :
  leave === LEAVE.WEST  ? { row, col: 0 } :
                          { row, col: geo.cols + 1 };

async function main() {
  const dest = resolveRoom(map, arg('--to'));
  if (dest == null) throw new Error(`unknown room: ${arg('--to')}`);

  const st = await api('/status');
  if (!st.in_game) throw new Error(`no session in game: ${JSON.stringify(st)}`);
  if (!st.last_move)
    throw new Error('the proxy has not seen this client move yet, so it does not know ' +
                    'the room or position. Take one step in the client and try again.');

  let room = byObjId.get(st.known_room);
  if (!room) throw new Error(`room object ${st.known_room} is not in the baked map — ` +
                             `object ids are renumbered by save game; rebuild with m59-map.mjs build`);
  let { row, col } = toGrid(st.last_move.y, st.last_move.x);
  console.log(`at ${room.name} (${room.num}) row ${row}, col ${col} — heading for ` +
              `${map.rooms[dest].name} (${dest})`);

  const route = findPath(map, room.num, dest);
  if (!route.found) throw new Error(route.reason);
  console.log(`${route.hops.length} hop(s): ${route.hops.map(h => h.toName).join(' -> ')}\n`);

  for (const hop of route.hops) {
    const geo = geometryOf(room);
    if (!geo) throw new Error(`no geometry for ${room.name}`);
    console.log(`${room.name} -> ${hop.toName}  (${hop.kind})`);

    let packetsBefore = 0;
    if (hop.kind === 'go') {
      // An interior exit is a square you stand on and then send BP_REQ_GO.
      const p = geo.path(row, col, hop.row, hop.col);
      if (!p.found) throw new Error(`no route to the exit at ${hop.row},${hop.col}: ${p.reason}`);
      await walkSquares(p.steps, 'walk');
      packetsBefore = DRY ? 0 : (await api('/status')).fromServer;
      if (!DRY) {
        // LET THE THROTTLE WINDOW CLEAR BEFORE THE GO.
        //
        // `go` is one of the actions the server drops silently past
        // INCOMING_PACKET_THROTTLE = 5 packets per second (user.kod:50, 881-885).
        // Arriving at the exit square means we have just spent that second's budget
        // walking, so a `go` sent immediately is discarded with no reply — the
        // character simply stands on the doorstep. That is exactly what happened:
        // Theron was found parked on (2,8), the exit square, still in the inn.
        await sleep(1300);
        await api('/go');
        await sleep(900);
      }
      console.log('  sent go');
    } else {
      const leave = leaveOf(hop);
      if (!leave) throw new Error(`hop to ${hop.toName} has no usable direction: ${JSON.stringify(hop)}`);
      const t = edgeTarget(geo, leave, row, col);
      if (!t) throw new Error(`no reachable square on the ${hop.direction} edge of ${room.name}`);
      await walkSquares(t.steps, 'walk');
      const off = beyond(leave, t.row, t.col, geo);
      if (!DRY) {
        // forge:false — this square is deliberately outside the room, which is what
        // makes it an exit. Handing it to the client would have it index its own
        // room grid out of bounds; the server's room-change burst moves the view.
        packetsBefore = (await api('/status')).fromServer;
        const { y, x } = toWire(off.row, off.col);
        await api('/move', { y, x, forge: false });
        await sleep(1100);
      }
      console.log(`  stepped off the ${hop.direction} edge`);
    }

    // ARRIVING SOMEWHERE THE PROXY CANNOT SEE.
    //
    // After a transition the proxy's idea of the room is stale: it only learns from
    // the player's own BP_REQ_MOVE, and a player being driven never sends one. The
    // map knows both the destination room object and the square you arrive on, so we
    // hand them over rather than guessing — /move accepts `room` and `at` for exactly
    // this. Injecting against a stale room id is silent (NEXT-STEPS trap 5), so this
    // is the difference between the next hop working and nothing happening at all.
    room = map.rooms[hop.to];
    row = hop.arriveRow ?? row; col = hop.arriveCol ?? col;
    if (!DRY) {
      const { st, how } = await confirmRoom(room.objId, room.name, packetsBefore);
      console.log(`  arrival: ${how}`);
      // The same BP_ROOM_CONTENTS that confirmed the room also carried our own object
      // and therefore our position, so by here the proxy already knows both from the
      // server. Read that rather than the map's idea of where this exit lands, and
      // seed only as a fallback — a seed we then read back would just be our own
      // assumption wearing a server's clothes.
      if (st.last_move) {
        ({ row, col } = toGrid(st.last_move.y, st.last_move.x));
      } else {
        const { y, x } = toWire(row, col);
        await api('/seed', { room: room.objId, at: { y, x } });
      }
      await sleep(400);
    }
    console.log(`  confirmed in ${room.name} (${room.num}) at row ${row}, col ${col}\n`);
  }
  console.log(`arrived: ${room.name}`);
}

main().catch(e => { console.error(`drive failed: ${e.message}`); process.exit(1); });
