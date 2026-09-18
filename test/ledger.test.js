'use strict';
// postLedger 是唯一的寫帳入口。SPEC §7.3（冪等與並發）與 §3（整數元）。
// 這一檔要守住的是「錢不會憑空多出來，也不會憑空消失」。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, accountOf, USERS } = require('./helpers/seed.js');

function bank() {
  const gs = freshBank();
  login(gs, 'momo');                       // 觸發自動開戶
  return { gs, current: accountOf(gs, 'momo', 'current'), gift: accountOf(gs, 'momo', 'gift') };
}

test('同一個 clientId 送兩次只入帳一次，第二次回報 duplicate', () => {
  const { gs, current } = bank();
  const opts = { accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'cid-retry-1' };

  const first = gs.$.plain(gs.postLedger(opts));
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.balanceAfter, 100);
  assert.strictEqual(first.duplicate, undefined);

  const second = gs.$.plain(gs.postLedger(opts));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.duplicate, true, '離線佇列重送不能重複入帳（SPEC §7.3）');
  assert.strictEqual(second.balanceAfter, 100, 'duplicate 要回原本那筆的 balanceAfter');

  assert.strictEqual(gs.$.rows('ledger').length, 1, 'ledger 只能有一筆');
  assert.strictEqual(gs.accountBalance(current.accountId), 100);
});

test('不同 clientId 是不同筆，會各自入帳', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'a' });
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'b' });
  assert.strictEqual(gs.accountBalance(current.accountId), 200);
});

test('沒帶 clientId 的兩筆不會被誤判成重複', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 10 });
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 10 });
  assert.strictEqual(gs.$.rows('ledger').length, 2);
  assert.strictEqual(gs.accountBalance(current.accountId), 20);
});

test('餘額由 ledger 加總得出：accounts.balance 被亂改也不影響 balanceAfter', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'c1' });

  // 有人（或上次寫到一半的請求）把快取欄寫壞了
  const row = gs.$.rows('accounts').find(a => a.accountId === current.accountId)._row;
  gs.$.setCell('accounts', row, 'balance', 999999);

  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'adjust', amount: 50, clientId: 'c2'
  }));
  assert.strictEqual(res.balanceAfter, 150, '要以 ledger 加總為準，不能信 accounts.balance');
  assert.strictEqual(gs.accountBalance(current.accountId), 150);
});

test('accounts.balance 被寫成怪字串時也不會污染計算', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 80, clientId: 'c1' });
  const row = gs.$.rows('accounts').find(a => a.accountId === current.accountId)._row;
  gs.$.setCell('accounts', row, 'balance', '待確認');
  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'adjust', amount: 20, clientId: 'c2'
  }));
  assert.strictEqual(res.balanceAfter, 100);
});

test('每次寫帳後 accounts.balance 這個快取欄會被更新', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 42, clientId: 'c1' });
  const acc = gs.$.rows('accounts').find(a => a.accountId === current.accountId);
  assert.strictEqual(gs.num(acc.balance, -1), 42);
});

test('超過餘額的提領被擋下來，並且什麼都不寫', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'c1' });

  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'withdraw', amount: -101, clientId: 'c2'
  }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'insufficient');
  assert.match(res.message, /100/);
  assert.strictEqual(gs.$.rows('ledger').length, 1, '被擋下來就不該留下 ledger 紀錄');
  assert.strictEqual(gs.accountBalance(current.accountId), 100);
});

test('剛好領到 0 元是可以的', () => {
  const { gs, current } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'c1' });
  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'withdraw', amount: -100, clientId: 'c2'
  }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.balanceAfter, 0);
});

test('allowNegative 可以把餘額壓到負數（家長罰款用）', () => {
  const { gs, current } = bank();
  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'penalty', amount: -50,
    clientId: 'c1', allowNegative: true
  }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.balanceAfter, -50);
  assert.strictEqual(gs.accountBalance(current.accountId), -50);
});

test('amount 為 0（或空、或非數字）一律拒絕', () => {
  const { gs, current } = bank();
  [0, '0', '', null, undefined, 'abc', 0.4].forEach(amount => {
    const res = gs.$.plain(gs.postLedger({
      accountId: current.accountId, type: 'adjust', amount
    }));
    assert.strictEqual(res.ok, false, 'amount=' + JSON.stringify(amount) + ' 應該被拒絕');
    assert.strictEqual(res.error, 'zero-amount');
  });
  assert.strictEqual(gs.$.rows('ledger').length, 0);
});

test('金額一律四捨五入成整數元（SPEC §3）', () => {
  const { gs, current } = bank();
  const res = gs.$.plain(gs.postLedger({
    accountId: current.accountId, type: 'interest', amount: 12.6, clientId: 'c1'
  }));
  assert.strictEqual(res.balanceAfter, 13);
  assert.strictEqual(gs.$.rows('ledger')[0].amount, 13);
});

test('帳戶不存在回 no-account', () => {
  const { gs } = bank();
  const res = gs.$.plain(gs.postLedger({ accountId: 'nope', type: 'adjust', amount: 10 }));
  assert.strictEqual(res.error, 'no-account');
});

test('ledger 紀錄會帶上 kidId / by / clientId，事後查得出來是誰做的', () => {
  const { gs, current } = bank();
  gs.postLedger({
    accountId: current.accountId, type: 'adjust', amount: 30,
    memo: '幫忙洗車', by: 'aug', clientId: 'c1', refId: 'req-9'
  });
  const l = gs.$.rows('ledger')[0];
  assert.strictEqual(l.kidId, 'momo');
  assert.strictEqual(l.accountId, current.accountId);
  assert.strictEqual(l.type, 'adjust');
  assert.strictEqual(l.amount, 30);
  assert.strictEqual(l.balanceAfter, 30);
  assert.strictEqual(l.memo, '幫忙洗車');
  assert.strictEqual(l.by, 'aug');
  assert.strictEqual(l.refId, 'req-9');
  assert.strictEqual(l.clientId, 'c1');
  // vm 與 host 是不同 realm，跨界的 Date 不會通過 instanceof
  assert.strictEqual(Object.prototype.toString.call(l.ts), '[object Date]');
});

test('各帳戶餘額互不相干', () => {
  const { gs, current, gift } = bank();
  gs.postLedger({ accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'a' });
  gs.postLedger({ accountId: gift.accountId, type: 'gift_in', amount: 600, clientId: 'b' });
  assert.strictEqual(gs.accountBalance(current.accountId), 100);
  assert.strictEqual(gs.accountBalance(gift.accountId), 600);
});

test('拿不到鎖時整筆寫帳放棄，回 busy', () => {
  const { gs, current } = bank();
  gs.$.lock.failWaitLock = true;
  assert.throws(() => gs.postLedger({
    accountId: current.accountId, type: 'adjust', amount: 100, clientId: 'c1'
  }), /BUSY:/);
  assert.strictEqual(gs.$.rows('ledger').length, 0);
});

test('admin_recalc 會把被改壞的 accounts.balance 與歷史 balanceAfter 一起修好', () => {
  const gs = freshBank();
  login(gs, 'momo');
  const parent = login(gs, 'aug');
  const current = accountOf(gs, 'momo', 'current');

  gs.$.call({ action: 'admin_adjust', session: parent, kidId: 'momo', accountId: current.accountId, amount: 100, clientId: 'r1' });
  gs.$.call({ action: 'admin_adjust', session: parent, kidId: 'momo', accountId: current.accountId, amount: 50, clientId: 'r2' });

  const accRow = gs.$.rows('accounts').find(a => a.accountId === current.accountId)._row;
  gs.$.setCell('accounts', accRow, 'balance', 7);
  const ledRow = gs.$.rows('ledger')[0]._row;
  gs.$.setCell('ledger', ledRow, 'balanceAfter', 12345);

  const res = gs.$.call({ action: 'admin_recalc', session: parent });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.fixedLedgerRows, 1);
  assert.deepStrictEqual(res.fixed, [{ accountId: current.accountId, was: 7, now: 150 }]);

  assert.strictEqual(gs.$.rows('ledger')[0].balanceAfter, 100);
  assert.strictEqual(gs.$.rows('accounts').find(a => a.accountId === current.accountId).balance, 150);
});

test('admin_recalc 在資料本來就對的時候不亂改東西', () => {
  const gs = freshBank();
  login(gs, 'momo');
  const parent = login(gs, 'aug');
  const current = accountOf(gs, 'momo', 'current');
  gs.$.call({ action: 'admin_adjust', session: parent, kidId: 'momo', accountId: current.accountId, amount: 100, clientId: 'r1' });

  const res = gs.$.call({ action: 'admin_recalc', session: parent });
  assert.deepStrictEqual(res.fixed, []);
  assert.strictEqual(res.fixedLedgerRows, 0);
});

test('admin_gift 不該把紅包入到已關閉的 gift 帳戶', () => {
  const gs = freshBank();
  const parent = login(gs, 'aug');
  login(gs, 'momo');

  // 情境：家長把舊的紅包帳戶關掉（換了新的），系統自動補了一個新的
  const old = accountOf(gs, 'momo', 'gift');
  const row = gs.$.rows('accounts').find(a => a.accountId === old.accountId)._row;
  gs.$.setCell('accounts', row, 'status', 'closed');

  const res = gs.$.call({
    action: 'admin_gift', session: parent, kidId: 'momo', amount: 600, clientId: 'g1'
  });
  assert.strictEqual(res.ok, true);

  // 挑帳戶時若沒排除 closed，錢會入到已關閉的帳戶；
  // accountsOf() 會把 closed 濾掉，於是這筆錢在所有畫面上消失，只剩 ledger 裡有。
  const active = gs.$.rows('accounts')
    .find(a => a.kidId === 'momo' && a.type === 'gift' && a.status === 'active');
  assert.strictEqual(gs.accountBalance(active.accountId), 600,
    '紅包要入到還在用的那個 gift 帳戶');

  const snap = gs.$.call({ action: 'snapshot', session: login(gs, 'momo') });
  assert.strictEqual(snap.accounts.reduce((n, a) => n + a.balance, 0), 600,
    '小孩必須看得到這 600 元');
});

test('clientId 的冪等比對必須區分大小寫', () => {
  const gs = freshBank();
  const parent = login(gs, 'aug');
  login(gs, 'momo');
  const cur = accountOf(gs, 'momo', 'current');

  const a = gs.$.call({ action: 'admin_adjust', session: parent, kidId: 'momo',
    accountId: cur.accountId, amount: 100, memo: '第一筆', clientId: 'ABC-123' });
  // 只差大小寫 = 不同的兩筆交易。若比對時把兩邊轉小寫，第二筆會被誤判成重複而消失。
  const b = gs.$.call({ action: 'admin_adjust', session: parent, kidId: 'momo',
    accountId: cur.accountId, amount: 100, memo: '第二筆', clientId: 'abc-123' });

  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.notStrictEqual(b.duplicate, true, '大小寫不同就不是同一筆，不該被當成重複');
  assert.strictEqual(gs.accountBalance(cur.accountId), 200, '兩筆都要入帳');
});
