#!/usr/bin/env node
// m59-errandstate.mjs -- THE OTHER VOCABULARY: what an ERRAND can see.
//
// docs/keeper-rebuild-plan.md §3 left one question open on purpose, and this is the
// answer to it:
//
//   "the errand set derives symbols from fleet rows over MCP, the act set from a
//    live client. Same names, two sources. That is two producers for one symbol,
//    which §3's own rule forbids. Either two vocabularies, or one vocabulary with an
//    explicitly polymorphic context. Do not let it happen by accident."
//
// TWO VOCABULARIES. They are not the same facts wearing different clothes, and
// merging them would be the most expensive kind of tidying-up available here.
//
// ── WHY THEY MUST NOT SHARE NAMES ───────────────────────────────────────────
//
// FRESHNESS DIFFERS BY THREE ORDERS OF MAGNITUDE. m59-worldstate reads a live
// client: health, stats and the use list are PUSHED by the server, so `armed` is a
// cache hit and true right now. This module reads a `fleet` row fetched over MCP
// by a supervisor that runs every few minutes. `purse` in a row is what the purse
// was when somebody last looked.
//
// Give both the same name and a plan can silently chain a one-second fact to a
// five-minute-old one, which is precisely the failure this repository already has a
// name for: `ms_since_moved` measures the KEEPER, and reading it as though it
// measured the CHARACTER invented a stall that was not there and got two correct
// behaviours reverted. The cure was not a better number, it was noticing that two
// different questions had been given one name.
//
// So every symbol here is prefixed with its scope in the docs and, more usefully,
// lives in a separate registry that validates separately. An errand action naming
// an ACT symbol fails validation, and vice versa. That is the whole mechanism.
//
// ── THE SAME THREE RULES ────────────────────────────────────────────────────
//
//   CLOSED SET, ONE PRODUCER EACH, UNKNOWN FAILS SAFE PER SYMBOL.
//
// A row is missing far more often than a client is -- a character that is logged
// out has no row at all -- so the unknown direction matters more here, not less.

// A row, as the broker's `fleet` tool reports it. Nothing else is read.
export const ROW_FIELDS = Object.freeze([
  'agent', 'character', 'room_num', 'purse', 'reagents', 'level', 'max_health',
  'karma', 'mode', 'policy', 'keeper_running', 'stalled',
]);

// Raza, the newbie island. Rooms 1011-1018; a character that has not left cannot
// reach the mainland economy at all, which is why "out of Raza" is a fact an errand
// plans around rather than a place it happens to be.
export const RAZA_ROOMS = Object.freeze([1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const ERRAND_SYMBOLS = {
  keeper_running: {
    describe: 'the keeper is driving this character',
    whenUnknown: false,
    why_unknown: 'assuming a keeper we cannot see is running is how two drivers end ' +
                 'up steering one character',
    produce: ({ row }) => (row?.keeper_running == null ? null : !!row.keeper_running),
  },

  stalled: {
    describe: 'the keeper is reporting no progress',
    whenUnknown: false,
    why_unknown: 'a missing reading is not evidence of a stall, and acting on one ' +
                 'restarts a keeper that was working',
    produce: ({ row }) => (row?.stalled == null ? null : !!row.stalled),
  },

  out_of_raza: {
    describe: 'off the newbie island, so the mainland economy is reachable',
    whenUnknown: false,
    why_unknown: 'planning a shopping trip from an unknown room is how an errand ' +
                 'walks a character at nothing',
    produce: ({ row }) => {
      const r = num(row?.room_num);
      return r == null ? null : !RAZA_ROOMS.includes(r);
    },
  },

  at_assigned_room: {
    describe: 'standing where the policy says to stand',
    whenUnknown: false,
    why_unknown: 'unknown position must not satisfy a "get there" goal',
    produce: ({ row }) => {
      const r = num(row?.room_num);
      const want = num(row?.policy?.assignedRoom ?? row?.policy?.assigned_room);
      if (r == null || want == null) return null;
      return r === want;
    },
  },

  funded: {
    describe: 'carrying enough to buy the thing this errand is for',
    whenUnknown: false,
    why_unknown: 'a shopping trip planned on an unreadable purse is a walk for nothing',
    // COST COMES FROM THE CALLER, not from a constant here. A weapon, a skill and a
    // hall are three different prices, and a single "enough money" threshold would
    // be a number with two meanings -- the shape this repository keeps paying for.
    produce: ({ row, need }) => {
      const p = num(row?.purse);
      if (p == null) return null;
      return p >= (num(need) ?? 1);
    },
  },

  has_prey: {
    describe: 'the policy names something to hunt',
    whenUnknown: false,
    why_unknown: 'an empty hunt is what sends a keeper roaming somewhere it has no ' +
                 'business being',
    produce: ({ row }) => {
      const h = row?.policy?.hunt;
      return h === undefined ? null : !!h;
    },
  },

  can_advance: {
    describe: 'the prey can still raise this character — level strictly above max health',
    whenUnknown: false,
    why_unknown: 'assuming a kill pays is how a fleet grinds a creature worth nothing ' +
                 'for a week while every row reads healthy',
    // Max health IS the level here, and AdvancementCheck needs the creature STRICTLY
    // above it -- which is why nine characters stuck at 50 could farm a level-50
    // fungus beast indefinitely and gain nothing.
    produce: ({ row, preyLevel }) => {
      const mine = num(row?.max_health);
      const prey = num(preyLevel ?? row?.policy?.preyLevel);
      if (mine == null || prey == null) return null;
      return prey > mine;
    },
  },

  stocked: {
    describe: 'at least one casting of create food (2 elderberry AND 2 herbs)',
    whenUnknown: false,
    why_unknown: 'a resupply skipped on an unreadable pack is the one that empties a fleet',
    // The same min-not-sum rule as the act vocabulary, from a different source: a
    // row's reagents block rather than a live inventory. Two producers is exactly
    // what having two vocabularies makes safe, because neither can be mistaken for
    // the other's freshness.
    produce: ({ row }) => {
      const r = row?.reagents;
      if (!r) return null;
      const e = num(r.elderberry) ?? 0, h = num(r.herbs ?? r.herb) ?? 0;
      return Math.min(e, h) >= 2;
    },
  },
};

export const ERRAND_SYMBOL_NAMES = Object.freeze(Object.keys(ERRAND_SYMBOLS));

export function evaluateErrand(ctx = {}) {
  const out = {};
  for (const [name, sym] of Object.entries(ERRAND_SYMBOLS)) {
    let v = null;
    try { v = sym.produce(ctx); } catch { v = null; }
    out[name] = v == null ? sym.whenUnknown : !!v;
  }
  return out;
}

export function errandUnknowns(ctx = {}) {
  const out = [];
  for (const [name, sym] of Object.entries(ERRAND_SYMBOLS)) {
    let v = null;
    try { v = sym.produce(ctx); } catch { v = null; }
    if (v == null) out.push({ symbol: name, assumed: sym.whenUnknown, why: sym.why_unknown });
  }
  return out;
}

// THE SEPARATION, ENFORCED. An errand action naming an ACT symbol is a scope error
// and is reported as one -- with the reason, because "armed is not a symbol" would
// be baffling to somebody looking straight at it in the other registry.
export function validateErrand(action) {
  const problems = [];
  for (const [where, list] of [['pre', action?.pre], ['effects', action?.effects]]) {
    for (const raw of list ?? []) {
      const name = String(raw).replace(/^!/, '');
      if (ERRAND_SYMBOLS[name]) continue;
      problems.push(
        `${action?.name ?? 'errand'}.${where} names "${raw}", which is not an ERRAND ` +
        `symbol (known: ${ERRAND_SYMBOL_NAMES.join(', ')}). If it is an act symbol ` +
        'like armed or in_reach, it belongs to a keeper reading a live client, not to ' +
        'an errand reading a fleet row that may be minutes old.');
    }
  }
  return problems;
}

export function validateErrands(actions = []) {
  return actions.flatMap(a => validateErrand(a));
}
