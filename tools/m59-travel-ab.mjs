#!/usr/bin/env node
// DID RESTING AT A SAFE WALL MID-JOURNEY MAKE A CHARACTER DIE LESS?
//
// ===================== CLOSED 2026-08-21. THE ARMS NO LONGER SPLIT. =====================
//
// This tool still reads the historical rows and still prints the tally, because the rows
// exist and somebody will want to know what they said. What it no longer does is ask for
// more data: `travel_hold` defaults to `on` and `ab`/`half` are accepted as `on`, so from
// the retirement forward every journey is in the holding arm and the control arm is frozen
// at whatever it had.
//
// WHY IT WAS CLOSED WITHOUT REACHING SIGNIFICANCE, which is worth writing down because it
// is not the usual reason. The experiment compared two ways of TRAVELLING WELL. The deaths
// this fleet actually suffers are not that: characters get stuck, lost or unresponsive and
// are eaten where they stand. Cccc, 2026-08-21 — walked out of a sanctuary at 27% health
// against a 70% flee threshold, into a room with six things in it, killed over twenty-two
// seconds with nothing driving at all. Neither arm addresses that, and the control arm was
// paying for the privilege of asking: half of every journey deliberately walked a hurt
// character straight past the only free healing on the road.
//
// So the intervention that mattered was never the wall. It was the keeper still being
// awake — see TRAVEL_GUARD_DEFAULTS in m59-autopilot.mjs.
//
//   node tools/m59-travel-ab.mjs              # the result so far, and whether to believe it
//   node tools/m59-travel-ab.mjs --hours 48
//   node tools/m59-travel-ab.mjs --json
//
// THE OUTCOME IS DEATHS. Only deaths. That is not a shortcut, it is the hypothesis: the
// thing players tell each other is that fighting from a wall means you take MORE damage
// and die LESS. If that is true, then any measurement built on damage taken would show the
// treatment arm looking worse while it was working, and the experiment would reject the
// one intervention worth having. Damage is reported below as a MECHANISM CHECK — if the
// holding arm is not taking more damage, the holds are not doing anything — and it is
// never the verdict.
//
// THE COST OF THAT CHOICE IS TIME, and this tool says so on every run rather than letting
// somebody read a two-hour result as an answer. Travelling deaths run at roughly one per
// 1,180 journeys. Detecting a halving needs on the order of 30 deaths in the control arm;
// at the fleet's ~6,800 multi-hop journeys a day that is the better part of a week.
//
// THE UNIT IS THE JOURNEY, not the character. Characters differ by max health, hunting
// ground and strategy, and with twenty-one of them a split by character would be
// confounded by all three. Randomising per journey lets every character contribute to both
// arms, so those differences cancel instead of needing to be modelled.
//
// Journeys come from `travel_journey` ledger events; deaths from the postmortems, joined
// on `summary.travel_arm`, which the keeper stamps for as long as a journey is in flight.
import { readLedger } from './m59-ledger.mjs';
import { loadPostmortems } from './m59-postmortems.mjs';
import { fleetScope, partition, scopeLine } from './m59-fleetscope.mjs';
import { isTravelTrip } from './m59-travel-kind.mjs';

export { isTravelTrip } from './m59-travel-kind.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const HOURS = Number(arg('hours', 24));
const sinceMs = HOURS * 3600 * 1000;

// ------------------------------------------------------------------ statistics
//
// Deliberately the crudest defensible thing. A rare-event A/B wants a proportion test, and
// anything fancier here would be a second place for the answer to live.

// Two-proportion z test. Returns the p-value for "these two rates are the same".
export function twoProportion(a, na, b, nb) {
  if (!na || !nb) return null;
  const pa = a / na, pb = b / nb;
  const p = (a + b) / (na + nb);
  const se = Math.sqrt(p * (1 - p) * (1 / na + 1 / nb));
  if (!se) return null;
  const z = (pa - pb) / se;
  // Normal tail, Abramowitz & Stegun 26.2.17. Two-sided.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const pv = d * t * (1.330274 * t ** 4 - 1.821256 * t ** 3 + 1.781478 * t * t - 0.356538 * t + 0.319381);
  return { z, p: 2 * pv };
}

// HOW MUCH LONGER. The number somebody actually wants when the answer is "not yet".
// Events needed in the control arm to see a `reduction` with 80% power at alpha 0.05,
// from the standard two-proportion sample-size formula collapsed to the rare-event case.
export function eventsNeeded(reduction) {
  // n_events(control) ~= (z_a/2 + z_b)^2 * (1 + (1-r)) / (r^2)  for small p, per arm.
  const zA = 1.959964, zB = 0.8416212;
  const r = reduction;
  return Math.ceil((zA + zB) ** 2 * (2 - r) / (r * r));
}

// ------------------------------------------------------------------ the data

// GUARDED, so the arithmetic above can be imported and tested without this file going and
// reading a live ledger. m59-supervise.mjs carries the same guard for the same reason.
const isMain = import.meta.filename === process.argv[1];
if (!isMain) { /* imported for the helpers only */ } else {

const scope = await fleetScope({ argv, allFleets: argv.includes('--all-fleets') });

const { events } = readLedger({ sinceMs });
// Direct room changes used to be written as journeys even though there is no
// intermediate map in which the hold treatment can fire. Keeping them in the
// denominator measures zoning frequency, not travel safety.
const journeys = events.filter(e => e.kind === 'travel_journey' && isTravelTrip(e));
const pauses = events.filter(e => e.kind === 'travel_pause');
const holds = events.filter(e => e.kind === 'travel_hold');

const mine = (rows) => scope.characters
  ? rows.filter(r => scope.characters.has(r.character)) : rows;

const J = mine(journeys), P = mine(pauses), H = mine(holds);

// A death counts for an arm when the character was ON a journey of that arm. Deaths off a
// journey are not this experiment's business and are excluded rather than split.
const { kept: deaths } = partition(loadPostmortems({ sinceMs }), scope);
const onJourney = deaths.map(d => ({ d, arm: d?.travel_arm?.arm ?? null }))
  .filter(x => x.arm);

const arms = ['walk', 'hold'];
const tally = {};
for (const a of arms) {
  const js = J.filter(j => j.arm === a);
  tally[a] = {
    journeys: js.length,
    deaths: onJourney.filter(x => x.arm === a).length,
    legs: js.reduce((t, j) => t + (j.legs || 0), 0),
    ms: js.reduce((t, j) => t + (j.ms || 0), 0),
    held_ms: js.reduce((t, j) => t + (j.held_ms || 0), 0),
    // The mechanism check, never the verdict.
    hp_lost: js.reduce((t, j) => t + Math.max(0, (j.hp_start ?? 0) - (j.hp_end ?? 0)), 0),
    candidates: P.filter(p => p.arm === a).length + H.filter(h => h.arm === a).length,
    holds: H.filter(h => h.arm === a).length,
  };
}

const out = {
  window_hours: HOURS,
  scope: { fleet: scope.fleet, from: scope.from },
  arms: tally,
  deaths_off_journey: deaths.length - onJourney.length,
};

if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const rate = (t) => t.journeys ? (1000 * t.deaths / t.journeys) : null;
const fmt = (n, d = 1) => (n == null ? '—' : n.toFixed(d));

console.log(`RESTING AT A WALL MID-JOURNEY — last ${HOURS}h`);
console.log('  ' + scopeLine(scope) + '\n');

console.log('                       walk on      hold at a wall');
console.log(`  journeys          ${String(tally.walk.journeys).padStart(10)}  ${String(tally.hold.journeys).padStart(16)}`);
console.log(`  DEATHS            ${String(tally.walk.deaths).padStart(10)}  ${String(tally.hold.deaths).padStart(16)}`);
console.log(`  per 1000 journeys ${fmt(rate(tally.walk), 2).padStart(10)}  ${fmt(rate(tally.hold), 2).padStart(16)}`);
console.log();
console.log(`  moments a hold was warranted ${String(tally.walk.candidates).padStart(6)}  ${String(tally.hold.candidates).padStart(16)}`);
console.log(`  holds actually taken         ${String(tally.walk.holds).padStart(6)}  ${String(tally.hold.holds).padStart(16)}`);
console.log(`  time held (s)                ${String(Math.round(tally.walk.held_ms / 1000)).padStart(6)}  ${String(Math.round(tally.hold.held_ms / 1000)).padStart(16)}`);
console.log();
console.log('  MECHANISM CHECK — not the verdict. The hypothesis is MORE damage, FEWER deaths,');
console.log('  so the holding arm losing more health is the fix working, not failing.');
console.log(`  health lost per journey      ${fmt(tally.walk.journeys ? tally.walk.hp_lost / tally.walk.journeys : null, 2).padStart(6)}  ${fmt(tally.hold.journeys ? tally.hold.hp_lost / tally.hold.journeys : null, 2).padStart(16)}`);
console.log(`  seconds per journey          ${fmt(tally.walk.journeys ? tally.walk.ms / tally.walk.journeys / 1000 : null).padStart(6)}  ${fmt(tally.hold.journeys ? tally.hold.ms / tally.hold.journeys / 1000 : null).padStart(16)}`);

console.log('\nVERDICT — THE EXPERIMENT IS CLOSED (2026-08-21)');
console.log('  Holding is the BEHAVIOUR now, not a treatment: travel_hold defaults to "on" and');
console.log('  ab/half are accepted as "on". The control arm is frozen at whatever it had, so');
console.log('  the numbers above stop moving from here and no amount of waiting changes them.');
console.log('  It was not closed by reaching significance. It was closed because the QUESTION was');
console.log('  wrong: it compared two ways of travelling WELL, and what kills this fleet is being');
console.log('  stuck, lost or unresponsive and eaten where it stands — which neither arm touched,');
console.log('  while the control arm paid for the asking by walking hurt characters past the only');
console.log('  free healing on the road. See TRAVEL_GUARD_DEFAULTS in m59-autopilot.mjs.');
const nW = tally.walk.journeys, nH = tally.hold.journeys;
const dW = tally.walk.deaths, dH = tally.hold.deaths;
if (!nW || !nH) {
  console.log('\n  Not enough of a split was ever recorded to compare. That is now permanent.');
} else {
  const t = twoProportion(dW, nW, dH, nH);
  console.log('\n  WHAT THE ROWS SAID BEFORE IT CLOSED, for the record and not as a decision:');
  if (t && t.p < 0.05) {
    const better = rate(tally.hold) < rate(tally.walk) ? 'holding' : 'walking on';
    console.log(`  ${better} was better, p = ${t.p.toFixed(4)}.`);
  } else {
    console.log(`  never separated. ${t ? `p = ${t.p.toFixed(3)}` : 'too few deaths to test'}, ` +
                `${dW} control-arm death(s) against ${dH} in the holding arm.`);
    console.log(`  About ${eventsNeeded(0.5)} control-arm deaths would have been needed to see a`);
    console.log('  halving with 80% power — which is why this was never going to answer in time.');
  }
  if (tally.hold.holds === 0 && tally.hold.candidates > 0)
    console.log('\n  WARNING: the treatment arm found candidate moments and held at none of them.\n' +
                '  Either no room offered a wall, or takeSafeSpot is refusing. Check travel_pause\n' +
                '  events — an experiment whose treatment never fires measures nothing.');
  if (tally.hold.candidates === 0)
    console.log('\n  WARNING: no candidate moments at all. Either nothing is travelling hurt, or the\n' +
                '  gate is too tight (travelHoldBelow / travelHoldVigor). This still matters\n' +
                '  after the retirement — it now means the HOLD ITSELF never fires, rather\n' +
                '  than that a comparison is empty.');
}
console.log(`\n  ${out.deaths_off_journey} death(s) in the window happened off a journey and are not this ` +
            'experiment\'s business.');

}
