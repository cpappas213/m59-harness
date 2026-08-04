#!/usr/bin/env node
// RESTING MUST NOTICE IT IS BEING HIT. Offline, no server, safe to run any time:
//
//   node tools/m59-rest-test.mjs
//
// restUntil sits still for up to two and a half minutes and restores health slowly.
// It does nothing to stop anything hitting you, so the only evidence that a rest is
// going badly is that health is going DOWN — and it already reads vitals every three
// seconds to decide whether it is finished.
//
// It did not always look. Zoot rested 61 seconds on a square that had been proven safe
// against fewer attackers than were now standing on him, went from 17 health to 3, and
// every one of those reads saw the number falling. These are the cases that must not
// regress: it aborts on damage, it does NOT abort on ordinary slow recovery, and the
// blind behaviour is still reachable on purpose.

import { restUntil } from './m59-skills.mjs';

// A session whose stats reads walk down a scripted list of health values.
function fakeSession(seq) {
  let i = 0;
  const c = {
    vitals: () => ({ health: { value: seq[Math.min(i, seq.length - 1)], max: 20 },
                     vigor:  { value: 200, max: 200, scale_max: 200 } }),
    stats: async () => { i++; },
    waitFor: async () => {},
    rest: async () => {},
    stand: async () => {},
  };
  return { need: () => c, pacer: { submit: async (_kind, f) => f() } };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Climbing, then knocked back down. The comparison has to be against the best health
// seen so far and not the health we sat down at, or 12 -> 16 -> 14 reads as progress.
{
  const r = await restUntil(fakeSession([12, 14, 16, 14]),
                            { health: 0.99, vigor: 0.99, maxSeconds: 120 });
  ok('aborts when health falls back from its peak', !!r.interrupted, JSON.stringify(r.interrupted));
  ok('says how much was lost', /took 2 damage/.test(r.interrupted || ''), r.interrupted);
  ok('cuts the rest short instead of burning the leash', r.seconds < 30, 'seconds=' + r.seconds);
}

// Ordinary recovery. Must not abort — a rest that bails on its own regeneration would
// leave every character permanently hurt.
{
  const r = await restUntil(fakeSession([12, 15, 18, 20]),
                            { health: 0.95, vigor: 0.95, maxSeconds: 120 });
  ok('does not abort on a clean recovery', !r.interrupted, JSON.stringify(r.interrupted));
  ok('still reaches the target', r.reached_target === true);
}

// The old behaviour, still available for a caller that genuinely wants to sit it out.
{
  const r = await restUntil(fakeSession([12, 14, 9]),
                            { health: 0.99, vigor: 0.99, maxSeconds: 12, abortOnDamage: false });
  ok('abortOnDamage:false keeps the blind behaviour', !r.interrupted);
}

// AFTER A DEATH, STAY IN AND REST UNTIL WHOLE.
//
// Scooter died twice inside forty minutes: the keeper escaped the Underworld, cleared
// its one-shot needsRecovery flag on the same pass, and sent a 5-health character with
// no weapon straight back to the room that had just killed it. recovered() is the gate
// that stops that, and the trap it must not fall into is demanding more vigor than
// resting can deliver — REST_VIGOR_CAP is 80 of 200, and asking for more retires the
// character silently rather than erroring.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const keeper = (health, maxHealth, vigor) => {
    const k = Object.create(Autopilot.prototype);
    k.recoverUntilWhole = true;
    k.s = { client: { vitals: () => ({
      health: { value: health, max: maxHealth },
      vigor:  { value: vigor, scale_max: 200 },
    }) } };
    return k;
  };

  ok('a character back from the dead at 11% is not recovered',
     keeper(3, 28, 80).recovered() === false);
  ok('nor at 80% — the ordinary restBelow would already have released it',
     keeper(23, 28, 80).recovered() === false);
  ok('at full health and the resting cap it IS recovered',
     keeper(28, 28, 80).recovered() === true);
  ok('28 of 29 counts as whole, so the last health point does not block for ever',
     keeper(28, 29, 80).recovered() === true);

  // The deadlock. Vigor above 80/200 comes only from food, so a character resting in
  // an inn can never exceed it — requiring more would hold it there for ever.
  ok('full health with vigor AT the cap does not deadlock waiting for 200',
     keeper(28, 28, 80).recovered() === true);
  ok('but below the cap it keeps resting',
     keeper(28, 28, 40).recovered() === false);

  // Clearing is the point: the flag must go off, or the character never fights again.
  const done = keeper(28, 28, 80);
  done.recovered();
  ok('recovering clears the flag once whole', done.recoverUntilWhole === false);
  const notYet = keeper(3, 28, 80);
  notYet.recovered();
  ok('and does NOT clear it while still hurt', notYet.recoverUntilWhole === true);

  // Unknown vitals must not be read as "fine" — that would defeat the whole gate.
  const blind = Object.create(Autopilot.prototype);
  blind.recoverUntilWhole = true;
  blind.s = { client: { vitals: () => ({}) } };
  ok('unreadable vitals keep it resting rather than releasing it',
     blind.recovered() === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
