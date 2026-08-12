#!/usr/bin/env node
// Offline parser and allow-list tests for the narrow faction-join surface.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factionAssignment, factionJoinConfirmed, factionJoinSpec, factionOfferAllowed,
  factionFromProfile, visibleTokenFromProfile, soldierAssignment, soldierFromInventory,
  isCouncilToken, COUNCIL_TOKEN_DESTINATIONS }
  from './m59-factions.mjs';
import { FactionStatusCache } from './m59-faction-status.mjs';

assert.equal(factionJoinSpec('Jonas').room, 371);
assert.equal(factionJoinSpec('Princess').leader, 'Princess Kateriina');

assert.deepEqual(factionAssignment('duke', [
  'Duke Akardius says, "Bring me a ruby before the hour is out."',
]), { item: 'ruby', target: 'Duke Akardius', room: 952 });

assert.deepEqual(factionAssignment('princess', [
  'Princess Kateriina asks that you deliver this official letter to Lady Aftyn.',
]), { item: 'letter', target: 'Lady Aftyn', room: 205 });

assert.deepEqual(factionAssignment('rebel', [
  "Jonas D'Accor says, \"Bring me a knight's shield.\"",
]), { item: "knight's shield", target: "Jonas D'Accor", room: 371 });

assert.equal(factionOfferAllowed('rebel', {
  item: 'scimitar', target: "Jonas D'Accor",
}).room, 371);
assert.equal(factionOfferAllowed('rebel', { item: 'plate armor', target: 'Herbutte' }), null);
assert.equal(factionJoinConfirmed(['Your name is entered on the roll of membership.']), true);
assert.equal(factionJoinConfirmed(['The item is not accepted.']), false);

assert.equal(factionFromProfile('Firmly loyal to Princess Kateriina.'), 'princess');
assert.equal(factionFromProfile('A freedom fighter supporting Jonas.'), 'rebel');
assert.equal(factionFromProfile('Not a court vassal, yet affected by the Meridian Council.'), 'neutral');
assert.equal(factionFromProfile('He hailed from Cor Noth less than a year.'), 'neutral');
assert.equal(factionFromProfile(null), 'unknown');
assert.equal(soldierFromInventory('rebel', ['shield of the rebel militia']), true);
assert.deepEqual(soldierAssignment('rebel', [
  "Jonas asks you to defeat a soldier of the Princess' army.",
]), { target: "soldier of the Princess' army", rooms: [593, 583, 603], stage_index: 0 });
assert.equal(visibleTokenFromProfile('She is holding a jade cat token.'), 'jade cat token');
assert.equal(isCouncilToken('demon skull token'), true);
assert.deepEqual(COUNCIL_TOKEN_DESTINATIONS['crystal sphere token'],
  { councilor: 'Esseldi', room: 526 });

const dir = mkdtempSync(join(tmpdir(), 'm59-faction-cache-'));
try {
  const cache = new FactionStatusCache({ dir, now: () => 1234 });
  cache.observe('Miss Piggy', 'Firmly loyal to Princess Kateriina.',
    [{ name: "shield of the Princess' army" }]);
  assert.deepEqual(cache.read('Miss Piggy'), { character: 'Miss Piggy', faction: 'princess',
    soldier: true, observed_at: 1234, source: 'player-profile' });

  // A MEMBERSHIP THAT CHANGED IS RECORDED. This is the case the broker used to be unable
  // to reach at all: it short-circuited on any faction other than 'unknown', so a
  // character seen once as neutral answered neutral for ever however it had changed.
  cache.observe('Miss Piggy', 'A freedom fighter supporting Jonas.', []);
  assert.equal(cache.read('Miss Piggy').faction, 'rebel');
  assert.equal(cache.read('Miss Piggy').soldier, false, 'and the soldier flag follows it down');

  // A READING THAT SAYS NOTHING MUST NOT ERASE ONE THAT SAID SOMETHING. Empty profile text
  // is the server declining to answer, not a resignation, and the two are the same value
  // and opposite facts. Overwriting is the dangerous direction — the faction-games strategy
  // fights on this — so the stale-but-true reading survives a blank look.
  cache.observe('Miss Piggy', '', []);
  assert.equal(cache.read('Miss Piggy').faction, 'rebel', 'a blank look does not disarm a rebel');
  assert.equal(cache.read('Miss Piggy').observed_at, 1234,
    'and the clock is untouched, so the next read still treats it as old and looks again');

  // But a character nobody has ever observed stays unknown rather than being invented, and
  // absent membership must never be presented as confirmed neutrality.
  cache.observe('Nobody', '', []);
  assert.equal(cache.read('Nobody').faction, 'unknown');

  // `ageOf` owns the clock and nothing else: staleness is the caller's policy.
  const clock = { t: 5000 };
  const aged = new FactionStatusCache({ dir, now: () => clock.t });
  assert.equal(aged.ageOf('Miss Piggy'), 5000 - 1234);
  assert.equal(aged.ageOf('never-seen'), null, 'no reading is not an age of zero');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log('factions: join, membership, soldier, and token assertions passed');
