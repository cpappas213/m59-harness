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
const weaponScore = name => {
  for (const [re, n] of WEAPON_WORDS) if (re.test(name)) return n;
  return 0;
};

export async function equipBest(s) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  const scored = c.inventory
    .map(o => ({ o, name: c.rsc.get(o.nameRsc), score: weaponScore(c.rsc.get(o.nameRsc)) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length)
    return { wielding: null, note: 'nothing weapon-like in inventory — you will fight with your fists, which works but badly' };
  const best = scored[0];
  const before = c.evSeq;
  await s.pacer.submit('use', () => c.use(best.o.id));
  const ev = await c.waitFor({ since: before, timeoutMs: 3000 });
  return {
    wielding: best.name, id: best.o.id,
    considered: scored.map(x => x.name),
    messages: ev.events.filter(e => e.text).map(e => e.text),
  };
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
export async function restUntil(s, { health = DEFAULT_REST_UNTIL, vigor = DEFAULT_REST_UNTIL, maxSeconds = 120 } = {}) {
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
  let stalled = 0, last = -1;
  while (Date.now() - t0 < maxSeconds * 1000) {
    await sleep(3000);
    v = await read();
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
    note: done() ? undefined
      : (stalled >= 3 ? 'nothing recovered for several checks — something may be preventing rest, or you are already at your ceiling'
                      : 'timed out before reaching the target'),
  };
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

  if (equip) {
    const e = await equipBest(s);
    say('equipped', { wielding: e.wielding, note: e.note });
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

  let killed = false, disengaged = null, roundsFought = 0, drifted = null;
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
// Five portals stand in a pentagram with FIXED destinations, each dead until its
// brazier is lit — Portal.SomethingMoved returns immediately if the portal is not
// animating, so an unlit one silently does nothing. A sixth, the "rip in space",
// re-rolls its destination every 5-10 seconds and only says where it currently leads
// if you look at it, in prose that names an inn rather than a city.
//
// So: if the caller wants a particular city, stand next to the shifting portal and
// poll it, stepping on when it reads right. Otherwise take the nearest working one.
export const RIP_DESTINATIONS = [
  { match: /bustling bar of Familiars/i, city: 'Tos' },
  { match: /Limping Toad/i, city: 'Marion' },
  { match: /Yonder Inn of Jasper/i, city: 'Jasper' },
  { match: /Cibilo Creek Inn/i, city: 'Cornoth' },
  { match: /Brownstone Inn/i, city: 'Barloque' },
  { match: /island fortress of Ko'catan/i, city: "Ko'catan" },
];
export const readRipDestination = text => RIP_DESTINATIONS.find(d => d.match.test(text || ''))?.city ?? null;

export async function escapeUnderworld(s, { city = null, maxSeconds = 180 } = {}) {
  const c = s.need();
  const portals = () => [...c.room.objects.values()].filter(o => isTeleporter(o.flags));

  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  const here = s.world?.room;
  const found = portals();
  if (!found.length)
    return { left: false, reason: 'no teleporter in this room', room: here?.name };

  // The shifting one describes a destination; the fixed ones do not.
  const rip = found.find(o => /rip in space/i.test(c.rsc.get(o.nameRsc)));

  if (city && rip) {
    // Stand next to it FIRST. The window is 5-10 seconds and walking is a second a
    // square, so polling from across the room means reading a destination you can no
    // longer reach in time.
    const spot = s.world.approachSquare(rip.col, rip.row);
    if (spot && spot.steps > 0) {
      const walk = await s.walkTo(spot.col, spot.row, { maxSteps: Math.max(30, spot.steps + 10) });
      if (!walk.arrived) return { left: false, reason: 'could not get next to the shifting portal', walk };
    }
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < maxSeconds * 1000) {
      const b = c.evSeq;
      await s.pacer.submit('look', () => c.look(rip.id));
      const ev = await c.waitFor({ since: b, kinds: ['look'], timeoutMs: 3000 });
      const desc = ev.events.find(e => e.id === rip.id)?.description || '';
      const dest = readRipDestination(desc);
      if (dest) seen.push(dest);
      if (dest && dest.toLowerCase().includes(String(city).toLowerCase())) {
        const before = c.evSeq;
        await s.pacer.submit('move', () => c.moveToSquare(rip.col, rip.row), 1050);
        const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 5000 });
        const entered = arr.events.find(e => e.kind === 'room-entered');
        return entered
          ? { left: true, arrived_in: entered.roomName, wanted: city, saw: seen }
          : { left: false, reason: 'stepped on it as it read right, but nothing happened — it may have swapped first',
              saw: seen, note: 'try again; the window is 5-10 seconds and unknown which' };
      }
      await sleep(1200);
    }
    return { left: false, reason: `never saw ${city} in ${maxSeconds}s`, saw: seen,
             note: 'the rip picks from five inns and never repeats twice running, so it is luck plus patience' };
  }

  // No preference: take whichever teleporter is closest and actually works. The fixed
  // ones may be switched off, and an off portal is silent, so try in order.
  const reachable = found
    .map(o => ({ o, r: s.world.reach(o.col, o.row) }))
    .filter(x => x.r.reachable)
    .sort((a, b) => a.r.steps - b.r.steps);
  const tried = [];
  for (const { o } of reachable) {
    const name = c.rsc.get(o.nameRsc);
    const walk = await s.walkTo(o.col, o.row, { maxSteps: 80 });
    const before = c.evSeq;
    if (!walk.arrived) { tried.push({ name, why: walk.reason || 'could not reach it' }); continue; }
    const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 3000 });
    const entered = arr.events.find(e => e.kind === 'room-entered');
    if (entered) return { left: true, arrived_in: entered.roomName, via: name, tried };
    tried.push({ name, why: 'stood on it and nothing happened — probably unlit; its brazier needs activating' });
  }
  return { left: false, reason: 'none of the teleporters here worked', tried,
           note: 'the pentagram portals are dead until their brazier is lit — look for objects with "activate" and try those' };
}

// ---------------------------------------------------------------- commerce

// Sell everything a merchant will take, keeping what you are using.
export async function sellAll(s, { merchant, keep = [], minPrice = 1 } = {}) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const keepRe = new RegExp([...keep, 'shilling', 'coin'].join('|'), 'i');
  const wielded = new Set();      // anything we are using is worth keeping by default
  const items = c.inventory
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) }))
    .filter(x => !keepRe.test(x.name) && !wielded.has(x.o.id) && weaponScore(x.name) === 0);

  if (!items.length) return { sold: [], note: 'nothing to sell that is not money or a weapon you are carrying' };

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
  return { sold, refused, total_received: total,
           note: refused.length ? 'refusals are usually "this merchant does not deal in that" — check merchants for who does' : undefined };
}
