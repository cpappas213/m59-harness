#!/usr/bin/env node
// THE PUBLIC KEEPER ARGUMENTS, AND WHICH END OF THE BAND EACH ONE OWNS.
//
// `fight_above_vigor` is the FLOOR. It must beat the selected strategy, because every
// strategy in the table declares `vigorFloor` and fightFloor() reads the legacy field
// last — which made the advertised broker argument decide nothing at all.
//
// It must NOT become the ceiling. See applyFightAboveVigor: a ceiling equal to the
// floor collapses provisioning's band into a threshold and gives up the health
// regeneration the food was bought for. shouldWaitForProvision is what stops a fed
// character idling in an inn, and it is pinned in m59-combat-test.mjs.
import {
  applyFightAboveVigor,
  Autopilot,
  effectiveFightVigor,
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
    fightAboveVigor: 100,
  };
  applyFightAboveVigor(policy, 100);

  ok('the legacy status field remains truthful', policy.fightAboveVigor === 100);
  ok('the effective provisioning floor is the explicit threshold', policy.vigorFloor === 100);
  ok('and the strategy ceiling is left where it was — the band is not collapsed',
     policy.vigorCeiling === undefined,
     `baseline default is ${STRATEGIES.baseline.vigorCeiling}`);
  ok('carried food cannot silently raise an explicit floor',
     effectiveFightVigor(policy, STRATEGIES.baseline) === 100);
}

console.log('\n--- food behavior is caller-owned ---');
{
  const keeper = new Autopilot({});
  ok('paid food acquisition defaults off', keeper.policy.buyFood === false);
  ok('food consumption defaults off', keeper.policy.eatBeforeFighting === false);
  ok('the default fight floor is naturally rest-reachable', keeper.fightFloor() === 80);
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
console.log('\n13 passed');
