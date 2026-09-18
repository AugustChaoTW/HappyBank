'use strict';
// 授權。SPEC §7.1（身分一律以 session 判定，不接受前端指定 kidId）與 §8。
// 威脅模型是「自家小孩會開 DevTools 改參數」，不是外部攻擊者。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, accountOf } = require('./helpers/seed.js');

function setup() {
  const gs = freshBank();
  const momo = login(gs, 'momo');
  const coco = login(gs, 'coco');
  const aug = login(gs, 'aug');
  return {
    gs, momo, coco, aug,
    momoCurrent: accountOf(gs, 'momo', 'current'),
    cocoCurrent: accountOf(gs, 'coco', 'current')
  };
}

test('小孩 session 不能用 admin_adjust', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.momo, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 1000, clientId: 'x1'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(t.gs.$.rows('ledger').length, 0, '不能留下任何入帳');
});

test('小孩 session 不能用 admin_gift', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_gift', session: t.momo, kidId: 'momo', amount: 5000, clientId: 'x1'
  });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(t.gs.$.rows('ledger').length, 0);
});

test('小孩 session 不能用 admin_recalc', () => {
  const t = setup();
  assert.strictEqual(t.gs.$.call({ action: 'admin_recalc', session: t.momo }).error, 'unauthorized');
});

test('沒帶 session 的 admin_* 也是 unauthorized', () => {
  const t = setup();
  ['admin_adjust', 'admin_gift', 'admin_recalc'].forEach(action => {
    assert.strictEqual(t.gs.$.call({ action, kidId: 'momo', amount: 100 }).error, 'unauthorized');
  });
});

test('admin_adjust 的 kidId 與帳戶擁有者不符時拒絕（打錯字不該入到別人帳上）', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug,
    kidId: 'coco', accountId: t.momoCurrent.accountId,   // Coco 的名字配 Momo 的帳戶
    amount: 500, clientId: 'x1'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'kid-mismatch');
  assert.strictEqual(t.gs.accountBalance(t.momoCurrent.accountId), 0);
  assert.strictEqual(t.gs.accountBalance(t.cocoCurrent.accountId), 0);
});

test('admin_adjust 沒帶 kidId 時拒絕（不能靠 accountId 單獨過關）', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug,
    accountId: t.momoCurrent.accountId, amount: 500, clientId: 'x1'
  });
  assert.strictEqual(res.error, 'kid-mismatch');
});

test('admin_adjust 的 kidId 大小寫不敏感', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'MoMo',
    accountId: t.momoCurrent.accountId, amount: 500, clientId: 'x1'
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.balanceAfter, 500);
});

test('admin_adjust 不能動非 active 的帳戶', () => {
  const t = setup();
  const row = t.gs.$.rows('accounts').find(a => a.accountId === t.momoCurrent.accountId)._row;
  t.gs.$.setCell('accounts', row, 'status', 'closed');
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 500, clientId: 'x1'
  });
  assert.strictEqual(res.error, 'account-inactive');
});

test('admin_adjust 帳戶不存在回 no-account', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo', accountId: 'nope', amount: 5
  });
  assert.strictEqual(res.error, 'no-account');
});

test('admin_adjust 負數會記成 penalty，正數記成 adjust', () => {
  const t = setup();
  t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 200, clientId: 'x1'
  });
  t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: -50, clientId: 'x2'
  });
  const types = t.gs.$.rows('ledger').map(l => l.type);
  assert.deepStrictEqual(types, ['adjust', 'penalty']);
  assert.strictEqual(t.gs.accountBalance(t.momoCurrent.accountId), 150);
});

test('admin_gift 給不存在的小孩要拒絕，且不能憑空開戶', () => {
  const t = setup();
  const before = t.gs.$.rows('accounts').length;
  const res = t.gs.$.call({
    action: 'admin_gift', session: t.aug, kidId: 'mommo', amount: 600, clientId: 'x1'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no-kid');
  assert.strictEqual(t.gs.$.rows('accounts').length, before, '不該替不存在的小孩開帳戶');
  assert.strictEqual(t.gs.$.rows('ledger').length, 0, '錢不該憑空消失到虛構帳戶');
});

test('admin_gift 不能把紅包塞給家長帳號', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_gift', session: t.aug, kidId: 'vicky', amount: 600, clientId: 'x1'
  });
  assert.strictEqual(res.error, 'no-kid');
});

test('admin_gift 正常路徑：入到 gift 帳戶，不是 current', () => {
  const t = setup();
  const res = t.gs.$.call({
    action: 'admin_gift', session: t.aug, kidId: 'momo', amount: 600, clientId: 'x1'
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.balanceAfter, 600);
  const gift = accountOf(t.gs, 'momo', 'gift');
  assert.strictEqual(t.gs.accountBalance(gift.accountId), 600);
  assert.strictEqual(t.gs.accountBalance(t.momoCurrent.accountId), 0,
    '紅包必須留在 0% 的 gift 帳戶，讓小孩自己動手搬（SPEC §2）');
  assert.strictEqual(t.gs.$.rows('ledger')[0].type, 'gift_in');
});

test('admin_gift 也吃 clientId 冪等', () => {
  const t = setup();
  t.gs.$.call({ action: 'admin_gift', session: t.aug, kidId: 'momo', amount: 600, clientId: 'x1' });
  const again = t.gs.$.call({ action: 'admin_gift', session: t.aug, kidId: 'momo', amount: 600, clientId: 'x1' });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'gift').accountId), 600);
});

test('snapshot 完全忽略前端帶的 kidId，只給 session 主人的資料', () => {
  const t = setup();
  t.gs.$.call({ action: 'admin_gift', session: t.aug, kidId: 'coco', amount: 9999, clientId: 'x1' });

  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo, kidId: 'coco', userId: 'coco' });
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.user.userId, 'momo');
  assert.strictEqual(snap.kids, undefined, '小孩看不到全家一覽');

  const cocoIds = t.gs.$.rows('accounts')
    .filter(a => a.kidId === 'coco').map(a => a.accountId);
  snap.accounts.forEach(a => {
    assert.ok(!cocoIds.includes(a.accountId), 'Momo 不該看到 Coco 的帳戶');
  });
  assert.strictEqual(snap.accounts.reduce((n, a) => n + a.balance, 0), 0);
  assert.strictEqual(JSON.stringify(snap).indexOf('9999'), -1, 'Coco 的餘額不該外洩');
});

test('snapshot 的 ledger 只含自己的紀錄', () => {
  const t = setup();
  t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'coco',
    accountId: t.cocoCurrent.accountId, amount: 777, clientId: 'x1'
  });
  t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 111, clientId: 'x2'
  });
  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(snap.ledger.length, 1);
  assert.strictEqual(snap.ledger[0].amount, 111);
});

test('家長 snapshot 看得到全家，而且形狀符合 SPEC §7.1', () => {
  const t = setup();
  t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 300, clientId: 'x1'
  });
  const snap = t.gs.$.call({ action: 'snapshot', session: t.aug });
  assert.strictEqual(snap.user.role, 'parent');
  assert.strictEqual(snap.accounts, undefined, '家長端沒有自己的 accounts');
  // 家長端「要」有 chores：待審清單得顯示家事名稱與獎金，
  // 沒有的話前端只能靠寫死的對照表猜，家長一改標題就對不上。
  assert.ok(Array.isArray(snap.chores), '家長端要有 chores');
  assert.strictEqual(snap.kids.length, 2);
  const momo = snap.kids.find(k => k.user.userId === 'momo');
  assert.strictEqual(momo.total, 300);
  // dailyAllowance 逐人帶：待審清單上的簽到那筆在 pending 階段沒有金額（§7.1）
  assert.deepStrictEqual(Object.keys(momo).sort(),
    ['accounts', 'dailyAllowance', 'total', 'user']);
  assert.strictEqual(momo.dailyAllowance, 20);
});

test('whoami 只回公開欄位', () => {
  const t = setup();
  const res = t.gs.$.call({ action: 'whoami', session: t.momo });
  assert.deepStrictEqual(res.user, { userId: 'momo', role: 'kid', displayName: 'Momo', emoji: '👧' });
});

test('過期 session 打 admin_* 也是 unauthorized（不會先做事再檢查）', () => {
  const t = setup();
  const row = t.gs.$.rows('sessions').find(s => s.token === t.aug)._row;
  t.gs.$.setCell('sessions', row, 'expiresTs', new Date(Date.now() - 1000));
  const res = t.gs.$.call({
    action: 'admin_adjust', session: t.aug, kidId: 'momo',
    accountId: t.momoCurrent.accountId, amount: 500, clientId: 'x1'
  });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(t.gs.$.rows('ledger').length, 0);
});
