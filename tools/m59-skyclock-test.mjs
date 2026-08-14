#!/usr/bin/env node
// READING THE TIME OFF THE SUN.
//
// The assertions worth keeping are the ones that fail in the dangerous direction: an hour
// that is wrong reads exactly like an hour that is right, and the whole fleet's night
// shift is timed off it. A silently wrong clock sends a shift to stand in an empty
// graveyard, or leaves it hunting frogmen through the only window it had.

import assert from 'node:assert/strict';
import { hourFromSunAngle, sunHeightAt, moonDayFromAngle, phaseFromSun, isFresh,
         graveyardOpenAt, GRAVEYARD_HOURS, GAME_HOUR_MS, STALE_MS } from './m59-skyclock.mjs';

// --- the inversion, against the kod's own formula --------------------------------
{
  // sun.kod:53 — piAngle = ((iHour + 19) mod 24) * 130
  for (let hour = 0; hour < 24; hour++) {
    const angle = ((hour + 19) % 24) * 130;
    assert.equal(hourFromSunAngle(angle), hour, `hour ${hour} must round-trip through ${angle}`);
  }
  // Noon is the high point, which is the independent check that the mapping is not
  // rotated: the height formula peaks at 13 and the angle formula has to agree.
  assert.equal(sunHeightAt(13), 420);
  assert.ok(sunHeightAt(1) < sunHeightAt(13));
  assert.equal(sunHeightAt(2), -200, 'the floor holds');
}

// --- the moon is refused as a sun ------------------------------------------------
{
  // THE FAILURE THIS PREVENTS IS SEVENTEEN HOURS WRONG. moon.kod:100 adds 200*(day mod 20)
  // to a different hour offset, so a moon packet read as a sun gives a plausible hour that
  // is simply not the time. Every legal sun angle is an exact multiple of 130; most moon
  // angles are not, and the ones that are fall outside the 24-step range.
  let refused = 0, total = 0;
  for (let hour = 0; hour < 24; hour++) {
    for (let day = 0; day < 20; day++) {
      const moon = ((hour + 5) % 24) * 130 + 200 * day;
      total += 1;
      const read = hourFromSunAngle(moon);
      if (read === null) { refused += 1; continue; }
      // If it was not refused it must at least not be claiming to be a different hour
      // than the moon's own — the only accepted cases are where the two formulas collide.
      assert.equal(moon % 130, 0);
    }
  }
  assert.ok(refused / total > 0.7, `most moon angles must be refused outright (was ${refused}/${total})`);
  assert.equal(hourFromSunAngle(-130), null);
  assert.equal(hourFromSunAngle(24 * 130), null, 'past a full circle is not an hour');
  assert.equal(hourFromSunAngle('nonsense'), null);
}

// --- the day falls out of the moon once the hour is known ------------------------
{
  for (let hour = 0; hour < 24; hour += 7) {
    for (const day of [0, 3, 19]) {
      const moon = ((hour + 5) % 24) * 130 + 200 * day;
      assert.equal(moonDayFromAngle(moon, hour), day);
    }
  }
  // A disagreement produces null rather than an invented day.
  assert.equal(moonDayFromAngle(7, 3), null);
  assert.equal(moonDayFromAngle(1000, null), null);
}

// --- the window is the kod's window ----------------------------------------------
{
  // tosgrave.kod:65 — `if iHour < 5 or iHour > 21 { propagate; }`, and the propagate is
  // what creates monsters. Seven hours of twenty-four; at five real minutes an hour that
  // is the 35-minutes-in-120 the fleet works from.
  const open = [...Array(24).keys()].filter(graveyardOpenAt);
  assert.deepEqual(open.sort((a, b) => a - b), [...GRAVEYARD_HOURS].sort((a, b) => a - b));
  assert.equal(open.length, 7);
  assert.equal(open.length * GAME_HOUR_MS, 35 * 60_000);
  // The boundaries specifically, because an off-by-one here is a whole game hour.
  assert.equal(graveyardOpenAt(21), false);
  assert.equal(graveyardOpenAt(22), true);
  assert.equal(graveyardOpenAt(4), true);
  assert.equal(graveyardOpenAt(5), false);
  assert.equal(graveyardOpenAt(null), false, 'no hour is not an open graveyard');
}

// --- the phase, and extrapolation ------------------------------------------------
{
  const at = 1_000_000_000_000;
  // Read at the moment hour 22 began: the window has its whole 35 minutes left.
  const opening = phaseFromSun(22, { at, now: at });
  assert.equal(opening.night, true);
  assert.equal(opening.closes_in_ms, 35 * 60_000);
  assert.equal(opening.opens_in_ms, null, 'an open window does not also report an opening');

  // Midday: 22 is nine hours away.
  const noon = phaseFromSun(13, { at, now: at });
  assert.equal(noon.night, false);
  assert.equal(noon.opens_in_ms, 9 * GAME_HOUR_MS);

  // EXTRAPOLATION IS THE POINT, not a fallback. One game hour later the hour has advanced
  // by exactly one and the countdown has come down by exactly one hour.
  const later = phaseFromSun(13, { at, now: at + GAME_HOUR_MS });
  assert.equal(later.hour, 14);
  assert.equal(later.opens_in_ms, 8 * GAME_HOUR_MS);

  // Part-way into an hour, the countdown is not rounded to whole hours — a shift timing a
  // 90-second walk against a 35-minute window cannot use a five-minute-granular clock.
  const part = phaseFromSun(13, { at, now: at + GAME_HOUR_MS + 60_000 });
  assert.equal(part.hour, 14);
  assert.equal(part.opens_in_ms, 8 * GAME_HOUR_MS - 60_000);
  assert.equal(part.into_hour_ms, 60_000);

  // It wraps, rather than running off the end of the day.
  assert.equal(phaseFromSun(23, { at, now: at + 2 * GAME_HOUR_MS }).hour, 1);
  assert.equal(phaseFromSun(23, { at, now: at + 2 * GAME_HOUR_MS }).night, true);

  assert.equal(phaseFromSun(null), null);
}

// --- a reading is a calibration, so it lasts ------------------------------------
{
  // This was one game hour and the feature was useless between logins because of it.
  assert.ok(STALE_MS > GAME_HOUR_MS * 12, 'a reading outlives the hour it was taken in');
  const now = 1_000_000_000_000;
  assert.equal(isFresh(now - 6 * 3600_000, now), true);
  assert.equal(isFresh(now - 13 * 3600_000, now), false, 'but not for ever — a server restart moves the hour');
  assert.equal(isFresh(null, now), false);
}

console.log('skyclock: sun inversion, moon rejection, the undead window, and extrapolation passed');
