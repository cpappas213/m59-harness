#!/usr/bin/env node
// OFFLINE TEST FOR "WHERE DOES THIS ROSTER ACTUALLY CONNECT".
//
//   node tools/m59-rosterendpoint-test.mjs
//
// Pure fixtures in a throwaway directory. No broker, no session, no roster on this
// machine is read.
//
// WHAT IT IS DEFENDING. The broker's startup banner used to print M59_HOST/M59_PORT --
// this PROCESS's default for a join that names no host -- under the words "game server".
// For a named fleet that is usually not where anybody is, and on 2026-08-21 it had
// broker-shadow.log announcing `game server 127.0.0.1:5959` in the banner directly above
// twenty-one shadow sessions established to 127.0.0.1:15959. The shadow fleet's entire
// purpose is being NOT prod, so a line inviting a reader to believe the opposite during
// an incident is worse than no line at all.
//
// The banner cannot ask the session table: the HTTP listener comes up before the resume,
// so `sessions` is still empty when it prints. The roster is what the resume is about to
// dial, which makes it the only thing that can answer at that moment.
//
// It should fail the day the endpoint is taken from anywhere but the roster, or the day
// "this file names no single server" starts being answered with a guess.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';

let failures = 0;
const check = (ok, what) => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${what}`);
};

const root = mkdtempSync(join(tmpdir(), 'm59-rosterendpoint-'));
let n = 0;
const write = value => {
  const path = join(root, `roster-${n++}.json`);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};
const slot = (account, host, port) => ({
  credentials: { account, password: 'not-a-real-password', character: 'Someone', host, port },
});

// The case that started it: a loopback test fleet must never read as the default 5959.
const shadow = write({
  shadow01: slot('shadow01', '127.0.0.1', 15959),
  shadow02: slot('shadow02', '127.0.0.1', 15959),
});
const got = rosterGameEndpoint(shadow);
check(got && got.host === '127.0.0.1' && got.port === 15959,
  `a loopback test roster did not report its own port (got ${JSON.stringify(got)})`);

// A remote fleet is reported as itself, not normalised to loopback.
const prod = write({ t1: slot('t1', '76.214.42.186', 5959), t2: slot('t2', '76.214.42.186', 5959) });
const prodGot = rosterGameEndpoint(prod);
check(prodGot && prodGot.host === '76.214.42.186' && prodGot.port === 5959,
  'a remote roster did not report its own endpoint');

// THE ONE THAT MATTERS MOST. A roster naming two servers describes a fleet that does not
// exist; picking either one would put a confident wrong endpoint on the banner.
const mixed = write({ a: slot('a', '127.0.0.1', 15959), b: slot('b', '76.214.42.186', 5959) });
check(rosterGameEndpoint(mixed) === null, 'a roster mixing two game servers picked one of them');

// Same host, different ports, is still two servers.
const twoPorts = write({ a: slot('a', '127.0.0.1', 15959), b: slot('b', '127.0.0.1', 5959) });
check(rosterGameEndpoint(twoPorts) === null, 'one host on two ports was treated as one server');

// Case and whitespace are not two servers.
const casing = write({ a: slot('a', 'LocalHost', 15959), b: slot('b', ' localhost ', 15959) });
const casingGot = rosterGameEndpoint(casing);
check(casingGot && casingGot.port === 15959,
  'host casing or padding split one server into two');

// "Names no single server" has several shapes and they all answer null rather than
// falling back to a default the caller did not ask for.
check(rosterGameEndpoint(join(root, 'absent.json')) === null, 'a missing roster did not answer null');
check(rosterGameEndpoint(write('{ not json')) === null, 'an unparseable roster did not answer null');
check(rosterGameEndpoint(write([])) === null, 'a JSON array was accepted as a roster');
check(rosterGameEndpoint(write({})) === null, 'an empty roster did not answer null');
check(rosterGameEndpoint(write({ a: { credentials: { account: 'a' } } })) === null,
  'a roster with no endpoint did not answer null');

// A slot with an unusable port is not an endpoint, and must not drag a good one down
// with it -- the remaining agreement still stands.
const badPort = write({
  a: slot('a', '127.0.0.1', 0),
  b: slot('b', '127.0.0.1', 99999),
  c: slot('c', '127.0.0.1', 15959),
});
const badPortGot = rosterGameEndpoint(badPort);
check(badPortGot && badPortGot.port === 15959, 'an out-of-range port broke a roster that otherwise agreed');

rmSync(root, { recursive: true, force: true });

if (failures) {
  console.error(`${failures} roster-endpoint check(s) failed`);
  process.exit(1);
}
console.log('m59-rosterendpoint: all checks passed (11)');
