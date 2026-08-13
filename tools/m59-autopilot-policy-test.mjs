#!/usr/bin/env node
import { applyFightAboveVigor, STRATEGIES } from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failed++;
};

console.log('--- explicit fight vigor overrides strategy provisioning ---');
{
  const policy = {
    strategy: 'baseline',
    fightAboveVigor: 100,
  };
  applyFightAboveVigor(policy, 100);

  ok('the legacy status field remains truthful', policy.fightAboveVigor === 100);
  ok('the effective provisioning floor is the explicit threshold', policy.vigorFloor === 100);
  ok('the strategy ceiling cannot keep it digesting toward 200', policy.vigorCeiling === 100,
     `baseline default is ${STRATEGIES.baseline.vigorCeiling}`);
}

console.log('\n--- invalid thresholds fail at the broker boundary ---');
for (const value of [undefined, 'not-a-number', Infinity, -1, 201]) {
  let rejected = false;
  try { applyFightAboveVigor({}, value); } catch { rejected = true; }
  ok(`rejects ${String(value)}`, rejected);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\n8 passed');
