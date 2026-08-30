#!/usr/bin/env node
// THE CITY MATRIX'S SAFETY AND COVERAGE CONTRACT, WITHOUT A SOCKET OR A ROSTER.
//
//   node tools/m59-city-matrix-test.mjs
//
// Importing the runner is itself part of the test: its live main is entry-point guarded,
// so this file can exercise config, scheduling and checkpoint validation without importing
// the broker, opening HTTP, or touching a participant.

import { readFileSync } from 'node:fs';
import {
  CITIES,
  DEFAULT_OUTPUT,
  HARNESS_ROOT,
  PARKING,
  SCHEMA,
  assertBatchStaging,
  assertDmResolution,
  assertHealthSnapshot,
  assertIdentityProof,
  assertTraceLifecycle,
  buildRunConfig,
  buildSchedule,
  exampleConfig,
  expectedCollisionTraceFile,
  expectedReachablePairKeys,
  expectedStateFile,
  fingerprint,
  pairKey,
  parseCli,
  positionAt,
  reachablePairs,
  resolveHarnessPath,
  validateCheckpoint,
  validateConfig,
} from './m59-city-matrix.mjs';
// Entry-point guarded like the runner, so importing it runs nothing and opens no socket.
import { travelArgs } from './m59-circuit.mjs';

const BROKER_SOURCE = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const CITY_SOURCE = readFileSync(new URL('./m59-city-matrix.mjs', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
};
const throws = (name, fn, pattern = null) => {
  let message = null;
  try { fn(); }
  catch (error) { message = error?.message ?? String(error); }
  ok(name, message !== null && (!pattern || pattern.test(message)), JSON.stringify(message));
};
const clone = value => JSON.parse(JSON.stringify(value));

const rawConfig = exampleConfig();
const config = validateConfig(rawConfig);
const stateFile = expectedStateFile(config);

function health(overrides = {}) {
  const base = {
    ok: true,
    root: HARNESS_ROOT,
    fleet: config.fleet,
    state: stateFile,
    sessions: config.participants.map(row => row.agent),
    session_driver: 'in-process',
    session_characters: Object.fromEntries(config.participants.map(row =>
      [row.agent, row.character])),
    session_object_ids: Object.fromEntries(config.participants.map((row, index) =>
      [row.agent, 7_001 + index])),
    game_server: config.game,
    session_game_servers: Object.fromEntries(config.participants.map(row =>
      [row.agent, config.game])),
    geometry_drift: [],
    movement_policy: { exit_fallback_enabled: false },
    collision_trace: { enabled: true, file: expectedCollisionTraceFile() },
    observed_at: '2026-08-25T12:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function dmObjectIds(sample = health()) {
  return Object.fromEntries(config.participants.map(row =>
    [row.character, sample.session_object_ids[row.agent]]));
}

function identityProof(sample = health()) {
  return {
    observed_at: '2026-08-25T12:00:00.000Z',
    health: clone(sample),
    dm_object_ids: dmObjectIds(sample),
  };
}

function stagedStatuses(scheduled, fixtureHealth = 10_000) {
  const rows = [];
  for (const assigned of scheduled.assignments) {
    const city = CITIES.find(row => row.room === assigned.from);
    rows.push({ agent: assigned.agent, room: city.room, position: clone(city.stage),
      busy: false, health: fixtureHealth, max_health: fixtureHealth });
  }
  for (const participant of scheduled.idle)
    rows.push({ agent: participant.agent, room: PARKING.room, position: clone(PARKING.stage),
      busy: false, health: fixtureHealth, max_health: fixtureHealth });
  return rows;
}

function cleanBatch(scheduled, sample = health(), offset = 0) {
  const start = Date.parse('2026-08-25T12:01:00.000Z') + offset * 60_000;
  const finish = start + 20_000;
  const results = scheduled.assignments.map((assigned, index) => ({
    ...assigned,
    started_at: new Date(start + 1_000 + index).toISOString(),
    finished_at: new Date(start + 10_000 + index).toISOString(),
    elapsed_ms: 9_000,
    arrived: true,
    deaths: 0,
    swings: 0,
    result: {
      agent: assigned.agent,
      from: assigned.from,
      to: assigned.to,
      arrived: true,
      deaths: 0,
      rooms: [assigned.from, assigned.to],
    },
  }));
  return {
    index: scheduled.index,
    kind: scheduled.kind,
    started_at: new Date(start).toISOString(),
    finished_at: new Date(finish).toISOString(),
    elapsed_ms: finish - start,
    identity_before_mutation: identityProof(sample),
    status_before: stagedStatuses(scheduled),
    health_before: clone(sample),
    health_after: clone(sample),
    results,
    attempts: results.length,
    arrived: results.length,
    deaths: 0,
  };
}

function checkpointFor(runConfig, schedule, completed = 0) {
  return {
    schema: SCHEMA,
    started_at: '2026-08-25T12:00:00.000Z',
    verdict: 'running',
    run_config: clone(runConfig),
    config_fingerprint: fingerprint(runConfig),
    schedule_fingerprint: fingerprint(schedule),
    schedule: clone(schedule),
    health_start: health(),
    resume_health: [],
    fixture_setups: completed ? [{ identity_before_mutation: identityProof() }] : [],
    batches: schedule.slice(0, completed).map((batch, index) => cleanBatch(batch, health(), index)),
  };
}

console.log('');
console.log('the config is explicit, portable and incapable of naming a remote authority');
{
  ok('the credential-free example validates', config.participants.length === 6);
  ok('validation copies rather than reuses participant rows',
    config.participants[0] !== rawConfig.participants[0]);
  ok('the default output is under ignored substrate/traces',
    DEFAULT_OUTPUT.replaceAll('\\', '/').endsWith('/substrate/traces/m59-city-matrix.json'),
    DEFAULT_OUTPUT);
  for (const key of ['broker', 'game', 'admin']) {
    const remote = clone(rawConfig);
    remote[key].host = 'example.com';
    throws(`${key} refuses a remote host`, () => validateConfig(remote), /127\.0\.0\.1/);
    const wildcard = clone(rawConfig);
    wildcard[key].host = '0.0.0.0';
    throws(`${key} refuses a wildcard host`, () => validateConfig(wildcard), /127\.0\.0\.1/);
  }
  const short = clone(rawConfig);
  short.participants.pop();
  throws('five participants are refused', () => validateConfig(short), /exactly six/);
  const duplicateAgent = clone(rawConfig);
  duplicateAgent.participants[5].agent = duplicateAgent.participants[0].agent;
  throws('duplicate agent handles are refused', () => validateConfig(duplicateAgent), /duplicate agent/);
  const duplicateCharacter = clone(rawConfig);
  duplicateCharacter.participants[5].character =
    duplicateCharacter.participants[0].character.toUpperCase();
  throws('duplicate character names are refused case-insensitively',
    () => validateConfig(duplicateCharacter), /duplicate character/);
  const injected = clone(rawConfig);
  injected.participants[0].character = 'Tester\nshow status';
  throws('maintenance-command characters are refused', () => validateConfig(injected), /alphabetic/);
  const unnamed = clone(rawConfig);
  unnamed.fleet = 'default';
  throws('the ambiguous default fleet is refused', () => validateConfig(unnamed), /not "default"/);
  const collided = clone(rawConfig);
  collided.admin.port = collided.game.port;
  throws('endpoint ports must be distinct', () => validateConfig(collided), /must be distinct/);
  const extra = clone(rawConfig);
  extra.password = 'must never belong here';
  throws('unknown config fields are refused rather than ignored',
    () => validateConfig(extra), /unknown field/);
}

console.log('');
console.log('the reachable set is exactly 25 physical directions');
{
  const pairs = reachablePairs();
  const actual = new Set(pairs.map(pairKey));
  const expected = expectedReachablePairKeys();
  ok('there are 25 pair rows', pairs.length === 25, String(pairs.length));
  ok('all 25 pair rows are unique', actual.size === 25, String(actual.size));
  ok('the independent expected set also has 25 keys', expected.size === 25, String(expected.size));
  ok('the schedule covers every expected key', [...expected].every(key => actual.has(key)));
  ok('there are no self-pairs', pairs.every(pair => pair.from !== pair.to));
  ok('Ko\'catan has no outbound pair', pairs.every(pair => pair.from !== 2001));
  ok('all five mainland cities have an inbound Ko\'catan leg',
    pairs.filter(pair => pair.to === 2001).length === 5);
  ok('the city catalogue still has five mainland cities plus Ko\'catan', CITIES.length === 6);
}

console.log('');
console.log('parallel mode covers 25 pairs once and spreads them fairly');
const parallel = buildSchedule(config.participants, 'parallel');
{
  const flat = parallel.flatMap(batch => batch.assignments);
  const loads = config.participants.map(participant =>
    flat.filter(row => row.agent === participant.agent).length);
  ok('parallel has five batches', parallel.length === 5, String(parallel.length));
  ok('parallel has 25 total assignments', flat.length === 25, String(flat.length));
  ok('each parallel batch assigns five distinct participants', parallel.every(batch =>
    batch.assignments.length === 5 && new Set(batch.assignments.map(row => row.agent)).size === 5));
  ok('each parallel batch parks exactly one participant',
    parallel.every(batch => batch.idle.length === 1));
  ok('the four mainland batches have five distinct sources and destinations',
    parallel.slice(0, 4).every(batch =>
      new Set(batch.assignments.map(row => row.from)).size === 5 &&
      new Set(batch.assignments.map(row => row.to)).size === 5));
  ok('the Ko\'catan batch has five sources converging on one destination',
    new Set(parallel[4].assignments.map(row => row.from)).size === 5 &&
    new Set(parallel[4].assignments.map(row => row.to)).size === 1);
  ok('parallel uses all six participants', loads.every(load => load > 0), JSON.stringify(loads));
  ok('parallel load differs by at most one', Math.max(...loads) - Math.min(...loads) <= 1,
    JSON.stringify(loads));
  ok('parallel pair coverage is unique', new Set(flat.map(pairKey)).size === 25);
}

console.log('');
console.log('serial mode preserves the stronger all-participants sweep');
const serial = buildSchedule(config.participants, 'serial');
{
  const flat = serial.flatMap(batch => batch.assignments);
  const loads = config.participants.map(participant =>
    flat.filter(row => row.agent === participant.agent).length);
  ok('serial has one batch for each of 25 pairs', serial.length === 25, String(serial.length));
  ok('serial has 150 participant legs', flat.length === 150, String(flat.length));
  ok('each serial batch assigns all six participants',
    serial.every(batch => batch.assignments.length === 6 && batch.idle.length === 0));
  ok('each serial batch contains only one directed pair',
    serial.every(batch => new Set(batch.assignments.map(pairKey)).size === 1));
  ok('every participant traverses all 25 pairs', loads.every(load => load === 25),
    JSON.stringify(loads));
  ok('serial still has exactly 25 distinct pair keys', new Set(flat.map(pairKey)).size === 25);
}

console.log('');
console.log('all six exact squares are reasserted only after sequential staging is complete');
{
  const staged = stagedStatuses(parallel[0]);
  ok('five city starts and the idle parking square pass together',
    assertBatchStaging(staged, parallel[0], { fixtureHealth: 10_000 }) === staged);
  const displaced = clone(staged);
  displaced[0].position.col += 1;
  throws('one assigned participant displaced after its own relocation aborts the batch',
    () => assertBatchStaging(displaced, parallel[0], { fixtureHealth: 10_000 }),
    /left exact staging square/);
  const idleAgent = parallel[0].idle[0].agent;
  const idleDisplaced = clone(staged);
  idleDisplaced.find(row => row.agent === idleAgent).position.row += 1;
  throws('the parked sixth participant is reasserted too',
    () => assertBatchStaging(idleDisplaced, parallel[0], { fixtureHealth: 10_000 }),
    /left exact staging square/);
  const boundaryStart = CITY_SOURCE.indexOf('assertBatchStaging(statusBefore, scheduled');
  const launchStart = CITY_SOURCE.indexOf('const results = await Promise.all', boundaryStart);
  const betweenAssertionAndLaunch = CITY_SOURCE.slice(boundaryStart, launchStart)
    .replace(/\/\/.*$/gm, '');
  ok('the final all-six assertion has no await before launching the batch',
    boundaryStart >= 0 && launchStart > boundaryStart &&
      !/\bawait\b/.test(betweenAssertionAndLaunch), betweenAssertionAndLaunch);
}

console.log('');
console.log('CLI modes and the config example do not need repository-local names');
{
  const parsed = parseCli(['--config', 'fixture.json']);
  ok('parallel is the default mode', parsed.mode === 'parallel');
  ok('relative config paths resolve from the harness, not the caller CWD',
    parsed.configPath === resolveHarnessPath('fixture.json'), parsed.configPath);
  const customOutput = parseCli(['--config', 'fixture.json', '--output',
    'substrate/traces/custom-city-matrix.json']);
  ok('relative output paths resolve from the harness too',
    customOutput.output === resolveHarnessPath('substrate/traces/custom-city-matrix.json'),
    customOutput.output);
  throws('output outside ignored substrate/traces is refused', () => parseCli([
    '--config', 'fixture.json', '--output', 'city-matrix-outside.json',
  ]), /descendant.*substrate\/traces/);
  throws('a non-JSON file under traces is still refused', () => parseCli([
    '--config', 'fixture.json', '--output', 'substrate/traces/city-matrix.txt',
  ]), /\.json/);
  throws('--overwrite can never target the loaded config roster', () => parseCli([
    '--config', 'substrate/traces/city-matrix-config.json',
    '--output', 'substrate/traces/city-matrix-config.json', '--overwrite',
  ]), /must not be the config file/);
  ok('a fresh run is allowed only when the trace path is absent',
    assertTraceLifecycle({ resume: false, traceExists: false }));
  throws('fresh and --overwrite runs refuse a pre-existing capture',
    () => assertTraceLifecycle({ resume: false, traceExists: true }),
    /trace already exists.*sequence 1/);
  ok('resume preserves an existing capture', assertTraceLifecycle({
    resume: true, traceExists: true, completedBatches: 2,
  }));
  ok('an empty checkpoint may resume before its first trace row exists', assertTraceLifecycle({
    resume: true, traceExists: false, completedBatches: 0,
  }));
  throws('completed batches cannot resume after their trace was removed',
    () => assertTraceLifecycle({ resume: true, traceExists: false, completedBatches: 1 }),
    /without the existing collision trace/);
  ok('the default fixture health is 10000', parsed.fixtureHealth === 10_000);
  ok('the default leg deadline is 1800 seconds', parsed.maxLegMs === 1_800_000);
  ok('--example needs no config path', parseCli(['--example']).example === true);
  throws('--example refuses mixed live arguments',
    () => parseCli(['--example', '--config', 'fixture.json']), /does not take other/);
  throws('resume and overwrite are mutually exclusive', () => parseCli([
    '--config', 'fixture.json', '--resume', '--overwrite',
  ]), /mutually exclusive/);
  throws('unknown modes are refused',
    () => parseCli(['--config', 'fixture.json', '--mode', 'fast']), /parallel or serial/);
  throws('unknown flags are refused',
    () => parseCli(['--config', 'fixture.json', '--trust-me']), /unknown argument/);
  ok('exact DM staging accepts the requested row and column',
    positionAt({ row: 5, col: 6 }, { row: 5, col: 6 }));
  ok('DM displacement by one square is not accepted as staging',
    !positionAt({ row: 5, col: 7 }, { row: 5, col: 6 }));
}

console.log('');
console.log('health and read-only DM resolution prove the exact in-process lab authority');
const startHealth = health();
const runConfig = buildRunConfig(config,
  { mode: 'parallel', fixtureHealth: 10_000, maxLegMs: 1_800_000 }, startHealth);
{
  ok('a complete local health sample validates',
    assertHealthSnapshot(startHealth, config) === startHealth);
  const identityStart = BROKER_SOURCE.indexOf('function liveSessionIdentity');
  const identityEnd = BROKER_SOURCE.indexOf('\nfunction brokerHealth', identityStart);
  const identityCode = BROKER_SOURCE.slice(identityStart, identityEnd)
    .replace(/\/\/.*$/gm, '');
  ok('broker identity maps iterate only the published live-readiness session list',
    /for \(const agent of readiness\.sessions\)/.test(identityCode));
  ok('broker identity comes from live client character and object fields, not credentials',
    /client\?\.me\?\.name/.test(identityCode) && /client\?\.selfId/.test(identityCode) &&
      !/credentials|password|fleetState/.test(identityCode), identityCode);
  const brokerHealthStart = BROKER_SOURCE.indexOf('function brokerHealth');
  const brokerHealthEnd = BROKER_SOURCE.indexOf('\nfunction brokerLoopbackRequest', brokerHealthStart);
  const brokerHealthCode = BROKER_SOURCE.slice(brokerHealthStart, brokerHealthEnd);
  ok('broker health publishes commanded driver, live identity, and immutable trace config',
    /session_driver:\s*SESSION_DRIVER/.test(brokerHealthCode) &&
      /liveSessionIdentity\(readiness\)/.test(brokerHealthCode) &&
      /collision_trace:\s*\{[\s\S]{0,160}?enabled:\s*COLLISION_TRACE[\s\S]{0,160}?file:\s*COLLISION_TRACE_FILE/.test(
        brokerHealthCode));
  ok('serving health does not inspect the collision trace file',
    !/readFile|existsSync|statSync/.test(brokerHealthCode));
  ok('run_config records health-reported fallback=false', runConfig.exit_fallback_enabled === false);
  ok('run_config records the commanded in-process session driver',
    runConfig.session_driver === 'in-process');
  ok('run_config persists the broker-reported enabled default trace path',
    runConfig.collision_trace?.enabled === true &&
      runConfig.collision_trace?.file === expectedCollisionTraceFile());
  throws('a broker with tracing disabled is refused before fixture mutation',
    () => assertHealthSnapshot(health({ collision_trace: {
      enabled: false, file: expectedCollisionTraceFile(),
    } }), config), /collision_trace\.enabled=true/);
  throws('a broker tracing to another file is refused before fixture mutation',
    () => assertHealthSnapshot(health({ collision_trace: {
      enabled: true, file: expectedCollisionTraceFile() + '.other',
    } }), config), /exact default checkout path/);
  throws('run_config construction independently rejects another trace path', () =>
    buildRunConfig(config,
      { mode: 'parallel', fixtureHealth: 10_000, maxLegMs: 1_800_000 },
      health({ collision_trace: {
        enabled: true, file: expectedCollisionTraceFile() + '.other',
      } })), /default checkout collision trace path/);
  throws('keeper-process mode is refused before fixture mutation', () => assertHealthSnapshot(
    health({ session_driver: 'keeper-process' }), config), /session_driver="in-process"/);
  const missingCharacterKey = clone(startHealth.session_characters);
  delete missingCharacterKey[config.participants[0].agent];
  throws('session_characters must expose exactly six agent keys', () => assertHealthSnapshot(
    health({ session_characters: missingCharacterKey }), config), /exactly the six configured/);
  const wrongCharacter = clone(startHealth.session_characters);
  wrongCharacter[config.participants[0].agent] = config.participants[1].character;
  throws('a broker agent attached to another character is refused', () => assertHealthSnapshot(
    health({ session_characters: wrongCharacter }), config), /mapping differs/);
  const caseOnlyCharacters = clone(startHealth.session_characters);
  caseOnlyCharacters[config.participants[0].agent] =
    caseOnlyCharacters[config.participants[0].agent].toUpperCase();
  ok('character mapping comparison is case-insensitive', assertHealthSnapshot(
    health({ session_characters: caseOnlyCharacters }), config).session_characters ===
      caseOnlyCharacters);
  const duplicateObjectIds = clone(startHealth.session_object_ids);
  duplicateObjectIds[config.participants[5].agent] =
    duplicateObjectIds[config.participants[0].agent];
  throws('live object IDs must be distinct positive safe integers', () => assertHealthSnapshot(
    health({ session_object_ids: duplicateObjectIds }), config), /distinct positive safe integers/);
  const resolved = dmObjectIds(startHealth);
  const matched = assertDmResolution(resolved, startHealth, config);
  ok('all six DM IDs match the broker live-session IDs',
    Object.keys(matched).length === 6 && Object.values(matched).every(row =>
      row.broker_object_id === row.dm_object_id), JSON.stringify(matched));
  const wrongDm = clone(resolved);
  wrongDm[config.participants[0].character] += 100;
  throws('a maintenance socket resolving a different live object is refused', () =>
    assertDmResolution(wrongDm, startHealth, config), /do not match broker live sessions/);
  const missingDm = clone(resolved);
  delete missingDm[config.participants[0].character];
  throws('DM resolution must contain exactly all six configured names', () =>
    assertDmResolution(missingDm, startHealth, config), /exactly the six configured/);
  ok('the persisted identity proof validates offline without a socket',
    Object.keys(assertIdentityProof(identityProof(startHealth), config)).length === 6);
  const fallbackOn = health({ movement_policy: { exit_fallback_enabled: true } });
  throws('fallback=true is refused', () => assertHealthSnapshot(fallbackOn, config),
    /exit_fallback_enabled=false/);
  const fallbackMissing = health({ movement_policy: {} });
  throws('a missing fallback field is not treated as false',
    () => assertHealthSnapshot(fallbackMissing, config), /exit_fallback_enabled=false/);
  const wrongRoot = health({ root: HARNESS_ROOT + '-other' });
  throws('another harness checkout is refused', () => assertHealthSnapshot(wrongRoot, config),
    /not this harness checkout/);
  const wrongState = health({ state: stateFile + '.other' });
  throws('another roster is refused even under the same fleet label',
    () => assertHealthSnapshot(wrongState, config), /configured fleet roster/);
  const missing = health({ sessions: startHealth.sessions.slice(1) });
  throws('a missing fixture session is refused', () => assertHealthSnapshot(missing, config),
    /sessions differ/);
  const unexpected = health({ sessions: [...startHealth.sessions, 'somebody-else'] });
  throws('an unexpected broker session is refused',
    () => assertHealthSnapshot(unexpected, config), /sessions differ/);
  const wrongServerMap = clone(startHealth.session_game_servers);
  wrongServerMap[config.participants[0].agent] = { host: '127.0.0.1', port: 5959 };
  throws('a participant on another game port is refused', () => assertHealthSnapshot(
    health({ session_game_servers: wrongServerMap }), config), /wrong game server/);
  throws('geometry drift is refused', () => assertHealthSnapshot(
    health({ geometry_drift: [{ room: 52 }] }), config), /geometry drift/);
}

console.log('');
console.log('resume accepts only a clean, matching, contiguous passing prefix');
{
  const report = checkpointFor(runConfig, parallel, 2);
  const progress = validateCheckpoint(report, runConfig, parallel);
  ok('two clean batches resume at the third', progress.completed === 2 && progress.remaining === 3,
    JSON.stringify(progress));

  const serialRunConfig = buildRunConfig(config,
    { mode: 'serial', fixtureHealth: 10_000, maxLegMs: 1_800_000 }, startHealth);
  const serialReport = checkpointFor(serialRunConfig, serial, 1);
  ok('a six-result serial batch is a valid checkpoint prefix',
    validateCheckpoint(serialReport, serialRunConfig, serial).completed === 1);

  const wrongConfig = clone(report);
  wrongConfig.run_config.fixture_health = 9_999;
  throws('changed run configuration is refused',
    () => validateCheckpoint(wrongConfig, runConfig, parallel), /different run configuration/);

  const wrongSchedule = clone(report);
  [wrongSchedule.schedule[0], wrongSchedule.schedule[1]] =
    [wrongSchedule.schedule[1], wrongSchedule.schedule[0]];
  throws('changed schedule content is refused',
    () => validateCheckpoint(wrongSchedule, runConfig, parallel), /schedule differs/);

  const gap = clone(report);
  gap.batches[1].index = 3;
  throws('a non-contiguous completed prefix is refused',
    () => validateCheckpoint(gap, runConfig, parallel), /contiguous schedule prefix|scheduled batch/);

  const failedArrival = clone(report);
  failedArrival.batches[0].results[0].arrived = false;
  throws('a failed arrival is refused',
    () => validateCheckpoint(failedArrival, runConfig, parallel), /did not arrive alive/);

  const death = clone(report);
  death.batches[0].results[0].deaths = 1;
  throws('a death is refused', () => validateCheckpoint(death, runConfig, parallel),
    /did not arrive alive/);

  const wrongPair = clone(report);
  wrongPair.batches[0].results[0].from = 999;
  throws('a result that changes its assignment is refused',
    () => validateCheckpoint(wrongPair, runConfig, parallel), /wrong from/);

  const hiddenDeath = clone(report);
  hiddenDeath.batches[0].results[0].result.deaths = 1;
  throws('a nested leg death cannot be hidden by a clean summary',
    () => validateCheckpoint(hiddenDeath, runConfig, parallel), /contradicts its assignment/);

  const badInterval = clone(report);
  badInterval.batches[0].results[0].finished_at = '2026-08-25T11:00:00.000Z';
  throws('a backwards result interval is refused',
    () => validateCheckpoint(badInterval, runConfig, parallel), /invalid interval/);

  const unsafeBatch = clone(report);
  unsafeBatch.batches[1].health_after.movement_policy.exit_fallback_enabled = true;
  throws('fallback enabled in any completed batch is refused',
    () => validateCheckpoint(unsafeBatch, runConfig, parallel), /exit_fallback_enabled=false/);

  const untracedBatch = clone(report);
  untracedBatch.batches[1].health_after.collision_trace.enabled = false;
  throws('tracing disabled in any completed batch is refused',
    () => validateCheckpoint(untracedBatch, runConfig, parallel), /collision_trace\.enabled=true/);

  const wrongBatchAuthority = clone(report);
  wrongBatchAuthority.batches[0].identity_before_mutation.dm_object_ids[
    config.participants[0].character] += 100;
  throws('a completed batch cannot hide a broker/DM object-ID mismatch',
    () => validateCheckpoint(wrongBatchAuthority, runConfig, parallel),
    /do not match broker live sessions/);

  const noProvisioningProof = clone(report);
  noProvisioningProof.fixture_setups = [];
  throws('completed work requires a persisted pre-provisioning identity proof',
    () => validateCheckpoint(noProvisioningProof, runConfig, parallel),
    /pre-provisioning identity proof/);

  const keeperBatch = clone(report);
  keeperBatch.batches[0].identity_before_mutation.health.session_driver = 'keeper-process';
  throws('a prior batch driven outside the broker process is refused on resume',
    () => validateCheckpoint(keeperBatch, runConfig, parallel), /session_driver="in-process"/);

  const unsafeResume = clone(report);
  unsafeResume.resume_health.push(health({ movement_policy: { exit_fallback_enabled: true } }));
  throws('fallback enabled in a prior resume sample is refused',
    () => validateCheckpoint(unsafeResume, runConfig, parallel), /exit_fallback_enabled=false/);

  const failure = clone(report);
  failure.verdict = 'fail';
  failure.failure = { message: 'test' };
  throws('a failed checkpoint is refused',
    () => validateCheckpoint(failure, runConfig, parallel), /running or completed clean/);

  const incompletePass = clone(report);
  incompletePass.verdict = 'pass';
  throws('an incomplete pass is refused',
    () => validateCheckpoint(incompletePass, runConfig, parallel), /passing checkpoint is incomplete/);

  const completePass = checkpointFor(runConfig, parallel, parallel.length);
  completePass.verdict = 'pass';
  completePass.health_end = health();
  const complete = validateCheckpoint(completePass, runConfig, parallel);
  ok('a complete pass remains a valid no-work resume',
    complete.completed === 5 && complete.remaining === 0, JSON.stringify(complete));
}

console.log('');
console.log('');
console.log('the live run holds the fleet run lock, and every leg is the walk alone');
{
  // A TaskStop'd shell leaves the node driver issuing commands for an hour; a second run on
  // the same six bodies reports every collision as "movement cancelled by a newer command".
  // The lock is m59-solo-run.mjs's, taken the same way, before the first thing written.
  const CIRCUIT_SOURCE = readFileSync(new URL('./m59-circuit.mjs', import.meta.url), 'utf8');
  const mainAt = CITY_SOURCE.indexOf('export async function main(');
  const lockAt = CITY_SOURCE.indexOf("takeRunLock(config.fleet, { label: 'city-matrix' })", mainAt);
  const firstWrite = CITY_SOURCE.indexOf('checkpoint(cli.output, report)', mainAt);
  const liveStart = CITY_SOURCE.indexOf('await runLive(', mainAt);
  const firstHealth = CITY_SOURCE.indexOf('getJsonLoopback(config.broker.port)', mainAt);
  ok('the runner claims the fleet through m59-runlock.mjs',
    /import \{ takeRunLock \} from '\.\/m59-runlock\.mjs'/.test(CITY_SOURCE));
  ok('the lock is taken before the first checkpoint write',
    mainAt >= 0 && lockAt > mainAt && firstWrite > lockAt);
  ok('before the broker is asked anything', lockAt > 0 && firstHealth > lockAt);
  ok('and before any DM mutation', lockAt > 0 && liveStart > lockAt);
  const refusal = CITY_SOURCE.slice(lockAt, CITY_SOURCE.indexOf('return 3;', lockAt));
  ok("a held lock is refused naming the holder's pid, label and argv, and how to stop it",
    /h\.pid/.test(refusal) && /h\.label/.test(refusal) && /h\.argv/.test(refusal) &&
      /m59-solo-run\.mjs --stop --fleet/.test(refusal), refusal);
  ok('a refused claim runs nothing and writes nothing',
    refusal.length > 0 && !/runLive|checkpoint\(|getJsonLoopback|drive\(/.test(refusal));
  ok('the claim is released on every way out of the run',
    /try \{ return await drive\([^)]*\); \}\s*finally \{ claim\.release\(\); \}/.test(CITY_SOURCE));
  ok('every leg asks for the walk only, never the errands',
    /runLeg\(assigned\.agent, assigned\.to,\s*\{ maxMs: cli\.maxLegMs, runErrands: false \}\)/
      .test(CITY_SOURCE));

  // The circuit side: silence is the broker's default and every other caller keeps it.
  ok('runLeg leaves run_errands unset unless a caller decides',
    JSON.stringify(travelArgs('lab1', 106)) ===
      JSON.stringify({ agent: 'lab1', to: 106, background: true, max_hops: 30 }));
  ok('undefined is silence too',
    !('run_errands' in travelArgs('lab1', 106, { runErrands: undefined })));
  ok('a proof leg sends run_errands: false',
    travelArgs('lab1', 106, { runErrands: false }).run_errands === false);
  ok('and only a literal true sends true',
    travelArgs('lab1', 106, { runErrands: true }).run_errands === true &&
      travelArgs('lab1', 106, { runErrands: 'yes' }).run_errands === false);
  ok('runLeg puts exactly those arguments on the wire',
    /broker\('travel', travelArgs\(agent, to, \{ runErrands \}\)/.test(CIRCUIT_SOURCE));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
