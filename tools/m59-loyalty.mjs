#!/usr/bin/env node
// WHO OWES THEIR LIEGE SERVICE, AND HOW LONG THEY HAVE LEFT.
//
// A faction membership is a subscription. `FactionServiceTimer` (player.kod:11238)
// accumulates WALL-CLOCK time — it runs while the character is logged out — and at
// FACTION_WARN_TIME (20h) the server says
//
//     "Your liege is no longer convinced of your loyalty. You should visit your liege
//      at court again."
//
// and at FACTION_RESIGN_TIME (24h) it calls `ResignFaction`. Four hours, and there is no
// packet behind the notice: it is `MsgSendUser` prose, so the broker catches it off the
// event stream and files it beside the membership, exactly as a bank balance is caught.
// This reads that file back for the whole fleet without moving anybody.
//
//     node tools/m59-loyalty.mjs                 # the whole fleet, read-only
//     node tools/m59-loyalty.mjs --json
//     node tools/m59-loyalty.mjs --serve <name>  # plan the errand for one character
//     node tools/m59-loyalty.mjs --serve <name> --apply
//
// `--serve` is the operator path. DUM does the same three steps on its own five-minute
// clock when `factions.keep_membership` is on; this is for doing one by hand, and for
// the Duke, whose service quest is deliberately not automated anywhere.

import { readdirSync, existsSync } from 'node:fs';
import { FactionStatusCache } from './m59-faction-status.mjs';
import { loyaltyDebt, factionLoyaltySpec, loyaltyPurchase, LOYALTY_TRIGGER,
  FACTION_LOYALTY_GRACE_MS } from './m59-factions.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] ?? null; };

const DIR = process.env.M59_FACTION_DIR || 'substrate/faction-status';
const cache = new FactionStatusCache({ dir: DIR });

const everyCharacter = () => (existsSync(DIR) ? readdirSync(DIR) : [])
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))
  .sort();

const duration = ms => {
  if (ms == null) return '—';
  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(Math.round(ms / 60000));
  return `${sign}${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m`;
};

const rows = () => everyCharacter().map(character => {
  const status = cache.read(character);
  return { character, status, debt: status ? loyaltyDebt(status) : null };
}).filter(row => row.status);

// ---------------------------------------------------------------------------- serve

async function serve(character, { apply = false } = {}) {
  const status = cache.read(character);
  if (!status) { console.error(`no faction record for "${character}"`); process.exit(1); }
  const debt = loyaltyDebt(status);
  if (!debt) {
    console.log(`${character}: ${status.faction} — nothing owed.`);
    // NOT AN ERROR, AND NOT NECESSARILY GOOD NEWS. The warning is the only signal there
    // is, so "nothing owed" also covers "this broker was down when it was sent". The
    // server repeats it every twenty minutes until the deadline, so a broker that has
    // been up more than that has genuinely not heard one.
    console.log('  (the warning repeats every 20 min until the deadline, so a broker that ' +
      'has been up longer than that and heard nothing is genuinely up to date)');
    return;
  }
  const spec = factionLoyaltySpec(debt.faction);
  console.log(`${character} owes ${spec.title} service.`);
  console.log(`  warned   ${new Date(debt.warned_at).toLocaleString()}`);
  if (debt.soldier) {
    console.log('  deadline none — a soldier shield clamps the service counter at the warn');
    console.log('           threshold (player.kod:11203), so this warning never becomes an');
    console.log('           expulsion. Serving is optional.');
  } else {
    console.log(`  due      ${new Date(debt.due_at).toLocaleString()}  (${duration(debt.due_in_ms)} left` +
      `${debt.expired ? ', EXPIRED — expulsion may already have run' : ''})`);
  }
  if (!debt.automated) {
    console.log(`\n  NOT AUTOMATED: ${debt.why_not}`);
    console.log(`  By hand: go to room ${spec.room}, say "${LOYALTY_TRIGGER}" to ${spec.leader},`);
    console.log('  then say "tax" to the townsperson he names, and bring the money back.');
    console.log('  Both legs are half-hour timers and failing either revokes the membership.');
    return;
  }

  const purchase = loyaltyPurchase(debt.faction);
  console.log('\n  plan');
  if (purchase)
    console.log(`   1. travel ${purchase.room} — buy a ${purchase.item} from ${purchase.merchant} ` +
      '(assembles his list on demand, so he cannot run out)');
  console.log(`   ${purchase ? 2 : 1}. travel ${spec.room} — say "${LOYALTY_TRIGGER}" to ${spec.leader}`);
  console.log(`   ${purchase ? 3 : 2}. take the ONE item he names to ${spec.target ?? 'the recipient named'} ` +
    'within the hour');
  console.log('\n  He names one item out of ' + spec.accepts.length + ': ' + spec.accepts.join(', ') + '.');
  console.log('  Asking starts a one-hour timer whose penalty is expulsion, in place of the');
  console.log('  four hours already in hand — worth trading, because doing nothing loses the');
  console.log('  membership with certainty.');

  if (!apply) { console.log('\n  (plan only — pass --apply to run it)'); return; }

  const call = async (name, args) => {
    const response = await fetch(`${process.env.M59_BROKER || 'http://127.0.0.1:8901'}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name, arguments: args } }),
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
    const text = body.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : body.result;
  };

  const agent = value('--agent');
  if (!agent) {
    console.error('\n--apply needs --agent <handle> (the broker addresses sessions by handle, ' +
      'and a character name is not one)');
    process.exit(1);
  }

  console.log('\n  running');
  if (purchase) {
    console.log(`   travel ${purchase.room} …`);
    console.log('   ', JSON.stringify(await call('travel', { agent, to: purchase.room })));
    console.log('   ', JSON.stringify(await call('faction_loyalty',
      { agent, action: 'acquire', faction: debt.faction })));
  }
  console.log(`   travel ${spec.room} …`);
  console.log('   ', JSON.stringify(await call('travel', { agent, to: spec.room })));
  const asked = await call('faction_loyalty', { agent, action: 'request', faction: debt.faction });
  console.log('   ', JSON.stringify(asked));
  if (!asked.assigned) {
    console.log('\n  no assignment came back. Nothing was lost: without a reply there is no');
    console.log('  quest node and no one-hour timer. Check the liege was present and within');
    console.log('  five squares, and that a warning really is outstanding.');
    return;
  }
  console.log(`\n  assigned: ${asked.assigned.item} -> ${asked.assigned.target} ` +
    `(room ${asked.assigned.room}), one hour from now`);
  console.log('  Acquire that exact item and finish with:');
  console.log(`    faction_loyalty agent=${agent} action=offer faction=${debt.faction} ` +
    `item=<id> target="${asked.assigned.target}"`);
}

// ---------------------------------------------------------------------------- main

const target = value('--serve');
if (target) {
  await serve(target, { apply: flag('--apply') });
} else {
  const all = rows();
  if (flag('--json')) {
    console.log(JSON.stringify(all.map(({ character, status, debt }) =>
      ({ character, faction: status.faction, soldier: status.soldier,
         loyalty: status.loyalty ?? null, debt })), null, 2));
  } else {
    const members = all.filter(row => ['duke', 'princess', 'rebel'].includes(row.status.faction));
    console.log(`${all.length} character(s) on record, ${members.length} in a faction.\n`);
    if (!members.length) console.log('  nobody owes anything, because nobody has joined anything.');
    for (const { character, status, debt } of members) {
      const state = !debt ? 'ok'
        : debt.soldier ? 'warned (soldier — never expelled)'
        : debt.expired ? 'EXPIRED'
        : `OWES SERVICE — ${duration(debt.due_in_ms)} left`;
      console.log(`  ${character.padEnd(12)} ${String(status.faction).padEnd(9)} ${state}`);
    }
    // A CHARACTER WITH NO WARNING IS NOT PROVEN SAFE. The counter is invisible: nothing
    // on the wire reports `piFactionServiceUpdate`, so the only thing ever known about it
    // is the sentence at 20 hours. This tool reports what was heard, and says so.
    console.log('\n  There is no packet for the service counter — the only signal is the');
    console.log('  sentence at 20 hours, and it repeats every 20 minutes until the deadline.');
    console.log(`  A grace period is ${duration(FACTION_LOYALTY_GRACE_MS)} wide.`);
  }
}
