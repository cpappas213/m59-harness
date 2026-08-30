#!/usr/bin/env node
// A WIRE PROOF FOR THE SIX-INN FIXTURE ON AN IN-PROCESS BROKER. NOT THE SIX-CITY INSTRUMENT.
//
//   node tools/m59-city-matrix.mjs --config substrate/traces/city-matrix-config.json
//   node tools/m59-city-matrix.mjs --config substrate/traces/city-matrix-config.json --mode serial
//   node tools/m59-city-matrix.mjs --config substrate/traces/city-matrix-config.json --resume
//
// WHAT THIS IS. Six disposable characters at 10,000 health (`--fixture-health`; health and
// max health both, refreshed by DM heal at every placement) are PLACED by DM authority on a
// staging square inside each city's inn — Familiars in Tos, the Brownestone, Cibilo Creek,
// the Limping Toad, the Yonder Inn, the Aerie Guest House, with the Raza Inn as the car park
// for whoever is idle — and sent along the 25 physically walkable directed pairs between
// those squares, on a broker started with `--in-process` and `M59_COLLISION_TRACE=1`. What
// the run proves is the WIRE: that every coordinate packet the mover sent between those two
// squares validates against the BSP the client enforces, that no exit fallback was ever
// enabled, and that the capture is one ordered, complete sequence a verifier
// (`m59-collision-trace-verify.mjs`) can replay offline. Arrival is asserted because a leg
// that did not arrive has no complete sequence to verify, not because it measures anything.
//
// WHAT IT IS NOT. It is not the six-city zero-death instrument, and its PASS line does not
// say a real character can cross Meridian and live. A fixture with 10,000 health cannot die
// on any road here, a DM placement skips the approach to the door, every leg is sent with
// `run_errands: false` so nothing banks or shops on the way, and the survival ladder has
// nothing to react to at that health — so deaths, damage, rests, wall detours, stalls and the
// time a real crossing takes are all outside what this run can observe. Those questions
// belong to `m59-solo-run.mjs` (one character at a time, at real health, `--tour` for a
// circuit that asks whether it is still useful afterwards) and `m59-hoptest.mjs` (every
// doorway on an itinerary, independently, in seconds each); both keep the keeper armed and
// count deaths.
//
// AND NO REAL FLEET CAN RUN IT. `assertHealthSnapshot` refuses a broker whose
// `/health.session_driver` is not "in-process": the per-character keeper-process driver —
// the one every fleet on this machine runs, because it is the one that survives a keeper
// dying — has six independent sequence counters and cannot produce one ordered fleet
// trace. This is a lab tool for a disposable loopback server with a six-slot roster of its
// own, started as `docs/m59-routing.md` describes. The change that promoted this runner did
// not rerun the live matrix against that fixture (its description says so); it enforces
// every precondition before it mutates anything, which is a different claim from having
// passed.
//
// The configuration is deliberately external. Agent handles and character names belong
// to the disposable local fixture, not to this repository, and baking one lab's dated
// roster into a reusable tool is how a safe experiment gets pointed at the wrong fleet.
// The file contains only the named fleet, three loopback endpoints, and six explicit
// `{agent, character}` pairs; it contains no account name or password.
//
// Ko'catan has five physically unwalkable outbound directions in the stock geometry at
// room 2505. The matrix is therefore the twenty directed pairs among the five mainland
// cities plus the five mainland-to-Ko'catan pairs: exactly 25, never the tempting 30.
//
// THIS TOOL HAS DM AUTHORITY. Every endpoint is required to be literal 127.0.0.1, the
// broker must identify this checkout and the exact named roster, all of its sessions must
// be the six configured participants, and every health sample must report that the
// unvalidated exit fallback is OFF. A CLI promise is not evidence about an already-running
// broker; `/health.movement_policy.exit_fallback_enabled` is. It also holds the fleet run
// lock (`m59-runlock.mjs`) for the whole run, so a driver whose shell died cannot go on
// issuing relocations against a second run's bodies.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { takeRunLock } from './m59-runlock.mjs';

export const SCHEMA = 'm59-city-matrix/1';
export const MODES = Object.freeze(['parallel', 'serial']);
export const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_OUTPUT = fileURLToPath(
  new URL('../substrate/traces/m59-city-matrix.json', import.meta.url));
export const TRACE_OUTPUT_ROOT = fileURLToPath(
  new URL('../substrate/traces/', import.meta.url));
export const expectedCollisionTraceFile = (harnessRoot = HARNESS_ROOT) =>
  resolve(harnessRoot, 'substrate', 'collision-trace.jsonl');

export const CITIES = Object.freeze([
  Object.freeze({ name: 'Tos', room: 52, stage: Object.freeze({ row: 5, col: 6 }) }),
  Object.freeze({ name: 'Barloque', room: 106, stage: Object.freeze({ row: 10, col: 11 }) }),
  Object.freeze({ name: 'Cornoth', room: 153, stage: Object.freeze({ row: 5, col: 7 }) }),
  Object.freeze({ name: 'Marion', room: 202, stage: Object.freeze({ row: 9, col: 7 }) }),
  Object.freeze({ name: 'Jasper', room: 370, stage: Object.freeze({ row: 5, col: 7 }) }),
  Object.freeze({ name: "Ko'catan", room: 2001, stage: Object.freeze({ row: 7, col: 5 }) }),
]);

export const PARKING = Object.freeze({
  name: 'Raza Inn', room: 1011, stage: Object.freeze({ row: 4, col: 6 }),
});

const MAINLAND = CITIES.slice(0, 5);
const KOCATAN = CITIES[5];
const FLEET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Meridian character names are one alphabetic word. Keeping this narrower than an
// arbitrary string also keeps a newline or maintenance command out of the DM protocol.
const CHARACTER_NAME = /^[A-Za-z][A-Za-z]{0,31}$/;

const plainObject = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function assertKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be a JSON object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function endpoint(value, label) {
  assertKeys(value, ['host', 'port'], label);
  if (value.host !== '127.0.0.1') {
    throw new Error(`${label}.host must be literal 127.0.0.1; refusing a non-loopback or ` +
      `wildcard endpoint`);
  }
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${label}.port must be an integer from 1 through 65535`);
  return { host: '127.0.0.1', port };
}

export function validateParticipants(value) {
  if (!Array.isArray(value) || value.length !== 6)
    throw new Error('config.participants must contain exactly six entries');
  const participants = value.map((row, index) => {
    const label = `config.participants[${index}]`;
    assertKeys(row, ['agent', 'character'], label);
    const agent = String(row.agent ?? '').trim();
    const character = String(row.character ?? '').trim();
    if (!AGENT_NAME.test(agent))
      throw new Error(`${label}.agent must contain only letters, digits, dash and underscore`);
    if (!CHARACTER_NAME.test(character))
      throw new Error(`${label}.character must be one alphabetic Meridian name`);
    return { agent, character };
  });
  const duplicateAgents = participants.filter((row, index) =>
    participants.findIndex(other => other.agent === row.agent) !== index);
  const duplicateCharacters = participants.filter((row, index) =>
    participants.findIndex(other => other.character.toLowerCase() === row.character.toLowerCase()) !== index);
  if (duplicateAgents.length) throw new Error('config.participants contains a duplicate agent');
  if (duplicateCharacters.length) throw new Error('config.participants contains a duplicate character');
  return participants;
}

export function validateConfig(value) {
  assertKeys(value, ['fleet', 'broker', 'game', 'admin', 'participants'], 'config');
  const fleet = String(value.fleet ?? '').trim();
  if (!FLEET_NAME.test(fleet) || fleet.toLowerCase() === 'default') {
    throw new Error('config.fleet must be an explicit named fleet (not "default") using ' +
      'letters, digits, dash and underscore');
  }
  const config = {
    fleet,
    broker: endpoint(value.broker, 'config.broker'),
    game: endpoint(value.game, 'config.game'),
    admin: endpoint(value.admin, 'config.admin'),
    participants: validateParticipants(value.participants),
  };
  const ports = [config.broker.port, config.game.port, config.admin.port];
  if (new Set(ports).size !== ports.length)
    throw new Error('config broker, game and admin ports must be distinct');
  return config;
}

export function expectedStateFile(config, harnessRoot = HARNESS_ROOT) {
  return resolve(harnessRoot, 'substrate', 'fleets', `${config.fleet}.json`);
}

export const pairKey = pair => `${pair.from}>${pair.to}`;

// K5's directed edges split into four cyclic shifts. In each mainland group every city
// is a source and a destination exactly once; the fifth group is the unavoidable
// convergence on Ko'catan.
export function reachablePairGroups() {
  const groups = [1, 2, 3, 4].map((shift, index) => ({
    index: index + 1,
    kind: 'mainland',
    pairs: MAINLAND.map((from, fromIndex) => ({
      from: from.room,
      from_name: from.name,
      to: MAINLAND[(fromIndex + shift) % MAINLAND.length].room,
      to_name: MAINLAND[(fromIndex + shift) % MAINLAND.length].name,
    })),
  }));
  groups.push({
    index: 5,
    kind: 'to_kocatan',
    pairs: MAINLAND.map(from => ({
      from: from.room, from_name: from.name,
      to: KOCATAN.room, to_name: KOCATAN.name,
    })),
  });
  let pairIndex = 0;
  return groups.map(group => ({
    ...group,
    pairs: group.pairs.map(pair => ({ ...pair, pair_index: ++pairIndex })),
  }));
}

export function expectedReachablePairKeys() {
  return new Set(MAINLAND.flatMap(from => CITIES
    .filter(to => to.room !== from.room)
    .map(to => `${from.room}>${to.room}`)));
}

export function reachablePairs() {
  const pairs = reachablePairGroups().flatMap(group => group.pairs.map(pair => ({
    ...pair, kind: group.kind,
  })));
  const actual = new Set(pairs.map(pairKey));
  const expected = expectedReachablePairKeys();
  if (pairs.length !== 25 || actual.size !== 25 || expected.size !== 25 ||
      [...expected].some(key => !actual.has(key))) {
    throw new Error('reachable itinerary is not the exact 25-pair directed city matrix');
  }
  return pairs;
}

function assignment(pair, participant, batch, index) {
  return {
    index,
    pair_index: pair.pair_index,
    batch,
    kind: pair.kind,
    from: pair.from,
    from_name: pair.from_name,
    to: pair.to,
    to_name: pair.to_name,
    agent: participant.agent,
    character: participant.character,
  };
}

export function assertSchedule(schedule, participants, mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown city-matrix mode ${JSON.stringify(mode)}`);
  if (!Array.isArray(schedule)) throw new Error('schedule must be an array');
  const flat = schedule.flatMap(batch => batch.assignments ?? []);
  const expectedPairs = expectedReachablePairKeys();
  const countsByPair = new Map();
  for (const row of flat)
    countsByPair.set(pairKey(row), (countsByPair.get(pairKey(row)) ?? 0) + 1);
  const wantedPerPair = mode === 'serial' ? participants.length : 1;
  const wantedBatches = mode === 'serial' ? 25 : 5;
  const wantedAssignments = 25 * wantedPerPair;
  if (schedule.length !== wantedBatches || flat.length !== wantedAssignments)
    throw new Error(`${mode} schedule has the wrong batch or assignment count`);
  if (countsByPair.size !== 25 || [...expectedPairs].some(key =>
    countsByPair.get(key) !== wantedPerPair))
    throw new Error(`${mode} schedule is not the exact reachable pair matrix`);

  const participantAgents = new Set(participants.map(row => row.agent));
  const unknown = flat.filter(row => !participantAgents.has(row.agent));
  if (unknown.length) throw new Error('schedule assigns an unknown participant');
  const loads = new Map(participants.map(row => [row.agent, 0]));
  for (const row of flat) loads.set(row.agent, loads.get(row.agent) + 1);

  for (let index = 0; index < schedule.length; index++) {
    const batch = schedule[index];
    if (batch.index !== index + 1) throw new Error('schedule batch indexes must be contiguous');
    const agents = batch.assignments.map(row => row.agent);
    if (new Set(agents).size !== agents.length)
      throw new Error(`schedule batch ${batch.index} assigns a participant twice`);
    if (mode === 'parallel') {
      if (batch.assignments.length !== 5 || batch.idle?.length !== 1)
        throw new Error(`parallel batch ${batch.index} must assign five and idle one`);
    } else {
      if (batch.assignments.length !== participants.length || (batch.idle?.length ?? 0) !== 0)
        throw new Error(`serial batch ${batch.index} must assign all participants`);
      if (new Set(batch.assignments.map(pairKey)).size !== 1)
        throw new Error(`serial batch ${batch.index} must exercise one pair`);
    }
  }

  const values = [...loads.values()];
  if (mode === 'serial' && values.some(value => value !== 25))
    throw new Error('serial schedule does not give every participant all 25 pairs');
  if (mode === 'parallel' && Math.max(...values) - Math.min(...values) > 1)
    throw new Error('parallel schedule assignment load differs by more than one');
  return schedule;
}

export function buildSchedule(participants, mode = 'parallel') {
  const clean = validateParticipants(participants);
  const groups = reachablePairGroups();
  let assignmentIndex = 0;
  let schedule;

  if (mode === 'parallel') {
    schedule = groups.map(group => {
      const assignments = group.pairs.map(pair => {
        const participant = clean[assignmentIndex % clean.length];
        return assignment({ ...pair, kind: group.kind }, participant, group.index,
          ++assignmentIndex);
      });
      const assigned = new Set(assignments.map(row => row.agent));
      return {
        index: group.index,
        kind: group.kind,
        assignments,
        idle: clean.filter(row => !assigned.has(row.agent)),
      };
    });
  } else if (mode === 'serial') {
    schedule = reachablePairs().map((pair, batchIndex) => ({
      index: batchIndex + 1,
      kind: pair.kind,
      assignments: clean.map(participant => assignment(pair, participant, batchIndex + 1,
        ++assignmentIndex)),
      idle: [],
    }));
  } else {
    throw new Error(`unknown city-matrix mode ${JSON.stringify(mode)}`);
  }
  return assertSchedule(schedule, clean, mode);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}

export const fingerprint = value => createHash('sha256')
  .update(JSON.stringify(canonical(value))).digest('hex');

export function resolveHarnessPath(value, harnessRoot = HARNESS_ROOT) {
  const path = String(value ?? '');
  return resolve(isAbsolute(path) ? path : resolve(harnessRoot, path));
}

export const positionAt = (position, stage) =>
  position?.row === stage?.row && position?.col === stage?.col;

export function assertBatchStaging(rows, scheduled, { fixtureHealth = null } = {}) {
  if (!Array.isArray(rows)) throw new Error(`batch ${scheduled?.index ?? '?'} staging is not an array`);
  const expected = new Map();
  for (const assigned of scheduled.assignments ?? []) {
    const city = CITIES.find(row => row.room === assigned.from);
    if (!city) throw new Error(`batch ${scheduled.index} has no staging city for room ${assigned.from}`);
    expected.set(assigned.agent, { room: city.room, stage: city.stage });
  }
  for (const participant of scheduled.idle ?? [])
    expected.set(participant.agent, { room: PARKING.room, stage: PARKING.stage });
  const actual = new Map(rows.map(row => [row?.agent, row]));
  if (rows.length !== expected.size || actual.size !== expected.size ||
      [...expected.keys()].some(agent => !actual.has(agent)))
    throw new Error(`batch ${scheduled.index} staging status must contain every participant exactly once`);
  for (const [agent, wanted] of expected) {
    const row = actual.get(agent);
    if (row.room !== wanted.room || !positionAt(row.position, wanted.stage))
      throw new Error(`batch ${scheduled.index} ${agent} left exact staging square ` +
        `${wanted.room}:${wanted.stage.row},${wanted.stage.col}`);
    if (row.busy)
      throw new Error(`batch ${scheduled.index} ${agent} became busy after staging`);
    if (fixtureHealth != null &&
        (row.health !== fixtureHealth || row.max_health !== fixtureHealth))
      throw new Error(`batch ${scheduled.index} ${agent} lost fixture health after staging`);
  }
  return rows;
}

function samePath(left, right) {
  const normalized = value => {
    const path = resolve(String(value ?? '')).replaceAll('\\', '/');
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  return normalized(left) === normalized(right);
}

export function assertSafeOutputPath(outputValue, configPath, harnessRoot = HARNESS_ROOT) {
  const output = resolveHarnessPath(outputValue, harnessRoot);
  const traceRoot = resolve(harnessRoot, 'substrate', 'traces');
  const fromTraceRoot = relative(traceRoot, output);
  const firstSegment = fromTraceRoot.split(/[\\/]/)[0];
  if (!fromTraceRoot || isAbsolute(fromTraceRoot) || firstSegment === '..')
    throw new Error('--output must be a descendant of this harness checkout\'s substrate/traces');
  if (extname(output).toLowerCase() !== '.json') throw new Error('--output must be a .json file');
  if (samePath(output, configPath))
    throw new Error('--output must not be the config file; refusing to overwrite a fleet roster');
  return output;
}

export function assertHealthSnapshot(health, config, {
  label = 'health', harnessRoot = HARNESS_ROOT,
  stateFile = expectedStateFile(config, harnessRoot),
} = {}) {
  if (!plainObject(health)) throw new Error(`${label}: broker health is not an object`);
  const sessions = Array.isArray(health.sessions) ? health.sessions : [];
  const agents = config.participants.map(row => row.agent);
  const characterByAgent = health.session_characters;
  const objectIdByAgent = health.session_object_ids;
  const missing = agents.filter(agent => !sessions.includes(agent));
  const unexpected = sessions.filter(agent => !agents.includes(agent));
  const sessionServers = health.session_game_servers ?? {};
  const wrongSessionServers = agents.filter(agent =>
    sessionServers[agent]?.host !== config.game.host ||
    Number(sessionServers[agent]?.port) !== config.game.port);
  if (health.ok !== true) throw new Error(`${label}: broker did not report ok=true`);
  if (health.fleet !== config.fleet)
    throw new Error(`${label}: broker holds fleet ${JSON.stringify(health.fleet)}, expected ` +
      JSON.stringify(config.fleet));
  if (!samePath(health.root, harnessRoot))
    throw new Error(`${label}: broker root is not this harness checkout`);
  if (!samePath(health.state, stateFile))
    throw new Error(`${label}: broker state is not the configured fleet roster`);
  if (health.game_server?.host !== config.game.host ||
      Number(health.game_server?.port) !== config.game.port)
    throw new Error(`${label}: broker sessions do not share the configured loopback game endpoint`);
  if (health.session_driver !== 'in-process')
    throw new Error(`${label}: broker must report session_driver="in-process" for this lab run`);
  if (!Array.isArray(health.geometry_drift) || health.geometry_drift.length)
    throw new Error(`${label}: geometry drift must be present and empty`);
  if (missing.length || unexpected.length)
    throw new Error(`${label}: broker sessions differ from config (missing ${missing.join(',') || '-'}; ` +
      `unexpected ${unexpected.join(',') || '-'})`);
  if (wrongSessionServers.length)
    throw new Error(`${label}: participant session(s) target the wrong game server: ` +
      wrongSessionServers.join(', '));
  if (!plainObject(characterByAgent) || Object.keys(characterByAgent).length !== agents.length ||
      agents.some(agent => !Object.hasOwn(characterByAgent, agent)))
    throw new Error(`${label}: session_characters must have exactly the six configured agent keys`);
  const wrongCharacters = config.participants.filter(({ agent, character }) =>
    typeof characterByAgent[agent] !== 'string' ||
    characterByAgent[agent].toLowerCase() !== character.toLowerCase());
  if (wrongCharacters.length)
    throw new Error(`${label}: live agent-to-character mapping differs from config: ` +
      wrongCharacters.map(row => row.agent).join(', '));
  if (!plainObject(objectIdByAgent) || Object.keys(objectIdByAgent).length !== agents.length ||
      agents.some(agent => !Object.hasOwn(objectIdByAgent, agent)))
    throw new Error(`${label}: session_object_ids must have exactly the six configured agent keys`);
  const objectIds = agents.map(agent => objectIdByAgent[agent]);
  if (objectIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(objectIds).size !== objectIds.length)
    throw new Error(`${label}: session_object_ids must be six distinct positive safe integers`);
  if (health.movement_policy?.exit_fallback_enabled !== false)
    throw new Error(`${label}: broker must authoritatively report ` +
      'movement_policy.exit_fallback_enabled=false');
  const expectedTrace = expectedCollisionTraceFile(harnessRoot);
  if (health.collision_trace?.enabled !== true)
    throw new Error(`${label}: broker must authoritatively report collision_trace.enabled=true`);
  if (typeof health.collision_trace?.file !== 'string' ||
      !isAbsolute(health.collision_trace.file) ||
      !samePath(health.collision_trace.file, expectedTrace))
    throw new Error(`${label}: broker collision_trace.file must be the exact default checkout path ` +
      expectedTrace);
  return health;
}

export function assertDmResolution(resolved, health, config, {
  label = 'DM identity', harnessRoot = HARNESS_ROOT,
  stateFile = expectedStateFile(config, harnessRoot),
} = {}) {
  assertHealthSnapshot(health, config,
    { label: `${label} health`, harnessRoot, stateFile });
  if (!plainObject(resolved)) throw new Error(`${label}: dm.resolve did not return an object`);
  const characters = config.participants.map(row => row.character);
  if (Object.keys(resolved).length !== characters.length ||
      characters.some(character => !Object.hasOwn(resolved, character)))
    throw new Error(`${label}: dm.resolve must return exactly the six configured characters`);
  const dmIds = characters.map(character => resolved[character]);
  if (dmIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(dmIds).size !== dmIds.length)
    throw new Error(`${label}: dm.resolve must return six distinct positive object IDs`);
  const mismatches = config.participants.filter(({ agent, character }) =>
    resolved[character] !== health.session_object_ids[agent]);
  if (mismatches.length)
    throw new Error(`${label}: admin DM object IDs do not match broker live sessions: ` +
      mismatches.map(row => row.agent).join(', '));
  return Object.fromEntries(config.participants.map(({ agent, character }) => [agent, {
    character,
    broker_object_id: health.session_object_ids[agent],
    dm_object_id: resolved[character],
  }]));
}

export function assertIdentityProof(proof, config, identity = {}) {
  if (!plainObject(proof)) throw new Error(`${identity.label ?? 'identity proof'} is not an object`);
  isoMillis(proof.observed_at, `${identity.label ?? 'identity proof'}.observed_at`);
  return assertDmResolution(proof.dm_object_ids, proof.health, config, identity);
}

export function buildRunConfig(config, { mode, fixtureHealth, maxLegMs }, health) {
  if (!MODES.includes(mode)) throw new Error(`unknown city-matrix mode ${JSON.stringify(mode)}`);
  if (!Number.isInteger(fixtureHealth) || fixtureHealth < 1 || fixtureHealth > 32_767)
    throw new Error('fixtureHealth must be an integer from 1 through 32767');
  if (!Number.isFinite(maxLegMs) || maxLegMs < 1)
    throw new Error('maxLegMs must be a positive number');
  if (health.movement_policy?.exit_fallback_enabled !== false)
    throw new Error('cannot build run config without authoritative disabled exit fallback health');
  if (health.session_driver !== 'in-process')
    throw new Error('cannot build run config without authoritative in-process session health');
  if (health.collision_trace?.enabled !== true)
    throw new Error('cannot build run config without authoritative enabled collision tracing');
  if (typeof health.collision_trace?.file !== 'string' ||
      !isAbsolute(health.collision_trace.file) ||
      !samePath(health.collision_trace.file, expectedCollisionTraceFile()))
    throw new Error('cannot build run config without the default checkout collision trace path');
  return {
    mode,
    fleet: config.fleet,
    broker: config.broker,
    game: config.game,
    admin: config.admin,
    fixture_health: fixtureHealth,
    max_leg_ms: maxLegMs,
    exit_fallback_enabled: health.movement_policy.exit_fallback_enabled,
    session_driver: health.session_driver,
    collision_trace: {
      enabled: health.collision_trace.enabled,
      file: health.collision_trace.file,
    },
    participants: config.participants,
  };
}

export function assertTraceLifecycle({ resume = false, traceExists = false,
                                       completedBatches = 0 } = {}) {
  if (!Number.isSafeInteger(completedBatches) || completedBatches < 0)
    throw new Error('completedBatches must be a non-negative safe integer');
  if (!resume && traceExists)
    throw new Error('collision trace already exists; stop the broker, clear the default trace, ' +
      'then start a fresh traced run at sequence 1');
  if (resume && completedBatches > 0 && !traceExists)
    throw new Error('cannot resume completed batches without the existing collision trace');
  return true;
}

function isoMillis(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not an ISO timestamp`);
  return parsed;
}

export function assertCompletedBatch(batch, scheduled, config, identity = {}) {
  if (!plainObject(batch) || batch.index !== scheduled.index || batch.kind !== scheduled.kind)
    throw new Error(`completed batch is not scheduled batch ${scheduled.index}`);
  if (!Array.isArray(batch.results) || batch.results.length !== scheduled.assignments.length)
    throw new Error(`batch ${scheduled.index} has the wrong result count`);
  const batchStart = isoMillis(batch.started_at, `batch ${batch.index}.started_at`);
  const batchFinish = isoMillis(batch.finished_at, `batch ${batch.index}.finished_at`);
  if (batchFinish < batchStart) throw new Error(`batch ${batch.index} finishes before it starts`);
  assertIdentityProof(batch.identity_before_mutation, config,
    { ...identity, label: `batch ${batch.index} identity_before_mutation` });
  assertHealthSnapshot(batch.health_before, config,
    { ...identity, label: `batch ${batch.index} health_before` });
  assertHealthSnapshot(batch.health_after, config,
    { ...identity, label: `batch ${batch.index} health_after` });
  assertBatchStaging(batch.status_before, scheduled,
    { fixtureHealth: identity.fixtureHealth ?? null });

  batch.results.forEach((row, index) => {
    const wanted = scheduled.assignments[index];
    for (const key of ['index', 'pair_index', 'batch', 'kind', 'from', 'from_name',
      'to', 'to_name', 'agent', 'character']) {
      if (row[key] !== wanted[key])
        throw new Error(`batch ${batch.index} result ${index + 1} has wrong ${key}`);
    }
    const started = isoMillis(row.started_at, `batch ${batch.index} result.started_at`);
    const finished = isoMillis(row.finished_at, `batch ${batch.index} result.finished_at`);
    if (finished < started || started < batchStart || finished > batchFinish)
      throw new Error(`batch ${batch.index} result ${index + 1} has an invalid interval`);
    if (row.arrived !== true || Number(row.deaths) !== 0)
      throw new Error(`batch ${batch.index} result ${index + 1} did not arrive alive`);
    if (row.result?.agent !== wanted.agent || row.result?.from !== wanted.from ||
        row.result?.to !== wanted.to || row.result?.arrived !== true ||
        Number(row.result?.deaths) !== 0 || !Array.isArray(row.result?.rooms) ||
        !row.result.rooms.includes(wanted.from) || !row.result.rooms.includes(wanted.to))
      throw new Error(`batch ${batch.index} result ${index + 1} contradicts its assignment`);
  });
  if (batch.attempts !== scheduled.assignments.length ||
      batch.arrived !== scheduled.assignments.length || Number(batch.deaths) !== 0)
    throw new Error(`batch ${batch.index} summary does not describe a clean pass`);
  return batch;
}

function configFromRunConfig(runConfig) {
  return validateConfig({
    fleet: runConfig.fleet,
    broker: runConfig.broker,
    game: runConfig.game,
    admin: runConfig.admin,
    participants: runConfig.participants,
  });
}

export function validateCheckpoint(report, runConfig, schedule, {
  harnessRoot = HARNESS_ROOT,
  stateFile = expectedStateFile(configFromRunConfig(runConfig), harnessRoot),
} = {}) {
  if (!plainObject(report) || report.schema !== SCHEMA)
    throw new Error(`checkpoint schema must be ${SCHEMA}`);
  if (runConfig.exit_fallback_enabled !== false)
    throw new Error('current run config does not prove the exit fallback is disabled');
  if (runConfig.session_driver !== 'in-process')
    throw new Error('current run config does not prove in-process session driving');
  if (runConfig.collision_trace?.enabled !== true ||
      !samePath(runConfig.collision_trace?.file, expectedCollisionTraceFile(harnessRoot)))
    throw new Error('current run config does not prove enabled tracing at the default path');
  if (report.run_config?.exit_fallback_enabled !== false)
    throw new Error('checkpoint does not record exit_fallback_enabled=false');
  if (fingerprint(report.run_config) !== fingerprint(runConfig) ||
      report.config_fingerprint !== fingerprint(runConfig))
    throw new Error('checkpoint belongs to a different run configuration');
  if (report.schedule_fingerprint !== fingerprint(schedule) ||
      fingerprint(report.schedule) !== fingerprint(schedule))
    throw new Error('checkpoint schedule differs from the current schedule');
  if (!Array.isArray(report.batches) || report.batches.length > schedule.length)
    throw new Error('checkpoint has an invalid completed batch list');
  if (report.verdict !== 'running' && report.verdict !== 'pass')
    throw new Error('only a running or completed clean checkpoint can be resumed');
  if (report.failed_batch || report.failure)
    throw new Error('a checkpoint containing a failure cannot be resumed');

  const config = configFromRunConfig(runConfig);
  if (fingerprint(schedule) !== fingerprint(buildSchedule(config.participants, runConfig.mode)))
    throw new Error('current schedule is not the canonical reachable city matrix');
  const identity = { harnessRoot, stateFile, fixtureHealth: runConfig.fixture_health };
  assertHealthSnapshot(report.health_start, config, { ...identity, label: 'health_start' });
  if (report.resume_health !== undefined && !Array.isArray(report.resume_health))
    throw new Error('checkpoint resume_health must be an array');
  for (const [index, health] of (report.resume_health ?? []).entries())
    assertHealthSnapshot(health, config, { ...identity, label: `resume_health[${index}]` });
  if (report.fixture_setups !== undefined && !Array.isArray(report.fixture_setups))
    throw new Error('checkpoint fixture_setups must be an array');
  if (report.batches.length && !(report.fixture_setups?.length > 0))
    throw new Error('checkpoint with completed batches lacks a pre-provisioning identity proof');
  for (const [index, setup] of (report.fixture_setups ?? []).entries())
    assertIdentityProof(setup?.identity_before_mutation, config,
      { ...identity, label: `fixture_setups[${index}].identity_before_mutation` });
  report.batches.forEach((batch, index) => {
    if (batch.index !== index + 1)
      throw new Error('checkpoint completed batches are not a contiguous schedule prefix');
    assertCompletedBatch(batch, schedule[index], config, identity);
  });
  if (report.health_end)
    assertHealthSnapshot(report.health_end, config, { ...identity, label: 'health_end' });
  if (report.verdict === 'pass' &&
      (report.batches.length !== schedule.length || !report.health_end))
    throw new Error('passing checkpoint is incomplete');
  return { completed: report.batches.length, remaining: schedule.length - report.batches.length };
}

export function parseCli(argv) {
  const values = new Map();
  const flags = new Set();
  const valueFlags = new Set(['--config', '--mode', '--output', '--fixture-health', '--max-leg']);
  const boolFlags = new Set(['--resume', '--overwrite', '--help', '--example']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (values.has(arg)) throw new Error(`${arg} may be supplied only once`);
      values.set(arg, value);
    } else if (boolFlags.has(arg)) {
      if (flags.has(arg)) throw new Error(`${arg} may be supplied only once`);
      flags.add(arg);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (flags.has('--help')) return { help: true };
  if (flags.has('--example')) {
    if (argv.length !== 1) throw new Error('--example does not take other arguments');
    return { help: false, example: true };
  }
  if (!values.has('--config')) throw new Error('--config is required');
  if (flags.has('--resume') && flags.has('--overwrite'))
    throw new Error('--resume and --overwrite are mutually exclusive');
  const mode = values.get('--mode') ?? 'parallel';
  if (!MODES.includes(mode)) throw new Error('--mode must be parallel or serial');
  const fixtureHealth = Number(values.get('--fixture-health') ?? 10_000);
  if (!Number.isInteger(fixtureHealth) || fixtureHealth < 1 || fixtureHealth > 32_767)
    throw new Error('--fixture-health must be an integer from 1 through 32767');
  const maxLegSeconds = Number(values.get('--max-leg') ?? 1_800);
  if (!Number.isFinite(maxLegSeconds) || maxLegSeconds <= 0)
    throw new Error('--max-leg must be a positive number of seconds');
  const configPath = resolveHarnessPath(values.get('--config'));
  const output = assertSafeOutputPath(values.get('--output') ?? DEFAULT_OUTPUT, configPath);
  return {
    help: false,
    example: false,
    configPath,
    mode,
    output,
    fixtureHealth,
    maxLegMs: maxLegSeconds * 1_000,
    resume: flags.has('--resume'),
    overwrite: flags.has('--overwrite'),
  };
}

export function exampleConfig() {
  return {
    fleet: 'routing-lab',
    broker: { host: '127.0.0.1', port: 8911 },
    game: { host: '127.0.0.1', port: 15959 },
    admin: { host: '127.0.0.1', port: 19998 },
    participants: Array.from({ length: 6 }, (_, index) => ({
      agent: `lab${index + 1}`,
      character: `Tester${String.fromCharCode(65 + index)}`,
    })),
  };
}

function usage() {
  return `usage: node tools/m59-city-matrix.mjs --config <file> [options]\n\n` +
    `  --mode parallel|serial   25 legs in five batches, or all six over all 25 pairs\n` +
    `  --resume                continue a passing-prefix checkpoint\n` +
    `  --overwrite             replace an existing output instead of resuming it\n` +
    `  --output <file.json>    default: substrate/traces/m59-city-matrix.json\n` +
    `  --fixture-health <n>    disposable fixture health/max-health (default 10000)\n` +
    `  --max-leg <seconds>     per-leg deadline (default 1800)\n\n` +
    `  --example               print a credential-free config template and exit\n\n` +
    `config shape:\n` + JSON.stringify(exampleConfig(), null, 2) + '\n';
}

function checkpoint(output, report) {
  mkdirSync(dirname(output), { recursive: true });
  // Same-directory rename is the atomic boundary. A killed process may leave its uniquely
  // named .tmp, but it can never leave half a JSON checkpoint under the path --resume reads.
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    renameSync(temporary, output);
    renamed = true;
  } finally {
    if (!renamed && existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function observed(health) {
  return { ...health, observed_at: new Date().toISOString() };
}

function getJsonLoopback(port, path = '/health', timeoutMs = 15_000) {
  return new Promise((done, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = http.get({
      hostname: '127.0.0.1', port, path,
      agent: false, headers: { connection: 'close', host: `127.0.0.1:${port}` },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300)
          return finish(reject, new Error(`broker health returned HTTP ${response.statusCode}`));
        try { finish(done, JSON.parse(text)); }
        catch { finish(reject, new Error('broker health returned non-JSON')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(
      `broker health did not answer within ${timeoutMs}ms`)));
    request.on('error', error => finish(reject, error));
  });
}

function statusRow(agent, status) {
  return {
    agent,
    room: status?.where?.num ?? null,
    room_name: status?.where?.name ?? null,
    busy: !!status?.busy,
    position: status?.position ?? null,
    health: status?.vitals?.health?.value ?? null,
    max_health: status?.vitals?.health?.max ?? null,
    last_action: status?.last_action ?? null,
  };
}

const dead = row => /underworld/i.test(row.room_name ?? '') || row.room === 1 ||
  (row.health != null && row.health <= 0);

async function runLive(cli, config, schedule, report, dependencies, readHealth) {
  const { runLeg, rpc, heal, kit, relocate, resolveCharacters } = dependencies;
  const agents = config.participants.map(row => row.agent);
  const characters = config.participants.map(row => row.character);
  const cityByRoom = new Map(CITIES.map(city => [city.room, city]));
  const dmOpts = { env: { ...process.env,
    M59_HOST: config.game.host,
    M59_PORT: String(config.game.port),
    M59_ADMIN_HOST: config.admin.host,
    M59_ADMIN_PORT: String(config.admin.port),
  } };

  const statusOf = async (agent, timeoutMs = 30_000) =>
    statusRow(agent, await rpc(config.broker.port, 'status', { agent }, timeoutMs));

  // A loopback address does not prove two ports terminate in the same game process. Resolve
  // all six names read-only through the maintenance socket and compare those transient IDs
  // with the broker's simultaneous live-session IDs before giving the DM socket authority.
  const proveAdminIdentity = async label => {
    const health = await readHealth(`${label} broker identity`);
    const dmObjectIds = await resolveCharacters(characters, dmOpts);
    const proof = {
      observed_at: new Date().toISOString(),
      health,
      dm_object_ids: dmObjectIds,
    };
    proof.matches = assertDmResolution(dmObjectIds, health, config,
      { label, harnessRoot: HARNESS_ROOT, stateFile: expectedStateFile(config) });
    return proof;
  };

  const waitForFixture = async (participant, room, stage, label) => {
    const deadline = Date.now() + 120_000;
    let row = null;
    while (Date.now() <= deadline) {
      row = await statusOf(participant.agent);
      if (row.room === room && positionAt(row.position, stage) &&
          !row.busy && row.health === cli.fixtureHealth &&
          row.max_health === cli.fixtureHealth) return row;
      await new Promise(done => setTimeout(done, 1_000));
    }
    throw new Error(`${label}: broker did not confirm room ${room} square ` +
      `${stage.row},${stage.col}, idle state, and ${cli.fixtureHealth}/${cli.fixtureHealth} ` +
      `health: ${JSON.stringify(row)}`);
  };

  const refresh = async (participant, label) => {
    const result = await heal([participant.character], dmOpts);
    if (result.missing?.length || result.rejected?.length ||
        !result.healed?.includes(participant.character))
      throw new Error(`${label}: fixture heal failed: ${JSON.stringify(result)}`);
    return result;
  };

  const provisionFixtures = async identityBeforeMutation => {
    const provisioned = [];
    for (const participant of config.participants) {
      const configured = await kit(participant.character, { health: cli.fixtureHealth }, dmOpts);
      if (!configured.ok || configured.rejected?.length)
        throw new Error(`could not provision ${participant.character}: ${JSON.stringify(configured)}`);
      const refreshed = await refresh(participant, `provision ${participant.agent}`);
      provisioned.push({ ...participant, configured, refreshed });
    }
    return {
      at: new Date().toISOString(),
      health: cli.fixtureHealth,
      identity_before_mutation: identityBeforeMutation,
      participants: provisioned,
    };
  };

  const place = async (participant, room, stage, label) => {
    await rpc(config.broker.port, 'cancel_movement', { agent: participant.agent }, 30_000);
    const moved = await relocate([participant.character], room,
      { row: stage.row, col: stage.col, verify: true }, dmOpts);
    if (!moved.ok || moved.rejected?.length ||
        moved.moved?.[participant.character] !== 'in the room')
      throw new Error(`${label}: administrative placement failed: ${JSON.stringify(moved)}`);
    if (!positionAt(moved.square, stage))
      throw new Error(`${label}: DM helper displaced requested square ${stage.row},${stage.col} ` +
        `to ${moved.square?.row ?? '?'},${moved.square?.col ?? '?'}`);
    const refreshed = await refresh(participant, label);
    // UtilGoNearSquare always returns success and may choose another standable square. The
    // DM helper proves the room; only the broker's pushed position proves the exact square.
    const status = await waitForFixture(participant, room, stage, label);
    return { ...participant, room, asked_square: stage, moved, refreshed, status };
  };

  const snapshotAll = async label => {
    const rows = await Promise.all(agents.map(agent => statusOf(agent)));
    const deaths = rows.filter(dead);
    if (deaths.length) throw new Error(`${label}: dead fixture(s): ${JSON.stringify(deaths)}`);
    return rows;
  };

  const execute = async assigned => {
    const started = Date.now();
    let result = null;
    let rejected = null;
    // NO ERRANDS ON A PROOF LEG. `travel` runs the outstanding errands by default — a
    // character sent across the world banks and stocks up before it goes — and a fixture
    // that detours to a vendor puts squares on the wire that are not the route under proof,
    // and can spend the whole leg deadline in a shop. Every leg here asks for the walk only.
    try {
      result = await runLeg(assigned.agent, assigned.to,
        { maxMs: cli.maxLegMs, runErrands: false });
    } catch (error) { rejected = error?.message ?? String(error); }
    const finished = Date.now();
    return {
      ...assigned,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      elapsed_ms: finished - started,
      arrived: result?.arrived === true,
      deaths: Number(result?.deaths ?? 0),
      swings: Number(result?.swings ?? 0),
      result,
      ...(rejected ? { rejected } : {}),
    };
  };

  const runBatch = async scheduled => {
    const started = Date.now();
    const identityBeforeMutation = await proveAdminIdentity(
      `before batch ${scheduled.index} mutation`);
    const staged = [];
    for (const assigned of scheduled.assignments) {
      const participant = { agent: assigned.agent, character: assigned.character };
      const city = cityByRoom.get(assigned.from);
      staged.push(await place(participant, city.room, city.stage,
        `batch ${scheduled.index} ${assigned.agent} ${assigned.from_name}->${assigned.to_name}`));
    }
    const parked = [];
    for (const participant of scheduled.idle) {
      parked.push(await place(participant, PARKING.room, PARKING.stage,
        `batch ${scheduled.index} idle ${participant.agent}`));
    }
    const healthBefore = await readHealth(`before batch ${scheduled.index}`);
    // FINAL READ, AFTER EVERY SEQUENTIAL DM RELOCATION. Earlier participants can have been
    // waiting for several maintenance round trips by now; a keeper, delayed command or live
    // mutation could move one after its individual placement check. No await is allowed
    // between this all-six exact-square assertion and launching the legs below.
    const statusBefore = await snapshotAll(`before batch ${scheduled.index}`);
    assertBatchStaging(statusBefore, scheduled, { fixtureHealth: cli.fixtureHealth });
    const results = await Promise.all(scheduled.assignments.map(execute));
    const healthAfter = await readHealth(`after batch ${scheduled.index}`);
    const statusAfter = await snapshotAll(`after batch ${scheduled.index}`);
    const finished = Date.now();
    return {
      index: scheduled.index,
      kind: scheduled.kind,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      elapsed_ms: finished - started,
      identity_before_mutation: identityBeforeMutation,
      staged,
      parked,
      status_before: statusBefore,
      health_before: healthBefore,
      results,
      health_after: healthAfter,
      status_after: statusAfter,
      arrived: results.filter(row => row.arrived).length,
      attempts: results.length,
      deaths: results.reduce((sum, row) => sum + row.deaths, 0),
    };
  };

  report.fixture_setups ??= [];
  const provisioningIdentity = await proveAdminIdentity('before fixture provisioning');
  report.fixture_setups.push(await provisionFixtures(provisioningIdentity));
  checkpoint(cli.output, report);

  for (let index = report.batches.length; index < schedule.length; index++) {
    const scheduled = schedule[index];
    console.log(`[batch ${scheduled.index}/${schedule.length}] ${scheduled.kind}: ` +
      scheduled.assignments.map(row => `${row.agent}:${row.from_name}->${row.to_name}`).join(', '));
    const completed = await runBatch(scheduled);
    try {
      assertCompletedBatch(completed, scheduled, config,
        { harnessRoot: HARNESS_ROOT, stateFile: expectedStateFile(config),
          fixtureHealth: cli.fixtureHealth });
    } catch (error) {
      report.failed_batch = completed;
      throw error;
    }
    report.batches.push(completed);
    checkpoint(cli.output, report);
    console.log(`  ${completed.arrived}/${completed.attempts} arrived, ` +
      `${completed.deaths} deaths in ${Math.round(completed.elapsed_ms / 1_000)}s`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) { process.stdout.write(usage()); return 0; }
  if (cli.example) { process.stdout.write(JSON.stringify(exampleConfig(), null, 2) + '\n'); return 0; }
  if (!existsSync(cli.configPath)) throw new Error(`config file not found: ${cli.configPath}`);
  if (existsSync(cli.output) && !cli.resume && !cli.overwrite)
    throw new Error(`output already exists: ${cli.output}; use --resume or --overwrite`);
  if (cli.resume && !existsSync(cli.output))
    throw new Error(`cannot resume missing checkpoint: ${cli.output}`);
  const traceFile = expectedCollisionTraceFile();
  if (!cli.resume)
    assertTraceLifecycle({ resume: false, traceExists: existsSync(traceFile) });

  let raw;
  try { raw = JSON.parse(readFileSync(cli.configPath, 'utf8')); }
  catch (error) { throw new Error(`could not read config JSON: ${error.message}`); }
  const config = validateConfig(raw);
  const schedule = buildSchedule(config.participants, cli.mode);
  const stateFile = expectedStateFile(config);

  // ONE THING DRIVING THIS FLEET AT A TIME. The same claim `m59-solo-run.mjs` makes, for
  // the same reason: a TaskStop'd shell, a broken pipe, a Ctrl-C through a wrapper — every
  // one of them can kill the SHELL and leave this node process issuing DM relocations and
  // travels for an hour, and a second run on the same six bodies reports every collision as
  // "movement cancelled by a newer command", the sentence a genuine survival interrupt
  // produces. Taken before the first thing this run writes and released on every way out;
  // a lock whose owner cannot be corroborated is stale and is taken over rather than
  // refused for ever.
  const claim = takeRunLock(config.fleet, { label: 'city-matrix' });
  if (!claim.ok) {
    const h = claim.holder ?? {};
    console.error(`city-matrix: REFUSING — fleet "${config.fleet}" is already being driven.`);
    console.error(`             pid ${h.pid}, "${h.label ?? '?'}", since ` +
                  `${h.at ? new Date(h.at).toISOString() : '?'}`);
    console.error(`             ${h.argv ?? ''}`);
    console.error('             Two runs on one fleet fight for the same bodies and both report');
    console.error('             "movement cancelled by a newer command". Stop that one first:');
    console.error(`               node tools/m59-solo-run.mjs --stop --fleet ${config.fleet}`);
    return 3;
  }
  if (claim.tookOverFrom)
    console.log(`(took over a stale lock: ${claim.tookOverFrom.why})`);
  try { return await drive(cli, config, schedule, stateFile, traceFile); }
  finally { claim.release(); }
}

// Everything past the lock. Split out so the claim above wraps the whole of it in one
// `try/finally` rather than a release on each of several returns and throws.
async function drive(cli, config, schedule, stateFile, traceFile) {
  // Pin every imported helper against stale M59_* values in the launching shell.
  Object.assign(process.env, {
    M59_FLEET: config.fleet,
    M59_STATE_FILE: stateFile,
    M59_BROKER_PORT: String(config.broker.port),
    M59_HOST: config.game.host,
    M59_PORT: String(config.game.port),
    M59_ADMIN_HOST: config.admin.host,
    M59_ADMIN_PORT: String(config.admin.port),
    M59_EXIT_FALLBACK: '0',
  });

  const readHealth = async label => {
    const sample = observed(await getJsonLoopback(config.broker.port));
    return assertHealthSnapshot(sample, config,
      { label, harnessRoot: HARNESS_ROOT, stateFile });
  };
  const startHealth = await readHealth(cli.resume ? 'resume start' : 'start');
  const runConfig = buildRunConfig(config, cli, startHealth);

  let report;
  if (cli.resume) {
    try { report = JSON.parse(readFileSync(cli.output, 'utf8')); }
    catch (error) { throw new Error(`could not read checkpoint JSON: ${error.message}`); }
    assertTraceLifecycle({ resume: true, traceExists: existsSync(traceFile),
      completedBatches: Array.isArray(report?.batches) ? report.batches.length : 0 });
    validateCheckpoint(report, runConfig, schedule, { harnessRoot: HARNESS_ROOT, stateFile });
    report.resume_health ??= [];
    report.resume_health.push(startHealth);
    report.verdict = 'running';
    delete report.finished_at;
  } else {
    report = {
      schema: SCHEMA,
      started_at: new Date().toISOString(),
      verdict: 'running',
      run_config: runConfig,
      config_fingerprint: fingerprint(runConfig),
      schedule_fingerprint: fingerprint(schedule),
      cities: CITIES,
      parking: PARKING,
      expected_unreachable: MAINLAND.map(to => ({
        from: KOCATAN.room,
        from_name: KOCATAN.name,
        to: to.room,
        to_name: to.name,
        reason: 'stock room-2505 collision makes Ko\'catan outbound physically unwalkable',
      })),
      schedule,
      health_start: startHealth,
      resume_health: [],
      fixture_setups: [],
      batches: [],
    };
  }
  checkpoint(cli.output, report);

  const [circuit, patrol, dm] = await Promise.all([
    import(new URL('./m59-circuit.mjs', import.meta.url)),
    import(new URL('./m59-patrol.mjs', import.meta.url)),
    import(new URL('./m59-dm.mjs', import.meta.url)),
  ]);

  try {
    await runLive(cli, config, schedule, report, {
      runLeg: circuit.runLeg,
      rpc: patrol.rpc,
      heal: dm.heal,
      kit: dm.kit,
      relocate: dm.relocate,
      resolveCharacters: dm.resolve,
    }, readHealth);
    report.health_end = await readHealth('end');
    report.finished_at = new Date().toISOString();
    report.verdict = 'pass';
    checkpoint(cli.output, report);
    const legs = report.batches.reduce((sum, batch) => sum + batch.results.length, 0);
    console.log(`PASS: 25/25 reachable directed pairs, ${legs}/${legs} participant arrivals, ` +
      '0 deaths, exit fallback disabled');
    return 0;
  } catch (error) {
    report.finished_at = new Date().toISOString();
    report.verdict = 'fail';
    report.failure = { message: error?.message ?? String(error), stack: error?.stack ?? null };
    report.failed_at = schedule[report.batches.length]?.index ?? null;
    checkpoint(cli.output, report);
    throw error;
  }
}

const isMain = !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`FAIL: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
