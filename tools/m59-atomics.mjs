#!/usr/bin/env node
// m59-atomics.mjs -- shared atomic keeper operations for the GOAP planner and
// the behavior tree.
//
// The GOAP supervisor (m59-goap.mjs) and the behavior tree action nodes
// (m59-bt-nodes.mjs) both need the same primitive operations -- revive, stop,
// travel, set policy, pick prey, buy a weapon. Before this file each side
// implemented them against its own mechanism (GOAP over broker MCP tools via
// HTTP, the BT against in-process keeper methods), which meant two copies of
// every operation that could drift. This module is the single copy: an atomic
// is one primitive operation, declared with the world-state field it changes
// (`effect`), and reached through a small DRIVER that supplies the mechanism
// for the context it runs in.
//
//   - brokerDriver(baseURL)  -- GOAP: verbs call broker MCP tools over HTTP.
//   - keeperDriver(keeper)   -- BT:  verbs call in-process keeper methods.
//
// Atomics are invoked as   runAtomic(name, ctx, params)   and each returns a
// Promise. The BT action nodes wrap that promise in their RUNNING/slot pattern
// (kick it off, report status on a later tick); GOAP just awaits it.
//
// No broker, no autopilot, no client imports -- pure, so it is testable offline
// against mock drivers. HTTP (fetch) is only ever touched at call time inside
// brokerDriver, never at module load.

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

// Broker driver: every verb issues a broker MCP tool call over HTTP. `agent`
// names the roster slot the tool operates on. `callTool` is the low-level
// JSON-RPC sender; it defaults to one that hits `baseURL`, but callers can pass
// their own (the GOAP file already has one with the same shape) so there is a
// single HTTP implementation per process.
export function brokerDriver(baseURL, callTool) {
  const tool = callTool || ((name, args) => _httpTool(baseURL, name, args));
  return {
    // autopilot stop / revive / set
    stop:      (agent, why)        => tool('autopilot', { agent, action: 'stop',  why }),
    revive:    (agent, why)        => tool('autopilot', { agent, action: 'revive', why }),
    setPolicy: (agent, fields)     => tool('autopilot', { agent, action: 'set', ...fields }),
    // travel: returns { arrived }
    travel:    (agent, to)         => tool('travel',    { agent, to }),
    // read-only queries
    pickPrey:  (agent, { goals, karma } = {}) => tool('prey', { agent, goals, ...(karma ? { karma } : {}) }),
    who:       (agent)             => tool('who',      { agent }),
    // inn claim / release
    claimInn:  (agent, character)  => tool('inn', { agent, action: 'claim', character }),
    // skill purchasing: returns { results: [ { queued, ability, price, reason } ] }
    buySkills: (agents)            => tool('buy_next_planned_skills', { agents }),
    // leave the newbie zone (Raza)
    leaveRaza: (agent)             => tool('leave_raza', { agent }),
  };
}

// Keeper driver: every verb calls an in-process keeper method on the keeper
// that is already bound to its own character, so `agent` is ignored. Methods
// are guarded on existence so a mock keeper in a unit test only needs to
// implement the verbs it is asked for. The BT currently exercises only the
// weapon atomics; the rest exist for the travel/revive nodes that come next.
export function keeperDriver(keeper) {
  const k = keeper || {};
  return {
    stop:   (_agent, why)  => typeof k.stop === 'function' ? k.stop(why) : Promise.resolve(false),
    revive: (_agent, why)  => typeof k.revive === 'function' ? k.revive(why) : Promise.resolve(false),
    travel: (_agent, to)   => typeof k.travel === 'function' ? k.travel(to, {}) : Promise.resolve(false),
    setPolicy: (_agent, fields) => {
      // The BT executes strategy; GOAP decides it. Mutating the keeper's live
      // policy object is the in-process analog of `autopilot set`. Guarded: a
      // keeper without a policy object cannot take one.
      if (k.policy && fields) Object.assign(k.policy, fields);
      return Promise.resolve(true);
    },
    pickPrey: (_agent, { goals, karma } = {}) => Promise.resolve({ candidates: [] }),
    who:   (_agent) => Promise.resolve({ here: [] }),
    claimInn: (_agent, _character) => Promise.resolve(false),
    buySkills: (_agents) => Promise.resolve({ results: [] }),
    leaveRaza: (_agent) => Promise.resolve(false),
    // The weapon atomics the get_armed subtree currently exercises.
    equipBest: (_agent, why) => typeof k.armSelf === 'function'
      ? k.armSelf(why)
      : (typeof k.equipBest === 'function' ? k.equipBest() : Promise.resolve(false)),
    conjureWeapon: (_agent, why) => typeof k.makeWeapon === 'function'
      ? k.makeWeapon(why) : Promise.resolve(false),
    buyWeapon: (_agent, why) => typeof k.buyWeaponsAtNearestSmith === 'function'
      ? k.buyWeaponsAtNearestSmith({ why }) : Promise.resolve(false),
  };
}

// Default HTTP tool for brokerDriver when no callTool is supplied.
async function _httpTool(baseURL, name, args) {
  const r = await fetch(baseURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Which inn a town trip should aim for. Rooms west of 400 (Ileria/Barloque/Tos
// side) go to Tos inn 52, east (Jasper side) to Jasper inn 370. This rule is
// duplicated across four GOAP town-trip actions; it lives here so it has one
// home, exactly as the effect discipline does.
export function innDest(room) {
  return (room ?? 0) < 400 ? 52 : 370;
}

// Composite: stop the keeper, travel to `to`, revive it. The five GOAP town-trip
// actions all do exactly this triple; collapsing them here is the point of the
// shared layer. Returns { arrived } from the travel call.
export async function relocateThenRevive(ctx, { agent, to, stopWhy, reviveWhy }) {
  await ctx.stop(agent, stopWhy);
  const result = await ctx.travel(agent, to);
  await ctx.revive(agent, reviveWhy);
  return result;
}

// ---------------------------------------------------------------------------
// The atomic registry
// ---------------------------------------------------------------------------
//
// Each atomic is { effect, run(ctx, params) }. `effect` names the world-state
// field(s) the atomic moves forward -- the same answer GOAP's cycle-guard and
// the BT's docs read, so monotonicity has one source. Params are per-atomic.

const ATOMICS = {
  // revive_keeper: un-inert the keeper. effect: inert=false.
  revive_keeper: {
    effect: 'inert=false',
    run: (ctx, { agent, why }) => ctx.revive(agent, why),
  },
  // stop_keeper: soft-stop (goInert). effect: inert=true. An intermediate of
  // the relocate composite, not a standalone plan step.
  stop_keeper: {
    effect: 'inert=true',
    run: (ctx, { agent, why }) => ctx.stop(agent, why),
  },
  // travel_to: move to a room. effect: room=to, health non-null once readable.
  travel_to: {
    effect: 'room=to, health readable',
    run: (ctx, { agent, to }) => ctx.travel(agent, to),
  },
  // set_policy: write hunt/assigned_room/purpose/goals. effect: those fields.
  set_policy: {
    effect: 'hunt/assigned_room/purpose/goals set',
    run: (ctx, { agent, fields }) => ctx.setPolicy(agent, fields),
  },
  // pick_prey: read prey candidates (respecting karma). effect: none (query).
  pick_prey: {
    effect: 'none (query)',
    run: (ctx, { agent, goals, karma }) => ctx.pickPrey(agent, { goals, karma }),
  },
  // claim_inn: park at an inn to rest. effect: parked_at_inn=true.
  claim_inn: {
    effect: 'parked_at_inn=true',
    run: (ctx, { agent, character }) => ctx.claimInn(agent, character),
  },
  // buy_skills: queue next planned skill purchase. effect: nextSkillCost
  // advances, totalFunds drops.
  buy_skills: {
    effect: 'nextSkillCost advances, totalFunds drops',
    run: (ctx, { agents }) => ctx.buySkills(agents),
  },
  // leave_raza: walk out of the newbie zone. effect: room outside 1011-1018.
  leave_raza: {
    effect: 'room outside 1011-1018',
    run: (ctx, { agent }) => ctx.leaveRaza(agent),
  },
  // who_in_room: read the room's occupants. effect: none (query).
  who_in_room: {
    effect: 'none (query)',
    run: (ctx, { agent }) => ctx.who(agent),
  },
  // equip_best: wear the best weapon in the pack. effect: hasWeapon=true.
  equip_best: {
    effect: 'hasWeapon=true',
    run: (ctx, { agent, why }) => ctx.equipBest(agent, why),
  },
  // conjure_weapon: cast create weapon. effect: hasWeapon=true.
  conjure_weapon: {
    effect: 'hasWeapon=true',
    run: (ctx, { agent, why }) => ctx.conjureWeapon(agent, why),
  },
  // buy_weapon: walk to a smith and buy one. effect: hasWeapon=true.
  buy_weapon: {
    effect: 'hasWeapon=true',
    run: (ctx, { agent, why }) => ctx.buyWeapon(agent, why),
  },
};

// Dispatch: run an atomic by name against a driver. Throws on an unknown name
// rather than silently no-opping, so a typo in a caller is reported, not hidden.
export async function runAtomic(name, ctx, params = {}) {
  const a = ATOMICS[name];
  if (!a) throw new Error(`unknown atomic: ${name}`);
  return a.run(ctx, params);
}

export const ATOMIC_NAMES = Object.keys(ATOMICS);
