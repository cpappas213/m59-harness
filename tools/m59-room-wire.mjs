// Exact live-room provenance from BP_PLAYER.
//
// The stable map room number is local data. The resource ids and security checksum
// are not: they are the current tuple sent by the server. Keep those evidence
// classes separate and join them only when the configured map has exactly one row
// for the complete (roomRsc, roomNameRsc) pair. In particular, never fall back to
// the runtime room object id: it is renumbered by server saves.

const UINT32_MAX = 0xffff_ffff;
const ROOM_WIRE_KEYS = new Set([
  'resolved_room_num', 'room_resource_id', 'room_security_u32',
]);

const uint32 = value => Number.isInteger(value) && !Object.is(value, -0) &&
  value >= 0 && value <= UINT32_MAX;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

// Validate an untrusted/cross-process room_wire and return a new closed object.
// Extra keys are rejected so a caller cannot accidentally promote related display
// or map fields into server provenance.
export function canonicalRoomWire(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ROOM_WIRE_KEYS.size || keys.some(key => !ROOM_WIRE_KEYS.has(key)))
    return null;
  if (!positiveInteger(value.resolved_room_num) ||
      !uint32(value.room_resource_id) || value.room_resource_id === 0 ||
      !uint32(value.room_security_u32)) return null;
  return Object.freeze({
    resolved_room_num: value.resolved_room_num,
    room_resource_id: value.room_resource_id,
    room_security_u32: value.room_security_u32,
  });
}

export function sameRoomWire(left, right) {
  const a = canonicalRoomWire(left), b = canonicalRoomWire(right);
  return !!a && !!b &&
    a.resolved_room_num === b.resolved_room_num &&
    a.room_resource_id === b.room_resource_id &&
    a.room_security_u32 === b.room_security_u32;
}

// Capture the whole BP_PLAYER tuple before looking at the map. JavaScript cannot
// interleave another packet handler into this synchronous read, so these three
// locals describe one client generation rather than a field-by-field mixture.
export function resolveRoomWire(client, map) {
  const roomResourceId = client?.roomRsc;
  const roomNameResourceId = client?.roomNameRsc;
  const roomSecurity = client?.room?.security;
  if (!uint32(roomResourceId) || roomResourceId === 0 ||
      !uint32(roomNameResourceId) || roomNameResourceId === 0 ||
      !uint32(roomSecurity)) return null;

  const rooms = map?.rooms;
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) return null;
  const matches = Object.values(rooms).filter(room => room && typeof room === 'object' &&
    room.roomRsc === roomResourceId && room.nameRsc === roomNameResourceId);
  if (matches.length !== 1) return null;

  const resolvedRoomNum = matches[0].num;
  if (!positiveInteger(resolvedRoomNum) || rooms[String(resolvedRoomNum)] !== matches[0])
    return null;
  return Object.freeze({
    resolved_room_num: resolvedRoomNum,
    room_resource_id: roomResourceId,
    room_security_u32: roomSecurity,
  });
}
