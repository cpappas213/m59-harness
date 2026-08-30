#!/usr/bin/env node
// PROVE THAT EVERY RECORDED MOVE WHICH REACHED THE WIRE WAS COLLISION-CHECKED.
//
//   node tools/m59-collision-trace-verify.mjs
//   node tools/m59-collision-trace-verify.mjs --trace substrate/traces/run.jsonl \
//     --matrix substrate/traces/m59-city-matrix.json
//
// This is deliberately an offline verifier. It opens no socket and reads no roster. The
// trace supplies the exact validator inputs used before each packet, the map supplies the
// BSP and stable room security, and the matrix supplies the interval and policy evidence
// for the run. A command-line assertion is not evidence: exit fallback is proved disabled
// only by broker /health snapshots recorded in the matrix, or explicitly on every wire row.

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  edgeCandidatesOf, edgeExitsOf, inferredExits, loadMap, movementMapFile, passableExits,
} from './m59-map.mjs';
import { protocolToClient, sharedRoomGeometry } from './m59-roo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
// Match m59-collision-trace.mjs exactly. This older path is explicitly gitignored; changing
// only the reader would make a default capture look missing after a successful run.
export const DEFAULT_TRACE_FILE = join(REPO_ROOT, 'substrate', 'collision-trace.jsonl');
export const DEFAULT_MATRIX_FILE = join(
  REPO_ROOT, 'substrate', 'traces', 'm59-city-matrix.json');
export const DEFAULT_OUTPUT_FILE = join(
  REPO_ROOT, 'substrate', 'traces', 'collision-trace-verdict.json');
export const VERDICT_ROOT = join(REPO_ROOT, 'substrate', 'traces');
export const DEFAULT_MAX_LINES = 200_000;

const CALLSITE_KINDS = new Set(['step', 'pivot', 'fine']);
const WIRE_SCHEMA = 'm59-wire-move/1';
const LOSS_SCHEMA = 'm59-collision-trace-loss/1';

const MATRIX_ERROR_KINDS = new Set([
  'matrix_missing', 'matrix_load_failed', 'wrong_matrix_schema', 'matrix_not_passed',
  'matrix_mode_invalid', 'matrix_session_driver_invalid', 'matrix_agent_count', 'matrix_pair_count',
  'matrix_schedule_coverage', 'matrix_health_invalid', 'invalid_pair_interval',
  'overlapping_pair_intervals', 'pair_result_failed', 'pair_result_coverage',
  'agent_pair_result_failed', 'agent_pair_room_coverage', 'agent_pair_identity_coverage',
  'invalid_batch_interval', 'overlapping_batch_intervals', 'batch_result_failed',
  'batch_health_invalid', 'batch_result_coverage', 'batch_agent_identity_coverage',
  'pair_has_no_wire_coverage', 'pair_trace_starts_in_wrong_room',
]);
const WALL_SAFETY_ERROR_KINDS = new Set([
  'fallback_or_unvalidated_record', 'invalid_wire_record', 'invalid_wire_mode',
  'room_missing_from_map', 'room_geometry_load_failed', 'room_security_mismatch',
  'invalid_off_map_contract', 'off_map_bsp_replay_failed', 'off_map_evidence_failed',
  'off_map_not_at_proved_edge', 'incomplete_trace_options',
  'unproved_no_floor_recovery', 'sender_validation_incomplete', 'bsp_replay_failed',
  'failed_off_map_command_discontinuity', 'same_room_command_discontinuity',
  'same_room_identity_unproved', 'unproved_room_transition', 'off_map_wrong_destination',
]);
const COVERAGE_ERROR_KINDS = new Set([
  'trace_missing', 'trace_changed_while_reading', 'trace_missing_final_newline',
  'blank_trace_line', 'malformed_json', 'non_object_trace_row', 'trace_may_be_truncated',
  'missing_trace_sequence', 'partial_trace_sequence', 'invalid_trace_sequence',
  'trace_sequence_starts_late', 'trace_sequence_regressed', 'trace_sequence_gap',
  'no_wire_moves', 'invalid_timestamp', 'timestamp_regressed',
  'unknown_trace_record', 'unknown_wire_schema_kind', 'callsite_missing_sent_flag',
  'off_map_transition_has_no_successor_evidence', 'agent_coverage',
  'trace_matrix_agent_mismatch', 'sent_callsite_without_wire_record',
  'trace_capture_incomplete', 'fallback_policy_unproved', 'fallback_policy_enabled',
]);

const finiteTimestamp = value => Number.isFinite(value) ? value : Date.parse(value);
const integerWireCoordinate = number => Number.isInteger(number) && number >= 0 && number <= 0xffff;
export const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y;
const securityValue = value => Number.isFinite(Number(value))
  ? (Number(value) & 0x0fffffff) : null;

/** Stable movement identity. Object ids are intentionally absent: saves renumber them. */
export function stableRoomIdentity(room) {
  const num = Number(room?.num);
  const live = securityValue(room?.live_security);
  const baked = securityValue(room?.baked_security);
  if (!Number.isSafeInteger(num) || live == null || baked == null || live !== baked) return null;
  return { num, security: live };
}

export function sameStableRoom(a, b) {
  const left = stableRoomIdentity(a);
  const right = stableRoomIdentity(b);
  return !!left && !!right && left.num === right.num && left.security === right.security;
}

export function parseTraceJsonl(raw, { maxLines = DEFAULT_MAX_LINES } = {}) {
  const errors = [];
  const addError = (kind, detail = {}) => errors.push({ ...detail, kind });
  if (!Number.isSafeInteger(maxLines) || maxLines < 1)
    addError('invalid_max_lines', { maxLines });
  if (typeof raw !== 'string') raw = '';
  if (raw && !raw.endsWith('\n')) addError('trace_missing_final_newline');

  const physicalLines = raw ? raw.split(/\r?\n/) : [];
  if (physicalLines.at(-1) === '') physicalLines.pop();
  const parsed = [];
  for (let index = 0; index < physicalLines.length; index++) {
    const text = physicalLines[index];
    if (!text.trim()) {
      addError('blank_trace_line', { line: index + 1 });
      continue;
    }
    try {
      const row = JSON.parse(text);
      if (!row || typeof row !== 'object' || Array.isArray(row))
        addError('non_object_trace_row', { line: index + 1 });
      else parsed.push({ line: index + 1, row });
    } catch (error) {
      addError('malformed_json', { line: index + 1, error: error.message });
    }
  }
  if (Number.isSafeInteger(maxLines) && physicalLines.length >= maxLines)
    addError('trace_may_be_truncated', { lines: physicalLines.length, maxLines });

  const lossMarkers = parsed.filter(({ row }) =>
    row.schema === LOSS_SCHEMA && row.kind === 'trace_loss');
  for (const { line, row } of lossMarkers) {
    addError('trace_capture_incomplete', {
      line,
      reason: row.reason ?? null,
      lost_from_seq: row.lostFromSeq ?? null,
      lost_through_seq: row.lostThroughSeq ?? null,
      lost_count: row.lostCount ?? null,
    });
  }

  // A replayable wire proof must start at the recorder's first row and account for every
  // row after it. Accepting an old, wholly unsequenced diagnostic here would let a capture
  // begin after unknown omitted packets and still masquerade as complete evidence.
  const proofBearing = parsed.some(({ row }) =>
    row.schema === WIRE_SCHEMA && row.kind === 'wire_move');
  const sequenced = parsed.filter(({ row }) => row.seq != null);
  if (proofBearing && !sequenced.length)
    addError('missing_trace_sequence', { rows: parsed.length });
  else if (proofBearing && sequenced.length !== parsed.length)
    addError('partial_trace_sequence', { sequenced: sequenced.length, rows: parsed.length });
  if (proofBearing && parsed.length) {
    const first = parsed[0];
    if (Number.isSafeInteger(first.row.seq) && first.row.seq !== 1)
      addError('trace_sequence_starts_late', { line: first.line, seq: first.row.seq });
    let prior = null;
    for (const { line, row } of parsed) {
      if (!Number.isSafeInteger(row.seq) || row.seq < 1) {
        addError('invalid_trace_sequence', { line, seq: row.seq });
        continue;
      }
      if (prior != null && row.seq <= prior)
        addError('trace_sequence_regressed', { line, prior, seq: row.seq });
      if (prior != null && row.seq > prior + 1) {
        const from = prior + 1, through = row.seq - 1;
        const marked = lossMarkers.some(({ row: marker }) =>
          Number(marker.lostFromSeq) <= from &&
          (marker.lostThroughSeq == null || Number(marker.lostThroughSeq) >= through));
        if (!marked) addError('trace_sequence_gap', { line, from, through });
      }
      prior = row.seq;
    }
  }

  return { errors, physicalLines, parsed, lossMarkers };
}

function healthPolicyValue(health) {
  const value = health?.movement_policy?.exit_fallback_enabled;
  return typeof value === 'boolean' ? value : null;
}

function tracePolicyValue(row) {
  for (const holder of [row?.movement_policy, row?.policy]) {
    if (typeof holder?.exit_fallback_enabled === 'boolean')
      return holder.exit_fallback_enabled;
  }
  return null;
}

/**
 * A false command-line flag is not evidence about another process. Broker health is.
 * Trace evidence is accepted only when every wire record explicitly carries the policy.
 */
export function fallbackPolicyProof({ healthSnapshots = [], moves = [] } = {}) {
  const errors = [];
  const evidence = [];
  const required = healthSnapshots.filter(snapshot => snapshot.required !== false);
  let allRequiredHealthFalse = required.length > 0;

  for (const snapshot of healthSnapshots) {
    const value = healthPolicyValue(snapshot.health);
    if (value === false) evidence.push({ source: snapshot.label, value: false });
    if (value === true)
      errors.push({ kind: 'fallback_policy_enabled', source: snapshot.label });
    if (snapshot.required !== false && value !== false) allRequiredHealthFalse = false;
  }

  const traceValues = moves.map(({ row }) => tracePolicyValue(row));
  const allWireRowsFalse = traceValues.length > 0 && traceValues.every(value => value === false);
  if (allWireRowsFalse) evidence.push({ source: 'every_wire_record', value: false });
  if (traceValues.some(value => value === true))
    errors.push({ kind: 'fallback_policy_enabled', source: 'wire_record' });

  const contradicted = errors.some(error => error.kind === 'fallback_policy_enabled');
  const proved = !contradicted && (allRequiredHealthFalse || allWireRowsFalse);
  if (!proved) {
    errors.push({
      kind: 'fallback_policy_unproved',
      missing_health: required
        .filter(snapshot => healthPolicyValue(snapshot.health) !== false)
        .map(snapshot => snapshot.label),
      wire_rows_with_explicit_policy: traceValues.filter(value => value != null).length,
      wire_rows: moves.length,
      note: 'record broker /health movement_policy.exit_fallback_enabled=false; a CLI flag is not evidence',
    });
  }
  return { proved, evidence, errors };
}

const participantName = participant => typeof participant === 'string'
  ? participant : participant?.agent;

function intervalOf(row, fallback, addError, label) {
  const start = finiteTimestamp(row?.started_at ?? fallback?.started_at);
  const explicitEnd = finiteTimestamp(row?.finished_at ?? fallback?.finished_at);
  const elapsed = Number(row?.elapsed_ms ?? fallback?.elapsed_ms);
  const end = Number.isFinite(explicitEnd) ? explicitEnd
    : Number.isFinite(start) && Number.isFinite(elapsed) && elapsed >= 0 ? start + elapsed : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    addError(label.kind, { ...label.detail, started_at: row?.started_at ?? fallback?.started_at,
      finished_at: row?.finished_at ?? fallback?.finished_at,
      elapsed_ms: row?.elapsed_ms ?? fallback?.elapsed_ms });
    return null;
  }
  return { start, end };
}

function validHealth(health) {
  return !!health?.ok && Array.isArray(health.geometry_drift) && !health.geometry_drift.length;
}

/** Normalize all supported matrix schemas to per-agent scored intervals. */
export function normalizeMatrix(matrix, { expectedAgents = 6, expectedPairs = 25 } = {}) {
  const errors = [];
  const addError = (kind, detail = {}) => errors.push({ ...detail, kind });
  const intervals = [];
  const matrixAgents = new Set();
  const healthSnapshots = [];
  let mode = null;

  if (!matrix || typeof matrix !== 'object')
    return { errors, intervals, matrixAgents, healthSnapshots, mode };

  if (matrix.schema === 'm59-reachable-city-matrix/1') mode = 'serial';
  else if (matrix.schema === 'm59-parallel-city-matrix/1') mode = 'parallel';
  else if (matrix.schema === 'm59-city-matrix/1') mode = matrix.run_config?.mode ?? matrix.mode;
  else addError('wrong_matrix_schema', { schema: matrix.schema ?? null });
  if (!['serial', 'parallel'].includes(mode))
    addError('matrix_mode_invalid', { mode });
  const requiresInProcessDriver = matrix.schema === 'm59-city-matrix/1';
  if (requiresInProcessDriver && matrix.run_config?.session_driver !== 'in-process')
    addError('matrix_session_driver_invalid', { source: 'run_config.session_driver',
      value: matrix.run_config?.session_driver ?? null });
  if (matrix.verdict !== 'pass')
    addError('matrix_not_passed', { verdict: matrix.verdict ?? null,
      failed_at: matrix.failed_at ?? matrix.failure ?? null });

  const addHealth = (label, health, required = true, batch = null) => {
    healthSnapshots.push({ label, health, required });
    if (requiresInProcessDriver && required && health?.session_driver !== 'in-process')
      addError('matrix_session_driver_invalid', { source: label,
        value: health?.session_driver ?? null });
    if (!validHealth(health))
      addError(batch == null ? 'matrix_health_invalid' : 'batch_health_invalid', {
        endpoint: batch == null ? label : undefined,
        batch,
        health: health == null ? null : { ok: health.ok,
          geometry_drift: health.geometry_drift ?? null },
      });
  };

  addHealth('health_start', matrix.health_start, true);
  addHealth('health_end', matrix.health_end, true);
  for (let index = 0; index < (matrix.resume_health ?? []).length; index++)
    addHealth(`resume_health[${index}]`, matrix.resume_health[index], false);

  if (matrix.schema === 'm59-city-matrix/1') {
    const participants = matrix.run_config?.participants ?? matrix.participants ?? [];
    if (!Array.isArray(participants) || participants.length !== expectedAgents)
      addError('matrix_agent_count', { expected: expectedAgents,
        actual: Array.isArray(participants) ? participants.length : null });
    for (const participant of participants) {
      const agent = participantName(participant);
      if (typeof agent === 'string' && agent) matrixAgents.add(agent);
    }

    // This value is useful as a consistency check but never proves the policy: /health
    // above is the observation of the broker process which actually sent the packets.
    if (matrix.run_config?.exit_fallback_enabled !== false)
      addError('matrix_health_invalid', { endpoint: 'run_config.exit_fallback_enabled',
        value: matrix.run_config?.exit_fallback_enabled ?? null });

    const schedule = Array.isArray(matrix.schedule) ? matrix.schedule : [];
    const assignments = schedule.flatMap(batch => Array.isArray(batch?.assignments)
      ? batch.assignments : Number.isFinite(Number(batch?.from)) ? [batch] : []);
    const scheduledPairIndexes = new Set(assignments.map(row =>
      Number(row.pair_index ?? row.index)).filter(Number.isFinite));
    const scheduledKeys = new Set(assignments.map(row => `${row.from}>${row.to}`));
    const expectedAssignments = mode === 'serial' ? expectedPairs * expectedAgents : expectedPairs;
    if (assignments.length !== expectedAssignments ||
        scheduledPairIndexes.size !== expectedPairs ||
        scheduledKeys.size !== expectedPairs)
      addError('matrix_schedule_coverage', { expected_pairs: expectedPairs,
        expected_assignments: expectedAssignments, assignments: assignments.length,
        unique_pair_indexes: scheduledPairIndexes.size, unique_pairs: scheduledKeys.size });

    const batches = Array.isArray(matrix.batches) ? matrix.batches : [];
    let previousEnd = -Infinity;
    const resultPairIndexes = new Set();
    const resultPairKeys = new Set();
    for (const batch of batches) {
      const batchNumber = batch.index ?? null;
      const batchInterval = intervalOf(batch, null, addError,
        { kind: 'invalid_batch_interval', detail: { batch: batchNumber } });
      if (batchInterval) {
        if (batchInterval.start < previousEnd)
          addError('overlapping_batch_intervals', { batch: batchNumber,
            start: batchInterval.start, previous_end: previousEnd });
        previousEnd = Math.max(previousEnd, batchInterval.end);
      }
      addHealth(`batches[${batchNumber}].health_before`, batch.health_before, true, batchNumber);
      addHealth(`batches[${batchNumber}].health_after`, batch.health_after, true, batchNumber);

      const results = Array.isArray(batch.results) ? batch.results : [];
      const expectedInBatch = mode === 'serial' ? expectedAgents : Math.max(0, expectedAgents - 1);
      if (results.length !== expectedInBatch)
        addError('batch_result_coverage', { batch: batchNumber,
          expected: expectedInBatch, actual: results.length });
      if (batch.attempts != null && Number(batch.attempts) !== expectedInBatch ||
          batch.arrived != null && Number(batch.arrived) !== expectedInBatch ||
          batch.deaths != null && Number(batch.deaths) !== 0)
        addError('batch_result_failed', { batch: batchNumber, attempts: batch.attempts,
          arrived: batch.arrived, deaths: batch.deaths });

      const resultAgents = new Set();
      for (const row of results) {
        const result = row.result ?? row;
        const pairIndex = Number(row.pair_index ?? row.index);
        const pair = { ...row, index: pairIndex };
        resultPairIndexes.add(pairIndex);
        resultPairKeys.add(`${row.from}>${row.to}`);
        resultAgents.add(row.agent);
        const succeeded = row.arrived === true && Number(row.deaths) === 0 &&
          result.arrived === true && Number(result.deaths) === 0 &&
          Number(result.from) === Number(row.from) && Number(result.to) === Number(row.to);
        if (!succeeded)
          addError('agent_pair_result_failed', { pair: pairIndex, batch: batchNumber,
            agent: row.agent, arrived: row.arrived, deaths: row.deaths,
            from: result.from, to: result.to });
        if (!Array.isArray(result.rooms) || !result.rooms.includes(Number(row.from)) ||
            !result.rooms.includes(Number(row.to)))
          addError('agent_pair_room_coverage', { pair: pairIndex, batch: batchNumber,
            agent: row.agent, rooms: result.rooms ?? null });
        const interval = intervalOf(row, batch, addError,
          { kind: 'invalid_pair_interval', detail: { pair: pairIndex,
            batch: batchNumber, agent: row.agent } });
        if (interval) intervals.push({ pair, agent: row.agent, ...interval });
      }
      const expectedIdentities = mode === 'serial' ? expectedAgents : expectedInBatch;
      if (resultAgents.size !== expectedIdentities ||
          mode === 'serial' && [...matrixAgents].some(agent => !resultAgents.has(agent)))
        addError('batch_agent_identity_coverage', { batch: batchNumber,
          agents: [...resultAgents].sort() });
    }
    const expectedIntervals = mode === 'serial' ? expectedPairs * expectedAgents : expectedPairs;
    if (intervals.length !== expectedIntervals || resultPairIndexes.size !== expectedPairs ||
        resultPairKeys.size !== expectedPairs)
      addError('matrix_pair_count', { expected_pairs: expectedPairs,
        expected_intervals: expectedIntervals, intervals: intervals.length,
        unique_pair_indexes: resultPairIndexes.size, unique_pairs: resultPairKeys.size });
  } else if (mode === 'serial') {
    const participants = Array.isArray(matrix.agents) ? matrix.agents : [];
    if (participants.length !== expectedAgents)
      addError('matrix_agent_count', { expected: expectedAgents, actual: participants.length });
    for (const agent of participants) matrixAgents.add(agent);
    const pairs = Array.isArray(matrix.pairs) ? matrix.pairs : [];
    if (pairs.length !== expectedPairs)
      addError('matrix_pair_count', { expected: expectedPairs, actual: pairs.length });
    let previousEnd = -Infinity;
    for (const pair of pairs) {
      const interval = intervalOf(pair, null, addError,
        { kind: 'invalid_pair_interval', detail: { pair: pair.index } });
      if (interval) {
        if (interval.start < previousEnd)
          addError('overlapping_pair_intervals', { pair: pair.index,
            start: interval.start, previous_end: previousEnd });
        previousEnd = Math.max(previousEnd, interval.end);
      }
      if (pair.arrived !== expectedAgents || pair.attempts !== expectedAgents ||
          Number(pair.deaths) !== 0)
        addError('pair_result_failed', { pair: pair.index, arrived: pair.arrived,
          attempts: pair.attempts, deaths: pair.deaths });
      const results = Array.isArray(pair.results) ? pair.results : [];
      if (results.length !== expectedAgents)
        addError('pair_result_coverage', { pair: pair.index, expected: expectedAgents,
          actual: results.length });
      const resultAgents = new Set();
      for (const result of results) {
        resultAgents.add(result.agent);
        if (!result.arrived || Number(result.deaths) !== 0 ||
            Number(result.from) !== Number(pair.from) || Number(result.to) !== Number(pair.to))
          addError('agent_pair_result_failed', { pair: pair.index, agent: result.agent,
            arrived: result.arrived, deaths: result.deaths,
            from: result.from, to: result.to });
        if (!Array.isArray(result.rooms) || !result.rooms.includes(Number(pair.from)) ||
            !result.rooms.includes(Number(pair.to)))
          addError('agent_pair_room_coverage', { pair: pair.index, agent: result.agent,
            rooms: result.rooms ?? null });
        if (interval) intervals.push({ pair, agent: result.agent, ...interval });
      }
      if (resultAgents.size !== expectedAgents ||
          [...matrixAgents].some(agent => !resultAgents.has(agent)))
        addError('agent_pair_identity_coverage', { pair: pair.index,
          agents: [...resultAgents].sort() });
    }
  } else if (mode === 'parallel') {
    const participants = Array.isArray(matrix.participants) ? matrix.participants : [];
    if (participants.length !== expectedAgents)
      addError('matrix_agent_count', { expected: expectedAgents, actual: participants.length });
    for (const participant of participants) matrixAgents.add(participantName(participant));
    const batches = Array.isArray(matrix.batches) ? matrix.batches : [];
    let previousEnd = -Infinity;
    const pairKeys = new Set(), pairIndexes = new Set();
    for (const batch of batches) {
      const interval = intervalOf(batch, null, addError,
        { kind: 'invalid_batch_interval', detail: { batch: batch.index } });
      if (interval) {
        if (interval.start < previousEnd)
          addError('overlapping_batch_intervals', { batch: batch.index,
            start: interval.start, previous_end: previousEnd });
        previousEnd = Math.max(previousEnd, interval.end);
      }
      addHealth(`batches[${batch.index}].health_after`, batch.health_after, true, batch.index);
      const expectedInBatch = Math.max(0, expectedAgents - 1);
      if (batch.arrived !== batch.attempts || batch.attempts !== expectedInBatch ||
          Number(batch.deaths) !== 0)
        addError('batch_result_failed', { batch: batch.index, arrived: batch.arrived,
          attempts: batch.attempts, deaths: batch.deaths });
      const results = Array.isArray(batch.results) ? batch.results : [];
      if (results.length !== expectedInBatch)
        addError('batch_result_coverage', { batch: batch.index,
          expected: expectedInBatch, actual: results.length });
      const resultAgents = new Set();
      for (const row of results) {
        const result = row.result ?? {};
        resultAgents.add(row.agent);
        pairKeys.add(`${row.from}>${row.to}`);
        pairIndexes.add(Number(row.index));
        if (!row.arrived || Number(row.deaths) !== 0 || !result.arrived ||
            Number(result.deaths) !== 0 || Number(result.from) !== Number(row.from) ||
            Number(result.to) !== Number(row.to))
          addError('agent_pair_result_failed', { pair: row.index, batch: batch.index,
            agent: row.agent, arrived: row.arrived, deaths: row.deaths,
            from: result.from, to: result.to });
        if (!Array.isArray(result.rooms) || !result.rooms.includes(Number(row.from)) ||
            !result.rooms.includes(Number(row.to)))
          addError('agent_pair_room_coverage', { pair: row.index, batch: batch.index,
            agent: row.agent, rooms: result.rooms ?? null });
        if (interval) intervals.push({ pair: row, agent: row.agent, ...interval });
      }
      if (resultAgents.size !== expectedInBatch)
        addError('batch_agent_identity_coverage', { batch: batch.index,
          agents: [...resultAgents].sort() });
    }
    if (intervals.length !== expectedPairs || pairKeys.size !== expectedPairs ||
        pairIndexes.size !== expectedPairs)
      addError('matrix_pair_count', { expected: expectedPairs, intervals: intervals.length,
        unique_pairs: pairKeys.size, unique_indexes: pairIndexes.size });
  }

  return { errors, intervals, matrixAgents, healthSnapshots, mode };
}

export function edgeDirection(room, target) {
  if (!room?.roo || !integerWireCoordinate(target?.x) || !integerWireCoordinate(target?.y))
    return null;
  const candidates = [];
  if (target.y === 63 && target.x >= 64 && target.x < (room.roo.cols + 1) * 64)
    candidates.push('north');
  if (target.y === (room.roo.rows + 1) * 64 && target.x >= 64 &&
      target.x < (room.roo.cols + 1) * 64) candidates.push('south');
  if (target.x === 63 && target.y >= 64 && target.y < (room.roo.rows + 1) * 64)
    candidates.push('west');
  if (target.x === (room.roo.cols + 1) * 64 && target.y >= 64 &&
      target.y < (room.roo.rows + 1) * 64) candidates.push('east');
  return candidates.length === 1 ? candidates[0] : null;
}

export function offMapEvidence(map, room, move, {
  getEdgeExits = edgeExitsOf,
  getEdgeCandidates = edgeCandidatesOf,
  getInferredExits = inferredExits,
} = {}) {
  const direction = edgeDirection(room, move.to);
  if (!direction) return { direction: null, candidates: [], destinations: [] };
  const col = Math.floor(move.from.x / 64), row = Math.floor(move.from.y / 64);
  const onBoundary = direction === 'north' ? row === 1
    : direction === 'south' ? row === room.roo.rows
      : direction === 'west' ? col === 1
        : direction === 'east' ? col === room.roo.cols : false;
  const found = [];
  for (const edge of getEdgeExits(room)) {
    if ((edge.leaveName ?? '').toLowerCase() !== direction) continue;
    for (const candidate of getEdgeCandidates(room, edge, null, { live: true }))
      if (samePoint(candidate.edge_target, move.to)) found.push({ edge, candidate });
  }
  for (const edge of getInferredExits(map, room.num)) {
    if (edge.direction !== direction) continue;
    for (const candidate of getEdgeCandidates(room, direction, null, { live: true }))
      if (samePoint(candidate.edge_target, move.to)) found.push({ edge, candidate });
  }
  const candidates = found.filter(({ candidate }) => onBoundary &&
    Math.abs(move.from.x - candidate.fine_stand_on.x) <= 64 &&
    Math.abs(move.from.y - candidate.fine_stand_on.y) <= 64);
  return { direction, candidates,
    destinations: [...new Set(candidates.map(({ edge }) => Number(edge.to))
      .filter(Number.isFinite))] };
}

// A server reading or combat displacement can leave a small gap between commands. It is
// reconciled only when the static BSP proves the chord; dynamic bodies are intentionally
// omitted because their positions between two recorded endpoints cannot be reconstructed.
export function replayStaticGap(room, from, to, traceOptions = {}, {
  geometryOf = sharedRoomGeometry, toClient = protocolToClient,
} = {}) {
  const geometry = geometryOf(room);
  const common = { slide: false, obstacles: [], roomFlags: traceOptions?.roomFlags ?? 0,
    overrideDepths: traceOptions?.overrideDepths ?? null, motionZ: null };
  const targetX = toClient(to.x), targetY = toClient(to.y);
  for (const fall of [false, true]) {
    try {
      const replay = geometry.traceFineMoveClient(
        toClient(from.x), toClient(from.y), targetX, targetY, { ...common, fall });
      if (replay?.available && replay?.moved && replay?.arrived &&
          Math.abs(replay.x - targetX) <= 1e-6 && Math.abs(replay.y - targetY) <= 1e-6)
        return { arrived: true, fall };
    } catch { /* the other vertical mode may still prove the segment */ }
  }
  return { arrived: false };
}

export function verifyCollisionTrace({
  traceRaw = '', traceFile = null, traceBytes = null, traceReadErrors = [],
  matrix = null, matrixFile = null, matrixReadErrors = [], map = null, mapFile = null,
  mapReadErrors = [], maxLines = DEFAULT_MAX_LINES, expectedAgents = 6, expectedPairs = 25,
  dependencies = {},
} = {}) {
  const errors = [...traceReadErrors, ...matrixReadErrors, ...mapReadErrors];
  const addError = (kind, detail = {}) => errors.push({ ...detail, kind });
  const parsedTrace = parseTraceJsonl(traceRaw, { maxLines });
  errors.push(...parsedTrace.errors);
  const { parsed, physicalLines, lossMarkers } = parsedTrace;
  const moves = parsed.filter(({ row }) => row.schema === WIRE_SCHEMA && row.kind === 'wire_move');
  if (!moves.length) addError('no_wire_moves');

  let priorTimestamp = -Infinity;
  for (const { line, row } of parsed) {
    if (!Number.isSafeInteger(row.at) || row.at < 0)
      addError('invalid_timestamp', { line, at: row.at });
    else if (row.at < priorTimestamp)
      addError('timestamp_regressed', { line, prior: priorTimestamp, at: row.at });
    else priorTimestamp = row.at;

    const wire = row.schema === WIRE_SCHEMA && row.kind === 'wire_move';
    const callsite = row.schema == null && CALLSITE_KINDS.has(row.kind);
    const loss = row.schema === LOSS_SCHEMA && row.kind === 'trace_loss';
    if (!wire && !callsite && !loss)
      addError('unknown_trace_record', { line, schema: row.schema ?? null,
        kind: row.kind ?? null });
    if (row.schema === WIRE_SCHEMA && row.kind !== 'wire_move')
      addError('unknown_wire_schema_kind', { line, kind: row.kind ?? null });
    if (callsite && typeof row.sent !== 'boolean')
      addError('callsite_missing_sent_flag', { line, kind: row.kind });
  }

  if (map && (!map.rooms || !map.geometryManifestSha256))
    addError('map_missing_exact_geometry_manifest', {
      manifest: map?.geometryManifestSha256 ?? null });

  const normalized = normalizeMatrix(matrix, { expectedAgents, expectedPairs });
  errors.push(...normalized.errors);
  const { intervals, matrixAgents, healthSnapshots, mode: matrixMode } = normalized;
  const policyProof = fallbackPolicyProof({ healthSnapshots, moves });
  errors.push(...policyProof.errors);

  const pairAt = (timestamp, agent) => intervals
    .filter(interval => interval.agent === agent && timestamp >= interval.start &&
      timestamp <= interval.end)
    .sort((a, b) => b.start - a.start)[0] ?? null;
  const isStagedTransition = (previous, current) => {
    const interval = pairAt(current.row.at, current.row.agent);
    const before = pairAt(previous.row.at, previous.row.agent);
    return !!interval && before?.pair?.index !== interval.pair.index &&
      Number(current.row.room?.num) === Number(interval.pair.from);
  };
  const lossBetween = (priorLine, nextLine) => lossMarkers.some(({ line }) =>
    line > priorLine && line < nextLine);

  const geometryOf = dependencies.geometryOf ?? sharedRoomGeometry;
  const toClient = dependencies.toClient ?? protocolToClient;
  const getPassableExits = dependencies.getPassableExits ?? passableExits;
  const agents = new Set(), rooms = new Set(), roomIds = new Map(), byAgent = new Map();
  let validated = 0, offMap = 0, falls = 0, slides = 0;

  for (let index = 0; index < moves.length; index++) {
    const entry = moves[index], move = entry.row;
    const label = { line: entry.line, index: index + 1, agent: move.agent,
      room: move.room?.num };
    if (typeof move.agent !== 'string' || !move.agent) addError('invalid_agent', label);
    else agents.add(move.agent);
    if (Number.isFinite(Number(move.room?.num))) rooms.add(Number(move.room.num));

    const roomNum = Number(move.room?.num), roomId = Number(move.room?.id);
    if (!Number.isSafeInteger(roomNum) || !Number.isSafeInteger(roomId))
      addError('invalid_room_identity', { ...label, room_id: move.room?.id });
    else {
      const seen = roomIds.get(roomNum) ?? new Set();
      seen.add(roomId); roomIds.set(roomNum, seen);
    }

    const coordinates = [move.from?.x, move.from?.y, move.requested?.x, move.requested?.y,
      move.to?.x, move.to?.y];
    if (move.sent !== true || coordinates.some(number => !integerWireCoordinate(number))) {
      addError('invalid_wire_record', { ...label, sent: move.sent });
      continue;
    }
    if (!Number.isFinite(move.speed) || move.speed < 0 ||
        typeof move.mode?.off_map !== 'boolean' || typeof move.mode?.slide !== 'boolean' ||
        typeof move.mode?.fall !== 'boolean') {
      addError('invalid_wire_mode', { ...label, speed: move.speed, mode: move.mode });
      continue;
    }
    if (move.fallback || move.unvalidated ||
        /fallback|unvalidated/i.test(String(move.validation?.reason ?? '')))
      addError('fallback_or_unvalidated_record', label);

    const room = map?.rooms?.[roomNum] ?? map?.rooms?.[String(roomNum)];
    if (!room?.roo) { addError('room_missing_from_map', label); continue; }
    let geometry;
    try { geometry = geometryOf(room); }
    catch (error) {
      addError('room_geometry_load_failed', { ...label, error: error.message });
      continue;
    }
    const identity = stableRoomIdentity(move.room);
    const mapSecurity = securityValue(geometry.security);
    if (!identity || identity.security !== mapSecurity) {
      addError('room_security_mismatch', { ...label,
        live: securityValue(move.room?.live_security),
        baked: securityValue(move.room?.baked_security), map: mapSecurity });
      continue;
    }

    if (move.mode.off_map) {
      offMap++;
      if (move.mode.slide || move.mode.fall || move.speed !== 0 || move.trace_options != null ||
          !samePoint(move.requested, move.to) || move.validation?.available !== true ||
          move.validation?.moved !== true || move.validation?.arrived !== true ||
          move.validation?.blocked !== false || move.validation?.slid !== false ||
          move.validation?.offMap !== true || !samePoint(move.validation?.target, move.to) ||
          !samePoint(move.validation?.requested, move.requested) ||
          move.validation?.reason === 'recovered_from_no_floor')
        addError('invalid_off_map_contract', { ...label, mode: move.mode, speed: move.speed,
          validation: move.validation });
      const targetX = toClient(move.to.x), targetY = toClient(move.to.y);
      let replay = null;
      try {
        replay = geometry.traceFineMoveClient(toClient(move.from.x), toClient(move.from.y),
          targetX, targetY, { slide: false, fall: false });
      } catch { /* reported as a failed replay below */ }
      if (!replay?.available || !replay?.moved || !replay?.arrived ||
          Math.abs(replay.x - targetX) > 1e-6 || Math.abs(replay.y - targetY) > 1e-6)
        addError('off_map_bsp_replay_failed', { ...label,
          replay: replay ? { available: replay.available, moved: replay.moved,
            arrived: replay.arrived, x: replay.x, y: replay.y } : null,
          from: move.from, to: move.to });
      let evidence = { direction: null, candidates: [], destinations: [] };
      try { evidence = offMapEvidence(map, room, move, dependencies); }
      catch (error) { addError('off_map_evidence_failed', { ...label, error: error.message }); }
      if (!evidence.direction || !evidence.candidates.length || !evidence.destinations.length)
        addError('off_map_not_at_proved_edge', { ...label, from: move.from, to: move.to,
          direction: evidence.direction });
      entry.offMapEvidence = evidence;
      continue;
    }

    if (move.trace_options == null || !Array.isArray(move.trace_options.obstacles) ||
        !Number.isInteger(move.trace_options.roomFlags) ||
        !(move.trace_options.overrideDepths == null ||
          Array.isArray(move.trace_options.overrideDepths)) ||
        !(move.trace_options.motionZ == null ||
          Number.isFinite(move.trace_options.motionZ.min) &&
          Number.isFinite(move.trace_options.motionZ.max)))
      addError('incomplete_trace_options', { ...label, trace_options: move.trace_options });
    if (move.validation?.reason === 'recovered_from_no_floor') {
      addError('unproved_no_floor_recovery', label); continue;
    }
    if (move.validation?.available !== true || move.validation?.moved !== true ||
        move.validation?.arrived !== true) {
      addError('sender_validation_incomplete', { ...label, validation: move.validation });
      continue;
    }
    const options = { slide: move.mode.slide, fall: move.mode.fall,
      obstacles: move.trace_options?.obstacles ?? [],
      roomFlags: move.trace_options?.roomFlags ?? 0,
      overrideDepths: move.trace_options?.overrideDepths ?? null,
      motionZ: move.trace_options?.motionZ ?? null };
    const targetX = toClient(move.to.x), targetY = toClient(move.to.y);
    let replay = null;
    try {
      replay = geometry.traceFineMoveClient(toClient(move.from.x), toClient(move.from.y),
        targetX, targetY, options);
    } catch { /* reported below */ }
    if (!replay?.available || !replay?.moved || !replay?.arrived ||
        Math.abs(replay.x - targetX) > 1e-6 || Math.abs(replay.y - targetY) > 1e-6) {
      addError('bsp_replay_failed', { ...label, mode: move.mode,
        reason: replay?.reason ?? null,
        replay: replay ? { available: replay.available, moved: replay.moved,
          arrived: replay.arrived, x: replay.x, y: replay.y } : null,
        from: move.from, to: move.to });
      continue;
    }
    validated++;
    if (move.mode.fall) falls++;
    if (move.mode.slide || move.validation?.slid) slides++;
  }

  for (const entry of moves) {
    const list = byAgent.get(entry.row.agent) ?? [];
    list.push(entry); byAgent.set(entry.row.agent, list);
  }
  let continuityChecks = 0, transitionChecks = 0, stagedTransitions = 0;
  let offMapRetries = 0, reconciledContinuity = 0;
  for (const [agent, list] of byAgent) {
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1], current = list[index];
      const prior = previous.row, move = current.row;
      const captureGap = lossBetween(previous.line, current.line);
      if (isStagedTransition(previous, current)) { stagedTransitions++; continue; }

      const sameNumber = Number(prior.room?.num) === Number(move.room?.num);
      if (sameNumber) {
        if (!sameStableRoom(prior.room, move.room)) {
          addError('same_room_identity_unproved', { agent, prior_line: previous.line,
            line: current.line, room: move.room?.num,
            prior_security: stableRoomIdentity(prior.room)?.security ?? null,
            security: stableRoomIdentity(move.room)?.security ?? null });
          continue;
        }
        if (prior.mode.off_map) {
          const nearStart = Math.abs(prior.from.x - move.from.x) <= 64 &&
            Math.abs(prior.from.y - move.from.y) <= 64;
          if (!nearStart) {
            if (!captureGap)
              addError('failed_off_map_command_discontinuity', { agent,
                prior_line: previous.line, line: current.line,
                prior_from: prior.from, current_from: move.from });
          } else offMapRetries++;
        } else {
          continuityChecks++;
          if (!samePoint(prior.to, move.from)) {
            if (captureGap) continue;
            const room = map?.rooms?.[Number(move.room.num)] ??
              map?.rooms?.[String(move.room.num)];
            let reconciled = { arrived: false };
            try { if (room?.roo) reconciled = replayStaticGap(
              room, prior.to, move.from, move.trace_options, { geometryOf, toClient }); }
            catch { /* reported as a continuity failure */ }
            if (reconciled.arrived) reconciledContinuity++;
            else addError('same_room_command_discontinuity', { agent, room: move.room.num,
              prior_line: previous.line, line: current.line, prior_to: prior.to,
              from: move.from, bsp_reconciled: false });
          }
        }
        continue;
      }

      transitionChecks++;
      if (captureGap) continue;
      const graphExits = getPassableExits(map, Number(prior.room?.num))
        .filter(exit => Number(exit.to) === Number(move.room?.num));
      if (!graphExits.length)
        addError('unproved_room_transition', { agent, prior_line: previous.line,
          line: current.line, from_room: prior.room?.num, to_room: move.room?.num,
          prior_off_map: prior.mode?.off_map, prior_to: prior.to });
      if (prior.mode.off_map) {
        const allowed = previous.offMapEvidence?.destinations ?? [];
        if (!allowed.includes(Number(move.room?.num)))
          addError('off_map_wrong_destination', { agent, prior_line: previous.line,
            line: current.line, from_room: prior.room?.num, to_room: move.room?.num,
            allowed_destinations: allowed });
      }
    }

    const last = list.at(-1);
    if (last?.row.mode?.off_map) {
      const interval = pairAt(last.row.at, agent);
      const allowed = last.offMapEvidence?.destinations ?? [];
      if (!interval || !allowed.includes(Number(interval.pair.to)))
        addError('off_map_transition_has_no_successor_evidence', { agent, line: last.line,
          room: last.row.room?.num, allowed_destinations: allowed,
          matrix_pair: interval?.pair?.index ?? null,
          matrix_destination: interval?.pair?.to ?? null });
    }
  }

  if (agents.size !== expectedAgents)
    addError('agent_coverage', { expected: expectedAgents, actual: agents.size,
      agents: [...agents].sort() });
  if (matrixAgents.size && (agents.size !== matrixAgents.size ||
      [...matrixAgents].some(agent => !agents.has(agent))))
    addError('trace_matrix_agent_mismatch', { trace_agents: [...agents].sort(),
      matrix_agents: [...matrixAgents].sort() });

  let callsiteMatched = 0;
  const usedWire = new Set();
  for (const { line, row } of parsed) {
    if (row.schema != null || !row.sent || !CALLSITE_KINDS.has(row.kind)) continue;
    const requested = row.kind === 'fine' ? row.aimed : row.to;
    let found = -1;
    for (let index = moves.length - 1; index >= 0; index--) {
      const candidate = moves[index];
      if (candidate.line >= line || usedWire.has(index)) continue;
      if (row.at - candidate.row.at > 1_000) break;
      if (candidate.row.agent === row.agent &&
          Number(candidate.row.room?.num) === Number(row.room) &&
          samePoint(candidate.row.requested, requested)) { found = index; break; }
    }
    if (found < 0)
      addError('sent_callsite_without_wire_record', { line, agent: row.agent,
        room: row.room, kind: row.kind, to: requested });
    else { usedWire.add(found); callsiteMatched++; }
  }

  let coveredAgentPairs = 0;
  for (const interval of intervals) {
    const covered = (byAgent.get(interval.agent) ?? []).filter(({ row }) =>
      row.at >= interval.start && row.at <= interval.end);
    if (!covered.length) {
      addError('pair_has_no_wire_coverage', { pair: interval.pair.index,
        agent: interval.agent, from: interval.pair.from, to: interval.pair.to });
      continue;
    }
    coveredAgentPairs++;
    if (Number(covered[0].row.room?.num) !== Number(interval.pair.from))
      addError('pair_trace_starts_in_wrong_room', { pair: interval.pair.index,
        agent: interval.agent, expected: interval.pair.from,
        actual: covered[0].row.room?.num, line: covered[0].line });
  }

  const roomObjectIdChanges = [...roomIds.values()]
    .reduce((sum, ids) => sum + Math.max(0, ids.size - 1), 0);
  const matrixErrorCount = errors.filter(error => MATRIX_ERROR_KINDS.has(error.kind)).length;
  const wallSafetyErrorCount = errors
    .filter(error => WALL_SAFETY_ERROR_KINDS.has(error.kind)).length;
  const coverageErrorCount = errors.filter(error => COVERAGE_ERROR_KINDS.has(error.kind)).length;
  return {
    schema: 'm59-wire-trace-verdict/3',
    trace: traceFile,
    matrix: matrixFile,
    matrix_mode: matrixMode,
    map: mapFile,
    geometry_manifest_sha256: map?.geometryManifestSha256 ?? null,
    fallback_disabled_proved: policyProof.proved,
    fallback_policy_evidence: policyProof.evidence,
    lines: physicalLines.length,
    trace_bytes: traceBytes ?? Buffer.byteLength(traceRaw, 'utf8'),
    trace_loss_markers: lossMarkers.length,
    wire_moves: moves.length,
    replay_validated: validated,
    off_map_transition_packets: offMap,
    off_map_retries: offMapRetries,
    continuity_checks: continuityChecks,
    bsp_reconciled_continuity_gaps: reconciledContinuity,
    transition_checks: transitionChecks,
    staged_transitions: stagedTransitions,
    room_object_id_changes: roomObjectIdChanges,
    sent_callsite_records_matched: callsiteMatched,
    covered_agent_pairs: coveredAgentPairs,
    expected_agent_pairs: intervals.length,
    falls, slides,
    agents: [...agents].sort(),
    rooms: [...rooms].sort((a, b) => a - b),
    matrix_error_count: matrixErrorCount,
    wall_safety_error_count: wallSafetyErrorCount,
    coverage_error_count: coverageErrorCount,
    errors: errors.slice(0, 100),
    error_count: errors.length,
    verdict: errors.length ? 'fail' : 'pass',
  };
}

function readStableTrace(file) {
  const errors = [];
  if (!existsSync(file)) return { raw: '', bytes: 0,
    errors: [{ kind: 'trace_missing', trace: file }] };
  const before = statSync(file);
  const raw = readFileSync(file, 'utf8');
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    errors.push({ kind: 'trace_changed_while_reading', before_size: before.size,
      after_size: after.size });
  return { raw, bytes: after.size, errors };
}

export function verifyCollisionTraceFiles({
  traceFile = DEFAULT_TRACE_FILE, matrixFile = DEFAULT_MATRIX_FILE,
  mapFile = movementMapFile(), maxLines = DEFAULT_MAX_LINES,
  expectedAgents = 6, expectedPairs = 25, dependencies = {},
} = {}) {
  const trace = readStableTrace(traceFile);
  let matrix = null, map = null;
  const matrixReadErrors = [], mapReadErrors = [];
  if (!existsSync(matrixFile)) matrixReadErrors.push({ kind: 'matrix_missing', matrix: matrixFile });
  else {
    try { matrix = JSON.parse(readFileSync(matrixFile, 'utf8')); }
    catch (error) { matrixReadErrors.push({ kind: 'matrix_load_failed', error: error.message }); }
  }
  if (!existsSync(mapFile)) mapReadErrors.push({ kind: 'map_missing', map: mapFile });
  else {
    try { map = (dependencies.loadMap ?? loadMap)(mapFile); }
    catch (error) { mapReadErrors.push({ kind: 'map_load_failed', error: error.message }); }
  }
  return verifyCollisionTrace({ traceRaw: trace.raw, traceFile, traceBytes: trace.bytes,
    traceReadErrors: trace.errors, matrix, matrixFile, matrixReadErrors, map, mapFile,
    mapReadErrors, maxLines, expectedAgents, expectedPairs, dependencies });
}

/** Same-directory rename is the commit boundary; captures can identify agents and rooms. */
export function writeVerdictAtomic(file, summary) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file),
    `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    writeFileSync(temporary, JSON.stringify(summary, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    renamed = true;
  } finally {
    if (!renamed && existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

const repoPath = value => isAbsolute(value) ? resolve(value) : resolve(REPO_ROOT, value);

/**
 * Reports contain agent/room/path metadata. Keep CLI output in the one ignored directory
 * reserved for it; lexical traversal is refused even when normalization would land back
 * inside that directory, so the boundary is visible in the command the operator typed.
 */
export function verdictOutputPath(value) {
  if (typeof value !== 'string' || !value)
    throw new Error('--output requires a pathname or -');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value))
    throw new Error('--output may not contain a .. path segment');
  const file = repoPath(value);
  const within = relative(VERDICT_ROOT, file);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('--output must be a descendant of substrate/traces');
  if (extname(file).toLowerCase() !== '.json')
    throw new Error('--output must name a .json file under substrate/traces');
  return file;
}

export function parseCli(argv = []) {
  const options = { traceFile: DEFAULT_TRACE_FILE, matrixFile: DEFAULT_MATRIX_FILE,
    mapFile: movementMapFile(), outputFile: DEFAULT_OUTPUT_FILE,
    maxLines: Number(process.env.M59_COLLISION_TRACE_MAX || DEFAULT_MAX_LINES),
    expectedAgents: 6, expectedPairs: 25, help: false };
  const valueFlags = new Map([
    ['--trace', 'traceFile'], ['--matrix', 'matrixFile'], ['--map', 'mapFile'],
    ['--output', 'outputFile'], ['--max-lines', 'maxLines'],
    ['--agents', 'expectedAgents'], ['--pairs', 'expectedPairs'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--fallback-disabled')
      throw new Error('--fallback-disabled was removed: record broker /health policy evidence');
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`unknown option: ${arg}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (['maxLines', 'expectedAgents', 'expectedPairs'].includes(key)) options[key] = Number(value);
    else if (key === 'outputFile' && value === '-') options[key] = null;
    else if (key === 'outputFile') options[key] = verdictOutputPath(value);
    else options[key] = repoPath(value);
  }
  for (const key of ['maxLines', 'expectedAgents', 'expectedPairs'])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw new Error(`${key} must be a positive integer`);
  return options;
}

export const CLI_HELP = `Usage: node tools/m59-collision-trace-verify.mjs [options]

All relative paths are resolved from the harness repository root.

  --trace FILE       JSONL capture (default: substrate/collision-trace.jsonl)
  --matrix FILE      matrix report (default: substrate/traces/m59-city-matrix.json)
  --map FILE         collision map (default: the broker's normal map selection)
  --output FILE      verdict JSON (default: substrate/traces/collision-trace-verdict.json)
  --output -         print only; do not write a verdict file
  --max-lines N      capture line cap (default: M59_COLLISION_TRACE_MAX or 200000)
  --agents N         expected participant count (default: 6)
  --pairs N          expected city-pair count (default: 25)

There is no --fallback-disabled assertion. The matrix must record broker /health with
movement_policy.exit_fallback_enabled=false, or every wire record must carry that policy.`;

export function runCli(argv = process.argv.slice(2)) {
  let options;
  try { options = parseCli(argv); }
  catch (error) { console.error(error.message); console.error(CLI_HELP); return 2; }
  if (options.help) { console.log(CLI_HELP); return 0; }
  const summary = verifyCollisionTraceFiles(options);
  if (options.outputFile) writeVerdictAtomic(options.outputFile, summary);
  console.log(JSON.stringify(summary, null, 2));
  return summary.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runCli();
