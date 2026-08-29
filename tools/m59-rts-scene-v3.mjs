// Strict, topology-bound Meridian room scenes for RTS consumers.
//
// This is deliberately additive to m59-rts-scene.mjs.  That module owns the
// deployed v2/`M59ROOM 2` contract, including its historical behavior.  V3 is
// built only from one validated AtlasMapGeneration and never falls back to v2.

import { createHash } from 'node:crypto';
import { AtlasMapGeneration, ATLAS_TOPOLOGY_SCHEMA } from './m59-atlas-topology.mjs';
import { DEFAULT_ROO_DIRS, loadRoo } from './m59-roo.mjs';
import {
  RoomSceneStore,
  RTS_SCENE_SCHEMA,
  toNativeRoomScene,
} from './m59-rts-scene.mjs';

export const RTS_SCENE_V3_SCHEMA = 'm59-rts-scene/v3';
export const RTS_SCENE_V3_NATIVE_VERSION = 3;
export const RTS_SCENE_BINDING_SCHEMA = 'm59-rts-atlas-binding/v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 4096;
const MAX_ATLAS_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_FIELD_BYTES = 32 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;

const GENERATION_BINDING_KEYS = Object.freeze([
  'room_num',
  'room_resource_id',
  'room_resource_symbol',
  'roo_file',
  'static_token_kind',
  'static_token_value',
  'rows',
  'cols',
  'roo_security_u32',
]);

const PUBLIC_BINDING_KEYS = Object.freeze([
  'schema',
  'atlas_schema',
  'geometry_manifest_sha256',
  'topology_records_sha256',
  'atlas_artifact_sha256',
  'geometry_room_count',
  'room_resource_id',
  'room_resource_symbol',
  'static_token_kind',
  'static_token',
  'roo_security_u32',
]);

const SCENE_KEYS = Object.freeze([
  'schema',
  'room',
  'name',
  'resource',
  'roo_version',
  'rows',
  'cols',
  'planes',
  'walls',
  'surfaces',
  'coordinate_scale',
  'height_scale',
  'texture_origin_scale',
  'vertex_winding',
  'binding',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`${label} does not have its exact closed field set`);
  return value;
}

function uint32(value, label, { nonzero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (nonzero ? 1 : 0) || value > UINT32_MAX)
    throw new Error(`${label} must be ${nonzero ? 'a nonzero ' : 'an '}unsigned 32-bit integer`);
  return value;
}

function positiveInt(value, label, maximum = 0x7fffffff) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label} must be an integer in 1..${maximum}`);
  return value;
}

function scalarText(value, label, {
  allowEmpty = false,
  controls = false,
  maxBytes = MAX_TEXT_BYTES,
} = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0))
    throw new Error(`${label} must be ${allowEmpty ? '' : 'non-empty '}text`);
  for (let index = 0; index < value.length; ++index) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        throw new Error(`${label} must contain only Unicode scalar values`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} must contain only Unicode scalar values`);
    }
  }
  if (!controls && /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`${label} must not contain controls`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes)
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function rooFile(value, label) {
  const result = scalarText(value, label);
  if (result === '.' || result === '..' || /[\\/:]/.test(result) ||
      !result.toLowerCase().endsWith('.roo'))
    throw new Error(`${label} must be an exact local .roo basename`);
  return result;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value))
    throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

// Percent-encode UTF-8 bytes, not UTF-16 code units.  Only RFC 3986 unreserved
// bytes remain literal; unlike encodeURIComponent this also escapes !'()*.
function percentEncode(value, label = 'native field') {
  const raw = scalarText(String(value), label, { allowEmpty: true, controls: true,
    maxBytes: MAX_NATIVE_FIELD_BYTES });
  let result = '';
  for (const byte of Buffer.from(raw, 'utf8')) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e ||
        byte === 0x5f || byte === 0x7e) {
      result += String.fromCharCode(byte);
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(kind, status, code, room, message) {
  return Object.freeze({ ok: false, kind, status, code, room, message });
}

export class RoomSceneV3Error extends Error {
  constructor(result, options = {}) {
    super(result?.message || 'room scene v3 failed', options);
    this.name = 'RoomSceneV3Error';
    this.kind = result?.kind || 'unavailable';
    this.status = result?.status || 503;
    this.code = result?.code || 'scene-v3-unavailable';
    this.room = result?.room ?? null;
    this.result = result;
  }
}

function asFailure(error, room, fallbackKind = 'conflict') {
  if (error instanceof RoomSceneV3Error) return error.result;
  const message = String(error?.message || error || 'unknown scene error').slice(0, 512);
  return fallbackKind === 'unavailable'
    ? failure('unavailable', 503, 'scene-v3-unavailable', room, message)
    : failure('conflict', 409, 'scene-v3-binding-conflict', room, message);
}

function generationMetadata(generation) {
  if (!generation || typeof generation.getRoomBinding !== 'function' ||
      typeof generation.getRoomSource !== 'function')
    throw new Error('scene v3 requires an AtlasMapGeneration');
  const summary = generation.summary;
  if (!Object.isFrozen(generation) || !Object.isFrozen(summary))
    throw new Error('atlas generation and summary must be frozen');
  if (summary?.schema !== ATLAS_TOPOLOGY_SCHEMA)
    throw new Error(`atlas generation must use ${ATLAS_TOPOLOGY_SCHEMA}`);
  const geometry = sha256(summary.source_geometry_manifest_sha256,
    'atlas source geometry manifest');
  const topology = sha256(summary.source_topology_records_sha256,
    'atlas source topology records');
  const artifactHash = sha256(summary.sha256, 'atlas artifact');
  const roomCount = positiveInt(summary.rooms, 'atlas room count', 4096);
  if (!Number.isSafeInteger(summary.bytes) || summary.bytes < 1 || summary.bytes > MAX_ATLAS_BYTES)
    throw new Error(`atlas artifact bytes must be in 1..${MAX_ATLAS_BYTES}`);
  if (typeof generation.artifact !== 'string' ||
      Buffer.byteLength(generation.artifact, 'utf8') !== summary.bytes ||
      createHash('sha256').update(generation.artifact).digest('hex') !== artifactHash)
    throw new Error('atlas artifact bytes do not match the frozen generation summary');
  const identity = [ATLAS_TOPOLOGY_SCHEMA, geometry, topology, artifactHash].join(':');
  if (generation.map_build_identity !== identity)
    throw new Error('atlas map-build identity does not match its derived component hashes');
  const roomNumbers = generation.room_numbers;
  if (!Array.isArray(roomNumbers) || !Object.isFrozen(roomNumbers) ||
      roomNumbers.length !== roomCount)
    throw new Error('atlas generation must expose one frozen room number per room');
  let previous = 0;
  for (const number of roomNumbers) {
    positiveInt(number, 'atlas room number');
    if (number <= previous) throw new Error('atlas room numbers must be unique and ascending');
    previous = number;
  }
  return Object.freeze({ geometry, topology, artifactHash, roomCount, identity,
    roomNumbers });
}

function generationRoom(binding, source, roomNumber) {
  exactKeys(binding, GENERATION_BINDING_KEYS, 'atlas room binding');
  if (!Object.isFrozen(binding) || !Object.isFrozen(source) || !Object.isFrozen(source?.roo))
    throw new Error('atlas room binding and source must be frozen');
  positiveInt(binding.room_num, 'binding room number');
  if (binding.room_num !== roomNumber || source.num !== roomNumber)
    throw new Error(`room ${roomNumber} number disagrees with its atlas source`);
  const resourceId = uint32(binding.room_resource_id, 'binding room resource id',
    { nonzero: true });
  const resourceSymbol = scalarText(binding.room_resource_symbol,
    'binding room resource symbol');
  const file = rooFile(binding.roo_file, 'binding ROO filename');
  const rows = positiveInt(binding.rows, 'binding rows', 4096);
  const cols = positiveInt(binding.cols, 'binding cols', 4096);
  if (source.roomRsc !== resourceId || source.rsc !== resourceSymbol ||
      source.rooFile !== file || source.roo?.file !== file ||
      source.rows !== rows || source.cols !== cols ||
      source.roo?.rows !== rows || source.roo?.cols !== cols)
    throw new Error(`room ${roomNumber} binding disagrees with its frozen map source`);

  const tokenKind = binding.static_token_kind;
  const tokenValue = binding.static_token_value;
  let security = null;
  if (tokenKind === 'roo-security-u32') {
    security = uint32(binding.roo_security_u32, 'binding ROO security');
    if (source.roo?.security !== security)
      throw new Error(`room ${roomNumber} ROO security disagrees with its frozen source`);
    if (tokenValue !== String(security))
      throw new Error(`room ${roomNumber} security token does not equal full ROO security`);
  } else if (tokenKind === 'collision-sha256') {
    if (binding.roo_security_u32 !== null || source.roo?.security != null)
      throw new Error(`room ${roomNumber} collision binding must derive ROO security locally`);
    sha256(tokenValue, `room ${roomNumber} collision token`);
    if (source.roo?.collision?.digest !== tokenValue)
      throw new Error(`room ${roomNumber} collision token disagrees with its frozen source`);
  } else {
    throw new Error(`room ${roomNumber} has unsupported static token kind`);
  }
  return Object.freeze({ roomNumber, resourceId, resourceSymbol, file, rows, cols,
    security, tokenKind, tokenValue });
}

function publicBinding(metadata, room) {
  return Object.freeze({
    schema: RTS_SCENE_BINDING_SCHEMA,
    atlas_schema: ATLAS_TOPOLOGY_SCHEMA,
    geometry_manifest_sha256: metadata.geometry,
    topology_records_sha256: metadata.topology,
    atlas_artifact_sha256: metadata.artifactHash,
    geometry_room_count: metadata.roomCount,
    room_resource_id: room.resourceId,
    room_resource_symbol: room.resourceSymbol,
    static_token_kind: room.tokenKind,
    static_token: room.tokenValue,
    roo_security_u32: room.security,
  });
}

function validatePublicBinding(binding, roomNumber) {
  exactKeys(binding, PUBLIC_BINDING_KEYS, 'scene v3 binding');
  if (binding.schema !== RTS_SCENE_BINDING_SCHEMA ||
      binding.atlas_schema !== ATLAS_TOPOLOGY_SCHEMA)
    throw new Error(`room ${roomNumber} has an unsupported scene binding schema`);
  sha256(binding.geometry_manifest_sha256, 'scene geometry manifest');
  sha256(binding.topology_records_sha256, 'scene topology records');
  sha256(binding.atlas_artifact_sha256, 'scene atlas artifact');
  positiveInt(binding.geometry_room_count, 'scene geometry room count', 4096);
  uint32(binding.room_resource_id, 'scene room resource id', { nonzero: true });
  scalarText(binding.room_resource_symbol, 'scene room resource symbol');
  const security = uint32(binding.roo_security_u32, 'scene ROO security');
  if (binding.static_token_kind === 'roo-security-u32') {
    if (binding.static_token !== String(security))
      throw new Error(`room ${roomNumber} scene security token does not equal ROO security`);
  } else if (binding.static_token_kind === 'collision-sha256') {
    sha256(binding.static_token, 'scene collision token');
  } else {
    throw new Error(`room ${roomNumber} has an unsupported scene static token kind`);
  }
  return binding;
}

function projectedLocalRoo(room, loadRooImpl, dirs) {
  let geometry;
  try {
    geometry = loadRooImpl(room.file, dirs, { strict: true });
  } catch (error) {
    throw new RoomSceneV3Error(failure('unavailable', 503, 'scene-v3-roo-unavailable',
      room.roomNumber, `room ${room.roomNumber} local ROO could not be verified: ${error.message}`),
      { cause: error });
  }
  if (!geometry || typeof geometry.toJSON !== 'function')
    throw new RoomSceneV3Error(failure('unavailable', 503, 'scene-v3-roo-unavailable',
      room.roomNumber, `room ${room.roomNumber} local ROO is unavailable`));

  let roo;
  try {
    roo = geometry.toJSON({ includeWalls: true, includeSurfaces: true,
      includeCollision: true });
  } catch (error) {
    throw new RoomSceneV3Error(failure('unavailable', 503, 'scene-v3-roo-unavailable',
      room.roomNumber, `room ${room.roomNumber} local ROO could not be projected: ${error.message}`),
      { cause: error });
  }
  return roo;
}

function matchingLocalRoo(source, room, loadRooImpl) {
  // Preserve the established loader call for the common case, then resolve a
  // basename collision generation-first: probe each configured directory in the
  // same stable order until one strict file matches the frozen token.  This is
  // required when a server/client/Steam tree contains different revisions of one
  // basename (duke3.roo is a real example).
  const directories = [...new Set(DEFAULT_ROO_DIRS.filter(directory =>
    typeof directory === 'string' && directory.length > 0))];
  const attempts = [undefined, ...directories.map(directory => [directory])];
  let conflict = null;
  let unavailable = null;
  for (const dirs of attempts) {
    try {
      const roo = projectedLocalRoo(room, loadRooImpl, dirs);
      if (!isRecord(roo) || !Array.isArray(roo.sectors) || !Array.isArray(roo.leaves))
        throw new Error(`room ${room.roomNumber} local ROO has no complete render surfaces`);
      const security = uint32(roo.security, `room ${room.roomNumber} local ROO security`);
      if (roo.file !== room.file || roo.rows !== room.rows || roo.cols !== room.cols)
        throw new Error(`room ${room.roomNumber} local ROO identity disagrees with the frozen binding`);
      if (source.roo.version !== undefined && roo.version !== source.roo.version)
        throw new Error(`room ${room.roomNumber} local ROO format version changed`);
      if (room.tokenKind === 'roo-security-u32') {
        if (security !== room.security)
          throw new Error(`room ${room.roomNumber} local ROO security changed`);
        // The frozen map collision digest may include graph-entry reachability and edge
        // direction provenance. Full ROO security is the static token for this path;
        // comparing that movement-derived digest would reject the same strict ROO.
      } else if (roo?.collision?.digest !== room.tokenValue) {
        throw new Error(`room ${room.roomNumber} local ROO does not match its collision token`);
      }
      return Object.freeze({ roo, security });
    } catch (error) {
      if (error instanceof RoomSceneV3Error && error.kind === 'unavailable')
        unavailable ??= error;
      else
        conflict ??= error;
    }
  }
  throw conflict ?? unavailable ?? new Error(`room ${room.roomNumber} has no local ROO candidate`);
}

function verifiedRoo(source, room, loadRooImpl) {
  const matched = matchingLocalRoo(source, room, loadRooImpl);
  const { roo, security } = matched;

  // Publish the exact projection that passed token-specific verification. The atlas
  // hashes do not independently cover every baked plane/wall/surface byte, so a
  // merely verified basename must never launder stale source.roo render geometry.
  return Object.freeze({ roo, security });
}

function normalizedScene(source, roo, room, binding) {
  scalarText(source.name ?? '', `room ${room.roomNumber} name`, { allowEmpty: true });
  // Ensure the permissive v2 store cannot perform its own unverified rehydration:
  // this room always reaches it with both surface arrays already present.
  const normalized = new RoomSceneStore({ rooms: {
    [room.roomNumber]: { ...source, roo },
  } }).get(room.roomNumber);
  if (!normalized)
    throw new Error(`room ${room.roomNumber} geometry does not satisfy the room-scene bounds`);
  if (normalized.room !== room.roomNumber || normalized.resource !== room.file ||
      normalized.rows !== room.rows || normalized.cols !== room.cols)
    throw new Error(`room ${room.roomNumber} normalized scene disagrees with its binding`);
  const scene = {
    ...normalized,
    schema: RTS_SCENE_V3_SCHEMA,
    binding,
  };
  validateSceneV3(scene);
  return deepFreeze(scene);
}

function validateSceneV3(scene) {
  exactKeys(scene, SCENE_KEYS, 'scene v3');
  if (scene.schema !== RTS_SCENE_V3_SCHEMA)
    throw new Error(`expected ${RTS_SCENE_V3_SCHEMA}`);
  const room = positiveInt(scene.room, 'scene room number');
  scalarText(scene.name, 'scene room name', { allowEmpty: true });
  rooFile(scene.resource, 'scene ROO filename');
  positiveInt(scene.rows, 'scene rows', 4096);
  positiveInt(scene.cols, 'scene cols', 4096);
  validatePublicBinding(scene.binding, room);
  return scene;
}

function strictNativeV2Lines(scene) {
  const legacy = toNativeRoomScene({ ...scene, schema: RTS_SCENE_SCHEMA });
  const lines = legacy.slice(0, -1).split('\n').map((rawLine, lineIndex) =>
    rawLine.split('\t').map((field, fieldIndex) => {
      let decoded;
      try { decoded = decodeURIComponent(field); }
      catch (error) {
        throw new Error(`legacy scene emitted an invalid field at ${lineIndex}:${fieldIndex}`,
          { cause: error });
      }
      return percentEncode(decoded, `native scene field ${lineIndex}:${fieldIndex}`);
    }));
  if (lines.length < 2 || lines[0][0] !== 'M59ROOM' || lines[0][1] !== '2' ||
      lines.at(-1).length !== 1 || lines.at(-1)[0] !== 'ENDROOM')
    throw new Error('legacy scene normalization emitted an invalid record envelope');
  lines[0][1] = String(RTS_SCENE_V3_NATIVE_VERSION);
  return lines;
}

export function toNativeRoomSceneV3(scene) {
  try {
    validateSceneV3(scene);
    const binding = scene.binding;
    const lines = strictNativeV2Lines(scene);
    const bind = [
      'M59BIND',
      '1',
      binding.atlas_schema,
      binding.geometry_manifest_sha256,
      binding.topology_records_sha256,
      binding.atlas_artifact_sha256,
      binding.geometry_room_count,
      binding.room_resource_id,
      binding.room_resource_symbol,
      binding.static_token_kind,
      binding.static_token,
      binding.roo_security_u32,
    ].map((field, index) => percentEncode(field, `M59BIND field ${index}`));
    lines.splice(1, 0, bind);
    return `${lines.map(fields => fields.join('\t')).join('\n')}\n`;
  } catch (error) {
    const room = Number.isSafeInteger(scene?.room) ? scene.room : null;
    throw new RoomSceneV3Error(asFailure(error, room), { cause: error });
  }
}

export class RoomSceneV3Store {
  #generation;
  #metadata;
  #results;
  #status;

  constructor(generation, { loadRooImpl = loadRoo } = {}) {
    if (typeof loadRooImpl !== 'function')
      throw new RoomSceneV3Error(failure('unavailable', 503, 'scene-v3-producer-unavailable',
        null, 'scene v3 requires a ROO loader'));
    this.#generation = generation;
    this.#results = new Map();
    try {
      this.#metadata = generationMetadata(generation);
    } catch (error) {
      throw new RoomSceneV3Error(failure('unavailable', 503,
        'scene-v3-producer-unavailable', null, error.message), { cause: error });
    }

    let ready = 0, conflicts = 0, unavailable = 0;
    for (const roomNumber of this.#metadata.roomNumbers) {
      let result;
      try {
        const binding = generation.getRoomBinding(roomNumber);
        const source = generation.getRoomSource(roomNumber);
        if (!binding || !source)
          throw new Error(`room ${roomNumber} is present without a complete atlas binding/source pair`);
        const room = generationRoom(binding, source, roomNumber);
        const verified = verifiedRoo(source, room, loadRooImpl);
        const verifiedRoom = Object.freeze({ ...room, security: verified.security });
        const sceneBinding = publicBinding(this.#metadata, verifiedRoom);
        const scene = normalizedScene(source, verified.roo, verifiedRoom, sceneBinding);
        result = Object.freeze({ ok: true, kind: 'scene', status: 200,
          code: 'scene-v3-ready', room: roomNumber, scene });
        ++ready;
      } catch (error) {
        result = asFailure(error, roomNumber);
        if (result.kind === 'unavailable') ++unavailable;
        else ++conflicts;
      }
      this.#results.set(roomNumber, result);
    }
    this.#status = Object.freeze({
      ready: conflicts === 0 && unavailable === 0,
      map_build_identity: this.#metadata.identity,
      geometry_room_count: this.#metadata.roomCount,
      scenes_ready: ready,
      scenes_conflict: conflicts,
      scenes_unavailable: unavailable,
    });
    Object.freeze(this);
  }

  static fromMap(map, { atlasLimits = {}, loadRooImpl = loadRoo } = {}) {
    return new RoomSceneV3Store(AtlasMapGeneration.fromMap(map, atlasLimits), { loadRooImpl });
  }

  get generation() {
    return this.#generation;
  }

  get status() {
    return this.#status;
  }

  getResult(roomNumber) {
    if (!Number.isSafeInteger(roomNumber) || roomNumber < 1 || roomNumber > 0x7fffffff)
      return failure('invalid', 400, 'scene-v3-invalid-room', null,
        'room number must be an integer in 1..2147483647');
    return this.#results.get(roomNumber) ??
      failure('not-found', 404, 'scene-v3-room-not-found', roomNumber,
        `room ${roomNumber} is not in the frozen map generation`);
  }

  get(roomNumber) {
    const result = this.getResult(roomNumber);
    if (result.ok) return result.scene;
    if (result.status === 404) return null;
    throw new RoomSceneV3Error(result);
  }

  require(roomNumber) {
    const result = this.getResult(roomNumber);
    if (result.ok) return result.scene;
    throw new RoomSceneV3Error(result);
  }
}
