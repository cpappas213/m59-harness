// DEBUGGING INSTRUMENTATION FOR THE MOVEMENT PATH. OFF UNLESS SOMEBODY TURNS IT ON.
//
//   M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 ...
//   node tools/m59-collision-trace.mjs            read back what it caught
//   node tools/m59-collision-trace.mjs --clear
//
// THE QUESTION IT EXISTS TO ANSWER. A character reads `! NOT MOVING — travelling, same
// square two pulses apart` for four hundred seconds, and from outside there is no way to
// tell the two possibilities apart: it is either SENDING NOTHING — every candidate step
// refused by the local validator, so no packet ever leaves — or it is LOOPING, sending
// steps that go out and land nowhere. Those want opposite fixes, and every instrument in
// the harness reads the same for both, because both look like a body that has not moved.
//
// So this records the one event that separates them: every move attempt, whether a packet
// was SENT, and the validator's reason when it was not.
//
// WHY IT IS SAFE TO HAVE AT ALL. The server does no geometry check on a player move —
// room.kod's own comment on `UserMove` is "already been checked by client (HAHA!)" — so
// the refusals recorded here are entirely OUR OWN, produced locally by `validateFineTarget`
// against baked geometry. Tracing them costs one appended line and reaches no socket.
//
// ============================ IT MUST BE OFF WHEN COMMITTED ============================
//
// This writes a line per move attempt. A fleet of twenty-one crossing the map produces
// thousands a minute, and left on it is an unbounded file and a measurable cost inside the
// one loop that has to stay fast. `m59-collision-trace-test.mjs` fails if the default in
// this file is anything but off, so it cannot be left switched on by an edit — turning it
// on is a thing you do in the ENVIRONMENT, for one run, and never in the source.

import { appendFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
// OVERRIDABLE, SO A TEST NEVER TOUCHES A LIVE CAPTURE.
//
// `m59-collision-trace-test.mjs` proves that tracing writes NOTHING when it is off, and the
// only honest way to prove that is to check the file does not appear — which means deleting
// it first. Pointed at the real path, that test deletes an in-progress trace: it happened,
// mid-run, and took the movement record of a fleet crossing with it. The suite points this
// at a scratch file instead. Same pattern m59-collision-test.mjs already uses for the
// tactics and crossings books.
export const TRACE_FILE = process.env.M59_COLLISION_TRACE_FILE
  || join(REPO, 'substrate', 'collision-trace.jsonl');

// THE DEFAULT, AND THE ONLY THING THE TEST CARES ABOUT. Read once: this is consulted in a
// hot loop, and re-reading process.env per move is itself a cost worth not paying.
export const COLLISION_TRACE = process.env.M59_COLLISION_TRACE === '1';

// A bound, because an unbounded debug file on a machine that is also running the fleet is
// a way to fill a disk while looking like nothing is happening.
const configuredMaxLines = Number(process.env.M59_COLLISION_TRACE_MAX || 200_000);
const MAX_LINES = Number.isSafeInteger(configuredMaxLines) && configuredMaxLines > 0
  ? configuredMaxLines : 200_000;
// Reserve the final physical line for a durable cap marker. Without it, a file that stops
// cleanly at the configured bound is indistinguishable from a complete capture.
const MAX_ATTEMPTS = Math.max(0, MAX_LINES - 1);
// A failed destination must not turn this diagnostic into an unbounded memory sink. Keep
// the oldest rows: if this fills, their successors are represented by one loss marker on
// recovery, preserving the order on either side of the gap.
// Pending rows are process-local: a hard process death while the destination is unavailable
// can lose them before a marker is durable. Restart handling below preserves the numbering
// and cap of durable rows; it does not claim to reconstruct memory from a dead process.
const configuredPending = Number(process.env.M59_COLLISION_TRACE_PENDING_MAX || 4_096);
const MAX_PENDING = Number.isSafeInteger(configuredPending) && configuredPending > 0
  ? configuredPending : 4_096;
let attempted = 0;
let pending = [];
let loss = null;
let capLine = '';
let capWritten = false;
let resumeProblem = null;
let complained = false;
let complainedLoss = false;

// A trace file is one bounded capture even when the supervised broker restarts. Continue
// its logical sequence and remaining line budget instead of appending a second `seq: 1`
// run after an open-ended cap marker. A malformed/partial tail cannot be repaired safely by
// appending more bytes, so it fails closed until the operator clears the diagnostic file.
function resumeExistingCapture() {
  if (!COLLISION_TRACE) return;
  let text;
  try { text = readFileSync(TRACE_FILE, 'utf8'); }
  catch (error) {
    // A confirmed absence is a fresh capture. Anything else means bytes may already exist
    // behind a permission error, lock, directory, or device failure; assigning seq 1 there
    // would make a later recovery look complete while exceeding the prior capture's cap.
    if (error?.code === 'ENOENT') return;
    resumeProblem = 'existing trace could not be inspected; clear or repair it before tracing again';
    return;
  }
  if (!text) return;
  if (!text.endsWith('\n')) {
    resumeProblem = 'existing trace has a partial final line; clear it before tracing again';
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  let highestSeq = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); }
    catch {
      resumeProblem = 'existing trace contains malformed JSON; clear it before tracing again';
      return;
    }
    if (Number.isSafeInteger(row?.seq) && row.seq > highestSeq) highestSeq = row.seq;
    if (Number.isSafeInteger(row?.lostThroughSeq) && row.lostThroughSeq > highestSeq)
      highestSeq = row.lostThroughSeq;
    if (row?.schema === 'm59-collision-trace-loss/1'
        && row?.reason === 'max_lines_reached' && row?.lostThroughSeq === null)
      capWritten = true;
  }
  // `lines.length` also handles captures written before sequence numbers existed and makes
  // a previously reset/duplicated sequence conservative rather than repeating it again.
  attempted = Math.max(highestSeq, lines.length);
  if (lines.length >= MAX_LINES) capWritten = true;
}

resumeExistingCapture();

function lossLine() {
  if (!loss) return '';
  const reasons = [...loss.reasons];
  return JSON.stringify({
    schema: 'm59-collision-trace-loss/1',
    kind: 'trace_loss',
    reason: reasons.length === 1 ? reasons[0] : 'multiple',
    lossReasons: reasons,
    lostFromSeq: loss.fromSeq,
    lostThroughSeq: loss.throughSeq,
    lostCount: loss.count,
    at: loss.at,
    // The marker occupies the first unavailable sequence. A range longer than one also
    // leaves a numeric gap before the next move row; either form is unambiguously incomplete.
    seq: loss.fromSeq,
  }) + '\n';
}

function rememberLoss(seq, at, reason) {
  if (!loss) {
    loss = { fromSeq: seq, throughSeq: seq, count: 1, at, reasons: new Set([reason]) };
  } else {
    loss.throughSeq = seq;
    loss.count++;
    loss.reasons.add(reason);
  }
}

// One append is the commit boundary. Never dequeue a retry before the entire ordered batch
// has landed: a later call can then retry the same serialized bytes without intentionally
// duplicating them. As with every append-only diagnostic, a filesystem that partially writes
// before throwing can still leave a malformed tail; the next process detects and refuses it.
function appendBatch(current = '') {
  const marker = lossLine();
  const batch = pending.join('') + marker + capLine + current;
  if (!batch) return true;
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    appendFileSync(TRACE_FILE, batch);
  } catch {
    return false;
  }
  pending = [];
  loss = null;
  if (capLine) capWritten = true;
  capLine = '';
  return true;
}

function markCap() {
  if (!capWritten && !capLine) {
    const seq = attempted + 1;
    capLine = JSON.stringify({
      schema: 'm59-collision-trace-loss/1',
      kind: 'trace_loss',
      reason: 'max_lines_reached',
      lossReasons: ['max_lines_reached'],
      lostFromSeq: seq,
      // The tracer cannot know how many future calls this cap will omit. Null is deliberate:
      // consumers must treat the range as open-ended, never as one missing move.
      lostThroughSeq: null,
      lostCount: null,
      at: Date.now(),
      seq,
    }) + '\n';
  }
  appendBatch();
}

/**
 * One move attempt. No-op — and cheap — unless the trace is on.
 *
 * `sent` is the whole point: false means the local validator refused and NOTHING went to
 * the wire, true means a packet left and the body still did not arrive. Everything else is
 * context for reading a run back afterwards.
 */
export function traceMove(detail) {
  if (!COLLISION_TRACE) return;
  if (resumeProblem) {
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] ${resumeProblem} — ${TRACE_FILE}`);
    }
    return;
  }
  if (capWritten) {
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] capture already ended at its line cap — ${TRACE_FILE}`);
    }
    return;
  }
  if (attempted >= MAX_ATTEMPTS) {
    // A cap reached during an outage must not strand already accepted rows forever. Calls
    // after the cap retry both those rows and the durable, open-ended cap marker.
    markCap();
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] stopped at ${MAX_LINES} lines — ${TRACE_FILE}`);
    }
    return;
  }

  const seq = ++attempted;
  const at = Date.now();
  let line;
  try {
    // SPREAD FIRST, CLOCK AND SEQUENCE LAST, so caller fields can never take their names.
    // It already did: the step call site passed `at: {col,row}` for the body's square, which
    // overwrote `at: Date.now()` and made every interval in the file read NaN. That is the
    // `emit(kind, data)` trap this repository already documents — a payload field silently
    // winning because it was spread over the thing it collided with — and it cost the timing
    // on the first capture of the bounce.
    line = JSON.stringify({ ...detail, at, seq }) + '\n';
  } catch {
    // A malformed diagnostic payload must still leave durable evidence that continuity was
    // lost, and must never break the walk it was meant to observe.
    rememberLoss(seq, at, 'serialization_error');
    appendBatch();
    return;
  }

  if (appendBatch(line)) return;

  if (!loss && pending.length < MAX_PENDING) {
    // Store the already serialized bytes: retries retain the event's original clock and seq.
    pending.push(line);
    return;
  }

  // Once a gap begins, later failures join it rather than being queued behind it. That keeps
  // the recovery order pending -> marker -> first newly writable row while memory stays flat.
  rememberLoss(seq, at, 'pending_queue_overflow');
  if (!complainedLoss) {
    complainedLoss = true;
    console.error(`[collision-trace] pending queue full; loss will be marked on recovery — ${TRACE_FILE}`);
  }
}

// ------------------------------------------------------------------ reading it back
if (process.argv[1]?.endsWith('m59-collision-trace.mjs')) {
  if (process.argv.includes('--clear')) {
    if (existsSync(TRACE_FILE)) unlinkSync(TRACE_FILE);
    console.log('cleared');
    process.exit(0);
  }
  if (!existsSync(TRACE_FILE)) {
    console.log(`no trace at ${TRACE_FILE}`);
    console.log('turn it on for one run:  M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 --dashboard 8972');
    process.exit(0);
  }
  let malformed = 0;
  const rows = readFileSync(TRACE_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { malformed++; return null; } }).filter(Boolean);
  const byAgent = new Map();
  const reasons = {};
  let sent = 0, refused = 0, lost = 0, openLosses = 0, lossMarkers = 0;
  for (const r of rows) {
    if (r.kind === 'trace_loss') {
      lossMarkers++;
      if (r.lostCount == null) openLosses++;
      else lost += Number(r.lostCount) || 0;
      continue;
    }
    if (r.sent) sent++; else { refused++; reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1; }
    const a = byAgent.get(r.agent) ?? { sent: 0, refused: 0, rooms: new Set() };
    if (r.sent) a.sent++; else a.refused++;
    if (r.room != null) a.rooms.add(r.room);
    byAgent.set(r.agent, a);
  }
  console.log(`${sent + refused} recorded move attempt(s): ${sent} sent, ${refused} refused by our own validator\n`);
  if (lossMarkers) {
    const open = openLosses ? `; ${openLosses} open-ended loss range(s)` : '';
    console.log(`TRACE INCOMPLETE: ${lost} known move attempt(s) unavailable${open} (${lossMarkers} durable loss marker(s))\n`);
  }
  if (malformed)
    console.log(`TRACE INCOMPLETE: ${malformed} malformed line(s) could not be read\n`);
  // THE ANSWER, IN ONE LINE PER CHARACTER. All-refused is "sending nothing"; a high sent
  // count with no progress is "looping". They are different bugs.
  console.log('  agent        sent  refused  rooms');
  for (const [agent, a] of [...byAgent].sort((x, y) => y[1].refused - x[1].refused))
    console.log(`  ${String(agent).padEnd(12)} ${String(a.sent).padStart(4)}  ${String(a.refused).padStart(7)}  ${[...a.rooms].join(',')}`);
  if (refused) {
    console.log('\nwhy the validator refused:');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
}
