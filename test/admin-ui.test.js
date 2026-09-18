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

// ---------------------------------------------------- 兩種 kind 混排（§6、§7.1）
// 每日零用錢簽到與家事走的是同一條待審清單。看不出是哪一種、看不到勾了什麼、
// 看不到照片，媽媽就只能憑感覺按核准——那等於沒有審核。

function claimReq(over) {
  return Object.assign(req({
    id: 'c1', kind: 'allowance_claim', choreId: '', photoFileId: 'pf1',
    amount: '',                    // 伺服器 pending 階段一律留空（§7.1）
    checklist: '好好照顧自己|尊重別人的需求|完成自己的工作'
  }), over);
}

function snapWithAllowance(over) {
  const s = snap(over);
  s.kids = [
    { user: { userId: 'momo', displayName: 'Momo', emoji: '👧' }, accounts: [], total: 100, dailyAllowance: 20 },
    { user: { userId: 'coco', displayName: 'Coco', emoji: '👧' }, accounts: [], total: 50, dailyAllowance: 12 }
  ];
  return s;
}

test('kindLabel：allowance_claim 要寫成「每日零用錢」，不要印原始 kind 字串', () => {
  assert.strictEqual(Admin.kindLabel('allowance_claim'), '每日零用錢');
  assert.strictEqual(Admin.kindLabel('chore_done'), '家事');
  assert.strictEqual(Admin.kindLabel('withdraw'), '領現金');
  // 不認得的還是要印得出東西，不要空白
  assert.strictEqual(Admin.kindLabel('weird_kind'), 'weird_kind');
});

test('rowTitle：簽到寫「每日零用錢」，家事寫家事名稱', () => {
  const s = snapWithAllowance();
  assert.match(Admin.rowTitle(s, claimReq()), /每日零用錢/);
  assert.ok(!/allowance_claim/.test(Admin.rowTitle(s, claimReq())), '不能露出原始 kind');
  assert.match(Admin.rowTitle(s, req()), /倒垃圾/);
});

// ---- 金額：pending 的 amount 是空的，要去查那個小孩的 dailyAllowance

test('rowAmount：pending 的簽到用該小孩的 dailyAllowance，不是 req.amount', () => {
  const s = snapWithAllowance();
  assert.strictEqual(Admin.rowAmount(s, claimReq({ kidId: 'momo' })), 20);
  assert.strictEqual(Admin.rowAmount(s, claimReq({ kidId: 'coco' })), 12, '每個小孩的金額不同');
});

test('rowAmount：家事還是看 chores.reward（前端不採信 req.amount）', () => {
  const s = snapWithAllowance({ chores: [{ id: 'chore-trash', title: '倒垃圾', icon: '🗑️', reward: 99 }] });
  assert.strictEqual(Admin.rowAmount(s, req({ amount: 5 })), 99);
});

test('rowAmount：查不到小孩的 dailyAllowance 就回 0——寧可不寫數字，也不要寫錯的', () => {
  const s = snapWithAllowance();
  assert.strictEqual(Admin.rowAmount(s, claimReq({ kidId: 'dodo' })), 0);
  assert.strictEqual(Admin.rowAmount(snap(), claimReq()), 0, '舊的家長快照沒帶 dailyAllowance');
  assert.strictEqual(Admin.rowAmount(null, claimReq()), 0);
});

test('dailyAllowanceOf：大小寫不同的 kidId 也要對得上', () => {
  const s = snapWithAllowance();
  assert.strictEqual(Admin.dailyAllowanceOf(s, 'MOMO'), 20);
  assert.strictEqual(Admin.dailyAllowanceOf(s, ''), 0);
  assert.strictEqual(Admin.dailyAllowanceOf(s, 'nobody'), 0);
});

// ---- 照片：看的是有沒有 photoFileId，不是 kind

test('photoState：有 photoFileId 就要抓縮圖，簽到與家事一視同仁', () => {
  assert.strictEqual(Admin.photoState(claimReq()), 'loading');
  assert.strictEqual(Admin.photoState(req()), 'loading');
});

test('photoState：該有照片卻沒有 photoFileId → missing；別的 kind 沒照片才是 none', () => {
  assert.strictEqual(Admin.photoState(claimReq({ photoFileId: '' })), 'missing');
  assert.strictEqual(Admin.photoState(req({ photoFileId: '' })), 'missing');
  assert.strictEqual(Admin.photoState({ kind: 'withdraw', id: 'w1' }), 'none');
});

test('photoState：抓過的用快取，抓壞的講「照片讀不到」而不是破圖', () => {
  assert.strictEqual(Admin.photoState(claimReq(), 'data:image/jpeg;base64,AAA'), 'ready');
  assert.strictEqual(Admin.photoState(claimReq(), 'error'), 'error');
});

// ---- 勾選紀錄：這才是媽媽要核對的證據

test('parseChecklist：伺服器目前寫的是「項目|項目|項目」', () => {
  assert.deepStrictEqual(plain(Admin.parseChecklist('好好照顧自己|尊重別人的需求|完成自己的工作')),
    ['好好照顧自己', '尊重別人的需求', '完成自己的工作']);
});

test('parseChecklist：也吃得下「項目=1」的寫法，0 的那項不算勾到', () => {
  assert.deepStrictEqual(plain(Admin.parseChecklist('好好照顧自己=1|尊重別人的需求=1')),
    ['好好照顧自己', '尊重別人的需求']);
  assert.deepStrictEqual(plain(Admin.parseChecklist('甲=1|乙=0|丙=true|丁=false')), ['甲', '丙']);
});

test('parseChecklist：壞資料一律回空陣列，不能讓整張待審清單炸掉', () => {
  ['', null, undefined, '|||', '  ', 0].forEach(v => {
    assert.deepStrictEqual(plain(Admin.parseChecklist(v)), [], JSON.stringify(v));
  });
  assert.deepStrictEqual(plain(Admin.parseChecklist({ nope: 1 })), []);
  assert.deepStrictEqual(plain(Admin.parseChecklist(['甲', '乙'])), ['甲', '乙'], '陣列也收');
});

test('checklistLine：沒有勾選紀錄要明講，不要留一片空白', () => {
  assert.strictEqual(Admin.checklistLine(''), '（沒有勾選紀錄）');
  assert.strictEqual(Admin.checklistLine('亂七八糟的東西=0'), '（沒有勾選紀錄）');
  assert.match(Admin.checklistLine('甲|乙'), /甲/);
  assert.match(Admin.checklistLine('甲|乙'), /乙/);
});

// ---- 分組、排序、狀態機、退回規則對兩種 kind 一視同仁

test('groupRequests：簽到與家事混在同一個小孩底下，一樣照時間新到舊', () => {
  const s = snapWithAllowance({ requests: [
    req({ id: 'a', ts: taipei('2026-09-18T08:00:00') }),
    claimReq({ id: 'b', kidId: 'momo', ts: taipei('2026-09-18T21:00:00') }),
    claimReq({ id: 'c', kidId: 'coco', ts: taipei('2026-09-18T07:00:00') })
  ] });
  const groups = Admin.groupRequests(s);
  assert.deepStrictEqual(plain(groups.map(g => g.kid.userId)), ['momo', 'coco']);
  assert.deepStrictEqual(plain(groups[0].items.map(r => r.id)), ['b', 'a']);
});

test('pendingCount：簽到也算一件待審', () => {
  assert.strictEqual(Admin.pendingCount(snapWithAllowance({ requests: [
    req({ id: 'a' }), claimReq({ id: 'b' }), claimReq({ id: 'c', status: 'approved' })
  ] })), 2);
});

test('簽到也走同一套代理狀態機與「退回要寫理由」', () => {
  let row = Admin.initialRow();
  assert.deepStrictEqual(plain(Admin.decidePayload('c1', 'approve', row)),
    { requestId: 'c1', decision: 'approve', decidedNote: '' });
  row = Admin.applyDecideResult(Admin.startSend(row), { ok: false, error: 'needs-proxy' });
  assert.strictEqual(row.proxy, true);
  assert.deepStrictEqual(plain(Admin.decidePayload('c1', 'approve', row)),
    { requestId: 'c1', decision: 'approve', decidedNote: '', proxy: true });
  // 退回沒理由一樣送不出去
  assert.strictEqual(Admin.decidePayload('c1', 'reject', row), null);
  const withNote = Object.assign({}, row, { note: '照片看不出來' });
  assert.deepStrictEqual(plain(Admin.decidePayload('c1', 'reject', withNote)),
    { requestId: 'c1', decision: 'reject', decidedNote: '照片看不出來', proxy: true });
});

// ---- 按類型全選（§6）：混在一起批會讓媽媽一鍵放行她沒看過的那一種

test('pendingByKind：分成兩批，每批照小孩分組後的順序，簽到排前面', () => {
  const s = snapWithAllowance({ requests: [
    req({ id: 'a', ts: taipei('2026-09-18T08:00:00') }),
    claimReq({ id: 'b', kidId: 'momo', ts: taipei('2026-09-18T21:00:00') }),
    claimReq({ id: 'c', kidId: 'coco', ts: taipei('2026-09-18T07:00:00') }),
    req({ id: 'd', kidId: 'coco', ts: taipei('2026-09-18T06:00:00') })
  ] });
  const batches = Admin.pendingByKind(s);
  assert.deepStrictEqual(plain(batches.map(b => b.kind)), ['allowance_claim', 'chore_done']);
  assert.deepStrictEqual(plain(batches[0].ids), ['b', 'c']);
  assert.deepStrictEqual(plain(batches[1].ids), ['a', 'd']);
  assert.match(batches[0].label, /每日零用錢/);
  assert.match(batches[0].label, /2/);
});

test('pendingByKind：只有一筆的那一類不給全選鈕（按一次就好，全選只會讓人手滑）', () => {
  const s = snapWithAllowance({ requests: [req({ id: 'a' }), claimReq({ id: 'b' })] });
  assert.deepStrictEqual(plain(Admin.pendingByKind(s)), []);
  assert.deepStrictEqual(plain(Admin.pendingByKind(null)), []);
});

test('pendingByKind：不認得的 kind 也要能全選，不要讓它卡在清單上', () => {
  const s = snapWithAllowance({ requests: [
    req({ id: 'a', kind: 'withdraw', amount: 100 }),
    req({ id: 'b', kind: 'withdraw', amount: 50 })
  ] });
  const batches = Admin.pendingByKind(s);
  assert.deepStrictEqual(plain(batches.map(b => b.kind)), ['withdraw']);
  assert.match(batches[0].label, /領現金/);
});

test('summarizeBatch：講得出剛剛批的是哪一類', () => {
  assert.match(Admin.summarizeBatch({ done: 3, total: 3, label: '每日零用錢' }), /每日零用錢/);
  assert.match(Admin.summarizeBatch({ done: 3, total: 3, label: '每日零用錢' }), /3/);
});
