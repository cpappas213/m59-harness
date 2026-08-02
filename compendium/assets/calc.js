// GENERATED from tools/calc.mjs by tools/derive/creatures.mjs — do not edit.
(function(){
// calc.mjs -- the combat arithmetic, reimplemented exactly from the server.
//
// ONE SOURCE OF TRUTH.  derive/creatures.mjs imports this to render the bestiary
// server-side, and also emits a browser copy to assets/calc.js so the page can
// recompute against a different reference character without a round trip. Do not
// fork it; edit here and rebuild.
//
// Every constant below carries the file and line it came from. Blakod is integer
// arithmetic throughout, so every division truncates toward zero — `trunc()` is
// not decoration, it changes results.

// kod/object/active/holder/nomoveon/battler.kod:19
const EQUAL_CHANCE_HIT = 55;
// kod/object/active/holder/nomoveon/battler/player.kod (constants block)
const MAX_DAMAGE_PER_HIT = 30;
const MAX_HEALTH_DAMAGE_FRACTION = 3;

// kod/object/item/passitem/weapon.kod:31-70.  Read these together: the type that
// hits hardest gets no accuracy, the type that hits softest gets the most.
const WEAPON_TYPE = {
  0: { name: 'bludgeon', min: 4, max: 8, hit: 75, range: 2, disarm: -5, spell: 0 },
  1: { name: 'thrust', min: 3, max: 8, hit: 125, range: 3, disarm: 10, spell: -10 },
  2: { name: 'slash', min: 5, max: 11, hit: 0, range: 2, disarm: 0, spell: -15 },
};
const WEAPON_QUALITY = {
  0: { name: 'low', dmg: -1, hit: 0 },
  1: { name: 'normal', dmg: 0, hit: 0 },
  2: { name: 'high', dmg: 1, hit: 50 },
  3: { name: 'nerudite', dmg: 1, hit: 25 },
};

// A weapon with no override swings Slash, whose damage factor is 80.
// kod/object/passive/skill/stroke/slash.kod:43 · stroke.kod:67
const STROKE_DAMAGE_FACTOR = 80;
const MAX_PROFICIENCY_DAMAGE = 5;

// Unarmed: kod/object/passive/skill/stroke/unarmed.kod:35-36
const UNARMED = { min: 1, max: 3, hit: 0 };

const T = Math.trunc;
function bound(v, lo, hi) {
  if (lo !== null && lo !== undefined && v < lo) v = lo;
  if (hi !== null && hi !== undefined && v > hi) v = hi;
  return v;
}

// ---------------------------------------------------------------- monster
//
// monster.kod:1433 GetOffense / :1455 GetDefense — the same expression
function monsterOffense(level, difficulty) {
  return bound(3 * (level || 0) + 60 * (difficulty || 0), 1, 1500);
}
// monster.kod:4079 GetMaxHitPoints, then Fuzzy'd at :352
function monsterHealthBase(level) {
  return level < 40 ? level : T((120 * level) / 100);
}
// monster.kod:4263 Fuzzy(n) = n - n/4 + random(0, n/2)  → 75%…125%
function fuzzyLow(n) { return T(n) - T(T(n) / 4); }
function fuzzyHigh(n) { return T(n) - T(T(n) / 4) + T((T(n) * 2) / 4); }

function monsterHealth(level) {
  const b = monsterHealthBase(level || 0);
  return [Math.max(1, fuzzyLow(b)), Math.max(1, fuzzyHigh(b))];
}
// monster.kod:1488 GetDamage = Fuzzy(level / random(10,15))
function monsterDamage(level) {
  const lo = Math.max(1, fuzzyLow(T((level || 0) / 15)));
  const hi = Math.max(1, fuzzyHigh(T((level || 0) / 10)));
  return [Math.min(lo, hi), hi];
}

// ---------------------------------------------------------------- player
//
// player.kod:4227 GetOffense
function playerOffense(ref, weapon) {
  const s = ref.skills, a = ref.stats;
  let off = (weapon ? s.stroke : s.punch ?? s.stroke) * 3
    + (weapon ? s.proficiency : s.brawling ?? s.proficiency) * 2
    + a.aim * 4
    + T((ref.maxHealth * 3) / 2);
  if (weapon) {
    off += (WEAPON_TYPE[weapon.type] || { hit: 0 }).hit;
    off += (WEAPON_QUALITY[weapon.quality] || { hit: 0 }).hit;
  }
  return bound(off, 1, 1000);
}

// player.kod:4294 GetDefense.  Parry is zero without a weapon in hand, block is
// zero without a shield — both are checked before the ability is even read.
function playerDefense(ref, weapon, worn) {
  const s = ref.skills, a = ref.stats;
  const hasShield = worn.some((w) => w.isShield);
  let def = (weapon ? s.parry : 0) * 2
    + (hasShield ? s.block : 0) * 1
    + s.dodge * 3
    + a.agility * 4
    + T((ref.maxHealth * 3) / 2);
  for (const w of worn) def += (w.defenseBonus || 0);
  return bound(def, 1, 1000);
}

// battler.kod:330 — the whole of whether an attack lands
function hitChance(offense, defense) {
  return bound(T((offense * EQUAL_CHANCE_HIT) / defense), 10, 95);
}

// weapon.kod:241 GetBaseDamage → stroke.kod:201 FindDamage → :332 DamageFactors
function playerDamage(ref, weapon) {
  const might = ref.stats.might;
  const prof = weapon ? ref.skills.proficiency : (ref.skills.brawling ?? ref.skills.proficiency);
  const t = weapon ? WEAPON_TYPE[weapon.type] : null;
  const q = weapon ? WEAPON_QUALITY[weapon.quality] : null;
  const lo = weapon ? t.min + q.dmg : UNARMED.min;
  const hi = weapon ? t.max + q.dmg : UNARMED.max;
  const swing = (base) => {
    const d = T((base * STROKE_DAMAGE_FACTOR) / 100);
    const profBonus = T(((prof + 1) * MAX_PROFICIENCY_DAMAGE) / 100);
    return Math.max(1, profBonus + T(((100 + bound(might - 25, 0, 40)) * d) / 100));
  };
  return [swing(lo), swing(hi)];
}

// ---------------------------------------------------------------- armour
//
// battler.kod:189 ResistanceCheck — the LARGEST matching resistance plus the
// WORST matching weakness, across everything worn.  Not a sum per item.
const ATCK_WEAP_ALL = 0x00001;
function resistanceAgainst(worn, atype) {
  let maxRes = 0, minRes = 0;
  for (const w of worn) {
    for (const [flag, value] of Object.entries(w.resist || {})) {
      const bit = Number(flag);
      const matches = (atype & bit) !== 0 || (atype !== 0 && bit === ATCK_WEAP_ALL);
      if (!matches) continue;
      if (value > maxRes) maxRes = value;
      if (value < minRes) minRes = value;
    }
  }
  return bound(maxRes, null, 100) + bound(minRes, -100, null);
}

// player.kod:4556 AssessDamage, in order.  `expected` uses the mean of the flat
// roll, which is rerolled on every blow; pass expected=false for the worst case.
function damageToPlayer(raw, ref, worn, atype, aspell, { expected = true } = {}) {
  let dmg = raw;
  for (const w of worn) {
    let r = w.damageReduce || 0;
    if (!r) continue;
    let reduce = expected ? (T(r / 3) + r) / 2 : T(r / 3);
    // defmod.kod:110-122 — no flat reduction at all against pure spell damage,
    // two thirds of it when the attack carries both a weapon and a spell type.
    if (aspell) reduce = atype ? (reduce * 2) / 3 : 0;
    dmg -= Math.min(reduce, dmg - 1);
  }
  const res = resistanceAgainst(worn, atype);
  if (res > 0) dmg = (dmg * (100 - res)) / 100;
  else if (res < 0) dmg = (dmg * (-100 + res)) / -100;
  if (dmg <= 0) dmg = 1;
  dmg = Math.min(dmg, T((ref.maxHealth + (MAX_HEALTH_DAMAGE_FRACTION - 1)) / MAX_HEALTH_DAMAGE_FRACTION));
  dmg = Math.min(dmg, MAX_DAMAGE_PER_HIT);
  return dmg;
}

// ---------------------------------------------------------------- the fight
//
// Everything the bestiary needs about one reference character against one
// creature.  Attacks resolve about once a second for both sides
// (player.kod:5305 IsOkayAttackTime), so "swings" reads as seconds.
// A character can be described two ways: by what it is made of (attributes,
// skills, equipment) or by the three numbers those produce. The second is what
// you have if you read them off your own status screen, so both are accepted.
// A directly-described character carries no armour, and therefore no flat
// damage reduction and no resistances — offence, defence and damage do not
// encode those. Incoming damage for such a build is before mitigation.
function effective(ref, weapon, worn) {
  if (ref.mode === 'simple' && ref.direct) {
    return {
      simple: true,
      off: bound(Math.trunc(ref.direct.off) || 1, 1, 1000),
      def: bound(Math.trunc(ref.direct.def) || 1, 1, 1000),
      dmg: [Math.max(1, Math.trunc(ref.direct.dmgLo) || 1),
            Math.max(1, Math.trunc(ref.direct.dmgHi) || 1)],
    };
  }
  return {
    simple: false,
    off: playerOffense(ref, weapon),
    def: playerDefense(ref, weapon, worn),
    dmg: playerDamage(ref, weapon),
  };
}

function matchup(ref, weapon, worn, creature, eff) {
  const e = eff || effective(ref, weapon, worn);
  const wornForDamage = e.simple ? [] : worn;
  const pOff = e.off;
  const pDef = e.def;
  const mOff = monsterOffense(creature.level, creature.difficulty);
  const mDef = mOff;

  const youHit = hitChance(pOff, mDef);
  const hitsYou = hitChance(mOff, pDef);

  const pDmg = e.dmg;
  const pAvg = (pDmg[0] + pDmg[1]) / 2;

  const mDmgRaw = monsterDamage(creature.level);
  const mDmg = [
    damageToPlayer(mDmgRaw[0], ref, wornForDamage, creature.atype || 0, creature.aspell || 0),
    damageToPlayer(mDmgRaw[1], ref, wornForDamage, creature.atype || 0, creature.aspell || 0),
  ];
  const mAvg = (mDmg[0] + mDmg[1]) / 2;

  const mHp = monsterHealth(creature.level);
  const mHpAvg = (mHp[0] + mHp[1]) / 2;

  // Expected swings, accounting for misses.
  const toKill = pAvg > 0 && youHit > 0 ? mHpAvg / (pAvg * (youHit / 100)) : Infinity;
  const toDie = mAvg > 0 && hitsYou > 0 ? ref.maxHealth / (mAvg * (hitsYou / 100)) : Infinity;
  const margin = toDie / toKill;

  return {
    pOff, pDef, mOff, mDef, youHit, hitsYou,
    pDmg, pAvg, mDmg, mAvg, mHp, mHpAvg,
    toKill, toDie, margin, simple: e.simple,
    verdict: verdictOf(margin),
  };
}

function verdictOf(margin) {
  if (!isFinite(margin)) return { key: 'safe', label: 'harmless' };
  if (margin >= 4) return { key: 'trivial', label: 'trivial' };
  if (margin >= 2) return { key: 'easy', label: 'comfortable' };
  if (margin >= 1.25) return { key: 'fair', label: 'a fair fight' };
  if (margin >= 1) return { key: 'close', label: 'too close' };
  if (margin >= 0.5) return { key: 'losing', label: 'you lose' };
  return { key: 'deadly', label: 'do not' };
}

window.M59Calc={bound,monsterOffense,monsterHealth,monsterDamage,playerOffense,playerDefense,playerDamage,hitChance,damageToPlayer,matchup,effective,verdictOf,WEAPON_TYPE,WEAPON_QUALITY};
})();
