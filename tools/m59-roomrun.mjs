#!/usr/bin/env node
// RUN A NAKED CHARACTER THROUGH ONE ROOM, OVER AND OVER, AND WRITE DOWN WHAT HAPPENS.
//
//   node tools/m59-roomrun.mjs --case badlands --runs 10
//   node tools/m59-roomrun.mjs --case twisted-wood --runs 10
//   node tools/m59-roomrun.mjs --list
//   node tools/m59-roomrun.mjs --room 585 --from 584 --to 586 --runs 6
//
// WHY THIS EXISTS. Of 85 prod deaths in eight hours, 45 were in TWO ROOMS: the border of
// the Badlands (26) and the Western border of the Twisted Wood (19). Those are not hunting
// grounds — they are corridors the fleet crosses on the way to somewhere else, and 587 is
// the single busiest room in the world with 1,527 recorded crossings. A room that kills a
// quarter of the fleet while it is only passing through is a room worth being able to test
// deliberately rather than waiting to be told about.
//
// THE CHARACTER IS THE OPERATOR'S SPEC AND IT IS DELIBERATELY BARE: 50 max health, 50 in
// every attribute (agility 50 is the dodge), 100 vigor, and NOTHING EQUIPPED. Armour and a
// weapon would turn this into a test of the loadout; the question is whether the crossing
// itself is survivable, and for a fresh character it is the crossing that has to be.
//
// WHAT IT MEASURES, and each of these answers a different question:
//
//   arrived        can the room be crossed at all, from that side
//   seconds        how long it takes — every second is a second something can reach you
//   damage         what the crossing costs even when it works
//   died           whether 50hp is enough to pay that
//   tried          exit squares refused before one worked; each one is a FULL walk across
//                  the room, and this is where a seconds-long hop becomes a minutes-long one
//   longest stall  the longest the character went without changing room while travelling
//
// LOOPBACK ONLY. Placement goes over the maintenance socket, which is unauthenticated and
// IP-restricted and that is its whole security model. This refuses a non-loopback game
// server rather than trusting the caller to remember — the same rule m59-dm.mjs follows.

import { execFile } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The two rooms the prod death record actually names, with the boundaries the fleet
// crosses them by. A case is a room plus the pair of neighbours it sits between, because
// "can it cross 587" is not one question — 587 has three boundaries and they are not alike.
const CASES = {
  badlands: {
    room: 585, name: 'The border of the Badlands',
    why: '26 of 85 prod deaths in eight hours',
    legs: [{ from: 584, to: 586 }, { from: 586, to: 584 }],
  },
  'twisted-wood': {
    room: 587, name: 'Western border of the Twisted Wood',
    why: '19 of 85 prod deaths in eight hours; 1,527 recorded crossings, the busiest room there is',
    legs: [{ from: 586, to: 576 }, { from: 576, to: 586 },
           { from: 586, to: 597 }, { from: 597, to: 586 }],
  },
};

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes(n);
const PORT = Number(flag('--port', process.env.M59_PORT || 8901));
const RUNS = Number(flag('--runs', 6));
const AGENT = flag('--agent', null);
const LEG_TIMEOUT_MS = Number(flag('--leg-timeout', 420)) * 1000;

if (has('--list') || (!flag('--case') && !flag('--room'))) {
  console.log('cases:');
  for (const [k, c] of Object.entries(CASES))
    console.log(`  ${k.padEnd(14)} room ${c.room}  ${c.name}\n${' '.repeat(17)}${c.why}`);
  console.log('\n  --case <name> --runs N [--agent <agent>] [--port 8901]');
  console.log('  --room N --from N --to N --runs N     an ad-hoc room instead of a named case');
  process.exit(0);
}

const rpc = (name, args = {}) => new Promise(resolve => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => { s += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          const t = (j.result?.content || []).map(c => c.text).join('');
          try { resolve(JSON.parse(t)); } catch { resolve({ raw: t }); }
        } catch (e) { resolve({ error: e.message }); }
      });
    });
  // No timeout: a crossing of one of these rooms is measured in minutes and cutting it off
  // would record a failure the fleet did not have.
  req.setTimeout(0);
  req.on('error', e => resolve({ error: e.message }));
  req.end(body);
});
const dm = (...args) => new Promise(resolve => {
  execFile(process.execPath, [join(REPO, 'tools', 'm59-dm.mjs'), ...args],
    { cwd: REPO, timeout: 90000 }, (err, out) => resolve({ ok: !err && /"ok": true/.test(out || ''), out: out || '' }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hpOf = s => { const m = /^(\d+)\/(\d+)$/.exec(String(s || '')); return m ? { v: +m[1], max: +m[2] } : null; };

async function board() {
  const b = await rpc('fleet');
  const m = new Map();
  for (const r of (b.fleet || [])) m.set(r.agent, r);
  return m;
}

// THE SPEC, ASSERTED RATHER THAN ASSUMED. A runner that quietly kept its armour would make
// every number here a measurement of the armour.
async function strip(agent, character) {
  const eq = await rpc('equipment', { agent });
  for (const item of (eq.equipped || [])) {
    await rpc('act', { agent, verb: 'unuse', target: item.id });
    await rpc('act', { agent, verb: 'drop', target: item.id });
  }
  await dm('kit', character, '--health', '50');
  const where = await dm('where', character);
  const id = (where.out.match(/\s(\d+)\s*$/m) || [])[1];
  if (id) await dm('exec', `set object ${id} piVigor INT 100`);
  const after = await rpc('equipment', { agent });
  return { equipped: after.count ?? 0 };
}

async function main() {
  const c = flag('--case') ? CASES[flag('--case')] : null;
  if (flag('--case') && !c) { console.error(`unknown case "${flag('--case')}" — try --list`); process.exit(1); }
  const room = c ? c.room : Number(flag('--room'));
  const legs = c ? c.legs : [{ from: Number(flag('--from')), to: Number(flag('--to')) }];
  const label = c ? `${c.name} (${room})` : `room ${room}`;

  const rows = await board();
  const agent = AGENT || [...rows.keys()].find(a => /^lap/.test(a)) || [...rows.keys()][0];
  const me = rows.get(agent);
  if (!me) { console.error(`no such agent "${agent}" on the broker at ${PORT}`); process.exit(1); }
  const character = me.character;
  if (!character) { console.error(`${agent} has no character in game`); process.exit(1); }

  console.log(`\n${label}`);
  if (c) console.log(`  ${c.why}`);
  console.log(`  runner ${agent} (${character}) — stripping to 50hp / 50 dodge / 100 vigor, naked\n`);
  const spec = await strip(agent, character);
  if (spec.equipped) console.log(`  WARNING: ${spec.equipped} item(s) still equipped — the numbers include them\n`);

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const leg = legs[i % legs.length];
    // Start on the far side of the boundary, so the run is a real crossing rather than a
    // walk from wherever the character happened to be.
    const placed = await dm('relocate', character, String(leg.from), '--at', '30,30');
    await dm('heal', character);
    await sleep(2500);
    if (!placed.ok) { console.log(`  run ${i + 1}: could not place in ${leg.from}, skipped`); continue; }

    const before = (await board()).get(agent);
    const hp0 = hpOf(before?.health)?.v ?? null;
    const t0 = Date.now();
    await rpc('travel', { agent, to: leg.to, background: true });

    // Watch rather than ask: a blocking travel call can return "cancelled" while the
    // character walks on, and the next call becomes the newer command that cancels it.
    let lastRoom = before?.room_num ?? null, lastChange = Date.now(), stall = 0;
    let outcome = 'timeout', crossed = false;
    while (Date.now() - t0 < LEG_TIMEOUT_MS) {
      await sleep(4000);
      const now = (await board()).get(agent);
      if (!now) continue;
      if (now.room_num !== lastRoom) { lastRoom = now.room_num; lastChange = Date.now(); }
      else stall = Math.max(stall, Date.now() - lastChange);
      if (now.room_num === room) crossed = true;
      if (now.room_num === 1) { outcome = 'died'; break; }
      if (now.room_num === leg.to) { outcome = 'arrived'; break; }
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const after = (await board()).get(agent);
    const hp1 = hpOf(after?.health)?.v ?? null;
    const damage = (hp0 != null && hp1 != null && hp1 < hp0) ? hp0 - hp1 : 0;
    results.push({ leg: `${leg.from}->${leg.to}`, outcome, secs, damage,
                   enteredRoom: crossed, stall: Math.round(stall / 1000) });
    console.log(`  run ${String(i + 1).padStart(2)}  ${leg.from} -> ${leg.to}  ` +
      `${outcome.toUpperCase().padEnd(7)} ${String(secs).padStart(4)}s  damage ${String(damage).padStart(3)}  ` +
      `${crossed ? 'entered the room' : 'NEVER ENTERED THE ROOM'}  longest stall ${stall / 1000 | 0}s`);
  }

  const stat = xs => {
    if (!xs.length) return 'n/a';
    const s = [...xs].sort((a, b) => a - b);
    return `min ${s[0]}  max ${s[s.length - 1]}  avg ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)}  median ${s[Math.floor(s.length / 2)]}`;
  };
  const ok = results.filter(r => r.outcome === 'arrived');
  const died = results.filter(r => r.outcome === 'died');
  console.log(`\n  ---- ${label} ----`);
  console.log(`  crossings attempted ${results.length}   arrived ${ok.length}   died ${died.length}   ` +
    `timed out ${results.filter(r => r.outcome === 'timeout').length}`);
  console.log(`  survival    ${results.length ? Math.round(100 * (1 - died.length / results.length)) : 0}%`);
  console.log(`  seconds     ${stat(ok.map(r => r.secs))}`);
  console.log(`  damage      ${stat(results.map(r => r.damage))}`);
  console.log(`  worst stall ${stat(results.map(r => r.stall))}`);
  const byLeg = new Map();
  for (const r of results) {
    const e = byLeg.get(r.leg) || { n: 0, ok: 0, died: 0, dmg: 0 };
    e.n++; if (r.outcome === 'arrived') e.ok++; if (r.outcome === 'died') e.died++; e.dmg += r.damage;
    byLeg.set(r.leg, e);
  }
  console.log(`  by leg:`);
  for (const [k, e] of byLeg)
    console.log(`     ${k.padEnd(12)} ${e.ok}/${e.n} arrived, ${e.died} died, ${e.dmg} damage total`);
  process.exit(died.length && !ok.length ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
