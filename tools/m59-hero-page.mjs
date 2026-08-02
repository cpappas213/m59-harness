#!/usr/bin/env node
// EVERYTHING ABOUT ONE CHARACTER THAT THE AGENT DELIBERATELY DOES NOT SEE.
//
// The tools an agent uses are narrow on purpose. A keeper deciding whether to swing
// does not need a skill list, and paying to carry one into every decision would tax
// every decision it makes. But a person asking "why is this one doing badly?" wants
// exactly that: the whole sheet, the pack, what it can still carry, and the last few
// things it did in order.
//
// So this is the other end of the same data — read-only, assembled from state the
// broker already holds, and cross-linked into the compendium so that "wheel of cheese"
// and "blink" are things you click rather than strings you go and look up.
//
// It renders whatever it is handed and reaches for nothing itself. That matters: the
// dashboard server it is served from has no code path to a session, which is the
// property that makes it safe to point at a home network.
import { esc, lore, roomLink } from './m59-dashboard.mjs';

const clock = t => (t ? new Date(t).toTimeString().slice(0, 8) : '');

const STYLE = `
  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa;
          --panel:#fff; --line:#e6e4e0; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1;
          --edge:#c2700a; --mana:#2563eb; --skip:#8b8b8b; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24;
            --line:#2e2e36; --good:#4ade80; --bad:#f87171; --accent:#8b9bff;
            --edge:#fbaa3e; --mana:#60a5fa; --skip:#6b6b6b; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .1rem; letter-spacing:-.01em; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
       margin:2rem 0 .6rem; font-weight:600; }
  .sub { color:var(--dim); font-size:.85rem; margin-bottom:1.2rem; }
  .back { color:var(--accent); text-decoration:none; font-size:.85rem; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.75rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.8rem 1rem; }
  .card .k { color:var(--dim); font-size:.68rem; text-transform:uppercase; letter-spacing:.07em; }
  .card .val { font-size:1.35rem; font-weight:600; margin-top:.1rem; }
  .card .sm { font-size:.75rem; color:var(--dim); }
  table { border-collapse:collapse; width:100%; font-size:.87rem; }
  th { text-align:left; color:var(--dim); font-weight:400; font-size:.68rem; text-transform:uppercase;
       letter-spacing:.07em; padding:.3rem .6rem .3rem 0; border-bottom:1px solid var(--line); }
  td { padding:.28rem .6rem .28rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .dim { color:var(--dim); } .good { color:var(--good); } .bad { color:var(--bad); } .skip { color:var(--skip); }
  .detail { max-width:430px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a.lore, a.room-link { color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--line); }
  a.lore:hover, a.room-link:hover { border-bottom-color:var(--accent); }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:2rem; }
  @media (max-width:760px){ .cols { grid-template-columns:1fr; } }
  .launch { display:inline-flex; align-items:center; gap:.8rem; background:var(--panel);
            border:1px solid var(--line); border-radius:10px; padding:.8rem 1.1rem; cursor:pointer;
            font:inherit; color:inherit; text-align:left; }
  .launch:hover { border-color:var(--accent); }
  .launch .ico { font-size:1.8rem; line-height:1; }
  .launch .t { font-weight:700; letter-spacing:.05em; }
  .launch .s { font-size:.73rem; color:var(--dim); }
  .warn { color:var(--edge); font-size:.82rem; max-width:62ch; }
  .free { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:.35rem; }
  .free span { display:block; height:100%; background:var(--accent); }
`;

export function renderHero(h, { localhost = false } = {}) {
  if (!h) {
    return '<!doctype html><meta charset=utf-8><title>unknown character</title>' +
      '<p style="font:15px system-ui;padding:2rem">No character by that name is in the fleet. ' +
      '<a href="/fleet">Back to the fleet</a>.</p>';
  }

  const v = h.vitals || {};
  const hp = v.health || {}, mp = v.mana || {}, vg = v.vigor || {};
  const carried = h.inventory?.length ?? 0;
  const cap = h.max_carry ?? null;
  const freePct = cap ? Math.max(0, Math.round(100 * (cap - carried) / cap)) : null;

  const items = (h.inventory || []).map(i => `
    <tr><td>${lore(i.name)}</td>
        <td class="num dim">${i.amount ?? ''}</td>
        <td class="dim">${esc((i.can || []).join(', '))}</td></tr>`).join('');

  const abilities = [
    ...(h.skills || []).map(s => ({ ...s, kind: 'skill' })),
    ...(h.spells || []).map(s => ({ ...s, kind: 'spell' })),
  ].map(a => `
    <tr><td>${lore(a.name)}</td>
        <td class="dim">${esc(a.kind)}${a.school ? ' · ' + esc(a.school) : ''}</td>
        <td class="num dim">${a.ability ?? ''}</td>
        <td class="num dim">${a.mana != null ? a.mana + ' mana' : ''}</td></tr>`).join('');

  const stats = Object.entries(h.stats || {}).map(([k, val]) => `
    <tr><td class="dim">${esc(k)}</td><td class="num">${esc(val)}</td></tr>`).join('');

  const effects = (h.effects || []).map(e => `<li>${esc(e)}</li>`).join('');

  const journal = (h.journal || []).slice(-30).reverse().map(e => `
    <tr><td class="dim">${esc(clock(e.at))}</td>
        <td>${esc(e.what)}</td>
        <td class="dim detail">${esc(Object.entries(e)
          .filter(([k]) => !['at', 'pass', 'what'].includes(k))
          .map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`)
          .join(' · '))}</td></tr>`).join('');

  const trials = (h.trials || []).slice(-14).reverse().map(t => `
    <tr><td class="dim">${esc(clock(t.at))}</td>
        <td class="${!t.counted ? 'skip' : /HIT/.test(t.verdict) ? 'bad' : 'good'}">${esc(t.verdict)}</td>
        <td class="dim">${t.window_s ?? '?'}s · hp ${t.health_before ?? '?'}→${t.health_after ?? '?'} · ${t.adjacent_at_start} adj</td></tr>`).join('');

  const name = h.name ?? '?';
  const href = encodeURIComponent(name);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Meridian 59</title>
<meta http-equiv="refresh" content="20">
<style>${STYLE}</style></head>
<body><div class="wrap">
  <a class="back" href="/fleet">&larr; fleet</a>
  <h1>${esc(name)}</h1>
  <div class="sub">${esc(h.agent ?? '')} · ${esc(h.strategy ?? 'no strategy')} ·
    ${h.in_game ? 'in game' : '<span class="bad">not in game</span>'} ·
    ${roomLink(h.room?.name, h.room?.num)}
    ${h.position ? `<span class="dim">(col ${h.position.col}, row ${h.position.row})</span>` : ''}</div>

  <div class="cards">
    <div class="card"><div class="k">doing</div>
      <div class="val" style="font-size:1rem">${esc(h.activity ?? '—')}</div></div>
    <div class="card"><div class="k">health</div>
      <div class="val">${hp.value ?? '—'}<span class="sm"> / ${hp.max ?? '—'}</span></div>
      <div class="sm">max health <em>is</em> the level</div></div>
    <div class="card"><div class="k">mana</div>
      <div class="val">${mp.value ?? '—'}<span class="sm"> / ${mp.max ?? '—'}</span></div></div>
    <div class="card"><div class="k">vigor</div>
      <div class="val">${vg.value ?? '—'}<span class="sm"> / ${vg.scale_max ?? 200}</span></div>
      <div class="sm">${vg.rested === true ? 'rested' : vg.rest_threshold != null
        ? `resting reaches ${vg.rest_threshold}` : ''}</div></div>
    <div class="card"><div class="k">carrying</div>
      <div class="val">${carried}<span class="sm"> / ${cap ?? '?'}</span></div>
      <div class="sm">${freePct != null ? freePct + '% free' : 'no keeper limit set'}</div>
      ${freePct != null ? `<div class="free"><span style="width:${100 - freePct}%"></span></div>` : ''}</div>
    <div class="card"><div class="k">stamina</div><div class="val">${h.stamina ?? '—'}</div>
      <div class="sm">${h.ceiling != null ? `lifetime cap ${h.ceiling} health` : ''}</div></div>
  </div>

  <h2>Safe spot</h2>
  ${h.safe_spot ? `<div class="cards">
    <div class="card"><div class="k">standing at</div>
      <div class="val" style="font-size:1.1rem">${h.safe_spot.at.col}, ${h.safe_spot.at.row}</div>
      <div class="sm">${h.safe_spot.works
        ? '<span class="good">holds under attack</span>' : 'untested'}</div></div>
    <div class="card" style="grid-column:span 2"><div class="k">evidence</div>
      <div class="sm" style="margin-top:.3rem">${esc(h.safe_spot.evidence)}</div></div>
    <div class="card"><div class="k">on us</div>
      <div class="val">${h.threat?.in_swing_range ?? 0}</div>
      <div class="sm">${h.threat?.camped_on_us ?? 0} camped${
        (h.threat?.what || []).length ? ' · ' + esc(h.threat.what.join(', ')) : ''}</div></div>
   </div>` : '<p class="dim">Not holding one.</p>'}
  ${trials ? `<table style="margin-top:.8rem">
    <thead><tr><th>time</th><th>reading</th><th>inputs</th></tr></thead>
    <tbody>${trials}</tbody></table>` : ''}

  <h2>Survival</h2>
  <div class="cards">
    <div class="card"><div class="k">deaths</div><div class="val ${h.deaths ? 'bad' : ''}">${h.deaths ?? 0}</div></div>
    <div class="card"><div class="k">deaths in a safe spot</div>
      <div class="val ${h.deaths_in_safe_spot ? 'bad' : 'good'}">${h.deaths_in_safe_spot ?? 0}</div>
      <div class="sm">${h.deaths_in_proven_safe_spot ?? 0} of them in a proven one</div></div>
    <div class="card"><div class="k">mulligans</div><div class="val">${h.mulligans ?? 0}</div>
      <div class="sm">fights re-taken from full instead of lost</div></div>
    <div class="card"><div class="k">logoffs</div><div class="val">${h.logoffs ?? 0}</div>
      <div class="sm">deaths avoided by disconnecting</div></div>
  </div>

  <div class="cols">
    <div>
      <h2>Carrying</h2>
      <table><thead><tr><th>item</th><th class="num">n</th><th>can</th></tr></thead>
        <tbody>${items || '<tr><td colspan="3" class="dim">nothing at all</td></tr>'}</tbody></table>
    </div>
    <div>
      <h2>Skills and spells</h2>
      <table><thead><tr><th>name</th><th>kind</th><th class="num">at</th><th class="num">cost</th></tr></thead>
        <tbody>${abilities || '<tr><td colspan="4" class="dim">none known</td></tr>'}</tbody></table>
    </div>
  </div>

  ${effects ? `<h2>Status effects</h2><ul class="dim">${effects}</ul>` : ''}

  <h2>Stats</h2>
  <table><tbody>${stats || '<tr><td class="dim">none reported</td></tr>'}</tbody></table>

  <h2>Recent log</h2>
  <table><thead><tr><th>time</th><th>what</th><th>detail</th></tr></thead>
    <tbody>${journal || '<tr><td colspan="3" class="dim">nothing yet</td></tr>'}</tbody></table>

  <h2>Play as this character</h2>
  ${localhost ? `
    <button class="launch" onclick="grab()">
      <span class="ico">&#128481;</span>
      <span><span class="t">START AS ${esc(String(name).toUpperCase())}</span><br>
      <span class="s">copies a PowerShell command that launches the client logged in as this
      character, then injects the agent DLL so the MCP can drive it too</span></span>
    </button>
    <p class="sub" style="margin-top:.6rem">
      or <a class="lore" href="/hero/${href}/start.ps1">download start.ps1</a></p>
    <script>
      async function grab() {
        const r = await fetch('/hero/${href}/start.ps1');
        const t = await r.text();
        const one = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\\\start-${href}.ps1';
        try {
          await navigator.clipboard.writeText(t);
          alert('The script is on your clipboard. Save it as start.ps1 and run it,\\nor use the download link.');
        } catch (e) { window.prompt('Copy this script:', t); }
      }
    </script>`
    : `<p class="warn">Withheld. This page is reachable from the network and the launcher carries
       the account password in plain text, so it is only offered to a browser running on the
       machine the broker is on. Open <code>http://127.0.0.1</code> rather than the LAN address
       to get it.</p>`}

  <footer class="sub" style="margin-top:2.5rem">live from the broker · refreshes every 20s</footer>
</div></body></html>`;
}

// The launcher itself. Two steps that are otherwise done by hand every time: start
// the client already logged in as this character, and inject the agent DLL so the
// same character can also be driven through the MCP.
//
// /U /W /H /P are the client's own switches, and /Q skips the splash.
export function startScript(h, { repo, host, port }) {
  const c = h.credentials || {};
  return `# Start Meridian 59 as ${h.name} and hand the client to the agent DLL.
#
# Generated by the fleet dashboard. It contains a password in plain text, which is
# why the page only offers it to a browser on this machine — treat the file the same
# way and delete it when you are done.

$client = "${(h.client_path || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Meridian 59\\Meridian.exe').replace(/"/g, '`"')}"
if (-not (Test-Path $client)) { Write-Error "client not found at $client"; exit 1 }

Start-Process -FilePath $client -ArgumentList @(
  '/H:${host}', '/P:${port}', '/U:${c.account ?? ''}', '/W:${c.password ?? ''}', '/Q'
)

# The client has to be up before anything can be injected into it, and it has to be
# the FOREGROUND window afterwards or it ignores movement entirely: HandleKeys returns
# early unless GetFocus() is the client, so a minimised client accepts turns and drops
# every step.
Start-Sleep -Seconds 6
& powershell -NoProfile -ExecutionPolicy Bypass -File "${repo}\\tools\\m59-inject.ps1"

Write-Host ""
Write-Host "Launched as ${h.name}. Keep the client window focused for movement to work."
`;
}
