#!/usr/bin/env node
// Offline commander/commerce capability regression.  It imports pure stores and
// reads source text only: no broker, roster, gateway, fleet, or Meridian socket.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMANDER_FACULTIES,
  CommanderLeaseStore,
  CommerceQuoteStore,
  bindCommerceOfferEcho,
  canonicalCommerceItems,
  canonicalCommerceProvenance,
  commanderSettings,
  commerceItemsEqual,
  exactRtsRoomBinding,
  fleetIdentity,
  leaseTiming,
  quoteTiming,
  redactControlArgs,
  resolveCommerceInventoryOrigins,
  tradeFingerprint,
} from './m59-rts-command.mjs';

assert.equal(fleetIdentity(null), 'default');
assert.equal(fleetIdentity('-'), 'default');
assert.equal(fleetIdentity(' prod '), 'prod');
assert.deepEqual(commanderSettings({}, 'prod'), {
  schema: 'm59-rts-commander/v1', enabled: true, fleet: 'prod',
  authority: 'authenticated-enabled-loopback-gateway',
}, 'broker capability has no manually synchronized second-secret dead gate');
assert.deepEqual(COMMANDER_FACULTIES, ['work', 'movement', 'economy', 'social']);

assert.deepEqual(exactRtsRoomBinding({
  expectedRoomNum: 103, actualRoomNum: 103, roomObjectId: 673, packet: 'commerce',
}), { room_num: 103, room_object_id: 673 },
'stable room numbers and live room object ids occupy different namespaces');
assert.deepEqual(exactRtsRoomBinding({
  expectedRoomNum: 103, actualRoomNum: 103, roomObjectId: 673,
  expectedRoomObjectId: 673, packet: 'buy-list',
}), { room_num: 103, room_object_id: 673 },
'a paced packet retains the exact live room object captured at request entry');
assert.throws(() => exactRtsRoomBinding({
  expectedRoomNum: 103, actualRoomNum: 104, roomObjectId: 673, packet: 'commerce',
}), /session is in room 104, not 103/);
assert.throws(() => exactRtsRoomBinding({
  expectedRoomNum: 103, actualRoomNum: 103, roomObjectId: 674,
  expectedRoomObjectId: 673, packet: 'buy-list',
}), /live room object changed from 673 to 674/,
'a room transition after acceptance fails closed even if a stable room number were reused');
assert.throws(() => exactRtsRoomBinding({
  expectedRoomNum: 103, actualRoomNum: 103, roomObjectId: null, packet: 'commerce',
}), /live room object id is unavailable/);

let now = 1_000;
let tokenCounter = 0;
const leases = new CommanderLeaseStore({
  now: () => now,
  tokenFactory: () => `lease-token-${++tokenCounter}`,
  idFactory: () => `lease-id-${tokenCounter}`,
});
const lease = leases.issue({
  fleet: 'fixture', brokerPid: 77, server: { host: '127.0.0.1', port: 5959 },
  owner: 'fixture-owner', agents: [{ agent: 't1', character: 'Kermit' }],
}, 20_000);
assert.equal(lease.expiresAt, 21_000);
assert.equal(leases.require(lease.token), lease);
assert.equal(leases.activeForAgent('t1'), lease);
assert.throws(() => leases.issue({ agents: [{ agent: 't1', character: 'Kermit' }] }),
  /already held/, 'overlapping live leases are refused');
assert.deepEqual(leaseTiming(lease, now), {
  lease_id: lease.leaseId, expires_at_ms: 21_000, expires_in_ms: 20_000,
  heartbeat_after_ms: 6_666,
});
now = 18_000;
leases.renew(lease.token, 30_000);
assert.equal(lease.expiresAt, 48_000, 'heartbeat extends from now, bounded at 30 seconds');
now = 48_001;
assert.throws(() => leases.require(lease.token), /expired/);
assert.equal(leases.activeForAgent('t1'), null, 'expiry fails authority back closed immediately');
const replacement = leases.issue({
  fleet: 'fixture', brokerPid: 77, server: { host: '127.0.0.1', port: 5959 },
  owner: 'replacement', agents: [{ agent: 't1', character: 'Kermit' }],
}, 5_000);
leases.release(replacement.token);
assert.throws(() => leases.require(replacement.token), /released/);

now = 100_000;
tokenCounter = 0;
const quotes = new CommerceQuoteStore({
  now: () => now,
  tokenFactory: () => `quote-token-${++tokenCounter}`,
  idFactory: () => `quote-id-${tokenCounter}`,
  ttlMs: 15_000,
});
const issued = quotes.issue({ kind: 'buy', agent: 't1', total: 25 });
assert.deepEqual(quoteTiming(issued, now), {
  quote_id: issued.quoteId, quote_token: issued.token,
  created_at_ms: 100_000, expires_at_ms: 115_000, expires_in_ms: 15_000,
});
assert.throws(() => quotes.consume(issued.token, claims => {
  assert.equal(claims.kind, 'buy');
  throw new Error('actor mismatch');
}), /actor mismatch/);
assert.equal(quotes.require(issued.token), issued,
  'a malformed/mismatched commit does not burn a valid quote before validation');
quotes.consume(issued.token, claims => assert.equal(claims.total, 25));
assert.throws(() => quotes.consume(issued.token), /already used/,
  'a valid commit is single-use and replay protected');
const cancelled = quotes.issue({ kind: 'trade_cancel' });
quotes.cancel(cancelled.token);
assert.throws(() => quotes.require(cancelled.token), /cancelled/);
const expiring = quotes.issue({ kind: 'sell' });
now = expiring.expiresAt;
assert.throws(() => quotes.require(expiring.token), /expired/,
  'the exact expiry instant has no remaining authority');

assert.deepEqual(canonicalCommerceItems([
  { id: 9, name: 'Herb', quantity: 2 }, { id: 2, name: 'Shillings', amount: 5 },
]), [
  { id: 2, name: 'Shillings', quantity: 5 }, { id: 9, name: 'Herb', quantity: 2 },
]);
assert.ok(commerceItemsEqual(
  [{ id: 9, name: 'Herb', quantity: 2 }, { id: 2, name: 'Shillings', quantity: 5 }],
  [{ id: 2, name: 'Shillings', amount: 5 }, { id: 9, name: 'Herb', amount: 2 }]),
  'offer-set comparison is order independent but identity/quantity exact');
assert.equal(commerceItemsEqual(
  [{ id: 9, name: 'Herb', quantity: 2 }],
  [{ id: 9, name: 'Herb', quantity: 3 }]), false);
assert.throws(() => canonicalCommerceItems([
  { id: 9, name: 'Herb', quantity: 1 }, { id: 9, name: 'Herb', quantity: 1 },
]), /duplicate/, 'duplicate ids cannot make an ambiguous economic intent');
assert.throws(() => canonicalCommerceItems([{ id: 9, name: 'Herb', quantity: 0 }]),
  /positive/, 'zero/negative quantities never reach the wire');
assert.deepEqual(bindCommerceOfferEcho(
  [{ id: 7138, name: 'herb', quantity: 1 }],
  [{ id: 7139, name: 'herb', quantity: 1 }]),
[{ inventory_id: 7138, table_id: 7139, name: 'herb', quantity: 1 }],
'server-issued trade-table ids are bound to, but never confused with, original inventory ids');
assert.throws(() => bindCommerceOfferEcho(
  [{ id: 21, name: 'herb', quantity: 1 }],
  [{ id: 22, name: 'herb', quantity: 2 }]), /changed offered herb quantity/);
assert.throws(() => canonicalCommerceProvenance([
  { id: 21, name: 'herb', quantity: 1 },
  { id: 22, name: 'herb', quantity: 1 },
]), /same-name commerce stacks are ambiguous/,
  'two held ids with the same visible identity fail closed instead of guessing at cloned table provenance');
assert.deepEqual(resolveCommerceInventoryOrigins(
  [{ id: 7139, name: 'herb', quantity: 1 }],
  [{ inventory_id: 7138, table_id: 7139, name: 'herb', quantity: 1 }]),
[{ id: 7138, name: 'herb', quantity: 1 }],
'acceptance recovers original held ids while retaining the observed trade-table binding');
assert.throws(() => resolveCommerceInventoryOrigins(
  [{ id: 7140, name: 'herb', quantity: 1 }],
  [{ inventory_id: 7138, table_id: 7139, name: 'herb', quantity: 1 }]),
/no longer matches its exact inventory provenance/,
'a changed transient table id fails closed before acceptance');
assert.throws(() => resolveCommerceInventoryOrigins(
  [
    { id: 7139, name: 'herb', quantity: 1 },
    { id: 7140, name: 'herb', quantity: 1 },
  ], [
    { inventory_id: 7138, table_id: 7139, name: 'herb', quantity: 1 },
    { inventory_id: 7137, table_id: 7140, name: 'herb', quantity: 1 },
  ]), /same-name commerce stacks are ambiguous/,
'ambiguous same-name source stacks cannot acquire acceptance authority');

const trade = {
  revision: 4, role: 'offerer', counterparty: { id: 50, name: 'Fozzie' },
  ours: [{ id: 9, name: 'Herb', quantity: 2 }],
  theirs: [{ id: 2, name: 'Shillings', quantity: 10 }], may_accept: true,
};
const fingerprint = tradeFingerprint(trade);
assert.notEqual(fingerprint, tradeFingerprint({ ...trade, revision: 5 }));
assert.notEqual(fingerprint, tradeFingerprint({ ...trade, may_accept: false }));
assert.notEqual(fingerprint, tradeFingerprint({ ...trade,
  theirs: [{ id: 2, name: 'Shillings', quantity: 11 }] }));
assert.equal(fingerprint, tradeFingerprint({ ...trade,
  ours: [...trade.ours].reverse(), theirs: [...trade.theirs].reverse() }));

assert.deepEqual(redactControlArgs({ agent: 't1', command_auth: 'secret', lease_token: 'lease',
  quote_token: 'quote', control_token: 'control', room: 7 }), {
  agent: 't1', command_auth: '[redacted]', lease_token: '[redacted]',
  quote_token: '[redacted]', control_token: '[redacted]', room: 7,
});

const brokerPath = fileURLToPath(new URL('./m59-broker.mjs', import.meta.url));
const clientPath = fileURLToPath(new URL('./m59-client.mjs', import.meta.url));
const broker = readFileSync(brokerPath, 'utf8');
const client = readFileSync(clientPath, 'utf8');
const section = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section ${start} .. ${end} exists`);
  return source.slice(from, to);
};

assert.match(broker,
  /function requireRtsRoom[\s\S]*?exactRtsRoomBinding\(\{[\s\S]*?actualRoomNum: s[.]world[?][.]room[?][.]num[\s\S]*?roomObjectId: s[.]client[?][.]room[?][.]id/s,
  'broker room authority validates the stable room number and live object id in their own namespaces');
assert.doesNotMatch(broker,
  /const rooms = \[s[.]world[?][.]room[?][.]num, s[.]client[?][.]room[?][.]id\]/,
  'room authority never conflates stable room numbers with runtime room object ids');

const commander = section(broker, "name: 'commander_lease'", "name: 'attack_intent'");
assert.match(broker, /function commanderAuth\(a, caller\)[\s\S]*?requireRtsLocalCaller\(caller\)/,
  'lease acquisition is reachable only through a local broker caller');
assert.match(commander, /commanderAuth\(a, caller\)/);
assert.match(broker, /function commanderAuth[\s\S]*fleetIdentity\(a[.]fleet\).*COMMANDER_FLEET/s);
assert.match(broker, /function commanderAuth[\s\S]*Number\(a[.]broker_pid\) !== process[.]pid/s);
assert.match(commander, /exactRosterAuthority/);
assert.match(commander, /COMMANDER_FACULTIES/);
assert.match(commander, /claimFaculties/);
assert.match(commander, /heartbeatFaculties/);
assert.match(commander, /releaseFaculties/);
assert.doesNotMatch(commander, /command_auth|M59_RTS_COMMAND_/,
  'broker does not depend on a manually synchronized second secret');

for (const [start, end] of [
  ["name: 'attack_intent'", "name: 'move_intent'"],
  ["name: 'move_intent'", "name: 'context_intent'"],
  ["name: 'context_intent'", "name: 'cancel_action'"],
]) {
  const source = section(broker, start, end);
  assert.match(source, /lease_token/);
  assert.match(source, /requireControlSession\([^;]+a[.]lease_token\)/s);
  assert.match(source, /leaseToken: a[.]lease_token/);
}

const prepare = section(broker, "name: 'commerce_prepare'", "name: 'commerce_commit'");
assert.match(broker, /function commerceActorView[\s\S]*?room_object_id: actor[.]roomObjectId/s,
  'prepared commerce quotes capture the live room object id as well as the stable room number');
assert.match(prepare, /actor: commerceActorView\(actor\)/);
for (const kind of ['buy', 'sell', 'offer', 'trade_counter_empty', 'trade_accept', 'trade_cancel'])
  assert.match(prepare, new RegExp(`['\"]${kind}['\"]`));
assert.match(prepare, /commerceQuotes[.]issue/);
assert.match(prepare, /trade_fingerprint/);
assert.match(prepare, /expected_trade_revision/);
assert.match(prepare, /expected_ours/);
assert.match(prepare, /expected_theirs/);
assert.match(prepare, /sell-quote-cancel/,
  'sell prepare closes its temporary merchant offer before issuing a quote');
assert.match(prepare, /canonicalCommerceProvenance\(held\)/,
  'same-name source stacks fail closed before a sell or offer packet');
assert.match(prepare, /bindCommerceOfferEcho\(held, trade[.]ours\)/,
  'merchant quotes bind transient trade-table ids to original held ids');
assert.match(prepare, /resolveCommerceInventoryOrigins\(trade[.]ours, c[.]trade[?][.]inventoryBindings\)/,
  'trade acceptance quotes recover exact original inventory provenance');
assert.doesNotMatch(prepare, /commerceItemsEqual\(trade[.]ours, held\)/,
  'server-cloned table ids are not mistaken for held inventory ids');

const commit = section(broker, "name: 'commerce_commit'", "name: 'shop'");
assert.match(commit, /commerceQuotes[.]consume/);
assert.match(commit, /claims[.]lease_id !== actor[.]lease[.]leaseId/);
assert.match(commit, /claims[.]actor[.]room_object_id !== actor[.]roomObjectId/,
  'commit rejects a quote if the live room object changed after preparation');
assert.match(commit, /rtsPacketAuthority\(\{/);
assert.match(commit, /leaseToken: a[.]lease_token/);
assert.match(commit, /pacer[.]submit\('buy'.*beforeMutation\('buy-items'\)/s);
assert.match(commit, /pacer[.]submit\('trade'.*beforeMutation\('accept-offer'\)/s);
assert.match(commit, /state: 'awaiting_other_party'/);
assert.match(commit, /gained === wanted[.]quoted_quantity && spent === claims[.]price[.]total_price/,
  'purchase success requires exact item gain and purse spend evidence');
assert.match(commit, /itemFailures[\s\S]*received === claims[.]price[.]total_price/,
  'sale success requires exact item-id loss and purse receipt evidence');
assert.match(commit, /expectedTradeNameDeltas[\s\S]*nameFailures[\s\S]*outgoingFailures/,
  'trade accept verifies both offered sides against refreshed inventory');
assert.match(commit, /bindCommerceOfferEcho\(requested, trade[.]ours\)/,
  'offer commit records the server-observed table ids alongside original inventory ids');
assert.match(commit, /claims[.]outgoing_inventory_items[\s\S]*exactInventoryItems\(c, outgoingInventoryItems\)[\s\S]*claims[.]trade_fingerprint/s,
  'trade accept revalidates original held ids and the observed table revision at the final packet');
assert.match(commit, /c[.]trade[.]inventoryBindings = \[\]/,
  'an exact empty counter records explicit empty-side inventory provenance');
assert.doesNotMatch(commit, /commerceItemsEqual\(trade[.]ours, requested\)/,
  'commit does not compare transient table ids directly with inventory ids');
assert.match(commit, /ended[.]timedOut \|\| c[.]trade/,
  'trade cancellation is not reported committed until the cached table clears');
assert.match(commit, /verification_failed: true/g,
  'ambiguous server silence is represented as failed verification, not success');
const outgoingOfferBranch = section(commit, "if (claims.kind === 'offer')", "if (!reply.events.some(event => event.kind === 'countered')");
assert.doesNotMatch(outgoingOfferBranch, /acceptOffer\(/,
  'an outgoing player offer is never auto-accepted');

const cleanup = section(broker, 'async function cancelExactCommerceTrade', 'async function queryCommerceCatalog');
assert.match(cleanup, /const fingerprint = opened[.]fingerprint/);
assert.match(cleanup, /exact[.]fingerprint !== fingerprint[\s\S]*c[.]trade = null/s,
  'failed-prepare cleanup clears only the exact trade generation whose cancel packet was sent');

assert.match(broker, /args: recordedArgs/);
assert.doesNotMatch(broker, /rec[?][.]line\('call', \{ tool: name, args,/,
  'flight recorder never writes raw capability tokens');
assert.match(client, /tradeRevision/);
assert.match(client, /withId: this[.]trade[?][.]withId \?\? this[.]pendingOfferTo[?][.]id/,
  'outgoing trades retain exact counterparty identity for later fingerprints');

console.log('m59 RTS commander leases and two-phase commerce capabilities passed offline');
