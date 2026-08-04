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

import './m59-test-ledger.mjs';        // FIRST — the keeper records casts; see that file
import {
  isJunk, JUNK_NAMES, proficiencyFor, weaponRanking, equipBest, junkAndBroken,
  brokenSet, brokenWeaponText, abilityOf, equippedNow, inspectForBroken, carryCapacity, freeRoomFor, wouldFit, signetRings, returnSignetRings,
  parseDeathBroadcast, deathBroadcastFor,
} from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { isFood } from './m59-items.mjs';
import { outages, outageAround, recoverCrash, readLedger, ACTIVE_FILE } from './m59-uptime.mjs';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const recoverCrashAt = (activeFile, ledgerFile) => recoverCrash({ activeFile, ledgerFile });
const readLedgerAt = (f) => readLedger(f);
import { RoomGeometry } from './m59-roo.mjs';
import { roomCap, karmaSafe } from './m59-spawns.mjs';
import { OF } from './m59-parse.mjs';
import { nearestSafeSpot, safeSpots, exposureAt, lineOfSight, MAX_ATTACKERS } from './m59-safespots.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// A client whose inventory is a list of [id, name], and whose `use` replies the way the
// server does: either a refusal text from the script, or silence and the id joining the
// use list.
//
// That last part is the whole of the authoritative equipment change. BP_USE is the
// server saying "it is in plUsing now" (player.kod:3425-3426), and it is the only
// difference between "we asked to wield this" and "this is wielded". `tracksUse: false`
// models a client that keeps no use list, which must report NOT verified rather than
// fall back to the old guess.
function fakeClient(items, replies = {}, { tracksUse = true } = {}) {
  const names = new Map(items.map(([id, name]) => [id, name]));
  return {
    inventory: items.map(([id]) => ({ id, nameRsc: id })),
    rsc: { get: (r) => names.get(r) ?? '' },
    statsById: new Map(),
    evSeq: 0,
    used: [],
    events: [],
    ...(tracksUse ? { using: new Set() } : {}),
    requestInventory() {},
    use(id) {
      this.used.push(id);
      const text = replies[id];
      if (text) { this.events.push({ seq: ++this.evSeq, kind: 'message', text }); return; }
      this.using?.add(id);
      this.events.push({ seq: ++this.evSeq, kind: 'equipment', how: 'used', id });
    },
    waitFor({ since = 0 } = {}) {
      return { events: this.events.filter(e => e.seq > since) };
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

// THESE ASSERTIONS USED TO PIN INVENTED NAMES — "mace proficiency", "sword
// proficiency" and five more that no skill in the game is called. They were changed
// because they were wrong, not to make the code pass: each name below is verbatim from
// that skill's own resource string in kod, cited beside it.
//
// The reason it survived so long is worth keeping: the only consumer is a by-name
// lookup, and a name nothing answers to is indistinguishable from a skill the
// character has not learned. Both come back null.
console.log('\nwhich proficiency a weapon trains (viProficiency_Needed)');
{
  ok('short sword has its own', proficiencyFor('short sword') === 'short sword fighting');  // profshsw.kod
  ok('a long sword is fencing', proficiencyFor('long sword') === 'fencing');                // profswrd.kod
  ok('and so is a nerudite sword', proficiencyFor('nerudite sword') === 'fencing');
  ok('scimitar is its own', proficiencyFor('scimitar') === 'scimitar wielding');            // profscim.kod
  ok('axe', proficiencyFor('battle axe') === 'axe wielding');                               // profaxe.kod
  ok('mace', proficiencyFor('mace') === 'mace fighting');                                   // profmace.kod
  ok('hammer', proficiencyFor('war hammer') === 'hammer wielding');                         // profhamr.kod
  ok('bows are archery', proficiencyFor('crossbow') === 'archery');                         // archery.kod
  ok('something unrecognised gets null, not a guess', proficiencyFor('turnip') === null);
  // Order matters: "short sword" must not fall through to the /sword/ rule.
  ok('the short sword rule wins over the generic sword rule',
     proficiencyFor('short sword') !== 'fencing');
}

console.log('\nranking by proficiency, and overriding it');
{
  const c = fakeClient([[1, 'long sword'], [2, 'battle axe']]);
  c.statsById.set('fencing', { value: 90 });
  c.statsById.set('axe wielding', { value: 11 });
  ok('abilityOf reads a named skill', abilityOf(c, 'fencing') === 90);
  ok('and returns null when never read, not 0', abilityOf(c, 'mace fighting') === null);
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

console.log('\nasking whether a weapon is broken BEFORE carrying it home');
{
  // A client that answers `look` from a script. `null` models the empty first reply the
  // live server gives when two looks come back to back — measured, not assumed.
  const looker = (descriptions) => {
    const c = fakeClient([[1, 'mace'], [2, 'long sword'], [3, 'dagger']]);
    c.looked = [];
    c.look = function (id) {
      this.looked.push(id);
      const seq = descriptions[id];
      const d = Array.isArray(seq) ? seq[this.looked.filter(x => x === id).length - 1] : seq;
      this.events.push({ seq: ++this.evSeq, kind: 'look', id, description: d ?? null });
    };
    c.waitFor = function ({ kinds } = {}) {
      const evs = this.events.filter(e => !kinds || kinds.includes(e.kind));
      this.events = [];
      return { events: evs };
    };
    return c;
  };
  const SHATTERED = 'A heavy mace.\r\n\r\nThis mace has been shattered by a powerful blow.';

  const c1 = looker({ 1: SHATTERED, 2: 'A fine blade.', 3: 'A small knife.' });
  const r1 = await inspectForBroken(fakeSession(c1), [1, 2, 3]);
  ok('the shattered one is identified from its description', r1.broken.join() === '1',
     JSON.stringify(r1));
  ok('the sound ones are not condemned', r1.sound.join() === '2,3');
  ok('and it is remembered, so junkAndBroken can drop it', brokenSet(c1).has(1));

  // The retry. First look returns null, second returns the truth.
  const c2 = looker({ 1: [null, SHATTERED] });
  const r2 = await inspectForBroken(fakeSession(c2), [1]);
  ok('an empty first reply is retried rather than believed', r2.broken.join() === '1',
     JSON.stringify(r2));
  ok('which took two looks', c2.looked.length === 2);

  // The case that must never be guessed.
  const c3 = looker({ 1: [null, null] });
  const r3 = await inspectForBroken(fakeSession(c3), [1]);
  ok('no answer at all is UNKNOWN, not broken', r3.unknown.join() === '1' && !r3.broken.length,
     JSON.stringify(r3));
  ok('and an unknown weapon is NOT condemned — we would be throwing away good ones',
     !brokenSet(c3).has(1));

  // Already-known ones cost nothing to re-ask about.
  const c4 = looker({ 1: SHATTERED });
  brokenSet(c4).add(1);
  const r4 = await inspectForBroken(fakeSession(c4), [1]);
  ok('a weapon already known broken is not looked at again', c4.looked.length === 0);
  ok('but it is still reported broken', r4.broken.join() === '1');

  // And junkAndBroken must then actually offer it up.
  const c5 = looker({ 1: SHATTERED });
  await inspectForBroken(fakeSession(c5), [1]);
  const dead = junkAndBroken(c5);
  ok('what inspection condemns, junkAndBroken lists for dropping',
     dead.some(d => d.id === 1), JSON.stringify(dead));
}

console.log('\nwhat the mana says about a cast, and what we can know about carrying');
{
  // The ceiling is exact arithmetic; the load is not knowable and must not be invented.
  const c = fakeClient([[1, 'mace'], [2, 'herb']]);
  c.stat = (k) => (k === 'might' ? 25 : null);
  const cap = carryCapacity(c);
  ok('the ceiling is 1700 + might*20', cap.weight_max === 2200 && cap.bulk_max === 2200,
     JSON.stringify(cap));
  ok('weight and bulk share one formula', cap.weight_max === cap.bulk_max);
  ok('the load is now added up from the kod table', cap.load?.weight === 62,   // mace 60 + herb 2
     JSON.stringify(cap.load));
  ok('and bulk is counted separately from weight', cap.load?.bulk === 64,      // mace 60 + herb 4
     JSON.stringify(cap.load));
  ok('room_for is the ceiling minus the load', cap.room_for?.weight === 2200 - 62);
  const blind = fakeClient([[1, 'mace']]);
  blind.stat = () => null;
  ok('with might unread it says so rather than assuming a default',
     carryCapacity(blind).known === false);

  // The honesty rule: an unrecognised item makes the total a LOWER BOUND, and room_for
  // must be withheld rather than computed from an undercount.
  const odd = fakeClient([[1, 'mace'], [2, 'nameless curio']]);
  odd.stat = (k) => (k === 'might' ? 25 : null);
  const capOdd = carryCapacity(odd);
  ok('an unweighed item marks the load inexact', capOdd.load.exact === false,
     JSON.stringify(capOdd.load));
  ok('and room_for is withheld rather than guessed low', capOdd.room_for === null);
  ok('the unweighed ones are named so the table can be fixed',
     (capOdd.load.unweighed || []).includes('nameless curio'));
  ok('wouldFit returns null when it cannot know, so callers cannot read it as yes',
     wouldFit(odd, 60) === null);
  ok('and answers honestly when it can', wouldFit(c, 60) === true);
  ok('refusing what genuinely will not fit', wouldFit(c, 5000) === false);

  // freeRoomFor sheds only what is already known dead — it never gambles on the load.
  const c2 = fakeClient([[1, 'mace'], [2, 'broken mace'], [3, 'dagger']]);
  c2.dropped = [];
  c2.drop = function (ids) { this.dropped.push(...ids); };
  const freed = await freeRoomFor(fakeSession(c2));
  ok('junk is shed to make room', freed.dropped.some(d => d.name === 'broken mace'),
     JSON.stringify(freed.dropped));
  ok('and a sound weapon is not', !freed.dropped.some(d => d.name === 'dagger'));
  const c3 = fakeClient([[1, 'dagger']]);
  c3.drop = function () { throw new Error('should not drop anything'); };
  const none = await freeRoomFor(fakeSession(c3));
  ok('nothing dead means nothing dropped, not a panic clear-out', none.dropped.length === 0);
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

// ------------------------------------------------------- what is actually equipped
//
// Every claim below used to be an inference, and each one was wrong in its own way.
// The server has kept the answer the whole time, in plUsing, and sends it unasked.

console.log('\nequipping is verified against the server\'s use list');
{
  const c = fakeClient([[1, 'long sword'], [2, 'dagger']]);
  const r = await equipBest(fakeSession(c));
  ok('the wielded weapon is the one the server put in the use list',
     r.wielding === 'long sword' && c.using.has(1), JSON.stringify(r));
  ok('and that is what "verified" now means', r.verified === true);
  ok('it says what confirmed it', /use list/.test(r.confirmed_by || ''), r.confirmed_by);
}

// The refusal that read as success for as long as this code has existed. Re-`use` of a
// wielded item is not a toggle — CheckPosition counts the item against its own slot and
// answers "your hands are too full" (player.kod:131,3235). The old check only looked for
// the BROKEN message, so this came back verified with the weapon unchanged.
console.log('\na refusal that is not the broken message is still a refusal');
{
  const c = fakeClient([[1, 'long sword'], [2, 'dagger']],
                       { 1: 'Your hands are too full to use that.' });
  const r = await equipBest(fakeSession(c));
  ok('a hands-full refusal does not count as wielding it', r.wielding !== 'long sword',
     JSON.stringify(r));
  ok('it moves on to the next weapon', r.wielding === 'dagger' && c.using.has(2));
  ok('and says what was in the way rather than blaming the weapon',
     /hands too full/.test(r.rejected?.[0]?.why || ''), JSON.stringify(r.rejected));
  ok('the hands-full weapon is NOT remembered as broken', !brokenSet(c).has(1));
}

// A refusal with no text at all — the server declining silently. Nothing to pattern
// match on, and the old code therefore called it a success.
console.log('\na silent refusal is caught by the use list alone');
{
  const c = fakeClient([[1, 'long sword']]);
  c.use = function (id) { this.used.push(id); };     // accepts, confirms nothing, says nothing
  const r = await equipBest(fakeSession(c));
  ok('silence is not taken for consent', r.wielding === null && r.verified === false,
     JSON.stringify(r));
  ok('and it says the server never added it', /never added it to the use list/.test(r.rejected?.[0]?.why || ''),
     JSON.stringify(r.rejected));
}

// `fight` calls equipBest before every engagement. Without this the common case spends
// a request — out of five a second, right before a fight — being told no.
console.log('\nalready holding the best weapon costs no request');
{
  const c = fakeClient([[1, 'long sword'], [2, 'dagger']]);
  await equipBest(fakeSession(c));
  const sent = c.used.length;
  const r = await equipBest(fakeSession(c));
  ok('the second call sends no use at all', c.used.length === sent, `used=${JSON.stringify(c.used)}`);
  ok('and still reports the weapon', r.wielding === 'long sword' && r.verified === true);
  ok('saying it was already wielded', r.already_wielded === true, JSON.stringify(r));
}

// The honest degradation. A client with no use list must not silently reuse the old
// guess and call it verified.
console.log('\na client that keeps no use list says so');
{
  const c = fakeClient([[1, 'long sword']], {}, { tracksUse: false });
  const r = await equipBest(fakeSession(c));
  ok('it still wields something', r.wielding === 'long sword');
  ok('but does not claim it was verified', r.verified === false, JSON.stringify(r));
  ok('and explains what it does not know', /keeps no use list/.test(r.note || ''), r.note);
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

// The mirror of that bug. Protecting equipment by NAME cuts both ways: the name test
// that wrongly kept a shattered sword also wrongly dropped anything worn that is not
// named after a weapon. The use list answers it exactly, for both directions.
console.log('\nnothing you are wearing is dead weight');
{
  const c = fakeClient([[1, 'broken mace'], [2, 'ring of the sun'], [3, 'rat pelt']]);
  c.using.add(1);                                  // wielding it, junk name and all
  const dead = junkAndBroken(c);
  ok('a junk NAME on a worn item is not a reason to strip the character',
     !dead.some(d => d.id === 1), JSON.stringify(dead));
  c.using.delete(1);
  ok('and the moment it is taken off, it is dead weight again',
     junkAndBroken(c).some(d => d.id === 1));

  // The pack-clearer's own guard, which is a value regex and always was. A worn ring
  // matches nothing in it, so before the use list it was as droppable as the pelt.
  const keep = /shilling|coin|diamond|ruby|emerald|sapphire|armor|armour|shield|sword|mace|hammer|axe|bow|helm|gauntlet/i;
  ok('a worn ring is protected by no name in the keep list', !keep.test('ring of the sun'));
  const worn = equippedNow(c) ?? new Set();
  worn.add(2);
  const droppable = c.inventory.filter(o => !worn.has(o.id) && !keep.test(c.rsc.get(o.nameRsc)));
  ok('but the use list protects it', !droppable.some(o => o.id === 2),
     JSON.stringify(droppable.map(o => c.rsc.get(o.nameRsc))));
  ok('while the rat pelt is still fair game', droppable.some(o => o.id === 3));
}

console.log('\nequippedNow is null, not empty, when the client cannot answer');
{
  // The distinction the whole change rests on. A client with no use list must return
  // null so callers fall back to their old guard; returning an empty Set would say
  // "nothing is equipped", and every drop guard downstream would believe it.
  ok('a tracking client gives a Set', equippedNow(fakeClient([[1, 'x']])) instanceof Set);
  ok('a non-tracking one gives null, not an empty Set',
     equippedNow(fakeClient([[1, 'x']], {}, { tracksUse: false })) === null);
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

console.log('\nreach is a disc of radius 3, not the eight squares touching you');
{
  // An open field with one wall stub, so every claim below is about the arithmetic
  // rather than about a fixture's corners.
  const mk = (rows, cols, holes = []) => {
    const flags = Buffer.alloc(rows * cols, 0x01);
    for (const [r, c] of holes) flags[(r - 1) * cols + (c - 1)] = 0x00;
    // Every direction open from every square; walls are expressed as missing floor,
    // which is what CanMoveInRoom checks first.
    const grid = Buffer.alloc(rows * cols, 0xff);
    return new RoomGeometry({ file: 'test', version: 12, rows, cols, grid, flags,
                              monsterGrid: null, walls: [], sidedefs: [], clientSize: null });
  };

  ok('the disc has 28 squares in it, not 8', MAX_ATTACKERS === 28);

  // Open floor: everything in the disc can reach us, and nothing is a free shot.
  const open = mk(15, 15);
  const mid = exposureAt(open, 8, 8);
  ok('in the open every one of the 28 can hit you', mid.attackers === 28, JSON.stringify(mid));
  ok('and nothing can be hit for free', mid.free_shots === 0);
  ok('but there is ground to fight from', mid.our_ground === 12);

  // The square two away is inside reach and would have been missed by an adjacency
  // model — this is the specific error the old ring made.
  const twoAway = mk(15, 15, [[8, 9], [8, 10]]);   // a two-square stub due east
  ok('a square two east is in reach when the floor is there',
     exposureAt(mk(15, 15), 8, 8).attackers > exposureAt(twoAway, 8, 8).attackers);

  // LineOfSight is the server's staircase walk, and it is what makes a free shot.
  const wall = mk(15, 15, [[7, 9], [8, 9], [9, 9]]);   // a north-south wall one east
  ok('sight through a wall square is refused', lineOfSight(wall, 8, 10, 8, 8) === false);
  ok('sight along open floor is granted', lineOfSight(wall, 8, 6, 8, 8) === true);
  const behind = exposureAt(wall, 8, 8);
  ok('the wall denies squares behind it, not just the ones it occupies',
     behind.attackers < 28 - 3, `${behind.attackers} attackers`);
  ok('and it creates squares we can hit that cannot answer',
     behind.free_shots > 0, JSON.stringify(behind));

  // A square with no floor within our reach is a cell, not a fighting position. Our
  // reach is 2, so clearing only the eight touching squares does NOT make one — which
  // is the same mistake in miniature, and worth pinning.
  const cell = mk(9, 9);
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++) {
    const dr = r - 5, dc = c - 5;
    if ((dr || dc) && dr * dr + dc * dc <= 4) cell.flags[(r - 1) * 9 + (c - 1)] = 0x00;
  }
  ok('walling only the eight neighbours does not make a cell',
     exposureAt(mk(9, 9, [[4,4],[4,5],[4,6],[5,4],[5,6],[6,4],[6,5],[6,6]]), 5, 5).our_ground > 0);
  ok('a square with nothing in our reach is not offered as a spot',
     safeSpots(cell, { limit: Infinity }).every(s => !(s.col === 5 && s.row === 5)));

  // The score has to prefer the free shot over mere enclosure, because the book says
  // free shots hold 89% against 31% for none.
  const scored = safeSpots(wall, { limit: Infinity });
  const best = scored[0];
  ok('the best-scoring square in a room with a wall has free shots',
     best && best.free_shots > 0, JSON.stringify(best && { col: best.col, row: best.row, free: best.free_shots }));
  ok('open floor scores nothing, so it is never the pick',
     scored.every(s => s.can_reach_you < MAX_ATTACKERS));
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

console.log('\ndropping a stack needs the quantity');
{
  const k = new Autopilot({ name: 't6', world: { room: {} }, client: null }, {});
  // encodeIdList has always taken {id, amount}; every caller passed a bare id, and
  // UserDrop (user.kod:3802) returns early on `number <= 0` without dropping anything.
  // Beaker spent 14 passes on "dropped red mushroom x20" while still carrying 15 of 14.
  ok('a stack is sent with its quantity',
     JSON.stringify(k.dropSpec({ id: 7, amount: 20 })) === '{"id":7,"amount":20}');
  ok('a single item is still sent as a bare id', k.dropSpec({ id: 7, amount: 1 }) === 7);
  ok('and so is one with no amount at all', k.dropSpec({ id: 7 }) === 7);
  ok('a missing object does not throw', k.dropSpec(undefined) === undefined);
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
  ok('and is not a reason to stop hunting', !notFull.capBlockers({ num: 554 }).should_clear);

  // THE CASE THE FIRST VERSION MISSED, and it was the live one. Prey IS present -- two
  // centipedes -- so "no prey here" never fired, and the keeper hunted the two while
  // eight spiders held the cap. At 65% spider spawn the room only gets worse.
  ok('a full room where blockers outnumber prey is cleared even though prey is present',
     st.should_clear === true, JSON.stringify({ prey: st.prey_present, why: st.why_clear }));
  ok('it counts the prey that is present', st.prey_present === 2);
  ok('and says composition is the reason, not absence', /only 2/.test(st.why_clear ?? ''));
  const mostlyPrey = mk({ 'baby spider': 2, centipede: 8 });
  const mp = mostlyPrey.capBlockers({ num: 554 });
  ok('a full room that is mostly prey is left alone — hunting is better than tidying',
     mp.full === true && mp.should_clear === false, JSON.stringify(mp.why_clear));

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


// A SIGNET RING IS 1500 SHILLINGS THE FLEET WAS CARRYING AS LOOT.
console.log('\ngiving a signet ring back to whoever is named on it');
{
  const CREST = (who) => `This ring is worn and dirty, but you make out the family crest of ${who}. Surely, its return would be appreciated.`;
  const build = ({ owners = {}, present = [], takes = true } = {}) => {
    const items = Object.keys(owners).map(id => [Number(id), 'signet ring']);
    const c = fakeClient(items.length ? items : [[1, 'signet ring']]);
    c.looked = [];
    c.offered = [];
    c.room = { objects: new Map(present.map((n, i) => [900 + i, { id: 900 + i, nameRsc: 900 + i }])) };
    const names = new Map(present.map((n, i) => [900 + i, n]));
    const base = c.rsc.get;
    c.rsc = { get: (r) => names.get(r) ?? base(r) };
    c.selfId = 1;
    c.look = function (id) {
      this.looked.push(id);
      this.events.push({ seq: ++this.evSeq, kind: 'look', id, description: CREST(owners[id]) });
    };
    c.offer = function (to, ids) {
      this.offered.push({ to, ids });
      if (takes) this.inventory = this.inventory.filter(o => !ids.includes(o.id));
    };
    c.waitFor = function ({ kinds } = {}) {
      const evs = this.events.filter(e => !kinds || kinds.includes(e.kind));
      this.events = [];
      return { events: evs };
    };
    return c;
  };

  const c1 = build({ owners: { 1: 'Pietro' }, present: ['Pietro'] });
  const r1 = await returnSignetRings(fakeSession(c1));
  ok('the ring goes back when its owner is standing here',
     r1.returned.length === 1 && r1.returned[0].to === 'Pietro', JSON.stringify(r1));
  ok('and it was offered to that object, not to anyone else', c1.offered[0].to === 900);

  const c2 = build({ owners: { 1: 'Pietro' }, present: ['Hester Gilk'] });
  const r2 = await returnSignetRings(fakeSession(c2));
  ok('a different NPC is not offered the ring', r2.returned.length === 0 && c2.offered.length === 0);
  ok('and we say we are still carrying it', r2.carrying === 1);

  const c3 = build({ owners: { 1: 'Pietro' }, present: [] });
  ok('an empty room costs no offers', (await returnSignetRings(fakeSession(c3))).returned.length === 0);

  // The owner is read once and remembered — a look per ring per pass would be absurd.
  const c4 = build({ owners: { 1: 'Pietro' }, present: ['Pietro'] });
  const s4 = fakeSession(c4);
  await signetRings(s4);
  const afterFirst = c4.looked.length;
  await signetRings(s4);
  ok('the owner is looked up once and cached', c4.looked.length === afterFirst && afterFirst === 1,
     `looked ${c4.looked.length} times`);

  // If the NPC does not take it, that is reported rather than counted as returned.
  const c5 = build({ owners: { 1: 'Pietro' }, present: ['Pietro'], takes: false });
  const r5 = await returnSignetRings(fakeSession(c5));
  ok('a refusal is not counted as a return', r5.returned.length === 0 && r5.refused.length === 1,
     JSON.stringify(r5));
  ok('proof is the ring LEAVING the pack, not the offer being sent', r5.carrying === 1);
}


// AN EMPTY HAND IS NOT A FIGHT, IT IS A BEATING.
//
// The keeper sent unarmed characters out to hunt over and over -- Scooter three times in
// one afternoon, Rowlf, Gonzo and Animal once each. An unarmed character still swings and
// still reports fighting, so nothing about it reads as broken from outside.
console.log('\nrefusing to hunt with nothing in hand');
{
  const keeper = (equipped, known = true) => {
    const k = Object.create(Autopilot.prototype);
    k.s = { client: { equipment: () => ({ known, equipped }), rsc: { get: () => '' } } };
    return k;
  };
  ok('a wielded mace counts as armed', keeper([{ name: 'mace' }]).armed() === true);
  ok('an empty use list is NOT armed', keeper([]).armed() === false);
  ok('armour alone is not a weapon',
     keeper([{ name: 'leather armor' }, { name: 'shield' }]).armed() === false);
  ok('a weapon among the armour still counts',
     keeper([{ name: 'leather armor' }, { name: 'short sword' }]).armed() === true);
  // Junk that merely looks like a weapon must not satisfy the check -- "broken mace" is
  // a real junk item, and weaponScore already excludes it.
  ok('a junk "broken mace" does not count as armed',
     keeper([{ name: 'broken mace' }]).armed() === false);
  // A read we could not make must not idle the fleet: unknown is treated as armed, so
  // the guard catches empty hands rather than becoming a new way to stop.
  ok('an unreadable use list is treated as armed, not as unarmed',
     keeper([], false).armed() === true);
}


// THE VIGOR CAP IS A SHOPPING PROBLEM, AND THE FLEET WAS NEVER SHOPPING.
//
// Resting stops awarding vigor at 80 of 200, so everything above it has to be eaten.
// restockReagents filtered every shop list through shareKind -- elderberry and herbs and
// nothing else -- so a character could stand at a counter selling bread with money in
// hand and buy nothing. Ten of twenty-one sat at exactly 80 for a whole session.
console.log('\nknowing what is food, from the class tree rather than a word list');
{
  ok('bread is food', isFood('loaf of bread'));
  ok('so is an apple', isFood('apple'));
  ok('and a drink counts — vigor is vigor', isFood('mug of stout'));
  // The two that a name-matching rule would get wrong, in both directions.
  ok('an Inky-cap mushroom is food, which "contains mushroom" would have to guess at',
     isFood('Inky-cap mushroom'));
  ok('but elderberry is a REAGENT, not food', !isFood('elderberry'));
  ok('and so is a herb', !isFood('herb'));
  ok('a weapon is not food', !isFood('mace'));
  ok('an unknown name is not food — buying scenery wastes money', !isFood('nameless curio'));
  ok('and it is case-insensitive, because names arrive as the server spells them',
     isFood('LOAF OF BREAD') && isFood('  apple '));
}


// THE SERVER ANNOUNCES THE KILLER, AND NOTHING WAS READING IT.
//
// killed_by was "everything standing next to us at the end". Against 249 deaths that have
// a matching broadcast, the crowd's most common member was the real killer 51% of the
// time -- a coin flip written into the record as a cause of death. It also invented a
// culprit: twelve Badlands deaths were blamed on "soldier of the Duke's army" for being
// nearby, when the broadcasts say groundworm nine times and troll four.
console.log('\nreading who actually struck the killing blow');
{
  const p = parseDeathBroadcast;
  ok('the ordinary form names the killer',
     p('### Kermit was just killed by a giant rat.')?.killer === 'giant rat');
  ok('and names the victim', p('### Kermit was just killed by a giant rat.')?.who === 'Kermit');
  ok('the article is stripped, so it joins to a creature name',
     p('### Zoot was just killed by an ant.')?.killer === 'ant');
  // A player kill does NOT name the killer -- the record must not invent one.
  const murder = p('### Piggy has been murdered in cold blood.');
  ok('murder in cold blood is recognised', murder?.how === 'murdered by a player');
  ok('and leaves the killer null rather than guessing', murder?.killer === null);
  ok('the room killing you is its own cause',
     p('### Zoot met an untimely end.')?.how === 'the room itself');
  ok('so is your own folly',
     p('### Beaker was just slain by his own folly.')?.how === 'own folly');
  ok('a murderer being killed still yields the killer',
     p('### The notorious murderer, Lew, has been killed by a troll.')?.killer === 'troll');
  // Same channel, not a death. Treating it as one would file a token loss as a fatality.
  ok('"lost a token to" is NOT a death', p('### Rowlf lost a token to a centipede.') === null);
  ok('ordinary combat text is not a broadcast', p('You hit the giant rat for 4 damage.') === null);
  ok('empty input does not throw', p('') === null && p(null) === null);

  // Matching to the right character matters: twenty-one characters die often enough that
  // "the most recent ### line" is regularly about somebody else.
  const evs = [
    { at: 1000, text: '### Scooter was just killed by a centipede.' },
    { at: 1900, text: '### Kermit was just killed by a giant rat.' },
    { at: 2500, text: '### Beaker was just killed by a slime.' },
  ];
  ok('it picks the broadcast naming US, not the nearest in time',
     deathBroadcastFor('Kermit', evs, 2400)?.killer === 'giant rat');
  ok('and is case-insensitive about the name',
     deathBroadcastFor('kermit', evs, 2000)?.killer === 'giant rat');
  ok('a character with no broadcast gets null, not somebody else\'s',
     deathBroadcastFor('Rowlf', evs, 2000) === null);
  ok('and one far outside the window is not claimed',
     deathBroadcastFor('Kermit', evs, 999999, { withinMs: 5000 }) === null);
}


// LOW VIGOR IS NOT A REASON TO RUN AWAY. LOW HEALTH IS.
//
// `hurt` is true when EITHER health or vigor is short. That is right for deciding to rest
// and wrong for deciding to abandon a room: vigor does not fall because a monster is
// nearby, health does. Measured on the fleet: of 107 room-flees, all 107 were by
// characters below 180 vigor and none by a well-fed one, and every fleeing character had
// zero kills. Robin fled 54 times at 29 of 29 health.
console.log('\nwhen to leave a room, and when to stand and fight tired');
{
  // The predicate as the keeper computes it: health below the rest bar, OR too tired to
  // fight at all for this character's own vigor floor.
  const leaves = (hp, vig, fightAboveVigor) => {
    const healthHurt = hp !== null && hp < 0.7;                 // restAt
    const tooTired = vig !== null && vig < (fightAboveVigor / 200);
    return healthHurt || tooTired;
  };
  ok('full health at the vigor cap does NOT leave — it fights tired',
     leaves(1.0, 0.4, 0) === false);
  ok('nor at 90% health and low vigor', leaves(0.9, 0.4, 0) === false);
  ok('but genuinely hurt still leaves', leaves(0.3, 1.0, 0) === true);
  ok('and hurt AND tired leaves', leaves(0.3, 0.4, 0) === true);
  // The deadlock the branch exists for must survive: a character that refuses to fight
  // below a vigor floor cannot fight and cannot rest in a combat zone, so it must go.
  ok('a character with a vigor floor it cannot meet still leaves',
     leaves(1.0, 0.4, 180) === true);
  ok('and once above that floor it stays', leaves(1.0, 0.95, 180) === false);
  ok('unknown vitals do not trigger a flee', leaves(null, null, 0) === false);
}


// WAS ANYTHING DRIVING WHEN IT DIED?
//
// A keeper is the only thing that makes a character act. Without one it stands exactly
// where it was, in whatever room it was in, while everything already swinging at it
// carries on -- so a stopped keeper is not a pause, it is a character held still in a
// fight. A broker restart stops all twenty-one at once, which is why deaths arrive in
// waves, and every one of those was being charged to the hunting strategy.
console.log('\nmarking the deaths that happened with nobody driving');
{
  const led = [
    { at: 1000, agent: 't1', event: 'stop', why: 'restart' },
    { at: 5000, agent: 't1', event: 'start' },
    { at: 9000, agent: 't2', event: 'stop' },
  ];
  const o1 = outages('t1', led, 20000);
  ok('a closed outage is found', o1.length === 1 && o1[0].ms === 4000, JSON.stringify(o1));
  ok('and it carries why it went down', o1[0].why === 'restart');
  const o2 = outages('t2', led, 20000);
  ok('a keeper that never came back is still an outage', o2[0].open === true,
     JSON.stringify(o2));
  ok('measured up to now', o2[0].ms === 11000);
  ok('an agent with no events has none', outages('t9', led, 20000).length === 0);

  ok('a death inside the window is marked',
     outageAround('t1', 3000, led)?.died_ms_into_outage === 2000);
  ok('a death before it is not', outageAround('t1', 500, led) === null);
  // The grace window: a character standing still under attack for minutes is usually
  // past saving when the keeper returns, so the death lands just after the resume.
  ok('a death shortly AFTER the resume still belongs to the outage',
     outageAround('t1', 5000 + 20000, led)?.after_resume === 20000);
  ok('but not long after', outageAround('t1', 5000 + 300000, led) === null);
  ok('another agent is never blamed for this one\'s outage',
     outageAround('t9', 3000, led) === null);
}


// A CRASH WRITES NOTHING, which is the hole in the uptime ledger: stop() records "I am
// going away" and a process that dies cannot. So the worst outages -- twenty-one
// characters standing still until somebody notices -- were the ones it could not see.
// A file that exists only while keepers run, removed on clean shutdown, closes it; the
// heartbeat inside it is what turns "it crashed" into "it crashed at 21:47".
console.log('\ntelling a crash from a clean shutdown');
{
  const tmp = mkdtempSync(join(tmpdir(), 'm59-crash-'));
  const active = join(tmp, 'keeper-active.json');
  const led = join(tmp, 'uptime.jsonl');
  const beat = Date.now() - 120000;

  // A file left behind by a pid that is gone == the last run died.
  writeFileSync(active, JSON.stringify({ pid: 999999, beat_at: beat, agents: ['t1', 't2'] }));
  const found = recoverCrashAt(active, led);
  ok('a leftover liveness file is read as a crash', !!found, JSON.stringify(found));
  ok('and it names every agent that was being driven', found.agents.join() === 't1,t2');
  ok('the last heartbeat dates it', found.last_beat === beat);
  ok('the file is cleared so it is not counted twice', !existsSync(active));
  const rows = readLedgerAt(led);
  ok('a stop is recorded for each agent', rows.length === 2 && rows.every(r => r.event === 'stop'),
     `${rows.length} rows`);
  // rows.length is asserted separately: .every() on an empty array passes vacuously, and
  // that is exactly how the first version of this reported success while writing nothing.
  ok('marked as an estimate, not a fact', rows.length > 0 && rows.every(r => r.estimated === true));
  ok('and says why', /crashed/.test(rows[0].why));

  // Clean shutdown: no file, so nothing to recover.
  ok('no liveness file means the last shutdown was clean',
     recoverCrashAt(join(tmp, 'absent.json'), led) === null);

  // A live pid is a second broker, not a crash — that is the fleet lock's problem.
  const live = join(tmp, 'live.json');
  writeFileSync(live, JSON.stringify({ pid: process.pid, beat_at: beat, agents: ['t1'] }));
  ok('a file held by a LIVE process is not a crash', recoverCrashAt(live, led) === null);
  ok('and it is left alone for the owner', existsSync(live));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
