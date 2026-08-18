#!/usr/bin/env node
// THE WAY OUT OF A POCKET IS THE WAY IN, WALKED BACKWARDS — the contract test for the
// breadcrumb escape.
//
//   node tools/m59-breadcrumb-test.mjs
//
// Offline. The fault it exists against: a safe wall IS the coarse grid and the BSP
// disagreeing, the fleet seeks those squares out, and since the router plans on the
// collision view a character standing on one frequently cannot plan a route to its own
// room's exits. Room 587 is 68 regions with both exits in region 0; there are 17,402 such
// pockets world-wide. The character tries, is refused, replans, forever, and the board
// reports `travelling` while it twitches in a corner.
//
// The five properties, each of which is a way the escape could be wrong:
//
//   1. A CRUMB IS A MOVE THE VALIDATOR ACCEPTED, recorded at the one choke point every
//      move passes through, with the position the packet left from.
//   2. IT CANNOT INVENT AN IMPOSSIBLE TRAVERSAL. Every retreat step goes back through the
//      fine validator, so a refused reverse step stops the retreat rather than teleporting.
//      This is the whole safety argument for breadcrumbs over a coarse-grid escape hatch.
//   3. A BROKEN TRAIL IS DROPPED, NOT SKIPPED. A crumb that does not start where we are
//      standing means something else moved us; the ones below it are no better connected.
//   4. IT STOPS THE MOMENT THE ROUTE REAPPEARS. The goal is to leave the pocket, not to
//      undo the journey.
//   5. walkTo USES IT AND THEN RE-PLANS — and a genuine dead end still reports itself,
//      with the retreat named rather than swallowed.
import { readFileSync } from 'node:fs';
import { elideLoops } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

// BORROW THE REAL IMPLEMENTATION, NEVER A COPY — `m59-broker.mjs` cannot be imported,
// importing it takes the fleet lock and starts rejoin timers, so the methods are lifted
// out of the source by BRACE MATCHING.
const src = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
function lift(signature, name, deps = {}) {
  const start = src.indexOf('  ' + signature);
  ok(`the ${name} method was located`, start >= 0);
  const opening = src.indexOf(') {', start);
  let depth = 0, end = -1;
  for (let at = opening + 2; at < src.length; at++) {
    if (src[at] === '{') depth++;
    else if (src[at] === '}') { depth--; if (depth === 0) { end = at + 1; break; } }
  }
  const method = src.slice(start, end);
  ok(`${name} is a whole method`, method.trim().endsWith('}'));
  return new Function(...Object.keys(deps), `return ({${method}}).${name}`)(...Object.values(deps));
}

const KOD_FINENESS = 64;
const queueValidatedMove = lift('async queueValidatedMove(x, y, {', 'queueValidatedMove',
  { MOVE_INTERVAL_MS: 0, CLIENT_FINENESS: 1024, noteGeometryDrift() {} });
// THE REAL `elideLoops`, not a stand-in: the retreat now trims cycles out of the trail
// before replaying it, and a hand-written imitation here would be testing the imitation.
const retreatAlongBreadcrumbs = lift('async retreatAlongBreadcrumbs({', 'retreatAlongBreadcrumbs',
  { KOD_FINENESS, elideLoops });
// `provedSquares` turns a plan into the legs the string pull proved, so the coalescer can
// skip along them without tracing. These fixtures have no collision model at all, which is
// exactly the case where it must decline — so null here is the real answer, not a stub of
// one, and it keeps this suite testing the retreat rather than the pull.
const walkTo = lift('async walkTo(col, row, {', 'walkTo',
  { KOD_FINENESS, MOVE_HOP_MAX_SQUARES: 8, isTerminalMovementReason: () => false,
    provedSquares: () => null });

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a Session. Movement is on square centres;
// `legal` decides which fine endpoints the validator will accept, which is how a pocket
// with a one-way way in is expressed.
// ---------------------------------------------------------------------------
const half = KOD_FINENESS >> 1;
const fineOf = (col, row) => ({ x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half });
const sq = fine => ({ col: Math.floor(fine.x / KOD_FINENESS), row: Math.floor(fine.y / KOD_FINENESS) });

function fakeSession({ at = { col: 5, row: 5 }, roomId = 587, legal = () => true,
                       routable = () => true } = {}) {
  const start = fineOf(at.col, at.row);
  const self = { ...start, ...at };
  const packets = [];
  const client = {
    self,
    room: { id: roomId },
    moveTo(x, y) {
      packets.push({ x, y });
      Object.assign(self, { x, y, ...sq({ x, y }) });
    },
    predictSelf(next) { Object.assign(self, next); },
  };
  const found = (r, c) => routable({ row: r, col: c });
  const session = {
    client, packets,
    movementGeneration: 0,
    breadcrumbs: undefined,
    need() { return client; },
    movementWasCancelled() { return false; },
    cancelledMovement(extra) { return { cancelled: true, ...extra }; },
    threatsHere() { return null; },
    async stepFine() { return { moved: true }; },
    world: { geometry: {
      walkable: () => true,
      // walkTo asks `standable` now — the BSP question rather than the server grid's.
      // See RoomGeometry.standable. Modelled as true for the same reason `walkable` is:
      // this fixture is about the breadcrumb trail, not about floor.
      standable: () => true,
      nearestWalkable: () => null,
      // The router only ever offers a route out of a square it considers connected.
      path(fr, fc, tr, tc) {
        if (!found(fr, fc)) return { found: false, reason: 'no route', collision_view: true };
        const steps = [];
        let r = fr, c = fc;
        while (r !== tr || c !== tc) {
          r += Math.sign(tr - r); c += Math.sign(tc - c);
          steps.push({ row: r, col: c });
        }
        return { found: true, steps };
      },
    } },
    // Stands in for validateFineTarget: exact endpoints only, no sliding, so a refusal
    // is a refusal. `legal` is asked with both ends, which is how a one-way step is said.
    validateFineTarget(x, y) {
      const from = { x: self.x, y: self.y };
      if (!legal(sq(from), sq({ x, y })))
        return { available: true, moved: false, blocked: true, reason: 'geometry_blocked' };
      return { available: true, moved: true, blocked: false,
               target: { x: Math.round(x), y: Math.round(y) } };
    },
    pacer: { async submit(_kind, invoke) { return invoke(); } },
    async step(col, row) {
      const q = await queueValidatedMove.call(session, ...Object.values(fineOf(col, row)),
        { expectedRoomId: client.room.id });
      if (!q.sent) return { moved: false, reason: q.validation?.reason ?? 'geometry_blocked',
                            position: { ...sq(self) } };
      client.predictSelf({ ...q.target, ...sq(q.target) });
      return { moved: true, position: { ...sq(self) } };
    },
    queueValidatedMove, retreatAlongBreadcrumbs, walkTo,
  };
  return session;
}

const walk = async (s, cols) => { for (const c of cols) await s.step(c.col, c.row); };

// ---------------------------------------------------------------------------
console.log('a crumb is recorded for every accepted move, and names where it left from');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  ok('two moves, two crumbs', s.breadcrumbs.length === 2);
  ok('the first left the starting square', s.breadcrumbs[0].from.x === fineOf(5, 5).x);
  ok('and arrived at the second', s.breadcrumbs[0].to.x === fineOf(6, 5).x);
  ok('the trail is contiguous', s.breadcrumbs[0].to.x === s.breadcrumbs[1].from.x);
  ok('each crumb names its room', s.breadcrumbs.every(c => c.roomId === 587));
  ok('a refused move leaves no crumb', await (async () => {
    const t = fakeSession({ legal: () => false });
    await t.step(6, 5);
    return (t.breadcrumbs ?? []).length === 0;
  })());
}

// ---------------------------------------------------------------------------
console.log('the retreat undoes the trail in reverse, one accepted step at a time');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({});
  ok('it walked all three back', out.steps === 3);
  ok('and is standing where it started', s.client.self.col === 5 && s.client.self.row === 5);
  ok('the trail is spent rather than doubled back on', s.breadcrumbs.length === 0);
  ok('the retreat sent real, validated packets', s.packets.length === 6);
}

// ---------------------------------------------------------------------------
console.log('it cannot invent an impossible traversal — only undo one');
{
  // A one-way ledge: 5,5 -> 6,5 is legal, the reverse is not. This is the shape of the
  // thing the coarse-grid escape hatch was rejected for; the retreat must simply stop.
  const oneWay = (from, to) => !(from.col === 6 && to.col === 5);
  const s = fakeSession({ legal: oneWay });
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({});
  ok('it undid what it could', out.steps === 1);
  ok('and stopped at the step the validator refuses', s.client.self.col === 6);
  ok('reporting why rather than forcing it', out.reason === 'geometry_blocked');
  ok('every packet sent was one the validator accepted',
    s.packets.every(p => p.x !== fineOf(5, 5).x));
}

// ---------------------------------------------------------------------------
console.log('a broken trail is dropped whole, never skipped');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  // Something else moved us — a teleport, a knockback, a room change.
  s.client.predictSelf({ ...fineOf(20, 20), col: 20, row: 20 });
  const out = await s.retreatAlongBreadcrumbs({});
  ok('nothing was replayed', out.steps === 0);
  ok('and it says the trail is broken', out.reason === 'breadcrumb_trail_broken');
  ok('the disconnected crumbs are gone rather than left to mislead', s.breadcrumbs.length === 0);
  // The same rule at the recording end: a move that does not start where the last one
  // ended begins a new trail rather than extending a fiction.
  await s.step(21, 20);
  ok('a fresh trail starts after a jump', s.breadcrumbs.length === 1);
}

// ---------------------------------------------------------------------------
console.log('it stops the moment the route reappears — the goal is out, not undone');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({ until: () => s.client.self.col === 7 });
  ok('one step was enough', out.steps === 1);
  ok('and the rest of the trail is kept', out.crumbs_left === 2);
}

// ---------------------------------------------------------------------------
console.log('walkTo escapes the pocket and then plans from where it lands');
{
  // The pocket: 8,5 has no route anywhere. Everything else does. The character walks in
  // — which is exactly how a safe spot is taken — and then is asked to leave.
  const s = fakeSession({ routable: p => !(p.col === 8 && p.row === 5) });
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  ok('it really is cut off', s.world.geometry.path(5, 8, 5, 1).found === false);
  const r = await walkTo.call(s, 1, 5, {});
  ok('the walk still arrives', r.arrived === true);
  ok('at the square asked for', s.client.self.col === 1 && s.client.self.row === 5);
}

{
  // AND A GENUINE DEAD END STILL REPORTS ITSELF. Nothing is routable, so the retreat
  // cannot rescue the walk — it must say so rather than spin or claim success.
  const s = fakeSession({ routable: () => false });
  await walk(s, [{ col: 6, row: 5 }]);
  const r = await walkTo.call(s, 1, 5, {});
  ok('it does not claim to have arrived', r.arrived === false);
  ok('the retreat is named rather than swallowed', r.retreated >= 1);
  ok('and the note says the escape was tried', /breadcrumbs/.test(r.note ?? ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
