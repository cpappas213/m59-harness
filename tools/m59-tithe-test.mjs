#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TitheBook, parseRentHours, parseRentLine, tithePaymentPlan } from './m59-tithe.mjs';

const full = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 3_000, purse: 4_000, walkingMoney: 1_000 });
assert.equal(full.amount, 2_000, 'the daily amount caps one payment');

const partial = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 500,
  saleProceeds: 700, purse: 1_700, walkingMoney: 1_000 });
assert.equal(partial.amount, 700, 'a smaller sale makes a partial payment');

const reserve = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 2_000, purse: 2_500, walkingMoney: 1_000 });
assert.equal(reserve.amount, 1_500, 'walking money is never taxed');

const noSale = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 0, purse: 9_000, walkingMoney: 1_000 });
assert.equal(noSale.amount, 0, 'old purse is not sale proceeds');

assert.deepEqual(parseRentLine(['Thy guild owes 12000 coins in rent.']).due, 12_000);
assert.deepEqual(parseRentLine(['Thy guild has a positive balance of 4000 shillings.']).credit, 4_000);
assert.equal(parseRentHours(['You have 4 hours to pay.']), 4);

const dir = mkdtempSync(join(tmpdir(), 'm59-tithe-'));
try {
  const at = new Date(2026, 7, 12, 12).getTime();
  const book = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
  book.record(700, { at });
  book.record(300, { at: at + 60_000 });
  assert.equal(book.paidToday(at), 1_000, 'verified partials add within a day');
  assert.equal(book.paidToday(at + 24 * 60 * 60_000), 0, 'the next local day starts unpaid');
  const reopened = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
  assert.equal(reopened.paidToday(at), 1_000, 'the daily total survives restart');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('10 passed, 0 failed');
