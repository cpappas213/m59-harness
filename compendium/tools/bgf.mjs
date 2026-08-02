#!/usr/bin/env node
// bgf.mjs -- decode Meridian 59 .bgf sprite files and write PNGs.
//
//   node tools/bgf.mjs all             extract group-0 frame of every bgf
//   node tools/bgf.mjs one <file.bgf>  dump one file's structure
//
// Format, straight out of makebgf/writebgf.c (writer) and clientd3d/dibutil.c
// (reader).  All integers are little-endian 32-bit unless noted.
//
//   magic  42 47 46 11
//   int32  version            (client requires >= 10)
//   char   name[32]
//   int32  num_bitmaps
//   int32  num_groups
//   int32  max_indices
//   int32  shrink             display divisor: a 128x256 bitmap with shrink 4
//                             draws at the size of a 32x64 one
//   per bitmap:
//     int32 width, height, xoffset, yoffset
//     byte  num_hotspots, then per hotspot: byte number, int32 x, int32 y
//     byte  compressed        1 = zlib, 0 = raw
//     int32 length            compressed byte count (0 when raw)
//     bytes width*height palette indices, row-major, top row first
//   per group:
//     int32 num_indices, then that many int32 1-based bitmap indices (0 = none)
//
// Group 0 is what the kod displays by default and what the client puts in
// description dialogs, so group 0 index 1 is the object's "icon".  Palette
// index 254 is transparent (clientd3d/draw3d.h TRANSPARENT_INDEX).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const M59 = process.env.M59_ROOT || 'C:/code/Meridian59';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// A checked-out source tree keeps the .bgf files under run/localclient/, but a
// shipped client (Steam, GOG) keeps them in resource/ beside the executable and
// carries no palette at all. tools/pull-client-assets.py finds both and points
// these two at whichever pair it found.
const RESDIR = process.env.M59_RESOURCE || path.join(M59, 'run/localclient/resource');
const PALETTE = process.env.M59_PALETTE || path.join(M59, 'blakston.pal');
const OUTDIR = path.join(HERE, '..', 'assets', 'img');
const TRANSPARENT = 254;

// ---------------------------------------------------------------- palette

export function loadPalette() {
  const txt = fs.readFileSync(PALETTE, 'latin1');
  const pal = txt.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number));
  if (pal.length !== 256) throw new Error(`palette has ${pal.length} entries`);
  return pal;
}

// ---------------------------------------------------------------- decode

export function readBGF(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b[0] !== 0x42 || b[1] !== 0x47 || b[2] !== 0x46 || b[3] !== 0x11) {
    throw new Error('not a bgf');
  }
  let p = 4;
  const version = b.readInt32LE(p); p += 4;
  const name = b.toString('latin1', p, p + 32).replace(/\0.*$/, ''); p += 32;
  const numBitmaps = b.readInt32LE(p); p += 4;
  const numGroups = b.readInt32LE(p); p += 4;
  const maxIndices = b.readInt32LE(p); p += 4;
  const shrink = b.readInt32LE(p); p += 4;

  const bitmaps = [];
  for (let i = 0; i < numBitmaps; i++) {
    const width = b.readInt32LE(p); p += 4;
    const height = b.readInt32LE(p); p += 4;
    const xoff = b.readInt32LE(p); p += 4;
    const yoff = b.readInt32LE(p); p += 4;
    const nh = b.readUInt8(p); p += 1;
    const hotspots = [];
    for (let h = 0; h < nh; h++) {
      const num = b.readInt8(p); p += 1;
      const x = b.readInt32LE(p); p += 4;
      const y = b.readInt32LE(p); p += 4;
      hotspots.push({ num, x, y });
    }
    const compressed = b.readUInt8(p); p += 1;
    const clen = b.readInt32LE(p); p += 4;
    let bits;
    if (compressed) {
      bits = zlib.inflateSync(b.subarray(p, p + clen));
      p += clen;
    } else {
      bits = b.subarray(p, p + width * height);
      p += width * height;
    }
    if (bits.length < width * height) throw new Error(`short bitmap ${i} in ${path.basename(file)}`);
    bitmaps.push({ width, height, xoff, yoff, hotspots, bits });
  }

  const groups = [];
  for (let g = 0; g < numGroups && p + 4 <= b.length; g++) {
    const n = b.readInt32LE(p); p += 4;
    const idx = [];
    for (let k = 0; k < n; k++) { idx.push(b.readInt32LE(p)); p += 4; }
    groups.push(idx);
  }

  return { version, name, shrink, numBitmaps, numGroups, maxIndices, bitmaps, groups };
}

// ---------------------------------------------------------------- PNG out

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 8-bit indexed PNG with a tRNS entry for the transparent index.
export function writeIndexedPNG(file, width, height, bits, palette, scale = 1) {
  let w = width, h = height, px = bits;
  if (scale > 1) {
    w = width * scale; h = height * scale;
    px = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      const sy = (y / scale) | 0;
      for (let x = 0; x < w; x++) px[y * w + x] = bits[sy * width + ((x / scale) | 0)];
    }
  }
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    px.copy(raw, y * (w + 1) + 1, y * w, y * w + w);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const plte = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) {
    plte[i * 3] = palette[i][0]; plte[i * 3 + 1] = palette[i][1]; plte[i * 3 + 2] = palette[i][2];
  }
  const trns = Buffer.alloc(TRANSPARENT + 1, 255);
  trns[TRANSPARENT] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return { w, h };
}

// Kod names groups 1-based (viInventory_group = 3); the stored indices are
// 0-based into the bitmap list, with -1 meaning "nothing drawn here"
// (include/dibutil.h BitmapsGetIndex does no adjustment, BITMAP_MISSING = -1).
// Offset 0 of a group is the view at angle 0 — the front of a monster, the
// single frame of a still object (clientd3d/draw.c GetObjectPdib).
export function groupBitmap(bgf, kodGroup = 1) {
  const g = bgf.groups[kodGroup - 1];
  if (!g || !g.length) return null;
  const idx = g[0];
  if (idx == null || idx < 0 || idx >= bgf.bitmaps.length) return null;
  return bgf.bitmaps[idx];
}

// ---------------------------------------------------------------- driver

function main() {
  const cmd = process.argv[2] || 'all';
  const palette = loadPalette();

  if (cmd === 'one') {
    const f = process.argv[3];
    const bgf = readBGF(path.isAbsolute(f) ? f : path.join(RESDIR, f));
    console.log(JSON.stringify({
      name: bgf.name, version: bgf.version, shrink: bgf.shrink,
      numBitmaps: bgf.numBitmaps, numGroups: bgf.numGroups,
      sizes: bgf.bitmaps.map((b) => `${b.width}x${b.height}`),
      groups: bgf.groups,
    }, null, 1));
    return;
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const files = fs.readdirSync(RESDIR).filter((f) => f.toLowerCase().endsWith('.bgf'));
  const index = {};
  let ok = 0, fail = 0, pngs = 0;
  for (const f of files) {
    try {
      const bgf = readBGF(path.join(RESDIR, f));
      const stem = f.replace(/\.bgf$/i, '').toLowerCase();
      const entry = {
        shrink: Math.max(1, bgf.shrink || 1),
        frames: bgf.numBitmaps, groupCount: bgf.numGroups,
        label: bgf.name || null, groups: {},
      };
      for (let g = 1; g <= bgf.numGroups; g++) {
        const bm = groupBitmap(bgf, g);
        if (!bm) continue;
        const name = `${stem}_g${g}.png`;
        const { w, h } = writeIndexedPNG(path.join(OUTDIR, name), bm.width, bm.height, bm.bits, palette);
        entry.groups[g] = { file: name, w, h, angles: bgf.groups[g - 1].length };
        pngs++;
      }
      if (!Object.keys(entry.groups).length) throw new Error('no drawable group');
      index[stem] = entry;
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 10) console.error(`  ${f}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(HERE, '..', 'data', 'images.json'), JSON.stringify(index, null, 1));
  console.log(`bgf: ${ok} files, ${fail} failed, of ${files.length}; ${pngs} pngs`);
}

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1'))
    || process.argv[1].endsWith('bgf.mjs')) main();
