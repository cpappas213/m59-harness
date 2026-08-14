#!/usr/bin/env node
import {
  applyFightAboveVigor,
  Autopilot,
  effectiveFightVigor,
  effectiveTravelHoldVigor,
  STRATEGIES,
} from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failed++;
};

console.log('--- explicit fight vigor overrides strategy provisioning ---');
{
  const policy = {
    strategy: 'baseline',
    fightAboveVigor: 80,
  };
  applyFightAboveVigor(policy, 80);

  ok('the legacy status field remains truthful', policy.fightAboveVigor === 80);
  ok('the effective provisioning floor is the explicit threshold', policy.vigorFloor === 80);
  ok('the strategy ceiling cannot keep it digesting toward 200', policy.vigorCeiling === 80,
     `baseline default is ${STRATEGIES.baseline.vigorCeiling}`);
  ok('carried food cannot raise an explicit rested floor',
     effectiveFightVigor(policy, STRATEGIES.baseline) === 80);
}

console.log('\n--- food behavior is caller-owned ---');
{
  const keeper = new Autopilot({});
  ok('paid food acquisition defaults off', keeper.policy.buyFood === false);
  ok('food consumption defaults off', keeper.policy.eatBeforeFighting === false);
  ok('the default fight floor is naturally rest-reachable', keeper.fightFloor() === 80);
  ok('the default travel hold gate is naturally rest-reachable',
     effectiveTravelHoldVigor(keeper.policy) === 80);
  ok('an explicit travel hold gate remains caller-owned',
     effectiveTravelHoldVigor({ travelHoldVigor: 120 }) === 120);
  applyFightAboveVigor(keeper.policy, 140);
  const result = await keeper.provision(
    STRATEGIES.baseline,
    { vigor: { value: 80, scale_max: 200 } },
  );
  ok('a high threshold alone does not authorize eating or cooking', result === false);
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
console.log('\n15 passed');
