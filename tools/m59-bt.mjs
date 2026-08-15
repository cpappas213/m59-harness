#!/usr/bin/env node
// m59-bt.mjs -- behavior tree primitives for the Meridian 59 keeper.
//
// Replaces the sequential if/return chains in the keeper's `pass()` method
// with a composable tree. Each node exposes a single method:
//
//     node.tick(blackboard) -> 'SUCCESS' | 'FAILURE' | 'RUNNING'
//
// The blackboard is a plain mutable object shared by the whole tree. Action
// nodes that return RUNNING stash their per-instance state under a private
// `_bt` namespace on the blackboard so subsequent ticks can resume them.
//
// Node types exported:
//   - Selector(children)  : tries left-to-right, returns first SUCCESS
//   - Sequence(children)  : returns FAILURE on first FAILURE
//   - Condition(fn)       : synchronous predicate, no side effects
//   - Action(fn)          : async; may return RUNNING and be re-entered
//   - Inverter(child)     : inverts SUCCESS<->FAILURE, passes RUNNING through
//   - Timeout(maxMs,child): returns FAILURE if child doesn't finish in time
//   - Retry(n, child)     : resets child state and retries up to n times
//
// Constants SUCCESS / FAILURE / RUNNING are also exported so callers can
// compare against them directly without string lookups.
//
// No broker, no autopilot, no I/O -- pure in-memory tree mechanics.

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

export const SUCCESS = 'SUCCESS';
export const FAILURE = 'FAILURE';
export const RUNNING = 'RUNNING';

// ---------------------------------------------------------------------------
// Composite nodes
// ---------------------------------------------------------------------------

// Selector: try children in order; return first SUCCESS. If all FAILURE -> FAILURE.
// RUNNING from a child is returned immediately and the tree resumes from that
// child on the next tick.
export class Selector {
  constructor(children) {
    this.children = children;
    this._name = 'Selector';
  }
  tick(bb) {
    for (const child of this.children) {
      const r = child.tick(bb);
      if (r === SUCCESS || r === RUNNING) return r;
    }
    return FAILURE;
  }
}

// Sequence: run children in order; return first FAILURE. All SUCCESS -> SUCCESS.
// RUNNING from a child short-circuits (later children are skipped) and is
// remembered implicitly because Action nodes stash their state on the bb.
export class Sequence {
  constructor(children) {
    this.children = children;
    this._name = 'Sequence';
  }
  tick(bb) {
    for (const child of this.children) {
      const r = child.tick(bb);
      if (r === FAILURE || r === RUNNING) return r;
    }
    return SUCCESS;
  }
}

// ---------------------------------------------------------------------------
// Leaf nodes
// ---------------------------------------------------------------------------

// Condition: synchronous predicate. MUST be side-effect free so re-ticking
// during RUNNING elsewhere doesn't poison the world state.
export class Condition {
  constructor(fn) {
    this.fn = fn;
    this._name = 'Condition';
  }
  tick(bb) {
    return this.fn(bb) ? SUCCESS : FAILURE;
  }
}

// Action: async. The fn is given (bb) and may return one of three values:
//   - SUCCESS / FAILURE : terminal, action done
//   - RUNNING          : not done yet; state is stashed on bb._bt[key] and
//                        re-entered next tick (still async)
//   - a Promise        : awaited; its resolved value is interpreted as above.
//
// Action instances are tracked under bb._bt. An action's *private* state can
// be a counter, a timer, a partial result, anything -- the BT just calls fn
// again next tick and lets the action decide what to do with the result.
export class Action {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `act_${Math.random().toString(36).slice(2, 10)}`;
    this._name = opts.name || 'Action';
  }
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    const out = this.fn(bb, slot);
    if (out && typeof out.then === 'function') {
      // Async action: the caller is expected to await tick(). We return the
      // promise's eventual status via a microtask -- but our tick API is
      // synchronous. For async, the action's fn should resolve immediately to
      // RUNNING and stash its real work in slot.promise. On the next tick the
      // action awaits slot.promise and reports its final status. See
      // m59-bt-test.mjs for the canonical pattern.
      bb._bt[this.key] = { promise: out };
      return RUNNING;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Decorators
// ---------------------------------------------------------------------------

// Inverter: SUCCESS -> FAILURE, FAILURE -> SUCCESS. RUNNING passes through.
export class Inverter {
  constructor(child) {
    this.child = child;
    this._name = 'Inverter';
  }
  tick(bb) {
    const r = this.child.tick(bb);
    if (r === SUCCESS) return FAILURE;
    if (r === FAILURE) return SUCCESS;
    return RUNNING;
  }
}

// Timeout(maxMs, child): if the child doesn't reach a terminal status within
// maxMs wall-clock milliseconds, this returns FAILURE. We track the start
// time under bb._bt so re-ticks don't reset the clock.
export class Timeout {
  constructor(maxMs, child) {
    this.maxMs = maxMs;
    this.child = child;
    this._key  = `timeout_${Math.random().toString(36).slice(2, 10)}`;
    this._name = 'Timeout';
  }
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this._key] ||= { start: Date.now() };
    const r = this.child.tick(bb);
    if (r === SUCCESS || r === FAILURE) {
      delete bb._bt[this._key];
      return r;
    }
    if (Date.now() - slot.start > this.maxMs) {
      delete bb._bt[this._key];
      return FAILURE;
    }
    return RUNNING;
  }
}

// Retry(n, child): if the child returns FAILURE, clear its private slot so
// the next tick restarts it. Repeat up to n times. After n failures, return
// FAILURE. SUCCESS short-circuits, RUNNING passes through.
export class Retry {
  constructor(n, child) {
    this.n = n;
    this.child = child;
    this._name = 'Retry';
  }
  tick(bb) {
    let last = null;
    for (let i = 0; i <= this.n; i++) {
      last = this.child.tick(bb);
      if (last === SUCCESS || last === RUNNING) return last;
      // Child returned FAILURE -- wipe any state it stashed so the retry
      // starts from scratch. Action nodes expose their slot key as `.key`;
      // other node types don't stash state, so the delete is a no-op for them.
      if (bb._bt && this.child.key) delete bb._bt[this.child.key];
    }
    return FAILURE;
  }
}

// ---------------------------------------------------------------------------
// Convenience builders
// ---------------------------------------------------------------------------

// selector(...children) -> Selector
// sequence(...children) -> Sequence
// These exist so callers can write `selector(c1, c2)` instead of
// `new Selector([c1, c2])` for tree literals.
export function selector(...children) {
  return new Selector(children);
}
export function sequence(...children) {
  return new Sequence(children);
}

// ---------------------------------------------------------------------------
// Convenience: walk a tree and call fn(node) on every node for debugging /
// pretty-printing. Not used by the tree itself, but handy for tests and the
// introspection tooling that will live in tools/m59-bt-nodes.mjs.
// ---------------------------------------------------------------------------

export function walk(node, fn, depth = 0) {
  if (!node) return;
  fn(node, depth);
  if (Array.isArray(node.children)) {
    for (const c of node.children) walk(c, fn, depth + 1);
  }
  if (node.child) walk(node.child, fn, depth + 1);
}
