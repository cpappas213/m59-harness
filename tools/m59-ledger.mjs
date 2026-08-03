// The long record: what happened to each character, over days.
//
// This is deliberately NOT the flight recorder. That one keeps two-minute windows and
// throws away everything older than half an hour, which is right for "why is this
// character standing still" and useless for "what has become of the fleet since
// yesterday". The two want opposite things — one wants everything for a short time,
// the other wants a little for a long time — so they are separate files with separate
// lifetimes and nothing is rotated out of this one.
//
// Keyed by CHARACTER NAME, never by agent name or object id. Agent names are a broker
// convention and get reassigned; object ids are renumbered by every `save game`. The
// character name is the only identifier that means the same thing tomorrow.
//
// Two kinds of line, both JSONL, appended and never rewritten:
//
//   sample   a periodic snapshot of every character — level, kills, deaths, where
//   event    something worth knowing the moment it happened: a level gained, a
//            death, leaving the newbie zone, a stall that lasted
//
// Samples alone would answer "how far did it get". Events alone would answer "what
// happened to it". Neither alone answers "why did it stop gaining at four in the
// morning", which is the question actually worth being able to ask.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

// Per-fleet, because this is keyed by character name and names are only unique
// within a server. See ledgerDirFor. Naming no fleet keeps the original directory,
// so an existing checkout's history stays exactly where it was.
const DIR = ledgerDirFor(fleetName());

const dayFile = (t = Date.now()) =>
  join(DIR, 'fleet-' + new Date(t).toISOString().slice(0, 10) + '.jsonl');

function append(obj) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(dayFile(), JSON.stringify(obj) + '\n');
  } catch (e) {
    // Never let bookkeeping break play.
    console.error('[ledger] ' + e.message);
  }
}

// Last seen state per character, so events can be derived from samples rather than
// having to be reported from a dozen call sites that would each forget one.
const last = new Map();

export function recordEvent(character, kind, detail = {}) {
  if (!character) return;
  append({ t: Date.now(), iso: new Date().toISOString(), type: 'event', character, kind, ...detail });
}

// `rows` is the fleet tool's own output, so the ledger records exactly what a
// supervisor would have seen rather than a second, subtly different view.
export function recordSample(rows = []) {
  const t = Date.now();
  for (const r of rows) {
    const name = r.character;
    if (!name) continue;
    const now = {
      level: r.level ?? null,
      kills: r.autopilot?.kills ?? 0,
      deaths: r.deaths ?? null,
      room: r.room ?? null,
      room_num: r.room_num ?? null,
      health: r.health ?? null,
      mana: r.mana ?? null,
      vigor_of: r.vigor_of ?? null,
      has_weapon: r.has_weapon ?? null,
      has_food: r.has_food ?? null,
      activity: r.activity ?? null,
      deaths_in_safe_spot: r.deaths_in_safe_spot ?? null,
      deaths_in_proven_safe_spot: r.deaths_in_proven_safe_spot ?? null,
      mulligans: r.mulligans ?? null,
      logoffs: r.logoffs ?? null,
      stalled: r.stalled && r.stalled !== false ? (r.stalled.why || String(r.stalled)) : null,
      strategy: r.strategy ?? null,
      stalled_pct: r.time?.stalled_pct ?? null,
      active_s: r.time?.active_s ?? null,
      stalled_s: r.time?.stalled_s ?? null,
      fighting_s: r.time?.fighting_s ?? null,
      recovering_s: r.time?.recovering_s ?? null,
      travelling_s: r.time?.travelling_s ?? null,
      death_sig: r.last_death?.at ?? null,
    };
    const was = last.get(name);

    // Derive the events. A level gain is the thing being farmed, so it is worth a
    // line of its own; so is losing one, which is what a death costs and the only
    // way to see the cost rather than just the fact.
    if (was) {
      if (now.strategy !== was.strategy)
        recordEvent(name, 'strategy_changed', { from: was.strategy, to: now.strategy, level: now.level });
      if (now.level != null && was.level != null && now.level !== was.level)
        recordEvent(name, now.level > was.level ? 'level_up' : 'level_lost',
                    { from: was.level, to: now.level, room: now.room });
      // The keeper reconstructs the death at the resolution it happened at — where,
      // at what health, against what — and stamps it. Record THAT rather than
      // inferring from a five-minute sample, which reported the inn a character had
      // been resting in rather than the field it died in.
      if (now.death_sig && now.death_sig !== was.death_sig) {
        const d = r.last_death || {};
        recordEvent(name, 'died', {
          died_in: d.died_in ?? now.room, level: d.level ?? now.level,
          health_trail: d.health_trail, last_health: d.last_health, last_vigor: d.last_vigor,
          killed_by: d.killed_by ? d.killed_by.join(', ') : null,
          hunting: d.hunting, strategy: d.strategy, flee_threshold: d.flee_threshold,
        });
      } else if (now.room !== was.room && /Underworld/i.test(now.room || '') &&
                 !/Underworld/i.test(was.room || '')) {
        recordEvent(name, 'died', { was_in: was.room, level: now.level, note: 'inferred from sampling' });
      }
      if (was.room && /Raza|Mausoleum|Museum/i.test(was.room) && now.room &&
          !/Raza|Mausoleum|Museum/i.test(now.room))
        recordEvent(name, 'left_the_newbie_zone', { to: now.room, level: now.level });
      if (now.stalled && !was.stalled)
        recordEvent(name, 'stalled', { why: now.stalled, room: now.room, level: now.level });
      // WHAT CAME NEXT. A stall is only half the story; the useful half is what
      // resolved it, because that is what the keeper should have done sooner.
      if (!now.stalled && was.stalled)
        recordEvent(name, 'unstalled', { after: was.stalled, room: now.room,
                                         moved: now.room !== was.room });
    } else {
      recordEvent(name, 'first_seen', { level: now.level, room: now.room });
    }
    last.set(name, now);
    append({ t, type: 'sample', character: name, ...now });
  }
}

// Read it back. `since` is a millisecond timestamp; the default of 24 hours is the
// question this file exists to answer.
export function readLedger({ sinceMs = 24 * 3600 * 1000 } = {}) {
  if (!existsSync(DIR)) return { samples: [], events: [] };
  const cutoff = Date.now() - sinceMs;
  const samples = [], events = [];
  // Two days of files covers any 24-hour window regardless of when it started.
  const files = readdirSync(DIR).filter(f => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);
  for (const f of files) {
    for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.t < cutoff) continue;
      (o.type === 'event' ? events : samples).push(o);
    }
  }
  return { samples, events };
}

// THE DEATH POST-MORTEM. Not a dump of records — the point is the pattern.
//
// A death costs a point of maximum health outright, which is the exact thing being
// farmed, so a death is worth roughly an hour of the work that caused it. That makes
// "what do these have in common" the highest-value question the ledger can answer.
export function deathReport({ sinceMs = 24 * 3600 * 1000, limit = 20 } = {}) {
  const { events } = readLedger({ sinceMs });
  const deaths = events.filter(e => e.kind === 'died').slice(-limit);
  const tally = (key) => {
    const t = {};
    for (const d of deaths) {
      const v = d[key];
      if (v == null) continue;
      for (const one of String(v).split(', ')) t[one] = (t[one] || 0) + 1;
    }
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ what: k, deaths: n }));
  };
  return {
    deaths: deaths.length,
    window_hours: +(sinceMs / 3600000).toFixed(1),
    // The three cuts worth having. Repeat victims usually mean one character is
    // somewhere wrong; repeat rooms mean the ROOM is wrong for everyone sent there;
    // repeat killers mean the prey choice or the threat ceiling is wrong.
    by_character: tally('character'),
    by_room: tally('died_in'),
    by_killer: tally('killed_by'),
    by_strategy: tally('strategy'),
    recent: deaths.reverse().map(d => ({
      at: d.iso || new Date(d.t).toISOString(),
      character: d.character, level: d.level, died_in: d.died_in ?? d.was_in,
      health_trail: d.health_trail, last_health: d.last_health, last_vigor: d.last_vigor,
      killed_by: d.killed_by, hunting: d.hunting, strategy: d.strategy,
      flee_threshold: d.flee_threshold,
      ...(d.note ? { note: d.note } : {}),
    })),
    read_this_way:
      'health_trail is the last four samples before the death, oldest first. A trail ' +
      'that ends well above the flee threshold means the character was killed FASTER ' +
      'than one keeper pass — raising the threshold will not help and only fighting ' +
      'something weaker will. A trail that decays through the threshold means the ' +
      'withdrawal was attempted and lost, which is a speed problem, not a policy one.',
  };
}

// Where the fleet's time actually goes. Stalled means standing about not knowing what
// to do, while NOT recovering — resting and eating are work.
export function timeReport({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const { samples, events } = readLedger({ sinceMs });
  const latest = new Map();
  for (const s of samples) if (s.active_s != null) latest.set(s.character, s);
  const rows = [...latest.values()].map(s => ({
    character: s.character, strategy: s.strategy,
    active_s: s.active_s, stalled_s: s.stalled_s, stalled_pct: s.stalled_pct,
    fighting_s: s.fighting_s, recovering_s: s.recovering_s, travelling_s: s.travelling_s,
  })).sort((a, b) => (b.stalled_pct ?? 0) - (a.stalled_pct ?? 0));

  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const stalls = {};
  for (const e of events.filter(e => e.kind === 'stalled'))
    stalls[e.why] = (stalls[e.why] || 0) + 1;
  const resolutions = {};
  for (const e of events.filter(e => e.kind === 'unstalled'))
    resolutions[`${e.after} -> ${e.moved ? 'moved room' : 'resolved in place'}`] =
      (resolutions[`${e.after} -> ${e.moved ? 'moved room' : 'resolved in place'}`] || 0) + 1;

  const total = sum('active_s') + sum('stalled_s');
  return {
    fleet: { active_s: sum('active_s'), stalled_s: sum('stalled_s'),
             stalled_pct: total ? +((100 * sum('stalled_s')) / total).toFixed(1) : 0,
             fighting_s: sum('fighting_s'), recovering_s: sum('recovering_s'),
             travelling_s: sum('travelling_s') },
    worst_offenders: rows.slice(0, 8),
    stall_causes: Object.entries(stalls).sort((a, b) => b[1] - a[1])
      .map(([why, n]) => ({ why, times: n })),
    how_stalls_ended: Object.entries(resolutions).sort((a, b) => b[1] - a[1])
      .map(([what, n]) => ({ what, times: n })),
  };
}

// Per character: where it started, where it got to, and what happened on the way.
export function summarise({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const { samples, events } = readLedger({ sinceMs });
  const by = new Map();
  for (const s of samples) {
    const e = by.get(s.character) || {
      character: s.character, first_seen: s.t, last_seen: s.t,
      level_first: s.level, level_last: s.level, level_peak: s.level ?? 0,
      kills_last: s.kills, room_last: s.room, samples: 0,
    };
    e.last_seen = s.t;
    e.level_last = s.level;
    // MEASURE EACH CHARACTER FROM WHEN ITS CURRENT STRATEGY STARTED, not from the
    // beginning of the window. Ten hours of pre-experiment history — including a
    // spell trapped in a sealed town and a run of deaths caused by a safety rule that
    // turned out to be wrong — would otherwise be charged against whichever pattern
    // the character happens to be running now, which is exactly backwards.
    if (s.strategy && s.strategy !== e.strategy) {
      e.strategy = s.strategy;
      e.strategy_since = s.t;
      e.level_at_strategy = s.level;
    }
    if (e.strategy) e.level_now_in_strategy = s.level;
    if ((s.level ?? 0) > e.level_peak) e.level_peak = s.level ?? 0;
    e.kills_last = Math.max(e.kills_last ?? 0, s.kills ?? 0);
    // LAST KNOWN, not last sampled. A snapshot taken while a character is mid-login
    // reports no room at all, and overwriting with that blanks the column for every
    // character on the page for the first few minutes after a restart — which reads
    // as "the fleet is nowhere" rather than "we have not heard yet".
    e.room_last = s.room ?? e.room_last ?? null;
    // LATEST, not aggregated. Health and mana are the two things on this page that
    // are only meaningful as "right now" — an average health is a number about
    // nothing. Samples are read in time order, so the last write wins.
    e.room_num_last = s.room_num ?? e.room_num_last ?? null;
    e.health_last = s.health ?? e.health_last ?? null;
    e.mana_last = s.mana ?? e.mana_last ?? null;
    e.vigor_last = s.vigor_of ?? e.vigor_last ?? null;
    e.weapon_last = s.has_weapon ?? e.weapon_last ?? null;
    e.food_last = s.has_food ?? e.food_last ?? null;
    e.activity_last = s.activity ?? e.activity_last ?? null;
    // Counters, so take the largest seen rather than the latest — a keeper restart
    // zeroes them and the point of the column is the run, not the process.
    e.spot_deaths = Math.max(e.spot_deaths ?? 0, s.deaths_in_safe_spot ?? 0);
    e.proven_spot_deaths = Math.max(e.proven_spot_deaths ?? 0, s.deaths_in_proven_safe_spot ?? 0);
    e.mulligans = Math.max(e.mulligans ?? 0, s.mulligans ?? 0);
    e.logoffs = Math.max(e.logoffs ?? 0, s.logoffs ?? 0);
    e.samples++;
    by.set(s.character, e);
  }
  for (const ev of events) {
    const e = by.get(ev.character);
    if (!e) continue;
    e.events ??= {};
    e.events[ev.kind] = (e.events[ev.kind] || 0) + 1;
    // Deaths under the CURRENT strategy — the only ones that say anything about it.
    if (ev.kind === 'died' && e.strategy_since && ev.t >= e.strategy_since)
      e.deaths_in_strategy = (e.deaths_in_strategy || 0) + 1;
  }
  const rows = [...by.values()].map(e => ({
    character: e.character,
    level: e.level_last,
    gained: (e.level_last ?? 0) - (e.level_first ?? 0),
    peak: e.level_peak,
    kills: e.kills_last,
    deaths: e.events?.died || 0,
    stalls: e.events?.stalled || 0,
    left_newbie_zone: !!e.events?.left_the_newbie_zone,
    room: e.room_last,
    room_num: e.room_num_last ?? null,
    health: e.health_last ?? null,
    mana: e.mana_last ?? null,
    vigor: e.vigor_last ?? null,
    has_weapon: e.weapon_last ?? null,
    has_food: e.food_last ?? null,
    activity: e.activity_last ?? null,
    deaths_in_safe_spot: e.spot_deaths ?? 0,
    deaths_in_proven_safe_spot: e.proven_spot_deaths ?? 0,
    mulligans: e.mulligans ?? 0,
    logoffs: e.logoffs ?? 0,
    strategy: e.strategy ?? null,
    watched_hours: +((e.last_seen - e.first_seen) / 3600000).toFixed(2),
    // The experimental measurements: everything since this character's current
    // pattern began, and nothing before it.
    on_strategy_hours: e.strategy_since ? +((e.last_seen - e.strategy_since) / 3600000).toFixed(2) : 0,
    gained_on_strategy: e.strategy_since
      ? (e.level_now_in_strategy ?? 0) - (e.level_at_strategy ?? 0) : 0,
    deaths_on_strategy: e.deaths_in_strategy || 0,
  })).sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

  // THE COMPARISON. Health gained per hour is the figure that decides which pattern
  // is better; kills are not, because a kill at or below your own level is worth
  // nothing at all and a strategy can look busy while gaining no ground.
  const byStrategy = {};
  for (const r of rows) {
    const k = r.strategy || 'unassigned';
    const g = byStrategy[k] ??= { strategy: k, characters: 0, levels_gained: 0,
                                  deaths: 0, stalls: 0, hours: 0, kills: 0 };
    g.characters++;
    g.levels_gained += Math.max(0, r.gained_on_strategy);
    g.deaths += r.deaths_on_strategy;
    g.stalls += r.stalls;
    g.kills += r.kills || 0;
    g.hours += r.on_strategy_hours;
  }
  const comparison = Object.values(byStrategy).map(g => ({
    ...g,
    hours: +g.hours.toFixed(2),
    levels_per_hour: g.hours ? +(g.levels_gained / g.hours).toFixed(3) : null,
    deaths_per_hour: g.hours ? +(g.deaths / g.hours).toFixed(3) : null,
  })).sort((a, b) => (b.levels_per_hour ?? 0) - (a.levels_per_hour ?? 0));

  return {
    window_hours: +(sinceMs / 3600000).toFixed(1),
    characters: rows.length,
    samples: samples.length,
    total_levels_gained: rows.reduce((a, r) => a + Math.max(0, r.gained), 0),
    total_deaths: rows.reduce((a, r) => a + r.deaths, 0),
    fleet: rows,
    comparison,
    comparison_note: 'levels_per_hour is the figure that matters — max health IS the ' +
      'level, and it is what every one of these patterns is trying to buy. Read ' +
      'deaths_per_hour next: a death costs a point of max health outright, so a fast ' +
      'pattern that dies is not fast.',
    recent_events: events.slice(-40).map(e => ({ at: e.iso || new Date(e.t).toISOString(),
                                                 character: e.character, kind: e.kind,
                                                 ...Object.fromEntries(Object.entries(e)
                                                   .filter(([k]) => !['t', 'iso', 'type', 'character', 'kind'].includes(k))) })),
  };
}
