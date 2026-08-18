#!/usr/bin/env node
// THE GRAVEYARD ONLY EXISTS FOR THIRTY-FIVE MINUTES IN EVERY TWO HOURS.
//
//   node tools/m59-nightshift.mjs                # where the clock is and what it would do
//   node tools/m59-nightshift.mjs --apply        # actually set the orders
//   node tools/m59-nightshift.mjs --watch        # stay up, switching the fleet at each edge
//
// WHY THIS EXISTS.
//
// The Graveyard of Tos (room 70) spawns zombies and skeletons and nothing else, and it
// spawns them ONLY at night. From the room's own source, tosgrave.kod:
//
//     plMonsters = [ [&Zombie, 85], [&Skeleton, 15] ]
//     TryCreateMonster() { iHour = Send(SYS,@GetHour); if iHour < 5 or iHour > 21 { propagate; } }
//
// Outside that window TryCreateMonster returns without propagating, so the room creates
// nothing at all. A fleet parked there by day is standing in an empty field.
//
// THE CLOCK IS ARITHMETIC ON THE WALL CLOCK, WHICH IS WHY THIS NEEDS NO PROTOCOL SUPPORT.
// system.kod derives the game hour from real time and says so in its own comment:
//
//     iTime = GetTime() - 5*HOUR
//     iMinutes = (iTime mod (2*HOUR))/60        % "Our day is 2 hours long now"
//     piHour = iMinutes/5                       % 0..119 over two hours -> 0..23
//
// So a game day is 2 REAL hours, a game hour is 5 REAL minutes, and the undead window
// (hours 22, 23, 0, 1, 2, 3, 4) is 35 real minutes in every 120 — a 29% duty cycle. There
// is a BP_LIGHT_AMBIENT packet (220) that the server pushes on every light change and our
// client does not parse; it would confirm this but is not needed to compute it.
//
// WHAT THE FLEET DOES WITH THE OTHER 85 MINUTES is the interesting half. Fungus beasts are
// level 50 and difficulty 1; nine characters are already at level 50 and a kill only
// advances when the creature's level is STRICTLY greater, so those nine cannot gain
// anything from the day grind at all. They can still earn: loot, coin for armour, and the
// vigor to be full when the window opens.
//
// AND THE DANGER IS NOT THE LEVEL, IT IS THE DIFFICULTY. GetAttackAbility is
// 3*viLevel + 60*viDifficulty:
//
//     fungus beast   level 50, difficulty 1  ->  210
//     zombie         level 55, difficulty 4  ->  405
//     skeleton       level 75, difficulty 5  ->  525
//
// So the night shift is fought against things that hit roughly twice as often as anything
// this fleet has faced. That is survivable behind armour and a wall; it is not survivable
// bare. This tool REFUSES to send an unarmoured character by default for that reason —
// see --send-bare.
import { readFileSync } from 'node:fs';

const PORT = Number(argOf('port', 8901));
const URL = `http://127.0.0.1:${PORT}/`;
const APPLY = has('apply');
const WATCH = has('watch');
const SEND_BARE = has('send-bare');
const GRAVEYARD = Number(argOf('room', 70));
// SET OFF BEFORE THE SUN GOES DOWN.
//
// The window is 35 real minutes and a walk from the Ilerian hunting grounds to Tos is ten
// to twenty. Sent AT the edge, the fleet spends the whole window travelling and arrives to
// an empty graveyard: the first live attempt re-tasked all twenty-one with eleven minutes
// left, one character reached room 70, and the fleet killed zero undead.
//
// So the shift starts early. `lead` minutes before the hour turns, everybody is already
// walking; by the time TryCreateMonster starts firing they are standing in it. Costs the
// tail of the day shift, which is the cheap end — nothing there advances a level-50
// character anyway.
const LEAD_MIN = Number(argOf('lead', 20));
const NIGHT_PREY = String(argOf('prey', 'zombie'));
// Where they work by day. Kept as the rooms the fleet already uses, because the day shift
// is about earning and topping up rather than about advancing.
const DAY_ROOMS = String(argOf('day-rooms', '562,544,563')).split(',').map(Number);
const DAY_PREY = String(argOf('day-prey', 'fungus beast'));

function has(n) { return process.argv.includes('--' + n); }
function argOf(n, d) {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
}

let id = 0;
async function call(name, args = {}, timeoutMs = 120000) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------- the clock
const HOUR = 3600;
// THE ARITHMETIC IS RIGHT AND THE EPOCH IS NOT, WHICH IS WHY THIS DEFERS TO AN ANCHOR.
//
// `system.kod` really does derive the hour from real time, and the transcription below is
// faithful — but it is anchored to the Unix epoch, and the SERVER's phase is whatever its
// own clock was doing when it started. Those agree only by luck.
//
// Measured 2026-08-18, and it is not a small drift: this function returned **game hour 10**
// — "day, the graveyard is empty, opens in 57 minutes" — while `m59-dayclock.mjs`, which is
// anchored to a shift an operator watched begin, said NIGHT with 30 minutes left. The
// server settled it: `send object 0 GetHour` answered **23**. A ~54 minute error, in the
// direction that tells a fleet to stand down during the one window it exists for.
//
// So the anchored answer wins when there is one. `m59-dayclock.mjs` owns the anchor and
// re-anchors whenever the world disagrees with it; this module is a consumer, not a second
// opinion. The derived form stays as `gameHourDerived` because it is the transcription of
// the kod and worth keeping honest — and because with no anchor file on a fresh clone it
// is still the best available guess.
export function gameHourDerived(atMs = Date.now()) {
  const iTime = Math.floor(atMs / 1000) - 5 * HOUR;
  const iMinutes = Math.floor(((iTime % (2 * HOUR)) + 2 * HOUR) % (2 * HOUR) / 60);
  return Math.floor(iMinutes / 5);
}

export function gameHour(atMs = Date.now()) {
  // A game hour is 5 real minutes and the undead window is hours 22-4, i.e. the last 35
  // minutes of every 120. The anchor names the moment a window OPENED, so the hour is
  // where `atMs` sits in that cycle — not where the epoch says it sits.
  const anchor = anchorMs();
  if (anchor == null) return gameHourDerived(atMs);
  const CYCLE = 120 * 60_000;
  const since = ((atMs - anchor) % CYCLE + CYCLE) % CYCLE;
  // Minute 0 of the cycle is game hour 22 (the window opening); each game hour is 5 min.
  return (22 + Math.floor(since / (5 * 60_000))) % 24;
}

/** The observed anchor, or null when nobody has recorded one. */
function anchorMs() {
  try {
    const { readAnchor } = anchorModule ?? {};
    const a = typeof readAnchor === 'function' ? readAnchor() : null;
    // The record's field is `night_starts_at`, an ISO string — NOT `at`, and not a number.
    // Reading the wrong field returns null, which falls silently back to the derived clock
    // and looks exactly like having no anchor at all. That is how the first version of
    // this fix shipped inert.
    const ms = a?.night_starts_at ? Date.parse(a.night_starts_at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}
let anchorModule = null;
try { anchorModule = await import('./m59-dayclock.mjs'); } catch { anchorModule = null; }
/** tosgrave.kod: spawns when the hour is under 5 or over 21. */
export const undeadAbroad = (h) => h < 5 || h > 21;

/** Real minutes until the window next changes state, and what it changes to. */
export function nextEdge(atMs = Date.now()) {
  const now = undeadAbroad(gameHour(atMs));
  for (let k = 1; k <= 121; k++) {
    const s = undeadAbroad(gameHour(atMs + k * 60_000));
    if (s !== now) return { inMinutes: k, opens: s };
  }
  return { inMinutes: null, opens: !now };
}

// ---------------------------------------------------------------- the shift
async function shift() {
  const h = gameHour();
  const spawning = undeadAbroad(h);
  const edge = nextEdge();
  // Going out is decided on where the clock will be when they ARRIVE, not where it is now.
  const soon = undeadAbroad(gameHour(Date.now() + LEAD_MIN * 60_000));
  const night = spawning || soon;
  console.log(`game hour ${h} — ${spawning ? 'NIGHT: undead are spawning' : 'day: the graveyard is empty'}` +
              `; ${spawning ? 'closes' : 'opens'} in ${edge.inMinutes} real minutes` +
              (!spawning && soon ? `  [setting out now: ${LEAD_MIN}min lead]` : ''));

  const f = await call('fleet', {});
  const rows = (f.fleet || []).filter(r => r.in_game !== false);
  if (!rows.length) { console.log('nobody in game'); return; }

  // WHO MAY GO. A zombie rates 405 and a skeleton 525 against a fungus beast's 210, so
  // "unarmoured" stops being untidy and starts being the difference between a night shift
  // and a corpse run. Checked against the server's own use list rather than the pack.
  const ARMOUR = /leather (armor|armour)|chain|plate|mail|robe/i;
  const bare = [];
  for (const r of rows) {
    const eq = await call('equipment', { agent: r.agent }).catch(() => ({ equipped: [] }));
    r._armoured = (eq.equipped || []).some(x => ARMOUR.test(String(x?.name ?? x ?? '')));
    if (!r._armoured) bare.push(r.character);
  }
  if (bare.length)
    console.log(`without body armour: ${bare.join(', ')}` +
                (night && !SEND_BARE ? ' — held back from the graveyard (--send-bare overrides)' : ''));

  let n = 0;
  for (const [i, r] of rows.entries()) {
    const goingOut = night && (r._armoured || SEND_BARE);
    const want = goingOut
      ? { hunt: NIGHT_PREY, assigned_room: GRAVEYARD }
      : { hunt: DAY_PREY, assigned_room: DAY_ROOMS[i % DAY_ROOMS.length] };

    // Diff against the keeper's own policy, which the fleet row now carries — writing
    // orders that are already set is how two writers make a character oscillate while
    // both their logs look correct.
    const pol = r.policy || {};
    const same = pol.hunt === want.hunt && pol.assignedRoom === want.assigned_room;
    if (same) continue;
    n++;
    console.log(`  ${String(r.character).padEnd(9)} ${pol.hunt ?? '?'}@${pol.assignedRoom ?? '?'}` +
                ` -> ${want.hunt}@${want.assigned_room}`);
    if (APPLY)
      await call('autopilot', { agent: r.agent, action: 'start', mode: 'farm', ...want })
        .catch(e => console.log(`    ${r.character}: ${e.message}`));
  }
  console.log(n ? (APPLY ? `${n} re-tasked` : `${n} would be re-tasked — pass --apply`)
                : 'every character already has the right orders');
}

await shift();
if (WATCH) {
  // Re-check a little more often than a game hour (5 real minutes), so an edge is never
  // missed by more than a minute.
  console.log('watching — will switch the fleet at each edge. Ctrl-C to stop.');
  setInterval(() => { shift().catch(e => console.log('shift failed:', e.message)); }, 60_000);
}
