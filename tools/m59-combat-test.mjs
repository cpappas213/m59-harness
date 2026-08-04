#!/usr/bin/env node
// THE THREE WAYS A KEEPER FIGHTS NOTHING WHILE LOOKING BUSY. Offline, no server:
//
//   node tools/m59-combat-test.mjs
//
// All three were found on the live fleet on the same afternoon, and all three share a
// shape: the keeper did exactly what it said it was doing, reported success, and
// achieved nothing. None of them could be seen from outside.
//
//   1. THE CLIFF. Half the fleet stood above West Merchant Way pulling monsters that
//      could not climb to them, with melee weapons that could not reach down. pull()
//      succeeded every time, so progress() fired every pass and the stall detector
//      never saw it.
//   2. THE PACK. Broken weapons are not renamed (weapon.kod:788 changes only the icon)
//      and one junk item is literally called "broken mace", so the keep-list that
//      protects equipment from being dropped was protecting shattered swords.
//   3. THE EMPTY HAND. equipBest sent `use` and never read the reply. A weapon that
//      shattered mid-fight was reported as wielded for as long as it was carried, while
//      every swing after it broke was a punch.

import {
  isJunk, JUNK_NAMES, proficiencyFor, weaponRanking, equipBest, junkAndBroken,
  brokenSet, brokenWeaponText, abilityOf,
} from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { nearestSafeSpot } from './m59-safespots.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// A client whose inventory is a list of [id, name], and whose `use` replies with
// whatever the script says the server would say.
function fakeClient(items, replies = {}) {
  const names = new Map(items.map(([id, name]) => [id, name]));
  return {
    inventory: items.map(([id]) => ({ id, nameRsc: id })),
    rsc: { get: (r) => names.get(r) ?? '' },
    statsById: new Map(),
    evSeq: 0,
    used: [],
    requestInventory() {},
    use(id) { this.used.push(id); this._last = id; },
    waitFor() {
      const text = replies[this._last];
      return { events: text ? [{ text }] : [] };
    },
  };
}
const fakeSession = (c) => ({ need: () => c, client: c,
                              pacer: { submit: async (_k, f) => f() } });

console.log('\njunk that looks like gear');
{
  ok('the thirteen junk names are known', JUNK_NAMES.length === 13);
  ok('"broken mace" is junk', isJunk('broken mace'));
  ok('and case/space insensitive', isJunk('  Broken Mace '));
  ok('a real mace is not', !isJunk('mace'));
  const c = fakeClient([[1, 'broken mace'], [2, 'dagger']]);
  const r = weaponRanking(c);
  ok('junk is excluded from the ranking entirely',
     r.length === 1 && r[0].name === 'dagger', JSON.stringify(r.map(x => x.name)));
  // This is the specific inversion that was live: /mace/ scored 5, /dagger/ scored 2.
  ok('so the junk mace can no longer outrank a real dagger', r[0].name === 'dagger');
}

console.log('\nwhich proficiency a weapon trains (viProficiency_Needed)');
{
  ok('short sword has its own', proficiencyFor('short sword') === 'shortsword proficiency');
  ok('a long sword is sword proficiency', proficiencyFor('long sword') === 'sword proficiency');
  ok('and so is a nerudite sword', proficiencyFor('nerudite sword') === 'sword proficiency');
  ok('scimitar is its own', proficiencyFor('scimitar') === 'scimitar proficiency');
  ok('axe', proficiencyFor('battle axe') === 'axe proficiency');
  ok('mace', proficiencyFor('mace') === 'mace proficiency');
  ok('hammer', proficiencyFor('war hammer') === 'hammer proficiency');
  ok('bows are archery', proficiencyFor('crossbow') === 'archery');
  ok('something unrecognised gets null, not a guess', proficiencyFor('turnip') === null);
  // Order matters: "short sword" must not fall through to the /sword/ rule.
  ok('the short sword rule wins over the generic sword rule',
     proficiencyFor('short sword') !== 'sword proficiency');
}

console.log('\nranking by proficiency, and overriding it');
{
  const c = fakeClient([[1, 'long sword'], [2, 'battle axe']]);
  c.statsById.set('sword proficiency', { value: 90 });
  c.statsById.set('axe proficiency', { value: 11 });
  ok('abilityOf reads a named skill', abilityOf(c, 'sword proficiency') === 90);
  ok('and returns null when never read, not 0', abilityOf(c, 'mace proficiency') === null);
  ok('the weapon it is good with leads', weaponRanking(c)[0].name === 'long sword');
  // The whole point of the override: proficiency ranking only ever rewards what you are
  // already best at, so a training goal needs a way to say otherwise.
  const trained = weaponRanking(c, { priority: ['axe'] });
  ok('a priority list overrides proficiency', trained[0].name === 'battle axe',
     JSON.stringify(trained.map(x => x.name)));
  ok('and the rest still follow', trained[1].name === 'long sword');
  const c2 = fakeClient([[1, 'greatsword'], [2, 'dagger']]);
  ok('with no abilities read it falls back to weapon class, not to zero',
     weaponRanking(c2)[0].name === 'greatsword');
}

console.log('\nthe server refusing a broken weapon');
{
  for (const t of ['Your long sword is broken; you can\'t use it!',
                   'Your mace shatters into pieces.',
                   'It has been shattered by a powerful blow.'])
    ok(`recognised: "${t.slice(0, 34)}..."`, brokenWeaponText(t));
  ok('ordinary combat text is not mistaken for it',
     !brokenWeaponText('You hit the giant rat for 4 damage.'));
}

console.log('\nequipBest tries the next one instead of lying');
{
  const c = fakeClient([[1, 'long sword'], [2, 'dagger']],
                       { 1: "Your long sword is broken; you can't use it!" });
  const r = await equipBest(fakeSession(c));
  ok('it does not report the refused weapon as wielded', r.wielding === 'dagger',
     JSON.stringify(r));
  ok('and says the choice was verified', r.verified === true);
  ok('the refusal is reported rather than swallowed',
     r.rejected?.[0]?.name === 'long sword', JSON.stringify(r.rejected));
  ok('the broken one is remembered', brokenSet(c).has(1));
  const again = await weaponRanking(c);
  ok('so it is not offered again', !again.some(x => x.name === 'long sword'),
     JSON.stringify(again.map(x => x.name)));
}

console.log('\nwhen everything in the pack is broken');
{
  const c = fakeClient([[1, 'long sword'], [2, 'dagger']],
                       { 1: 'is broken; you can\'t use it!', 2: 'is broken; you can\'t use it!' });
  const r = await equipBest(fakeSession(c));
  ok('it admits to being empty-handed', r.wielding === null && r.verified === false);
  ok('rather than reporting the last thing it tried', !r.wielding);
  ok('and names how many it refused', r.rejected.length === 2, JSON.stringify(r.rejected));
  ok('both are now known broken', brokenSet(c).size === 2);
}

console.log('\nwhat should be dropped');
{
  const c = fakeClient([[1, 'broken mace'], [2, 'long sword'], [3, 'shilling']]);
  brokenSet(c).add(2);
  const dead = junkAndBroken(c);
  ok('junk and known-broken are both listed', dead.length === 2, JSON.stringify(dead));
  ok('the junk is labelled junk', dead.find(d => d.id === 1).why === 'junk');
  ok('the broken sword is labelled broken', /broken/.test(dead.find(d => d.id === 2).why));
  ok('and nothing else is swept up', !dead.some(d => d.id === 3));
  // The live bug: `keep` protects /sword|mace/, so both of these were exempt from the
  // pack-clearer for exactly the reason they most needed dropping.
  const keep = /shilling|coin|armor|shield|sword|mace|hammer|axe|bow|helm/i;
  ok('both would have been protected by the old keep list',
     dead.every(d => keep.test(d.name)), JSON.stringify(dead.map(d => d.name)));
}

console.log('\nthe cliff detector');
{
  // The real method, on a real Autopilot, with a session stubbed to what it touches.
  const keeper = (limit) => {
    const k = new Autopilot({ name: 'test', world: { room: { num: 42 } }, client: null },
                            limit == null ? {} : { policy: { pullsBeforeBarren: limit } });
    k.hold = { col: 10, row: 20 };
    k.releaseHold = (why) => { k._released = why; };
    return k;
  };

  const k = keeper();
  ok('the default is three attempts', k.policy.pullsBeforeBarren === 3);
  ok('the first pull that does not convert is not fatal', k.pullDidNotConvert('nothing came') === false);
  ok('nor the second', k.pullDidNotConvert('nothing came') === false);
  ok('and the spot is still held while it is in doubt', !k._released);
  ok('the third writes it off', k.pullDidNotConvert('nothing came') === true);
  ok('the square is now barren in this room',
     k.barrenSpots.get(42)?.has('10,20') === true,
     JSON.stringify([...(k.barrenSpots.get(42) ?? [])]));
  ok('the spot is given up', /nothing can reach/.test(k._released ?? ''), k._released);
  ok('and it counts as no progress, so the stall detector can see it',
     /nothing can reach/.test(k.stalledWhy ?? '') || k.idlePasses > 0);
  ok('it says why in the journal, naming the cliff',
     k.journal.some(e => /cannot climb/.test(JSON.stringify(e))),
     JSON.stringify(k.journal.at(-1)));

  const k2 = keeper();
  k2.pullDidNotConvert('a'); k2.pullDidNotConvert('b');
  k2.pullConverted();
  ok('contact resets the count', k2.pullsWithoutContact === 0);
  ok('so a slow-but-working spot is never written off',
     k2.pullDidNotConvert('c') === false && k2.pullDidNotConvert('d') === false);

  const k3 = keeper(1);
  ok('the limit is configurable', k3.pullDidNotConvert('x') === true);
}

console.log('\nthe cliff, from the geometry instead of from experience');
{
  // West Merchant Way in miniature. A ledge along the top, reachable from below on the
  // FINE grid only — which is the shape of the real room: the fine grid connects 99.9%
  // of the floor to the clifftop and the coarse grid connects 24%.
  const rows = 6, cols = 6;
  // Floor only in the 4x4 interior, so the edge squares are backed by rock and actually
  // score as defensible. A room with floor everywhere has no safe spots at all, which is
  // a fact about safeSpots() worth knowing before writing a fixture for it.
  const flags = Buffer.alloc(rows * cols, 0x00);
  for (let r = 2; r <= 5; r++) for (let c = 2; c <= 5; c++) flags[(r - 1) * cols + (c - 1)] = 0x01;
  const fine = Buffer.alloc(rows * cols, 0xff);           // fine: everything connects
  const coarse = Buffer.alloc(rows * cols, 0xff);
  // Coarse: nothing may step NORTH out of row 4 — the cliff face. N 0x01, NE 0x02, NW 0x80.
  // Rows 2-3 are the ledge; rows 4-5 are the ground the monsters are on.
  for (let c = 1; c <= cols; c++) coarse[(4 - 1) * cols + (c - 1)] &= ~(0x01 | 0x02 | 0x80);
  const geo = new RoomGeometry({ file: 'test', version: 12, rows, cols,
                                 grid: coarse, flags, monsterGrid: fine,
                                 walls: [], sidedefs: [], clientSize: null });

  const TOP = [2, 2], BOT = [5, 3];                       // [row, col] — ledge corner, ground
  const canReach = (los) => geo.monsterCanReach(BOT[0], BOT[1], TOP[0], TOP[1], los == null ? {} : { los });
  ok('LOS_NEW_BOTH: the monster climbs it', canReach(3).reachable === true);
  ok('LOS_NEW_MONSTER: also climbs', canReach(1).reachable === true);
  ok('LOS_OLD: it cannot', canReach(0).reachable === false);
  ok('LOS_NEW_PLAYER: still cannot — players fine, monsters coarse',
     canReach(2).reachable === false);
  ok('and LOS_OLD is the default, because that is what the server ships',
     canReach().reachable === false);
  ok('the answer names the grid it used', canReach(0).grid === 'coarse');
  // The asymmetry that hid this: we walk DOWN fine, it cannot come UP.
  ok('we can still walk down to it, which is why every earlier check passed',
     geo.path(TOP[0], TOP[1], BOT[0], BOT[1], { fine: false }).found === true);

  // And the chooser must refuse the ledge rather than score it well for being empty.
  const qr = (col, r2) => geo.monsterCanReach(BOT[0], BOT[1], r2, col, { los: 0 });
  const stats = {};
  const picked = nearestSafeSpot(geo, { col: 3, row: 2 },
    { within: 12, minAvoided: 0, quarryReach: qr, stats });
  ok('no square the quarry cannot reach is offered',
     !picked || qr(picked.col, picked.row).reachable === true,
     JSON.stringify(picked && { col: picked.col, row: picked.row }));
  ok('the refused count is reported even when nothing is chosen',
     stats.unreachable_by_quarry > 0, JSON.stringify(stats));
  ok('considered is reported too, so "no spots" and "no reachable spots" differ',
     stats.considered > 0, JSON.stringify(stats));
  // Without a quarry the old behaviour must be untouched: this runs in rooms where
  // nothing is being hunted, and refusing every square there would strand the fleet.
  const noQuarry = nearestSafeSpot(geo, { col: 3, row: 2 }, { within: 12, minAvoided: 0 });
  ok('with no quarry to ask about, nothing is filtered', noQuarry !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
