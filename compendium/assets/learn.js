// GENERATED from tools/learn.mjs by tools/derive/planner.mjs — do not edit.
(function(){
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
function levelPointsAt(table, l) {
  const n = Number(l) || 0;
  return (Array.isArray(table) && n > 0 && n <= table.length) ? table[n - 1] : 0;
}

// What the character's existing knowledge already costs, before it learns anything else.
// `trackLevels` is {trackName: highestLevelKnown}; the names do not matter, only that
// there is one entry per track and that the weapon-skill track is among them.
function trackPoints(table, trackLevels) {
  let total = 0;
  for (const l of Object.values(trackLevels || {})) total += levelPointsAt(table, l);
  return total;
}

function learnCost({ trackLevels = {}, school = null, level = 1, intellect = 0,
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
  const thin = prevLevelCount < 3;
  if (thin && level - 1 === 1) need = Math.trunc(need / 3);
  else if (thin && level - 1 === 2) need = Math.trunc(need * 2 / 3);

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
function canLearn({ have, ...rest }) {
  const cost = learnCost(rest);
  if (cost.need == null) return { ...cost, can: null };
  const iHave = rest.level === 1 ? 297 : (Number(have) || 0);
  return { ...cost, have: iHave, can: iHave >= cost.need, short: Math.max(0, cost.need - iHave) };
}

window.M59Learn={learnCost,canLearn,trackPoints,levelPointsAt};
})();
