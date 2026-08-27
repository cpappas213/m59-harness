#!/usr/bin/env node
// DOES THE BROKER'S GEOMETRY CACHE HAVE A CEILING?
//
//   node tools/m59-lru-test.mjs
//
// Offline. Imports the real module — opens no socket, touches no roster, starts no broker.
//
// WHY THIS FILE EXISTS. `_walkableCache` in m59-broker.mjs was `new Map()` with no
// eviction. Its name undersold it: nine key prefixes, and the largest entries are whole
// decoded `.roo` rooms. One entry per room per prefix across 264 rooms, resident for the
// life of the process.
//
// That is not a runaway leak — it is bounded by the world — and it is exactly the shape
// that hurt here anyway. Measured on prod 2026-08-27: the broker sat at 0.8-1.4 GB RSS
// taking ~10,700 page faults a second while Windows trimmed its working set (75 node
// processes, 22.3 GB combined, commit charge 62.8 of 91.8 GB). A full GC across a trimmed
// heap that size produced a 736-second event-loop stall, and the tell was the SHAPE of the
// failure: connections to 8901 were REFUSED, not slow, while the port sat listening —
// the accept backlog filling because nothing was calling accept().
//
// The rule being pinned is only this: the cache has a ceiling, the ceiling is enforced on
// the way in, and what falls out is the least recently USED rather than the least recently
// written. A cache that evicts what the fleet is standing on would trade resident memory
// for `.roo` re-parses on the one event loop every session shares, which is the worse bug.
import { Lru, LRU_MAX } from './m59-lru.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

console.log('it behaves like the Map it replaced');
{
  const c = new Lru(4);
  ok('a miss is undefined, not a throw', c.get('nothing') === undefined);
  ok('and has() says so', c.has('nothing') === false);
  c.set('geo:Valley of Ileria', { rooms: 1 });
  ok('what goes in comes out', c.get('geo:Valley of Ileria').rooms === 1);
  ok('has() finds it', c.has('geo:Valley of Ileria') === true);
  c.set('geo:Valley of Ileria', { rooms: 2 });
  ok('and overwriting replaces rather than duplicating',
     c.get('geo:Valley of Ileria').rooms === 2 && c.size === 1);
}

console.log('\nbut unlike that Map, it has a ceiling');
{
  const c = new Lru(3);
  for (let i = 0; i < 50; i++) c.set('w:room' + i, new Array(100).fill(i));
  ok('fifty rooms in, three resident', c.size === 3, `size ${c.size}`);
  ok('and it counted what it dropped', c.evictions === 47, `${c.evictions} evictions`);
  ok('the newest survive', c.has('w:room49') && c.has('w:room48') && c.has('w:room47'));
  ok('the oldest are gone', !c.has('w:room0') && !c.has('w:room46'));
}

console.log('\nleast recently USED, not least recently written');
{
  // THE ONE THAT MATTERS. The fleet stands in a handful of rooms and asks about them over
  // and over; a room-view sweep drags in a long tail of rooms nobody is in. Evicting by
  // insertion order would throw away the room the fleet is fighting in and keep the sweep's
  // leftovers — trading bounded memory for a `.roo` re-parse on the shared event loop.
  const c = new Lru(3);
  c.set('geo:Valley of Ileria', 'valley');
  c.set('geo:Deep Woods', 'woods');
  c.set('geo:Familiars', 'inn');
  c.get('geo:Valley of Ileria');            // the fleet is standing here
  c.set('geo:Barloque', 'city');            // a sweep drags in a fourth
  ok('the room that was READ most recently survives eviction',
     c.has('geo:Valley of Ileria'), 'the hot room was evicted — this is the bug');
  ok('the one nobody touched is what fell out', !c.has('geo:Deep Woods'));
  ok('and the newcomer is in', c.has('geo:Barloque'));
  ok('still at the ceiling', c.size === 3);
}

console.log('\nit reports enough to tell a good cap from a bad one');
{
  const c = new Lru(2);
  c.set('a', 1); c.set('b', 2);
  c.get('a'); c.get('a'); c.get('nope');
  const s = c.stats();
  ok('size and max', s.size === 2 && s.max === 2);
  ok('hits and misses', s.hits === 2 && s.misses === 1, JSON.stringify(s));
  ok('and a hit rate to judge the cap by', s.hit_rate === 0.67, `${s.hit_rate}`);
  ok('a cache nobody has asked anything reports no rate rather than zero',
     new Lru(2).stats().hit_rate === null);
}

console.log('\na pathological cap is refused rather than served');
{
  // A cap of zero is a re-parse on every single call, on the one event loop every session
  // shares. The repository's rule about settings applies: an unusable value keeps the
  // working default instead of quietly doing something nobody would have asked for.
  ok('zero falls back to the default', new Lru(0).max === LRU_MAX);
  ok('negative does too', new Lru(-5).max === LRU_MAX);
  ok('so does nonsense', new Lru(NaN).max === LRU_MAX && new Lru(undefined).max === LRU_MAX);
  ok('and a real number is honoured', new Lru(7).max === 7);
  ok('a fractional cap is floored, not left fractional', new Lru(7.9).max === 7);
}

console.log('\nand it is deliberately not a whole Map');
{
  // Iterating a cache whose contents evict underneath you is a bug waiting to be written.
  const c = new Lru(2);
  ok('no keys()', typeof c.keys !== 'function');
  ok('no entries()', typeof c.entries !== 'function');
  ok('no forEach()', typeof c.forEach !== 'function');
  ok('but delete and clear, which have obvious meanings', (() => {
    c.set('x', 1); const d = c.delete('x'); c.set('y', 2); c.clear();
    return d === true && c.size === 0;
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
