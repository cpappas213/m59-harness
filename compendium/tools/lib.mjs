// lib.mjs -- shared helpers for the compendium generator and every derive module.
//
// The single rule of this file: nothing in here invents a value.  Everything is
// read out of data/koddb.json (compiled from kod by tools/kodparse.mjs) or
// data/images.json (compiled from the .bgf sprites by tools/bgf.mjs).

import fs from 'node:fs';
import path from 'node:path';

export const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const ROOT = path.join(HERE, '..');
export const M59 = process.env.M59_ROOT || 'C:/code/Meridian59';

export function loadDB() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'koddb.json'), 'utf8'));
}
export function loadImages() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'images.json'), 'utf8'));
}

// ---------------------------------------------------------------- strings

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// Kod strings carry printf-ish escapes and the odd stray whitespace.
export function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function titleCase(s) {
  return String(s).replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ---------------------------------------------------------------- classes

export function cls(db, name) {
  return db.classes[String(name).toLowerCase()] || null;
}

// Every class whose inheritance chain contains `ancestor`, excluding the
// ancestor itself unless asked for.
export function descendants(db, ancestor, { includeSelf = false } = {}) {
  const a = String(ancestor).toLowerCase();
  return Object.values(db.classes).filter((c) => {
    const chain = c.chain.map((x) => x.toLowerCase());
    if (!chain.includes(a)) return false;
    if (!includeSelf && c.name.toLowerCase() === a) return false;
    return true;
  });
}

// Resolve a classvar (or property) by walking the inheritance chain.  Returns
// {name, expr, value, rsc, from} or null when nobody in the chain declares it.
export function inherited(db, c, varName, bag = 'classvars') {
  if (!c) return null;
  const want = varName.toLowerCase();
  for (const step of c.chain) {
    const k = cls(db, step);
    if (!k) continue;
    for (const [key, v] of Object.entries(k[bag])) {
      if (key.toLowerCase() === want) return { name: key, ...v, from: k.name, file: k.file };
    }
  }
  return null;
}

// Numeric value of a classvar, resolved through inheritance.  `null` when the
// class sets it to `$` (kod's nil) or when it is not a number.
export function ivar(db, c, varName) {
  const v = inherited(db, c, varName);
  if (!v) return null;
  if (v.expr === '$') return null;
  return v.value ?? null;
}

// A resource-valued classvar, resolved through inheritance AND through the
// declaring class's own resource table.
export function rvar(db, c, varName) {
  if (!c) return null;
  const want = varName.toLowerCase();
  for (const step of c.chain) {
    const k = cls(db, step);
    if (!k) continue;
    for (const [key, v] of Object.entries(k.classvars)) {
      if (key.toLowerCase() !== want) continue;
      if (v.expr === '$') return null;
      if (v.rsc) return { ...v.rsc, from: k.name, file: k.file, line: v.line };
      // The classvar may name a resource declared in a *different* class, or be
      // a literal.  Search the whole chain's resource tables for the name.
      for (const step2 of c.chain) {
        const k2 = cls(db, step2);
        const r = k2 && k2.resources[v.expr];
        if (r) return { ...r, from: k2.name, file: k2.file };
      }
      return null;
    }
  }
  return null;
}

// Object declares vrName = "something" as the universal fallback, so a class
// that never overrides it resolves to a name that is worse than no name at all.
// Treat that as unnamed and let the caller fall back to the class name.
export function nameOf(db, c) {
  const r = rvar(db, c, 'vrName');
  if (!r || r.kind !== 'string') return null;
  if (r.from === 'Object') return null;
  return cleanText(r.value);
}

// "AvarWarChief" -> "Avar War Chief".  Used only when the class has no name of
// its own; a class name is at least specific, which "something" is not.
export function humanize(className) {
  return String(className)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}
export function descOf(db, c) {
  const r = rvar(db, c, 'vrDesc');
  return r && r.kind === 'string' ? cleanText(r.value) : null;
}

// Find the message body for `msg` on class `c`, walking up the chain.
export function findMessage(db, c, msg) {
  const want = msg.toLowerCase();
  for (const step of c.chain) {
    const k = cls(db, step);
    if (!k) continue;
    const m = k.messages.find((x) => x.name.toLowerCase() === want);
    if (m) return { ...m, from: k.name, file: k.file };
  }
  return null;
}
// Only the class's own override, not an inherited one.
export function ownMessage(c, msg) {
  const want = msg.toLowerCase();
  return c.messages.find((x) => x.name.toLowerCase() === want) || null;
}

// ---------------------------------------------------------------- constants

// Reverse lookup: which constant names have this exact value, restricted to a
// prefix.  Used to turn `viAttack_type = 64` back into ATCK_WEAP_THRUST.
export function constNames(db, prefix, value) {
  const out = [];
  for (const [k, v] of Object.entries(db.constants)) {
    if (!k.startsWith(prefix)) continue;
    if (v.value === value) out.push(k);
  }
  return out;
}

// Decompose a bitmask into the prefix's single-bit constants that it contains.
export function flagNames(db, prefix, value) {
  if (!value) return [];
  const out = [];
  for (const [k, v] of Object.entries(db.constants)) {
    if (!k.startsWith(prefix)) continue;
    const n = v.value;
    if (!n || n <= 0) continue;
    if ((n & (n - 1)) !== 0) continue;   // not a single bit
    if ((value & n) === n) out.push({ name: k, bit: n });
  }
  out.sort((a, b) => a.bit - b.bit);
  return out;
}

// blakston.khd annotates most flag constants with a trailing comment that says
// what the flag does — "MOB_NOAGRESS  = 0x02000  % Won't attack until molested".
// That is the best one-line description of the flag in existence, so lift it.
let _constComments = null;
export function constComment(name) {
  if (!_constComments) {
    _constComments = new Map();
    for (const f of ['blakston.khd', 'protocol.khd']) {
      const p = path.join(M59, 'kod', 'include', f);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'latin1').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^%]*%\s*(.+?)\s*$/.exec(line);
        if (m && m[2]) _constComments.set(m[1].toUpperCase(), m[2]);
      }
    }
  }
  return _constComments.get(String(name).toUpperCase()) || null;
}

export function constValue(db, name) {
  const c = db.constants[name.toUpperCase()];
  return c ? c.value : null;
}

// ---------------------------------------------------------------- kod bits

// Parse a kod list-of-pairs literal out of a message body, e.g.
//   return [ [ATCK_WEAP_THRUST,5], [ATCK_WEAP_SLASH,20] ];
// Returns [{a:'ATCK_WEAP_THRUST', b:5}, ...] with names left as written.
export function parsePairList(body) {
  if (!body) return [];
  const out = [];
  for (const m of body.matchAll(/\[\s*([A-Za-z_][\w]*|-?\d+)\s*,\s*(-?\d+)\s*\]/g)) {
    out.push({ a: m[1], b: parseInt(m[2], 10) });
  }
  return out;
}

// Parse Cons([&Class, n], Cons([&Class, n], $)) reagent lists.
export function parseConsPairs(body) {
  if (!body) return [];
  const out = [];
  for (const m of body.matchAll(/\[\s*&(\w+)\s*,\s*(-?\d+)\s*\]/g)) {
    out.push({ cls: m[1], count: parseInt(m[2], 10) });
  }
  return out;
}

// ---------------------------------------------------------------- images

// The picture for a class: its vrIcon resource -> "foo.bgf" -> assets/img/foo_gN.png
export function iconFor(db, images, c, { group = null, varName = 'vrIcon' } = {}) {
  const r = rvar(db, c, varName);
  if (!r || r.kind !== 'file') return null;
  const stem = r.value.replace(/\.bgf$/i, '').toLowerCase();
  const rec = images[stem];
  if (!rec) return null;
  let g = group;
  if (g == null) {
    const inv = ivar(db, c, 'viInventory_group');
    g = inv && rec.groups[inv] ? inv : null;
  }
  if (g == null || !rec.groups[g]) g = Object.keys(rec.groups)[0];
  const info = rec.groups[g];
  if (!info) return null;
  return { src: `../assets/img/${info.file}`, w: info.w, h: info.h, stem, group: Number(g), shrink: rec.shrink, rec };
}

// Every distinct group of a class's sprite, for a small gallery.
export function spriteGroups(db, images, c, varName = 'vrIcon') {
  const r = rvar(db, c, varName);
  if (!r || r.kind !== 'file') return [];
  const stem = r.value.replace(/\.bgf$/i, '').toLowerCase();
  const rec = images[stem];
  if (!rec) return [];
  return Object.entries(rec.groups).map(([g, info]) => ({
    group: Number(g), src: `../assets/img/${info.file}`, w: info.w, h: info.h, angles: info.angles, stem,
  }));
}

// ---------------------------------------------------------------- html bits

export function citeLine(file, line) {
  return `<p class="cite">${esc(file)}${line ? ':' + line : ''}</p>`;
}

export function factGrid(pairs) {
  const cells = pairs.filter(Boolean).map(([lbl, val, small]) =>
    `<div class="fact"><div class="lbl">${esc(lbl)}</div><div class="val${small ? ' sm' : ''}">${val}</div></div>`);
  return cells.length ? `<div class="facts">${cells.join('')}</div>` : '';
}

// columns: [{key, label, num?, cls?, sort?}]  rows: [{...}] where each cell is
// already-escaped HTML in row[key] and row['_'+key] is the sort key if present.
export function dataTable(columns, rows, { id = null, sortable = true } = {}) {
  const th = columns.map((c, i) =>
    `<th class="${c.num ? 'num ' : ''}${sortable ? 'sortable' : ''}"${sortable ? ` data-col="${i}"` : ''}>${esc(c.label)}</th>`).join('');
  const tb = rows.map((r) => `<tr${r._attrs || ''}>` + columns.map((c) => {
    const sort = r['_' + c.key];
    return `<td class="${c.num ? 'num ' : ''}${c.cls || ''}"${sort !== undefined ? ` data-sort="${esc(sort)}"` : ''}>${r[c.key] ?? ''}</td>`;
  }).join('') + '</tr>').join('\n');
  return `<div class="tablewrap"><table class="data"${id ? ` id="${id}"` : ''}>
<thead><tr>${th}</tr></thead>
<tbody>${tb}</tbody></table></div>`;
}

export function tagList(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="tags">${tags.map((t) =>
    t.href ? `<a class="tag ${t.cls || ''}" href="${t.href}">${esc(t.text)}</a>`
           : `<span class="tag ${t.cls || ''}">${esc(t.text)}</span>`).join('')}</div>`;
}

export function iconImg(icon, alt, maxSide = 96) {
  if (!icon) return '';
  return `<img class="icon" src="${icon.src}" alt="${esc(alt)}" width="${icon.w}" height="${icon.h}" loading="lazy">`;
}

// The big picture at the top of an entity page.  These are pixel sprites of wildly
// different sizes — a spell icon is 16x16, a monster is 140x84 — so scale by a whole
// number until the longest side is near `target`.  Whole numbers only: a fractional
// scale on nearest-neighbour art produces uneven pixels.
export function heroImg(icon, alt, target = 128) {
  if (!icon) return '';
  const longest = Math.max(icon.w, icon.h);
  const scale = Math.max(1, Math.min(8, Math.floor(target / longest) || 1));
  return `<img class="icon" src="${icon.src}" alt="${esc(alt)}" width="${icon.w * scale}" height="${icon.h * scale}">`;
}

// A page's picture block: the portrait tile plus title, lede and tags beside it.
export function heroBlock({ icon, alt, title, lede, tags }) {
  let h = '<div class="hero">';
  if (icon) h += `<div class="portrait">${heroImg(icon, alt || title)}</div>`;
  h += `<div class="heroText"><h1>${esc(title)}</h1>`;
  if (lede) h += `<p class="lede">${lede}</p>`;
  if (tags && tags.length) h += tagList(tags);
  return h + '</div></div>';
}

export function num(v) { return v === null || v === undefined ? '<span class="muted">—</span>' : String(v); }

// The completeness backstop: every entity page ends with the class's own kod, so
// a reader who doubts a derived number can check it without leaving the page.
export function kodSource(db, c, { maxLines = 400 } = {}) {
  const parts = [];
  parts.push(`<h2>In the source</h2>`);
  parts.push(`<p class="cite">${esc(c.file)}:${c.classLine}</p>`);
  parts.push(`<p><code class="k">${esc(c.name)}</code> is <code class="k">${esc(c.parent || '—')}</code>` +
    (c.chain.length > 2 ? ` — full chain ${c.chain.map((x) => `<code class="k">${esc(x)}</code>`).join(' ← ')}` : '') +
    (c.children.length ? `. Subclasses: ${c.children.map((x) => `<code class="k">${esc(x)}</code>`).join(', ')}` : '') + '.</p>');

  const cv = Object.entries(c.classvars);
  if (cv.length) {
    parts.push(`<h3>Class variables declared here</h3>`);
    parts.push(dataTable(
      [{ key: 'v', label: 'Variable' }, { key: 'e', label: 'Value' }, { key: 'r', label: 'Resolves to' }, { key: 'l', label: 'Line', num: true }],
      cv.map(([k, v]) => ({
        v: `<code class="k">${esc(k)}</code>`,
        e: `<code>${esc(v.expr)}</code>`,
        r: v.rsc ? `<em>${esc(String(v.rsc.value).slice(0, 90))}</em>` : (v.value !== null && String(v.value) !== v.expr ? String(v.value) : '<span class="muted">—</span>'),
        l: String(v.line), _l: v.line,
      })), { sortable: false }));
  }
  const props = Object.entries(c.properties);
  if (props.length) {
    parts.push(`<h3>Properties declared here</h3>`);
    parts.push(dataTable(
      [{ key: 'v', label: 'Property' }, { key: 'e', label: 'Initial value' }, { key: 'l', label: 'Line', num: true }],
      props.map(([k, v]) => ({
        v: `<code class="k">${esc(k)}</code>`, e: `<code>${esc(v.expr || '—')}</code>`,
        l: String(v.line), _l: v.line,
      })), { sortable: false }));
  }
  if (c.messages.length) {
    parts.push(`<h3>Behaviour overridden here</h3>`);
    for (const m of c.messages) {
      const sig = `${m.name}(${m.params.map((p) => p.def !== null ? `${p.name} = ${p.def}` : p.name).join(', ')})`;
      const body = m.body.split('\n').length > maxLines
        ? m.body.split('\n').slice(0, maxLines).join('\n') + '\n   % … truncated, see source'
        : m.body;
      parts.push(`<h4>${esc(sig)}</h4>`);
      if (m.doc) parts.push(`<p>${esc(m.doc)}</p>`);
      parts.push(`<pre><code>${esc(body)}</code></pre>`);
      parts.push(`<p class="cite">${esc(c.file)}:${m.line}</p>`);
    }
  }
  return parts.join('\n');
}
