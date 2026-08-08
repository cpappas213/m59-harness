#!/usr/bin/env node
// WHICH FLEETS DOES THIS MACHINE ACTUALLY HAVE CREDENTIALS FOR, AND IS ANYTHING HOLDING THEM?
//
//   node tools/m59-fleets.mjs            what a person reads
//   node tools/m59-fleets.mjs --json     what a launcher reads
//
// m59-which.mjs answers the question for ONE fleet: the one the next command would act
// on. That is the right question before touching a fleet and the wrong question before
// OFFERING a choice of them. A commander client that wants to put "which fleet?" in
// front of a player has to enumerate: every roster on this machine, the server each one
// belongs to, and whether a broker is currently holding it — because a fleet without a
// live broker cannot be attached to, and saying so is more useful than omitting it.
//
// A roster file IS the credential store, so "fleets with local credentials available" is
// exactly "roster files present in substrate/". This tool reads them and never prints a
// password, an account name, or a character name: a launcher only needs slot names,
// which are the same identifiers already written in every doc and command line.
//
// Which broker holds which fleet is decided by asking, never by assuming. substrate/
// records a pid file per fleet with the HTTP port m59-service.mjs started it on, but
// that file is a hint — a broker started by hand writes none, and a stale one outlives
// the process. So the candidate ports are collected from the pid files plus the default,
// each is asked /health once, and a broker is matched to a roster only when it names
// that exact roster PATH. Fleet label alone is not identity: two checkouts can both hold
// a fleet called "prod" and they are not the same 21 characters.
//
// It changes nothing. Read-only, safe at any time, and it never starts a broker.

import http from 'node:http';
import net from 'node:net';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleetName } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const arg = (flag, dflt = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (flag) => argv.includes(flag);

const SUBSTRATE = resolve(arg('--substrate', join(REPO, 'substrate')));
const DEFAULT_BROKER_PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));
// A remote game server is somebody else's machine. Reachability there is not this
// tool's business and a connect attempt is a packet we did not have to send, so the
// probe is loopback-only unless a caller says otherwise.
const PROBE_REMOTE = has('--probe-remote');
const AS_JSON = has('--json');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PORT_OK = (value) => Number.isInteger(value) && value > 0 && value <= 65535;

const c = process.stdout.isTTY && !AS_JSON
  ? { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
      warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
  : { ok: s => s, bad: s => s, warn: s => s, dim: s => s };

const samePath = (a, b) => !!a && !!b &&
  resolve(String(a)).replace(/\\/g, '/').toLowerCase() ===
  resolve(String(b)).replace(/\\/g, '/').toLowerCase();

// ------------------------------------------------------------------ rosters

// One roster, reduced to what a chooser needs. The password is read (to answer "are
// there credentials here at all") and immediately forgotten; nothing derived from it
// leaves this function.
function readRoster(label, fleet, path) {
  const entry = {
    fleet, label, roster: path, agents: [], agent_count: 0, credentials: 0,
    server: null, server_consistent: true, servers: [], loopback: false,
    server_reachable: null, broker: null, status: 'parsed', detail: '',
    control_eligible: false, control_reason: '',
  };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    entry.status = 'unreadable';
    entry.detail = `roster is unreadable: ${e.message}`;
    return entry;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    entry.status = 'unreadable';
    entry.detail = 'roster is not a slot object';
    return entry;
  }
  const endpoints = new Map();
  for (const [agent, record] of Object.entries(parsed)) {
    if (!NAME_OK.test(agent)) continue;          // not a broker slot name; skip it
    entry.agents.push(agent);
    const credentials = record?.credentials;
    const account = typeof credentials?.account === 'string' ? credentials.account.trim() : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    if (account && password) entry.credentials += 1;
    const host = typeof credentials?.host === 'string' ? credentials.host.trim() : '';
    const port = Number(credentials?.port);
    if (host && PORT_OK(port)) {
      endpoints.set(`${host.toLowerCase()}:${port}`, { host, port });
    }
  }
  entry.agents.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  entry.agent_count = entry.agents.length;
  entry.servers = [...endpoints.values()];
  // A roster is per-server on purpose: characters on one server share nothing with
  // characters on another, so a file holding two endpoints describes a fleet that does
  // not exist. Report the disagreement rather than picking one of them.
  entry.server_consistent = entry.servers.length <= 1;
  entry.server = entry.servers.length === 1 ? entry.servers[0] : null;
  entry.loopback = !!entry.server && LOOPBACK.has(entry.server.host.toLowerCase());
  if (!entry.agent_count) entry.detail = 'roster has no character slots';
  else if (!entry.server_consistent) entry.detail = 'roster mixes more than one game server';
  else if (!entry.server) entry.detail = 'roster records no game server endpoint';
  return entry;
}

function discoverRosters() {
  const found = [];
  const named = join(SUBSTRATE, 'fleets');
  if (existsSync(named)) {
    for (const file of readdirSync(named).sort()) {
      // Everything else in that directory is a lock, a .prev, a rescue copy or a
      // keeper sidecar. A fleet name may not contain a dot, so one exact pattern
      // separates rosters from all of them.
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(file);
      if (!match) continue;
      found.push(readRoster(match[1], match[1], join(named, file)));
    }
  }
  // The unnamed fleet is still a fleet. It predates named rosters and on this machine
  // it is the record of a local server, so it belongs in the list under the label the
  // broker itself reports for it.
  const unnamed = join(SUBSTRATE, 'fleet-state.json');
  if (existsSync(unnamed)) found.push(readRoster('default', '', unnamed));
  return found;
}

// ------------------------------------------------------------------ brokers

function fetchJson(url, timeoutMs = 1500) {
  const u = new URL(url);
  return new Promise((done) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET', headers: { connection: 'close' }, agent: false, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return done(null);
        try { done(JSON.parse(body)); } catch { done(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

// Where to look. The default port first, because a checkout with one broker and no
// service pid file is the ordinary case and "localhost on the default port" is what a
// launcher tries when nobody said otherwise.
function candidateBrokerPorts() {
  // `--port 0` is how a test says "probe nothing but what I name", so the default is
  // filtered by the same rule as every other candidate rather than trusted.
  const ports = PORT_OK(DEFAULT_BROKER_PORT) ? [DEFAULT_BROKER_PORT] : [];
  for (const extra of (arg('--broker-ports', '') || '').split(',')) {
    const port = Number(extra);
    if (PORT_OK(port)) ports.push(port);
  }
  if (existsSync(SUBSTRATE)) {
    for (const file of readdirSync(SUBSTRATE)) {
      if (!/^broker-.+\.pid$/.test(file)) continue;
      try {
        const record = JSON.parse(readFileSync(join(SUBSTRATE, file), 'utf8'));
        const port = Number(record?.http);
        if (PORT_OK(port)) ports.push(port);
      } catch { /* a pid file we cannot read is only a lost hint */ }
    }
  }
  return [...new Set(ports)];
}

async function probeBrokers() {
  const ports = candidateBrokerPorts();
  const answers = await Promise.all(ports.map(port => fetchJson(`http://127.0.0.1:${port}/health`)));
  const brokers = [];
  for (let i = 0; i < ports.length; i += 1) {
    const health = answers[i];
    if (!health?.ok) continue;
    brokers.push({
      http: ports[i],
      pid: Number(health.pid) || null,
      fleet: health.fleet || 'default',
      root: health.root || '',
      state: health.state || '',
      sessions: Array.isArray(health.sessions) ? health.sessions : [],
      session_count: Array.isArray(health.sessions) ? health.sessions.length : 0,
      game_server: health.game_server || null,
    });
  }
  return brokers;
}

// ------------------------------------------------------------------ server reachability

function probeEndpoint({ host, port }, timeoutMs = 400) {
  return new Promise((done) => {
    const socket = net.connect({ host, port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// ------------------------------------------------------------------ judgement

// WHY A FLEET IS OR IS NOT OFFERABLE, IN ONE PLACE.
//
// The caller of this tool is a menu, and a menu that silently drops a fleet is the same
// failure as a broker that comes up empty: it answers confidently about a world that is
// smaller than the real one. Every roster comes back, each carrying the exact reason it
// cannot be attached to right now.
function judge(entry, brokers, defaultFleetName, labelCounts) {
  entry.default_fleet = (entry.fleet || '') === (defaultFleetName || '');
  entry.ambiguous_label = (labelCounts.get(entry.label) || 0) > 1;
  const held = brokers.find(broker => samePath(broker.state, entry.roster));
  if (held) {
    entry.broker = held;
    entry.status = 'attachable';
    entry.detail = `broker pid ${held.pid} on 127.0.0.1:${held.http}, ${held.session_count} session(s)`;
  } else if (entry.status === 'unreadable') {
    // readRoster already said why, and it is not about brokers.
  } else if (!entry.agent_count || !entry.server) {
    entry.status = 'unusable';
  } else {
    entry.status = 'no-broker';
    entry.detail = entry.fleet
      ? `no broker is holding this roster (start one: node tools/m59-service.mjs start --fleet ${entry.fleet})`
      : 'no broker is holding this roster (start one: node tools/m59-service.mjs start --fleet -)';
  }

  // Control eligibility is the gateway's rule restated, not a new one: an explicit
  // non-production fleet label whose sessions are all on a loopback game server. It is
  // reported so a launcher can arm the right fleets without re-deriving the policy, and
  // the gateway and broker still check it again at their own boundaries.
  //
  // The unnamed fleet is eligible under the same terms, because the broker gives it the
  // explicit label "default" and a gateway can name that. What it may not be is
  // AMBIGUOUS: a roster literally called default.json reports the same label, and then
  // neither the gateway nor anything else can tell the two apart from a health response.
  if (entry.ambiguous_label) entry.control_reason = `two rosters both report the label "${entry.label}"`;
  else if (/^prod(?:uction)?$/i.test(entry.label)) entry.control_reason = 'production is never controllable from a client';
  else if (!entry.server) entry.control_reason = 'the roster does not agree on one game server';
  else if (!entry.loopback) entry.control_reason = `${entry.server.host} is not a loopback game server`;
  else if (entry.status !== 'attachable') entry.control_reason = 'no broker is holding this roster';
  else if (held.game_server && !(LOOPBACK.has(String(held.game_server.host).toLowerCase()) &&
           Number(held.game_server.port) === entry.server.port)) {
    entry.control_reason = 'the broker\'s live sessions are not on this roster\'s loopback endpoint';
  } else entry.control_eligible = true;
  if (entry.control_eligible) entry.control_reason = '';
  return entry;
}

// ------------------------------------------------------------------ output

const fleets = discoverRosters();
const brokers = await probeBrokers();
// Which one this checkout means when nothing says otherwise -- the same resolution
// every other tool uses, minus `--fleet`, because an inventory lists all of them and a
// flag here would be read as "show me only that one". A launcher uses this to pick a
// primary; it is a preference, never an authorization.
let defaultFleetName = '';
try { defaultFleetName = resolveFleetName([]).name; }
catch { /* a bad recorded default is not a reason to refuse to list rosters */ }

const labelCounts = new Map();
for (const entry of fleets) labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);

for (const entry of fleets) {
  judge(entry, brokers, defaultFleetName, labelCounts);
  if (entry.server && (entry.loopback || PROBE_REMOTE)) {
    entry.server_reachable = await probeEndpoint(entry.server);
  }
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    schema: 'm59-fleets/v1',
    substrate: SUBSTRATE,
    default_fleet: defaultFleetName || '',
    default_broker_port: DEFAULT_BROKER_PORT,
    brokers,
    fleets,
  }, null, 2) + '\n');
  process.exit(0);
}

if (!fleets.length) {
  console.log(c.warn(`no rosters under ${SUBSTRATE} — this machine has no fleet credentials`));
  process.exit(0);
}
const width = Math.max(...fleets.map(entry => entry.label.length), 5);
for (const entry of fleets) {
  const name = entry.label.padEnd(width);
  const server = entry.server ? `${entry.server.host}:${entry.server.port}` : '(no server)';
  const paint = entry.status === 'attachable' ? c.ok : entry.status === 'no-broker' ? c.warn : c.bad;
  const marks = [
    entry.default_fleet ? 'default' : '',
    entry.control_eligible ? 'control-eligible' : '',
    entry.ambiguous_label ? 'ambiguous label' : '',
    entry.server_reachable === false ? 'server not answering' : '',
  ].filter(Boolean);
  console.log(`${paint(name)}  ${String(entry.agent_count).padStart(3)} slot(s)  ` +
    `${server.padEnd(21)}  ${paint(entry.status)}`);
  console.log(c.dim(`  ${entry.detail || 'ready'}${marks.length ? `  [${marks.join(', ')}]` : ''}`));
}
process.exit(0);
