// Pure normalization for the terminal fleet board.
//
// Broker fleet rows intentionally keep common fields flat, while a keeper's operational
// detail is a nested status object.  The TUI historically put `/mode` under `ap` and then
// tried to read deaths/walls/threat from it; those fields were never there.  Keeping this
// merge pure makes that contract testable without starting an interactive terminal.

const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;

export function mergeTuiRow(row = {}, keeper = null) {
  const remote = keeper?.autopilot_status ?? null;
  const compact = row.autopilot ?? {};
  const remoteDid = remote?.did ?? {};
  const deaths24h = finite(row.deaths_24h) ?? 0;
  const deathsRun = finite(row.deaths_since_keeper_start) ??
    finite(row.deaths) ?? finite(remoteDid.deaths) ?? 0;
  const ap = {
    ...compact,
    ...(remote ?? {}),
    running: keeper?.goap?.running ?? remote?.running ?? compact.running ?? false,
    mode: keeper?.goap?.mode ?? remote?.mode ?? compact.mode ?? null,
    activity: remote?.activity ?? row.activity ?? null,
    policy: remote?.policy ?? row.policy ?? null,
    did: {
      ...remoteDid,
      kills: finite(row.kills) ?? finite(remoteDid.kills) ?? finite(compact.kills) ?? 0,
      kills_30m: finite(row.kills_30m) ?? finite(remoteDid.kills_30m) ??
        finite(compact.kills_30m) ?? 0,
      deaths: deathsRun,
      deaths_24h: deaths24h,
      deaths_in_safe_spot: finite(row.deaths_in_safe_spot) ??
        finite(remoteDid.deaths_in_safe_spot) ?? 0,
      deaths_in_proven_safe_spot: finite(row.deaths_in_proven_safe_spot) ??
        finite(remoteDid.deaths_in_proven_safe_spot) ?? 0,
      mulligans: finite(row.mulligans) ?? finite(remoteDid.mulligans) ?? 0,
      logoffs: finite(row.logoffs) ?? finite(remoteDid.logoffs) ?? 0,
    },
    last_death: remote?.last_death ?? row.last_death ?? null,
  };

  // Prefer the broker's age because an explicit fleet refresh accounts for both cache
  // layers.  Direct keeper state is the fallback when an older broker does not expose it.
  const directAge = finite(keeper?.as_of_ms);
  const brokerAge = finite(row.snapshot_age_ms);
  return {
    ...row,
    ap,
    snapshot_age_ms: brokerAge ?? directAge,
    keeper_port: keeper?.__port ?? null,
  };
}

export function fleetFreshness(rows = [], staleAfterMs = 10_000) {
  const ages = rows.map(r => finite(r.snapshot_age_ms)).filter(v => v != null);
  const unknown = rows.length - ages.length;
  const stale = rows.filter(r => {
    const age = finite(r.snapshot_age_ms);
    return age != null && age > staleAfterMs;
  });
  return {
    known: ages.length,
    unknown,
    stale,
    max_age_ms: ages.length ? Math.max(...ages) : null,
  };
}

