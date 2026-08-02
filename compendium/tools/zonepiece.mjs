// zonepiece.mjs -- render a room's invisible machinery for its zone page.
//
// Split out of derive/zones.mjs because it is the one part of a zone page that
// is prose about behaviour rather than a table of properties, and it is the
// part a player cannot discover in game at all.

import { esc, dataTable, cls, nameOf, humanize, slugify } from './lib.mjs';

const ms = (n) => {
  if (n === null || n === undefined) return '—';
  if (n % 60000 === 0 && n >= 60000) return `${n / 60000} min`;
  if (n % 1000 === 0) return `${n / 1000} s`;
  return `${n} ms`;
};

// Handlers whose names say what they are for. Anything not listed still gets
// shown; this only supplies a sentence where one is obvious.
const HANDLER_NOTE = {
  FirstUserEntered: 'Runs when the room goes from empty to occupied.',
  SomethingKilled: 'Runs whenever anything in the room dies.',
  LeverChanged: 'Runs when a lever in the room is pulled.',
  ResetPuzzle: 'Puts the puzzle back to its starting state.',
  CheckAllDeadMonsters: 'Checks whether the room has been cleared.',
  NewHold: 'Runs when anything enters the room.',
  LeaveHold: 'Runs when anything leaves the room.',
  ReqNewHold: 'Vetoes something trying to enter — this is how a room limits what may spawn where.',
  TestOpenDoor: 'An administrative shortcut, not reachable in play.',
};

export function setPieceSection(db, r) {
  const hasRegions = r.regions && r.regions.length;
  const hasTimers = r.timers && r.timers.length;
  const interesting = (r.handlers || []).filter((h) =>
    h.setsTimer || h.movesSector || h.deletes || h.creates.length ||
    /^(FirstUserEntered|SomethingKilled|LeverChanged|ResetPuzzle|CheckAllDead|ReqNewHold)/i.test(h.name));
  if (!hasRegions && !hasTimers && interesting.length < 2) return '';

  let h = `<h2 id="setpiece">Set piece</h2>
<p>This room runs machinery of its own — timers, trigger areas, or handlers that fire on
something other than walking in. None of it is visible while you are standing in it.</p>`;

  // ---- trigger regions
  if (hasRegions) {
    const areas = r.regions.filter((g) => (g.squares ?? 2) > 1);
    const squares = r.regions.filter((g) => (g.squares ?? 2) <= 1);

    h += `<h3>Trigger areas</h3>
<p>These are tested by the room's own code and are <strong>completely invisible in play</strong>:
nothing in the client marks them, and standing one square outside one is a different situation
from standing inside it. They are drawn on the map above. Bounds are inclusive, in the room's own
row and column grid, clipped to the map.</p>`;

    const rowFor = (g, i) => ({
      l: `<span class="rgkey rg-${i % 4}"></span> ${esc(g.label)}${g.openEnded ? ' <span class="muted">(open-ended, clipped to the room)</span>' : ''}`,
      k: esc(g.kind || ''),
      r: g.minRow === g.maxRow ? String(g.minRow) : `${g.minRow}–${g.maxRow}`,
      c: g.minCol === g.maxCol ? String(g.minCol) : `${g.minCol}–${g.maxCol}`,
      s: String(g.squares ?? ((g.maxRow - g.minRow + 1) * (g.maxCol - g.minCol + 1))),
      _s: g.squares ?? 0,
      u: g.usedBy.map((n) => `<code class="k">${esc(n)}</code>`).join(', '),
    });
    const cols = [{ key: 'l', label: 'Area' }, { key: 'k', label: 'What it is' },
                  { key: 'r', label: 'Rows' }, { key: 'c', label: 'Columns' },
                  { key: 's', label: 'Squares', num: true }, { key: 'u', label: 'Tested by' }];

    if (areas.length) h += dataTable(cols, areas.map(rowFor), { sortable: false });
    if (squares.length) {
      h += `<h4>Single squares</h4>
<p>One square each — usually a doorway, a teleport pad, or a step that is checked before you are
allowed onto it.</p>`;
      h += dataTable(cols, squares.map((g, i) => rowFor(g, i + areas.length)), { sortable: false });
    }

    // Which handler tests which squares. Comparing the clause LISTS would be
    // wrong: a room can declare a rectangle that turns out to be wholly inside
    // another clause, so two handlers with different clause sets can still test
    // exactly the same ground. Compare the unions.
    const squaresOf = (list) => {
      const set = new Set();
      for (const g of list) {
        for (let rr = g.minRow; rr <= g.maxRow; rr++) {
          for (let cc = g.minCol; cc <= g.maxCol; cc++) set.add(rr + ',' + cc);
        }
      }
      return set;
    };
    const byHandler = {};
    for (const g of r.regions.filter((x) => (x.squares ?? 2) > 1)) {
      for (const u of g.usedBy) (byHandler[u] = byHandler[u] || []).push(g);
    }
    const names = Object.keys(byHandler);
    if (names.length > 1) {
      const sets = {};
      for (const n of names) sets[n] = squaresOf(byHandler[n]);
      const pairs = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = sets[names[i]], b = sets[names[j]];
          const onlyA = [...a].filter((k) => !b.has(k));
          const onlyB = [...b].filter((k) => !a.has(k));
          pairs.push({ a: names[i], b: names[j], onlyA, onlyB });
        }
      }
      const same = pairs.filter((x) => !x.onlyA.length && !x.onlyB.length);
      const diff = pairs.filter((x) => x.onlyA.length || x.onlyB.length);

      h += `<div class="note"><strong>How much ground each one covers.</strong> ` +
        names.map((n) => `<code class="k">${esc(n)}</code> tests ${sets[n].size} squares`).join(', ') +
        `.</div>`;

      for (const x of same) {
        h += `<div class="note"><strong>The same ground, by two routes.</strong>
<code class="k">${esc(x.a)}</code> and <code class="k">${esc(x.b)}</code> are written with
different clauses but cover <em>exactly the same squares</em> — one of the declared rectangles
turns out to sit wholly inside another. Whatever blocks the one blocks the other.</div>`;
      }
      for (const x of diff) {
        h += `<div class="warn"><strong>These two are not the same ground.</strong>
${x.onlyA.length ? `${x.onlyA.length} squares are tested by <code class="k">${esc(x.a)}</code> only. ` : ''}` +
`${x.onlyB.length ? `${x.onlyB.length} squares are tested by <code class="k">${esc(x.b)}</code> only. ` : ''}` +
`Standing on one of those behaves differently from standing on the rest.</div>`;
      }
    }
  }

  // ---- timers
  if (hasTimers) {
    h += `<h3>Timers</h3>`;
    h += dataTable(
      [{ key: 'h', label: 'Fires' }, { key: 'p', label: 'After' }, { key: 'e', label: 'Constant' }, { key: 's', label: 'Armed by' }],
      r.timers.map((t) => ({
        h: `<code class="k">${esc(t.handler)}</code>`,
        p: ms(t.ms), _p: t.ms ?? 0,
        e: `<code>${esc(t.expr)}</code>`,
        s: `<code class="k">${esc(t.setIn)}</code>`,
      })), { sortable: false });
    h += `<p class="cite">${esc(r.file)} — <code class="k">CreateTimer</code></p>`;
  }

  // ---- handlers
  if (interesting.length) {
    h += `<h3>What the room reacts to</h3>`;
    h += dataTable(
      [{ key: 'n', label: 'Handler' }, { key: 'w', label: 'What it does' }, { key: 'l', label: 'Line', num: true }],
      interesting.map((x) => {
        const does = [];
        if (x.creates.length) does.push('creates ' + x.creates.map((k) => {
          const kk = cls(db, k);
          return kk && kk.chain.includes('Monster')
            ? `<a href="../creatures/${slugify(k)}.html">${esc(nameOf(db, kk) || humanize(k))}</a>`
            : `<code class="k">${esc(k)}</code>`;
        }).join(', '));
        if (x.deletes) does.push('deletes objects');
        if (x.setsTimer) does.push('sets a timer');
        if (x.movesSector) does.push('moves a floor or ceiling');
        return {
          n: `<code class="k">${esc(x.name)}</code>`,
          w: (HANDLER_NOTE[x.name] ? esc(HANDLER_NOTE[x.name]) + ' ' : '') +
             (x.doc ? '<em>' + esc(x.doc) + '</em> ' : '') + does.join('; '),
          l: String(x.line), _l: x.line,
        };
      }), { sortable: false });
    h += `<p>The full text of each is under <a href="#src">In the source</a>.</p>`;
  }

  // ---- the room's own constants
  const consts = Object.entries(r.constants || {}).filter(([, v]) => v.value !== null);
  if (consts.length) {
    h += `<h3>Numbers this room declares</h3>`;
    h += dataTable(
      [{ key: 'n', label: 'Constant' }, { key: 'v', label: 'Value' }],
      consts.map(([k, v]) => ({
        n: `<code class="k">${esc(k)}</code>`,
        v: /_TIME$|_DELAY$|TIMER/i.test(k) ? `${v.value} <span class="muted">(${ms(v.value)})</span>` : String(v.value),
      })), { sortable: false });
  }

  return h;
}
