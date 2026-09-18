'use strict';
// js/admin.js 的純函式部分（家長待審清單）。
// 只測「會讓家長按錯、或讓錢多入一次」的邏輯：分組排序、代理確認的狀態機、
// 退回沒理由能不能送、待審件數、錯誤碼翻譯。
// 縮圖抓取、DOM 事件、批次送出的網路部分不在這裡測——沒有瀏覽器就沒有意義。

const test = require('node:test');
const assert = require('node:assert');
const { loadBrowserModule } = require('./helpers/load-browser.js');

const Admin = loadBrowserModule('js/admin.js', 'Admin');

// vm 裡造出來的物件跟這裡的 Object 不同 realm，deepStrictEqual 會因為原型不同而失敗。
// 只比內容，所以先過一次 JSON。
const plain = v => JSON.parse(JSON.stringify(v));

function taipei(iso) {
  return new Date(iso + '+08:00').toISOString();
}

function snap(over) {
  return Object.assign({
    ok: true,
    user: { userId: 'aug', role: 'parent', displayName: 'Aug', emoji: '🧑' },
    chore_approver: 'vicky',
    kids: [
      { user: { userId: 'momo', displayName: 'Momo', emoji: '👧' }, accounts: [], total: 100 },
      { user: { userId: 'coco', displayName: 'Coco', emoji: '👧' }, accounts: [], total: 50 }
    ],
    requests: []
  }, over);
}

function req(over) {
  return Object.assign({
    id: 'r1', kind: 'chore_done', kidId: 'momo', choreId: 'chore-trash',
    status: 'pending', ts: taipei('2026-09-18T20:00:00'), photoFileId: 'f1'
  }, over);
}

// ---------------------------------------------------------------- 分組與排序

test('groupRequests：依小孩分組，組內新到舊', () => {
  const s = snap({ requests: [
    req({ id: 'a', kidId: 'momo', ts: taipei('2026-09-18T08:00:00') }),
    req({ id: 'b', kidId: 'coco', ts: taipei('2026-09-18T09:00:00') }),
    req({ id: 'c', kidId: 'momo', ts: taipei('2026-09-18T21:00:00') })
  ] });
  const groups = Admin.groupRequests(s);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].kid.userId, 'momo');
  assert.deepStrictEqual(plain(groups[0].items.map(r => r.id)), ['c', 'a'], '新的在上面');
  assert.strictEqual(groups[1].kid.userId, 'coco');
  assert.deepStrictEqual(plain(groups[1].items.map(r => r.id)), ['b']);
});

test('groupRequests：只收 pending，沒有待審的小孩不出現', () => {
  const s = snap({ requests: [
    req({ id: 'a', kidId: 'momo' }),
    req({ id: 'b', kidId: 'coco', status: 'approved' })
  ] });
  const groups = Admin.groupRequests(s);
  assert.deepStrictEqual(plain(groups.map(g => g.kid.userId)), ['momo']);
});

test('groupRequests：kids 裡沒有的 kidId 也要看得到，不能整筆消失', () => {
  const s = snap({ requests: [req({ id: 'a', kidId: 'dodo' }), req({ id: 'b', kidId: 'momo' })] });
  const groups = Admin.groupRequests(s);
  assert.deepStrictEqual(plain(groups.map(g => g.kid.userId)), ['momo', 'dodo'], '不認得的排最後');
  assert.strictEqual(groups[1].kid.displayName, 'dodo');
});

test('groupRequests：壞時間不要讓整份清單炸掉', () => {
  const s = snap({ requests: [req({ id: 'a', ts: '' }), req({ id: 'b' })] });
  const groups = Admin.groupRequests(s);
  assert.deepStrictEqual(plain(groups[0].items.map(r => r.id)), ['b', 'a']);
});

test('groupRequests：空快照回空陣列', () => {
  assert.deepStrictEqual(plain(Admin.groupRequests(null)), []);
  assert.deepStrictEqual(plain(Admin.groupRequests({})), []);
});

// ---------------------------------------------------------------- 待審件數

test('pendingCount：只算 pending', () => {
  assert.strictEqual(Admin.pendingCount(snap()), 0);
  assert.strictEqual(Admin.pendingCount(snap({ requests: [
    req({ id: 'a' }), req({ id: 'b', status: 'rejected' }), req({ id: 'c', kidId: 'coco' })
  ] })), 2);
  assert.strictEqual(Admin.pendingCount(null), 0);
});

// ---------------------------------------------------------------- 核准者名字

test('approverName：登入者就是核准者時用自己的 displayName', () => {
  const s = snap({ user: { userId: 'vicky', role: 'parent', displayName: 'Vicky' } });
  assert.strictEqual(Admin.approverName(s), 'Vicky');
});

test('approverName：不是自己時查名單，查不到就退回 chore_approver 原值', () => {
  const s = snap();
  assert.strictEqual(Admin.approverName(s, [{ userId: 'vicky', displayName: '媽媽' }]), '媽媽');
  assert.strictEqual(Admin.approverName(s), 'vicky');
  assert.strictEqual(Admin.approverName(snap({ chore_approver: '' })), '');
});

// ---------------------------------------------------------------- 代理狀態機

test('代理狀態機：idle → needs-proxy → 帶 proxy 再送 → done', () => {
  let row = Admin.initialRow();
  assert.strictEqual(row.phase, 'idle');
  assert.strictEqual(row.proxy, false);

  // 第一次按核准：不帶 proxy
  assert.deepStrictEqual(plain(Admin.decidePayload('r1', 'approve', row)),
    { requestId: 'r1', decision: 'approve', decidedNote: '' });

  row = Admin.startSend(row);
  assert.strictEqual(row.phase, 'sending');

  // 伺服器說要代理：換按鈕，**不自動重送**（SPEC §9.5 三）
  row = Admin.applyDecideResult(row, { ok: false, error: 'needs-proxy', message: '這件要 Vicky 確認' });
  assert.strictEqual(row.phase, 'needs-proxy');
  assert.strictEqual(row.proxy, true);
  assert.strictEqual(Admin.buttonLabel(row, 'Vicky'), '代替 Vicky 確認');

  // 家長再按一次才帶 proxy:true
  assert.deepStrictEqual(plain(Admin.decidePayload('r1', 'approve', row)),
    { requestId: 'r1', decision: 'approve', decidedNote: '', proxy: true });

  row = Admin.applyDecideResult(Admin.startSend(row), { ok: true, status: 'approved', amount: 10 });
  assert.strictEqual(row.phase, 'done');
  assert.strictEqual(row.result, 'approved');
});

test('代理狀態機：needs-proxy 之後的 proxy 旗標不會被別的錯誤洗掉', () => {
  let row = Admin.applyDecideResult(Admin.initialRow(), { ok: false, error: 'needs-proxy' });
  row = Admin.applyDecideResult(Admin.startSend(row), { ok: false, error: 'busy', message: '忙' });
  assert.strictEqual(row.phase, 'error');
  assert.strictEqual(row.proxy, true, '重試時仍然是代理');
  assert.strictEqual(Admin.buttonLabel(row, 'Vicky'), '代替 Vicky 確認');
});

test('代理狀態機：already-decided 進 stale，要求重抓 snapshot', () => {
  const row = Admin.applyDecideResult(Admin.startSend(Admin.initialRow()),
    { ok: false, error: 'already-decided' });
  assert.strictEqual(row.phase, 'stale');
  assert.strictEqual(Admin.needsRefresh(row), true);
  assert.strictEqual(Admin.needsRefresh(Admin.initialRow()), false);
});

test('buttonLabel：處理中與已決定不是可按的狀態', () => {
  assert.strictEqual(Admin.buttonLabel(Admin.initialRow(), 'Vicky'), '核准 ✔');
  assert.strictEqual(Admin.buttonLabel(Admin.startSend(Admin.initialRow()), 'Vicky'), '處理中…');
  const done = Admin.applyDecideResult(Admin.initialRow(), { ok: true, status: 'rejected' });
  assert.strictEqual(Admin.buttonLabel(done, 'Vicky'), '已退回');
  // 名字不知道時不要印出「代替  確認」這種空格
  const proxy = Admin.applyDecideResult(Admin.initialRow(), { ok: false, error: 'needs-proxy' });
  assert.strictEqual(Admin.buttonLabel(proxy, ''), '代替確認');
});

// ---------------------------------------------------------------- 能不能送

test('canSubmit：退回沒寫理由，前端就先擋（伺服器也會擋 note-required）', () => {
  const row = Admin.initialRow();
  assert.strictEqual(Admin.canSubmit('reject', row), false);
  assert.strictEqual(Admin.decidePayload('r1', 'reject', row), null);

  const withNote = Object.assign({}, row, { note: '照片看不出來' });
  assert.strictEqual(Admin.canSubmit('reject', withNote), true);
  assert.deepStrictEqual(plain(Admin.decidePayload('r1', 'reject', withNote)),
    { requestId: 'r1', decision: 'reject', decidedNote: '照片看不出來' });
});

test('canSubmit：只有空白的理由不算理由', () => {
  const row = Object.assign(Admin.initialRow(), { note: '   \n ' });
  assert.strictEqual(Admin.canSubmit('reject', row), false);
  assert.strictEqual(Admin.decidePayload('r1', 'reject', row), null);
});

test('canSubmit：核准不需要理由，但送出中或已決定的一律不能再送', () => {
  assert.strictEqual(Admin.canSubmit('approve', Admin.initialRow()), true);
  assert.strictEqual(Admin.canSubmit('approve', Admin.startSend(Admin.initialRow())), false);
  const done = Admin.applyDecideResult(Admin.initialRow(), { ok: true, status: 'approved' });
  assert.strictEqual(Admin.canSubmit('approve', done), false);
  assert.strictEqual(Admin.canSubmit('reject', Object.assign({}, done, { note: '不行' })), false);
});

test('decidePayload：核准時的理由選填，會一起送出', () => {
  const row = Object.assign(Admin.initialRow(), { note: '做得很好' });
  assert.deepStrictEqual(plain(Admin.decidePayload('r1', 'approve', row)),
    { requestId: 'r1', decision: 'approve', decidedNote: '做得很好' });
});

// ---------------------------------------------------------------- 錯誤碼翻譯

test('errorMessage：家長看得懂的話，而且不要把暫時性錯誤講成永久失敗', () => {
  assert.match(Admin.errorMessage('needs-proxy', '', 'Vicky'), /代替|Vicky/);
  assert.match(Admin.errorMessage('already-decided'), /處理過|重新/);
  assert.match(Admin.errorMessage('note-required'), /理由/);
  assert.match(Admin.errorMessage('unauthorized'), /登入/);
  assert.match(Admin.errorMessage('busy'), /忙/);
  assert.match(Admin.errorMessage('photo-missing'), /照片/);
  assert.match(Admin.errorMessage('kid-mismatch'), /小孩|帳戶/);
  assert.match(Admin.errorMessage('account-inactive'), /帳戶/);
});

test('errorMessage：不認得的錯誤碼原樣轉述伺服器訊息', () => {
  assert.strictEqual(Admin.errorMessage('weird', '伺服器說了什麼'), '伺服器說了什麼');
  assert.ok(Admin.errorMessage('weird', ''), '沒訊息也要有一句話');
  assert.ok(Admin.errorMessage(undefined, undefined));
});

// ---------------------------------------------------------------- 批次核准

test('summarizeBatch：全部成功 / 中途卡住都要講清楚', () => {
  assert.match(Admin.summarizeBatch({ done: 3, total: 3 }), /3/);
  const stopped = Admin.summarizeBatch({ done: 1, total: 4, stopped: true, error: 'needs-proxy' }, 'Vicky');
  assert.match(stopped, /1/);
  assert.match(stopped, /4/);
  assert.match(stopped, /代替|Vicky/);
});
