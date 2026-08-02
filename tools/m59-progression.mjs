#!/usr/bin/env node
// What "progressing normally" actually looks like, computed from the rules the
// server enforces rather than from anyone's memory of playing.
//
//   node tools/m59-progression.mjs hp                 kills per hit point
//   node tools/m59-progression.mjs hp --stamina 25
//   node tools/m59-progression.mjs climb 20 100       kills to go from H to H
//   node tools/m59-progression.mjs ability            uses per ability point
//   node tools/m59-progression.mjs check              re-derive the constants from the kod
//
// Everything here is a closed-form consequence of four kod methods. The point of
// computing rather than tabulating is that `check` re-reads the constants out of
// the source, so this file cannot quietly drift away from the game.
//
// AUTHORITIES (C:/code/meridian59)
//   kod/.../battler/player.kod:7736  AdvancementCheck   what a kill is worth
//   kod/.../battler/player.kod:7896  GetHighMark        the denominator of the roll
//   kod/.../battler/player.kod:7647  CheckAdvancementPoints  the 10-per-window cap
//   kod/.../battler/player.kod:1465  NewOwner           the cap's room-change refund
//   kod/object/passive/skill.kod:294 ImproveAbility     what a skill use is worth

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const M59 = process.env.M59_ROOT || 'C:/code/meridian59';
const PLAYER = 'kod/object/active/holder/nomoveon/battler/player.kod';
const SKILL  = 'kod/object/passive/skill.kod';
const SPELL  = 'kod/object/passive/spell.kod';

// kod's `/` truncates toward zero, like C. Every advancement number runs through
// it at least twice, and rounding instead of truncating shifts the tables.
const idiv = (a, b) => Math.trunc(a / b);

// --------------------------------------------------------------- constants
//
// Read out of the source rather than pasted, so `check` can prove they are still
// what this file assumes.

function constants() {
  const p = readFileSync(join(M59, PLAYER), 'utf8');
  const s = readFileSync(join(M59, SKILL), 'utf8');
  const sp = readFileSync(join(M59, SPELL), 'utf8');
  const num = (txt, re, what) => {
    const m = re.exec(txt);
    if (!m) throw new Error(`could not find ${what} — the kod has moved, re-read it`);
    return Number(m[1]);
  };
  return {
    ADVANCEMENT_LIMIT: num(p, /ADVANCEMENT_LIMIT\s*=\s*(\d+)/, 'ADVANCEMENT_LIMIT'),
    ADVANCE_TIMER_MIN: num(p, /ADVANCE_TIMER_MIN\s*=\s*(\d+)/, 'ADVANCE_TIMER_MIN'),
    ADVANCE_TIMER_MAX: num(p, /ADVANCE_TIMER_MAX\s*=\s*(\d+)/, 'ADVANCE_TIMER_MAX'),
    MAXIMUM_STAT:      num(p, /MAXIMUM_STAT\s*=\s*(\d+)/, 'MAXIMUM_STAT'),
    START_HEALTH:      num(p, /piBase_Max_Health\s*=\s*(\d+)/i, 'starting piBase_Max_Health'),
    ROOM_REFUND:       num(p, /piAdvancement_points\s*=\s*bound\(\(piAdvancement_points\s*-\s*(\d+)\)/,
                            'the NewOwner advancement refund'),
    SOFTCAP_SKILL:     num(s, /SOFTCAP_PENALTY\s*=\s*(\d+)/, 'skill SOFTCAP_PENALTY'),
    SOFTCAP_SPELL:     num(sp, /SOFTCAP_PENALTY\s*=\s*(\d+)/, 'spell SOFTCAP_PENALTY'),
    // The health ceiling is a comparison, not a named constant: AdvancementCheck
    // gains only while piBase_Max_health < (101 + stamina).
    HEALTH_CEIL_BASE:  num(p, /piBase_Max_health\s*<\s*\((\d+)\s*\+\s*Send\(self,@GetStamina\)\)/,
                            'the health ceiling expression'),
    NEWBIE_HP:         30,   // PKILL_ENABLE_HP, blakston.khd:2094
  };
}

// ------------------------------------------------------------ hit points
//
// AdvancementCheck, transcribed:
//
//   piGain_chance += gain
//   if roll:
//     highmark = (index+1)*index  where index = H*(100-stamina)/100
//     iNumber  = piGain_chance + bound((L-H)/5, 0, 10)
//     if random(1,highmark) < iNumber and H < 101+stamina:
//        H += 1;  piGain_chance = -(H/2)  [ - (50-stamina)/2 if H > 30 ]
//
// So the accumulator is a random walk that starts NEGATIVE after every gain and
// climbs by `gain` per eligible kill. That reset is the whole difficulty curve:
// nothing about the roll gets harder with level except how far below zero you
// start and how large the denominator is.

const highMark = (H, stamina) => {
  const index = idiv(H * (100 - stamina), 100);
  return (index + 1) * index;
};

// The accumulator's value immediately after gaining a point at base health H.
const resetTo = (H, stamina) =>
  -idiv(H, 2) - (H > 30 ? idiv(50 - stamina, 2) : 0);

// P(this kill produces the point), given the accumulator BEFORE the roll.
// random(1,highmark) < iNumber, so the successes are 1..iNumber-1.
function pGain(acc, H, stamina, monsterLevel) {
  const hm = highMark(H, stamina);
  if (hm <= 0) return 1;                        // stamina 100 would divide by zero; MAXIMUM_STAT prevents it
  const b = Math.min(Math.max(idiv(monsterLevel - H, 5), 0), 10);
  const iNumber = acc + b;
  return Math.min(Math.max((iNumber - 1) / hm, 0), 1);
}

// Expected eligible kills to gain one point of max health at base health H.
// Exact, by walking the accumulator forward and weighting each kill by the
// probability the walk is still alive when it happens.
function killsPerPoint(H, stamina, { gain = 3, monsterLevel = null, newbie = null } = {}) {
  if (H >= constantsCache().HEALTH_CEIL_BASE + stamina)
    return { kills: Infinity, note: `at the ceiling — ${constantsCache().HEALTH_CEIL_BASE} + stamina ${stamina}` };
  const L = monsterLevel ?? H + 1;
  const isNewbie = newbie ?? (H < constantsCache().NEWBIE_HP);
  const step = gain + (isNewbie ? 1 : 0);

  let acc = resetTo(H, stamina);
  let alive = 1, expected = 0;
  for (let k = 1; k <= 200000 && alive > 1e-12; k++) {
    acc += step;
    const p = pGain(acc, H, stamina, L);
    expected += k * alive * p;
    alive *= (1 - p);
  }
  return { kills: expected, highmark: highMark(H, stamina), reset: resetTo(H, stamina), step };
}

let _c = null;
const constantsCache = () => (_c ||= constants());

// ---------------------------------------------------------------- ability
//
// GetSecondaryChance / ImproveAbility, transcribed:
//
//   initial   = viChance_to_increase * (1 + intellect/100)          GetInitialChance
//   C         = 60 + req - level*10 - totalLearnPoints              GetSecondaryChance
//   factor    = bound(2*difficulty - ability + 10, 50, 100)
//   C         = bound(C * factor / 100, 5, inf)
//   if ability > 2*req - 1:  C = C / SOFTCAP_PENALTY
//   C         = bound(C, 1 + req/10, 99)
//   improve   if random(1,100) <= initial AND random(0,100) < C
//
// THE SKILL BUG: GetSecondaryChance reads the current ability with
// `GetSpellAbility(#spell_num=viSkill_num)` (skill.kod:414). A skill's number is
// never in plSpells, so that call returns 0 for every skill (player.kod:6720's
// own comment says so). For SKILLS therefore `ability` is always 0 in `factor`,
// which means the improve chance does not fall as the skill rises and the
// softcap never fires. Spells read the same field with the same call, but for a
// spell the number IS in plSpells, so spells get the intended curve and skills
// do not. This is not a modelling choice; it is what the server computes.

function abilityChance({ chanceToIncrease = 20, level = 1, req = 25, intellect = 25,
                         ability = 1, difficulty = 60, learnPoints = 0,
                         hardLearn = false, isSkill = true } = {}) {
  const c = constantsCache();
  const initial = chanceToIncrease + idiv(chanceToIncrease * intellect, 100);
  const pInitial = Math.min(initial, 100) / 100;

  const effAbility = isSkill ? 0 : ability;       // the skill.kod:414 bug
  let C = 60 + req - level * 10 - learnPoints;
  const factor = Math.min(Math.max(2 * difficulty - effAbility + 10, 50), 100);
  C = idiv(C * factor, 100);
  C = Math.max(C, 5);
  if (effAbility > 2 * req - 1) C = idiv(C, isSkill ? c.SOFTCAP_SKILL : c.SOFTCAP_SPELL);
  if (hardLearn) C = idiv(C, 10);                 // ModifyChanceToImprove, room.kod:1399
  C = Math.min(Math.max(C, 1 + idiv(req, 10)), 99);

  // random(0,100) < C over 101 equally likely values.
  const pSecondary = Math.min(Math.max(C / 101, 0), 1);
  return { p: pInitial * pSecondary, C, initial, factor, uses: 1 / (pInitial * pSecondary) };
}

// --------------------------------------------------------------- reporting

const fmt = n => (n === Infinity ? '-' : n >= 100 ? n.toFixed(0) : n.toFixed(1));

function tableHP(stamina) {
  const c = constantsCache();
  const ceiling = c.HEALTH_CEIL_BASE + stamina;
  console.log(`\nEXPECTED KILLS PER +1 MAX HEALTH  (stamina ${stamina}, ceiling ${ceiling})`);
  console.log('  the good case is: you took damage from it AND landed the killing blow,');
  console.log('  on a monster whose level is above your max health.\n');
  console.log('    H  | best case | no killing blow | equal-level | cumulative from 20');
  console.log('  -----+-----------+-----------------+-------------+-------------------');
  let cum = 0;
  for (let H = c.START_HEALTH; H < ceiling; H++) {
    const best = killsPerPoint(H, stamina, { gain: 3 }).kills;
    cum += best;
    if (H % 10 !== 0 && H !== c.START_HEALTH && H !== ceiling - 1) continue;
    const two  = killsPerPoint(H, stamina, { gain: 2 }).kills;
    const near = killsPerPoint(H, stamina, { gain: 1, monsterLevel: H }).kills;
    console.log(`   ${String(H).padStart(3)} | ${fmt(best).padStart(9)} | ${fmt(two).padStart(15)} |` +
                ` ${fmt(near).padStart(11)} | ${fmt(cum).padStart(18)}`);
  }
  console.log(`\n  A near-level kill (gain 1) never rolls at all — it only banks the accumulator,`);
  console.log(`  so the "equal-level" column is what it costs when SOME later kill is above you.`);
}

function tableAbility() {
  console.log('\nEXPECTED USES PER +1 ABILITY\n');
  console.log('  SKILLS — flat in current ability, because of the skill.kod:414 lookup bug.');
  console.log('  Difficulty is the target monster\'s level and saturates at 45.\n');
  console.log('    target monster level | int 1 | int 25 | int 50 | int 70');
  console.log('  -----------------------+-------+--------+--------+-------');
  for (const d of [1, 20, 30, 40, 45, 100, 150]) {
    const row = [1, 25, 50, 70].map(i =>
      fmt(abilityChance({ difficulty: d, intellect: i, isSkill: true }).uses));
    console.log(`   ${String(d).padStart(21)} | ${row[0].padStart(5)} | ${row[1].padStart(6)} |` +
                ` ${row[2].padStart(6)} | ${row[3].padStart(6)}`);
  }
  console.log('\n  SPELLS — the curve the designers intended: the chance falls as the ability rises,');
  console.log('  and collapses by the softcap once ability >= 2 x the requisite stat.\n');
  console.log('    ability | req 25 | req 40 | req 50 (softcap unreachable)');
  console.log('  ----------+--------+--------+-----------------------------');
  for (const a of [1, 10, 25, 49, 50, 75, 90, 98]) {
    const r = [25, 40, 50].map(req =>
      fmt(abilityChance({ ability: a, req, difficulty: 60, isSkill: false }).uses).padStart(6));
    console.log(`   ${String(a).padStart(8)} | ${r[0]} | ${r[1]} | ${r[2]}`);
  }
  const c = constantsCache();
  const winMin = c.ADVANCE_TIMER_MIN / 60000, winMax = c.ADVANCE_TIMER_MAX / 60000;
  const mean = (winMin + winMax) / 2;
  console.log(`\n  THE CAP BINDS BEFORE THE ODDS DO. ${c.ADVANCEMENT_LIMIT} ability points per window,`);
  console.log(`  window ${winMin}-${winMax} minutes (mean ${mean}), so at best`);
  console.log(`  ${(c.ADVANCEMENT_LIMIT * 60 / mean).toFixed(0)} points/hour standing still —`);
  console.log(`  and 0->99 in one ability is at minimum ${(98 / (c.ADVANCEMENT_LIMIT * 60 / mean)).toFixed(1)} hours no matter how good the odds are.`);
  console.log(`\n  Each room change refunds ${c.ROOM_REFUND} points (player.kod:1465, "give them a break on the`);
  console.log(`  botting imp cap"), so practising across ${Math.ceil(c.ADVANCEMENT_LIMIT / c.ROOM_REFUND)}+ rooms lifts the ceiling:`);
  console.log('    room changes per window |  0 |  5 | 10 | 20');
  const per = n => c.ADVANCEMENT_LIMIT + n * c.ROOM_REFUND;
  console.log(`    points available        | ${[0,5,10,20].map(n => String(per(n)).padStart(2)).join(' | ')}`);
  console.log(`    points per hour         | ${[0,5,10,20].map(n => String(Math.round(per(n)*60/mean)).padStart(2)).join(' | ')}`);
}

function climb(from, to, stamina) {
  const c = constantsCache();
  const ceiling = c.HEALTH_CEIL_BASE + stamina;
  if (to > ceiling) {
    console.log(`\n  ${to} is above this character's ceiling of ${ceiling} (101 + stamina ${stamina}).`);
    console.log('  Stamina IS the health cap. No amount of killing gets past it.');
    to = ceiling;
  }
  let total = 0;
  for (let H = from; H < to; H++) total += killsPerPoint(H, stamina, { gain: 3 }).kills;
  console.log(`\n  ${from} -> ${to} max health at stamina ${stamina}: ${Math.round(total).toLocaleString()} eligible kills`);
  for (const secs of [5, 10, 20, 30, 60]) {
    const h = total * secs / 3600;
    console.log(`    at ${String(secs).padStart(2)}s per kill: ${h.toFixed(1)} hours` +
                (h > 24 ? ` (${(h / 24).toFixed(1)} days)` : ''));
  }
  console.log('\n  "Eligible" is doing real work: the kill only counts if you damaged it, it was');
  console.log('  your current target, and its level was above your max health. Everything else');
  console.log('  is free time.');
}

function check() {
  const c = constantsCache();
  console.log('\nconstants re-read from the kod:\n');
  for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(20)} ${v}`);
  const p = readFileSync(join(M59, PLAYER), 'utf8');
  const s = readFileSync(join(M59, SKILL), 'utf8');
  const claims = [
    ['health ceiling is 101 + stamina',
     /piBase_Max_health\s*<\s*\(101\s*\+\s*Send\(self,@GetStamina\)\)/.test(p)],
    ['gaining a point resets the accumulator NEGATIVE',
     /piGain_chance\s*=\s*-\(piBase_Max_health\/2\)/.test(p)],
    ['gaining a point refills health to full',
     /piHealth\s*=\s*piMax_Health;/.test(p)],
    ['highmark = (index+1)*index',
     /highmark\s*=\s*\(index\+1\)\*index/.test(p)],
    ['over-level bonus is capped at 10',
     /bound\(\(monster_level-piBase_Max_health\)\/5,0,10\)/.test(p)],
    ['a room change refunds advancement points',
     /piAdvancement_points\s*=\s*bound\(\(piAdvancement_points\s*-\s*2\)/.test(p)],
    ['SKILL BUG: secondary chance reads skill ability via GetSpellAbility',
     /iAbility\s*=\s*Send\(who,@GetSpellAbility,#spell_num=viSkill_num\)/.test(s)],
    ['difficulty saturates: factor is bounded to 50..100',
     /factor\s*=\s*bound\(factor,50,100\)/.test(s)],
  ];
  console.log('');
  let bad = 0;
  for (const [claim, ok] of claims) {
    console.log(`  ${ok ? 'holds ' : 'BROKEN'}  ${claim}`);
    if (!ok) bad++;
  }
  console.log(bad ? `\n  ${bad} claim(s) no longer match the source — the tables above are stale.`
                  : '\n  every claim still matches the source.');
  return bad;
}

// -------------------------------------------------------------------- cli

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : dflt;
};

try {
  switch (cmd) {
    case 'hp':      tableHP(flag('stamina', 1)); break;
    case 'ability': tableAbility(); break;
    case 'climb':   climb(Number(rest[0] || 20), Number(rest[1] || 100), flag('stamina', 1)); break;
    case 'check':   process.exit(check() ? 1 : 0);
    default:
      console.log('usage: m59-progression.mjs hp [--stamina N] | ability | climb <from> <to> [--stamina N] | check');
      process.exit(1);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
