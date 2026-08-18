#!/usr/bin/env node
// LET THE PERSON IN THE GAME SAY "NOW" WITHOUT LEAVING THE GAME.
//
//   node tools/m59-signal.mjs                     listen and print, one line per event
//   node tools/m59-signal.mjs --wait F5           block until F5, print it, exit 0
//   node tools/m59-signal.mjs --wait F5 --timeout 300
//   node tools/m59-signal.mjs --tail              replay the book, then listen
//   node tools/m59-signal.mjs --last 20           just the book, no listening
//
// THE PROBLEM THIS SOLVES IS A CLOCK, NOT A FEATURE. Collecting a sample with a human in
// the loop means an agent starts a recording, the person does the thing, and the person
// then has to alt-tab out of a live game to a terminal to say they are done — which
// takes seconds, lands in the middle of whatever the agent is writing, and puts a ragged
// tail on every recording that then has to be trimmed by guesswork. A keypress inside
// the client costs nothing and is exact to the frame.
//
// UDP, AND THE REASONS ARE ALL ABOUT THE OTHER END. The sender is inside the client's
// message loop (clientd3d/m59dbg.c) holding a live game session. A TCP connect can
// block; a datagram cannot. A listener that is not running must cost the client nothing;
// with UDP there is no connection to fail. And a dropped packet costs one notification,
// which is the cheapest possible failure for a debugging aid.
//
// LOOPBACK ONLY, bound to 127.0.0.1 rather than 0.0.0.0. This process learns which
// character is standing where, five times a room change; it is not a thing to put on an
// interface. There is no authentication and there should not be one — the security model
// is the same as the maintenance socket's, and it is the loopback bind.
//
// EVERY EVENT IS WRITTEN DOWN. `substrate/client-signals.jsonl` is append-only and
// gitignored: it names a character and its position, which is the same class of secret
// as the grudge book. It exists because "I pressed it and nothing happened" and "I
// pressed it and the listener was not running" are the same experience and different
// bugs, and only the book tells them apart.
import dgram from 'node:dgram';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNAL_PORT = Number(process.env.M59_SIGNAL_PORT || 8907);
export const SIGNAL_FILE = process.env.M59_SIGNAL_FILE ||
  fileURLToPath(new URL('../substrate/client-signals.jsonl', import.meta.url));

/**
 * Parse one datagram.
 *
 * A MALFORMED DATAGRAM IS RECORDED, NOT DROPPED. Anything at all can send to a UDP port,
 * and a listener that silently discards what it cannot parse is indistinguishable from
 * one that is not running — which is precisely the confusion this tool exists to end.
 */
export function parseSignal(buf) {
  const text = String(buf).trim();
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object') return { ok: true, ...v };
  } catch { /* fall through */ }
  return { ok: false, kind: 'unparseable', raw: text.slice(0, 200) };
}

/**
 * One line a human can read at a glance, and a Monitor can grep.
 *
 * The kind comes FIRST and in capitals because these lines arrive in the middle of other
 * output and the eye needs an anchor; the position comes last because it is the part
 * that will be copied into another command.
 */
export function formatSignal(s) {
  if (!s.ok) return `SIGNAL ?? unparseable: ${s.raw}`;
  const who = s.account ? ` ${s.account}` : '';
  const what = s.detail ? ` ${s.detail}` : '';
  const where = Number.isFinite(s.room)
    ? ` room ${s.room} sq ${s.row},${s.col} fine ${s.fine_x},${s.fine_y}`
    : '';
  return `SIGNAL ${String(s.kind ?? '?').toUpperCase()}${what}${who}${where}`;
}

export function record(s, file = SIGNAL_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: Date.now(), ...s }) + '\n');
  } catch { /* the book is a convenience; losing it must not cost the notification */ }
}

export function readBook(file = SIGNAL_FILE, limit = 20) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } })
              .filter(Boolean);
}

/**
 * Listen. Calls `onSignal` for every datagram; resolves when `until` returns true.
 *
 * `until` rather than a hard-coded key so the same loop serves "print for ever" and
 * "block until F5" — two modes with one code path, because two loops is how the
 * printing one ends up with a bug the waiting one does not.
 */
export function listen({ port = SIGNAL_PORT, onSignal = null, until = null } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closing */ }
      resolve(value);
    };
    sock.on('error', err => { if (!done) { done = true; try { sock.close(); } catch {} reject(err); } });
    sock.on('message', buf => {
      const s = parseSignal(buf);
      onSignal?.(s);
      if (until?.(s)) finish(s);
    });
    sock.bind(port, '127.0.0.1', () => {
      if (!until) resolve({ listening: true, sock, close: () => finish(null) });
    });
  });
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-signal.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  const port = Number(flag('port', SIGNAL_PORT));

  if (has('last')) {
    for (const s of readBook(SIGNAL_FILE, Number(flag('last', 20))))
      console.log(new Date(s.at).toISOString().slice(11, 19) + '  ' + formatSignal(s));
    process.exit(0);
  }

  if (has('tail'))
    for (const s of readBook(SIGNAL_FILE, Number(flag('tail', 10))))
      console.log(new Date(s.at).toISOString().slice(11, 19) + '  ' + formatSignal(s) + '  (replay)');

  const wantKey = flag('wait');
  const timeout = Number(flag('timeout', 0));

  const emit = s => {
    record(s);
    console.log(formatSignal(s));
  };

  if (wantKey) {
    // EXIT CODE IS THE ANSWER, because the caller is usually a script or an agent that
    // needs to know whether the person actually pressed it: 0 pressed, 3 timed out.
    // A timeout that exits 0 would read as "they said go" to everything downstream.
    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => {
        console.log(`no ${wantKey} within ${timeout}s`);
        process.exit(3);
      }, timeout * 1000);
      timer.unref?.();
    }
    console.log(`waiting for ${wantKey} on udp 127.0.0.1:${port} — press it in the game`);
    listen({ port, onSignal: emit,
             until: s => s.ok && s.kind === 'key'
                      && String(s.detail).toUpperCase() === wantKey.toUpperCase() })
      .then(() => { if (timer) clearTimeout(timer); process.exit(0); })
      .catch(err => { console.error(`cannot listen on ${port}: ${err.message}`); process.exit(2); });
  } else {
    console.log(`listening on udp 127.0.0.1:${port} — F5..F8 in the client, and every room change`);
    listen({ port, onSignal: emit })
      .catch(err => { console.error(`cannot listen on ${port}: ${err.message}`); process.exit(2); });
  }
}
