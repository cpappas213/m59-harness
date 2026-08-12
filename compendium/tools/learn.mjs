// learn.mjs -- PlayerCanLearn, as arithmetic. Zero imports on purpose.
//
// THREE THINGS COMPUTE THIS AND THEY MUST NOT DISAGREE: the planner page in a browser, the
// loadout tool in node, and anything that later wants to ask "can this character learn
// that" before walking it to a teacher. A quantity with two homes in this repository has
// always ended up with two answers, so this file is the one home — it is imported by
// `tools/m59-loadout.mjs` and inlined into `assets/learn.js` by `derive/planner.mjs`, the
// same way `calc.mjs` becomes `calc.js` for the bestiary.
//
// That is also why there is not a single `import` here, and why nothing in it touches the
// filesystem: the inliner strips import lines and wraps the rest, so anything this file
// depended on would silently become undefined in the browser.
//
// THE QUESTION IT ANSWERS. `PlayerCanLearn` (player.kod:10630) compares two numbers:
//
//   iHave  the sum of your best THREE ability values among what you already know at the
//          level BELOW, in that same school. Flat 297 for level 1, because there is no
//          level below it (player.kod:10783). This is not a pool that accumulates — it is
//          how good you are at the previous level, right now.
//   iNeed  what that level costs, given everything you already know.
//
// You may learn it when iHave >= iNeed. Nothing is spent; the requirement is a threshold.
//
// WHY THE COST RISES WITH WHAT YOU KNOW. iNeed is driven by iPoints, the sum over SEVEN
// tracks — the six spell schools and one more for skills — of a weight per level from
// `vlLevelPoints = [1,2,4,6,8,10]` (system.kod:414). So a second school is cheap and a
// sixth is not, and a character that has been learning proficiencies pays more for its
// next spell than one that has not. The seventh track is the one that gets missed.
//
// EVERY CONSTANT IS PASSED IN. POINTS_SLOPE, MIN_NEEDED_TO_ADVANCE and MaxLearnPoints live
// in the game source, not in this file, and `m59-planner-data.mjs` reads them out of it
// with the line they came from. A missing one returns null rather than a plausible number:
// an invented cost curve reads as authoritative, and that is worse than showing none.

// The weight of holding a track at level `l`. Level 0 — nothing known in that track — is
// free, which is why `GetLevelLearnPoints` short-circuits on it (system.kod:6219).
//
// A LEVEL PAST THE END OF THE TABLE IS ALSO FREE, AND THAT IS NOT A GUESS. assess, thrust
// and kick declare `viSkill_level = 50` — a sentinel for "granted, not sold", since
// `Skill.GetValue` doubles per level and 250*2^50 is nobody's price. The server then asks
// `Nth(vlLevelPoints, 50)` of a six-element list, and Nth past the end returns NIL after
// logging "Nth can't go past end of list" (blakserv/list.c:178). So a character that knows
// thrust has iWeapon = 50, and its weapon track contributes NOTHING — including hiding the
// proficiency levels it would otherwise have been charged for, because iWeapon is a MAX.
//
// Clamping to the last entry is the natural thing to write here and would be wrong in the
// expensive direction: it would price ten points onto every character that has ever
// thrust, and the planner would report builds as unreachable that the server allows.
export function levelPointsAt(table, l) {
  const n = Number(l) || 0;
  return (Array.isArray(table) && n > 0 && n <= table.length) ? table[n - 1] : 0;
}

// What the character's existing knowledge already costs, before it learns anything else.
// `trackLevels` is {trackName: highestLevelKnown}; the names do not matter, only that
// there is one entry per track and that the weapon-skill track is among them.
export function trackPoints(table, trackLevels) {
  let total = 0;
  for (const l of Object.values(trackLevels || {})) total += levelPointsAt(table, l);
  return total;
}

export function learnCost({ trackLevels = {}, school = null, level = 1, intellect = 0,
                            knowOneAtLevel = false, prevLevelCount = 3, constants = {} } = {}) {
  const slope = constants.points_slope;
  const floor = constants.min_needed_to_advance;
  const maxPts = constants.max_learn_points;
  const table = constants.level_points;
  if (slope == null || floor == null || maxPts == null || !Array.isArray(table))
    return { need: null, points: null, school, level,
             why: 'the learning constants are not resolved — see planner.json learning.note' };

  let points = trackPoints(table, trackLevels);
  // GOING INTO A LEVEL NOTHING IS KNOWN AT YET COSTS THE DIFFERENCE UP FRONT, which is what
  // makes the FIRST ability of a new level the expensive one and the second and third
  // nearly free (player.kod:10824). `knowOneAtLevel` is the whole of that distinction.
  if (!knowOneAtLevel) points += levelPointsAt(table, level) - levelPointsAt(table, level - 1);

  const fromIntellect = Math.trunc((Number(intellect) || 0) * 2 * slope / 5);
  let need = points * slope + (297 - maxPts * slope) - fromIntellect;
  // bound(iNeed, MIN_NEEDED_TO_ADVANCE, $) — so nobody rushes the low levels.
  need = Math.max(need, floor);

  // THE SCARCITY RELIEF, and a planner that stops at the formula above is wrong by a factor
  // of three. When the level below holds fewer than three abilities you cannot reach 297 at
  // all — iHave is the sum of your best three and there are not three — so the cost is eased
  // to match (player.kod:10915).
  // The server branches on EXACTLY one or two abilities existing in the previous
  // level, not on "fewer than three" as a broad condition. Zero is normally
  // impossible for a real next level, but treating it as one-third would turn bad
  // catalogue data into a plausible, very cheap answer.
  if (prevLevelCount === 1) need = Math.trunc(need / 3);
  else if (prevLevelCount === 2) need = Math.trunc(need * 2 / 3);

  return {
    need, points, school, level,
    // Level 1 is measured against the maximum outright, so it is reachable from nothing.
    have_max: level === 1 ? 297 : null,
    from_intellect: fromIntellect,
    why: `${points} track points * ${slope}, less ${fromIntellect} for intellect`,
  };
}

// CAN THIS CHARACTER LEARN IT, given what it is actually good at. `have` is the sum of its
// best three abilities at the level below in that school — the caller has to compute that
// from the character, because only the character knows it.
export function canLearn({ have, ...rest }) {
  const cost = learnCost(rest);
  if (cost.need == null) return { ...cost, can: null };
  const iHave = rest.level === 1 ? 297 : (Number(have) || 0);
  return { ...cost, have: iHave, can: iHave >= cost.need, short: Math.max(0, cost.need - iHave) };
}

// HOW FAR THIS CHARACTER IS FROM LEARNING SOMETHING NEW.
//
// `canLearn` is deliberately the small arithmetic primitive: its caller supplies iHave.
// This is the character-level counterpart. It joins known ability percentages to the
// compendium catalogue, selects the best three values at the preceding level, reproduces
// PlayerCanLearn's early-success rules, and reports every candidate rather than making a
// caller reconstruct the same answer once per spell or skill.
//
// Inputs are already data, not files, so this remains usable in both Node and the browser:
//   known:     [{name, kind:'skill'|'spell', school, level, ability}]
//   catalogue:[{name, kind, school, level, required_karma?, learnable?, for_sale?}]
// The caller enriches the wire rows from planner.json; no game metadata is guessed here.
const learnNorm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const learnKind = r => r?.kind === 'skill' ? 'skill' : r?.kind === 'spell' ? 'spell' : null;
const learnSchool = r => learnNorm(r?.school ?? r?.discipline);
const boundedPrevSlots = n => Math.max(1, Math.min(3, Number(n) || 0));

export function RemainingRequiredToLearnNewSkills({
  known = [], catalogue = [], intellect = 0, karma = null, constants = {},
  kind = 'both', name = null,
} = {}) {
  const catalogued = (catalogue || []).filter(r => learnKind(r) && Number(r.level) > 0);
  const byName = new Map(catalogued.map(r => [`${learnKind(r)}:${learnNorm(r.name)}`, r]));
  const joined = [];
  for (const raw of (known || [])) {
    const k = learnKind(raw);
    if (!k || !raw?.name) continue;
    const cat = byName.get(`${k}:${learnNorm(raw.name)}`) || {};
    joined.push({ ...cat, ...raw, kind: k,
                  school: raw.school ?? raw.discipline ?? cat.school ?? cat.discipline ?? null,
                  level: Number(raw.level ?? cat.level) || null,
                  ability: Number(raw.ability) || 0 });
  }

  const knownKeys = new Set(joined.map(r => `${r.kind}:${learnNorm(r.name)}`));
  const trackLevels = {};
  const skillLevels = joined.filter(r => r.kind === 'skill' && r.level).map(r => r.level);
  trackLevels.weapon = skillLevels.length ? Math.max(...skillLevels) : 0;
  for (const r of joined) {
    if (r.kind !== 'spell' || !r.level || learnNorm(r.name) === 'blink') continue;
    const school = r.school ?? r.discipline;
    if (school) trackLevels[school] = Math.max(trackLevels[school] ?? 0, r.level);
  }

  const wantName = name == null ? null : learnNorm(name);
  const wantKind = kind === 'skills' ? 'skill' : kind === 'spells' ? 'spell' : null;
  const candidates = catalogued.filter(r => {
    const k = learnKind(r), key = `${k}:${learnNorm(r.name)}`;
    if (wantKind && k !== wantKind) return false;
    if (wantName && learnNorm(r.name) !== wantName) return false;
    if (!wantName && knownKeys.has(key)) return false;
    if (r.learnable === false || r.abstract === true) return false;
    // A real-level skill marked not for sale is a granted/internal ability, not a new
    // thing a character can set out to learn. Spells do not carry this field.
    if (k === 'skill' && r.for_sale === false) return false;
    return true;
  });

  const countAt = (rows, target, level) => rows.filter(r =>
    learnSchool(r) === learnSchool(target) && Number(r.level) === level);
  const karmaKnown = karma !== null && karma !== undefined && Number.isFinite(Number(karma));
  const evaluated = candidates.map(target => {
    const k = learnKind(target), level = Number(target.level);
    const key = `${k}:${learnNorm(target.name)}`;
    if (knownKeys.has(key)) {
      return { name: target.name, kind: k, school: target.school ?? target.discipline,
               level, already_known: true, can_learn: false, remaining_required: 0,
               blocked_by: ['already known'] };
    }

    // PlayerCanLearn returns before all arithmetic when this school/discipline already
    // has something above the target, or enough peers at the same level. Preserve that
    // ordering: even KarmaCheck is below these branches in player.kod.
    const above = countAt(joined, target, level + 1);
    const peers = countAt(joined, target, level);
    if (above.length || (peers.length && (level > 2 || peers.length >= 2))) {
      return { name: target.name, kind: k, school: target.school ?? target.discipline,
               level, can_learn: true, remaining_required: 0,
               shortcut: above.length ? 'already knows a higher level in this track'
                                      : 'already knows enough abilities at this level',
               previous_level_best_three: [] };
    }

    const previous = level > 1
      ? countAt(joined, target, level - 1).sort((a, b) => b.ability - a.ability).slice(0, 3)
      : [];
    const have = level === 1 ? 297 : previous.reduce((sum, r) => sum + r.ability, 0);
    // GetNumAtLevel counts what EXISTS in the system, not what this character knows.
    const prevLevelCount = level > 1 ? countAt(catalogued, target, level - 1).length : 0;
    const cost = canLearn({
      have, trackLevels, school: target.school ?? target.discipline, level,
      intellect, knowOneAtLevel: peers.length > 0, prevLevelCount, constants,
    });

    const requiredKarma = Number(target.required_karma) || 0;
    const karmaOk = !requiredKarma || !karmaKnown ||
      (requiredKarma > 0 ? Number(karma) >= requiredKarma : Number(karma) <= requiredKarma);
    const noBase = level > 1 && have === 0;
    const maxPossible = level === 1 ? 297 : 99 * boundedPrevSlots(prevLevelCount);
    const impossible = cost.need != null && cost.need > maxPossible;
    const blockers = [];
    if (!karmaOk) blockers.push(`karma ${karma}, needs ${requiredKarma > 0 ? '>=' : '<='} ${requiredKarma}`);
    if (noBase) blockers.push(`knows nothing at level ${level - 1} in this track`);
    if (impossible) blockers.push(`needs ${cost.need}, but this level can provide at most ${maxPossible}`);
    if (cost.need == null) blockers.push(cost.why);

    const formulaCan = cost.can;
    const can = formulaCan == null ? null : formulaCan && karmaOk && !noBase && !impossible;
    return {
      name: target.name, kind: k, school: target.school ?? target.discipline, level,
      can_learn: can,
      remaining_required: cost.short ?? null,
      need: cost.need, have,
      previous_level_best_three: previous.map(r => ({ name: r.name, ability: r.ability })),
      previous_level_abilities_in_game: prevLevelCount,
      intellect: Number(intellect) || 0,
      intellect_reduction: cost.from_intellect ?? null,
      impossible: impossible || undefined,
      blocked_by: blockers.length ? blockers : undefined,
      formula: cost.why,
    };
  }).sort((a, b) => (b.can_learn === true ? 1 : 0) - (a.can_learn === true ? 1 : 0)
    || (a.remaining_required ?? Infinity) - (b.remaining_required ?? Infinity)
    || a.level - b.level || String(a.name).localeCompare(String(b.name)));

  const ready = evaluated.filter(r => r.can_learn === true);
  const measurable = evaluated.filter(r => !r.already_known && r.remaining_required != null && !r.impossible);
  const unresolved = evaluated.some(r => r.can_learn === null);
  return {
    intellect: Number(intellect) || 0,
    karma: karmaKnown ? Number(karma) : null,
    track_levels: trackLevels,
    can_learn_any: ready.length ? true : unresolved ? null : false,
    remaining_required_to_any: ready.length ? 0
      : measurable.length ? Math.min(...measurable.map(r => r.remaining_required)) : null,
    ready_count: ready.length,
    candidates_checked: evaluated.length,
    candidates: evaluated,
    note: 'remaining_required is the combined ability percentage still needed among the best ' +
          'three abilities one level below; it is a threshold, not points that get spent.',
  };
}

// JavaScript convention for callers that do not need to mirror the requested/game-style
// function name. Both names are the same implementation, not two formulas.
export const remainingRequiredToLearnNewSkills = RemainingRequiredToLearnNewSkills;
