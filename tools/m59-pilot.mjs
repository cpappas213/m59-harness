#!/usr/bin/env node
// Drive the Meridian client from outside it, through the injected agent.
//
//   node tools/m59-pilot.mjs pos
//   node tools/m59-pilot.mjs goto 34 25            one square, this room
//   node tools/m59-pilot.mjs travel "The Crypt"    across rooms
//
// Requires tools/m59-inject.ps1 to have put m59agent.dll into the client; it listens
// on 127.0.0.1:8913 and speaks `pos` / `act N` / `hold N MS`.
//
// WHAT MOVES, AND WHAT DECIDES
//
// We never send a position. We send the same actions a keypress would produce, and
// the CLIENT decides where that puts it — its own collision, its own speed, its own
// animation, and it tells the server itself. That is the whole reason this exists:
// every earlier design had us computing a coordinate and asserting it, and an
// asserted coordinate is one the client can disagree with. Forged positions crashed
// it outright (GetFloorBase indexing a room grid with a square from another room),
// and injected positions desynced silently when the server dropped them.
//
// So the loop here is: read where it actually is, work out what to press, press it,
// read again. Nothing is assumed to have worked.
//
// The geometry still matters, but only for choosing WHERE to go. Steering straight at
// a distant square walks into walls, so A* over the room's real walkability grid
// supplies waypoints, and the client handles the last few inches.
import net from 'node:net';
import { loadMap, findPath, resolveRoom, exitsOf, LEAVE_NAME } from './m59-map.mjs';
import { RoomGeometry } from './m59-roo.mjs';

// One agent per client, each on its own port. The DLL claims the first free one in
// this range, so the range IS the roster — sweeping it is how a controller finds
// which characters are running without anything having to register anywhere.
const PORT_BASE = 8913, PORT_COUNT = 16;
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const PORT = Number(flag('--port', PORT_BASE));

// Action codes, counted off the enum in clientd3d/intrface.h:60-93. They live here
// rather than in the DLL so that a miscount is a one-line fix and not a rebuild.
const A = {
  GO: 15, FORWARD: 31, BACKWARD: 32, SLIDELEFT: 33, SLIDERIGHT: 34,
  FORWARDFAST: 39, TURNLEFT: 47, TURNRIGHT: 48,
};

const FINENESS = 1024;          // client units per square
const ANGLES   = 4096;          // a full turn

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the agent

// One connection, held open, one command in flight at a time. The DLL handles a
// single command per recv, so pipelining would silently drop everything after the
// first — the queue is not an optimisation, it is the protocol.
class Agent {
  constructor(port = PORT) { this.port = port; this.queue = Promise.resolve(); }

  async connect() {
    this.sock = net.connect(this.port, '127.0.0.1');
    this.buf = '';
    this.waiters = [];
    this.sock.setEncoding('utf8');
    this.sock.on('data', d => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf('\n')) >= 0; ) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    await new Promise((res, rej) => {
      this.sock.once('connect', res);
      this.sock.once('error', e => rej(new Error(
        `no agent on 127.0.0.1:${this.port} — run: powershell -File tools/m59-inject.ps1  (${e.code})`)));
    });
  }

  cmd(line) {
    // Serialise: each send waits for the previous reply.
    const run = async () => {
      const reply = new Promise(res => this.waiters.push(res));
      this.sock.write(line + '\n');
      const raw = await reply;
      try { return JSON.parse(raw); } catch { return { error: raw }; }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  pos()            { return this.cmd('pos'); }
  act(n)           { return this.cmd(`act ${n}`); }
  hold(n, ms)      { return this.cmd(`hold ${n} ${Math.max(25, Math.round(ms))}`); }
  close()          { this.sock?.end(); }
}

// ---------------------------------------------------------------- geometry

const map = loadMap();
const byObjId = new Map(Object.values(map.rooms).map(r => [r.objId, r]));

function roomOf(objId) {
  const r = byObjId.get(objId);
  if (!r) throw new Error(
    `room object ${objId} is not in substrate/m59-map.json — object ids are renumbered ` +
    `by every "save game". Rebuild with: node tools/m59-map.mjs build`);
  return r;
}
const geometryOf = room => RoomGeometry.fromJSON(room.roo);

// Server rows/cols are 1-based; the client puts square (1,1) at 0..1023.
const centreOf = (row, col) => ({ x: (col - 1) * FINENESS + 512, y: (row - 1) * FINENESS + 512 });

// Shortest signed difference between two angles, in client units.
function angleDiff(want, have) {
  let d = (want - have) % ANGLES;
  if (d > ANGLES / 2) d -= ANGLES;
  if (d < -ANGLES / 2) d += ANGLES;
  return d;
}

// Angle 0 lies along +x and increases toward +y — moveobj.c's turnToFace maps
// (dx>0, dy>0) to the first eighth. Checked against a live client: at angle 833
// (73 degrees) walking forward moved dx=+644, dy=+2416, a bearing of 75 degrees.
const bearing = (dx, dy) => ((Math.atan2(dy, dx) / (2 * Math.PI) * ANGLES) + ANGLES) % ANGLES;

// THE WALLS ARE IN THE BAKE, IN THE SAME UNITS AS THE PLAYER.
//
// Both grids are one byte per square, and a wall does not respect square boundaries:
// it cuts across them at an arbitrary angle. Routing on squares therefore aims the
// character at places it cannot reach in a straight line, and what that looks like
// from the outside is a bot walking into a wall and grinding along it — which is
// exactly what it does, because the client slides along a wall rather than stopping.
//
// Measured, to rule out the alternative: where the character moved freely, its travel
// direction matched player.angle to within a couple of degrees. Where it did not, the
// actual direction was exactly 180.0 or 270.0 degrees - axis-aligned, i.e. sliding.
// So the facing arithmetic was never wrong; the waypoints were.
//
// room.roo.walls holds the real segments as [x0, y0, x1, y1, flags] in CLIENT
// FINENESS units - the same space as player.x/y - with bit 0 of flags meaning
// passable (m59-roo.mjs toJSON). Testing a step against those is what the client
// itself is doing.
const wallCache = new WeakMap();
function blockingWalls(room) {
  let w = wallCache.get(room);
  if (!w) {
    w = (room.roo.walls ?? []).filter(seg => !(seg[4] & 1));   // drop passable ones
    wallCache.set(room, w);
  }
  return w;
}

// Standard orientation test. Touching endpoints count as crossing, which is the
// conservative choice: clipping a wall corner is what makes the client slide.
function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function wallBetween(walls, x0, y0, x1, y1) {
  for (const s of walls)
    if (segmentsCross(x0, y0, x1, y1, s[0], s[1], s[2], s[3])) return true;
  return false;
}

// THE MOVE GRID IS A PREFERENCE, NOT A VETO.
//
// Two failures, opposite in kind, and both real:
//
//   Treat the .roo move grid as binding, and A* refuses routes that plainly work.
//   Standing at (6,9) in the Yonder Inn its mask offers no way south, and the square
//   west of it no way west, so a square seven steps across an open room came back as
//   "no route" while the client walked through there quite happily.
//
//   Ignore it and route on floor alone, and A* plots straight through the bar counter
//   in the Limping Toad — which the client will not cross, so the character grinds
//   against it until the stuck detector gives up.
//
// The grid is right about the counter and wrong about the corridor, and there is no
// way to tell which from the data. So weight rather than filter: a step the grid
// allows costs 1, a step it forbids costs BLOCKED_COST. Routes that respect the
// geometry win whenever one exists, and where the grid is wrong the path is merely
// expensive instead of impossible. The client is still the authority — it does the
// real collision check — and the closed loop re-plans from wherever it ends up.
const BLOCKED_COST = 12;

//
// `blocked` is what the run has LEARNED. Neither grid records room objects, and a
// bar counter is an object with MOVEON_NO, not architecture — so the geometry can be
// entirely correct and the character still cannot walk the line. Squares proved
// impassable by walking into them go in here and the next plan routes around them.
function pathOverFloor(geo, fromRow, fromCol, toRow, toCol, blocked = null, walls = null) {
  if (!geo.inBounds(toRow, toCol) || !geo.walkable(toRow, toCol))
    return { found: false, reason: `goal (row ${toRow}, col ${toCol}) has no floor` };
  if (!geo.walkable(fromRow, fromCol))
    return { found: false, reason: 'standing on a square the geometry calls solid' };
  if (fromRow === toRow && fromCol === toCol) return { found: true, steps: [] };

  const key = (r, c) => (r - 1) * geo.cols + (c - 1);
  const h = (r, c) => Math.max(Math.abs(r - toRow), Math.abs(c - toCol));
  const g = new Map([[key(fromRow, fromCol), 0]]);
  const came = new Map();
  const open = [{ r: fromRow, c: fromCol, f: h(fromRow, fromCol) }];

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.r === toRow && cur.c === toCol) {
      const steps = [];
      let k = key(cur.r, cur.c), rr = cur.r, cc = cur.c;
      while (came.has(k)) {
        steps.push({ row: rr, col: cc });
        const prev = came.get(k); rr = prev.r; cc = prev.c; k = key(rr, cc);
      }
      return { found: true, steps: steps.reverse() };
    }
    const base = g.get(key(cur.r, cur.c));
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = cur.r + dr, c = cur.c + dc;
      if (!geo.inBounds(r, c) || !geo.walkable(r, c)) continue;
      if (blocked && blocked.has(`${r},${c}`)) continue;
      // No corner-cutting: a diagonal needs both orthogonals open, or the client
      // catches on the corner and the stuck detector fires instead.
      if (dr && dc && (!geo.walkable(cur.r, c) || !geo.walkable(r, cur.c))) continue;
      // A real wall segment across the step is a hard no — that is the client's own
      // test. The move grid stays advisory underneath it, since it also encodes
      // things the wall list does not (and gets some of them wrong).
      if (walls) {
        const a = centreOf(cur.r, cur.c), b2 = centreOf(r, c);
        if (wallBetween(walls, a.x, a.y, b2.x, b2.y)) continue;
      }
      const allowed = geo.canMove(cur.r, cur.c, r, c);
      const cost = base + (dr && dc ? 1.414 : 1) * (allowed ? 1 : BLOCKED_COST);
      const k = key(r, c);
      if (g.has(k) && g.get(k) <= cost) continue;
      g.set(k, cost); came.set(k, { r: cur.r, c: cur.c });
      open.push({ r, c, f: cost + h(r, c) });
    }
  }
  return { found: false, reason: 'no floor route between those squares' };
}

// Is the straight line between two squares clear? Sampled at a third of a square,
// which is fine enough to catch a wall and coarse enough to stay cheap. Used only to
// drop waypoints A* emitted that we do not actually need to visit.
// Smoothing has to be STRICTER than routing, not looser. Routing may cross a
// grid-forbidden step under protest, because the grid is sometimes wrong; smoothing
// exists only to delete waypoints, and deleting one that was routing around the bar
// counter puts the straight line back through it. So here the grid is binding.
function clearLine(geo, r0, c0, r1, c1, walls = null) {
  // The wall segments decide it when we have them: that is the same straight line
  // the character is about to walk, tested against the same geometry the client
  // collides with.
  if (walls) {
    const a = centreOf(r0, c0), b = centreOf(r1, c1);
    if (wallBetween(walls, a.x, a.y, b.x, b.y)) return false;
  }
  const dr = r1 - r0, dc = c1 - c0;
  const steps = Math.ceil(Math.max(Math.abs(dr), Math.abs(dc)) * 3);
  let pr = r0, pc = c0;
  for (let i = 0; i <= steps; i++) {
    const r = Math.round(r0 + dr * i / steps), c = Math.round(c0 + dc * i / steps);
    if (!geo.walkable(r, c)) return false;
    if (!walls && (r !== pr || c !== pc) && !geo.canMove(pr, pc, r, c)) return false;
    pr = r; pc = c;
  }
  return true;
}

// A* returns every square; walking them one at a time means turning at every square,
// which looks absurd and is slow. Keep only the corners: the farthest point still in
// clear line of sight.
function smooth(geo, from, steps, walls = null) {
  const pts = [from, ...steps.map(s => ({ row: s.row, col: s.col }))];
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clearLine(geo, pts[i].row, pts[i].col, pts[j].row, pts[j].col, walls)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- steering

// Which action increases the angle, and how fast — both measured rather than assumed.
// The bindings file calls them left and right, but which way the number moves is a
// property of the client, and the turn rate is needed to size a correction. One small
// turn at startup answers both, and costs less than getting either wrong.
const turn = { up: A.TURNRIGHT, down: A.TURNLEFT, rate: 1.9, done: false };

async function calibrateTurn(agent, log) {
  const a0 = (await agent.pos()).angle;
  const ms = 200;
  await agent.hold(A.TURNRIGHT, ms);
  const a1 = (await agent.pos()).angle;
  const d = angleDiff(a1, a0);
  if (d === 0) throw new Error('the client did not turn — is it in game and not in a dialog?');
  if (d < 0) { turn.up = A.TURNLEFT; turn.down = A.TURNRIGHT; }
  turn.rate = Math.abs(d) / ms;                 // angle units per millisecond
  turn.done = true;
  log(`  turn: ${turn.up === A.TURNRIGHT ? 'RIGHT' : 'LEFT'} increases the angle, ` +
      `${turn.rate.toFixed(2)} units/ms`);
}

const WALK_RATE = 2.6;    // client units per ms, measured; only sizes the hold

// Steer to one square, correcting from what the client reports rather than from what
// we asked for. `until` lets a caller stop early — leaving the room is a success for
// an edge exit and a surprise everywhere else.
async function steerTo(agent, row, col, { tol = 380, timeoutMs = 25000, until = null, log } = {}) {
  const { x: tx, y: ty } = centreOf(row, col);
  const deadline = Date.now() + timeoutMs;
  let lastDist = Infinity, stalls = 0;

  for (;;) {
    const p = await agent.pos();
    if (until) { const done = await until(p); if (done) return { p, why: 'until' }; }

    const dx = tx - p.x, dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= tol) return { p, why: 'arrived' };
    if (Date.now() > deadline) return { p, why: 'timeout', dist };

    const err = angleDiff(bearing(dx, dy), p.angle);
    let walked = false;
    if (Math.abs(err) > 140) {
      if (!turn.done) await calibrateTurn(agent, log);
      // Measured turn rates run around 0.56 units/ms, so a half turn is over three
      // seconds. The cap keeps each correction closed-loop without making a big turn
      // take dozens of round trips.
      const ms = Math.min(700, Math.max(30, Math.abs(err) / turn.rate));
      await agent.hold(Math.sign(err) > 0 ? turn.up : turn.down, ms);
    } else {
      await agent.hold(A.FORWARD, Math.min(600, Math.max(60, dist / WALK_RATE)));
      walked = true;
    }

    // The client refuses to walk through its own walls, so a distance that stops
    // falling means something is there that the grid did not predict.
    //
    // ONLY COUNT ITERATIONS THAT TRIED TO WALK. Turning does not close distance and
    // never will, so counting those rounds as stalls declared "stuck" in the middle
    // of a perfectly good turn — at the measured rate a half turn is ten holds, and
    // the threshold was six.
    if (walked) {
      if (Math.abs(lastDist - dist) < 40) stalls++; else stalls = 0;
      if (stalls >= 6) return { p, why: 'stuck', dist };
      lastDist = dist;
    }
  }
}

// RE-PLAN FROM WHERE IT ACTUALLY IS, NOT FROM WHERE THE PLAN SAID.
//
// Walking a fixed list of waypoints assumes the geometry is right about every square,
// and it is not: the floor grid does not carry the wall SEGMENTS the client collides
// against, so a line that looks open can stop the character halfway along it. Once
// that happens a fixed plan has nowhere to go — it keeps steering at a waypoint it
// cannot reach and reports "stuck" from a position the plan never anticipated.
//
// So plan, walk a little, look, plan again. The client's reported position is the
// only input, which means sliding along a wall or being shoved by a teleporter is
// simply the next starting point rather than a failure. Smoothing still cuts the
// corners, but only as far as the next corner, so there is always something to
// re-plan from.
async function walkTo(agent, geo, goalRow, goalCol, log, { tol = 420, maxRounds = 60, walls = null } = {}) {
  const blocked = new Set();
  let dead = 0;
  for (let round = 0; round < maxRounds; round++) {
    const p = await agent.pos();
    const { x: gx, y: gy } = centreOf(goalRow, goalCol);
    if (Math.hypot(gx - p.x, gy - p.y) <= tol) return p;

    const path = pathOverFloor(geo, p.row, p.col, goalRow, goalCol, blocked, walls);
    if (!path.found)
      throw new Error(`${path.reason}` +
        (blocked.size ? ` (after learning ${blocked.size} blocked square(s) by walking into them)` : ''));
    if (!path.steps.length) return p;

    // The next corner, not the whole route: far enough to be worth walking, near
    // enough that a wrong guess costs one leg rather than the trip.
    const corner = smooth(geo, { row: p.row, col: p.col }, path.steps, walls)[0];
    const isGoal = corner.row === goalRow && corner.col === goalCol;
    const r = await steerTo(agent, corner.row, corner.col,
      { tol: isGoal ? tol : 620, timeoutMs: 15000, log });

    if (r.why === 'stuck' || r.why === 'timeout') {
      // Blame the square we were walking INTO, not the one we are standing on, and
      // remember it. Retrying the same line is what turned an unmapped bar counter
      // into a dead stop; routing around it is what a player does.
      const dr = Math.sign(corner.row - r.p.row), dc = Math.sign(corner.col - r.p.col);
      const br = r.p.row + dr, bc = r.p.col + dc;
      const blame = `${br},${bc}`;
      // THE GOAL SQUARE CAN BE THE BLOCKED ONE. A table, a barrel or another player
      // stands on it, and blaming it deletes the destination — the next plan then
      // reports "no floor route" for a walk that in fact just finished. Standing
      // beside an occupied square is arriving.
      if (br === goalRow && bc === goalCol) {
        log(`  row ${goalRow}, col ${goalCol} is occupied — stopping beside it`);
        return r.p;
      }
      if (dr || dc) {
        if (blocked.has(blame)) dead++; else { blocked.add(blame); dead = 0; }
        log(`  blocked at row ${r.p.row + dr}, col ${r.p.col + dc} — routing around it`);
      } else dead++;
      if (dead >= 3)
        throw new Error(`stuck at row ${r.p.row}, col ${r.p.col} heading for ` +
                        `row ${goalRow}, col ${goalCol} — no way around`);
    }
  }
  throw new Error(`gave up after ${maxRounds} planning rounds`);
}

// ---------------------------------------------------------------- commands

async function withAgent(fn) {
  const agent = new Agent();
  await agent.connect();
  try { return await fn(agent); } finally { agent.close(); }
}

const log = (...a) => console.log(...a);

async function cmdPos() {
  await withAgent(async agent => {
    const p = await agent.pos();
    const room = byObjId.get(p.room);
    log(JSON.stringify({ ...p, room_name: room?.name ?? null, room_num: room?.num ?? null }, null, 2));
  });
}

async function cmdGoto(row, col) {
  await withAgent(async agent => {
    const p = await agent.pos();
    const room = roomOf(p.room), geo = geometryOf(room);
    log(`${room.name}: row ${p.row}, col ${p.col} -> row ${row}, col ${col}`);
    // Pre-check only for a clean early error; walkTo re-plans on every round anyway.
    const walls = blockingWalls(room);
    const path = pathOverFloor(geo, p.row, p.col, row, col, null, walls);
    if (!path.found) throw new Error(path.reason);
    await walkTo(agent, geo, row, col, log, { walls });
    const q = await agent.pos();
    log(`arrived: row ${q.row}, col ${q.col}`);
  });
}

// STRANDED CHARACTERS, AND HOW THEY GET THAT WAY.
//
// The server does not check walls — ReqSomethingMoved is only ever called for
// monsters and dropped items, and its own comment says user moves "have already been
// checked by client (HAHA!)". So anything that moves a character server-side, an
// admin teleport or any of the earlier versions of this tooling, can put it somewhere
// the CLIENT will not let it walk out of. It is not stuck against a wall; it is on
// the wrong side of one, and no amount of steering will fix that.
//
// The way out is the pair: move server-side to a square that is open, then ask for
// the room. The room load carries our own object and SetRoomInfo re-reads position
// from it, so the client stops believing the old spot.
//
// Default target is the square with the most legal exits in the room, which is a
// decent proxy for "somewhere you can definitely walk out of".
async function cmdUnstick(row, col) {
  await withAgent(async agent => {
    const before = await agent.pos();
    const room = roomOf(before.room), geo = geometryOf(room);

    if (!row || !col) {
      let best = null;
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
        if (!geo.walkable(r, c)) continue;
        const n = geo.neighbors(r, c).length;
        if (!best || n > best.n) best = { r, c, n };
      }
      if (!best) throw new Error(`no walkable square in ${room.name}`);
      row = best.r; col = best.c;
    }

    log(`${room.name}: row ${before.row}, col ${before.col} -> row ${row}, col ${col}`);
    await agent.cmd(`move ${row} ${col}`);
    await sleep(600);
    await agent.cmd('refresh');
    await sleep(1200);

    const after = await agent.pos();
    if (after.row === row && after.col === col) log(`unstuck: row ${after.row}, col ${after.col}`);
    else log(`the client still reports row ${after.row}, col ${after.col} — the move or the ` +
             `refresh did not land`);
  });
}

async function cmdTravel(dest) {
  const to = resolveRoom(map, dest);
  if (to == null) throw new Error(`unknown room: ${dest}`);

  await withAgent(async agent => {
    let p = await agent.pos();
    let room = roomOf(p.room);
    const route = findPath(map, room.num, to);
    if (!route.found) throw new Error(route.reason);
    log(`${room.name} -> ${map.rooms[to].name}: ${route.hops.length} hop(s)`);

    for (const hop of route.hops) {
      const geo = geometryOf(room), walls = blockingWalls(room);
      p = await agent.pos();
      log(`${room.name} -> ${hop.toName} (${hop.kind})`);

      // The room the client reports IS the confirmation. player.room_id is set from
      // the room the server pushed on the transition, so watching it removes every
      // heuristic the packet-level version needed to guess an arrival.
      const arrived = async () => (await agent.pos()).room === map.rooms[hop.to].objId;

      if (hop.kind === 'go') {
        const path = pathOverFloor(geo, p.row, p.col, hop.row, hop.col, null, walls);
        if (!path.found) throw new Error(`no route to the exit at ${hop.row},${hop.col}: ${path.reason}`);
        await walkTo(agent, geo, hop.row, hop.col, log, { walls });
        // `go` is throttled with the rest of the action opcodes (5/second,
        // user.kod:50), and we have just spent that second walking.
        await sleep(1200);
        await agent.act(A.GO);
      } else {
        const t = edgeTarget(geo, hop.direction, p.row, p.col);
        if (!t) throw new Error(`no reachable square on the ${hop.direction} edge of ${room.name}`);
        await walkTo(agent, geo, t.row, t.col, log, { walls });
        // Then keep walking, off the edge. Leaving IS the arrival, so the room watch
        // is what ends it rather than reaching an unreachable square.
        const off = beyondEdge(geo, hop.direction, t.row, t.col);
        await steerTo(agent, off.row, off.col, { tol: 200, timeoutMs: 12000, until: arrived, log });
      }

      const ok = await waitFor(arrived, 9000);
      if (!ok) {
        const now = await agent.pos();
        throw new Error(`the client is still in room ${now.room}, not ${map.rooms[hop.to].objId} ` +
                        `(${hop.toName}) — stopping rather than walking on in the wrong room`);
      }
      room = map.rooms[hop.to];
      const q = await agent.pos();
      log(`  in ${room.name}, row ${q.row}, col ${q.col}\n`);
    }
    log(`arrived: ${room.name}`);
  });
}

async function waitFor(pred, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(350);
  }
}

// The nearest square on the named edge that A* can actually reach.
function edgeTarget(geo, direction, fromRow, fromCol) {
  const cands = [];
  if (direction === 'north') for (let c = 1; c <= geo.cols; c++) cands.push([1, c]);
  if (direction === 'south') for (let c = 1; c <= geo.cols; c++) cands.push([geo.rows, c]);
  if (direction === 'west')  for (let r = 1; r <= geo.rows; r++) cands.push([r, 1]);
  if (direction === 'east')  for (let r = 1; r <= geo.rows; r++) cands.push([r, geo.cols]);
  let best = null;
  for (const [r, c] of cands) {
    if (!geo.walkable(r, c)) continue;
    const p = geo.path(fromRow, fromCol, r, c);
    if (p.found && (!best || p.steps.length < best.steps.length))
      best = { row: r, col: c, steps: p.steps };
  }
  return best;
}

const beyondEdge = (geo, direction, row, col) =>
  direction === 'north' ? { row: 0, col } :
  direction === 'south' ? { row: geo.rows + 1, col } :
  direction === 'west'  ? { row, col: 0 } :
                          { row, col: geo.cols + 1 };

// ---------------------------------------------------------------- cli

// Every client that answers, and who is driving it. Sweeping beats registration:
// nothing has to be kept in sync, and a client that died simply stops replying.
async function cmdList() {
  const rows = await Promise.all(
    Array.from({ length: PORT_COUNT }, (_, i) => PORT_BASE + i).map(async port => {
      const a = new Agent(port);
      try {
        await a.connect();
        const p = await a.pos();
        a.close();
        const room = byObjId.get(p.room);
        return `  :${port}  pid ${String(p.pid).padEnd(6)} object ${String(p.id).padEnd(6)} ` +
               `row ${String(p.row).padStart(3)}, col ${String(p.col).padStart(3)}  ` +
               `${room?.name ?? `room object ${p.room}`}`;
      } catch { return null; }
    }));
  const live = rows.filter(Boolean);
  console.log(live.length ? live.join('\n') : 'no agents answering — run tools/m59-inject.ps1');
}

const [cmd, ...rest] = argv;
const usage = `usage:
  node tools/m59-pilot.mjs list                        every injected client
  node tools/m59-pilot.mjs [--port N] pos
  node tools/m59-pilot.mjs [--port N] goto <row> <col>
  node tools/m59-pilot.mjs [--port N] travel <room name or number>
  node tools/m59-pilot.mjs [--port N] stand | rest
  node tools/m59-pilot.mjs [--port N] say <text>
  node tools/m59-pilot.mjs [--port N] unstick [<row> <col>]`;

// Protocol actions go down the client's own connection, via ToServer inside the DLL —
// same socket, same security stream, no proxy. UC_* are from include/proto.h:220-230.
const UC = { REST: 5, STAND: 6 };

try {
  if (cmd === 'list') await cmdList();
  else if (cmd === 'stand') await withAgent(a => a.cmd(`usercmd ${UC.STAND}`));
  else if (cmd === 'rest')  await withAgent(a => a.cmd(`usercmd ${UC.REST}`));
  else if (cmd === 'say')   await withAgent(a => a.cmd(`say ${rest.join(' ')}`));
  else if (cmd === 'unstick') await cmdUnstick(Number(rest[0]) || 0, Number(rest[1]) || 0);
  else if (cmd === 'pos') await cmdPos();
  else if (cmd === 'goto') {
    if (rest.length < 2) throw new Error(usage);
    await cmdGoto(Number(rest[0]), Number(rest[1]));
  } else if (cmd === 'travel') {
    if (!rest.length) throw new Error(usage);
    await cmdTravel(rest.join(' '));
  } else console.error(usage);
} catch (e) {
  console.error(`pilot: ${e.message}`);
  process.exit(1);
}
