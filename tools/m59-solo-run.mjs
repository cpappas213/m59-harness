#!/usr/bin/env node
// ONE CHARACTER AT A TIME, TOS TO CASTLE VICTORIA, AND WHETHER IT LIVED.
//
//   node tools/m59-solo-run.mjs
//   node tools/m59-solo-run.mjs --wall-below 0.9 --hold-below 0.85
//   node tools/m59-solo-run.mjs --agents shadow01,shadow02 --timeout 240
//   node tools/m59-solo-run.mjs --dry-run
//
// WHY ONE AT A TIME. Twenty-one characters crossing together is a different experiment from
// one character crossing: they queue at the same doorway, stand on each other's squares, and
// the spawn they walk through is shared. Every fleet-wide run so far has measured contention
// as much as it measured the road. This sends them in sequence, from the same square, at full
// health, and asks the only question that matters — did it get there, and if not, what
// stopped it.
//
// THE KNOB THIS EXISTS TO TURN. `travel_wall_below` is the health fraction at which a
// traveller detours to a safe wall it is passing. Raise it and shelter is sought EARLIER,
// with more health left to reach the wall with; lower it and the character presses on.
// `travel_hold_below` is the same decision at a hop boundary. Both are per character and
// live, so a sweep is a matter of running this twice.
//
// A NOTE ON THE DEFAULT, because it is not what the schema says. `autopilot`'s description
// of `travel_wall_below` reads "Default 0.6". The code is `this.policy.travelWallBelow ?? 0.8`
// in both places that consult it, and a live character reads 0.8. The documented number has
// never been the one in force.
//
// IT REFUSES A GAME SERVER THAT IS NOT LOOPBACK. Asked of the ROSTER before anything is
// touched, because that can be answered with no broker up and because the answer decides
// whether it is acceptable to walk characters into a corridor until they die.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { takeRunLock, inspectRunLock, releaseRunLock,
         exitWhenOutputIsGone } from './m59-runlock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const PORT    = Number(flag('port', 8971));
const FLEET   = flag('fleet', 'shadow');
const FROM    = Number(flag('from', 50));     // The Streets of Tos
const TO      = Number(flag('to', 38));       // Castle Victoria
const TIMEOUT = Number(flag('timeout', 240)) * 1000;
const WALL    = flag('wall-below', null);
const HOLD    = flag('hold-below', null);
const ONLY    = flag('agents', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const DRY     = has('dry-run');

// HOW MUCH HEALING A LEG MAY CHARGE TO SOMETHING OTHER THAN THE ROAD. Generous, because a
// character that walks into the Twisted Wood at 30% genuinely does need a couple of minutes
// on a wall — and bounded, because an unbounded pause is a hang. Past this the leg ends as
// `rested out`, which is its own finding: the road was never the thing that was slow.
const REST_CREDIT_MS = Number(flag('rest-credit', 180)) * 1000;

// ONLY ONE OF THESE MAY DRIVE A FLEET, AND A DEAD ONE MUST NOT KEEP DRIVING IT.
//
// Both halves were learned the same afternoon. Three copies of this script were live against
// the same twenty-one characters — one sixty-five minutes after it had been "stopped" through
// a wrapper that took the shell and left the node process, one killed at launch by a `tee`
// that could not open its file and never noticed the broken pipe. They fought for the same
// bodies and every collision reached the transit book as `movement cancelled by a newer
// command`, which is the same sentence a real survival interrupt produces. The travel bug
// being investigated was, in part, three copies of the investigation.
//
// So the run claims the fleet, a second one is refused by name, and a run whose output has
// gone away stops rather than continuing in silence. `--stop` clears a holder; `--force`
// overrides the refusal for somebody who knows what they are doing.
exitWhenOutputIsGone();

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNDERWORLD = 1;

function call(name, args, ms = 90000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try { done(JSON.parse(JSON.parse(t).result.content[0].text)); }
        catch (e) { done({ _error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// IS THIS CHARACTER DELIBERATELY STOPPED? Resting at a wall or in a sanctuary is the
// survival ladder doing its job, and it is NOT the road being slow. Counted against the
// leg's clock it produced the wrong verdict twice over: thirteen of fourteen legs ended in
// a timeout rather than a death, and a character that spent two minutes healing on a proven
// safe spot was recorded as having failed to cross — when what it actually did was survive.
const RESTING = /rest|holding a (proven|untested) safe spot|healing|recovering/i;
const isResting = ap => RESTING.test(String(ap?.activity ?? ''));

// ---------------------------------------------------------------- who is driving
if (has('stop')) {
  const found = inspectRunLock(FLEET);
  if (found.state === 'none') { console.log(`nothing holds fleet "${FLEET}"`); process.exit(0); }
  const pid = Number(found.lock?.pid);
  console.log(`fleet "${FLEET}" is ${found.state} by pid ${pid}` +
              (found.why ? ` (${found.why})` : '') +
              (found.lock?.at ? `, since ${new Date(found.lock.at).toISOString()}` : ''));
  if (found.state === 'held' && Number.isInteger(pid) && pid !== process.pid) {
    // BY PID, NEVER BY NAME. Matching `node` or `m59-*` across every process once killed a
    // live broker belonging to a different checkout and logged out its whole fleet.
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  signalled pid ${pid}`);
    } catch (e) { console.log(`  could not signal pid ${pid}: ${e.message}`); }
  }
  releaseRunLock(FLEET);
  console.log('  lock cleared');
  process.exit(0);
}

const claim = takeRunLock(FLEET, { label: `solo-run ${FROM}->${TO}`, force: has('force') });
if (!claim.ok) {
  const h = claim.holder ?? {};
  console.error(`solo-run: REFUSING — fleet "${FLEET}" is already being driven.`);
  console.error(`          pid ${h.pid}, "${h.label ?? '?'}", since ` +
                `${h.at ? new Date(h.at).toISOString() : '?'}`);
  console.error(`          ${h.argv ?? ''}`);
  console.error(`          Two runs on one fleet fight for the same bodies and both report`);
  console.error(`          "movement cancelled by a newer command". Stop that one first:`);
  console.error(`            node tools/m59-solo-run.mjs --stop --fleet ${FLEET}`);
  process.exit(3);
}
if (claim.tookOverFrom)
  console.log(`(took over a stale lock: ${claim.tookOverFrom.why})`);

// ---------------------------------------------------------------- which fleet
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`solo-run: ${rosterFile} does not name one game server.`);
  process.exit(2);
}
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`solo-run: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, not loopback.`);
  console.error(`          This walks characters into a corridor until they die. Lab servers only.`);
  process.exit(2);
}

const fleet = await call('fleet', {});
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
rows.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!rows.length) { console.error('solo-run: no characters matched.'); process.exit(1); }

console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(`${rows.length} character(s), one at a time, ${FROM} -> ${TO}, ${TIMEOUT / 1000}s each`);
console.log(`shelter: travel_wall_below ${WALL ?? '(unchanged)'}, travel_hold_below ${HOLD ?? '(unchanged)'}\n`);
if (DRY) { rows.forEach(r => console.log(`  ${r.character} (${r.agent})`)); process.exit(0); }

const dm = await import('./m59-dm.mjs');
const snap = JSON.parse(readFileSync(join(REPO, 'substrate', 'shadow-snapshot.json'), 'utf8'));
const maxOf = name => snap.characters.find(c => c.shadow_name === name)?.max_health ?? null;

console.log('  character    outcome     s   from -> ended   low  rest  rooms');
const results = [];
for (const r of rows) {
  // Same starting conditions for every one of them, or the run measures who went first.
  await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  await call('autopilot', { agent: r.agent, action: 'unpark' });
  if (WALL !== null) await call('autopilot', { agent: r.agent, travel_wall_below: Number(WALL) });
  if (HOLD !== null) await call('autopilot', { agent: r.agent, travel_hold_below: Number(HOLD) });
  await dm.relocate([r.character], FROM, { verify: false }).catch(() => null);
  const ids = await dm.resolve([r.character]);
  const max = maxOf(r.character);
  if (ids[r.character] != null && max) await dm.dm(dm.healthCmds(ids[r.character], max), { timeoutMs: 60000 });

  const started = Date.now();
  const sent = await call('travel', { agent: r.agent, to: TO, max_hops: 30, background: true }, 60000);
  let ended = null, low = null, died = false, restedMs = 0;
  const rooms = new Set([FROM]);
  if (sent?._error || sent?.refused) {
    ended = 'refused';
  } else {
    for (;;) {
      await sleep(5000);
      const [st, ap] = await Promise.all([
        call('status', { agent: r.agent }, 30000),
        call('autopilot', { agent: r.agent, action: 'status' }, 30000),
      ]);
      // THE CLOCK PAUSES WHILE IT RESTS, and the time is kept rather than discarded — a leg
      // that spent most of its budget healing is a different animal from one that spent it
      // walking, and only reporting both tells them apart.
      // A PAUSED CLOCK NEEDS A CEILING, OR IT IS NOT A PAUSE, IT IS A HANG.
      //
      // Every 5s poll that reads as resting used to add 5s of credit, with nothing bounding
      // the total — so a character that rests and never stops cancels its own timeout and
      // the leg runs for ever. It did: one run sat on its first character for ten minutes
      // and printed no rows at all, and from outside that is indistinguishable from a
      // hung broker. The instrument has to be able to fail.
      //
      // So rest still buys time, but only up to REST_CREDIT_MS. Past that the leg ends and
      // says WHY it ended — `rested out` is a different finding from `timed out`, and
      // conflating them is what this whole column exists to prevent.
      if (isResting(ap)) restedMs = Math.min(restedMs + 5000, REST_CREDIT_MS);
      const room = st?.where?.num ?? null;
      const hp = st?.vitals?.health?.value ?? null;
      if (room != null) rooms.add(room);
      if (hp != null && (low === null || hp < low)) low = hp;
      // THE UNDERWORLD IS THE DEATH, and it is the only reliable sign of one: a 5s poll
      // almost never lands on the frame where health reads zero.
      if (room === UNDERWORLD) { died = true; ended = 'DIED'; break; }
      if (room === TO) { ended = 'arrived'; break; }
      if (Date.now() - started - restedMs > TIMEOUT) {
        ended = restedMs >= REST_CREDIT_MS ? 'rested out' : 'timed out';
        break;
      }
    }
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const restSecs = Math.round(restedMs / 1000);
  const at = await call('status', { agent: r.agent }, 30000);
  results.push({ character: r.character, ended, secs, restSecs, died, low,
                 endedIn: at?.where?.num ?? null, rooms: [...rooms] });
  console.log(`  ${String(r.character).padEnd(12)} ${String(ended).padEnd(10)} ${String(secs).padStart(3)}   ` +
              `${String(FROM).padStart(4)} -> ${String(at?.where?.num ?? '?').padStart(5)}   ` +
              `${String(low ?? '?').padStart(3)}  ${String(restSecs).padStart(4)}r  ${[...rooms].join(',')}`);
}

const arrived = results.filter(r => r.ended === 'arrived').length;
const dead = results.filter(r => r.died).length;
console.log(`\n${results.length} run(s): ${arrived} arrived, ${dead} died, ` +
            `${results.length - arrived - dead} neither`);
const stops = {};
for (const r of results) if (r.ended !== 'arrived') stops[r.endedIn ?? '?'] = (stops[r.endedIn ?? '?'] ?? 0) + 1;
if (Object.keys(stops).length) {
  console.log('\nwhere the ones that did not arrive ended up:');
  for (const [k, v] of Object.entries(stops).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  room ${k}`);
}
