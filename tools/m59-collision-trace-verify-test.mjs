#!/usr/bin/env node
// OFFLINE CONTRACT TEST FOR THE WIRE-TRACE VERIFIER.
//
// No socket, broker, roster, or real map. Synthetic rows pin the proof boundaries: exact
// BSP replay, an authorized off-map edge, stable room identity across object-id renumbering,
// transition recognition despite object-id reuse, matrix/callsite coverage, JSONL loss, and
// broker-observed fallback policy. A CLI assertion must never substitute for the last one.

import {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MATRIX_FILE, DEFAULT_OUTPUT_FILE, DEFAULT_TRACE_FILE,
  REPO_ROOT, fallbackPolicyProof, normalizeMatrix, parseCli, parseTraceJsonl,
  sameStableRoom, stableRoomIdentity, verifyCollisionTrace, verdictOutputPath,
  writeVerdictAtomic,
} from './m59-collision-trace-verify.mjs';
import { buildSchedule } from './m59-city-matrix.mjs';

let passed = 0, failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const kinds = summary => summary.errors.map(error => error.kind);
const clone = value => structuredClone(value);

const health = policy => ({ ok: true, geometry_drift: [], session_driver: 'in-process',
  ...(policy === undefined ? {} : {
    movement_policy: { exit_fallback_enabled: policy },
  }) });

const room1 = { num: 1, security: 11, roo: { rows: 2, cols: 2 } };
const room2 = { num: 2, security: 22, roo: { rows: 2, cols: 2 } };
const map = { geometryManifestSha256: 'fixture-manifest',
  rooms: { 1: room1, 2: room2 } };

const wireRoom = (num, id, security) => ({
  num, id, live_security: security, baked_security: security,
});
const normalMove = ({ at, room, from, to }) => ({
  schema: 'm59-wire-move/1', kind: 'wire_move', agent: 'fixture-agent', sent: true,
  room, from: { ...from }, requested: { ...to }, to: { ...to }, speed: 36,
  mode: { slide: false, fall: false, off_map: false },
  trace_options: { obstacles: [], roomFlags: 0, overrideDepths: null, motionZ: null },
  validation: { available: true, moved: true, arrived: true, blocked: false,
    slid: false, reason: null },
  at,
});
const offMapMove = ({ at, room, from, to }) => ({
  schema: 'm59-wire-move/1', kind: 'wire_move', agent: 'fixture-agent', sent: true,
  room, from: { ...from }, requested: { ...to }, to: { ...to }, speed: 0,
  mode: { slide: false, fall: false, off_map: true }, trace_options: null,
  validation: { available: true, moved: true, arrived: true, blocked: false,
    slid: false, offMap: true, target: { ...to }, requested: { ...to }, reason: null },
  at,
});
const callsite = (move, at = move.at + 1) => ({
  agent: move.agent, room: move.room.num, kind: 'step', to: { ...move.requested },
  sent: true, reason: null, at,
});

const first = offMapMove({ at: 110, room: wireRoom(1, 10, 11),
  from: { x: 160, y: 96, col: 2, row: 1 }, to: { x: 192, y: 96 } });
// Object id 10 is deliberately REUSED by room 2. It must still be a room transition.
const second = normalMove({ at: 120, room: wireRoom(2, 10, 22),
  from: { x: 96, y: 96, col: 1, row: 1 }, to: { x: 128, y: 96 } });
// The same room is then RENUMBERED. It must still be a same-room continuity check.
const third = normalMove({ at: 130, room: wireRoom(2, 99, 22),
  from: { x: 128, y: 96, col: 2, row: 1 }, to: { x: 160, y: 96 } });
const baseRows = [first, callsite(first), second, callsite(second), third, callsite(third)]
  .map((row, index) => ({ ...row, seq: index + 1 }));
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

const assignment = {
  index: 1, pair_index: 1, batch: 1, agent: 'fixture-agent',
  character: 'fixture-character', from: 1, from_name: 'one', to: 2, to_name: 'two',
};
const matrix = {
  schema: 'm59-city-matrix/1', verdict: 'pass',
  run_config: { mode: 'serial', fleet: 'fixture', broker: 'http://127.0.0.1:1',
    game: 1, admin: 2, fixture_health: 3, max_leg_ms: 1_000,
    exit_fallback_enabled: false, session_driver: 'in-process',
    participants: [{ agent: 'fixture-agent' }] },
  health_start: health(false), health_end: health(false),
  schedule: [{ index: 1, kind: 'serial', assignments: [assignment] }],
  batches: [{
    index: 1, kind: 'serial', started_at: 100, finished_at: 200, elapsed_ms: 100,
    health_before: health(false), health_after: health(false),
    attempts: 1, arrived: 1, deaths: 0,
    results: [{ ...assignment, started_at: 100, finished_at: 200, elapsed_ms: 100,
      arrived: true, deaths: 0, swings: 0,
      result: { arrived: true, deaths: 0, from: 1, to: 2, rooms: [1, 2] } }],
  }],
};

const geometryOf = room => ({
  security: room.security,
  traceFineMoveClient(_fromX, _fromY, targetX, targetY) {
    return { available: true, moved: true, arrived: true, blocked: false,
      slid: false, x: targetX, y: targetY };
  },
});
const dependencies = {
  geometryOf, toClient: value => value,
  getPassableExits: (_map, room) => room === 1 ? [{ to: 2 }] : [],
  getEdgeExits: room => room.num === 1 ? [{ leaveName: 'east', to: 2 }] : [],
  getEdgeCandidates: room => room.num === 1 ? [{
    fine_stand_on: { x: 160, y: 96 }, edge_target: { x: 192, y: 96 },
  }] : [],
  getInferredExits: () => [],
};
const verify = ({ rows = baseRows, report = matrix, fixtureMap = map,
  deps = dependencies, agents = 1, pairs = 1, raw = null } = {}) =>
  verifyCollisionTrace({ traceRaw: raw ?? jsonl(rows), matrix: report, map: fixtureMap,
    maxLines: 100, expectedAgents: agents, expectedPairs: pairs, dependencies: deps });

console.log('\nportable defaults and import boundary');
ok('the default trace matches the recorder\'s existing path',
  /[\\/]substrate[\\/]collision-trace\.jsonl$/.test(DEFAULT_TRACE_FILE),
  DEFAULT_TRACE_FILE);
ok('the default matrix lives under ignored substrate/traces',
  /[\\/]substrate[\\/]traces[\\/]m59-city-matrix\.json$/.test(DEFAULT_MATRIX_FILE),
  DEFAULT_MATRIX_FILE);
ok('the default verdict lives under ignored substrate/traces',
  /[\\/]substrate[\\/]traces[\\/]collision-trace-verdict\.json$/.test(DEFAULT_OUTPUT_FILE),
  DEFAULT_OUTPUT_FILE);
const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
ok('both the recorder path and generated report directory remain ignored',
  /^\/substrate\/collision-trace\.jsonl$/m.test(gitignore) &&
    /^\/substrate\/traces\/$/m.test(gitignore));
const relativeCli = parseCli(['--trace', 'substrate/traces/a.jsonl',
  '--matrix', 'substrate/traces/b.json', '--map', 'substrate/c.json',
  '--output', 'substrate/traces/d.json']);
ok('every relative CLI pathname is rooted at the harness repository',
  [relativeCli.traceFile, relativeCli.matrixFile, relativeCli.mapFile,
    relativeCli.outputFile].every(file => file.startsWith(REPO_ROOT)),
  JSON.stringify(relativeCli));
const outputRejection = value => {
  try { parseCli(['--output', value]); return ''; }
  catch (error) { return error.message; }
};
ok('an output beside live fleet state is rejected',
  /substrate\/traces/i.test(outputRejection('substrate/fleets/prod.json')));
ok('an absolute output outside the report directory is rejected',
  /substrate\/traces/i.test(outputRejection(join(tmpdir(), 'm59-verdict-outside.json'))));
ok('a lexical parent traversal is rejected before normalization',
  /\.\./.test(outputRejection('substrate/traces/nested/../../escaped.json')));
const nestedOutput = verdictOutputPath('substrate/traces/nested/run/verdict.json');
ok('a nested JSON report under substrate/traces is accepted',
  nestedOutput === join(REPO_ROOT, 'substrate', 'traces', 'nested', 'run', 'verdict.json'),
  nestedOutput);
let rejectedAttestation = '';
try { parseCli(['--fallback-disabled']); }
catch (error) { rejectedAttestation = error.message; }
ok('the removed --fallback-disabled assertion is rejected',
  /removed|evidence/i.test(rejectedAttestation), rejectedAttestation);

const verdictScratch = mkdtempSync(join(tmpdir(), 'm59-trace-verdict-'));
const verdictFile = join(verdictScratch, 'nested', 'verdict.json');
try {
  writeVerdictAtomic(verdictFile, { verdict: 'first' });
  writeVerdictAtomic(verdictFile, { verdict: 'second' });
  ok('the verdict is atomically replaced with one complete JSON document',
    JSON.parse(readFileSync(verdictFile, 'utf8')).verdict === 'second' &&
      readdirSync(join(verdictScratch, 'nested')).length === 1);
  const mode = statSync(verdictFile).mode & 0o777;
  ok('the verdict is requested as owner-readable/writable only',
    process.platform === 'win32' || mode === 0o600, `mode ${mode.toString(8)}`);
} finally {
  rmSync(verdictScratch, { recursive: true, force: true });
}

console.log('\nthe verifier consumes the matrix runner\'s real nested schedule shape');
const six = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
  .map((agent, index) => ({ agent, character: String.fromCharCode(65 + index).repeat(2) }));
const actualSchedule = buildSchedule(six, 'parallel');
const actualReport = {
  schema: 'm59-city-matrix/1', verdict: 'pass',
  run_config: { mode: 'parallel', exit_fallback_enabled: false,
    session_driver: 'in-process', participants: six },
  schedule: actualSchedule, health_start: health(false), health_end: health(false),
  batches: actualSchedule.map((batch, batchIndex) => {
    const start = 1_000 + batchIndex * 1_000;
    const results = batch.assignments.map((assigned, resultIndex) => ({
      ...assigned, started_at: start + 10 + resultIndex,
      finished_at: start + 500 + resultIndex, elapsed_ms: 490,
      arrived: true, deaths: 0, swings: 0,
      result: { arrived: true, deaths: 0, from: assigned.from, to: assigned.to,
        rooms: [assigned.from, assigned.to] },
    }));
    return { index: batch.index, kind: batch.kind, started_at: start,
      finished_at: start + 900, elapsed_ms: 900, health_before: health(false),
      health_after: health(false), results, attempts: results.length,
      arrived: results.length, deaths: 0 };
  }),
};
const actualNormalized = normalizeMatrix(actualReport);
ok('all 25 real parallel assignments become 25 scored intervals with no schema error',
  actualNormalized.mode === 'parallel' && actualNormalized.intervals.length === 25 &&
    actualNormalized.errors.length === 0, JSON.stringify(actualNormalized.errors));
ok('the nested five-batch schedule still identifies all six participants',
  actualNormalized.matrixAgents.size === 6 && actualReport.schedule.length === 5);

console.log('\nstable room identity never depends on a transient object id');
ok('renumbering an object does not change a proved room identity',
  sameStableRoom(wireRoom(2, 20, 22), wireRoom(2, 99, 22)));
ok('reusing an object id cannot turn two room numbers into one room',
  !sameStableRoom(wireRoom(1, 10, 11), wireRoom(2, 10, 22)));
ok('a security change prevents a same-room identity claim',
  !sameStableRoom(wireRoom(2, 20, 22), wireRoom(2, 99, 23)));
ok('the stable identity contains only room number and security evidence',
  JSON.stringify(stableRoomIdentity(wireRoom(2, 99, 22))) ===
    JSON.stringify({ num: 2, security: 22 }));

console.log('\nthe complete synthetic proof passes');
const baseline = verify();
ok('the matrix, trace, map and BSP replay form a passing verdict',
  baseline.verdict === 'pass', JSON.stringify(baseline.errors));
ok('the off-map packet is proved and followed into its declared destination',
  baseline.off_map_transition_packets === 1 && baseline.transition_checks === 1,
  JSON.stringify({ offMap: baseline.off_map_transition_packets,
    transitions: baseline.transition_checks }));
ok('renumbering room 2 remains an ordinary continuity check',
  baseline.continuity_checks === 1 && baseline.room_object_id_changes === 1,
  JSON.stringify({ continuity: baseline.continuity_checks,
    objectChanges: baseline.room_object_id_changes }));
ok('every sent callsite and scored agent-pair is covered',
  baseline.sent_callsite_records_matched === 3 && baseline.covered_agent_pairs === 1,
  JSON.stringify({ callsites: baseline.sent_callsite_records_matched,
    pairs: baseline.covered_agent_pairs }));
ok('actual broker health proves fallback was disabled',
  baseline.fallback_disabled_proved && baseline.fallback_policy_evidence.length === 4,
  JSON.stringify(baseline.fallback_policy_evidence));

console.log('\nfallback policy requires machine evidence');
const noHealthPolicy = clone(matrix);
for (const holder of [noHealthPolicy.health_start, noHealthPolicy.health_end,
  noHealthPolicy.batches[0].health_before, noHealthPolicy.batches[0].health_after])
  delete holder.movement_policy;
const unproved = verify({ report: noHealthPolicy });
ok('run_config false is not accepted by itself',
  kinds(unproved).includes('fallback_policy_unproved'), JSON.stringify(unproved.errors));
const enabledMatrix = clone(matrix);
enabledMatrix.health_start.movement_policy.exit_fallback_enabled = true;
const enabled = verify({ report: enabledMatrix });
ok('a broker health snapshot with fallback enabled fails explicitly',
  kinds(enabled).includes('fallback_policy_enabled') && !enabled.fallback_disabled_proved,
  JSON.stringify(enabled.errors));
const traceProvedRows = clone(baseRows);
for (const row of traceProvedRows)
  if (row.schema === 'm59-wire-move/1')
    row.movement_policy = { exit_fallback_enabled: false };
const traceProved = verify({ rows: traceProvedRows, report: noHealthPolicy });
ok('an explicit false policy on every wire row is equivalent evidence',
  traceProved.fallback_disabled_proved &&
    !kinds(traceProved).includes('fallback_policy_unproved'), JSON.stringify(traceProved.errors));
const directProof = fallbackPolicyProof({ healthSnapshots: [],
  moves: traceProvedRows.filter(row => row.schema === 'm59-wire-move/1').map(row => ({ row })) });
ok('the exported policy helper reports the evidence source',
  directProof.proved && directProof.evidence[0]?.source === 'every_wire_record');

console.log('\nJSONL integrity and durable loss are failures, not warnings');
const missingNewline = verify({ raw: jsonl(baseRows).slice(0, -1) });
ok('a missing final newline is detected',
  kinds(missingNewline).includes('trace_missing_final_newline'));
const malformed = parseTraceJsonl('{"at":1}\nnot-json\n', { maxLines: 10 });
ok('a malformed physical line is retained as a coverage error',
  malformed.errors.some(error => error.kind === 'malformed_json' && error.line === 2));
const withLoss = [baseRows[0], baseRows[1], {
  schema: 'm59-collision-trace-loss/1', kind: 'trace_loss', reason: 'test_gap',
  lostFromSeq: 3, lostThroughSeq: 4, lostCount: 2, at: 115, seq: 3,
}, ...baseRows.slice(2).map(row => ({ ...row, seq: row.seq + 2 }))];
const lost = verify({ rows: withLoss });
ok('a durable loss marker makes the capture incomplete',
  kinds(lost).includes('trace_capture_incomplete') && lost.trace_loss_markers === 1,
  JSON.stringify(lost.errors));

const unsequencedRows = clone(baseRows);
for (const row of unsequencedRows) delete row.seq;
const unsequenced = verify({ rows: unsequencedRows });
ok('a proof-bearing capture with no sequence evidence is rejected',
  kinds(unsequenced).includes('missing_trace_sequence'), JSON.stringify(unsequenced.errors));
const partiallySequencedRows = clone(baseRows);
delete partiallySequencedRows[2].seq;
const partiallySequenced = verify({ rows: partiallySequencedRows });
ok('every relevant capture row must participate in the sequence',
  kinds(partiallySequenced).includes('partial_trace_sequence') &&
    kinds(partiallySequenced).includes('invalid_trace_sequence'),
  JSON.stringify(partiallySequenced.errors));
const lateSequenceRows = clone(baseRows).map(row => ({ ...row, seq: row.seq + 40 }));
const lateSequence = verify({ rows: lateSequenceRows });
ok('a contiguous capture which starts after sequence one is rejected',
  kinds(lateSequence).includes('trace_sequence_starts_late'), JSON.stringify(lateSequence.errors));
const nonIntegerSequenceRows = clone(baseRows);
nonIntegerSequenceRows[2].seq = 3.5;
const nonIntegerSequence = verify({ rows: nonIntegerSequenceRows });
ok('every sequence value must be an integer',
  kinds(nonIntegerSequence).includes('invalid_trace_sequence'),
  JSON.stringify(nonIntegerSequence.errors));

console.log('\nmatrix execution mode is explicit proof evidence');
const missingModeMatrix = clone(matrix);
delete missingModeMatrix.run_config.mode;
const missingMode = verify({ report: missingModeMatrix });
ok('a city matrix with no execution mode is rejected',
  kinds(missingMode).includes('matrix_mode_invalid'), JSON.stringify(missingMode.errors));
const invalidModeMatrix = clone(matrix);
invalidModeMatrix.run_config.mode = 'mixed';
const invalidMode = verify({ report: invalidModeMatrix });
ok('a city matrix mode must be exactly serial or parallel',
  kinds(invalidMode).includes('matrix_mode_invalid'), JSON.stringify(invalidMode.errors));

console.log('\nnew matrix proofs require one in-process session writer');
const missingRunDriverMatrix = clone(matrix);
delete missingRunDriverMatrix.run_config.session_driver;
const missingRunDriver = verify({ report: missingRunDriverMatrix });
ok('run_config must record the in-process session driver',
  kinds(missingRunDriver).includes('matrix_session_driver_invalid') &&
    missingRunDriver.matrix_error_count === 1,
  JSON.stringify(missingRunDriver.errors));
const keeperStartMatrix = clone(matrix);
keeperStartMatrix.health_start.session_driver = 'keeper-process';
const keeperStart = verify({ report: keeperStartMatrix });
ok('required start health must independently report the in-process driver',
  kinds(keeperStart).includes('matrix_session_driver_invalid'), JSON.stringify(keeperStart.errors));
const missingBatchDriverMatrix = clone(matrix);
delete missingBatchDriverMatrix.batches[0].health_after.session_driver;
const missingBatchDriver = verify({ report: missingBatchDriverMatrix });
ok('every required batch health snapshot must report the in-process driver',
  kinds(missingBatchDriver).includes('matrix_session_driver_invalid'),
  JSON.stringify(missingBatchDriver.errors));

console.log('\neach proof layer fails independently');
const badReplayDeps = { ...dependencies,
  geometryOf: room => ({ security: room.security,
    traceFineMoveClient() { return { available: true, moved: false, arrived: false }; } }) };
const badReplay = verify({ deps: badReplayDeps });
ok('a sender claim which the BSP cannot replay is rejected',
  kinds(badReplay).includes('bsp_replay_failed') &&
    kinds(badReplay).includes('off_map_bsp_replay_failed'), JSON.stringify(badReplay.errors));
const noEdge = verify({ deps: { ...dependencies, getEdgeCandidates: () => [] } });
ok('an off-map packet without an exact edge candidate is rejected',
  kinds(noEdge).includes('off_map_not_at_proved_edge'), JSON.stringify(noEdge.errors));
const wrongSecurityRows = clone(baseRows);
wrongSecurityRows[2].room.live_security = 23;
const wrongSecurity = verify({ rows: wrongSecurityRows });
ok('live, baked and map security must agree',
  kinds(wrongSecurity).includes('room_security_mismatch'), JSON.stringify(wrongSecurity.errors));
const unmatchedRows = clone(baseRows);
unmatchedRows[1].to.x--;
const unmatched = verify({ rows: unmatchedRows });
ok('a sent callsite without its exact wire record is rejected',
  kinds(unmatched).includes('sent_callsite_without_wire_record'), JSON.stringify(unmatched.errors));
const uncoveredMatrix = clone(matrix);
uncoveredMatrix.batches[0].results[0].started_at = 140;
uncoveredMatrix.batches[0].results[0].finished_at = 150;
uncoveredMatrix.batches[0].results[0].elapsed_ms = 10;
const uncovered = verify({ report: uncoveredMatrix });
ok('a passed matrix result with no wire rows in its scored interval is rejected',
  kinds(uncovered).includes('pair_has_no_wire_coverage'), JSON.stringify(uncovered.errors));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
