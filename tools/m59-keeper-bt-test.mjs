#!/usr/bin/env node
// m59-keeper-bt-test.mjs -- tests for the BT keeper (simplified)

import { BTKeeper } from './m59-keeper-bt.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log('\nBTKeeper:');
{
  const mockSession = {
    live: true,
    client: {
      vitals: () => ({
        health: { value: 100, max: 100 },
        vigor: { value: 50, max: 200 }
      }),
      inventory: [],
      rsc: { get: () => '' }
    },
    world: { room: { num: 123, name: 'Test Room' } }
  };
  const policy = { hunt: 'giant rat', vigorCeiling: 200 };
  const keeper = new BTKeeper(mockSession, policy);
  
  check('keeper is created', keeper !== null && keeper !== undefined);
  check('keeper has a tick method', typeof keeper.tick === 'function');
  check('keeper has a start method', typeof keeper.start === 'function');
  check('keeper has a stop method', typeof keeper.stop === 'function');
  check('keeper has a purse method', typeof keeper.purse === 'function');
  check('keeper has a larder method', typeof keeper.larder === 'function');
}

console.log('\nBTKeeper.purse:');
{
  const mockSession = {
    live: true,
    client: {
      vitals: () => ({
        health: { value: 100, max: 100 },
        vigor: { value: 150, max: 200 }
      }),
      inventory: [
        { nameRsc: 1, amount: 100 },
        { nameRsc: 2, amount: 50 }
      ],
      rsc: { get: (rsc) => rsc === 1 ? 'shilling' : '' }
    },
    world: { room: { num: 123, name: 'Test Room' } }
  };
  const policy = {};
  const keeper = new BTKeeper(mockSession, policy);
  
  const purse = keeper.purse();
  check('purse returns 100 (only counts shillings)', purse === 100);
}

console.log('\nBTKeeper.larder:');
{
  const mockSession = {
    live: true,
    client: {},
    world: { room: { num: 123, name: 'Test Room' } }
  };
  const policy = {};
  const keeper = new BTKeeper(mockSession, policy);
  
  const larder = keeper.larder(mockSession.client);
  check('larder returns an array', Array.isArray(larder));
  check('larder is empty by default', larder.length === 0);
}

console.log('\nBTKeeper tree structure:');
{
  const mockSession = {
    live: true,
    client: {
      vitals: () => ({
        health: { value: 100, max: 100 },
        vigor: { value: 150, max: 200 }
      }),
      inventory: [],
      rsc: { get: () => '' }
    },
    world: { room: { num: 123, name: 'Test Room' } }
  };
  const policy = { hunt: 'giant rat', vigorCeiling: 200 };
  const keeper = new BTKeeper(mockSession, policy);
  
  const tree = keeper._getRootTree();
  check('root tree is created', tree !== null && tree !== undefined);
  check('root tree has a tick method', typeof tree.tick === 'function');
  check('root tree is a Selector', tree._name === 'Selector');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
