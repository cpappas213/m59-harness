#!/usr/bin/env node
// THE TWO THINGS THE DEATHS PAGE CAN GET WRONG WITHOUT LOOKING WRONG. Offline, no server,
// no broker, safe any time:
//
//   node tools/m59-deaths-test.mjs
//
// A treemap that is subtly mislaid still looks exactly like a treemap — rectangles, in a
// rectangle, in descending size. You cannot see a 12% area error by squinting at one, and
// the entire point of the chart is that area means quantity. So the layout is checked as
// geometry: every rectangle's area against its share, every pair for overlap, and the
// total against the canvas.
//
// And a location that is WRONG looks exactly like a location that is right. That is not a
// hypothetical — before the trust rule, the top of "where the fleet dies" was a list that
// included three inns, and nothing in a rendered page could have told you. So the rule is
// pinned here against synthetic postmortems whose answers are known, including the exact
// shape that produced the inns: a keeper that last looked while the character was resting
// somewhere safe, minutes before it died somewhere else.

import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// BOTH SCRATCH DIRECTORIES, BEFORE ANY IMPORT AT ALL.
//
// Each module resolves its directory once, at load, so an env var set after the fact is
// ignored — and the module that gets skipped is not always the one you are importing.
// This test set M59_TOUGHER_DIR just before importing m59-tougher.mjs, which looks
// careful and was not: m59-deaths-page.mjs had already pulled it in at the top of the
// file, so the record was live on the REAL fleet directory. It then wrote five synthetic
// max-health gains into the actual record, next to the three the fleet had genuinely
// earned that afternoon. They had to be picked out by timestamp afterwards. A test that
// can corrupt the data it is testing gets its environment set on line one.
const dir = mkdtempSync(join(tmpdir(), 'm59-deaths-test-'));
const tdir = mkdtempSync(join(tmpdir(), 'm59-tougher-test-'));
process.env.M59_POSTMORTEM_DIR = dir;
process.env.M59_TOUGHER_DIR = tdir;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const { loadPostmortems, locate, causeOf, facets, digest, TRUST_MS } =
  await import('./m59-postmortems.mjs');
const { SQUARIFY_JS } = await import('./m59-deaths-page.mjs');
const t = await import('./m59-tougher.mjs');

// PROOF THAT IT WORKED, rather than trust that it did. If this ever fails, everything
// below is writing into a live fleet's record.
if (!t.TOUGHER_DIR.startsWith(tdir)) {
  console.error(`REFUSING TO RUN: the tougher record resolved to ${t.TOUGHER_DIR}, not the ` +
                `scratch directory. This test would write into real fleet data.`);
  process.exit(2);
}

const T0 = 1786000000000;
let seq = 0;
function write(pm) {
  const f = `${pm.character}-${++seq}.json`;
  writeFileSync(join(dir, f), JSON.stringify(pm));
  return f;
}
// A death, with the two knobs that decide whether we can place it: how long ago the
// keeper last looked, and whether a damage segment landed near the end.
const death = ({ character = 'Kermit', at = T0, frameAgo = 5_000, frameRoom = 'The Fields',
                 frameNum = 100, hitAgo = null, hitRoom = 'The Badlands', hitNum = 585,
                 killer = null, crowd = [], threats = 1 } = {}) => ({
  character, agent: 't1', at, reason: 'died',
  was: { doing: 'fighting', hunting: 'giant rat', strategy: 'baseline', in_safe_spot: false },
  where: { room: frameRoom, num: frameNum, col: 10, row: 20 },
  vitals: { level: 24, trail: [24, 24, 12, 3], last_health: 3, last_vigor: 100 },
  threats: { present_at_the_end: crowd, most_at_once: crowd.length, players_present: [] },
  summary: { died_in: frameRoom, room_num: frameNum, level: 24, was_nearby: crowd },
  killed_by_broadcast: killer
    ? { who: character, killer, how: 'killed', text: `### ${character} was just killed by a ${killer}.`, at: at - 2000 }
    : null,
  frames: frameAgo == null ? [] : [
    { at: at - frameAgo - 3000, room: frameRoom, num: frameNum, col: 8, row: 20, health: 24, max: 24, threat_count: threats, threats: crowd },
    { at: at - frameAgo, room: frameRoom, num: frameNum, col: 10, row: 20, health: 12, max: 24, threat_count: threats, threats: crowd },
  ],
  hits: hitAgo == null ? [] : [
    { room: hitNum, room_name: hitRoom, col: 30, row: 12, doing: 'travelling',
      first_at: at - hitAgo - 1000, last_at: at - hitAgo, hits: 3, lost: 9, health: 3, max: 24, by: [] },
  ],
  text: [{ at: at - 4000, kind: 'message', text: 'The giant rat claws you with its attack.' }],
  decisions: [], note: '', during_keeper_outage: null,
});

// ------------------------------------------------------------------ what killed it

console.log('\nwhat killed it — an announcement is not a guess');
{
  const announced = causeOf(death({ killer: 'groundworm', crowd: ['troll', 'troll', 'groundworm'] }));
  ok('the server\'s broadcast names the killer', announced.killer === 'groundworm');
  ok('and it is marked as observed', announced.observed === true);
  // THE TRAP THIS EXISTS FOR: the crowd's most common member here is `troll`, and the
  // broadcast says groundworm. Preferring the crowd is how twelve deaths at the border of
  // the Badlands got blamed on soldiers that had not touched anybody.
  ok('the crowd does NOT override the broadcast', announced.killer !== 'troll');

  const guessed = causeOf(death({ killer: null, crowd: ['troll', 'troll', 'groundworm'] }));
  ok('with no broadcast it falls back to the commonest thing nearby', guessed.killer === 'troll');
  ok('and says plainly that it is a guess', guessed.observed === false);
  ok('and says how good a guess', /half the time/.test(guessed.why));

  const nothing = causeOf(death({ killer: null, crowd: [] }));
  ok('nothing in view and no broadcast is an honest null', nothing.killer === null);
  ok('rather than an invented culprit', nothing.observed === false);
}

// ------------------------------------------------------------------ where it died

console.log('\nwhere it died — evidence or nothing');
{
  const fresh = locate(death({ frameAgo: 5_000 }));
  ok('a frame from five seconds before the end places the death', fresh.trusted === true);
  ok('and says which witness it used', fresh.source === 'frame');

  const stale = locate(death({ frameAgo: 240_000, frameRoom: 'Yonder Inn of Jasper', frameNum: 370 }));
  ok('a frame four minutes stale does NOT place it', stale.trusted === false);
  // The whole point. Nothing in an inn can hurt anybody; the character was resting there
  // when the keeper last looked and died somewhere else entirely.
  ok('and the inn is not offered as the answer', stale.room === undefined);
  ok('though what it WOULD have claimed is kept, clearly labelled',
     stale.claimed === 'Yonder Inn of Jasper');
  ok('and it says why it refused', /where it WAS, not where it died/.test(stale.why));

  ok('exactly at the window is still trusted', locate(death({ frameAgo: TRUST_MS })).trusted === true);
  ok('a second past it is not', locate(death({ frameAgo: TRUST_MS + 1000 })).trusted === false);

  // THE EVENT STREAM WINS. A hit segment keeps recording while the keeper is blind, so a
  // stale frame in a town and a fresh hit in the field must resolve to the field.
  const both = locate(death({ frameAgo: 300_000, frameRoom: 'Familiars', frameNum: 52,
                              hitAgo: 4_000, hitRoom: 'The border of the Badlands', hitNum: 585 }));
  ok('a fresh damage segment beats a stale frame', both.trusted === true && both.source === 'hits');
  ok('and it names the field, not the inn', both.room === 'The border of the Badlands');
  ok('and carries the square the damage landed on', both.col === 30 && both.row === 12);

  const noFrames = locate(death({ frameAgo: null }));
  ok('a death with no frames at all is unplaced', noFrames.trusted === false);
  ok('and says so rather than blaming staleness', /never got a frame/.test(noFrames.why));
}

// ------------------------------------------------------------------ the facets

console.log('\nthe treemap only gets what can be stood behind');
{
  // Start from an empty directory, but do not remove the directory itself — the module
  // resolved that path at load and cannot be told about a new one.
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  // Three placeable deaths in the field, two unplaceable ones whose files name an inn.
  write(death({ character: 'Kermit', at: T0, frameAgo: 3000, frameRoom: 'The Badlands', frameNum: 585, killer: 'troll' }));
  write(death({ character: 'Zoot', at: T0 - 1000, frameAgo: 3000, frameRoom: 'The Badlands', frameNum: 585, killer: 'troll' }));
  write(death({ character: 'Piggy', at: T0 - 2000, frameAgo: 3000, frameRoom: 'The Fields', frameNum: 100, killer: 'slime' }));
  write(death({ character: 'Rowlf', at: T0 - 3000, frameAgo: 600_000, frameRoom: 'Familiars', frameNum: 52, killer: 'slime' }));
  write(death({ character: 'Beaker', at: T0 - 4000, frameAgo: 600_000, frameRoom: 'The Limping Toad Inn and Tavern', frameNum: 202, killer: null, crowd: ['ant'] }));

  const rows = loadPostmortems({});
  ok('every death is loaded, placeable or not', rows.length === 5, `got ${rows.length}`);
  ok('newest first', rows[0].character === 'Kermit');

  const f = facets(rows);
  const places = f.place.children.map(c => c.name);
  ok('the map shows only the placed rooms', places.length === 2, JSON.stringify(places));
  ok('and no inn reaches it', !places.some(p => /inn|tavern|familiars/i.test(p)), JSON.stringify(places));
  ok('the busiest room is the one with two deaths', f.place.children[0].name === 'The Badlands');
  ok('and it splits by character underneath', f.place.children[0].children.length === 2);
  // THE HOLE IS REPORTED, NOT HIDDEN. Two deaths went nowhere; a page that showed three
  // rooms and said nothing would read as a complete picture of five deaths.
  ok('the deaths it refused to place are counted', f.place.unplaced === 2);
  ok('and the note says how many and why', /2 are not shown/.test(f.place.note), f.place.note);

  // Announced and guessed killers are never added together.
  ok('announced killers are their own set', f.cause.total === 4);
  ok('guessed ones are kept separate', f.cause.inferred_total === 1);
  ok('and the guessed one is not in the announced facet',
     !f.cause.children.some(c => c.name === 'ant'));

  const d = digest(rows[0].file);
  ok('a single death reads back as a digest', d?.character === 'Kermit');
  ok('with its cause', d.cause.killer === 'troll' && d.cause.observed === true);
  ok('and its place', d.where.trusted === true && d.where.room === 'The Badlands');
  ok('and the shape of the dying', typeof d.shape === 'string' && d.biggest_drop === 12);
  ok('and what the server said', d.text.length === 1);
}

// ------------------------------------------------------------------ the treemap layout

console.log('\nthe treemap is geometry, so check it as geometry');
{
  // The exact string the page ships, evaluated. Testing a copy would test the copy.
  const squarify = new Function(SQUARIFY_JS + '; return squarify;')();
  const W = 900, H = 460;
  const run = (values) => {
    const nodes = values.map((v, i) => ({ name: 'n' + i, value: v }));
    const boxes = squarify(nodes, 0, 0, W, H);
    const total = values.reduce((t, v) => t + v, 0);
    return { nodes, boxes, total };
  };

  // The shape of the real data: one category holding a quarter, a long thin tail.
  const { boxes, total } = run([108, 36, 28, 27, 27, 24, 24, 20, 19, 15, 15, 8, 5, 4, 3, 2, 2, 1, 1, 1]);
  ok('every node gets a rectangle', boxes.length === 20, `got ${boxes.length}`);

  let areaErr = 0;
  for (const b of boxes) {
    const got = (b.x1 - b.x0) * (b.y1 - b.y0);
    const want = (b.node.value / total) * W * H;
    areaErr = Math.max(areaErr, Math.abs(got - want) / want);
  }
  // AREA IS THE ONLY THING A TREEMAP MEANS. If this drifts the chart is lying, and it is
  // lying in a way that looks completely normal.
  ok('area is proportional to value, to within a rounding error',
     areaErr < 1e-9, `worst error ${(areaErr * 100).toFixed(6)}%`);

  const covered = boxes.reduce((t, b) => t + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  ok('the rectangles fill the canvas exactly',
     Math.abs(covered - W * H) / (W * H) < 1e-9, `${(100 * covered / (W * H)).toFixed(4)}%`);

  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6) overlaps++;
    }
  ok('and none of them overlap', overlaps === 0, `${overlaps} overlapping pairs`);

  const inside = boxes.every(b => b.x0 >= -1e-6 && b.y0 >= -1e-6 && b.x1 <= W + 1e-6 && b.y1 <= H + 1e-6);
  ok('and none escape the canvas', inside);

  ok('they come out biggest first', boxes[0].node.value === 108);

  // SQUARIFIED, not sliced. The reason to run this algorithm rather than divide the
  // rectangle into strips is that the boxes stay close to square and therefore legible;
  // a naive slice-and-dice on this data produces 20:1 slivers.
  const ratios = boxes.map(b => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    return Math.max(w / h, h / w);
  }).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  ok('the median rectangle is close to square', median < 2.5, `median aspect ${median.toFixed(2)}`);
  ok('and even the worst is readable rather than a sliver', ratios[ratios.length - 1] < 12,
     `worst aspect ${ratios[ratios.length - 1].toFixed(2)}`);

  // The degenerate inputs a live fleet will absolutely produce.
  ok('no data lays out as nothing rather than throwing', squarify([], 0, 0, W, H).length === 0);
  ok('a single category fills the whole canvas', (() => {
    const b = squarify([{ name: 'only', value: 7 }], 0, 0, W, H);
    return b.length === 1 && Math.abs((b[0].x1 - b[0].x0) * (b[0].y1 - b[0].y0) - W * H) < 1e-6;
  })());
  ok('zero-valued categories are dropped rather than dividing by zero',
     squarify([{ name: 'a', value: 5 }, { name: 'z', value: 0 }], 0, 0, W, H).length === 1);
  ok('a zero-size canvas produces no rectangles', squarify([{ name: 'a', value: 5 }], 0, 0, 0, 0).length === 0);
  ok('equal values split evenly', (() => {
    const b = squarify([1, 1, 1, 1].map((v, i) => ({ name: 'n' + i, value: v })), 0, 0, 400, 400);
    return b.every(x => Math.abs((x.x1 - x.x0) * (x.y1 - x.y0) - 40000) < 1e-6);
  })());
}

// ------------------------------------------------------------------ the tougher record

console.log('\nattributing a max-health gain to the kill that paid for it');
{
  ok('the server\'s own words are what we match on',
     t.TOUGHER_LINE.test('You suddenly feel a little tougher.'));
  ok('and not something merely adjacent',
     !t.TOUGHER_LINE.test('The giant rat is weak, and near death.'));

  // THE ORDERING BUG, PINNED. The keeper writes the kill down AFTER fight() returns, so
  // it lands in the feed a few milliseconds after the announcement it caused. The first
  // version required the kill to come first, and filed the fleet's very first real gain —
  // Lew 22 -> 23 in The Queen's Way — as "cause unknown", with the kill that paid for it
  // sitting in the feed 40ms later.
  const T = 1786000000000;
  t.recordGain('Lew', { at: T, from: 22, to: 23, room: "The Queen's Way", room_num: 603 });
  t.recordKill('Lew', { at: T + 40, creature: 'spider', room: "The Queen's Way", room_num: 603 });
  {
    const g = t.loadGains('Lew').gains;
    ok('a kill recorded just AFTER the announcement still pays for it',
       g.length === 1 && g[0].creature === 'spider', JSON.stringify(g));
    ok('and the point itself is right', g[0].from === 22 && g[0].to === 23);
  }

  // The other direction, which always worked.
  t.recordKill('Kermit', { at: T, creature: 'groundworm', room: 'The Badlands', room_num: 585 });
  t.recordGain('Kermit', { at: T + 300, from: 23, to: 24 });
  {
    const g = t.loadGains('Kermit').gains;
    ok('a kill just BEFORE it pays for it too', g.length === 1 && g[0].creature === 'groundworm');
    ok('and the room comes off the kill when the gain did not carry one',
       g[0].room === 'The Badlands');
  }

  // NEAREST WINS. Two kills inside the window is the ordinary case for a character
  // fighting steadily, and the one that rolled the point is the one next to the message.
  t.recordKill('Piggy', { at: T, creature: 'ant', room: 'A' });
  t.recordKill('Piggy', { at: T + 9000, creature: 'troll', room: 'B' });
  t.recordGain('Piggy', { at: T + 9100, from: 20, to: 21 });
  ok('the nearest kill wins, not the first', t.loadGains('Piggy').gains[0].creature === 'troll');

  // Outside the window it must not guess.
  t.recordKill('Zoot', { at: T, creature: 'slime', room: 'A' });
  t.recordGain('Zoot', { at: T + 60_000, from: 21, to: 22 });
  t.flushPending('Zoot', T + 120_000);
  {
    const g = t.loadGains('Zoot').gains;
    ok('a gain with no kill near it is still recorded', g.length === 1);
    ok('but its cause is left null rather than guessed', g[0].creature === null, JSON.stringify(g[0]));
    ok('and it says why', /no kill was recorded near it/.test(g[0].attributed));
  }

  // A POINT MUST NEVER BE WRITTEN TWICE. The gains file is the long memory, so a
  // duplicate is permanent and inflates the one number the fleet is judged on.
  t.recordGain('Rowlf', { at: T, from: 19, to: 20 });
  t.recordKill('Rowlf', { at: T + 200, creature: 'frogman', room: 'C' });
  t.recordGain('Rowlf', { at: T + 10, from: 19, to: 20 });     // the same point, seen again
  {
    const g = t.loadGains('Rowlf').gains;
    ok('the same point is never written twice', g.length === 1, JSON.stringify(g));
    ok('and it keeps the attribution', g[0].creature === 'frogman');
  }

  // The feed: ten per character, newest first, and it does not grow.
  for (let i = 0; i < 25; i++) t.recordKill('Beaker', { at: T + i * 1000, creature: 'rat' + i });
  const feed = t.feedFor('Beaker');
  ok('the feed holds exactly ten', feed.length === t.FEED_SIZE, `got ${feed.length}`);
  ok('newest first', feed[0].creature === 'rat24');
  ok('and the oldest have fallen off', !feed.some(e => e.creature === 'rat0'));

  t.recordDeath('Beaker', { at: T + 30_000, killer: 'troll', observed: true, room: 'D' });
  ok('deaths share the feed with kills', t.feedFor('Beaker')[0].kind === 'death');
  ok('and carry whether the killer was announced', t.feedFor('Beaker')[0].observed === true);

  const sum = t.toughSummary(t.allGains({}));
  ok('the summary counts every point on disk', sum.total === 5, `got ${sum.total}`);
  ok('and separates the ones with no cause', sum.unattributed === 1);
  ok('and ranks what paid by how much it paid', sum.by_creature[0].value >= 1);
}

rmSync(dir, { recursive: true, force: true });
rmSync(tdir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
