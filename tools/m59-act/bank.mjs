#!/usr/bin/env node
// m59-act/bank.mjs -- DEPOSIT OR WITHDRAW SHILLINGS AT A BANKER.
//
// Banking is a USERCOMMAND, not a trade. The banker is in the room, the
// character says "deposit 500" or "withdraw 300", and the server moves the
// money between the purse and the vault. No offer, no counter, no trade
// protocol — one command, one result.
//
// THE TWO COMMANDS:
//   deposit(n)   ->  UC.DEPOSIT (35)  {4, u32(n)}
//   withdraw(n)  ->  UC.WITHDRAW (36) {4, u32(n)}
//
// WHAT THE ATOMIC CHECKS BEFORE SENDING:
//   DEPOSIT: the purse has at least n. The server refuses a deposit larger
//   than the purse, but checking locally saves a round-trip.
//   WITHDRAW: nothing. The vault balance is server-side and not readable
//   over the wire (the balance() command returns it, but it is a separate
//   round-trip). A withdraw that exceeds the vault is refused by the server
//   and the refusal is a message.
//
// WHAT IT DOES NOT DO:
//   IT DOES NOT WALK. The banker must be in the room. A planner that needs
//   to travel to a bank plans the travel separately.
//   IT DOES NOT REFRESH THE PURSE. The purse is updated by a BP_STAT push
//   (group 2, slot 8 — actually the purse is not a stat, it is in the
//   inventory as the gold object). The caller re-reads when it needs the
//   new purse value.
//   IT DOES NOT BALANCE. Reading the vault balance is a separate command
//   (UC.BALANCE) and a separate concern. A planner that needs to know how
//   much is in the vault reads it before planning the withdraw.

/**
 * deposit(client, session, { amount, waitMs })
 *
 * Deposits shillings from the purse to the vault.
 * Returns { sent, amount, reason }.
 */
export async function deposit(client, session, { amount, waitMs = 1000 } = {}) {
  if (!client || !session) return { sent: false, amount: 0, reason: 'no client or session' };
  if (amount == null || amount <= 0)
    return { sent: false, amount: 0, reason: 'no amount' };

  // The purse check. A courtesy — the server's refusal is the real answer.
  // The purse is the sum of shilling objects in the inventory.
  const purse = (client.inventory ?? [])
    .filter(o => /shilling/i.test(client.rsc?.get?.(o.nameRsc) ?? ''))
    .reduce((sum, o) => sum + (o.amount ?? 1), 0);
  if (purse < amount)
    return { sent: false, amount: 0, reason: `purse has ${purse}, cannot deposit ${amount}` };

  const before = client.evSeq ?? 0;
  await session.pacer.submit('bank', () => client.deposit(amount), waitMs).catch(() => {});
  const ev = await client.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  const refusal = msgs.find(m => /cannot|refuse|not enough|unable/i.test(m));
  if (refusal) return { sent: true, amount: 0, reason: refusal };

  return { sent: true, amount, reason: null };
}

deposit.pre     = [];
deposit.effects = [];   // the purse drops and the vault rises. Neither is a
                        // vocabulary symbol.
deposit.atomic  = 'deposit';
deposit.mutates = true;  // sends a mutation packet (UC.DEPOSIT);

/**
 * withdraw(client, session, { amount, waitMs })
 *
 * Withdraws shillings from the vault to the purse.
 * Returns { sent, amount, reason }.
 */
export async function withdraw(client, session, { amount, waitMs = 1000 } = {}) {
  if (!client || !session) return { sent: false, amount: 0, reason: 'no client or session' };
  // ABSENT AND ZERO ARE DIFFERENT REQUESTS. The planner asks for "a withdrawal"
  // without a figure -- it cannot know the vault balance -- and that means "as much as
  // is there", so an absent amount becomes a large ask and the server gives what it has.
  // An EXPLICIT zero or negative is a caller with a bug, and quietly turning that into
  // a maximal withdrawal is wrong in the expensive direction, so it is refused.
  if (amount == null) amount = 10000;
  if (!(amount > 0)) return { sent: false, amount: 0, reason: 'no amount to withdraw' };

  const before = client.evSeq ?? 0;
  await session.pacer.submit('bank', () => client.withdraw(amount), waitMs).catch(() => {});
  const ev = await client.waitFor({ since: before, kinds: ['message', 'inventory'], timeoutMs: waitMs })
                .catch(() => ({ events: [] }));

  const msgs = (ev.events ?? []).filter(e => e.text).map(e => e.text);
  const refusal = msgs.find(m => /cannot|refuse|not enough|unable|no gold/i.test(m));
  if (refusal) return { sent: true, amount: 0, reason: refusal };

  return { sent: true, amount, reason: null };
}

withdraw.pre     = ['at_bank'];
withdraw.effects = ['has_money'];  // withdrawing puts gold in the purse
withdraw.atomic  = 'withdraw';
withdraw.mutates = true;  // sends a mutation packet (UC.WITHDRAW);
