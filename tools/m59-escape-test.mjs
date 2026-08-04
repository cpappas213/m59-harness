#!/usr/bin/env node
// A CHARACTER THAT IS STILL SITTING DOWN CAN NEITHER LEAVE NOR SWING. Offline, no
// server, safe to run any time:
//
//   node tools/m59-escape-test.mjs
//
// Resting sets PFLAG_NO_MOVE and PFLAG_NO_FIGHT together (player.kod:1162), and nothing
// clears resting except standing up or logging off — not death, not being attacked. So a
// character killed mid-rest, or one a keeper sat down in a safe spot and never got back
// up, is stuck in a way that looks like something else entirely:
//
//   * escaping the Underworld — the move is bounced SILENTLY (user.kod:2988), so every
//     portal in the pentagram reads as unlit and the report blamed the braziers.
//   * fighting — the swing is refused OUT LOUD (user.kod:4679, "unable to lift your
//     weapon"), so the combat lines read as a fight going badly rather than as a fight
//     not happening.
//
// Two different refusals, so two different fixes: movement has to be pre-empted by
// standing up first, and attacking can simply be believed and recovered from.
//
// The fakes below model those server behaviours and nothing else.

import { escapeUnderworld, standUp, fight } from './m59-skills.mjs';
import { MOVEON, OF } from './m59-parse.mjs';

function underworld({ resting = false, deaf = false, portals = [], unwalkable = [] } = {}) {
  const log = [];
  const names = new Map([[900, 'The Underworld'], [901, 'The Blue Sow']]);
  const objects = new Map();
  portals.forEach((p, i) => {
    const id = i + 1;
    names.set(id, p.name);
    objects.set(id, { id, flags: MOVEON.TELEPORTER, col: p.col, row: p.row, nameRsc: id });
  });

  const c = {
    room: { id: 10, objects },
    roomNameRsc: 900,
    rsc: { get: r => names.get(r) ?? '?' },
    evSeq: 0,
    events: [],
    self: { col: 1, row: 1 },
    emit(kind, data) { const ev = { seq: ++c.evSeq, kind, ...data }; c.events.push(ev); return ev; },
    // Enough of the long poll to be honest about ordering: an event emitted DURING a
    // walk is still there afterwards, and only a cursor taken beforehand can see it.
    async waitFor({ since = 0, kinds = null } = {}) {
      const want = kinds && new Set([].concat(kinds));
      return { events: c.events.filter(e => e.seq > since && (!want || want.has(e.kind))), timedOut: false };
    },
    roomContents() { c.emit('room-contents', { room: c.room.id }); },
    // `deaf` is a character that cannot stand up however politely asked — held, webbed,
    // or a stand that got dropped. The report must stay honest about that too.
    stand() { log.push('stand'); if (!deaf) resting = false; },
    look(id) { c.emit('look', { id, description: 'Through it you glimpse the bustling bar of Familiars.' }); },
    moveToSquare(col, row) { step(col, row); },
  };

  function step(col, row) {
    log.push(`move ${col},${row}`);
    if (resting) return;                      // bounced back onto the square we are on
    if (unwalkable.some(u => u.col === col && u.row === row)) return;
    c.self = { col, row };
    const p = portals.find(p => p.col === col && p.row === row);
    if (p?.live) {
      c.room = { id: 20, objects: new Map() };
      c.roomNameRsc = 901;
      c.emit('room-entered', { room: 20, roomName: 'The Blue Sow' });
    }
  }

  const s = {
    need: () => c,
    pacer: { submit: async (_kind, fn) => fn() },
    world: {
      room: { name: 'The Underworld' },
      reach: () => ({ reachable: true, steps: 3 }),
      approachSquare: (col, row) => ({ col: col - 1, row, steps: 1 }),
    },
    // The real one: a step onto a live portal leaves the room, so it returns
    // arrived:false with left_room set, having done exactly what was wanted.
    async walkTo(col, row) {
      const wasIn = c.room.id;
      step(col, row);
      if (c.room.id !== wasIn) return { arrived: false, left_room: true, note: 'a step crossed the room edge' };
      if (c.self.col === col && c.self.row === row) return { arrived: true, position: { col, row } };
      return { arrived: false, reason: 'blocked — every heading refused, at every reach tried' };
    },
  };
  return { s, log };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Died sitting down. This is the whole bug: without the stand, not one of these moves
// lands and every portal in the pentagram reads as dead.
{
  const { s, log } = underworld({ resting: true, portals: [{ name: 'portal', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a resting character still gets out', r.left === true, JSON.stringify(r));
  ok('stands up before it moves a step', log[0] === 'stand', JSON.stringify(log));
  ok('says so, so the caller can rule posture out', r.stood_up === true);
  ok('names where it came out', r.arrived_in === 'The Blue Sow', r.arrived_in);
}

// The portal fires on the last step of the walk, so walkTo reports it as a walk that
// never arrived. Believing that is how a working portal gets logged as a broken one.
{
  const { s } = underworld({ portals: [{ name: 'rip in space', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a portal that fires mid-walk counts as leaving', r.left === true, JSON.stringify(r));
  ok('and says which one did it', r.via === 'rip in space', r.via);
}

// A real unlit portal: we get onto its square and nothing happens. This diagnosis is
// correct and must survive.
{
  const { s } = underworld({ portals: [{ name: 'portal', col: 5, row: 5, live: false }] });
  const r = await escapeUnderworld(s);
  ok('a dead portal is still called dead', r.left === false && /none of the teleporters/.test(r.reason));
  ok('and still blames the brazier', /brazier/.test(r.tried[0].why), r.tried[0].why);
}

// Never got there. Whatever is wrong, it is not the brazier — and saying it is sends the
// caller hunting for something to activate that was never the problem.
{
  const { s } = underworld({ portals: [{ name: 'portal', col: 5, row: 5, live: true }],
                             unwalkable: [{ col: 5, row: 5 }] });
  const r = await escapeUnderworld(s);
  ok('an unreached portal is not reported as unlit', !/brazier/.test(r.tried[0].why), r.tried[0].why);
  ok('it says it never got onto the square', /never got onto its square/.test(r.tried[0].why));
  ok('and the note does not blame the pentagram', !/dead until their brazier/.test(r.note), r.note);
}

// A character that cannot stand up at all — held, webbed, or a stand that went missing.
// The answer must not become "the portals are dead".
{
  const { s, log } = underworld({ resting: true, deaf: true,
                                  portals: [{ name: 'portal', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a character that cannot move does not blame the portals', !/brazier/.test(r.tried[0].why), r.tried[0].why);
  ok('and we did try to stand it up', log.includes('stand'));
}

// Waiting by the shifting portal for a named city, from a sitting start.
{
  const { s, log } = underworld({ resting: true, portals: [{ name: 'rip in space', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s, { city: 'Tos', maxSeconds: 10 });
  ok('the city wait stands up too', log[0] === 'stand', JSON.stringify(log));
  ok('and steps on when it reads right', r.left === true, JSON.stringify(r));
}

// Nothing to walk onto. The stand still happens — it is the cheapest thing in the room
// and the answer is more trustworthy for it.
{
  const { s, log } = underworld({ resting: true, portals: [] });
  const r = await escapeUnderworld(s);
  ok('an empty room still reports honestly', r.left === false && /no teleporter/.test(r.reason));
  ok('having stood up anyway', log[0] === 'stand' && r.stood_up === true);
}

// The helper on its own, since anything else that has to move may want it.
{
  const { s, log } = underworld({ resting: true });
  await standUp(s);
  ok('standUp sends exactly one stand', log.filter(x => x === 'stand').length === 1, JSON.stringify(log));
}

// ------------------------------------------------------------------------ fighting
//
// The same posture, the other half of the flag. A monster standing next to us, a
// character sitting down, and a server that answers every swing with the same line.

const REFUSED = 'You find yourself unable to lift your weapon.';

function safeSpot({ resting = false, deaf = false, hits = 3 } = {}) {
  const log = [];
  const names = new Map([[500, 'The Ledge'], [1, 'mummy']]);
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 4, row: 5, x: 288, y: 352, nameRsc: 1 };
  const objects = new Map([[1, foe], [99, { id: 99, flags: 0, col: 5, row: 5, nameRsc: 1 }]]);

  const c = {
    selfId: 99,
    self: { col: 5, row: 5 },
    room: { id: 30, objects },
    roomNameRsc: 500,
    rsc: { get: r => names.get(r) ?? '?' },
    lookup: r => names.get(r) ?? '?',
    inventory: [],
    evSeq: 0,
    vitals: () => ({ health: { value: 40, max: 40 }, vigor: { value: 200, max: 200, scale_max: 200 } }),
    stats: async () => {},
    async waitFor() { return { events: [], timedOut: true }; },
    roomContents() {},
    stand() { log.push('stand'); if (!deaf) resting = false; },
  };

  const s = {
    need: () => c,
    pacer: { submit: async (_kind, fn) => fn() },
    world: { approachSquare: () => null },
    // The one rule: a resting character's swings are refused, and the server says so.
    async attackRounds(id, swings) {
      log.push(`swing x${swings}`);
      if (resting) return { messages: [REFUSED], vitals: c.vitals() };
      if (--hits <= 0) objects.delete(id);
      return { messages: ['You hit the mummy.'], vitals: c.vitals() };
    },
    async lootFloor() { return { taken: [], refused: [], carrying: [] }; },
  };
  return { s, log };
}

// Sat down in a safe spot, told to fight. The refusals are not misses.
{
  const { s, log } = safeSpot({ resting: true });
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('a refused swing gets us back on our feet', log.includes('stand'), JSON.stringify(log));
  ok('and the fight then actually happens', r.killed === true, JSON.stringify(r));
  ok('it says a round went to standing up', /resting/.test(r.stood_up || ''), r.stood_up);
  ok('the stand comes after the round that was refused', log.indexOf('stand') === 1, JSON.stringify(log));
}

// Standing did not help: Hold, Dazzle, Blind, a DM freeze. Swinging eleven more times
// is eleven more refusals — stop and name what it might be.
{
  const { s, log } = safeSpot({ resting: true, deaf: true });
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('a flag standing cannot clear stops the fight', r.could_not_swing === true, JSON.stringify(r));
  ok('it does not spend the whole leash on it', r.rounds === 2, 'rounds=' + r.rounds);
  ok('and it names the other causes', /Hold, Dazzle, Blind/.test(r.note || ''), r.note);
  ok('having tried standing exactly once', log.filter(x => x === 'stand').length === 1, JSON.stringify(log));
}

// Nothing wrong with us. The recovery must not fire, and must not cost a round.
{
  const { s, log } = safeSpot();
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('an ordinary fight sends no stand at all', !log.includes('stand'), JSON.stringify(log));
  ok('and takes exactly the rounds it needed', r.killed === true && r.rounds === 3, 'rounds=' + r.rounds);
  ok('and claims no stand it did not do', r.stood_up === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
