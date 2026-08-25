#!/usr/bin/env node
// m59-zap-test.mjs -- the contract test for the zap enchantment state machine.
import { zapStatus, blueMushroomCount, equippedWeapon, findZapSpell, shouldCastZap } from './m59-zap.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake client with a controllable event ring and inventory.
function makeClient({ events = [], inventory = [], equipped = [], spells = [] } = {}) {
  return {
    eventsSince: (since = 0) => events.filter(e => e.seq > since),
    inventory,
    rsc: { get: (id) => id },  // nameRsc == name for the test
    equipment: () => ({ known: true, equipped }),
    spells,
  };
}

console.log('zapStatus: detects the ON message');
{
  const c = makeClient({ events: [
    { seq: 1, kind: 'message', text: 'Sparks jump and crackle from your fingertips.', at: Date.now() - 1000 },
  ]});
  const s = zapStatus(c);
  ok('active after ON', s.active === true, JSON.stringify(s));
  ok('basis is the ON message', /sparks jump/i.test(s.basis), s.basis);
}

console.log('\nzapStatus: OFF message clears it');
{
  const c = makeClient({ events: [
    { seq: 1, kind: 'message', text: 'Sparks jump and crackle from your fingertips.', at: Date.now() - 5000 },
    { seq: 2, kind: 'message', text: 'Your fingers are no longer charged with electrical power.', at: Date.now() - 1000 },
  ]});
  const s = zapStatus(c);
  ok('inactive after OFF', s.active === false, JSON.stringify(s));
}

console.log('\nzapStatus: latest message wins');
{
  const c = makeClient({ events: [
    { seq: 1, kind: 'message', text: 'Your fingers are no longer charged with electrical power.', at: Date.now() - 5000 },
    { seq: 2, kind: 'message', text: 'Sparks jump and crackle from your fingertips.', at: Date.now() - 1000 },
  ]});
  const s = zapStatus(c);
  ok('active (ON is latest)', s.active === true, JSON.stringify(s));
}

console.log('\nzapStatus: non-zap messages ignored');
{
  const c = makeClient({ events: [
    { seq: 1, kind: 'message', text: 'You pick up a blue mushroom.', at: Date.now() - 1000 },
  ]});
  const s = zapStatus(c);
  ok('inactive (no zap message)', s.active === false, JSON.stringify(s));
  ok('no basis', s.basis == null, s.basis);
}

console.log('\nblueMushroomCount: counts blue mushrooms');
{
  const c = makeClient({ inventory: [
    { name: 'blue mushroom', count: 3 },
    { name: 'mace', count: 1 },
  ]});
  ok('count is 3', blueMushroomCount(c) === 3, String(blueMushroomCount(c)));
}
{
  const c = makeClient({ inventory: [] });
  ok('zero with no mushrooms', blueMushroomCount(c) === 0);
}

console.log('\nequippedWeapon: finds an equipped weapon');
{
  const c = makeClient({ equipped: [{ id: 10, name: 'mace' }] });
  const w = equippedWeapon(c);
  ok('finds mace', w?.name === 'mace', JSON.stringify(w));
}
{
  const c = makeClient({ equipped: [] });
  const w = equippedWeapon(c);
  ok('null when bare-handed', w === null, JSON.stringify(w));
}

console.log('\nfindZapSpell: finds the zap spell');
{
  const c = makeClient({ spells: [{ id: 5, name: 'zap' }, { id: 6, name: 'relay' }] });
  const z = findZapSpell(c);
  ok('finds zap', z?.id === 5, JSON.stringify(z));
}
{
  const c = makeClient({ spells: [{ id: 6, name: 'relay' }] });
  const z = findZapSpell(c);
  ok('null when no zap', z === null, JSON.stringify(z));
}

console.log('\nshouldCastZap: the decision logic');
{
  // Enchantment down, has spell + mushrooms -> cast
  const c = makeClient({
    events: [],
    inventory: [{ name: 'blue mushroom', count: 2 }],
    equipped: [{ id: 10, name: 'mace' }],
    spells: [{ id: 5, name: 'zap' }],
  });
  const r = shouldCastZap(c);
  ok('should cast (down + mushrooms + spell)', r.shouldCast === true, JSON.stringify(r));
}
{
  // Enchantment already active -> do not cast
  const c = makeClient({
    events: [{ seq: 1, kind: 'message', text: 'Sparks jump and crackle from your fingertips.', at: Date.now() - 1000 }],
    inventory: [{ name: 'blue mushroom', count: 2 }],
    spells: [{ id: 5, name: 'zap' }],
  });
  const r = shouldCastZap(c);
  ok('do not cast (already active)', r.shouldCast === false, JSON.stringify(r));
}
{
  // No blue mushrooms -> do not cast
  const c = makeClient({
    events: [],
    inventory: [{ name: 'mace', count: 1 }],
    spells: [{ id: 5, name: 'zap' }],
  });
  const r = shouldCastZap(c);
  ok('do not cast (no mushrooms)', r.shouldCast === false, JSON.stringify(r));
}
{
  // No zap spell -> do not cast
  const c = makeClient({
    events: [],
    inventory: [{ name: 'blue mushroom', count: 2 }],
    spells: [{ id: 6, name: 'relay' }],
  });
  const r = shouldCastZap(c);
  ok('do not cast (no spell)', r.shouldCast === false, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
