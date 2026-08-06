#!/usr/bin/env node
// WHAT EACH CHARACTER IS, WRITTEN DOWN WHERE LOSING THE SERVER CANNOT TAKE IT.
//
//   node tools/m59-sheet.mjs                    every character in the fleet
//   node tools/m59-sheet.mjs --agent t10        just that one
//   node tools/m59-sheet.mjs --checkpoint       also file a timestamped copy
//   node tools/m59-sheet.mjs --agent t10 --print   show it, write nothing
//
// Sheets land in substrate/sheets/<Character>.json, and --checkpoint additionally files
// substrate/sheets/checkpoints/<Character>-<stamp>.json so a series survives.
//
// WHY THIS EXISTS: THE CHECKPOINT MECHANISM DOES NOT COVER THIS FLEET.
//
// m59-shutdown.mjs copies the server's savegame directory aside before stopping. That
// works for the local containerised server and does nothing at all for `prod`, which
// lives on 76.214.42.186 — every one of the fleet's connections is OUTBOUND and nothing
// is listening locally. Running it against prod copies a stale save from an unrelated
// local install and reports success, which is worse than reporting nothing.
//
// We cannot snapshot a server we do not run. What we CAN snapshot is everything each
// character knows about itself, which is most of what a re-roll would need to be told.
//
// NO, THIS IS NOT BYTE-COMPATIBLE WITH THE SERVER'S SAVE, AND IT CANNOT BE.
//
// SaveGame (blakserv/savegame.c:97) writes a whole-VM image in a private binary format:
//
//   SaveClasses()    every class id, name and property-name table   savegame.c:141
//   SaveResources()  every dynamic resource                         savegame.c:171
//   SaveSystem()     the system node                                savegame.c:178
//   SaveObjects()    every object with all of its properties        savegame.c:199
//   SaveListNodes()  every list cell in the world                   savegame.c:214
//   SaveTimers()     every pending timer                            savegame.c:250
//   SaveUsers()      every account                                  savegame.c:268
//
// A client sees none of that. It sees its own stats, its own inventory, its own ability
// numbers, and the ids and names of things in the room with it — a thin projection of one
// object out of a graph containing every object in the world. Even for its OWN character
// the protocol never sends most of the kod properties the save records. Producing a
// loadable save from here would mean fabricating the parts we cannot see, and a savegame
// that is 5% observed and 95% invented is not a backup, it is a way to corrupt a world.
//
// So the format is JSON, and it is written to be read by a person or a model with no
// prior knowledge: every block carries its own units and provenance, because a number
// whose meaning has to be looked up elsewhere is a number that will be misread. `vigor`
// is the standing example — it is out of 200, not out of a `max` field, and reading it
// like health has silently disabled vigor decisions in this repository more than once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
export const SHEET_DIR = path.join(REPO, 'substrate', 'sheets');
const BROKER_PORT = process.env.M59_BROKER_PORT || '8901';
const BROKER = `http://127.0.0.1:${BROKER_PORT}/`;

async function broker(name, args = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BROKER, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(j.result.content[0].text);
    return JSON.parse(j.result.content[0].text);
  } finally { clearTimeout(t); }
}

// THE ABILITY CACHE IS A SECOND SOURCE, AND IT OUTLIVES THE SESSION.
//
// substrate/abilities/<name>.json is written by the keeper and holds `best` — the highest
// each ability has ever been seen at. A sheet taken while a character is out of game
// still gets its skills from here, which is the difference between a checkpoint that
// covers 21 characters and one that covers whichever 14 happened to be logged in.
export function readAbilityCache(character) {
  const f = path.join(REPO, 'substrate', 'abilities', `${character}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const pctOf = (v) => (v && v.max ? Math.round((100 * v.value) / v.max) : null);

// One sheet. `live` is what the broker answered; `cached` is the on-disk ability record.
// Either may be missing, and the sheet says which of them each block came from rather
// than presenting a merged result as though it were all equally fresh.
export function buildSheet({ character, agent, status, abilities, equipment, inventory, cached, at = 0 }) {
  const vitals = status?.vitals ?? {};
  const attrs = status?.attributes ?? {};
  const cachedSkills = cached?.skills ?? {};
  const cachedSpells = cached?.spells ?? {};

  // Ability rows, live first and the cache filling the gaps. `best` only ever comes from
  // the cache: it is a record across sessions and the live read cannot know it.
  const rows = (liveList, cachedMap, kind) => {
    const out = new Map();
    for (const r of liveList || []) {
      if (!r?.name) continue;
      const c = cachedMap[r.name] ?? {};
      out.set(r.name, {
        name: r.name, ability: r.ability ?? null, id: r.id ?? c.id ?? null,
        ...(kind === 'spell' && r.school ? { school: r.school } : {}),
        ...(kind === 'spell' && r.targets != null ? { targets: r.targets } : {}),
        best_ever: c.best ?? r.ability ?? null,
        first_seen: c.first ?? null, last_read: c.at ?? null,
        source: 'live',
      });
    }
    for (const [name, c] of Object.entries(cachedMap)) {
      if (out.has(name)) continue;
      out.set(name, { name, ability: c.ability ?? null, id: c.id ?? null,
                      best_ever: c.best ?? c.ability ?? null,
                      first_seen: c.first ?? null, last_read: c.at ?? null,
                      source: 'remembered — this character was not in game when the sheet was taken' });
    }
    return [...out.values()].sort((a, b) => (b.ability ?? 0) - (a.ability ?? 0));
  };

  const skills = rows(abilities?.skills, cachedSkills, 'skill');
  const spells = rows(abilities?.spells, cachedSpells, 'spell');

  // AN ATTRIBUTE IS AN OBJECT, NOT A NUMBER. `status` reports each as
  // {value, display_scale, hard_cap}, and treating it as a number gives NaN — which
  // then reads as 0, which reads as a character that cannot carry anything. The
  // compendium's buildFromCharacter already unwraps it the same way; this is the second
  // place that has had to learn it, which is why the plain numbers are written out
  // alongside the detail rather than left for the next reader to unwrap again.
  const num = (a) => (Number.isFinite(a) ? a : (Number.isFinite(a?.value) ? a.value : null));
  const at6 = { might: num(attrs.might), intellect: num(attrs.intellect),
                stamina: num(attrs.stamina), agility: num(attrs.agility),
                mysticism: num(attrs.mysticism), aim: num(attrs.aim) };
  const stamina = at6.stamina;

  return {
    _format: {
      what: 'One Meridian 59 character, as completely as a client can observe itself.',
      version: 1,
      not_a_savegame:
        'This is NOT byte-compatible with the server savegame and cannot be. SaveGame ' +
        '(blakserv/savegame.c:97) writes a whole-VM binary image — classes, resources, ' +
        'system node, every object, list nodes, timers, users. A client sees a thin ' +
        'projection of one object out of that graph. The parts it cannot see would have ' +
        'to be invented, and an invented save corrupts a world rather than restoring one.',
      reading_it: {
        ability: 'Skill and spell numbers are the server\'s ability value, 0-100ish, as ' +
                 'pushed on BP_STAT. Higher is better. `best_ever` is the highest this ' +
                 'repository has ever seen it, across sessions.',
        attributes: 'Fixed at character creation and never move. They cap what can be ' +
                    'learned; stamina additionally sets the maximum-health ceiling at ' +
                    '101 + stamina.',
        vigor: 'OUT OF 200, not out of a max field. It reports {value, scale_max, ' +
               'rest_threshold}. Resting alone stops awarding it at 80; everything above ' +
               'that has to be eaten. Reading it like health is a mistake this ' +
               'repository has made more than once.',
        level: 'A character\'s LEVEL is its maximum health. There is no separate field.',
        equipment: 'What is WORN is plUsing and is the server\'s own word. What is ' +
                   'CARRIED is the inventory and is a different list.',
      },
      provenance: 'Every block says where it came from. `live` means the broker answered ' +
                  'for a character in game at capture time; `remembered` means it came ' +
                  'from substrate/abilities, which survives the session.',
    },

    character, agent,
    captured_at: at,
    captured_at_iso: at ? new Date(at).toISOString() : null,
    in_game_at_capture: status?.in_game === true,

    identity: {
      object_id: status?.object_id ?? null,
      karma: status?.karma ?? null,
      room: status?.room ?? null,
      position: status?.position ?? null,
    },

    level: vitals?.health?.max ?? null,
    // The six, as plain numbers, because this is the block a recreator sends back to
    // `reroll` and the one a planner does arithmetic on. `detail` keeps the scale and
    // cap the server reported alongside them.
    attributes: {
      ...at6,
      note: 'fixed at creation; never change. These are what m59-mirror.mjs replays.',
      health_ceiling: stamina != null ? 101 + stamina : null,
      total: Object.values(at6).every(v => v != null)
        ? Object.values(at6).reduce((a, b) => a + b, 0) : null,
      detail: attrs,
    },

    vitals: {
      health: vitals.health ?? null,
      mana: vitals.mana ?? null,
      vigor: vitals.vigor ?? null,
      health_pct: pctOf(vitals.health), mana_pct: pctOf(vitals.mana),
    },

    skills, spells,
    skill_count: skills.length, spell_count: spells.length,

    equipment: {
      worn: equipment?.equipped ?? [],
      wielding: equipment?.wielding ?? [],
      source: equipment?.source ?? null,
      known: equipment?.known ?? false,
    },
    inventory: (inventory?.items ?? []).map(i => ({
      name: i.name, amount: i.amount ?? 1, can: i.can ?? undefined })),

    advancement: abilities?.advancement ?? null,
    freshness: abilities?.freshness ?? null,
  };
}

export function sheetPath(character) { return path.join(SHEET_DIR, `${character}.json`); }

export function writeSheet(sheet, { checkpoint = false } = {}) {
  fs.mkdirSync(SHEET_DIR, { recursive: true });
  const f = sheetPath(sheet.character);
  fs.writeFileSync(f, JSON.stringify(sheet, null, 1));
  let cp = null;
  if (checkpoint) {
    const dir = path.join(SHEET_DIR, 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(sheet.captured_at || Date.now()).toISOString().replace(/[:.]/g, '-');
    cp = path.join(dir, `${sheet.character}-${stamp}.json`);
    fs.writeFileSync(cp, JSON.stringify(sheet, null, 1));
  }
  return { file: f, checkpoint: cp };
}

// Read a sheet back. This is what makes it a checkpoint rather than a report: the
// compendium falls back to it when the broker is down or the character is out of game,
// so an imported character keeps working when the fleet does not.
export function loadSheet(nameOrAgent) {
  try {
    const direct = sheetPath(nameOrAgent);
    if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'));
    for (const f of fs.readdirSync(SHEET_DIR)) {
      if (!f.endsWith('.json')) continue;
      const s = JSON.parse(fs.readFileSync(path.join(SHEET_DIR, f), 'utf8'));
      if (s.agent === nameOrAgent || s.character === nameOrAgent) return s;
    }
  } catch { /* no sheets yet */ }
  return null;
}

export async function captureOne(agent, { at = Date.now() } = {}) {
  // Never let one unreachable character abort the sweep — a checkpoint that covers 20 of
  // 21 is worth having, and which one it missed is worth reporting.
  const soft = (p) => p.then(r => r, () => null);
  const [status, abilities, equipment, inventory] = await Promise.all([
    soft(broker('status', { agent, brief: true })),
    soft(broker('abilities', { agent, known_only: false })),
    soft(broker('equipment', { agent })),
    soft(broker('inventory', { agent })),
  ]);
  const character = status?.character ?? status?.name ?? agent;
  const cached = readAbilityCache(character);
  if (!status && !cached) return { agent, ok: false, why: 'no live answer and nothing remembered' };
  return { agent, ok: true,
           sheet: buildSheet({ character, agent, status, abilities, equipment, inventory, cached, at }) };
}

// ---------------------------------------------------------------------- cli
if (process.argv[1] && path.basename(process.argv[1]) === 'm59-sheet.mjs') {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const one = arg('--agent');
  const checkpoint = argv.includes('--checkpoint');
  const print = argv.includes('--print');

  let agents = one ? [one] : [];
  if (!agents.length) {
    try {
      const f = await broker('fleet', {});
      agents = (f.fleet || []).map(r => r.agent).filter(Boolean);
    } catch (e) {
      console.error(`could not list the fleet: ${e.message}`);
      console.error('Pass --agent <name>, or start the broker.');
      process.exit(1);
    }
  }

  const at = Date.now();
  const done = [], failed = [];
  for (const a of agents) {
    const r = await captureOne(a, { at });
    if (!r.ok) { failed.push(r); continue; }
    if (print) { console.log(JSON.stringify(r.sheet, null, 1)); done.push(r); continue; }
    const w = writeSheet(r.sheet, { checkpoint });
    done.push({ ...r, ...w });
    const live = r.sheet.in_game_at_capture ? 'live' : 'remembered';
    console.log(`${r.sheet.character.padEnd(10)} ${String(r.sheet.level ?? '?').padStart(3)}  ` +
                `${String(r.sheet.skill_count).padStart(2)} skills, ${String(r.sheet.spell_count).padStart(2)} spells  (${live})`);
  }
  if (!print) {
    console.log(`\n${done.length} sheet(s) -> ${path.relative(REPO, SHEET_DIR)}`);
    if (checkpoint) console.log(`checkpoints -> ${path.relative(REPO, path.join(SHEET_DIR, 'checkpoints'))}`);
  }
  // Say what was missed rather than quietly covering less than it claims.
  for (const f of failed) console.error(`MISSED ${f.agent}: ${f.why}`);
  process.exit(failed.length && !done.length ? 1 : 0);
}
