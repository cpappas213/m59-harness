#!/usr/bin/env node
// Offline-only producer tests.  No broker, keeper, roster, Meridian session, or
// network endpoint is opened here.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  AtlasMapGeneration,
  geometryManifestForRooms,
} from './m59-atlas-topology.mjs';
import {
  RoomSceneV3Error,
  RoomSceneV3Store,
  RTS_SCENE_BINDING_SCHEMA,
  RTS_SCENE_V3_SCHEMA,
  toNativeRoomSceneV3,
} from './m59-rts-scene-v3.mjs';
import { RoomSceneStore, toNativeRoomScene } from './m59-rts-scene.mjs';
import { DEFAULT_ROO_DIRS } from './m59-roo.mjs';

const plane = Buffer.from([1, 2, 3, 4]).toString('base64');
const collisionDigest = '35'.repeat(32);

function fixtureRoom() {
  return {
    num: 200,
    objId: 800,
    cls: 'MarionRoom',
    rsc: 'room_α!',
    roomRsc: 0xffffffff,
    name: "Meridian ! ' α",
    nameRsc: 700,
    rooFile: 'marion hall!.roo',
    rows: 2,
    cols: 2,
    flags: 0,
    edgeExits: [],
    goExits: [],
    yellZone: [],
    roo: {
      file: 'marion hall!.roo',
      security: 0xffffffff,
      version: 13,
      rows: 2,
      cols: 2,
      grid: plane,
      flags: plane,
      monsterGrid: plane,
      walls: [[0, 0, 2048, 0, 1]],
      sectors: [{
        id: 1,
        serverId: 71,
        floorType: 301,
        ceilingType: 302,
        tx: 4,
        ty: 5,
        floorHeight: 160,
        ceilingHeight: 3200,
        light: 192,
        flags: 0,
        speed: 0,
        depth: 0,
        slopedFloor: null,
        slopedCeiling: null,
      }],
      leaves: [{
        node: 2,
        sector: 1,
        bbox: [0, 0, 2048, 1024],
        polygon: [[0, 0], [2048, 0], [2048, 1024], [0, 1024]],
      }],
      collision: { digest: collisionDigest },
    },
  };
}

function fixtureMap(room = fixtureRoom()) {
  const rooms = { [room.num]: room };
  return {
    ...geometryManifestForRooms(rooms),
    geometrySource: 'synthetic offline scene-v3 fixture',
    rooms,
  };
}

function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function rehydrationGeometry(roo) {
  return {
    collisionReady: true,
    toJSON(options) {
      assert.deepEqual(options, {
        includeWalls: true,
        includeSurfaces: true,
        includeCollision: true,
      });
      return clone(roo);
    },
  };
}

function facade(generation, { binding, source } = {}) {
  return Object.freeze({
    artifact: generation.artifact,
    summary: generation.summary,
    map_build_identity: generation.map_build_identity,
    room_numbers: generation.room_numbers,
    getRoomBinding: number => number === 200
      ? (binding === undefined ? generation.getRoomBinding(number) : binding)
      : null,
    getRoomSource: number => number === 200
      ? (source === undefined ? generation.getRoomSource(number) : source)
      : null,
  });
}

// ---------------------------------------------------------------- bound baked scene

const input = fixtureMap();
const generation = AtlasMapGeneration.fromMap(input);
const bakedLoadedRoo = clone(input.rooms['200'].roo);
const bakedLoadCalls = [];
const store = new RoomSceneV3Store(generation, {
  loadRooImpl: (file, dirs, options) => {
    bakedLoadCalls.push({ file, dirs, options });
    return rehydrationGeometry(bakedLoadedRoo);
  },
});
assert.deepEqual(bakedLoadCalls, [{
  file: 'marion hall!.roo',
  dirs: undefined,
  options: { strict: true },
}], 'even baked surfaces require one strict local ROO verification');
assert.deepEqual(store.status, {
  ready: true,
  map_build_identity: generation.map_build_identity,
  geometry_room_count: 1,
  scenes_ready: 1,
  scenes_conflict: 0,
  scenes_unavailable: 0,
});

const ready = store.getResult(200);
assert.equal(ready.ok, true);
assert.strictEqual(store.get(200), ready.scene);
assert.strictEqual(store.require(200), ready.scene);
const scene = ready.scene;
assert.equal(scene.schema, RTS_SCENE_V3_SCHEMA);
assert.deepEqual(scene.binding, {
  schema: RTS_SCENE_BINDING_SCHEMA,
  atlas_schema: 'M59ATLAS/1',
  geometry_manifest_sha256: generation.summary.source_geometry_manifest_sha256,
  topology_records_sha256: generation.summary.source_topology_records_sha256,
  atlas_artifact_sha256: generation.summary.sha256,
  geometry_room_count: 1,
  room_resource_id: 0xffffffff,
  room_resource_symbol: 'room_α!',
  static_token_kind: 'roo-security-u32',
  static_token: String(0xffffffff),
  roo_security_u32: 0xffffffff,
});
assert.ok(Object.isFrozen(scene));
assert.ok(Object.isFrozen(scene.binding));
assert.ok(Object.isFrozen(scene.surfaces));
assert.ok(Object.isFrozen(scene.surfaces.leaves[0].polygon));
assert.throws(() => { scene.binding.roo_security_u32 = 7; }, TypeError,
  'a cached bound scene cannot be semantically mutated');

const staleBakedInput = fixtureMap();
const verifiedBakedRoo = clone(staleBakedInput.rooms['200'].roo);
staleBakedInput.rooms['200'].roo.sectors[0].floorHeight = 9999;
const staleBakedGeneration = AtlasMapGeneration.fromMap(staleBakedInput);
const staleBakedStore = new RoomSceneV3Store(staleBakedGeneration, {
  loadRooImpl: () => rehydrationGeometry(verifiedBakedRoo),
});
assert.equal(staleBakedStore.require(200).surfaces.sectors[0].floor_height, 160,
  'verified local geometry, not unchecked baked surfaces, owns the bound scene');

const native = toNativeRoomSceneV3(scene);
const lines = native.trimEnd().split('\n');
assert.match(lines[0],
  /^M59ROOM\t3\t200\tMeridian%20%21%20%27%20%CE%B1\tmarion%20hall%21\.roo\t13\t2\t2\t1024\t1024\t64\tclockwise-looking-down$/);
assert.equal(lines[1], [
  'M59BIND',
  '1',
  'M59ATLAS%2F1',
  generation.summary.source_geometry_manifest_sha256,
  generation.summary.source_topology_records_sha256,
  generation.summary.sha256,
  '1',
  String(0xffffffff),
  'room_%CE%B1%21',
  'roo-security-u32',
  String(0xffffffff),
  String(0xffffffff),
].join('\t'));
assert.equal(lines.filter(line => line.startsWith('M59ROOM\t')).length, 1);
assert.equal(lines.filter(line => line.startsWith('M59BIND\t')).length, 1);
assert.ok(lines[2].startsWith('PLANE\tgrid\t'), 'M59BIND immediately follows M59ROOM');
assert.equal(lines.at(-1), 'ENDROOM');
assert.doesNotMatch(native, /^M59ROOM\t2\t/m);

// A preferred basename hit may be a different local revision. Continue in the
// configured directory order and keep the first strict candidate matching the
// frozen generation token (the public duke3.roo split exercises this exact case).
const staleBakedRoo = clone(bakedLoadedRoo);
staleBakedRoo.security = 7;
const candidateCalls = [];
const candidateStore = new RoomSceneV3Store(generation, {
  loadRooImpl: (file, dirs, options) => {
    candidateCalls.push({ file, dirs, options });
    return rehydrationGeometry(dirs === undefined ? staleBakedRoo : bakedLoadedRoo);
  },
});
assert.equal(candidateStore.getResult(200).ok, true);
assert.deepEqual(candidateCalls, [{
  file: 'marion hall!.roo',
  dirs: undefined,
  options: { strict: true },
}, {
  file: 'marion hall!.roo',
  dirs: [DEFAULT_ROO_DIRS[0]],
  options: { strict: true },
}]);
assert.equal(candidateStore.get(200).binding.roo_security_u32, 0xffffffff);

// The deployed v2 seam is still independently v2 and has no binding record.
const legacyScene = new RoomSceneStore(input).get(200);
const legacyNative = toNativeRoomScene(legacyScene);
assert.match(legacyNative, /^M59ROOM\t2\t/);
assert.doesNotMatch(legacyNative, /^M59BIND\t/m);

// The caller's map is not retained: changing it after generation creation cannot
// change the frozen scene or any of its binding hashes.
input.rooms['200'].rsc = 'mutated_after_generation';
input.rooms['200'].roo.security = 7;
assert.strictEqual(store.get(200), scene);
assert.equal(scene.binding.room_resource_symbol, 'room_α!');
assert.equal(scene.binding.roo_security_u32, 0xffffffff);

// ---------------------------------------------------------------- lookup and no downgrade

assert.deepEqual(store.getResult(999), {
  ok: false,
  kind: 'not-found',
  status: 404,
  code: 'scene-v3-room-not-found',
  room: 999,
  message: 'room 999 is not in the frozen map generation',
});
assert.equal(store.get(999), null);
assert.equal(store.getResult(0).status, 400);
assert.throws(() => store.require(999), error =>
  error instanceof RoomSceneV3Error && error.status === 404 &&
  error.code === 'scene-v3-room-not-found');

// ---------------------------------------------------------------- closed/mutation validation

for (const mutate of [
  candidate => { candidate.schema = 'm59-rts-scene/v2'; },
  candidate => { candidate.binding.atlas_artifact_sha256 = 'AA'.repeat(32); },
  candidate => { candidate.binding.static_token = '7'; },
  candidate => { candidate.binding.roo_security_u32 = 7; },
  candidate => { candidate.binding.room_resource_id = 0; },
  candidate => { candidate.binding.room_resource_symbol = '\ud800'; },
  candidate => { candidate.binding.unexpected = 'field'; },
]) {
  const candidate = clone(scene);
  mutate(candidate);
  assert.throws(() => toNativeRoomSceneV3(candidate), error =>
    error instanceof RoomSceneV3Error && error.status === 409 &&
    error.code === 'scene-v3-binding-conflict');
}

// ---------------------------------------------------------------- verified legacy surface rehydration

const unbakedRoom = fixtureRoom();
const exactLoadedRoo = clone(unbakedRoom.roo);
delete unbakedRoom.roo.sectors;
delete unbakedRoom.roo.leaves;
const unbakedGeneration = AtlasMapGeneration.fromMap(fixtureMap(unbakedRoom));
const loadCalls = [];
const rehydrated = new RoomSceneV3Store(unbakedGeneration, {
  loadRooImpl: (file, dirs, options) => {
    loadCalls.push({ file, dirs, options });
    return rehydrationGeometry(exactLoadedRoo);
  },
});
assert.deepEqual(loadCalls, [{
  file: 'marion hall!.roo',
  dirs: undefined,
  options: { strict: true },
}]);
assert.equal(rehydrated.getResult(200).ok, true);
assert.equal(rehydrated.get(200).surfaces.leaves.length, 1);

function rehydrationResult(change, loader = null) {
  const loaded = clone(exactLoadedRoo);
  change?.(loaded);
  const candidate = new RoomSceneV3Store(unbakedGeneration, {
    loadRooImpl: loader ?? (() => rehydrationGeometry(loaded)),
  });
  return candidate.getResult(200);
}

for (const change of [
  roo => { roo.file = 'other.roo'; },
  roo => { roo.rows = 3; },
  roo => { roo.security = 0x7fffffff; },
  roo => { roo.version = 12; },
  roo => { delete roo.sectors; },
]) {
  const result = rehydrationResult(change);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'conflict');
  assert.equal(result.status, 409);
  assert.throws(() => {
    const mismatch = new RoomSceneV3Store(unbakedGeneration, {
      loadRooImpl: () => rehydrationGeometry((() => {
        const loaded = clone(exactLoadedRoo);
        change(loaded);
        return loaded;
      })()),
    });
    mismatch.get(200);
  }, error => error instanceof RoomSceneV3Error && error.status === 409);
}

for (const loader of [
  () => null,
  () => { throw new Error('fixture parse failure'); },
  () => ({ collisionReady: true, toJSON: () => { throw new Error('fixture projection failure'); } }),
]) {
  const result = rehydrationResult(null, loader);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.status, 503);
}

// Security-token rooms deliberately ignore a collision digest difference: the
// checked map's baked digest carries graph-entry/edge-direction provenance that a
// strict local ROO projection does not. Full uint32 ROO security is authoritative.
const movementDigestLoaded = clone(exactLoadedRoo);
movementDigestLoaded.collision.digest = '36'.repeat(32);
const movementDigestStore = new RoomSceneV3Store(unbakedGeneration, {
  loadRooImpl: () => rehydrationGeometry(movementDigestLoaded),
});
assert.equal(movementDigestStore.getResult(200).ok, true);
assert.equal(movementDigestStore.get(200).binding.roo_security_u32, 0xffffffff);

// A collision-only atlas token is exact. Its strict local ROO supplies the
// mandatory full security value only after that digest has matched.
const collisionOnly = fixtureRoom();
delete collisionOnly.roo.security;
const collisionLoaded = clone(collisionOnly.roo);
collisionLoaded.security = 0x81234567;
const collisionOnlyStore = RoomSceneV3Store.fromMap(fixtureMap(collisionOnly), {
  loadRooImpl: () => rehydrationGeometry(collisionLoaded),
});
assert.equal(collisionOnlyStore.getResult(200).ok, true);
assert.deepEqual({
  kind: collisionOnlyStore.get(200).binding.static_token_kind,
  token: collisionOnlyStore.get(200).binding.static_token,
  security: collisionOnlyStore.get(200).binding.roo_security_u32,
}, {
  kind: 'collision-sha256',
  token: collisionDigest,
  security: 0x81234567,
});

const wrongCollisionLoaded = clone(collisionLoaded);
wrongCollisionLoaded.collision.digest = '36'.repeat(32);
const wrongCollisionStore = RoomSceneV3Store.fromMap(fixtureMap(collisionOnly), {
  loadRooImpl: () => rehydrationGeometry(wrongCollisionLoaded),
});
assert.equal(wrongCollisionStore.getResult(200).kind, 'conflict');
assert.match(wrongCollisionStore.getResult(200).message, /does not match its collision token/);

// ---------------------------------------------------------------- generation/source conflict classification

const badBinding = frozen({ ...generation.getRoomBinding(200), room_resource_symbol: 'wrong' });
const badBindingStore = new RoomSceneV3Store(facade(generation, { binding: badBinding }), {
  loadRooImpl: () => { throw new Error('not reached'); },
});
assert.equal(badBindingStore.getResult(200).status, 409);
assert.equal(badBindingStore.status.scenes_conflict, 1);

const missingBindingStore = new RoomSceneV3Store(facade(generation, { binding: null }), {
  loadRooImpl: () => { throw new Error('not reached'); },
});
assert.equal(missingBindingStore.getResult(200).status, 409);

const badSummary = Object.freeze({ ...generation.summary, sha256: '00'.repeat(32) });
const badGeneration = Object.freeze({
  artifact: generation.artifact,
  summary: badSummary,
  map_build_identity: generation.map_build_identity,
  room_numbers: generation.room_numbers,
  getRoomBinding: number => generation.getRoomBinding(number),
  getRoomSource: number => generation.getRoomSource(number),
});
assert.throws(() => new RoomSceneV3Store(badGeneration), error =>
  error instanceof RoomSceneV3Error && error.status === 503 &&
  error.code === 'scene-v3-producer-unavailable');

// Explicit opt-in release gate for the checked public map. It is fully offline,
// but not part of the fast fixture pass because it strictly parses every installed
// ROO and can take several minutes on a cold filesystem cache.
if (process.env.M59_RTS_CHECKED_MAP_SCENES === '1') {
  const mapPath = fileURLToPath(new URL('../substrate/m59-map.json', import.meta.url));
  const checkedGeneration = AtlasMapGeneration.fromFile(mapPath);
  const checkedStore = new RoomSceneV3Store(checkedGeneration);
  assert.equal(checkedStore.status.ready, true,
    `checked map must be scene-v3 ready: ${JSON.stringify(checkedStore.status)}`);
  assert.equal(checkedStore.status.scenes_ready, checkedGeneration.summary.rooms);
  console.log(`m59 RTS scene v3: checked public map ${checkedGeneration.summary.sha256} ready`);
}

console.log('m59 RTS scene v3: frozen atlas binding, strict native order, rehydration, and failures passed');
