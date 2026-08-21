// Movement results that cannot become legal by retrying another heading or pretending
// a square is occupied. These are failures of the local collision contract or of the
// state needed to apply it; callers must propagate them before any further packet.
export const TERMINAL_MOVEMENT_REASONS = Object.freeze([
  'collision_geometry_unavailable',
  'collision_geometry_changed',
  'room_security_unknown',
  'room_geometry_mismatch',
  'room_changed_before_move',
  'position_confirmation_timeout',
  'own_position_unknown',
  'start_has_no_floor',
  // SPLIT OUT OF `start_has_no_floor` 2026-08-21, and terminal for exactly the same
  // reason it is: no heading fixes it. The character's coordinates and the loaded room
  // geometry belong to different rooms, so every square the search can reach is empty —
  // and re-planning against the wrong map produces another wrong plan, faster.
  //
  // It is separated because the two were indistinguishable in the record and the common
  // one is not the one the old name describes: 1,535 of 2,361 shadow-fleet hop failures
  // in fourteen hours read `start_has_no_floor`, and the room they mostly left is ten
  // rows by thirteen columns with every square in it walkable. See the note at the
  // refusal site in m59-broker.mjs.
  'position_outside_room_geometry',
  'invalid_move_target',
]);

const TERMINAL = new Set(TERMINAL_MOVEMENT_REASONS);

export function isTerminalMovementReason(reason) {
  return typeof reason === 'string' && TERMINAL.has(reason);
}

export function terminalMovementResult(result) {
  return result && isTerminalMovementReason(result.reason) ? result : null;
}
