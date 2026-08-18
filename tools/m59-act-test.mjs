#!/usr/bin/env node
// m59-act-test.mjs -- THE ATOMIC CONTRACT, ENFORCED MECHANICALLY.
//
// Offline, no server:  node tools/m59-act-test.mjs
//
// Two halves. The first is a CONFORMANCE sweep that every file in tools/m59-act/
// must pass, whoever writes it and whenever: it is the thing that stops the next
// wave of atomics turning into wrappers the way the last one did. The second is
// per-atomic behaviour.
//
// The conformance rules come from docs/keeper-rebuild-plan.md §4, and each exists
// because of a specific failure already paid for in this repository:
//
//   TAKES A CLIENT, NOT A KEEPER
//     The fork's BT modules took a keeper and called 71 of its methods. 25 of
//     those existed on one fork only, so the modules could not be carried to
//     another trunk at all -- the wrapper debt and the fork turned out to be the
//     same bill. An atomic over the client is portable because m59-client.mjs is
//     identical everywhere.
//
//   DECLARES pre/effects FROM THE CLOSED VOCABULARY
//     A precondition nobody produces makes a plan silently unsatisfiable, and the
//     planner can only report "no plan". Same shape as policy.purpose sitting
//     outside a schema for a year with the yield audit switched off behind it.
//
//   NO UNBOUNDED LOOP
//     The keeper is a long-await machine and 82% of deaths had it blind, worst
//     case 909 seconds inside one travel call. An atomic that loops cannot be
//     interrupted between iterations, so looping belongs to the caller.
//
//   REFUSES BY RETURNING, NOT BY THROWING
//     A refusal that throws has to be caught by every caller, and the ones that
//     forget read it as success -- which is exactly how "no error" came to mean
//     "the merchant sold it" for years, when a refusal here is a sentence spoken
//     to the room and never an error on the wire.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, SYMBOL_NAMES, evaluate } from './m59-worldstate.mjs';
import { fakeClient, fakeSession } from './m59-fake-client.mjs';

const evaluateFor = (spec) => evaluate({ client: fakeClient(spec), policy: {} });
const ACTDIR = join(dirname(fileURLToPath(import.meta.url)), 'm59-act');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------------------------------------------
// Conformance: every atomic, every rule.
// ---------------------------------------------------------------------------
const files = readdirSync(ACTDIR).filter(f => f.endsWith('.mjs')).sort();
ok('there is at least one atomic to check', files.length > 0);

for (const file of files) {
  const src = readFileSync(join(ACTDIR, file), 'utf8');
  const mod = await import(join(ACTDIR, file));
  const fns = Object.values(mod).filter(v => typeof v === 'function' && v.atomic);

  console.log(`\nconformance: m59-act/${file}`);
  ok(`${file} exports at least one tagged atomic`, fns.length > 0,
     'tag it with `fn.atomic = "name"` so the sweep can find it');

  for (const fn of fns) {
    const n = fn.atomic;

    // 1. the vocabulary
    ok(`${n}: declares pre`, Array.isArray(fn.pre));
    ok(`${n}: declares effects`, Array.isArray(fn.effects));
    const problems = validate({ name: n, pre: fn.pre, effects: fn.effects });
    ok(`${n}: every pre/effect is a known world-state symbol`, problems.length === 0,
       problems[0] ?? '');
    ok(`${n}: effects are not empty — an atomic that changes nothing is a Condition`,
       (fn.effects ?? []).length > 0);

    // 2. NEVER THE KEEPER. Checked in the source, because a signature cannot say it.
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok(`${n}: never reaches for a keeper`,
       !/\bkeeper\./.test(body) && !/\bthis\.(policy|s|note|tally)\b/.test(body),
       'an atomic takes (client, session) and nothing else');

    // 3. bounded — no loop around an await
    const looping = /\b(while|for)\s*\([^)]*\)\s*\{[^]*?\bawait\b/.test(body);
    ok(`${n}: contains no loop around an await`, !looping,
       'looping is the callers job, so it can be interrupted between iterations');

    // 4. arity: (client, session, args)
    ok(`${n}: takes (client, session, args)`, fn.length <= 3 && fn.length >= 2);
  }
}

// ---------------------------------------------------------------------------
// Behaviour: attack
// ---------------------------------------------------------------------------
const { attack, SWING_MS } = await import('./m59-act/attack.mjs');

const withFoe = (col = 11, row = 10) => {
  const c = fakeClient({
    selfId: 1, col: 10, row: 10,
    equipped: [{ id: 5, name: 'mace' }],
    room: { num: 1, objects: [{ id: 9, name: 'mummy', col, row }] },
  });
  return { c, s: fakeSession(c) };
};

console.log('\nattack: one swing, and it reaches the wire');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('it reports sending', r.sent === true);
  ok('exactly ONE attack packet — an atomic is one swing',
     c.sent.filter(x => x[0] === 'attack').length === 1, JSON.stringify(c.sent));
  ok('aimed at the target we named', c.sent.find(x => x[0] === 'attack')[1] === 9);
  ok('the swing timer is the server\'s', SWING_MS === 1050);
}

console.log('\nattack refuses by RETURNING — never by throwing');
{
  const { c, s } = withFoe();
  let threw = false; let r;
  try { r = await attack(c, s, {}); } catch { threw = true; }
  ok('no target: does not throw', !threw);
  ok('and says why', r.sent === false && /no target/.test(r.reason));
  ok('and sent nothing', c.sent.length === 0);

  let r2, threw2 = false;
  try { r2 = await attack(null, null, { targetId: 9 }); } catch { threw2 = true; }
  ok('no client: does not throw either', !threw2 && r2.sent === false);
}

console.log('\nattack obeys the reach disc — a swing from too far is thrown away by the server');
{
  const far = withFoe(14, 10);              // distance 4, outside the radius-3 disc
  const r = await attack(far.c, far.s, { targetId: 9, waitMs: 1 });
  ok('it refuses rather than wasting the round', r.sent === false);
  ok('and names the reason', /out of reach/.test(r.reason));
  ok('and no packet went out', far.c.sent.filter(x => x[0] === 'attack').length === 0);

  const edge = withFoe(13, 10);             // distance exactly 3 — legal
  const r2 = await attack(edge.c, edge.s, { targetId: 9, waitMs: 1 });
  ok('three squares away IS in reach and does swing', r2.sent === true);
}

console.log('\nattack is honest: it reads the room back rather than trusting the send');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('the target was there before', r.target_present_before === true);
  ok('and is reported still there after — nothing is claimed about damage',
     r.target_present_after === true);

  // Now the room says it is gone. The atomic must report the ROOM's answer.
  const { c: c2, s: s2 } = withFoe();
  s2.pacer = { submit: async (_k, fn) => { fn(); c2.room.objects.delete(9); } };
  const r2 = await attack(c2, s2, { targetId: 9, waitMs: 1 });
  ok('a target that left is reported gone, from the room and not from the send',
     r2.sent === true && r2.target_present_after === false);
}

console.log('\nattack will not swing at something that is not there');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 999, waitMs: 1 });
  ok('an absent target is refused', r.sent === false && /not in the room/.test(r.reason));
  ok('and nothing was sent', c.sent.filter(x => x[0] === 'attack').length === 0);
}

// ---------------------------------------------------------------------------
// Behaviour: step
// ---------------------------------------------------------------------------
const { step, WALK_SPEED, VIGOR_RUN_THRESHOLD } = await import('./m59-act/step.mjs');

const walker = (spec = {}) => {
  const c = fakeClient({ selfId: 1, col: 5, row: 5, vigor: 100, room: { num: 7 }, ...spec });
  return { c, s: fakeSession(c) };
};

console.log('\nstep: one square, and arrival is READ BACK not assumed');
{
  const { c, s } = walker();
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('it moved', r.sent === true && r.arrived === true);
  ok('it reports where it came from and where it landed',
     r.from.col === 5 && r.at.col === 6, JSON.stringify(r));
  ok('exactly one movement went out — an atomic is one step',
     c.sent.filter(x => x[0] === 'step').length === 1, JSON.stringify(c.sent));
}

console.log('\nstep is honest: a move the world refuses is NOT an arrival');
{
  // The packet goes out and nothing happens -- which is what a collision refusal
  // looks like on this wire. A caller that trusted the send walks a route it never
  // actually started.
  const { c, s } = walker();
  s.step = async () => ({ moved: false, reason: 'blocked' });   // world does not budge
  const r = await step(c, s, { col: 9, row: 9, waitMs: 1 });
  ok('it does not claim to have arrived', r.arrived === false);
  ok('and it says where it actually is', r.at.col === 5 && r.at.row === 5);
  ok('and carries the reason through', r.reason === 'blocked');
}

console.log('\nstep propagates TERMINAL failures rather than inviting a retry');
{
  const { c, s } = walker();
  s.step = async () => ({ moved: false, reason: 'collision_geometry_unavailable' });
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('a terminal reason is marked as such', r.terminal === true);
  ok('retrying one of these just re-sends a move the geometry already refused',
     r.arrived === false);

  const { c: c2, s: s2 } = walker();
  s2.step = async () => ({ moved: false, reason: 'blocked' });
  const r2 = await step(c2, s2, { col: 6, row: 5, waitMs: 1 });
  ok('an ordinary refusal is NOT terminal — that one is worth retrying',
     r2.terminal === undefined);
}

console.log('\nstep offers no speed, because the mover accepts none');
{
  // The run floor is real (below vigor 10 the server snaps you back and logs you as
  // a speedhacker) but UNREACHABLE: the broker's mover is step(col,row,{confirm,
  // beforeMutation}) and takes no speed. An argument the mover drops is a lever
  // connected to nothing, and a guard on it can never fire -- the same shape as the
  // `typeof c.armed === 'function'` branch that has never executed.
  const { c, s } = walker({ vigor: 4 });
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('a character at 4 vigor still steps — walking has no floor',
     r.sent === true && r.arrived === true);
  ok('the constants stay for citation even though nothing consumes them',
     WALK_SPEED === 18 && VIGOR_RUN_THRESHOLD === 10);
  ok('and no speed is passed to the mover',
     c.sent.filter(x => x[0] === 'step').length === 1);
}

console.log('\nstep requires the validated mover — the grid is for planning, not stepping');
{
  // Centre-to-centre grid steps are measured to fail 218 of 311 in room 587, and
  // 92% of those failures DO NOT MOVE THE CHARACTER -- so a caller replans from an
  // unchanged position and asks for the identical refused step for ever.
  const c = fakeClient({ selfId: 1, col: 5, row: 5, room: { num: 587 } });
  const s = fakeSession(c);
  delete s.step;                       // a session with no fine-coordinate mover
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('it refuses rather than sending a step that cannot work',
     r.sent === false && /no validated mover/.test(r.reason));
  ok('and marks it terminal — retrying cannot make it legal', r.terminal === true);
  ok('and NOTHING went to the wire', c.sent.length === 0);
}

console.log('\nstep refuses what cannot be a step at all');
{
  const { c, s } = walker();
  const same = await step(c, s, { col: 5, row: 5, waitMs: 1 });
  ok('a step to where we already stand sends nothing and is already arrived',
     same.sent === false && same.arrived === true && c.sent.length === 0);

  const bad = await step(c, s, { col: 1.5, row: 'x', waitMs: 1 });
  ok('a non-integer target is invalid_move_target and terminal',
     bad.sent === false && bad.reason === 'invalid_move_target' && bad.terminal === true);

  const lost = walker({ overrides: { self: null } });
  const r = await step(lost.c, lost.s, { col: 6, row: 5, waitMs: 1 });
  ok('not knowing where we are is terminal, not a guess',
     r.sent === false && r.reason === 'own_position_unknown' && r.terminal === true);

  let threw = false;
  try { await step(null, null, { col: 1, row: 1 }); } catch { threw = true; }
  ok('and none of these throw', !threw);
}

// ---------------------------------------------------------------------------
// Behaviour: equip / rest / stand
// ---------------------------------------------------------------------------
const { equip } = await import('./m59-act/equip.mjs');
const { rest, stand } = await import('./m59-act/rest.mjs');

console.log('\nequip: the USE LIST is the answer, never what the send asked for');
{
  // A `use` that the server declines says so OUT LOUD to the room and sends
  // nothing on the wire -- "your hands are too full", player.kod:131. So a caller
  // that trusts the send goes on believing it is armed. Nineteen of twenty-five
  // characters were once found fighting in their shirts.
  const c = fakeClient({ inventory: [{ id: 3, name: 'mace' }], equipped: [] });
  const s = fakeSession(c);
  const r = await equip(c, s, { itemId: 3, waitMs: 1 });
  ok('the packet went', r.sent === true);
  ok('but nothing changed, because the use list did not move',
     r.changed === false && r.equipped_after === false);
  ok('and it says so rather than reporting success',
     /did not move/.test(r.reason), r.reason);
}

console.log('\nequip reports a real change when the use list actually moves');
{
  const c = fakeClient({ inventory: [{ id: 3, name: 'mace' }], equipped: [] });
  const s = fakeSession(c);
  // the server accepts: the use list gains the item
  s.pacer = { submit: async (_k, fn) => { fn(); c.equipment = () =>
    ({ known: true, equipped: [{ id: 3, name: 'mace' }], count: 1 }); } };
  const r = await equip(c, s, { itemId: 3, waitMs: 1 });
  ok('changed is true only when the SERVER moved it',
     r.changed === true && r.equipped_before === false && r.equipped_after === true);
}

console.log('\nequip refuses the two no-ops, because re-using is REFUSED not idempotent');
{
  const armedC = fakeClient({ equipped: [{ id: 3, name: 'mace' }] });
  const r = await equip(armedC, fakeSession(armedC), { itemId: 3, waitMs: 1 });
  ok('wielding what we already wield sends nothing',
     r.sent === false && /already in use/.test(r.reason) && armedC.sent.length === 0);

  const bareC = fakeClient({ equipped: [] });
  const r2 = await equip(bareC, fakeSession(bareC), { itemId: 3, off: true, waitMs: 1 });
  ok('taking off what is not on sends nothing either',
     r2.sent === false && /not in use/.test(r2.reason));
}

console.log('\nequip will not claim a change from an unread use list');
{
  // known:false means NOBODY HAS ASKED, which is the opposite fact from "nothing
  // is equipped" and must never render the same.
  const c = fakeClient({ equipped: [], known: false });
  const r = await equip(c, fakeSession(c), { itemId: 3, waitMs: 1 });
  ok('it still sends — an unread list is not a refusal', r.sent === true);
  ok('but claims no change, because there is no evidence either way',
     r.changed === false && r.equipped_before === null);
}

console.log('\nrest / stand: one posture change, and no confirmation is invented');
{
  const c = fakeClient({ vigor: 20 });
  const s = fakeSession(c);
  const r = await rest(c, s, { waitMs: 1 });
  ok('rest sends exactly one', r.sent === true && c.sent.filter(x => x[0] === 'rest').length === 1);
  // Posture is reported by no packet this client parses. Claiming to have
  // confirmed it would be the UC_LOOK_PLAYER mistake: inventing an answer for a
  // question nothing on the wire asks.
  ok('and does NOT pretend to have confirmed the posture', r.posture_confirmed === false);

  const r2 = await stand(c, s, { waitMs: 1 });
  ok('stand sends exactly one', r2.sent === true && c.sent.filter(x => x[0] === 'stand').length === 1);

  let threw = false;
  try { await rest(null, null); await stand(null, null); } catch { threw = true; }
  ok('neither throws without a session', !threw);
}

console.log('\nresting cannot pass the cap, and the vocabulary is what says so');
{
  // REST_VIGOR_CAP is 80 of 200: everything above it has to be EATEN, and a fleet
  // holding out for a vigor no rest can deliver looks exactly like a working one.
  const low  = evaluateFor({ vigor: 40 });
  const atCap = evaluateFor({ vigor: 80 });
  ok('under the cap, sitting down can still pay', low.can_rest_higher === true);
  ok('AT the cap it cannot, however long you sit', atCap.can_rest_higher === false);
  ok('rest declares that as its effect, so a planner cannot loop on it',
     rest.effects.includes('can_rest_higher'));
}

// ---------------------------------------------------------------------------
// Behaviour: cast — A CHARACTER CAN ONLY CAST WHAT IT KNOWS
// ---------------------------------------------------------------------------
const { cast, knownSpells, spellNamed, groundedCasts, SPELL_EFFECTS }
  = await import('./m59-act/cast.mjs');

const caster = (spells, spec = {}) => {
  const c = fakeClient({ spells, mana: 30, ...spec });
  return { c, s: fakeSession(c) };
};

console.log('\ncast: a spell the character does not know is refused, not attempted');
{
  const { c, s } = caster(['create food']);
  const r = await cast(c, s, { spell: 'shatter lock', waitMs: 1 });
  ok('it refuses', r.sent === false && r.known === false);
  ok('and says why in the character\'s own terms',
     /does not know that spell/.test(r.reason), r.reason);
  ok('and NOTHING went to the wire — asking spends the round for silence',
     c.sent.filter(x => x[0] === 'cast').length === 0);

  const r2 = await cast(c, s, { spell: 'create food', waitMs: 1 });
  ok('a spell it DOES know goes out', r2.sent === true && r2.known === true);
  ok('and it went out by the id from the LIVE list, not a cached one',
     c.sent.find(x => x[0] === 'cast')[1] === spellNamed(c, 'create food').id);
}

console.log('\ncast resolves BY NAME, because ids are renumbered and lists go stale');
{
  // Object ids are renumbered on every save (every 15 minutes) and a group-3 stat
  // packet is POSITIONAL against plSpells -- against a stale list every number is
  // mislabelled silently. So a name is the only durable handle.
  const { c } = caster([{ id: 4242, name: 'create food' }]);
  ok('it finds the spell whatever its id is', spellNamed(c, 'create food').id === 4242);
  ok('matching is case-insensitive', spellNamed(c, 'CREATE FOOD') !== null);
  ok('and an unknown name is null rather than a guess', spellNamed(c, 'fireball') === null);
  ok('knownSpells lists what the character actually holds',
     knownSpells(c).length === 1 && knownSpells(c)[0].name === 'create food');
}

console.log('\ncast refuses on mana rather than sending a spell that cannot land');
{
  const { c, s } = caster(['create food'], { mana: 3 });
  const r = await cast(c, s, { spell: 'create food', waitMs: 1 });
  ok('it refuses', r.sent === false && /not enough mana/.test(r.reason));
  ok('and reports what it had', r.mana_before === 3);
  ok('and sent nothing', c.sent.filter(x => x[0] === 'cast').length === 0);
}

console.log('\ngroundedCasts: an unknown spell is ABSENT from the plan space, not refused in it');
{
  // The same guarantee attack.pre gives against the engagement ceiling: not
  // discouraged, IMPOSSIBLE, because the action does not exist. This is also how
  // the game itself behaves -- a skill you cannot learn is missing from the
  // merchant's offer list (monster.kod:4855) rather than refused.
  const { c } = caster(['create food']);
  const acts = groundedCasts(c);
  ok('a character who knows create food gets exactly that action',
     acts.length === 1 && acts[0].atomic === 'cast create food');
  ok('it carries the SPELL\'s own preconditions, not a generic one',
     acts[0].pre.includes('has_reagents') && acts[0].pre.includes('has_mana'));
  ok('and the spell\'s own effects',
     acts[0].effects.includes('has_food') && acts[0].effects.includes('!has_reagents'));

  const none = groundedCasts(fakeClient({ spells: [] }));
  ok('a character who knows NOTHING gets no cast actions at all — no plan can contain one',
     none.length === 0);

  const other = groundedCasts(fakeClient({ spells: ['blink'] }));
  ok('and a spell with no modelled effect is not invented into the plan space',
     other.length === 0);

  // The chain the fleet actually lives on, expressed in the vocabulary.
  ok('create food is 2 elderberry AND 2 herbs -> a meal',
     SPELL_EFFECTS['create food'].pre.includes('has_reagents') &&
     SPELL_EFFECTS['create food'].effects.includes('has_food'));
}

console.log('\ncast refuses by returning, like every other atomic');
{
  let threw = false; let r;
  try { r = await cast(null, null, { spell: 'create food' }); } catch { threw = true; }
  ok('no client does not throw', !threw && r.sent === false);
  const { c, s } = caster(['create food']);
  const r2 = await cast(c, s, {});
  ok('no spell named does not throw either', r2.sent === false && /no spell/.test(r2.reason));
}

// ---------------------------------------------------------------------------
// Behaviour: eat — the stomach is the constraint, and it is invisible
// ---------------------------------------------------------------------------
const { eat } = await import('./m59-act/eat.mjs');
const { Stomach, STOMACH_CAP } = await import('./m59-skills.mjs');

const eater = (vigor = 40, extra = {}) => {
  const c = fakeClient({ vigor, inventory: [{ id: 4, name: 'bread' }], ...extra });
  return { c, s: fakeSession(c) };
};

console.log('\neat: applies the food to ourselves, and reads the gain back');
{
  const { c, s } = eater(40);
  // the server accepts and vigor rises
  let v = 40;
  c.vitals = () => ({ health: { value: 20, max: 20 }, mana: { value: 20, max: 20 },
                      vigor: { value: v, max: 200, scale_max: 200 } });
  s.pacer = { submit: async (_k, fn) => { fn(); v = 95; } };
  const r = await eat(c, s, { itemId: 4, waitMs: 1 });
  ok('it sent an apply of the food onto ourselves',
     c.sent.some(x => x[0] === 'apply' && x[1] === 4 && x[2] === c.selfId), JSON.stringify(c.sent));
  ok('and reports the gain from vitals rather than assuming one',
     r.vigor_before === 40 && r.vigor_after === 95 && r.gained === 55);
}

console.log('\neat will not eat what is not in the pack');
{
  const { c, s } = eater();
  const r = await eat(c, s, { itemId: 999, waitMs: 1 });
  ok('refused, and nothing sent',
     r.sent === false && /not in the pack/.test(r.reason) && c.sent.length === 0);
}

console.log('\neat refuses a mouthful the stomach cannot take — before the packet');
{
  // ReqEatSomething refuses when piStomach + filling > 100 (player.kod:5703) and
  // says so only to the room. A refusal we can predict is one we can plan around.
  const { c, s } = eater();
  const full = new Stomach(STOMACH_CAP);
  const r = await eat(c, s, { itemId: 4, filling: 25, stomach: full, waitMs: 1 });
  ok('it refuses', r.sent === false && /too full/.test(r.reason));
  ok('and says how long until it would fit — the stomach drains 0.12 a second',
     typeof r.seconds_until_room === 'number' && r.seconds_until_room > 0,
     String(r.seconds_until_room));
  ok('and no packet went out', c.sent.filter(x => x[0] === 'apply').length === 0);
}

console.log('\nthe stomach model is charged on EVIDENCE, and a refusal is a measurement');
{
  // Charging optimistically lets the model drift permanently high; it must move only
  // on what actually happened.
  const gained = new Stomach(0);
  const { c, s } = eater(40);
  let v = 40;
  c.vitals = () => ({ health: { value: 20, max: 20 }, mana: { value: 20, max: 20 },
                      vigor: { value: v, max: 200, scale_max: 200 } });
  s.pacer = { submit: async (_k, fn) => { fn(); v = 90; } };
  await eat(c, s, { itemId: 4, filling: 25, stomach: gained, waitMs: 1 });
  ok('a meal that landed is charged to the model', gained.level >= 25, String(gained.level));

  // Now the server declines: the packet goes, nothing moves.
  const declined = new Stomach(0);
  const { c: c2, s: s2 } = eater(40);
  await eat(c2, s2, { itemId: 4, filling: 25, stomach: declined, waitMs: 1 });
  ok('a meal that did NOT land pins the model from below instead',
     declined.level > 0, String(declined.level));
  ok('and that reading is the only stomach evidence the wire ever gives',
     declined.level >= STOMACH_CAP - 25);
}

console.log('\neat closes the supply chain, in the vocabulary');
{
  ok('it needs food', eat.pre.includes('has_food'));
  ok('it produces vigor and consumes the food',
     eat.effects.includes('vigor_ok') && eat.effects.includes('!has_food'));
  // The reason the chain has to exist at all: resting stops at 80 of 200, so
  // everything above the cap must be eaten.
  ok('and resting alone could never get there — the cap is 80 of 200',
     evaluateFor({ vigor: 80 }).can_rest_higher === false);
}

console.log('\nattack declares a plan-able contract');
{
  ok('pre includes being armed and in reach',
     attack.pre.includes('armed') && attack.pre.includes('in_reach'));
  ok('pre includes the engagement band — the ceiling is a PRECONDITION, not an afterthought',
     attack.pre.includes('target_in_band'));
  ok('every symbol it names exists in the vocabulary',
     [...attack.pre, ...attack.effects].every(s => SYMBOL_NAMES.includes(s.replace(/^!/, ''))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
