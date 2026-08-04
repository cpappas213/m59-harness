#!/usr/bin/env node
// Composite behaviours: the multi-step things a player does, done in one call.
//
// The primitive tools are faithful to the protocol, which makes them precise and
// tedious. Fighting one monster correctly is: find it, check you are armed, route to
// a square beside it, turn to face it, swing on the server's one-per-second clock,
// read your health between swings, decide whether to keep going, notice when it dies,
// then walk over the drops and pick them up. That is a dozen paced calls, and every
// one of them has a silent failure mode.
//
// A capable agent can drive that. A small one should not have to. Everything here is
// built from the same primitives and takes the same care — the difference is that the
// decisions are made in code instead of by the model, and reported afterwards so the
// model can still see what happened and disagree.
//
// The rule these follow: never fail silently, and never quietly do something the
// caller did not ask for. A skill that gives up says why, at which stage, and what
// the state was when it stopped.

import { OF, isTeleporter, describeObject } from './m59-parse.mjs';
// The Underworld's exits, and which city is nearest to any room. As a namespace,
// because escapeUnderworld re-exports most of it and a bare import would shadow.
import * as UW from './m59-underworld.mjs';

// Health fractions. Chosen from what the game does rather than taste: a monster that
// can take you from half to nothing in one exchange is common, and the server's
// one-action-per-second clock means fleeing takes several seconds during which you
// are still being hit.
export const DEFAULT_DISENGAGE_AT = 0.35;
export const DEFAULT_REST_UNTIL = 0.9;

const pct = v => (v && v.max ? v.value / v.max : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// VIGOR IS NOT SHAPED LIKE HEALTH AND MANA, and reading it with `pct` above deadlocked
// the whole fleet.
//
// Health and mana report {value, max}. Vigor reports {value, scale_max, rest_threshold}
// and has no `max` at all, so `pct(vitals.vigor)` is null. In restUntil's `done()` that
// null became `?? 1` — "vigor is 100% satisfied, always" — so restUntil answered
// "already recovered" the instant health was high, whatever the vigor target.
//
// The keeper meanwhile reads vigor CORRECTLY (m59-autopilot.mjs:62 vigorPct) and sends
// anyone under restBelow here to rest. The two disagreed every pass: the keeper decided
// "too tired, sit down", restUntil returned "already recovered" without sitting, and the
// rest branch returned before reaching farming or errands. A character below the vigor
// threshold therefore did nothing at all, for ever, while reporting a healthy activity
// and a full health bar. That is what k0 kills across the fleet looked like from inside.
const vigorFrac = g => (!g || g.value == null) ? null : g.value / (g.scale_max ?? 200);
const vitalFrac = (v, which) => which === 'vigor' ? vigorFrac(v?.vigor) : pct(v?.[which]);

// ---------------------------------------------------------------- equipment

// Rough ordering of what is worth wielding. GetWeapon returns nothing for an empty
// hand and UserAttack then falls back to punch, so anything beats nothing.
const WEAPON_WORDS = [
  [/greatsword|two.?hand/i, 9], [/battle ?axe|halberd/i, 8], [/long ?sword/i, 7],
  [/broadsword|scimitar/i, 6], [/mace|morning ?star|war ?hammer/i, 5], [/axe/i, 5],
  [/short ?sword|falchion/i, 4], [/sword/i, 4], [/dagger|knife/i, 2],
  [/staff|club|cudgel/i, 2], [/bow|crossbow|sling/i, 3],
];
export const weaponScore = name => {
  if (isJunk(name)) return 0;
  for (const [re, n] of WEAPON_WORDS) if (re.test(name)) return n;
  return 0;
};

// JUNK THAT LOOKS LIKE GEAR. kod/object/item/passitem/junk.kod builds thirteen items
// whose whole design is to carry a real item's ICON and a worthless body, and one of
// them is called "broken mace". weaponScore matched it on /mace/ and gave it 5 — ahead
// of a real dagger at 2 — so a character holding both wielded the junk. Junk is a
// PassiveItem and not a Weapon, so the wield silently did nothing and the character
// punched things while this function reported it was holding a mace.
//
// Junk is not literally worthless (value 5-30, junk.kod:27-90) but it is 10-40 weight
// and 10-40 bulk for it, and the broken mace is the only one that corrupts a decision.
export const JUNK_NAMES = [
  'broken mace', 'undecipherable book', 'fake chalice', 'glass pendant',
  'surplus legion helmet', 'tanned kriipa leather', 'scrap metal',
  "bones of konima's original war party", 'ketchikan hoop', 'pamyan drapery',
  'toy ant mask', 'rusty armor', 'water finding arrow',
];
export const isJunk = (name) => JUNK_NAMES.includes(String(name || '').trim().toLowerCase());

// A BROKEN WEAPON IS NOT RENAMED. Only its icon group changes (weapon.kod:788-836,
// viBroken_group), so nothing about the name, and nothing this client can see in the
// inventory, distinguishes a working long sword from a shattered one. `piHits <= 0` is
// the whole of it and it is server-side.
//
// What IS visible is what the server says, and it says three different things:
export const WEAPON_SHATTERED = /shatters into pieces/i;          // it broke just now, mid-fight
export const WEAPON_IS_BROKEN = /is broken; you can'?t use it/i;  // we tried to wield a dead one
export const WEAPON_CONDITION = /shattered by a powerful blow/i;  // seen when examining it
export const brokenWeaponText = (t) => WEAPON_SHATTERED.test(t || '') || WEAPON_IS_BROKEN.test(t || '')
                                    || WEAPON_CONDITION.test(t || '');

// Learned, per client, because it cannot be read. A weapon enters this set the moment
// the server refuses it or announces it shattering, and leaves only when it leaves the
// pack. Without it every pass re-picks the same dead sword — it still scores highest.
export const brokenSet = (c) => (c._brokenWeapons ??= new Set());

// A SWING THAT WAS REFUSED, AND THE ONE COMBAT FAILURE THE SERVER ACTUALLY ANNOUNCES.
//
// UserAttack (user.kod:4679) checks PFLAG_NO_FIGHT before it works out a stroke, and
// answers with this line instead of swinging. Resting sets that flag alongside
// PFLAG_NO_MOVE (player.kod:1162), so a character that sat down and never got back up
// swings at nothing for as long as anything keeps asking it to — and the combat lines
// read as a fight going badly rather than as a fight not happening.
//
// Worth knowing which way round the two refusals work: a MOVE from a resting player is
// bounced silently (user.kod:2988), an ATTACK is refused out loud. So movement has to be
// pre-empted by standing up first, and attacking can simply be believed.
export const CANNOT_SWING = /unable to lift your weapon/i;   // user.kod:119, user_no_fight
export const cannotSwingText = (t) => CANNOT_SWING.test(t || '');

// WHICH PROFICIENCY A WEAPON TRAINS. From viProficiency_Needed on each weapon class
// rather than from the skill names, because the two do not line up by spelling: every
// sword in the game routes to SKID_PROFICIENCY_SWORD (451) including the gold, mystic,
// nerudite and Riija swords, while the short sword has its own (457).
//
// THE NAMES ON THE RIGHT ARE THE SERVER'S, verbatim from each skill's own resource
// string, and seven of the eight used to be invented. "mace proficiency" is called
// "mace fighting"; the sword one is "fencing"; axe, scimitar and hammer are "wielding"
// rather than "proficiency"; the short sword is "short sword fighting". Only archery
// happened to be right.
//
// That mattered more than it looks, because the only consumer is a by-name lookup:
// every one of these returned a skill the character does not have, `abilityOf` gave
// null, and weaponRanking fell back to its crude name score. Both halves of the
// proficiency feature were broken at once and each hid the other — a wrong name looks
// exactly like a skill that has not been read.
export const WEAPON_PROFICIENCY = [
  [/short ?sword/i, 'short sword fighting'],         // profshsw.kod, SKID 457
  [/scimitar/i, 'scimitar wielding'],                // profscim.kod, SKID 453
  [/hammer/i, 'hammer wielding'],                    // profhamr.kod, SKID 454
  [/axe/i, 'axe wielding'],                          // profaxe.kod, SKID 455
  [/mace|morning ?star|club|cudgel/i, 'mace fighting'],        // profmace.kod, SKID 452
  [/bow|crossbow|sling|arrow/i, 'archery'],          // archery.kod, SKID 456
  [/sword|dagger|knife|falchion|blade/i, 'fencing'], // profswrd.kod, SKID 451
];

// The rest of the combat skills, by the server's names. Strokes are what you swing
// with and the defences are checked before their ability is even read — parry is zero
// without a weapon and block is zero without a shield (player.kod:4294).
export const STROKE_SKILLS = { slash: 'slash', thrust: 'thrust', fire: 'fire',
                               unarmed: 'Unarmed Combat' };
export const DEFENCE_SKILLS = { parry: 'parry', block: 'block', dodge: 'dodge' };
export const BRAWLING_SKILL = 'brawling';
export const proficiencyFor = (name) => {
  for (const [re, skill] of WEAPON_PROFICIENCY) if (re.test(name || '')) return skill;
  return null;
};

// The character's ability in a named skill. Returns null rather than 0 when it has
// simply not been read — "no skill" and "never asked" must not rank the same.
//
// THIS USED TO ALWAYS RETURN NULL, and nothing noticed because null is also the
// legitimate "not read yet" answer and weaponRanking falls back to the crude name
// score for it. Skill abilities are stat GROUP 4, and `statsById` indexes a stat by
// name only `if (s.name)` — but `name` comes from STAT_NAMES, which covers groups 1
// and 2 only. So a group-4 stat was filed under "4.7" and nothing else, and every
// by-name search of that map missed it. Proficiency-weighted weapon choice has
// therefore never actually run.
//
// The ability map is keyed by the skill's object id and carries its real name, which
// is what makes the by-name question answerable at all. The statsById scan stays as a
// fallback for clients that predate it.
export function abilityOf(c, skillName) {
  if (!skillName) return null;
  const fromMap = c?.abilityOf?.(skillName);
  if (Number.isFinite(fromMap)) return fromMap;
  const direct = c?.statsById?.get?.(skillName)?.value;
  if (Number.isFinite(direct)) return direct;
  for (const [k, v] of c?.statsById ?? []) {
    if (typeof k === 'string' && k.toLowerCase() === skillName.toLowerCase()
        && Number.isFinite(v?.value)) return v.value;
  }
  return null;
}

// WHAT TO WIELD, BEST FIRST.
//
// `priority` overrides the ordering with a list of name fragments — the point of it is
// training: a character with 90% sword and 11% axe will otherwise wield the sword for
// ever and never move the axe, because proficiency ranking is a feedback loop that
// rewards what you are already good at. Pass ['axe'] and it trains the axe.
export function weaponRanking(c, { priority = null } = {}) {
  const broken = brokenSet(c);
  const rows = (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    .filter(x => !isJunk(x.name) && weaponScore(x.name) > 0 && !broken.has(x.o.id))
    .map(x => {
      const skill = proficiencyFor(x.name);
      return { ...x, skill, ability: abilityOf(c, skill), base: weaponScore(x.name) };
    });
  if (priority?.length) {
    const rank = (n) => {
      const i = priority.findIndex(p => n.toLowerCase().includes(String(p).toLowerCase()));
      return i === -1 ? priority.length : i;
    };
    return rows.sort((a, b) => rank(a.name) - rank(b.name) || b.base - a.base);
  }
  // Proficiency first — a weapon you are good with hits more often than a nominally
  // bigger one you are not. Unread abilities fall back to the crude name score rather
  // than sorting as zero, which would put the greatsword last on a fresh login.
  return rows.sort((a, b) => (b.ability ?? -1) - (a.ability ?? -1) || b.base - a.base);
}

// THE SERVER'S OWN LIST OF WHAT IS EQUIPPED, or null if this client does not keep one.
// Nothing below is allowed to infer the answer when this returns null — it says so
// instead. See M59Client.equipment().
export const equippedNow = (c) => (c?.using instanceof Set ? c.using : null);

// The refusal you get for wielding something you are already wielding. Re-`use` is not
// a toggle and not a no-op: TryUseItem runs CheckPosition, which counts the item
// against its own slot (player.kod:3235), finds no room, and answers this
// (player.kod:131). The old code sent it every single fight and read the refusal as
// success, because the only text it checked for was the broken-weapon one.
export const HANDS_FULL = /hands are too full/i;
export const handsFullText = (t) => HANDS_FULL.test(t || '');

export async function equipBest(s, { priority = null, maxTries = 4 } = {}) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  const broken = brokenSet(c);
  const ranked = weaponRanking(c, { priority });
  if (!ranked.length)
    return { wielding: null, verified: false,
             ...(broken.size ? { known_broken: broken.size } : {}),
             note: 'nothing wieldable in the pack — you will fight with your fists, which ' +
                   'works but badly. Junk and weapons known to be broken are excluded.' };

  // ALREADY HOLDING THE RIGHT THING. `fight` calls this before every engagement, so
  // without the check the common case is a request spent on being told no — out of a
  // budget of five a second, in the second before a fight starts.
  const held = equippedNow(c);
  if (held?.has(ranked[0].o.id))
    return { wielding: ranked[0].name, id: ranked[0].o.id, verified: true,
             already_wielded: true, skill: ranked[0].skill, ability: ranked[0].ability,
             by: 'it was already in the server\'s use list — no request sent',
             considered: ranked.map(x => x.name) };

  // TRY, THEN CHECK. The previous version sent `use` and reported the name it had picked
  // without ever reading the reply, so a shattered weapon was reported as wielded for as
  // long as the character carried it. That is the whole of the "it never re-equips" bug:
  // nothing was wrong with the choosing, and nothing ever noticed the refusal.
  //
  // "Checked" now means the server put the id in plUsing and said so on BP_USE — not
  // merely that it did not complain. Those came apart in both directions: a refusal
  // with no text at all still read as success, and a hands-full refusal read as success
  // too because it is not the broken message.
  const rejected = [];
  for (const cand of ranked.slice(0, maxTries)) {
    const before = c.evSeq;
    await s.pacer.submit('use', () => c.use(cand.o.id));
    // Wait for whichever comes first: the use-list moving, or the server saying why not.
    const ev = await c.waitFor({ since: before, kinds: ['equipment', 'message'], timeoutMs: 3000 });
    const texts = ev.events.filter(e => e.text).map(e => e.text);
    if (texts.some(brokenWeaponText)) {
      broken.add(cand.o.id);
      rejected.push({ name: cand.name, id: cand.o.id, why: 'the server says it is broken' });
      continue;
    }
    const now = equippedNow(c);
    if (now && !now.has(cand.o.id)) {
      rejected.push({ name: cand.name, id: cand.o.id,
                      why: texts.find(handsFullText)
                        ? 'refused: hands too full — something else is in the way, and it was ' +
                          'not this weapon (we checked the use list first)'
                        : texts[0] || 'the server never added it to the use list, and said nothing' });
      continue;
    }
    return {
      wielding: cand.name, id: cand.o.id,
      verified: !!now,
      skill: cand.skill, ability: cand.ability,
      ...(priority ? { by: 'the priority list given' } : { by: 'proficiency, then weapon class' }),
      ...(now ? { confirmed_by: 'the server\'s use list (BP_USE)',
                  equipped: [...now] }
              : { note: 'NOT verified — this client keeps no use list, so all that is known ' +
                        'is that the server did not refuse out loud.' }),
      ...(rejected.length ? { rejected } : {}),
      considered: ranked.map(x => x.name),
      messages: texts,
    };
  }
  return { wielding: null, verified: false, rejected,
           considered: ranked.map(x => x.name),
           note: `every candidate was refused (${rejected.length}) — see \`rejected\` for which ` +
                 'were broken and which were blocked. Fighting bare-handed; the broken ones ' +
                 'should be dropped, see junkAndBroken().' };
}

// What is in the pack that should not be: junk, and weapons the server has refused.
// Returned rather than dropped, because dropping is the caller's decision to make.
//
// Anything currently equipped is excluded whatever its name. A junk NAME on a worn item
// is not a reason to strip the character — and "broken mace" is a real junk item, so
// the name test alone would happily list the mace somebody is holding.
export function junkAndBroken(c) {
  const broken = brokenSet(c);
  const worn = equippedNow(c) ?? new Set();
  return (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    .filter(x => !worn.has(x.o.id) && (isJunk(x.name) || broken.has(x.o.id)))
    .map(x => ({ id: x.o.id, name: x.name,
                 why: broken.has(x.o.id) ? 'broken — the server refuses to wield it' : 'junk' }));
}

// ---------------------------------------------------------------- resting

// HOW HEALTH ACTUALLY COMES BACK, because getting this wrong is expensive.
//
// It regenerates constantly, one point at a time, on a timer whose interval is set
// mostly by VIGOR (player.kod:5611, CalculateHealthTime):
//
//     ms_per_point = ((200 - vigor)^2 / 6 + 1000) * (125 - stamina) / 100
//                    * 100 / bound(max_health, 40, 100)     , clamped to [1000, 60000]
//
// At vigor 80 with 50 stamina and 26 max health that is about 6.4 seconds a point;
// at full vigor it is under 2. So resting IS the right move when hurt — not because
// resting heals, but because it restores vigor, and vigor is what sets the rate.
//
// THE GATE THAT CATCHES YOU: HealthTimer only awards the point if
// PFLAG_MOVED_SINCE_ENTRY is set (player.kod:2639) — "only gain health if we've
// moved since entry". Walk into a room, stand still, and you regenerate NOTHING, for
// ever. One of mine sat in an inn at 5 of 26 and rested twenty-nine times without
// recovering a single point, which looked exactly like a game with no regeneration
// in it. It is not. It is a game that wants you to take one step first.
//
// Flasks and heal spells are still worth carrying — they are the only way to get
// health back DURING a fight, when six seconds a point is far too slow to matter.
const HEALER_ITEM = /flask/i;
const HEAL_SPELL = /^(minor heal|heal|major heal|hospice)$/i;

export async function healUp(s, { target = 0.9, maxItems = 8 } = {}) {
  const c = s.need();
  const frac = () => { const h = c.vitals()?.health; return h && h.max ? h.value / h.max : null; };
  const before = frac();
  if (before === null || before >= target) return { healed: false, reason: 'already healthy', health: before };

  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const used = [];
  let flasks = c.inventory.filter(o => HEALER_ITEM.test(c.rsc.get(o.nameRsc) || ''));
  for (let i = 0; i < maxItems && flasks.length && (frac() ?? 1) < target; i++) {
    const f = flasks.shift();
    await s.pacer.submit('act', () => c.apply(f.id, c.selfId), 1050);
    await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 2500 });
    used.push('flask');
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 2000 });
    flasks = c.inventory.filter(o => HEALER_ITEM.test(c.rsc.get(o.nameRsc) || ''));
  }

  // A heal spell is free but costs mana, and a Shal'ille character has one.
  const spell = (c.spells || []).find(sp => HEAL_SPELL.test(c.rsc.get(sp.nameRsc) || ''));
  if (spell && (frac() ?? 1) < target) {
    for (let i = 0; i < 3 && (frac() ?? 1) < target; i++) {
      const before2 = frac();
      await s.pacer.submit('cast', () => c.cast(spell.id, [c.selfId]), 1050);
      await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 3000 });
      used.push(c.rsc.get(spell.nameRsc));
      if ((frac() ?? 0) <= (before2 ?? 0)) break;      // out of mana or reagents
    }
  }

  const after = frac();
  return {
    healed: after > before, used, health: { before, after },
    reached_target: after >= target,
    ...(after < target && !used.length ? {
      reason: 'nothing to heal with',
      note: 'no flask and no heal spell — but health does regenerate on its own, about ' +
            'once every few seconds, PROVIDED you have moved since entering this room ' +
            '(PFLAG_MOVED_SINCE_ENTRY). Take a step, then rest: resting raises vigor and ' +
            'vigor is what sets the regeneration rate.',
    } : {}),
  };
}

// EATING IS HOW YOU GET VIGOR ABOVE THE RESTING CEILING.
//
// Resting only takes vigor to piVigor_rest_threshold — 80 on a 200 scale. Above that
// the only lever is food: EatSomething calls AddExertion(-10000 * nutrition), and
// less exertion is more vigor (player.kod:5734). Vigor in turn sets the health
// regeneration rate, so a well-fed character both survives longer and recovers
// faster between fights. Players describe not wanting to fight under 100 vigor, and
// the arithmetic agrees with them.
//
// THE CONSTRAINT IS THE STOMACH, NOT THE MONEY. ReqEatSomething refuses when
// piStomach + filling > 100, and the stomach empties only with time — so what
// matters is nutrition per unit of FILLING, not nutrition per shilling:
//
//     inky cap mushroom   50 nutrition / 25 filling = 2.00   250sh
//     wheel of cheese     30 / 40 = 0.75                      80sh
//     meat pie            30 / 50 = 0.60                      80sh
//     loaf of bread       20 / 40 = 0.50                      60sh
//     apple               10 / 24 = 0.42                      25sh
//
// An inky cap is 2.7x the vigor per sitting that cheese is, for about 3x the price —
// roughly break-even on cost and far better on the thing that is actually scarce.
// EVERY NUMBER HERE IS FROM THE KOD, not from tasting.
//
// Read out of kod/object/item/passitem/numbitem/food/*.kod - each item sets
// viNutrition and viFilling, and food.kod's base class defaults to 10/50. Taking
// that default for a real item is the mistake this table used to make: "edible
// mushroom" is snack.kod, which overrides to 5/15, so it was filed at 0.20 when it
// is really 0.33 - and several cheap meats were recorded at filling 25 where the kod
// says 20 or 30. Two entries also carried a literal backspace byte where  was
// meant, so /stew/ and /apple/ could never match at all.
//
// Sorted by nutrition per unit of FILLING, the only ranking that matters: the
// stomach caps at 100 and drains 0.12 a second, so filling is what is scarce and
// shillings are not.
//
//   Inky-cap mushroom   50/25 = 2.00   not sold in shops; late drop, hoarded for wars
//   chocolate mint       5/5  = 1.00   tiny, and perfectly efficient
//   wheel of cheese     30/40 = 0.75   the best thing a shop will sell you
//   turkey leg          15/20 = 0.75
//   mug of stout         6/8  = 0.75
//   meat pie            30/50 = 0.60
//   stew                15/25 = 0.60
//   loaf of bread       20/40 = 0.50
//   waterskin            3/6  = 0.50
//   slice of pork        9/20 = 0.45   also bowl of soup, spideye
//   bunch of grapes      7/16 = 0.44
//   apple               10/24 = 0.42
//   edible mushroom      5/15 = 0.33   poor, but it clears in 125s and can be free
//   drumstick            9/30 = 0.30
//   goblet               3/10 = 0.30
const FOOD = [
  { re: /inky.?cap/i,       nutrition: 50, filling: 25 },
  { re: /chocolate mint/i,  nutrition: 5,  filling: 5 },
  { re: /wheel of cheese/i, nutrition: 30, filling: 40 },
  { re: /turkey leg/i,      nutrition: 15, filling: 20 },
  { re: /mug of/i,          nutrition: 6,  filling: 8 },
  { re: /meat pie/i,        nutrition: 30, filling: 50 },
  { re: /stew/i,            nutrition: 15, filling: 25 },
  { re: /loaf of bread/i,   nutrition: 20, filling: 40 },
  { re: /waterskin/i,       nutrition: 3,  filling: 6 },
  { re: /slice of pork|bowl of soup|spideye/i, nutrition: 9, filling: 20 },
  { re: /bunch of grapes/i, nutrition: 7,  filling: 16 },
  { re: /apple/i,           nutrition: 10, filling: 24 },
  { re: /edible mushroom/i, nutrition: 5,  filling: 15 },
  { re: /drumstick/i,       nutrition: 9,  filling: 30 },
  { re: /goblet/i,          nutrition: 3,  filling: 10 },
];
const foodValue = name => FOOD.find(f => f.re.test(name)) || null;

// THE STOMACH, MODELLED — because the protocol never sends it.
//
// piStomach is server-side and nothing reports it, but it is fully determined by two
// things we can see and one constant we can read:
//
//   EatSomething:   piStomach += filling                      (player.kod:5744)
//   UpdateStomach:  piStomach -= elapsed_seconds * 12 / 100   (player.kod:1347)
//   ReqEatSomething refuses when piStomach + filling > 100     (player.kod:5703)
//
// So it drains 0.12 a second — a full stomach takes 833 seconds, 13.9 minutes, which
// the kod states outright and then adds the line that matters most: "Need empty
// stomach to get vigor boost from food."
//
// Tracking it locally turns "eat and hope" into arithmetic: we know before asking
// whether a given food will fit, and how many seconds until it would. And the model
// is self-correcting — a refusal is itself a measurement, since being told no to a
// food of filling F proves the stomach is above 100 - F.
export const STOMACH_CAP = 100;
export const STOMACH_DRAIN_PER_SEC = 0.12;        // FOOD_USE_RATE 12, applied /100

export class Stomach {
  constructor(value = 0) { this.value = value; this.at = Date.now(); }
  #settle() {
    const now = Date.now();
    this.value = Math.max(0, this.value - (now - this.at) / 1000 * STOMACH_DRAIN_PER_SEC);
    this.at = now;
  }
  get level() { this.#settle(); return this.value; }
  ate(filling) { this.#settle(); this.value = Math.min(STOMACH_CAP, this.value + filling); }
  // A refusal is evidence, not just a failure.
  refused(filling) { this.#settle(); this.value = Math.max(this.value, STOMACH_CAP - filling + 1); }
  roomFor(filling) { return this.level + filling <= STOMACH_CAP; }
  secondsUntilRoomFor(filling) {
    const over = this.level + filling - STOMACH_CAP;
    return over <= 0 ? 0 : Math.ceil(over / STOMACH_DRAIN_PER_SEC);
  }
}

// What is worth eating next, best nutrition per unit of filling first, and whether
// there is currently room for it. Lets a caller decide to WAIT rather than ask.
export function larderOf(c) {
  return c.inventory
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '', food: foodValue(c.rsc.get(o.nameRsc) || '') }))
    .filter(x => x.food)
    .sort((a, b) => (b.food.nutrition / b.food.filling) - (a.food.nutrition / a.food.filling));
}

// WHAT THE FLEET WANTS, so that nothing another character needs is ever sold to an NPC.
//
// A merchant buys low and sells high. A herb sold by one character and bought back by
// another pays that spread TWICE, and the fleet is a single owner — the only reason a
// reagent ever reached a shop counter is that neither end knew about the other. Worse
// than the money: `create food` refuses silently without 2 ElderBerry and 2 Herbs, so a
// character that sold its herbs cannot raise its vigor above the 80 that resting gives,
// and fights permanently tired next to someone carrying sixty of them.
//
// A process-wide board rather than anything on the wire — every keeper in this broker
// writes what it is short of and what it can spare, and the sell and drop paths read the
// aggregate before letting anything go. When the guild hall lands, its store is another
// holder to publish into this same board rather than a second mechanism.
export const interest = {
  byAgent: new Map(),          // agent -> { wants:Set<string>, spare:Map<string,number>, at:number }

  declare(agent, { wants = [], spare = new Map() } = {}) {
    this.byAgent.set(agent, {
      wants: new Set(wants.map(w => String(w).toLowerCase())),
      spare: spare instanceof Map ? spare : new Map(Object.entries(spare)),
      at: Date.now(),
    });
  },
  forget(agent) { this.byAgent.delete(agent); },

  // Who wants a thing by this name — matched loosely, because the server hands us
  // display names ("herb", "elderberry") and callers think in kinds.
  wantedBy(name, { except = null } = {}) {
    const n = String(name || '').toLowerCase();
    if (!n) return [];
    const out = [];
    for (const [agent, rec] of this.byAgent) {
      if (agent === except) continue;
      for (const w of rec.wants) if (n.includes(w) || w.includes(n)) { out.push(agent); break; }
    }
    return out;
  },
  anyoneWants(name, opts) { return this.wantedBy(name, opts).length > 0; },

  // Who is carrying spare of a thing, most first. Used to pair a giver with a needer.
  holdersOf(kind) {
    const k = String(kind || '').toLowerCase();
    return [...this.byAgent].filter(([, r]) => (r.spare.get(k) ?? 0) > 0)
      .map(([agent, r]) => ({ agent, count: r.spare.get(k) }))
      .sort((a, b) => b.count - a.count);
  },

  board() {
    return [...this.byAgent].map(([agent, r]) => ({
      agent, wants: [...r.wants], spare: Object.fromEntries(r.spare),
    }));
  },
};

// The things a fleet member is ever worth holding for somebody else. Deliberately short:
// the point is to stop reagents leaking to vendors, not to turn every character into a
// warehouse. Weight is the reason this is a list and not "anything anyone wants".
export const SHAREABLE = [
  { kind: 'elderberry', re: /elder\s?berry/i, why: 'create food, 2 per casting' },
  { kind: 'herb',       re: /^herbs?$/i,      why: 'create food, 2 per casting' },
];
export const shareKind = (name) => SHAREABLE.find(s => s.re.test(String(name || '')))?.kind ?? null;

// What in the pack could be swung at something, best first.
//
// The mirror of larderOf, and it exists for the same reason: "can this character
// actually fight?" and "can it actually keep fighting?" are the two questions a fleet
// page has to answer, and both of them are about what is in the pack rather than
// about any number the server reports. A character with no weapon is not hunting, it
// is standing in a monster room punching things — GetWeapon returns nothing for an
// empty hand and UserAttack quietly falls back to a punch, so nothing about it reads
// as broken from the outside.
export function weaponsOf(c) {
  return (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    .map(x => ({ ...x, score: weaponScore(x.name) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Vigor is capped at 200, and nutrition converts to it one for one: EatSomething
// calls AddExertion(-10000 * nutrition), and the rest timer awards a single point
// with RestAddExertion(-10000). So an inky cap is fifty vigor — and eating one at
// 190 throws forty of them away along with the stomach room, which is the resource
// that actually runs out. `maxWaste` is how much overshoot is tolerable.
export const VIGOR_MAX = 200;

export async function eat(s, { maxItems = 4, stomach = null, upToVigor = null,
                               maxWaste = 12 } = {}) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const vig = () => c.vitals()?.vigor?.value ?? null;
  const before = vig();

  // Best nutrition per unit of filling first — the stomach is what runs out.
  const larder = larderOf(c);

  if (!larder.length)
    return { ate: [], filling: 0, vigor: before, reason: 'carrying no food',
             note: 'vigor above the resting threshold of 80 comes only from eating; ' +
                   'inky cap mushrooms are the most stomach-efficient thing to carry' };

  const ate = [];
  let filling = 0, tooFull = false, wasteful = 0;
  for (const item of larder.slice(0, maxItems)) {
    // Stop once we have what we came for; the rest of the larder keeps, and stomach
    // room spent now is room unavailable during the fight.
    if (upToVigor != null && (vig() ?? 0) >= upToVigor) break;
    // Do not spend a request on a mouthful we already know will be refused.
    if (stomach && !stomach.roomFor(item.food.filling)) { tooFull = true; continue; }
    // Do not spend fifty vigor of mushroom to gain five. Skip it and try something
    // smaller; the good stuff keeps, and the stomach room does not.
    if ((vig() ?? 0) + item.food.nutrition - VIGOR_MAX > maxWaste) { wasteful++; continue; }

    const b = c.evSeq;
    await s.pacer.submit('act', () => c.apply(item.o.id, c.selfId), 1050);
    const ev = await c.waitFor({ since: b, kinds: ['message', 'stat'], timeoutMs: 2500 }).catch(() => ({ events: [] }));
    // "You are too full to eat" means the stomach is the binding constraint; stop
    // rather than spending the rest of the larder on refusals — and record what the
    // refusal just told us about how full we are.
    if (ev.events?.some(e => /too full/i.test(e.text || ''))) {
      stomach?.refused(item.food.filling);
      tooFull = true;
      break;
    }
    stomach?.ate(item.food.filling);
    filling += item.food.filling;
    ate.push(item.name);
  }
  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  return { ate, filling, tooFull, wasteful, vigor: { before, after: vig() },
           note: ate.length ? undefined
             : wasteful ? 'already near full vigor; not spending stomach room on overshoot'
             : 'too full to eat anything — the stomach empties with time' };
}

export const foodInInventory = (c) =>
  c.inventory.filter(o => foodValue(c.rsc.get(o.nameRsc) || '')).length;

// Make sure the regeneration timer will actually pay out.
//
// HealthTimer refuses to award a point unless the player has moved since entering the
// room, so a character that walks in and stops recovers nothing at all no matter how
// long it waits. One step is enough to set the flag, and it is cheap — a second.
export async function nudge(s) {
  const c = s.need();
  const me = c.self;
  if (!me) return { moved: false, why: 'position unknown' };
  const geo = s.world?.geometry;
  const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  // TRY THE EMPTY SIDES FIRST. In a crowded inn the neighbouring squares are other
  // characters, and a step into one is refused — so a nudge that walks the ring in a
  // fixed order can burn all eight attempts against the pile it is standing in and
  // report "every neighbouring square refused". The flag stays unset, and the
  // character regenerates nothing for as long as the crowd lasts.
  const c2 = c.room?.objects;
  const taken = new Set(c2 ? [...c2.values()].filter(o => o.id !== c.selfId)
                              .map(o => `${o.col},${o.row}`) : []);
  deltas.sort((a, b) => (taken.has(`${me.col + a[0]},${me.row + a[1]}`) ? 1 : 0) -
                        (taken.has(`${me.col + b[0]},${me.row + b[1]}`) ? 1 : 0));
  for (const [dc, dr] of deltas) {
    const col = me.col + dc, row = me.row + dr;
    if (geo && !geo.walkable(row, col)) continue;
    await s.pacer.submit('move', () => c.moveToSquare(col, row), 1050);
    await sleep(250);
    const now = c.self;
    if (now && (now.col !== me.col || now.row !== me.row))
      return { moved: true, from: { col: me.col, row: me.row }, to: { col: now.col, row: now.row },
               why: 'health regeneration is gated on having moved since entering the room' };
  }
  return { moved: false, why: 'every neighbouring square refused' };
}

// ARM THE SAME TIMER WITHOUT LEAVING THE SQUARE.
//
// nudge() steps, and a step is exactly what you must not do when you are standing in
// a safe spot: the spot is a place, and the moment you leave it the walls stop
// covering you. Turning sets PFLAG_MOVED_SINCE_ENTRY the same way a step does — the
// flag is about having acted, not about having travelled — so a character that has
// just reconnected can arm its own health regeneration, wake the monsters it is
// hiding from, and still be somewhere they cannot reach.
//
// REQ_TURN carries no coordinates, so this cannot move us even if the server
// disagrees with our idea of where we are. Verified anyway, because a "safe spot"
// that quietly drifted is worse than no safe spot at all.
export async function turnInPlace(s, { degrees = null, verify = true } = {}) {
  const c = s.need();
  const me = c.self;
  if (!me) return { turned: false, why: 'position unknown' };
  const from = me.degrees ?? 0;
  const to = degrees ?? Math.round((from + 90) % 360);
  const was = { col: me.col, row: me.row, x: me.x, y: me.y };
  await s.pacer.submit('turn', () => c.face(to));
  await sleep(300);
  if (!verify) return { turned: true, from, to, moved: false };
  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
  const now = c.self;
  const moved = !!now && (now.col !== was.col || now.row !== was.row);
  return {
    turned: true, from, to, moved,
    position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
    why: 'turning arms the health regeneration timer without giving up the square',
  };
}

// Go back to an EXACT position, to the fine unit.
//
// moveToSquare aims at the centre of a square (col*64+32). A safe spot that works by
// hugging a wall can be most of a square off that centre, so "walk back to (25,23)"
// is not the same request as "stand where I was standing", and the difference is the
// difference between a wall at your back and a wall nearby. Fine movement is the only
// way to say the second one.
export async function returnToSpot(s, spot, { maxSteps = 20, tolerance = 12 } = {}) {
  const c = s.need();
  if (!spot) return { arrived: false, why: 'no spot given' };
  const at = () => {
    const me = c.self;
    if (!me) return null;
    if (spot.x == null) return me.col === spot.col && me.row === spot.row ? 0 : Infinity;
    return Math.hypot(me.x - spot.x, me.y - spot.y);
  };
  const d0 = at();
  if (d0 !== null && d0 <= tolerance) return { arrived: true, already: true, off_by: d0 };

  // Get onto the right square first through the geometry, then close the last few
  // fine units directly — the square router cannot express the last bit.
  if (c.self && (c.self.col !== spot.col || c.self.row !== spot.row)) {
    const w = await s.walkTo(spot.col, spot.row, { maxSteps }).catch(e => ({ arrived: false, reason: e.message }));
    if (!w.arrived) return { arrived: false, why: w.reason || 'could not walk back to the square' };
  }
  if (spot.x != null && s.walkFine) {
    await s.walkFine(spot.x, spot.y, { maxSteps: 6, stride: 40, arriveWithin: tolerance })
           .catch(() => null);
  }
  const d = at();
  return { arrived: d !== null && d <= tolerance, off_by: d,
           position: c.self ? { col: c.self.col, row: c.self.row, x: c.self.x, y: c.self.y } : null };
}

// Sit until a vital comes back, or until nothing is improving. Resting is silent
// unless something changes, so "no reply" is the normal case and cannot be used as a
// stop condition — the stop condition has to be the numbers themselves.
// STOP RESTING IF THE RESTING IS NOT WORKING.
//
// `abortOnDamage` is on by default and is the difference between a rest and a
// beating. Resting restores health slowly and does nothing whatsoever to stop
// anything hitting you, so the only evidence that a rest is going badly is that
// health is going DOWN — and the loop below already reads vitals every three
// seconds to decide whether it is finished. It simply never asked.
//
// Zoot rested 61 seconds on a square proven safe while four mummies that the proof
// never covered took him from 17 health to 3. Every one of those reads saw the
// number falling and none of them was allowed to care. Three seconds of that is a
// bad break; a minute of it is nearly a death.
export async function restUntil(s, { health = DEFAULT_REST_UNTIL, vigor = DEFAULT_REST_UNTIL,
                                     maxSeconds = 120, abortOnDamage = true } = {}) {
  const c = s.need();
  const read = async () => {
    await s.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
    return c.vitals();
  };
  let v = await read();
  const started = { ...v };
  const done = () => (vitalFrac(v, 'health') ?? 1) >= health && (vitalFrac(v, 'vigor') ?? 1) >= vigor;
  if (done()) return { rested: false, note: 'already recovered', vitals: v };

  await s.pacer.submit('rest', () => c.rest());
  const t0 = Date.now();
  let stalled = 0, last = -1, interrupted = null;
  // The best health seen SO FAR in this rest, not the health we sat down at: a rest
  // that climbs 12 -> 16 and is then hit back to 14 is being interrupted, and
  // comparing against the starting 12 would call that progress and sit through it.
  let peak = v?.health?.value ?? null;
  while (Date.now() - t0 < maxSeconds * 1000) {
    await sleep(3000);
    v = await read();
    const hp = v?.health?.value ?? null;
    if (abortOnDamage && hp != null) {
      if (peak == null || hp > peak) peak = hp;
      else if (hp < peak) {
        // Health only falls while resting if something is hitting us. Whatever the
        // caller believed about this square, it is wrong NOW — hand that back rather
        // than sitting out the remaining leash.
        interrupted = `took ${peak - hp} damage while resting — something is hitting us`;
        break;
      }
    }
    if (done()) break;
    // A room can prevent resting, and standing back up is silent too. If nothing has
    // moved for three checks, say so rather than sitting for the full timeout.
    const now = (vitalFrac(v, 'health') ?? 0) + (vitalFrac(v, 'vigor') ?? 0);
    if (Math.abs(now - last) < 0.001) { if (++stalled >= 3) break; } else stalled = 0;
    last = now;
  }
  await s.pacer.submit('rest', () => c.stand());
  return {
    rested: true,
    seconds: Math.round((Date.now() - t0) / 1000),
    from: started, vitals: v,
    reached_target: done(),
    // Set when the rest was cut short by incoming damage. Callers should treat this
    // as "the square you trusted is not working", not as an ordinary short rest.
    interrupted,
    note: interrupted ? interrupted
      : done() ? undefined
      : (stalled >= 3 ? 'nothing recovered for several checks — something may be preventing rest, or you are already at your ceiling'
                      : 'timed out before reaching the target'),
  };
}

// A CHARACTER THAT SAT DOWN AND WAS NOT STOOD BACK UP CAN DO NEITHER OF THE TWO THINGS
// IT MOST NEEDS TO DO.
//
// Resting sets PFLAG_NO_MOVE and PFLAG_NO_FIGHT together (player.kod:1162,
// ResetPlayerFlagList), and only standing up or logging off clears resting — not death,
// not being attacked, not changing room. So the state outlives whatever caused it: a
// character killed mid-rest wakes in the Underworld still sitting, and a keeper that
// rested in a safe spot and lost its stand goes on being unable to swing.
//
// The two refusals behave differently, which is why they need different handling:
//
//   move    bounced SILENTLY. user.kod:2988 puts you back on the square you are already
//           on and returns, so it looks like walls, not posture — pre-empt it.
//   attack  refused OUT LOUD, "unable to lift your weapon" (user.kod:4679) — believe it
//           and recover. See CANNOT_SWING above.
//
// Standing when already standing costs nothing: UC_STAND is StopResting, which returns
// immediately when there is no rest timer. Resting is silent in both directions, so there
// is no posture to read and nothing to be gained by asking first. Just stand.
export async function standUp(s) {
  const c = s.need();
  await s.pacer.submit('rest', () => c.stand());
  await sleep(300);
}

// ---------------------------------------------------------------- finding

// Resolve a creature by name against what is actually in the room, preferring things
// that can be attacked and are close. Takes a partial name, because an agent thinks
// "spider" and the world says "baby spider".
// CREATURES, NOT PEOPLE.
//
// Every character in the game is ATTACKABLE, so "the nearest attackable thing" happily
// resolves to another player — and this fleet stands its characters next to each other
// constantly, in inns and increasingly on the same safe walls. Left unfiltered it does
// not merely pick one occasionally: 131 of 132 "hit back at whatever is adjacent"
// decisions across the fleet were aimed at a FLEETMATE, and twenty-five characters
// produced three kills between them while swinging at each other all night. Guardian
// angels meant nobody actually died of it; nobody achieved anything either.
//
// Excluding players by default is right for every caller here — you hunt creatures —
// and PvP, if it is ever wanted, should have to say so out loud.
export function findCreature(s, needle, { attackableOnly = true, includePlayers = false } = {}) {
  const c = s.need();
  const me = c.self;
  const low = String(needle ?? '').toLowerCase();
  let list = [...c.room.objects.values()].filter(o => o.id !== c.selfId);
  if (!includePlayers) list = list.filter(o => !(o.flags & OF.PLAYER));
  if (attackableOnly) list = list.filter(o => o.flags & OF.ATTACKABLE);
  if (low) list = list.filter(o => c.rsc.get(o.nameRsc).toLowerCase().includes(low));
  if (me) {
    const d = o => Math.hypot(o.col - me.col, o.row - me.row);
    list.sort((a, b) => d(a) - d(b));
  }
  return list;
}

// ---------------------------------------------------------------- fighting

// The whole engagement, from "there is a spider somewhere" to "the spider is dead and
// I picked up what it dropped".
//
// The safety rails are the point. A model that has never played this game does not
// know that a fey elhai will kill a twenty-hit-point character in two exchanges, that
// fleeing takes seconds it may not have, or that its own attacks are silently
// discarded if it swings twice in a second. So: read health every round, disengage on
// a threshold, and stop rather than dying — but report everything, so the caller can
// override next time.
export async function fight(s, {
  target,
  // The id of a creature we have already hurt. A kill scores nothing unless we
  // damaged it AND it was our current target, and every new attack resets those
  // flags (player.kod:7764-7816) — so breaking off a wounded creature and coming
  // back to whatever is nearest throws away the work AND leaves a half-dead monster
  // to heal. Prefer the one we were already fighting, whenever it is still here.
  preferId = null,
  rounds = 12,
  swingsPerRound = 4,
  disengageAt = DEFAULT_DISENGAGE_AT,
  loot = true,
  equip = true,
  // FIGHT WITHOUT MOVING. In a safe spot the square IS the advantage, so approaching
  // is not a helpful convenience — it is throwing the fight's entire premise away to
  // save a few seconds. With this set, anything out of reach is reported as out of
  // reach and the caller decides what to do about it (pull it over, or wait).
  holdPosition = false,
  // How far a swing carries. One square plus the diagonal; the caller can widen it
  // for a bow.
  reach = 1.5,
  // Name fragments overriding which weapon to reach for. See weaponRanking.
  weaponPriority = null,
} = {}) {
  const c = s.need();
  const log = [];
  const say = (stage, detail) => { log.push({ stage, ...detail }); return detail; };

  // Refresh before choosing: an id from a stale look may be a corpse by now.
  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });

  const candidates = findCreature(s, target);
  if (!candidates.length) {
    const present = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE))
      .map(o => c.rsc.get(o.nameRsc));
    return {
      fought: false, reason: target ? `nothing here matches "${target}"` : 'nothing here can be attacked',
      attackable_here: [...new Set(present)],
      note: present.length ? 'try one of the names above' : 'this room has nothing to fight — travel somewhere else',
    };
  }
  // Holding a position narrows the field to what we can hit from it. Choosing a foe
  // first and discovering afterwards that it is across the room wastes the pass;
  // worse, `preferId` would keep re-selecting the same unreachable creature forever.
  const me0 = c.self;
  const within = o => !me0 || Math.hypot(o.col - me0.col, o.row - me0.row) <= reach;
  const inReach = holdPosition ? candidates.filter(within) : candidates;
  if (holdPosition && !inReach.length) {
    const nearest = candidates[0];
    return {
      fought: false, out_of_reach: true,
      reason: 'holding position and nothing matching is within reach',
      nearest: nearest ? { id: nearest.id, name: c.rsc.get(nearest.nameRsc),
                           distance: me0 ? +Math.hypot(nearest.col - me0.col, nearest.row - me0.row).toFixed(1) : null,
                           col: nearest.col, row: nearest.row } : null,
      note: 'pull it to you, or give up the spot deliberately — do not drift off it',
    };
  }

  const resumed = preferId != null && inReach.find(o => o.id === preferId);
  const foe = resumed || inReach[0];
  const foeName = c.rsc.get(foe.nameRsc);
  say('chose', { target: describeObject(foe, c.lookup),
                 ...(resumed ? { resumed: 'the one we already damaged' } : {}),
                 ...(holdPosition ? { holding: 'fighting from where we stand' } : {}) });

  let wielded = null;
  if (equip) {
    const e = await equipBest(s, { priority: weaponPriority });
    wielded = e.id ?? null;
    say('equipped', { wielding: e.wielding, verified: e.verified, skill: e.skill,
                      ability: e.ability, rejected: e.rejected, note: e.note });
  }

  // Health BEFORE, so the report can say what the fight cost.
  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  const before = c.vitals();
  const startPct = pct(before.health);
  if (startPct !== null && startPct < disengageAt)
    return { fought: false, reason: `starting health is ${Math.round(startPct * 100)}%, already below the disengage threshold`,
             vitals: before, note: 'rest first' };

  // Close and face. approachSquare routes to a square BESIDE it — you cannot stand
  // where a monster stands — and faceToward matters because an attack on something
  // behind you is refused with a message about view, not range.
  const spot = holdPosition ? null : s.world?.approachSquare?.(foe.col, foe.row);
  if (spot && spot.steps > 0) {
    const walk = await s.walkTo(spot.col, spot.row, { maxSteps: Math.max(30, spot.steps + 10) });
    say('approached', { arrived: walk.arrived, steps: walk.steps, reason: walk.reason });
    if (!walk.arrived)
      return { fought: false, reason: walk.reason || 'could not get to it', log,
               note: 'the geometry may not connect, or something is in the way' };
  }

  let killed = false, disengaged = null, roundsFought = 0, drifted = null, stoodUp = false;
  const combatLines = [];
  for (let r = 0; r < rounds; r++) {
    if (!c.room.objects.has(foe.id)) { killed = true; break; }
    // It backed off. Swinging at nothing is free, but the server refuses the swing
    // and the caller needs to know the creature broke contact rather than that we
    // are missing — those call for opposite responses.
    if (holdPosition) {
      const here = c.self, it = c.room.objects.get(foe.id);
      if (here && it && Math.hypot(it.col - here.col, it.row - here.row) > reach) {
        drifted = { distance: +Math.hypot(it.col - here.col, it.row - here.row).toFixed(1) };
        break;
      }
    }
    const b = c.evSeq;
    const res = await s.attackRounds(foe.id, swingsPerRound);
    roundsFought++;
    combatLines.push(...res.messages);

    // WE ARE STILL SITTING DOWN, AND THE SERVER JUST SAID SO.
    //
    // "You find yourself unable to lift your weapon." is PFLAG_NO_FIGHT, which resting
    // sets (player.kod:1162). Nothing clears resting but standing or logging off, so a
    // rest that was cut short, or a safe spot the keeper sat down in and never got back
    // up from, turns every swing from here on into that line — a fight that reads like
    // bad luck and is actually a posture. Stand and take the round again.
    //
    // Standing is not a cure for the rest of that flag's causes. Hold, Dazzle, Blind and
    // a DM freeze set it too, and for those the honest answer is to stop and name them,
    // not to spend eleven more rounds being refused.
    if (res.messages.some(cannotSwingText)) {
      if (stoodUp)
        return { fought: false, could_not_swing: true, stood_up: true,
                 target: foeName, foe_id: foe.id, rounds: roundsFought,
                 reason: 'every swing was refused: "unable to lift your weapon"',
                 combat: combatLines.slice(-8), log,
                 note: 'standing up did not clear it, so this is not resting. The same flag is set by ' +
                       'Hold, Dazzle, Blind and a DM freeze — wait for the enchantment to lapse. More ' +
                       'swings now cost packets and do nothing.' };
      stoodUp = true;
      await standUp(s);
      say('stood up', { because: 'every swing was refused — we were sitting down', round: roundsFought });
      continue;
    }

    // IT BROKE MID-FIGHT, which is the ordinary way a weapon leaves service and was
    // previously invisible. ReqWeaponAttack unequips the weapon itself (weapon.kod:513)
    // and every later swing is a punch, so a character finished the fight, and the next
    // twenty fights, bare-handed while the keeper reported it armed. Re-arm here rather
    // than at the next pass: the rest of THIS fight is the part that was being lost.
    if (res.messages.some(brokenWeaponText)) {
      if (wielded != null) brokenSet(c).add(wielded);
      say('weapon broke', { was: wielded, round: roundsFought });
      if (equip) {
        const again = await equipBest(s, { priority: weaponPriority });
        wielded = again.id ?? null;
        say('re-armed', { wielding: again.wielding, verified: again.verified, note: again.note });
      }
    }

    // Are we dead? "Our own object is missing from the room list" is NOT the test,
    // however obvious it looks. It is also true when a save-game renumbers object
    // ids underneath a live session, and then a character standing at full health
    // reports being killed on every single pass, forever. Corroborate it: the
    // Underworld is a named room, and a corpse has no health.
    const gone = !c.room.objects.has(c.selfId);
    const inUnderworld = /underworld/i.test(c.rsc.get(c.roomNameRsc) || '');
    const noHealth = (c.vitals()?.health?.value ?? 1) <= 0;
    if (gone && (inUnderworld || noHealth)) {
      return { fought: true, killed: false, died: true, rounds: roundsFought,
               combat: combatLines.slice(-8), log,
               note: 'we were killed. You are in the Underworld; the way out is a portal — see escape_underworld.' };
    }
    if (gone) {
      // Missing but alive and not in the Underworld: our id is stale, not our body.
      return { fought: true, killed: false, died: false, rounds: roundsFought,
               combat: combatLines.slice(-8), log, stale_identity: true,
               note: 'our own object id is not in the room contents but we are alive and not in the ' +
                     'Underworld — the server most likely renumbered ids in a save. Re-login to ' +
                     'resolve a fresh id; do NOT treat this as death.' };
    }

    const v = c.vitals();
    const hp = pct(v.health);
    if (hp !== null && hp < disengageAt) {
      disengaged = { at_health: Math.round(hp * 100) + '%' };
      break;
    }
    if (!c.room.objects.has(foe.id)) { killed = true; break; }
  }

  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  const after = c.vitals();

  const out = {
    fought: true, target: foeName, killed, rounds: roundsFought,
    health: { before: before.health, after: after.health },
    // Worth saying out loud: it means a round went nowhere, and it means whatever sat
    // this character down is not doing so again by itself.
    ...(stoodUp ? { stood_up: 'the first round was refused — we were resting' } : {}),
    combat: combatLines.slice(-10),
    // Pass this back as preferId next time. A wounded creature we walk away from is
    // both credit we have already earned and a monster that will heal if left, so
    // the caller needs to be able to name it rather than re-pick the nearest.
    foe_id: killed ? null : foe.id,
    log,
  };

  if (disengaged) {
    out.disengaged = disengaged;
    out.held_position = holdPosition || undefined;
    // The advice inverts inside a safe spot, and getting it the wrong way round is
    // fatal. Out in the open, walking away is what stops the damage. In a safe spot,
    // walking away is what STARTS it: nothing can land a blow while you stand still
    // and do not swing, so the recovery move is to sit down where you are.
    out.note = holdPosition
      ? `broke off at ${disengaged.at_health} health while holding a safe spot. Do NOT walk away — ` +
        `rest where you stand. Nothing can hit you here unless you swing first, so this is a ` +
        `free heal back to full and then the fight again from the top.`
      : `broke off at ${disengaged.at_health} health. The monster is still there and still hostile — ` +
        `walk away before resting, or it will keep hitting you.`;
    return out;
  }
  if (drifted) {
    out.drifted_out_of_reach = drifted;
    out.note = `it moved out of reach (${drifted.distance} squares) and we are holding position. ` +
               `Pull it back or wait — chasing it is what the spot is for not doing.`;
    return out;
  }
  if (!killed) {
    out.note = `still alive after ${roundsFought} rounds. Either it is too strong, or your attacks are missing — ` +
               `check the combat lines: "too far away" means the geometry moved you, "avoids/dodges" means you are just unlucky.`;
    return out;
  }

  if (loot) {
    const l = await s.lootFloor({ stayPut: holdPosition });
    out.looted = l.taken;
    out.refused = l.refused?.length ? l.refused : undefined;
    out.carrying = l.carrying;
  }
  return out;
}

// ---------------------------------------------------------------- escaping

// Getting out of the Underworld, which is where you wake up after dying and which has
// no exits in the room graph at all.
//
// Six teleporters, and the difference between them is the whole of this function:
//
//   FIVE FIXED PORTALS in a pentagram, each with a destination hard-coded at room
//   construction (uworld.kod:649-662). One or two are unlit at random (ResetPuzzle,
//   uworld.kod:460) and an unlit one is SILENT — Portal.SomethingMoved returns
//   immediately when it is not animating — so a dead portal and a portal you never
//   reached look identical unless you check which happened.
//
//   ONE SHIFTING PORTAL, the "rip in space", re-rolling every 5-10 seconds among the
//   same five inns and only saying where it leads if you LOOK at it.
//
// THIS USED TO ONLY KNOW ABOUT THE RIP. Asking for a named city meant standing beside
// the anomaly polling it for up to three minutes — while a portal that goes to that
// city every time, without waiting, stood a few squares away. Now a named city walks
// to its own portal, and the rip is the fallback rather than the plan.
//
// The tables, the descriptions and the nearest-city graph live in m59-underworld.mjs.
export { RIP_DESTINATIONS, readRipDestination, UNDERWORLD_PORTALS, nearestCity,
         citiesByDistance, CITY_INNS, KOCATAN_IS_DEATH_ONLY } from './m59-underworld.mjs';

// Which teleporters in this room are which. The rip announces itself by name, so it
// costs nothing; the fixed ones have to be looked at, and each look is a request out of
// a budget of five a second — so they are looked at in the order most likely to end the
// search, not all of them up front.
async function identifyPortals(s, found, { want = null, maxLooks = 6 } = {}) {
  const c = s.need();
  const rows = found.map(o => {
    const name = c.rsc.get(o.nameRsc) || '';
    const expected = UW.UNDERWORLD_PORTALS.find(
      p => p.clientCol === o.col && p.clientRow === o.row) ?? null;
    return { o, name, rip: UW.RIP_NAME.test(name), expected, city: null, desc: null };
  });

  // The rip needs no look to be identified, and looking at it here would be wasted —
  // its answer expires in seconds and is only useful immediately before stepping on.
  const toLook = rows.filter(r => !r.rip);

  // Best first: the portal whose square matches the one we want, then everything else
  // by how far it is to walk. The coordinates are only a hint — the description is what
  // decides — but a hint that is right most of the time saves four looks.
  toLook.sort((a, b) => {
    const aw = a.expected?.city === want ? 0 : 1;
    const bw = b.expected?.city === want ? 0 : 1;
    if (aw !== bw) return aw - bw;
    const ar = s.world?.reach?.(a.o.col, a.o.row)?.steps ?? 99;
    const br = s.world?.reach?.(b.o.col, b.o.row)?.steps ?? 99;
    return ar - br;
  });

  let looks = 0;
  for (const r of toLook) {
    if (looks >= maxLooks) break;
    looks++;
    const before = c.evSeq;
    await s.pacer.submit('look', () => c.look(r.o.id));
    const ev = await c.waitFor({ since: before, kinds: ['look'], timeoutMs: 3000 });
    r.desc = ev.events.find(e => e.id === r.o.id)?.description || '';
    const sign = UW.readPortalSign(r.desc, r.name);
    r.city = sign.city;
    r.shifting = sign.shifting;
    // A description that reads as the rip's, on an object not named "rip in space".
    // Believe the description: the name can be a resource we failed to resolve.
    if (sign.shifting) r.rip = true;
    if (want && r.city === want && !r.shifting) break;
  }
  return { rows, looked: looks };
}

// Walk onto a teleporter and say whether it fired. Factored out because getting the
// bookkeeping wrong here is what produced the two oldest wrong diagnoses in this file:
// a portal that fires on the LAST STEP of the walk reports arrived:false, and a cursor
// taken after the walk looks past the very event it is waiting for.
async function stepOnto(s, o) {
  const c = s.need();
  const before = c.evSeq;
  const wasIn = c.room.id;
  const walk = await s.walkTo(o.col, o.row, { maxSteps: 80 });
  const arr = await c.waitFor({ since: before, kinds: ['room-entered'],
                                timeoutMs: walk.arrived ? 3000 : 500 });
  const entered = arr.events.find(e => e.kind === 'room-entered');
  const now = { id: c.room.id, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null };
  if (entered || now.id !== wasIn)
    return { left: true, arrived_in: entered?.roomName ?? now.name, room: now.id };
  return { left: false, walked: walk.arrived,
           why: walk.arrived
             ? 'stood on it and nothing happened — it is unlit; one or two of the five ' +
               'are, at random, and its brazier needs activating'
             : `never got onto its square (${walk.reason || walk.note || 'the walk did not arrive'})` };
}

export async function escapeUnderworld(s, { city = null, nearestTo = null,
                                            maxSeconds = 180, allowRip = true } = {}) {
  const c = s.need();
  const portals = () => [...c.room.objects.values()].filter(o => isTeleporter(o.flags));
  // Which room we are in, read from the client rather than from an event: c.room.id and
  // roomNameRsc are both set by the room packet the teleport sends, so this answers "did
  // that work" even when the event that announced it went past while we were walking.
  const whereAmI = () => ({ id: c.room.id, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null });

  // Before anything is measured, and before a single step is taken: a character killed
  // mid-rest wakes up here still sitting, and a resting character's moves are bounced in
  // silence, so every portal in the pentagram would read as unlit. See standUp.
  await standUp(s);

  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  const here = s.world?.room;
  const found = portals();
  if (!found.length)
    return { left: false, stood_up: true, reason: 'no teleporter in this room', room: here?.name };

  // WHICH CITY. An explicit one wins; otherwise, if the caller said where the character
  // died, the answer is almost always "put me back nearest to that" — the corpse and
  // everything it was carrying is lying there, and the walk back is the real cost of
  // dying. See m59-underworld.mjs for how the distance is worked out.
  let wanted = city ?? null, chosenBecause = city ? 'asked for' : null;
  let near = null;
  if (!wanted && nearestTo != null) {
    near = UW.nearestCity(nearestTo);
    if (near.city) { wanted = near.city; chosenBecause = `nearest to where it died (${near.hops} rooms)`; }
  }

  // The shifting one describes a destination; the fixed ones do not.
  const rip = found.find(o => UW.RIP_NAME.test(c.rsc.get(o.nameRsc) || ''));

  // ---- a named city: walk to its own portal, which goes there every time ----
  const cityAttempts = [];
  if (wanted && found.length > (rip ? 1 : 0)) {
    const { rows } = await identifyPortals(s, found, { want: wanted });
    const match = rows.find(r => !r.rip && r.city
                                 && r.city.toLowerCase() === String(wanted).toLowerCase());
    if (match) {
      const step = await stepOnto(s, match.o);
      if (step.left)
        return { left: true, stood_up: true, arrived_in: step.arrived_in, room: step.room,
                 wanted, city: wanted, chosen_because: chosenBecause,
                 via: `the fixed ${wanted} portal`,
                 ...(near ? { died_in_room: nearestTo, hops_from_death: near.hops } : {}),
                 note: 'a fixed portal, so this is repeatable — no waiting and no luck involved' };
      cityAttempts.push({ portal: `fixed ${wanted}`, why: step.why });
    } else {
      cityAttempts.push({
        portal: `fixed ${wanted}`,
        why: rows.some(r => r.desc)
          ? `no portal here reads as ${wanted} — saw ` +
            JSON.stringify(rows.filter(r => !r.rip).map(r => r.city ?? 'unreadable'))
          : 'could not read any portal description',
      });
    }
  }

  // Ko'catan is not in the pentagram at all, so there was never a fixed portal to try.
  if (wanted && String(wanted).toLowerCase().startsWith("ko") && !UW.portalFor(wanted))
    cityAttempts.push({ portal: "fixed Ko'catan", why: UW.KOCATAN_IS_DEATH_ONLY });

  if (wanted && rip && allowRip) {
    // Stand next to it FIRST. The window is 5-10 seconds and walking is a second a
    // square, so polling from across the room means reading a destination you can no
    // longer reach in time.
    const spot = s.world.approachSquare(rip.col, rip.row);
    if (spot && spot.steps > 0) {
      const walk = await s.walkTo(spot.col, spot.row, { maxSteps: Math.max(30, spot.steps + 10) });
      if (!walk.arrived)
        return { left: false, stood_up: true, reason: 'could not get next to the shifting portal', walk,
                 note: 'we stood up first, so this is not resting — something is in the way' };
    }
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < maxSeconds * 1000) {
      const b = c.evSeq;
      await s.pacer.submit('look', () => c.look(rip.id));
      const ev = await c.waitFor({ since: b, kinds: ['look'], timeoutMs: 3000 });
      const desc = ev.events.find(e => e.id === rip.id)?.description || '';
      const dest = UW.readRipDestination(desc);
      if (dest) seen.push(dest);
      if (dest && dest.toLowerCase().includes(String(wanted).toLowerCase())) {
        const before = c.evSeq;
        const wasIn = c.room.id;
        await s.pacer.submit('move', () => c.moveToSquare(rip.col, rip.row), 1050);
        const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 5000 });
        const entered = arr.events.find(e => e.kind === 'room-entered');
        const now = whereAmI();
        return (entered || now.id !== wasIn)
          ? { left: true, stood_up: true, arrived_in: entered?.roomName ?? now.name,
              wanted, city: wanted, chosen_because: chosenBecause, via: 'the rip in space',
              ...(near ? { died_in_room: nearestTo, hops_from_death: near.hops } : {}),
              ...(cityAttempts.length ? { fixed_portal_first: cityAttempts } : {}), saw: seen }
          : { left: false, stood_up: true,
              reason: 'stepped on it as it read right, but nothing happened — it may have swapped first',
              saw: seen, note: 'try again; the window is 5-10 seconds and unknown which' };
      }
      await sleep(1200);
    }
    // Out of patience on the rip. Do NOT stop here — the caller wanted OUT, and a city
    // it did not ask for is enormously better than another spell in the Underworld.
    // Fall through to the nearest working portal, and say plainly that the city was not
    // the one wanted so the walk back is not a surprise.
    cityAttempts.push({ portal: 'rip in space', why: `never showed ${wanted} in ${maxSeconds}s; saw ` +
                                                     JSON.stringify(seen) });
  }

  // No preference, or the preference could not be had: take whichever teleporter is
  // closest and actually works. One or two of the pentagram are unlit at random and an
  // unlit one is silent, so try in order rather than trusting any single portal.
  const reachable = found
    .map(o => ({ o, r: s.world.reach(o.col, o.row) }))
    .filter(x => x.r.reachable)
    .sort((a, b) => a.r.steps - b.r.steps);
  const tried = [];
  for (const { o } of reachable) {
    const name = c.rsc.get(o.nameRsc);
    // Both markers go up BEFORE the walk. Stepping onto a live portal is itself the
    // last step of the walk, so the room packet can arrive while walkTo is still in
    // its loop — and a cursor taken afterwards looks past the very event it is for.
    const before = c.evSeq;
    const wasIn = c.room.id;
    const walk = await s.walkTo(o.col, o.row, { maxSteps: 80 });
    const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: walk.arrived ? 3000 : 500 });
    const entered = arr.events.find(e => e.kind === 'room-entered');
    const now = whereAmI();
    // A walk that "failed" because it left the room is the walk that worked.
    if (entered || now.id !== wasIn) {
      const arrivedIn = entered?.roomName ?? now.name;
      // Which city we ACTUALLY came out in, so a caller that asked for one and got
      // another finds out here rather than after walking the wrong way for ten minutes.
      const landed = Object.entries(UW.CITY_INNS)
        .find(([, v]) => v.inn === now.id || (arrivedIn && v.innName === arrivedIn))?.[0] ?? null;
      return { left: true, stood_up: true, arrived_in: arrivedIn, room: now.id, via: name,
               ...(landed ? { city: landed } : {}), tried,
               ...(wanted ? {
                 wanted, chosen_because: chosenBecause,
                 got_what_was_wanted: landed === wanted,
                 ...(cityAttempts.length ? { could_not_use: cityAttempts } : {}),
                 ...(landed && landed !== wanted ? {
                   note: `OUT, but in ${landed} rather than ${wanted}. The corpse and everything ` +
                         `it was carrying is still where it died; check the walk before setting off.`,
                 } : {}),
               } : {}) };
    }
    // Only blame the brazier if we actually got onto the square. Not arriving is a
    // different fault with a different fix, and reporting it as an unlit portal sends
    // the caller hunting for something to activate that was never the problem.
    tried.push({ name, why: walk.arrived
      ? 'stood on it and nothing happened — probably unlit; its brazier needs activating'
      : `never got onto its square (${walk.reason || walk.note || 'the walk did not arrive'})` });
  }
  return { left: false, stood_up: true, reason: 'none of the teleporters here worked', tried,
           ...(wanted ? { wanted, could_not_use: cityAttempts } : {}),
           note: tried.some(t => /never got onto/.test(t.why))
             ? 'at least one was never reached, so this is not evidence that the portals are dead — ' +
               'we stood up before walking, so it is not resting either; check the route'
             : 'one or two of the five pentagram portals are unlit at random and an unlit one is ' +
               'silent (uworld.kod:460). If EVERY one is dead, look for the braziers — objects ' +
               'with "activate" — or wait for the room to reset, which it does when empty.' };
}

// ---------------------------------------------------------------- commerce

// Sell everything a merchant will take, keeping what you are using.
export async function sellAll(s, { merchant, keep = [], minPrice = 1 } = {}) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const keepRe = new RegExp([...keep, 'shilling', 'coin'].join('|'), 'i');
  // ANYTHING WE ARE WEARING IS NOT FOR SALE. This set used to be constructed empty and
  // never filled, so the guard below was decorative: the armour on your back and the
  // ring on your finger were as sellable as a rat pelt, protected only by whether their
  // names happened to match `keep`. It is the server's use list now, so it is right by
  // construction rather than by a name pattern somebody has to maintain.
  const wielded = equippedNow(c) ?? new Set();
  let items = c.inventory
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) }))
    .filter(x => !keepRe.test(x.name) && !wielded.has(x.o.id) && weaponScore(x.name) === 0);

  // DO NOT SELL WHAT A CRewMATE IS SHORT OF. The merchant buys low and sells high, so
  // this round trip costs the fleet twice over, and the thing being round-tripped is
  // usually the reagent that decides whether somebody can eat.
  const held = [];
  items = items.filter(x => {
    if (!interest.anyoneWants(x.name, { except: s.name })) return true;
    held.push({ name: x.name, wanted_by: interest.wantedBy(x.name, { except: s.name }) });
    return false;
  });

  if (!items.length) return { sold: [], kept_for_the_fleet: held,
    note: held.length
      ? 'nothing left to sell — what is in the pack is either yours to keep or wanted by another character'
      : 'nothing to sell that is not money, equipment you are wearing, or a weapon you are carrying' };

  const sold = [], refused = [];
  let total = 0;
  for (const it of items) {
    const q = await s.sellOne(merchant, it.o, false);
    if (!q.offered_price || q.offered_price < minPrice) {
      refused.push({ name: it.name, why: q.merchant_said?.join(' ') || q.note || 'no price offered' });
      await sleep(900);
      continue;
    }
    const done = await s.sellOne(merchant, it.o, true);
    if (done.sold) { sold.push({ name: it.name, price: q.offered_price }); total += q.offered_price; }
    else refused.push({ name: it.name, why: done.note || 'accept failed' });
    await sleep(900);
  }
  return { sold, refused, total_received: total, kept_for_the_fleet: held,
           note: refused.length ? 'refusals are usually "this merchant does not deal in that" — check merchants for who does' : undefined };
}
