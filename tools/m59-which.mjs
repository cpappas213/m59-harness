#!/usr/bin/env node
// WHICH FLEET AM I ABOUT TO ACT ON, AND IS IT THE ONE THAT IS RUNNING?
//
//   node tools/m59-which.mjs [--fleet <name>] [--port 8901]
//
// Every fleet tool takes --fleet and every one of them is silent about it, which is
// the whole problem: passing the wrong one, or none, operates on the wrong fleet and
// does so quietly. A restart once stopped a live 46-session broker and would have
// brought back a different roster pointed at a server that was down — nothing in the
// output of any step said which fleet was meant.
//
// So this says it, out loud, before anything is touched. It is the first line of every
// slash command for that reason, and it is a TOOL rather than twenty lines of node -e
// pasted into each command file, because those files exist in two repositories and the
// copies drift.
//
// It changes nothing. Read-only, safe at any time.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));

// ONE PORT IS NOT A SEARCH, AND "NOTHING FOUND" IS THE ANSWER THAT GETS PEOPLE HURT.
// This used to ask 8901 and nothing else, so a broker started anywhere else was invisible
// and the report read `not answering on 8901 - nothing is holding a fleet` with exit 0.
// That is a FALSE ALL-CLEAR from the one tool whose entire job is to refuse one, and it is
// the same shape as the failure this file was written after: every step reporting success
// while a live 46-session broker was stopped. Measured on this machine, with the shadow
// fleet held on 8971 by a broker with 21 characters in game.
//
// m59-service.mjs writes substrate/broker-<fleet>.pid with the port it started on, which is
// how m59-fleets.mjs finds brokers on any port. Ask the same places: the default first,
// because one broker on the default port is the ordinary case, then every port a pid file
// names. A pid file that is stale merely costs one refused connection.
const SUBSTRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate');
const portOk = p2 => Number.isInteger(p2) && p2 > 0 && p2 < 65536;
function candidatePorts() {
  const ports = portOk(PORT) ? [PORT] : [];
  try {
    for (const file of readdirSync(SUBSTRATE)) {
      if (!/^broker-.+\.pid$/.test(file)) continue;
      try {
        const port = Number(JSON.parse(readFileSync(join(SUBSTRATE, file), 'utf8'))?.http);
        if (portOk(port)) ports.push(port);
      } catch { /* a pid file we cannot read is only a lost hint */ }
    }
  } catch { /* no substrate directory is an ordinary answer */ }
  return [...new Set(ports)];
}

const c = process.stdout.isTTY
  ? { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
      warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
  : { ok: s => s, bad: s => s, warn: s => s, dim: s => s };

let fleet;
try { fleet = resolveFleet(argv); }
catch (e) { console.error(c.bad(e.message)); process.exit(2); }

const short = p => p.replace(/^.*[\\/]substrate[\\/]/, 'substrate/').replace(/\\/g, '/');

// What is on disk. A roster that is missing is worth saying plainly rather than as a
// zero, because "no such fleet" and "a fleet with nobody in it" want different answers.
let rosterLine;
if (!existsSync(fleet.stateFile)) {
  rosterLine = c.warn(`no roster at ${short(fleet.stateFile)} — this fleet does not exist yet`);
} else {
  try {
    const raw = readFileSync(fleet.stateFile, 'utf8');
    const names = Object.keys(JSON.parse(raw));
    rosterLine = `${short(fleet.stateFile)} — ${names.length} character(s), ${raw.length} bytes`;
  } catch (e) {
    rosterLine = c.bad(`${short(fleet.stateFile)} — unreadable: ${e.message}`);
  }
}

// Who is actually holding a fleet right now. The broker is the authority on this; what
// we resolved is only what the NEXT command would do.
const ports = candidatePorts();
const asked = await Promise.all(ports.map(async port => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? { port, health: await r.json() } : null;
  } catch { return null; }               // nothing listening is an ordinary answer
}));
const live = asked.filter(Boolean);
// Prefer the broker holding the fleet this command would act on: with several up, the one
// that matters is the one about to be touched, and reporting any other as "the" broker
// would invent a mismatch that is not there.
const chosen = live.find(x => (x.health.fleet || 'default') === fleet.label) ?? live[0] ?? null;
const health = chosen?.health ?? null;
const foundOn = chosen?.port ?? null;

console.log(`fleet    ${c.ok(fleet.label)}   ${c.dim('<- ' + fleet.source)}`);
console.log(`roster   ${rosterLine}`);

if (!health) {
  console.log(`broker   ${c.warn('not answering on ' + ports.join(', '))} — nothing is holding a fleet`);
} else {
  const held = health.fleet || 'default';
  const n = health.sessions?.length ?? 0;
  console.log(`broker   ${c.ok('UP')} pid ${health.pid} on ${foundOn}, holding ${c.ok(held)}, ${n} session(s)`);
  // Several brokers up at once is normal here and is not itself a problem; being unaware of
  // one is. Name them, because the mismatch check below speaks for the chosen one only.
  for (const other of live) {
    if (other === chosen) continue;
    console.log(c.dim(`         also up: pid ${other.health.pid} on ${other.port} holding ` +
                      `${other.health.fleet || 'default'}, ${other.health.sessions?.length ?? 0} session(s)`));
  }
  if (held !== fleet.label) {
    // The exact trap this file exists for. Loud, and it says what to do about it.
    console.log('');
    console.log(c.bad(`MISMATCH: the broker is holding "${held}" but this command would act on "${fleet.label}".`));
    console.log(c.bad(`Anything you run now targets the wrong fleet, quietly. Add --fleet ${held},`));
    console.log(c.bad(`or say --fleet ${fleet.label} and mean it.`));
    process.exit(1);
  }
  if (health.root && !health.root.replace(/[\\/]+$/, '').endsWith('m59-harness')) {
    console.log(c.warn(`note: that broker's checkout is ${health.root}`));
  }
}
process.exit(0);
