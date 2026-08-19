// THE MONORAIL: the fastest way anybody has ever actually crossed this room, kept.
//
// 99% of travel is exit to exit. A room has a handful of doors, everyone crossing it is
// going from one of them to another, and the geometry does not change — so there is a best
// way through, it is the same every time, and the fleet has been re-deriving it on every
// trip and then throwing it away.
//
// This combs the trail ledger for those crossings and keeps the quickest one per
// (room, came from, going to). What comes out is not a plan and not a claim: it is what a
// body did, straightened against the same BSP the mover enforces, so it cannot contain a
// step the mover would refuse. That is the property no planner has — `path()` reasons about
// stand points a body may never occupy, and this repository has spent a long day proving how
// badly that goes in tight terrain.
//
// TIME IS THE ONLY RANKING, AND DEATHS ARE NOT EVIDENCE. Monsters wander the coarse grid, so
// which crossing killed somebody is a fact about where a troll was standing, not about the
// route — and ranking on survival would teach the fleet to avoid whichever road it happened
// to be unlucky on. A death simply means that attempt produced no usable track.
//
//   node tools/m59-tracks.mjs                what has been learned
//   node tools/m59-tracks.mjs --room 599     one room in detail
//   node tools/m59-tracks.mjs --save         write substrate/m59-tracks.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSamples, segments, straighten, squareOf, roomIndex, resolveRoom,
         TRAILS_DIR, WALKS_DIR } from './m59-trails.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TRACKS_FILE = process.env.M59_TRACKS ||
  path.join(HERE, '..', 'substrate', 'm59-tracks.json');

// A crossing has to be a crossing. A segment that starts and ends in the same corner of a
// room is somebody milling about, not a route through it.
export const MIN_SPAN_SQUARES = Number(process.env.M59_TRACK_MIN_SPAN || 4);
// And it has to be plausible as a walk. A segment spanning more than this in one sample is a
// teleport, a knockback or a relocate, and joining its ends draws a line through whatever
// happened in between.
export const MAX_JUMP_WIRE = Number(process.env.M59_TRACK_MAX_JUMP || 600);

export const trackKey = (room, from, to) => `${room}:${from ?? '?'}>${to ?? '?'}`;

/**
 * Turn a stream of samples into crossings: which room, in by which door, out by which.
 *
 * The neighbouring segments are what say where a body came FROM and went TO — the sample
 * stream is continuous, so the room before and the room after are simply the previous and
 * next segments of the same body, when they are close enough in time to be the same journey.
 */
export function crossings(samples, { joinWithinMs = 15000 } = {}) {
  const segs = segments(samples);
  // Group by body so "the segment before" means the same body's previous room.
  const byBody = new Map();
  for (const s of segs) {
    const list = byBody.get(s.body) ?? [];
    list.push(s); byBody.set(s.body, list);
  }
  const out = [];
  for (const list of byBody.values()) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 0; i < list.length; i++) {
      const seg = list[i], prev = list[i - 1], next = list[i + 1];
      const cameFrom = prev && (seg.from - prev.to) <= joinWithinMs ? prev.room : null;
      const goingTo = next && (next.from - seg.to) <= joinWithinMs ? next.room : null;
      if (goingTo == null) continue;               // a crossing needs a far side
      // AND THE FAR SIDE HAS TO BE A DIFFERENT ROOM. A body whose samples were cut by a gap
      // produces two segments in the SAME room, and joining them reads as a crossing from a
      // room to itself — which then keys a track nobody can ever use and hides the real one
      // behind it. Same for the near side.
      if (goingTo === seg.room || cameFrom === seg.room) continue;
      const a = squareOf(seg.points[0]), b = squareOf(seg.points[seg.points.length - 1]);
      const span = Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
      if (span < MIN_SPAN_SQUARES) continue;
      // A jump between consecutive samples is not a walk.
      let teleported = false;
      for (let k = 1; k < seg.points.length; k++) {
        const p = seg.points[k], q = seg.points[k - 1];
        if (Math.hypot(p.x - q.x, p.y - q.y) > MAX_JUMP_WIRE) { teleported = true; break; }
      }
      if (teleported) continue;
      out.push({ room: seg.room, cameFrom, goingTo, body: seg.body, name: seg.name,
                 ms: seg.to - seg.from, points: seg.points, entered: a, left: b });
    }
  }
  return out;
}

/**
 * Keep the quickest crossing per (room, from, to), straightened.
 *
 * `geoFor` is injected rather than imported so this stays testable without a map — a caller
 * with no geometry still gets loop-elided trails, which are worse tracks and not wrong ones.
 */
export function comb(crossingList, geoFor = () => null) {
  const best = new Map();
  for (const c of crossingList) {
    const key = trackKey(c.room, c.cameFrom, c.goingTo);
    const had = best.get(key);
    if (had && had.ms <= c.ms) { had.seen++; continue; }
    const geo = geoFor(c.room);
    const points = straighten(geo, c.points);
    if (points.length < 2) continue;
    best.set(key, { room: c.room, from: c.cameFrom, to: c.goingTo, ms: c.ms,
                    waypoints: points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
                    entered: c.entered, left: c.left,
                    samples: c.points.length, seen: (had?.seen ?? 0) + 1,
                    straightened: geo ? true : false });
  }
  return best;
}

export function loadTracks(file = TRACKS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).tracks ?? {}; } catch { return {}; }
}

/** The track for this crossing, or null — and null means "plan it as you always did". */
export function recallTrack(room, from, to, tracks = loadTracks()) {
  return tracks[trackKey(room, from, to)] ?? tracks[trackKey(room, null, to)] ?? null;
}

// ---------------------------------------------------------------------------- CLI
const direct = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const files = [];
  for (const dir of [TRAILS_DIR, WALKS_DIR]) {
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f)); }
    catch { /* nothing recorded yet */ }
  }
  if (!files.length) { console.log('no trails recorded yet'); process.exit(0); }
  const samples = files.flatMap(readSamples);
  const list = crossings(samples);

  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const map = loadMap(movementMapFile());
  try { attachStepMasks(map); } catch { /* coarse, as everywhere */ }
  const geoFor = num => { const r = map.rooms[num];
    try { return r?.roo ? sharedRoomGeometry(r) : null; } catch { return null; } };

  // Resolve object ids to room numbers before combing — see roomIndex in m59-trails.mjs.
  const index = roomIndex(map);
  for (const c of list) {
    c.room = resolveRoom(index, c.room) ?? c.room;
    c.cameFrom = c.cameFrom == null ? null : (resolveRoom(index, c.cameFrom) ?? c.cameFrom);
    c.goingTo = resolveRoom(index, c.goingTo) ?? c.goingTo;
  }

  const best = comb(list, geoFor);
  const wantRoom = arg('--room') ? Number(arg('--room')) : null;
  console.log(`${samples.length} sample(s), ${list.length} crossing(s), ${best.size} track(s) learned\n`);
  console.log('room                             from    to     best   samples  waypoints  seen');
  for (const [key, t] of [...best].sort((a, b) => a[1].room - b[1].room)) {
    if (wantRoom && t.room !== wantRoom) continue;
    console.log(`${String(t.room).padStart(5)} ${String(map.rooms[t.room]?.name ?? '?').slice(0, 26).padEnd(27)} ` +
      `${String(t.from ?? '-').padStart(5)} ${String(t.to).padStart(5)} ${String((t.ms / 1000).toFixed(0) + 's').padStart(7)} ` +
      `${String(t.samples).padStart(8)} ${String(t.waypoints.length).padStart(10)} ${String(t.seen).padStart(5)}` +
      (t.straightened ? '' : '   (not straightened — no geometry)'));
  }
  if (process.argv.includes('--save')) {
    const tracks = {};
    for (const [k, t] of best) tracks[k] = t;
    fs.writeFileSync(TRACKS_FILE, JSON.stringify({
      note: 'The quickest crossing anybody has actually walked, per room and pair of doors, ' +
            'straightened against the baked BSP. Made of accepted moves, so it cannot contain ' +
            'a step the mover refuses. Ranked on TIME only: monsters wander, so a death says ' +
            'nothing about the route.',
      written: new Date().toISOString(), tracks,
    }, null, 1) + String.fromCharCode(10));
    console.log('\nwrote ' + TRACKS_FILE);
  }
}
