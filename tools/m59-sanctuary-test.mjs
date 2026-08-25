#!/usr/bin/env node
// READY-TO-LEAVE-SANCTUARY MUST LET A CHARACTER ESCAPE A WRONG ROOM EVEN WHEN VITALS
// HAVE NOT COME BACK YET.
//
//   node tools/m59-sanctuary-test.mjs
//
// After a broker restart the connection takes several seconds to settle and the
// vitals read returns null for health/mana/vigor. Without this fix the keeper
// interprets null as "not whole" and parks the character inside whatever safe room
// it woke up in -- a recovery that never completes. JayB and Lee were stuck in
// room 1016 (Mausoleum) for that exact reason: assignedRoom 586, current 1016,
// vitals null, and the gate stayed closed.
//
// The fix is one line of judgement: when the character is in the wrong room by
// assignment, unknown vitals are not a reason to stay. They are a reason to leave.
// These are the cases that must not regress.

// Set M59_SPAWN_FILE BEFORE the autopilot is imported -- loadSpawns() caches the
// first read forever, so the file has to exist at the moment the import resolves.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-sanctuary-test-'));
const spawnFile = join(dir, 'spawns.json');
writeFileSync(spawnFile, JSON.stringify({ rooms: {
  1016: [],                              // Mausoleum -- no spawns, that is the point
  586:  [],                              // assigned room treated as a sanctuary for the
                                        // same reason (no spawns, but kept separate)
  999:  [{ creature: 'giant rat', huntable: true }],
                                        // a hunting ground, so this is NOT a sanctuary
}}));
process.env.M59_SPAWN_FILE = spawnFile;

const { Autopilot } = await import('./m59-autopilot.mjs');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' -- ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fake room
//
// sanctuary() reads s.world.room.num and the spawn table; vitals() reads c.vitals().
// armedForSure() reads c.equipment(). A weapon in the equipped list makes
// armedForSure() say yes without dragging in the broker.
function keeper({ assignedRoom, currentRoom, vitalsValue = null }) {
  const c = {
    selfId: 99,
    room: { id: currentRoom, objects: new Map() },
    rsc: { get: () => '' },
    vitals: () => vitalsValue,
    equipment: () => ({ known: true, equipped: [{ name: 'short sword' }] }),
    inventory: [],
  };
  const s = {
    name: 'test', live: true, client: c,
    world: { room: { num: currentRoom, name: 'Test Room' }, geometry: null },
  };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  ap.policy.assignedRoom = assignedRoom;
  return ap;
}

// ------------------------------------------------------------------ the cases

// 1. WRONG ROOM AND UNKNOWN VITALS: the broker restart case. Must allow leaving.
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 1016, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('back to work');
  ok('vitals null + wrong room -> allow leaving', r === true,
     `got ${JSON.stringify(r)}`);
}

// 2. NO ASSIGNMENT, UNKNOWN VITALS: still cautious. A character with nowhere to
//    be has no reason to walk out blind.
{
  const ap = keeper({ assignedRoom: null, currentRoom: 1016, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('anywhere');
  ok('vitals null + no assignment -> stay put', r === false,
     `got ${JSON.stringify(r)}`);
}

// 3. ALREADY IN THE ASSIGNED ROOM, UNKNOWN VITALS: still cautious. There is no
//    place to be that we are not already in, so unknown vitals rightly mean wait.
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 586, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('anywhere');
  ok('vitals null + already home -> stay put', r === false,
     `got ${JSON.stringify(r)}`);
}

// 4. SANITY CHECK: whole vitals + wrong room still allow leaving (pre-existing
//    behaviour must not have regressed).
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 1016,
    vitalsValue: { health: { value: 30, max: 30, pct: 1.0 },
                   mana:   { value: 30, max: 30, pct: 1.0 },
                   vigor:  { value: 200, scale_max: 200 } } });
  const r = await ap.readyToLeaveSanctuary('back to work');
  ok('vitals full + wrong room -> allow leaving', r === true,
     `got ${JSON.stringify(r)}`);
}

// 5. NOT IN A SANCTUARY: never gated by this check. A monster room is its own
//    problem and not one this function is allowed to make worse.
{
  const c = {
    selfId: 99, room: { id: 999, objects: new Map() }, rsc: { get: () => '' },
    vitals: () => null,
    equipment: () => ({ known: true, equipped: [{ name: 'short sword' }] }),
    inventory: [],
  };
  const s = { name: 'test', live: true, client: c,
    world: { room: { num: 999, name: 'hunting ground' }, geometry: null } };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  ap.policy.assignedRoom = 999;
  const r = await ap.readyToLeaveSanctuary('already outside');
  ok('not in sanctuary -> short-circuit true even with null vitals', r === true,
     `got ${JSON.stringify(r)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
