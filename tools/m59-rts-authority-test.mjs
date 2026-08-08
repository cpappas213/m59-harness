#!/usr/bin/env node
// Offline RTS packet-authority regression. This imports only pure helpers and reads
// source text; it opens no broker, fleet, roster, gateway, or Meridian connection.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rtsCleanupAuthorityCheck, rtsJobReport,
         rtsPacketAuthorityCheck } from './m59-rts-safety.mjs';

const callbacks = (calls, { isCancelled = false } = {}) => ({
  endpoint: () => calls.push('endpoint'),
  keeper: () => calls.push('keeper'),
  room: () => calls.push('room'),
  owner: () => calls.push('owner'),
  cancelled: () => { calls.push('cancelled'); return isCancelled; },
  validate: (packet, detail) => calls.push(`validate:${packet}:${detail?.id ?? ''}`),
});

{
  const calls = [];
  const cancelled = rtsPacketAuthorityCheck({
    packet: 'attack', detail: { id: 900 }, ...callbacks(calls, { isCancelled: true }),
  });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner', 'cancelled'],
    'owned cancellation wins only after endpoint/keeper/room/owner and before action validation');
}

{
  const calls = [];
  const stopped = rtsPacketAuthorityCheck({
    packet: 'get', detail: { id: 901 }, ...callbacks(calls),
  });
  assert.equal(stopped, false);
  assert.deepEqual(calls,
    ['endpoint', 'keeper', 'room', 'owner', 'cancelled', 'validate:get:901'],
    'an authorized packet reaches its action-specific identity validator last');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.keeper = () => { calls.push('keeper'); throw new Error('keeper resumed'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'move', ...hooks }), /keeper resumed/);
  assert.deepEqual(calls, ['endpoint', 'keeper'],
    'a resumed keeper fails closed before room, owner, cancellation, or action checks');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.endpoint = () => { calls.push('endpoint'); throw new Error('endpoint changed'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'cast', ...hooks }), /endpoint changed/);
  assert.deepEqual(calls, ['endpoint'], 'a changed endpoint is the first fail-closed boundary');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.owner = () => { calls.push('owner'); throw new Error('token replaced'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'use', ...hooks }), /token replaced/);
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner'],
    'a replaced token owner blocks before cancellation or item validation');
}

{
  const calls = [];
  const hooks = callbacks(calls, { isCancelled: true });
  rtsCleanupAuthorityCheck({ packet: 'cleanup-stand', ...hooks });
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner'],
    'recovery cleanup ignores cancellation but retains every other authority boundary');
}

const baseJob = {
  label: 'fixture action', startedAt: 1000, finishedAt: 5000, done: true,
};
assert.deepEqual(rtsJobReport({ ...baseJob, cancelled: true, error: 'cleanup lost authority' }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'explicit cancellation outranks a cleanup error');
assert.deepEqual(rtsJobReport({ ...baseJob, cancelRequestedAt: 2000, result: { ok: true } }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'a completed attack that returned normally still reports its requested cancellation');
assert.deepEqual(rtsJobReport({ ...baseJob, result: { recovery: { cancelled: true } } }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'nested recovery cancellation is promoted to ACTION telemetry');
assert.deepEqual(rtsJobReport({ ...baseJob, error: 'ordinary failure' }, 5000),
  { last_action: 'fixture action', took_s: 4, failed: 'ordinary failure' });
assert.deepEqual(rtsJobReport({ ...baseJob, done: false, finishedAt: undefined,
  cancelled: true }, 5000),
  { busy: 'fixture action', running_for_s: 4, stopping: true });

const brokerPath = fileURLToPath(new URL('./m59-broker.mjs', import.meta.url));
const skillsPath = fileURLToPath(new URL('./m59-skills.mjs', import.meta.url));
const broker = readFileSync(brokerPath, 'utf8');
const skills = readFileSync(skillsPath, 'utf8');
const section = (start, end) => {
  const from = broker.indexOf(start);
  const to = broker.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section ${start} .. ${end} exists`);
  return broker.slice(from, to);
};

const step = section('async step(col, row,', '\n  // ------------------------------------------------------- fine movement');
assert.match(step, /pacer[.]submit[(]'turn'.*beforeMutation[(]'turn'.*c[.]face/s,
  'RTS movement can guard the turn packet inside its pacer callback');
assert.match(step, /pacer[.]submit[(]'move'.*beforeMutation[(]'move'.*c[.]moveToSquare/s,
  'RTS movement can guard the move packet inside its pacer callback');

const walk = section('async walkTo(col, row,', '\n  // Leave the room');
assert.match(walk, /beforeMutation = null/);
assert.ok((walk.match(/this[.]step[(][\s\S]*?beforeMutation/g) || []).length >= 3,
  'every walkTo step path threads the final-packet mutation hook');

const loot = section('async lootFloor({', '\n  // Offer one item to a merchant');
assert.match(loot, /this[.]walkTo[\s\S]*beforeMutation:/,
  'loot movement carries the selected item id into the packet hook');
assert.match(loot, /pacer[.]submit[(]'get'.*beforeMutation[(]'get'.*c[.]get/s,
  'loot revalidates exact item safety inside the get pacer callback');

const attack = section("name: 'attack',", "name: 'attack_intent',");
assert.match(attack, /faceToward\(o,[\s\S]*beforeRtsMutation\(a, packet\)/,
  'RTS attack turns use the same final authority hook');
assert.match(attack, /pacer[.]submit[(]'attack'.*beforeRtsMutation[(]a, 'attack'[)].*c[.]attack/s,
  'the final attack callback guards immediately before c.attack');

const attackIntent = section("name: 'attack_intent',", "name: 'move_intent',");
assert.match(attackIntent, /rtsPacketAuthority[(]\{/);
assert.match(attackIntent, /sameRtsIdentity.*OF[.]ATTACKABLE/s);
assert.match(attackIntent, /current[.]flags & OF[.]PLAYER/);
assert.match(attackIntent, /fraction > 0[.]35/,
  'multi-swing HP must still exceed 35% at the final callback');
assert.match(attackIntent, /\[RTS_MUTATION_GUARD\]: guard/);

const moveIntent = section("name: 'move_intent',", "name: 'context_intent',");
assert.match(moveIntent, /rtsPacketAuthority[(]\{/);
assert.match(moveIntent, /walkTo\(col, row,[\s\S]*beforeMutation/,
  'move intent threads authority into every walk packet');

const context = section("name: 'context_intent',", "name: 'cancel_action',");
for (const expected of [
  /rtsPacketAuthority[(]\{/,
  /sameRtsIdentity/,
  /OF[.]GETTABLE/,
  /CURSED_ITEMS[.]test/,
  /outside pickup range/,
  /brokenSet[(]c[)]/,
  /rtsSafeSpellRule/,
  /rtsSpellTargetAllowed/,
  /beforeCleanup/,
  /beforeMutation,/,
]) assert.match(context, expected);
assert.match(context, /lootFloor\([\s\S]*beforeMutation/,
  'context loot passes the packet guard into movement and get');

const cancel = section("name: 'cancel_action',", "name: 'shop',");
assert.match(cancel, /requireLocalControlEndpoint[(]s,/,
  'cancel still verifies the exact endpoint');
assert.doesNotMatch(cancel, /requireLocalControlSession|requireRtsKeeperInactive/,
  'owned cancellation remains available after a keeper resumes');
assert.match(cancel, /job[.]controlToken !== token/,
  'cancel retains exact token ownership');

assert.match(skills, /beforeMutation[(]'use', \{ item_id: cand[.]o[.]id/,
  'weapon helpers expose their chosen cached item to final validation');
assert.match(skills, /beforeMutation[(]'eat', \{ item_id: item[.]o[.]id/,
  'food helpers expose their chosen cached item to final validation');
assert.match(skills, /beforeCleanup[(]'cleanup-stand'[)]/,
  'recovery cleanup has its own authority hook inside the pacer callback');

console.log('m59 RTS final-packet authority and cancellation telemetry passed');
