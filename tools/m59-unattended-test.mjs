#!/usr/bin/env node
// WITH NO BOT ATTACHED, THE KEEPER STILL KEEPS THE CHARACTER ALIVE. Offline, no server,
// no broker, safe any time:
//
//   node tools/m59-unattended-test.mjs
//
// This is the cheapest insurance in the whole carve-out and it guards a property that
// erodes SILENTLY. Behaviour is migrating outward — `meridian59-dum-bot` decides what to
// hunt, where to stand and which errands to stop for; this repository keeps everything
// that has to be right within a second. That split only stays safe while the second half
// is genuinely still here, and the failure mode is not a crash. It is a character that
// stands still while something eats it, on an afternoon when nobody happened to be
// running a bot.
//
// So this asserts the unattended case directly, in the two forms it can be got wrong:
//
//   1. WITH NOTHING CLAIMED, every faculty answers `keeper`. A faculty that quietly
//      defaults to anything else is a decision nobody is making.
//   2. THE FOUR THAT KEEP A CHARACTER ALIVE ARE NOT CLAIMABLE by asking nicely. An
//      operator may hand them over per roster; a bot must not be able to take them by
//      omission, by typo, or by claiming the whole list.
//
// It pins the CONTRACT and not the ladder — the survival behaviour itself is
// m59-autopilot's and is covered by m59-combat-test and m59-rest-test. What is tested
// here is that nothing can take ownership of it out from under an empty room.
//
// It should fail the day somebody moves a survival decision out of the keeper. That is
// its whole job.

import { Autopilot } from './m59-autopilot.mjs';
import { describeCommitment, isTakeable, heldBy } from './m59-commitment.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// A keeper with nothing attached to it.
//
// The prototype rather than `new Autopilot(...)`, deliberately: a real constructor wants
// a session, which wants a socket, which wants a server — and the whole value of this
// test is that it runs on a laptop with no fleet up, every time, rather than on the
// afternoon somebody remembers to check. Everything asserted below is ownership
// bookkeeping and is pure; `journal` and `policy` are the only state any of it touches,
// and they are stubbed to exactly what `note()` and `releaseCommitment()` read.
const keeper = () => Object.assign(Object.create(Autopilot.prototype), {
  journal: [], policy: {}, claims: new Map(), passes: 0,
});

console.log('\nan unattended keeper');
{
  const k = keeper();
  const status = k.facultyStatus();
  const notKeeper = Object.entries(status).filter(([, v]) => v !== 'keeper');
  ok('every faculty belongs to the keeper when nothing is claimed',
     notKeeper.length === 0, JSON.stringify(notKeeper));
  ok('and that is all eight of them',
     Object.keys(status).length === Autopilot.FACULTIES.length);
  for (const f of Autopilot.FACULTIES)
    ok(`  ${f} is the keeper's`, k.facultyOwner(f) === 'keeper' && k.facultyHeld(f) === false);

  ok('nothing is holding it', k.heldStatus() === null);
  ok('nothing is mid-operation on it', k.busyStatus() === null);
  ok('so it reports no commitment at all', k.commitment() === null);
  ok('and it is takeable', isTakeable(k.commitment()) === true);
}

console.log('\nthe four that keep a character alive');
{
  // THE LIST ITSELF, because the guarantee is the membership and not the mechanism. A
  // faculty quietly dropping off this list is the change this test exists to catch.
  ok('are exactly identity, mortality, survival and recovery',
     JSON.stringify([...Autopilot.PROTECTED_FACULTIES].sort()) ===
     JSON.stringify(['identity', 'mortality', 'recovery', 'survival']));

  const k = keeper();
  const r = k.claimFaculties({ faculties: Autopilot.FACULTIES, by: 'a-bot', leaseMs: 60_000 });
  ok('a bot asking for EVERYTHING gets only the directional half',
     JSON.stringify([...r.granted].sort()) ===
     JSON.stringify(['economy', 'movement', 'social', 'work']));
  ok('and the four are refused, one refusal each', r.refused.length === 4);
  ok('with a reason that names the roster, not a rule number',
     r.refused.every(x => /may_yield/.test(x.why)));
  for (const f of Autopilot.PROTECTED_FACULTIES)
    ok(`  ${f} is still the keeper's after that claim`, k.facultyOwner(f) === 'keeper');

  // The consented path still works, because an operator MAY hand them over — the point
  // is that it takes saying so on the machine that owns the roster.
  const k2 = keeper();
  const r2 = k2.claimFaculties({ faculties: ['survival'], by: 'a-bot',
                                 mayYield: ['survival'], leaseMs: 60_000 });
  ok('an operator who consented on the roster can hand survival over',
     r2.granted.length === 1 && k2.facultyOwner('survival') === 'a-bot');
  ok('and it is still only the one that was named',
     k2.facultyOwner('mortality') === 'keeper');
}

console.log('\na bot that dies mid-run');
{
  // LEASES FAIL BACK TO THE KEEPER, NEVER OPEN. A bot that crashes, is Ctrl-C'd, or was
  // never started must leave a character that still defends itself. The check is on READ
  // rather than on a timer, so there is no window in which a dead bot still owns anything.
  const k = keeper();
  k.claimFaculties({ faculties: ['work', 'movement'], by: 'a-bot', leaseMs: 60_000 });
  ok('while it is alive it owns what it claimed', k.facultyOwner('work') === 'a-bot');

  for (const c of k.claims.values()) c.until = Date.now() - 1;   // the bot stopped heartbeating
  ok('an expired lease is the keeper\'s again', k.facultyOwner('work') === 'keeper');
  ok('and the claim is gone rather than lingering as an expired one', k.claims.has('work') === false);
  ok('and the character reports nobody holding it', k.heldStatus() === null);

  // The nastier half: a bot that died while it had declared itself busy. Without an
  // expiry on that too, every stall detector in the fleet would step politely over a
  // keeper that has genuinely stopped, for ever, and the fleet page would show a
  // character mid-operation with nothing running.
  const k2 = keeper();
  k2.claimFaculties({ faculties: ['work'], by: 'a-bot', leaseMs: 60_000 });
  k2.declareBusy({ by: 'a-bot', kind: 'crate-check', leaseMs: 60_000 });
  ok('a declared operation is not takeable while it is live',
     isTakeable(k2.commitment()) === false);
  k2.busy.until = Date.now() - 1;
  ok('and an expired one is takeable again', isTakeable(k2.commitment()) === true);
  ok('and is cleared rather than left to be re-read', k2.busy === null);
}

console.log('\nwho may say a character is busy');
{
  const k = keeper();
  const no = k.declareBusy({ by: 'a-bot', kind: 'crate-check' });
  ok('nothing may be marked busy without a claim behind it',
     no.busy === null && /claim a faculty first/.test(no.refused));

  k.claimFaculties({ faculties: ['work'], by: 'a-bot', leaseMs: 60_000 });
  const other = k.declareBusy({ by: 'a-different-bot', kind: 'something' });
  ok('and only the holder may mark it — marking somebody else\'s character hands-off ' +
     'is the same authority as taking it',
     other.busy === null && /holds this character/.test(other.refused));

  k.declareBusy({ by: 'a-bot', kind: 'crate-check', label: 'checking the crate' });
  ok('the holder may', k.busyStatus()?.kind === 'crate-check');
  ok('and a stranger may not clear it either',
     k.freeBusy({ by: 'a-different-bot' }).refused !== undefined && k.busyStatus() !== null);
  ok('but an operator with no name may — that is the override',
     k.freeBusy({}).busy === null);
}

console.log('\nthe override reaches an outside owner');
{
  // If the override key leaves the claim in place, the bot's next heartbeat renews a
  // character an operator has just taken back and the row goes grey again within thirty
  // seconds, with nothing on screen to say why.
  const k = keeper();
  k.policy = {}; k.claims = new Map();
  k.claimFaculties({ faculties: ['work', 'movement'], by: 'a-bot', leaseMs: 60_000 });
  k.declareBusy({ by: 'a-bot', kind: 'crate-check' });
  const out = k.releaseCommitment('an operator took this character back');
  ok('it cancels the operation', k.busyStatus() === null);
  ok('and takes the faculties back too', k.heldStatus() === null);
  ok('and says both things it did',
     out.undone.some(s => /cancelled a-bot's operation/.test(s)) &&
     out.undone.some(s => /took work, movement back/.test(s)), JSON.stringify(out.undone));
  ok('leaving the character unattended and therefore the keeper\'s',
     k.facultyOwner('work') === 'keeper' && k.facultyOwner('survival') === 'keeper');
}

console.log('\nan old broker, and a fleet with no bots on it');
{
  // Nothing about this feature may change what a fleet WITHOUT a bot reports, because
  // that is every fleet until somebody starts one — and a board that started greying
  // rows differently on the day this landed would be indistinguishable from a fleet that
  // had started behaving differently.
  ok('a plain errand reads exactly as it did', describeCommitment({
    errand: { kind: 'lootrun', farmer: 'x' } })?.kind === 'errand');
  ok('a plain partner reads exactly as it did',
     describeCommitment({ partner: 'x' })?.kind === 'partner');
  ok('nothing at all is still null', describeCommitment({}) === null);
  ok('and none of them claim an owner',
     heldBy(describeCommitment({ errand: { kind: 'lootrun' } })) === null &&
     heldBy(describeCommitment({ partner: 'x' })) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
