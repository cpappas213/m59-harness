// GENERATED from tools/statpane.mjs by tools/derive/planner.mjs — do not edit.
(function(){
// statpane.mjs -- THE CLIENT'S STATS PANE, AND THE ARITHMETIC UNDER IT. Zero imports.
//
// The planner draws this pane so a person can describe a build; the fleet's /stats board
// draws the same pane, read-only, so a person can see which builds the fleet actually has.
// They must not be able to look different or say different things, so both take the pane
// from here: the labels, the six-stat order, the CSS, the markup, and the three derived
// numbers in the footer.
//
// TWO CONSUMERS IN TWO LANGUAGES, WHICH IS WHY THIS FILE HAS NO IMPORTS AND TOUCHES NO
// DISK. It is imported by `tools/m59-planner-data.mjs` and `tools/m59-stats-page.mjs` in
// node, and inlined into `assets/statpane.js` + `assets/statpane.css` by
// `derive/planner.mjs` for the browser — the same trick `learn.mjs` and `calc.mjs` use, and
// the inliner strips import lines, so anything this file depended on would silently become
// undefined in a browser and nowhere else.
//
// ATTRIBUTES ARE THE ONE READING IN THIS REPOSITORY THAT CANNOT GO STALE. They are fixed at
// creation and never move (`create automated` is unrepairable for exactly this reason), so
// a pane drawn from a character sheet written last week is as true as one drawn from a live
// session. Every other board here has to say how old its numbers are; this one does not,
// and that is a property of the quantity rather than of the code.

// The six a character is rolled with, in the client's own order, named as the kod names
// them — every lookup anywhere keys off this spelling.
const STAT_ORDER = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];

const STATS = {
  might:     { label: 'Might',     blurb: 'Melee damage, and what heavy weapons key off.' },
  intellect: { label: 'Intellect', blurb: 'How fast every skill and spell improves, and how many school levels a character can learn in its lifetime.' },
  stamina:   { label: 'Stamina',   blurb: 'Maximum health is 101 + stamina, fixed at creation and never moved.' },
  agility:   { label: 'Agility',   blurb: 'Avoiding blows, and what most combat skills key off.' },
  mysticism: { label: 'Mysticism', blurb: 'Mana pool and spellcasting.' },
  aim:       { label: 'Aim',       blurb: 'Ranged accuracy, and what the precision weapon skills key off.' },
};

// The ceiling a bar is drawn against. The server sends `hard_cap` with every attribute and
// that is what should be used; 70 is only the fallback for a build nobody has observed.
const HARD_CAP_FALLBACK = 70;

// ---------------------------------------------------------------- the derived numbers
//
// Three numbers a person reads off a build, none of which is an attribute. Here rather than
// in each pane because a quantity with two homes in this repository has always ended up
// with two answers.

// The absolute ceiling on max health, which IS the level in this fleet's terms
// (player.kod:7830, `piBase_Max_health < (101 + GetStamina)`). Not what the character has —
// what it can ever have.
function healthCeiling(stamina) {
  return stamina == null ? null : 101 + Number(stamina);
}

// Weight AND bulk are both bounded by this, so a pack that fits by weight can still be
// refused for bulk (`viBulk_hold_max = 1700`, player.kod:737; `GetBulkMax`, player.kod:10456).
function carryCapacity(might) {
  return 1700 + (Number(might) || 0) * 20;
}

function pointsSpent(stats) {
  return STAT_ORDER.reduce((t, k) => t + (Number(stats && stats[k]) || 0), 0);
}

// ---------------------------------------------------------------- identity
//
// WHAT MAKES TWO CHARACTERS THE SAME BUILD. The six numbers and nothing else — not the
// level, which moves, and not the pack. Written as the numbers themselves so the key is
// legible in a URL, in a log line and in a test failure: `50/10/50/45/15/30`.
function statsKey(stats) {
  if (!stats) return null;
  const vals = STAT_ORDER.map(k => (Number.isFinite(Number(stats[k])) ? Number(stats[k]) : null));
  return vals.some(v => v == null) ? null : vals.join('/');
}

function sameStats(a, b) {
  const ka = statsKey(a);
  return ka != null && ka === statsKey(b);
}

// ---------------------------------------------------------------- the pane, as CSS
//
// The frame and the bars, which is all a read-only pane needs. The planner's own additions
// — the tab strip, the draggable bar, the hatching that marks a PLANNED value — stay in
// planner.css, because a board showing what a character is cannot show a plan and must not
// carry the styling that says it could.
//
// WHY IT IGNORES THE READER'S LIGHT/DARK PREFERENCE, on both pages. The point of borrowing
// the client's panel is that it looks like the thing next to it on the desktop, and a "dark
// mode Meridian 59" is a different program. The chrome around it follows the theme as
// usual; the seam is deliberate.
//
// The colours are taken off screenshots of the running client at 1x, not guessed:
// panel 0x9c9c9c, bar trough 0x5c1414, bar fill 0x18a018, bar border 0xc8a028.
const PANE_CSS = `
:root {
  --m59-panel: #9c9c9c;
  --m59-panel-lit: #b4b4b4;
  --m59-panel-dim: #6e6e6e;
  --m59-trough: #5c1414;
  --m59-fill: #18a018;
  --m59-edge: #c8a028;
  --m59-ink: #1c1c1c;
  --m59-ink-dim: #4a4a4a;
  --m59-say: #800080;      /* the client's own message colour */
}

/* The panel's noise. The client's is a bitmap; this is the same idea at the same
 * amplitude, inlined so the page has no extra request and works from a file:// copy. */
.m59 {
  --m59-noise: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='64' height='64' filter='url(%23n)' opacity='0.16'/%3E%3C/svg%3E");
}

.m59 {
  background: var(--m59-noise), var(--m59-panel);
  border: 2px solid;
  border-color: var(--m59-panel-lit) var(--m59-panel-dim) var(--m59-panel-dim) var(--m59-panel-lit);
  padding: 3px;
  color: var(--m59-ink);
  font: 13px/1.35 "Segoe UI", Tahoma, "DejaVu Sans", sans-serif;
  min-width: 0;
}
.m59 * { box-sizing: border-box; }

/* ---- stat bars */

.m59-bars { display: grid; grid-template-columns: max-content 1fr; gap: 3px 8px; align-items: center; }
.m59-bars > .k { font-size: 13px; color: var(--m59-ink); }
.m59-bar {
  position: relative; height: 17px; background: var(--m59-trough);
  border: 1px solid var(--m59-edge); overflow: hidden;
}
.m59-bar > i { display: block; height: 100%; background: var(--m59-fill); }
.m59-bar > b {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end;
  padding-right: 5px; font-weight: 400; font-size: 11px; color: #fff;
  text-shadow: 0 0 2px #000, 0 0 2px #000;
}
/* Where the value came from. A number read off a real character and one somebody typed
 * must not render identically — that is the whole rule this site is built on. Every bar on
 * the fleet's own board is observed; on the planner most of them are not. */
.m59-bar.observed { border-color: #e8e8e8; }

/* The pane's own footer line. */
.m59-foot {
  margin-top: 4px; padding-top: 3px; border-top: 1px solid var(--m59-panel-dim);
  font-size: 11px; color: var(--m59-ink-dim); display: flex; gap: 10px; flex-wrap: wrap;
}
.m59-foot .over { color: #7a1010; font-weight: 600; }
`;

// ---------------------------------------------------------------- the pane, as markup

// Small and local rather than imported, because this file has no imports on purpose. The
// only untrusted thing that reaches it is a stat value, which is rendered as a number.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One bar per attribute. `caps` is the server's own `hard_cap` per stat when we have it.
function statBars(stats, { caps = null, observed = true } = {}) {
  return STAT_ORDER.map(k => {
    const meta = STATS[k] || { label: k, blurb: '' };
    const v = Number(stats && stats[k]);
    const known = Number.isFinite(v);
    const cap = (caps && Number(caps[k])) || HARD_CAP_FALLBACK;
    const pct = known ? Math.max(0, Math.min(100, (v / cap) * 100)) : 0;
    return `<span class="k" title="${esc(meta.blurb)}">${esc(meta.label)}</span>`
      + `<span class="m59-bar${observed && known ? ' observed' : ''}"`
      + ` title="${esc(meta.label)} ${known ? v : '—'} of ${cap}">`
      + `<i style="width:${pct.toFixed(1)}%"></i><b>${known ? v : '—'}</b></span>`;
  }).join('');
}

// The three numbers a build is actually judged on. The ceiling is deliberately first: nine
// characters in this fleet are stuck because a level-50 creature cannot advance a level-50
// character, and stamina is the only thing that decides how far any of them can ever get.
function statFoot(stats) {
  const ceiling = healthCeiling(stats && stats.stamina);
  return `<span title="the most max health this build can ever reach (player.kod:7830)">max health ceiling ${
    ceiling == null ? '—' : ceiling} (101 + stamina)</span>`
    + `<span>${pointsSpent(stats)} points spent</span>`
    + `<span title="weight and bulk are each bounded by this (player.kod:10456)">carry ${
      carryCapacity(stats && stats.might)}</span>`;
}

// THE READ-ONLY PANE. No tab strip, no sliders, nothing that suggests a value here could be
// edited — attributes are fixed at creation, so a board that let you drag one would be
// offering a re-roll, which is what the planner is for.
function statPane(stats, { caps = null, foot = true, extra = '' } = {}) {
  return `<div class="m59 m59-statpane">`
    + `<div class="m59-bars">${statBars(stats, { caps })}</div>`
    + (foot ? `<div class="m59-foot">${statFoot(stats)}</div>` : '')
    + extra
    + `</div>`;
}

window.M59StatPane={STAT_ORDER,STATS,HARD_CAP_FALLBACK,healthCeiling,carryCapacity,pointsSpent,statsKey,sameStats,statBars,statFoot,statPane};
})();
