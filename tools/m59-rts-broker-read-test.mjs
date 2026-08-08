#!/usr/bin/env node
// Starts an empty, no-resume broker on an ephemeral loopback port. It never opens a
// Meridian session or a roster, and the exact child process is stopped in finally.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rtsSafeSpellRule } from './m59-rts-safety.mjs';
import { standToAct } from './m59-skills.mjs';

assert.ok(rtsSafeSpellRule('create food', 0));
assert.ok(rtsSafeSpellRule('CREATE WEAPON', 0));
assert.ok(rtsSafeSpellRule('blink', 0));
assert.equal(rtsSafeSpellRule('earthquake', 0), null,
  'zero-target Earthquake is not safe merely because it has no explicit target');
assert.equal(rtsSafeSpellRule('resist magic', 1), null,
  'target spells remain fail-closed until separately audited');
assert.equal(rtsSafeSpellRule('create weapon', 1), null,
  'an allowlisted name with a changed wire arity fails closed');

let standPackets = 0;
await assert.rejects(() => standToAct({
  need: () => ({ stand: () => { standPackets++; } }),
  pacer: { submit: async (_kind, send) => send() },
}, {
  beforePacket: packet => {
    assert.equal(packet, 'stand');
    throw new Error('fixture cancelled inside pacer');
  },
}), /cancelled inside pacer/);
assert.equal(standPackets, 0,
  'the cancellation callback runs inside the pacer immediately before c.stand()');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`empty broker exited with ${child.exitCode}`);
    try {
      const response = await fetch(new URL('/health', url));
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('empty broker did not become healthy');
}

const port = await freePort();
const url = new URL(`http://127.0.0.1:${port}`);
const broker = fileURLToPath(new URL('./m59-broker.mjs', import.meta.url));
const child = spawn(process.execPath,
  [broker, '--http', String(port), '--no-resume', '--fleet', 'rts-fastpath-empty-fixture'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, M59_RTS_READ_TOKEN: 'fixture-read-token' },
  });
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });

try {
  const health = await waitForHealth(url, child);
  assert.equal(health.fleet, 'rts-fastpath-empty-fixture');
  assert.deepEqual(health.sessions, []);
  assert.equal(health.game_server, null);
  assert.deepEqual(health.session_game_servers, {});

  const listed = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(listed.status, 200);
  const tools = (await listed.json()).result.tools;
  const attackIntent = tools.find(tool => tool.name === 'attack_intent');
  const moveIntent = tools.find(tool => tool.name === 'move_intent');
  const contextIntent = tools.find(tool => tool.name === 'context_intent');
  const cancelAction = tools.find(tool => tool.name === 'cancel_action');
  assert.deepEqual(attackIntent.inputSchema.required,
    ['agent', 'room', 'target', 'control_token', 'server_host', 'server_port']);
  assert.deepEqual(moveIntent.inputSchema.required,
    ['agent', 'room', 'col', 'row', 'control_token', 'server_host', 'server_port']);
  assert.deepEqual(contextIntent.inputSchema.required,
    ['agent', 'room', 'action', 'control_token', 'server_host', 'server_port']);
  assert.deepEqual(contextIntent.inputSchema.properties.action.enum,
    ['stand', 'rest_here', 'recover_here', 'grab_nearby', 'take', 'cast',
      'approach', 'face', 'equip_best', 'wear_best', 'eat_best', 'prepare',
      'item_use', 'item_unuse', 'item_eat', 'safety_on']);
  assert.deepEqual(cancelAction.inputSchema.required,
    ['agent', 'control_token', 'server_host', 'server_port']);
  assert.match(cancelAction.description, /inside the pacer immediately before each mutating packet/,
    'cancel contract states the final pre-packet recheck boundary');

  const source = readFileSync(broker, 'utf8');
  const aggregateStart = source.indexOf('async function brokerRtsRead(url)');
  const aggregateEnd = source.indexOf('\nfunction serveHttp(port)', aggregateStart);
  assert.ok(aggregateStart >= 0 && aggregateEnd > aggregateStart,
    'broker aggregate implementation is present');
  const aggregateSource = source.slice(aggregateStart, aggregateEnd);
  assert.match(aggregateSource, /Array[.]isArray[(]c[.]spells[)]/,
    'aggregate spell rows come from the protocol client cache');
  assert.match(aggregateSource, /Array[.]isArray[(]c[.]inventory[)]/,
    'aggregate inventory rows come from the protocol client cache');
  assert.match(aggregateSource, /slice[(]0, RTS_READ_MAX_INVENTORY_ITEMS[)]/,
    'aggregate inventory rows have a fixed per-agent bound');
  assert.match(aggregateSource, /skills[.]larderOf[(]c[)]/,
    'aggregate inventory food roles use the existing cached classification helper');
  assert.match(aggregateSource, /skills[.]weaponScore[(]name[)]/,
    'aggregate inventory weapon roles use the existing classification helper');
  assert.match(aggregateSource, /skills[.]armourKind[(]name[)]/,
    'aggregate inventory armor roles use the existing classification helper');
  assert.match(aggregateSource, /skills[.]brokenSet[(]c[)]/,
    'known broken gear is withheld from the safe use affordance');
  assert.match(aggregateSource, /CURSED_ITEMS[.]test[(]name[)]/,
    'known cursed gear is withheld from the safe use affordance');
  assert.match(aggregateSource, /school:\s*Number[.]isInteger[(]spell[.]school[)]\s*[?]\s*spell[.]school \+ 1/,
    'aggregate spell rows convert the zero-based wire school to Meridian one-based numbering');
  assert.doesNotMatch(aggregateSource, /requestSpells|requestInventory|pacer[.]submit/,
    'aggregate spell and inventory rows never issue Meridian requests');
  assert.match(aggregateSource, /filter[(]spell => rtsSafeSpellRule[(]spell[.]name, spell[.]targets[)][)]/,
    'broker aggregate exposes only spells admitted by the shared fail-closed policy');
  const contextStart = source.indexOf("name: 'context_intent'");
  const contextEnd = source.indexOf("name: 'cancel_action'", contextStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart,
    'typed context intent implementation is present');
  const contextSource = source.slice(contextStart, contextEnd);
  assert.match(contextSource, /stayPut: action === 'grab_nearby'/,
    'group grab never walks away from the selected square');
  assert.match(contextSource, /explicitIdsOverride: action !== 'grab_nearby'/,
    'gateway-derived grab ids retain broker unsafe-item screening');
  assert.match(contextSource, /outside pickup range/,
    'broker independently enforces the seven-square grab radius');
  assert.match(contextSource, /rtsSafeSpellRule[(]known[.]name, count[)]/,
    'broker repeats the shared safe-spell check at the final action boundary');
  assert.match(contextSource, /not classified as safe for RTS casting/,
    'broker explicitly refuses Earthquake and every other unclassified spell');
  assert.match(contextSource, /expected_item_name/,
    'exact inventory actions recheck the gateway-observed item identity');
  assert.match(contextSource, /weaponScore\(inventoryName\).*armourKind\(inventoryName\)/s,
    'exact item use is restricted to classified gear');
  assert.match(contextSource, /brokenSet\(c\).*CURSED_ITEMS[.]test\(inventoryName\)/s,
    'broker independently refuses known broken or cursed exact item use');
  assert.match(contextSource, /larderOf\(c\).*item_eat refused/s,
    'exact item eating is restricted to known food');
  assert.match(contextSource, /c[.]safety[(]true[)]/,
    'RTS exposes only the protective safety-on direction');
  assert.match(contextSource, /\[RTS_MUTATION_GUARD\]: guard/g,
    'context jobs pass their full live authority guard into mutating tool paths');
  assert.match(contextSource, /beforeMutation, beforeCleanup, shouldCancel: cancelled/,
    'owned recovery has distinct ordinary and cleanup packet authority hooks');

  const attackIntentStart = source.indexOf("name: 'attack_intent'");
  const attackIntentEnd = source.indexOf("name: 'move_intent'", attackIntentStart);
  const attackIntentSource = source.slice(attackIntentStart, attackIntentEnd);
  assert.match(attackIntentSource, /swings > 1 \? \{ stop_below: 0[.]35 \}/,
    'multi-swing RTS attacks carry a fixed 35% health disengage floor');
  assert.match(attackIntentSource, /fraction > 0[.]35/,
    'multi-swing health is rechecked from the final pacer callback');
  assert.match(attackIntentSource, /sameRtsIdentity.*OF[.]ATTACKABLE/s,
    'the final attack callback rechecks exact target identity and attackability');
  assert.match(attackIntentSource, /current[.]flags & OF[.]PLAYER/,
    'the final attack callback repeats the broker PvE-only rule');

  const cancelSource = source.slice(contextEnd,
    source.indexOf("name: 'shop'", contextEnd));
  assert.match(cancelSource, /requireControlEndpoint[(]s,/,
    'owned cancellation retains exact endpoint verification');
  assert.match(cancelSource, /requireRtsLocalCaller[(]caller[)]/,
    'owned cancellation still requires a caller on this machine');
  assert.doesNotMatch(cancelSource, /requireControlSession|requireRtsKeeperInactive/,
    'owned cancellation remains available after a keeper resumes');

  const castStart = source.indexOf("name: 'cast'");
  const castEnd = source.indexOf("name: 'merchants'", castStart);
  assert.ok(castStart >= 0 && castEnd > castStart, 'cast implementation is present');
  const castSource = source.slice(castStart, castEnd);
  assert.match(castSource, /standToAct[(]s, [{] beforePacket: beforeMutation [}][)]/,
    'RTS cancellation reaches the stand packet used by cast');
  assert.match(castSource,
    /pacer[.]submit[(]'cast', [(][)] => [{]\s*beforeRtsMutation[(]a, 'cast'[)]/,
    'cast cancellation is rechecked from inside the pacer immediately before c.cast()');

  const refused = await fetch(new URL('/rts/v1/read', url));
  assert.equal(refused.status, 401);
  assert.match((await refused.json()).error, /token required/);

  const headers = { authorization: 'Bearer fixture-read-token' };
  const malformed = await fetch(new URL('/rts/v1/read?agent=not%21valid', url), { headers });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /simple identifiers/);

  const empty = await fetch(new URL('/rts/v1/read', url), { headers });
  assert.equal(empty.status, 404);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.schema, 'm59-broker-rts-read/v1');
  assert.match(emptyBody.error, /no requested agents/);

  console.log('m59 broker RTS read/control/context schemas passed, empty/no-resume');
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`empty broker child did not exit:\n${stderr}`);
}
