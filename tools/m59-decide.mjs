#!/usr/bin/env node
// m59-decide.mjs -- THE DECIDE HALF, as a pure synchronous function.
//
// One tick is sense -> decide -> actuate. m59-tick.mjs owns the first and third; this
// is the middle, and it is deliberately the SAME decision the old keeper made, taken
// the same way, from the same vocabulary:
//
//     evaluate()  m59-worldstate.mjs   frame -> the 20-odd closed symbols
//     planFor()   m59-plan.mjs         symbols + goal -> a plan
//     intend()    here                 the plan's first step -> one command
//
// BOTH OF THOSE ARE ALREADY SYNCHRONOUS. `evaluate` reads pushed client state and
// `planFor` is A* over an in-memory action set -- neither is even declared async. So
// the decide half NEVER NEEDED TO BLOCK, and the only thing standing between the old
// model and this one was that execution went through `stepPlan`, which awaits an atomic.
//
// ---------------------------------------------------------------------------
// WHY THIS DOES NOT CALL THE ATOMICS
// ---------------------------------------------------------------------------
//
// The m59-act/ atomics are `async (client, session, args)` and every one of them awaits
// -- a pacer slot, a confirmation, a bounded wait for a reply. Calling one from a tick
// would break rule 1 immediately, and no amount of care would keep it fixed.
//
// So the plan is read for its DECISION and the decision is turned into a command here.
// The atomics stay exactly where they are, for the legacy driver and for the offline
// suite, and this is a second reader of the same plan rather than a rewrite of them.
//
// The cost is honest and worth stating: the binding an atomic does at execution time
// (which weapon, which food, which target) has to be done here too. Rather than a second
// copy of that judgement -- the shape this repository keeps paying for -- it imports the
// SAME pure helpers the atomics bind with: pickWeapon, pickFood, knownSpells. Those are
// synchronous by construction, which is why they can be shared at all.
import { evaluate } from './m59-worldstate.mjs';
import { planFor } from './m59-plan.mjs';
import { pickWeapon } from './m59-act/equip.mjs';
import { pickFood } from './m59-act/eat.mjs';
import { knownSpells } from './m59-act/cast.mjs';

// ---------------------------------------------------------------------------
// INTENT -- one planned action, turned into one command
// ---------------------------------------------------------------------------
//
// EVERY ENTRY SENDS AT MOST ONE THING AND RETURNS. An entry that wanted to send two
// commands in sequence, waiting for the first, would be a loop around an await with the
// awaits removed -- which is worse, because it would look fine.
//
// An action with no entry is REFUSED BY NAME, never guessed at. A silent fallthrough
// here would be a plan the tick believes it executed and did not, which is the failure
// this whole design is arranged against.
export const INTENTS = {
  rest:  (f, act) => ({ sent: !!act.rest(),  what: 'rest' }),
  stand: (f, act) => ({ sent: !!act.stand(), what: 'stand' }),

  equip: (f, act, ctx) => {
    const item = pickWeapon(ctx.client);
    if (!item) return { sent: false, why: 'no weapon in the pack' };
    act.use(item.id);
    return { sent: true, what: `equip ${item.name ?? item.id}` };
  },

  eat: (f, act, ctx) => {
    const item = pickFood(ctx.client);
    if (!item) return { sent: false, why: 'nothing edible in the pack' };
    act.eat(item.id);
    return { sent: true, what: `eat ${item.name ?? item.id}` };
  },

  // THE TARGET COMES FROM THE WORLD STATE, not from a second search. `has_target`,
  // `in_reach` and `target_in_band` are all produced from ws._targetId, so choosing a
  // different creature here would let the ceiling be checked against one and the swing
  // land on another -- the engagement ceiling failing open.
  attack: (f, act, ctx) => {
    const id = ctx.ws?._targetId;
    if (id == null) return { sent: false, why: 'no target in the world state' };
    if (!f.objects?.get?.(id)) return { sent: false, why: 'the target has left the room' };
    act.swing(id);
    return { sent: true, what: `attack ${id}` };
  },
};

// `cast <name>` is one action per known spell, so it is matched by prefix rather than
// listed. The spell id is resolved from the client's own list, which is pushed.
function castIntent(name, f, act, ctx) {
  const want = name.slice('cast '.length).toLowerCase();
  const spell = knownSpells(ctx.client).find(sp => String(sp.name).toLowerCase() === want);
  if (!spell) return { sent: false, why: `does not know ${want}` };
  act.cast(spell.id, []);
  return { sent: true, what: name };
}

export function intend(actionName, frame, act, ctx) {
  if (!actionName) return { sent: false, why: 'no action' };
  if (actionName.startsWith('cast ')) return castIntent(actionName, frame, act, ctx);
  const fn = INTENTS[actionName];
  if (!fn) return { sent: false, why: `no intent for "${actionName}"` };
  return fn(frame, act, ctx);
}

// ---------------------------------------------------------------------------
// THE DECIDER
// ---------------------------------------------------------------------------
//
// Returns a `decide(frame, act, loop)` for TickLoop. SYNCHRONOUS, by contract and in
// fact: nothing in the call graph below awaits.
//
// `goals` is an ordered list of { goal, when(ws) }. The first whose `when` holds and
// which is not currently skipped is pursued. It is the caller's, not this file's,
// because what a character is FOR is a directional decision and belongs to whoever is
// steering -- the same split CLAUDE.md draws between the keeper and a bot.
// TIME IS WALL CLOCK, NEVER A TICK COUNT.
//
// `skipForMs` was `skipFor = 30` in TICKS, and that is wrong in the direction that hurts:
// ticks coalesce when the loop is under load, so a goal "skipped for 30 ticks" is three
// seconds on a healthy loop and half a minute on a struggling one. The pause would grow
// exactly when things were going worst. A tick is a sampling cadence, not a clock.
export function makeDecider({ session, policy = {}, goals = [], onDecision = null,
                              skipAfter = 5, skipForMs = 3000, now = () => Date.now() } = {}) {
  if (!session) throw new Error('makeDecider: no session');
  const fails = new Map();       // goal -> consecutive failures
  const skipped = new Map();     // goal -> wall-clock ms to resume at
  let ticks = 0;

  const decide = (frame, act, loop) => {
    ticks++;
    const client = session.client;
    if (!client) return;

    // 1. SENSE -> VOCABULARY. Free: every producer reads pushed state.
    const ws = evaluate({ client, session, policy, agent: session.name });

    // 2. GOAL. The first that applies and is not serving a skip.
    const active = goals.find(g => {
      if (!g?.goal || !g.when?.(ws)) return false;
      const until = skipped.get(g.goal) ?? 0;
      return now() >= until;
    });
    if (!active) { onDecision?.({ ticks, goal: null, why: 'nothing to do' }); return; }

    // 3. PLAN. Synchronous A* over an action set built from what this character has.
    const p = planFor(client, { [active.goal]: true }, { session, policy, ws });
    const first = p.found ? (p.names?.[0] ?? null) : null;

    // A GOAL THAT CANNOT BE PLANNED IS A FAILURE AND MUST COUNT AS ONE. The old keeper
    // returned before its failure counter on exactly this path, so the one outcome that
    // most clearly means "unreachable" was the only one that could never retire a goal,
    // and a character re-selected it for ever. Watched live: JayB, goal has_food,
    // "exhausted 13 nodes", every pass, not moving.
    if (!first) { note(active.goal, false); 
      onDecision?.({ ticks, goal: active.goal, action: null, why: p.reason ?? 'no plan' });
      return; }

    // 4. ACT. One command, fired, not awaited.
    const r = intend(first, frame, act, { client, session, ws });
    note(active.goal, r.sent);
    onDecision?.({ ticks, goal: active.goal, action: first, sent: r.sent,
                   what: r.what ?? null, why: r.why ?? null });
  };

  function note(goal, ok) {
    if (ok) { fails.set(goal, 0); return; }
    const n = (fails.get(goal) ?? 0) + 1;
    fails.set(goal, n);
    if (n >= skipAfter) { skipped.set(goal, now() + skipForMs); fails.set(goal, 0); }
  }

  decide.state = () => ({ ticks, fails: Object.fromEntries(fails),
                          skipped: Object.fromEntries(skipped) });
  return decide;
}

// The fleet's ordinary ladder, as a default. Survival first, and every one of these is
// a REFUSAL-shaped condition rather than a weight: a cost can be outbid and a
// precondition cannot, which is the one rule docs/HANDOFF.md says must not be broken.
export const DEFAULT_GOALS = [
  { goal: 'healthy',  when: ws => ws.hurt === true },
  { goal: 'armed',    when: ws => ws.armed === false },
  { goal: 'vigor_ok', when: ws => ws.vigor_ok === false && ws.has_food === true },
  { goal: 'has_food', when: ws => ws.has_food === false && ws.has_reagents === true },
];
