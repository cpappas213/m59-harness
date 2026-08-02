#!/usr/bin/env node
// The Meridian 59 resource table: integer id -> string.
//
//   node tools/m59-rsc.mjs                    load, report, dump a sample
//   node tools/m59-rsc.mjs <id> [<id> ...]    resolve specific ids
//   node tools/m59-rsc.mjs --grep <pattern>   find ids whose string matches
//
// Nothing in the game protocol carries object names as text. `name_res` in
// BP_ROOM_CONTENTS, the speaker name in BP_SAID, every stat label — all of them
// are integers into this table. Without it an agent perceives a room as a list
// of numbers. So this is not a convenience: it is half of perception.
//
// Format, from util/rscload.c:
//
//   "RSC\x01"          4-byte magic
//   version            4, must be 4
//   num_resources      4
//   num_resources x [ id (4) | NUL-terminated string ]
//
// The strings are latin1, not UTF-8 — the client is a 1990s Windows program and
// the .rsc files contain 0x92-style curly quotes that UTF-8 decoding mangles
// into U+FFFD.
//
// Ids at or above MIN_DYNAMIC_RSC (blakserv/blakserv.h:94) are *dynamic* — player
// names, guild names, anything a player typed. They are not in any file. The
// server pushes them to a live session with BP_CHANGE_RESOURCE, so a client
// learns them by listening, and the table below takes overrides for exactly that.

import fs from 'node:fs';
import path from 'node:path';

export const MIN_DYNAMIC_RSC = 1000000;   // blakserv/blakserv.h:94

const RSC_MAGIC = Buffer.from([0x52, 0x53, 0x43, 0x01]);
const RSC_VERSION = 4;

// Where the .rsc files live. The client's copy and the server's copy are two
// separate trees (see trap 10 in NEXT-STEPS.md) and either will do for names,
// since both are written by blakcomp from the same kod.
export const DEFAULT_RSC_DIRS = [
  'C:/code/meridian59/run/localclient/resource',
  'C:/code/meridian59/run/server/rsc',
];

// Parse one .rsc file into [id, string] pairs. Returns null rather than throwing
// if the file is not a resource file at all — the resource directory also holds
// .bgf bitmaps, .ogg sounds and .roo rooms, and walking it is easier than
// maintaining a list.
export function parseRsc(buf, { strict = false } = {}) {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(RSC_MAGIC)) {
    if (strict) throw new Error('not a .rsc file (bad magic)');
    return null;
  }
  const version = buf.readInt32LE(4);
  if (version !== RSC_VERSION) {
    if (strict) throw new Error(`unsupported .rsc version ${version}`);
    return null;
  }
  const count = buf.readInt32LE(8);
  const out = [];
  let p = 12;
  for (let i = 0; i < count; i++) {
    if (p + 4 > buf.length) throw new Error(`truncated at resource ${i}/${count}`);
    const id = buf.readInt32LE(p); p += 4;
    // rscload.c reads bytes until NUL. A resource may legitimately be the empty
    // string, which is a lone NUL.
    const end = buf.indexOf(0, p);
    if (end < 0) throw new Error(`unterminated string for resource ${id}`);
    out.push([id, buf.subarray(p, end).toString('latin1')]);
    p = end + 1;
  }
  return { count, entries: out, trailing: buf.length - p };
}

export class ResourceTable {
  constructor() {
    this.map = new Map();       // id -> string
    this.files = 0;
    this.skipped = 0;
    this.collisions = 0;
  }

  get size() { return this.map.size; }

  loadFile(file) {
    let parsed;
    try {
      parsed = parseRsc(fs.readFileSync(file));
    } catch (e) {
      this.skipped++;
      return 0;
    }
    if (!parsed) { this.skipped++; return 0; }
    for (const [id, str] of parsed.entries) {
      // blakcomp allocates ids globally, so a collision means two files disagree
      // — worth counting, because a nonzero count says the tree is inconsistent.
      const prev = this.map.get(id);
      if (prev !== undefined && prev !== str) this.collisions++;
      this.map.set(id, str);
    }
    this.files++;
    return parsed.entries.length;
  }

  loadDir(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return this; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.rsc')) continue;
      this.loadFile(path.join(dir, n));
    }
    return this;
  }

  // BP_CHANGE_RESOURCE (30) — the server telling a live session about a dynamic
  // resource. This is the only way to learn a player's name from the protocol.
  set(id, str) { this.map.set(id, str); return this; }

  has(id) { return this.map.has(id); }

  // Resolution never fails: an agent that cannot name a thing still has to be
  // able to talk about it, and the shape of the placeholder says which kind of
  // ignorance this is.
  get(id) {
    const s = this.map.get(id);
    if (s !== undefined) return s;
    if (id === 0) return '';
    if (id >= MIN_DYNAMIC_RSC) return `<dynamic ${id}>`;
    return `<rsc ${id}>`;
  }

  // Reverse lookup, for tests and for a human poking at the table.
  grep(pattern) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    const hits = [];
    for (const [id, s] of this.map) if (re.test(s)) hits.push([id, s]);
    return hits.sort((a, b) => a[0] - b[0]);
  }
}

let shared = null;

// One table for every agent in a process. Loading is ~1100 small files, so it is
// worth doing once; Task 3's broker holds a single instance for all sessions.
export function loadResources(dirs = DEFAULT_RSC_DIRS) {
  if (shared) return shared;
  const t = new ResourceTable();
  for (const d of dirs) {
    t.loadDir(d);
    if (t.size) break;      // first directory that yields anything wins
  }
  shared = t;
  return t;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const t0 = Date.now();
  const t = loadResources();
  const ms = Date.now() - t0;

  if (args[0] === '--grep') {
    const hits = t.grep(args.slice(1).join(' '));
    console.log(`${hits.length} match(es):`);
    for (const [id, s] of hits.slice(0, 60)) console.log(`  ${String(id).padStart(7)}  ${s}`);
    if (hits.length > 60) console.log(`  ... and ${hits.length - 60} more`);
  } else if (args.length) {
    for (const a of args) {
      const id = Number(a);
      console.log(`${String(id).padStart(7)}  ${t.has(id) ? JSON.stringify(t.get(id)) : '(unknown)'}`);
    }
  } else {
    console.log(`loaded ${t.size} resources from ${t.files} .rsc files in ${ms}ms`);
    console.log(`skipped ${t.skipped} non-resource files, ${t.collisions} id collisions`);
    const ids = [...t.map.keys()].sort((a, b) => a - b);
    console.log(`id range ${ids[0]} .. ${ids[ids.length - 1]}`);
    console.log('\nsample:');
    for (const id of ids.slice(0, 8)) console.log(`  ${String(id).padStart(7)}  ${JSON.stringify(t.get(id))}`);
    // A few things an agent will actually need to recognise.
    console.log('\nprobes:');
    for (const p of ['^Sword$', '^Mummy$', '^shopkeeper', '^Kocatan']) {
      const hits = t.grep(new RegExp(p, 'i')).slice(0, 3);
      console.log(`  /${p}/  ->  ${hits.map(([i, s]) => `${s} (${i})`).join(', ') || '(none)'}`);
    }
  }
}
