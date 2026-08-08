#!/usr/bin/env node
// OFFLINE TEST FOR THE LOCAL FLEET INVENTORY.
//
//   node tools/m59-fleets-test.mjs
//
// It builds a throwaway substrate directory and one fake broker on an ephemeral
// loopback port. No Meridian session, no real broker, no roster on this machine is
// read: `--substrate` and `--port` point the tool entirely at the fixture, and
// `--port 0` is how the no-broker cases say "probe nothing".
//
// What it is actually defending:
//
//  - a roster is matched to a broker by the STATE PATH that broker reports, never by
//    the fleet label, because two checkouts can both hold a fleet called prod;
//  - a fleet with no broker still comes back, carrying the reason, because a menu that
//    silently drops it is indistinguishable from one that never had it; and
//  - nothing password-shaped ever reaches the output.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'm59-fleets.mjs');
let failures = 0;
const check = (ok, what) => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${what}`);
};

const root = mkdtempSync(join(tmpdir(), 'm59-fleets-'));
const fleetsDir = join(root, 'fleets');
mkdirSync(fleetsDir);

const slot = (account, host, port) => ({
  credentials: { account, password: 'hunter2-not-a-real-password', character: 'Someone', host, port },
});
const roster = (host, port, names) =>
  Object.fromEntries(names.map((name, i) => [name, slot(`acct${i}`, host, port)]));

const localPath = join(fleetsDir, 'boslab.json');
writeFileSync(localPath, JSON.stringify(roster('127.0.0.1', 5959, ['a1', 'a2', 'a3'])));
writeFileSync(join(fleetsDir, 'prod.json'), JSON.stringify(roster('10.0.0.9', 5959, ['t1', 't2'])));
writeFileSync(join(fleetsDir, 'quiet.json'), JSON.stringify(roster('127.0.0.1', 15959, ['q1'])));
writeFileSync(join(fleetsDir, 'split.json'), JSON.stringify({
  ...roster('127.0.0.1', 5959, ['s1']), ...roster('10.0.0.9', 5959, ['s2']),
}));
// The sidecars a real substrate/fleets is full of. None of them is a roster.
writeFileSync(join(fleetsDir, 'boslab.json.lock'), '{"pid":1}');
writeFileSync(join(fleetsDir, 'boslab.json.prev'), '{}');
writeFileSync(join(fleetsDir, 'boslab.keeper-active.json'), '{}');

// One fake broker, holding the local roster by its exact path, on a loopback port the
// OS chooses. It also claims a fleet label that belongs to a DIFFERENT roster, which is
// exactly the confusion the path match has to survive.
const broker = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true, pid: 4242, root: '/somewhere/else/m59-harness', fleet: 'prod',
    state: localPath, sessions: ['a1', 'a2'], game_server: { host: '127.0.0.1', port: 5959 },
  }));
});
await new Promise(done => broker.listen(0, '127.0.0.1', done));
const brokerPort = broker.address().port;

// The fixture broker answers from THIS process, so the child may never be waited on
// synchronously: spawnSync blocks the event loop that would have served /health, and
// every probe then times out into an empty broker list that looks like a real answer.
function run(substrate, extra) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [TOOL, '--json', '--substrate', substrate, ...extra],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', fail);
    child.on('close', (code) => {
      check(code === 0, `tool exited ${code}: ${err}`);
      try { done({ text: out, json: JSON.parse(out) }); }
      catch (e) { fail(new Error(`unparsable tool output: ${e.message}\n${out}\n${err}`)); }
    });
  });
}

const { text, json } = await run(root, ['--port', String(brokerPort)]);
const byLabel = Object.fromEntries(json.fleets.map(entry => [entry.label, entry]));

check(json.schema === 'm59-fleets/v1', 'schema is not m59-fleets/v1');
check(Object.keys(byLabel).length === 4, `expected 4 rosters, got ${Object.keys(byLabel).length}`);
check(!byLabel['boslab.keeper-active'] && !byLabel['boslab.json'],
  'a sidecar file was read as a roster');

const lab = byLabel.boslab;
check(lab.status === 'attachable', `the held roster is ${lab.status}, not attachable`);
check(lab.broker?.http === brokerPort, 'the held roster did not bind to the answering broker');
check(lab.agents.join(',') === 'a1,a2,a3', `slot names are ${lab.agents.join(',')}`);
check(lab.credentials === 3, 'credential presence was not counted');
check(lab.server?.port === 5959 && lab.loopback === true, 'the local endpoint was misread');
check(lab.control_eligible === true, `a loopback lab fleet was refused control: ${lab.control_reason}`);

// The broker CLAIMS to hold "prod". It does not hold this checkout's prod roster, and
// matching on the label instead of the path is the bug this asserts against.
check(byLabel.prod.status === 'no-broker', 'a roster was bound to a broker by fleet label');
check(byLabel.prod.broker === null, 'a foreign broker was attributed to the prod roster');
check(byLabel.prod.detail.includes('m59-service.mjs'),
  'a fleet with no broker does not say how to start one');

check(byLabel.quiet.status === 'no-broker', 'an unheld roster was reported attachable');
check(byLabel.quiet.control_eligible === false, 'control was offered without a broker');

check(byLabel.split.status === 'unusable', 'a roster mixing two servers was called usable');
check(byLabel.split.server === null, 'a roster mixing two servers reported one');

check(!/hunter2|password/i.test(text), 'PASSWORD-SHAPED DATA REACHED THE OUTPUT');

// A fleet is no longer refused control for its NAME, and its game server no longer has
// to be loopback. Locality is asserted about the CALLER, at the broker, where an RTS
// control tool that did not arrive from this machine is refused outright. What survives
// here is the endpoint binding: the broker holding the roster must have its live
// sessions on that roster's own game server.
const prodLocal = mkdtempSync(join(tmpdir(), 'm59-fleets-prod-'));
mkdirSync(join(prodLocal, 'fleets'));
const prodPath = join(prodLocal, 'fleets', 'production.json');
writeFileSync(prodPath, JSON.stringify(roster('76.214.42.186', 5959, ['p1'])));

const prodBroker = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true, pid: 909, root: '/somewhere/else/m59-harness', fleet: 'production',
    state: prodPath, sessions: ['p1'], game_server: { host: '76.214.42.186', port: 5959 },
  }));
});
await new Promise(done => prodBroker.listen(0, '127.0.0.1', done));
const { json: prodJson } = await run(prodLocal, ['--port', String(prodBroker.address().port)]);
check(prodJson.fleets[0].control_eligible === true,
  `a production fleet on its own server was refused control: ${prodJson.fleets[0].control_reason}`);
check(prodJson.fleets[0].loopback === false, 'a remote game server was reported as loopback');
prodBroker.close();

// The endpoint binding is the part that still has teeth: a broker whose sessions are on
// a different server than the roster names cannot be armed for it, whatever it is called.
const strayBroker = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true, pid: 910, root: '/somewhere/else/m59-harness', fleet: 'production',
    state: prodPath, sessions: ['p1'], game_server: { host: '10.0.0.9', port: 5959 },
  }));
});
await new Promise(done => strayBroker.listen(0, '127.0.0.1', done));
const { json: strayJson } = await run(prodLocal, ['--port', String(strayBroker.address().port)]);
check(strayJson.fleets[0].control_eligible === false,
  'a broker whose sessions are on another server was offered control');
check(/game server/i.test(strayJson.fleets[0].control_reason),
  `the endpoint refusal does not say why: ${strayJson.fleets[0].control_reason}`);
strayBroker.close();

const { json: unprobedJson } = await run(prodLocal, ['--port', '0']);
check(unprobedJson.brokers.length === 0, '--port 0 still probed a broker');

// Two rosters that report one label cannot be told apart from a health response.
const collide = mkdtempSync(join(tmpdir(), 'm59-fleets-collide-'));
mkdirSync(join(collide, 'fleets'));
writeFileSync(join(collide, 'fleets', 'default.json'), JSON.stringify(roster('127.0.0.1', 5959, ['d1'])));
writeFileSync(join(collide, 'fleet-state.json'), JSON.stringify(roster('127.0.0.1', 5959, ['u1'])));
const { json: collideJson } = await run(collide, ['--port', '0']);
check(collideJson.fleets.length === 2, 'the unnamed roster was not listed beside the named one');
check(collideJson.fleets.every(entry => entry.ambiguous_label === true &&
  entry.control_eligible === false), 'an ambiguous fleet label was offered control');

broker.close();
rmSync(root, { recursive: true, force: true });
rmSync(prodLocal, { recursive: true, force: true });
rmSync(collide, { recursive: true, force: true });

if (failures) {
  console.error(`${failures} fleet-inventory check(s) failed`);
  process.exit(1);
}
console.log('m59-fleets: all checks passed');
