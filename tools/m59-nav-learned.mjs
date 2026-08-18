#!/usr/bin/env node
// m59-nav-learned.mjs -- a learned overlay on top of the static room graph.
//
// The static map (m59-map.json) says which edges EXIST. This overlay says which
// edges WORK. It is advisory: if the overlay is empty or wrong, the router
// behaves exactly as it does without it.
//
//   node tools/m59-nav-learned.mjs backfill   populate from existing transit logs
//   node tools/m59-nav-learned.mjs stats      show what has been learned
//   node tools/m59-nav-learned.mjs show <room>  edges out of one room
//
// The overlay is a JSON file: substrate/m59-nav-learned.json
//   { "563->583": { tried: 12, ok: 11, fail_streak: 0, last_reason: null, last_at: ... },
//     "583->593": { tried: 5, ok: 2, fail_streak: 3, last_reason: "no floor", last_at: ... } }
//
// Thresholds:
//   fail_streak >= 3  -> "suspect" (penalize in ordering)
//   fail_streak >= 5  -> "bad"     (route around if possible)
//   ok on a bad edge  -> reset streak, restore

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_FILE = process.env.M59_NAV_LEARNED || join(REPO, 'substrate', 'm59-nav-learned.json');

const SUSPECT_STREAK = 3;
const BAD_STREAK = 5;

// ─── Load / save ─────────────────────────────────────────────────────────────

function load() {
  try {
    return JSON.parse(readFileSync(OVERLAY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(overlay) {
  const dir = dirname(OVERLAY_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OVERLAY_FILE, JSON.stringify(overlay, null, 2));
}

// ─── Edge key ────────────────────────────────────────────────────────────────

const key = (from, to) => `${from}->${to}`;

// ─── Record a hop result ─────────────────────────────────────────────────────
// Called by the broker after each hop. `from` and `to` are room NUMBERS.
// `ok` is boolean. `reason` is the error string (null on success).

export function recordHop(from, to, ok, reason = null) {
  const overlay = load();
  const k = key(from, to);
  const e = overlay[k] ?? { tried: 0, ok: 0, fail_streak: 0, last_reason: null, last_at: 0 };
  e.tried++;
  e.last_at = Date.now();
  if (ok) {
    e.ok++;
    e.fail_streak = 0;
    e.last_reason = null;
  } else {
    e.fail_streak++;
    e.last_reason = reason;
  }
  overlay[k] = e;
  save(overlay);
}

// ─── Consult: which edges out of `from` are suspect or bad? ─────────────────
// Returns { bad: Set<number>, suspect: Set<number> } — destination room numbers.

export function consult(from) {
  const overlay = load();
  const bad = new Set();
  const suspect = new Set();
  const prefix = `${from}->`;
  for (const [k, e] of Object.entries(overlay)) {
    if (!k.startsWith(prefix)) continue;
    const to = Number(k.slice(prefix.length));
    if (e.fail_streak >= BAD_STREAK) bad.add(to);
    else if (e.fail_streak >= SUSPECT_STREAK) suspect.add(to);
  }
  return { bad, suspect };
}

// ─── Penalty for ordering: 0 is best, higher is worse ───────────────────────
// The broker's orderExits can add this to the sort key.

export function penalty(from, to) {
  const overlay = load();
  const e = overlay[key(from, to)];
  if (!e) return 0;
  if (e.fail_streak >= BAD_STREAK) return 1000;
  if (e.fail_streak >= SUSPECT_STREAK) return 100;
  return 0;
}

// ─── Reverify: clear a bad edge after a successful probe ────────────────────

export function reverify(from, to, ok) {
  const overlay = load();
  const k = key(from, to);
  const e = overlay[k];
  if (!e) return;
  if (ok) {
    e.fail_streak = 0;
    e.last_reason = null;
    e.last_at = Date.now();
    save(overlay);
  }
}

// ─── Backfill from transit logs ─────────────────────────────────────────────

export function backfill() {
  const transitDir = join(REPO, 'substrate', 'transits');
  const overlay = load();
  let count = 0;
  try {
    const files = existsSync(transitDir) ? readdirSync(transitDir).filter(f => f.endsWith('.json')) : [];
    for (const f of files) {
      const full = join(transitDir, f);
      let data;
      try { data = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
      for (const t of data.transits ?? []) {
        const from = t.room, to = t.to;
        if (from == null || to == null) continue;
        const k = key(from, to);
        const e = overlay[k] ?? { tried: 0, ok: 0, fail_streak: 0, last_reason: null, last_at: 0 };
        e.tried++;
        e.last_at = Math.max(e.last_at, t.at ?? 0);
        if (t.ok) {
          e.ok++;
          e.fail_streak = 0;
          e.last_reason = null;
        } else {
          e.fail_streak++;
          e.last_reason = t.reason ?? null;
        }
        overlay[k] = e;
        count++;
      }
    }
  } catch { /* no transit dir */ }
  save(overlay);
  return count;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function stats() {
  const overlay = load();
  let total = 0, ok = 0, suspect = 0, bad = 0;
  for (const e of Object.values(overlay)) {
    total++;
    if (e.ok > 0) ok++;
    if (e.fail_streak >= BAD_STREAK) bad++;
    else if (e.fail_streak >= SUSPECT_STREAK) suspect++;
  }
  return { edges: total, ok, suspect, bad, file: OVERLAY_FILE };
}

export function showRoom(from) {
  const overlay = load();
  const prefix = `${from}->`;
  const out = [];
  for (const [k, e] of Object.entries(overlay)) {
    if (!k.startsWith(prefix)) continue;
    const to = Number(k.slice(prefix.length));
    out.push({ to, ...e });
  }
  return out.sort((a, b) => a.to - b.to);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'backfill') {
    const n = backfill();
    console.log(`backfilled ${n} transit entries`);
    const s = stats();
    console.log(`overlay: ${s.edges} edges, ${s.ok} ok, ${s.suspect} suspect, ${s.bad} bad`);
  } else if (cmd === 'stats') {
    const s = stats();
    console.log(JSON.stringify(s, null, 2));
  } else if (cmd === 'show' && process.argv[3]) {
    const room = Number(process.argv[3]);
    const edges = showRoom(room);
    if (!edges.length) { console.log(`no learned data for room ${room}`); process.exit(0); }
    for (const e of edges) {
      const status = e.fail_streak >= BAD_STREAK ? 'BAD' : e.fail_streak >= SUSPECT_STREAK ? 'SUSPECT' : 'ok';
      console.log(`  ${room} -> ${e.to}: tried=${e.tried} ok=${e.ok} streak=${e.fail_streak} [${status}] ${e.last_reason ?? ''}`);
    }
  } else {
    console.log('usage: m59-nav-learned.mjs <backfill|stats|show <room>>');
    process.exit(1);
  }
}
