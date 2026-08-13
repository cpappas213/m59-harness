#!/usr/bin/env node
// Offline parser and allow-list tests for the narrow faction-join surface.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factionAssignment, factionJoinConfirmed, factionJoinSpec, factionOfferAllowed,
  factionFromProfile, visibleTokenFromProfile, soldierAssignment, soldierFromInventory,
  isCouncilToken, COUNCIL_TOKEN_DESTINATIONS,
  isLoyaltyWarning, isLoyaltyLost, factionLoyaltySpec, loyaltyAssignment,
  loyaltyOfferAllowed, loyaltyRenewalConfirmed, loyaltyFailed, loyaltyDebt,
  withinQuestReach, LOYALTY_TRIGGER, FACTION_LOYALTY_GRACE_MS }
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
    soldier: true, observed_at: 1234, source: 'player-profile', loyalty: null },
    'a character nobody has warned carries `loyalty: null` — no lapse, not an empty one');

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

// ---------------------------------------------------------------------------
// LOYALTY SERVICE — the recurring obligation, not the one-off join.
// ---------------------------------------------------------------------------

// The sentence itself, as `player_faction_time` (player.kod:160) reaches a client: the
// `~I` is stripped and the resource wraps across two source lines, so the match is on
// either half rather than on the whole literal.
const WARNING = 'Your liege is no longer convinced of your loyalty. ' +
  'You should visit your liege at court again.';
assert.equal(isLoyaltyWarning(WARNING), true);
assert.equal(isLoyaltyWarning('You should visit your liege at court again.'), true,
  'the resource wraps across two lines; either half must still identify it');
assert.equal(isLoyaltyWarning('You suddenly feel a little tougher.'), false);

// Expulsion (`player_unfactioned`, player.kod:167) is a DIFFERENT fact from the warning
// and must never be folded into it: one starts a clock, the other says it ran out.
const LOST = 'Your liege has no use for one such as you, lacking in prowess or devotion.  ' +
  'Your name has been stricken from the roll of membership.';
assert.equal(isLoyaltyLost(LOST), true);
assert.equal(isLoyaltyWarning(LOST), false, 'the expulsion is not another warning');
assert.equal(isLoyaltyLost(WARNING), false);

// ONE WORD, AND IT IS THE SAME WORD FOR ALL THREE LIEGES. Nodes 5, 8 and 197 all carry
// `duke_standard1_trigger` (questengine.kod:125); the constant's name is a source quirk.
assert.equal(LOYALTY_TRIGGER, 'loyalty');

// FOUR HOURS: FACTION_RESIGN_TIME (86400) - FACTION_WARN_TIME (72000), blakston.khd:2325.
assert.equal(FACTION_LOYALTY_GRACE_MS, 4 * 3600 * 1000);

// LONGEST NAME FIRST. "long sword" contains "sword" and "knight's shield" contains
// "shield"; matching the shorter first would send a character to hand over a possession
// the recipient never asked for and does not give back.
assert.deepEqual(loyaltyAssignment('rebel', [
  'Ah, Miss Piggy, my fellow freedom fighter.  My troops have need of more equipment.  ' +
  'Bring me a long sword and I will not forget your loyalty.',
]), { item: 'long sword', target: "Jonas D'Accor", room: 371, time_limit_ms: 3600_000 });

assert.deepEqual(loyaltyAssignment('princess', [
  'Ah, Miss Piggy, my loyal servant.  Wouldst thou be so kind as to deliver an ' +
  'official letter to Lady Aftyn?  I would be most grateful.',
]), { item: 'letter', target: 'Lady Aftyn', aliases: undefined, room: 205,
      time_limit_ms: 3600_000 });

// A reply nobody anticipated is null. An errand invented from an unrecognised noun would
// walk a character across the world to offer the wrong thing.
assert.equal(loyaltyAssignment('rebel', ['Jonas ignores you.']), null);
assert.equal(loyaltyAssignment('rebel', []), null);

// THE DUKE IS RECOGNISED AND NOT AUTOMATED, and says which of the two it is. His middle
// node names a different townsperson every time (questengine.kod:2479).
assert.equal(factionLoyaltySpec('duke').automated, false);
assert.equal(factionLoyaltySpec('rebel').automated, undefined,
  'silence on `automated` means automated; only the refusal is declared');
assert.equal(loyaltyAssignment('duke', ['I require you to collect all taxes due from Meidei.']), null);

// Offering is an ALLOWLIST, like every other offer surface here.
assert.deepEqual(loyaltyOfferAllowed('rebel', { item: 'scimitar', target: "Jonas D'Accor" }),
  { item: 'scimitar', target: "Jonas D'Accor", room: 371 });
assert.equal(loyaltyOfferAllowed('rebel', { item: 'mace', target: "Jonas D'Accor" }), null,
  'a mace is not on node 198 cargo list');
assert.equal(loyaltyOfferAllowed('rebel', { item: 'long sword', target: 'Skivlat' }), null,
  'the right item to the wrong recipient is still a gift');
assert.equal(loyaltyOfferAllowed('princess', { item: 'letter', target: 'Xiana' }).room, 48,
  'an alias resolves to the same recipient');

// A RENEWAL NEVER SAYS "ENTERED ON THE ROLL OF MEMBERSHIP", because the character was on
// it the whole time. Reusing the join confirmation would report every success as unproven.
assert.equal(loyaltyRenewalConfirmed(['Ah, excellent.  I will definitely put this to good use.']), true);
assert.equal(factionJoinConfirmed(['Ah, excellent.  I will definitely put this to good use.']), false);
assert.equal(loyaltyFailed(['Subject: You are not a true rebel']), true);
assert.equal(loyaltyRenewalConfirmed(['Subject: You are not a true rebel']), false);

// FIVE SQUARES. `CheckCompletionCriteria` refuses beyond `Q_NPC_CLOSE_ENOUGH`
// (questnode.kod:650) and says nothing, so being deaf is indistinguishable from agreeing.
assert.equal(withinQuestReach({ col: 10, row: 10 }, { col: 13, row: 13 }).within, true);
assert.equal(withinQuestReach({ col: 10, row: 10 }, { col: 20, row: 10 }).within, false);
assert.equal(withinQuestReach(null, { col: 1, row: 1 }), null,
  'an unknown position is not a far one');

// --- the debt, and the three ways it is not one ---------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm59-loyalty-'));
  try {
    let now = 1_700_000_000_000;
    const cache = new FactionStatusCache({ dir, now: () => now });
    cache.write('Rebel One', { faction: 'rebel' });
    assert.equal(loyaltyDebt(cache.read('Rebel One'), now), null,
      'membership alone is not a debt');

    cache.noteLoyaltyWarning('Rebel One', { at: now });
    assert.equal(loyaltyDebt(cache.read('Rebel One'), now).due_in_ms, FACTION_LOYALTY_GRACE_MS);

    // THE WARNING REPEATS EVERY TWENTY MINUTES AND IT IS THE SAME DEADLINE. Re-dating on
    // each repeat would push the due time forward for ever, and the character would be
    // expelled while the record still claimed four hours left.
    now += 20 * 60 * 1000;
    cache.noteLoyaltyWarning('Rebel One', { at: now });
    assert.equal(loyaltyDebt(cache.read('Rebel One'), now).due_in_ms,
      FACTION_LOYALTY_GRACE_MS - 20 * 60 * 1000);

    // An ordinary profile read knows nothing about a lapse and must not erase one.
    cache.write('Rebel One', { faction: 'rebel', source: 'player-profile' });
    assert.equal(loyaltyDebt(cache.read('Rebel One'), now).warned_at, now - 20 * 60 * 1000);

    cache.noteLoyaltyServed('Rebel One', { at: now });
    assert.equal(loyaltyDebt(cache.read('Rebel One'), now), null, 'serving clears the debt');

    // A SOLDIER IS WARNED FOR EVER AND NEVER EXPELLED (player.kod:11203 clamps the
    // counter). Reported as a debt with no deadline, not as no debt: the liege did ask.
    cache.write('Soldier', { faction: 'rebel', soldier: true });
    cache.noteLoyaltyWarning('Soldier', { at: now, soldier: true });
    const soldierDebt = loyaltyDebt(cache.read('Soldier'), now);
    assert.equal(soldierDebt.soldier, true);
    assert.equal(soldierDebt.due_at, null, 'a deadline that never arrives is not a deadline');
    assert.equal(soldierDebt.expired, false);

    // Expulsion is OBSERVED, never inferred from the deadline passing.
    cache.write('Doomed', { faction: 'rebel' });
    cache.noteLoyaltyWarning('Doomed', { at: now });
    const late = now + FACTION_LOYALTY_GRACE_MS + 1;
    assert.equal(loyaltyDebt(cache.read('Doomed'), late).expired, true);
    assert.equal(cache.read('Doomed').faction, 'rebel',
      'past the deadline is not the same as thrown out');
    cache.noteLoyaltyLost('Doomed', { at: now });
    assert.equal(cache.read('Doomed').faction, 'neutral');
    assert.equal(loyaltyDebt(cache.read('Doomed'), now), null, 'nothing to serve once out');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('factions: join, membership, soldier, token, and loyalty-service assertions passed');
