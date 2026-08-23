// ROOMS WHOSE GEOMETRY REALLY DOES MOVE, DECLARED RATHER THAN DISCOVERED EACH TIME.
//
// The whole collision model rests on the map being a fact: the bake describes the room, the
// mover enforces it, and a packet saying the room just changed shape is a reason to stop,
// because we cannot mutate our in-memory BSP the way the stock client does. That is right
// almost everywhere. In a handful of places it is exactly wrong, and it caged the fleet.
//
// The Cragged Mountains is the case that forced this. The Temple of Qor's door sits on the
// 598 -> 599 boundary — the only road to Castle Victoria — and cycles faster than the 8s
// invalidation window, so every packet re-armed the refusal. Measured: seven refusals in
// thirty-five seconds, and the Tos -> Castle Victoria leg completed 0 times out of 3 in a
// grand tour. The operator names the others from having played them: the Arena of Kraanan,
// Castle Brax, and a little of North Barloque.
//
// THE RULE THE OPERATOR ASKED FOR, IN TWO HALVES:
//
//   * PREFER NOT TO ROUTE THROUGH THEM — but never refuse. These are ordinary rooms with a
//     moving part, not death rooms, and the road to Castle Victoria goes through one with
//     no alternative at all. So this is a cost, and `findPath` treats it exactly like the
//     other soft hazards: it goes through when there is no other way.
//   * DO NOT CARE ABOUT THE CHANGE UNLESS WE ARE ACTUALLY IN IT. A `BP_SECTOR_MOVE` that
//     names its sector is already narrowed to that sector, and that narrowing is the right
//     behaviour everywhere. What this adds is the case where the packet does NOT name one:
//     everywhere else that reads as "we do not know which part moved, so refuse the room",
//     and in a room we have DECLARED to be permanently in motion that reading is a cage
//     rather than caution.
//
// THE FAILURE DIRECTION, STATED PLAINLY, BECAUSE IT IS A RELAXATION. Being wrong here means
// authorising a move against geometry that has shifted underneath us in a room we already
// know shifts. The server does not check player collision at all, so the move is accepted
// and the character ends up somewhere it should not be — recoverable, and the ordinary
// per-move validation still runs against everything else. Being wrong the other way is what
// we measured: a character that can never leave the room, on the only road to a whole
// quarter of the world. The list is deliberately SHORT and hand-declared for that reason —
// it is an exception, and every entry should have somebody's name on it.
export const MUTABLE_GEOMETRY = Object.freeze({
  598: 'The Cragged Mountains — the Temple of Qor door cycles on the 599 boundary, faster ' +
       'than the 8s invalidation window. Reproduced: 7 refusals in 35s, Tos -> Castle ' +
       'Victoria 0 of 3.',
  578: 'The Cragged Mountains (the other one) — same room class, declared with 598 rather ' +
       'than waiting to be caged by it.',
  60:  'The Arena of Kraanan — operator, 2026-08-18.',
  73:  'The Arena of Kraanan — operator, 2026-08-18.',
  825: 'The Dungeon of Castle Brax — operator, 2026-08-18.',
  827: 'Ancient Graveyard of Brax — operator, 2026-08-18.',
  828: 'Decaying City of Brax — operator, 2026-08-18.',
  829: 'Within the Walls of Castle Brax — operator, 2026-08-18.',
  830: 'Ruins of Castle Brax — operator, 2026-08-18.',
  101: 'North Barloque — "a tiny bit", operator, 2026-08-18.',
});

/** Does this room's geometry move? */
export const isMutableGeometry = room => Object.hasOwn(MUTABLE_GEOMETRY, String(Number(room)));

/** Why it is on the list, or null. Kept so a refusal can cite rather than assert. */
export const mutableBecause = room => MUTABLE_GEOMETRY[String(Number(room))] ?? null;

/**
 * How much a router should dislike crossing one, as a fraction of a room's danger scale.
 *
 * NOT a ban and not a `danger` rating — those are about what lives in a room. This is about
 * the room being harder to walk RELIABLY, which is a different axis, and it is small on
 * purpose: enough to prefer the road that avoids the Arena when one exists, nowhere near
 * enough to make a fleet walk an extra town to dodge North Barloque.
 */
export const MUTABLE_TRANSIT_PENALTY = Number(process.env.M59_MUTABLE_PENALTY || 120);

// ---------------------------------------------------------------------------- CLI
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const direct = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  console.log('rooms declared to have moving geometry:\n');
  for (const [room, why] of Object.entries(MUTABLE_GEOMETRY))
    console.log('  ' + String(room).padStart(4) + '  ' + why);
  console.log('\ntransit penalty: ' + MUTABLE_TRANSIT_PENALTY +
              ' (a preference, never a refusal — the only road to Castle Victoria is through 598)');
}
