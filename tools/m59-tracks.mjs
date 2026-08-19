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
import { UNDERWORLD_PORTALS } from './m59-underworld.mjs';

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

// WHERE A SEALED ROOM IS KNOWN TO LEAD. Only the Underworld today: five pentagram portals
// with fixed destinations, plus the rip in space, which re-rolls among those same five — so
// the destination SET is the same either way. Empty for any other sealed room, which means
// "nothing is known, accept what is observed" and keeps this from becoming a second, worse
// copy of the room graph.
export const sealedDestinations = new Map([
  [1, new Set(UNDERWORLD_PORTALS.map(p => Number(p.inn)).filter(Number.isFinite))],
]);

/**
 * Turn a stream of samples into crossings: which room, in by which door, out by which.
 *
 * The neighbouring segments are what say where a body came FROM and went TO — the sample
 * stream is continuous, so the room before and the room after are simply the previous and
 * next segments of the same body, when they are close enough in time to be the same journey.
 */
export function crossings(samples, { joinWithinMs = 15000, neighbours = null } = {}) {
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
      // AND THE DOORS HAVE TO EXIST.
      //
      // `goingTo` is simply the next room this body was seen in, and after a teleport that
      // is wherever the harness put it — so a "crossing" appeared from the Western border
      // of the Twisted Wood into the Streets of Tos, which do not touch. Left in, those
      // become tracks nobody can ever ride, sorted to the top by their absurdly short times,
      // and they are the first thing a reader picks up. A crossing is only a crossing
      // between rooms that share a door.
      if (neighbours) {
        const out = neighbours.get(Number(seg.room));
        // A ROOM WITH NO DOORS AT ALL LEAVES BY SOMETHING ELSE, AND THAT IS THE POINT.
        //
        // The filter above exists to throw away the harness's own teleports, which look
        // exactly like crossings. It would also throw away every PORTAL hop, and the
        // Underworld is the case that matters: it publishes no exits whatsoever — "six
        // teleporters, and that is all" — so the router cannot plan a single step of it and
        // a recorded walk is the only thing that ever could. When a room declares nothing,
        // every real transition out of it is necessarily a teleporter, so there is nothing
        // for the filter to protect against and it stands aside.
        const sealed = !out || out.size === 0;
        // A SEALED ROOM STILL HAS A KNOWN SET OF WAYS OUT, WHERE ANYBODY HAS WRITTEN ONE
        // DOWN. Standing the filter aside entirely let the harness's own relocations back
        // in: the Underworld grew "crossings" to The Streets of Tos and East Merchant Way,
        // which are not portal destinations and which nothing can ever ride. The pentagram's
        // five inns are documented in m59-underworld.mjs with their kod citations, so the
        // exception is narrowed to them rather than to anything at all.
        if (sealed) {
          const known = sealedDestinations.get(Number(seg.room));
          if (known && !known.has(Number(goingTo))) continue;
        } else if (!out.has(Number(goingTo))) continue;
        if (cameFrom != null && !sealed) {
          const back = neighbours.get(Number(cameFrom));
          // Arriving from a sealed room is a teleporter landing, which is legitimate for
          // the same reason.
          if (back && back.size && !back.has(Number(seg.room))) continue;
        }
      }
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
    // WHICH STATIONS ARE SHELTER.
    //
    // The tight squares that make these crossings awkward are the SAME squares a monster
    // cannot reach — that is what a safe wall is, measured: the coarse grid offering a
    // neighbour the mover refuses. So a track already runs past the best places in the room
    // to stop and bleed quietly, and marking them costs nothing. A traveller that is hurt
    // mid-crossing does not need to reach a town; it needs the next station with a wall at
    // its back.
    //
    // The dose is what matters rather than the fact: at zero refused neighbours 28% of
    // tested squares held, at four or more 70.5%. Three is the threshold where the signal
    // is clearly present and the squares are still common enough to be on a route.
    const safeAt = [];
    if (geo && typeof geo.walkable === 'function') {
      points.forEach((p, i) => {
        const row = Math.floor(p.y / 64) + 1, col = Math.floor(p.x / 64) + 1;
        let refused = 0;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const nr = row + dr, nc = col + dc;
          if (!geo.inBounds?.(nr, nc) || !geo.walkable(nr, nc)) continue;
          if (!geo.moverStepLands?.(row, col, nr, nc)) refused++;
        }
        if (refused >= 3) safeAt.push(i);
      });
    }
    best.set(key, { room: c.room, from: c.cameFrom, to: c.goingTo, ms: c.ms,
                    waypoints: points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
                    ...(safeAt.length ? { shelter: safeAt } : {}),
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

  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const map = loadMap(movementMapFile());
  try { attachStepMasks(map); } catch { /* coarse, as everywhere */ }
  const geoFor = num => { const r = map.rooms[num];
    try { return r?.roo ? sharedRoomGeometry(r) : null; } catch { return null; } };

  // Resolve object ids to room numbers, then keep only crossings between rooms that share
  // a door — see the note in crossings(). Samples are rewritten first so the neighbour test
  // is asked in room numbers, which is the only vocabulary the map speaks.
  const index = roomIndex(map);
  for (const s2 of samples) s2.room = resolveRoom(index, s2.room) ?? s2.room;
  const neighbours = new Map();
  for (const key of Object.keys(map.rooms)) {
    const r = map.rooms[key];
    const to = new Set();
    for (const e of (r.edgeExits ?? [])) if (e.to != null) to.add(Number(e.to));
    for (const g of (r.goExits ?? [])) if (g.to != null && !g.locked) to.add(Number(g.to));
    neighbours.set(Number(r.num), to);
  }
  const list = crossings(samples, { neighbours });

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
