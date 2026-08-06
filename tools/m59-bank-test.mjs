#!/usr/bin/env node
// THE BANKER'S PROSE, READ THE WAY THE SERVER WROTE IT. Offline, no server, safe any time:
//
//   node tools/m59-bank-test.mjs
//
// Every case here is a line the server can actually emit, taken from monster.kod:136-148
// rather than from memory. Three of them are the reason this file exists:
//
//   * "in your POSSESSION" is the purse and differs from the account line by one word.
//     Reading it as a balance would overwrite a real balance with the contents of a
//     pocket, and the number would look perfectly plausible.
//   * A WITHDRAWAL REPORTS THE AMOUNT, NOT THE NEW BALANCE. Taking its %i as the balance
//     is the one mistake that writes a confidently wrong number, and it would only be
//     wrong when the balance went DOWN — the direction nobody checks.
//   * Barloque's banker is BANK_BASIC, and BANK_BASIC = BID_TOS = 1. Filing it as a
//     third account would split one balance into two and under-report both.
//
// Uses M59_BANK_DIR against a scratch directory, so it never touches a real fleet.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-bank-test-'));
process.env.M59_BANK_DIR = dir;

const bank = await import('./m59-bank.mjs');
const { readBankerLine, bankFromLine, noteBankerLine, emptyBook,
        record, loadBook, fleetTotal, accountOf } = bank;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const T0 = 1785971086036;
const says = (who, what) => `${who} tells you, "${what}"`;

// ------------------------------------------------------------------ the parse

console.log('\nreading what the banker said');
{
  const d = readBankerLine('Thank you for your deposit.  You now have 4595 shillings in your account.');
  ok('a deposit reports the new balance', d?.balance === 4595, JSON.stringify(d));
  ok('and is marked as observed, not computed', d?.observed === true);
  ok('and is filed as a deposit', d?.kind === 'deposit');
}
{
  const b = readBankerLine('You have 500 shillings in your account.');
  ok('a balance check reads', b?.balance === 500, JSON.stringify(b));
  ok('and is filed as a balance', b?.kind === 'balance');
}
{
  const r = readBankerLine('But you only have 120 shillings in your account!');
  ok('a refused withdrawal still states the balance', r?.balance === 120, JSON.stringify(r));
  ok('and is observed — the banker said the number', r?.observed === true);
}
{
  // THE ONE THAT LOOKS LIKE A BALANCE AND IS NOT.
  const p = readBankerLine('But you only have 300 shillings in your possession!');
  ok('"in your possession" is the purse and is NOT read as a balance', p === null,
     JSON.stringify(p));
}
{
  const w = readBankerLine('Here are your 900 shillings. Thank you for your business.');
  ok('a withdrawal reports the amount handed over', w?.withdrew === 900, JSON.stringify(w));
  ok('and carries no balance of its own', w?.balance === undefined);
  ok('and is never observed', w?.observed === false);
}
{
  const z = readBankerLine('You have no money to withdraw!');
  ok('an empty account states itself as zero', z?.balance === 0, JSON.stringify(z));
  ok('and zero is observed, not assumed', z?.observed === true);
}
ok('an unrelated line reads as nothing', readBankerLine('The mummy hits you.') === null);
ok('an empty line reads as nothing', readBankerLine('') === null);
ok('1 shilling parses as well as 4595',
   readBankerLine('You have 1 shilling in your account.')?.balance === 1);
ok('a comma-grouped number parses',
   readBankerLine('You have 12,345 shillings in your account.')?.balance === 12345);

// ------------------------------------------------------------------ which bank

console.log('\nwhich account it went into');
ok('Skivlat is Tos, bank 1', bankFromLine(says('Skivlat', 'x'))?.bank === 1);
ok('Yevitan is Jasper, bank 1', bankFromLine(says('Yevitan', 'x'))?.bank === 1);
ok("Setag'lib is Barloque and STILL bank 1 (BANK_BASIC = BID_TOS = 1)",
   bankFromLine(says("Setag'lib", 'x'))?.bank === 1);
ok("Huital ko'Nosak is Ko'catan, bank 2",
   bankFromLine(says("Huital ko'Nosak", 'x'))?.bank === 2);
ok('the three bank-1 towns share one account key',
   accountOf(1) === accountOf(1) && accountOf(1) !== accountOf(2));
ok('an unknown speaker falls back to the room',
   bankFromLine(says('Nobody', 'x'), 'The Hungry Vaults')?.bank === 2);
ok('and an unknown speaker in an unknown room is unattributable',
   bankFromLine(says('Nobody', 'x'), 'Deep Woods of Ileria') === null);

// ------------------------------------------------------------------ the record

console.log('\nkeeping the record');
{
  const book = emptyBook('Scooter');
  const e = noteBankerLine(book, says('Skivlat',
    'Thank you for your deposit.  You now have 4595 shillings in your account.'), { at: T0, room: 279 });
  ok('a deposit is recorded', e?.balance === 4595);
  ok('under the shared Jasper/Tos/Barloque account',
     book.accounts[accountOf(1)]?.balance === 4595);
  ok('and names the banker', e.banker === 'Skivlat');
  ok('and the history has it', book.history.length === 1);
}
{
  // A deposit at Jasper and one at Ko'catan are two different balances, and adding
  // them into one account would be the expensive kind of wrong.
  const book = emptyBook('Kermit');
  noteBankerLine(book, says('Yevitan', 'You have 1000 shillings in your account.'), { at: T0 });
  noteBankerLine(book, says("Huital ko'Nosak", 'You have 250 shillings in your account.'), { at: T0 + 1 });
  ok('two towns, two accounts', Object.keys(book.accounts).length === 2);
  ok('Jasper holds its own', book.accounts[accountOf(1)].balance === 1000);
  ok("Ko'catan holds its own", book.accounts[accountOf(2)].balance === 250);
}
{
  // Barloque pays into the SAME balance as Tos. One account, updated.
  const book = emptyBook('Fozzie');
  noteBankerLine(book, says('Skivlat', 'You have 800 shillings in your account.'), { at: T0 });
  noteBankerLine(book, says("Setag'lib",
    'Thank you for your deposit.  You now have 1200 shillings in your account.'), { at: T0 + 1 });
  ok('Barloque updates the Tos balance rather than opening a second account',
     Object.keys(book.accounts).length === 1 && book.accounts[accountOf(1)].balance === 1200);
}
{
  // THE WITHDRAWAL. The banker says what it handed over; the balance is arithmetic.
  const book = emptyBook('Bunsen');
  noteBankerLine(book, says('Skivlat', 'You have 4085 shillings in your account.'), { at: T0 });
  const w = noteBankerLine(book, says('Skivlat',
    'Here are your 1000 shillings. Thank you for your business.'), { at: T0 + 1 });
  ok('a withdrawal moves the balance down by what came out', w?.balance === 3085, JSON.stringify(w));
  ok('and is flagged as NOT observed', w?.observed === false);
  ok('and records what was taken', w?.withdrew === 1000);
  ok('and the account carries the derived number', book.accounts[accountOf(1)].balance === 3085);
}
{
  // Nothing to subtract from. Inventing a starting balance would be a fabrication.
  const book = emptyBook('Rizzo');
  const w = noteBankerLine(book, says('Skivlat',
    'Here are your 500 shillings. Thank you for your business.'), { at: T0 });
  ok('a withdrawal with no known balance records nothing rather than guessing', w === null);
  ok('and leaves the account empty', Object.keys(book.accounts).length === 0);
}
{
  // A backfill walks files in directory order, which is not time order.
  const book = emptyBook('Piggy');
  noteBankerLine(book, says('Skivlat', 'You have 900 shillings in your account.'), { at: T0 + 5000 });
  noteBankerLine(book, says('Skivlat', 'You have 100 shillings in your account.'), { at: T0 });
  ok('an older reading does not overwrite a newer one',
     book.accounts[accountOf(1)].balance === 900, JSON.stringify(book.accounts));
  ok('but the history keeps both, in time order',
     book.history.length === 2 && book.history[0].balance === 100);
}
{
  const book = emptyBook('Statler');
  const e = noteBankerLine(book, says('Skivlat',
    'But you only have 300 shillings in your possession!'), { at: T0 });
  ok('a purse line writes nothing to the account', e === null && !Object.keys(book.accounts).length);
}
{
  const book = emptyBook('Gonzo');
  const e = noteBankerLine(book, 'Somebody tells you, "You have 700 shillings in your account."',
                           { at: T0, roomName: 'Deep Woods of Ileria' });
  ok('a balance nobody can attribute to a bank is refused, not filed under a guess',
     e === null, JSON.stringify(e));
}

// ------------------------------------------------------------------ on disk

console.log('\nacross the fleet');
record('Scooter', says('Skivlat',
  'Thank you for your deposit.  You now have 4595 shillings in your account.'), { at: T0, room: 279 });
record('Bunsen', says('Skivlat', 'You have 4085 shillings in your account.'), { at: T0 });
record('Kermit', says("Huital ko'Nosak", 'You have 250 shillings in your account.'), { at: T0 });
{
  ok('what was written comes back', loadBook('Scooter').accounts[accountOf(1)].balance === 4595);
  const t = fleetTotal();
  ok('the fleet total sums the latest balance per account',
     t.total === 4595 + 4085 + 250, 'got ' + t.total);
  ok('and counts the characters holding one', t.characters_with_a_balance === 3);
  ok('and all of it is observed here', t.observed_total === t.total);
}
{
  // Depositing again REPLACES a balance; it does not add to one.
  record('Scooter', says('Skivlat',
    'Thank you for your deposit.  You now have 5000 shillings in your account.'), { at: T0 + 60000 });
  const t = fleetTotal();
  ok('a second deposit replaces rather than accumulates', t.total === 5000 + 4085 + 250,
     'got ' + t.total);
  ok('and the previous balance is kept on the entry', loadBook('Scooter').accounts[accountOf(1)].was === 4595);
}
{
  record('Bunsen', says('Skivlat', 'Here are your 85 shillings. Thank you for your business.'),
         { at: T0 + 60000 });
  const t = fleetTotal();
  ok('a withdrawal lowers the total', t.total === 5000 + 4000 + 250, 'got ' + t.total);
  ok('and the total says how much of it a banker actually stated',
     t.observed_total === 5000 + 250, 'got ' + t.observed_total);
}
{
  const before = fleetTotal().total;
  record('Bunsen', 'The mummy hits you.', { at: T0 + 70000 });
  ok('an unrelated line changes nothing', fleetTotal().total === before);
}
ok('an unnamed character is never written', record(null, says('Skivlat',
  'You have 10 shillings in your account.'), { at: T0 }) === null);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
