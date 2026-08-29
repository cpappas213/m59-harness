#!/usr/bin/env node
// THE BLOCKING CASES, EACH AS A COMMAND THAT REPRODUCES IT ON DEMAND.
//
//   node tools/m59-repro.mjs --list
//   node tools/m59-repro.mjs crowded-pipe --fleet shadow
//   node tools/m59-repro.mjs gully-escape --fleet shadow
//
// A KNOWN FAILURE THAT NOBODY CAN RE-RUN IS A RUMOUR. This repository keeps the things that
// WORK honest -- the offline suites, the hop book, the tactics ledger -- and had nowhere to
// put the things that do not. So a blocker got written into a commit message, was true on
// the day, and then quietly stopped being either true or false.
//
// Every case here names what is blocked, what was measured, WHEN, and under which movement
// epoch, and runs the same measurement again on demand. Two numbers that disagree is the
// point: a case that has silently healed should be deleted, and one that has got worse is a
// regression nobody would otherwise have noticed.
//
// THESE ARE NOT TESTS AND THEY MUST NOT BE IN THE OFFLINE SUITE. Every one joins characters,
// relocates bodies with the DM tools, and takes minutes. `m59-todo-test.mjs` is the offline
// half: it fails nothing, prints these as TODOs, and checks the parts that can be checked
// without a server.
//
// LOOPBACK ONLY, by m59-dm.mjs's own guard. Relocating bodies is a lab-server power.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost, adminTarget } from './m59-dm.mjs';
import { broker } from './m59-circuit.mjs';
import { tryHop, startsIn } from './m59-hoptest.mjs';
import { epochId } from './m59-epoch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/repro.json';
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { try { mkdirSync(dirname(BOOK), { recursive: true }); } catch {}
                    writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

const fleetRows = async () => ((await broker('fleet', {}, { timeoutMs: 60000 }))?.fleet ?? []);
const namesOf = async () => new Map((await fleetRows()).map(a => [a.agent, a.character]));

/**
 * THE REGISTRY. `m59-todo-test.mjs` imports this, so the offline TODO list and the thing
 * that reproduces it cannot drift apart -- there is one description of each blocker.
 *
 * `measured` is what was actually observed, with the date and the epoch it was seen under,
 * because a movement commit resets what these numbers mean (see docs/m59-evidence.md).
 * `blocking` says what it stops, in one line, for somebody reading the list cold.
 */
export const CASES = {
  'crowded-pipe': {
    title: 'six characters at once through a one-square sewer pipe',
    blocking: 'about half the 108 -> 110 crossings when the fleet arrives together; the ' +
              '2 -> 110 and 52 -> 110 legs are the ones that need it',
    why:
      "Room 108's jump take-off is reached only along a corridor one square wide -- row 35 " +
      "east, then col 47 north. One character crosses it every time. Six converging on it at " +
      "once do not, and patience alone cannot fix a genuine single-file bottleneck: somebody " +
      "has to be last, and the walk has a time budget. The sidestep, which is the walker's " +
      "usual answer to a body in the way, cannot help because there is no side to step to.",
    measured: {
      at: '2026-08-29',
      epoch: 'd80ceac (#movement a player in the way is a queue, not a wall)',
      solo: '4/4 forward, median 162s (1 bot, 4 starts, 180s cap)',
      crowded_before_queueing: '3/6 forward, 6/6 back, median 159s (6 bots, 6 starts, 420s cap)',
      crowded_after_queueing: '3/6 forward, 6/6 back, median 124s (same run shape)',
      note: 'the same three starts failed in both crowded runs -- 3,42 / 25,2 / 55,21 -- and ' +
            '3,42 crosses solo, so this is contention rather than geometry',
    },
    hint: 'a reservation on the corridor, or staggered departures, rather than more patience',
    // The offline half of the claim: the corridor really is one square wide, which is WHY
    // the sidestep cannot help. If this ever stops being true the case needs rewriting
    // rather than re-running.
    //
    // ROWS 36-42, AND THE FIRST VERSION OF THIS SAID 35-42 AND REPORTED ITS OWN CASE OUT OF
    // DATE. Row 35 is the junction where the east-west corridor meets the north-south pipe
    // and is four squares wide; row 43 is the junction at the other end. Seven rows are the
    // single-file part. Measured rather than assumed, which is the only reason it was caught.
    offline({ geometryFor }) {
      const geo = geometryFor(108);
      if (!geo) return { checked: false, why: 'no room 108 geometry on disk' };
      const narrow = [];
      for (let r = 36; r <= 42; r++) {
        const open = [44, 45, 46, 47, 48].filter(c => !!geo.standPoint(r, c));
        if (open.length === 1 && open[0] === 47) narrow.push(r);
      }
      return { checked: true, ok: narrow.length === 7,
               detail: narrow.length + ' of rows 36-42 are exactly one square wide at col 47 ' +
                       '(35 and 43 are the junctions, four wide)' };
    },
    async run({ bots, tries, maxS }) {
      const { roomObject } = await import('./m59-dm.mjs');
      const room = await roomObject(108);
      if (room == null) return { ok: false, why: 'room 108 is not on this server' };
      const { sharedRoomGeometry } = await import('./m59-roo.mjs');
      const { loadMap } = await import('./m59-map.mjs');
      const { attachStepMasks } = await import('./m59-routes.mjs');
      const map = loadMap(); attachStepMasks(map);
      const geo = sharedRoomGeometry(map.rooms['108']);
      const names = await namesOf();
      const use = bots ?? ['shadow01', 'shadow09', 'shadow11', 'shadow12', 'shadow05', 'shadow06'];
      const starts = startsIn(geo, tries);
      const forward = await Promise.all(starts.map((s, k) =>
        tryHop(use[k % use.length], room, s, 110,
               { name: names.get(use[k % use.length]), maxMs: maxS * 1000 })));
      const scored = forward.filter(r => !r.skipped);
      const okd = scored.filter(r => r.ok);
      return {
        ok: scored.length > 0 && okd.length === scored.length,
        crossed: scored.length + ' start(s), ' + okd.length + ' crossed',
        median_s: okd.length
          ? Math.round(okd.map(r => r.ms).sort((a, b) => a - b)[okd.length >> 1] / 1000) : null,
        failures: scored.filter(r => !r.ok).map(r =>
          (r.start ? r.start.row + ',' + r.start.col : 'start unknown') +
          ' (' + String(r.why).slice(0, 40) + ')'),
      };
    },
  },

  'gully-escape': {
    title: 'escaping the sewer gully costs about a third of the health of whoever does it',
    blocking: 'not the route -- the gully IS escapable now -- but surviving the trip out',
    why:
      "Row 27 of room 108 is the gully the declared jump clears. Its note used to say a " +
      "character that falls in cannot get out again, and that was measured under the " +
      "predicate that had deleted the room's low corridor. With that ground restored a body " +
      "reaches all five anchors from 27,43, and one has been watched doing it. What is left " +
      "is that the gully is where the sewer's monsters are, so the escape is a fight.",
    measured: {
      at: '2026-08-29',
      epoch: 'd80ceac (#movement a player in the way is a queue, not a wall)',
      result: '1 of 3 escaped and crossed to 110 in 45s; 1 retreated to an inn (room 153); ' +
              '1 died and came back in the Underworld',
      health: 'all three lost about a third: 53->22, 33->14, 45->14',
      note: 'the retreat to an inn is the survival ladder working, not a failure',
    },
    hint: 'a combat question rather than a routing one -- see docs/m59-combat.md',
    // The routing half of this case is a CLAIM THAT MUST KEEP HOLDING: the gully is
    // escapable. If this check ever fails, the note in m59-falljumps.json is wrong again and
    // the case has become a routing bug rather than a combat one.
    offline({ geometryFor }) {
      const geo = geometryFor(108);
      if (!geo) return { checked: false, why: 'no room 108 geometry on disk' };
      const R = 70, C = 70, key = (r, c) => r * 1000 + c;
      const D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      const step = (a, b, c, d) => { try { return geo.moverStepLands(a, b, c, d) === true; } catch { return false; } };
      const seen = new Set([key(27, 43)]); const q = [[27, 43]];
      while (q.length) {
        const [r, c] = q.shift();
        for (const [dr, dc] of D) {
          const nr = r + dr, nc = c + dc;
          if (nr < 1 || nc < 1 || nr > R || nc > C || seen.has(key(nr, nc))) continue;
          if (!geo.standPoint(nr, nc) || !step(r, c, nr, nc)) continue;
          seen.add(key(nr, nc)); q.push([nr, nc]);
        }
      }
      const anchors = [[55, 1], [23, 1], [5, 43], [5, 42], [56, 8]];
      const reached = anchors.filter(([r, c]) => seen.has(key(r, c))).length;
      return { checked: true, ok: reached === anchors.length,
               detail: 'from the gully floor 27,43 a body reaches ' + reached + ' of 5 anchors ' +
                       'over ' + seen.size + ' squares' };
    },
    async run({ maxS }) {
      const { roomObject } = await import('./m59-dm.mjs');
      const room = await roomObject(108);
      if (room == null) return { ok: false, why: 'room 108 is not on this server' };
      const names = await namesOf();
      const rowFor = async a => (await fleetRows()).find(x => x.agent === a);
      const lines = [];
      for (const agent of ['shadow05', 'shadow06', 'shadow11']) {
        const before = await rowFor(agent);
        const r = await tryHop(agent, room, { row: 27, col: 43 }, 110,
                               { name: names.get(agent), maxMs: maxS * 1000 });
        const after = await rowFor(agent);
        lines.push(agent + ' hp ' + before?.health + ' -> ' + after?.health + '  ' +
                   (r.ok ? 'ESCAPED in ' + Math.round(r.ms / 1000) + 's'
                         : 'stopped in room ' + after?.room_num + ': ' + String(r.why).slice(0, 40)));
      }
      return { ok: lines.every(l => l.includes('ESCAPED')), lines };
    },
  },
};

// ------------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-repro.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const name = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

  if (has('list') || !name) {
    console.log('\nknown blocking cases -- each reproduces on demand\n');
    for (const [id, c] of Object.entries(CASES)) {
      console.log('  ' + id);
      console.log('      ' + c.title);
      console.log('      blocks:   ' + c.blocking);
      console.log('      measured: ' + c.measured.at + ' on ' + c.measured.epoch);
      for (const [k, v] of Object.entries(c.measured))
        if (k !== 'at' && k !== 'epoch') console.log('                ' + k + ': ' + v);
      console.log('      run:      node tools/m59-repro.mjs ' + id + ' --fleet shadow\n');
    }
    console.log('  the offline half, which fails nothing: node tools/m59-todo-test.mjs\n');
    process.exit(0);
  }

  const c = CASES[name];
  if (!c) { console.error('unknown case "' + name + '" -- try --list'); process.exit(2); }

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error('refusing: ' + target.host + ' is not loopback. These relocate bodies with ' +
                  'the DM tools, which is a lab-server power.');
    process.exit(2);
  }

  const opts = { tries: Number(flag('tries', 6)), maxS: Number(flag('max-s', 420)),
                 bots: flag('bots') ? flag('bots').split(',') : null };
  console.log('\n' + name + ' -- ' + c.title);
  console.log('  what it blocks: ' + c.blocking);
  console.log('  last measured:  ' + c.measured.at + ' on ' + c.measured.epoch);
  for (const [k, v] of Object.entries(c.measured))
    if (k !== 'at' && k !== 'epoch') console.log('                  ' + k + ': ' + v);
  console.log('\n  running it again now, epoch ' + epochId('movement') + '...\n');

  const result = await c.run(opts);
  for (const [k, v] of Object.entries(result))
    console.log('  ' + String(k).padEnd(10) + ' ' +
                (Array.isArray(v) ? v.join('\n             ') : v));

  const book = load();
  book.runs.push({ at: new Date().toISOString(), case: name, epoch: epochId('movement'), result });
  save(book);
  console.log('\n  ' + (result.ok ? 'IT DID NOT REPRODUCE -- if that holds, delete the case'
                                  : 'reproduced'));
  console.log('  recorded in ' + BOOK + '\n');
}
