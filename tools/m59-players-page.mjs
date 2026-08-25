// m59-players-page.mjs -- /players dashboard tab
// Shows sightings, targets, active conflicts, per-player movement trails and heatmaps.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV, STYLE, esc, ago } from './m59-page-chrome.mjs';
import { readHistory, roomHeatmap, playerStats, movementTrail,
         timeOfDayPattern, zonePattern, followingDetection, ZONE_MAP } from './m59-intel.mjs';

const HERE      = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');
const SEEN_PATH       = join(SUBSTRATE, 'players-seen.json');
const TARGETS_PATH    = join(SUBSTRATE, 'targets.json');
const CONFLICTS_PATH  = join(SUBSTRATE, 'active-conflicts.json');
const HISTORY_DIR     = join(SUBSTRATE, 'player-history');

function readJSON(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

const THREAT_COLOUR = {
  none:       'var(--dim)',
  suspicious: 'var(--edge)',
  target:     'var(--bad)',
};

// Build sorted list of all known players (from history dir + seen index).
function knownPlayerNames() {
  const from_seen = Object.keys(readJSON(SEEN_PATH));
  const from_dir  = existsSync(HISTORY_DIR)
    ? readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6))
    : [];
  // The history filenames are sanitised; try to match back to seen names.
  return [...new Set([...from_seen, ...from_dir.map(f => f.replace(/_/g, ' '))])];
}

export function renderPlayers(query = '') {
  const seen      = readJSON(SEEN_PATH);
  const targets   = readJSON(TARGETS_PATH);
  const conflicts = readJSON(CONFLICTS_PATH);
  const now       = Date.now();

  const SUSPICIOUS_WINDOW_MS = 10 * 60_000;

  const entries = Object.values(seen)
    .sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));

  // Active conflicts (not expired)
  const liveConflicts = Object.values(conflicts).filter(cf => now < cf.expires_at);

  // ---- Summary pills
  const targetCount     = Object.keys(targets).length;
  const suspiciousCount = entries.filter(s => s.threat_level === 'suspicious' && !targets[s.name]).length;
  const recentCount     = entries.filter(s => now - (s.last_seen ?? 0) < 5 * 60_000).length;

  const summary = `
    <div class="pills">
      <span class="pill">${entries.length} players seen</span>
      <span class="pill" style="color:var(--bad)">${targetCount} target${targetCount !== 1 ? 's' : ''}</span>
      <span class="pill" style="color:var(--edge)">${suspiciousCount} suspicious</span>
      <span class="pill" style="color:var(--good)">${recentCount} seen &lt;5m ago</span>
      ${liveConflicts.length ? `<span class="pill" style="color:var(--bad);font-weight:600">⚔ ${liveConflicts.length} ACTIVE CONFLICT${liveConflicts.length > 1 ? 'S' : ''}</span>` : ''}
    </div>`;

  // ---- Active conflicts section
  const conflictsSection = liveConflicts.length === 0
    ? `<p class="dim">No active conflicts.</p>`
    : `<table>
    <thead><tr><th>Target</th><th>Room</th><th>Reported by</th><th>Started</th><th>Updated</th></tr></thead>
    <tbody>${liveConflicts.map(cf => `
    <tr>
      <td><strong style="color:var(--bad)">${esc(cf.target)}</strong></td>
      <td class="dim">${cf.room_name ? `${esc(cf.room_name)} (${cf.room})` : (cf.room ?? '--')}</td>
      <td class="dim">${esc(cf.reporter)}</td>
      <td class="dim">${ago(cf.started_at)}</td>
      <td class="dim">${ago(cf.updated_at)}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;

  // ---- Active targets section
  const targetRows = Object.values(targets)
    .sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0))
    .map(t => {
      const s = seen[t.name];
      const loc = s?.last_room_name ? `${esc(s.last_room_name)} (${s.last_room})` : (s?.last_room ?? '--');
      return `
    <tr>
      <td><strong>${esc(t.name)}</strong></td>
      <td>${t.auto_attack ? '<span style="color:var(--bad)">⚔ auto-attack</span>' : 'observe'}</td>
      <td class="dim">${t.assigned_to ?? 'any'}</td>
      <td style="text-align:right;color:var(--good)">${t.kills ?? 0}</td>
      <td class="dim">${ago(t.added_at)}</td>
      <td class="dim">${esc(t.reason ?? '')}</td>
      <td class="dim">${loc}</td>
    </tr>`;
    }).join('');

  const targetsSection = Object.keys(targets).length === 0
    ? `<p class="dim">No targets.</p>`
    : `<table>
    <thead>
      <tr><th>Name</th><th>Mode</th><th>Assigned to</th><th style="text-align:right">Kills</th><th>Added</th><th>Reason</th><th>Last location</th></tr>
    </thead>
    <tbody>${targetRows}</tbody>
  </table>`;

  // ---- Main sightings table
  const rows = entries.map(s => {
    const isTarget = !!targets[s.name];
    const tEntry   = targets[s.name];
    const threat   = isTarget ? 'target' : (s.threat_level ?? 'none');
    const kills    = s.confirmed_kills ?? 0;

    const threatLabel = isTarget
      ? `<span style="color:var(--bad);font-weight:600">TARGET${tEntry?.auto_attack ? ' ⚔' : ''}</span>`
      : threat === 'suspicious'
        ? `<span style="color:var(--edge)">suspicious</span>`
        : `<span style="color:var(--dim)">--</span>`;

    const recent = (s.recent ?? []).filter(x => now - x.at < SUSPICIOUS_WINDOW_MS).length;
    const loc = s.last_room_name
      ? `${esc(s.last_room_name)} <span class="dim">(${s.last_room})</span>`
      : String(s.last_room ?? '--');

    return `
    <tr class="player-row" data-name="${esc(s.name)}" style="cursor:pointer" onclick="toggleDetail('${esc(s.name.replace(/'/g, "\\'"))}')">
      <td><strong>${esc(s.name)}</strong></td>
      <td>${threatLabel}</td>
      <td style="text-align:right">${s.total_sightings ?? 0}${recent > 0 ? ` <span class="dim">(${recent} recent)</span>` : ''}</td>
      <td class="dim">${ago(s.last_seen)}</td>
      <td>${loc}</td>
      <td class="dim">${esc(s.last_seen_by ?? '--')}</td>
      <td style="text-align:right;color:${kills>0?'var(--good)':'var(--dim)'}">${kills > 0 ? kills : '--'}</td>
    </tr>
    <tr class="detail-row" id="detail-${esc(s.name)}" style="display:none">
      <td colspan="7" style="background:var(--panel);padding:.5rem 1rem">
        ${renderPlayerDetail(s.name, s)}
      </td>
    </tr>`;
  }).join('');

  const tableOrEmpty = entries.length === 0
    ? `<p class="dim" style="margin:2rem 0">No player sightings recorded yet. Sightings are logged whenever a non-fleet player appears in the same room as a keeper.</p>`
    : `<table>
    <thead>
      <tr>
        <th>Player</th><th>Threat</th><th style="text-align:right">Sightings</th>
        <th>Last seen</th><th>Last location</th><th>Seen by</th>
        <th style="text-align:right">Fleet kills</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian 59 -- Players</title>
<meta http-equiv="refresh" content="30">
<style>
${STYLE}
body { font-family: system-ui, sans-serif; font-size: 14px; margin: 0;
       background: var(--bg); color: var(--fg); }
.wrap { max-width: 1200px; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
h2 { font-size: .85rem; margin: 1.5rem 0 .4rem; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
h3 { font-size: .85rem; margin: .6rem 0 .3rem; color: var(--dim); }
table { width: 100%; border-collapse: collapse; margin: .5rem 0 1.5rem; }
th { text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
     color: var(--dim); border-bottom: 1px solid var(--line); padding: .25rem .4rem; }
td { padding: .28rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.dim { color: var(--dim); }
.pills { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0 1rem; }
.pill { background: var(--panel); border: 1px solid var(--line); border-radius: 4px;
        padding: .15rem .5rem; font-size: .8rem; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.trail-entry { font-size: .8rem; padding: .15rem 0; border-bottom: 1px solid var(--line); }
.heatmap-bar { display: inline-block; height: 8px; background: var(--edge); vertical-align: middle; border-radius: 2px; }
.player-row:hover td { background: var(--panel); }
</style>
</head><body>
<div class="wrap">
${NAV('players')}
<h1>Players</h1>
${summary}

<h2>Active Conflicts</h2>
${conflictsSection}

<h2>Active Targets</h2>
${targetsSection}

<h2>All Sightings</h2>
<p class="dim" style="font-size:.75rem;margin-bottom:.5rem">Click a row to expand movement trail and location heatmap.</p>
${tableOrEmpty}

<p class="dim" style="font-size:.75rem;margin-top:2rem">
  Add target: <code>node tools/m59-intel.mjs --add &lt;name&gt; --auto-attack</code> &nbsp;|&nbsp;
  Remove: <code>node tools/m59-intel.mjs --remove &lt;name&gt;</code> &nbsp;|&nbsp;
  History: <code>node tools/m59-intel.mjs --player &lt;name&gt;</code> &nbsp;|&nbsp;
  Heatmap: <code>node tools/m59-intel.mjs --heatmap &lt;name&gt;</code>
</p>
</div>
<script>
function toggleDetail(name) {
  const row = document.getElementById('detail-' + name);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? '' : 'none';
}
</script>
</body></html>`;
}

function renderPlayerDetail(name, index) {
  const trail = movementTrail(name, 25);
  const heat  = roomHeatmap(name).slice(0, 10);
  const total = heat.reduce((t, r) => t + r.count, 0);
  const maxCount = heat[0]?.count ?? 1;

  const trailHtml = trail.length === 0
    ? `<p class="dim" style="font-size:.8rem">No movement history yet.</p>`
    : trail.map(r => `
      <div class="trail-entry">
        <span class="dim" style="font-size:.75rem;min-width:80px;display:inline-block">${fmtAgoShort(r.at)}</span>
        <span style="min-width:42px;display:inline-block;color:var(--dim);font-size:.75rem">${r.room}</span>
        <span>${esc(r.room_name ?? '?')}</span>
        <span class="dim" style="font-size:.75rem"> via ${esc(r.observer ?? '?')}</span>
      </div>`).join('');

  const heatHtml = heat.length === 0
    ? `<p class="dim" style="font-size:.8rem">No data.</p>`
    : heat.map(r => {
        const pct = Math.round(r.count / total * 100);
        const barW = Math.round(r.count / maxCount * 80);
        return `
      <div class="trail-entry">
        <span style="min-width:42px;display:inline-block;color:var(--dim);font-size:.75rem">${r.room}</span>
        <span style="min-width:180px;display:inline-block;font-size:.8rem">${esc(r.room_name ?? '?')}</span>
        <span class="heatmap-bar" style="width:${barW}px"></span>
        <span class="dim" style="font-size:.75rem;margin-left:.3rem">${r.count}x (${pct}%)</span>
      </div>`;
      }).join('');

  const stats = playerStats(name);
  const meta = `<div style="font-size:.8rem;color:var(--dim);margin-bottom:.5rem">
    First seen: ${fmtAgoShort(stats.first_seen)} &nbsp;*&nbsp;
    ${stats.unique_rooms} unique rooms &nbsp;*&nbsp;
    ${stats.total_sightings} total sightings
    ${stats.confirmed_kills ? ` &nbsp;*&nbsp; <span style="color:var(--good)">${stats.confirmed_kills} fleet kill${stats.confirmed_kills !== 1 ? 's' : ''}</span>` : ''}
  </div>`;

  // ---- Time-of-day sparkline (24 hourly bars, peak labelled)
  const hours   = timeOfDayPattern(name);
  const hourMax = Math.max(1, ...hours);
  const hourTotal = hours.reduce((a, b) => a + b, 0);
  const peakHour = hours.indexOf(hourMax);
  const sparkHtml = hourTotal === 0
    ? `<p class="dim" style="font-size:.8rem">No timed history yet.</p>`
    : hours.map((c, h) => {
        const hPx  = Math.round(c / hourMax * 32);
        const mark = h === peakHour && c > 0 ? ' <span style="font-weight:600;color:var(--edge)">*</span>' : '';
        return `<span title="${h}:00 → ${c}" style="display:inline-block;width:14px;margin-right:1px;vertical-align:bottom;text-align:center;font-size:.6rem;color:var(--dim)">`
             + `<span style="display:block;height:${hPx}px;background:var(--accent);margin-bottom:1px;border-radius:1px"></span>`
             + `${h % 6 === 0 ? h : ''}${mark}`
             + `</span>`;
      }).join('');

  // ---- Zone breakdown (top zones, sorted)
  const zones = zonePattern(name);
  const zoneTotal = Object.values(zones).reduce((a, b) => a + b, 0);
  const zonesHtml = Object.keys(zones).length === 0
    ? `<p class="dim" style="font-size:.8rem">No zone data.</p>`
    : Object.entries(zones).map(([zone, count]) => {
        const pct = zoneTotal > 0 ? Math.round(count / zoneTotal * 100) : 0;
        return `<div class="trail-entry">
          <span style="display:inline-block;width:120px;font-size:.8rem">${esc(zone)}</span>
          <span style="display:inline-block;width:60px;font-size:.75rem;color:var(--dim);text-align:right">${count}</span>
          <span class="heatmap-bar" style="width:${pct * 1.6}px"></span>
          <span class="dim" style="font-size:.75rem;margin-left:.3rem">${pct}%</span>
        </div>`;
      }).join('');

  // ---- Following detection (compare against fleet members in seen index / state)
  // We try every known fleet name whose history exists. Show the strongest match.
  let fleetCandidates = [];
  try {
    const statePath = join(SUBSTRATE, 'fleet-state.json');
    const fleetState = existsSync(statePath) ? readJSON(statePath) : {};
    const seenIndex  = readJSON(SEEN_PATH);
    // Prefer fleet-state roster; fall back to any player name whose history file exists.
    const fromState = Object.values(fleetState)
      .map(e => e?.credentials?.character ?? e?.name ?? null)
      .filter(Boolean);
    const fromHistory = existsSync(HISTORY_DIR)
      ? readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6).replace(/_/g, ' '))
      : [];
    const all = [...new Set([...fromState, ...fromHistory])].filter(n => n !== name && seenIndex[n] === undefined);
    fleetCandidates = all;
  } catch { /* leave empty */ }

  const followChecks = fleetCandidates
    .map(fc => ({ name: fc, ...followingDetection(name, fc) }))
    .sort((a, b) => b.matches - a.matches);
  const follower = followChecks.find(r => r.following);

  const followHtml = follower
    ? `<div style="color:var(--bad);font-weight:600;padding:.4rem .6rem;background:rgba(255,80,80,.08);border-left:3px solid var(--bad);border-radius:2px;font-size:.85rem">
        ⚠ Possible follower of <strong>${esc(follower.name)}</strong>
        &mdash; ${follower.matches} matches / ${follower.fleet_moves} moves (${Math.round(follower.confidence * 100)}% correlation)
      </div>`
    : (followChecks.length === 0
        ? `<p class="dim" style="font-size:.8rem">No fleet history available to compare against.</p>`
        : `<p class="dim" style="font-size:.8rem">No following detected against ${followChecks.length} fleet member${followChecks.length !== 1 ? 's' : ''}.
            Best match: ${followChecks[0]?.name ?? '--'} ${followChecks[0]?.matches ?? 0}/${followChecks[0]?.fleet_moves ?? 0}.
          </p>`);

  return `${meta}<div class="detail-grid">
    <div>
      <h3>Movement trail (last 25 rooms)</h3>
      ${trailHtml}
    </div>
    <div>
      <h3>Top rooms (${total} recorded moves)</h3>
      ${heatHtml}
    </div>
  </div>
  <div class="detail-grid">
    <div>
      <h3>Activity by hour (UTC) -- peak: ${peakHour}:00 (${hours[peakHour]} sig)</h3>
      <div style="margin:.4rem 0;font-family:monospace">${sparkHtml}</div>
    </div>
    <div>
      <h3>Zone breakdown (${zoneTotal} moves)</h3>
      ${zonesHtml}
    </div>
  </div>
  <div>
    <h3>Following analysis</h3>
    ${followHtml}
  </div>`;
}

function fmtAgoShort(t) {
  if (!t) return '--';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s/60)}m ago`;
  if (s < 86400) return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
}
