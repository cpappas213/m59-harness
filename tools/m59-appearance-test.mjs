#!/usr/bin/env node
// Offline regression for the local animation trigger token. These are real packed
// Meridian packets fed through M59Client; no broker, socket, or server is involved.

import assert from 'node:assert/strict';
import { M59Client } from './m59-client.mjs';

const BP = { ROOM_CONTENTS: 134, MOVE: 200, TURN: 201, CREATE: 217, CHANGE: 219 };
const u8 = value => Buffer.from([value & 0xff]);
const u16 = value => { const out = Buffer.alloc(2); out.writeUInt16LE(value & 0xffff); return out; };
const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; };
const i32 = value => { const out = Buffer.alloc(4); out.writeInt32LE(value); return out; };

// ExtractObject with no palette prefix, ANIMATE_NONE group 1, and no overlays.
const object = ({ id, icon = 950, name = 900 }) => Buffer.concat([
  u32(id), u32(icon), u32(name), u32(0), i32(0),
  u16(0),                    // LIGHT_FLAG_NONE
  u8(1), u16(1),            // base ANIMATE_NONE, group 1
  u8(0),                     // base overlay count
]);
const motion = () => Buffer.concat([u8(1), u16(2), u8(0)]);
const roomObject = (value) => Buffer.concat([
  object(value), u16(value.y), u16(value.x), u16(value.angle), motion(),
]);
const changedObject = value => Buffer.concat([object(value), motion()]);

const resources = new Map([[900, 'Kermit'], [901, 'rat'],
  [950, 'bta.bgf'], [951, 'rat.bgf'], [952, 'attack.bgf']]);
const client = new M59Client({ resources, verbose: false });

client.onGameMessage(BP.ROOM_CONTENTS, Buffer.concat([
  u32(800), u16(1), roomObject({ id: 501, x: 672, y: 736, angle: 1024 }),
]));
const initial = client.room.objects.get(501);
assert.equal(initial.appearanceRevision, 1);

const attack = changedObject({ id: 501, icon: 952 });
client.onGameMessage(BP.CHANGE, attack);
const firstAttackRevision = initial.appearanceRevision;
assert.equal(firstAttackRevision, 2);
assert.equal(initial.iconRsc, 952);

// An identical one-shot program is a new attack. Its bytes and resulting descriptor
// are the same, so only this token tells a renderer to restart the local animation.
client.onGameMessage(BP.CHANGE, attack);
assert.equal(initial.appearanceRevision, 3);
assert.equal(initial.iconRsc, 952);

client.onGameMessage(BP.MOVE, Buffer.concat([u32(501), u16(800), u16(864), u8(18)]));
client.onGameMessage(BP.TURN, Buffer.concat([u32(501), u16(2048)]));
assert.equal(initial.appearanceRevision, 3, 'movement and facing do not restart animation programs');

client.onGameMessage(BP.CREATE,
  roomObject({ id: 600, icon: 951, name: 901, x: 800, y: 736, angle: 2048 }));
assert.equal(client.room.objects.get(600).appearanceRevision, 4);

console.log('m59 appearance revision: 7 assertions passed on packed offline packets');
