#!/usr/bin/env node
//
// The fleet's supply coordination: who is short of what, who is near enough to be handed
// it, and how far a courier will walk to finish the job.
//
// The three properties pinned here are the three that were WRONG in the version this
// replaced, and each failed silently:
//
//   - a shortfall the board could not state was invisible to the only mechanism that
//     fetches things, so a fleet holding 14 elderberry against 215 herbs kept buying herbs;
//   - a delivery addressed to a frozen list of people reported "farmer left the room or is
//     dead" and carried the goods home, because minutes pass between the poll and the
//     arrival and the fleet moves in them;
//   - a delivery addressed to ONE room ignored a character standing one door away.
import assert from 'node:assert/strict';
import { interest } from './m59-skills.mjs';
import { roomsWithin } from './m59-map.mjs';
import { wantsOf } from './m59-loadout.mjs';

let n = 0;
const ok = (cond, why) => { assert.ok(cond, why); n++; };
const eq = (a, b, why) => { assert.deepEqual(a, b, why); n++; };

// ------------------------------------------------------------------ the board, one room
interest.byAgent.clear();
interest.declare('courier', { room: 38, character: 'Courier', farming: true,
  wants: ['herb'], needs: { herb: 20 }, spare: {} });
interest.declare('farmer-a', { room: 39, character: 'Kermit', farming: true,
  wants: ['herb', 'elderberry'], needs: { herb: 42, elderberry: 7 }, spare: {} });
interest.declare('farmer-b', { room: 39, character: 'Gonzo', farming: true,
  wants: ['herb'], needs: new Map([['herb', 12]]), spare: new Map() });
interest.declare('visitor', { room: 39, character: 'Visitor', farming: false,
  wants: ['herb'], needs: { herb: 99 }, spare: {} });

const room = interest.demandsForRoom(39, { except: 'courier' });
eq(room.map(row => row.agent).sort(), ['farmer-a', 'farmer-b']);
eq(room[0].needs, { herb: 42, elderberry: 7 });
ok(room.every(row => row.character !== 'Visitor'), 'a non-farming declaration is not an order');
eq(interest.demandsForRoom(38, { except: 'courier' }), []);
eq(interest.board().find(row => row.agent === 'farmer-b').needs, { herb: 12 });

// ------------------------------------------------------------------ ANY kind, not two
//
// The board carries whatever a loadout put on it. Nothing here knows what a "mushroom" is
// for, and that is the point: the delivery mechanism must not have its own opinion about
// which shortfalls are worth fetching, or it will have the old one.
interest.declare('caster', { room: 39, character: 'Zoot', farming: true,
  wants: ['mushroom'], needs: { mushroom: 40, 'blue dragon scale': 2 }, spare: {} });
const anyKind = interest.demandsForRoom(39, { except: 'courier' }).find(r => r.agent === 'caster');
eq(anyKind.needs, { mushroom: 40, 'blue dragon scale': 2 },
  'a loadout shortfall reaches the board whatever it is named');

// ------------------------------------------------------------------ the neighbourhood
//
// Nearest first, because a courier should empty its pack in the room it is standing in
// before it walks anywhere, and the ordering is the difference between one short walk and
// crossing the destination twice.
interest.byAgent.clear();
interest.declare('here',   { room: 38, character: 'Here',  farming: true, needs: { herb: 5 } });
interest.declare('next',   { room: 39, character: 'Next',  farming: true, needs: { herb: 5 } });
interest.declare('far',    { room: 41, character: 'Far',   farming: true, needs: { herb: 5 } });
interest.declare('beyond', { room: 99, character: 'Beyond', farming: true, needs: { herb: 5 } });

const near = interest.demandsNear(new Map([[38, 0], [39, 1], [41, 2]]));
eq(near.map(r => r.agent), ['here', 'next', 'far'], 'sorted by hops, nearest first');
eq(near.map(r => r.hops), [0, 1, 2]);
ok(!near.some(r => r.agent === 'beyond'), 'a room outside the neighbourhood is not served');
eq(interest.demandsNear([38, 39]).map(r => r.agent).sort(), ['here', 'next'],
  'a plain list of rooms is accepted and reads as distance zero');

// A STALE DECLARATION IS NOT A DELIVERY ORDER. Somebody who logged off an hour ago must
// not pull a courier across the map.
interest.declare('ghost', { room: 38, character: 'Ghost', farming: true, needs: { herb: 5 } });
interest.byAgent.get('ghost').at = Date.now() - 10 * 60_000;
ok(!interest.demandsNear([38]).some(r => r.agent === 'ghost'), 'a stale want is ignored');
ok(interest.demandsNear([38], { maxAgeMs: 20 * 60_000 }).some(r => r.agent === 'ghost'),
  'and comes back when the caller asks for a wider window');

// A want of zero is not a want.
interest.declare('sated', { room: 38, character: 'Sated', farming: true, needs: { herb: 0 } });
ok(!interest.demandsNear([38]).some(r => r.agent === 'sated'), 'a zero shortfall is not an order');

// ------------------------------------------------------------------ roomsWithin
//
// A tiny fixture rather than the real map: this is testing the walk, not the world. High
// room numbers keep it clear of the code-declared and synthetic exits the real graph has.
const go = (to) => ({ to, row: 1, col: 1 });
const map = { rooms: {
  9001: { num: 9001, edgeExits: [], goExits: [go(9002), go(9003)] },
  9002: { num: 9002, edgeExits: [], goExits: [go(9004)] },
  9003: { num: 9003, edgeExits: [], goExits: [] },
  9004: { num: 9004, edgeExits: [], goExits: [go(9005)] },
  9005: { num: 9005, edgeExits: [], goExits: [] },
} };
eq([...roomsWithin(map, 9001, 0).keys()], [9001], 'radius 0 is the room itself');
eq([...roomsWithin(map, 9001, 1).keys()].sort(), [9001, 9002, 9003]);
eq(roomsWithin(map, 9001, 2).get(9004), 2, 'hop count is the distance, not a flag');
ok(!roomsWithin(map, 9001, 2).has(9005), 'and the radius really bounds it');
eq(roomsWithin(map, 9001, 3).get(9005), 3);
ok(roomsWithin(map, 9001, 2).get(9001) === 0, 'the origin is always distance zero');

// ------------------------------------------------------------------ wantsOf carries counts
//
// `wants` answers "may somebody sell this" and needs only a name. `needs` answers "how many
// should a courier buy" and a name cannot. Farm delivery reads the second; before it
// existed the loadout could ask for something and no courier could hear the quantity.
const loadout = { carry: [
  { item: 'herb', min: 20, max: null },
  { item: 'elderberry', min: 20, max: null },
  { item: 'mushroom', min: 40, max: 60 },
  { item: 'sapphire', min: 0, max: 2 },
] };
const pack = [{ name: 'herb', amount: 8 }, { name: 'mushroom', amount: 40 },
              { name: 'sapphire', amount: 9 }];
const w = wantsOf(loadout, pack);
eq(w.needs.get('herb'), 12, 'short by exactly the gap to the floor');
eq(w.needs.get('elderberry'), 20, 'nothing in the pack means the whole floor is short');
ok(!w.needs.has('mushroom'), 'a satisfied floor is not a need');
eq(w.spare.get('sapphire'), 7, 'and the surplus half still works');
ok(w.wants.includes('herb') && w.wants.includes('elderberry'), 'names still reported');
ok(wantsOf(null, pack) === null, 'no loadout still means no opinion');

interest.byAgent.clear();
console.log(`farm coordination: ${n} assertions passed`);
