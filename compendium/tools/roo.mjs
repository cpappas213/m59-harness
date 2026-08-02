// roo.mjs -- read the wall geometry out of a .roo room file and draw the
// top-down map the client's own minimap draws.
//
// Format, from clientd3d/bspload.c BSPRooFileLoad:
//
//   "ROO\xB1"            magic
//   int32 version        client requires >= 10; >= 13 stores coordinates as floats
//   int32 security       checksum, also the room's unique id
//   int32 main_offset    seek here
//   at main_offset:
//     int32 width, height        FINENESS units; rows/cols = >> LOG_FINENESS (4)
//     int32 node_pos, wall_pos, ?, sidedef_pos, sector_pos
//   at wall_pos:
//     int16 num_walls, then per wall:
//       int16 next_num, pos_sidedef, neg_sidedef
//       4×4   x0, y0, x1, y1        int32 before version 13, float from 13
//       2 or 4 length              int16 before version 13, float from 13
//       int16 pos_xoff, neg_xoff, pos_yoff, neg_yoff
//       int16 pos_sector, neg_sector
//
// A wall with a sector on both sides is a passage between two areas of the same
// room; a wall with only one is the outer shell. Drawing them differently is
// what makes the result read as a map rather than a scribble.

import fs from 'node:fs';

// clientd3d/drawdefs.h:43 — 1024 fine units per grid square.
const LOG_FINENESS = 10;

export function readRoo(file) {
  const b = fs.readFileSync(file);
  if (b.length < 16 || b[0] !== 0x52 || b[1] !== 0x4f || b[2] !== 0x4f || b[3] !== 0xb1) {
    throw new Error('not a roo file');
  }
  const version = b.readInt32LE(4);
  const security = b.readInt32LE(8);
  const mainPos = b.readInt32LE(12);
  if (mainPos <= 0 || mainPos + 24 > b.length) throw new Error('bad main offset');

  let p = mainPos;
  const width = b.readInt32LE(p); p += 4;
  const height = b.readInt32LE(p); p += 4;
  const nodePos = b.readInt32LE(p); p += 4;
  const wallPos = b.readInt32LE(p); p += 4;
  p += 4;                                   // unused section pointer
  const sidedefPos = b.readInt32LE(p); p += 4;
  const sectorPos = b.readInt32LE(p); p += 4;

  const wide = version >= 13;
  const readCoord = (off) => (wide ? b.readFloatLE(off) : b.readInt32LE(off));

  if (wallPos <= 0 || wallPos + 2 > b.length) throw new Error('bad wall offset');
  let q = wallPos;
  const numWalls = b.readUInt16LE(q); q += 2;
  const walls = [];
  const recLen = 2 + 2 + 2 + 16 + (wide ? 4 : 2) + 8 + 4;
  for (let i = 0; i < numWalls; i++) {
    if (q + recLen > b.length) break;
    q += 2;                                          // next_num
    const posSidedef = b.readUInt16LE(q); q += 2;
    const negSidedef = b.readUInt16LE(q); q += 2;
    const x0 = readCoord(q); q += 4;
    const y0 = readCoord(q); q += 4;
    const x1 = readCoord(q); q += 4;
    const y1 = readCoord(q); q += 4;
    q += wide ? 4 : 2;                               // length
    q += 8;                                          // texture offsets
    const posSector = b.readUInt16LE(q); q += 2;
    const negSector = b.readUInt16LE(q); q += 2;
    walls.push({ x0, y0, x1, y1, posSector, negSector, posSidedef, negSidedef });
  }

  return {
    version, security, width, height,
    rows: height >> LOG_FINENESS, cols: width >> LOG_FINENESS,
    numWalls, walls, nodePos, wallPos, sidedefPos, sectorPos,
  };
}

// A wall that separates two sectors is something you can see past or walk
// through; a wall with one side is solid. The client's automap makes the same
// distinction, which is why its maps are readable.
export function isSolid(w) {
  return !(w.posSector && w.negSector);
}

// ---------------------------------------------------------------- drawing

// SVG rather than a bitmap: these are line drawings, they scale, they are a
// tenth the size, and they stay legible in both colour themes because the
// stroke can be `currentColor`.
export function rooToSVG(roo, { max = 760, pad = 8, marks = [], regions = [] } = {}) {
  const solid = [], portal = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of roo.walls) {
    if (!isFinite(w.x0) || !isFinite(w.y0) || !isFinite(w.x1) || !isFinite(w.y1)) continue;
    minX = Math.min(minX, w.x0, w.x1); maxX = Math.max(maxX, w.x0, w.x1);
    minY = Math.min(minY, w.y0, w.y1); maxY = Math.max(maxY, w.y0, w.y1);
    (isSolid(w) ? solid : portal).push(w);
  }
  if (!isFinite(minX)) return null;

  const w0 = Math.max(1, maxX - minX), h0 = Math.max(1, maxY - minY);
  const scale = Math.min(max / w0, max / h0);
  const W = Math.round(w0 * scale) + pad * 2;
  const H = Math.round(h0 * scale) + pad * 2;
  // Room coordinates run y-down in the file and the client draws them y-down
  // too, so no flip is needed.
  const X = (x) => (x - minX) * scale + pad;
  const Y = (y) => (y - minY) * scale + pad;
  const path = (list) => list.map((w) =>
    `M${X(w.x0).toFixed(1)} ${Y(w.y0).toFixed(1)}L${X(w.x1).toFixed(1)} ${Y(w.y1).toFixed(1)}`).join('');

  // Marks are room grid coordinates (row, col) as kod uses them; the file’s
  // units are FINENESS-scaled, so multiply back up and centre in the square.
  const F = 1 << LOG_FINENESS;
  const markSvg = marks.map((m) => {
    const mx = X((m.col + 0.5) * F), my = Y((m.row + 0.5) * F);
    if (mx < 0 || my < 0 || mx > W || my > H) return '';
    return `<g class="mk mk-${m.kind || 'x'}"><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4"/>` +
      (m.label ? `<title>${String(m.label).replace(/[<&]/g, '')}</title>` : '') + `</g>`;
  }).join('');

  // Trigger regions are grid rectangles, inclusive at both ends, so the drawn
  // box runs from the near edge of the first square to the far edge of the last.
  const regionSvg = regions.map((g, i) => {
    const x0 = X(g.minCol * F), y0 = Y(g.minRow * F);
    const x1 = X((g.maxCol + 1) * F), y1 = Y((g.maxRow + 1) * F);
    const label = String(g.label || '').replace(/[<&]/g, '');
    return `<g class="rg rg-${i % 4}">` +
      `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}"/>` +
      `<title>${label} — rows ${g.minRow}–${g.maxRow}, columns ${g.minCol}–${g.maxCol}</title></g>`;
  }).join('');

  return `<svg class="roomap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img">` +
    regionSvg +
    `<path class="portal" d="${path(portal)}"/>` +
    `<path class="solid" d="${path(solid)}"/>` +
    markSvg +
    `</svg>`;
}
