'use strict';
// js/money.js —— 前端顯示用的算式。
// monthlyInterest 必須與伺服器端同一條式子（SPEC §3、§4），
// 不然畫面上的「下個月會變成 ○○」跟真的入帳金額對不起來，小孩會來吵。

const test = require('node:test');
const assert = require('node:assert');
const { loadBrowserModule } = require('./helpers/load-browser.js');

const Money = loadBrowserModule('js/money.js', 'Money');

function isoDaysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

test('format：整數元、千分位', () => {
  assert.strictEqual(Money.format(0), '0');
  assert.strictEqual(Money.format(7), '7');
  assert.strictEqual(Money.format(1234), '1,234');
  assert.strictEqual(Money.format(1234567), '1,234,567');
  assert.strictEqual(Money.format(-250), '-250');
});

test('format：小數四捨五入，不顯示小數點', () => {
  assert.strictEqual(Money.format(12.4), '12');
  assert.strictEqual(Money.format(12.5), '13');
  assert.strictEqual(Money.format('88.6'), '89');
});

test('format：空值與怪東西一律當 0，不要印出 NaN', () => {
  [null, undefined, '', 'abc', NaN, {}].forEach(v => {
    assert.strictEqual(Money.format(v), '0', String(v) + ' 應該顯示 0');
  });
});

test('monthlyInterest：Math.round，不足 1 元就是 0 元', () => {
  assert.strictEqual(Money.monthlyInterest(100, 0.05), 5);
  assert.strictEqual(Money.monthlyInterest(1000, 0.1), 100);
  assert.strictEqual(Money.monthlyInterest(19, 0.05), 1);   // 0.95 → 1
  assert.strictEqual(Money.monthlyInterest(9, 0.05), 0);    // 0.45 → 0
  assert.strictEqual(Money.monthlyInterest(10, 0.05), 1);   // 0.5  → 1（Math.round 往上）
  assert.strictEqual(Money.monthlyInterest(0, 0.05), 0);
});

test('monthlyInterest：0% 的紅包帳戶永遠沒有利息', () => {
  assert.strictEqual(Money.monthlyInterest(99999, 0), 0);
});

test('monthlyInterest：空值不要變成 NaN', () => {
  assert.strictEqual(Money.monthlyInterest(null, null), 0);
  assert.strictEqual(Money.monthlyInterest('abc', 0.05), 0);
  assert.strictEqual(Money.monthlyInterest(100, 'abc'), 0);
});

test('weeksToTarget：已達標或不會成長時回 null', () => {
  assert.strictEqual(Money.weeksToTarget(500, 500, 50), null);
  assert.strictEqual(Money.weeksToTarget(600, 500, 50), null);
  assert.strictEqual(Money.weeksToTarget(0, 500, 0), null);
});

test('weeksToTarget：無條件進位（差一點也要多等一週）', () => {
  assert.strictEqual(Money.weeksToTarget(0, 500, 50), 10);
  assert.strictEqual(Money.weeksToTarget(0, 501, 50), 11);
  assert.strictEqual(Money.weeksToTarget(100, 500, 50), 8);
});

test('daysUntil：以「天」為單位，今天是 0', () => {
  assert.strictEqual(Money.daysUntil(isoDaysFromToday(0)), 0);
  assert.strictEqual(Money.daysUntil(isoDaysFromToday(1)), 1);
  assert.strictEqual(Money.daysUntil(isoDaysFromToday(30)), 30);
  assert.strictEqual(Money.daysUntil(isoDaysFromToday(-1)), -1, '過期回負數');
});

test('daysUntil：今天稍早與今天稍晚都算同一天（不是看 24 小時）', () => {
  const start = new Date(); start.setHours(0, 1, 0, 0);
  const end = new Date(); end.setHours(23, 59, 0, 0);
  assert.strictEqual(Money.daysUntil(start.toISOString()), 0);
  assert.strictEqual(Money.daysUntil(end.toISOString()), 0);
});

test('daysUntil：空值與怪字串回 null', () => {
  [null, undefined, '', 'not a date'].forEach(v => {
    assert.strictEqual(Money.daysUntil(v), null, String(v) + ' 應該回 null');
  });
});

test('formatDate：yyyy/MM/dd，補零', () => {
  assert.strictEqual(Money.formatDate('2026-12-18T00:00:00'), '2026/12/18');
  assert.strictEqual(Money.formatDate('2026-01-05T00:00:00'), '2026/01/05');
});

test('formatDate：空值與怪字串回空字串（畫面不要出現 Invalid Date）', () => {
  [null, undefined, '', 'not a date'].forEach(v => {
    assert.strictEqual(Money.formatDate(v), '', String(v) + ' 應該回空字串');
  });
});

test('formatWhen：今天只講時間，其他日子補上日期', () => {
  const today = new Date(); today.setHours(9, 5, 0, 0);
  assert.strictEqual(Money.formatWhen(today.toISOString()), '今天 09:05');

  const past = new Date(); past.setDate(past.getDate() - 3); past.setHours(21, 30, 0, 0);
  assert.strictEqual(Money.formatWhen(past.toISOString()), Money.formatDate(past.toISOString()) + ' 21:30');

  assert.strictEqual(Money.formatWhen(''), '');
  assert.strictEqual(Money.formatWhen('not a date'), '');
});
