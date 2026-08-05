#!/usr/bin/env node
// m59-rearm.mjs — give the fleet's spare weapons to the characters holding none.
//
//   node tools/m59-rearm.mjs                  # who is unarmed, who can spare one (dry)
//   node tools/m59-rearm.mjs --go             # actually hand them out
//   node tools/m59-rearm.mjs --go --agents t1,t16
//
// WHY THIS EXISTS.
//
// `create weapon` makes a TEMPORARY weapon. The spell attaches IA_MADE with
// timer_duration = spellPower * 2 minutes (creaweap.kod:123-125), so at this fleet's
// spellpower a conjured mace lasts well under an hour and then simply vanishes. A
// character that armed itself that way is unarmed again a few passes later, and an
// unarmed character does not error — UserAttack falls back to a punch, so it stands in a
// monster room hitting things for nothing while every reading says it is hunting.
//
// Re-casting is not a reliable answer either: the spell costs 15 mana, and the
// characters that keep losing weapons are the ones fighting hardest, so they are
// repeatedly found at 10 or 11 mana with nothing to swing.
//
// Meanwhile the fleet hoards. Looted maces accumulate in whoever killed the thing:
// Robin and Zoot were each carrying five while Kermit, Floyd and Scooter fought with
// their fists. A permanent mace in the right pack is worth more than three casts.
//
// This does not buy anything and does not create anything. It moves what the fleet
// already owns.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const GO = !!arg('go', false);
const ONLY = arg('agents', null);

let id = 0;
// Long by default: `supply` walks a character across rooms and that is minutes, not
// seconds. A client-side timeout here does not cancel the errand — it abandons it
// mid-flight with a keeper still stopped, which is how three of these were lost before.
async function call(name, args = {}, timeoutMs = 600_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    const text = j.result?.content?.[0]?.text;
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const skills = await import('./m59-skills.mjs');

async function main() {
  const f = await call('fleet', {}, 120_000);
  const rows = (f.fleet || []).filter(r => r.character);
  if (!rows.length) { console.log('no characters in game'); return; }

  const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;

  // WHAT IS IN EACH PACK. `wielding` comes from the server's use list, which is the only
  // authority on what is actually held — the pack is a different question and the two
  // come apart constantly.
  const packs = new Map();
  for (const r of rows) {
    const inv = await call('inventory', { agent: r.agent }, 60_000).catch(() => ({ items: [] }));
    const weapons = (inv.items || []).filter(i => skills.weaponScore(i.name) > 0)
                                     .sort((a, b) => skills.weaponScore(b.name) - skills.weaponScore(a.name));
    packs.set(r.agent, weapons);
  }

  const unarmed = rows.filter(r => !r.wielding && (packs.get(r.agent) || []).length === 0)
                      .filter(r => !only || only.includes(r.agent));
  // A donor keeps the one it is using plus one in reserve — a fleet that strips its
  // fighters bare to arm the idle has not gained anything.
  const donors = rows.map(r => ({ r, spare: (packs.get(r.agent) || []).slice(r.wielding ? 1 : 2) }))
                     .filter(d => d.spare.length > 0);

  console.log(`${unarmed.length} unarmed with an empty pack; ` +
              `${donors.reduce((t, d) => t + d.spare.length, 0)} spare weapon(s) across ${donors.length} character(s)`);
  if (!unarmed.length) return;

  for (const need of unarmed) {
    // Nearest by ROUTE, because the donor has to walk it — room numbers are not distance.
    const routed = [];
    for (const d of donors) {
      if (!d.spare.length || d.r.agent === need.agent) continue;
      if (d.r.room_num === need.room_num) { routed.push({ d, hops: 0 }); continue; }
      const m = await call('map', { agent: d.r.agent, to: need.room_num }, 60_000).catch(() => null);
      if (m?.route?.found) routed.push({ d, hops: m.route.hops.length });
    }
    routed.sort((a, b) => a.hops - b.hops);
    const pick = routed[0];
    if (!pick) { console.log(`  ${need.character}: no donor can reach it`); continue; }
    const give = pick.d.spare[0];
    if (!GO) {
      console.log(`  ${need.character} <- ${pick.d.r.character} (${pick.hops} hops): ${give.name}`);
      continue;
    }
    // supply() holds BOTH keepers for the whole exchange and restores them itself. Do not
    // stop them here as well: the errand that does the walking owns that invariant, and
    // two owners is how a character ends up unattended.
    const r = await call('supply', { from: pick.d.r.agent, to: need.agent,
                                     what: [{ id: give.id, amount: 1 }], who_travels: 'from' })
                    .catch(e => ({ supplied: false, reason: e.message }));
    if (!r?.supplied) {
      // A FAILED HANDOVER IS NOT THE SAME AS A CHARACTER STILL EMPTY-HANDED. Its own
      // keeper may have conjured one meanwhile, and saying "FAILED" about a character
      // that is now armed reads as a problem to chase. Ask the server before deciding.
      const eq = await call('equipment', { agent: need.agent }, 60_000).catch(() => null);
      const armedAnyway = eq?.wielding ?? null;
      console.log(`  ${need.character} <- ${pick.d.r.character}: handover failed — ` +
                  `${String(r?.reason || 'no reason given').slice(0, 90)}` +
                  (armedAnyway ? ` (but it is wielding ${JSON.stringify(armedAnyway)} now — its keeper ` +
                                 'armed it, so this is not an unarmed character)'
                               : ' (still empty-handed)'));
      continue;
    }
    pick.d.spare.shift();
    // ASK AGAIN BEFORE CALLING IT UNVERIFIED.
    //
    // A single read 1.5s after the handover said "wielding null (UNVERIFIED)" for a
    // character that was, in fact, holding the mace — BP_USE arrives when it arrives, and
    // the equip request itself has to land first. Reporting an unverified failure that
    // actually worked is worse than reporting nothing: it sends the next pass chasing a
    // problem that is not there.
    let eq = null;
    for (let i = 0; i < 3 && !eq?.wielding; i++) {
      await sleep(2000);
      eq = await call('equip_best', { agent: need.agent }, 90_000).catch(() => null);
    }
    console.log(`  ${need.character} <- ${pick.d.r.character} (${pick.hops} hops): ${give.name} — ` +
                `now wielding ${JSON.stringify(eq?.wielding ?? null)}` +
                `${eq?.verified ? ' (verified against the server use list)' : ' (UNVERIFIED)'}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
