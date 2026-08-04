#!/usr/bin/env node
// WHAT EVERY ITEM WEIGHS, so the fleet can know when it is full.
//
//   node tools/m59-items.mjs build     # write substrate/m59-items.json from the kod
//   node tools/m59-items.mjs           # show what is known, and what is not
//   node tools/m59-items.mjs mace      # look one up
//
// WHY THIS EXISTS. The server refuses a pickup — and DELETES a spell-created weapon
// rather than handing it over — when `piWeight_hold + weight > GetWeightMax`, or the
// same for bulk (holder.kod:259 ReqNewHold -> :281 CanHoldWeightAndBulk). The ceiling
// is exact arithmetic on an attribute we already read:
//
//     GetWeightMax = GetBulkMax = 1700 + might * 20     player.kod:10456, :10461
//
// but the LOAD was unknowable. piWeight_hold lives on the server and is never sent, and
// no packet carries an item's weight or bulk either — so "is there room" could only be
// answered by trying and losing the mana. That cost a real afternoon: create weapon
// rolls, succeeds, builds the weapon, asks ReqNewHold, and on refusal deletes it and
// keeps the 15 mana (creaweap.kod:116-129).
//
// The weights are not secret, they are just not on the wire. Every item class declares
// viWeight and viBulk, or inherits them, and Item itself defaults both to 10
// (item.kod:66-67). So this reads them once, from the kod, and writes a table the
// broker can add up.
//
// KEYED BY NAME, BECAUSE A NAME IS ALL THE PROTOCOL GIVES US. An inventory entry is
// {id, name, amount} — the class is not in it. So the join is through vrName, the
// resource string each class names itself with, which is exactly the string the client
// resolves for display. Where two classes share a display name the heavier is kept and
// both are recorded, because guessing light is the direction that fails: it says there
// is room when there is not, which is the bug this exists to prevent.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const KODDB = join(HERE, '..', 'compendium', 'data', 'koddb.json');
export const ITEMS_FILE = join(HERE, '..', 'substrate', 'm59-items.json');

// Item.viWeight / Item.viBulk (item.kod:66-67). Used when nothing in the chain says
// otherwise, which is the common case for the small stuff.
const DEFAULT_WEIGHT = 10;
const DEFAULT_BULK = 10;

// Walk the inheritance chain for the first class that declares this classvar. koddb
// resolves each chain already, most-derived first, so this is a lookup rather than a
// graph walk. Returns null when nothing in the chain declares it at all — which is
// different from "declared as 0" and must not collapse into the default silently.
function inherited(classes, chain, name) {
  for (const step of chain || []) {
    const cls = classes[String(step).toLowerCase()];
    const v = cls?.classvars?.[name];
    if (v && typeof v.value === 'number') return { value: v.value, from: cls.name };
  }
  return null;
}

// The display name a class calls itself, which is what the protocol hands us back.
//
// TWO CLASSVARS, NOT ONE. Most items name themselves with vrName, but anything whose
// identity is concealed until it is identified — rings, potions, the disguised gear —
// carries vrRealName instead and leaves vrName unset. Reading only vrName silently
// dropped every one of those from the table, and the fleet noticed: Statler's six signet
// rings came back "unweighed" and withheld its room_for, which is the honest failure but
// still a hole. SignetRing declares viWeight 2 perfectly plainly (ringsignet, :36-37).
function displayName(cls) {
  for (const key of ['vrName', 'vrRealName']) {
    const rsc = cls?.classvars?.[key]?.rsc;
    if (rsc?.kind === 'string' && typeof rsc.value === 'string') return rsc.value.trim();
  }
  return null;
}

export function buildItemTable(koddbFile = KODDB) {
  const db = JSON.parse(readFileSync(koddbFile, 'utf8'));
  const classes = db.classes || {};
  const byName = new Map();
  let considered = 0, defaulted = 0;

  for (const cls of Object.values(classes)) {
    // Items only. Anything whose chain does not pass through Item has no weight that
    // matters here — creatures, rooms, spells and the rest are never in a pack.
    const chain = cls.chain || [];
    if (!chain.some(x => String(x).toLowerCase() === 'item')) continue;
    const name = displayName(cls);
    if (!name) continue;                       // abstract classes name nothing
    considered++;

    const w = inherited(classes, chain, 'viWeight');
    const b = inherited(classes, chain, 'viBulk');
    if (!w || !b) defaulted++;
    const entry = {
      name,
      weight: w?.value ?? DEFAULT_WEIGHT,
      bulk: b?.value ?? DEFAULT_BULK,
      cls: cls.name,
      declared_by: { weight: w?.from ?? 'Item (default)', bulk: b?.from ?? 'Item (default)' },
    };

    const key = name.toLowerCase();
    const prev = byName.get(key);
    // KEEP THE HEAVIER. Two classes can share a display name, and the protocol cannot
    // tell us which one is in the pack. Underestimating says there is room when there
    // is not, and that is the failure this table exists to prevent; overestimating only
    // makes a character shed something early.
    if (!prev) byName.set(key, { ...entry, also: [] });
    else {
      const keep = entry.weight > prev.weight ? entry : prev;
      const other = entry.weight > prev.weight ? prev : entry;
      byName.set(key, { ...keep, also: [...(prev.also || []), { cls: other.cls, weight: other.weight, bulk: other.bulk }] });
    }
  }

  return {
    builtAt: null,                              // stamped by the caller; see build()
    source: 'compendium/data/koddb.json',
    defaults: { weight: DEFAULT_WEIGHT, bulk: DEFAULT_BULK, from: 'item.kod:66-67' },
    capacity_formula: '1700 + might * 20, for weight AND bulk (player.kod:10456, :10461)',
    counts: { item_classes: considered, distinct_names: byName.size, used_defaults: defaulted },
    items: Object.fromEntries([...byName.entries()].sort()),
  };
}

// ------------------------------------------------------------------ lookup

let cached = null;
export function loadItems(file = ITEMS_FILE) {
  if (cached) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

// What one item weighs, by the name the protocol gave us. Returns null for anything the
// table does not know — the caller has to decide what to do about that, and every
// caller here treats it as "unknown", never as zero.
export function weighItem(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t) return null;
  const hit = t.items[String(name || '').trim().toLowerCase()];
  return hit ? { weight: hit.weight, bulk: hit.bulk, cls: hit.cls } : null;
}

// ADD UP A PACK, and say how much of it we could not account for.
//
// `unknown` is the number that decides whether the total means anything. A load of 900
// with three unknown items is not a load of 900; it is a lower bound. Callers that use
// this to answer "is there room" must treat any unknown as a reason to make room rather
// than to conclude there is some.
export function weighPack(items, file = ITEMS_FILE) {
  let weight = 0, bulk = 0;
  const unknown = [];
  for (const it of items || []) {
    const n = it.amount ?? 1;
    const w = weighItem(it.name, file);
    if (!w) { unknown.push(it.name); continue; }
    weight += w.weight * n;
    bulk += w.bulk * n;
  }
  return { weight, bulk, unknown, exact: unknown.length === 0 };
}

// ------------------------------------------------------------------- cli

function build() {
  const table = buildItemTable();
  table.builtAt = new Date().toISOString();
  writeFileSync(ITEMS_FILE, JSON.stringify(table, null, 1));
  console.log(`wrote ${ITEMS_FILE}`);
  console.log(`  ${table.counts.item_classes} item classes -> ${table.counts.distinct_names} distinct names`);
  console.log(`  ${table.counts.used_defaults} fell back to Item's 10/10`);
  const heavy = Object.values(table.items).sort((a, b) => b.weight - a.weight).slice(0, 5);
  console.log('  heaviest:', heavy.map(h => `${h.name} ${h.weight}`).join(', '));
}

if (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(String(process.argv[1]).replace(/\\/g, '/'))) {
  const arg = process.argv[2];
  if (arg === 'build') build();
  else if (arg) {
    const w = weighItem(arg);
    console.log(w ? `${arg}: weight ${w.weight}, bulk ${w.bulk} (${w.cls})` : `${arg}: not in the table`);
  } else {
    const t = loadItems();
    if (!t) { console.log('no table yet — run: node tools/m59-items.mjs build'); process.exit(1); }
    console.log(`${t.counts.distinct_names} items, built ${t.builtAt}`);
    console.log(`${t.counts.used_defaults} used Item's default 10/10`);
    console.log(t.capacity_formula);
  }
}
