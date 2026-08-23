// WHICH RUNG ANSWERED, AND HOW LONG IT KEPT ANSWERING.
//
//   M59_KEEPER_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971
//   node tools/m59-keeper-trace.mjs                 # read it back
//   node tools/m59-keeper-trace.mjs --agent shadow01 --full
//   node tools/m59-keeper-trace.mjs --clear
//
// WHY THIS EXISTS. The keeper is a ladder of eight stages walked in order, short-circuiting
// on the first one that says it dealt with the tick. Every instrument we have reports the
// RESULT of that walk — `mode`, `activity`, the journal — and none of them reports the walk.
// So a character sitting at `mode idle` for six minutes holding a live objective looks
// identical whether:
//
//   - an early stage is returning HANDLED every pass and the later ones never run,
//   - the stage that would act is running and declining silently,
//   - or the ladder is not being walked at all because the keeper is parked inside one await.
//
// Those are three different bugs with one symptom, and this session spent three rounds
// tuning thresholds inside the third stage before establishing that the first stage was
// ending every tick. `recovering_from_death` in `passUnderworld` returns HANDLED while a
// character mends, and `resumeSuspendedJourney` lives in `passFarm`, which is last — so a
// character that had died could not resume no matter what its own gates said.
//
// THE RUN-LENGTH IS THE POINT, NOT THE VOLUME. A pass runs about once a second per
// character, and twenty-one characters writing eight verdicts each would be a hundred and
// sixty rows a second — a file nobody reads and a disk nobody wanted spent. What is
// diagnostic is not each pass, it is each CHANGE: the shape of a decision, and how many
// passes and seconds it held. A character stuck for six minutes should be ONE row saying
// so, which is also the form that makes the stuck case obvious rather than buried.
//
// `M59_KEEPER_TRACE_ALL=1` writes every pass instead, for when the question is about a
// handful of seconds rather than a stall.
//
// OFF BY DEFAULT AND FREE WHEN OFF: every entry point returns on the first line.

import { appendFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const KEEPER_TRACE = process.env.M59_KEEPER_TRACE === '1';
const EVERY_PASS = process.env.M59_KEEPER_TRACE_ALL === '1';
export const TRACE_FILE = process.env.M59_KEEPER_TRACE_FILE
  || join(REPO, 'substrate', 'keeper-trace.jsonl');

// Same argument as the collision tracer: an unbounded debug file on the machine running the
// fleet is a way to fill a disk while looking like nothing is happening.
const configured = Number(process.env.M59_KEEPER_TRACE_MAX || 200_000);
const MAX_LINES = Number.isSafeInteger(configured) && configured > 0 ? configured : 200_000;
let written = 0;
let complained = false;

// One open run per character. A run is "the same decision, still being made".
const open = new Map();

function write(row) {
  if (written >= MAX_LINES) {
    if (!complained) {
      complained = true;
      console.error(`[keeper-trace] stopped at ${MAX_LINES} lines — ${TRACE_FILE}`);
    }
    return;
  }
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    // SPREAD FIRST, CLOCK LAST — the `emit(kind, data)` trap this repository documents, and
    // the one that made every interval in the first collision capture read NaN.
    appendFileSync(TRACE_FILE, JSON.stringify({ ...row, at: Date.now() }) + '\n');
    written++;
  } catch { /* a trace that cannot be written must never break the keeper it is watching */ }
}

/**
 * The shape of one decision. Two passes with the same shape are the same situation
 * continuing, and are worth one row between them rather than two.
 *
 * Deliberately coarse. Health changes every pass and is not a decision; the STAGE that
 * answered, the room, and what the character thinks it is doing are. Health is carried on
 * the row anyway — first and last — because "stuck and mending" and "stuck and flat" are
 * different findings and the run-length is where that shows.
 */
function shapeOf(d) {
  return [d.decided_by ?? 'none', d.room ?? '?', d.mode ?? '?', d.doing ?? '?',
          d.suspended_to ?? '-', d.holding ? 'hold' : '-'].join('|');
}

function flush(who, next = null) {
  const run = open.get(who);
  if (!run) return;
  const passes = run.lastPass - run.firstPass + 1;
  write({
    kind: 'ladder',
    who,
    decided_by: run.d.decided_by,
    room: run.d.room,
    mode: run.d.mode,
    doing: run.d.doing,
    suspended_to: run.d.suspended_to ?? null,
    holding: !!run.d.holding,
    // WHAT RAN BEFORE THE ONE THAT ANSWERED. The whole question this file exists for is
    // "which rung never got a turn", and that is only answerable if the ones that did are
    // named. Recorded from the first pass of the run: within a run the path is stable by
    // construction, because the stage that answered is part of the shape.
    ran: run.d.ran ?? null,
    first_pass: run.firstPass,
    last_pass: run.lastPass,
    passes,
    held_s: Math.round((run.lastAt - run.firstAt) / 100) / 10,
    health_from: run.firstHealth,
    health_to: run.d.health ?? null,
    vigor_to: run.d.vigor ?? null,
    // A run that ends because something changed says what it changed TO, so the file reads
    // as a sequence rather than as a pile of unrelated observations.
    then: next,
  });
  open.delete(who);
}

/**
 * One walk of the ladder.
 *
 * `ran` is the ordered list of stages that were actually entered, `decided_by` the one that
 * returned HANDLED (or null when every stage passed and the tick fell out of the bottom).
 */
export function traceLadder(detail) {
  if (!KEEPER_TRACE) return;
  try {
    const who = detail.who ?? '?';
    if (EVERY_PASS) { write({ kind: 'pass', ...detail }); return; }
    const shape = shapeOf(detail);
    const run = open.get(who);
    if (run && run.shape === shape) {
      run.lastPass = detail.pass ?? run.lastPass;
      run.lastAt = Date.now();
      run.d = detail;
      return;
    }
    flush(who, shape === (run?.shape ?? null) ? null : (detail.decided_by ?? 'none'));
    open.set(who, {
      shape, d: detail,
      firstPass: detail.pass ?? 0, lastPass: detail.pass ?? 0,
      firstAt: Date.now(), lastAt: Date.now(),
      firstHealth: detail.health ?? null,
    });
  } catch { /* never break the keeper */ }
}

/**
 * A decision that is not a stage verdict — a gate inside one, declining or firing.
 *
 * Always written, never run-length collapsed: these are rare by construction and each one
 * is a sentence about why something did not happen.
 */
export function traceDecision(who, what, detail = {}) {
  if (!KEEPER_TRACE) return;
  try { write({ kind: 'decision', who, what, ...detail }); }
  catch { /* never break the keeper */ }
}

/** Close every open run, so a trace read after a shutdown is not missing its last rows. */
export function flushKeeperTrace() {
  if (!KEEPER_TRACE) return;
  for (const who of [...open.keys()]) flush(who);
}
if (KEEPER_TRACE) process.once('exit', () => { try { flushKeeperTrace(); } catch {} });

// ------------------------------------------------------------------ reading it back

if (process.argv[1]?.endsWith('m59-keeper-trace.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  if (argv.includes('--clear')) {
    if (existsSync(TRACE_FILE)) unlinkSync(TRACE_FILE);
    console.log('cleared');
    process.exit(0);
  }
  if (!existsSync(TRACE_FILE)) {
    console.log(`no keeper trace at ${TRACE_FILE}`);
    console.log('turn it on for one run:');
    console.log('  M59_KEEPER_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 --dashboard 8972');
    process.exit(0);
  }
  let malformed = 0;
  const rows = readFileSync(TRACE_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { malformed++; return null; } }).filter(Boolean);
  const only = flag('agent');
  const full = argv.includes('--full');

  const ladder = rows.filter(r => r.kind === 'ladder' && (!only || r.who === only));
  const decisions = rows.filter(r => r.kind === 'decision' && (!only || r.who === only));

  // WHICH RUNG ENDS THE TICK, AND FOR HOW LONG. Seconds rather than counts, because a stage
  // that answers once and holds for six minutes and a stage that answers three hundred
  // times in three hundred seconds are the same number of rows and very different bugs.
  const byStage = new Map();
  for (const r of ladder) {
    const k = r.decided_by ?? 'fell through';
    const e = byStage.get(k) ?? { runs: 0, passes: 0, secs: 0, rooms: new Set() };
    e.runs++; e.passes += r.passes ?? 0; e.secs += r.held_s ?? 0;
    if (r.room != null) e.rooms.add(r.room);
    byStage.set(k, e);
  }
  console.log(`${ladder.length} decision run(s)${only ? ` for ${only}` : ''}` +
              `${malformed ? `, ${malformed} malformed line(s)` : ''}\n`);
  console.log('  stage that ended the tick        runs   passes   seconds  rooms');
  for (const [k, e] of [...byStage.entries()].sort((a, b) => b[1].secs - a[1].secs))
    console.log('  ' + k.padEnd(30) + String(e.runs).padStart(5)
                + String(e.passes).padStart(9) + String(Math.round(e.secs)).padStart(10)
                + '  ' + [...e.rooms].join(','));

  // THE LONGEST HOLDS, WHICH IS WHERE A STALL IS. Anything a character did for a long time
  // without the shape changing is either the answer or the bug.
  const longest = [...ladder].sort((a, b) => (b.held_s ?? 0) - (a.held_s ?? 0)).slice(0, full ? 60 : 12);
  console.log('\n  the longest a single decision held:');
  console.log('    who        s     passes  room  stage                    mode/doing        health');
  for (const r of longest) {
    const hp = r.health_from != null && r.health_to != null
      ? `${Math.round(r.health_from * 100)}%->${Math.round(r.health_to * 100)}%` : '';
    console.log('    ' + String(r.who ?? '?').padEnd(10)
                + String(Math.round(r.held_s ?? 0)).padStart(5)
                + String(r.passes ?? 0).padStart(10)
                + String(r.room ?? '?').padStart(6) + '  '
                + String(r.decided_by ?? 'fell through').padEnd(24)
                + `${r.mode ?? '?'}/${r.doing ?? '?'}`.padEnd(18) + hp
                + (r.suspended_to != null ? `  susp->${r.suspended_to}` : ''));
    if (full && r.ran) console.log('              ran: ' + r.ran.join(' -> '));
  }

  if (decisions.length) {
    console.log(`\n  ${decisions.length} named decision(s):`);
    for (const d of decisions.slice(full ? 0 : -25)) {
      const { kind, who, what, at, ...rest } = d;
      console.log(`    ${String(who).padEnd(10)} ${what}  ${JSON.stringify(rest).slice(0, 150)}`);
    }
  }
}
