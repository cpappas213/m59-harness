#!/usr/bin/env node
// DRIVE A FLEET BACK AND FORTH SO THE TRAVEL CODE GETS EXERCISED.
//
//   node tools/m59-commute.mjs --port 8971            # run it
//   node tools/m59-commute.mjs --port 8971 --once     # one round, then exit
//
// Each character is given an inn and a destination and walks between them for ever. The
// point is not the walking: it is that five different roads, twenty-one bodies and a few
// hours produce the transit ledger and the keeper ledger that every travel fix here has been
// argued from.
//
// WHY AN EXTERNAL DRIVER AT ALL. The keeper owns "get back where you belong" through
// `assignedRoom`, and that is the right mechanism for a PLACE — it is what `spread` is built
// on. It cannot express a COMMUTE, because a commute has two destinations and a keeper has
// one. So this is orchestration the harness genuinely does not have, and it is deliberately
// the only thing in it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// EVERY BUG THIS FILE HAS HAD WAS THE SAME BUG: IT SENT A COMMAND TO A CHARACTER THAT HAD
// SOMETHING BETTER TO DO.
//
// `travel` supersedes whatever movement is in flight, and the ledger records that as
// `movement cancelled by a newer command`. Measured across three windows, this driver was
// the LARGEST single cause of travel failure in the fleet — 54 of 183 in one, 18 of 34 in
// another, 33 of 56 in a third — and the journeys it cancelled were the ones that could
// least afford it:
//
//   * a character resting at a safe wall part-way through a trip reads "holding a proven
//     safe spot" and does not change room, so a stillness counter calls it stuck
//   * one resting to full before setting out, which travel_start_health asks for and which
//     takes minutes, reads "resting" for the same reason
//   * one that has reached its destination may still be finishing the journey that got it
//     there, and the turn-round send cancels the tail of it
//
// So there is exactly one rule in this file and `decide` is the whole of it: DO NOT SEND TO
// A CHARACTER THAT IS BUSY. `committed` is the authority — the broker sets it for the whole
// journey whatever the body is doing inside it — and the activity string is a second opinion
// for the deliberate standing-still the harness does between journeys.
// ─────────────────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

export const UNDERWORLD_ROOM = 1;
export const POLL_MS = Number(process.env.M59_COMMUTE_POLL || 30000);
export const DWELL_MS = Number(process.env.M59_COMMUTE_DWELL || 120000);
export const STUCK_POLLS = Number(process.env.M59_COMMUTE_STUCK_POLLS || 3);
export const RESEND_QUIET_MS = Number(process.env.M59_COMMUTE_RESEND_QUIET || 120000);
// One body at a time through a shared doorway. The Yonder Inn is 10x14 with a single door
// and four characters were staged in it; whether crowding is what fails there is still open
// (staggering did not move the number), but two bodies aiming at one square is not something
// this driver should be creating on purpose.
export const DEPART_GAP_MS = Number(process.env.M59_COMMUTE_DEPART_GAP || 25000);
// Below this a character is left alone to recover rather than given a road to walk. Not a
// survival mechanism — the keeper owns that — just a refusal to make things worse.
export const MIN_HEALTH = Number(process.env.M59_COMMUTE_MIN_HEALTH || 0.6);

/** Health as a fraction, or null when the row does not say. "37/49" or {value,max}. */
export function healthFraction(row) {
  const h = row?.health;
  if (h && typeof h === 'object' && Number.isFinite(h.value) && h.max > 0) return h.value / h.max;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(h ?? ''));
  if (!m) return null;
  const max = Number(m[2]);
  return max > 0 ? Number(m[1]) / max : null;
}

/**
 * IS THIS CHARACTER BUSY? The one question that matters, and it has two sources.
 *
 * `committed` is the broker's own answer and is set for the whole journey however the body
 * is spending it — walking, resting at a wall, sitting in an inn. It is the authority.
 *
 * The activity string catches the deliberate standing-still that happens BETWEEN journeys,
 * where nothing is committed and the character is still doing something worth not
 * interrupting: recovering, eating for vigor, holding a wall, trading, fighting.
 */
export function busy(row) {
  if (row?.committed) return 'a journey is steering';
  const act = String(row?.activity ?? '');
  if (/travel|walk|journey/i.test(act)) return act;
  if (/rest|eat|hold|sit|heal|trad|shop|bank|fight|hunt/i.test(act)) return act;
  return null;
}

/** Why this character should be left alone entirely this round, or null. */
export function unavailable(row) {
  if (row?.in_game === false) return 'not in game';
  if (row?.room_num === UNDERWORLD_ROOM) return 'in the Underworld — the keeper is walking it out';
  const frac = healthFraction(row);
  if (frac !== null && frac < MIN_HEALTH)
    return `at ${Math.round(frac * 100)}% health — letting it recover before adding a journey`;
  return null;
}

/**
 * WHAT TO DO WITH ONE CHARACTER THIS ROUND. Pure, so it can be argued with offline.
 *
 * Returns { action, reason, going?, startDwell? } where action is one of:
 *   'skip'    leave it alone; reason says why
 *   'arrive'  it has just reached its target — start the dwell clock
 *   'send'    issue travel to `going`
 *
 * `state` is this character's row of the driver's own bookkeeping and is NOT mutated here.
 */
export function decide(row, state, opts = {}) {
  const now = opts.now ?? Date.now();
  const target = state.going === 'dest' ? state.dest : state.inn;
  const lastDeparture = opts.lastDeparture ?? 0;
  const room = row?.room_num ?? null;

  // 1. NOTHING ELSE IS CONSIDERED FIRST. Dead, recovering or logged out beats every other
  //    branch below, and both of the others end in a send.
  const why = unavailable(row);
  if (why) return { action: 'skip', reason: why, resetDwell: true, resetStill: true };

  // 2. BUSY BEATS EVERYTHING TOO, INCLUDING BEING AT THE DESTINATION. A character standing
  //    in the room it was sent to may still be finishing the journey that got it there, and
  //    the turn-round send used to cancel the tail of it. This is the check that was missing.
  const doing = busy(row);
  if (doing) return { action: 'skip', reason: doing, busy: true };

  // 3. ARRIVED. Dwell, then turn round — but only once the doorway is free, so this driver
  //    is not itself putting several bodies on one exit square.
  if (room === target) {
    if (!state.arrivedAt) return { action: 'arrive', reason: `reached ${room}` };
    if (now - state.arrivedAt < DWELL_MS) return { action: 'skip', reason: 'dwelling' };
    if (now - lastDeparture < DEPART_GAP_MS)
      return { action: 'skip', reason: 'waiting for the doorway to clear' };
    const going = state.going === 'dest' ? 'inn' : 'dest';
    return { action: 'send', going, room,
             reason: `turning round for ${going === 'dest' ? state.dest : state.inn}` };
  }

  // 4. NOT THERE, NOT BUSY, NOT RECOVERING. Only now is a stillness counter meaningful —
  //    and it still has to be quiet for a while, because a journey that has just ended
  //    leaves a character idle for a moment before the next one is issued.
  if (state.still >= STUCK_POLLS && now - state.sent > RESEND_QUIET_MS
      && now - lastDeparture >= DEPART_GAP_MS)
    return { action: 'send', going: state.going, room,
             reason: `idle in ${room} for ${state.still} rounds` };
  return { action: 'skip', reason: 'en route' };
}

// ---------------------------------------------------------------- the runner

async function main() {
  const PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));
  const call = async (name, args = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.map(c => c.text).join('') ?? '';
    try { return JSON.parse(text); } catch { return text || j; }
  };

  // The route each character walks. Read from a file so this tool carries no roster of its
  // own — orders belong to the machine that gives them, not to the repository.
  const planPath = arg('--plan', join(HERE, '..', 'substrate', 'commute.json'));
  let plan;
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); }
  catch (e) {
    console.error(`no commute plan at ${planPath} — ${e.message}`);
    console.error('It is {"agents":{"shadow01":{"inn":52,"dest":39}, ...}}');
    process.exit(2);
  }
  const agents = Object.entries(plan.agents ?? {});
  if (!agents.length) { console.error('the plan names no agents'); process.exit(2); }

  const state = new Map(agents.map(([a, r]) => [a, {
    inn: Number(r.inn), dest: Number(r.dest), going: 'dest',
    lastRoom: null, still: 0, arrivedAt: 0, sent: 0, laps: 0, lastReason: null,
  }]));
  const lastDeparture = new Map();

  console.log(`commute: ${agents.length} character(s), poll ${POLL_MS / 1000}s, ` +
              `dwell ${DWELL_MS / 1000}s, re-send after ${STUCK_POLLS} idle rounds`);

  for (;;) {
    const f = await call('fleet', {}).catch(() => null);
    if (!f?.fleet) { await new Promise(r => setTimeout(r, POLL_MS)); continue; }
    const acts = [];
    let atDest = 0, atInn = 0, busyCount = 0;

    for (const row of f.fleet) {
      const s = state.get(row.agent);
      if (!s) continue;
      if (row.room_num === s.lastRoom) s.still++; else { s.still = 0; s.lastRoom = row.room_num; }
      const target = s.going === 'dest' ? s.dest : s.inn;
      if (row.room_num === target) { if (s.going === 'dest') atDest++; else atInn++; }

      const d = decide(row, s, { lastDeparture: lastDeparture.get(row.room_num) ?? 0 });
      if (d.resetStill) s.still = 0;
      if (d.resetDwell) s.arrivedAt = 0;
      if (d.busy) busyCount++;

      if (d.action === 'skip') {
        // Only speak when the reason CHANGES, or a fleet of twenty-one prints the same
        // twenty-one lines every thirty seconds and the round that matters is invisible.
        if (d.reason !== s.lastReason && !/dwelling|en route/.test(d.reason)) {
          s.lastReason = d.reason;
          acts.push(`${row.character} ${d.reason}`);
        }
        continue;
      }
      s.lastReason = null;
      if (d.action === 'arrive') { s.arrivedAt = Date.now(); acts.push(`${row.character} ${d.reason}`); continue; }

      s.going = d.going;
      s.arrivedAt = 0;
      s.sent = Date.now();
      s.still = 0;
      if (d.going === 'dest' && d.reason.startsWith('turning')) s.laps++;
      lastDeparture.set(d.room, Date.now());
      await call('travel', { agent: row.agent, to: d.going === 'dest' ? s.dest : s.inn,
                             background: true }).catch(() => null);
      acts.push(`${row.character} ${d.reason}`);
    }

    const laps = [...state.values()].reduce((n, s) => n + s.laps, 0);
    console.log(`${new Date().toISOString().slice(11, 19)}  at dest: ${atDest}  at inn: ${atInn}  ` +
                `busy: ${busyCount}  laps: ${laps}` + (acts.length ? '\n    ' + acts.join('\n    ') : ''));
    if (argv.includes('--once')) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
