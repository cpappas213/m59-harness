// Tests for the behavior tree decomposition of provision()
//
//   node tools/m59-bt-provision-test.mjs

import { 
  checkLarderNode, castNode, checkMoneyNode, 
  withdrawFromBankNode, buyFoodNode, eatNode, provisionTree 
} from './m59-bt-provision.mjs';
import { SUCCESS, FAILURE } from './m59-bt.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log('\ncheckLarderNode:');
{
  const keeper = {
    s: { client: {} },
    larder: () => [{ food: { filling: 50, nutrition: 10 } }]
  };
  const node = checkLarderNode(keeper);
  const bb = {};
  const result = node.tick(bb);
  check('returns SUCCESS when food is found', result === SUCCESS);
  check('sets bb.hasFood to true', bb.hasFood === true);
  check('sets bb.bestFood', bb.bestFood.filling === 50);
}
{
  const keeper = {
    s: { client: {} },
    larder: () => []
  };
  const node = checkLarderNode(keeper);
  const bb = {};
  const result = node.tick(bb);
  check('returns FAILURE when no food', result === FAILURE);
  check('sets bb.hasFood to false', bb.hasFood === false);
}

console.log('\ncastNode:');
{
  const keeper = {
    s: {
      client: {
        spells: [{ name: 'create food', level: 1, mana: 10 }],
        cast: async (spellName, targetRsc) => ({ success: true, spellName, targetRsc })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'create food');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when spell is known and cast', result === SUCCESS);
  check('sets bb.castResult.success to true', bb.castResult?.success === true);
}
{
  const keeper = {
    s: {
      client: {
        spells: [],
        cast: async () => ({ success: true })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'create food');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when spell is not known', result === FAILURE);
  check('sets bb.castResult.reason', bb.castResult?.reason === 'does not know spell');
}
console.log('\ncastNode with self target:');
{
  let castTarget = null;
  const keeper = {
    s: {
      client: {
        me: { rsc: 12345, name: 'TestChar' },
        spells: [{ name: 'heal', level: 1, mana: 15 }],
        cast: async (spellName, targetRsc) => {
          castTarget = targetRsc;
          return { success: true, spellName, targetRsc };
        }
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'heal', 'self');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when casting on self', result === SUCCESS);
  check('sets bb.castResult.target to self', bb.castResult?.target === 'TestChar');
  check('passes self RSC to cast', castTarget === 12345);
}
console.log('\ncastNode with entity target:');
{
  let castTarget = null;
  const keeper = {
    s: {
      client: {
        spells: [{ name: 'zap', level: 1, mana: 20 }],
        cast: async (spellName, targetRsc) => {
          castTarget = targetRsc;
          return { success: true, spellName, targetRsc };
        }
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const target = { rsc: 99999, name: 'TestMonster' };
  const node = castNode(keeper, 'zap', target);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when casting on entity', result === SUCCESS);
  check('sets bb.castResult.target to entity name', bb.castResult?.target === 'TestMonster');
  check('passes entity RSC to cast', castTarget === 99999);
}

console.log('\ncheckMoneyNode:');
{
  const keeper = {
    purse: () => 500
  };
  const node = checkMoneyNode(keeper, 400);
  const bb = {};
  const result = node.tick(bb);
  check('returns SUCCESS when purse >= minAmount', result === SUCCESS);
  check('sets bb.hasMoney to true', bb.hasMoney === true);
}
{
  const keeper = {
    purse: () => 300
  };
  const node = checkMoneyNode(keeper, 400);
  const bb = {};
  const result = node.tick(bb);
  check('returns FAILURE when purse < minAmount', result === FAILURE);
  check('sets bb.hasMoney to false', bb.hasMoney === false);
}

console.log('\nwithdrawFromBankNode:');
{
  const keeper = {
    withdrawForFood: async () => {},
    note: () => {}
  };
  const node = withdrawFromBankNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when withdrawal succeeds', result === SUCCESS);
  check('sets bb.withdrewMoney to true', bb.withdrewMoney === true);
}
{
  const keeper = {
    withdrawForFood: async () => { throw new Error('no bank here'); },
    note: () => {}
  };
  const node = withdrawFromBankNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when withdrawal fails', result === FAILURE);
  check('sets bb.withdrewMoney to false', bb.withdrewMoney === false);
}

console.log('\nbuyFoodNode:');
{
  let larderEmpty = true;
  const keeper = {
    s: { client: {} },  // Add s.client
    buyFoodInTown: async () => { larderEmpty = false; },  // Simulate buying food
    larder: () => larderEmpty ? [] : [{ food: { filling: 50 } }],
    note: () => {}
  };
  const node = buyFoodNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when food is bought', result === SUCCESS);
  check('sets bb.boughtFood to true', bb.boughtFood === true);
}
{
  const keeper = {
    buyFoodInTown: async () => {},
    larder: () => [],
    note: () => {}
  };
  const node = buyFoodNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when no food is bought', result === FAILURE);
  check('sets bb.boughtFood to false', bb.boughtFood === false);
}

console.log('\neatNode:');
{
  const keeper = {
    s: {
      client: {
        eat: async () => ({ ate: ['bread'], vigor: 150 })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    policy: { vigorCeiling: 200 },
    note: () => {}
  };
  const node = eatNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when food is eaten', result === SUCCESS);
  check('sets bb.ate to true', bb.ate === true);
}
{
  const keeper = {
    s: {
      client: {
        eat: async () => ({ ate: [], vigor: 100 })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    policy: { vigorCeiling: 200 },
    note: () => {}
  };
  const node = eatNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when no food is eaten', result === FAILURE);
  check('sets bb.ate to false', bb.ate === false);
}

console.log('\nprovisionTree:');
{
  const keeper = {
    s: { client: {} },
    larder: () => [{ food: { filling: 50, nutrition: 10 } }],
    purse: () => 500,
    withdrawForFood: async () => {},
    buyFoodInTown: async () => {},
    note: () => {},
    policy: { vigorCeiling: 200, walkingMoney: 400 }
  };
  const tree = provisionTree(keeper);
  check('provisionTree returns a tree', tree !== null && tree !== undefined);
  check('tree has a tick method', typeof tree.tick === 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
