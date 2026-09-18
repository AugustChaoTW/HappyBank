'use strict';
// num() 與 toIso()：Sheets 的格子隨時可能是空的、或被手改成怪東西。
// 這兩個函式是整個後端的「輸入衛生」底線。

const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./helpers/load-gs.js');

const gs = loadGs();

test('num：空值一律吃 fallback，不要變成 0', () => {
  assert.strictEqual(gs.num('', 5), 5);
  assert.strictEqual(gs.num(null, 5), 5);
  assert.strictEqual(gs.num(undefined, 5), 5);
});

test('num：0 是合法的值，不能被 fallback 蓋掉', () => {
  assert.strictEqual(gs.num(0, 5), 0);
  assert.strictEqual(gs.num('0', 5), 0);
  assert.strictEqual(gs.num(0, 0.05), 0);
});

test('num：數字字串要轉成數字', () => {
  assert.strictEqual(gs.num('3', 5), 3);
  assert.strictEqual(gs.num('0.05', 1), 0.05);
  assert.strictEqual(gs.num('-12', 0), -12);
  assert.strictEqual(gs.num(7, 5), 7);
});

test('num：不是數字就吃 fallback', () => {
  assert.strictEqual(gs.num('abc', 5), 5);
  assert.strictEqual(gs.num('12元', 5), 5);
  assert.strictEqual(gs.num(NaN, 5), 5);
  assert.strictEqual(gs.num({}, 5), 5);
});

test('num：fallback 本身可以是任何值', () => {
  assert.strictEqual(gs.num('', 0.05), 0.05);
  assert.strictEqual(gs.num('abc', null), null);
});

test('toIso：空值回 null', () => {
  assert.strictEqual(gs.toIso(''), null);
  assert.strictEqual(gs.toIso(null), null);
  assert.strictEqual(gs.toIso(undefined), null);
});

test('toIso：怪字串回 null 而不是丟 RangeError', () => {
  assert.strictEqual(gs.toIso('not a date'), null);
  assert.strictEqual(gs.toIso('待補'), null);
  assert.strictEqual(gs.toIso({}), null);
});

test('toIso：合法日期回 ISO 字串', () => {
  const d = new Date('2026-09-18T01:23:45.000Z');
  assert.strictEqual(gs.toIso(d), '2026-09-18T01:23:45.000Z');
  assert.strictEqual(gs.toIso('2026-09-18T01:23:45.000Z'), '2026-09-18T01:23:45.000Z');
  assert.strictEqual(gs.toIso(d.getTime()), '2026-09-18T01:23:45.000Z');
});

test('isTrue：Sheets 的真布林與手打的 TRUE 都要認', () => {
  assert.strictEqual(gs.isTrue(true), true);
  assert.strictEqual(gs.isTrue('TRUE'), true);
  assert.strictEqual(gs.isTrue('true'), true);
  assert.strictEqual(gs.isTrue(false), false);
  assert.strictEqual(gs.isTrue(''), false);
  assert.strictEqual(gs.isTrue('FALSE'), false);
});
