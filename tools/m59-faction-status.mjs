// PERSISTED, OBSERVED FACTION MEMBERSHIP.
//
// The server does not push allegiance as a stat. It appears in a player's extra
// profile text, so the broker records that observation by character name. The cache
// is evidence, not an order: desired join goals stay in DUM and never overwrite it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { factionFromProfile, soldierFromInventory, FACTION_LOYALTY_GRACE_MS }
  from './m59-factions.mjs';

const safe = value => String(value ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'unknown';

// WARNED, SERVED, LOST — three states, and the middle one is the only one that is not
// evidence of something the server said. `warned_at` is the sentence landing;
// `served_at` is a renewal we watched succeed; `lost_at` is the expulsion announcing
// itself. `due_at` is arithmetic on `warned_at` and is carried explicitly rather than
// recomputed by every reader, because a grace period with two homes is a grace period
// with two answers.
const normaliseLoyalty = value => {
  if (!value || typeof value !== 'object') return null;
  const warnedAt = Number(value.warned_at) || null;
  const servedAt = Number(value.served_at) || null;
  const lostAt = Number(value.lost_at) || null;
  if (!warnedAt && !servedAt && !lostAt) return null;
  return {
    warned_at: warnedAt,
    due_at: Number(value.due_at) || (warnedAt ? warnedAt + FACTION_LOYALTY_GRACE_MS : null),
    served_at: servedAt,
    lost_at: lostAt,
    // A soldier is warned and never expelled (player.kod:11203 clamps the counter while a
    // SoldierShield is worn), so the deadline the warning implies never arrives for one.
    // Recorded at the moment of the warning rather than derived later, because the shield
    // can come off between the warning and whoever reads this.
    soldier_at_warning: value.soldier_at_warning === true,
  };
};

export class FactionStatusCache {
  constructor({ dir = 'substrate/faction-status', now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.now = now;
  }

  path(character) { return join(this.dir, `${safe(character)}.json`); }

  read(character) {
    const path = this.path(character);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value?.character !== character || !['duke', 'princess', 'rebel', 'neutral', 'unknown'].includes(value?.faction))
        return null;
      return { character, faction: value.faction, soldier: value.soldier === true,
        observed_at: Number(value.observed_at) || null, source: value.source || 'player-profile',
        loyalty: normaliseLoyalty(value.loyalty) };
    } catch { return null; }
  }

  // A WRITE THAT DOES NOT MENTION LOYALTY MUST NOT FORGET IT. Every existing caller —
  // the login profile read, the inventory reconcile, the join confirmation — writes the
  // whole record from what it happens to know, and none of them knows anything about a
  // lapse. Without this carry-forward the ordinary profile read a minute after the
  // warning would erase the only notice the server will ever send, and the character
  // would be expelled four hours later with nothing on disk explaining why. `null` is how
  // a caller says it means to clear it.
  write(character, values = {}) {
    if (values.loyalty === undefined) values = { ...values, loyalty: this.read(character)?.loyalty ?? null };
    const value = { character,
      faction: ['duke', 'princess', 'rebel', 'neutral'].includes(values.faction) ? values.faction : 'unknown',
      soldier: values.soldier === true, observed_at: Number(values.observed_at) || this.now(),
      source: values.source || 'player-profile',
      loyalty: normaliseLoyalty(values.loyalty) };
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(character), tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, path);
    return value;
  }

  // A READING THAT SAYS NOTHING MUST NOT ERASE ONE THAT SAID SOMETHING.
  //
  // `factionFromProfile` answers 'unknown' for one case only — empty profile text — and
  // that is the server declining to tell us, not the character resigning its faction. The
  // two are the same value and opposite facts. Overwriting is the dangerous direction:
  // membership is observed rarely and acted on (the faction-games strategy fights on it),
  // so a blank look during a rejoin could quietly disarm a unit that is still a rebel.
  //
  // Leaving a stale-but-true reading in place is the safe failure, and `observed_at` is
  // untouched so the next read still treats it as old and looks again.
  observe(character, extra, items = []) {
    const faction = factionFromProfile(extra);
    if (faction === 'unknown') {
      const cached = this.read(character);
      if (cached && cached.faction !== 'unknown') return cached;
    }
    return this.write(character, { faction,
      soldier: soldierFromInventory(faction, items), source: 'player-profile' });
  }

  // How old a reading is, in ms, or null when there has never been one. Staleness is the
  // caller's policy — this only owns the clock.
  ageOf(character) {
    const cached = this.read(character);
    return cached?.observed_at ? Math.max(0, this.now() - cached.observed_at) : null;
  }

  // THE SENTENCE ARRIVED. Written down immediately, because the server sends it once.
  //
  // Re-warning is normal and must not restart the clock silently: the timer fires again
  // on every subsequent tick above the warn threshold, so a character that is going to be
  // expelled hears this repeatedly, all on the SAME deadline. The first warning of a
  // lapse is what dates it; a later one only refreshes the soldier flag.
  noteLoyaltyWarning(character, { at = this.now(), soldier = false } = {}) {
    const cached = this.read(character);
    const already = cached?.loyalty;
    const continuing = already?.warned_at && !already.served_at && !already.lost_at;
    const loyalty = continuing
      ? { ...already, soldier_at_warning: soldier === true }
      : { warned_at: at, due_at: at + FACTION_LOYALTY_GRACE_MS, served_at: null,
          lost_at: null, soldier_at_warning: soldier === true };
    return this.write(character, { ...(cached ?? {}), source: cached?.source ?? 'loyalty-warning',
      soldier: cached?.soldier ?? soldier === true, loyalty });
  }

  noteLoyaltyServed(character, { at = this.now() } = {}) {
    const cached = this.read(character);
    return this.write(character, { ...(cached ?? {}),
      loyalty: { ...(cached?.loyalty ?? {}), warned_at: cached?.loyalty?.warned_at ?? null,
        served_at: at, lost_at: null } });
  }

  // Expulsion is observed, not inferred. The deadline passing means the deadline passed;
  // only `player_unfactioned` means the character is out, and it is the server saying so.
  noteLoyaltyLost(character, { at = this.now() } = {}) {
    const cached = this.read(character);
    return this.write(character, { ...(cached ?? {}), faction: 'neutral', soldier: false,
      source: 'unfactioned-message', observed_at: at,
      loyalty: { ...(cached?.loyalty ?? {}), lost_at: at } });
  }

  reconcileInventory(character, items = []) {
    const cached = this.read(character);
    if (!cached) return null;
    const soldier = soldierFromInventory(cached.faction, items);
    return soldier === cached.soldier ? cached : this.write(character, { ...cached, soldier,
      source: soldier ? 'player-profile+inventory' : cached.source });
  }
}
