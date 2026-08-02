#!/usr/bin/env node
// kodparse.mjs -- compile every .kod file in the Meridian 59 tree into one JSON
// database.  Everything downstream (the compendium generator, the derived-stat
// tables, the cross-references) reads this file and never the source again.
//
//   node tools/kodparse.mjs            write data/koddb.json
//
// The grammar is small.  A class file is:
//
//   ClassName is ParentName        (root class "Object" has no "is")
//   constants:   NAME = expr  |  include blakston.khd
//   resources:   name = "string"  |  name = file.bgf  |  name = file.ogg
//   classvars:   vrName = res     |  viValue_average = 800
//   properties:  piHits = 0
//   messages:    MsgName(a = $, b = 0)  "doc"  { body }
//   end
//
// '%' starts a comment to end of line, except inside a string literal.  A line
// ending in '\' continues onto the next.  Resource strings are written as a run
// of adjacent literals that concatenate.

import fs from 'node:fs';
import path from 'node:path';

const M59 = process.env.M59_ROOT || 'C:/code/Meridian59';
const KOD = path.join(M59, 'kod');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, '..', 'data', 'koddb.json');

// ---------------------------------------------------------------- lexing

// Strip a '%' comment without eating a '%' that lives inside a string.
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === '%' && !inStr) return line.slice(0, i);
  }
  return line;
}

// Join backslash-continued lines, remembering the 1-based line number each
// logical line started on.
function logicalLines(text) {
  const raw = text.split(/\r?\n/);
  const out = [];
  let buf = null, startLine = 0;
  for (let i = 0; i < raw.length; i++) {
    let line = stripComment(raw[i]);
    const cont = /\\\s*$/.test(line);
    if (cont) line = line.replace(/\\\s*$/, '');
    if (buf === null) { buf = line; startLine = i + 1; }
    else buf += ' ' + line.trim();
    if (!cont) { out.push({ line: buf, n: startLine, raw: raw[i] }); buf = null; }
  }
  if (buf !== null) out.push({ line: buf, n: startLine, raw: '' });
  return out;
}

// A resource value is either a run of "..." literals (concatenated) or a bare
// token, which in practice is always a filename: a sprite, a sound, or the
// .roo map file a room draws itself from.
function parseResourceValue(rhs) {
  const strs = [...rhs.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (strs.length) {
    return { kind: 'string', value: strs.join('').replace(/\\n/g, '\n').replace(/\\"/g, '"') };
  }
  const tok = rhs.trim();
  if (/\.(bgf|ogg|wav|mid|roo|bmp|bbg)$/i.test(tok)) return { kind: 'file', value: tok };
  return { kind: 'raw', value: tok };
}

// ---------------------------------------------------------------- constants

// blakston.khd and protocol.khd are flat "NAME = expr" tables.  Values can be
// decimal, hex, or arithmetic over previously-defined names.
function parseConstantFile(file) {
  const out = new Map();
  for (const { line } of logicalLines(fs.readFileSync(file, 'latin1'))) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.set(m[1].toUpperCase(), m[2]);
  }
  return out;
}

// Evaluate a kod constant expression against a name table.  Returns a number,
// or null when the expression mentions something we cannot resolve.
function evalConst(expr, table, depth = 0) {
  if (expr == null || depth > 12) return null;
  let e = String(expr).trim();
  if (!e) return null;
  if (/^-?\d+$/.test(e)) return parseInt(e, 10);
  if (/^0x[0-9a-f]+$/i.test(e)) return parseInt(e, 16);

  // substitute identifiers
  let bad = false;
  const sub = e.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
    const v = table.get(id.toUpperCase());
    if (v === undefined) { bad = true; return id; }
    const n = evalConst(v, table, depth + 1);
    if (n === null) { bad = true; return id; }
    return `(${n})`;
  });
  if (bad) return null;
  if (!/^[\s0-9()+\-*/|&^~x a-fA-F]*$/.test(sub)) return null;
  try {
    // kod's operators are C's; '|' and '&' are bitwise, division truncates.
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${sub.replace(/0x[0-9a-fA-F]+/g, (h) => parseInt(h, 16))})`)();
    return Number.isFinite(v) ? Math.trunc(v) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- class file

const SECTIONS = new Set(['constants', 'resources', 'classvars', 'properties', 'messages']);

function parseClassFile(file, relFile) {
  const text = fs.readFileSync(file, 'latin1');
  const lines = logicalLines(text);
  const rawLines = text.split(/\r?\n/);

  const cls = {
    file: relFile,
    name: null, parent: null, classLine: 0,
    constants: {}, resources: {}, classvars: {}, properties: {}, messages: [],
    includes: [],
  };

  let section = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const { line, n } = lines[i];
    const t = line.trim();
    if (!t) continue;

    const sec = /^([A-Za-z]+)\s*:\s*$/.exec(t);
    if (sec && SECTIONS.has(sec[1].toLowerCase())) { section = sec[1].toLowerCase(); continue; }
    if (/^end\s*$/i.test(t)) break;

    if (!cls.name) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(t);
      if (m) { cls.name = m[1]; cls.parent = m[2]; cls.classLine = n; continue; }
      const m2 = /^([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(t);
      if (m2 && !SECTIONS.has(m2[1].toLowerCase())) { cls.name = m2[1]; cls.classLine = n; continue; }
      continue;
    }

    if (section === 'constants') {
      const inc = /^include\s+(\S+)/i.exec(t);
      if (inc) { cls.includes.push(inc[1]); continue; }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(t);
      if (m) cls.constants[m[1]] = m[2];
      continue;
    }
    if (section === 'resources') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(t);
      if (m) {
        // Adjacent string literals concatenate, and they may sit on following
        // lines with no continuation marker at all.  Absorb every following
        // line that is nothing but string literals.
        let rhs = m[2];
        while (i + 1 < lines.length) {
          const nxt = lines[i + 1].line.trim();
          if (!nxt || !/^"/.test(nxt) || !/^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(nxt)) break;
          rhs += ' ' + nxt;
          i++;
        }
        cls.resources[m[1]] = { ...parseResourceValue(rhs), line: n };
      }
      continue;
    }
    if (section === 'classvars' || section === 'properties') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(t);
      if (m) cls[section][m[1]] = { expr: m[2], line: n };
      else {
        const bare = /^([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(t);
        if (bare) cls[section][bare[1]] = { expr: '', line: n };
      }
      continue;
    }
    if (section === 'messages') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)$/.exec(t);
      if (!m) continue;
      // Collect the signature (may span logical lines) then the { } body.
      let sig = m[2];
      let j = i;
      let depth = (sig.match(/\(/g) || []).length - (sig.match(/\)/g) || []).length;
      while (depth >= 0 && !/\)/.test(sig.slice(-1)) && j + 1 < lines.length && !sig.includes(')')) {
        j++; sig += ' ' + lines[j].line.trim();
      }
      // Body: scan raw source from this line for the first '{' and its match.
      const body = extractBody(rawLines, lines[j].n - 1);
      cls.messages.push({
        name: m[1],
        params: parseParams(sig),
        line: lines[i].n,
        endLine: body.endLine,
        doc: body.doc,
        body: body.text,
      });
      // Advance past the body.
      while (i < lines.length - 1 && lines[i].n < body.endLine) i++;
      continue;
    }
  }
  return cls.name ? cls : null;
}

function parseParams(sig) {
  const inner = sig.slice(0, sig.lastIndexOf(')') >= 0 ? sig.lastIndexOf(')') : sig.length);
  return inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(.+))?$/.exec(s);
    return m ? { name: m[1], def: m[2] ?? null } : { name: s, def: null };
  });
}

// Walk raw source from `from` (0-based) to the message's closing brace.  Also
// collects the doc-string literals that sit between the signature and the '{'.
function extractBody(rawLines, from) {
  let doc = [];
  let started = false, depth = 0, out = [];
  for (let k = from; k < rawLines.length; k++) {
    const line = rawLines[k];
    const clean = stripComment(line);
    if (!started) {
      for (const m of clean.matchAll(/"((?:[^"\\]|\\.)*)"/g)) doc.push(m[1]);
      const bi = clean.indexOf('{');
      if (bi < 0) continue;
      started = true;
      out.push(clean.slice(bi));
      depth = countBraces(clean.slice(bi));
      if (depth === 0) return { text: out.join('\n'), doc: doc.join(''), endLine: k + 1 };
      continue;
    }
    out.push(clean);
    depth += countBraces(clean);
    if (depth <= 0) return { text: out.join('\n'), doc: doc.join(''), endLine: k + 1 };
  }
  return { text: out.join('\n'), doc: doc.join(''), endLine: rawLines.length };
}

function countBraces(s) {
  let inStr = false, d = 0;
  for (const c of s) {
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === '{') d++;
    else if (!inStr && c === '}') d--;
  }
  return d;
}

// ---------------------------------------------------------------- driver

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.toLowerCase().endsWith('.kod')) acc.push(p);
  }
  return acc;
}

const globals = new Map();
for (const khd of ['blakston.khd', 'protocol.khd']) {
  const f = path.join(KOD, 'include', khd);
  if (fs.existsSync(f)) for (const [k, v] of parseConstantFile(f)) if (!globals.has(k)) globals.set(k, v);
}

const files = walk(KOD);
const classes = {};
const byName = {};
const problems = [];

for (const f of files) {
  const rel = path.relative(M59, f).replace(/\\/g, '/');
  let c;
  try { c = parseClassFile(f, rel); } catch (err) { problems.push(`${rel}: ${err.message}`); continue; }
  if (!c) { problems.push(`${rel}: no class header`); continue; }
  const key = c.name.toLowerCase();
  if (classes[key]) problems.push(`${rel}: duplicate class ${c.name} (also ${classes[key].file})`);
  classes[key] = c;
  byName[c.name] = key;
}

// Resolve each class's own constants on top of the globals, then evaluate every
// classvar / property to a number where it is one.
for (const key of Object.keys(classes)) {
  const c = classes[key];
  const table = new Map(globals);
  for (const [k, v] of Object.entries(c.constants)) table.set(k.toUpperCase(), v);
  for (const bag of ['classvars', 'properties']) {
    for (const [k, v] of Object.entries(c[bag])) {
      v.value = evalConst(v.expr, table);
      // A classvar naming a resource resolves through the resource table.
      if (v.value === null && c.resources[v.expr]) v.rsc = c.resources[v.expr];
    }
  }
}

// Inheritance chain, and inherited-value lookup helpers baked into the JSON so
// the generator does not have to re-derive them.
function chainOf(key, seen = new Set()) {
  const out = [];
  let k = key;
  while (k && classes[k] && !seen.has(k)) {
    seen.add(k); out.push(classes[k].name);
    const p = classes[k].parent;
    k = p ? p.toLowerCase() : null;
  }
  return out;
}
for (const key of Object.keys(classes)) classes[key].chain = chainOf(key);

// Children index.
for (const key of Object.keys(classes)) classes[key].children = [];
for (const key of Object.keys(classes)) {
  const p = classes[key].parent?.toLowerCase();
  if (p && classes[p]) classes[p].children.push(classes[key].name);
}

const constants = {};
for (const [k, v] of globals) {
  const n = evalConst(v, globals);
  constants[k] = { expr: v, value: n };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  builtFrom: M59,
  classCount: Object.keys(classes).length,
  constants,
  classes,
  problems,
}, null, 1));

console.log(`classes: ${Object.keys(classes).length}`);
console.log(`constants: ${Object.keys(constants).length}`);
console.log(`problems: ${problems.length}`);
for (const p of problems.slice(0, 20)) console.log('  ' + p);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
