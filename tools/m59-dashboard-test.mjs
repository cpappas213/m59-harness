#!/usr/bin/env node
// The fleet board's learning threshold, entirely against a scratch ledger.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-dashboard-test-'));
process.env.M59_LEDGER_DIR = dir;
const { recordSample } = await import('./m59-ledger.mjs');
recordSample([{
  character: 'Tester', level: 20, health: '20/20', mana: '10/10', vigor_of: '200/200',
  room: 'Somewhere', room_num: 1, strategy: 'test', has_weapon: true, has_food: true,
  learning: {
    progress: { target: 'weaponcraft', label: 'Weaponcraft 2', source: 'automatic',
      current_level: 1, next_level: 2, points: 25, example_ability: 'dodge' },
    planned: { configured: 1, ready: 0, next: null },
  },
}]);
const { renderDashboard } = await import('./m59-dashboard.mjs');
const html = renderDashboard({ hours: 1 });
let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
ok('the fleet table names the progression column', /points to next/.test(html));
ok('the target track and level are visible', /Weaponcraft 2/.test(html));
ok('the exact remaining points are visible', /title="next ability: dodge[^>]*">25<\/strong>/.test(html));
ok('the board remains read-only', !/buy_next_planned_skills|api\/planned-learning/.test(html));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
