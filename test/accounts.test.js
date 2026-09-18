'use strict';
// 自動開戶。SPEC §2：current 與 gift 每人各 1，自動建立。
// 這裡最怕的是「開了兩個活期帳戶」——之後入帳會散在兩邊，小孩的錢看起來就變少了。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, accountOf } = require('./helpers/seed.js');

function currents(gs, kidId) {
  return gs.$.rows('accounts').filter(a => String(a.kidId) === kidId && a.type === 'current');
}
function activeOf(gs, kidId, type) {
  return gs.$.rows('accounts')
    .filter(a => String(a.kidId) === kidId && a.type === type && a.status !== 'closed');
}

test('小孩第一次登入自動開好一個 current 與一個 gift', () => {
  const gs = freshBank({ users: ['momo'] });
  assert.strictEqual(gs.$.rows('accounts').length, 0, '建帳號時不該先開戶');

  login(gs, 'momo');

  const mine = gs.$.rows('accounts').filter(a => a.kidId === 'momo');
  assert.strictEqual(mine.length, 2);
  assert.deepStrictEqual(mine.map(a => a.type).sort(), ['current', 'gift']);

  const current = accountOf(gs, 'momo', 'current');
  assert.strictEqual(current.name, '我的活期帳戶');
  assert.strictEqual(current.emoji, '💰');
  assert.strictEqual(current.rateMonthly, 0.05, '活期月利率取自 config.rate_current');
  assert.strictEqual(current.balance, 0);
  assert.strictEqual(current.status, 'active');
  assert.strictEqual(current.lockUntil, '');
  assert.strictEqual(current.targetAmount, '');

  const gift = accountOf(gs, 'momo', 'gift');
  assert.strictEqual(gift.emoji, '🧧');
  assert.strictEqual(gift.rateMonthly, 0, '紅包帳戶是 0%，這是整堂課的重點（SPEC §2）');
});

test('家長登入不會被開戶', () => {
  const gs = freshBank({ users: ['aug'] });
  login(gs, 'aug');
  assert.strictEqual(gs.$.rows('accounts').length, 0);
});

test('ensureDefaultAccounts 呼叫兩次不會開出重複帳戶', () => {
  const gs = freshBank({ users: ['momo'] });
  gs.ensureDefaultAccounts('momo');
  gs.ensureDefaultAccounts('momo');
  gs.ensureDefaultAccounts('momo');
  assert.strictEqual(gs.$.rows('accounts').length, 2);
});

test('反覆登入 + snapshot 也只會有兩個帳戶', () => {
  const gs = freshBank({ users: ['momo'] });
  const a = login(gs, 'momo');
  const b = login(gs, 'momo');
  gs.$.call({ action: 'snapshot', session: a });
  gs.$.call({ action: 'snapshot', session: b });
  assert.strictEqual(currents(gs, 'momo').length, 1);
  assert.strictEqual(gs.$.rows('accounts').length, 2);
});

test('每個小孩各有自己的一組帳戶', () => {
  const gs = freshBank();
  login(gs, 'momo');
  login(gs, 'coco');
  assert.strictEqual(activeOf(gs, 'momo', 'current').length, 1);
  assert.strictEqual(activeOf(gs, 'coco', 'current').length, 1);
  assert.notStrictEqual(accountOf(gs, 'momo', 'current').accountId,
    accountOf(gs, 'coco', 'current').accountId);
});

test('帳戶被 closed 之後會重新補一個，舊的留在表上當歷史', () => {
  const gs = freshBank({ users: ['momo'] });
  login(gs, 'momo');
  const old = accountOf(gs, 'momo', 'current');
  const row = gs.$.rows('accounts').find(a => a.accountId === old.accountId)._row;
  gs.$.setCell('accounts', row, 'status', 'closed');

  gs.ensureDefaultAccounts('momo');

  assert.strictEqual(currents(gs, 'momo').length, 2, '關掉的帳戶要保留，不能就地復活');
  const active = activeOf(gs, 'momo', 'current');
  assert.strictEqual(active.length, 1, '同時間只能有一個可用的活期帳戶');
  assert.notStrictEqual(active[0].accountId, old.accountId);
});

test('closed 的帳戶不會出現在 snapshot 裡', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const gift = accountOf(gs, 'momo', 'gift');
  const row = gs.$.rows('accounts').find(a => a.accountId === gift.accountId)._row;
  gs.$.setCell('accounts', row, 'status', 'closed');

  const snap = gs.$.call({ action: 'snapshot', session });
  const ids = snap.accounts.map(a => a.accountId);
  assert.ok(!ids.includes(gift.accountId), 'closed 帳戶不該出現');
  // 但 gift 會被自動補一個回來（SPEC §2：每人 1，自動建立）
  assert.strictEqual(snap.accounts.filter(a => a.type === 'gift').length, 1);
});

test('ensureDefaultAccounts 傳空值時什麼都不做', () => {
  const gs = freshBank({ users: ['momo'] });
  ['', null, undefined].forEach(v => gs.ensureDefaultAccounts(v));
  assert.strictEqual(gs.$.rows('accounts').length, 0);
});

test('snapshot 的帳戶欄位型別照 SPEC §7.1：targetAmount / lockUntil 沒設就是 null', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const snap = gs.$.call({ action: 'snapshot', session });
  snap.accounts.forEach(a => {
    assert.strictEqual(a.targetAmount, null, '沒設目標金額要是 null，不是 0');
    assert.strictEqual(a.lockUntil, null);
    assert.strictEqual(typeof a.balance, 'number');
    assert.strictEqual(typeof a.rateMonthly, 'number');
    assert.deepStrictEqual(Object.keys(a).sort(),
      ['accountId', 'balance', 'emoji', 'lockUntil', 'name', 'rateMonthly', 'status', 'targetAmount', 'type']);
  });
});

test('config 的利率被清空時，開戶會退回 SPEC 的預設值而不是 0', () => {
  const gs = freshBank({ users: ['momo'] });
  const row = gs.$.rows('config').find(c => c.key === 'rate_current')._row;
  gs.$.setCell('config', row, 'value', '');
  gs.ensureDefaultAccounts('momo');
  assert.strictEqual(accountOf(gs, 'momo', 'current').rateMonthly, 0.05,
    'config 被誤清不該讓小孩的活期變成 0% 利率');
});
