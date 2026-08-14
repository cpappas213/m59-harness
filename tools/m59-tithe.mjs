// GUILD TITHES — exact payment plus the durable once-per-day book.
//
// The server provides no tithe ledger. Frular accepts shillings by cancelling an offer,
// so the only proof is that the payer's purse fell. The book therefore records only the
// verified purse delta, never the intended offer, and survives broker/keeper restarts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

// WHICH FLEET'S BOOK, ANSWERED ONCE.
//
// The book is keyed `<fleet>-<agent>.json`, so two answers to "which fleet" are two books
// for the same character — and the failure is quiet in the expensive direction: a keeper
// writing to `default-t14` while a tool reads `prod-t14` sees `paid_today: 0` all day and
// tithes again every time it sells. The keeper derived the name from argv/env with a
// literal 'default' fallback while the broker resolved it properly, so a broker started
// with no `--fleet` but a `substrate/fleet-default` of `prod` split them. `fleetName()` is
// the same resolver every other fleet tool uses, in the same order.
export const titheFleet = (argv, env) => fleetName(argv, env) || 'default';

export const FRULAR_ROOM = 700;
export const FRULAR_NAME = 'Frular';

export function parseRentLine(lines) {
  for (const raw of [].concat(lines ?? [])) {
    const text = String(raw);
    if (/belongest to no guild/i.test(text))
      return { in_guild: false, due: null, credit: null, said: text };
    let match = text.match(/owes\s+(\d+)\s+coins?\s+in\s+rent/i);
    if (match) return { in_guild: true, due: Number(match[1]), credit: -Number(match[1]), said: text };
    match = text.match(/has a positive balance of\s+(\d+)\s+shillings?/i);
    if (match) return { in_guild: true, due: -Number(match[1]), credit: Number(match[1]), said: text };
    if (/owest\s+no\s+rent/i.test(text))
      return { in_guild: true, due: 0, credit: 0, said: text };
  }
  return null;
}

export function parseRentHours(lines) {
  for (const raw of [].concat(lines ?? [])) {
    const text = String(raw);
    if (/less than an hour/i.test(text)) return 0.5;
    if (/have an hour to pay/i.test(text)) return 1;
    const match = text.match(/have\s+(\d+)\s+hours?\s+to pay/i);
    if (match) return Number(match[1]);
  }
  return null;
}

export const TITHE_DIR = process.env.M59_TITHE_DIR ||
  fileURLToPath(new URL('../substrate/guild-tithes', import.meta.url));

const safe = value => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'unnamed';

export function localDayKey(at = Date.now()) {
  const d = new Date(at);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}

export function tithePaymentPlan({ dailyAmount, paidToday = 0, saleProceeds = 0,
                                   purse = 0, walkingMoney = 0 } = {}) {
  const target = Math.max(0, Math.floor(Number(dailyAmount) || 0));
  const paid = Math.max(0, Math.floor(Number(paidToday) || 0));
  const remaining = Math.max(0, target - paid);
  const proceeds = Math.max(0, Math.floor(Number(saleProceeds) || 0));
  const available = Math.max(0, Math.floor(Number(purse) || 0) -
    Math.max(0, Math.floor(Number(walkingMoney) || 0)));
  const amount = Math.min(remaining, proceeds, available);
  return { target, paid, remaining, proceeds, available, amount };
}

export class TitheBook {
  constructor({ agent, fleet = 'default', dir = TITHE_DIR } = {}) {
    this.agent = safe(agent);
    this.fleet = safe(fleet);
    this.dir = resolve(dir);
    this.path = join(this.dir, `${this.fleet}-${this.agent}.json`);
  }

  read() {
    if (!existsSync(this.path)) return { days: {} };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value, days: value.days && typeof value.days === 'object' ? value.days : {} }
        : { days: {} };
    } catch { return { days: {} }; }
  }

  paidToday(at = Date.now()) {
    return Math.max(0, Number(this.read().days[localDayKey(at)]?.paid) || 0);
  }

  record(paid, { at = Date.now(), detail = {} } = {}) {
    const amount = Math.max(0, Math.floor(Number(paid) || 0));
    if (!amount) return this.read();
    const all = this.read(), day = localDayKey(at);
    const was = all.days[day] ?? {};
    all.agent = this.agent;
    all.fleet = this.fleet;
    all.days[day] = { ...was, paid: (Number(was.paid) || 0) + amount,
      last_at: at, ...detail };
    // A year is more than this decision needs and bounds an unattended fleet's state.
    const keys = Object.keys(all.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 370))) delete all.days[old];
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, this.path);
    return all;
  }
}

export const purseAmount = c => (c.inventory || [])
  .filter(i => (c.rsc.get(i.nameRsc) || '').toLowerCase() === 'shilling')
  .reduce((n, i) => n + (i.amount ?? 1), 0);

async function askRent(s, c) {
  const before = c.evSeq;
  await s.pacer.submit('say', () => c.say('rent'));
  const { events } = await c.waitFor({ since: before, timeoutMs: 4000 });
  const said = events.filter(e => e.text).map(e => String(e.text));
  return { said, rent: parseRentLine(said), hours_left: parseRentHours(said) };
}

export async function guildRentStatus(s) {
  const c = s.need(), room = s.world?.room?.num ?? null;
  const frular = [...(c.room?.objects?.values() ?? [])]
    .find(o => (c.rsc.get(o.nameRsc) || '') === FRULAR_NAME);
  if (!frular) return { ok: false, reason: `${FRULAR_NAME} is not in this room`, room,
    go_to: FRULAR_ROOM,
    note: `travel to ${FRULAR_ROOM} (The Guildmaster's Hall, Barloque)` };
  const r = await askRent(s, c);
  return { action: 'status', room, purse: purseAmount(c), due: r.rent?.due ?? null,
    credit: r.rent?.credit ?? null, hours_until_arrears: r.hours_left,
    frular_said: r.said };
}

export async function payGuildTithe(s, { amount = 0, all = false } = {}) {
  const c = s.need(), room = s.world?.room?.num ?? null;
  const frular = [...(c.room?.objects?.values() ?? [])]
    .find(o => (c.rsc.get(o.nameRsc) || '') === FRULAR_NAME);
  if (!frular) return { ok: false, reason: `${FRULAR_NAME} is not in this room`, room,
    go_to: FRULAR_ROOM };

  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
  const stack = (c.inventory || [])
    .find(i => (c.rsc.get(i.nameRsc) || '').toLowerCase() === 'shilling');
  const have = stack ? (stack.amount ?? 1) : 0;
  if (!stack || have < 1) return { ok: false, reason: 'carrying no shillings', purse: 0 };
  const asked = all ? have : Math.floor(Number(amount) || 0);
  if (!(asked > 0)) throw new Error('pay needs a positive `amount`, or all:true');
  const offered = Math.min(asked, have);

  const before = c.evSeq;
  await s.pacer.submit('trade', () => c.offer(frular.id, [{ id: stack.id, amount: offered }]));
  const { events } = await c.waitFor({ since: before, timeoutMs: 5000 });
  const said = events.filter(e => e.text).map(e => String(e.text));
  await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 800));
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
  const after = purseAmount(c), paid = have - after;
  const r = await askRent(s, c);
  return { action: 'pay', room, offered, purse_before: have, purse_after: after,
    paid, ok: paid > 0, thanked: said.some(x => /thank thee for thy payment/i.test(x)),
    frular_said: said, due: r.rent?.due ?? null, credit: r.rent?.credit ?? null,
    hours_until_arrears: r.hours_left };
}
