#!/usr/bin/env node
// LOOT RUNS: PAIRING A CHARACTER WHO HAS TOO MUCH WITH ONE WHO HAS NOTHING.
//
// A farmer that is going well produces more than it can carry. Kills drop food, herbs,
// reagents and coin faster than a fourteen-slot pack fills, so the surplus stays on the
// floor and rots there — and the farmer cannot go and sell it without giving up the
// wall it took twenty minutes to prove.
//
// Meanwhile the bottom of the fleet is stuck for exactly the opposite reason: no food,
// so vigor is pinned at the resting cap of 80 for ever; no money, so no food; and no
// safe way to earn money, because earning it means fighting, and fighting at 80 vigor
// is thirty seconds of swinging followed by an hour of recovery.
//
// Those two problems are each other's solution and the game already has the mechanism:
// walk over, pick it up. The trade players actually make is LOOT FOR THE POOR, FOOD FOR
// THE FARMER — the runner keeps what it can sell, and hands over any food it is
// carrying, because a farmer with food out-earns the value of the food many times over.
// Where there is no food to give, the debt is settled in town later.
//
// THE PART THAT IS EASY TO GET WRONG: do not carry money into the wilderness to settle
// up. Death drops inventory, and the whole point of the exercise is that one of these
// characters is fragile. Cash changes hands in a bank or an inn, afterwards, or not at
// all.
import { loadSpawns } from './m59-spawns.mjs';

// What makes a farmer worth visiting. Not kills alone — a character killing things it
// outlevels produces nothing anyone wants — but kills PLUS a full pack, which is the
// only observable proxy for "there is more on the floor than it can pick up".
export function farmersWorthVisiting(fleet, { minKills = 3, fullAt = 0.75 } = {}) {
  return (fleet || [])
    .filter(r => r.in_game !== false)
    .map(r => {
      const cap = r.max_carry ?? 14;
      const full = (r.carrying ?? 0) / cap;
      const vigor = Number(String(r.vigor_of ?? '0/200').split('/')[0]) || 0;
      return { ...r, full, vigor,
        // A farmer still worth supplying is one that can keep going. One that is out
        // of vigor is not a farmer, it is the next thing needing rescue.
        productive: (r.autopilot?.kills ?? r.kills ?? 0) >= minKills && vigor >= 60,
        overflowing: full >= fullAt };
    })
    .filter(r => r.productive && r.overflowing)
    .sort((a, b) => b.full - a.full);
}

// Who should go and fetch it. The best runner is the one that gains most and risks
// least: no food (so the payment is worth something), space to carry, and — the part
// worth being strict about — enough health to survive the walk, because the walk is
// through the same rooms that made the farmer rich.
export function runnersAvailable(fleet, { minSpace = 4 } = {}) {
  return (fleet || [])
    .filter(r => r.in_game !== false)
    .map(r => {
      const cap = r.max_carry ?? 14;
      const space = cap - (r.carrying ?? 0);
      const hp = parseRatio(r.health);
      const vigor = Number(String(r.vigor_of ?? '0/200').split('/')[0]) || 0;
      return { ...r, space, hp, vigor,
        // "Poor" is what qualifies you, not what disqualifies you: the run exists to
        // fix it. No food is the sharpest signal, because it is the one that cannot
        // fix itself.
        needy: !r.has_food || !r.has_weapon,
        fitToTravel: hp >= 0.7 && vigor >= 40 };
    })
    .filter(r => r.space >= minSpace && r.fitToTravel)
    // Neediest first, then most space. A character with no food AND no weapon is the
    // one this whole arrangement is for.
    .sort((a, b) => (b.needy - a.needy) || (b.space - a.space));
}

const parseRatio = s => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s ?? ''));
  return m && +m[2] ? +m[1] / +m[2] : 0;
};

// Pair them up. One runner per farmer — two runners in the same room is the stacking
// problem again, in a room that already has a swarm in it.
export function planRuns(fleet, opts = {}) {
  const farmers = farmersWorthVisiting(fleet, opts);
  const runners = runnersAvailable(fleet, opts);
  const used = new Set();
  const runs = [];
  for (const f of farmers) {
    const r = runners.find(x => !used.has(x.agent) && x.agent !== f.agent);
    if (!r) break;
    used.add(r.agent);
    runs.push({
      farmer: f.agent, farmer_name: f.character,
      runner: r.agent, runner_name: r.character,
      room: f.room_num, room_name: f.room,
      farmer_pack: `${f.carrying}/${f.max_carry ?? 14}`,
      runner_space: r.space,
      // What the runner owes, and in which currency. Food now is worth more to a
      // farmer than money later, and costs the runner nothing it can use.
      pay_with: r.has_food ? 'food, handed over on arrival'
                           : 'half the sale proceeds, settled in town afterwards',
      why: `${f.character} is carrying ${f.carrying} of ${f.max_carry ?? 14} and still killing; ` +
           `${r.character} has ${r.space} slots free and ` +
           (r.has_food ? 'can pay in food' : 'no food to pay with, so this is on credit'),
    });
  }
  return { runs,
    farmers_overflowing: farmers.map(f => f.character),
    runners_free: runners.map(r => r.character),
    note: runs.length ? undefined
      : farmers.length ? 'nobody free and healthy enough to make the trip'
      : 'no farmer is full enough to be worth visiting yet',
  };
}

// Is the destination somewhere a poorly-equipped character should walk into? The
// runner is chosen for being badly off, which is exactly the character a spawn table
// can kill on the way in.
export function tooDangerousForRunner(spawnFile, roomNum, runnerLevel, over = 4) {
  const spawns = loadSpawns(spawnFile);
  const here = spawns?.rooms?.[roomNum] || [];
  const worst = here.reduce((m, x) => Math.max(m, x.level ?? 0), 0);
  return worst > runnerLevel + over
    ? { tooDangerous: true, worst, ceiling: runnerLevel + over }
    : { tooDangerous: false, worst };
}

// ---------------------------------------------------------------- quartermasters
//
// THE OTHER HALF OF THE SAME IDEA: A CHARACTER CAN BE A SERVICE.
//
// The two things that silently stop a character working are having no weapon and
// having no food, and both have a level-1 Kraanan answer that anybody can cast — no
// karma gate, so a fresh neutral character can do it on day one.
//
//   create weapon  needs NO reagents at all. One caster can arm the entire fleet, for
//                  nothing, as often as asked.
//   create food    needs 2 elderberries and 2 herbs, which is precisely what a farmer
//                  spends all day picking up. The supplicant brings the reagents; the
//                  caster brings the spell.
//
// THE CATCH, AND IT MATTERS: a created weapon does not last. Somewhere between a
// couple of minutes and a couple of hours and it is gone. So this is a stopgap, not a
// repair — a character kitted out this way must be treated as still needing a real
// weapon, and anything that caches "is armed" has to expect it to stop being true.
// Free is still an excellent price for getting somebody out of a punching-monsters
// state and back to a shop.
export const SERVICE_SPELLS = {
  'create weapon': { fixes: 'has_weapon', reagents: [], temporary: true,
    note: 'lasts minutes to hours, then vanishes — a stopgap that buys the walk to a shop' },
  'create food':   { fixes: 'has_food', reagents: ['ElderBerry x2', 'Herbs x2'], temporary: false,
    note: 'the supplicant supplies the reagents; farmers loot both constantly' },
};

// Who needs a service, who can give it, and who should walk to whom.
//
// The caster travels, not the supplicant — a character with no weapon is the one that
// should be doing the least walking through monster rooms, and the caster by
// definition has a spell that makes it useful the moment it arrives.
// THE NEWBIE ZONE IS A SEPARATE WORLD AND THE DOOR ONLY OPENS OUTWARDS.
//
// Raza is not connected to the rest of the map in the travel graph — the only way out
// is the Grand Museum portal, and it is one-way. So a quartermaster standing in Raza
// cannot reach a supplicant in Tos, and nobody outside can walk in. Pairing across
// that line produces errands that always fail: eleven were dispatched at once and all
// eleven came back "no route from 1016 to 586", having done nothing but burn a pass
// each. Cheaper to not propose them, and to say why.
const IN_RAZA = /Raza|Mausoleum|Museum/i;
const zoneOf = r => IN_RAZA.test(r.room || '') ? 'raza' : 'world';

// create weapon needs nothing; create food needs two elderberries and two herbs out of
// the caster's own pack. A caster missing them is not a caster for that service.
const canCast = (caster, service) => {
  if (service !== 'create food') return true;
  const r = caster.reagents;
  if (!r) return true;                 // no reading available — do not refuse on absence
  return (r.elderberry ?? 0) >= 2 && (r.herbs ?? 0) >= 2;
};

export function planProvisioning(fleet, { minMana = 15 } = {}) {
  const rows = (fleet || []).filter(r => r.in_game !== false);
  const casters = rows.filter(r => (r.provides || []).length && (r.mana_now ?? 0) >= minMana);
  const needs = [];
  for (const r of rows) {
    const wants = [];
    if (!r.has_weapon) wants.push('create weapon');
    if (!r.has_food) wants.push('create food');
    if (wants.length) needs.push({ ...r, wants });
  }

  // Spread the work. Picking the first able caster every time is what a `find` does,
  // and with nine quartermasters and twenty-three errands it handed all twenty-three
  // to Kraan — one character walking the length of the world while eight stood in an
  // inn. Prefer a caster already standing in the room, since that errand costs no
  // travel at all; otherwise take whoever has been given the least so far.
  const load = new Map();
  const jobs = [];
  const unreachable = [];
  const unshopped = [];
  for (const n of needs) {
    for (const want of n.wants) {
      const all = casters.filter(x => (x.provides || []).includes(want) && x.agent !== n.agent);
      const sameZone = all.filter(x => zoneOf(x) === zoneOf(n));
      if (!sameZone.length) {
        if (all.length) unreachable.push(
          `${n.character} needs ${want} but every caster who has it is ` +
          `${zoneOf(n) === 'raza' ? 'outside Raza' : 'inside Raza'}, and the museum portal is one-way`);
        continue;
      }
      // KNOWING THE SPELL IS NOT BEING ABLE TO CAST IT. create food consumes two
      // elderberries and two herbs from the CASTER, and casting without them fails
      // without a word — the errand completes having produced nothing.
      const able = sameZone.filter(x => canCast(x, want));
      if (!able.length) {
        unshopped.push(
          `${n.character} needs ${want} but no caster in reach is carrying ` +
          `${SERVICE_SPELLS[want].reagents.join(' and ')}`);
        continue;
      }
      const caster = able.find(x => x.room_num != null && x.room_num === n.room_num)
        ?? able.reduce((a, b) => ((load.get(b.agent) ?? 0) < (load.get(a.agent) ?? 0) ? b : a));
      load.set(caster.agent, (load.get(caster.agent) ?? 0) + 1);
      const spec = SERVICE_SPELLS[want];
      jobs.push({
        service: want,
        caster: caster.agent, caster_name: caster.character,
        supplicant: n.agent, supplicant_name: n.character,
        room: n.room_num, room_name: n.room,
        reagents_needed: spec.reagents,
        supplicant_can_pay: spec.reagents.length === 0 ? true : null,
        temporary: spec.temporary,
        why: `${n.character} has no ${want === 'create weapon' ? 'weapon' : 'food'}; ` +
             `${caster.character} can cast ${want}` +
             (spec.reagents.length ? ` if ${n.character} supplies ${spec.reagents.join(' and ')}` : ' for nothing'),
        caveat: spec.temporary ? spec.note : undefined,
      });
    }
  }
  return {
    jobs,
    casters: casters.map(c => `${c.character} (${(c.provides || []).join(', ')}) [${zoneOf(c)}]`),
    unreachable: unreachable.length ? unreachable : undefined,
    missing_reagents: unshopped.length ? unshopped : undefined,
    unmet: needs.filter(n => !jobs.some(j => j.supplicant === n.agent)).map(n => n.character),
    note: casters.length ? undefined
      : 'nobody in the fleet knows create food or create weapon — reroll someone with the ' +
        'selfSufficient loadout and the whole fleet gains a quartermaster',
  };
}
