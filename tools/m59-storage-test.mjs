#!/usr/bin/env node
//
// The four containers and their four different rules. Runs against scratch directories and
// never touches substrate/storage — the running broker writes that.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCache, packFullness, bulkFullness, vaultFullness, chestFullness,
         packMax, PACK_BASE, VAULT_BULK_MAX, CHEST_BULK_MAX, STOREBOX_BULK_MAX,
         GUILD_CHEST_SLOTS, BOOKMAKERS_CHESTS } from './m59-storage.mjs';

let n = 0;
const ok = (c, why) => { assert.ok(c, why); n++; };
const eq = (a, b, why) => { assert.equal(a, b, why); n++; };

// ------------------------------------------------------------------ the ceilings
eq(PACK_BASE, 1700, 'player.kod:737');
eq(packMax(0), 1700, 'no might is still the base, not zero');
eq(packMax(35), 2400, '1700 + might*20 (player.kod:10458)');
eq(VAULT_BULK_MAX, 3000, 'storage.kod:31');
eq(CHEST_BULK_MAX, 24000, 'chest.kod:29');
eq(STOREBOX_BULK_MAX, 4000, 'storebox.kod:33');
eq(GUILD_CHEST_SLOTS, 4, 'a hall may hold four');
eq(BOOKMAKERS_CHESTS, 3, 'guildh14.kod:518,520,522 creates three');

// ------------------------------------------------------------------ a pack has TWO
//
// The one container with two ceilings, and it is full when EITHER is reached. Reporting
// the average, or whichever is lower, says there is room when there is not — which is the
// bug the weight table exists to prevent: a create weapon on a full pack costs 15 mana and
// the server DELETES the weapon.
const heavy = packFullness([{ name: 'plate armor', amount: 3 }], 35);
const bulky = packFullness([{ name: 'herb', amount: 200 }], 35);
ok(heavy.known && bulky.known, 'both are answerable with a might');
eq(heavy.percent, Math.max(heavy.weight_pct, heavy.bulk_pct), 'the pack takes the WORSE fraction');
eq(bulky.percent, Math.max(bulky.weight_pct, bulky.bulk_pct));
ok(heavy.binding === 'weight' || heavy.binding === 'bulk', 'and says which one binds');
eq(bulky.binding, 'bulk', 'two hundred herbs is bulk-bound, not weight-bound');

// WITHOUT MIGHT THERE IS NO CEILING, and a percentage of an unknown ceiling is not zero.
const noMight = packFullness([{ name: 'mace', amount: 1 }], null);
eq(noMight.known, false, 'unknown rather than a number');
eq(noMight.percent, undefined, 'and specifically not a percentage');

// ------------------------------------------------------------------ the bulk-only three
//
// These declare viWeight_hold_max = $, which is nil and means unlimited. Weighing them
// would invent a limit the server does not have — so a pack of lead fills a vault by bulk
// alone, and the answer must not move when the weight does.
const light = vaultFullness([{ name: 'herb', amount: 100 }]);
eq(light.binding, 'bulk', 'a vault is bulk-only');
ok(light.percent > 0 && light.percent < 100);
eq(vaultFullness([]).percent, 0, 'an empty vault is genuinely 0%');
eq(bulkFullness([{ name: 'herb', amount: 100 }], CHEST_BULK_MAX).percent,
   chestFullness([{ name: 'herb', amount: 100 }]).percent,
   'a chest is the same arithmetic against a bigger number');
ok(chestFullness([{ name: 'herb', amount: 100 }]).percent < light.percent,
   'and the same load is a smaller fraction of the bigger container');

// ------------------------------------------------------------------ the record
const dir = mkdtempSync(join(tmpdir(), 'm59-storage-'));
try {
  const cache = new StorageCache({ dir, now: () => 5000 });

  // NEVER LOOKED AND EMPTY ARE OPPOSITE FACTS about a store, and the whole point of the
  // board is to keep them apart. A guild that thinks a chest is empty when nobody has
  // opened it will not go and look.
  eq(cache.readVault('Piggy'), null, 'an unread vault is null, not an empty one');
  const chests = cache.allChests();
  eq(chests.length, GUILD_CHEST_SLOTS, 'always four slots');
  ok(chests.every(c => c.never_opened === true), 'and all of them start as never opened');
  ok(chests.every(c => c.items === null), 'with no item list, rather than an empty one');

  cache.writeVault('Piggy', [{ name: 'herb', amount: 40 }, { name: 'mace', amount: 1, fee: 12 }]);
  const v = cache.readVault('Piggy');
  eq(v.items.length, 2);
  eq(v.items[1].fee, 12, 'the retrieval fee is kept — it is what getting it back costs');
  eq(v.fullness.max, VAULT_BULK_MAX, 'and fullness comes back with the reading');
  ok(v.fullness.percent > 0);

  cache.writeChest(2, { object_id: 77, room: 714, items: [{ name: 'elderberry', amount: 300 }],
                        by: 'Piggy' });
  const c2 = cache.readChest(2);
  eq(c2.opened_by, 'Piggy');
  eq(c2.object_id, 77, 'addressed by object id — two chests in one room are two ids');
  eq(cache.allChests().filter(c => c.never_opened).length, GUILD_CHEST_SLOTS - 1,
     'writing one slot leaves the others honestly unopened');

  // A slot outside the hall's capacity is refused rather than silently filed somewhere.
  assert.throws(() => cache.writeChest(0, {}), /1\.\.4/); n++;
  assert.throws(() => cache.writeChest(GUILD_CHEST_SLOTS + 1, {}), /1\.\.4/); n++;

  // RENT HAS A SIGN AND THE SIGN IS THE WHOLE MEANING. Positive is a debt that loses the
  // hall; negative is credit. An unparsed answer stores as null and must never read as a
  // guild that owes nothing.
  cache.writeRent({ due: 4200, credit: -4200, in_guild: true, hours_left: 3,
                    said: 'owes 4200 coins in rent', by: 'Piggy' });
  eq(cache.readRent().due, 4200, 'positive is owed');
  eq(cache.readRent().hours_left, 3);
  cache.writeRent({ due: -900, credit: 900, in_guild: true, said: 'positive balance of 900' });
  eq(cache.readRent().due, -900, 'negative is credit');
  cache.writeRent({ due: null, in_guild: true, said: 'something nobody parsed' });
  eq(cache.readRent().due, null, 'and an unparsed answer is null, never zero');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`storage: ${n} assertions passed`);
