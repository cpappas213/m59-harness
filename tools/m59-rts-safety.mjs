// Fail-closed policy for spells exposed through the RTS control surface.
//
// A zero-target wire arity does not mean a spell is harmless: Earthquake is the
// important counterexample.  Names here are therefore an audited exact allowlist,
// and the observed wire arity must also match.  Callers retain and send the exact
// server-observed spelling; this module only classifies it case-insensitively.

const SAFE_SPELLS = new Map(Object.entries({
  // creafood.kod / creaweap.kod: create inventory for the caster, zero targets.
  'create food': { targets: 0, target_mode: 'none' },
  'create weapon': { targets: 0, target_mode: 'none' },
  // blink.kod teleports only the caster to the room's local place of power.
  'blink': { targets: 0, target_mode: 'none' },
}).map(([name, rule]) => [name, Object.freeze({ ...rule })]));

export function rtsSafeSpellRule(name, targets) {
  if (typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(targets)) return null;
  const rule = SAFE_SPELLS.get(name.trim().toLowerCase());
  return rule && rule.targets === targets ? rule : null;
}

export function rtsSpellTargetAllowed(rule, {
  targetId = null,
  selfId = null,
  targetIsPlayer = null,
} = {}) {
  if (!rule) return false;
  if (rule.target_mode === 'none') return targetId === null;
  if (!Number.isSafeInteger(targetId) || targetId < 1) return false;
  if (rule.target_mode === 'self')
    return Number.isSafeInteger(selfId) && selfId > 0 && targetId === selfId;
  if (rule.target_mode === 'pve') return targetIsPlayer === false;
  return false;
}

export const RTS_SAFE_SPELL_NAMES = Object.freeze([...SAFE_SPELLS.keys()]);

// THE CONTROL PLANE IS LOCAL; THE GAME SERVER NEED NOT BE.
//
// The broker's JSON-RPC transport carries every RTS write, has no authentication of
// its own, and M59_BIND can deliberately bind it to a LAN interface — so being able to
// reach it is not authority to drive a character. Reads are already refused off-loopback
// at the socket regardless of that bind; this is the same statement for writes, and it
// is what replaced the old rule that the GAME server had to be a local lab. That rule
// was a blast-radius proxy rather than a check: it conflated "the commander is on this
// machine" with "the target is disposable", and it made a shared remote server
// undrivable for no security gain.
//
// A caller is local when its transport says so: stdio is a pipe from the process that
// spawned the broker, and an HTTP request must have arrived from loopback on a loopback
// Host header. Absent or malformed context is refused — a control tool that cannot tell
// where it came from has no business sending a Meridian packet.
export function rtsCallerIsLocal(caller) {
  return !!caller && caller.local === true && typeof caller.transport === 'string' &&
    caller.transport.length > 0;
}

export function requireRtsLocalCaller(caller) {
  if (!rtsCallerIsLocal(caller))
    throw new Error('RTS control is accepted only from this machine: the broker\'s ' +
      'JSON-RPC transport is unauthenticated and may be bound beyond loopback');
  return caller;
}

// Run the authority chain synchronously inside a pacer callback. Callers provide
// closures over broker state so this module stays independent of sessions and
// autopilots. Ordering matters: a packet never reaches action validation unless its
// endpoint, keeper, room, and token owner are still authoritative; an owned cancel
// then wins over a target/item race and produces cancellation telemetry.
export function rtsPacketAuthorityCheck({ packet, detail = null, endpoint, keeper, room,
                                           owner, cancelled, validate = null }) {
  endpoint();
  keeper();
  room(packet);
  owner(packet);
  if (cancelled()) return true;
  if (typeof validate === 'function') validate(packet, detail);
  return false;
}

export function rtsCleanupAuthorityCheck({ packet, endpoint, keeper, room, owner }) {
  endpoint();
  keeper();
  room(packet);
  owner(packet);
}

// Background RTS jobs are exposed as renderer telemetry after they finish. An owned
// cancellation is authoritative even when the underlying helper returned an ordinary
// result (attack stops its loop) or threw while unwinding (recovery cleanup can lose
// authority). Never let those races turn a user-requested stop into `ok` or `failed`.
export function rtsJobReport(job, now = Date.now()) {
  if (!job) return undefined;
  const elapsed = Math.max(0, Math.round(((job.finishedAt || now) - job.startedAt) / 1000));
  if (!job.done) {
    return {
      busy: job.label,
      running_for_s: elapsed,
      ...(job.cancelled || job.cancelRequestedAt ? { stopping: true } : {}),
    };
  }
  const cancelled = job.cancelled === true || job.cancelRequestedAt != null ||
    job.result?.cancelled === true || job.result?.recovery?.cancelled === true;
  const commerceResult = typeof job.kind === 'string' && job.kind.startsWith('commerce:') && job.result
    ? {
        commerce_result: {
          kind: job.result.kind ?? job.kind.slice('commerce:'.length),
          quote_id: job.result.quote_id ?? null,
          committed: job.result.committed === true,
          verification_failed: job.result.verification_failed === true,
          state: job.result.state ?? null,
          evidence: job.result.evidence ?? null,
        },
      }
    : {};
  return {
    last_action: job.label,
    took_s: elapsed,
    // `ok` MEANT "THE FUNCTION RETURNED", WHICH IS NOT WHAT ANY READER THINKS IT MEANS.
    //
    // A journey that gives up resolves normally -- `{arrived:false, reason:'...'}` is a
    // return value, not a throw -- so it landed in the `ok: true` default below and the job
    // reported success. Measured on shadow: `travel to 2` from inside Ukgoth answered
    // `{last_action:'walk to room 2', took_s:0, ok:true}` while the character did not move a
    // square, from four different starting positions, and every instrument above this one
    // repeated the claim. It is the same class of mistake as `busy` being absent and read as
    // false: a field whose failure mode is looking fine.
    //
    // A result that carries `arrived` is a movement job, and for those `arrived` IS the
    // outcome. Anything else keeps the old meaning, because a commerce or errand job has no
    // such field and its own verification is handled above.
    ...(cancelled ? { cancelled: true }
      : job.error ? { failed: job.error }
      : job.result?.verification_failed === true || job.result?.committed === false
        ? { failed: 'server outcome could not be verified; no success was claimed' }
      : job.result && job.result.arrived === false
        ? { failed: job.result.reason ?? job.result.note ?? 'did not arrive, and gave no reason' }
      : { ok: true }),
    ...commerceResult,
  };
}
