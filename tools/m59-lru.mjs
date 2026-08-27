#!/usr/bin/env node
// m59-lru.mjs -- A BOUNDED CACHE, BECAUSE THE BROKER'S BIGGEST ONE WAS NOT.
//
// WHY THIS EXISTS. `_walkableCache` in m59-broker.mjs was a bare `new Map()` with no
// eviction, and its name undersold it: it is keyed by NINE different prefixes and what it
// stores is not a walkable array but, in the worst case, an entire decoded `.roo` —
//
//   geo:<room>            a whole parsed room: BSP, sidedefs, wall chains
//   w:<room>              the walkable grid
//   h:<roo>:<rows>x<cols> a height grid, one number per cell
//   hc:<roo>              hidden cells
//   gw:/gw2:/gw3:/gw4:    the room-view's grid, walls, heights and hidden cells
//
// One entry per room per prefix, across 264 rooms, held for the life of the process. It is
// not a runaway leak — it is bounded by the world — but it is a large, permanently-resident
// heap that never shrinks, and on this machine that is the thing that hurts. Measured
// 2026-08-27: the prod broker sat at 0.8-1.4 GB RSS taking ~10,700 page faults a second
// while Windows trimmed its working set (75 node processes, 22.3 GB combined, commit charge
// 62.8 of 91.8 GB). A full GC over a trimmed heap of that size is what produced a 736-second
// event-loop stall — long enough that the accept backlog filled and connections to 8901 were
// REFUSED while the port sat listening.
//
// So the cache is capped. The point is not to make it small — a cache that misses is a
// re-parse on the event loop every session shares — it is to stop it being UNBOUNDED, so
// the resident set has a ceiling that does not depend on how many rooms the fleet has
// wandered through since the broker started.
//
// It is its own file rather than a class inside the broker for the reason
// docs/m59-tests.md keeps making: m59-broker.mjs cannot be imported without taking the
// fleet lock and starting rejoin timers, so a rule that lives in it is a rule nobody can
// ask a question about offline. See m59-lru-test.mjs.

// HOW MANY ENTRIES. Not bytes: entry sizes here differ by three orders of magnitude (a
// walkable grid against a whole decoded room) and measuring them would cost more than the
// cache saves. A count is the honest approximation.
//
// 48 is chosen against the ACCESS PATTERN rather than the world size. A fleet is in a
// handful of rooms at a time and asks about them repeatedly; what evicts is the long tail
// a room-view sweep drags in, which is exactly the part that should not be resident for
// ever. Every room the fleet is actually standing in stays hot.
export const LRU_MAX = Number(process.env.M59_LRU_MAX || 48);

// A drop-in for the `has`/`get`/`set` a Map was being used for, and DELIBERATELY NOT a full
// Map: the broker used exactly those three, and implementing the rest would invite someone
// to iterate a cache whose contents evict underneath them.
export class Lru {
  constructor(max = LRU_MAX) {
    // A cache of zero or fewer is a re-parse on every call, on the one event loop every
    // session shares. Refuse it rather than quietly serving a pathological setting — the
    // repository's own rule about a value that does not do what it says.
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : LRU_MAX;
    this.map = new Map();
    this.hits = 0; this.misses = 0; this.evictions = 0;
  }

  get size() { return this.map.size; }

  has(key) { return this.map.has(key); }

  // READING IS WHAT MAKES AN ENTRY RECENT, and that is the whole of the policy. Map keeps
  // insertion order, so deleting and re-inserting moves an entry to the young end and the
  // oldest key is simply the first one the iterator yields. No timestamps, no heap.
  get(key) {
    if (!this.map.has(key)) { this.misses++; return undefined; }
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    this.hits++;
    return value;
  }

  set(key, value) {
    // Overwriting is also a use: delete first so the entry lands at the young end rather
    // than keeping the position it was first inserted at.
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }
    return this;
  }

  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }

  // For /health and for anyone asking whether the cap is set too low to be worth having.
  stats() {
    const looks = this.hits + this.misses;
    return { size: this.map.size, max: this.max, hits: this.hits, misses: this.misses,
             evictions: this.evictions,
             hit_rate: looks ? Math.round((this.hits / looks) * 100) / 100 : null };
  }
}
