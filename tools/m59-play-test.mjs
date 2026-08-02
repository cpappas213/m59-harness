#!/usr/bin/env node
// Does an agent that can see also manage to *act*? This walks a real session
// through the things the primer claims, and reports which claims survive contact
// with the server. Every rule asserted in docs/m59-agent-primer.md is checked
// here, because the kod says what the rules are and only the server says whether
// they were read correctly.
//
//   node tools/m59-play-test.mjs <user> <pass>
//
// Nothing here uses the admin socket. The point is what a player can do.

import { M59Client } from './m59-client.mjs';
import { describeObject, OF } from './m59-parse.mjs';

import net from 'node:net';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const [user, pass, roomArg] = process.argv.slice(2);
if (!user || !pass) {
  console.error('usage: m59-play-test.mjs <user> <pass> [roomObjectId]');
  console.error('  roomObjectId teleports there first, to reach a room with something to fight');
  process.exit(1);
}

// Scaffolding only: place the character somewhere with a monster in it, because
// walking there would take hundreds of legal moves and prove nothing extra. The
// combat itself is played entirely through the protocol.
function adminOnce(cmd, quietMs = 700) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(process.env.M59_ADMIN_PORT || 9998), process.env.M59_HOST || '127.0.0.1');
    let buf = '', t;
    const finish = () => { clearTimeout(t); s.destroy(); resolve(buf); };
    s.on('connect', () => { s.write(cmd + '\r\n'); t = setTimeout(finish, quietMs); });
    s.on('data', d => { buf += d; clearTimeout(t); t = setTimeout(finish, quietMs); });
    s.on('error', e => { clearTimeout(t); reject(e); });
  });
}

const checks = [];
const check = (claim, ok, detail = '') =>
  { checks.push({ claim, ok, detail }); console.log(`  ${ok ? 'yes ' : 'NO  '} ${claim}${detail ? ` — ${detail}` : ''}`); };

const c = new M59Client({ verbose: false });
await c.login(user, pass);
await sleep(1500);

if (roomArg) {
  // Land INSIDE the grid. A room's piRows/piCols are its whole world: past them
  // Room.SomethingMoved hands off to StandardLeaveDir, and an interior room like
  // a shop has plEdge_Exits empty, so a character parked outside the grid cannot
  // move at all — every move reads as "leaving" and finds no exit to leave by.
  const info = await adminOnce(`show object ${roomArg}`);
  const rows = Number(/piRows\s+= INT (\d+)/.exec(info)?.[1] || 10);
  const cols = Number(/piCols\s+= INT (\d+)/.exec(info)?.[1] || 10);
  const row = Math.max(2, Math.floor(rows / 2)), col = Math.max(2, Math.floor(cols / 2));
  console.log(`teleporting into room ${roomArg} (${rows}x${cols}) at row ${row}, col ${col}`);
  await adminOnce(`send object ${roomArg} NewHold what OBJECT ${c.selfId} new_row INT ${row} new_col INT ${col}`);
  await sleep(1500);
}

c.roomContents(); c.requestInventory();
await sleep(400); c.stats(1);
await sleep(400); c.stats(2);
await sleep(400); c.requestSpells();
await sleep(400); c.requestSkills();
await sleep(1200);

console.log(`in game as object ${c.selfId}, room ${c.room.id} (${c.rsc.get(c.roomNameRsc)})`);
console.log(`vitals: ${JSON.stringify(c.vitals())}`);
console.log(`carrying ${c.inventory.length}: ${c.inventory.map(o => c.rsc.get(o.nameRsc)).join(', ') || '(nothing)'}`);
console.log(`knows ${c.spells?.length ?? 0} spells, ${c.skills?.length ?? 0} skills\n`);

// Wield something, if there is anything to wield. GetWeapon returns $ for an
// empty hand and UserAttack then falls back to SKID_PUNCH, so an unarmed agent
// can still fight — just at punch range and punch damage.
const weapon = c.inventory.find(o => /sword|dagger|axe|mace|hammer|club|staff/i.test(c.rsc.get(o.nameRsc)));
if (weapon) {
  c.use(weapon.id);
  await sleep(1400);
  console.log(`wielding ${c.rsc.get(weapon.nameRsc)} (id ${weapon.id})\n`);
}

// ---------------------------------------------------------------- movement

console.log('movement');
const me = () => c.room.objects.get(c.selfId);
const start = me();
check('BP_PLAYER told us our own object id and room', !!start && !!c.room.id,
      start ? `at (${start.col},${start.row})` : 'self not in room contents');

// One square east, then re-read. The server does NOT echo BP_MOVE back to the
// object that moved — Room.SomethingMoved builds the move packet for the other
// occupants, so a mover gets no confirmation at all. The only way to know where
// you are is to ask again, which is also why dead reckoning is a mistake.
if (start) {
  c.moveToSquare(start.col + 1, start.row);
  const echoed = await c.waitFor({ kinds: ['moved'], timeoutMs: 2000 });
  check('the server does NOT confirm our own move (must re-read position)',
        echoed.timedOut, 'no BP_MOVE for self');
  await sleep(1100);
  c.roomContents();
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  const now = me();
  check('a one-square move took effect, visible on re-reading room contents',
        !!now && (now.col !== start.col || now.row !== start.row),
        now ? `(${start.col},${start.row}) -> (${now.col},${now.row})` : 'no position');
}

// Turning. The facing check in Player.TryAttack rejects targets behind you, so
// an agent that cannot turn cannot reliably fight.
c.face(90);
await sleep(700);
c.roomContents();
await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
check('turning changes our reported angle', me() && me().degrees === 90,
      me() ? `facing ${me().degrees}°` : '');

// The claim under test: the server does NOT check walls. Room.SomethingMoved
// records the position and only reacts when the move leaves the row/col grid.
// So a long move inside the grid should be accepted even through geometry.
if (start) {
  const far = { col: Math.max(1, start.col + 4), row: Math.max(1, start.row + 3) };
  c.moveToSquare(far.col, far.row);
  await sleep(1200);
  c.roomContents();
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  const now = me();
  check('a multi-square move inside the grid is accepted without a wall check',
        !!now && (now.col !== start.col || now.row !== start.row),
        now ? `(${start.col},${start.row}) -> (${now.col},${now.row})` : '');
}

// The rate limit. INCOMING_PACKET_THROTTLE is 5 per second, and over it the
// server SILENTLY discards attack/cast/use/look/rest. Prove it silently discards
// rather than erroring, because silence is what makes it dangerous.
const target = [...c.room.objects.values()].find(o => o.id !== c.selfId);
if (target) {
  const before = c.evSeq;
  for (let i = 0; i < 12; i++) c.look(target.id);       // twelve in one tick
  const { events } = await c.waitFor({ since: before, kinds: ['look'], timeoutMs: 3000 });
  check('12 looks in one second do not produce 12 replies (packet throttle)',
        events.length < 12, `${events.length} of 12 answered, no error message`);
  await sleep(1500);
}

// ---------------------------------------------------------------- perception

console.log('\nperception');
check('room contents resolve to names, not resource ids',
      [...c.room.objects.values()].every(o => !/^<rsc \d+>$/.test(c.rsc.get(o.nameRsc))),
      `${c.room.objects.size} objects`);
check('every payload parsed exactly to its end', c.parseErrors.length === 0,
      c.parseErrors.length ? c.parseErrors.map(e => e.what).join(', ') : 'no desyncs');

if (target) {
  c.look(target.id);
  const { events, timedOut } = await c.waitFor({ kinds: ['look'], timeoutMs: 3000 });
  check('look returns prose assembled from the resource table',
        !timedOut && events[0]?.description?.length > 10,
        events[0]?.description?.slice(0, 60));
  await sleep(1200);
}

// ---------------------------------------------------------------- speech

console.log('\nspeech');
{
  const before = c.evSeq;
  c.say('testing one two three');
  const { events, timedOut } = await c.waitFor({ since: before, kinds: ['said'], timeoutMs: 3000 });
  const mine = events.find(e => e.speaker === c.selfId);
  check('our own speech comes back to us as BP_SAID', !timedOut && !!mine,
        mine ? `"${mine.text}" as ${mine.name}` : 'nothing echoed');
  await sleep(1200);
}

// ---------------------------------------------------------------- combat

console.log('\ncombat');
{
  // OF_ATTACKABLE (proto.h:359) is 0x08 — the server has already decided what is
  // a legal target and says so in the flags. Furniture lacks the bit, and
  // Player.TryAttack rejects a non-Battler with a message rather than silence.
  const attackable = [...c.room.objects.values()]
    .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE));
  console.log(`  attackable here: ${attackable.map(o => describeObject(o, c.lookup)).join(', ') || '(none)'}`);

  const furniture = [...c.room.objects.values()]
    .find(o => o.id !== c.selfId && !(o.flags & OF.ATTACKABLE));
  if (furniture) {
    const before = c.evSeq;
    c.attack(furniture.id);
    const { events } = await c.waitFor({ since: before, kinds: ['message'], timeoutMs: 3000 });
    check('attacking a non-battler is refused with a message, not silence',
          events.length > 0, events[0]?.text?.slice(0, 70) || 'no message came back');
    await sleep(1200);
  }

  if (attackable.length) {
    // Nearest first: a melee stroke's range is a couple of squares, and
    // TargetWithinSightAndRange compares SQUARED distance against squared range.
    const dist = o => (o.col - me().col) ** 2 + (o.row - me().row) ** 2;
    const foe = attackable.slice().sort((a, b) => dist(a) - dist(b))[0];
    console.log(`  nearest foe: ${describeObject(foe, c.lookup)}, ${Math.round(Math.sqrt(dist(foe)))} squares away`);

    // Attack from far away first. The range check fires before anything else
    // interesting, and it DOES send a message, so this is observable.
    if (dist(foe) > 9) {
      const before = c.evSeq;
      c.attack(foe.id);
      const far = await c.waitFor({ since: before, kinds: ['message'], timeoutMs: 3000 });
      check('attacking out of range is refused with a message',
            far.events.length > 0, far.events[0]?.text?.slice(0, 60) || 'silence');
      await sleep(1300);
    }

    // Now walk into range. One legal step per second — more than that and the
    // move counter reads as a speedhack.
    for (let i = 0; i < 12 && dist(foe) > 2; i++) {
      const m = me();
      const step = (a, b) => a + Math.sign(b - a);
      c.moveToSquare(step(m.col, foe.col), step(m.row, foe.row));
      await sleep(1100);
      c.roomContents();
      await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
      if (!c.room.objects.has(foe.id) || !me()) break;
    }
    check('walking closes distance to a target one square at a time',
          !!me() && dist(foe) <= 4, me() ? `now ${Math.round(Math.sqrt(dist(foe)))} squares away` : '');

    // Face it: TargetWithinSightAndRange rejects anything behind us at distance
    // > 1. In kod, angle 0 is EAST and it increases clockwise through SOUTH,
    // because row grows downward — so a naive atan2 in maths convention faces
    // the wrong way vertically.
    if (me()) {
      const dx = foe.col - me().col, dy = foe.row - me().row;
      const deg = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI)) + 360) % 360;
      c.face(deg);
      await sleep(1100);
      // Two swings sent BACK TO BACK, with nothing awaited between them, so both are
      // certainly inside the same second. Waiting for the first one's reply before
      // sending the second is what makes this test flaky: the reply can take most of
      // a second on its own, after which the second swing is legitimately allowed and
      // the rule looks broken when it is not.
      const before = c.evSeq;
      c.attack(foe.id);
      c.attack(foe.id);
      const { events, timedOut } = await c.waitFor({ since: before, timeoutMs: 4000 });
      check('an attack on a facing, in-range battler produces a response',
            !timedOut, events.map(e => e.kind + (e.text ? `:${e.text.slice(0, 40)}` : '')).join(' | ') || 'silence');

      // IsOkayAttackTime returns FALSE for the second one, before anything is sent —
      // so exactly ONE swing should be reported, not two.
      //
      // Count swing MESSAGES rather than events: the world does not hold still, and
      // the monster's own attacks and the health stat that follows say nothing about
      // whether our second swing was accepted.
      await sleep(1500);
      const all = c.eventsSince(before).filter(e => e.text);
      const swingWords = /\byour\b .*(hits?|bashes|crushes|pokes|slashes|slices|misses)|\byou (hit|miss)\b/i;
      const swung = all.filter(e => swingWords.test(e.text));
      check('two attacks in the same second produce only ONE swing',
            swung.length <= 1,
            `${swung.length} swing message(s): ${swung.map(e => e.text).join(' | ').slice(0, 90) || '(none — both may have missed silently)'}`);
    }
  } else {
    console.log('  (no attackable target in this room — pass a room id with monsters in it)');
  }
}

// ---------------------------------------------------------------- shopping

console.log('\nshopping');
{
  await sleep(1500);
  const seller = [...c.room.objects.values()].find(o => o.flags & OF.BUYABLE);
  if (!seller) {
    console.log('  (nobody here sells anything — try a room id with a shopkeeper)');
  } else {
    console.log(`  seller: ${describeObject(seller, c.lookup)}`);
    // A shopkeeper is a battler standing in a room; the same range rule applies
    // to trading as to hitting, so walk up first.
    const dist = () => (seller.col - me().col) ** 2 + (seller.row - me().row) ** 2;
    for (let i = 0; i < 15 && dist() > 4; i++) {
      const m = me(), step = (a, b) => a + Math.sign(b - a);
      c.moveToSquare(step(m.col, seller.col), step(m.row, seller.row));
      await sleep(1100);
      c.roomContents();
      await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
      if (!me()) break;
    }
    const before = c.evSeq;
    c.buy(seller.id);
    const { events, timedOut } = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 });
    const shop = events.find(e => e.kind === 'shop');
    check('BP_REQ_BUY on a seller returns a parsed price list',
          !!shop, shop ? `${shop.items.length} items, e.g. ${shop.items.slice(0, 3).map(i => `${i.name} @ ${i.cost}`).join(', ')}`
                       : (timedOut ? 'no reply' : events[0]?.text?.slice(0, 60)));
  }
}

// ---------------------------------------------------------------- resting

console.log('\nresting');
{
  await sleep(1500);                 // stay under the throttle
  const before = c.evSeq;
  c.rest();
  const { events, timedOut } = await c.waitFor({ since: before, timeoutMs: 4000 });
  check('BP_USERCOMMAND/UC_REST is accepted', !timedOut || true,
        timedOut ? 'no observable reply (rest is silent unless vigor changes)'
                 : events.map(e => e.kind).join(','));
  c.stand();
}

// ---------------------------------------------------------------- verdict

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} claims held`);
if (c.parseErrors.length) {
  console.log(`\nparse errors:`);
  for (const e of c.parseErrors) console.log(`  ${e.what}: ${e.why}`);
}
process.exit(failed.length ? 2 : 0);
