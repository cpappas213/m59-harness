// THE CONTRACT FOR REMEMBERING A WALK, AND FOR THE INSTRUMENT THAT SAYS WHICH TACTIC PAID.
//
// Both of these exist because fixes were being chosen by argument rather than by evidence.
// The failure modes they have are quiet ones — a book that silently replaces the router, a
// summary that averages a tactic across the situations where it is right and the ones where
// it is wrong — so they are pinned here rather than trusted.
//
// Runs against scratch directories and opens no socket.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-trip-'));
process.env.M59_TRIPS_DIR = join(scratch, 'trips');
process.env.M59_TACTICS_DIR = join(scratch, 'tactics');

const { simplify, recordTrip, recallTrip, tripKey, loadTrips } = await import('./m59-tripbook.mjs');
const { recordTactic, flushTactics, readTactics, summarise } = await import('./m59-tactics.mjs');

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  ' + detail : '')); }
};

console.log('the trip book: what it keeps, and what it refuses to keep');
{
  // THE WIGGLING IS THE POINT. A walk that went out and came back has done a round trip,
  // and replaying it would replay the round trip.
  const wiggly = [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
                  { row: 1, col: 2 }, { row: 1, col: 3 }, { row: 1, col: 4 }];
  const tidy = simplify(wiggly);
  ok('a loop in a recorded walk is elided, not replayed',
     tidy.length === 4 && tidy[3].col === 4,
     JSON.stringify(tidy));

  ok('a walk too short to be worth remembering is refused',
     simplify([{ row: 1, col: 1 }]) === null);

  // The pull is the caller's, because the geometry is. A pull that throws must not lose the
  // recording — the un-pulled trail is still better than nothing.
  ok('a string pull that throws leaves the elided trail intact',
     simplify(wiggly, { pull: () => { throw new Error('no geometry'); } }).length === 4);
  ok('a string pull that returns nothing leaves the elided trail intact',
     simplify(wiggly, { pull: () => [] }).length === 4);
}

console.log('\na trip is only learned from a walk that went well');
{
  const clean = [{ row: 5, col: 5 }, { row: 5, col: 6 }, { row: 5, col: 7 }];
  ok('a walk that stumbled is not recorded',
     recordTrip({ room: 587, to: 576, squares: clean, stumbles: 2, fleet: 'test' }) === null);
  ok('a walk that lost health is not recorded',
     recordTrip({ room: 587, to: 576, squares: clean, hp_lost: 7, fleet: 'test' }) === null);
  ok('a clean walk is recorded',
     recordTrip({ room: 587, to: 576, squares: clean, fleet: 'test' })?.steps.length === 3);
}

console.log('\nand the book gets better rather than merely consistent');
{
  const longer = [{ row: 9, col: 1 }, { row: 9, col: 2 }, { row: 9, col: 3 }, { row: 9, col: 4 }];
  const shorter = [{ row: 9, col: 1 }, { row: 9, col: 4 }];
  recordTrip({ room: 100, to: 101, squares: longer, fleet: 'test' });
  recordTrip({ room: 100, to: 101, squares: shorter, fleet: 'test' });
  ok('a shorter clean route replaces a longer one',
     recallTrip(100, 101, null, { fleet: 'test' })?.steps.length === 2);
  recordTrip({ room: 100, to: 101, squares: longer, fleet: 'test' });
  ok('and a longer one does not replace it, but still counts as a sighting',
     recallTrip(100, 101, null, { fleet: 'test' })?.steps.length === 2 &&
     recallTrip(100, 101, null, { fleet: 'test' })?.seen >= 2);
}

console.log('\nthe two rules that would be silent if broken');
{
  // NULL MEANS PLAN IT THE WAY YOU ALWAYS DID. Every consumer reads it that way, so a book
  // that answered with an empty route would strand a fleet while looking like a cache miss.
  ok('an unknown trip recalls null, never an empty route',
     recallTrip(999, 998, null, { fleet: 'test' }) === null);

  // ONE WALL, TWO DESTINATIONS. Western border of the Twisted Wood declares east -> 586 and
  // east -> 597 on the same boundary. A book keyed by direction would hand one approach to
  // both and send a character to the wrong town with every leg reporting success.
  ok('the key names the destination, so one wall cannot serve two rooms the same approach',
     tripKey(587, 586) !== tripKey(587, 597));
  recordTrip({ room: 587, to: 586, squares: [{ row: 1, col: 1 }, { row: 1, col: 2 }], fleet: 'test' });
  recordTrip({ room: 587, to: 597, squares: [{ row: 40, col: 1 }, { row: 40, col: 2 }], fleet: 'test' });
  const a = recallTrip(587, 586, null, { fleet: 'test' });
  const b = recallTrip(587, 597, null, { fleet: 'test' });
  ok('and the two really are remembered apart',
     a.steps[0].row === 1 && b.steps[0].row === 40,
     JSON.stringify({ a: a.steps[0], b: b.steps[0] }));
}

console.log('\nthe tactic ledger: scored against the trigger, never on its own');
{
  // The same tactic, right in one situation and wrong in another. Averaged it reads 50%,
  // which is exactly the number that would keep it in use where it is doing harm.
  for (let i = 0; i < 4; i++)
    recordTactic({ tactic: 'breadcrumb_retreat', trigger: 'no_route', worked: true,
                   ms: 900, room: 585, fleet: 'test' });
  for (let i = 0; i < 4; i++)
    recordTactic({ tactic: 'breadcrumb_retreat', trigger: 'body_blocked', worked: false,
                   ms: 4000, hp_lost: 6, room: 587, fleet: 'test' });
  flushTactics('test');
  const rows = readTactics({ fleet: 'test', hours: 1 });
  ok('every application is written down', rows.length === 8, String(rows.length));
  const table = summarise(rows);
  const good = table.find(c => c.trigger === 'no_route');
  const bad = table.find(c => c.trigger === 'body_blocked');
  ok('the same tactic is reported separately per trigger',
     table.length === 2 && good.success === 1 && bad.success === 0,
     JSON.stringify(table.map(c => [c.trigger, c.success])));
  ok('and what the bad one COST is carried, not just that it failed',
     bad.total_ms === 16000 && bad.hp_lost === 24,
     JSON.stringify({ ms: bad.total_ms, hp: bad.hp_lost }));
  ok('the room it keeps failing in is named',
     bad.worst_rooms[0]?.room === 587, JSON.stringify(bad.worst_rooms));

  // THE OUTCOME IS THE CALLER'S, NOT THE TACTIC'S. A tactic that ran without error and left
  // the walk exactly as stuck is a failure, and that is the commonest kind.
  recordTactic({ tactic: 'needle_wait', trigger: 'body_blocked', room: 587, fleet: 'test' });
  flushTactics('test');
  const after = summarise(readTactics({ fleet: 'test', hours: 1 }));
  ok('a tactic that did not say it worked is counted as not working',
     after.find(c => c.tactic === 'needle_wait').worked === 0);
}

console.log('\nneither instrument may break the thing it measures');
{
  ok('a malformed tactic row is swallowed rather than thrown',
     recordTactic(null) === null || true);
  ok('a malformed trip is refused rather than thrown',
     recordTrip({ room: 'nonsense', to: 1, squares: [] }) === null);
  ok('a trip with no squares at all is refused',
     recordTrip({ room: 1, to: 2, squares: null, fleet: 'test' }) === null);
  ok('the book survives being asked for a fleet that has none',
     JSON.stringify(loadTrips('never-existed')) === '{}');
}

console.log('');
console.log('an object id is not a room number, and the two indexes must never merge');
{
  const { roomIndex, resolveRoom } = await import('./m59-trails.mjs');
  // The real shape of the collision: room 1 (the Underworld) has object id 6, and room 6
  // (The Deep Dark Woods of Marion) exists. 30 of the world's 264 object ids collide with
  // some room's number like this, so a single map that accepts either answers 11% of
  // lookups with the wrong room and cannot be told that it is doing so.
  const map = { rooms: {
    1: { num: 1, objId: 6,  nameRsc: 900, roomRsc: 800 },
    6: { num: 6, objId: 42, nameRsc: 901, roomRsc: 801 },
  } };
  const idx = roomIndex(map);
  ok('an object id resolves to its own room, not to the room of the same number',
     resolveRoom(idx, { room: 6 }) === 1, String(resolveRoom(idx, { room: 6 })));
  ok('and the room whose NUMBER is 6 is still reachable by its own object id',
     resolveRoom(idx, { room: 42 }) === 6, String(resolveRoom(idx, { room: 42 })));

  // THE STABLE KEY WINS. objId is renumbered by every `save game`; nameRsc and roomRsc come
  // from BP_PLAYER and survive one. A sample carrying both must be resolved by the durable
  // one, or a ledger silently re-points at different rooms after a save.
  ok('the stable name resource beats a stale object id',
     resolveRoom(idx, { room: 42, room_name_rsc: 900 }) === 1);
  ok('and the room resource does too',
     resolveRoom(idx, { room: 42, room_rsc: 800 }) === 1);
  ok('a sample with no stable key still resolves by object id',
     resolveRoom(idx, { room: 6 }) === 1);
  ok('and an unknown room resolves to null rather than to a guess',
     resolveRoom(idx, { room: 12345 }) === null);
}

rmSync(scratch, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
