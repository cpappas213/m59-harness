// One-off: replace the reference-character panel markup in derive/creatures.mjs.
// Kept as a file rather than an inline heredoc because the replacement is a
// template literal full of backticks and ${}.
import fs from 'node:fs';

const p = 'tools/derive/creatures.mjs';
const src = fs.readFileSync(p, 'utf8');

const START = '<div id="refchar" class="refchar">';
const END = '  <div id="refSummary" class="refsummary"></div>\n</div>';
const i = src.indexOf(START);
const j = src.indexOf(END);
if (i < 0 || j < 0) throw new Error('panel markers not found');

const panel = String.raw`<div id="refchar" class="refchar" data-mode="detailed">
  <div class="refhead">
    <button type="button" id="refCollapse" class="iconbtn" aria-expanded="true"
            title="Collapse or expand">&#9662;</button>
    <strong class="refttl">Reference character</strong>
    <select id="refPreset" aria-label="Saved build">${PRESETS.map((p, i) =>
      `<option value="${p.id}"${i === 2 ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <span class="seg" role="group" aria-label="Input mode">
      <button type="button" id="modeDetailed" class="segbtn on">Detailed</button
      ><button type="button" id="modeSimple" class="segbtn">Simple</button>
    </span>
    <button type="button" id="refGo" class="btn primary">Generate</button>
    <span class="refspacer"></span>
    <button type="button" id="refPop" class="btn" title="Keep this panel on screen while you scroll">Pop out</button>
  </div>

  <div class="refbody" id="refBody">
    <div class="refrow">
      <label>Save as
        <input type="text" id="refName" placeholder="my fighter" maxlength="32" autocomplete="off">
      </label>
      <button type="button" id="refClone" class="btn">Save as new</button>
      <button type="button" id="refSave" class="btn">Update</button>
      <button type="button" id="refDelete" class="btn">Delete</button>
      <button type="button" id="refReset" class="btn">Reset</button>
      <span id="refMsg" class="refmsg" role="status"></span>
    </div>

    <div class="refgrid" id="gridSimple" hidden>
      <fieldset><legend>Straight from your status screen</legend>
        <label>Offence <input type="number" id="d_off" min="1" max="1000" value="695"></label>
        <label>Defence <input type="number" id="d_def" min="1" max="1000" value="610"></label>
        <label>Damage low <input type="number" id="d_dlo" min="1" max="200" value="5"></label>
        <label>Damage high <input type="number" id="d_dhi" min="1" max="200" value="9"></label>
        <label>Max health <input type="number" id="d_hp" min="1" max="300" value="100"></label>
      </fieldset>
      <fieldset class="wide"><legend>What simple mode does not know</legend>
        <p class="fsnote">Offence, defence and damage already contain your attributes, skills and
        weapon — but not your armour's <em>flat damage reduction</em> or its
        <em>typed resistances</em>, because no single number carries those. So
        <strong>Damage to you</strong> and <strong>Swings to die</strong> are shown before
        armour mitigation, and are pessimistic by however much your armour absorbs.
        Switch to Detailed to model it.</p>
      </fieldset>
    </div>

    <div class="refgrid" id="gridDetailed">
      <fieldset><legend>Vitals</legend>
        <label>Max health <input type="number" id="rMaxHealth" min="1" max="300" value="${defaultRef.maxHealth}"></label>
      </fieldset>
      <fieldset><legend>Attributes</legend>
        ${['might', 'agility', 'stamina', 'intellect', 'mysticism', 'aim'].map((k) =>
          `<label>${k[0].toUpperCase() + k.slice(1)} <input type="number" id="s_${k}" min="1" max="50" value="${defaultRef.stats[k]}"></label>`).join('')}
      </fieldset>
      <fieldset><legend>Skills</legend>
        ${[['stroke', 'Stroke'], ['proficiency', 'Proficiency'], ['parry', 'Parry'], ['block', 'Block'], ['dodge', 'Dodge']].map(([k, l]) =>
          `<label>${l} <input type="number" id="k_${k}" min="0" max="99" value="${defaultRef.skills[k]}"></label>`).join('')}
      </fieldset>
      <fieldset><legend>Equipment</legend>
        <label>Weapon <select id="g_weapon">${opt(weapons, defaultRef.weapon, 'unarmed')}</select></label>
        ${SLOTS.map((s) =>
          `<label>${s.label} <select id="g_${s.key}">${opt(armour[s.key], defaultRef.gear[s.key], 'none')}</select></label>`).join('')}
      </fieldset>
    </div>
  </div>
`;

fs.writeFileSync(p, src.slice(0, i) + panel + src.slice(j), 'utf8');
console.log('panel replaced');
