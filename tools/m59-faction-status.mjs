// PERSISTED, OBSERVED FACTION MEMBERSHIP.
//
// The server does not push allegiance as a stat. It appears in a player's extra
// profile text, so the broker records that observation by character name. The cache
// is evidence, not an order: desired join goals stay in DUM and never overwrite it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { factionFromProfile, soldierFromInventory } from './m59-factions.mjs';

const safe = value => String(value ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'unknown';

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
        observed_at: Number(value.observed_at) || null, source: value.source || 'player-profile' };
    } catch { return null; }
  }

  write(character, values = {}) {
    const value = { character,
      faction: ['duke', 'princess', 'rebel', 'neutral'].includes(values.faction) ? values.faction : 'unknown',
      soldier: values.soldier === true, observed_at: Number(values.observed_at) || this.now(),
      source: values.source || 'player-profile' };
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

  reconcileInventory(character, items = []) {
    const cached = this.read(character);
    if (!cached) return null;
    const soldier = soldierFromInventory(cached.faction, items);
    return soldier === cached.soldier ? cached : this.write(character, { ...cached, soldier,
      source: soldier ? 'player-profile+inventory' : cached.source });
  }
}
