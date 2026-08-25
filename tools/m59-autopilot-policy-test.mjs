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
import { applyFightAboveVigor, STRATEGIES, reachableFightFloor } from './m59-autopilot.mjs';

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
}

console.log('\n--- invalid thresholds fail at the broker boundary ---');
for (const value of [undefined, 'not-a-number', Infinity, -1, 201]) {
  let rejected = false;
  try { applyFightAboveVigor({}, value); } catch { rejected = true; }
  ok(`rejects ${String(value)}`, rejected);
}

console.log('\n--- the fight floor is capped at what the character can actually reach ---');
// Resting caps at 80 of a 200 bar; vigor above that comes only from food. A floor
// above rest-cap + carried-food is unreachable and would idle the character forever.
//
// The Lee deadlock: baseline floor 140, one mushroom carried (+50). The old empty-larder
// escape hatch never fired (larder non-empty), so the floor stayed 140, but 80+50=130
// < 140 -- unreachable, and the character looped "too tired to start a fight".
ok('a single mushroom raises the reachable floor from the 80 resting cap to 130',
   reachableFightFloor(140, 200, 50) === 130,
   `got ${reachableFightFloor(140, 200, 50)}`);
ok('an empty larder caps the floor at the 80 resting ceiling, not the configured 140',
   reachableFightFloor(140, 200, 0) === 80,
   `got ${reachableFightFloor(140, 200, 0)}`);
ok('a well-stocked larder keeps the full 140 floor (food can bridge it)',
   reachableFightFloor(140, 200, 200) === 140,
   `got ${reachableFightFloor(140, 200, 200)}`);
ok('a floor already below the resting cap is never raised by food',
   reachableFightFloor(80, 200, 50) === 80,
   `got ${reachableFightFloor(80, 200, 50)}`);
ok('a floor above the cap with no food drops to the cap (100 -> 80)',
   reachableFightFloor(100, 200, 0) === 80,
   `got ${reachableFightFloor(100, 200, 0)}`);
ok('the resting cap scales with the vigor bar, not a hard-coded 200',
   reachableFightFloor(140, 100, 50) === 90,   // 0.4*100=40 + 50 = 90 -> min(140,90)=90
   `got ${reachableFightFloor(140, 100, 50)}`);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\n14 passed');
