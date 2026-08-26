#!/usr/bin/env node
// FAMOUS LAST WORDS. A character that is about to die says something first.
//
//   node tools/m59-lastwords.mjs --agent t2                 watch Pepe, speak when doomed
//   node tools/m59-lastwords.mjs --agent t2 --dry-run       decide, print, send nothing
//   node tools/m59-lastwords.mjs --agent t2 --below 0.25    floor: speak under this fraction
//   node tools/m59-lastwords.mjs --agent t2 --doomed-in 3   speak this many seconds from dead
//   node tools/m59-lastwords.mjs --agent t2 --broadcast     the whole server hears it
//   node tools/m59-lastwords.mjs --agents t1,t2,t5          several, one process
//   node tools/m59-lastwords.mjs --all --port 8971          everyone this broker holds
//   node tools/m59-lastwords.mjs --all --stuck              also speak on being stuck
//   node tools/m59-lastwords.mjs --list                     the rotation, and what is left
//   node tools/m59-lastwords.mjs --reset                    start the rotation over
//
// ONE PROCESS FOR A WHOLE FLEET, because the alternative is twenty-one of them and the
// rotation is on disk: twenty-one processes each hold their own copy of the spent list in
// memory, write over each other, and the exhaustive rotation the section below argues for
// stops being exhaustive. The rotation is shared and the COOLDOWN is per character, which
// is the right way round — a fight that drops four characters at once should produce four
// different lines, not the same one four times.
//
// WHY THIS IS NOT IN THE KEEPER. The keeper's survival ladder decides at one second and is
// the thing that keeps a character alive; it has no business also being a comedian, and a
// `say` on the wire is one more thing that can throw inside a pass that must not throw.
// This watches from outside, speaks, and cannot affect the ladder either way. If this
// process dies the character is exactly as safe as it was.
//
// THE ROTATION IS EXHAUSTIVE, NOT RANDOM. Random repeats, and a bot that says the same line
// three deaths running reads as broken rather than funny. Every line is used once before any
// is used twice, and the spent list is on disk so it survives a restart of this script.
//
// IT SPEAKS IN THE ROOM, NOT AT THE SERVER. `say` is heard by whoever is standing there,
// which is the audience. `yell` and `broadcast` reach people who did not ask to hear it,
// and prod is a shared server with real players on it — see CLAUDE.md. `--yell` if you
// really mean it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '..', 'substrate', 'lastwords.json');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PORT = Number(arg('port', 8901));
// `--agent` stays singular and unchanged; `--agents` is a list; `--all` asks the broker.
// Three spellings rather than redefining the one that is already in scripts elsewhere.
const AGENT = arg('agent', null);
const AGENTS = (arg('agents', null) ?? '').split(',').map(x => x.trim()).filter(Boolean);
const ALL = has('all');
// SPEAKING BECAUSE YOU ARE STUCK IS A DIFFERENT TRIGGER FROM SPEAKING BECAUSE YOU ARE DYING,
// and it is off by default. A stuck character is stuck for as long as nobody comes, so this
// fires ONCE PER EPISODE — on the edge into stuck — rather than every cooldown, or the
// rotation is spent in an hour by one character standing still against a wall.
const ON_STUCK = has('stuck');
const BELOW = Number(arg('below', 0.15));       // health fraction that counts as doomed
// HOW CLOSE TO DEAD IS "ABOUT TO DIE". A fraction alone is the wrong instrument: 12 health
// with nothing in the room is a character resting, and 12 health with a troll swinging is a
// character with a second and a half left, and `--below` cannot tell them apart. It fires
// the same in both, which is why the lines were landing thirty seconds early and the
// character then wandered off and lived.
//
// So the fraction becomes a floor and the RATE becomes the trigger: health divided by how
// fast it is going down is a time-to-zero in seconds, and under this many seconds is the
// moment worth speaking at. Whichever fires first wins.
const DOOMED_IN = Number(arg('doomed-in', 3));
const EVERY = Number(arg('every', 1000));       // poll interval, ms — the rate below is
                                               // measured across it, so a slow poll both
                                               // blurs the rate and delays the line
const COOLDOWN = Number(arg('cooldown', 45000));
const DRY = has('dry-run');
// say (default, the room only) < yell (nearby) < broadcast (everyone on the server).
// Broadcast is opt-in and stays opt-in: prod is shared with real players who did not ask
// to hear a bot die, so the loud channel is something an operator chooses out loud.
const CHANNEL = has('broadcast') ? 'broadcast' : has('yell') ? 'yell' : 'say';

// {attacker} is filled with whatever is about to do it — "Trolls are friendly... right?".
// A line without the token works anywhere, which most of them do.
const LINES = [
  'Your floor is clean.',
  'Trouble... is... a family game.',
  'Clever girl...',
  '{Attacker}s are friendly... right? I think they are friendly.',
  'I am invincible!',
  'I am a leaf on the wind.',
  'Hey... when did my shirt turn red?',
  'I mean, crap man, look at that. That is like my stomach plug, on the ground back there. ' +
    'You do not see that every day. I mean that does not really even seem possible if you ' +
    'think about it, with body organs and cartilage and bones. I mean I am no doctor, but ' +
    'it was like one clean chunk.',
  'I am bleeding, making me the victor',
  'But, is not Betty a woman’s name?',
  'I must take my place in the great circle of... stuff.',
  'Oh, again with the squeaky shoes.',
  'They call me Wimp Lo.',
  // ---- the rest of the rotation
  'This is fine. This is a normal amount of {attacker}.',
  'I have made a tactical decision to be over there instead.',
  'Tell the fleet I went down facing the wrong way.',
  'The pathfinder said this was a shortcut.',
  'I regret every step since Tos.',
  'Somebody write down the room number.',
  'It is not a bug if I do it on purpose. I am doing this on purpose.',
  'Ah — so THAT is what that room does.',
  'My health bar was more of a suggestion anyway.',
  'I would like a word with whoever wrote my movement code.',
  'Twenty max health and a dream.',
  'Do not follow me. Seriously. Do not follow me.',
  'I am not stuck, I am gathering data.',
  'This counts as arriving if you squint.',
  'Log it as inconclusive.',
  'The good news is I found the {attacker}s.',
  'Put me down as "arrived, briefly".',
  'I have one more idea and it is a bad one.',
  'Route confirmed. Survival: pending.',
  'Every map needs a landmark. I volunteer.',
];

const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { used: [] }; } };
const save = (s) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };

// Every line once before any line twice. When the pool empties it refills MINUS the line
// just spoken, so the wrap-around cannot repeat across the seam either.
function nextLine(state) {
  let left = LINES.filter((l) => !state.used.includes(l));
  if (!left.length) {
    state.used = state.last ? [state.last] : [];
    left = LINES.filter((l) => !state.used.includes(l));
  }
  const line = left[Math.floor(Math.random() * left.length)];
  state.used.push(line);
  state.last = line;
  return line;
}

const fill = (line, attacker) => line
  .replace(/\{Attacker\}/g, String(attacker).replace(/^./, (c) => c.toUpperCase()))
  .replace(/\{attacker\}/g, String(attacker));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
  const t = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(String(t).slice(0, 160));
  try { return JSON.parse(t); } catch { return t; }
}

if (has('reset')) { save({ used: [] }); console.log(`rotation reset — all ${LINES.length} lines available`); process.exit(0); }
if (has('list')) {
  const s = load();
  console.log(`${LINES.length} lines, ${LINES.length - s.used.length} unused`);
  for (const l of LINES) console.log(' ', s.used.includes(l) ? '.' : '>', l.slice(0, 92));
  process.exit(0);
}
if (!AGENT && !AGENTS.length && !ALL) {
  console.error('need --agent t2, --agents t1,t2, or --all');
  process.exit(2);
}

// WHAT IS ABOUT TO DO IT. The room view is the only place an attacker's NAME appears.
// Scenery and our own fleet are filtered out and the nearest thing wins; unknown is fine,
// the token degrades to "something" and most lines never use it.
const SCENERY = /stool|barrel|urn|pot|sign|table|brazier|news|mug|bench|chair|torch|candle|rug|shelf|door|fountain|statue/i;
async function attackerNear(agent) {
  try {
    const l = await call('look', { agent });
    const mobs = (l.objects || []).filter((o) => !o.is_player && o.name && !SCENERY.test(o.name));
    if (!mobs.length) return null;
    mobs.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
    return mobs[0].name;
  } catch { return null; }
}

const frac = (h) => { const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(h ?? '')); return m ? Number(m[1]) / Number(m[2]) : null; };
// PER CHARACTER, not one number for the fleet. A shared cooldown would mean the first
// character to nearly die silences the other twenty for the next forty-five seconds, which
// is exactly backwards: a wipe is when you most want to hear from everybody.
const spokeAt = new Map();
const wasStuck = new Map();
// The previous sample, per character, so the drop between polls is measurable. One sample
// back rather than an average: a smoothed rate lags exactly when it matters, and the last
// two seconds is what the next two seconds looks like.
const lastSeen = new Map();
// HELD IN MEMORY, WRITTEN ONLY WHEN WE ACTUALLY SPEAK. Re-reading the file per line meant a
// dry run reloaded an empty spent-list every poll and repeated itself within four samples —
// so the one rehearsal that is supposed to prove the rotation could not show it. A dry run
// now exhausts the rotation exactly as the real thing does; it just never touches the disk.
const state = load();
const who = AGENT ? [AGENT] : AGENTS.length ? AGENTS : null;   // null means "ask the broker"
console.log(`watching ${who ? who.join(', ') : 'everyone on port ' + PORT}: ` +
            `speaks under ${Math.round(BELOW * 100)}% health${ON_STUCK ? ' and on going stuck' : ''} ` +
            `via ${CHANNEL}${DRY ? ' (dry run)' : ''}; ` +
            `${LINES.length - state.used.length} of ${LINES.length} lines unused`);

async function speak(row, why, secondsLeft = Infinity) {
  const attacker = why === 'stuck' ? null : await attackerNear(row.agent);
  const line = fill(nextLine(state), attacker || 'something');
  const stamp = new Date().toISOString().slice(11, 19);
  const when = Number.isFinite(secondsLeft) ? ` ~${secondsLeft.toFixed(1)}s left` : '';
  console.log(`${stamp} ${row.character} ${why === 'stuck' ? 'STUCK' : 'at ' + row.health + when} in ${row.room}` +
              (attacker ? ` (nearest: ${attacker})` : '') + ` -> ${CHANNEL}: ${line}`);
  spokeAt.set(row.agent, Date.now());
  if (DRY) return;
  try { await call('say', { agent: row.agent, text: line, type: CHANNEL }); save(state); }
  catch (e) { console.log('  say failed:', String(e.message).slice(0, 90)); }
}

for (;;) {
  await new Promise((r) => setTimeout(r, EVERY));
  let rows = [];
  try {
    const f = await call('fleet', {});
    rows = (f.fleet || []).filter((x) => !who || who.includes(x.agent));
  } catch { continue; }

  for (const row of rows) {
    if (row.in_game === false) continue;

    // STUCK FIRST, and only on the EDGE. `stuck` is null or an object on every kind of
    // broker — see the fleet row — so this is the one branch that does not have to know
    // whether an in-process pilot or a keeper process answered.
    if (ON_STUCK) {
      const now = !!row.stuck;
      const before = wasStuck.get(row.agent) ?? false;
      wasStuck.set(row.agent, now);
      if (now && !before) { await speak(row, 'stuck'); continue; }
    }

    const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(row.health ?? ''));
    if (!m) { lastSeen.delete(row.agent); continue; }
    const hp = Number(m[1]), max = Number(m[2]), now = Date.now();
    const prev = lastSeen.get(row.agent);
    lastSeen.set(row.agent, { hp, at: now });

    // Health per second, and only when it is going DOWN. Resting, a heal and a level-up
    // all make this negative, and a negative rate projected forward says a character is
    // about to die of getting better.
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const rate = prev && dt > 0.5 && hp < prev.hp ? (prev.hp - hp) / dt : 0;
    const secondsLeft = rate > 0 ? hp / rate : Infinity;

    // ALREADY DEAD IS NOT ABOUT TO DIE. The Underworld is where a corpse lands, and it
    // arrives there at 2 health and regenerates, so both tests below fire on it — measured,
    // four of the first five lines were spoken by characters who had died some seconds
    // earlier. Last words after the fact are not last words.
    if (/underworld/i.test(String(row.room ?? ''))) continue;

    // AND YOU ONLY GET LAST WORDS IF SOMETHING IS ACTUALLY KILLING YOU. `--below` on its
    // own fires on a character sitting quietly at 14% waiting to heal, which is where the
    // early, unearned lines were coming from. Losing health is the whole premise, so it
    // gates both branches: the projection says HOW CLOSE, the floor catches a hit so large
    // that one sample is the only warning there will ever be.
    if (rate <= 0) continue;
    const doomed = secondsLeft <= DOOMED_IN || hp / max <= BELOW;
    if (!doomed) continue;
    if (Date.now() - (spokeAt.get(row.agent) ?? 0) < COOLDOWN) continue;
    await speak(row, 'doomed', secondsLeft);
  }
}
