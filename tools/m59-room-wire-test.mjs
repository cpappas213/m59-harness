#!/usr/bin/env node
// Pure/offline: no socket, broker, roster, endpoint, or process.

import assert from 'node:assert/strict';
import { canonicalRoomWire, resolveRoomWire, sameRoomWire } from './m59-room-wire.mjs';

const SHARED_ROOM_RSC = 0xffff_ffff;
const GUEST_NAME_RSC = 0xffff_fffd;
const NEWB_NAME_RSC = 0xffff_fffe;
const map = { rooms: {
  1001: { num: 1001, name: 'The Inn of Hazar', roomRsc: SHARED_ROOM_RSC,
    nameRsc: GUEST_NAME_RSC },
  // Deliberately shares its .roo resource with the guest room. roomRsc alone
  // must never select the first row.
  1011: { num: 1011, name: 'Raza Inn', roomRsc: SHARED_ROOM_RSC,
    nameRsc: NEWB_NAME_RSC },
} };

const client = {
  roomRsc: SHARED_ROOM_RSC,
  roomNameRsc: NEWB_NAME_RSC,
  room: { id: 123456, security: 0xffff_ffff },
};
const exact = resolveRoomWire(client, map);
assert.deepEqual(exact, {
  resolved_room_num: 1011,
  room_resource_id: 0xffff_ffff,
  room_security_u32: 0xffff_ffff,
});
assert.equal(Object.isFrozen(exact), true, 'a captured provenance tuple is immutable');

assert.equal(resolveRoomWire({ ...client, room: { ...client.room, id: 999999 } }, map)
  .resolved_room_num, 1011, 'runtime object ids never participate in stable resolution');
assert.equal(resolveRoomWire({ ...client, roomNameRsc: GUEST_NAME_RSC }, map)
  .resolved_room_num, 1001, 'the complete resource pair disambiguates shared .roo resources');
assert.equal(resolveRoomWire({ ...client, roomNameRsc: null }, map), null,
  'roomRsc alone is not enough, even when a runtime object id is present');
assert.equal(resolveRoomWire({ ...client, roomRsc: null }, map), null,
  'roomNameRsc alone is not enough');
assert.equal(resolveRoomWire({ ...client, room: { ...client.room, security: 0 } }, map)
  .room_security_u32, 0, 'zero is a complete uint32 security checksum');

const duplicate = { rooms: { ...map.rooms,
  1012: { num: 1012, roomRsc: SHARED_ROOM_RSC, nameRsc: NEWB_NAME_RSC },
} };
assert.equal(resolveRoomWire(client, duplicate), null,
  'an ambiguous exact resource pair fails closed');
assert.equal(resolveRoomWire(client, { rooms: {
  wrong_key: { num: 1011, roomRsc: SHARED_ROOM_RSC, nameRsc: NEWB_NAME_RSC },
} }), null, 'the configured map key and resolved room number must agree');

for (const bad of [-1, -0, 0x1_0000_0000, 1.5, NaN, null]) {
  assert.equal(resolveRoomWire({ ...client, room: { ...client.room, security: bad } }, map), null,
    `invalid uint32 security ${String(bad)} fails closed`);
}
assert.equal(resolveRoomWire({ ...client, roomRsc: 0 }, map), null,
  'zero resource id cannot identify a bound live room');

assert.deepEqual(canonicalRoomWire(exact), exact, 'the exact closed tuple validates');
assert.equal(canonicalRoomWire({ ...exact, room_name_resource_id: NEWB_NAME_RSC }), null,
  'room_wire is closed; related internal resolver fields cannot leak into it');
assert.equal(sameRoomWire(exact, { ...exact }), true);
assert.equal(sameRoomWire(exact, { ...exact, room_security_u32: 1 }), false);

console.log('m59-room-wire-test: exact pair resolution and closed uint32 provenance passed');
