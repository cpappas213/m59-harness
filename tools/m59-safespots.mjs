// Where to stand so that nothing can hit you.
//
// Players call these "safe walls" and learn them by experiment and word of mouth.
// The mechanic, stated plainly by someone who uses them: in a working safe spot NO
// MONSTER CAN HIT YOU UNLESS YOU SWING AT IT FIRST. A monster can only retaliate
// while it is standing still — once it moves it cannot reach you again — so if you
// stop swinging, the damage stops. Fighting stops being something that happens to
// you and becomes something you choose, one exchange at a time.
//
// That single property is worth more than everything else in this file, because of
// what it does to the two worst moments in a fight:
//
//   LOSING      is no longer a race to walk out of reach while being hit. Stop
//               swinging, sit down, rest to full, and decide again from full health.
//               A fight you were going to lose becomes a draw you can re-take.
//   A SWARM     cannot pile onto you, because seven of the eight squares it needs to
//               stand on are wall — and the ones that do get in still cannot land a
//               blow unless you start it.
//
// The exact physics is finer than the movement grid — it lives in the BSP walls and
// probably the angles — and this module does NOT claim to reproduce it. It does two
// separate things, and the difference between them matters:
//
//   GUESSES  from the grid, which squares are likely to work: how many things can
//            stand next to you at once, and how much wall is at your back.
//   REMEMBERS which squares actually DID work, because a guess is a hypothesis and
//            standing in one under attack is the experiment. See SafeSpotBook.
//
// The guess alone is not a consolation prize. The fleet's deaths are overwhelmingly
// swarm deaths: every room a Qor character may hunt in is 50-75% baby spider, so it
// fights a centipede while three spiders it never chose surround it. A square with
// three open neighbours instead of eight cuts the number of things that can be
// hitting you at any moment by more than half, with no mechanic beyond geometry.
//
// The reference case: Varuka, standing untouched in a swarm at (25,23) of the Main
// Gate to the City of Tos. That square has five open neighbours — west, east and
// south — and the ENTIRE north arc is wall. Back to the wall, exactly as described.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RoomGeometry } from './m59-roo.mjs';

// The eight neighbours, in clockwise order, so that a run of blocked ones can be
// recognised as a contiguous arc rather than eight independent facts.
const RING = [
  [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
];

// The longest run of blocked directions, treating the ring as circular. A square
// with four blocked neighbours scattered around it is exposed from every side; one
// with four in a row has its back covered, which is the thing players describe.
function backCover(blocked) {
  const n = blocked.length;
  if (blocked.every(Boolean)) return n;
  let best = 0, run = 0;
  for (let i = 0; i < n * 2; i++) {
    run = blocked[i % n] ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

// Score every walkable square in a room for how defensible it is.
//
// `openNeighbours` is the number of squares a monster could stand on to melee you.
// `backCover` is the longest contiguous wall arc behind you. Both matter, and they
// are not the same: a doorway has few open neighbours but no back cover, while a
// long flat wall has plenty of open neighbours and excellent cover.
export function safeSpots(geo, { limit = 8, mustReach = null } = {}) {
  if (!geo) return [];
  const out = [];
  for (let r = 1; r <= geo.rows; r++) {
    for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      // Never recommend the outermost ring. Walking past row 1 / piRows or col 1 /
      // piCols is what triggers StandardLeaveDir, so a "safe corner" on the boundary
      // is a square that quietly ejects you from the room mid-fight — the opposite of
      // what it is being chosen for.
      if (r <= 1 || c <= 1 || r >= geo.rows || c >= geo.cols) continue;
      const blocked = RING.map(([dr, dc]) => !geo.walkable(r + dr, c + dc));
      const open = blocked.filter(b => !b).length;
      // A square nothing can reach is a cell, not a fighting position — we need at
      // least one open side to hit out of, and to have got there ourselves.
      if (open === 0) continue;
      // Nor is a completely open square worth naming.
      if (open >= 8) continue;
      const cover = backCover(blocked);
      out.push({
        col: c, row: r,
        can_reach_you: open,
        back_cover: cover,
        // How much better than standing in the open: eight attackers down to `open`.
        attackers_avoided: 8 - open,
        score: (8 - open) * 2 + cover,
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.can_reach_you - b.can_reach_you);

  // Optionally keep only spots we can actually path to from where we are.
  const picked = [];
  for (const s of out) {
    if (mustReach) {
      const p = mustReach(s.col, s.row);
      if (!p?.reachable) continue;
      s.steps_away = p.steps;
    }
    picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked;
}

// The best spot near where we are standing now, rather than the best in the room —
// walking thirty squares across a monster room to reach a marginally better corner
// is how you die on the way to safety.
//
// `book` is the memory of what has actually been tried here, and it OUTRANKS the
// geometry, because the geometry is a hypothesis and the book is a result. A square
// that held under attack is worth more than a better-looking square that has never
// been stood on, and a square that failed is worth nothing at all however good it
// looks — which is the whole reason for keeping the book.
// `toward` is where the fight has to happen — the prey. Without it this picks the
// most defensible square near US, which in a big outdoor room is a wall on the far
// side of the field from anything worth killing: the keeper walks to a perfect corner,
// discovers the nearest centipede is twelve steps away and cannot be fetched, gives
// the corner up, and picks the same one again next pass. A safe spot nothing can be
// brought to is not a safe spot, it is a bench.
export function nearestSafeSpot(geo, from, {
  within = 12, minAvoided = 3, reach = null, book = null, room = null, toward = null,
} = {}) {
  if (!geo || !from) return null;
  const all = safeSpots(geo, { limit: 400 });
  const known = book && room != null ? book.recall(room) : null;
  let best = null;
  for (const s of all) {
    const seen = known?.get(key(s.col, s.row)) || null;
    // Never send a character back to a square that has already been disproved.
    if (seen && book.discredited(seen)) continue;
    // A proven square is allowed to be less defensible on paper than the cutoff: it
    // has passed the only test that counts.
    if (s.attackers_avoided < minAvoided && !(seen && seen.held > 0)) continue;
    const d = Math.max(Math.abs(s.col - from.col), Math.abs(s.row - from.row));
    if (d > within) continue;
    const p = reach ? reach(s.col, s.row) : { reachable: true, steps: d };
    if (!p?.reachable) continue;
    // Prefer defensibility, then closeness. A spot two squares further away that
    // halves the number of attackers is worth the two squares. Proof is worth more
    // than either — a square that has held under attack beats any amount of
    // promising-looking wall.
    const proof = seen?.held ? 20 + Math.min(10, seen.held) : 0;
    // Distance from the fight counts twice over: it is walked once to fetch and once
    // to come back, and every step of it is taken in the open with the monster
    // already awake. Weighted more heavily than distance from us for that reason.
    const fromFight = toward ? Math.max(Math.abs(s.col - toward.col), Math.abs(s.row - toward.row)) : 0;
    const value = s.score + proof - (p.steps ?? d) * 0.5 - fromFight * 1.2;
    if (!best || value > best.value)
      best = { ...s, steps_away: p.steps ?? d, value, from_fight: toward ? fromFight : null,
               // Proven means held AND never failed. Discredited squares are already
               // skipped above; this keeps the flag honest for anything reading it.
               proven: !!seen?.held && !seen?.failed, held_before: seen?.held ?? 0,
               // The fine coordinate is what we actually want to stand on; see
               // SafeSpotBook. The square is only how we get there.
               fine: seen?.x != null ? { x: seen.x, y: seen.y } : null };
  }
  return best;
}

export function geometryFor(mapRoom) {
  return mapRoom?.roo ? RoomGeometry.fromJSON(mapRoom.roo) : null;
}

// ---------------------------------------------------------------- the book

const key = (col, row) => `${col},${row}`;

// WHAT ACTUALLY WORKED, WRITTEN DOWN.
//
// Everything above this line is inference from a one-byte-per-square movement grid,
// and the real mechanic is not in that grid. So the grid proposes and experience
// disposes: stand somewhere, be attacked, and see whether anything lands. That test
// is cheap, it is unambiguous, and until it is run the answer is genuinely unknown.
//
// Two things make it worth persisting rather than keeping in a process:
//
//   * a proven square is durable. Walls do not move, so a spot that held last week
//     holds today, and a character arriving in a room it has never seen can inherit
//     what another character learned there.
//   * a DISPROVED square is worth more than a proven one, because the geometry will
//     keep recommending it. The top-scoring square in a room can be one where the
//     BSP walls do not line up with the grid at all, and without a memory the keeper
//     walks back to it every time it wants to feel safe.
//
// The unit of memory is the FINE coordinate, not the square. moveToSquare puts you
// at the square's centre (col*64+32); a spot that works by hugging a wall may be
// forty fine units off that centre, and a square-move to "the same place" quietly
// lands you somewhere else. So the book records where we were standing to the fine
// unit and hands that back.
export class SafeSpotBook {
  constructor(file = null) {
    this.file = file;
    this.rooms = new Map();          // room number -> Map(key -> record)
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [num, spots] of Object.entries(raw.rooms || {}))
        this.rooms.set(Number(num), new Map(Object.entries(spots)));
    } catch { /* no book yet, or unreadable — start empty rather than fail */ }
  }

  save() {
    if (!this.file || !this.dirty) return false;
    const rooms = {};
    for (const [num, spots] of this.rooms) rooms[num] = Object.fromEntries(spots);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ rooms }));
      this.dirty = false;
      return true;
    } catch { return false; }   // a read-only substrate must not break a fight
  }

  recall(room) { return this.rooms.get(Number(room)) || null; }

  get(room, col, row) { return this.recall(room)?.get(key(col, row)) || null; }

  // ONE FAILURE IS ENOUGH. A spot that has ever let something through is out, for good,
  // however many times it held first.
  //
  // The old rule wanted two failures AND more failures than holds, on the reasoning that
  // poison or a stray archer can look like a spot that does not work and a good corner
  // is expensive to throw away. That has the cost backwards. Godfrey stood on a square
  // recorded held:1 — "proven" — and died there: it had been tested against two
  // attackers and met six, and went 24/24 to 9/24 in a single pass. Under the old rule
  // that square stayed proven and stayed recommended, to him and to everyone who
  // inherited the book.
  //
  // The asymmetry is the point. Being wrong about a bad spot costs a character; being
  // wrong about a good one costs a walk to the next corner. Spots seem safe at first and
  // turn out not to be — a crowd big enough simply reaches around the wall — and the
  // number of squares in a room is large. So a failure is permanent and there is no
  // route back into the recommendations.
  discredited(rec) { return !!rec && (rec.failed || 0) >= 1; }

  // We stood here under attack and nothing landed while we were not swinging.
  held(room, { col, row, x = null, y = null, seconds = 0, attackers = 0 }) {
    const rec = this.touch(room, col, row);
    rec.held++;
    rec.held_seconds = (rec.held_seconds || 0) + Math.round(seconds);
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    if (x != null) { rec.x = x; rec.y = y; }     // the exact place that worked
    rec.at = Date.now();
    this.dirty = true;
    return rec;
  }

  // We stood here under attack and were hit anyway. The spot does not work, or does
  // not work from the angle we were standing at.
  failed(room, { col, row, damage = 0, attackers = 0 }) {
    const rec = this.touch(room, col, row);
    rec.failed++;
    rec.damage_taken = (rec.damage_taken || 0) + damage;
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    rec.at = Date.now();
    this.dirty = true;
    return rec;
  }

  touch(room, col, row) {
    const num = Number(room);
    if (!this.rooms.has(num)) this.rooms.set(num, new Map());
    const spots = this.rooms.get(num);
    const k = key(col, row);
    if (!spots.has(k)) spots.set(k, { col, row, held: 0, failed: 0 });
    return spots.get(k);
  }

  // Everything known about a room, best first, for reporting.
  list(room) {
    const spots = this.recall(room);
    if (!spots) return [];
    return [...spots.values()]
      // A failure is checked FIRST. Asking `held > 0` before it reported a square that
      // had held once and killed someone once as simply "holds".
      .map(r => ({ ...r, verdict: this.discredited(r) ? 'does not work'
                                : r.held > 0 ? 'holds' : 'untested' }))
      .sort((a, b) => (a.failed - b.failed) || (b.held - a.held));
  }
}

let theBook = null;
export function safeSpotBook(file = null) {
  if (!theBook) theBook = new SafeSpotBook(file);
  return theBook;
}
