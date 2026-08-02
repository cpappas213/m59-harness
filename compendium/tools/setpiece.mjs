// setpiece.mjs -- recover the invisible machinery of a room.
//
// Some rooms are puzzles rather than places. A lever opens a door, a timer
// checks whether anyone is still standing inside a rectangle, and a handler
// wipes and respawns whatever is in it. None of that is visible in play — the
// rectangle in particular is completely invisible, and players learn its edges
// by guessing.
//
// Three properties of the source make it recoverable:
//
//   1. The rectangles are named constants, declared at the top of the room:
//        MIN_FINAL_ROW = 28   MAX_FINAL_ROW = 40
//        MIN_FINAL_COL = 1    MAX_FINAL_COL = 9
//   2. The predicates that test them are conjunctions of comparisons on a row
//      and a column, OR'd together — so the exact union can be read off:
//        if (iRow >= MIN_FINAL_ROW AND iRow <= MAX_FINAL_ROW
//            AND iCol >= MIN_FINAL_COL AND iCol <= MAX_FINAL_COL)
//           OR (iCol < HALL_EAST AND iRow > HALL_NORTH)
//      The second clause is half-open and clips to the room's own bounds, which
//      is why reading only the MIN_/MAX_ constants would miss part of the zone.
//   3. Timers are CreateTimer(self, @Handler, CONSTANT).
//
// Everything here is a static read. A region drawn on a map from this data is
// the region the server actually tests.

// The room's own constants, resolved against the global constant table.
export function localConstants(db, c) {
  const table = new Map();
  for (const [k, v] of Object.entries(db.constants)) {
    if (v.value !== null) table.set(k.toUpperCase(), v.value);
  }
  const own = {};
  for (const [k, expr] of Object.entries(c.constants)) {
    const t = String(expr).trim();
    let n = null;
    if (/^-?\d+$/.test(t)) n = parseInt(t, 10);
    else if (/^0x[0-9a-f]+$/i.test(t)) n = parseInt(t, 16);
    else if (table.has(t.toUpperCase())) n = table.get(t.toUpperCase());
    own[k] = { expr: t, value: n };
    if (n !== null) table.set(k.toUpperCase(), n);
  }
  return { own, table };
}

// The text of every `if` condition in a message body.
export function conditions(body) {
  const out = [];
  const re = /\bif\b/gi;
  let m;
  while ((m = re.exec(body))) {
    let i = m.index + 2, depth = 0, brace = -1;
    const start = i;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{' && depth <= 0) { brace = i; break; }
      else if (ch === '}' && depth <= 0) break;
    }
    if (brace > start) out.push(body.slice(start, brace));
  }
  return out;
}

// Split on OR at paren depth zero.
export function splitOr(text) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (text[i] === 'o' || text[i] === 'O')
             && (text[i + 1] === 'r' || text[i + 1] === 'R')
             && !/\w/.test(text[i - 1] || ' ') && !/\w/.test(text[i + 2] || ' ')) {
      parts.push(text.slice(last, i));
      last = i + 2;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// One disjunct -> a rectangle clipped to the room. Returns null unless the
// clause constrains BOTH a row and a column; that is what makes it a region
// rather than an ordinary comparison.
export function clauseToRect(clause, table, rows, cols) {
  let minRow = 0, maxRow = rows - 1, minCol = 0, maxCol = cols - 1;
  let sawRow = false, sawCol = false, bounded = 0;
  const re = /\b(i?row|i?col)\b\s*(>=|<=|<>|<|>|=)\s*([A-Za-z_]\w*|-?\d+)/gi;
  let m;
  while ((m = re.exec(clause))) {
    const axis = /col/i.test(m[1]) ? 'col' : 'row';
    const op = m[2];
    const raw = m[3];
    if (op === '<>') return null;
    let v = null;
    if (/^-?\d+$/.test(raw)) v = parseInt(raw, 10);
    else if (table.has(raw.toUpperCase())) v = table.get(raw.toUpperCase());
    if (v === null) return null;
    bounded++;
    if (axis === 'row') {
      sawRow = true;
      if (op === '>=') minRow = Math.max(minRow, v);
      else if (op === '>') minRow = Math.max(minRow, v + 1);
      else if (op === '<=') maxRow = Math.min(maxRow, v);
      else if (op === '<') maxRow = Math.min(maxRow, v - 1);
      else if (op === '=') { minRow = Math.max(minRow, v); maxRow = Math.min(maxRow, v); }
    } else {
      sawCol = true;
      if (op === '>=') minCol = Math.max(minCol, v);
      else if (op === '>') minCol = Math.max(minCol, v + 1);
      else if (op === '<=') maxCol = Math.min(maxCol, v);
      else if (op === '<') maxCol = Math.min(maxCol, v - 1);
      else if (op === '=') { minCol = Math.max(minCol, v); maxCol = Math.min(maxCol, v); }
    }
  }
  if (!sawRow || !sawCol || bounded < 2) return null;
  if (minRow > maxRow || minCol > maxCol) return null;
  return { minRow, maxRow, minCol, maxCol };
}

// The constant names a clause mentioned, so a region can be labelled the way
// the source labels it.
function namesIn(clause) {
  return [...new Set([...clause.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((g) => g[1]))]
    .filter((n) => /(ROW|COL|EAST|WEST|NORTH|SOUTH|HALL|PIT|GEN|FINAL|AREA|ZONE)/.test(n));
}

// A readable name for a region, from the constants it was built out of:
// MIN_FINAL_ROW / MAX_FINAL_COL -> "final".
function labelFor(names) {
  // Rooms write the stem in either position: MIN_FINAL_ROW and TRAP1_MIN_ROW
  // are both common. Strip the MIN/MAX and ROW/COL tokens wherever they sit and
  // whatever is left is the name the source uses for the area.
  const stems = new Set();
  for (const n of names) {
    const stem = n.split('_')
      .filter((tok) => !/^(MIN|MAX|ROW|COL|ROWS|COLS)\d*$/.test(tok))
      .join(' ').toLowerCase().trim();
    if (stem) stems.add(stem);
  }
  if (!stems.size) return 'trigger area';
  // Prefer the shortest, which is the stem without stray qualifiers.
  return [...stems].sort((a, b) => a.length - b.length)[0];
}

// What a region means depends entirely on which handler tests it. A single
// square checked by SomethingTryGo is a doorway; a rectangle checked by a
// respawn handler is a reset zone. Calling both "a trigger area" would be true
// and useless.
function kindOf(handlers) {
  const list = Array.isArray(handlers) ? handlers : [handlers];
  const parts = [];
  const any = (re) => list.some((h) => re.test(h));
  if (any(/Reset|Respawn/i)) parts.push('monsters cleared and respawned here');
  if (any(/^Count/i)) parts.push('your presence here blocks the reset');
  if (any(/Trap/i)) parts.push('trap');
  if (any(/Teleport/i)) parts.push('teleport pad');
  if (any(/^SomethingTryGo$/i)) parts.push('doorway or blocked square');
  if (any(/^InZone$/i)) parts.push('named zone');
  if (any(/Rent/i)) parts.push('rented room');
  else if (any(/Enter/i)) parts.push('entrance');
  return parts.length ? parts.join('; ') : 'tested by the room';
}

const BOILERPLATE =
  /^(Constructor|Constructed|Delete|CreateStandardExits|CreateStandardObjects|GetRoom\w*|Recreate\w*|LoadRoomData|SeanceCheck)$/i;

export function setPieces(db, c, dims) {
  const { own, table } = localConstants(db, c);
  const rows = dims ? dims.rows : 100;
  const cols = dims ? dims.cols : 100;

  // ---- timers
  const timers = [];
  for (const m of c.messages) {
    for (const g of m.body.matchAll(
      /CreateTimer\s*\(\s*self\s*,\s*@(\w+)\s*,\s*([A-Za-z_]\w*|\d+)\s*\)/gi)) {
      const raw = g[2];
      let ms = null;
      if (/^\d+$/.test(raw)) ms = parseInt(raw, 10);
      else if (table.has(raw.toUpperCase())) ms = table.get(raw.toUpperCase());
      if (!timers.some((t) => t.handler === g[1] && t.expr === raw)) {
        timers.push({ handler: g[1], expr: raw, ms, setIn: m.name, line: m.line });
      }
    }
  }

  // ---- regions, from the predicates that actually test them
  const regions = [];
  const seen = new Map();
  for (const m of c.messages) {
    for (const cond of conditions(m.body)) {
      if (!/\bi?row\b/i.test(cond) || !/\bi?col\b/i.test(cond)) continue;
      for (const clause of splitOr(cond)) {
        const rect = clauseToRect(clause, table, rows, cols);
        if (!rect) continue;
        // A clause covering the whole room is not a region.
        if (rect.minRow === 0 && rect.minCol === 0
            && rect.maxRow === rows - 1 && rect.maxCol === cols - 1) continue;
        const key = `${rect.minRow},${rect.maxRow},${rect.minCol},${rect.maxCol}`;
        if (seen.has(key)) {
          const prev = seen.get(key);
          if (!prev.usedBy.includes(m.name)) prev.usedBy.push(m.name);
          continue;
        }
        const names = namesIn(clause);
        const rec = {
          ...rect, usedBy: [m.name], names,
          label: labelFor(names),
          squares: (rect.maxRow - rect.minRow + 1) * (rect.maxCol - rect.minCol + 1),
          openEnded: !names.some((n) => /^MIN_/.test(n)) || !names.some((n) => /^MAX_/.test(n)),
        };
        regions.push(rec);
        seen.set(key, rec);
      }
    }
  }

  for (const g of regions) g.kind = kindOf(g.usedBy);

  // ---- the handlers that are this room's own behaviour
  const handlers = c.messages
    .filter((m) => !BOILERPLATE.test(m.name))
    .map((m) => ({
      name: m.name, line: m.line, doc: m.doc || '',
      creates: [...new Set([...m.body.matchAll(/Create\s*\(\s*&(\w+)/g)].map((g) => g[1]))],
      deletes: /@Delete\b/.test(m.body),
      setsTimer: /CreateTimer\s*\(/i.test(m.body),
      movesSector: /@SetSector\b/i.test(m.body),
    }))
    .filter((h) => h.creates.length || h.deletes || h.setsTimer || h.movesSector || h.doc);

  return { constants: own, timers, regions, handlers };
}
