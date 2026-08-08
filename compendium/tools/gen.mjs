#!/usr/bin/env node
// gen.mjs -- assemble the compendium.
//
//   node tools/kodparse.mjs && node tools/bgf.mjs all && node tools/gen.mjs
//
// Two kinds of page exist.
//
//   guides/   hand-written prose fragments from content/*.html, wrapped in the
//             site shell.  These are the "how does X work" pages.
//   <cat>/    machine-built entity pages.  Each category is a module in
//             tools/derive/ that turns koddb.json into an index table and one
//             page per entity.  See tools/derive/README.md for the contract.

import fs from 'node:fs';
import path from 'node:path';
import * as lib from './lib.mjs';
import { ROOT, esc, slugify } from './lib.mjs';

const OUT = ROOT;

// Guides in the order a reader should meet them.  Anything in content/ that is
// not listed here still gets built; it just lands at the end of its section.
const GUIDE_ORDER = [
  ['Start here', ['advancing', 'attributes', 'vigor', 'combat']],
  ['Fighting', ['weapons', 'armor', 'health-regeneration', 'death', 'bestiary-overview']],
  ['Magic', ['spells', 'schools', 'channeling', 'enchantments',
             'shalille', 'qor', 'kraanan', 'faren', 'riija', 'jala']],
  ['Skills and gear', ['skills-overview', 'items', 'economy']],
  ['The world', ['lore', 'karma', 'factions', 'duke', 'guilds', 'quests', 'places']],
];

// ---------------------------------------------------------------- shell

function shell({ title, body, rel = '..', nav, active, wide = false, crumbs = '', desc = '',
                 scripts = [], styles = [] }) {
  const navHtml = nav.map((n) =>
    `<a href="${rel}/${n.href}"${n.id === active ? ' class="on"' : ''}>${esc(n.title)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Meridian 59 Compendium</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
<link rel="stylesheet" href="${rel}/assets/style.css">
${styles.map((s2) => `<link rel="stylesheet" href="${rel}/assets/${s2}">`).join('')}
<script>(function(){try{var t=localStorage.getItem('m59-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="${rel}/index.html">Meridian&nbsp;<span>59</span> Compendium</a>
  <nav>${navHtml}</nav>
  <input id="q" type="search" placeholder="Search everything…" autocomplete="off" spellcheck="false">
  <button class="theme-toggle" id="themeToggle" title="Toggle light/dark">◐</button>
  <div id="results"></div>
</header>
<main${wide ? ' class="wide"' : ''}>
${crumbs ? `<p class="crumbs">${crumbs}</p>` : ''}
${body}
</main>
<footer class="sitefoot">
Every number on this site is compiled from the Meridian 59 server source in
<code>kod/</code> and the client sprites in <code>run/localclient/resource</code>.
Citations are <code>file:line</code> in that tree. Sprites are the game's own bitmaps,
decoded from <code>.bgf</code>. Where a page states a formula, it is the formula the
server actually runs — not a community estimate.
</footer>
<script>window.M59_REL=${JSON.stringify(rel)};</script>
<script src="${rel}/assets/site.js"></script>
${scripts.map((s2) => `<script src="${rel}/assets/${s2}"></script>`).join('')}
</body>
</html>`;
}

// ---------------------------------------------------------------- guides

function readGuides() {
  const dir = path.join(ROOT, 'content');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => {
    const slug = f.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const lede = /<p class="lede"[^>]*>([\s\S]*?)<\/p>/i.exec(html);
    // The blurb is re-escaped when it lands in a card, so any entity in the
    // source has to be decoded here or it renders as literal "&mdash;".
    const plain = (s) => s.replace(/<[^>]+>/g, '')
      .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, '’').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    return {
      slug, html,
      title: h1 ? plain(h1[1]) : lib.titleCase(slug.replace(/-/g, ' ')),
      blurb: lede ? plain(lede[1]) : '',
    };
  });
}

// Cut to a word boundary rather than mid-word, and say so with an ellipsis.
function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

// ---------------------------------------------------------------- driver

async function main() {
  const db = lib.loadDB();
  const images = lib.loadImages();

  // Load every derive module.
  const deriveDir = path.join(ROOT, 'tools', 'derive');
  const mods = [];
  if (fs.existsSync(deriveDir)) {
    for (const f of fs.readdirSync(deriveDir).filter((x) => x.endsWith('.mjs'))) {
      const url = 'file:///' + path.join(deriveDir, f).replace(/\\/g, '/');
      try {
        const m = await import(url);
        if (m.meta && typeof m.build === 'function') mods.push(m);
        else console.warn(`  derive/${f}: no meta+build export, skipped`);
      } catch (e) {
        console.error(`  derive/${f}: ${e.message}`);
      }
    }
  }
  mods.sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99));

  const guides = readGuides();

  const nav = [
    { id: 'home', title: 'Home', href: 'index.html' },
    { id: 'guides', title: 'Guides', href: 'guides/index.html' },
    ...mods.filter((m) => m.meta.nav !== false)
      .map((m) => ({ id: m.meta.id, title: m.meta.title, href: `${m.meta.dir}/index.html` })),
  ];

  const search = [];
  // Pages are collected first and written last, so the link-repair pass below
  // can see the whole site.  Guide fragments are written by hand and by other
  // agents, who cannot know which directory owns which entity; repairing the
  // links centrally is cheaper and more reliable than coordinating.
  const built = new Map();
  const write = (rel, html) => built.set(rel.replace(/\\/g, '/'), html);

  // ---- guides
  for (const g of guides) {
    write(`guides/${g.slug}.html`, shell({
      title: g.title, active: 'guides', nav, desc: g.blurb,
      crumbs: `<a href="../index.html">Home</a> › <a href="index.html">Guides</a> › ${esc(g.title)}`,
      body: g.html,
    }));
    search.push({ n: g.title, u: `guides/${g.slug}.html`, k: 'guide', d: g.blurb.slice(0, 120) });
  }

  {
    const bySlug = new Map(guides.map((g) => [g.slug, g]));
    const used = new Set();
    let body = `<h1>Guides</h1>
<p class="lede">How the game works, with the server's own formulas. Every quantity on these
pages is cited to the line of Blakod that enforces it.</p>`;
    for (const [section, slugs] of GUIDE_ORDER) {
      const have = slugs.filter((s) => bySlug.has(s));
      if (!have.length) continue;
      body += `\n<h2>${esc(section)}</h2>\n<div class="cards">`;
      for (const s of have) {
        used.add(s);
        const g = bySlug.get(s);
        body += `<a class="card" href="${s}.html"><div class="t">${esc(g.title)}</div><div class="d">${esc(clip(g.blurb, 150))}</div></a>`;
      }
      body += `</div>`;
    }
    const rest = guides.filter((g) => !used.has(g.slug));
    if (rest.length) {
      body += `\n<h2>More</h2>\n<div class="cards">`;
      for (const g of rest) body += `<a class="card" href="${g.slug}.html"><div class="t">${esc(g.title)}</div><div class="d">${esc(clip(g.blurb, 150))}</div></a>`;
      body += `</div>`;
    }
    write('guides/index.html', shell({
      title: 'Guides', active: 'guides', nav,
      crumbs: `<a href="../index.html">Home</a> › Guides`, body,
    }));
  }

  // ---- categories
  const catSummary = [];
  for (const m of mods) {
    const { meta } = m;
    let out;
    try {
      out = m.build({ db, images, lib });
    } catch (e) {
      console.error(`  derive/${meta.id}: build failed — ${e.stack}`);
      continue;
    }
    const dir = meta.dir;
    for (const p of out.pages || []) {
      write(`${dir}/${p.slug}.html`, shell({
        title: p.title, active: meta.id, nav, desc: p.desc || '',
        crumbs: `<a href="../index.html">Home</a> › <a href="index.html">${esc(meta.title)}</a> › ${esc(p.title)}`,
        body: p.html,
      }));
      search.push({
        n: p.title, u: `${dir}/${p.slug}.html`, k: p.kind || meta.id,
        d: (p.desc || '').slice(0, 120), i: p.icon || null,
      });
    }
    // A module may ship data the page's client-side code needs.  These are
    // written verbatim next to the pages, and are the only files a module is
    // allowed to add.
    for (const [rel, content] of Object.entries(out.files || {})) {
      const f = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    write(`${dir}/index.html`, shell({
      title: meta.title, active: meta.id, nav, wide: true, desc: meta.blurb,
      scripts: out.scripts || [], styles: out.styles || [],
      crumbs: `<a href="../index.html">Home</a> › ${esc(meta.title)}`,
      body: out.indexHtml,
    }));
    catSummary.push({ meta, count: (out.pages || []).length });
    console.log(`  ${meta.id}: ${(out.pages || []).length} pages`);
  }

  // ---- home
  {
    // Some categories are a comparison view over pages another module owns, so
    // "0 pages" would be a lie about emptiness rather than a fact about size.
    const cards = catSummary.map((c) =>
      `<a class="card" href="${c.meta.dir}/index.html"><div class="t">${esc(c.meta.title)}</div>` +
      `<div class="d">${esc(c.meta.blurb || '')}</div>` +
      `<div class="n">${c.count ? `${c.count} pages` : 'comparison table'}</div></a>`).join('');
    const guideCards = guides.slice(0, 8).map((g) =>
      `<a class="card" href="guides/${g.slug}.html"><div class="t">${esc(g.title)}</div><div class="d">${esc(clip(g.blurb, 130))}</div></a>`).join('');
    const body = `<h1>The Meridian 59 Compendium</h1>
<p class="lede">Every spell, skill, item and creature in the game, with the numbers the server
actually uses. Compiled directly from the Blakod source and the client's own sprites, so the
figures here are the figures the game runs — not remembered ones.</p>

<h2>Catalogues</h2>
<div class="cards">${cards}</div>

<h2>How the game works</h2>
<div class="cards">${guideCards}</div>
<p><a href="guides/index.html">All ${guides.length} guides →</a></p>

<h2>Reading these pages</h2>
<p>A line like <code>kod/object/passive/spell.kod:482</code> is a citation: that file, that line,
in the Meridian 59 source tree. If a number here disagrees with the game, the citation is where
to look. Formulas use integer arithmetic throughout, because Blakod has no other kind —
<code>/</code> truncates, and <code>random(a,b)</code> is inclusive at both ends.</p>
<p>Pictures are the game's own bitmaps, decoded from the client's <code>.bgf</code> files with
the palette in <code>blakston.pal</code>.</p>`;
    write('index.html', shell({ title: 'Home', active: 'home', nav, rel: '.', body }));
  }

  // ---- link repair, then write.
  //
  // Guide fragments are written by hand and cannot know which directory owns
  // which entity, so links are repaired centrally: rename directories that no
  // longer exist, then look the slug up anywhere on the site, then — only if it
  // is genuinely nowhere — unwrap the anchor so a reader sees text, not a 404.
  const DIR_ALIAS = {
    monsters: 'creatures', bestiary: 'creatures', mobs: 'creatures', npcs: 'creatures',
    reagents: 'items', weapons: 'items', armor: 'items', armour: 'items',
    spell: 'spells', skill: 'skills', item: 'items', guide: 'guides', creature: 'creatures',
  };
  const bySlug = new Map();
  for (const rel of built.keys()) {
    const m = /^([^/]+)\/([^/]+)\.html$/.exec(rel);
    if (m && m[2] !== 'index' && !bySlug.has(m[2])) bySlug.set(m[2], rel);
  }
  let fixed = 0, unwrapped = 0;
  const dead = new Map();
  const resolve = (fromRel, href) => {
    const [p, hash] = href.split('#');
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), p));
    if (built.has(abs)) return href;
    const m = /^(?:\.\.\/)?([^/]+)\/([^/]+\.html)$/.exec(p);
    if (m) {
      const suffix = hash ? '#' + hash : '';
      const alias = DIR_ALIAS[m[1]];
      if (alias && built.has(`${alias}/${m[2]}`)) { fixed++; return `../${alias}/${m[2]}${suffix}`; }
      const slug = m[2].replace(/\.html$/, '');
      if (slug !== 'index' && bySlug.has(slug)) { fixed++; return '../' + bySlug.get(slug) + suffix; }
    }
    return null;
  };
  for (const [rel, html] of built) {
    built.set(rel, html.replace(/<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g,
      (whole, pre, href, post, text) => {
        if (/^(https?:|mailto:|#)/.test(href)) return whole;
        const r = resolve(rel, href);
        if (r === href) return whole;
        if (r) return `<a${pre}href="${r}"${post}>${text}</a>`;
        unwrapped++;
        dead.set(href, (dead.get(href) || 0) + 1);
        return text;
      }));
  }

  for (const [rel, html] of built) {
    const f = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
  }
  fs.writeFileSync(path.join(OUT, 'search.json'), JSON.stringify(search));
  console.log(`\n${built.size} pages, ${search.length} search entries`);
  console.log(`links: ${fixed} redirected, ${unwrapped} unresolvable and unwrapped`);
  for (const [h, n] of [...dead.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${n}×  ${h}`);
  }
}

main();
