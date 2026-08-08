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
  return {
    last_action: job.label,
    took_s: elapsed,
    ...(cancelled ? { cancelled: true }
      : job.error ? { failed: job.error }
      : { ok: true }),
  };
}
