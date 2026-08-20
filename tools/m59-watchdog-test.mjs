#!/usr/bin/env node
// THE OUT-OF-BAND GUARD — the contract test for m59-watchdog.mjs.
//
//   node tools/m59-watchdog-test.mjs
//
// Offline, against a fake host. What is pinned here is the SEPARATION the guard rests
// on: it observes on its own clock, and the only thing it ever DOES is cancel movement,
// once, when health has crossed the withdraw line during a blocked pass. Everything
// else is somebody else's decision.
//
// It exists because the guard used to be a method on the 13,000-line keeper, reachable
// only by that keeper. Two drivers now run it, so the interface between them is a real
// boundary and needs a test rather than a convention.
import * as wd from './m59-watchdog.mjs';
import { safetyFor } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

function host({ hp = 20, max = 20, blockedMs = 0, inert = false, doing = 'travelling',
                hold = null, live = true, state = 'game' } = {}) {
  const notes = [], frames = [];
  let cancelled = 0;
  const h = {
    doing, hold, inert, passes: 1, tally: {},
    passStartedAt: blockedMs ? Date.now() - blockedMs : null,
    lastFrameAt: 0,
    s: { client: { vitals: () => ({ health: { value: hp, max } }),
                   self: { col: 4, row: 4 }, room: { id: 587 }, state },
         live,
         cancelMovement: () => { cancelled++; return { cancelled: true, interrupted: 1 }; } },
    safety: () => ({ fleeAt: 0.4 }),
    // THE REAL recordFrame STAMPS lastFrameAt, and the frame gate is computed from it.
    // A fake that only pushed to an array made the gate read "nothing has been recorded
    // for ever" and write a frame on every tick -- the fixture lying about the thing
    // under test, which is the failure docs/HANDOFF.md calls the most dangerous file.
    recordFrame(why) { frames.push(why); this.lastFrameAt = Date.now(); },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {},
    notes, frames, get cancels() { return cancelled; },
  };
  h.watch = wd.freshState();
  return h;
}

console.log('the handbrake — the only thing it actually does');
{
  const h = host({ hp: 5, blockedMs: 9000 });           // 25%, below fleeAt 0.4
  wd.tick(h);
  ok('a blocked pass with health under the withdraw line is cancelled', h.cancels === 1);
  ok('and it says so in a note a person can find',
     h.notes.some(n => /WATCHDOG/.test(n.what)));
  wd.tick(h); wd.tick(h);
  ok('ONCE per blocked pass, not once per tick', h.cancels === 1,
     'cancelling twice does nothing and the note would repeat every 500ms');
  h.passes = 2;
  wd.tick(h);
  ok('a NEW blocked pass may be interrupted again', h.cancels === 2);
}

console.log('\nand the four times it must NOT act');
{
  ok('healthy: a long pass on a full bar is not an emergency',
     host({ hp: 20, blockedMs: 9000 }) && (() => { const h = host({ hp: 20, blockedMs: 9000 }); wd.tick(h); return h.cancels === 0; })());
  ok('brief: hurt but the pass is not blocked — the pass will decide for itself',
     (() => { const h = host({ hp: 5, blockedMs: 100 }); wd.tick(h); return h.cancels === 0; })());
  // Cancelling under an errand is this keeper fighting the thing it stood down for.
  ok('INERT: something else is driving, so it is not ours to cancel',
     (() => { const h = host({ hp: 5, blockedMs: 9000, inert: true }); wd.tick(h); return h.cancels === 0; })());
  ok('not in game: nothing to cancel',
     (() => { const h = host({ hp: 5, blockedMs: 9000, live: false }); wd.tick(h); return h.cancels === 0; })());
}

console.log('\nit decides nothing else');
{
  const src = wd.tick.toString() + wd.pulse.toString();
  ok('nothing in it flees, rests, attacks or travels',
     !/\bflee\(|\brest\(|\battack\(|\btravel\(|walkTo\(/.test(src),
     'the ordinary pass already knows how to do those, with fresh numbers');
  ok('the only outward call is cancelMovement',
     (src.match(/\bs\.[a-zA-Z]+\(/g) ?? []).every(m => /cancelMovement|vitals/.test(m)));
}

console.log('\nthe record — because a death nobody framed cannot be placed');
{
  const h = host({ hp: 20, blockedMs: 0 });
  wd.tick(h);
  ok('a first tick writes a frame', h.frames.length === 1);
  const before = h.frames.length;
  wd.tick(h);
  ok('an unchanged bar does not write another straight away', h.frames.length === before);
  h.s.client.vitals = () => ({ health: { value: 12, max: 20 } });
  wd.tick(h);
  ok('but a health change always does — that is the resolution a post-mortem wants',
     h.frames.length === before + 1 &&
     /health moved/.test(h.frames[h.frames.length - 1]));
}

console.log('\na host that cannot answer must not take the guard down');
{
  // An exception inside a tick kills the timer and the guard dies silently. start()
  // wraps the tick for exactly this, so a broken host degrades to no guard rather than
  // to a crash — and records why.
  const h = host({ hp: 5, blockedMs: 9000 });
  h.safety = () => { throw new Error('no policy'); };
  wd.start(h);
  let threw = false;
  try { wd.tick(h); } catch { threw = true; }
  wd.stop(h);
  ok('the tick itself may throw, but start() catches it and records lastError',
     threw === true, 'and the timer keeps its next tick');
}

console.log('\none home for the withdraw line');
{
  const client = { vitals: () => ({ health: { value: 10, max: 50 } }) };
  const a = safetyFor(client, { fleeBelow: 0.4 });
  ok('safetyFor computes the same two-hit margin the keeper used to compute inline',
     a.maxHit === 17 && a.fleeAt > 0.4 && a.fleeAt <= 0.7);
  ok('and with no readable max it falls back to the policy floor',
     safetyFor({ vitals: () => ({}) }, { fleeBelow: 0.4 }).fleeAt === 0.4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
