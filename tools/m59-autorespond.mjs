#!/usr/bin/env node
// Tier 1, running inside the broker.
//
// `m59-responder.mjs` is the same thing as a separate process talking to the broker over
// HTTP. That is the better shape when you can have it — a separate credential scope and a
// separate blast radius. But when the broker is a stdio MCP server launched by an agent
// (`.mcp.json`), there is no HTTP endpoint for a second process to reach, and running a
// second broker instead would mean a second login on the same account, which the server
// refuses with AP_ACCOUNTUSED.
//
// So: the same loop, in here, driving the same `inbox` tool through a function reference
// instead of a socket. What it can do is unchanged, because what it can do was never
// about the process boundary — the model call declares no tools, gets one turn, and its
// only output path is `inbox reply`, which picks the recipient and the channel itself.
//
// It is off by default and starting it is an explicit act.

import { createDecider, routeDecision, DEFAULT_MODEL } from './m59-respond-core.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class AutoResponder {
  // `inbox` is the inbox tool's own run function, injected. This class never reaches for
  // any other tool, and that is the whole of its capability.
  constructor(inbox, { model = DEFAULT_MODEL, agent = null, idleMs = 4000,
                       batch = 6, journal = 200 } = {}) {
    this.inbox = inbox;
    this.model = model;
    this.agent = agent;          // null = every character that is listening
    this.idleMs = idleMs;
    this.batch = batch;
    this.journalMax = journal;
    this.running = false;
    this.decide = null;
    this.log = [];
    this.did = { seen: 0, answered: 0, escalated_to_operator: 0, declined: 0,
                 injections: 0, errors: 0 };
    this.lastError = null;
  }

  note(what, detail) {
    this.log.push({ at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), what, ...detail });
    if (this.log.length > this.journalMax) this.log.shift();
  }

  async start() {
    if (this.running) return this;
    // Build the decider before declaring ourselves running, so a missing SDK or a missing
    // API key is an error the caller sees immediately rather than a loop that fails
    // silently in the background forever.
    this.decide = await createDecider({ model: this.model });
    this.running = true;
    this.loop();
    return this;
  }

  stop() { this.running = false; }

  async pass() {
    const read = await this.inbox({ action: 'read', state: 'escalated', limit: this.batch,
                                    ...(this.agent ? { agent: this.agent } : {}) });
    const messages = read.messages ?? [];

    for (const m of messages) {
      if (!this.running) break;
      this.did.seen++;

      let out;
      try { out = await this.decide(m); }
      catch (e) {
        // Leave the item escalated and try again next pass. A model outage must not
        // consume the queue.
        this.did.errors++;
        this.lastError = e.message;
        this.note('error', { id: m.id, why: e.message });
        continue;
      }

      if (out.refused) {
        this.did.escalated_to_operator++;
        this.note('operator', { id: m.id, why: out.why });
        await this.inbox({ action: 'resolve', agent: m.agent, id: m.id,
                           state: 'operator', note: out.why });
        continue;
      }

      const d = out.decision;
      if (d.injection_suspected) this.did.injections++;
      const route = routeDecision(d);

      if (route.act === 'resolve') {
        if (route.state === 'operator') this.did.escalated_to_operator++;
        else this.did.declined++;
        this.note(route.state, { id: m.id, why: route.note });
        await this.inbox({ action: 'resolve', agent: m.agent, id: m.id,
                           state: route.state, note: route.note });
        continue;
      }

      const sent = await this.inbox({ action: 'reply', agent: m.agent, id: m.id,
                                      text: route.text });
      if (sent.replied) {
        this.did.answered++;
        this.note('answered', { id: m.id, said: sent.said, why: route.note });
      } else {
        this.note('withheld', { id: m.id, why: sent.why });
        // `retry` means a rate limit, which will pass. Anything else is the boundary
        // refusing, and the item should stop going round.
        if (!sent.retry)
          await this.inbox({ action: 'resolve', agent: m.agent, id: m.id,
                             state: sent.state ?? 'refused', note: sent.why });
      }
    }
    return messages.length;
  }

  async loop() {
    if (this._looping) return;
    this._looping = true;
    try {
      while (this.running) {
        let n = 0;
        try { n = await this.pass(); }
        catch (e) { this.did.errors++; this.lastError = e.message; this.note('error', { why: e.message }); }
        if (!n) await sleep(this.idleMs);
      }
    } finally { this._looping = false; }
  }

  status() {
    return {
      responding: this.running,
      model: this.model,
      scope: this.agent ?? 'every listening character',
      did: { ...this.did },
      ...(this.lastError ? { last_error: this.lastError } : {}),
      recent: this.log.slice(-12),
    };
  }
}

// One per broker process. The loop is fleet-wide by default, which is what you want:
// escalated items from every character land in the same queue and are drained in order.
let current = null;
export const autoResponder = () => current;
export async function startAutoResponder(inbox, opts) {
  if (current?.running) { current.stop(); }
  current = new AutoResponder(inbox, opts);
  await current.start();
  return current;
}
export function stopAutoResponder() {
  if (!current) return false;
  current.stop();
  const was = true;
  return was;
}
