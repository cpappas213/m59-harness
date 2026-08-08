// derive/planner.mjs -- the page between the compendium and the fleet.
//
// The rest of this site answers "what is this thing". This page answers "what should this
// character be", and then writes the answer somewhere the fleet reads: a LOADOUT, one file
// per character, which the keeper consults before it buys, sells, keeps or drops anything.
//
// It is the only page here that can WRITE. Everything else is a static tree that happens
// to be served; this posts to `/_loadout` on the harness's own compendium server, which is
// loopback-only, and falls back to downloading the file when the site is opened any other
// way. So the page works as files, works served, and does the useful thing when it is the
// harness serving it — the same three-way arrangement the bestiary's live character uses.
//
// WHERE THE DATA COMES FROM. `data/planner.json`, written by the harness's
// `tools/m59-planner-data.mjs`: the skills with their requisite stats, every spell with its
// school and level, the item catalogue with weights and sprites, and the four constants
// PlayerCanLearn is computed from. Not derived here, because the loadout tool reads the
// same file to check a loadout against the game, and a planner that disagreed with the
// checker would produce builds the fleet then rejected.
//
// A MISSING planner.json IS NOT A BROKEN PAGE. It is a page that says which command to run.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, esc } from '../lib.mjs';

export const meta = {
  id: 'planner', title: 'Planner', dir: 'planner', order: 2, nav: true,
  blurb: 'Plan a character, then hand the fleet a list of what it should be carrying.',
};

// The client's four tabs, in the client's order, with the client's meanings. Drawn rather
// than lifted: the real ones are 16x16 bitmaps inside the client's own resource file, and
// nothing in this repository decodes the UI chrome — only the object sprites.
const TAB_ICONS = {
  inventory: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="5" width="14" height="9" fill="#7a4a20" stroke="#3a2410"/><rect x="1" y="3" width="14" height="3" fill="#96601f" stroke="#3a2410"/><rect x="7" y="7" width="2" height="4" fill="#d8b040" stroke="#3a2410" stroke-width=".5"/></svg>',
  spells: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 L11 5" stroke="#7a4a20" stroke-width="2"/><path d="M12 2 l1 2.5 2.5 1 -2.5 1 -1 2.5 -1 -2.5 -2.5 -1 2.5 -1z" fill="#e8d24a" stroke="#8a6a10" stroke-width=".5"/></svg>',
  skills: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 14V7a1 1 0 0 1 2 0V4a1 1 0 0 1 2 0v3a1 1 0 0 1 2 0v1a1 1 0 0 1 2 0v3a3 3 0 0 1-3 3z" fill="#d8a878" stroke="#6a3a14"/></svg>',
  stats: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="3" width="14" height="3" fill="#5c1414" stroke="#c8a028" stroke-width=".7"/><rect x="1.7" y="3.7" width="9" height="1.6" fill="#18a018"/><rect x="1" y="7" width="14" height="3" fill="#5c1414" stroke="#c8a028" stroke-width=".7"/><rect x="1.7" y="7.7" width="5" height="1.6" fill="#18a018"/><rect x="1" y="11" width="14" height="3" fill="#5c1414" stroke="#c8a028" stroke-width=".7"/><rect x="1.7" y="11.7" width="12" height="1.6" fill="#18a018"/></svg>',
};

const tab = (id, label) =>
  `<button type="button" class="m59-tab" role="tab" id="tab-${id}" data-tab="${id}" ` +
  `aria-controls="pane-${id}" aria-selected="${id === 'inventory'}">` +
  `${TAB_ICONS[id]}<span class="lbl">${esc(label)}</span></button>`;

export function build() {
  // The page reads this at runtime; the build only needs to know whether it is there, so
  // that a missing one is reported on the page rather than as an empty picker.
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'planner.json'), 'utf8')); }
  catch { /* reported below */ }

  if (!data) {
    return {
      indexHtml: `<h1>Character planner</h1>
<p class="lede">This page needs <code>data/planner.json</code>, which is not here yet.</p>
<p>It is written by the harness, from the game's own source, and carries the skills with
their requisite stats, every spell with its school and level, the item catalogue with
weights and sprites, and the four constants <code>PlayerCanLearn</code> is computed from:</p>
<pre><code>node tools/m59-planner-data.mjs</code></pre>
<p>Nothing on this page is hand-maintained, so there is no fallback to show you — a planner
that guessed at the numbers would produce confident wrong builds, which is worse than no
planner. Run that and rebuild.</p>`,
      pages: [], scripts: [], styles: [],
    };
  }

  const unresolved = data.learning?.unresolved ?? [];
  const cites = data.learning?.cites ?? {};
  const citeList = Object.entries(cites).filter(([, v]) => v)
    .map(([k, v]) => `<code>${esc(k)}</code> ${esc(v)}`).join(', ');

  const indexHtml = `<h1>Character planner</h1>
<p class="lede">Bring a character in, decide what it should become and what it should be
carrying, and hand that back to the fleet. The panel is the client's own — the same four
tabs in the same order — and everything in it is editable.</p>

<div class="pl-bar">
  <label>Character
    <select id="plChar" aria-label="Which character to plan"></select>
  </label>
  <label>Name <input type="text" id="plName" size="14" autocomplete="off" spellcheck="false"></label>
  <span class="grow"></span>
  <button type="button" class="btn" id="plImport">Import a file…</button>
  <input type="file" id="plFile" accept="application/json,.json" hidden>
  <button type="button" class="btn" id="plExport">Export</button>
  <button type="button" class="btn" id="plGearFleet" title="Give every character in the fleet this weapon and armour preference. Only the gear — every other part of their loadouts is left alone.">Apply gear to fleet</button>
  <button type="button" class="btn primary" id="plSave">Save to the fleet</button>
  <span class="pl-msg" id="plMsg" role="status"></span>
</div>

<div class="pl-wrap">
  <div class="m59" id="plPanel">
    <div class="m59-tabs" role="tablist" aria-label="Character panel">
      ${tab('inventory', 'Inventory')}${tab('spells', 'Spells')}${tab('skills', 'Skills')}${tab('stats', 'Stats')}
    </div>

    <div class="m59-pane" id="pane-inventory" role="tabpanel" aria-labelledby="tab-inventory">
      <div class="m59-grid" id="plGrid"></div>
      <div class="m59-empty" id="plGridEmpty">Nothing asked for yet. Pick something from the
        list on the right — reagents first, they are what the fleet actually runs out of.</div>
      <div class="m59-foot" id="plCarryFoot"></div>
    </div>

    <div class="m59-pane" id="pane-spells" role="tabpanel" aria-labelledby="tab-spells" hidden>
      <div class="m59-schools" id="plSchools"></div>
      <div class="m59-foot" id="plSchoolFoot"></div>
    </div>

    <div class="m59-pane" id="pane-skills" role="tabpanel" aria-labelledby="tab-skills" hidden>
      <div class="m59-list" id="plSkills"></div>
      <div class="m59-foot" id="plSkillFoot"></div>
    </div>

    <div class="m59-pane" id="pane-stats" role="tabpanel" aria-labelledby="tab-stats" hidden>
      <div class="m59-bars" id="plStats"></div>
      <div class="m59-foot" id="plStatFoot"></div>
    </div>
  </div>

  <div class="pl-side">
    <section id="plFleetBox" hidden>
      <h2>Give the whole fleet this gear</h2>
      <div id="plFleet"></div>
    </section>

    <section id="plEditor">
      <h2 id="plEditorTitle">What this tab changes</h2>
      <div id="plEditorBody"></div>
    </section>

    <section id="plDiffBox" hidden>
      <h2>Against what it is carrying now</h2>
      <p class="hint">Read live from the fleet when the harness is serving this page. This is
      exactly what <code>node tools/m59-loadout.mjs &lt;name&gt; --check</code> reports, and
      what the keeper acts on.</p>
      <div class="pl-diff" id="plDiff"></div>
    </section>

    <section id="plProblemBox" hidden>
      <h2>Worth knowing about this loadout</h2>
      <ul class="pl-problems" id="plProblems"></ul>
    </section>

    <section>
      <h2>What happens to this</h2>
      <p class="pl-note"><strong>Save to the fleet</strong> writes
      <code>substrate/loadouts/&lt;character&gt;.json</code>. From there the keeper reads it
      every pass: it stops selling what the list protects, sheds what the list says to shed,
      tops up to the minimums when it is standing at a counter anyway, and reaches for the
      weapon named here rather than whichever one it happens to be best with. Nothing the
      list is silent about changes — a loadout adds rules, it does not replace them.</p>
      <p class="pl-note"><strong>Apply gear to fleet</strong> writes the <em>gear</em> half of
      this plan — the weapon and armour preference — into every character's loadout, and
      changes nothing else in any of them: carry lists, schools, sell and keep lists and purse
      floors are left exactly as they are. It says what it would do first and needs a second
      press. It is the same thing as
      <code>node tools/m59-loadout.mjs &lt;name&gt; --gear-to-fleet --apply</code>, and it does
      not save the rest of what you have edited here — that is what Save is for.</p>
      <p class="pl-note"><strong>Export</strong> downloads the same file. Drop it in that
      directory by hand and it means the same thing; the planner is a convenience, not the
      format's owner.</p>
      <p class="pl-prov">Skills, spells and items derived from the game source
      (<code>${esc(data.builtFrom?.koddb ?? 'kod/')}</code>): ${data.skills.length} skills,
      ${data.spells.length} spells across ${data.schools.length} schools,
      ${data.items.length} items.
      ${unresolved.length
        ? `<br><strong>Advancement costs are not shown</strong>: ${esc(unresolved.join(', '))}
           could not be read. ${esc(data.learning?.note ?? '')}`
        : `Learning constants read from the source: ${citeList}.`}</p>
    </section>
  </div>
</div>`;

  // THE LEARNING ARITHMETIC, THE SAME COPY THE LOADOUT TOOL RUNS. Inlined out of
  // tools/learn.mjs rather than rewritten for the browser — exactly as creatures.mjs does
  // with calc.mjs, and for the same reason: the planner and the checker must not be able to
  // give different answers to "what does this level cost". learn.mjs has no imports, so
  // stripping the export keywords is the whole of the translation.
  const learnSrc = fs.readFileSync(path.join(ROOT, 'tools', 'learn.mjs'), 'utf8')
    .replace(/^export /gm, '');
  const browserLearn = '// GENERATED from tools/learn.mjs by tools/derive/planner.mjs — do not edit.\n'
    + `(function(){\n${learnSrc}\nwindow.M59Learn={learnCost,canLearn,trackPoints,levelPointsAt};\n})();\n`;

  return {
    indexHtml, pages: [],
    // learn.js first: planner.js reads window.M59Learn at boot.
    scripts: ['learn.js', 'planner.js'],
    styles: ['planner.css'],
    files: { 'assets/learn.js': browserLearn },
  };
}
