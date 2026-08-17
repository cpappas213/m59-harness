#!/usr/bin/env node
// m59-keeper-bt.mjs -- the behavior-tree keeper: a dedicated driver for a
// Meridian 59 character, built on the decomposed BT trees.
//
// WHAT THIS IS AND IS NOT
//
// This is NOT a re-implementation of travel/fight/provision. Those live in the
// legacy keeper (m59-autopilot.mjs) and are battle-tested against the server's
// silent failures. Re-implementing them here would be the "wrapper" antipattern
// the whole decomposition exists to avoid -- we would spend a month rebuilding
// what 12,000 lines of field debugging already earned.
//
// What this file owns is the DECISION LADDER: given the state this pass, what is
// the highest-priority thing the character should be doing? The legacy pass()
// answers that with a long if/else chain, with the BT bolted in as opt-in
// shortcuts that fall through to the sequential code. This driver inverts the
// relationship: the tree is the primary path and the legacy methods are the
// leaves it delegates to. A character driven here and one driven by pass()
// perform identical actions for identical states; only the ORDER of evaluation
// and the ability to re-order without a 12,000-line edit differ.
//
// The ladder, top to bottom (safety before work, work before idle):
//   1. fleeAndRest  -- doomed / fleeing / sanctuary / wall / leave-room / rest
//   2. farm         -- provision / retarget / room-invalid / bags / cap /
//                      no-target / unarmed / hurt / tired / fight
//
// Each branch is a subtree already decomposed and tested in its own module.
// A branch that finds nothing (FAILURE) yields to the next; if every branch
// fails, the driver delegates to the legacy pass() so a not-yet-decomposed
// behaviour still runs. That fallback is the "decompose, don't wrap" seam: as
// more behaviour moves into the trees, the fallback shrinks until it is gone.
//
// CONTRACT
//   const legacy = new Autopilot(session, policy);   // owns session/pacer/notes
//   const driver = new BTKeeper(legacy);
//   await driver.pass();                              // drop-in for legacy.pass()

import { getFleeTree } from './m59-bt-flee.mjs';
import { getFarmTree } from './m59-bt-farm.mjs';
import { getTownTree } from './m59-bt-town.mjs';
import { updateBlackboard } from './m59-bt-nodes.mjs';

const PASS_LIMIT_MS = 30_000;   // a full pass may travel, but never forever

export class BTKeeper {
  constructor(keeper, opts = {}) {
    if (!keeper) throw new Error('BTKeeper: no keeper supplied');
    this.k = keeper;                       // the legacy keeper we drive
    this._bb = opts.blackboard || {};      // persists across ticks (slot state)
    this._fleeTree = null;
    this._farmTree = null;
    this._townTreeCache = null;
  }

  _flee() {
    if (!this._fleeTree) this._fleeTree = getFleeTree({ session: { keeper: this.k } });
    return this._fleeTree;
  }
  _farm() {
    if (!this._farmTree) this._farmTree = getFarmTree({ session: { keeper: this.k } });
    return this._farmTree;
  }

  // ── Decision trace ──────────────────────────────────────────────────────────
  //
  // WHY THIS EXISTS: post-mortems record WHAT happened (health trail, threats,
  // where) but not WHY the decisions were wrong. A death at 2 HP with 6 monsters
  // is only actionable if you can see which BT nodes evaluated, which fired,
  // which returned FAILURE, and what each one decided. Without this, every death
  // is reverse-engineered by hand from the journal + frames. With this, the
  // journal carries a one-line-per-pass trace: which node won, which were
  // consulted and rejected, and the state that drove the decision.
  //
  // The trace is a compact array on the blackboard (bb._trace), one entry per
  // leaf node that was ticked this pass. After the pass settles, it is emitted
  // as a single journal note. The entries are tiny (name + status + key state)
  // so the journal stays readable.
  //
  // It is NOT a full node-evaluation log (that would be noise: a pass ticks
  // 10+ nodes, most of which trivially return FAILURE). It records the nodes
  // that MATTER: the one that won (SUCCESS/RUNNING) and, for safety-critical
  // trees, the ones that were consulted but rejected (so you can see "doomed
  // was checked, health was 5/29, and it correctly passed" vs "doomed was
  // checked, health was 5/29, and it FAILED when it should have fired").
  _traceTree(label, tree, bb) {
    const trace = (bb._trace = bb._trace || []);
    trace.push(`[BT:${label}]`);
    const children = tree.children;
    if (!Array.isArray(children)) return tree;   // not a flat selector; no trace
    // Wrap each child: record its result, pass through its return value.
    const wrapped = children.map(child => ({
      tick: (b) => {
        const r = child.tick(b);
        trace.push({ node: child._name || child.key || 'node', r });
        return r;
      },
      tickAsync: async (b) => {
        const r = typeof child.tickAsync === 'function'
          ? await child.tickAsync(b) : child.tick(b);
        trace.push({ node: child._name || child.key || 'node', r });
        return r;
      },
      _name: child._name,
      key: child.key,
    }));
    // Return a new selector that ticks the wrapped children in order.
    return {
      tick: (b) => {
        for (const c of wrapped) {
          const r = c.tick(b);
          if (r === 'SUCCESS' || r === 'RUNNING') return r;
        }
        return 'FAILURE';
      },
      tickAsync: async (b) => {
        for (const c of wrapped) {
          const r = await c.tickAsync(b);
          if (r === 'SUCCESS' || r === 'RUNNING') return r;
        }
        return 'FAILURE';
      },
    };
  }

  // Emit the accumulated trace as a single journal note. Called at the end of
  // a pass, or before a return, so the trace is never lost.
  _emitTrace(bb) {
    const trace = bb._trace;
    if (!trace || !trace.length) return;
    // Compact: [BT:flee] doomed=SUCCESS  provision=FAILURE  fight=RUNNING
    const parts = [];
    for (const entry of trace) {
      if (typeof entry === 'string') { parts.push(entry); continue; }
      parts.push(`${entry.node}=${entry.r}`);
    }
    // Only log the trace when it is informative: something fired (SUCCESS or
    // RUNNING), or the pass fell through to legacy (all FAILURE). A pass where
    // farm/fight simply ran is the steady state and logging it every pass would
    // bury the signal. Log when: any node returned SUCCESS/RUNNING in a safety
    // tree, OR the whole pass delegated to legacy.
    const fired = trace.some(e => typeof e !== 'string' && (e.r === 'SUCCESS' || e.r === 'RUNNING'));
    const delegated = this._delegatedThisPass;
    if (fired || delegated) {
      this.k.note?.('bt-trace', { trace: parts.join(' ') });
    }
    bb._trace = null;
    this._delegatedThisPass = false;
  }

  // One pass of the driver. Drop-in replacement for keeper.pass().
  async pass() {
    const k = this.k;
    const s = k.s;
    if (!s?.live) { k.note?.('bt-keeper: not in game'); return; }
    const c = s.client;

    // Refresh the blackboard with the live world state. updateBlackboard
    // preserves the strategic fields GOAP writes between ticks and re-points
    // the live refs.
    const bb = updateBlackboard(this._bb, {
      client: c, session: k, policy: k.policy, room: s.world?.room,
    });
    bb.room = s.world?.room;

    const started = Date.now();
    const limit = () => Date.now() - started > PASS_LIMIT_MS;

    // 0. SAFETY FIRST, and not optional. The legacy pass() runs these before any work
    //    because they are the only things that matter when a character is dead or has
    //    lost its grip on the world: a character in the Underworld cannot path-travel
    //    out (no graph exits), so if the trees run first the farm node sees "this room
    //    has no prey", tries to travel, fails, and loops there forever. A dead Lee did
    //    exactly that: "this room cannot produce our prey -- leaving now" from The
    //    Underworld, on and on. Delegate to the same legacy methods the classic pass()
    //    uses -- they are the battle-tested logic; the trees only take over the parts
    //    (flee/rest and farm) that are actually decomposed. Everything below these is
    //    moot if we are dead.
    if (!c.self) {
      k.selfMissingPasses = (k.selfMissingPasses || 0) + 1;
      if (k.selfMissingPasses >= 3) {
        k.note?.('bt-keeper: lost our own object id -- reconnecting');
        const again = typeof k.reconnect === 'function'
          ? await k.reconnect('recovering a renumbered object id').catch(() => ({ ok: false }))
          : { ok: false };
        k.selfMissingPasses = 0;
        k.note?.(again.ok ? 'reconnected' : 'reconnect failed');
        k.noProgress?.('reconnecting after losing our object id');
        return;
      }
    } else k.selfMissingPasses = 0;

    // 1. UNDERWORLD. Dead -> escape via a portal. Must run before the trees, or a
    //    dead character farms in a room it cannot leave. passUnderworld returns true
    //    when it handled the pass (we are in the Underworld).
    if (await k.passUnderworld?.(s, c, s.world?.room)) return;

    // 2. ARM. A character with no weapon must be armed before it does anything else.
    if (await k.passArm?.(s, c)) return;

    // 3. FLEE AND REST. Safety always beats work.
    const fleeTree = this._traceTree('flee', this._flee(), bb);
    let r = await fleeTree.tickAsync(bb);
    if (r === 'RUNNING') { await this._drain(bb, fleeTree, limit); }
    if (r === 'SUCCESS' || r === 'RUNNING') { this._emitTrace(bb); return; }   // handled this pass

    // 4. TOWN BUSINESS: sell loot and bank the surplus before farming spends the
    //    pass. The legacy pass() does this (bankSurplus / bankRun) but the BT keeper
    //    skipped it entirely, so a BT character looted kills for hours and never
    //    converted the loot to money -- the bags filled, the purse never moved, and
    //    "sustainably profitable" was never testable. Delegate to the same legacy
    //    methods so the sell/bank/restock logic is not reimplemented here.
    if (await this._townBusiness(k, s, c)) { this._emitTrace(bb); return; }

    // 5. FARM. The hunting pass; provision is its first node, so "eat if
    //    hungry" runs before any swing.
    const farmTree = this._traceTree('farm', this._farm(), bb);
    r = await farmTree.tickAsync(bb);
    if (r === 'RUNNING') { await this._drain(bb, farmTree, limit); }
    if (r === 'SUCCESS' || r === 'RUNNING') { this._emitTrace(bb); return; }   // handled this pass

    // 6. NOTHING THE TREES HANDLE. Delegate to the legacy pass() so a
    //    not-yet-decomposed behaviour still runs. This is the seam that
    //    shrinks as the decomposition completes. The _btKeeperPass flag stops
    //    the legacy pass() from re-entering this driver and recursing.
    this._delegatedThisPass = true;
    this._emitTrace(bb);   // log the all-FAILURE trace before delegating
    k.note?.('bt-keeper: trees found nothing; delegating to legacy pass');
    const prev = k._btKeeperPass;
    k._btKeeperPass = true;
    try {
      await k.pass();
    } finally {
      k._btKeeperPass = prev;
    }
  }

  // A subtree reported RUNNING: it is mid-action (travelling, swinging,
  // buying). Keep ticking it until it settles or the pass limit is hit, so a
  // long async action is not abandoned mid-flight.
  async _drain(bb, tree, limit) {
    while (!limit()) {
      await new Promise(res => setTimeout(res, 250));
      const r = await tree.tickAsync(bb);
      if (r !== 'RUNNING') return r;
    }
    this.k.note?.('bt-keeper: pass limit hit; releasing a RUNNING tree');
    return 'RUNNING';
  }

  // Town business: BT-native subtree. Replaces the legacy delegation.
  // The tree ticks: in_bank → trip_machine (should_trip → travel → business → return).
  // Returns true when the pass was spent on town business (no farming this pass).
  _townTree() {
    if (!this._townTreeCache) this._townTreeCache = getTownTree(this.k);
    return this._townTreeCache;
  }

  async _townBusiness(k, s, c) {
    if (k._btKeeperPass) return false;             // guard against re-entry via legacy pass
    const tree = this._traceTree('town', this._townTree(), this._bb);
    const r = await tree.tickAsync(this._bb);
    if (r === 'RUNNING') return true;   // trip in progress
    if (r === 'SUCCESS') return true;   // did town business this pass
    return false;
  }
}
