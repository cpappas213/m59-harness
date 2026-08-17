#!/usr/bin/env node
// m59-keeper-bt.mjs -- A dedicated behavior-tree keeper for Meridian 59.
//
// This is a clean, BT-only keeper that does not fall back to the legacy
// sequential code. It ticks a behavior tree every second and uses the
// result to decide what to do.
//
// The keeper is composed of:
// 1. A main loop that ticks every second
// 2. A blackboard that holds the live state
// 3. A root behavior tree that decides what to do
//
// The root tree is a selector that tries these in order:
// 1. Flee (if in danger)
// 2. Provision (if hungry or tired)
// 3. Farm (if hunting)
// 4. Roam (if nothing else to do)
//
// This keeper is opt-in via policy.useBTKeeper === true.

import { Selector, Sequence, Condition, Action, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { getFarmTree } from './m59-bt-farm.mjs';
import { getFleeTree } from './m59-bt-flee.mjs';
import { provisionTree } from './m59-bt-provision.mjs';
import { updateBlackboard } from './m59-bt-nodes.mjs';

// ---------------------------------------------------------------------------
// BT Keeper class
// ---------------------------------------------------------------------------

export class BTKeeper {
  constructor(session, policy = {}) {
    this.s = session;
    this.policy = policy;
    this._blackboard = {};
    this._farmTree = null;
    this._fleeTree = null;
    this._provisionTree = null;
    this._lastTick = 0;
    this._running = false;
  }

  // Get or create the farm tree
  _getFarmTree() {
    if (!this._farmTree) {
      this._farmTree = getFarmTree({ session: { keeper: this } });
    }
    return this._farmTree;
  }

  // Get or create the flee tree
  _getFleeTree() {
    if (!this._fleeTree) {
      this._fleeTree = getFleeTree({ session: { keeper: this } });
    }
    return this._fleeTree;
  }

  // Get or create the provision tree
  _getProvisionTree() {
    if (!this._provisionTree) {
      this._provisionTree = provisionTree(this);
    }
    return this._provisionTree;
  }

  // Compose the root tree
  _getRootTree() {
    const keeper = this;
    
    return new Selector([
      // 1. Flee if in danger
      new Sequence([
        new Condition((bb) => {
          const hp = bb.client?.vitals?.()?.health;
          return hp && hp.value < hp.max * 0.4;
        }),
        this._getFleeTree()
      ]),
      // 2. Provision if hungry or tired
      new Sequence([
        new Condition((bb) => {
          const vigor = bb.client?.vitals?.()?.vigor;
          return vigor && vigor.value < (keeper.policy.vigorCeiling || 200);
        }),
        this._getProvisionTree()
      ]),
      // 3. Farm if hunting
      new Sequence([
        new Condition((bb) => keeper.policy.hunt != null),
        this._getFarmTree()
      ])
      // 4. Roam (placeholder - not yet implemented)
    ]);
  }

  // Main tick - called every second
  async tick() {
    const now = Date.now();
    if (now - this._lastTick < 1000) return; // Rate limit to 1Hz
    this._lastTick = now;

    const s = this.s;
    const c = s.client;
    
    if (!s.live) {
      this.note('not in game');
      return;
    }

    // Update the blackboard
    const bb = updateBlackboard(
      this._blackboard,
      { client: c, session: this, policy: this.policy, room: s.world?.room },
    );
    bb.room = s.world?.room;

    // Get the root tree
    const tree = this._getRootTree();

    // Tick the tree (synchronous) with a timeout to prevent infinite loops
    const start = Date.now();
    const MAX_TICK_MS = 5000; // 5 second timeout
    
    let result = tree.tick(bb);
    
    // If the tree is running, wait and tick again (with a timeout)
    while (result === 'RUNNING' && (Date.now() - start) < MAX_TICK_MS) {
      await new Promise(r => setTimeout(r, 100));
      result = tree.tick(bb);
    }
    
    // If we hit the timeout, force stop
    if (result === 'RUNNING') {
      this.note('BT tick timed out');
      return;
    }

    // Log the result
    this.note('BT tick complete', { result });

    // If the tree is still running, don't do anything else
    if (result === 'RUNNING') return;

    // If the tree succeeded, we're done
    if (result === 'SUCCESS') return;

    // If the tree failed, log it
    this.note('BT tick failed', { result });
  }

  // Start the keeper loop
  async start() {
    if (this._running) return;
    this._running = true;
    this.note('BT keeper started');

    while (this._running) {
      try {
        await this.tick();
      } catch (err) {
        this.note('BT tick error', { error: err.message });
      }
      // Wait 1 second
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Stop the keeper loop
  stop() {
    this._running = false;
    this.note('BT keeper stopped');
  }

  // Log a note
  note(msg, data = {}) {
    console.log(`[bt-keeper] ${msg}`, data);
    // TODO: Integrate with the broker's logging
  }

  // --- Methods that the BT nodes expect on the keeper ---

  // Get the larder (food in the pack)
  larder(client) {
    // This is a stub - the real implementation is in the legacy keeper
    // For now, return an empty array
    return [];
  }

  // Get the purse (money)
  purse() {
    const c = this.s.client;
    return c.inventory
      ?.filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
      .reduce((t, o) => t + (o.amount || 1), 0) ?? 0;
  }

  // Withdraw from bank
  async withdrawForFood() {
    // Stub - not yet implemented
    this.note('withdrawForFood not implemented');
  }

  // Buy food in town
  async buyFoodInTown() {
    // Stub - not yet implemented
    this.note('buyFoodInTown not implemented');
  }

  // Note a progress update
  progress(msg) {
    this.note('progress: ' + msg);
  }
}


