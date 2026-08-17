#!/usr/bin/env node
// WALK THE FLEET'S REAL ITINERARY AND TIME IT, WITH THE COLLISION ROUTING ON.
//
//   node tools/m59-circuit.mjs --route tos-jasper --bots Alpha,Bravo
//   node tools/m59-circuit.mjs --route grand --laps 2 --bots all
//   node tools/m59-circuit.mjs --list                 the named routes
//   node tools/m59-circuit.mjs --book                 what previous runs measured
//
// THE QUESTION IS WHETHER COLLISION-AWARE ROUTING IS SAFE TO PUT BACK ON THE FLEET, and
// it has three parts, none of which the fleet board can answer:
//
//   time     does the same journey take materially longer than it used to?
//   arrival  does it still get there, or does it stall somewhere?
//   damage   does it get hit more on the way — either by being slower, or by being
//            stuck somewhere with something chewing on it?
//
// THE BASELINE IS COMPROMISED AND THIS SAYS SO ON EVERY RUN. `travel_estimate` reads
// recorded per-edge times, and 85.1% of that history was recorded BEFORE collision
// routing landed (2026-08-16 18:25) — by bots that were cutting corners through geometry
// no real client can cross. So the "old speed" is optimistic by an unknown amount, and a
// measured slowdown against it is an UPPER BOUND on the real regression rather than an
// estimate of it. Reported as a range, never as a single number.
//
// ATTACKS ARE COUNTED AS SWINGS, NOT DAMAGE. A swing is deterministic evidence that
// something reached us; damage is a second roll bounded to [10,95]%. Counting
// `You dodge the ...'s attack.` off the flight recorder gives many more events per
// journey and cannot be erased by healing. Same rule as m59-provewall.
//
// IT NEVER TOUCHES PROD. The broker port defaults to the arena's 8961 and every verb
// here is addressed to a named agent; there is no fleet-wide anything.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/circuit-runs.json';
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

const PORT = Number(process.env.M59_BROKER_PORT || 8961);
const AGENTS = { TESTER: 't0', Alpha: 'arena1', Bravo: 'arena2', Charlie: 'arena3',
                 Delta: 'arena4', Echo: 'arena5' };
export const agentFor = n => AGENTS[n] ?? n;

// The itineraries the fleet actually walks, named so a run is repeatable and comparable.
export const ROUTES = {
  'tos-jasper':   { legs: [350], from: 50,  why: 'the one the operator asked for: Streets of Tos to East Jasper' },
  'jasper-tos':   { legs: [50],  from: 350, why: 'the return, which takes the same rooms reversed' },
  'bank-run':     { legs: [376, 50], from: 50, why: 'Tos out to the Royal Bank of Jasper and home' },
  'castle-sell':  { legs: [38, 101, 54], from: 50,
                    why: 'Castle Victoria, then Barloque to sell, then the Tos bank' },
  'grand':        { legs: [38, 350, 101, 50], from: 50,
                    why: 'Tos -> Castle Victoria -> Jasper -> Barloque -> Tos, the full lap' },
};

export async function broker(name, args, { timeoutMs = 300000 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { _error: `broker ${r.status}` };
    const j = await r.json();
    if (j.error) return { _error: j.error.message };
    const text = j.result?.content?.[0]?.text ?? '{}';
    // A REFUSAL COMES BACK AS PROSE, NOT AS JSON, and parsing it blindly turns a perfectly
    // clear message into a syntax error. `{"isError": true}` with a body of
    // `error: arena1 is busy: walk to Lake of Jala's Song` is the broker telling us
    // exactly what is wrong; the first version of this function reported it as
    // `Unexpected token 'e'` and lost the sentence entirely.
    if (j.result?.isError) return { _error: String(text).replace(/^error:\s*/, '') };
    try { return JSON.parse(text); }
    catch { return { _error: String(text).slice(0, 200) }; }
  } catch (e) { return { _error: e.message }; }
}

const INCOMING_SWING = /^You\s+\w+\s+.+'s attack\.?$/i;
export const isIncomingSwing = t => INCOMING_SWING.test(String(t ?? '').trim());

/** Where a character is, and how much it has been swung at since `mark`. */
export async function probe(agent, mark = 0) {
  const [st, rec] = await Promise.all([
    broker('status', { agent }, { timeoutMs: 30000 }),
    broker('recording', { agent, action: 'tail', limit: 400 }, { timeoutMs: 30000 }),
  ]);
  const tail = Array.isArray(rec?.tail) ? rec.tail : [];
  const fresh = tail.filter(e => (e.seq ?? 0) > mark);
  const swings = fresh.filter(e => e.kind === 'message' && isIncomingSwing(e.text)).length;
  const seq = tail.length ? Math.max(...tail.map(e => e.seq ?? 0)) : mark;
  const w = st?.where ?? {};
  return { room: w.num ?? null, name: w.name ?? null, busy: !!st?.busy,
           health: st?.vitals?.health?.value ?? null, max: st?.vitals?.health?.max ?? null,
           swings, seq, last: st?.last_action ?? null, error: st?._error ?? null };
}

/**
 * One leg: send a character to a room and watch until it arrives or gives up.
 *
 * BACKGROUND PLUS POLLING, not a blocking call. `travel` in the foreground holds the
 * request open for the whole walk — minutes — and with several characters that serialises
 * the entire experiment for no reason. It also means a hung leg hangs the runner, which
 * is precisely the failure being measured.
 *
 * THE STALL DETECTOR IS THE CHARACTER, NOT THE KEEPER. `ms_since_moved` measures when the
 * KEEPER last moved somebody and climbs while an errand walks perfectly well; this watches
 * the character's own room and square, which is the question actually being asked.
 */
export async function runLeg(agent, to, { pollMs = 5000, maxMs = 900000, onTick = null } = {}) {
  const start = Date.now();
  const first = await probe(agent);
  let mark = first.seq, swings = 0, lowest = first.health ?? null, deaths = 0;
  const from = first.room;

  const sent = await broker('travel', { agent, to, background: true, max_hops: 30 }, { timeoutMs: 60000 });
  if (sent?._error) return { agent, to, from, arrived: false, ms: 0, why: 'travel refused: ' + sent._error };

  let lastRoom = first.room, lastSeen = Date.now(), rooms = [first.room];
  for (;;) {
    await new Promise(r => setTimeout(r, pollMs));
    const p = await probe(agent, mark);
    mark = p.seq;
    swings += p.swings;
    if (p.health != null) {
      if (lowest == null || p.health < lowest) lowest = p.health;
      // A death shows as health at or below zero, or as an unheralded arrival in the
      // Underworld. Both are worth counting; neither is worth stopping for.
      if (p.health <= 0) deaths++;
    }
    if (p.room !== lastRoom) { rooms.push(p.room); lastRoom = p.room; lastSeen = Date.now(); }
    onTick?.({ agent, ...p, elapsed: Date.now() - start });

    if (p.room === to && !p.busy)
      return { agent, to, from, arrived: true, ms: Date.now() - start, rooms, swings, lowest, deaths };
    if (!p.busy && Date.now() - lastSeen > pollMs * 3)
      return { agent, to, from, arrived: p.room === to, ms: Date.now() - start, rooms, swings, lowest,
               deaths, why: 'stopped being busy without arriving',
               note: p.last?.note ?? p.last?.reason ?? null, stuck_in: p.room };
    if (Date.now() - start > maxMs)
      return { agent, to, from, arrived: false, ms: Date.now() - start, rooms, swings, lowest,
               deaths, why: 'timed out', stuck_in: p.room };
  }
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-circuit.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  if (has('list')) {
    for (const [k, v] of Object.entries(ROUTES))
      console.log(`  ${k.padEnd(14)} from ${String(v.from).padStart(4)} -> ${v.legs.join(' -> ').padEnd(18)} ${v.why}`);
    process.exit(0);
  }
  if (has('book')) {
    for (const r of load().runs.slice(-30))
      console.log(`${new Date(r.at).toISOString().slice(0, 16)}  ${String(r.route).padEnd(13)} ` +
                  `${r.bots} bot(s)  ${r.arrived}/${r.attempts} arrived  median ${Math.round((r.median_ms || 0) / 1000)}s  ` +
                  `baseline ${Math.round((r.baseline_ms || 0) / 1000)}s  swings ${r.swings}  deaths ${r.deaths}`);
    process.exit(0);
  }

  const routeName = flag('route', 'tos-jasper');
  const route = ROUTES[routeName];
  if (!route) { console.error(`unknown route "${routeName}" — try --list`); process.exit(2); }
  const laps = Number(flag('laps', 1));
  const botArg = flag('bots', 'Alpha,Bravo,Charlie,Delta,Echo');
  const bots = botArg === 'all' ? Object.keys(AGENTS).filter(n => n !== 'TESTER')
                                : botArg.split(',').map(s => s.trim()).filter(Boolean);

  // The baseline the fleet's own history predicts, so the slowdown is stated against
  // something rather than asserted. Its provenance is printed with it.
  let baseline = 0;
  {
    let at = route.from;
    for (const leg of route.legs) {
      const e = await broker('travel_estimate', { from: at, to: leg }, { timeoutMs: 30000 });
      baseline += Number(e?.ms ?? 0);
      at = leg;
    }
  }

  console.log(`route ${routeName}: ${route.why}`);
  console.log(`  ${route.from} -> ${route.legs.join(' -> ')}   x${laps} lap(s)   bots: ${bots.join(', ')}`);
  console.log(`  baseline from recorded history: ${Math.round(baseline / 1000)}s per lap`);
  console.log('  NOTE: 85.1% of that history predates collision routing, so it is optimistic;');
  console.log('  a measured slowdown against it is an UPPER BOUND on the real regression.\n');

  const results = [];
  for (let lap = 1; lap <= laps; lap++) {
    for (const leg of route.legs) {
      process.stdout.write(`lap ${lap}  -> ${leg}  `);
      const t0 = Date.now();
      // ALL BOTS AT ONCE, because that is how the fleet travels and because bodies
      // blocking bodies is one of the things being measured. Serialising them would
      // measure a world with one character in it.
      const legs = await Promise.all(bots.map(b => runLeg(agentFor(b), leg)));
      const ok = legs.filter(r => r.arrived).length;
      const times = legs.filter(r => r.arrived).map(r => r.ms).sort((a, b) => a - b);
      const med = times.length ? times[Math.floor(times.length / 2)] : 0;
      const sw = legs.reduce((s, r) => s + (r.swings || 0), 0);
      console.log(`${ok}/${legs.length} arrived, median ${Math.round(med / 1000)}s, ` +
                  `${sw} swing(s) taken, ${Math.round((Date.now() - t0) / 1000)}s wall`);
      for (const r of legs.filter(x => !x.arrived))
        console.log(`     ${r.agent} STUCK in ${r.stuck_in ?? '?'} — ${r.why}${r.note ? ': ' + r.note : ''}`);
      results.push({ lap, leg, legs });
    }
  }

  const all = results.flatMap(r => r.legs);
  const arrived = all.filter(r => r.arrived);
  const times = arrived.map(r => r.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  const swings = all.reduce((s, r) => s + (r.swings || 0), 0);
  const deaths = all.reduce((s, r) => s + (r.deaths || 0), 0);

  console.log(`\n=== ${routeName} ===`);
  console.log(`  arrived      ${arrived.length}/${all.length}`);
  console.log(`  median leg   ${Math.round(median / 1000)}s`);
  console.log(`  swings taken ${swings}   deaths ${deaths}`);
  if (baseline > 0 && median > 0) {
    const perLeg = baseline / Math.max(1, route.legs.length);
    const pct = 100 * (median - perLeg) / perLeg;
    console.log(`  vs baseline  ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (upper bound; the baseline is optimistic)`);
  }

  const b = load();
  b.runs.push({ at: Date.now(), route: routeName, laps, bots: bots.length,
                attempts: all.length, arrived: arrived.length, median_ms: median,
                baseline_ms: baseline, swings, deaths,
                stuck: all.filter(r => !r.arrived).map(r => ({ agent: r.agent, in: r.stuck_in, why: r.why })) });
  save(b);
  console.log(`\nrecorded in ${BOOK}`);
}
