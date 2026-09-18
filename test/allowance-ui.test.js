'use strict';
// js/allowance.js 的純函式部分（每日零用錢）。
// 只測會讓小孩看錯畫面或白做工的東西：今天到底領了沒、三項勾完了沒、
// 什麼時候才准按送出、首頁那兩顆大按鈕該寫什麼字、伺服器錯誤碼翻成什麼話。
// 相機、canvas 壓縮、fetch 都不在這裡測——沒有瀏覽器就沒有意義。
//
// 首頁「🧹 每日家事」那顆按鈕的狀態函式住在 chores.js（沿用它既有的 deriveState），
// 但它跟零用錢那顆是同一個版面上的一對，所以一起在這裡測。

const test = require('node:test');
const assert = require('node:assert');
const { loadBrowserModule } = require('./helpers/load-browser.js');

const Money = loadBrowserModule('js/money.js', 'Money');
const Chores = loadBrowserModule('js/chores.js', 'Chores');
// allowance.js 靠 Chores.periodKey 切日、靠 Money 印錢，所以要把它們餵進沙箱
const Allowance = loadBrowserModule('js/allowance.js', 'Allowance', { Money, Chores });

// vm 沙箱裡建的陣列跟這裡的 Array 不是同一個 prototype，deepStrictEqual 會不認得，
// 所以比較前先搬回本地陣列
const arr = x => Array.from(x);

function taipei(iso) {
  return new Date(iso + '+08:00').toISOString();
}

const NOW = new Date(taipei('2026-09-18T21:14:00'));

function claim(over) {
  return Object.assign({
    id: 'a1', kind: 'allowance_claim', status: 'pending', ts: taipei('2026-09-18T20:00:00')
  }, over);
}

function snap(over) {
  return Object.assign({ ok: true, requests: [], chores: [] }, over);
}

// ---------- 清單由伺服器決定 ----------

test('checklist：沒設定就用預設三項', () => {
  assert.deepStrictEqual(arr(Allowance.checklist(snap())),
    ['好好照顧自己', '尊重別人的需求', '完成自己的工作']);
  assert.deepStrictEqual(arr(Allowance.checklist(null)), arr(Allowance.DEFAULT_CHECKLIST));
});

test('checklist：伺服器送幾項就是幾項（第四項不必改程式）', () => {
  const four = ['一', '二', '三', '四'];
  assert.deepStrictEqual(arr(Allowance.checklist(snap({ daily_checklist: four }))), four);
  assert.strictEqual(Allowance.checklist(snap({ daily_checklist: four })).length, 4);
});

test('checklist：空陣列或壞型別退回預設，不要畫出一張沒東西可勾的卡', () => {
  assert.deepStrictEqual(arr(Allowance.checklist(snap({ daily_checklist: [] }))), arr(Allowance.DEFAULT_CHECKLIST));
  assert.deepStrictEqual(arr(Allowance.checklist(snap({ daily_checklist: '好好照顧自己' }))), arr(Allowance.DEFAULT_CHECKLIST));
  // 非字串項目濾掉，其餘照畫
  assert.deepStrictEqual(arr(Allowance.checklist(snap({ daily_checklist: ['甲', null, 42, '乙'] }))), ['甲', '乙']);
});

// ---------- 今天領了沒 ----------

test('claimState：今天沒送過 → 可以領', () => {
  assert.strictEqual(Allowance.claimState(snap(), NOW).state, 'available');
  assert.strictEqual(Allowance.claimState(null, NOW).state, 'available');
});

test('claimState：送出還沒審 → 等確認', () => {
  const out = Allowance.claimState(snap({ requests: [claim()] }), NOW);
  assert.strictEqual(out.state, 'pending');
  assert.strictEqual(out.request.id, 'a1');
});

test('claimState：核准了就是今天領到了，金額從 request.amount 來', () => {
  const r = claim({ status: 'approved', amount: 20, decidedTs: taipei('2026-09-18T21:14:00'), decidedBy: 'vicky' });
  const out = Allowance.claimState(snap({ requests: [r] }), NOW);
  assert.strictEqual(out.state, 'approved');
  assert.strictEqual(out.amount, 20);
});

test('claimState：request 沒帶金額就用快照上的每日零用錢設定', () => {
  const r = claim({ status: 'approved' });
  assert.strictEqual(Allowance.claimState(snap({ requests: [r], daily_allowance: 20 }), NOW).amount, 20);
  // 兩邊都沒有就是 0，畫面自己決定要不要講
  assert.strictEqual(Allowance.claimState(snap({ requests: [r] }), NOW).amount, 0);
});

test('claimState：核准後伺服器不回寫金額，就從帳本上同一天那筆零用錢回推', () => {
  const r = claim({ status: 'approved', decidedTs: taipei('2026-09-18T21:14:00') });
  const ledger = [
    { id: 'l0', ts: taipei('2026-09-17T21:00:00'), type: 'allowance', amount: 99 },
    { id: 'l1', ts: taipei('2026-09-18T21:14:00'), type: 'allowance', amount: 20 }
  ];
  assert.strictEqual(Allowance.claimState(snap({ requests: [r], ledger }), NOW).amount, 20);
  // 只有家事獎金的話不能拿來當零用錢的數字
  const chores = [{ id: 'l2', ts: taipei('2026-09-18T20:00:00'), type: 'chore', amount: 10 }];
  assert.strictEqual(Allowance.claimState(snap({ requests: [r], ledger: chores }), NOW).amount, 0);
});

test('claimState：被退回可以同一天重送（不佔今天的扣打）', () => {
  const r = claim({ status: 'rejected', decidedNote: '照片太暗' });
  const out = Allowance.claimState(snap({ requests: [r] }), NOW);
  assert.strictEqual(out.state, 'rejected');
  assert.strictEqual(Allowance.canSubmit({ state: out.state, items: ['甲'], ticked: ['甲'], hasPhoto: true }), true);
});

test('claimState：pending 蓋過同一天較早的 rejected', () => {
  const rejected = claim({ id: 'a1', status: 'rejected', ts: taipei('2026-09-18T09:00:00') });
  const pending = claim({ id: 'a2', status: 'pending', ts: taipei('2026-09-18T19:00:00') });
  assert.strictEqual(Allowance.claimState(snap({ requests: [rejected, pending] }), NOW).state, 'pending');
});

test('claimState：昨天領過不影響今天（用 Chores.periodKey 切日，兩邊界線一致）', () => {
  const yesterday = claim({ status: 'approved', ts: taipei('2026-09-17T21:00:00') });
  assert.strictEqual(Allowance.claimState(snap({ requests: [yesterday] }), NOW).state, 'available');
  // 台北 00:30 已經是新的一天
  const justAfterMidnight = new Date(taipei('2026-09-19T00:30:00'));
  const lastNight = claim({ status: 'approved', ts: taipei('2026-09-18T23:00:00') });
  assert.strictEqual(Allowance.claimState(snap({ requests: [lastNight] }), justAfterMidnight).state, 'available');
});

test('claimState：家事的 request 不要算成零用錢', () => {
  const chore = claim({ kind: 'chore_done', choreId: 'trash' });
  assert.strictEqual(Allowance.claimState(snap({ requests: [chore, null] }), NOW).state, 'available');
});

test('claimState：自己撤回的當作沒送過', () => {
  assert.strictEqual(Allowance.claimState(snap({ requests: [claim({ status: 'cancelled' })] }), NOW).state, 'available');
});

// ---------- 勾選與送出條件 ----------

const THREE = ['好好照顧自己', '尊重別人的需求', '完成自己的工作'];

test('allChecked：全部勾完才算數', () => {
  assert.strictEqual(Allowance.allChecked(THREE, THREE), true);
  assert.strictEqual(Allowance.allChecked(THREE, THREE.slice(0, 2)), false);
  assert.strictEqual(Allowance.allChecked(THREE, []), false);
  // 伺服器多送一項，舊的三項就不夠了
  assert.strictEqual(Allowance.allChecked(THREE.concat('額外一項'), THREE), false);
  // 沒有項目不能算「都勾完了」，不然會變成空白也能送
  assert.strictEqual(Allowance.allChecked([], []), false);
});

test('progressHint：還差幾項講清楚，勾完就換成可以拍照了', () => {
  assert.strictEqual(Allowance.progressHint(THREE, THREE.slice(0, 2)), '還有 1 項沒勾');
  assert.strictEqual(Allowance.progressHint(THREE, []), '還有 3 項沒勾');
  assert.match(Allowance.progressHint(THREE, THREE), /照片/);
});

test('canSubmit：三項沒勾完不准送（伺服器也會再擋一次）', () => {
  const base = { state: 'available', items: THREE, ticked: THREE, hasPhoto: true, sending: false };
  assert.strictEqual(Allowance.canSubmit(base), true);
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { ticked: THREE.slice(0, 2) })), false);
});

test('canSubmit：沒照片不准送、送出中不准再按', () => {
  const base = { state: 'available', items: THREE, ticked: THREE, hasPhoto: true, sending: false };
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { hasPhoto: false })), false);
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { sending: true })), false);
});

test('canSubmit：今天已送出或已領到就不准再送', () => {
  const base = { items: THREE, ticked: THREE, hasPhoto: true, sending: false };
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { state: 'pending' })), false);
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { state: 'approved' })), false);
  assert.strictEqual(Allowance.canSubmit(Object.assign({}, base, { state: 'rejected' })), true);
});

test('canSubmit：拍照步驟要等勾完才開（camera gate 與 submit gate 同一條規則）', () => {
  assert.strictEqual(Allowance.canShoot({ state: 'available', items: THREE, ticked: THREE }), true);
  assert.strictEqual(Allowance.canShoot({ state: 'available', items: THREE, ticked: [] }), false);
  assert.strictEqual(Allowance.canShoot({ state: 'pending', items: THREE, ticked: THREE }), false);
});

// ---------- 首頁兩顆大按鈕 ----------

test('homeLabel（🎁 每日零用錢）：三種狀態一眼看得出來', () => {
  assert.strictEqual(Allowance.homeLabel(snap(), NOW).label, '今天還沒領 →');
  assert.strictEqual(Allowance.homeLabel(snap(), NOW).state, 'available');

  const pending = Allowance.homeLabel(snap({ requests: [claim()] }), NOW);
  assert.strictEqual(pending.state, 'pending');
  assert.match(pending.label, /^⏳ 等.*確認$/);

  const r = claim({ status: 'approved', amount: 20, decidedTs: taipei('2026-09-18T21:14:00'), decidedBy: 'vicky' });
  const done = Allowance.homeLabel(snap({ requests: [r] }), NOW);
  assert.strictEqual(done.state, 'approved');
  assert.strictEqual(done.label, '✅ 今天領到了 ＋20');
});

test('homeLabel：不知道金額就不要亂寫數字', () => {
  const r = claim({ status: 'approved' });
  assert.strictEqual(Allowance.homeLabel(snap({ requests: [r] }), NOW).label, '✅ 今天領到了');
});

test('homeLabel：被退回要看得出還能再試一次', () => {
  const out = Allowance.homeLabel(snap({ requests: [claim({ status: 'rejected' })] }), NOW);
  assert.strictEqual(out.state, 'rejected');
  assert.match(out.label, /再試一次 →$/);
});

test('approvedLine：跟家事卡同一套寫法（誰、什麼時候、加多少）', () => {
  const r = claim({ status: 'approved', amount: 20, decidedTs: taipei('2026-09-18T21:14:00'), decidedBy: 'vicky' });
  assert.strictEqual(Allowance.approvedLine(r, 20, 'vicky'), '✅ 媽媽在 9/18 晚上 9:14 確認 ＋20');
  // 爸爸代替媽媽按核准
  const proxy = Object.assign({}, r, { decidedBy: 'aug', decidedProxy: true });
  assert.strictEqual(Allowance.approvedLine(proxy, 20, 'vicky'), '✅ 爸爸代替媽媽在 9/18 晚上 9:14 確認 ＋20');
});

test('homeButtonState（🧹 每日家事）：可做件數優先，其次等確認，最後今天做完了', () => {
  const chores = [
    { id: 'trash', title: '倒垃圾', reward: 10, repeat: 'daily', active: true },
    { id: 'desk', title: '收書桌', reward: 10, repeat: 'daily', active: true },
    { id: 'shoes', title: '排鞋子', reward: 10, repeat: 'daily', active: true }
  ];
  const cr = (id, status) => ({ id: 'c-' + id, kind: 'chore_done', choreId: id, status, ts: taipei('2026-09-18T19:00:00') });

  const fresh = Chores.homeButtonState(chores, [], NOW);
  assert.strictEqual(fresh.state, 'available');
  assert.strictEqual(fresh.label, '還有 3 件可以做 →');

  const two = Chores.homeButtonState(chores, [cr('trash', 'approved')], NOW);
  assert.strictEqual(two.label, '還有 2 件可以做 →');

  const waiting = Chores.homeButtonState(chores, [
    cr('trash', 'pending'), cr('desk', 'pending'), cr('shoes', 'approved')
  ], NOW);
  assert.strictEqual(waiting.state, 'pending');
  assert.strictEqual(waiting.label, '⏳ 2 件等確認');

  const done = Chores.homeButtonState(chores, chores.map(c => cr(c.id, 'approved')), NOW);
  assert.strictEqual(done.state, 'approved');
  assert.strictEqual(done.label, '✅ 今天都做完了');
});

test('homeButtonState：還沒有家事清單時不要說「都做完了」', () => {
  const out = Chores.homeButtonState([], [], NOW);
  assert.strictEqual(out.state, 'none');
  assert.match(out.label, /還沒有/);
});

test('homeButtonState：只看 daily，每週家事不混進今天的數字', () => {
  const weekly = [{ id: 'floor', title: '拖地', reward: 30, repeat: 'weekly', active: true }];
  const daily = [{ id: 'trash', title: '倒垃圾', reward: 10, repeat: 'daily', active: true }];
  assert.strictEqual(Chores.homeButtonState(daily.concat(weekly), [], NOW).label, '還有 1 件可以做 →');
});

// ---------- 錯誤碼 ----------

test('errorMessage：勾沒勾完、今天已經領過，都要講人話', () => {
  // 後端的碼名還沒定案，常見的幾種寫法都要接得住
  ['checklist-incomplete', 'incomplete-checklist', 'checklist-required'].forEach(code => {
    assert.match(Allowance.errorMessage(code), /三件事|每一件|勾/, code);
  });
  ['already-claimed', 'already-requested', 'already-reported'].forEach(code => {
    assert.match(Allowance.errorMessage(code), /今天/, code);
  });
});

test('errorMessage：照片、忙線、登入過期沿用家事頁同一套說法', () => {
  assert.match(Allowance.errorMessage('photo-required'), /照片/);
  assert.match(Allowance.errorMessage('photo-too-big'), /太大/);
  assert.match(Allowance.errorMessage('busy'), /忙/);
  assert.match(Allowance.errorMessage('unauthorized'), /重新登入/);
});

test('errorMessage：後端還沒開通不要讓畫面壞掉', () => {
  assert.match(Allowance.errorMessage('unknown-action'), /還沒開通/);
  assert.match(Allowance.errorMessage('no-backend'), /還沒開通/);
});

test('errorMessage：沒對照到的新碼就照講伺服器自己的話', () => {
  assert.strictEqual(Allowance.errorMessage('daily-claim-locked', '今天的零用錢已經發過了'), '今天的零用錢已經發過了');
  assert.match(Allowance.errorMessage('weird-new-code'), /等一下再試/);
  assert.match(Allowance.errorMessage('network'), /網路|連不上/);
});

// ---------- 日界線以伺服器為準（snapshot.today） ----------
// 平板時鐘跑掉時，「今天領了沒」不能由裝置決定：
// 寫「今天還沒領」而伺服器認為領過了，小孩拍完照送出才被 already-claimed 打回來。

const WRONG_CLOCK = new Date(taipei('2026-09-19T10:00:00'));   // 平板以為已經是隔天

test('claimState：裝置時鐘跑到明天，仍照伺服器的 today 算', () => {
  const r = claim({ status: 'approved', amount: 20, decidedBy: 'vicky' });
  // 裝置以為是 9/19 → 昨天那筆不算今天 → 會寫「今天還沒領」
  assert.strictEqual(Allowance.claimState(snap({ requests: [r] }), WRONG_CLOCK).state, 'available');
  // 伺服器說今天還是 9/18 → 今天已經領到了
  const server = Allowance.claimState(snap({ requests: [r], today: '2026-09-18' }), WRONG_CLOCK);
  assert.strictEqual(server.state, 'approved');
  assert.strictEqual(server.amount, 20);
});

test('claimState：裝置時鐘停在昨天，也不要把昨天那筆當成今天的', () => {
  const yesterday = claim({ status: 'approved', amount: 20, ts: taipei('2026-09-17T20:00:00') });
  const slow = new Date(taipei('2026-09-17T23:00:00'));
  assert.strictEqual(Allowance.claimState(snap({ requests: [yesterday] }), slow).state, 'approved');
  assert.strictEqual(
    Allowance.claimState(snap({ requests: [yesterday], today: '2026-09-18' }), slow).state, 'available',
    '伺服器說今天是 9/18，昨天領過不影響今天');
});

test('claimState：舊的離線快照沒有 today 就退回裝置時間（不能整頁空白）', () => {
  const r = claim({ status: 'pending' });
  assert.strictEqual(Allowance.claimState(snap({ requests: [r] }), NOW).state, 'pending');
  assert.strictEqual(Allowance.claimState(snap({ requests: [r], today: '壞掉的值' }), NOW).state, 'pending');
});

test('homeLabel：伺服器的今天說領過了，按鈕就不准寫「還沒領」', () => {
  const r = claim({ status: 'approved', amount: 20, decidedBy: 'vicky' });
  assert.strictEqual(Allowance.homeLabel(snap({ requests: [r] }), WRONG_CLOCK).label, '今天還沒領 →');
  assert.strictEqual(
    Allowance.homeLabel(snap({ requests: [r], today: '2026-09-18' }), WRONG_CLOCK).label,
    '✅ 今天領到了 ＋20');
});

// ---------- 還沒簽到就先講金額 ----------

test('homeLabel：snapshot 帶了 dailyAllowance，按鈕就寫得出「今天還沒領 ＋20 →」', () => {
  assert.strictEqual(Allowance.homeLabel(snap({ dailyAllowance: 20 }), NOW).label, '今天還沒領 ＋20 →');
  // 被退回也一樣看得到還能拿多少
  const out = Allowance.homeLabel(snap({ requests: [claim({ status: 'rejected' })], dailyAllowance: 20 }), NOW);
  assert.strictEqual(out.state, 'rejected');
  assert.match(out.label, /再試一次 →$/);
});

test('homeLabel：沒帶 dailyAllowance 就不要瞎掰數字', () => {
  assert.strictEqual(Allowance.homeLabel(snap(), NOW).label, '今天還沒領 →');
  assert.strictEqual(Allowance.homeLabel(snap({ dailyAllowance: 0 }), NOW).label, '今天還沒領 →');
});

test('claimState：還沒簽到時的金額來自 snapshot.dailyAllowance', () => {
  assert.strictEqual(Allowance.claimState(snap({ dailyAllowance: 20 }), NOW).amount, 20);
  // 舊欄位名（daily_allowance）留著當退路，離線快照才不會突然少一個數字
  assert.strictEqual(Allowance.claimState(snap({ daily_allowance: 20 }), NOW).amount, 20);
  // request 上回寫的實付金額優先——那是真的付出去的數字
  const r = claim({ status: 'approved', amount: 35 });
  assert.strictEqual(Allowance.claimState(snap({ requests: [r], dailyAllowance: 20 }), NOW).amount, 35);
});
