#!/usr/bin/env node
// TALK TO THE PERSON WHO IS IN THE GAME, IN THE GAME.
//
//   node tools/m59-tell.mjs TESTER "stand on 22,32 and let them come"
//   node tools/m59-tell.mjs TESTER --file notes.txt        one tell per line
//   node tools/m59-tell.mjs TESTER "line one" "line two"   several, in order
//   node tools/m59-tell.mjs --as arena2 TESTER "..."       speak as somebody else
//
// THE POINT IS THE ALT-TAB. An operator standing in the world looking at a wall is the
// most expensive instrument this repository has — every geometric claim here has been
// wrong at least once and each was settled by a person saying what they saw — and the
// cost of using it was never the looking, it was the switching. Telling somebody
// "walk to 26,32 now" through a terminal they cannot see means they leave the game,
// read, come back, and lose the thing they were watching.
//
// THE CHANNEL IS `tell`, WHICH REACHES ANYWHERE. It needs no character in the room,
// no line of sight and no travel — which matters, because the alternative was walking a
// second character across the world to stand next to the first one and talk.
//
// IT COSTS ONE MANA PER RECIPIENT AND REFUSES SILENTLY WHEN SHORT. That is the trap:
// a refusal arrives as PROSE spoken to the speaker, never as an error on the wire, so a
// tell that never went out returns a perfectly successful-looking call. `echoed` is the
// server's own echo of the line and it is the only evidence it went; this reports
// `NOT ECHOED` rather than printing the text and letting you assume.
//
// THE SPEAKER IS A FLEET CHARACTER, so this needs a broker holding one. It is not a
// back door into the chat system — it is the ordinary `say` tool with `type: tell`,
// which any agent driving that character could call.
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.M59_BROKER_PORT || 8961);

export async function tell(to, text, { as = 'arena1', port = PORT, type = 'tell' } = {}) {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
                 params: { name: 'say', arguments: { agent: as, type, to, text } } };
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return { ok: false, why: `broker answered ${r.status}` };
  const j = await r.json();
  if (j.error) return { ok: false, why: j.error.message };
  let out = {};
  try { out = JSON.parse(j.result?.content?.[0]?.text ?? '{}'); } catch { /* not json */ }
  // ECHOED IS THE EVIDENCE, not `spoken` — `spoken` is only what we asked for.
  return { ok: !!out.echoed, echoed: out.echoed ?? null,
           messages: out.messages ?? [], to: out.to ?? null, mana: out.mana_cost ?? null };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-tell.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : d;
  };
  const as = flag('as', 'arena1');
  const port = Number(flag('port', PORT));
  const type = flag('type', 'tell');

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as' || argv[i] === '--port' || argv[i] === '--type' || argv[i] === '--file') { i++; continue; }
    rest.push(argv[i]);
  }
  const to = rest.shift();
  if (!to) {
    console.error('usage: node tools/m59-tell.mjs <character> "line" ["line" ...]');
    process.exit(2);
  }

  let lines = rest;
  const file = flag('file');
  if (file) lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) {
    console.error('nothing to say');
    process.exit(2);
  }

  let sent = 0, failed = 0;
  for (const line of lines) {
    const r = await tell(to, line, { as, port, type });
    if (r.ok) { sent++; console.log(`  -> ${line}`); }
    else {
      failed++;
      // THE FAILURE IS THE INTERESTING HALF and it is usually mana. Printed with the
      // line, because a partially delivered briefing is worse than none — the person
      // acts on the half that arrived.
      console.log(`  NOT ECHOED: ${line}`);
      if (r.why) console.log(`     ${r.why}`);
      for (const m of (r.messages ?? []).slice(0, 2)) console.log(`     server said: ${m}`);
    }
    await new Promise(res => setTimeout(res, 400));
  }
  console.log(`\n${sent} delivered${failed ? `, ${failed} NOT delivered` : ''} as ${as} -> ${to}`);
  process.exit(failed ? 1 : 0);
}
