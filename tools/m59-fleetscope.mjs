#!/usr/bin/env node
// WHOSE RECORDS ARE THESE? One answer, for every tool that reads a per-character file.
//
//   node tools/m59-fleetscope.mjs           # who counts as this fleet, and how we decided
//
// THE PROBLEM. `substrate/postmortems/`, `substrate/abilities/`, `substrate/hits/` and
// their siblings are keyed by CHARACTER NAME and nothing else. A machine that has ever
// run a second fleet — a local test server, another checkout, a scratch roster — has that
// fleet's characters sitting in the same directories for ever, because nothing ever
// deletes them and nothing ever labelled them.
//
// So every board and every report silently summed two populations. Measured when this was
// written: 2 of 18 characters with a death record, 5 of 26 with a hit record, and 10 of 31
// with an ability record belonged to a fleet nobody was asking about — including
// `User327460430`, a throwaway from a local server that no longer runs. The `/skills`
// board's atrophy figures, which are the whole reason that board exists, were computed
// over that mixture.
//
// It is the quiet kind of wrong. The totals are plausible, no tool errors, and the extra
// characters look exactly like fleet members you had forgotten about.
//
// THE RULE: ASK THE BROKER, NOT THE FILE. A fleet is whatever the running broker is
// holding. That is deliberately not "the fleet named in substrate/fleet-default": the
// question a report is answering is about the fleet that is PLAYING, and two checkouts can
// each hold a fleet called `prod` while being different characters. So a broker is matched
// to a roster by the STATE PATH its own /health reports — the same rule m59-fleets.mjs
// uses, and for the same reason — and never by fleet label.
//
// With no broker up it falls back to the resolved fleet's roster file, because the records
// outlive the broker and a report of a fleet that is currently down is a perfectly good
// thing to want. It always says which of the two it used, because a scope resolved from a
// file and one resolved from a live broker are not equally trustworthy and must not print
// the same way.
//
// A ROSTER IS THE CREDENTIAL STORE. This reads one, and returns NOTHING from it but
// character names — no account, no password, no host. Nothing here prints a roster, and
// nothing here should ever be made to.
import http from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet, stateFileFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SUBSTRATE = join(REPO, 'substrate');
const DEFAULT_BROKER_PORT = 8901;

const portOk = (p) => Number.isInteger(p) && p > 0 && p < 65536;

function fetchJson(url, timeoutMs = 1200) {
  const u = new URL(url);
  return new Promise((done) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET', headers: { connection: 'close' }, agent: false, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
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

// Where a broker might be. The default port, anything named explicitly, and every port a
// service pid file mentions — a hint, not a promise: a broker started by hand writes no
// pid file and a stale one outlives its process, so each candidate is asked rather than
// believed.
export function candidateBrokerPorts({ port = null, extra = [] } = {}) {
  const ports = [];
  if (portOk(Number(port))) ports.push(Number(port));
  if (portOk(DEFAULT_BROKER_PORT)) ports.push(DEFAULT_BROKER_PORT);
  for (const p of extra) if (portOk(Number(p))) ports.push(Number(p));
  if (existsSync(SUBSTRATE)) {
    for (const file of readdirSync(SUBSTRATE)) {
      if (!/^broker-.+\.pid$/.test(file)) continue;
      try {
        const rec = JSON.parse(readFileSync(join(SUBSTRATE, file), 'utf8'));
        if (portOk(Number(rec?.http))) ports.push(Number(rec.http));
      } catch { /* an unreadable pid file is a lost hint, not an error */ }
    }
  }
  return [...new Set(ports)];
}

export async function probeBrokers(opts = {}) {
  const ports = candidateBrokerPorts(opts);
  const answers = await Promise.all(ports.map(p => fetchJson(`http://127.0.0.1:${p}/health`)));
  const out = [];
  for (let i = 0; i < ports.length; i++) {
    const h = answers[i];
    if (!h?.ok) continue;
    out.push({ http: ports[i], pid: Number(h.pid) || null, fleet: h.fleet || 'default',
               state: h.state || '', sessions: Array.isArray(h.sessions) ? h.sessions.length : 0 });
  }
  return out;
}

// The character names in a roster, and nothing else from it.
export function charactersInRoster(rosterPath) {
  if (!rosterPath || !existsSync(rosterPath)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(rosterPath, 'utf8')); } catch { return null; }
  const names = new Set();
  // Two shapes have existed: a map of slot -> {credentials:{character}}, and older//other
  // rosters that carry the name at the top of the slot. Both are read rather than one
  // being declared canonical, because a scope that silently comes back empty filters
  // EVERYTHING out, which looks exactly like a fleet that has done nothing.
  for (const slot of Object.values(raw || {})) {
    if (!slot || typeof slot !== 'object') continue;
    const n = slot.credentials?.character ?? slot.character ?? null;
    if (n) names.add(String(n));
  }
  return names.size ? names : null;
}

// WHO COUNTS AS THIS FLEET. Returns `characters: null` when it genuinely cannot tell —
// which callers must render as "not filtered", never as "nobody".
export async function fleetScope({ argv = process.argv.slice(2), env = process.env,
                                   port = null, allFleets = false } = {}) {
  const resolved = resolveFleet(argv, env);
  if (allFleets)
    return { characters: null, from: 'every fleet on this machine (--all-fleets)',
             fleet: null, roster: null, broker: null, filtered: false };

  const brokers = await probeBrokers({ port });
  // Which broker? An explicit --port wins. Otherwise, the one holding the roster the
  // fleet name resolves to — matched on the PATH it reports, not on the label, because
  // two checkouts can both call a fleet `prod`.
  const wantState = resolve(stateFileFor(resolved.fleet, env));
  let picked = null;
  if (portOk(Number(port))) picked = brokers.find(b => b.http === Number(port)) ?? null;
  if (!picked) picked = brokers.find(b => b.state && resolve(b.state) === wantState) ?? null;
  // One broker and no ambiguity is the ordinary case, and it is what a person means by
  // "the fleet" when they have not said which.
  if (!picked && brokers.length === 1) picked = brokers[0];

  if (picked) {
    const names = charactersInRoster(picked.state);
    if (names)
      return { characters: names, fleet: picked.fleet, roster: picked.state, broker: picked,
               filtered: true,
               from: `the broker on ${picked.http} (pid ${picked.pid}), holding ${picked.fleet}` };
    return { characters: null, fleet: picked.fleet, roster: picked.state, broker: picked,
             filtered: false,
             from: `the broker on ${picked.http} names a roster this cannot read (${picked.state}) — not filtered` };
  }

  // No broker. The records outlive it, so fall back to the roster on disk and say so.
  const names = charactersInRoster(resolved.stateFile);
  if (names)
    return { characters: names, fleet: resolved.fleet || 'default', roster: resolved.stateFile,
             broker: null, filtered: true,
             from: `${resolved.stateFile.replace(REPO + '\\', '').replace(REPO + '/', '')} `
                 + `(no broker answering; ${resolved.source})` };
  return { characters: null, fleet: resolved.fleet || null, roster: resolved.stateFile,
           broker: null, filtered: false,
           from: 'no broker and no readable roster — not filtered' };
}

// Split rows into the ones this fleet owns and the ones it does not. `setAside` is
// returned rather than dropped: a report that silently discards records is the same
// failure in the other direction, and the count is worth printing.
export function partition(rows, scope, nameOf = (r) => r?.character) {
  if (!scope?.characters) return { kept: [...rows], setAside: [], others: [] };
  const kept = [], setAside = [];
  for (const r of rows) (scope.characters.has(String(nameOf(r))) ? kept : setAside).push(r);
  return { kept, setAside, others: [...new Set(setAside.map(r => String(nameOf(r))))].sort() };
}

// One line a tool can print under its own output, so the reader always knows which
// population the numbers describe.
export function scopeLine(scope, setAside = []) {
  if (!scope?.filtered)
    return `every character with a record on this machine — ${scope?.from ?? 'unfiltered'}`;
  const others = [...new Set(setAside.map(r => String(r?.character ?? r)))].sort();
  return `${scope.fleet}: ${scope.characters.size} character(s), from ${scope.from}`
       + (others.length
          ? `\n  ${others.length} character(s) from another fleet set aside: ${others.join(', ')}`
          : '');
}

// ---------------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const scope = await fleetScope({ argv, allFleets: argv.includes('--all-fleets') });
  console.log(`fleet    ${scope.fleet ?? '(none)'}`);
  console.log(`from     ${scope.from}`);
  console.log(`roster   ${scope.roster ?? '(none)'}`);
  console.log(`counts   ${scope.characters ? scope.characters.size + ' character(s)' : 'NOT FILTERED'}`);
  if (scope.characters) console.log(`         ${[...scope.characters].join(', ')}`);

  // What is on this machine that this scope excludes — the thing the boards were summing.
  const dirs = ['postmortems', 'abilities', 'banks', 'tougher', 'hits', 'descriptions', 'sheets'];
  console.log('\nper-character record directories:');
  for (const d of dirs) {
    const p = join(SUBSTRATE, d);
    if (!existsSync(p)) { console.log(`  ${d.padEnd(14)} (absent)`); continue; }
    const names = new Set();
    for (const f of readdirSync(p)) {
      if (!f.endsWith('.json')) continue;
      names.add(f.replace(/-\d{4}-\d\d-\d\dT.*$/, '').replace(/\.json$/, ''));
    }
    const foreign = scope.characters ? [...names].filter(n => !scope.characters.has(n)) : [];
    console.log(`  ${d.padEnd(14)} ${String(names.size).padStart(3)} character(s)` +
      (scope.characters
        ? `, ${String(foreign.length).padStart(2)} not in this fleet` +
          (foreign.length ? ` — ${foreign.slice(0, 6).join(', ')}${foreign.length > 6 ? ' …' : ''}` : '')
        : ''));
  }
}
