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
const MAX_LINES = Number(process.env.M59_COLLISION_TRACE_MAX || 200_000);
let written = 0;
let complained = false;

/**
 * One move attempt. No-op — and cheap — unless the trace is on.
 *
 * `sent` is the whole point: false means the local validator refused and NOTHING went to
 * the wire, true means a packet left and the body still did not arrive. Everything else is
 * context for reading a run back afterwards.
 */
export function traceMove(detail) {
  if (!COLLISION_TRACE) return;
  if (written >= MAX_LINES) {
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] stopped at ${MAX_LINES} lines — ${TRACE_FILE}`);
    }
    return;
  }
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    // SPREAD FIRST, CLOCK LAST, so a caller's field can never take the timestamp's name.
    // It already did: the step call site passed `at: {col,row}` for the body's square, which
    // overwrote `at: Date.now()` and made every interval in the file read NaN. That is the
    // `emit(kind, data)` trap this repository already documents — a payload field silently
    // winning because it was spread over the thing it collided with — and it cost the timing
    // on the first capture of the bounce.
    appendFileSync(TRACE_FILE, JSON.stringify({ ...detail, at: Date.now() }) + '\n');
    written++;
  } catch { /* a trace that cannot be written must never break the walk it is watching */ }
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
  const rows = readFileSync(TRACE_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byAgent = new Map();
  const reasons = {};
  let sent = 0, refused = 0;
  for (const r of rows) {
    if (r.sent) sent++; else { refused++; reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1; }
    const a = byAgent.get(r.agent) ?? { sent: 0, refused: 0, rooms: new Set() };
    if (r.sent) a.sent++; else a.refused++;
    if (r.room != null) a.rooms.add(r.room);
    byAgent.set(r.agent, a);
  }
  console.log(`${rows.length} move attempt(s): ${sent} sent, ${refused} refused by our own validator\n`);
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
