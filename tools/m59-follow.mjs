#!/usr/bin/env node
// MAKE THE BOTS TRY TO WALK TO WHERE YOU ARE STANDING, AND WATCH THEM FAIL.
//
//   node tools/m59-follow.mjs --gather              put them in your room, then follow
//   node tools/m59-follow.mjs                       follow, assuming they are already here
//   node tools/m59-follow.mjs --bots Alpha,Bravo
//   node tools/m59-follow.mjs --lead Alpha --once   one round, no loop
//
// THE WHOLE ARGUMENT FOR THIS TOOL IS THAT THE NUMBERS DID NOT WORK. The wedge has been
// diagnosed three times from telemetry and the diagnosis was wrong three times —
// "another machine is holding the fleet", "travel is frozen", "both maps agree there is
// no floor" — because every wrong hypothesis predicted the same numbers. What settled it
// each time was somebody logging in and looking. So: a person stands on a square, five
// bots try to reach them, and whether they can is visible from inside the world.
//
// IT IS A MEASUREMENT DISGUISED AS A GAME. Standing on ordinary floor, they arrive. Walk
// onto a proven safe wall and some of them stop arriving — because a safe wall IS the
// coarse grid and the BSP disagreeing, that is the mechanism, and the router plans on the
// second of those. The person choosing where to stand is running the experiment.
//
// WHAT IT REPORTS IS THE REASON, NOT THE FAILURE. `walk_to` distinguishes several things
// that all look like "did not get there" from outside, and they have different fixes:
//
//   no route          the router refuses before sending a packet. THE WEDGE.
//   bouncing          it walked, kept landing somewhere other than the planned square,
//                     and spent its replans. This is the slide-along-a-wall failure.
//   blocked           something is standing in the way. Ordinary, and it clears.
//   left room         it walked out of the room. Usually means it was routed round.
//
// IT DRIVES BOTS DIRECTLY AND DELIBERATELY DOES NOT START KEEPERS. A keeper would fight
// it for the character every second and the picture would be of the argument rather than
// of the geometry. If a keeper IS running on one of these, stop it first.
//
// LOOPBACK ONLY for the DM half, by m59-dm.mjs's own guard. Reading a character's live
// square over the maintenance socket is how this stays cheap: one batched `show object`
// for the whole cast, rather than a `look` per bot per tick.
import { dm, resolve, split, isLoopbackHost, adminTarget, roomObject, relocateCmd,
         clampSquare, rejections } from './m59-dm.mjs';

const PORT = Number(process.env.M59_BROKER_PORT || 8961);

async function broker(name, args, { port = PORT, timeoutMs = 120000 } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return { _error: `broker answered ${r.status}` };
  const j = await r.json();
  if (j.error) return { _error: j.error.message };
  try { return JSON.parse(j.result?.content?.[0]?.text ?? '{}'); }
  catch { return { _error: 'broker reply was not json' }; }
}

/**
 * Where everybody is, in one batch.
 *
 * OVER THE MAINTENANCE SOCKET RATHER THAN `look`, because `look` is a real perception
 * call that re-reads from the server and costs a round trip per agent per tick — and
 * this loop runs every few seconds for as long as somebody is playing. `show object` is
 * the server's own view of its own properties and 2000 of them fit in one write.
 *
 * `poOwner` is the ROOM OBJECT, not the room number, which is the same distinction that
 * made the overlay files invisible: the harness counts rooms and the server holds
 * objects. Compared as object ids on both sides, so it never needs translating.
 */
export async function positionsOf(names) {
  const ids = await resolve(names);
  const present = names.filter(n => ids[n] != null);
  if (!present.length) return {};
  const cmds = present.map(n => `show object ${ids[n]}`);
  const blocks = split(await dm(cmds), cmds);
  const out = {};
  present.forEach((n, i) => {
    const b = blocks[i] || '';
    const num = re => { const m = re.exec(b); return m ? Number(m[1]) : null; };
    out[n] = {
      id: ids[n],
      room: num(/poOwner\s+= OBJECT (\d+)/),
      row: num(/piRow\s+= INT (-?\d+)/),
      col: num(/piCol\s+= INT (-?\d+)/),
      health: num(/piHealth\s+= INT (-?\d+)/),
    };
  });
  for (const n of names) if (!out[n]) out[n] = { id: null };
  return out;
}

/**
 * A ring of destinations around the leader, one per follower.
 *
 * NOT ALL ON THE LEADER'S OWN SQUARE. Five bots asked for one square is five bots
 * blocking each other, and every one of them would report `object_blocked` — a true
 * answer to a question nobody asked, which would bury the geometric refusals this exists
 * to show. Radius 2 keeps them inside melee reach (2-3 squares) so the picture still
 * looks like a group standing with you.
 */
export function stationsAround({ row, col }, count, { radius = 2 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / Math.max(1, count);
    out.push(clampSquare(Math.round(row + radius * Math.sin(a)),
                         Math.round(col + radius * Math.cos(a)), 0, 0));
  }
  return out;
}

/**
 * Turn a walk_to reply into one of a handful of words.
 *
 * THE CLASSIFICATION IS THE PRODUCT. "It did not arrive" is what the fleet board already
 * says and it is why the fault survived three investigations; which KIND of not-arriving
 * is what names the bug.
 */
export function classify(r) {
  if (!r || r._error) return { kind: 'error', why: r?._error ?? 'no reply' };
  if (r.arrived) return { kind: 'arrived', why: `${r.steps ?? 0} steps` };
  if (r.left_room) return { kind: 'left room', why: r.note ?? '' };
  const note = String(r.note ?? '');
  const reason = String(r.reason ?? '');
  if (/kept ending up somewhere other than the planned square/i.test(note))
    return { kind: 'BOUNCING', why: `${r.steps ?? 0} steps, ${r.refused_edges ?? 0} refused edges` };
  if (/no route/i.test(reason) || /no route/i.test(note))
    return { kind: 'NO ROUTE', why: (note || reason) + (r.retreated ? ` (retreated ${r.retreated})` : '') };
  if (/object_blocked/i.test(reason)) return { kind: 'blocked', why: 'something in the way' };
  if (/collision_geometry_unavailable|room_geometry_mismatch|room_security_unknown/.test(reason))
    return { kind: 'NO GEOMETRY', why: reason };
  return { kind: 'stopped', why: note || reason || 'no reason given' };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-follow.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  const lead = flag('lead', 'TESTER');
  const bots = (flag('bots', 'Alpha,Bravo,Charlie,Delta,Echo')).split(',').map(s => s.trim()).filter(Boolean);
  const agentOf = { Alpha: 'arena1', Bravo: 'arena2', Charlie: 'arena3', Delta: 'arena4', Echo: 'arena5' };
  const everyMs = Number(flag('every', 5000));
  const radius = Number(flag('radius', 2));

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error(`refusing: ${target.host} is not loopback.`);
    process.exit(2);
  }

  const where = await positionsOf([lead, ...bots]);
  const me = where[lead];
  if (!me?.room) {
    console.error(`cannot find ${lead} on this server`);
    process.exit(1);
  }
  console.log(`${lead} is in room object ${me.room} at ${me.row},${me.col}`);

  if (has('gather')) {
    // DM-PLACED RATHER THAN WALKED. Walking five characters across the world is twenty
    // minutes and fails halfway; this is one packet. It also means the followers START
    // somewhere the router considers ordinary, so the first refusal we see is about the
    // LEADER's square rather than about wherever they happened to be standing.
    const stations = stationsAround(me, bots.length, { radius: 4 });
    const cmds = bots.map((b, i) => where[b]?.id
      ? relocateCmd(where[b].id, me.room, stations[i].row, stations[i].col) : null).filter(Boolean);
    const out = await dm(cmds);
    const refused = rejections(out);
    console.log(`gathered ${cmds.length} bot(s) into the room` +
                (refused.length ? ` — ${refused.length} refused` : ''));
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\nfollowing ${lead} with ${bots.join(', ')} — every ${everyMs}ms. Ctrl-C to stop.\n`);
  const lastKind = new Map();
  let round = 0;

  for (;;) {
    round++;
    const now = await positionsOf([lead, ...bots]);
    const leader = now[lead];
    if (!leader?.room) { console.log(`round ${round}: lost ${lead}`); await new Promise(r => setTimeout(r, everyMs)); continue; }

    const stations = stationsAround(leader, bots.length, { radius });
    const line = [];

    // ONE AT A TIME, NOT IN PARALLEL. They share one event loop in the broker and one
    // world; five simultaneous walks produce five characters shoving each other, and
    // `object_blocked` would then be the most common answer to a question about walls.
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      const agent = agentOf[b] ?? b;
      const at = now[b];
      if (!at?.id) { line.push(`${b}:absent`); continue; }
      if (at.room !== leader.room) {
        line.push(`${b}:other-room`);
        if (lastKind.get(b) !== 'other-room') {
          console.log(`  ${b} is in a different room (${at.room} vs ${leader.room}) — ` +
                      `--gather moves them, or walk them yourself`);
          lastKind.set(b, 'other-room');
        }
        continue;
      }
      const s = stations[i];
      const r = await broker('walk_to', { agent, col: s.col, row: s.row, max_steps: 60 });
      const c = classify(r);
      line.push(`${b}:${c.kind}`);

      // ONLY ON CHANGE. This runs for as long as somebody is playing; a line per bot per
      // tick buries the transition, and the transition is the entire signal — the moment
      // a bot that was arriving stops arriving is the moment the leader stepped onto a
      // square the router cannot reach.
      if (lastKind.get(b) !== c.kind) {
        const flagged = /NO ROUTE|BOUNCING|NO GEOMETRY/.test(c.kind) ? '  <<<' : '';
        console.log(`  round ${round}  ${b.padEnd(8)} ${c.kind.padEnd(11)} ` +
                    `-> ${s.row},${s.col}   ${c.why}${flagged}`);
        lastKind.set(b, c.kind);
      }
    }

    const stuck = [...lastKind.values()].filter(k => /NO ROUTE|BOUNCING|NO GEOMETRY/.test(k)).length;
    console.log(`round ${round}  ${lead}@${leader.row},${leader.col}  ` +
                `${line.join(' ')}${stuck ? `   ${stuck} STUCK` : ''}`);

    if (has('once')) break;
    await new Promise(r => setTimeout(r, everyMs));
  }
}
