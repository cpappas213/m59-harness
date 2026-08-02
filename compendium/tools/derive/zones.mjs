// derive/zones.mjs -- one page per place, the zone index, and the world map.
//
// A zone page is the join between everything else on the site: the creatures
// that spawn there link back to their bestiary pages, the shopkeeper standing
// in the corner links to hers, the mana node links to the channelling guide,
// and every exit links to the zone on the other side of it — which links back.
//
// The map is the game's own: tools/roo.mjs reads the wall geometry out of the
// .roo file the client draws and emits it as SVG.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, M59, esc, slugify, cleanText, humanize, cls, descendants, ivar, nameOf, descOf,
  constNames, constComment, iconFor, dataTable, kodSource, num,
} from '../lib.mjs';
import { readRoo, rooToSVG } from '../roo.mjs';
import { setPieceSection } from '../zonepiece.mjs';

export const meta = {
  id: 'zones', title: 'Zones', dir: 'zones', order: 9, nav: true,
  blurb: 'Every place in the world: its map, its inhabitants and its exits.',
};

function sideTable(name) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8')); }
  catch { return null; }
}

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], w: [-1, 0] };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', w: 'east' };

// Things worth calling out by name when a room places them.
const NOTABLE = {
  ManaNode: { kind: 'node', label: 'Mana node', href: '../guides/channeling.html' },
  Portal: { kind: 'portal', label: 'Portal' },
  HellPortal: { kind: 'portal', label: 'Portal to the Underworld' },
  NewbPortal: { kind: 'portal', label: 'Portal from the newbie area' },
  Chest: { kind: 'thing', label: 'Chest' },
  Sign: { kind: 'thing', label: 'Sign' },
  sign: { kind: 'thing', label: 'Sign' },
  Firepit: { kind: 'thing', label: 'Firepit' },
  Lever: { kind: 'thing', label: 'Lever' },
  BookPedestal: { kind: 'thing', label: 'Book pedestal' },
  FoodDispenser: { kind: 'thing', label: 'Food dispenser' },
};
// Scenery that would drown the page if listed individually.
const DECOR = new Set(['OrnamentalObject', 'Tree', 'FeyTree', 'Shrub', 'TallBush', 'Brazier',
  'Pillar', 'Statue', 'Lamp', 'Candelabra', 'DynamicLight', 'Table', 'Stool', 'BarStool',
  'Skull', 'RainbowFern', 'Hotplate', 'Player', 'User', 'DM']);

// ---------------------------------------------------------------- world map
//
// Outdoor rooms are laid out by walking their compass exits: if A's north edge
// leads to B, then B sits one square north of A. That is how the world is
// actually built, so the result is a real map rather than a graph drawing.
function layout(rooms) {
  const pos = {}, comp = {}, displaced = {};
  const conflicts = [];
  let component = 0;

  // Seed from the best-connected room so the main landmass forms first.
  const order = Object.keys(rooms)
    .filter((n) => rooms[n].exits.some((e) => e.kind === 'edge' && e.to))
    .sort((a, b) =>
      rooms[b].exits.filter((e) => e.kind === 'edge' && e.to).length -
      rooms[a].exits.filter((e) => e.kind === 'edge' && e.to).length);

  for (const seed of order) {
    if (pos[seed]) continue;
    component++;
    const taken = new Map();
    const place = (n, x, y) => { pos[n] = { x, y }; comp[n] = component; taken.set(x + ',' + y, n); };
    place(seed, 0, 0);
    const queue = [seed];

    while (queue.length) {
      const at = queue.shift();
      for (const e of rooms[at].exits) {
        if (e.kind !== 'edge' || !e.to || !rooms[e.to]) continue;
        const d = DIRS[e.dir];
        if (!d) continue;
        const wx = pos[at].x + d[0], wy = pos[at].y + d[1];

        if (pos[e.to]) {
          // Already placed. If it is not where this exit says it should be, the
          // world does not lie flat here; say so rather than moving it.
          if (comp[e.to] === component && (pos[e.to].x !== wx || pos[e.to].y !== wy)) {
            conflicts.push({ from: at, to: e.to, dir: e.dir, reason: 'inconsistent' });
          }
          continue;
        }

        // Free cell, or the nearest one to it. Dropping the room instead would
        // lose half the map to a handful of overlaps.
        let x = wx, y = wy, nudged = false;
        if (taken.has(x + ',' + y)) {
          conflicts.push({ from: at, to: e.to, dir: e.dir, occupied: taken.get(x + ',' + y), reason: 'occupied' });
          let found = false;
          for (let ring = 1; ring <= 6 && !found; ring++) {
            for (let dx = -ring; dx <= ring && !found; dx++) {
              for (let dy = -ring; dy <= ring && !found; dy++) {
                if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                if (!taken.has((wx + dx) + ',' + (wy + dy))) { x = wx + dx; y = wy + dy; found = true; }
              }
            }
          }
          if (!found) continue;
          nudged = true;
        }
        place(e.to, x, y);
        if (nudged) displaced[e.to] = true;
        queue.push(e.to);
      }
    }
  }
  return { pos, comp, displaced, conflicts };
}

function worldMapSVG(rooms, lay, keep) {
  if (keep.length < 2) return null;
  const CW = 132, CH = 60, GAP = 14;
  const xs = keep.map((n) => lay.pos[n].x), ys = keep.map((n) => lay.pos[n].y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const cols = Math.max(...xs) - minX + 1, rowsN = Math.max(...ys) - minY + 1;
  const W = cols * (CW + GAP) + GAP, H = rowsN * (CH + GAP) + GAP;
  const X = (n) => (lay.pos[n].x - minX) * (CW + GAP) + GAP;
  const Y = (n) => (lay.pos[n].y - minY) * (CH + GAP) + GAP;
  const inSet = new Set(keep);

  const lines = [], boxes = [], drawn = new Set();
  for (const n of keep) {
    for (const e of rooms[n].exits) {
      if (e.kind !== 'edge' || !e.to || !inSet.has(e.to)) continue;
      const key = [n, e.to].sort().join('|');
      if (drawn.has(key)) continue;
      drawn.add(key);
      lines.push(`<line x1="${X(n) + CW / 2}" y1="${Y(n) + CH / 2}" x2="${X(e.to) + CW / 2}" y2="${Y(e.to) + CH / 2}"/>`);
    }
    const r = rooms[n];
    const full = r.disp || r.name;
    const label = full.length > 30 ? full.slice(0, 28) + '…' : full;
    boxes.push(
      `<a href="${r.slug}.html"><g class="node${lay.displaced[n] ? ' nudged' : ''}">` +
      `<rect x="${X(n)}" y="${Y(n)}" width="${CW}" height="${CH}" rx="6"/>` +
      `<text x="${X(n) + CW / 2}" y="${Y(n) + CH / 2 - 2}">${esc(label)}</text>` +
      `<text class="sub" x="${X(n) + CW / 2}" y="${Y(n) + CH / 2 + 13}">${esc(r.region)}</text>` +
      `<title>${esc(full)}${lay.displaced[n] ? ' — shifted to fit' : ''}</title></g></a>`);
  }
  return `<svg class="worldmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<g class="edges">${lines.join('')}</g>${boxes.join('')}</svg>`;
}

// ---------------------------------------------------------------- build

export function build({ db, images }) {
  const Z = sideTable('zones.json');
  if (!Z) {
    return {
      indexHtml: `<h1>Zones</h1><p class="lede">No zone data. Run <code>node tools/extract-zones.mjs</code>.</p>`,
      pages: [],
    };
  }
  const rooms = Z.rooms;
  const lay = layout(rooms);

  const link = (name, dir) => {
    const k = cls(db, name);
    const label = k ? (nameOf(db, k) || humanize(k.name)) : humanize(name);
    return `<a href="../${dir}/${slugify(name)}.html">${esc(label)}</a>`;
  };
  const zoneLink = (n) => rooms[n]
    ? `<a href="${rooms[n].slug}.html">${esc(rooms[n].disp || rooms[n].name)}</a>` : esc(humanize(n));

  // ------------------------------------------------------------- pages
  const pages = [];
  for (const r of Object.values(rooms)) {
    const title = r.disp || r.name;
    let body = `<h1>${esc(title)}</h1>`;

    const terr = r.terrain.map((t) => t.replace('TERRAIN_', '').toLowerCase());
    body += `<p class="lede">${esc(r.name)} is in <strong>${esc(r.region)}</strong>` +
      (terr.length ? `, ${esc(terr.join(' and '))} terrain` : '') +
      `. ${r.monsters.length ? `${r.monsters.length} kind${r.monsters.length > 1 ? 's' : ''} of creature spawn here` : 'Nothing spawns here'}` +
      `${r.exits.length ? ` and it connects to ${new Set(r.exits.map((e) => e.to).filter(Boolean)).size} other place${new Set(r.exits.map((e) => e.to).filter(Boolean)).size === 1 ? '' : 's'}` : ''}.</p>`;

    // ---- the map
    const marks = [];
    if (r.teleport.row != null && r.teleport.col != null) {
      marks.push({ row: r.teleport.row, col: r.teleport.col, kind: 'entry', label: 'Where you arrive' });
    }
    for (const g of r.generators) marks.push({ row: g.row, col: g.col, kind: 'gen', label: 'Creature generator' });
    for (const o of r.objects) {
      if (o.row == null || o.col == null) continue;
      const k = cls(db, o.cls);
      if (k && k.chain.includes('Monster')) marks.push({ row: o.row, col: o.col, kind: 'npc', label: nameOf(db, k) || humanize(o.cls) });
      else if (NOTABLE[o.cls]) marks.push({ row: o.row, col: o.col, kind: NOTABLE[o.cls].kind, label: NOTABLE[o.cls].label });
    }
    for (const e of r.exits) {
      if (e.kind === 'square' && e.fromRow != null) {
        marks.push({ row: e.fromRow, col: e.fromCol, kind: 'exit', label: 'Exit to ' + (e.to ? rooms[e.to].name : e.toRid) });
      }
    }

    if (r.roo) {
      const f = path.join(M59, 'resource', 'rooms', r.roo);
      if (fs.existsSync(f)) {
        try {
          const roo = readRoo(f);
          const svg = rooToSVG(roo, { max: 720, marks, regions: r.regions || [] });
          if (svg) {
            body += `<figure class="mapfig">${svg}<figcaption>` +
              `${roo.rows} × ${roo.cols} squares, ${roo.numWalls} walls, from <code>${esc(r.roo)}</code>. ` +
              (r.regions && r.regions.length ? `Shaded boxes are the room's own trigger areas — see <a href="#setpiece">Set piece</a>. ` : '') +
              `<span class="mk-key"><span class="mk-entry"></span> arrival <span class="mk-gen"></span> creature generator ` +
              `<span class="mk-npc"></span> someone standing here <span class="mk-node"></span> mana node ` +
              `<span class="mk-exit"></span> exit</span></figcaption></figure>`;
          }
        } catch (e) { /* a room whose map will not parse still gets a page */ }
      }
    }

    // ---- facts
    const flagRows = r.flags.map((f) => ({
      f: `<code class="k">${esc(f)}</code>`, d: esc(constComment(f) || '—'),
    }));
    body += `<h2>The place itself</h2>`;
    body += dataTable([{ key: 'k', label: '' }, { key: 'v', label: '' }], [
      { k: '<strong>Region</strong>', v: esc(r.region) },
      { k: '<strong>Room id</strong>', v: r.rid ? `<code class="k">${esc(r.rid)}</code>${r.ridValue != null ? ` (${r.ridValue})` : ''}` : '—' },
      { k: '<strong>Map file</strong>', v: r.roo ? `<code>${esc(r.roo)}</code>` : '—' },
      { k: '<strong>Terrain</strong>', v: terr.length ? esc(terr.join(', ')) : '—' },
      { k: '<strong>You arrive at</strong>', v: r.teleport.row != null ? `row ${r.teleport.row}, column ${r.teleport.col}` : '—' },
      { k: '<strong>Music</strong>', v: r.music ? `<code>${esc(r.music)}</code>` : '—' },
    ], { sortable: false });
    body += `<p class="cite">${esc(r.file)}:${r.line}</p>`;

    if (flagRows.length) {
      body += `<h3>Rules in force here</h3>` +
        dataTable([{ key: 'f', label: 'Flag' }, { key: 'd', label: 'What it means' }], flagRows, { sortable: false }) +
        `<p class="cite">kod/include/blakston.khd:1032 — see <a href="../guides/places.html">Places and Travel</a></p>`;
    }

    // ---- who lives here
    const npcs = r.objects.filter((o) => {
      const k = cls(db, o.cls);
      return k && k.chain.includes('Monster');
    });
    if (npcs.length) {
      body += `<h2>Who is here</h2>`;
      body += dataTable(
        [{ key: 'i', label: '' }, { key: 'n', label: 'Name' }, { key: 'p', label: 'Standing at' }],
        npcs.map((o) => {
          const k = cls(db, o.cls);
          const ic = k ? iconFor(db, images, k, { group: 1 }) : null;
          return {
            i: ic ? `<img class="icon rowicon" src="${ic.src}" alt="" loading="lazy">` : '',
            n: link(o.cls, 'creatures'),
            p: o.row != null ? `row ${o.row}, col ${o.col}` : '<span class="muted">—</span>',
          };
        }), { sortable: false });
    }

    // ---- what spawns here
    if (r.monsters.length) {
      const total = r.monsters.reduce((a, m) => a + m.weight, 0);
      body += `<h2>What spawns here</h2>`;
      body += dataTable(
        [{ key: 'i', label: '' }, { key: 'n', label: 'Creature' }, { key: 'w', label: 'Weight', num: true },
         { key: 'p', label: 'Share', num: true }, { key: 'l', label: 'Level', num: true }],
        r.monsters.map((m) => {
          const k = cls(db, m.cls);
          const ic = k ? iconFor(db, images, k, { group: 1 }) : null;
          return {
            i: ic ? `<img class="icon rowicon" src="${ic.src}" alt="" loading="lazy">` : '',
            n: link(m.cls, 'creatures'),
            w: String(m.weight), _w: m.weight,
            p: total ? `${Math.round((m.weight * 100) / total)}%` : '—',
            l: k ? num(ivar(db, k, 'viLevel')) : '—',
          };
        }), { sortable: false });
      body += `<p>${r.generators.length} generator${r.generators.length === 1 ? '' : 's'} place them, marked on the map above. Weights are relative: a creature with weight 60 against a total of 100 is picked about 60% of the time.</p>`;
      body += `<p class="cite">${esc(r.file)} — <code class="k">plMonsters</code> and <code class="k">plGenerators</code></p>`;
    }

    // ---- notable objects
    const notable = r.objects.filter((o) => NOTABLE[o.cls]);
    if (notable.length) {
      body += `<h2>Notable things</h2><ul>`;
      for (const o of notable) {
        const N = NOTABLE[o.cls];
        const extra = o.extra ? ' — ' + Object.entries(o.extra).map(([k, v]) => `${k} ${v}`).join(', ') : '';
        body += `<li>${N.href ? `<a href="${N.href}">${esc(N.label)}</a>` : esc(N.label)}` +
          (o.row != null ? ` at row ${o.row}, col ${o.col}` : '') + esc(extra) + `</li>`;
      }
      body += `</ul>`;
    }
    const decorCount = r.objects.filter((o) => DECOR.has(o.cls)).length;
    if (decorCount) {
      body += `<p class="muted">${decorCount} pieces of scenery — trees, braziers, furniture — are also placed here.</p>`;
    }

    // ---- the invisible machinery
    body += setPieceSection(db, r);

    // ---- exits, both ways
    const out = r.exits.filter((e) => e.to);
    const back = (r.inbound || []).filter((i) => rooms[i.from]);
    const backOnly = back.filter((i) => !out.some((e) => e.to === i.from));
    if (out.length || backOnly.length) {
      body += `<h2>Ways out</h2>`;
      if (out.length) {
        body += dataTable(
          [{ key: 'd', label: 'Leave by' }, { key: 't', label: 'Arrive at' }, { key: 'r', label: 'Region' }],
          out.map((e) => ({
            d: e.kind === 'edge' ? `the ${esc(e.dir)} edge` : `the square at row ${e.fromRow}, col ${e.fromCol}`,
            t: zoneLink(e.to),
            r: esc(rooms[e.to].region),
          })), { sortable: false });
        body += `<p class="cite">${esc(r.file)} — <code class="k">plEdge_Exits</code> and <code class="k">plExits</code></p>`;
      }
      if (backOnly.length) {
        body += `<h3>One-way in</h3><p>These lead here but this room has no matching way back: ` +
          backOnly.map((i) => zoneLink(i.from)).join(', ') + `.</p>`;
      }
    } else {
      body += `<h2>Ways out</h2><p>No room in the source declares an exit from here. It is reached
      and left by a teleporter, a portal, or a spell.</p>`;
    }

    const c = cls(db, r.cls);
    if (c) body += `<hr><a id="src"></a>` + kodSource(db, c, { maxLines: 120 });

    pages.push({
      slug: r.slug, title, html: body, kind: 'zone',
      desc: `${r.region}. ${r.monsters.length} creature types, ${out.length} exits.`,
    });
  }

  // ------------------------------------------------------------- world map
  const placed = Object.keys(lay.pos);
  const groups = {};
  for (const n of placed) (groups[lay.comp[n]] = groups[lay.comp[n]] || []).push(n);
  const components = Object.values(groups).sort((a, b) => b.length - a.length).filter((g) => g.length >= 2);

  let wmBody = `<h1>The World Map</h1>
<p class="lede">Outdoor rooms in Meridian 59 tile: walk off the north edge of one and you arrive
at the south edge of another. That relation is declared in the source, so the map below is not a
drawing — it is those declarations, laid out by walking the compass directions from the
best-connected room outward. Every box is a link.</p>
<div class="note">Of ${Object.keys(rooms).length} rooms, <strong>${placed.length}</strong> have at
least one compass exit and can be placed. The rest connect only by an interior exit — a door, a
staircase, a portal — which carries no direction, so there is nowhere on a grid to put them. Their
connections are listed on their own pages.</div>`;

  components.forEach((g, i) => {
    const svg = worldMapSVG(rooms, lay, g);
    if (!svg) return;
    const regions = [...new Set(g.map((n) => rooms[n].region))];
    wmBody += `<h2>${i === 0 ? 'The main landmass' : `Landmass ${i + 1}`} — ${g.length} rooms</h2>` +
      `<p>${esc(regions.join(', '))}.</p><div class="mapscroll">${svg}</div>`;
  });

  if (lay.conflicts.length) {
    const occupied = lay.conflicts.filter((k) => k.reason === 'occupied');
    const inconsistent = lay.conflicts.filter((k) => k.reason === 'inconsistent');
    wmBody += `<h2>Where the world does not lie flat</h2>
<p>${lay.conflicts.length} exits cannot be satisfied by a grid. ${occupied.length} lead to a
square something else already occupies — those rooms are drawn nearby instead, with a dashed
outline. ${inconsistent.length} lead to a room the grid has already placed elsewhere by a
different route. Neither is an extraction error: the world genuinely is not a plane, and these are
the seams. They are listed so the map above can be trusted everywhere else.</p>` +
      dataTable([{ key: 'f', label: 'From' }, { key: 'd', label: 'Going' },
                 { key: 't', label: 'To' }, { key: 'o', label: 'Clashes with' }],
        lay.conflicts.slice(0, 80).map((k) => ({
          f: zoneLink(k.from), d: esc(k.dir || ''), t: zoneLink(k.to),
          o: k.occupied ? zoneLink(k.occupied)
            : '<span class="muted">its position from another route</span>',
        })), { sortable: false });
    if (lay.conflicts.length > 80) {
      wmBody += `<p class="muted">…and ${lay.conflicts.length - 80} more.</p>`;
    }
  }
  wmBody += `<p>See <a href="index.html">every zone</a>, and
<a href="../guides/places.html">Places and Travel</a> for what the room flags mean.</p>`;

  pages.push({ slug: 'world-map', title: 'The World Map', html: wmBody, kind: 'zone', desc: 'Outdoor rooms laid out by their compass exits.' });

  // ------------------------------------------------------------- index
  const list = Object.values(rooms).sort((a, b) =>
    a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
  const regions = [...new Set(list.map((r) => r.region))].sort();

  const rows = list.map((r) => {
    const out = r.exits.filter((e) => e.to);
    const npcs = r.objects.filter((o) => { const k = cls(db, o.cls); return k && k.chain.includes('Monster'); });
    return {
      _attrs: ` data-region="${esc(r.region)}"`,
      n: `<a href="${r.slug}.html">${esc(r.disp || r.name)}</a>`, _n: r.name,
      g: esc(r.region), _g: r.region,
      m: String(r.monsters.length), _m: r.monsters.length,
      c: r.monsters.length
        ? r.monsters.slice(0, 3).map((x) => link(x.cls, 'creatures')).join(', ') +
          (r.monsters.length > 3 ? ` <span class="muted">+${r.monsters.length - 3}</span>` : '')
        : '<span class="muted">—</span>',
      p: npcs.length ? npcs.slice(0, 2).map((x) => link(x.cls, 'creatures')).join(', ') : '<span class="muted">—</span>',
      _p: npcs.length,
      x: String(out.length), _x: out.length,
      f: r.flags.length ? esc(r.flags.map((s) => s.replace('ROOM_', '').toLowerCase()).join(', ')) : '<span class="muted">—</span>',
      t: r.terrain.length ? esc(r.terrain.map((s) => s.replace('TERRAIN_', '').toLowerCase()).join(', ')) : '<span class="muted">—</span>',
    };
  });

  const indexHtml = `<h1>Zones</h1>
<p class="lede">${list.length} places, every one with the map the client draws, the creatures that
spawn in it, the people standing in it and the doors out of it. ${Z.stats.exitsResolved} exits
connect them; <a href="world-map.html">the world map</a> lays the outdoor ones out by their
compass directions.</p>

<div class="cards">
  <a class="card" href="world-map.html"><div class="t">The World Map</div><div class="d">Outdoor rooms placed by walking the north/south/east/west exits declared in the source.</div></a>
  <a class="card" href="../guides/places.html"><div class="t">Places and Travel</div><div class="d">What the sixteen room flags do to you, and where a new character should go.</div></a>
  <a class="card" href="../creatures/index.html"><div class="t">Bestiary</div><div class="d">Every creature, with the zones it spawns in and how hard it is for your build.</div></a>
</div>

<div class="filterbar" data-for="zonetable">
  <input type="search" placeholder="filter…" aria-label="Filter zones">
  <select data-filter="region"><option value="">every region</option>${
    regions.map((g) => `<option>${esc(g)}</option>`).join('')}</select>
  <span class="count"></span>
</div>
${dataTable([
    { key: 'n', label: 'Place' }, { key: 'g', label: 'Region' },
    { key: 'm', label: 'Spawns', num: true }, { key: 'c', label: 'Creatures' },
    { key: 'p', label: 'People' }, { key: 'x', label: 'Exits', num: true },
    { key: 't', label: 'Terrain' }, { key: 'f', label: 'Rules' },
  ], rows, { id: 'zonetable' })}

<h2>How this was assembled</h2>
<p>A room class declares its map file in <code class="k">prRoom</code>, its identity in
<code class="k">piRoom_num</code>, its spawn table in <code class="k">plMonsters</code> with
weights, the coordinates those spawns appear at in <code class="k">plGenerators</code>, and the
people and objects standing in it as <code class="k">Create()</code> calls with row and column.
Exits come in two forms: <code class="k">plEdge_Exits</code> for walking off the edge of the map,
and <code class="k">plExits</code> for stepping on a particular square. Both name their
destination by room id, which is what makes the links on these pages two-way.</p>
<p class="cite">kod/object/active/holder/room.kod and every subclass · extracted by tools/extract-zones.mjs · maps decoded from resource/rooms/*.roo by tools/roo.mjs, following clientd3d/bspload.c</p>`;

  return { indexHtml, pages };
}
