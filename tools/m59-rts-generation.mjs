// Process-local, monotonic generation IDs for complete cached RTS reads.
//
// Date.now() alone is not an identity: two aggregate reads can begin in the same
// millisecond and observe different worlds.  The first numeric component stays
// compatible with the order freshness parser while advancing at least once for
// every accepted generation in this broker process.  The PID retains restart
// identity.  observed_at remains the actual capture clock and is carried
// separately by the aggregate.

export class RtsGenerationClock {
  #last = -1;

  next(observedAtMs, brokerPid) {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
      throw new Error('RTS generation time must be a nonnegative safe integer');
    if (!Number.isSafeInteger(brokerPid) || brokerPid < 1)
      throw new Error('RTS generation broker PID must be a positive safe integer');
    const generationMs = Math.max(observedAtMs, this.#last + 1);
    if (!Number.isSafeInteger(generationMs))
      throw new Error('RTS generation clock exhausted the safe integer range');
    this.#last = generationMs;
    return Object.freeze({
      observed_at: new Date(generationMs).toISOString(),
      sequence: `${generationMs}-${brokerPid}`,
    });
  }
}

export const brokerRtsGenerationClock = new RtsGenerationClock();
