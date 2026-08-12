#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderHero } from './m59-hero-page.mjs';

const hero = faction_status => renderHero({
  name: 'Tester', agent: 't1', in_game: true, room: { num: 1, name: 'Somewhere' },
  vitals: {}, inventory: [], faction_status,
});

const neutral = hero({ faction: 'neutral', soldier: false, observed_at: 1 });
assert.match(neutral, /class="faction-priority missing"/);
assert.match(neutral, /<strong>No faction<\/strong>/);
assert.match(neutral, /Needs to join a faction/);

const member = hero({ faction: 'rebel', soldier: true, observed_at: Date.now() });
assert.match(member, /class="faction-priority member"/);
assert.match(member, /<strong>The Rebels<\/strong>/);
assert.match(member, /Faction soldier/);

const unknown = hero({ faction: 'unknown', soldier: false, observed_at: null });
assert.match(unknown, /class="faction-priority unknown"/);
assert.match(unknown, /Faction not yet known/);
assert.doesNotMatch(unknown, /Needs to join a faction/);

const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
assert.match(broker, /faction_status:\s*factionStatus/);
assert.match(broker, /factionStatuses\.reconcileInventory\(character, factionInventory\(c\)\)/);

console.log('hero page: prominent member, neutral, and unknown faction states passed');
