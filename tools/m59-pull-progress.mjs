// Pull-follow progress, shared by the legacy keeper and the GOAP scavenge atomic.
// Pure and offline-testable: callers own storage and supply the live target snapshot.

const finitePosition = object => object
  && Number.isFinite(Number(object.col)) && Number.isFinite(Number(object.row));

export function pullDistance(target, wall) {
  if (!finitePosition(target) || !finitePosition(wall)) return null;
  return Math.hypot(Number(target.col) - Number(wall.col),
                    Number(target.row) - Number(wall.row));
}

export function beginPullProgress(target, wall, { now = Date.now() } = {}) {
  const distance = pullDistance(target, wall);
  return {
    wall: wall ? { room: wall.room ?? null, col: wall.col, row: wall.row } : null,
    last_sample_at: now,
    last_progress_at: now,
    last_position: finitePosition(target) ? { col: target.col, row: target.row } : null,
    last_distance: distance,
    best_distance: distance,
    non_closing_samples: 0,
    progress_samples: 0,
  };
}

// Sample no more often than `sampleEveryMs`. A target must fail to establish a new best
// distance for several consecutive samples before it is called stalled: one pause, one
// server packet arriving late, or one step around an obstacle is not a disengagement.
export function samplePullProgress(state, target, {
  now = Date.now(), sampleEveryMs = 3_000, stalledSamples = 3, minCloser = 0.25,
} = {}) {
  if (!state) return { state: null, sampled: false, missing: !target, stalled: false };
  if (!finitePosition(target))
    return { state, sampled: false, missing: true, stalled: false, distance: null };

  const distance = pullDistance(target, state.wall);
  if (!Number.isFinite(distance))
    return { state, sampled: false, missing: false, stalled: false, distance: null };

  const cadence = Math.max(250, Number(sampleEveryMs) || 3_000);
  const since = now - Number(state.last_sample_at ?? state.at ?? now);
  if (since < cadence) {
    return {
      state, sampled: false, missing: false, stalled: false, distance,
      closer: false, next_sample_in_ms: Math.max(0, cadence - since),
    };
  }

  const threshold = Math.max(0, Number(minCloser) || 0);
  const best = Number.isFinite(state.best_distance) ? state.best_distance : Infinity;
  const closer = threshold === 0 ? distance < best : distance <= best - threshold;
  const next = {
    ...state,
    last_sample_at: now,
    last_position: { col: target.col, row: target.row },
    last_distance: distance,
    progress_samples: (state.progress_samples ?? 0) + 1,
    non_closing_samples: closer ? 0 : (state.non_closing_samples ?? 0) + 1,
    ...(closer ? { best_distance: distance, last_progress_at: now } : {}),
  };
  const limit = Math.max(1, Math.floor(Number(stalledSamples) || 3));
  return {
    state: next, sampled: true, missing: false, closer, distance,
    stalled: next.non_closing_samples >= limit,
    stalled_samples: next.non_closing_samples,
    sample_limit: limit,
  };
}
