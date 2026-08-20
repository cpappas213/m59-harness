#!/usr/bin/env node
// m59-tick.mjs -- THE REAL-TIME CORE: sense, decide, actuate, at a fixed rate.
//
// This is the second driver model in this repository and it exists alongside the first,
// which is untouched. m59-autopilot.mjs and everything under it keep working exactly as
// they do; nothing here is on their path.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG WITH THE FIRST ONE
// ---------------------------------------------------------------------------
//
// The keeper is a blocking RPC script wearing an agent's clothes:
//
//     loop {
//       ws   = evaluate(client)     // sense
//       plan = planFor(ws)          // decide
//       await stepPlan(...)         // act -- BLOCKS, seconds at a time
//     }
//
// Sensing happens only at the top of a pass and the act phase blocks the next one, so
// HOW OFTEN THE AGENT LOOKS AT THE WORLD IS DECIDED BY HOW LONG IT SPENT NOT LOOKING.
// Measured on this fleet: median pass 80ms, p99 16.6s, worst 207s, and 82% of deaths
// had the keeper blind at the moment of death.
//
// The tell that this is a habit rather than a necessity is that THE SENSOR DATA IS
// ALREADY FREE. The server pushes it, unasked:
//
//     BP_MOVE      our own position, written into room.objects, `predicted` cleared
//     BP_STAT      health, mana, vigor, ability levels
//     BP_USE_LIST  equipment, whole; BP_USE/BP_UNUSE one line per change
//
// `client.vitals()` and `client.self` are in-memory reads of pushed state. They cost
// nothing and block on nothing. `Session.perception()` and `Session.snapshot()` are
// likewise synchronous -- not even async. Yet the old model asks the server for things
// it has already been told: `confirmPosition()` sends roomContents() and blocks up to
// eight seconds to learn a position that arrived by push before the request went out.
//
// THE PROOF THAT THIS MODEL WORKS IS ALREADY IN THE TREE. m59-watchdog.mjs is a fixed
// 500ms timer that reads pushed state, blocks on nothing, and is the only thing still
// awake while a pass is stuck. It had to be invented as a RESCUE for the main loop --
// and you do not need a rescue for a loop that is already sampling at a fixed rate.
//
// ---------------------------------------------------------------------------
// THE FIVE RULES
// ---------------------------------------------------------------------------
//
// 1. A TICK NEVER AWAITS AN ACTUATION. Commands go into the paced outbound queue and
//    the tick returns. If a tick ever awaits a reply, this is the old model again with
//    a timer bolted on.
//
// 2. THE SENSOR NEVER SENDS. Reading the world is free by construction. Anything that
//    needs a request (a shop list, a fresh inventory) is a COMMAND whose answer arrives
//    later as pushed state and is read by a later tick -- never waited for.
//
// 3. EFFECTS ARE OBSERVED, NOT RETURNED. The actuator reports what it SENT. Whether it
//    worked is answered by the next tick reading pushed state. This is the whole of the
//    "no error has never meant success" rule, made structural instead of remembered:
//    there is no return value to misread, because there is no return value.
//
// 4. THE TICK RATE IS FIXED AND INDEPENDENT OF THE SERVER. Latency changes how long a
//    command takes to land. It must not change how often we look.
//
// 5. A SLOW DECIDE SKIPS, IT DOES NOT QUEUE. If deciding overruns the interval the tick
//    is dropped rather than run late, because a backlog of stale decisions is worse
//    than a missed one -- the world has moved and the decision was made against a world
//    that is gone.
//
// ---------------------------------------------------------------------------
// WHAT WE ACCEPT, EXPLICITLY
// ---------------------------------------------------------------------------
//
// ONE TICK OF STALENESS. The old model blocked to confirm a position before validating
// the next step against local collision geometry. Here the validator reads the latest
// PUSHED position, which may be one tick old. That is a deliberate trade and the server
// is the reason it is safe: it is the collision authority, it silently refuses an
// illegal move, and a refusal costs a tick rather than a character.

const DEFAULT_HZ = 10;

// ---------------------------------------------------------------------------
// SENSOR -- free, synchronous, sends nothing
// ---------------------------------------------------------------------------
export class Sensor {
  constructor(session) { this.session = session; this.lastAt = 0; }

  // ONE FRAME OF THE WORLD, read from state the server already pushed.
  //
  // Deliberately built from `snapshot()` and `perception()` and NOT from `view()`:
  // view() runs A* for every object and exit, which is a tactical query and not a
  // sensor read. A sensor that got slower as the room got busier would put us back
  // where we started.
  read() {
    const s = this.session, c = s?.client;
    const at = Date.now();
    // HOW LONG SINCE WE LAST LOOKED, in wall clock. NOT for integrating anything -- the
    // server owns position and pushes it, and keeping our own dead-reckoned copy would
    // be a second, wrong world. It is here so a decider can tell a healthy cadence from
    // a degraded one: a frame that arrives 2s after the last means we were blind for 2s,
    // and some decisions (engaging, committing to a walk) deserve to know that.
    const dt = this.lastAt ? at - this.lastAt : null;
    this.lastAt = at;
    if (!c || s.live !== true || c.state !== 'game')
      return { in_game: false, at, dt_ms: dt };
    const me = c.self;
    return {
      at,
      dt_ms: dt,
      in_game: true,
      agent: s.name ?? null,
      character: c.me?.name ?? null,
      selfId: c.selfId ?? null,
      room: { id: c.room?.id ?? null, num: c.room?.num ?? null },
      // The position the SERVER last told us, and whether it is our own guess.
      // `predicted` is cleared by the BP_MOVE handler, so this distinguishes "the
      // server said so" from "we think so", which a decider is entitled to know.
      position: me ? { col: me.col, row: me.row, x: me.x, y: me.y,
                       predicted: me.predicted === true } : null,
      vitals: c.vitals?.() ?? null,
      objects: c.room?.objects ?? null,
      inventory: c.inventory ?? null,
      equipment: c.equipment?.() ?? null,
      evSeq: c.evSeq ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// ACTUATOR -- fire and forget, paced, never awaited by a tick
// ---------------------------------------------------------------------------
//
// Every method here returns IMMEDIATELY. The Pacer is already an independent queue --
// `submit()` returns a promise and pumps on its own -- so the change is simply that
// nobody awaits it. What each call returns is a record of what was SENT.
export class Actuator {
  constructor(session) {
    this.session = session;
    this.sent = [];            // a small ring, for the record and for tests
    this.maxSent = 64;
  }

  get depth() { return this.session?.pacer?.depth ?? 0; }

  // The one place a command reaches the wire. `kind` feeds the Pacer's per-kind
  // spacing, which is how the door settle and the move interval are honoured.
  _send(kind, fn, minGapMs = 0) {
    const rec = { kind, at: Date.now(), ok: null };
    this.sent.push(rec);
    if (this.sent.length > this.maxSent) this.sent.shift();
    try {
      const p = this.session.pacer.submit(kind, fn, minGapMs);
      // NOT AWAITED. The catch is attached so a refusal cannot become an unhandled
      // rejection and take the process down -- it is bookkeeping, not a result.
      Promise.resolve(p).then(() => { rec.ok = true; }, (e) => { rec.ok = false; rec.why = e?.message; });
    } catch (e) { rec.ok = false; rec.why = e?.message; }
    return rec;
  }

  // -- movement. One square, sent, not confirmed. The next tick reads where we are.
  step(col, row, { minGapMs = 250 } = {}) {
    const c = this.session.client;
    return this._send('move', () => c.moveToSquare(col, row), minGapMs);
  }
  face(degrees) {
    const c = this.session.client;
    return this._send('move', () => c.face(degrees), 0);
  }
  go() {
    const c = this.session.client;
    return this._send('move', () => c.go(), 0);
  }

  // -- combat
  swing(targetId) {
    const c = this.session.client;
    return this._send('attack', () => c.attack(targetId), 1050);
  }

  // -- posture. Sitting down IS the behaviour when recovering; it is not a stall.
  rest()  { const c = this.session.client; return this._send('rest',  () => c.rest()); }
  stand() { const c = this.session.client; return this._send('stand', () => c.stand()); }

  // -- objects
  use(id)        { const c = this.session.client; return this._send('use',  () => c.use(id)); }
  unuse(id)      { const c = this.session.client; return this._send('use',  () => c.unuse(id)); }
  pickUp(id)     { const c = this.session.client; return this._send('get',  () => c.get(id)); }
  drop(ids)      { const c = this.session.client; return this._send('drop', () => c.drop([].concat(ids))); }
  // Eating is APPLY onto ourselves -- `use` on a loaf does nothing at all (food.kod:56).
  eat(id)        { const c = this.session.client; return this._send('act',  () => c.apply(id, c.selfId)); }
  cast(spellId, targets = []) {
    const c = this.session.client;
    return this._send('cast', () => c.cast(spellId, targets), 1050);
  }

  // -- trade
  openShop(merchantId) { const c = this.session.client; return this._send('buy',   () => c.buy(merchantId)); }
  offer(id, items)     { const c = this.session.client; return this._send('trade', () => c.offer(id, items)); }
  acceptOffer()        { const c = this.session.client; return this._send('trade', () => c.acceptOffer()); }

  // -- REQUESTS ARE COMMANDS, NOT QUESTIONS.
  //
  // The reply arrives as pushed state and a later tick reads it. Nothing here waits.
  // This is rule 2, and it is the one that is easiest to break by accident: the moment
  // somebody awaits one of these to "just get the inventory", the tick blocks again.
  requestInventory() { const c = this.session.client; return this._send('read', () => c.requestInventory()); }
  requestRoom()      { const c = this.session.client; return this._send('read', () => c.roomContents()); }
}

// ---------------------------------------------------------------------------
// TICK LOOP
// ---------------------------------------------------------------------------
export class TickLoop {
  /**
   * @param {object}   session  the Session (connection, pacer, pushed state)
   * @param {function} decide   (frame, actuator, ctx) -> void. SYNCHRONOUS by contract:
   *                            it may inspect the frame and call the actuator, and it
   *                            must not await anything. Returning a promise is treated
   *                            as a programming error and reported once.
   * @param {number}   hz       ticks per second
   */
  constructor({ session, decide, hz = DEFAULT_HZ, onError = null }) {
    if (!session) throw new Error('TickLoop: no session');
    if (typeof decide !== 'function') throw new Error('TickLoop: no decide()');
    this.session = session;
    this.decide = decide;
    this.intervalMs = Math.max(10, Math.round(1000 / hz));
    this.sensor = new Sensor(session);
    this.actuator = new Actuator(session);
    this.onError = onError;
    this.timer = null;
    this.busy = false;
    this.stats = { ticks: 0, skipped: 0, errors: 0, awaited: 0,
                   longest_decide_ms: 0, lastError: null };
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    // RULE 5: overrun SKIPS. A decide that is still running means the world has moved
    // under the one in progress; running a second against an older frame would build a
    // backlog of decisions about a world that is gone.
    if (this.busy) { this.stats.skipped++; return; }
    this.busy = true;
    const t0 = Date.now();
    try {
      const frame = this.sensor.read();
      if (!frame.in_game) return;
      const out = this.decide(frame, this.actuator, this);
      // RULE 1, ENFORCED RATHER THAN TRUSTED. A decide that returns a promise is doing
      // something asynchronous, which is the exact habit this model exists to remove.
      // It is reported and NOT awaited -- awaiting it here would quietly reintroduce
      // the blocking loop while every counter still said "tick".
      if (out && typeof out.then === 'function') {
        this.stats.awaited++;
        this.stats.lastError = 'decide() returned a promise; a tick must not await';
        Promise.resolve(out).catch(() => {});
      }
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e?.message ?? String(e);
      // A throwing decide must not kill the timer. That is how a guard dies silently.
      try { this.onError?.(e); } catch { /* the reporter is not allowed to matter */ }
    } finally {
      const ms = Date.now() - t0;
      if (ms > this.stats.longest_decide_ms) this.stats.longest_decide_ms = ms;
      this.stats.ticks++;
      this.busy = false;
    }
  }
}
