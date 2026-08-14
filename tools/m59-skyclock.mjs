#!/usr/bin/env node
// WHAT TIME IT IS, READ OFF THE SKY INSTEAD OF GUESSED FROM AN ANCHOR.
//
//   node tools/m59-skyclock.mjs            # what the last sky reading says
//   node tools/m59-skyclock.mjs --json
//
// The server creates a Sun and a Moon as background objects (`system.kod:3512`) and, on
// EVERY GAME HOUR, both recompute their position and push it to every logged-on user
// (`sun.kod:44`, `moon.kod:89`) as BP_ADD_BG_OVERLAY / BP_CHANGE_BG_OVERLAY. A game hour
// is five real minutes, so this arrives twelve times an hour whether anybody asked or not.
//
// THE SUN'S ANGLE IS THE GAME HOUR, EXACTLY. `sun.kod:53` is
//
//     piAngle = ((iHour + 19) mod 24) * 130
//
// which is twenty-four discrete values 130 apart and nothing else — so the hour comes
// straight back out of it with no estimation, no drift and no anchor. That matters
// because the thing this replaces was a person watching a graveyard fill up and typing
// the time in: `m59-dayclock.mjs` is arithmetic on real time, correct only while its
// anchor is, and silently wrong across a server restart or a clock change.
//
// The moon carries MORE, and is the reason both are parsed rather than just the sun:
//
//     piAngle  = ((iHour + 5) mod 24) * 130 + 200 * (iDay mod 20)      moon.kod:100
//     piHeight = 400 - Abs(300 - iDay) - 6*(iHour - 1)^2               moon.kod:105
//     animation group = lunar phase, on a 20-day cycle                 moon.kod:52
//
// With the hour known from the sun, `iDay mod 20` falls out of the moon's angle. Nothing
// in this fleet needs the day yet; it is derived because it is free once the packet is
// parsed, and because the alternative — deriving it later from a different source — is
// how two answers to one question get into a codebase.

const ANGLE_STEP = 130;
const HOURS = 24;

// Sun angle -> hour. `((h + 19) mod 24)` inverts to `((a + 5) mod 24)`.
export function hourFromSunAngle(angle) {
  const a = Number(angle);
  if (!Number.isFinite(a) || a < 0) return null;
  // A REMAINDER MEANS THIS IS NOT THE SUN. Every legal sun angle is an exact multiple of
  // 130; the moon's is not, because its day term adds multiples of 200. Refusing here is
  // what stops a moon packet being read as an hour seventeen hours wrong.
  if (a % ANGLE_STEP !== 0) return null;
  const step = a / ANGLE_STEP;
  if (step >= HOURS) return null;
  return (step + 5) % HOURS;
}

/** What the sun's height should be at this hour — for corroboration, not derivation. */
export const sunHeightAt = hour => Math.max(-200, 420 - 7 * (hour - 13) ** 2);

/**
 * `iDay mod 20` from the moon, given the hour the sun already established.
 *
 * Returns null rather than a guess when the arithmetic does not land on a whole day:
 * that means the two bodies disagree, which is a parsing bug or a packet from something
 * that is neither, and inventing a day from it would be worse than having none.
 */
export function moonDayFromAngle(angle, hour) {
  const a = Number(angle);
  if (!Number.isFinite(a) || hour == null) return null;
  const rest = a - ((hour + 5) % HOURS) * ANGLE_STEP;
  if (rest < 0 || rest % 200 !== 0) return null;
  const day = rest / 200;
  return day >= 0 && day < 20 ? day : null;
}

// THE UNDEAD WINDOW, AND IT IS THE HOUR THAT DECIDES IT.
//
// `tosgrave.kod:65` is `if iHour < 5 or iHour > 21 { propagate; }` — the propagate is what
// creates monsters, so the graveyard generates ONLY at those hours and generates nothing
// at all the rest of the time. That is seven hours of twenty-four; at five real minutes a
// game hour it is the 35-minutes-in-120 window the fleet has been working from.
export const GRAVEYARD_HOURS = Object.freeze([22, 23, 0, 1, 2, 3, 4]);
export const graveyardOpenAt = hour => hour != null && (hour < 5 || hour > 21);

export const GAME_HOUR_MS = 5 * 60_000;
export const GAME_DAY_MS = HOURS * GAME_HOUR_MS;

/**
 * The whole phase, from one sun reading and the moment it was taken.
 *
 * `into_hour_ms` is how far into the current game hour the reading is, which is what makes
 * the answer usable between packets: the hour ticks at a known rate, so a reading two
 * minutes old still says exactly where the boundary is.
 *
 * A CHANGE push lands ON an hour boundary, so a reading taken from one is calibrated to
 * the second. An ADD push arrives at login, at an arbitrary point inside an hour, so that
 * one places the boundary only within five minutes. Both are recorded the same way and the
 * difference shows up as `into_hour_ms` being wrong by up to one game hour after a login —
 * which the next hourly push corrects on its own.
 */
export function phaseFromSun(hour, { at = Date.now(), now = Date.now() } = {}) {
  if (hour == null) return null;
  const elapsed = Math.max(0, now - at);
  // How many whole game hours have gone by since the reading, and how far into the
  // current one we are.
  const hoursGone = Math.floor(elapsed / GAME_HOUR_MS);
  const intoHour = elapsed % GAME_HOUR_MS;
  const nowHour = (hour + hoursGone) % HOURS;
  const night = graveyardOpenAt(nowHour);

  // Hours until the state flips, counting from the START of the current hour, then
  // corrected by how far into it we already are.
  let flip = 1;
  while (flip < HOURS && graveyardOpenAt((nowHour + flip) % HOURS) === night) flip += 1;
  const untilFlip = flip * GAME_HOUR_MS - intoHour;

  return {
    night,
    hour: nowHour,
    into_hour_ms: intoHour,
    closes_in_ms: night ? untilFlip : null,
    opens_in_ms: night ? null : untilFlip,
    source: 'sky',
    read_at: at,
    age_ms: elapsed,
  };
}

// HOW LONG A SKY READING IS TRUSTED — AND A READING IS A CALIBRATION, NOT A SAMPLE.
//
// This was one game hour, on the reasoning that the sun pushes every game hour so anything
// older meant the packets had stopped. The push is real — measured live, BP_ADD_BG_OVERLAY
// at login and BP_CHANGE_BG_OVERLAY on each hour — but tying the shelf life to it was
// still wrong, because it made a missed push or a quiet moment fall all the way back to
// the hand-typed anchor when the reading in hand was still perfectly good.
//
// The right model is the one the anchor itself uses. The game hour advances at a FIXED
// KNOWN RATE — five real minutes, `system.kod` — so one observed hour plus elapsed time
// gives every later hour, exactly. That is precisely what the anchor does, except the
// anchor's starting moment is a person with a stopwatch and this one is the server stating
// its own hour. Extrapolating is not a degradation of a sky reading; it IS the sky reading.
//
// So this is long enough to span a quiet night, and `age_ms` rides on every answer so a
// caller can see how old the calibration is. What genuinely invalidates it is a SERVER
// restart — piHour is a stored property, not a pure function of wall-clock time, so a
// restart can put the hour anywhere — and that is what a fresh reading at the next login
// corrects. Losing an hour to a stale calibration after a server bounce is the cost;
// falling back to a hand-typed anchor that has the same problem and no self-correction is
// not an improvement on it.
export const STALE_MS = 12 * 60 * 60_000;

export const isFresh = (readAt, now = Date.now()) =>
  readAt != null && now - readAt < STALE_MS;

if (process.argv[1]?.endsWith('m59-skyclock.mjs')) {
  const hour = Number(process.argv.includes('--hour')
    ? process.argv[process.argv.indexOf('--hour') + 1] : NaN);
  if (Number.isFinite(hour)) {
    const p = phaseFromSun(hour);
    console.log(process.argv.includes('--json') ? JSON.stringify(p, null, 2)
      : `game hour ${p.hour} — graveyard ${p.night ? 'OPEN' : 'shut'}, ` +
        `${p.night ? 'closes' : 'opens'} in ${Math.round((p.closes_in_ms ?? p.opens_in_ms) / 60000)} min`);
  } else {
    console.log('the sun angle is ((hour + 19) mod 24) * 130 — sun.kod:53');
    console.log('the graveyard generates only at hours', GRAVEYARD_HOURS.join(', '),
                '— tosgrave.kod:65');
    console.log('\npass --hour <n> to see the phase for a given game hour.');
    console.log('The live reading is on the fleet board as `world_clock`.');
  }
}
