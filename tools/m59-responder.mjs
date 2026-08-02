#!/usr/bin/env node
// Tier 1 as a separate process, reaching the broker over HTTP.
//
//   node tools/m59-broker.mjs --http 8899 &
//   node tools/m59-responder.mjs --broker http://127.0.0.1:8899
//   node tools/m59-responder.mjs --once --dry-run --verbose      # decide, print, say nothing
//
// This is the better of the two shapes when you can have it: the API key lives here and
// not in the broker, and if this process is compromised it holds no game tools.
//
// It is NOT available when the broker is a stdio MCP server — there is no endpoint to
// POST to, and starting a second broker would mean a second login on the same account,
// which the game refuses. For that case the same loop runs inside the broker:
// `converse {action: "respond"}`. See `m59-autorespond.mjs`.
//
// The instructions, the schema and the model call all live in `m59-respond-core.mjs`, so
// the two runners cannot drift apart. What is here is the transport and the loop.
//
// The security argument, for the record: this process calls exactly ONE tool, `inbox`,
// with three actions — read, reply, resolve. It cannot move a character, fight, trade,
// sell, broadcast, or log anything out, because those tools are not reachable from here
// and `inbox reply` derives the recipient and the channel from the stored record rather
// than from anything the model produced. The model call declares NO TOOLS and gets one
// turn. So the worst outcome of a completely successful injection is that a character
// says something stupid to the person who was talking to it.

import { createDecider, routeDecision, DEFAULT_MODEL } from './m59-respond-core.mjs';

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BROKER = flag('broker', process.env.M59_BROKER || 'http://127.0.0.1:8899');
// claude-opus-5 by default. This is a small task, but it is the one place in the system
// where an adversary writes the input, and the cheap failure mode (say something silly)
// and the expensive one (say something that reveals how the fleet works) are separated
// by judgement. Override with --model if you want to trade.
const MODEL = flag('model', process.env.M59_RESPONDER_MODEL || DEFAULT_MODEL);
const AGENT = flag('agent', null);
const POLL_MS = Number(flag('poll', '4000'));
const BATCH = Number(flag('limit', '8'));
const ONCE = has('once');
const DRY = has('dry-run');
const VERBOSE = has('verbose');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ...a);

// -------------------------------------------------------------------- transport

let rpcId = 0;

// One tool, three actions. If you are reading this file to check what the responder can
// reach, this function is the whole answer.
async function inbox(args) {
  const res = await fetch(BROKER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
                           params: { name: 'inbox', arguments: args } }),
  });
  if (!res.ok) throw new Error(`broker ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.error) throw new Error(`broker: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

// -------------------------------------------------------------------- one pass

async function pass(decide) {
  const read = await inbox({ action: 'read', state: 'escalated', limit: BATCH,
                             ...(AGENT ? { agent: AGENT } : {}) });
  const messages = read.messages ?? [];
  if (!messages.length) return 0;

  for (const m of messages) {
    if (VERBOSE) log(`[${m.agent}] ${m.from?.name ?? '?'} (${m.channel}): ${m.utterance}`);

    let out;
    try { out = await decide(m); }
    catch (e) { log(`  ! model call failed: ${e.message}`); continue; }  // stays escalated

    if (out.refused) {
      log(`  - ${m.id}: ${out.why}`);
      if (!DRY) await inbox({ action: 'resolve', agent: m.agent, id: m.id,
                              state: 'operator', note: out.why });
      continue;
    }

    const route = routeDecision(out.decision);
    if (route.act === 'resolve') {
      log(`  ${route.state === 'operator' ? '!' : '-'} ${m.id}: ${route.note}`);
      if (!DRY) await inbox({ action: 'resolve', agent: m.agent, id: m.id,
                              state: route.state, note: route.note });
      continue;
    }

    log(`  > ${m.id}: "${route.text}"  [${route.note}]`);
    if (DRY) continue;

    // `inbox reply` decides for itself who hears this and on which channel, checks the
    // rate limit, and refuses outright if the reply looks like it is leaking internals.
    // A rejection here is not an error — it is the boundary doing its job.
    const sent = await inbox({ action: 'reply', agent: m.agent, id: m.id, text: route.text });
    if (!sent.replied) {
      log(`    withheld: ${sent.why}`);
      if (!sent.retry) await inbox({ action: 'resolve', agent: m.agent, id: m.id,
                                     state: sent.state ?? 'refused', note: sent.why });
    }
  }
  return messages.length;
}

// ----------------------------------------------------------------------- main

log(`responder up — broker ${BROKER}, model ${MODEL}${AGENT ? `, agent ${AGENT}` : ''}` +
    `${DRY ? ', DRY RUN (nothing will be said)' : ''}`);

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
  log('note: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — the SDK will fall back to an ' +
      '`ant auth login` profile if one exists.');

// Build the decider first: a missing SDK or a missing key should be an error now, not a
// loop that fails silently every four seconds forever.
let decide;
try { decide = await createDecider({ model: MODEL }); }
catch (e) { log(`cannot start: ${e.message}`); process.exit(1); }

let stop = false;
process.on('SIGINT', () => { log('stopping'); stop = true; });

do {
  try {
    const n = await pass(decide);
    if (!n && !ONCE) await sleep(POLL_MS);
  } catch (e) {
    log(`pass failed: ${e.message}`);
    if (!ONCE) await sleep(POLL_MS);
  }
} while (!ONCE && !stop);
