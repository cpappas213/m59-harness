#!/usr/bin/env node
// m59-goap-run.mjs -- THE ENTRY POINT. Run one character under the planner.
//
// Until this file there was no way to "bring up the GOAP keeper", because there was
// no GOAP keeper -- only libraries. m59-plan.mjs was imported by two test files and
// nothing else. This is the smallest thing that turns those libraries into
// something that touches a server.
//
//   node tools/m59-goap-run.mjs --fleet local --agent t1 --goal vigor_ok
//   node tools/m59-goap-run.mjs --fleet local --agent t1 --goal vigor_ok --apply
//
// IT PLANS BY DEFAULT AND CHANGES NOTHING. `--apply` is what sends packets. That is
// the same habit m59-goap.mjs and m59-restore.mjs have, and for the same reason: the
// interesting failure here is not a crash, it is a confident plan executed against a
// world that was not what we thought.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// NOT A KEEPER. It runs one plan and exits. There is no loop, no supervision, no
// rejoin, no watchdog. The real keeper is still m59-autopilot.mjs and this does not
// replace, restart or interfere with it.
//
// NOT A BROKER CLIENT. It opens its OWN connection, which means Meridian's one
// connection per character applies: IF A BROKER IS HOLDING THIS CHARACTER, RUNNING
// THIS WILL BUMP IT OFF. Use a character nothing else is driving, which on the local
// fleet is all of them by default.
//
// NOT ABLE TO MOVE. m59-act/step requires `session.step`, the broker's
// collision-validated fine-coordinate mover, and this builds a minimal session that
// has no such thing -- deliberately, because the alternative is centre-to-centre
// grid stepping, which upstream measured failing 218 of 311 times with 92% of the
// failures not moving the character at all. So `step` will refuse here, by design.
// The supply chain (cast, eat, equip, attack) needs no movement and is what this is
// for.
//
// ── AND WHERE IT MAY POINT ──────────────────────────────────────────────────
//
// There are two fleets and THE DEFAULT IS SOMEBODY ELSE'S MACHINE. Controlled
// readings cannot happen there: the fleet is being driven, so the subject walks away
// mid-experiment. This refuses a non-loopback host unless --i-mean-it is passed,
// the same way the DM tools do.

import { readFileSync, existsSync } from 'node:fs';
import { M59Client } from './m59-client.mjs';
import { planFor, stepPlan } from './m59-plan.mjs';
import { evaluate, unknowns, SYMBOL_NAMES } from './m59-worldstate.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : def;
};
const flag = (name) => argv.includes('--' + name);

// WHICH FLEET, RESOLVED THE WAY EVERY OTHER TOOL HERE RESOLVES IT.
//
// This used to be `arg('fleet', 'local')` -- its own argv reading with a literal
// default -- and on a machine with no substrate/fleets/local.json it fell through to
// substrate/fleet-state.json and drove THE DEFAULT FLEET while printing "fleet local".
// That is the failure CLAUDE.md opens on ("passing the wrong one operates on the wrong
// fleet quietly. Nothing errors"), and it is the same bug the tithe book had, from the
// same cause. fleetName() honours --fleet, then M59_FLEET, then substrate/fleet-default,
// then the unnamed fleet, and stateFileFor() maps the unnamed one to fleet-state.json.
const FLEET   = fleetName(argv) || null;
const AGENT   = arg('agent', 't1');
const GOALSYM = arg('goal', 'vigor_ok');
const APPLY   = flag('apply');
const FORCE   = flag('i-mean-it');
const MAXSTEP = Number(arg('max-steps', 4));

// A NAMED FLEET WHOSE ROSTER IS MISSING IS AN ERROR, NEVER A FALLBACK. Falling back is
// what made the label a lie: the run reported one fleet and drove another.
function loadRoster() {
  const p = stateFileFor(FLEET);
  if (!existsSync(p))
    throw new Error(FLEET
      ? `no roster for fleet "${FLEET}" at ${p}. \`node tools/m59-fleets.mjs\` lists what this machine has.`
      : `no roster at ${p}.`);
  return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
}

const LOOPBACK = /^(127\.0\.0\.1|::1|localhost)$/i;

async function main() {
  if (!SYMBOL_NAMES.includes(GOALSYM))
    throw new Error(`--goal "${GOALSYM}" is not a world-state symbol. Known: ${SYMBOL_NAMES.join(', ')}`);

  const { path, data } = loadRoster();
  const entry = data[AGENT] ?? data.agents?.[AGENT];
  if (!entry) throw new Error(`no agent "${AGENT}" in ${path} (have: ${Object.keys(data).join(', ')})`);
  const cred = entry.credentials ?? entry;

  // THE GUARD THAT MATTERS. Never print the password; never point at prod by accident.
  if (!LOOPBACK.test(String(cred.host)) && !FORCE)
    throw new Error(
      `refusing to drive ${AGENT} on ${cred.host}: that is not this machine.\n` +
      '  A controlled reading cannot happen on a server where the fleet is being\n' +
      '  driven -- the subject walks away mid-experiment. Use --fleet local, or pass\n' +
      '  --i-mean-it if you have genuinely decided otherwise.');

  console.log(`fleet ${FLEET ?? '(unnamed)'}  roster ${path}\n` +
              `agent ${AGENT}  character ${cred.character}  ` +
              `host ${cred.host}:${cred.port}  ${APPLY ? 'APPLY' : 'plan only'}`);

  const c = new M59Client({ host: cred.host, port: Number(cred.port), verbose: false });
  await c.login(cred.account, cred.password);
  if (c.state !== 'game') throw new Error(`login did not reach the game: ${c.error ?? c.state}`);

  // Ask for the things the vocabulary reads. Health and the use list are PUSHED, but
  // the inventory and the spell list are not -- and the spell list must be fresh,
  // because a group-3 stat packet is positional against plSpells and mislabels every
  // number against a stale one.
  // THESE ARE SENDS, NOT PROMISES. requestInventory() is `this.send(BP.REQ_INVENTORY)`
  // and returns undefined, so awaiting is harmless but `.catch()` on it throws --
  // which is exactly what happened on the first live run, after login, in a line the
  // offline suite never executed because no test chained onto them.
  //
  // stats(1) is the group-1 request: health, mana, vigor. The server does NOT push
  // stats on its own after login -- the client must ask. Without it, vitals() has
  // no vigor and the world state reads vigor_ok / can_rest_higher as ASSUMED.
  try { c.stats(1); } catch { /* the socket will say so */ }
  try { c.requestInventory(); } catch { /* the socket will say so */ }
  try { c.requestSpells?.(); } catch { /* likewise */ }
  // The stats round-trip takes longer than the inventory on a remote server.
  // 1500ms was enough for inventory but not for the BP_STAT group-1 reply,
  // which means the pre-read saw no vigor and fell back to ASSUMED.
  await new Promise(r => setTimeout(r, 3000));

  // A minimal session: a pass-through pacer and no mover. See the header for why
  // there is deliberately no `step`.
  const session = { client: c, pacer: { submit: async (_kind, fn) => fn() } };

  const before = evaluate({ client: c, policy: {} });
  const v0 = c.vitals?.() ?? {};
  console.log('\nworld state:');
  for (const k of SYMBOL_NAMES) console.log(`  ${k.padEnd(18)} ${before[k]}`);
  const guessed = unknowns({ client: c, policy: {} });
  if (guessed.length) {
    console.log('\n  ASSUMED (could not be read, fell back to the safe direction):');
    for (const g of guessed) console.log(`    ${g.symbol} -> ${g.assumed}`);
  }

  const goal = { [GOALSYM]: true };
  const p = planFor(c, goal, { session, policy: {} });

  console.log(`\ngoal ${JSON.stringify(goal)}`);
  if (p.problems?.length) { for (const x of p.problems) console.log('  PROBLEM ' + x); c.close?.(); return; }
  if (!p.found) {
    console.log(`  NO PLAN -- ${p.reason ?? 'the goal is not reachable from here'}`);
    console.log('  That is an answer, not a failure: something the plan needs is absent.');
    c.close?.(); return;
  }
  console.log(`  plan: ${p.names.join('  ->  ')}`);

  if (!APPLY) {
    console.log('\nplan only. Nothing was sent. Re-run with --apply to execute.');
    c.close?.(); return;
  }

  // ONE STEP AT A TIME, re-reading between each. A plan is a claim about a world
  // that will not hold still.
  console.log('');
  for (let i = 0; i < Math.min(MAXSTEP, p.steps.length); i++) {
    const r = await stepPlan(c, session, p, { index: i });
    if (r.done) break;
    console.log(`  ${r.action}: ${JSON.stringify(r.result)}`);
    try { c.stats(1); } catch { /* ignore */ }
    try { c.requestInventory(); } catch { /* ignore */ }
    await new Promise(r2 => setTimeout(r2, 900));
  }

  const after = evaluate({ client: c, policy: {} });
  const v1 = c.vitals?.() ?? {};
  console.log('\nwhat actually changed:');
  for (const k of SYMBOL_NAMES)
    if (before[k] !== after[k]) console.log(`  ${k}: ${before[k]} -> ${after[k]}`);
  console.log(`  vigor: ${v0.vigor?.value} -> ${v1.vigor?.value}` +
              `   mana: ${v0.mana?.value} -> ${v1.mana?.value}`);
  console.log('\nCompare that against what the atomics CLAIMED above. A disagreement is\n' +
              'the finding -- it is the first thing here ever checked against a server.');
  c.close?.();
}

main().catch(e => { console.error('\n' + e.message); process.exit(1); });
