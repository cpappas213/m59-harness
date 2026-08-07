// TWO PAGES ABOUT THE SAME LEDGER, READ FROM OPPOSITE ENDS.
//
//   /deaths    what killed them, where — and a loud refusal to say where, for most of them
//   /tougher   what it took to earn a point of maximum health, which is the only thing
//              any of this is for
//
// The fleet page answers "how is it going". These answer "why" — and the deaths half has
// to do something the fleet page never has to: DECLINE TO ANSWER. 253 of 637 deaths have
// no trustworthy location, and the honest rendering of that is a hole in the treemap and
// a number beside it, not a plausible-looking room. See m59-postmortems.mjs for the
// measurement that set the threshold.
//
// WHY THE TREEMAP IS INLINED RATHER THAN LOADED.
//
// This is d3's squarified treemap — the algorithm from d3-hierarchy
// (https://d3js.org/d3-hierarchy/treemap, Bruce/Shneiderman squarify, MIT) — written out
// here instead of pulled from a CDN. Not a preference: this page is served by the same
// server as the fleet board, which binds to every interface SO IT CAN BE READ FROM A
// PHONE ON THE LAN, and a phone on the LAN of a machine running a game server is exactly
// the situation where an unrelated CDN is not reachable. Every page in this repository is
// self-contained for that reason, and a treemap that renders as a blank rectangle when
// the internet is down is worse than no treemap.
//
// It is about eighty lines. The layout is the part that matters and it is faithful: sort
// descending, lay rows along the shorter side, accept a row while its worst aspect ratio
// improves, recurse into children.
import { loadPostmortems, facets, digest, TRUST_MS } from './m59-postmortems.mjs';
import { allGains, toughSummary, allFeeds, FEED_SIZE } from './m59-tougher.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { lore, roomLink } from './m59-dashboard.mjs';

const { label: FLEET_LABEL } = resolveFleet();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// ------------------------------------------------------------------ shared chrome
//
// Both pages and the fleet board carry the same nav, so the three read as one thing.
const NAV = (here) => `
  <nav class="tabs">
    <a href="/" class="${here === 'fleet' ? 'on' : ''}">Fleet</a>
    <a href="/deaths" class="${here === 'deaths' ? 'on' : ''}">Post mortems</a>
    <a href="/tougher" class="${here === 'tougher' ? 'on' : ''}">Tougher</a>
  </nav>`;

const STYLE = `
  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa;
          --panel:#fff; --line:#e6e4e0; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1;
          --edge:#c2700a; --mana:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24;
            --line:#2e2e36; --good:#4ade80; --bad:#f87171; --accent:#8b9bff;
            --edge:#fbaa3e; --mana:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  h2 { font-size:1rem; margin:2rem 0 .5rem; letter-spacing:.01em; }
  .sub { color:var(--dim); font-size:.85rem; margin-bottom:1rem; }
  .tabs { display:flex; gap:.25rem; margin:0 0 1.5rem; border-bottom:1px solid var(--line); }
  .tabs a { padding:.5rem .9rem; text-decoration:none; color:var(--dim); font-size:.9rem;
            border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tabs a.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .tabs a:hover { color:var(--fg); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
           gap:.75rem; margin-bottom:1.5rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.85rem 1rem; }
  .card .k { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:1.5rem; font-weight:600; line-height:1.2; }
  .card .n { color:var(--dim); font-size:.75rem; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:1rem; margin-bottom:1.25rem; }
  .facets { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:.75rem; }
  .facets button { font:inherit; font-size:.82rem; padding:.35rem .8rem; cursor:pointer;
                   border:1px solid var(--line); background:transparent; color:var(--dim);
                   border-radius:999px; }
  .facets button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  /* THE HOLE IN THE DATA, RENDERED AS A HOLE. An excluded death is not a smaller
     rectangle, it is an absent one, and the banner is the only thing that says so. */
  .caveat { border-left:3px solid var(--edge); padding:.5rem .8rem; margin:.75rem 0 0;
            background:color-mix(in srgb, var(--edge) 8%, transparent);
            font-size:.82rem; color:var(--fg); border-radius:0 6px 6px 0; }
  #tm { width:100%; height:460px; display:block; }
  #tm rect { stroke:var(--panel); stroke-width:1.5px; cursor:pointer; }
  #tm rect:hover { stroke:var(--fg); stroke-width:2px; }
  #tm text { pointer-events:none; font:12px ui-sans-serif,system-ui,sans-serif; fill:#fff; }
  /* WHITE-ON-WHITE. Labels are white because they sit on coloured rectangles, and that
     rule also caught the "nothing to show" message, which sits on the page background —
     so an empty treemap rendered as a blank panel with the explanation invisible inside
     it. Found by looking at the Tougher page on its first day, when there was genuinely
     nothing to show and the page said so in white text on white. */
  #tm text.empty-label { fill:var(--dim); font-size:13px; }
  #tm text.sm { font-size:10px; opacity:.75; }
  #tm .leafname { font-size:10px; opacity:.85; }
  .tip { position:fixed; pointer-events:none; background:var(--panel); color:var(--fg);
         border:1px solid var(--line); border-radius:8px; padding:.45rem .65rem;
         font-size:.8rem; box-shadow:0 4px 14px rgba(0,0,0,.18); opacity:0;
         transition:opacity .1s; max-width:260px; z-index:10; }
  /* A SIX-COLUMN TABLE OF ROOM NAMES IS WIDER THAN A PHONE, AND WIDER THAN THIS PAGE.
     Without this the table pushes the whole document past the viewport and everything
     scrolls sideways — including the header, the cards and the treemap, none of which
     are too wide. Caught by looking at it: the treemap's right-hand rectangles and the
     last column of the death report were both off-screen. The table scrolls inside its
     own panel instead, and keeps a min-width so it degrades to a scroll rather than to
     a column of single words. */
  .scroller { overflow-x:auto; }
  table { width:100%; min-width:640px; border-collapse:collapse; font-size:.85rem; }
  th { text-align:left; font-weight:600; color:var(--dim); font-size:.72rem;
       text-transform:uppercase; letter-spacing:.05em; padding:.4rem .5rem;
       border-bottom:1px solid var(--line); }
  td { padding:.4rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  tr.death { cursor:pointer; }
  tr.death:hover td { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .dim { color:var(--dim); }
  .bad { color:var(--bad); }
  .good { color:var(--good); }
  .guess { color:var(--edge); font-size:.75rem; }
  .pill { font-size:.68rem; padding:.05rem .4rem; border-radius:999px; border:1px solid var(--line);
          color:var(--dim); white-space:nowrap; }
  .pill.obs { border-color:var(--good); color:var(--good); }
  .pill.inf { border-color:var(--edge); color:var(--edge); }
  .detail td { background:color-mix(in srgb, var(--accent) 4%, transparent); }
  .detail .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
           gap:.6rem 1.2rem; }
  .detail td { max-width:0; }   /* let the grid track the table, not the other way round */
  .detail .kv .k { color:var(--dim); font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
  .log { font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; margin:.6rem 0 0;
         max-height:230px; overflow:auto; background:var(--bg); border:1px solid var(--line);
         border-radius:6px; padding:.5rem .6rem; }
  .log div { white-space:pre-wrap; }
  .log .t { color:var(--dim); }
  .trail { font:12px ui-monospace,monospace; letter-spacing:-.5px; }
  a { color:var(--accent); }
  .empty { color:var(--dim); padding:2rem 0; text-align:center; }
`;

// THE TREEMAP, and the tooltip, and the drill-down. One script for both pages — they
// differ only in the data handed to it.
// The layout on its own, with no DOM in it, so that m59-deaths-test.mjs can evaluate
// this exact string and check the rectangles it produces. A treemap that is subtly wrong
// still looks like a treemap, which is the whole reason to test it rather than squint.
export const SQUARIFY_JS = `
// ---- d3-hierarchy's squarified treemap, inlined. https://d3js.org/d3-hierarchy/treemap
// Squarify lays each row along the SHORTER side of the remaining rectangle and keeps
// adding to that row while doing so IMPROVES the worst aspect ratio in it. That is the
// whole trick: it is what stops a treemap becoming a row of slivers, and it is why the
// rectangles stay readable when one category dwarfs the rest — which is exactly this
// data, where one room holds a quarter of the deaths.
function worst(row, w, s) {
  if (!row.length) return Infinity;
  var rmax = -Infinity, rmin = Infinity, sum = 0, i;
  for (i = 0; i < row.length; i++) {
    var v = row[i].value * s;
    if (v > rmax) rmax = v;
    if (v < rmin) rmin = v;
    sum += v;
  }
  if (!(rmin > 0) || !(sum > 0)) return Infinity;   // a zero-value node has no aspect ratio
  return Math.max(w * w * rmax / (sum * sum), sum * sum / (w * w * rmin));
}
function squarify(nodes, x0, y0, x1, y1) {
  var out = [], items = nodes.slice().filter(function (n) { return n.value > 0; })
                              .sort(function (a, b) { return b.value - a.value; });
  var i = 0;
  while (i < items.length) {
    // The shorter side. Rows are laid along it, which is what keeps them square-ish.
    var w = Math.min(x1 - x0, y1 - y0);
    if (!(w > 0)) break;
    var remaining = 0;
    for (var q = i; q < items.length; q++) remaining += items[q].value;
    var s = (x1 - x0) * (y1 - y0) / remaining;      // value -> area, for what is LEFT
    var row = [], best = Infinity, j = i;
    while (j < items.length) {
      var r = worst(row.concat([items[j]]), w, s);
      if (r > best) break;                          // adding it makes the row worse: stop
      row.push(items[j]); best = r; j++;
    }
    if (!row.length) { row = [items[i]]; j = i + 1; }
    var rowArea = 0;
    for (var m = 0; m < row.length; m++) rowArea += row[m].value * s;
    // \`wide\` means the remaining rectangle is wider than tall, so this row becomes a
    // COLUMN down its left edge — laid along the short side, which is the height.
    var wide = (x1 - x0) >= (y1 - y0);
    var thick = rowArea / w;                        // how deep the row/column is
    var off = wide ? y0 : x0;
    for (var k = 0; k < row.length; k++) {
      var len = (row[k].value * s) / thick;
      out.push(wide
        ? { node: row[k], x0: x0, y0: off, x1: x0 + thick, y1: Math.min(off + len, y1) }
        : { node: row[k], x0: off, y0: y0, x1: Math.min(off + len, x1), y1: y0 + thick });
      off += len;
    }
    if (wide) x0 += thick; else y0 += thick;
    i = j;
  }
  return out;
}
`;

const TREEMAP_JS = SQUARIFY_JS + `
var SVGNS = 'http://www.w3.org/2000/svg';
var el = function (n, a) { var e = document.createElementNS(SVGNS, n);
  for (var k in a) e.setAttribute(k, a[k]); return e; };

// Colour by rank rather than by value: with one category at 25% and a tail at 1%, a
// value ramp is one bright block and a wall of identical dark ones. Rank keeps the tail
// distinguishable, which is where the surprises are.
// "1 points" is the reading you get on day one of a record that counts rare events, and
// it is the reading a person sees first. Singular by stripping the s, which is enough for
// "deaths" and "points" and is all this needs to cover.
function unitOf(n, unit) { return n === 1 ? unit.replace(/s$/, '') : unit; }
function hue(i, n) { return 'hsl(' + Math.round(210 + (i / Math.max(1, n)) * 130) % 360 +
  ' 55% ' + (34 + 26 * (1 - i / Math.max(1, n))).toFixed(0) + '%)'; }

var TIP = document.createElement('div');
TIP.className = 'tip'; document.body.appendChild(TIP);
function showTip(e, html) {
  TIP.innerHTML = html; TIP.style.opacity = 1;
  var x = Math.min(e.clientX + 14, window.innerWidth - 280);
  TIP.style.left = x + 'px'; TIP.style.top = (e.clientY + 16) + 'px';
}
function hideTip() { TIP.style.opacity = 0; }

var DRILL = null;                                   // which top-level box is opened
function drawTreemap(data, opts) {
  var svg = document.getElementById('tm');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var W = svg.clientWidth || 900, H = svg.clientHeight || 460;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var rows = data.children || [];
  if (!rows.length) {
    var t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-label' });
    t.textContent = opts.empty || 'nothing to show';
    svg.appendChild(t); return;
  }
  // DRILLED IN: one category, split by character. Same layout, different question —
  // "the border of the Badlands killed 36" versus "it killed Zoot 9 times".
  var top = DRILL ? rows.filter(function (r) { return r.name === DRILL; }) : rows;
  var laid = DRILL
    ? squarify((top[0] && top[0].children) || [], 0, 0, W, H)
    : squarify(rows, 0, 0, W, H);
  var n = laid.length;
  laid.forEach(function (b, i) {
    var g = el('g', {});
    var r = el('rect', { x: b.x0, y: b.y0, width: Math.max(0, b.x1 - b.x0),
                         height: Math.max(0, b.y1 - b.y0), fill: hue(i, n), rx: 2 });
    var name = b.node.name, val = b.node.value;
    var pct = data.total ? Math.round(1000 * val / data.total) / 10 : null;
    r.addEventListener('mousemove', function (e) {
      showTip(e, '<b>' + name + '</b><br>' + val + ' ' + unitOf(val, opts.unit) +
        (pct != null ? ' · ' + pct + '% of ' + data.total : '') +
        (DRILL ? '' : '<br><span style="opacity:.7">click to split by character</span>'));
    });
    r.addEventListener('mouseleave', hideTip);
    r.addEventListener('click', function () {
      DRILL = DRILL ? null : name; hideTip(); drawTreemap(data, opts);
    });
    g.appendChild(r);
    var w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (w > 46 && h > 22) {
      var label = el('text', { x: b.x0 + 6, y: b.y0 + 16 });
      label.textContent = name.length > Math.floor(w / 7) ? name.slice(0, Math.floor(w / 7) - 1) + '…' : name;
      g.appendChild(label);
      if (h > 36) {
        var v = el('text', { x: b.x0 + 6, y: b.y0 + 31, class: 'sm' });
        v.textContent = val + ' ' + unitOf(val, opts.unit);
        g.appendChild(v);
      }
    }
    svg.appendChild(g);
  });
  var back = document.getElementById('tm-back');
  if (back) { back.style.display = DRILL ? '' : 'none';
              back.textContent = '← all (' + DRILL + ')'; }
}

function pickFacet(key) {
  DRILL = null;
  var f = FACETS[key];
  document.querySelectorAll('.facets button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.facet === key);
  });
  document.getElementById('facet-note').textContent = f.note || '';
  drawTreemap(f, { unit: f.unit || 'deaths', empty: f.empty });
}
window.addEventListener('resize', function () {
  var on = document.querySelector('.facets button.on');
  if (on) { var f = FACETS[on.dataset.facet]; drawTreemap(f, { unit: f.unit || 'deaths', empty: f.empty }); }
});
`;

const DEATH_LOG_JS = `
// CLICK A DEATH, GET THE REPORT. Fetched rather than inlined: 600 digests with their
// text logs is megabytes, and the page has to open on a phone.
document.addEventListener('click', function (e) {
  var tr = e.target.closest && e.target.closest('tr.death');
  if (!tr) return;
  var next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  document.querySelectorAll('tr.detail').forEach(function (d) { d.remove(); });
  var row = document.createElement('tr');
  row.className = 'detail';
  row.innerHTML = '<td colspan="7" class="dim">reading the post mortem…</td>';
  tr.parentNode.insertBefore(row, tr.nextSibling);
  fetch('/deaths/report?file=' + encodeURIComponent(tr.dataset.file))
    .then(function (r) { return r.json(); })
    .then(function (d) { row.innerHTML = '<td colspan="7">' + renderDigest(d) + '</td>'; })
    .catch(function (err) { row.innerHTML = '<td colspan="7" class="bad">could not read it: ' + err + '</td>'; });
});
function kv(k, v) { return '<div class="kv"><div class="k">' + k + '</div><div>' + v + '</div></div>'; }
function renderDigest(d) {
  if (!d || d.error) return '<span class="bad">' + ((d && d.error) || 'not found') + '</span>';
  var w = d.where, c = d.cause;
  var place = w.trusted
    ? w.room + ' <span class="dim">(' + w.col + ',' + w.row + ')</span>'
    : '<span class="guess">not known — ' + w.why + '</span>';
  var killer = c.killer
    ? c.killer + (c.observed ? ' <span class="pill obs">announced</span>'
                             : ' <span class="pill inf">a guess</span>')
    : '<span class="dim">nothing named it</span>';
  var text = (d.text || []).map(function (t) {
    return '<div><span class="t">-' + (t.dt / 1000).toFixed(1) + 's</span> ' + t.text + '</div>';
  }).join('');
  // THE CELL THAT EXPLAINS MOST OF THIS PAGE. A keeper that was up and not looking is
  // the ordinary case, not the exception, and the report should say it in words.
  var k = d.keeper || {};
  var keeper = k.up === false ? '<span class="bad">N — nothing was driving</span>'
             : k.up === null ? '<span class="dim">? — no record either way</span>'
             : k.watching ? '<span class="good">Y</span> <span class="dim">last looked ' +
                 ((k.blind_ms || 0) / 1000).toFixed(1) + 's before the end</span>'
             : '<span class="guess">Y, but BLIND for ' + Math.round((k.blind_ms || 0) / 1000) +
               's</span> <span class="dim">— running, and not looking</span>';
  return '<div class="grid">' +
    kv('killed by', killer) +
    kv('keeper', keeper) +
    kv('where', place) +
    kv('was', (d.was.doing || '?') + (d.was.hunting ? ' · hunting ' + d.was.hunting : '')) +
    kv('level', d.level + (d.was.in_safe_spot ? ' · <span class="bad">in a safe spot</span>' : '')) +
    kv('shape', d.shape + ' <span class="dim">(biggest drop ' + d.biggest_drop + ')</span>') +
    kv('health', '<span class="trail">' + (d.health_trail || []).join(' ') + '</span>') +
    kv('crowd', (d.threats || []).join(', ') || '<span class="dim">nothing in view</span>') +
    kv('vigor', d.was.vigor == null ? '—' : d.was.vigor) +
    (d.during_keeper_outage ? kv('caveat', '<span class="guess">nothing was driving this character' +
      ' — do not read it as evidence about the strategy</span>') : '') +
  '</div>' +
  (text ? '<div class="log">' + text + '</div>' : '');
}
`;

// WAS ANYTHING DRIVING? Y/N — with the part that a bare Y hides.
//
// N is an outage: nothing was at the controls, and the death says nothing about how the
// fleet fights. Y is the uptime ledger saying the keeper was running.
//
// But 81% of the deaths where the keeper WAS up have it blind at the moment of death —
// median gap 18 seconds — and a plain Y over that is the most misleading cell on the page.
// A keeper blind for 18s has taken roughly eighteen decisions against a view of the world
// that stopped changing, including every decision about whether to flee. So Y carries the
// gap, and only a keeper inside its own 8s resync envelope gets the green one.
function keeperCell(k) {
  if (!k || k.up === null)
    return `<span class="dim" title="${esc(k?.why ?? 'no record')}">?</span>`;
  if (k.up === false)
    return `<span class="bad" title="${esc(k.why)}">N</span>`;
  const gap = k.blind_ms == null ? null
    : k.blind_ms < 1000 ? `${k.blind_ms}ms` : `${Math.round(k.blind_ms / 1000)}s`;
  if (k.watching)
    return `<span class="good" title="${esc(k.why)}">Y</span>` +
           (gap ? ` <span class="dim gapnum">${gap}</span>` : '');
  return `<span class="guess" title="${esc(k.why)}">Y</span>` +
         `<span class="pill inf" title="${esc(k.why)}">blind ${gap}</span>`;
}

// ------------------------------------------------------------------ /deaths

export function renderDeaths({ hours = 168 } = {}) {
  const rows = loadPostmortems({ sinceMs: hours * 3600 * 1000 });
  const f = facets(rows);
  const placed = rows.filter(r => r.where.trusted).length;
  const observed = rows.filter(r => r.cause.observed).length;
  const inSpot = rows.filter(r => r.in_safe_spot).length;
  const unattended = rows.filter(r => r.during_keeper_outage).length;
  const blind = rows.filter(r => r.keeper.up === true && !r.keeper.watching).length;
  const watching = rows.filter(r => r.keeper.watching).length;

  const logRows = rows.slice(0, 80).map(r => `
    <tr class="death" data-file="${esc(r.file)}">
      <td class="dim">${esc(ago(r.at))}</td>
      <td>${esc(r.character ?? '?')}</td>
      <td class="dim">${r.level ?? '—'}</td>
      <td class="keeper">${keeperCell(r.keeper)}</td>
      <td>${r.cause.killer
            ? `${lore(r.cause.killer)} ${r.cause.observed
                 ? '<span class="pill obs">announced</span>'
                 : '<span class="pill inf">a guess</span>'}`
            : '<span class="dim">unattributed</span>'}</td>
      <td>${r.where.trusted
            ? roomLink(r.where.room, r.where.num)
            : `<span class="guess" title="${esc(r.where.why)}">not known</span>`}</td>
      <td class="dim">${r.in_safe_spot ? '<span class="bad">in a safe spot</span>'
                     : esc(r.hunting ? 'hunting ' + r.hunting : (r.doing ?? '—'))}</td>
    </tr>`).join('');

  const FACETS = {
    cause: { ...f.cause, unit: 'deaths', empty: 'no death was announced by the server in this window' },
    place: { ...f.place, unit: 'deaths', empty: 'nothing in this window has a location we can stand behind' },
    inferred: { children: f.cause.inferred, total: f.cause.inferred_total, unit: 'deaths',
                note: 'THESE ARE GUESSES. No broadcast arrived, so this is the commonest thing that ' +
                      'was standing nearby — which matched the real killer 51% of the time when both ' +
                      'were available. Shown because a guess you can see is better than one folded ' +
                      'into the totals.',
                empty: 'nothing here — every death in this window was announced' },
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post mortems — ${esc(FLEET_LABEL)} fleet</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
  <h1>Post mortems</h1>
  <div class="sub">${rows.length} deaths in the last ${hours}h · ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('deaths')}

  <div class="cards">
    <div class="card"><div class="k">deaths</div><div class="v">${rows.length}</div>
      <div class="n">each costs a point of max health, for ever</div></div>
    <div class="card"><div class="k">killer announced</div><div class="v good">${observed}</div>
      <div class="n">${rows.length ? Math.round(100 * observed / rows.length) : 0}% — the rest is inference</div></div>
    <div class="card"><div class="k">location trusted</div><div class="v">${placed}</div>
      <div class="n">${rows.length - placed} we cannot place at all</div></div>
    <div class="card"><div class="k">died in a safe spot</div><div class="v ${inSpot ? 'bad' : 'good'}">${inSpot}</div>
      <div class="n">the number that falsifies the thesis</div></div>
    <div class="card"><div class="k">keeper was down</div><div class="v ${unattended ? 'bad' : 'dim'}">${unattended}</div>
      <div class="n">not evidence about the strategy</div></div>
    <div class="card"><div class="k">up but blind</div><div class="v ${blind ? 'bad' : 'good'}">${blind}</div>
      <div class="n">${watching} were actually watching — a keeper past its own 8s resync is
        deciding against a world that stopped changing</div></div>
  </div>

  <div class="panel">
    <div class="facets">
      <button data-facet="cause" class="on">What killed them</button>
      <button data-facet="place">Where they died</button>
      <button data-facet="inferred">Guessed killers</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <h2>The last ${Math.min(80, rows.length)} deaths</h2>
  <div class="sub">Click one to open its report.</div>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>when</th><th>who</th><th>lvl</th>
      <th title="was a keeper driving — and had it looked recently">keeper?</th>
      <th>killed by</th><th>where</th><th>doing</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="7" class="empty">no deaths in this window</td></tr>'}</tbody>
  </table>
  </div>
</div>
<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
${DEATH_LOG_JS}
document.querySelectorAll('.facets button[data-facet]').forEach(function (b) {
  b.addEventListener('click', function () { pickFacet(b.dataset.facet); });
});
document.getElementById('tm-back').addEventListener('click', function () {
  DRILL = null;
  var on = document.querySelector('.facets button.on');
  var f = FACETS[on.dataset.facet];
  drawTreemap(f, { unit: f.unit, empty: f.empty });
});
pickFacet('cause');
</script>
</body></html>`;
}

// ------------------------------------------------------------------ /tougher

export function renderTougher({ hours = 168 } = {}) {
  const gains = allGains({ sinceMs: hours * 3600 * 1000 });
  const s = toughSummary(gains);
  const feeds = allFeeds();

  const FACETS = {
    creature: { children: s.by_creature, total: s.total, unit: 'points',
                note: 'What actually paid. A kill only rolls for a point when the creature is at ' +
                      'or above your own level, so a creature that appears here is one worth ' +
                      'hunting and one that never does is a creature the fleet is killing for free.',
                empty: 'nothing yet' },
    room: { children: s.by_room, total: s.total, unit: 'points',
            note: 'Where the points were earned. The positive image of the deaths map — and unlike ' +
                  'that one, every row here is exact: a gain is announced the instant it happens, ' +
                  'so the room is where the character was standing, not where it was last seen.',
            empty: 'nothing yet' },
    character: { children: s.by_character, total: s.total, unit: 'points',
                 note: 'Who earned them.', empty: 'nothing yet' },
  };

  const gainRows = gains.slice(0, 60).map(g => `
    <tr>
      <td class="dim">${esc(ago(g.at))}</td>
      <td>${esc(g.character)}</td>
      <td class="good">${g.from != null && g.to != null ? `${g.from} → <b>${g.to}</b>` : (g.to ?? '—')}</td>
      <td>${g.creature ? lore(g.creature) : '<span class="guess">cause not recorded</span>'}</td>
      <td>${g.room ? roomLink(g.room, g.room_num) : '<span class="dim">—</span>'}</td>
    </tr>`).join('');

  // THE KILL FEED. In memory, ten per character, gone when the broker stops — which is
  // the right lifetime for "what is this character doing right now".
  const feedBlocks = feeds.map(f => `
    <div class="card">
      <div class="k">${esc(f.character)}</div>
      ${f.feed.map(e => {
        if (e.kind === 'gain')
          return `<div class="good"><b>TOUGHER</b> → ${e.to ?? '?'}${
            e.creature ? ' · ' + esc(e.creature) : ''} <span class="dim">${esc(ago(e.at))}</span></div>`;
        if (e.kind === 'death')
          return `<div class="bad">died${e.killer ? ' · ' + esc(e.killer) : ''}${
            e.observed ? '' : ' <span class="guess">(guess)</span>'} <span class="dim">${esc(ago(e.at))}</span></div>`;
        return `<div class="dim">killed ${esc(e.creature ?? '?')}${
          e.from_safe_spot ? ' <span class="pill">wall</span>' : ''} <span class="dim">${esc(ago(e.at))}</span></div>`;
      }).join('')}
    </div>`).join('');

  const nothingYet = !gains.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tougher — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>${STYLE}</style>
</head><body><div class="wrap">
  <h1>Tougher</h1>
  <div class="sub">Every point of maximum health the fleet has earned, and what died for it ·
    ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('tougher')}

  <div class="cards">
    <div class="card"><div class="k">points earned</div><div class="v good">${s.total}</div>
      <div class="n">last ${hours}h</div></div>
    <div class="card"><div class="k">creatures that paid</div><div class="v">${s.by_creature.length}</div>
      <div class="n">of everything the fleet kills</div></div>
    <div class="card"><div class="k">rooms that paid</div><div class="v">${s.by_room.length}</div>
      <div class="n">where the work actually is</div></div>
    <div class="card"><div class="k">cause not recorded</div><div class="v ${s.unattributed ? 'bad' : 'dim'}">${s.unattributed}</div>
      <div class="n">announced, but no kill near it</div></div>
  </div>

  ${nothingYet ? `
  <div class="panel">
    <div class="caveat">
      <b>Nothing on record yet, and that is expected.</b> A gain is caught from the server's own
      announcement — "You suddenly feel a little tougher." (<code>player.kod:144</code>) — which
      arrived on the wire for months with nothing listening. This record starts the first time a
      broker running this code sees one, and <b>it cannot be backfilled</b>: the ledger's
      <code>level_up</code> events were derived by diffing five-minute samples, so they know the
      net change and not the kill that caused it. Expect the first rows within a few hours of play.
    </div>
  </div>` : `
  <div class="panel">
    <div class="facets">
      <button data-facet="creature" class="on">What paid for them</button>
      <button data-facet="room">Where they were earned</button>
      <button data-facet="character">Who earned them</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <h2>Every point, newest first</h2>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>when</th><th>who</th><th>max health</th><th>what paid</th><th>where</th></tr></thead>
    <tbody>${gainRows}</tbody>
  </table>
  </div>`}

  <h2>Kill feed</h2>
  <div class="sub">The last ${FEED_SIZE} kills and deaths per character, held in memory —
    this empties when the broker restarts, on purpose.</div>
  ${feeds.length
    ? `<div class="cards">${feedBlocks}</div>`
    : '<div class="panel"><div class="empty">no keeper has killed anything since the broker started</div></div>'}
</div>
${nothingYet ? '' : `<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
document.querySelectorAll('.facets button[data-facet]').forEach(function (b) {
  b.addEventListener('click', function () { pickFacet(b.dataset.facet); });
});
document.getElementById('tm-back').addEventListener('click', function () {
  DRILL = null;
  var on = document.querySelector('.facets button.on');
  var f = FACETS[on.dataset.facet];
  drawTreemap(f, { unit: f.unit, empty: f.empty });
});
pickFacet('creature');
</script>`}
</body></html>`;
}

export function deathReportJSON(file) {
  // Path traversal is the only real hazard on a read-only server that binds to every
  // interface: the file name comes off a query string and is used to open a file. A
  // postmortem name has no directory in it, so anything that does is refused outright
  // rather than sanitised — sanitising invites a bypass, refusing does not.
  if (!file || /[\\/]/.test(file) || !file.endsWith('.json')) return { error: 'bad file name' };
  const d = digest(file);
  return d ?? { error: 'no such post mortem' };
}

export { TRUST_MS };
