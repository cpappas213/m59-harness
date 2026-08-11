#!/usr/bin/env node
// THE TRAVEL A/B — the randomisation and the arithmetic. Offline, safe any time:
//
//   node tools/m59-travel-ab-test.mjs
//
// This experiment runs on twenty-one live characters and its outcome is DEATHS, so the two
// things that can quietly ruin it are pinned here.
//
//   * A BIASED SPLIT. If the arm correlates with the character — or with the time of day,
//     or with which character travels most — the result is a fact about the fleet rather
//     than about the intervention, and it will look exactly like a real effect.
//   * ARITHMETIC THAT CLAIMS TOO MUCH. Rare events make it very easy to read noise as a
//     finding. A two-hour run with one death in each arm must say "not yet", and the
//     "how much longer" answer has to be right or somebody stops the experiment early.
//
// The outcome metric is deliberately NOT damage taken. The hypothesis players state is
// that fighting from a wall means you take MORE damage and die LESS — so a measurement
// built on damage would reject the intervention precisely when it is working.

import { twoProportion, eventsNeeded } from './m59-travel-ab.mjs';
import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const armOf = (seed) => Autopilot.prototype.travelArmFor.call(null, seed);

console.log('the split');
{
  let hold = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) if (armOf(`t${i % 21}-${i}-${1786000000000 + i * 137}`) === 'hold') hold++;
  const share = hold / N;
  // At n=200,000 the standard error is 0.11%, so a fair coin lands inside 0.5% almost
  // always and a tighter bound would fail on noise a few runs in a row. The imbalance that
  // would actually matter to a rare-event experiment is percent-scale, not this.
  ok('it is a coin, within half a percent', Math.abs(share - 0.5) < 0.005,
     `got ${(share * 100).toFixed(2)}%`);

  // THE BUG THIS CAUGHT. FNV-1a's last step multiplies by an odd constant, so its low bit
  // is (running hash) XOR (last character) and nothing else in the seed reaches it. Seeds
  // differing only in their final character alternated arms exactly.
  const tails = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(t => armOf('same-prefix-' + t));
  ok('THE ARM IS NOT DECIDED BY THE LAST CHARACTER — with the old hash these alternated ' +
     'in lockstep with its parity, which meant the experiment was randomising on one bit ' +
     'of the clock and the character was contributing nothing',
     !tails.every((a, i) => (a === 'hold') === (i % 2 === 1)));

  // THE ONE THAT MATTERS. A split that is 50/50 overall can still put one character almost
  // entirely in one arm, and the characters differ by max health, hunting ground and
  // strategy — so that would be a fact about Kermit, not about holding at walls.
  let worst = 0, worstWho = null;
  for (const who of ['Kermit', 'Piggy', 'Lew', 'Gonzo', 'Sweetums', 'Rizzo', 'Camilla']) {
    let h = 0;
    for (let i = 0; i < 20000; i++) if (armOf(`${who}-${i}-${1786000000000 + i * 911}`) === 'hold') h++;
    const d = Math.abs(h / 20000 - 0.5);
    if (d > worst) { worst = d; worstWho = who; }
  }
  ok('NO CHARACTER SITS IN ONE ARM — every one of them is within 2% of even, so the ' +
     'comparison is within-character and the differences between them cancel',
     worst < 0.02, `worst was ${worstWho} at ${(worst * 100).toFixed(1)}% off`);

  ok('it is stable — asking twice gives the same answer, so a decision re-evaluated ' +
     'mid-journey cannot flip arms', armOf('Kermit-7-1786000000000') === armOf('Kermit-7-1786000000000'));
  ok('and it is not stable across journeys, which is the point',
     new Set(Array.from({ length: 40 }, (_, i) => armOf(`Kermit-${i}-17860000000${i}`))).size === 2);
}

console.log('\nthe test that decides when to believe it');
{
  ok('no data, no answer', twoProportion(0, 0, 0, 0) === null);
  ok('identical rates are not a finding',
     twoProportion(10, 1000, 10, 1000).p > 0.99);
  // The shape of a real early result: one death each, a couple of thousand journeys.
  const early = twoProportion(1, 2000, 1, 2000);
  ok('ONE DEATH IN EACH ARM IS NOT A RESULT, however tempting the ratio looks',
     early.p > 0.9, `p = ${early?.p?.toFixed(3)}`);
  // And the shape of a real finding: a halving, with enough events behind it.
  const real = twoProportion(40, 20000, 18, 20000);
  ok('a halving on 58 deaths is', real.p < 0.01, `p = ${real?.p?.toFixed(4)}`);
  ok('the sign is right — fewer deaths in the second arm gives a positive z',
     twoProportion(40, 20000, 18, 20000).z > 0);
  ok('a zero-death window does not divide by zero', twoProportion(0, 500, 0, 500) === null);
}

console.log('\nhow much longer to run');
{
  // Standard two-proportion sizing. The absolute values matter less than the shape: a
  // smaller effect must need more events, and every answer must be a usable number.
  const half = eventsNeeded(0.5), quarter = eventsNeeded(0.25), most = eventsNeeded(0.75);
  ok('detecting a halving needs tens of deaths, not hundreds', half > 15 && half < 60, `got ${half}`);
  ok('A SMALLER EFFECT NEEDS MORE EVIDENCE, which is the property that stops this being ' +
     'used to justify stopping early', quarter > half && half > most,
     `${quarter} > ${half} > ${most}`);
  ok('all of them are finite and positive',
     [0.1, 0.25, 0.5, 0.75, 0.9].every(r => Number.isFinite(eventsNeeded(r)) && eventsNeeded(r) > 0));
}

console.log('\nthe gate that decides a candidate moment');
{
  // A stub keeper: travelHoldCandidate reads only vitals, the policy and what is in reach.
  const keeper = (health, max, vigor, inReach = 0) => ({
    policy: {},
    s: { client: { vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }) } },
    inReachOfUs: () => Array.from({ length: inReach }, (_, i) => ({ id: i })),
    travelHoldCandidate: Autopilot.prototype.travelHoldCandidate,
  });
  const ask = (k, remaining = 3) => k.travelHoldCandidate({ remaining });

  ok('hurt, rested, nothing in reach, rooms to go — that is the case this exists for',
     ask(keeper(20, 44, 150)).candidate === true);
  ok('healthy enough is not a candidate', ask(keeper(40, 44, 150)).candidate === false);
  ok('ARRIVING HURT IS FINE — the last room of a journey is somebody else\'s decision',
     ask(keeper(20, 44, 150), 0).candidate === false);
  ok('TOO TIRED FOR THE POINTS TO COME. At the resting cap a 15-point top-up costs 87s, ' +
     'as long as a whole p90 journey, so holding there pays full price for nothing',
     ask(keeper(20, 44, 80)).candidate === false &&
     /too tired/.test(ask(keeper(20, 44, 80)).why));
  ok('something already swinging is a fight, not a pause — the ordinary pass is better ' +
     'at both halves of that than a hold is',
     ask(keeper(20, 44, 150, 2)).candidate === false);
  ok('unreadable health refuses rather than guessing',
     ask({ ...keeper(20, 44, 150), s: { client: { vitals: () => ({}) } } }).candidate === false);
  ok('and every refusal says why, because a gate that silently never fires is an ' +
     'experiment that measures nothing',
     [keeper(40, 44, 150), keeper(20, 44, 80), keeper(20, 44, 150, 2)]
       .every(k => typeof ask(k).why === 'string' && ask(k).why.length > 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
