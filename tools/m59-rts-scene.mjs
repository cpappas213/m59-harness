// Static Meridian room geometry projection for native RTS renderers.
//
// Native v2 is a percent-encoded, tab-delimited stream:
//   M59ROOM 2 room name resource roo_version rows cols xy_scale z_scale tx_scale winding
//   PLANE   grid|flags|monster base64
//   SECTOR  id server_id floor_tex ceiling_tex tx ty floor_z ceiling_z light flags speed depth
//   SLOPE   sector floor|ceiling a b c d x0 y0 texture_angle
//   LEAF    node sector bbox_x0 bbox_y0 bbox_x1 bbox_y1 "x,y;x,y;..."
//   WALL    x0 y0 x1 y1 flags
//   ENDROOM
//
// ROO x/y and slope values are left untouched (1024 units per square in client
// space), flat heights are already converted to that same scale, and the compact
// sector texture origins remain in their stored KOD scale (64 units per square).

import { readFileSync } from 'node:fs';
import { loadRoo } from './m59-roo.mjs';

export const RTS_SCENE_SCHEMA = 'm59-rts-scene/v2';
export const RTS_SCENE_NATIVE_VERSION = 2;

const MAX_SECTORS = 0xffff;
const MAX_LEAVES = 0xffff;
const MAX_WALLS = 0xffff;
const MAX_LEAF_POINTS = 20; // clientd3d/bsp.h MAX_NPTS
const MAX_TEXT_LENGTH = 4096;

const finiteInteger = value => Number.isInteger(value) ? value : null;
const finiteNumber = value => Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value : '';

const integerIn = (value, lo, hi) =>
  Number.isInteger(value) && value >= lo && value <= hi ? value : null;

function rooSlope(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const key of ['a', 'b', 'c', 'd', 'x0', 'y0']) {
    const n = finiteNumber(value[key]);
    if (n === null) return undefined;
    out[key] = n;
  }
  if (out.c === 0) return undefined;
  const angle = finiteInteger(value.textureAngle ?? 0);
  if (angle === null) return undefined;
  out.texture_angle = angle;
  return out;
}

// Convert the baked ROO representation into the public scene seam. This is strict
// when surface arrays are present: a leaf with a bad sector is worse than no scene,
// because it would paint a valid polygon with somebody else's height or texture.
// An older map with neither array remains usable and simply has no surfaces.
function rooSurfaces(roo) {
  if (roo.sectors === undefined && roo.leaves === undefined)
    return { sectors: [], leaves: [] };
  if (!Array.isArray(roo.sectors) || !Array.isArray(roo.leaves) ||
      roo.sectors.length > MAX_SECTORS || roo.leaves.length > MAX_LEAVES)
    return null;

  const sectors = [];
  for (let i = 0; i < roo.sectors.length; i++) {
    const raw = roo.sectors[i];
    if (!raw || typeof raw !== 'object') return null;
    const id = integerIn(raw.id ?? i + 1, 1, MAX_SECTORS);
    const serverId = integerIn(raw.serverId, 0, 0xffff);
    const floorTexture = integerIn(raw.floorType, 0, 0xffff);
    const ceilingTexture = integerIn(raw.ceilingType, 0, 0xffff);
    const tx = finiteInteger(raw.tx), ty = finiteInteger(raw.ty);
    const floorHeight = finiteInteger(raw.floorHeight);
    const ceilingHeight = finiteInteger(raw.ceilingHeight);
    const light = integerIn(raw.light, 0, 0xff);
    const flags = finiteInteger(raw.flags);
    const speed = integerIn(raw.speed, 0, 0xff);
    const depth = finiteInteger(raw.depth);
    const floorSlope = rooSlope(raw.slopedFloor);
    const ceilingSlope = rooSlope(raw.slopedCeiling);
    if (id !== i + 1 || serverId === null || floorTexture === null ||
        ceilingTexture === null || tx === null || ty === null ||
        floorHeight === null || ceilingHeight === null || light === null ||
        flags === null || speed === null || depth === null || depth < 0 ||
        floorSlope === undefined || ceilingSlope === undefined) return null;
    sectors.push({
      id, server_id: serverId,
      floor_texture: floorTexture, ceiling_texture: ceilingTexture,
      texture_origin: [tx, ty],
      floor_height: floorHeight, ceiling_height: ceilingHeight,
      light, flags, speed, depth,
      floor_slope: floorSlope, ceiling_slope: ceilingSlope,
    });
  }

  const leaves = [];
  const seenNodes = new Set();
  for (const raw of roo.leaves) {
    if (!raw || typeof raw !== 'object') return null;
    const node = integerIn(raw.node, 1, MAX_LEAVES);
    const sector = integerIn(raw.sector, 1, sectors.length);
    const bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4
      ? raw.bbox.map(finiteNumber) : null;
    const polygon = Array.isArray(raw.polygon) &&
                    raw.polygon.length >= 3 && raw.polygon.length <= MAX_LEAF_POINTS
      ? raw.polygon.map(point => Array.isArray(point) && point.length === 2
          ? point.map(finiteNumber) : null)
      : null;
    if (node === null || sector === null || seenNodes.has(node) || !bbox ||
        bbox.some(v => v === null) || !polygon ||
        polygon.some(point => !point || point.some(v => v === null))) return null;
    seenNodes.add(node);
    // Deliberately no rounding, sorting, or winding normalization. These are the raw
    // ROO vertices in their original order.
    leaves.push({ node, sector, bbox, polygon });
  }
  return { sectors, leaves };
}

export class RoomSceneStore {
  constructor(map) {
    this.rooms = map?.rooms && typeof map.rooms === 'object' ? map.rooms : {};
    // Room geometry is immutable for the lifetime of a map build. Normalize the
    // potentially thousands of leaves once per room, not once per HTTP request.
    this.cache = new Map();
  }

  static fromFile(path) {
    return new RoomSceneStore(JSON.parse(readFileSync(path, 'utf8')));
  }

  get(number) {
    const roomNum = Number(number);
    if (!Number.isInteger(roomNum)) return null;
    if (this.cache.has(roomNum)) return this.cache.get(roomNum);
    const remember = value => (this.cache.set(roomNum, value), value);
    const room = this.rooms[String(roomNum)];
    let roo = room?.roo;
    if (!room || !roo) return remember(null);
    // Maps built before scene v2 contain the movement planes and walls but no BSP
    // leaves. Rehydrate those immutable surfaces from the user's local .roo at the
    // first request instead of requiring an admin-backed map rebuild or mutating
    // the established navigation graph. loadRoo has its own path and decode cache.
    if ((!Array.isArray(roo.sectors) || !Array.isArray(roo.leaves)) && room.rooFile) {
      const geometry = loadRoo(room.rooFile);
      if (geometry) roo = geometry.toJSON();
    }
    const rows = integerIn(roo.rows ?? room.rows, 1, 4096);
    const cols = integerIn(roo.cols ?? room.cols, 1, 4096);
    const rooVersion = finiteInteger(roo.version);
    if (rows === null || cols === null || rooVersion === null) return remember(null);
    const cells = rows * cols;
    const plane = value => {
      if (typeof value !== 'string') return null;
      const bytes = Buffer.from(value, 'base64');
      return bytes.length === cells ? bytes.toString('base64') : null;
    };
    const grid = plane(roo.grid);
    const flags = plane(roo.flags);
    if (!grid || !flags) return remember(null);
    const surfaces = rooSurfaces(roo);
    if (!surfaces) return remember(null);
    return remember({
      schema: RTS_SCENE_SCHEMA,
      room: roomNum,
      name: text(room.name),
      resource: text(room.rooFile || roo.file),
      roo_version: rooVersion,
      rows,
      cols,
      planes: { grid, flags, monster: plane(roo.monsterGrid) },
      walls: (Array.isArray(roo.walls) ? roo.walls : []).filter(wall =>
        Array.isArray(wall) && wall.length === 5 && wall.every(Number.isInteger)),
      surfaces,
      coordinate_scale: 1024,
      height_scale: 1024,
      texture_origin_scale: 64,
      vertex_winding: 'clockwise-looking-down',
    });
  }
}

function encode(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const safe = typeof raw.toWellFormed === 'function'
    ? raw.toWellFormed()
    : raw.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  return encodeURIComponent(safe);
}

export function toNativeRoomScene(scene) {
  if (!scene || scene.schema !== RTS_SCENE_SCHEMA) throw new Error(`expected ${RTS_SCENE_SCHEMA}`);
  if (!Number.isInteger(scene.room) || !Number.isInteger(scene.roo_version) ||
      integerIn(scene.rows, 1, 4096) === null ||
      integerIn(scene.cols, 1, 4096) === null ||
      typeof scene.name !== 'string' || scene.name.length > MAX_TEXT_LENGTH ||
      typeof scene.resource !== 'string' || scene.resource.length > MAX_TEXT_LENGTH)
    throw new Error('invalid or unbounded room header');
  const cells = scene.rows * scene.cols;
  const maxPlaneChars = Math.ceil(cells / 3) * 4 + 4;
  const validPlane = value => typeof value === 'string' && value.length <= maxPlaneChars &&
    Buffer.from(value, 'base64').length === cells;
  if (!scene.planes || !validPlane(scene.planes.grid) || !validPlane(scene.planes.flags) ||
      (scene.planes.monster !== null && !validPlane(scene.planes.monster)))
    throw new Error('invalid room planes');
  if (!scene.surfaces || !Array.isArray(scene.surfaces.sectors) ||
      !Array.isArray(scene.surfaces.leaves) ||
      scene.surfaces.sectors.length > MAX_SECTORS || scene.surfaces.leaves.length > MAX_LEAVES)
    throw new Error('invalid or unbounded room surfaces');
  if (scene.coordinate_scale !== 1024 || scene.height_scale !== 1024 ||
      scene.texture_origin_scale !== 64 || scene.vertex_winding !== 'clockwise-looking-down')
    throw new Error('invalid room coordinate metadata');
  if (!Array.isArray(scene.walls) || scene.walls.length > MAX_WALLS ||
      scene.walls.some(wall => !Array.isArray(wall) || wall.length !== 5 ||
        wall.some(value => !Number.isInteger(value))))
    throw new Error('invalid or unbounded room walls');
  const lines = [];
  const line = (...fields) => lines.push(fields.map(encode).join('\t'));
  line('M59ROOM', RTS_SCENE_NATIVE_VERSION, scene.room, scene.name, scene.resource,
    scene.roo_version, scene.rows, scene.cols, scene.coordinate_scale, scene.height_scale,
    scene.texture_origin_scale, scene.vertex_winding);
  line('PLANE', 'grid', scene.planes.grid);
  line('PLANE', 'flags', scene.planes.flags);
  if (scene.planes.monster) line('PLANE', 'monster', scene.planes.monster);
  for (let i = 0; i < scene.surfaces.sectors.length; i++) {
    const sector = scene.surfaces.sectors[i];
    const slopeOk = slope => slope === null || (!!slope &&
      ['a', 'b', 'c', 'd', 'x0', 'y0'].every(key => Number.isFinite(slope[key])) &&
      slope.c !== 0 && Number.isInteger(slope.texture_angle));
    if (!sector || sector.id !== i + 1 || integerIn(sector.server_id, 0, 0xffff) === null ||
        integerIn(sector.floor_texture, 0, 0xffff) === null ||
        integerIn(sector.ceiling_texture, 0, 0xffff) === null ||
        !Array.isArray(sector.texture_origin) || sector.texture_origin.length !== 2 ||
        sector.texture_origin.some(value => !Number.isInteger(value)) ||
        !Number.isInteger(sector.floor_height) || !Number.isInteger(sector.ceiling_height) ||
        integerIn(sector.light, 0, 0xff) === null || !Number.isInteger(sector.flags) ||
        integerIn(sector.speed, 0, 0xff) === null || !Number.isInteger(sector.depth) || sector.depth < 0 ||
        !slopeOk(sector.floor_slope) || !slopeOk(sector.ceiling_slope))
      throw new Error(`invalid sector ${i + 1}`);
    line('SECTOR', sector.id, sector.server_id, sector.floor_texture, sector.ceiling_texture,
      sector.texture_origin[0], sector.texture_origin[1], sector.floor_height,
      sector.ceiling_height, sector.light, sector.flags, sector.speed, sector.depth);
    for (const [surface, slope] of [['floor', sector.floor_slope], ['ceiling', sector.ceiling_slope]]) {
      if (slope) line('SLOPE', sector.id, surface, slope.a, slope.b, slope.c, slope.d,
        slope.x0, slope.y0, slope.texture_angle);
    }
  }
  const seenNodes = new Set();
  for (const leaf of scene.surfaces.leaves) {
    if (!leaf || integerIn(leaf.node, 1, MAX_LEAVES) === null || seenNodes.has(leaf.node) ||
        integerIn(leaf.sector, 1, scene.surfaces.sectors.length) === null ||
        !Array.isArray(leaf.bbox) || leaf.bbox.length !== 4 ||
        leaf.bbox.some(value => !Number.isFinite(value)) ||
        !Array.isArray(leaf.polygon) || leaf.polygon.length < 3 ||
        leaf.polygon.length > MAX_LEAF_POINTS || leaf.polygon.some(point =>
          !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value))))
      throw new Error(`leaf ${leaf.node} has invalid polygon`);
    seenNodes.add(leaf.node);
    // One percent-encoded field keeps an entire polygon atomic on the tab protocol.
    // Semicolon/comma are safe after decoding because every coordinate is numeric.
    const polygon = leaf.polygon.map(([x, y]) => `${x},${y}`).join(';');
    line('LEAF', leaf.node, leaf.sector, ...leaf.bbox, polygon);
  }
  for (const wall of scene.walls) line('WALL', ...wall);
  line('ENDROOM');
  return lines.join('\n') + '\n';
}
