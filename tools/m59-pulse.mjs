#!/usr/bin/env node
// IS IT ACTUALLY MOVING? NET DISPLACEMENT OVER A SHORT WINDOW, WHICH IS THE ONLY HONEST
// ANSWER.
//
//   node tools/m59-pulse.mjs                       every arena character, live
//   node tools/m59-pulse.mjs --who Alpha,Bravo
//   node tools/m59-pulse.mjs --window 2 --every 0.5
//   node tools/m59-pulse.mjs --once                one reading and exit
//
// EVERY OTHER STALL SIGNAL IN THIS REPOSITORY MEASURES THE KEEPER, AND THE KEEPER IS NOT
// THE CHARACTER. `ms_since_moved` is when the KEEPER last moved somebody, so it climbs
// while an errand walks the character perfectly well — a post-mortem once reported
// `doing: "stalled", 8 minutes since it last moved` about a character the frames put in
// three different rooms. And watching for ROOM CHANGES, which is what the travel tests
// here have been doing, is blind for whole minutes: a character crossing a large room is
// indistinguishable from one wedged against a wall until it either arrives or does not.
//
// The operator's rule, and it is the right one: **net displacement over about two seconds**.
// Maps essentially never require walking east-west-east-west, so a character that has not
// covered ground in two seconds is not making progress — there is no legitimate travel
// pattern that hides inside that window.
//
// NET, NOT TOTAL, AND THAT IS THE WHOLE POINT. Summing per-sample distance rewards exactly
// the failure this exists to catch: the two-square bounce, and the refused step that jitters
// a character on the spot, both produce plenty of movement and no progress. Net displacement
// from the start of the window to the end scores both at zero, which is what they are.
//
// WHAT COUNTS AS MOVING. A walking character covers about 5 squares/second — 320 protocol
// units — so a two-second window should show several hundred. The default floor is
// deliberately far below that (32 units, half a square) so that only a character which has
// genuinely stopped trips it, rather than one merely walking slowly or turning.
//
// READ OVER THE MAINTENANCE SOCKET, batched, because this polls twice a second for as long
// as somebody is watching and `show object` is the server reading its own properties. A
// `look` per character per tick would be a round trip through the game protocol for a
// question the server can answer directly.
import { dm, resolve, split, isLoopbackHost, adminTarget } from './m59-dm.mjs';

export const DEFAULT_WHO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

/** Fine position and room for several characters, in one batch. */
export async function sample(names) {
  const ids = await resolve(names);
  const present = names.filter(n => ids[n] != null);
  if (!present.length) return {};
  const cmds = present.map(n => `show object ${ids[n]}`);
  const blocks = split(await dm(cmds), cmds);
  const out = {};
  present.forEach((n, i) => {
    const b = blocks[i] || '';
    const num = re => { const m = re.exec(b); return m ? Number(m[1]) : null; };
    out[n] = { at: Date.now(),
               room: num(/poOwner\s+= OBJECT (\d+)/),
               row: num(/piRow\s+= INT (-?\d+)/), col: num(/piCol\s+= INT (-?\d+)/),
               // Fine coordinates, because a character can shuffle within one square for
               // a minute and the square never changes.
               fx: num(/piFine_col\s+= INT (-?\d+)/), fy: num(/piFine_row\s+= INT (-?\d+)/),
               health: num(/piHealth\s+= INT (-?\d+)/) };
  });
  return out;
}

/**
 * Net displacement between two samples of one character, in protocol units.
 *
 * A ROOM CHANGE IS INFINITE PROGRESS, NOT ZERO. The coordinates restart in the new room,
 * so subtracting them would report a large random number or, worse, a small one — and a
 * character that has just crossed a boundary is the least stalled thing in the world.
 */
export function displacement(a, b) {
  if (!a || !b) return null;
  if (a.room !== b.room) return { moved: Infinity, changedRoom: true };
  const ax = a.col * 64 + (a.fx ?? 32), ay = a.row * 64 + (a.fy ?? 32);
  const bx = b.col * 64 + (b.fx ?? 32), by = b.row * 64 + (b.fy ?? 32);
  return { moved: Math.hypot(bx - ax, by - ay), changedRoom: false };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-pulse.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const target = adminTarget();
  if (!isLoopbackHost(target.host)) { console.error('refusing: not loopback'); process.exit(2); }

  const who = (flag('who') ?? DEFAULT_WHO.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const windowS = Number(flag('window', 2));
  const everyS = Number(flag('every', 0.5));
  const floor = Number(flag('floor', 32));          // protocol units; a square is 64
  const keep = Math.max(2, Math.ceil(windowS / everyS) + 1);

  const ring = new Map(who.map(n => [n, []]));
  console.log(`pulse: net displacement over ${windowS}s, sampled every ${everyS}s, ` +
              `stalled below ${floor} units (a square is 64)\n`);
  console.log('   time   ' + who.map(n => n.padEnd(11)).join(''));

  for (let tick = 0; ; tick++) {
    const s = await sample(who);
    for (const n of who) {
      if (!s[n]) continue;
      const r = ring.get(n); r.push(s[n]); if (r.length > keep) r.shift();
    }
    if (tick * everyS >= windowS) {
      const cells = [];
      for (const n of who) {
        const r = ring.get(n);
        const d = displacement(r[0], r[r.length - 1]);
        if (!d) { cells.push('?'.padEnd(11)); continue; }
        if (d.changedRoom) { cells.push('ROOM+'.padEnd(11)); continue; }
        const m = Math.round(d.moved);
        // The flag is the product, so it is loud: a number nobody reads is a number
        // nobody acts on, and this exists because a stall was invisible for minutes.
        cells.push((m < floor ? `STALL ${m}` : `${m}`).padEnd(11));
      }
      const t = (tick * everyS).toFixed(1) + 's';
      console.log('  ' + t.padStart(6) + '   ' + cells.join(''));
    }
    if (has('once') && tick * everyS >= windowS) break;
    await new Promise(r => setTimeout(r, everyS * 1000));
  }
}
