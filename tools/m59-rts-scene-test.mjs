#!/usr/bin/env node
import assert from 'node:assert/strict';
import { RoomSceneStore, toNativeRoomScene } from './m59-rts-scene.mjs';

const bytes = Buffer.from([1, 2, 3, 4]).toString('base64');
const store = new RoomSceneStore({ rooms: { 200: {
  num: 200, name: 'Marion\tHall%', rooFile: 'marion room\n.roo', rows: 2, cols: 2,
  roo: { version: 13, rows: 2, cols: 2, grid: bytes, flags: bytes,
    monsterGrid: bytes, walls: [[0, 0, 2048, 0, 1]],
    sectors: [
      { id: 1, serverId: 71, floorType: 301, ceilingType: 302, tx: 4, ty: 5,
        floorHeight: 160, ceilingHeight: 3200, light: 192, flags: 0, speed: 0,
        depth: 0, slopedFloor: null, slopedCeiling: null },
      { id: 2, serverId: 72, floorType: 401, ceilingType: 402, tx: 6, ty: 7,
        floorHeight: 320, ceilingHeight: 3520, light: 128, flags: 1024, speed: 2,
        depth: 204,
        slopedFloor: { a: 1.5, b: -2, c: 1024, d: -512000, x0: 1024.25, y0: 0,
          textureAngle: 64 },
        slopedCeiling: null },
    ],
    leaves: [
      { node: 2, sector: 2, bbox: [1024.25, 0, 2048, 1024],
        polygon: [[1024.25, 0], [2048, 0], [2048, 1024], [1024.25, 1024]] },
      { node: 3, sector: 1, bbox: [0, 0, 1024.25, 1024],
        polygon: [[0, 0], [1024.25, 0], [1024.25, 1024], [0, 1024]] },
    ] },
} } });
const scene = store.get(200);
assert.equal(scene.schema, 'm59-rts-scene/v2');
assert.equal(scene.room, 200);
assert.equal(scene.planes.grid, bytes);
assert.equal(scene.walls.length, 1);
assert.equal(scene.surfaces.sectors[1].floor_texture, 401);
assert.equal(scene.surfaces.sectors[1].floor_slope.texture_angle, 64);
assert.deepEqual(scene.surfaces.leaves[0].polygon,
  [[1024.25, 0], [2048, 0], [2048, 1024], [1024.25, 1024]]);
assert.ok(scene.surfaces.leaves.every(leaf => scene.surfaces.sectors[leaf.sector - 1].id === leaf.sector));
assert.strictEqual(store.get(200), scene);
assert.equal(store.get(999), null);
const native = toNativeRoomScene(scene);
assert.match(native,
  /^M59ROOM\t2\t200\tMarion%09Hall%25\tmarion%20room%0A.roo\t13\t2\t2\t1024\t1024\t64\tclockwise-looking-down\n/);
assert.match(native, /\nPLANE\tgrid\tAQIDBA%3D%3D\n/);
assert.match(native, /\nSECTOR\t2\t72\t401\t402\t6\t7\t320\t3520\t128\t1024\t2\t204\n/);
assert.match(native, /\nSLOPE\t2\tfloor\t1.5\t-2\t1024\t-512000\t1024.25\t0\t64\n/);
assert.match(native,
  /\nLEAF\t2\t2\t1024.25\t0\t2048\t1024\t1024.25%2C0%3B2048%2C0%3B2048%2C1024%3B1024.25%2C1024\n/);
assert.match(native, /\nWALL\t0\t0\t2048\t0\t1\n/);
assert.match(native, /\nENDROOM\n$/);

const badReference = structuredClone(store.rooms['200']);
badReference.roo.leaves[0].sector = 3;
assert.equal(new RoomSceneStore({ rooms: { 200: badReference } }).get(200), null);
const tooManyPoints = structuredClone(store.rooms['200']);
tooManyPoints.roo.leaves[0].polygon = Array.from({ length: 21 }, (_, i) => [i, i]);
assert.equal(new RoomSceneStore({ rooms: { 200: tooManyPoints } }).get(200), null);

const legacy = new RoomSceneStore({ rooms: { 201: {
  num: 201, name: 'Legacy', rooFile: 'legacy.roo', rows: 2, cols: 2,
  roo: { version: 12, rows: 2, cols: 2, grid: bytes, flags: bytes, walls: [] },
} } }).get(201);
assert.deepEqual(legacy.surfaces, { sectors: [], leaves: [] });
assert.doesNotThrow(() => toNativeRoomScene(legacy));

const unbounded = structuredClone(scene);
unbounded.surfaces.leaves[0].polygon = Array.from({ length: 21 }, (_, i) => [i, i]);
assert.throws(() => toNativeRoomScene(unbounded), /invalid polygon/);
console.log('m59 RTS room scene v2: surfaces, bounds, and native encoding passed');
