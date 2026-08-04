#!/usr/bin/env node
// WHEN WAS NOBODY DRIVING — and which deaths happened then.
//
//   node tools/m59-uptime.mjs            # outages, longest first
//   node tools/m59-uptime.mjs deaths     # deaths marked against them
//
// WHY THIS EXISTS. A keeper is the only thing that makes a character act: without it the
// character stands exactly where it was, in whatever room it was in, and everything that
// was already swinging at it carries on. So a stopped keeper is not a pause, it is a
// character being held still in a fight — and a broker restart stops all twenty-one at
// once, which is why deaths arrive in waves.
//
// None of that was measurable. The broker log carries no timestamps at all, and the
// postmortem records what the character was doing without recording whether anything was
// driving it. So every death got attributed to a hunting decision, including the ones
// where the last decision had been made minutes earlier by a keeper that no longer
// existed. That is a bad way to judge a strategy: it charges the strategy for the
// operator's restarts.
//
// This is deliberately a SEPARATE ledger from the journal. The journal lives in the
// keeper, and a keeper that is gone cannot write "I am gone".
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const UPTIME_FILE = process.env.M59_UPTIME_FILE ||
  join(HERE, '..', 'substrate', 'keeper-uptime.jsonl');

// How long after a keeper comes back a death still counts as belonging to the outage.
// A character that has been standing still under attack for two minutes is usually
// already past saving when the keeper returns, and the first thing the keeper does is
// look around — so the death lands a few seconds after the resume, not before it.
export const GRACE_MS = 45_000;

export function record(agent, event, detail = {}) {
  try {
    mkdirSync(dirname(UPTIME_FILE), { recursive: true });
    appendFileSync(UPTIME_FILE, JSON.stringify({ at: Date.now(), agent, event, ...detail }) + '\n');
  } catch { /* never let bookkeeping break a keeper */ }
}

export function readLedger(file = UPTIME_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// Every window during which a given agent had nothing driving it. An outage that never
// closed is still an outage — it is reported with `open: true` rather than dropped,
// because "the keeper never came back" is the worst case and the easiest to miss.
export function outages(agent, ledger = readLedger(), now = Date.now()) {
  const mine = ledger.filter(e => e.agent === agent);
  const out = [];
  let downAt = null, why = null;
  for (const e of mine) {
    if (e.event === 'stop' && downAt == null) { downAt = e.at; why = e.why ?? null; }
    else if (e.event === 'start' && downAt != null) {
      out.push({ from: downAt, to: e.at, ms: e.at - downAt, why });
      downAt = null; why = null;
    }
  }
  if (downAt != null) out.push({ from: downAt, to: now, ms: now - downAt, why, open: true });
  return out;
}

// Was this character unattended when it died? Returns the outage it fell in, or null.
// Also catches deaths just AFTER a resume, for the reason in GRACE_MS.
export function outageAround(agent, at, ledger = readLedger()) {
  for (const o of outages(agent, ledger)) {
    if (at >= o.from && at <= o.to + GRACE_MS)
      return { ...o, died_ms_into_outage: at - o.from,
               after_resume: at > o.to ? at - o.to : 0 };
  }
  return null;
}

// ------------------------------------------------------------------- cli
const asScript = String(process.argv[1] ?? '').replace(/\\/g, '/');
if (import.meta.url.endsWith(asScript)) {
  const ledger = readLedger();
  if (!ledger.length) { console.log('no uptime ledger yet — it starts filling once a keeper stops or starts'); process.exit(0); }
  const agents = [...new Set(ledger.map(e => e.agent))];
  if (process.argv[2] === 'deaths') {
    const dir = join(HERE, '..', 'substrate', 'postmortems');
    const fs = await import('node:fs');
    const files = existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    let marked = 0, total = 0;
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(join(dir, f), 'utf8'));
      if (d.reason !== 'died' || !d.at || !d.agent) continue;
      total++;
      const o = outageAround(d.agent, d.at, ledger);
      if (o) { marked++;
        console.log(`* ${d.character} ${new Date(d.at).toISOString().slice(11, 19)} — ` +
          `${Math.round(o.died_ms_into_outage / 1000)}s into an outage of ${Math.round(o.ms / 1000)}s` +
          (o.after_resume ? ` (${Math.round(o.after_resume / 1000)}s after the keeper came back)` : '')); }
    }
    console.log(`\n${marked} of ${total} deaths happened with nothing driving the character (${total ? (100 * marked / total).toFixed(0) : 0}%)`);
  } else {
    const all = agents.flatMap(a => outages(a).map(o => ({ ...o, agent: a })))
                      .sort((x, y) => y.ms - x.ms);
    console.log(`${all.length} outages across ${agents.length} agents, longest first:`);
    for (const o of all.slice(0, 20))
      console.log(`  ${o.agent.padEnd(4)} ${Math.round(o.ms / 1000).toString().padStart(5)}s  ` +
                  `${new Date(o.from).toISOString().slice(11, 19)}${o.open ? '  STILL DOWN' : ''}  ${o.why ?? ''}`);
  }
}
