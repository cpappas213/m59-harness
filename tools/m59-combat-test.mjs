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
import { roomCap, karmaSafe } from './m59-spawns.mjs';
import { OF } from './m59-parse.mjs';
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

console.log('\nthe post-mortem');
{
  // A keeper with a client that has an event buffer, and a few passes of history.
  const events = [
    { seq: 1, kind: 'moved', at: 1000, col: 5, row: 5 },
    { seq: 2, kind: 'message', at: 1100, text: 'The centipede hits you for 7 damage.' },
    { seq: 3, kind: 'said', at: 1200, name: 'Waldorf', type: 'say', text: 'run!' },
    { seq: 4, kind: 'message', at: 1300, text: 'Your long sword shatters into pieces.' },
    { seq: 5, kind: 'room-contents', at: 1400, count: 3 },
    { seq: 6, kind: 'message', at: 1500, text: 'You are hit for 11 damage.' },
  ];
  const k = new Autopilot({ name: 't9', world: { room: { num: 545 } },
                            client: { events, me: { name: 'Scooter' } } }, {});
  k.policy.hunt = 'centipede';
  k.mode = 'farm';
  k.doing = 'fighting';
  k.journal = [{ at: 900, what: 'took a safe spot' }, { at: 1200, what: 'gave up the safe spot' }];
  k.recent5 = [
    { at: 10_000, room: 'West Merchant Way', num: 545, col: 90, row: 20, health: 25, max: 25,
      vigor: 180, doing: 'fighting', holding: { col: 90, row: 20, proven: true },
      moved_ms: 30_000, swung_ms: 500, threats: ['centipede'] },
    { at: 20_000, room: 'West Merchant Way', num: 545, col: 91, row: 21, health: 14, max: 25,
      vigor: 150, doing: 'fighting', holding: false,
      moved_ms: 1_000, swung_ms: 400, threats: ['centipede', 'baby spider'],
      players_present: ['Janice', 'Waldorf'] },
    { at: 30_000, room: 'Underworld', num: 999, col: 1, row: 1, health: 0, max: 25,
      vigor: 100, doing: null, holding: false, moved_ms: 100, swung_ms: 9_000, threats: [] },
  ];

  const pm = k.postMortem('died');
  ok('it names the character, not just the agent', pm.character === 'Scooter');
  ok('the Underworld frame is excluded from where it died',
     pm.where.room === 'West Merchant Way', JSON.stringify(pm.where));

  // The four things that were being kept separately.
  ok('it carries the server text', pm.text.length === 4, JSON.stringify(pm.text.length));
  ok('text is oldest-first, so it reads in order',
     pm.text[0].text === 'The centipede hits you for 7 damage.'
     && pm.text.at(-1).text === 'You are hit for 11 damage.');
  ok('speech is kept with who said it', pm.text.find(t => t.kind === 'said')?.who === 'Waldorf');
  ok('non-text events are left out', !pm.text.some(t => !t.text));
  ok('the weapon breaking is in there, which is often the whole answer',
     pm.text.some(t => /shatters/.test(t.text)));
  ok('it carries the decisions', pm.decisions.length === 2);
  ok('it carries the frames', pm.frames.length === 2, JSON.stringify(pm.frames.length));

  // What it was doing.
  ok('what it was doing', pm.was.doing === 'fighting');
  ok('whether it was in a safe spot at the end', pm.was.in_safe_spot === false);
  ok('and the frame before shows it had been', pm.frames[0].holding.proven === true);
  ok('whether it was moving', pm.was.moving === true, JSON.stringify(pm.was));
  ok('whether it was swinging', pm.was.swinging === true);
  ok('what it was hunting', pm.was.hunting === 'centipede');

  // The rate — 25 to 14 over ten seconds.
  ok('health rate is points per second and negative while dying',
     pm.vitals.health_per_second === -1.1, String(pm.vitals.health_per_second));
  ok('the trail is there too', pm.vitals.trail.join(',') === '25,14');
  ok('a single frame cannot give a rate, and says null rather than 0',
     k.healthRate([{ at: 1, health: 5 }]) === null);
  ok('threats at the end are recorded',
     pm.threats.present_at_the_end.join(',') === 'centipede,baby spider');
  ok('and the worst moment, which is usually not the last one',
     pm.threats.most_at_once === 2);
  // Found live: every character in this fleet is ATTACKABLE and they stand together,
  // so without the player filter a death record names four Muppets as the killers.
  ok('fleetmates are not listed as threats',
     !pm.threats.present_at_the_end.some(t => /Janice|Beaker|Waldorf/.test(t)));
  ok('but who was standing there is still recorded',
     pm.threats.players_present.join(',') === 'Janice,Waldorf',
     JSON.stringify(pm.threats.players_present));

  // The reason it is written to disk at all.
  const k2 = new Autopilot({ name: 't9', world: { room: {} },
                             client: { events: [], me: { name: 'Scooter' } } }, {});
  k2.recent5 = []; k2.journal = [];
  const live = k2.postMortem('still alive');
  ok('it works on a living character, so the recorder is testable',
     live.reason === 'still alive' && live.text.length === 0);

  // FOUND LIVE, NOT HERE. spend() clears `doing` at the END of each pass and the frame
  // is written at the START of the next one, so `doing` was structurally always null --
  // nine frames of a farming character all said null. These tests missed it because
  // they set the field by hand, which is the mistake worth leaving a guard against.
  const k3 = new Autopilot({ name: 't9', world: { room: {} },
                             client: { events: [], me: { name: 'Scooter' } } }, {});
  k3.recent5 = []; k3.journal = [];
  k3.doing = 'fighting';
  k3.spend(1000);
  ok('spend() still clears doing, as the time accounting needs', k3.doing === null);
  ok('but what the pass was is remembered', k3.lastDoing === 'fighting');
  ok('so a frame taken after the reset still knows',
     k3.postMortem('still alive').was.doing === 'fighting');
  k3.doing = null; k3.spend(1000);
  ok('a pass that decided nothing is "stalled", not null', k3.lastDoing === 'stalled');
  ok('and degrades to nulls rather than throwing on an empty history',
     live.where === null && live.vitals.health_per_second === null);
}

console.log('\nthe room that filled up with what nobody would kill');
{
  // East Merchant Way as found live: cap 10, and ten monsters in it — eight baby
  // spiders nobody wanted and two centipedes everybody did.
  // The REAL flag bits, imported rather than guessed. I first wrote these as 0x200/0x400
  // from memory; they are 0x08 and 0x04, and a fixture with invented bits would have
  // passed while testing nothing.
  const OF_ATTACKABLE = OF.ATTACKABLE, OF_PLAYER = OF.PLAYER;
  const spawns = {
    creatures: {
      centipede:   { name: 'centipede', cls: 'Centipede', level: 30, karma: 15, sites: [] },
      babyspider:  { name: 'baby spider', cls: 'BabySpider', level: 25, karma: -10, sites: [] },
      thrasher:    { name: 'thrasher', cls: 'Thrasher', level: 150, karma: -75, sites: [] },
    },
    rooms: { 554: [{ creature: 'centipede', cls: 'Centipede', level: 30, chance: 35, cap: 10, huntable: true },
                   { creature: 'baby spider', cls: 'BabySpider', level: 25, chance: 65, cap: 10, huntable: true }] },
    danger: {},
  };
  ok('roomCap reads the room-wide total', roomCap(spawns, 554) === 10);
  ok('and null for a room with no generator', roomCap(spawns, 999) === null);

  // A keeper standing in a full room. Objects are id -> {nameRsc, flags}.
  const mk = (counts, policy = {}) => {
    const objs = new Map();
    let id = 100;
    for (const [name, n] of Object.entries(counts))
      for (let i = 0; i < n; i++) objs.set(++id, { id, nameRsc: name, flags: OF_ATTACKABLE });
    objs.set(1, { id: 1, nameRsc: 'Beaker', flags: OF_ATTACKABLE | OF_PLAYER });   // a fleetmate
    const k = new Autopilot({ name: 't6', world: { room: { num: 554 } },
      client: { selfId: 9, room: { objects: objs }, rsc: { get: r => r },
                vitals: () => ({ health: { value: 25, max: 25 } }) } }, {});
    Object.assign(k.policy, { hunt: 'centipede', maxThreatOver: 6 }, policy);
    return k;
  };

  const full = mk({ 'baby spider': 8, centipede: 2 });
  const st = full.capBlockers({ num: 554 });
  ok('the room reads as full', st.full === true && st.present === 10, JSON.stringify(st));
  ok('fleetmates do not count toward the cap', st.present === 10);
  ok('our own prey is not counted as a blocker',
     !st.clearable.some(b => b.name === 'centipede') && !st.blocked.some(b => b.name === 'centipede'));
  ok('the baby spiders are clearable', st.clearable[0]?.name === 'baby spider');
  ok('and it knows how many there are', st.clearable[0].count === 8);

  const notFull = mk({ 'baby spider': 3, centipede: 2 });
  ok('a room below cap is not full and offers nothing to clear',
     notFull.capBlockers({ num: 554 }).full === false);

  // EXCEPTION 1 — karma. A kill is worth the NEGATIVE of the victim's karma.
  ok('killing negative-karma pushes you good, so an evil character refuses',
     karmaSafe(-10, 'evil') === false);
  ok('and a good character is happy to', karmaSafe(-10, 'good') === true);
  ok('positive-karma is the mirror', karmaSafe(15, 'evil') === true && karmaSafe(15, 'good') === false);
  ok('a neutral character only takes karma-0 prey',
     karmaSafe(0, 'neutral') === true && karmaSafe(-10, 'neutral') === false);
  ok('no school means no prohibition', karmaSafe(-10, null) === true);
  ok('UNKNOWN karma is not a prohibition — that would stall a character silently',
     karmaSafe(null, 'good') === true);
  const good = mk({ 'baby spider': 8, centipede: 2 }, { karma: 'evil' });
  const gst = good.capBlockers({ num: 554 });
  ok('an evil character will not clear baby spiders',
     gst.clearable.length === 0 && gst.blocked[0]?.name === 'baby spider', JSON.stringify(gst));
  ok('and says which exception it was', /karma/.test(gst.blocked[0].why));

  // EXCEPTION 2 — too dangerous.
  const scary = mk({ thrasher: 10 });
  const sst = scary.capBlockers({ num: 554 });
  ok('a level-150 blocker is not cleared by a level-25 character',
     sst.clearable.length === 0 && sst.blocked[0]?.name === 'thrasher');
  ok('and says it was the safety band, not karma',
     /safety band/.test(sst.blocked[0].why), sst.blocked[0].why);

  // Most numerous first: the point is freeing slots.
  // Ten, because nine would not be full and the whole block would silently test nothing.
  const mixed = mk({ 'baby spider': 2, thrasher: 1, rat: 7 }, { hunt: 'centipede' });
  const mst = mixed.capBlockers({ num: 554 });
  ok('the commonest clearable comes first', mst.clearable[0].name === 'rat',
     JSON.stringify(mst.clearable.map(x => `${x.count}x ${x.name}`)));
  ok('an unknown creature is still clearable — no level means no band to exceed',
     mst.clearable.some(x => x.name === 'rat'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
