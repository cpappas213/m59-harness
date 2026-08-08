#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  BrokerReader,
  OrderDedupe,
  RealtimeHub,
  createGatewayServer,
  dispatchAttackOrder,
  dispatchCancelOrder,
  dispatchContextOrder,
  dispatchMoveOrder,
  parseControlServer,
} from './m59-rts-gateway.mjs';

const now = 1786083600000;
const generation = `${now - 100}-1234`;
const endpoint = { host: '127.0.0.1', port: 5959 };
const look = (attack = true, player = false) => ({
  room: { num: 200, name: 'Marion', size: { rows: 4, cols: 4 } },
  you: { object_id: 501, col: 1, row: 1 },
  objects: [{ id: 900, name: player ? 'Opponent' : 'rat', is_player: player,
    col: 2, row: 1, can: attack ? ['attack'] : ['look'] }],
  exits: [],
});
const state = (looks = { t1: look(), t2: look() }) => ({
  schema: 'm59-broker-rts-read/v1', read_only: true,
  sequence: `${now}-1234`, observed_at: new Date(now).toISOString(),
  health: { pid: 1234, fleet: 'local-control-test', game_server: endpoint,
    sessions: Object.keys(looks),
    session_game_servers: Object.fromEntries(Object.keys(looks).map(agent => [agent, endpoint])) },
  agents: Object.keys(looks), looks, equipment: {},
  inventory: Object.fromEntries(Object.keys(looks).map(agent => [agent, [
    { id: 4573, name: 'mace', amount: 1, equipped: false,
      role: 'weapon', safe_actions: ['use'] },
    { id: 4575, name: 'leather armor', amount: 1, equipped: true,
      role: 'armor', safe_actions: ['unuse'] },
    { id: 4576, name: 'inky cap mushroom', amount: 2, equipped: false,
      role: 'food', safe_actions: ['eat'] },
    { id: 4574, name: 'shilling', amount: 500, equipped: false,
      role: 'other', safe_actions: [] },
  ]])),
  spells: Object.fromEntries(Object.keys(looks).map(agent => [agent, [
    { id: 801, name: 'create weapon', targets: 0, school: 0 },
    { id: 802, name: 'blink', targets: 0, school: 6 },
    { id: 803, name: 'earthquake', targets: 0, school: 4 },
    { id: 804, name: 'resist magic', targets: 1, school: 2 },
  ]])),
  fleet: { fleet: [] },
});

const calls = [];
let fixtureTokenCounter = 0;
const fixtureControlToken = () => `fixture.${String(++fixtureTokenCounter).padStart(8, '0')}`;
const withoutControlToken = args => {
  const { control_token: token, ...rest } = args;
  assert.match(token, /^fixture[.]\d{8}$/);
  return { token, rest };
};
const reader = {
  ordersEnabled: true,
  controlServer: endpoint,
  issueControlToken: fixtureControlToken,
  controlState: async () => state(),
  order: async (name, args) => {
    calls.push({ name, args, at: performance.now() });
    return { accepted: true, control_token: args.control_token };
  },
};

const accepted = await dispatchAttackOrder(reader, {
  type: 'attack', generation, order_id: 'group-attack-1',
  orders: [
    { agent: 't1', room: 200, target_id: 900 },
    { agent: 't2', room: 200, target_id: 900, swings: 3 },
  ],
}, { now });
assert.equal(accepted.accepted, true);
assert.equal(accepted.accepted_count, 2);
assert.equal(calls.length, 2);
assert.ok(Math.max(...calls.map(call => call.at)) - Math.min(...calls.map(call => call.at)) < 10,
  'independent sessions should dispatch in the same event-loop turn');
assert.deepEqual(calls.map(call => call.name), ['attack_intent', 'attack_intent']);
assert.equal(new Set(calls.map(call => call.args.control_token)).size, 2,
  'each admitted actor receives a distinct opaque ownership token');
for (const call of calls) assert.match(call.args.control_token, /^fixture[.]\d{8}$/);

await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation, order_id: 'typed-attack-01',
  orders: [{ agent: 't1', room: '200', target_id: 900 }],
}, { now }), /numeric positive integer room/);
await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation, order_id: 'typed-attack-02',
  orders: [{ agent: 't1', room: 200, target_id: true }],
}, { now }), /numeric positive integer room/);
await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation, order_id: 'typed-attack-03', debug: true,
  orders: [{ agent: 't1', room: 200, target_id: 900 }],
}, { now }), /attack request contains unsupported field: debug/);
await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation, order_id: 'typed-attack-04',
  orders: [{ agent: 't1', room: 200, target_id: 900, arbitrary: 1 }],
}, { now }), /attack order contains unsupported field: arbitrary/);
await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation: [generation], order_id: 'typed-attack-05',
  orders: [{ agent: 't1', room: 200, target_id: 900 }],
}, { now }), /missing or malformed snapshot generation/);

await assert.rejects(() => dispatchAttackOrder(reader, {
  type: 'attack', generation: `${now - 3000}-1234`, order_id: 'stale-attack-1',
  orders: [{ agent: 't1', room: 200, target_id: 900 }],
}, { now }), /stale/);

const actorSpecific = { ...reader, controlState: async () => state({ t1: look(), t2: look(false) }) };
await assert.rejects(() => dispatchAttackOrder(actorSpecific, {
  type: 'attack', generation, order_id: 'actor-specific-1',
  orders: [{ agent: 't1', room: 200, target_id: 900 },
    { agent: 't2', room: 200, target_id: 900 }],
}, { now }), /t2 no longer perceives/);
assert.equal(calls.length, 2, 'a rejected actor-specific batch dispatches nothing');

const playerReader = { ...reader, controlState: async () => state({ t1: look(true, true) }) };
await assert.rejects(() => dispatchAttackOrder(playerReader, {
  type: 'attack', generation, order_id: 'player-target-1',
  orders: [{ agent: 't1', room: 200, target_id: 900 }],
}, { now }), /PvE-only/);

const partialReader = { ...reader, order: async (name, args) => {
  if (args.agent === 't2') throw new Error('target moved during broker recheck');
  return { accepted: true, control_token: args.control_token };
} };
const partial = await dispatchAttackOrder(partialReader, {
  type: 'attack', generation, order_id: 'partial-attack-1',
  orders: [{ agent: 't1', room: 200, target_id: 900 },
    { agent: 't2', room: 200, target_id: 900 }],
}, { now });
assert.equal(partial.accepted, false);
assert.equal(partial.accepted_count, 1);
assert.equal(partial.rejected_count, 1);
assert.match(partial.outcomes[1].error, /target moved/);

const floor = Buffer.from([1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
const sceneStore = { get: () => ({ rows: 4, cols: 4, planes: { flags: floor.toString('base64') } }) };
const beforeMove = calls.length;
const moved = await dispatchMoveOrder(reader, {
  type: 'move', generation, order_id: 'group-move-001',
  orders: [{ agent: 't1', room: 200, col: 3, row: 2, max_steps: 80 }],
}, { now, sceneStore });
assert.equal(moved.accepted, true);
assert.equal(calls[beforeMove].name, 'move_intent');
const movedArgs = withoutControlToken(calls[beforeMove].args);
const moveControlToken = movedArgs.token;
assert.deepEqual(movedArgs.rest,
  { agent: 't1', room: 200, col: 3, row: 2, max_steps: 80,
    server_host: '127.0.0.1', server_port: 5959 });
await assert.rejects(() => dispatchMoveOrder(reader, {
  type: 'move', generation, order_id: 'typed-move-001',
  orders: [{ agent: 't1', room: 200, col: '3', row: 2 }],
}, { now, sceneStore }), /numeric integer room[/]col[/]row/);
await assert.rejects(() => dispatchMoveOrder(reader, {
  type: 'move', generation, order_id: 'blocked-move-1',
  orders: [{ agent: 't1', room: 200, col: 2, row: 2 }],
}, { now, sceneStore }), /not on the walkable/);

const floorItems = Array.from({ length: 14 }, (_, index) => ({
  id: 1001 + index, name: `loot ${index + 1}`, is_player: false,
  distance: 14 - index, can: ['get'],
}));
const contextLook = {
  ...look(),
  objects: [
    ...look().objects,
    ...floorItems,
    { id: 1100, name: 'statue', is_player: false, distance: 1, can: ['look'] },
    { id: 1101, name: 'far loot', is_player: false, col: 9, row: 9,
      distance: 1, can: ['get'] },
    { id: 1200, name: 'Local player', is_player: true, distance: 2, can: ['look'] },
  ],
};
const contextState = state({ t1: contextLook });
const contextReader = { ...reader, controlState: async () => contextState };

let beforeContext = calls.length;
const stood = await dispatchContextOrder(contextReader, {
  type: 'context', action: 'stand', generation, order_id: 'context-stand-001',
  orders: [{ agent: 't1', room: 200 }],
}, { now, sceneStore });
assert.equal(stood.accepted, true);
assert.deepEqual(calls[beforeContext].name, 'context_intent');
assert.deepEqual(withoutControlToken(calls[beforeContext].args).rest, {
  agent: 't1', room: 200, action: 'stand',
  server_host: '127.0.0.1', server_port: 5959,
});

beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'rest_here', generation, order_id: 'context-rest-001',
  orders: [{ agent: 't1', room: 200, col: 3, row: 2 }],
}, { now, sceneStore });
assert.deepEqual(withoutControlToken(calls[beforeContext].args).rest, {
  agent: 't1', room: 200, action: 'rest_here', col: 3, row: 2,
  server_host: '127.0.0.1', server_port: 5959,
});
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'rest_here', generation, order_id: 'context-rest-bad',
  orders: [{ agent: 't1', room: 200, col: 2, row: 2 }],
}, { now, sceneStore }), /not on the walkable/);

beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'recover_here', generation, order_id: 'context-recover1',
  orders: [{ agent: 't1', room: 200, col: 3, row: 2 }],
}, { now, sceneStore });
assert.deepEqual(withoutControlToken(calls[beforeContext].args).rest, {
  agent: 't1', room: 200, action: 'recover_here', col: 3, row: 2,
  server_host: '127.0.0.1', server_port: 5959,
});

for (const action of ['approach', 'face']) {
  beforeContext = calls.length;
  await dispatchContextOrder(contextReader, {
    type: 'context', action, generation, order_id: `context-${action}-001`,
    orders: [{ agent: 't1', room: 200, target_id: 900 }],
  }, { now, sceneStore });
  assert.equal(calls[beforeContext].args.target, 900);
  assert.equal(calls[beforeContext].args.action, action);
}
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'face', generation, order_id: 'context-face-gone',
  orders: [{ agent: 't1', room: 200, target_id: 99999 }],
}, { now, sceneStore }), /no longer perceives positioned target/);

for (const action of ['equip_best', 'wear_best', 'eat_best', 'prepare', 'safety_on']) {
  beforeContext = calls.length;
  await dispatchContextOrder(contextReader, {
    type: 'context', action, generation, order_id: `context-${action}-001`,
    orders: [{ agent: 't1', room: 200 }],
  }, { now, sceneStore });
  assert.equal(calls[beforeContext].args.action, action);
}

for (const [action, itemId, name] of [
  ['item_use', 4573, 'mace'],
  ['item_unuse', 4575, 'leather armor'],
  ['item_eat', 4576, 'inky cap mushroom'],
]) {
  beforeContext = calls.length;
  await dispatchContextOrder(contextReader, {
    type: 'context', action, generation, order_id: `context-${action}-001`,
    orders: [{ agent: 't1', room: 200, item_id: itemId }],
  }, { now, sceneStore });
  assert.equal(calls[beforeContext].args.item, itemId);
  assert.equal(calls[beforeContext].args.expected_item_name, name);
}
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'item_use', generation, order_id: 'context-item-bad1',
  orders: [{ agent: 't1', room: 200, item_id: 4574 }],
}, { now, sceneStore }), /not currently classified for safe use/);
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'stand', generation, order_id: 'context-extra-001',
  orders: [{ agent: 't1', room: 200, item_id: 4573 }],
}, { now, sceneStore }), /unsupported field: item_id/);

await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'grab_nearby', generation, order_id: 'context-grab-001',
  orders: [{ agent: 't1', room: 200, target_ids: [1100] }],
}, { now, sceneStore }), /unsupported field: target_ids/);
beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'grab_nearby', generation, order_id: 'context-grab-002',
  orders: [{ agent: 't1', room: 200 }],
}, { now, sceneStore });
assert.equal(calls[beforeContext].name, 'context_intent');
assert.deepEqual(calls[beforeContext].args.targets,
  floorItems.slice().sort((a, b) => a.distance - b.distance).slice(0, 12).map(item => item.id));
assert.equal(calls[beforeContext].args.targets.includes(1100), false);
assert.equal(calls[beforeContext].args.targets.includes(1101), false,
  'grab_nearby excludes known positions outside Meridian pickup range');

const sharedLootT1 = {
  ...look(),
  objects: [
    { id: 1301, name: 'near t1', is_player: false, distance: 1, can: ['get'] },
    { id: 1302, name: 'near t2', is_player: false, distance: 3, can: ['get'] },
  ],
};
const sharedLootT2 = {
  ...look(),
  objects: [
    { id: 1301, name: 'near t1', is_player: false, distance: 4, can: ['get'] },
    { id: 1302, name: 'near t2', is_player: false, distance: 1, can: ['get'] },
  ],
};
const groupGrabReader = { ...reader,
  controlState: async () => state({ t1: sharedLootT1, t2: sharedLootT2 }) };
beforeContext = calls.length;
await dispatchContextOrder(groupGrabReader, {
  type: 'context', action: 'grab_nearby', generation, order_id: 'context-grab-team',
  orders: [{ agent: 't1', room: 200 }, { agent: 't2', room: 200 }],
}, { now, sceneStore });
const groupGrabCalls = calls.slice(beforeContext);
assert.equal(groupGrabCalls.length, 2);
assert.deepEqual(groupGrabCalls.map(call => call.args.targets), [[1301], [1302]],
  'a group grab assigns each item once to the nearest eligible actor');
assert.equal(new Set(groupGrabCalls.flatMap(call => call.args.targets)).size, 2,
  'a group grab never races two actors for one item id');

const oneItemGrabReader = { ...reader, controlState: async () => state({
  t1: { ...look(), objects: [
    { id: 1401, name: 'one prize', is_player: false, distance: 1, can: ['get'] },
  ] },
  t2: { ...look(), objects: [
    { id: 1401, name: 'one prize', is_player: false, distance: 2, can: ['get'] },
  ] },
}) };
beforeContext = calls.length;
const oneItemGrab = await dispatchContextOrder(oneItemGrabReader, {
  type: 'context', action: 'grab_nearby', generation, order_id: 'context-grab-one1',
  orders: [{ agent: 't1', room: 200 }, { agent: 't2', room: 200 }],
}, { now, sceneStore });
const oneItemCalls = calls.slice(beforeContext);
assert.equal(oneItemCalls.length, 1, 'an actor with an empty grab assignment is not dispatched');
assert.equal(oneItemCalls[0].args.agent, 't1');
assert.deepEqual(oneItemCalls[0].args.targets, [1401]);
assert.equal(oneItemGrab.skipped_count, 1);
assert.deepEqual(oneItemGrab.skipped.map(row => row.agent), ['t2']);

beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'take', generation, order_id: 'context-take-001',
  orders: [{ agent: 't1', room: 200, target_id: 1001 }],
}, { now, sceneStore });
assert.equal(calls[beforeContext].args.target, 1001);
const beforeRejectedTake = calls.length;
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'take', generation, order_id: 'context-take-bad',
  orders: [{ agent: 't1', room: 200, target_id: 1100 }],
}, { now, sceneStore }), /no longer perceives.*gettable/);
assert.equal(calls.length, beforeRejectedTake, 'a stale take dispatches nothing');

beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-self',
  orders: [{ agent: 't1', room: 200, spell: 'CREATE WEAPON' }],
}, { now, sceneStore });
assert.equal(calls[beforeContext].args.spell, 'create weapon',
  'the broker receives the exact server-observed spell label');
assert.equal(Object.hasOwn(calls[beforeContext].args, 'target'), false);

beforeContext = calls.length;
await dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-blink',
  orders: [{ agent: 't1', room: 200, spell: 'BLINK' }],
}, { now, sceneStore });
assert.equal(calls[beforeContext].args.spell, 'blink');
assert.equal(Object.hasOwn(calls[beforeContext].args, 'target'), false);
const beforeUnsafeCast = calls.length;
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-quake',
  orders: [{ agent: 't1', room: 200, spell: 'earthquake' }],
}, { now, sceneStore }), /not classified as safe/);
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-target',
  orders: [{ agent: 't1', room: 200, spell: 'resist magic', target_id: 501 }],
}, { now, sceneStore }), /not classified as safe/);
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-arity',
  orders: [{ agent: 't1', room: 200, spell: 'create weapon', target_id: 900 }],
}, { now, sceneStore }), /accepts no target/);
assert.equal(calls.length, beforeUnsafeCast,
  'unsafe, unaudited, and arity-invalid spells dispatch nothing');
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'cast', generation, order_id: 'context-cast-unkn',
  orders: [{ agent: 't1', room: 200, spell: 'not a spell' }],
}, { now, sceneStore }), /does not currently know the exact spell/);
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'arbitrary_tool', generation, order_id: 'context-tool-bad1',
  orders: [{ agent: 't1', room: 200 }],
}, { now, sceneStore }), /context action must be/);
await assert.rejects(() => dispatchContextOrder(contextReader, {
  type: 'context', action: 'stand', generation: `${now - 3000}-1234`,
  order_id: 'context-stale-001', orders: [{ agent: 't1', room: 200 }],
}, { now, sceneStore }), /stale/);

const cancelled = await dispatchCancelOrder(reader, {
  type: 'cancel', order_id: 'cancel-action-1',
  orders: [{ agent: 't1', control_token: moveControlToken }],
}, { now });
assert.equal(cancelled.accepted, true);
assert.equal(calls.at(-1).name, 'cancel_action');
assert.equal(calls.at(-1).args.control_token, moveControlToken);
await assert.rejects(() => dispatchCancelOrder(reader, {
  type: 'cancel', order_id: 'cancel-action-2', generation,
  orders: [{ agent: 't1', control_token: moveControlToken }],
}, { now }), /cancel request contains unsupported field: generation/);
await assert.rejects(() => dispatchCancelOrder(reader, {
  type: 'cancel', order_id: 'cancel-action-3',
  orders: [{ agent: 't1', control_token: moveControlToken, force: true }],
}, { now }), /cancel order contains unsupported field: force/);

assert.deepEqual(parseControlServer('127.0.0.1:5959'), endpoint);
// A remote game server is an ordinary control target. What the endpoint has to be is
// NAMED and exact, not local: locality is asserted about the caller, at the broker,
// and every write still compares this value against the session's own credentials.
assert.deepEqual(parseControlServer('76.214.42.186:5959'), { host: '76.214.42.186', port: 5959 });
assert.throws(() => parseControlServer('76.214.42.186'), /explicit host:port/);
assert.throws(() => parseControlServer('76.214.42.186:0'), /exact game endpoint/);
// The fleet must still be named — a gateway that inherited a default would arm writes
// against whichever roster the broker happened to hold — but any name is allowed.
assert.throws(() => new BrokerReader({ expectedFleet: '', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'] }), /explicit --fleet/);
assert.ok(new BrokerReader({ expectedFleet: 'prod', ordersEnabled: true,
  controlServer: '76.214.42.186:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'] }), 'a named production fleet on its own server was refused arming');
assert.throws(() => new BrokerReader({ expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', allowedAgents: ['t1'] }), /CONTROL_TOKEN/);
assert.throws(() => new BrokerReader({ expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef' }), /non-empty --agents/);
const jsonResponse = value => ({ ok: true, status: 200, json: async () => value });
const gatedReader = new BrokerReader({
  expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'],
  fetchImpl: async () => jsonResponse(state({ t1: look() })),
});
assert.equal((await gatedReader.controlState(['t1'])).health.game_server.port, 5959);
await gatedReader.assertControlReady();
assert.equal(gatedReader.controlStatus.armed, true,
  'arming succeeds only after an aggregate control-state probe');
const rosterBoundReader = new BrokerReader({
  expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'],
  fetchImpl: async () => jsonResponse(state({ t1: look(), t6: look() })),
});
await assert.rejects(() => rosterBoundReader.controlState(['t6']),
  /outside this gateway's configured RTS control roster/);
const firstIssuedToken = gatedReader.issueControlToken('same-order-001', 't1');
assert.notEqual(gatedReader.issueControlToken('same-order-001', 't1'), firstIssuedToken,
  'reusing an order id for a newly admitted command does not reuse ownership');
assert.notEqual(rosterBoundReader.issueControlToken('same-order-001', 't1'), firstIssuedToken,
  'separate gateway instances have independently random ownership namespaces');
const wrongEndpointReader = new BrokerReader({
  expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'],
  fetchImpl: async () => jsonResponse({ ...state({ t1: look() }), health: {
    ...state({ t1: look() }).health,
    game_server: { host: '127.0.0.1', port: 5960 },
    session_game_servers: { t1: { host: '127.0.0.1', port: 5960 } },
  } }),
});
await assert.rejects(() => wrongEndpointReader.controlState(['t1']), /not wholly attached/);
assert.equal(wrongEndpointReader.controlStatus.armed, false,
  'a failed aggregate control-state validation clears write readiness');
const keeperState = { ...state({ t1: look() }), fleet: { fleet: [
  { agent: 't1', autopilot: { running: true }, activity: 'hunting: rat' },
] } };
const activeKeeperReader = new BrokerReader({
  expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'],
  fetchImpl: async () => jsonResponse(keeperState),
});
await assert.rejects(() => activeKeeperReader.controlState(['t1']), /active keeper/);
assert.equal(activeKeeperReader.controlStatus.armed, false,
  'an active keeper clears write readiness');
const noAggregateReader = new BrokerReader({
  expectedFleet: 'local-control-test', ordersEnabled: true,
  controlServer: '127.0.0.1:5959', controlToken: '0123456789abcdef',
  allowedAgents: ['t1'], fastPath: false, readToken: '',
  fetchImpl: async () => jsonResponse(state({ t1: look() })),
});
await assert.rejects(() => noAggregateReader.assertControlReady(),
  /aggregate endpoint.*read-only/);
assert.equal(noAggregateReader.controlStatus.armed, false,
  'write mode cannot arm through the legacy MCP path');

const dedupe = new OrderDedupe({ maxEntries: 16, ttlMs: 60_000, now: () => now });
let executions = 0;
const body = { order_id: 'dedupe-order-01', type: 'attack' };
const [first, retry] = await Promise.all([
  dedupe.execute(body.order_id, body, async () => ++executions),
  dedupe.execute(body.order_id, body, async () => ++executions),
]);
assert.deepEqual([first, retry, executions], [1, 1, 1]);
assert.throws(() => dedupe.execute(body.order_id, { ...body, type: 'move' }, async () => 2),
  /different payload/);

// HTTP boundary: disabled-by-default, token, JSON and browser-Origin checks, then
// one idempotent accepted POST. This is an in-process fixture and opens no Meridian
// session, roster, broker, or game-server connection.
const httpCalls = [];
const httpState = state({ t1: look() });
let httpAggregateFailure = false;
const httpReader = new BrokerReader({
  expectedFleet: 'local-control-test',
  ordersEnabled: true,
  controlServer: '127.0.0.1:5959',
  controlToken: 'fixture-control-token-123',
  allowedAgents: ['t1'], readToken: '',
  fetchImpl: async url => {
    if (new URL(url).pathname === '/health') return jsonResponse(httpState.health);
    if (httpAggregateFailure)
      return { ok: false, status: 503, json: async () => ({ error: 'fixture aggregate unavailable' }) };
    return jsonResponse(httpState);
  },
});
httpReader.order = async (name, args) => {
  httpCalls.push({ name, args });
  return { accepted: true, control_token: args.control_token };
};
await httpReader.assertControlReady();
const httpHub = new RealtimeHub({ reader: httpReader });
const server = createGatewayServer({ reader: httpReader, sceneStore: null, hub: httpHub });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const url = `http://127.0.0.1:${server.address().port}/v1/orders`;
  const health = await fetch(url.replace('/v1/orders', '/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).writes, true);
  const contract = await fetch(url.replace('/v1/orders', '/v1/contract'));
  assert.equal(contract.status, 200);
  const contractBody = await contract.json();
  assert.deepEqual(contractBody.rts_cast_policy, {
    fail_closed: true,
    exact_names: ['create food', 'create weapon', 'blink'],
    target_spells: false,
  });
  assert.deepEqual(contractBody.action_catalogue.context, [
    'stand', 'rest_here', 'recover_here', 'grab_nearby', 'take', 'cast',
    'approach', 'face', 'equip_best', 'wear_best', 'eat_best', 'prepare',
    'item_use', 'item_unuse', 'item_eat', 'safety_on',
  ]);
  assert.deepEqual(contractBody.action_catalogue.deliberately_absent,
    ['drop', 'safety_off', 'buy', 'sell', 'trade']);
  const postBody = JSON.stringify({ type: 'attack', generation: `${Date.now() - 100}-1234`,
    order_id: 'http-attack-001',
    orders: [{ agent: 't1', room: 200, target_id: 900 }] });
  const noToken = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: postBody });
  assert.equal(noToken.status, 401);
  const browser = await fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'https://example.test',
    authorization: 'Bearer fixture-control-token-123',
  }, body: postBody });
  assert.equal(browser.status, 403);
  const plain = await fetch(url, { method: 'POST', headers: {
    'content-type': 'text/plain', authorization: 'Bearer fixture-control-token-123',
  }, body: postBody });
  assert.equal(plain.status, 415);
  const jsonp = await fetch(url, { method: 'POST', headers: {
    'content-type': 'application/jsonp', authorization: 'Bearer fixture-control-token-123',
  }, body: postBody });
  assert.equal(jsonp.status, 415);
  const headers = { 'content-type': 'application/json',
    authorization: 'Bearer fixture-control-token-123' };
  const good = await fetch(url, { method: 'POST', headers, body: postBody });
  assert.equal(good.status, 202);
  const goodResult = await good.json();
  assert.equal(goodResult.accepted, true);
  const attackControlToken = goodResult.outcomes[0].result.control_token;
  assert.match(attackControlToken, /^rts[.][0-9a-f]{32}[.][0-9a-z]+[.][0-9a-f]{24}$/);
  const retried = await fetch(url, { method: 'POST', headers, body: postBody });
  assert.equal(retried.status, 202);
  assert.deepEqual(await retried.json(), goodResult,
    'an exact dedupe retry returns the originally stored result and ownership token');
  assert.equal(httpCalls.length, 1, 'an HTTP retry with one order_id is not dispatched twice');
  const contextBody = JSON.stringify({ type: 'context', action: 'stand',
    generation: `${Date.now() - 100}-1234`, order_id: 'http-context-001',
    orders: [{ agent: 't1', room: 200 }] });
  const context = await fetch(url, { method: 'POST', headers, body: contextBody });
  assert.equal(context.status, 202);
  const contextResult = await context.json();
  assert.equal(contextResult.action, 'stand');
  assert.equal(httpCalls.length, 2);
  assert.equal(httpCalls[1].name, 'context_intent');
  assert.match(httpCalls[1].args.control_token,
    /^rts[.][0-9a-f]{32}[.][0-9a-z]+[.][0-9a-f]{24}$/);
  assert.notEqual(httpCalls[1].args.control_token, attackControlToken,
    'newly admitted commands receive unique ownership tokens');
  httpAggregateFailure = true;
  httpReader.healthCache = null;
  httpReader.fastPathUnavailableUntil = 0;
  const aggregateDegraded = await fetch(url.replace('/v1/orders', '/health'));
  assert.equal(aggregateDegraded.status, 503);
  const aggregateDegradedBody = await aggregateDegraded.json();
  assert.equal(aggregateDegradedBody.writes, false);
  assert.match(aggregateDegradedBody.control.reason, /aggregate endpoint/);
  const degradedContract = await fetch(url.replace('/v1/orders', '/v1/contract'));
  assert.equal((await degradedContract.json()).writes, false,
    'the contract stops advertising writes when the aggregate command path fails');
  httpAggregateFailure = false;
  httpReader.fastPathUnavailableUntil = 0;
  httpState.health.game_server = { host: '127.0.0.1', port: 5960 };
  httpReader.healthCache = null;
  const degraded = await fetch(url.replace('/v1/orders', '/health'));
  assert.equal(degraded.status, 503);
  const degradedBody = await degraded.json();
  assert.equal(degradedBody.writes, false);
  assert.match(degradedBody.control.reason, /not wholly attached/);
} finally {
  await new Promise(resolve => server.close(resolve));
  httpHub.close();
}

console.log('m59 RTS local control: attack/move/cancel/auth/dedupe safety passed');
