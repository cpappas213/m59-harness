#!/usr/bin/env node
// WHERE THE DAMAGE LANDED, and the two states a keeper can be in. Offline, no server,
// safe to run any time:
//
//   node tools/m59-hits-test.mjs
//
// Two things are pinned here and both are about NOT GOING BLIND.
//
// The hit record exists because the keeper samples once a pass and a pass can be a
// multi-minute travel await — 33 of 50 recent deaths had their last observation over a
// minute before the killing blow. Health is pushed by the server, so it can be recorded
// through that gap. The cases that must not regress are the ones that would quietly turn
// the record back into noise: a heal counted as a hit, a login counted as a hit, and
// ninety swings on one square collapsing the shape of a death into one row.
//
// Inert exists because "stop the keeper" was being used to mean "stop driving" and was
// also switching off every instrument. The cases that must not regress are that an inert
// keeper still looks, still records, and can still be woken by the callers that hold it.

import * as hits from './m59-hits.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const T0 = 1_700_000_000_000;   // a fixed clock; Date.now() has no place in a test

// SEGMENTS FOLD BY PLACE, so a character standing under six attackers produces one record
// of a beating rather than ninety records of a swing.
{
  const book = hits.emptyBook('Animal');
  for (let i = 0; i < 12; i++)
    hits.record(book, { at: T0 + i * 2000, room: 562, roomName: 'The sandy shores',
                        col: 21, row: 20, doing: 'fighting', health: 30 - i * 2, max: 30, lost: 2 });
  ok('twelve hits on one square are one segment', book.segments.length === 1,
     JSON.stringify(book.segments.length));
  ok('and it carries the count', book.segments[0].hits === 12);
  ok('and the total lost', book.segments[0].lost === 24);
  ok('and how long it went on', book.segments[0].last_at - book.segments[0].first_at === 22000);
}

// A NEW SQUARE IS A NEW SEGMENT. This is the distinction the whole file is for: being hit
// ninety times without moving and being hit once in each of nine squares are completely
// different deaths, and a record that folded them together would say neither.
{
  const book = hits.emptyBook('Sweetums');
  for (let i = 0; i < 6; i++)
    hits.record(book, { at: T0 + i * 1000, room: 562, col: 10 + i, row: 20,
                        doing: 'travelling', health: 30 - i, max: 30, lost: 1 });
  ok('six hits across six squares are six segments', book.segments.length === 6);
  ok('each one remembers where it was',
     book.segments.map(s => s.col).join(',') === '10,11,12,13,14,15');
}

// SAME SQUARE, DIFFERENT ACTIVITY, DIFFERENT SEGMENT. Standing at (21,20) fighting and
// standing at (21,20) on the way past are the same coordinates and opposite facts.
{
  const book = hits.emptyBook('Zoot');
  hits.record(book, { at: T0, room: 562, col: 21, row: 20, doing: 'travelling', lost: 3 });
  hits.record(book, { at: T0 + 1000, room: 562, col: 21, row: 20, doing: 'fighting', lost: 3 });
  ok('a change of activity opens a new segment', book.segments.length === 2);
}

// A LONG GAP IS TWO VISITS, NOT ONE LONG BEATING. Without this a character hit once, left
// alone for ten minutes, and hit again would be recorded as "under attack for ten
// minutes" — which is the opposite of what happened and would be believed.
{
  const book = hits.emptyBook('Rizzo');
  hits.record(book, { at: T0, room: 544, col: 2, row: 21, doing: 'recovering', lost: 1 });
  hits.record(book, { at: T0 + hits.SEGMENT_GAP_MS + 1, room: 544, col: 2, row: 21,
                      doing: 'recovering', lost: 1 });
  ok('a gap longer than the window starts a new segment', book.segments.length === 2);
  const near = hits.emptyBook('Rizzo');
  hits.record(near, { at: T0, room: 544, col: 2, row: 21, doing: 'recovering', lost: 1 });
  hits.record(near, { at: T0 + hits.SEGMENT_GAP_MS - 1, room: 544, col: 2, row: 21,
                      doing: 'recovering', lost: 1 });
  ok('and a gap inside it extends the one we are in', near.segments.length === 1);
}

// A HEAL IS NOT A HIT. Resting, eating and a heal all move health the other way, and the
// module sees one number at a time — so the guard is that a non-positive loss is refused
// outright rather than filed as a zero-damage event.
{
  const book = hits.emptyBook('Piggy');
  ok('a gain records nothing', hits.record(book, { at: T0, lost: -5 }) === null);
  ok('and neither does a no-op', hits.record(book, { at: T0, lost: 0 }) === null);
  ok('the book stays empty', book.segments.length === 0);
}

// ATTRIBUTION IS A LIST, NOT A VERDICT. The damage packet names nobody; the prose that
// names an attacker is a separate message with no id tying them together. Recording it as
// a list of who was talking keeps it honest — the authoritative answer is the death
// broadcast, and the post-mortem already carries that.
{
  const book = hits.emptyBook('Janice');
  hits.record(book, { at: T0, room: 562, col: 3, row: 3, doing: 'fighting', lost: 2, by: 'slime' });
  hits.record(book, { at: T0 + 1000, room: 562, col: 3, row: 3, doing: 'fighting', lost: 2, by: 'slime' });
  hits.record(book, { at: T0 + 2000, room: 562, col: 3, row: 3, doing: 'fighting', lost: 2, by: 'frogman' });
  ok('a segment collects every attacker named during it',
     book.segments[0].by.join(',') === 'slime,frogman', JSON.stringify(book.segments[0].by));
  ok('and does not repeat one', book.segments[0].by.length === 2);
}

// THE SUMMARY ANSWERS THE QUESTION THAT MOTIVATED THE FILE: is this character losing
// fights, or is it being worn down on the roads between them?
{
  const book = hits.emptyBook('Bunsen');
  hits.record(book, { at: T0, room: 586, roomName: 'Main gate to Tos', col: 5, row: 5,
                      doing: 'travelling', lost: 12 });
  hits.record(book, { at: T0 + 60_000, room: 562, roomName: 'The sandy shores', col: 9, row: 9,
                      doing: 'fighting', lost: 4 });
  const s = hits.summarise(book);
  ok('it totals the damage', s.health_lost === 16);
  ok('it splits it by what the keeper was doing',
     s.by_activity.travelling === 12 && s.by_activity.fighting === 4, JSON.stringify(s.by_activity));
  ok('and surfaces the travelling number on its own', s.while_travelling === 12);
  ok('it names the worst room',
     Object.keys(s.worst_rooms)[0] === 'Main gate to Tos (586)', JSON.stringify(s.worst_rooms));
  ok('and counts the distinct squares', s.squares_hit_in === 2);
}

// ------------------------------------------------------------------ inert keepers

// STOPPING A KEEPER USED TO SWITCH OFF THE INSTRUMENTS TOO, and the windows it went blind
// in are where the deaths nobody can explain happened — three of the last fourteen death
// records died inside a deliberate hold, one of them 794 seconds in.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const keeper = () => {
    const k = Object.create(Autopilot.prototype);
    // `live` matters: activity() reports NOT IN GAME ahead of everything else, and it is
    // right to — a logged-out character is a more urgent fact than an inert keeper.
    k.s = { name: 't1', live: true,
            world: { room: { num: 370, name: 'Yonder Inn' } }, client: {} };
    k.journal = [];
    k.running = true;
    k.stopping = false;
    k.inert = null;
    k.mode = 'farm';
    k.policy = { hunt: 'giant rat' };
    k.book = { save: () => {} };
    k.note = () => {};
    k.progress = () => {};
    k.status = () => ({ running: k.running, inert: k.inertStatus() });
    return k;
  };

  const k = keeper();
  k.stop('held for an errand');
  ok('stop() leaves the loop running', k.running === true);
  ok('and makes it inert instead', !!k.inert);
  ok('the reason is kept, for the uptime ledger', k.inert.why === 'held for an errand');
  ok('and it reports itself as inert rather than as whatever it was doing',
     /^inert —/.test(k.activity()), k.activity());
  ok('status carries it', k.status().inert?.inert === true);

  // Every caller that holds a keeper already pairs the hold with a `start`. That pairing
  // is what makes this change invisible to them.
  k.start();
  ok('start() revives an inert keeper', k.inert === null);
  ok('without stopping and restarting the loop', k.running === true);

  // revive() is the explicit half, for a caller that wants to hand control back without
  // re-issuing orders.
  const k2 = keeper();
  k2.goInert('a person took the controls');
  k2.revive('they gave them back');
  ok('revive() clears it too', k2.inert === null);
  ok('reviving something that was not inert is harmless', k2.revive('again') === null);

  // Holding a keeper twice must not stack — the second hold would otherwise overwrite the
  // first one's reason and the first caller's revive would release the second's hold.
  const k3 = keeper();
  k3.goInert('the first errand');
  k3.goInert('the second errand');
  ok('a second hold does not overwrite the first reason',
     k3.inert.why === 'the first errand', k3.inert.why);

  // A HARD STOP MUST STILL EXIST. dropAutopilot throws the object away, and an inert
  // keeper is a running loop holding a session — leaving one behind would keep a
  // discarded autopilot alive against a character nobody is tracking.
  const k4 = keeper();
  k4.stop('the keeper is being discarded', { hard: true });
  ok('hard:true still asks the loop to stop', k4.stopping === true);
  ok('and leaves nothing inert behind to revive', k4.inert === null);
}

// ------------------------------------------------------------------ transit times
//
// THE MEASUREMENT THAT REPLACES "DAMAGE WHILE TRAVELLING". Damage on the road is normal in
// this game and is not a fault: human players die crossing the world constantly, and the
// world is expected to get MORE dangerous as other players start hunting these characters.
// Aborting a journey because it took a hit would cancel most journeys the fleet ever makes.
//
// What we control is TIME EXPOSED, and nothing was recording it. Gonzo spent nearly two
// minutes inside the Valley of Ileria on one crossing; most maps here go from any exit to
// any other in well under a minute. That gap is a bug with a location, not a dangerous map.
{
  const tr = await import('./m59-transits.mjs');
  const book = tr.emptyBook('Gonzo');
  // A fast crossing, a slow one, and one that never got out.
  tr.record(book, { at: T0,          room: 544, roomName: 'Valley of Ileria', to: 562,
                    ms: 8000,    walkMs: 7000,   ok: true,  tried: 1, journey: 'j1', hop: 0 });
  tr.record(book, { at: T0 + 10000, room: 544, roomName: 'Valley of Ileria', to: 562,
                    ms: 114000,  walkMs: 110000, ok: true,  tried: 9, journey: 'j2', hop: 0 });
  tr.record(book, { at: T0 + 20000, room: 562, roomName: 'The sandy shores', to: 552,
                    ms: 62000,   walkMs: 61000,  ok: false, tried: 10, journey: 'j3', hop: 1,
                    outcome: 'exit_candidates_exhausted',
                    refusals: [{ square: '1,4', stage: 'edge', crossing_packet_sent: true,
                                 why: 'stepping past the edge did nothing' }],
                    skipped: [{ stand_on: { col: 5, row: 1 }, why: 'not tried — budget spent' }],
                    reason: 'every square for that exit refused (10 tried)' });

  const rooms = tr.byRoom([book]);
  const valley = rooms.find(r => r.room === 544);
  ok('a room with a fast and a slow crossing keeps both', valley.crossings === 2);
  ok('and the worst crossing is kept exactly, because the tail is the whole point',
     valley.max_ms === 114000, String(valley.max_ms));
  ok('it says how many exit squares were attempted per crossing',
     valley.squares_per_crossing === 5, String(valley.squares_per_crossing));
  ok('the worst crossing itself is retrievable, not just its duration',
     valley.worst?.ms === 114000 && valley.worst?.tried === 9);

  const shores = rooms.find(r => r.room === 562);
  ok('a hop that never got out is still recorded', shores.crossings === 1);
  ok('and counted as a failure', shores.failed === 1);
  ok('with the reason kept verbatim',
     /every square for that exit refused/.test(shores.worst.reason));
  ok('with the stable outcome and exact refusal stage kept too',
     shores.worst.outcome === 'exit_candidates_exhausted' &&
     shores.worst.refusals?.[0]?.stage === 'edge' &&
     shores.worst.refusals?.[0]?.crossing_packet_sent === true &&
     shores.worst.skipped?.length === 1,
     JSON.stringify(shores.worst));
  ok('rooms come back worst-first', rooms[0].room === 544, String(rooms[0].room));

  // `ms` is time in the room; `walk_ms` is only the part inside leaveViaAny. The gap
  // between them is planning, and which half the tail is in decides where the fix goes.
  ok('deciding time is separable from walking time',
     book.transits[1].ms - book.transits[1].walk_ms === 4000);

  const onlyFails = tr.byRoom([book], { failuresOnly: true });
  ok('failures can be looked at on their own',
     onlyFails.length === 1 && onlyFails[0].room === 562);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
