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

// WHAT CAN ACTUALLY HIT YOU, TAKEN FROM THE SERVER'S OWN ARITHMETIC RATHER THAN GUESSED.
//
// Everything above was written against the assumption that melee is an adjacency
// relation — that the things which can hit you are the eight squares touching yours.
// It is not, and the kod is unambiguous. Both sides run the same two tests:
//
//   REACH   SquaredDistanceTo(what) <= GetAttackRange^2, where SquaredDistanceTo is
//           (piRow-row)^2 + (piCol-col)^2 on SQUARE coordinates (nomoveon.kod:121).
//           A monster's range is Bound(2 + viDifficulty/6, 2, 3) (monster.kod:1682);
//           ours is 2 for bludgeon and slash, 3 for thrust (weapon.kod:52-54).
//   SIGHT   Room.LineOfSight from the attacker's square to yours (monster.kod:1782).
//
// So the squares something can hit you from are a DISC OF RADIUS 3 — up to 28 of them —
// filtered by line of sight. Not the eight that touch you. That single mistake is why
// this module kept recommending squares that then failed under attack: a flat wall
// blocks three of eight neighbours and scores as a 62% improvement, while leaving
// twenty of the twenty-eight squares that can really reach you completely open.
//
// AND ONLY THE MONSTER CHECKS SIGHT. Player.TargetWithinSightAndRange (player.kod:4115)
// checks range and a facing cone and never calls LineOfSight. That asymmetry IS the
// mechanic players describe: from the right square you can hit it and it cannot hit you
// back, so the fight becomes something you choose one exchange at a time. It is a
// property of specific squares and it is computable, which is what `free_shots` counts
// below. Nothing in this repository was looking for it.
//
// Radius 3 is the worst case, and deliberately so: a spot chosen against a 3 is safe
// against the 2 that most things actually have.
const MONSTER_REACH = 3;
// Our own worst case, which is the pessimistic direction for a DIFFERENT reason — it is
// the range we are sure we can strike at, so it is the range a free shot must be within.
const PLAYER_REACH = 2;

function disc(radius) {
  const out = [];
  for (let dr = -radius; dr <= radius; dr++)
    for (let dc = -radius; dc <= radius; dc++)
      if ((dr || dc) && dr * dr + dc * dc <= radius * radius) out.push([dr, dc]);
  return out;
}
const MONSTER_DISC = disc(MONSTER_REACH);      // 28 squares
const PLAYER_DISC = disc(PLAYER_REACH);        // 12 squares
export const MAX_ATTACKERS = MONSTER_DISC.length;

// Room.LineOfSight (room.kod:2125), transcribed rather than approximated.
//
// It is NOT Bresenham. It advances one axis per iteration — whichever is currently
// further from the target — and asks CanMoveInRoom for that single step, giving up on
// the first refusal. The line it traces is therefore a staircase, and it is directional:
// sight from A to B is not always sight from B to A. The direction that matters is the
// attacker's, so callers pass the attacker's square first.
export function lineOfSight(geo, fromRow, fromCol, toRow, toCol, { fine = false } = {}) {
  let r = fromRow, c = fromCol, r2 = r, c2 = c;
  const rs = toRow - fromRow >= 0 ? 1 : -1;
  const cs = toCol - fromCol >= 0 ? 1 : -1;
  // Bounded because the caller's squares come from a disc, so the walk is at most six
  // steps; the guard is against a malformed geometry, not against the algorithm.
  for (let guard = 0; (r !== toRow || c !== toCol) && guard < 64; guard++) {
    if (Math.abs(r - toRow) > Math.abs(c - toCol)) r2 += rs; else c2 += cs;
    if (!geo.canMove(r, c, r2, c2, { fine })) return false;
    r = r2; c = c2;
  }
  return true;
}

// How exposed one square is: how many squares something could hit you from, and how
// many you could hit it from while it could not answer.
export function exposureAt(geo, row, col, { fine = false } = {}) {
  let attackers = 0, freeShots = 0, ourGround = 0;
  for (const [dr, dc] of MONSTER_DISC) {
    const ar = row + dr, ac = col + dc;
    if (!geo.walkable(ar, ac)) continue;              // nothing can stand in a wall
    if (lineOfSight(geo, ar, ac, row, col, { fine })) attackers++;
  }
  for (const [dr, dc] of PLAYER_DISC) {
    const ar = row + dr, ac = col + dc;
    if (!geo.walkable(ar, ac)) continue;
    ourGround++;
    // Within our reach, and the wall between us stops its line but not ours.
    if (!lineOfSight(geo, ar, ac, row, col, { fine })) freeShots++;
  }
  return { attackers, free_shots: freeShots, our_ground: ourGround };
}

// WHERE THE TWO GRIDS DISAGREE ABOUT WALKABILITY — WHICH IS WHAT A SAFE WALL *IS*.
//
// Everything else in this file scores a square on the COARSE grid: how many of the disc
// squares are walkable, what has line of sight, how long the blocked arc behind is. That
// describes a wall as the server's own artifact sees it, and the server's artifact is the
// thing MONSTERS path on. It says nothing about whether an approach the coarse grid offers
// can actually be MADE.
//
// The safety is exactly that gap. A monster paths to a square the coarse grid says is
// adjacent to us; the BSP the real geometry is built from refuses the step; the monster
// mills about outside a wall it believes it is standing next to. So the measure of a good
// wall is not how enclosed it looks — it is HOW MANY WAYS IN THE GRID OFFERS THAT THE
// MOVER REFUSES.
//
// `refused` counts approaches into this square that a coarse-grid pather believes in and
// the mover will not make. `offered` is how many the grid believes in at all, so the pair
// can be read as a ratio rather than as a raw count — a square with two of two refused is
// better cover than one with two of eight.
//
// IT RETURNS NULL WHEN IT CANNOT TELL, AND THAT IS NOT THE SAME AS ZERO.
// `moverStepLands` answers TRUE for everything when `collisionReady` is false — it is
// designed to get out of the way rather than to veto steps it cannot check. Reading that
// as "no disagreement" would score every square in the world as ordinary floor and quietly
// turn this whole criterion off, which is the shape of failure this repository keeps
// finding: a measurement that degrades to a plausible number instead of to an absence.
export function gridDisagreementAt(geo, row, col) {
  if (!geo || !geo.collisionReady || typeof geo.moverStepLands !== 'function') return null;
  let offered = 0, refused = 0;
  for (const [dr, dc] of RING) {
    const ar = row + dr, ac = col + dc;
    // Not offered by the coarse grid either, so there is nothing to disagree about.
    if (!geo.walkable(ar, ac)) continue;
    offered++;
    // The step a thing standing there would have to make to close on us. Asked in the
    // monster's direction — INTO this square — because that is the move that has to fail
    // for the wall to be worth standing at.
    if (!geo.moverStepLands(ar, ac, row, col)) refused++;
  }
  return { offered, refused };
}

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
export function safeSpots(geo, { limit = 8, mustReach = null, los = 0 } = {}) {
  if (!geo) return [];
  // Which grid governs the thing trying to hit us. LOS_OLD is the server default, so
  // monsters move and see on the COARSE grid — see RoomGeometry.LOS.
  const fine = RoomGeometry.monsterUsesFine(los);
  const out = [];
  // A SAFE SPOT IS THE TWO GRIDS DISAGREEING. NOTHING ELSE IS A CANDIDATE.
  //
  // This loop used to open `if (!geo.walkable(r, c)) continue;` — only ever considering
  // squares the COARSE grid admits, which is the grid monsters path on. That excluded, by
  // construction, every square that IS the mechanism, and left the search choosing between
  // pieces of open floor on the strength of how enclosed they looked.
  //
  // Measured 2026-08-23 against the shadow fleet's own book, on the three rooms it dies in:
  //
  //     room                      in the book      real walls in the room
  //     598 Cragged Mountains      15 squares      1778
  //     597 The Twisted Wood        8 squares       112
  //     587 W border Twisted Wood 140 squares       277
  //
  // and EVERY square in the book, in all three rooms — including the ones recorded as having
  // HELD — read `coarse=true, fine=true`. Ordinary grass. Not one wall among them. So nine
  // travel shelters in a row "failed", the book wrote those failures down as facts about the
  // squares, the search walked further out to the next patch of grass, and a character at 7
  // of 46 was sent eighteen steps across the Cragged Mountains to stand in a field.
  //
  // The operator's account is the other half of the evidence and it is worth recording as
  // such: a wall chosen by grid disagreement has never once been seen to fail, and the
  // failures in this book are suspected to be poison — which damages through any geometry
  // and which `failed()` already declines to blame a square for.
  //
  // So the candidate set is now exactly the squares where the grids disagree, in either of
  // the two ways that matters:
  //
  //   THE SQUARE ITSELF   coarse refuses it, the BSP allows a body in it. The strongest
  //                       form there is: a monster's pather will not target the square at
  //                       all, because as far as it is concerned there is no floor here.
  //   THE APPROACHES      the coarse grid offers ways in and the mover refuses them. The
  //                       monster paths to a square it believes is adjacent and mills about
  //                       outside a wall it thinks it is standing next to.
  //
  // AND WHERE IT CANNOT BE MEASURED, NOTHING IS OFFERED. `moverStepLands` answers true for
  // everything when collision is not ready, so accepting candidates in that state would
  // silently restore exactly the behaviour above — the search would go back to grading open
  // floor and would look like it was working. This module already refuses to read that as
  // "no disagreement"; refusing to read it as "good enough" is the same rule applied one
  // level up. An empty answer is a fact; a plausible one is a fault.
  if (!geo.collisionReady || typeof geo.moverStepLands !== 'function') return [];
  for (let r = 1; r <= geo.rows; r++) {
    for (let c = 1; c <= geo.cols; c++) {
      // A body has to fit. This is the BSP question, and it is the only one asked of the
      // square itself — `walkable` is deliberately not consulted here any more.
      if (typeof geo.standable === 'function' && !geo.standable(r, c)) continue;
      // Never recommend the outermost ring. Walking past row 1 / piRows or col 1 /
      // piCols is what triggers StandardLeaveDir, so a "safe corner" on the boundary
      // is a square that quietly ejects you from the room mid-fight — the opposite of
      // what it is being chosen for.
      if (r <= 1 || c <= 1 || r >= geo.rows || c >= geo.cols) continue;
      const blocked = RING.map(([dr, dc]) => !geo.walkable(r + dr, c + dc));
      const open = blocked.filter(b => !b).length;
      // THE NUMBER THAT DECIDES EVERYTHING, and it is not `open`. See MONSTER_DISC.
      const { attackers, free_shots, our_ground } = exposureAt(geo, r, c, { fine });
      // A square nothing can stand within reach of is a cell, not a fighting position:
      // we could hold it for ever and never kill anything. Measured on OUR reach, which
      // is the one that has to find a target.
      if (our_ground === 0) continue;
      // Nor is a square that hides from nothing worth naming. Fully exposed is exactly
      // as good as open floor, which is what the caller already has.
      if (attackers >= MAX_ATTACKERS) continue;
      const cover = backCover(blocked);
      // LEDGE EDGE: if any orthogonal neighbour is a drop (floor falls more than one
      // step), a spot here is one mistimed step from a fall. That is the wrong kind
      // of cover to fight from. Penalise hard; a clifftop corner must not score well.
      // Only matters in multi-level rooms; flat rooms have no height data or all-equal
      // heights, so this is a no-op there.
      let ledge = false;
      if (typeof geo.heightStepOk === 'function') {
        if (!geo.heightStepOk(r, c, r + 1, c) || !geo.heightStepOk(r, c, r - 1, c) ||
            !geo.heightStepOk(r, c, r, c + 1) || !geo.heightStepOk(r, c, r, c - 1))
          ledge = true;
      }
      // WHICH WAY THE WALL IS, so a character can be put against it rather than in the
      // middle of the square.
      //
      // This matters more than it looks. The real mechanic is finer than this grid —
      // it is in the BSP walls and the angles — and moveToSquare aims at the CENTRE of
      // a square (col*64+32). A spot that works by hugging a wall can be most of a
      // square away from that centre, so a character sent to a good square by name
      // stands in the middle of it, gets hit, and the square is written down as one
      // that does not work. Every FIRST visit was made that way, which is a mechanism
      // for manufacturing false failures out of good walls.
      //
      // The sum of the blocked directions points into the wall. Normalised to at most
      // one step on each axis, because it is used as a direction, not a distance.
      let dr = 0, dc = 0;
      for (let i = 0; i < RING.length; i++) {
        if (!blocked[i]) continue;
        dr += RING[i][0]; dc += RING[i][1];
      }
      const wall = (dr || dc) ? { dr: Math.sign(dr), dc: Math.sign(dc) } : null;
      // The two grids disagreeing, which is what actually makes a wall hold. Computed per
      // candidate rather than per returned spot: callers filter and sort on it, so it has
      // to exist before the narrowing rather than be attached to the survivors.
      const disagree = gridDisagreementAt(geo, r, c);
      // THE GATE. A square the coarse grid refuses is itself a disagreement and the strongest
      // one; otherwise at least one offered approach has to be one the mover will not make.
      // Anything else is open floor and is not a safe spot however good it scores.
      const coarseRefusesIt = geo.walkable(r, c) !== true;
      if (!coarseRefusesIt && !((disagree?.refused ?? 0) > 0)) continue;
      out.push({
        col: c, row: r,
        // APPROACHES THE COARSE GRID OFFERS AND THE MOVER REFUSES. null when collision is
        // not baked for this room — "cannot tell", never "none". See gridDisagreementAt.
        refused_approaches: disagree ? disagree.refused : null,
        offered_approaches: disagree ? disagree.offered : null,
        // How many squares something can actually swing at us from. The old field name
        // is kept because it is written into the book and the fleet page, but it now
        // counts the disc rather than the eight neighbours, so it runs 0..28 not 0..8.
        can_reach_you: attackers,
        // Squares within OUR reach whose line back to us is blocked: stand here, hit
        // whatever walks into one, and it cannot answer. The thing players call a safe
        // wall. Worth more than any amount of ordinary cover.
        free_shots,
        open_neighbours: open,
        back_cover: cover,
        wall,
        // How much better than standing in the open.
        attackers_avoided: MAX_ATTACKERS - attackers,
        // Exposure dominates, and a free shot is worth about three squares of it: it is
        // not merely safer, it is the only arrangement that lets a fight be won without
        // taking a hit. Cover stays in as a tie-break — it is cheap and it correlates.
        score: (MAX_ATTACKERS - attackers) + free_shots * 3 + cover * 0.5 - (ledge ? 50 : 0),
        ledge,
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
    if (picked.length >= limit) break;   // Infinity means "all of them" — see nearestSafeSpot
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
// brought to is not a safe spot, it is a bench. But the room grid is only a prediction
// of that fact: it ranks predicted-reachable squares first and still offers a doubtful
// square when none remain. Repeated live pulls are the veto.
// THE SPOT MUST ULTIMATELY BE ONE THE FIGHT CAN REACH, and that is a different question
// from whether we can reach it. A clifftop scores beautifully on defensibility — almost
// nothing can stand next to you, which is the whole metric — and we can walk up to it.
//
// `quarryReach(col,row)` answers "could the thing we came to fight get here", on the
// grid that governs MONSTERS (see RoomGeometry.LOS — the stock server puts them on the
// coarse grid). Null means the caller cannot say. False lowers a square behind every
// predicted-reachable option; it no longer suppresses the live experiment.
// WHAT A SAFE WALL ACTUALLY IS, AND WHY THE DISC METRICS ARE NOT IT.
//
// `attackers_avoided` and `free_shots` are transcriptions of the server's reach and
// sight tests, and both are correct about what they compute. Neither is what a player
// means by a safe wall, and the book says so once the evidence is cleaned:
//
//   attackers_avoided   r = 0.294, and NOT monotone — the 20-24 band holds 19.7% of the
//                       time against 39.1% for 15-19. The threshold sat in a trough.
//   free_shots          r = 0.241
//   blocked neighbours  r = 0.251
//   back_cover          r = 0.291, and back_cover >= 5 holds 89.7% of the time
//
// Four weak predictors in the same band, and the strongest single rule in the whole set
// is the one closest to the plain description: get a run of wall behind you.
//
// The old numbers looked far better than that (84.7% for avoided >= 20) because they
// were measured against a ledger where 27% of the failures were phantoms written by
// restBroken() with nothing adjacent — see the note there. Those phantoms are all open
// floor, so they inflated every metric that rewards enclosure.
//
// So the filter is now the requirement a person would state: A WALL YOU CAN PUT YOUR
// BACK TO. Ranked by how much of it there is, with the disc score kept as a tie-break
// rather than a gate, because it is weakly informative and free to compute.
//
// `rule` selects between them. 'disc' is the previous behaviour, kept because it is the
// thing this is being measured against and a claim nobody can re-run is not a finding.
export const SPOT_RULES = ['wall', 'disc'];

// TEST THE CORNERS FIRST, BECAUSE THE CLIFF IS NOT A SLOPE.
//
// back_cover is scored linearly above, which spreads the difference between a flat wall
// and a corner over six points — and that is not the shape of the evidence. On the
// cleaned ledger:
//
//   back_cover 0      23.5% held   (n=17)
//   back_cover 1-2    20.0% held   (n=60)
//   back_cover 3-4    38.6% held   (n=456)
//   back_cover 5-6    88.9% held   (n=27)
//   back_cover 7-8   100.0% held   (n=2)
//
// Everything from 0 to 4 is a coin-flip at best. At 5 it more than doubles. That is a
// step, so it is priced as one.
//
// SIZED TO OUTRANK ONE HOLD, DELIBERATELY. The proof bonus gives a square that has held
// once 21 points, which under the linear score alone means an untested corner (15) loses
// to a once-held flat wall (9 + 21 = 30) every time — so the 88.9% band never gets
// explored anywhere a mediocre square has already been proven, which is nearly
// everywhere. That is the wrong bet on our own numbers: an untested corner at 88.9%
// prior beats a flat wall measured at 38.6%. At 24 the ordering comes out:
//
//   untested corner            15 + 24 = 39
//   once-held flat wall         9 + 21 = 30      -> the corner is tried first
//   five-times-held flat wall   9 + 25 = 34      -> still the corner
//   VERIFIED flat wall          9 + 60 = 69      -> a person's judgement still wins
//   once-held corner           39 + 21 = 60      -> and proof still compounds
//
// So this changes which HYPOTHESIS is tested next and never overrules a human. It costs
// a walk when it is wrong, which is the cheap direction — see discredited().
const CORNER = 5;
const CORNER_BONUS = 24;
/**
 * THE SHELTERS ALONG A ROUTE, WORKED OUT BEFORE THE ROUTE IS WALKED.
 *
 * You do not add a fuel stop to a journey by braking in the middle of the road, unfolding a
 * map and re-planning from a standstill. You work out where the stops are while you are
 * still driving, and when you need one you change the road ahead. That is the whole idea
 * here, and the thing it replaces is exactly the braking version: the mid-hop wall rung used
 * to cancel the journey, hand the character back, search the room from where it happened to
 * be standing, and walk to whatever it found. Measured, that is the wrong shape — health
 * leaves at a median of 4.7 a second once something starts, and the average maximum on this
 * fleet is 45, so a full bar is nine and a half seconds. Stopping to think is most of it.
 *
 * So this is asked ONCE, when the crossing is planned, and the answer travels with the plan.
 * Each entry says which step of the route it hangs off and how far off the road it is, which
 * is what lets a caller take the next one AHEAD of it rather than the nearest one in any
 * direction — behind is where it has already been bitten.
 *
 * Costs nothing at runtime: a route that never needs a stop never looks at the list.
 */
export function sheltersAlong(geo, steps, {
  within = 6, book = null, room = null, minBackCover = 1, limit = 24,
} = {}) {
  if (!geo || !Array.isArray(steps) || !steps.length) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!Number.isFinite(st?.row) || !Number.isFinite(st?.col)) continue;
    let spot = null;
    try {
      spot = nearestSafeSpot(geo, { row: st.row, col: st.col },
                             { within, book, room, minBackCover });
    } catch { spot = null; }
    if (!spot) continue;
    const k = `${spot.col},${spot.row}`;
    if (seen.has(k)) continue;          // one entry per square, at the first step that reaches it
    seen.add(k);
    out.push({
      col: spot.col, row: spot.row,
      // WHICH STEP IT HANGS OFF. A caller walking the plan knows how far along it is, so this
      // is what makes "ahead" answerable at all.
      atStep: i,
      detour: spot.steps_away ?? Math.max(Math.abs(spot.row - st.row), Math.abs(spot.col - st.col)),
      proven: !!spot.proven,
      backCover: spot.back_cover ?? null,
      // WHAT MAKES IT A WALL AT ALL — the approaches the coarse grid offers and the mover
      // refuses. Carried through from the candidate so `shelterAhead` can rank on the
      // mechanism rather than on whether we happen to have stood here before. null means
      // the room is not baked and the question could not be asked; see gridDisagreementAt.
      refused_approaches: spot.refused_approaches ?? null,
      offered_approaches: spot.offered_approaches ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The next shelter AHEAD on a route, or null.
 *
 * `atStep` is where the walker has got to. Behind is not offered: a character that is being
 * hurt got that way somewhere, and sending it back through the place it was bitten to reach
 * a wall it has already passed is worse than carrying on. `maxDetour` is the real gate — a
 * wall twelve squares off the road is not shelter when there are nine seconds of health
 * left, it is a longer way to die.
 */
export function shelterAhead(shelters, atStep,
                             { maxDetour = 4, requireDisagreement = true, unreachable = null } = {}) {
  if (!Array.isArray(shelters) || !shelters.length) return null;
  let ahead = shelters.filter(s => s.atStep >= atStep && s.detour <= maxDetour);
  // The same exclusion the room search applies: a planned stop we have just failed to walk
  // to is not a stop. Applied before the ranking below rather than after, so a shelter that
  // cannot be reached does not win on disagreement and then fail again.
  if (unreachable) ahead = ahead.filter(s => !unreachable.has(`${s.col},${s.row}`));
  if (!ahead.length) return null;

  // A WALL IS THE TWO GRIDS DISAGREEING, AND THAT IS THE ONLY THING ASKED ABOUT HERE.
  //
  // `preferProven` used to break ties, and it was the wrong question twice over. It ranked
  // by whether this fleet had happened to stand somewhere before — which is a fact about
  // where it has been, not about the square — and on a road nobody has walked yet it is
  // simply absent, so the tie-break did nothing exactly where a stop matters most.
  //
  // The mechanism is available instead: `refused_approaches` counts the ways in that the
  // coarse grid offers and the mover refuses. That is what stops a monster reaching us, it
  // is computable for a square nobody has ever visited, and it does not decay when the book
  // is discredited.
  //
  // NULL IS NOT ZERO. An unbaked room cannot answer, and dropping those would empty the
  // list in exactly the rooms where collision has not been baked yet — so a null is kept
  // and sorted last, never filtered out. Only a square that CAN answer and answers "no
  // disagreement" is refused, because that square is plain floor wearing a wall's name.
  if (requireDisagreement) {
    const answerable = ahead.filter(s => s.refused_approaches != null);
    const disagreeing = answerable.filter(s => s.refused_approaches > 0);
    // Everything that could answer said no: fall through to the unanswerable ones rather
    // than returning null, since "not baked" is not evidence against a square.
    ahead = disagreeing.length || answerable.length < ahead.length
      ? [...disagreeing, ...ahead.filter(s => s.refused_approaches == null)]
      : [];
    if (!ahead.length) return null;
  }

  // Nearest along the route first, so the stop is the next one rather than the best one —
  // the best one may be forty squares further on, which is the same mistake as searching.
  ahead.sort((a, b) => (a.atStep - b.atStep)
    || ((b.refused_approaches ?? -1) - (a.refused_approaches ?? -1))
    || (a.detour - b.detour));
  return ahead[0];
}

export function nearestSafeSpot(geo, from, {
  within = 12, minAvoided = 20, reach = null, book = null, room = null, toward = null,
  quarryReach = null, strictQuarryReach = false, stats = null, los = 0,
  rule = 'wall', minBackCover = 1, fromFightWeight = 0.3,
  // SQUARES WE COULD NOT GET TO. A different fact from a square that failed to HOLD, which
  // is what `discredited` records — this one is about the walk, not about the wall.
  // See `unreachableSpots` on the keeper for why it is session-scoped and expires.
  unreachable = null,
} = {}) {
  if (!geo || !from) return null;
  // EVERY QUALIFYING SQUARE, NOT THE TOP FEW HUNDRED BY SCORE.
  //
  // This asked for the 400 best-scoring squares in the room and then filtered THOSE by
  // distance and by the book. Both of those orderings are wrong way round, and in a
  // big outdoor room the effect is severe: score rewards enclosure, so a tight alcove
  // scores roughly twice a plain wall edge and the 400 slots fill up with alcoves
  // before a single edge is considered. Discredit the alcoves — which is
  // what happens after a few hours in a room, 95 of them at the Tos gate — and this
  // returns null, reporting "nothing here is more defensible than open floor" about a
  // room with hundreds of perfectly good walls in it.
  //
  // MINAVOIDED IS 20 OF 28, AND IT IS SET FROM THE BOOK RATHER THAN FROM TASTE.
  //
  // It was 3 of 8, which sounded like "a wall at your back" and was in practice no
  // filter at all: of the 826 recorded squares with an outcome, 777 — 94% of them —
  // scored 3 or 4 on the ring, so the cutoff admitted almost everything and the model
  // could not tell a good square from a bad one. Those 777 held 39.5% of the time.
  //
  // On the reach disc the same squares separate properly, and the separation is sharp:
  //
  //   avoided 10-14   26.8% held        free_shots 0     30.6% held
  //   avoided 15-19   39.2% held        free_shots 1-2   42.4% held
  //   avoided 20+     84.7% held        free_shots 3+    89.4% held
  //
  // 20 is where that cliff is. It is affordable: across the 107 rooms the fleet hunts
  // in or has a book entry for, 106 have squares clearing it, and the busy ones have
  // between 43 and 404 of them. So this refuses far more than it used to and still
  // leaves every real hunting room hundreds of candidates.
  //
  // The cap bought nothing anyway — the loop below already narrows by `within` long
  // before anything expensive happens. Scoring every square is one pass over the room.
  const all = safeSpots(geo, { limit: Infinity, los });
  const known = book && room != null ? book.recall(room) : null;
  let best = null;
  let bestPredictedUnreachable = null;
  let unreachableByQuarry = 0;
  let reachableByQuarry = 0;
  let eligible = 0;
  let unreachableToUs = 0;
  let empiricallyBarren = 0;
  let partitionRejected = 0;
  for (const s of all) {
    const seen = known?.get(key(s.col, s.row)) || null;
    // Never send a character back to a square that has already been disproved.
    if (seen && book.discredited(seen)) continue;
    // NOR TO ONE WE HAVE JUST FAILED TO WALK TO. A wall that cannot be reached is not
    // shelter, and offering it again is how a hurt character spends a whole room choosing
    // the same unreachable square: measured in the Western border of the Twisted Wood, the
    // decision trail read "could not reach the safe spot" / "will not rest in the open here"
    // / "leaving the room to recover safely" / "could not leave", and then the character
    // died. Nothing recorded the failure, so every pass made the identical choice.
    if (unreachable?.has(key(s.col, s.row))) continue;
    // CHEAP TESTS FIRST. Distance and the defensibility cutoff are arithmetic on two
    // integers; quarryReach and reach are pathfinds. With the candidate list no longer
    // capped this ordering is the difference between one pass over the room and a
    // pathfind per square in it — the far corners of a 58x44 room were being routed to
    // and then discarded for being out of range.
    const d = Math.max(Math.abs(s.col - from.col), Math.abs(s.row - from.row));
    if (d > within) continue;
    // A proven square is allowed to be less defensible on paper than the cutoff: it
    // has passed the only test that counts.
    //
    // 'wall' asks only for a wall to stand against, which is a far wider net: room 544
    // goes from 113 candidates to about 1300. That is the point — the disc rule was
    // rejecting most of the room on a number that does not predict holding, and a wider
    // net with an honest ranking beats a narrow one built on a trough.
    const gate = rule === 'disc'
      ? s.attackers_avoided >= minAvoided
      : s.back_cover >= minBackCover;
    // `retest` keeps a REINSTATED square eligible without making it trusted. A square
    // put back by m59-safespot-retest.mjs has had its held count zeroed — it is being
    // asked to prove itself again from nothing — and zeroing it would otherwise drop any
    // square that qualified only BECAUSE it had held, so the reassessment could never
    // happen. It grants no proof bonus below, and it does not survive discredited()
    // above: fail again and the square is out for good, exactly as before.
    if (!gate && !(seen && (seen.held > 0 || seen.retest))) continue;
    eligible++;

    // THE MONSTER GRID IS A PRIOR, NOT A VERDICT.
    //
    // This used to `continue` on one coarse-grid miss. That made a stale quarry position,
    // an imperfect .roo movement mask, or a server setting we had inferred incorrectly
    // sufficient to declare every wall in the room a clifftop — before a character had
    // stood on even one of them. The live observation is cheaper and stronger: take the
    // best predicted-reachable wall first, but if none exists take the best predicted-
    // unreachable wall and actually try to pull the quarry there. `barrenSpots` below is
    // the empirical veto, learned only after repeated swings and a full follow window.
    let predictedUnreachable = false;
    let quarryPrediction = null;
    if (quarryReach) {
      quarryPrediction = quarryReach(s.col, s.row);
      if (quarryPrediction?.reachable === false) {
        predictedUnreachable = true;
        unreachableByQuarry++;
      } else if (quarryPrediction?.reachable === true) {
        reachableByQuarry++;
      }
    }
    // Some rooms contain player-operated doors whose two sides share a room number.
    // The coarse movement grid is the server's monster graph there, not merely a prior:
    // a monster cannot operate the door, so offering a wall in another component creates
    // a pull that can never convert. Keep the ordinary loose, test-it-live rule everywhere
    // else; only callers that know the room has player-only internal portals opt in.
    if (strictQuarryReach && predictedUnreachable) {
      partitionRejected++;
      continue;
    }
    const p = reach ? reach(s.col, s.row) : { reachable: true, steps: d };
    if (!p?.reachable) {
      unreachableToUs++;
      if (/empirically barren/i.test(String(p?.reason || p?.why || ''))) empiricallyBarren++;
      continue;
    }
    // Prefer defensibility, then closeness. A spot two squares further away that
    // halves the number of attackers is worth the two squares. Proof is worth more
    // than either — a square that has held under attack beats any amount of
    // promising-looking wall.
    // A marked square outranks any amount of promising-looking wall, and outranks a
    // square that merely held — holding is our own measurement, marking is somebody's
    // judgement made from inside the game.
    const proof = (seen?.verified ? 60 : 0) + (seen?.held ? 20 + Math.min(10, seen.held) : 0);
    // Distance from the fight is a TIE-BREAK, not a filter.
    //
    // This was 1.2 a square, which is heavier than it sounds: at that weight a wall
    // eight squares further from the quarry loses to open floor beside it, and the
    // quarryReach prediction above already supplies the primary partition. Any spot in
    // its predicted-reachable partition is good enough; if that partition is empty, the
    // best doubtful one is tested live instead of being forbidden by the map.
    const fromFight = toward ? Math.max(Math.abs(s.col - toward.col), Math.abs(s.row - toward.row)) : 0;
    // RANK ON THE THING THAT PREDICTS HOLDING. `score` is the disc composite; under the
    // wall rule the back arc leads and the disc score stays as a weak tie-break, at
    // roughly the ratio their correlations earn.
    const defensibility = rule === 'disc' ? s.score
      : s.back_cover * 3 + s.score * 0.25 + (s.back_cover >= CORNER ? CORNER_BONUS : 0);
    const value = defensibility + proof - (p.steps ?? d) * 0.5 - fromFight * fromFightWeight;
    const candidate = {
      ...s, steps_away: p.steps ?? d, value, from_fight: toward ? fromFight : null,
      // This is an invitation to TEST the prediction, not a statement that the square
      // works. The empirical pull detector is the authority after arrival.
      predicted_unreachable_by_quarry: predictedUnreachable || undefined,
      quarry_prediction: predictedUnreachable ? quarryPrediction : undefined,
      // Proven means held AND never failed. Discredited squares are already
      // skipped above; this keeps the flag honest for anything reading it.
      proven: !!seen?.held && !seen?.failed, held_before: seen?.held ?? 0,
      // The fine coordinate is what we actually want to stand on; see SafeSpotBook.
      // The square is only how we get there.
      fine: seen?.x != null ? { x: seen.x, y: seen.y } : null,
    };
    if (predictedUnreachable) {
      if (!bestPredictedUnreachable || value > bestPredictedUnreachable.value)
        bestPredictedUnreachable = candidate;
    } else if (!best || value > best.value) {
      best = candidate;
    }
  }
  // A reachable prediction always wins. The fallback is deliberately visible in the
  // returned record so the keeper can say it is testing a doubtful map rather than
  // presenting the map's guess as a fact.
  best ??= bestPredictedUnreachable;
  // Keep the map prediction and the live verdict separate in the diagnostics. A doubtful
  // square is no longer dropped merely for being doubtful; `empirically_barren` counts
  // the ones repeated pull tests have actually retired.
  if (stats) {
    stats.considered = all.length;
    stats.eligible = eligible;
    stats.unreachable_by_quarry = unreachableByQuarry;
    stats.reachable_by_quarry = reachableByQuarry;
    stats.unreachable_to_us = unreachableToUs;
    stats.empirically_barren = empiricallyBarren;
    stats.partition_rejected = partitionRejected;
    stats.used_predicted_unreachable = !!best?.predicted_unreachable_by_quarry;
  }
  if (best && unreachableByQuarry) best.rejected_unreachable_by_quarry = unreachableByQuarry;
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
  // A HUMAN STOOD HERE AND SAYS IT WORKS.
  //
  // Ground truth, and it outranks everything this file infers. The model reasons from a
  // one-byte-per-square grid and a transcription of the server's reach test; a person
  // playing the character sees the actual geometry and, more to the point, has fought
  // from the square. Every automatic judgement in this book has been wrong at least once
  // — the reach model condemned 560 squares it should not have, including all 132 in the
  // Valley of Ileria — and a marked square is the one kind of record that was not
  // produced by a model that might be wrong.
  //
  // Failures are still COUNTED on a verified square, because a human can be wrong too
  // and the record should say so. They just do not retire it: unmarking is a human's job.
  verify(room, { col, row, by = null, note = null }) {
    const rec = this.touch(room, col, row);
    rec.verified = true;
    rec.verified_by = by;
    rec.verified_at = Date.now();
    if (note) rec.verified_note = note;
    this.dirty = true;
    return rec;
  }

  unverify(room, { col, row }) {
    const rec = this.touch(room, col, row);
    delete rec.verified; delete rec.verified_by; delete rec.verified_at; delete rec.verified_note;
    this.dirty = true;
    return rec;
  }

  // WHAT JUDGED THIS SQUARE. A failure is permanent and that stays true however it was
  // found — a square that let a blow through is a bad square whether the character was
  // fighting from it or resting at it part-way through a journey, and the conservative
  // direction is the cheap one: being wrong about a bad square costs a character, being
  // wrong about a good one costs a walk to the next corner.
  //
  // But the two are not the same evidence. A travel hold is taken in a room nobody chose,
  // with whatever followed you through the door, on a wall derived from geometry that has
  // never been stood on. So the provenance is written down: `failed_via` is the most recent
  // judge and `failed_by` counts them, which is enough to fish the travel-only rejections
  // back out later without having to reconstruct anything.
  discredited(rec) {
    if (!rec) return false;
    if (rec.verified) return false;             // a person's word beats our arithmetic
    return (rec.failed || 0) >= 1;
  }

  // We stood here under attack and nothing landed while we were not swinging.
  held(room, { col, row, x = null, y = null, seconds = 0, attackers = 0, source = null }) {
    const rec = this.touch(room, col, row);
    rec.held++;
    if (source) mark(rec, 'held', source);
    rec.held_seconds = (rec.held_seconds || 0) + Math.round(seconds);
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    if (x != null) { rec.x = x; rec.y = y; }     // the exact place that worked
    rec.at = Date.now();
    this.dirty = true;
    return rec;
  }

  // We stood here under attack and were hit anyway. The spot does not work, or does
  // not work from the angle we were standing at.
  failed(room, { col, row, damage = 0, attackers = 0, settledMs = null, source = null }) {
    const rec = this.touch(room, col, row);
    rec.failed++;
    if (source) mark(rec, 'failed', source);
    rec.damage_taken = (rec.damage_taken || 0) + damage;
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    // HOW SETTLED WE WERE WHEN THE WINDOW THAT CONDEMNED THIS SQUARE OPENED.
    //
    // A failure is permanent, so the one way this book can be quietly wrong is by
    // blaming a square for a blow that was resolved before we reached it and only
    // arrived afterwards. SETTLE_GRACE_MS in m59-autopilot.mjs is what stops that, and
    // this is the evidence for whether it is wide enough: the tightest margin any real
    // failure was recorded at. If that number sits just above the grace, the grace is
    // too narrow and squares are still being retired by packet timing.
    if (settledMs != null && Number.isFinite(settledMs)) {
      rec.settled_ms = Math.max(0, Math.round(settledMs));
      rec.min_settled_ms = Math.min(rec.min_settled_ms ?? Infinity, rec.settled_ms);
    }
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

// Provenance for one outcome — the most recent judge, and a count per judge. Kept tiny and
// additive so an old book without it reads exactly as it always did.
function mark(rec, kind, source) {
  rec[`${kind}_via`] = source;
  const by = rec[`${kind}_by`] ?? {};
  by[source] = (by[source] || 0) + 1;
  rec[`${kind}_by`] = by;
}

let theBook = null;
export function safeSpotBook(file = null) {
  if (!theBook) theBook = new SafeSpotBook(file);
  return theBook;
}

// PUTTING BACK A SQUARE THAT WAS RETIRED BY A PACKET RATHER THAN BY A WALL.
//
// These two live here, next to discredited(), rather than in m59-safespot-retest.mjs
// where they are used: that file is a script with no entry-point guard, so importing it
// to test the rule would run it against the real book. The rule is the part worth
// pinning, so the rule lives with the data it describes.
//
// The subset is narrow on purpose. A square that HELD and was then retired on at most a
// point of damage is the shape a single late packet makes — see SETTLE_GRACE_MS in
// m59-autopilot.mjs, which did not exist when these were judged. A square that lost six
// is one something genuinely reached, and stays out.
export function selectForRetest(rooms, { maxDamage = 1 } = {}) {
  const picked = [];
  for (const [room, spots] of Object.entries(rooms || {})) {
    for (const [k, r] of Object.entries(spots || {})) {
      // A mark already outranks our arithmetic, so a verified square is not discredited
      // and needs no rescuing. Zeroing a person's held record to fix a problem they do
      // not have would be a loss rather than a repair.
      if (r.verified) continue;
      if (!((r.held || 0) > 0)) continue;
      if (!((r.failed || 0) > 0)) continue;
      if ((r.damage_taken || 0) > maxDamage) continue;
      picked.push({ room: Number(room), key: k, rec: r });
    }
  }
  return picked;
}

// UNTESTED, NOT TRUSTED, AND THAT DISTINCTION IS THE WHOLE POINT.
//
// The pardon in m59-safespot-retest.mjs clears `failed` and keeps `held`, on the sound
// reasoning that holding is holding wherever you stood. Applied here that would be
// exactly wrong: takeSafeSpot inherits `proven` from a clean held record, so the keeper
// would go and REST on these squares — trusting a judgement we have just decided was
// unreliable, without ever re-testing it. So `held` goes too, and the square has to earn
// its twelve quiet seconds again from nothing.
// `from` is the record the DECISION was made against, which is not always the record
// being rewritten. The failures that identify this subset were cleared out of the live
// book by the pardon in m59-safespot-retest.mjs before this ran, so the selection has to
// be made against an older snapshot — and the history worth keeping is that snapshot's,
// not the pardoned record's zeroes. Defaults to the record itself, which is the ordinary
// case.
export function reinstateUntested(rec, { why = 'retired before SETTLE_GRACE_MS existed',
                                         from = rec } = {}) {
  const out = { ...rec, held: 0, failed: 0 };
  delete out.damage_taken;
  delete out.held_seconds;
  // Keeps it eligible where the geometry cutoff alone would not offer it — see the gate
  // in nearestSafeSpot. Grants no proof bonus, and does not survive a fresh failure.
  out.retest = true;
  out.retest_at = Date.now();
  out.retest_why = why;
  out.retest_from = {
    held: from.held || 0, failed: from.failed || 0,
    damage_taken: from.damage_taken || 0,
    held_seconds: from.held_seconds || 0,
    most_attackers: from.most_attackers || 0,
    at: from.at ?? null,
  };
  return out;
}
