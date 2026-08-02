#!/usr/bin/env node
// lint.mjs -- check the built site for the mistakes that actually happen here.
//
//   node tools/lint.mjs            report everything
//   node tools/lint.mjs --links    only broken links and images
//   node tools/lint.mjs --cites    only citations that do not resolve
//
// Three classes of problem, in descending order of how much they matter:
//
//   1. a citation that points at a file or line that does not exist — the site's
//      whole claim is that you can check it, so a bad citation is a lie
//   2. a link or image that 404s
//   3. fragment hygiene: two <h1>s, a stray <script>, an inline style

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, M59 } from './lib.mjs';

const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes('--' + k);

const problems = { cites: [], links: [], images: [], html: [] };

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'assets', 'data', 'tools', 'content'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

// -------------------------------------------------------------- citations

const lineCounts = new Map();
function fileLines(rel) {
  if (lineCounts.has(rel)) return lineCounts.get(rel);
  const f = path.join(M59, rel);
  let n = -1;
  try { n = fs.readFileSync(f, 'latin1').split(/\r?\n/).length; } catch { n = -1; }
  lineCounts.set(rel, n);
  return n;
}

// Matches the shapes that actually appear: "kod/a/b.kod:123", "kod/a/b.kod:123-140",
// "clientd3d/foo.c:99".  Bare ":1256" back-references (":1256 PayCosts") are skipped
// because they inherit the file from earlier in the sentence.
const CITE = /\b((?:kod|clientd3d|blakserv|include|util|resource|doc|module|lib)\/[A-Za-z0-9_./-]+\.(?:kod|khd|c|h|txt|cpp))(?::(\d+)(?:\s*[-–]\s*(\d+))?)?/g;

function checkCites(file, html) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const seen = new Set();
  for (const m of html.matchAll(CITE)) {
    const src = m[1];
    const line = m[2] ? parseInt(m[2], 10) : null;
    const key = src + ':' + (line ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    const n = fileLines(src);
    if (n < 0) { problems.cites.push(`${rel}: no such source file  ${src}`); continue; }
    if (line !== null && line > n) {
      problems.cites.push(`${rel}: ${src}:${line} — file has only ${n} lines`);
    }
    if (m[3] && parseInt(m[3], 10) > n) {
      problems.cites.push(`${rel}: ${src}:${m[2]}-${m[3]} — file has only ${n} lines`);
    }
  }
}

// ------------------------------------------------------------------ links

function checkLinks(file, html) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const dir = path.dirname(file);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = path.join(dir, href.split('#')[0]);
    if (!fs.existsSync(target)) problems.links.push(`${rel} -> ${href}`);
  }
  for (const m of html.matchAll(/<img\b[^>]*src="([^"]*)"/g)) {
    const src = m[1];
    if (/^(https?:|data:)/.test(src)) continue;
    if (!fs.existsSync(path.join(dir, src))) problems.images.push(`${rel} -> ${src}`);
  }
}

// ------------------------------------------------------------------ html

function checkFragment(file, html) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const body = /<main[^>]*>([\s\S]*)<\/main>/.exec(html);
  const frag = body ? body[1] : html;
  const h1s = (frag.match(/<h1\b/g) || []).length;
  if (h1s !== 1) problems.html.push(`${rel}: ${h1s} <h1> elements (want exactly 1)`);
  if (/<script\b/i.test(frag)) problems.html.push(`${rel}: <script> inside the page body`);
  if (/<style\b/i.test(frag)) problems.html.push(`${rel}: <style> inside the page body`);
  if (/\bstyle="/i.test(frag)) problems.html.push(`${rel}: inline style attribute`);
  if (/<(html|head|body)\b/i.test(frag)) problems.html.push(`${rel}: nested document tags`);
  // unclosed tag heuristics that have actually bitten: table/div balance
  for (const tag of ['table', 'div', 'tbody', 'thead', 'tr']) {
    const open = (frag.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const close = (frag.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) problems.html.push(`${rel}: <${tag}> ${open} open vs ${close} close`);
  }
}

// ----------------------------------------------------------------- driver

const files = walk(ROOT);
// content/ fragments are checked too — they are the source of the guides.
const fragments = fs.existsSync(path.join(ROOT, 'content'))
  ? fs.readdirSync(path.join(ROOT, 'content')).filter((f) => f.endsWith('.html'))
    .map((f) => path.join(ROOT, 'content', f)) : [];

for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  if (want('cites')) checkCites(f, html);
  if (want('links')) checkLinks(f, html);
  if (want('html')) checkFragment(f, html);
}
for (const f of fragments) {
  if (!want('cites')) continue;
  checkCites(f, fs.readFileSync(f, 'utf8'));
}

let total = 0;
for (const [k, list] of Object.entries(problems)) {
  if (!list.length) continue;
  total += list.length;
  console.log(`\n${k}: ${list.length}`);
  const shown = k === 'links' || k === 'images' ? 60 : 200;
  for (const p of list.slice(0, shown)) console.log('  ' + p);
  if (list.length > shown) console.log(`  … and ${list.length - shown} more`);
}
console.log(`\n${files.length} pages checked, ${total} problems`);
process.exitCode = total ? 1 : 0;
