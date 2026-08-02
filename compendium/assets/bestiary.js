// bestiary.js -- the reference-character calculator on creatures/index.html.
//
// The page arrives already computed against one preset, so it is useful with
// JavaScript off. This file lets the reader describe a different character and
// recomputes every row in place, and lets them choose and reorder columns.
//
// All arithmetic lives in assets/calc.js, generated from tools/calc.mjs, which
// is the same code the site generator used to render the page. There is exactly
// one implementation of the combat formulas.

(function () {
  var panel = document.getElementById('refchar');
  var table = document.getElementById('beasttable');
  if (!panel || !table || !window.M59Calc) return;

  var C = window.M59Calc;
  var rel = window.M59_REL || '..';
  var DATA = null;
  var LS_BUILDS = 'm59-builds';
  var LS_CURRENT = 'm59-build-current';
  var LS_COLS = 'm59-bestiary-cols';
  var LS_MODE = 'm59-build-mode';
  var LS_POP = 'm59-refchar-pop';
  var LS_OPEN = 'm59-refchar-open';

  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k, d) {
    try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch (e) { return d; }
  }

  // ------------------------------------------------------------- builds

  function allBuilds() {
    var out = DATA.presets.map(function (p) { return p; });
    return out.concat(load(LS_BUILDS, []));
  }
  function findBuild(id) {
    var all = allBuilds();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return DATA.presets[2];
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function refreshPresetSelect(sel) {
    var s = document.getElementById('refPreset');
    var cur = sel || s.value;
    var custom = load(LS_BUILDS, []);
    s.innerHTML = '';
    var g1 = document.createElement('optgroup'); g1.label = 'Presets';
    DATA.presets.forEach(function (p) {
      var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; g1.appendChild(o);
    });
    s.appendChild(g1);
    if (custom.length) {
      var g2 = document.createElement('optgroup'); g2.label = 'Your builds';
      custom.forEach(function (p) {
        var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; g2.appendChild(o);
      });
      s.appendChild(g2);
    }
    s.value = cur;
    if (s.value !== cur) s.value = DATA.presets[2].id;
  }

  // Read the form into a build object.
  function readForm() {
    var stats = {}, skills = {}, gear = {};
    ['might', 'agility', 'stamina', 'intellect', 'mysticism', 'aim'].forEach(function (k) {
      stats[k] = +(document.getElementById('s_' + k) || {}).value || 0;
    });
    ['stroke', 'proficiency', 'parry', 'block', 'dodge'].forEach(function (k) {
      skills[k] = +(document.getElementById('k_' + k) || {}).value || 0;
    });
    DATA.slots.forEach(function (s) {
      var el = document.getElementById('g_' + s.key);
      if (el && el.value) gear[s.key] = el.value;
    });
    var mode = panel.getAttribute('data-mode') || 'detailed';
    var num = function (id, dflt) { var el = document.getElementById(id); return el ? (+el.value || dflt) : dflt; };
    return {
      id: document.getElementById('refPreset').value,
      name: '', mode: mode,
      // In simple mode the health that matters is the one typed beside the
      // other three numbers, not the one in the detailed panel.
      maxHealth: mode === 'simple' ? num('d_hp', 1) : num('rMaxHealth', 1),
      stats: stats, skills: skills, gear: gear,
      weapon: (document.getElementById('g_weapon') || {}).value || '',
      direct: {
        off: num('d_off', 1), def: num('d_def', 1),
        dmgLo: num('d_dlo', 1), dmgHi: num('d_dhi', 1),
      },
    };
  }

  function writeForm(b) {
    document.getElementById('rMaxHealth').value = b.maxHealth;
    Object.keys(b.stats).forEach(function (k) {
      var el = document.getElementById('s_' + k); if (el) el.value = b.stats[k];
    });
    Object.keys(b.skills).forEach(function (k) {
      var el = document.getElementById('k_' + k); if (el) el.value = b.skills[k];
    });
    var w = document.getElementById('g_weapon'); if (w) w.value = b.weapon || '';
    DATA.slots.forEach(function (s) {
      var el = document.getElementById('g_' + s.key);
      if (el) el.value = (b.gear && b.gear[s.key]) || '';
    });
    if (b.direct) {
      setVal('d_off', b.direct.off); setVal('d_def', b.direct.def);
      setVal('d_dlo', b.direct.dmgLo); setVal('d_dhi', b.direct.dmgHi);
      setVal('d_hp', b.maxHealth);
    }
    if (b.mode) setMode(b.mode, true);
  }

  // Named setVal, not set: recompute() already owns a set(tr, key, ...) and two
  // function declarations in one scope silently clobber each other.
  function setVal(id, v) { var el = document.getElementById(id); if (el && v !== undefined) el.value = v; }

  // Switching to simple carries the detailed build's computed numbers across, so
  // the handoff shows the same character rather than a blank one.
  function setMode(mode, quiet) {
    var was = panel.getAttribute('data-mode') || 'detailed';
    if (mode === 'simple' && was !== 'simple' && !quiet) {
      var b = readForm(); b.mode = 'detailed';
      var r = resolve(b);
      setVal('d_off', C.playerOffense(b, r.weapon));
      setVal('d_def', C.playerDefense(b, r.weapon, r.worn));
      var d = C.playerDamage(b, r.weapon);
      setVal('d_dlo', d[0]); setVal('d_dhi', d[1]);
      setVal('d_hp', b.maxHealth);
    }
    panel.setAttribute('data-mode', mode);
    document.getElementById('gridSimple').hidden = (mode !== 'simple');
    document.getElementById('gridDetailed').hidden = (mode === 'simple');
    document.getElementById('modeSimple').classList.toggle('on', mode === 'simple');
    document.getElementById('modeDetailed').classList.toggle('on', mode !== 'simple');
    store(LS_MODE, mode);
  }

  function resolve(b) {
    var weapon = null, worn = [];
    for (var i = 0; i < DATA.weapons.length; i++) {
      if (DATA.weapons[i].cls === b.weapon) { weapon = DATA.weapons[i]; break; }
    }
    DATA.slots.forEach(function (s) {
      var want = b.gear && b.gear[s.key];
      if (!want) return;
      var list = DATA.armour[s.key] || [];
      for (var i = 0; i < list.length; i++) if (list[i].cls === want) { worn.push(list[i]); return; }
    });
    return { weapon: weapon, worn: worn };
  }

  // ------------------------------------------------------------- render

  function fmt(v) {
    if (!isFinite(v)) return '∞';
    return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  }

  function recompute() {
    var b = readForm();
    var r = resolve(b);
    var bySlug = {};
    DATA.beasts.forEach(function (x) { bySlug[x.slug] = x; });

    var eff = C.effective(b, r.weapon, r.worn);

    var sum = document.getElementById('refSummary');
    sum.innerHTML =
      '<span class="stat"><b>Offence</b> ' + eff.off + ' / 1000</span>' +
      '<span class="stat"><b>Defence</b> ' + eff.def + ' / 1000</span>' +
      '<span class="stat"><b>Damage</b> ' + eff.dmg[0] + '–' + eff.dmg[1] + ' per hit</span>' +
      '<span class="stat"><b>Health</b> ' + b.maxHealth + '</span>' +
      (eff.simple
        ? '<span class="stat muted">typed in directly — armour not modelled</span>'
        : '<span class="stat">' + (r.weapon ? r.weapon.name : 'unarmed') +
          (r.worn.length ? ', ' + r.worn.map(function (w) { return w.name; }).join(', ') : ', no armour') + '</span>');

    var rows = table.tBodies[0].rows;
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var beast = bySlug[tr.getAttribute('data-slug')];
      if (!beast) continue;
      var m = C.matchup(b, r.weapon, r.worn, beast, eff);
      set(tr, 'youhit', m.youHit + '%', m.youHit);
      set(tr, 'hitsyou', m.hitsYou + '%', m.hitsYou);
      set(tr, 'yourdmg', m.pDmg[0] + '–' + m.pDmg[1], m.pAvg);
      set(tr, 'dmgtoyou', fmt(m.mDmg[0]) + '–' + fmt(m.mDmg[1]), m.mAvg);
      set(tr, 'ttk', fmt(m.toKill), isFinite(m.toKill) ? m.toKill : 1e9);
      set(tr, 'tts', fmt(m.toDie), isFinite(m.toDie) ? m.toDie : 1e9);
      var v = m.verdict;
      set(tr, 'verdict', '<span class="verdict v-' + v.key + '">' + v.label + '</span>', m.margin, true);
    }
    flash();
  }

  function set(tr, key, text, sort, html) {
    var td = tr.querySelector('td[data-col="' + key + '"]');
    if (!td) return;
    if (html) td.innerHTML = text; else td.textContent = text;
    if (sort !== undefined) td.setAttribute('data-sort', sort);
  }

  // Inline status instead of a modal: alert() and prompt() block the page, and
  // this panel is edited constantly.
  var msgTimer = null;
  function say(text) {
    var el = document.getElementById('refMsg');
    if (!el) return;
    el.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  function flash() {
    table.classList.remove('recomputed');
    void table.offsetWidth;
    table.classList.add('recomputed');
  }

  // ------------------------------------------------------------- columns

  function colState() {
    var saved = load(LS_COLS, null);
    var keys = DATA.columns.map(function (c) { return c.key; });
    if (!saved || !saved.order) {
      return {
        order: keys.slice(),
        on: DATA.columns.reduce(function (a, c) { a[c.key] = !!c.def || !!c.fixed; return a; }, {}),
      };
    }
    // Tolerate columns added or removed since the layout was saved.
    var order = saved.order.filter(function (k) { return keys.indexOf(k) >= 0; });
    keys.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var on = {};
    DATA.columns.forEach(function (c) {
      on[c.key] = c.fixed ? true : (saved.on && saved.on.hasOwnProperty(c.key) ? !!saved.on[c.key] : !!c.def);
    });
    return { order: order, on: on };
  }

  function applyColumns(st) {
    var head = table.tHead.rows[0];
    // Reorder by moving cells into the configured order, then toggle hidden.
    function order(rowEl) {
      st.order.forEach(function (k) {
        var cell = rowEl.querySelector('[data-col="' + k + '"]');
        if (cell) rowEl.appendChild(cell);
      });
      Array.prototype.forEach.call(rowEl.children, function (cell) {
        var k = cell.getAttribute('data-col');
        if (st.on[k]) cell.removeAttribute('hidden'); else cell.setAttribute('hidden', '');
      });
    }
    order(head);
    Array.prototype.forEach.call(table.tBodies[0].rows, order);
    // The sort handler keys off column position, so refresh the indices.
    Array.prototype.forEach.call(head.cells, function (th, i) { th.setAttribute('data-col-index', i); });
    store(LS_COLS, st);
  }

  function buildColumnUI(st) {
    var ul = document.getElementById('colList');
    var labels = {};
    DATA.columns.forEach(function (c) { labels[c.key] = c; });
    ul.innerHTML = '';
    st.order.forEach(function (k, i) {
      var c = labels[k];
      if (!c) return;
      var li = document.createElement('li');
      li.setAttribute('data-col', k);
      var name = c.label || (c.key === 'i' ? 'Picture' : c.key);
      li.innerHTML =
        '<label><input type="checkbox"' + (st.on[k] ? ' checked' : '') +
        (c.fixed ? ' disabled' : '') + '> ' + name + '</label>' +
        '<span class="movers"><button type="button" class="mv" data-dir="-1" aria-label="Move up">↑</button>' +
        '<button type="button" class="mv" data-dir="1" aria-label="Move down">↓</button></span>' +
        (c.calc ? '<span class="tagmini">vs your build</span>' : '');
      ul.appendChild(li);
    });

    ul.onclick = function (e) {
      var btn = e.target.closest && e.target.closest('button.mv');
      if (!btn) return;
      var li = btn.closest('li');
      var k = li.getAttribute('data-col');
      var i = st.order.indexOf(k);
      var j = i + (+btn.getAttribute('data-dir'));
      if (j < 0 || j >= st.order.length) return;
      st.order.splice(i, 1);
      st.order.splice(j, 0, k);
      applyColumns(st);
      buildColumnUI(st);
    };
    ul.onchange = function (e) {
      if (e.target.type !== 'checkbox') return;
      var k = e.target.closest('li').getAttribute('data-col');
      st.on[k] = e.target.checked;
      applyColumns(st);
    };
  }

  // ------------------------------------------------------------- boot

  fetch(rel + '/creatures.json').then(function (r) { return r.json(); }).then(function (j) {
    DATA = j;

    var st = colState();
    applyColumns(st);
    buildColumnUI(st);
    document.getElementById('colReset').onclick = function () {
      try { localStorage.removeItem(LS_COLS); } catch (e) {}
      var fresh = colState();
      applyColumns(fresh);
      buildColumnUI(fresh);
    };

    refreshPresetSelect(load(LS_CURRENT, DATA.presets[2].id));
    var start = findBuild(document.getElementById('refPreset').value);
    writeForm(start);
    recompute();

    document.getElementById('refPreset').onchange = function () {
      var b = findBuild(this.value);
      writeForm(b);
      store(LS_CURRENT, this.value);
      recompute();
    };
    document.getElementById('refGo').onclick = recompute;

    document.getElementById('refReset').onclick = function () {
      var b = findBuild(document.getElementById('refPreset').value);
      writeForm(b);
      recompute();
    };

    document.getElementById('refClone').onclick = function () {
      var base = readForm();
      var src = findBuild(document.getElementById('refPreset').value);
      var field = document.getElementById('refName');
      var name = (field.value || '').trim() || (src.name + ' copy');
      field.value = '';
      var custom = load(LS_BUILDS, []);
      var b = clone(base);
      b.id = 'u' + Date.now();
      b.name = name;
      b.builtin = false;
      custom.push(b);
      store(LS_BUILDS, custom);
      refreshPresetSelect(b.id);
      store(LS_CURRENT, b.id);
      recompute();
      say('Saved “' + name + '”.');
    };

    document.getElementById('refSave').onclick = function () {
      var id = document.getElementById('refPreset').value;
      var custom = load(LS_BUILDS, []);
      var idx = -1;
      for (var i = 0; i < custom.length; i++) if (custom[i].id === id) idx = i;
      if (idx < 0) {
        say('Built-in presets cannot be overwritten — use “Save as new”.');
        return;
      }
      var b = readForm();
      b.id = id;
      b.name = custom[idx].name;
      b.builtin = false;
      custom[idx] = b;
      store(LS_BUILDS, custom);
      recompute();
      say('Updated “' + b.name + '”.');
    };

    document.getElementById('refDelete').onclick = function () {
      var id = document.getElementById('refPreset').value;
      var custom = load(LS_BUILDS, []);
      var next = custom.filter(function (b) { return b.id !== id; });
      if (next.length === custom.length) {
        say('That is a built-in preset and cannot be deleted.');
        return;
      }
      store(LS_BUILDS, next);
      refreshPresetSelect(DATA.presets[2].id);
      writeForm(findBuild(DATA.presets[2].id));
      store(LS_CURRENT, DATA.presets[2].id);
      recompute();
      say('Deleted.');
    };

    // ---- mode, pop-out and collapse
    document.getElementById('modeSimple').onclick = function () { setMode('simple'); recompute(); };
    document.getElementById('modeDetailed').onclick = function () { setMode('detailed'); recompute(); };
    setMode(load(LS_MODE, 'detailed'), true);

    var body = document.getElementById('refBody');
    var collapseBtn = document.getElementById('refCollapse');
    function setOpen(open) {
      body.hidden = !open;
      collapseBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      collapseBtn.innerHTML = open ? '&#9662;' : '&#9656;';
      store(LS_OPEN, open);
    }
    collapseBtn.onclick = function () { setOpen(body.hidden); };
    setOpen(load(LS_OPEN, true));

    var popBtn = document.getElementById('refPop');
    function setPop(on) {
      panel.classList.toggle('popped', on);
      popBtn.textContent = on ? 'Dock' : 'Pop out';
      popBtn.title = on ? 'Return the panel to its place on the page'
                        : 'Keep this panel on screen while you scroll';
      store(LS_POP, on);
      // Popped out, the panel covers the table it is meant to be read against,
      // so it starts collapsed the first time.
      if (on && !load(LS_OPEN + '-seen', false)) { setOpen(false); store(LS_OPEN + '-seen', true); }
    }
    popBtn.onclick = function () { setPop(!panel.classList.contains('popped')); };
    setPop(load(LS_POP, false));

    // Editing any field and leaving it recomputes, so the button is a
    // convenience rather than a requirement.
    panel.addEventListener('change', function (e) {
      if (e.target.id === 'refPreset') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') recompute();
    });
  }).catch(function (e) {
    var sum = document.getElementById('refSummary');
    if (sum) sum.textContent = 'Could not load creature data: ' + e.message;
  });
})();
