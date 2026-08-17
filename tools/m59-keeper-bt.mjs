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
import { updateBlackboard } from './m59-bt-nodes.mjs';

const PASS_LIMIT_MS = 30_000;   // a full pass may travel, but never forever

export class BTKeeper {
  constructor(keeper, opts = {}) {
    if (!keeper) throw new Error('BTKeeper: no keeper supplied');
    this.k = keeper;                       // the legacy keeper we drive
    this._bb = opts.blackboard || {};      // persists across ticks (slot state)
    this._fleeTree = null;
    this._farmTree = null;
  }

  _flee() {
    if (!this._fleeTree) this._fleeTree = getFleeTree({ session: { keeper: this.k } });
    return this._fleeTree;
  }
  _farm() {
    if (!this._farmTree) this._farmTree = getFarmTree({ session: { keeper: this.k } });
    return this._farmTree;
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
    let r = await this._flee().tickAsync(bb);
    if (r === 'RUNNING') { await this._drain(bb, this._flee(), limit); }
    if (r === 'SUCCESS' || r === 'RUNNING') return;   // handled this pass

    // 2. FARM. The hunting pass; provision is its first node, so "eat if
    //    hungry" runs before any swing.
    r = await this._farm().tickAsync(bb);
    if (r === 'RUNNING') { await this._drain(bb, this._farm(), limit); }
    if (r === 'SUCCESS' || r === 'RUNNING') return;   // handled this pass

    // 3. NOTHING THE TREES HANDLE. Delegate to the legacy pass() so a
    //    not-yet-decomposed behaviour still runs. This is the seam that
    //    shrinks as the decomposition completes. The _btKeeperPass flag stops
    //    the legacy pass() from re-entering this driver and recursing.
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
}
