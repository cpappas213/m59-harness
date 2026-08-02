// Where each creature actually lives, and what else lives there.
//
// Monsters in Meridian 59 do not roam the world looking for you. Every room has a
// generator with a fixed spawn table, and a creature appears in a room only if that
// room's table names it. So "where do I find giant rats" is a LOOKUP, and a keeper
// that wanders room to room hoping to trip over one is running the wrong algorithm
// entirely — it walks a character across the map into the Princess's castle to hunt
// vermin that were never going to be there.
//
// Built from compendium/data/spawns.json, which is extracted from the kod room
// sources and carries the spawn chance, the population cap, and the cite line for
// every entry. NOT from the rendered creature pages: groundwormlarva.html claims
// "no room in the world declares this creature", while the data shows it generated
// at 70% in OutdoorsF6 and again in OutdoorsF7 — which is exactly where a character
// of mine kept dying to something the page said could not be there.
//
// Levels and karma come from tools/monsters.json (viLevel / viKarma straight out of
// the class definitions), because the danger of a room is the level of the WORST
// thing in it, not of the thing you meant to hunt.
import { readFileSync, writeFileSync } from 'node:fs';

// Room keys in spawns.json are kod class names — "OutdoorsF7" — and the map records
// the same string as `cls`, so this join is exact. (The creature PAGES cite the .roo
// basename instead; different key, same rooms.)
export function buildSpawnIndex({ spawnsFile, mapFile, monstersFile, outFile }) {
  const raw = JSON.parse(readFileSync(spawnsFile, 'utf8'));
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const mons = JSON.parse(readFileSync(monstersFile, 'utf8'));

  const byCls = new Map();
  for (const r of Object.values(map.rooms))
    if (r.cls) byCls.set(String(r.cls).toLowerCase(), r);

  // class name -> { display name, level, karma }
  const info = new Map();
  for (const m of mons) {
    if (!m.class) continue;
    const disp = m._res?.[m.vrName]?.[0] || m.class;
    info.set(m.class.toLowerCase(), {
      name: disp,
      level: m.viLevel != null ? Number(m.viLevel) : null,
      karma: m.viKarma != null ? Number(m.viKarma) : null,
    });
  }

  const creatures = {};                 // display name (lower) -> { ..., sites }
  const rooms = {};                     // room number -> [ { creature, level, karma, chance, cap } ]
  let joined = 0, unjoined = 0;
  const missingRooms = new Set();

  for (const [cls, entries] of Object.entries(raw.byMonster || {})) {
    const meta = info.get(cls.toLowerCase()) || { name: cls, level: null, karma: null };
    const sites = [];
    for (const e of entries) {
      const room = byCls.get(String(e.room).toLowerCase());
      if (!room) { unjoined++; missingRooms.add(e.room); continue; }
      joined++;
      const site = { room: room.num, room_name: room.name, how: e.how,
                     chance: e.chance, cap: e.cap, count: e.count, cite: e.cite };
      sites.push(site);
      (rooms[room.num] ||= []).push({ creature: meta.name, cls, level: meta.level,
                                      karma: meta.karma, chance: e.chance, cap: e.cap,
                                      // `generator` means the room keeps making these.
                                      // `create` means one was placed at construction —
                                      // a shopkeeper, a guard, a set piece. Quintor the
                                      // blacksmith is a `create`, which is why "does this
                                      // room spawn anything" said YES about a smithy.
                                      how: e.how, huntable: e.how === 'generator' });
    }
    creatures[meta.name.toLowerCase()] = { name: meta.name, cls, level: meta.level,
                                           karma: meta.karma, sites };
  }

  // Precompute the danger of each room once: the toughest thing its table can
  // produce. This is the number that decides whether a room is survivable, and it
  // is not the level of what you came to kill.
  const danger = {};
  for (const [num, list] of Object.entries(rooms)) {
    const worst = list.reduce((a, b) => ((b.level ?? 0) > (a?.level ?? 0) ? b : a), null);
    danger[num] = { toughest: worst?.creature ?? null, level: worst?.level ?? null,
                    kinds: list.length };
  }

  const out = { creatures, rooms, danger,
                stats: { creatures: Object.keys(creatures).length, rooms: Object.keys(rooms).length,
                         sites_joined: joined, sites_unjoined: unjoined,
                         unmapped_rooms: [...missingRooms].slice(0, 40) } };
  if (outFile) writeFileSync(outFile, JSON.stringify(out));
  return out;
}

let cached;
export function loadSpawns(file) {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

// Every room that generates something matching `want`, best chance first.
//
// `maxDanger` is the whole point of the call: it drops rooms whose table can also
// produce something too strong, which is the check that distinguishes room 566 from
// room 603. Both list giant rats; one of them also rolls a level-35 groundworm larva
// seven times in ten.
export function huntingGrounds(spawns, want, { maxDanger = null, limit = 12 } = {}) {
  if (!spawns) return [];
  const needle = String(want).toLowerCase();
  const hits = Object.values(spawns.creatures)
    .filter(c => c.name.toLowerCase().includes(needle) || c.cls.toLowerCase() === needle);
  // Only rooms that GENERATE the creature are hunting grounds. A room that merely
  // had one placed at construction will never make another, so it is a location,
  // not a source.
  const generates = (roomNum, name) => (spawns.rooms[roomNum] || [])
    .some(x => x.huntable && x.creature === name);
  const rows = [];
  for (const c of hits) {
    for (const s of c.sites) {
      if (s.how && s.how !== 'generator' && !generates(s.room, c.name)) continue;
      const here = spawns.rooms[s.room] || [];
      // THE THREAT CEILING IS ABOUT BYSTANDERS, NOT ABOUT THE PREY.
      //
      // Prey has to be ABOVE your level to pay anything at all — AdvancementCheck
      // needs monster_level > base_max_health — so measuring a room's danger with
      // the prey included rejects every room worth being in. A level-23 character
      // hunting level-30 giant rats had a ceiling of 29 and was told that all four
      // rat rooms were too dangerous, which left it with nowhere to go; nineteen
      // characters ended up standing in shops and inns because of it.
      //
      // What the ceiling is actually for is the thing you did NOT choose to fight:
      // the level-35 larva sharing a room with the rats, the level-50 spider next to
      // the ants. So exclude the quarry and judge the rest.
      const others = here.filter(x => x.cls !== c.cls);
      const worstOther = others.reduce((m, x) => Math.max(m, x.level ?? 0), 0);
      const d = spawns.danger[s.room] || {};
      const tooHot = maxDanger != null && worstOther > maxDanger;
      rows.push({
        room: s.room, room_name: s.room_name,
        creature: c.name, level: c.level, karma: c.karma,
        chance: s.chance, cap: s.cap, how: s.how,
        toughest_here: d.level != null ? `${d.toughest} (${d.level})` : null,
        also_here: here.filter(x => x.cls !== c.cls)
                       .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
                       .map(x => `${x.creature} ${x.level}${x.chance ? ` @${x.chance}%` : ''}`),
        ...(tooHot ? { rejected: `something OTHER than your prey here is level ${worstOther}, ` +
                                 `above your limit of ${maxDanger}` } : {}),
      });
    }
  }
  // RANK BY THE PREY'S SHARE OF THE ROOM, not by its raw spawn chance.
  //
  // Two rooms can both list centipedes at 50%, and be completely different places to
  // stand: one where the rest of the table is also centipedes, and one where the
  // other half is baby spiders that will attack you while you fight. Everything in a
  // room comes for you; only the share you are hunting pays you anything.
  //
  // This is not theoretical. Every room a Qor character may legally hunt in is 50-75%
  // baby spider and only 25-50% centipede — they are the one faction hunting the
  // MINORITY spawn everywhere they can go, and they accounted for thirteen of the
  // fleet's last twenty deaths.
  const share = (r) => {
    const here = spawns.rooms[r.room] || [];
    const total = here.reduce((a, x) => a + (x.chance ?? 0), 0);
    return total ? (r.chance ?? 0) / total : 0;
  };
  for (const r of rows) {
    r.share_of_room = +(share(r) * 100).toFixed(0);
    r.bystanders = (spawns.rooms[r.room] || [])
      .filter(x => x.cls !== rows.find(y => y === r)?.cls && x.creature !== r.creature)
      .reduce((a, x) => a + (x.chance ?? 0), 0);
  }
  const ok = rows.filter(r => !r.rejected)
    // Share first, then raw chance to break ties. A room that is mostly your prey is
    // worth more than a busier room that is mostly something else.
    .sort((a, b) => (b.share_of_room ?? 0) - (a.share_of_room ?? 0) || (b.chance ?? 0) - (a.chance ?? 0));
  const bad = rows.filter(r => r.rejected).sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0));
  // Rejected rooms are RETURNED, not hidden — a caller that cannot see why the
  // obvious room was skipped will keep trying to send characters there.
  return [...ok.slice(0, limit), ...bad.slice(0, 4)];
}

// WHAT SHOULD THIS CHARACTER BE KILLING RIGHT NOW.
//
// Two hard constraints, and they pull against each other.
//
// PAYS: AdvancementCheck only rolls when monster_level > base_max_health. Max health
// IS the level, so prey at or below your own level pays literally nothing — a room
// full of level-25 mummies is worthless to a level-25 character, and fifteen of mine
// ground away in one for the best part of an hour proving it.
//
// SURVIVABLE: and yet the prey must be ABOVE your level to pay at all, so "nothing
// above my level" is not available as a safety rule. `over` is the usable band, and
// what actually decides survival is not the prey but the TOUGHEST thing the room's
// table can roll — the level-35 larva sharing a room with the level-30 rats.
//
// KARMA is the third constraint and applies to the schools. A kill is an act worth
// the NEGATIVE of the victim's karma, so killing something evil pushes you good and
// vice versa:
//   want: 'evil'    (Qor)       kill POSITIVE-karma creatures
//   want: 'good'    (Shal'ille) kill NEGATIVE-karma creatures
//   want: 'neutral'             kill karma-0 creatures — no karma moves at all, so
//                               this is the prey that suits ANY character, and it is
//                               the only thing that works for a Qor student between
//                               level 30 and 50, where every positive-karma creature
//                               in the world is far too strong.
export function preyFor(spawns, level, { want = null, over = 6, limit = 6 } = {}) {
  if (!spawns || !level) return [];
  const karmaOk = (k) => {
    if (want === 'evil') return k != null && k > 0;
    if (want === 'good') return k != null && k < 0;
    if (want === 'neutral') return k === 0;
    return true;
  };
  // `ceiling` null means "accept any room" — used only by the relaxed second pass.
  const gather = (ceiling) => {
    const out = [];
    for (const c of Object.values(spawns.creatures)) {
      if (c.level == null || c.level <= level || c.level > level + over) continue;
      if (!karmaOk(c.karma)) continue;
      let rooms = huntingGrounds(spawns, c.name, { maxDanger: ceiling, limit: 20 })
        .filter(r => !r.rejected && r.creature === c.name);
      if (!rooms.length) continue;
      // With a ceiling in force every surviving room is safe, so rank by how much
      // prey it produces. WITHOUT one, every room is over the line and ranking by
      // prey chance is actively dangerous: it picked, for a level-35 character, the
      // room with the best ant density AND a level-100 groundworm on 40% of the
      // table. When nothing is safe, the question stops being "where is the most
      // prey" and becomes "where is the least likely to kill me".
      if (ceiling == null) {
        const risk = (r) => {
          const here = spawns.rooms[r.room] || [];
          const bad = here.filter(x => (x.level ?? 0) > level + over);
          const share = bad.reduce((a, x) => a + (x.chance ?? 0), 0);
          const worst = bad.reduce((a, x) => Math.max(a, x.level ?? 0), 0);
          return share * 1000 + worst;          // share dominates; level breaks ties
        };
        rooms = rooms.sort((a, b) => risk(a) - risk(b) || (b.chance ?? 0) - (a.chance ?? 0));
      }
      const best = rooms[0];
      const overLevel = (spawns.rooms[best.room] || [])
        .filter(x => (x.level ?? 0) > level + over);
      out.push({
        creature: c.name, level: c.level, karma: c.karma,
        pushes: c.karma == null ? 'unknown' : c.karma > 0 ? 'you toward evil'
              : c.karma < 0 ? 'you toward good' : 'nothing — karma-neutral',
        best_room: best.room, best_room_name: best.room_name,
        chance: best.chance, cap: best.cap,
        rooms: rooms.map(r => r.room),
        ...(overLevel.length ? { risk: overLevel.map(x =>
              `${x.creature} is level ${x.level}${x.chance ? ` and takes ${x.chance}% of this room's table` : ''}`) }
          : {}),
      });
    }
    // Highest qualifying level first: the fastest advancement still inside the band.
    return out.sort((a, b) => b.level - a.level).slice(0, limit);
  };

  const safe = gather(level + over);
  if (safe.length) return safe;

  // NOTHING CLEAN EXISTS, WHICH IS A FACT ABOUT THE WORLD AND NOT A FAILURE.
  // Between roughly level 35 and 45 every room that generates the right prey also
  // generates level-50 spiders — the ants live with them, and there is no third
  // room. Returning an empty list here would read as "no prey exists" and park a
  // character at 35 forever. Return the best compromise instead, labelled, so the
  // caller can decide whether the keeper's flee threshold covers it.
  return gather(null).map(p => ({ ...p, compromise: true,
    note: 'no room generates this without something well above your level; the ' +
          'keeper must be set to withdraw early' }));
}

// What is in a room, worst first. The other half of the same question.
export function roomThreats(spawns, roomNum) {
  const list = spawns?.rooms?.[roomNum];
  if (!list) return null;
  return [...list].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
}

if (process.argv[1]?.endsWith('m59-spawns.mjs')) {
  const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const idx = buildSpawnIndex({
    spawnsFile: root + 'compendium/data/spawns.json',
    mapFile: root + 'substrate/m59-map.json',
    monstersFile: root + 'tools/monsters.json',
    outFile: root + 'substrate/m59-spawns.json',
  });
  console.log(JSON.stringify({ ...idx.stats, unmapped_rooms: idx.stats.unmapped_rooms.length }));
  for (const w of ['giant rat', 'centipede']) {
    console.log(`\n${w} (nothing above level 32):`);
    for (const r of huntingGrounds(idx, w, { maxDanger: 32, limit: 6 }))
      console.log(`  ${String(r.room).padStart(4)} ${String(r.room_name).slice(0, 34).padEnd(35)} ` +
                  `${String(r.chance ?? '?').padStart(3)}% cap ${String(r.cap ?? '?').padStart(2)}  ` +
                  `${r.rejected ? 'REJECTED: ' + r.rejected : 'also: ' + (r.also_here.join(', ') || 'nothing')}`);
  }
}
