// /stats — WHAT BUILDS THIS FLEET IS MADE OF, WHICH IS FOUR ANSWERS AND NOT TWENTY-ONE.
//
// Attributes are fixed at creation and never move, so a character's six numbers are the one
// thing about it that is decided before it ever swings at anything and can never be
// repaired afterwards — `create automated` rolls zeroes and the character is capped at 102
// max health for ever. That makes them the most consequential numbers in the fleet and the
// least often looked at, because a per-character table of twenty-one identical-looking rows
// is unreadable and nobody reads it.
//
// THE FLEET IS ROLLED FROM A HANDFUL OF RECIPES, so the page groups by the recipe. Twenty-one
// characters here are four builds — 8, 5, 4 and 4 — and that shape is the finding: it says
// how many bets this fleet has actually placed, and a build with one name beside it is a bet
// of one. A row-per-character table hid that behind a wall of repeated numbers.
//
// It reads `substrate/sheets/<Character>.json`, and NEEDS NOTHING LIVE. Every other board
// here has to say how old its figures are — a purse has no record but the sample, a bank
// balance is prose said once — but an attribute cannot go stale, so a sheet written last
// week is as true as a session open right now. The only staleness this page can have is a
// character with no sheet on disk at all, and that is reported as itself: named, linked, and
// never folded into a group as though its build were known.
//
// The pane is the client's own stats screen, read-only, out of `compendium/tools/statpane.mjs`
// — the same file the planner draws from, so the two cannot come to look different or to
// disagree about what 101 + stamina is.
import fs from 'node:fs';
import path from 'node:path';
import { SHEET_DIR } from './m59-sheet.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { esc, num, NAV, STYLE } from './m59-page-chrome.mjs';
import {
  STAT_ORDER, STATS, PANE_CSS, statPane, statsKey, healthCeiling, pointsSpent,
} from '../compendium/tools/statpane.mjs';

const { label: FLEET_LABEL } = resolveFleet();

const EXTRA_STYLE = `
  /* A build and the characters that are it, side by side. The pane is a fixed column
     because it is a picture of one screen and stretching it to the page would stop it
     looking like the screen; the names take whatever is left and wrap. */
  .build { display:grid; grid-template-columns:minmax(260px,320px) 1fr; gap:1.25rem;
           align-items:start; }
  @media (max-width:760px) { .build { grid-template-columns:1fr; } }
  .build + .build { margin-top:1.25rem; }
  /* HOW MANY OF THE FLEET THIS IS, LOUDLY, because that is the number the page exists to
     show and it is easy to read a pane as "a character" rather than "eight of them". */
  .share { display:flex; align-items:baseline; gap:.5rem; flex-wrap:wrap; margin:0 0 .5rem; }
  .share .n { font-size:1.5rem; font-weight:600; line-height:1.1; }
  .share .of { color:var(--dim); font-size:.85rem; }
  .bar { height:6px; border-radius:999px; background:var(--line); overflow:hidden; margin:0 0 .75rem; }
  .bar i { display:block; height:100%; background:var(--accent); }
  .roster { display:flex; flex-wrap:wrap; gap:.4rem; }
  /* One chip per character: the name is the link to its own page, the level beside it is
     what the build has made of itself so far. Max health IS the level here, and it is the
     only part of a row that moves — which is exactly why it sits outside the pane. */
  .who { display:inline-flex; align-items:baseline; gap:.35rem; padding:.2rem .6rem;
         border:1px solid var(--line); border-radius:999px; background:var(--panel);
         text-decoration:none; color:var(--fg); font-size:.88rem; }
  .who:hover { border-color:var(--accent); }
  .who b { font-weight:600; }
  .who .lv { color:var(--dim); font-size:.75rem; font-variant-numeric:tabular-nums; }
  .who .lv.max { color:var(--good); }
  .key { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim); }
`;

// ---------------------------------------------------------------- reading the record

// Every sheet on disk, as a build. A half-written file is skipped rather than fatal: the
// export writes them one at a time and this page is served while that is happening.
export function readBuilds({ dir = SHEET_DIR, characters = null } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const who = s?.character;
    if (!who) continue;
    if (characters && !characters.has(who)) continue;
    const a = s.attributes || {};
    const stats = {};
    for (const k of STAT_ORDER) if (Number.isFinite(Number(a[k]))) stats[k] = Number(a[k]);
    const caps = {};
    for (const k of STAT_ORDER) {
      const c = Number(a.detail?.[k]?.hard_cap);
      if (Number.isFinite(c)) caps[k] = c;
    }
    out.push({
      character: who,
      agent: s.agent ?? null,
      // A CHARACTER'S LEVEL IS ITS MAXIMUM HEALTH. There is no separate field, here or in
      // the game — see the sheet, which says the same thing.
      level: Number.isFinite(Number(s.level)) ? Number(s.level) : null,
      stats: statsKey(stats) == null ? null : stats,
      caps: Object.keys(caps).length ? caps : null,
      captured_at: s.captured_at ?? null,
    });
  }
  return out;
}

// GROUP BY THE SIX NUMBERS AND NOTHING ELSE. Not by level, which moves; not by pack, which
// moves every minute. Sorted largest group first, because "how much of the fleet is this"
// is the question, and a tie broken by the ceiling so the order is stable across renders
// rather than following whatever order readdir happened to give.
export function groupBuilds(rows) {
  const by = new Map();
  const unknown = [];
  for (const r of rows) {
    const k = statsKey(r.stats);
    if (k == null) { unknown.push(r); continue; }
    if (!by.has(k)) by.set(k, { key: k, stats: r.stats, caps: r.caps, members: [] });
    const g = by.get(k);
    g.members.push(r);
    // The caps are the server's own answer and every character agrees on them; keeping the
    // first non-null means a group whose first member predates them still draws correctly.
    if (!g.caps && r.caps) g.caps = r.caps;
  }
  const groups = [...by.values()];
  for (const g of groups) {
    g.members.sort((a, b) => (b.level ?? 0) - (a.level ?? 0)
      || a.character.localeCompare(b.character));
    g.count = g.members.length;
    g.ceiling = healthCeiling(g.stats.stamina);
    g.points = pointsSpent(g.stats);
    // How far this build has actually got, which is the only moving part of a group. The
    // best and the worst rather than a mean: eight characters at 30 and one at 47 is the
    // shape here, and a mean of 32 says neither thing.
    const levels = g.members.map(m => m.level).filter(v => v != null);
    g.best_level = levels.length ? Math.max(...levels) : null;
    g.worst_level = levels.length ? Math.min(...levels) : null;
  }
  // WHAT EACH BUILD IS FOR, SAID AGAINST THE OTHER BUILDS RATHER THAN AGAINST ITSELF.
  //
  // The tallest bar is the obvious label and it is a useless one: every character in this
  // fleet was rolled with 50 stamina, so "stamina" is the tallest bar in three of the four
  // builds and distinguishes none of them. TWO SEPARATE FACTS get conflated there, and the
  // page has to keep them apart —
  //
  //   uniform    an attribute every build here rolled the same. It says something about the
  //              FLEET (one ceiling for everybody) and nothing about any one build, so it is
  //              stated once above the panes rather than on every row.
  //   best_at    the attributes this build holds the fleet's highest of, ties included:
  //              breaking a tie by sort order would report a fact about readdir.
  //
  // What is left is what a build is actually for. A build with none left is the interesting
  // case — it leads in nothing, which no pane on its own can show.
  const uniform = [];
  for (const k of STAT_ORDER) {
    const vals = groups.map(g => g.stats[k] ?? 0);
    const best = Math.max(...vals);
    if (groups.length > 1 && Math.min(...vals) === best) uniform.push(k);
    for (const g of groups) if ((g.stats[k] ?? 0) === best) (g.best_at ??= []).push(k);
  }
  for (const g of groups) {
    g.best_at ??= [];
    g.distinctive = g.best_at.filter(k => !uniform.includes(k));
  }
  groups.sort((a, b) => b.count - a.count
    || (b.ceiling ?? 0) - (a.ceiling ?? 0)
    || a.key.localeCompare(b.key));
  unknown.sort((a, b) => a.character.localeCompare(b.character));
  return { groups, unknown, uniform, known: rows.length - unknown.length, total: rows.length };
}

// ---------------------------------------------------------------- the page

const pct = (n, of) => (of ? Math.round((1000 * n) / of) / 10 : 0);

// "10 out of 20 characters (50%)". Written out rather than as a bare percentage because a
// share of twenty-one is not a percentage anybody should have to reverse.
const shareLine = (n, of) =>
  `<span class="n">${n}</span><span class="of">out of ${of} character${of === 1 ? '' : 's'}` +
  ` (${pct(n, of)}%)</span>`;

const chip = (m, ceiling) => {
  const at = ceiling != null && m.level != null && m.level >= ceiling;
  return `<a class="who" href="/hero/${encodeURIComponent(m.character)}"` +
    ` title="${esc(m.character)}${m.level == null ? '' : ` — max health ${m.level}` +
      (ceiling == null ? '' : ` of a possible ${ceiling}`)}">` +
    `<b>${esc(m.character)}</b>${m.level == null ? ''
      : `<span class="lv${at ? ' max' : ''}">${m.level}</span>`}</a>`;
};

export function renderStatsBoard({ characters = null, dir = SHEET_DIR } = {}) {
  const rows = readBuilds({ dir, characters });
  const { groups, unknown, uniform, known, total } = groupBuilds(rows);

  // A ROSTER CHARACTER WITH NO SHEET AT ALL WOULD OTHERWISE JUST BE ABSENT, and absent from
  // a page of percentages is indistinguishable from not existing — the shares would sum to
  // 100% of a fleet with somebody missing from it. So it is named. This is a different
  // failure from `unknown` above and must not be merged with it: `unknown` has a sheet whose
  // attributes nobody has read, this has no sheet, and the fix is a different command.
  const onFile = new Set(rows.map(r => r.character));
  const missing = characters ? [...characters].filter(c => !onFile.has(c)).sort() : [];

  // The fleet's own ceiling spread, which is the one thing worth saying about the set of
  // builds rather than about any one of them.
  const ceilings = groups.flatMap(g => g.members.map(() => g.ceiling)).filter(v => v != null);
  const bestCeiling = ceilings.length ? Math.max(...ceilings) : null;
  const worstCeiling = ceilings.length ? Math.min(...ceilings) : null;

  const builds = groups.map(g => `
    <div class="build">
      <div>${statPane(g.stats, { caps: g.caps })}</div>
      <div>
        <p class="share">${shareLine(g.count, total || known)}</p>
        <div class="bar"><i style="width:${pct(g.count, total || known)}%"></i></div>
        <div class="sub" style="margin-bottom:.6rem">
          ${groups.length < 2
            ? `<span title="there is nothing to compare it against, so it is neither the best at anything nor beaten at anything">the only build in the fleet</span>`
            : g.distinctive.length
            ? `<span title="the fleet's highest value in this attribute — ties included, since breaking a tie by sort order would report a fact about file order. Attributes every build here rolled the same are left out; they are named above the panes.">best in the fleet at ${
                g.distinctive.map(k => esc(STATS[k]?.label ?? k)).join(', ').toLowerCase()}</span>`
            : `<span class="warn" title="every other build here matches or beats it in each of the attributes that vary — the balanced roll, which leads in nothing">the fleet's best at nothing</span>`} ·
          <span title="max health IS the level here, and it is the only number about these characters that moves">${
            g.best_level == null ? 'no max health read yet'
            : g.worst_level === g.best_level ? `all at ${g.best_level} max health`
            : `${g.worst_level}–${g.best_level} max health so far`}</span>
          <span class="key" title="the six numbers, in the order the pane draws them">${esc(g.key)}</span>
        </div>
        <div class="roster">${g.members.map(m => chip(m, g.ceiling)).join('')}</div>
      </div>
    </div>`).join('');

  const nothingYet = !rows.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stats — ${esc(FLEET_LABEL)} fleet</title>
<!-- PANE_CSS is inlined rather than linked because these boards are served by the machine
     running the game server and are read from a phone on its LAN — the same reason the
     treemap is inlined. A pane that renders as a bare list of numbers when one asset does
     not arrive is worse than no pane. -->
<style>${STYLE}${EXTRA_STYLE}${PANE_CSS}</style>
</head><body><div class="wrap">
  <h1>Stats</h1>
  <div class="sub">The builds this fleet is made of, grouped by the six numbers that never
    move · ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('stats')}

  <div class="cards">
    <div class="card"><div class="k">builds</div><div class="v">${groups.length}</div>
      <div class="n">distinct sets of attributes</div></div>
    <div class="card"><div class="k">characters</div><div class="v">${total}</div>
      <div class="n">${known} with attributes on file${
        missing.length ? `, and ${missing.length} in the roster with no sheet` : ''}</div></div>
    <div class="card"><div class="k">largest build</div>
      <div class="v">${groups.length ? pct(groups[0].count, total) + '%' : '—'}</div>
      <div class="n">${groups.length ? `${groups[0].count} of ${total} share one roll` : 'nothing on file'}</div></div>
    <div class="card"><div class="k">health ceiling</div>
      <div class="v">${worstCeiling == null ? '—'
        : worstCeiling === bestCeiling ? num(bestCeiling) : `${num(worstCeiling)}–${num(bestCeiling)}`}</div>
      <div class="n">101 + stamina, and it is the cap for ever</div></div>
  </div>

  ${nothingYet ? `
  <div class="panel"><div class="caveat">
    <b>No character sheet on disk yet.</b> The attributes come from
    <code>substrate/sheets/&lt;Character&gt;.json</code>, which
    <code>node tools/m59-sheet.mjs</code> writes — and which
    <code>node tools/m59-backup.mjs</code> refreshes before every backup. Nothing here can
    be inferred from the ledger: it records levels, not attributes.
  </div></div>` : `
  <h2>Every build the fleet has</h2>
  <div class="sub">One pane per set of attributes — the client's own stats screen, read-only
    — and beside it every character rolled that way. Attributes are fixed at creation and
    never move, so nothing on a pane can change; the number beside each name is its max
    health, which is the only part that does, and green means it has reached the ceiling
    this build allows. Names link to the character's own page.</div>
  ${uniform.length ? `
  <div class="caveat">Every build here rolled the same
    ${uniform.map(k => `<b>${esc((STATS[k]?.label ?? k).toLowerCase())} ${
      groups[0].stats[k]}</b>`).join(' and the same ')}, so
    ${uniform.includes('stamina')
      ? `the ceiling on max health is ${groups[0].ceiling} for the whole fleet — no build here
         can outlast another, and none of the differences below buy a single extra point of it.`
      : `that attribute says nothing about which build a character is.`}
    Attributes the builds share are left out of the "best in the fleet at" line below, which
    would otherwise name ${esc((STATS[uniform[0]]?.label ?? uniform[0]).toLowerCase())} on
    every row and distinguish nothing.</div>` : ''}
  ${builds}

  ${unknown.length || missing.length ? `
  <h2>Not grouped</h2>
  <div class="sub">Characters the panes above do not account for, and why — two different
    reasons with two different fixes, kept apart because a build nobody has read and a build
    of zeroes would otherwise render identically.</div>
  <div class="panel">
    ${unknown.length ? `
    <div class="sub"><b>${unknown.length} with a sheet that carries no attributes.</b>
      A sheet written before the read landed. It is NOT a build: a character whose roll
      nobody has read is not a character that rolled zeroes — though such a character is
      real, since <code>create automated</code> makes one and caps it at 102 max health for
      ever.</div>
    <div class="roster" style="margin-bottom:.75rem">${
      unknown.map(m => chip(m, null)).join('')}</div>` : ''}
    ${missing.length ? `
    <div class="sub"><b>${missing.length} in the roster with no sheet at all.</b>
      Not counted in any share above, so the percentages are of the
      ${total} character${total === 1 ? '' : 's'} on file rather than of the whole roster.
      <code>node tools/m59-sheet.mjs</code> writes one.</div>
    <div class="roster">${missing.map(c => chip({ character: c, level: null }, null)).join('')}</div>` : ''}
  </div>` : ''}`}

  <div class="caveat" style="margin-top:1.5rem">
    Attributes are fixed at creation and never move (<code>player.kod:796-801</code>), and
    stamina alone sets the ceiling on max health — <code>101 + stamina</code>,
    <code>player.kod:7830</code> — so a build decides in advance how far a character can ever
    get. That is why this board needs nothing live and carries no freshness pill: unlike a
    purse or a bank balance, a reading of these cannot go out of date. The only thing that can
    be missing here is a character, never a stale number — and any character that is missing is
    named above rather than left out.
  </div>
</div>
</body></html>`;
}
