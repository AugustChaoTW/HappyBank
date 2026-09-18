'use strict';
// js/chores.js 的純函式部分。
// 這裡只測「一件家事 + 它的 requests → 四種狀態哪一種」與期間切分，
// 因為那是唯一會讓小孩看錯畫面的地方（把「今天已確認」畫成「可回報」，他就會再拍一次然後被伺服器擋）。
// canvas 壓縮與 DOM 事件不在這裡測——沒有瀏覽器就沒有意義。

const test = require('node:test');
const assert = require('node:assert');
const { loadBrowserModule } = require('./helpers/load-browser.js');

const Chores = loadBrowserModule('js/chores.js', 'Chores');

// 台北時間某一刻的 ISO 字串（台北 = UTC+8，固定，不用管日光節約）
function taipei(iso) {
  return new Date(iso + '+08:00').toISOString();
}

const DAILY = { id: 'trash', title: '倒垃圾', icon: '🗑️', reward: 10, repeat: 'daily', active: true };
const WEEKLY = { id: 'floor', title: '拖地', icon: '🧽', reward: 30, repeat: 'weekly', active: true };

function req(over) {
  return Object.assign({
    id: 'r1', kind: 'chore_done', choreId: 'trash', status: 'pending', ts: taipei('2026-09-18T20:00:00')
  }, over);
}

const NOW = new Date(taipei('2026-09-18T21:14:00'));   // 2026-09-18 是週五

test('periodKey：daily 以台北 00:00 切日，不是 UTC', () => {
  const key = Chores.periodKey.bind(null, 'daily');
  assert.strictEqual(key(new Date(taipei('2026-09-18T00:00:00'))), 'd:2026-09-18');
  assert.strictEqual(key(new Date(taipei('2026-09-18T23:59:59'))), 'd:2026-09-18');
  // 台北 00:30 在 UTC 還是前一天——用 UTC 算就會把新的一天算成昨天
  assert.strictEqual(key(new Date(taipei('2026-09-19T00:30:00'))), 'd:2026-09-19');
});

test('periodKey：weekly 以台北週日 00:00 起算七天', () => {
  const key = Chores.periodKey.bind(null, 'weekly');
  const sun = 'w:2026-09-13';
  assert.strictEqual(key(new Date(taipei('2026-09-13T00:00:00'))), sun, '週日當天');
  assert.strictEqual(key(new Date(taipei('2026-09-18T21:00:00'))), sun, '同一週的週五');
  assert.strictEqual(key(new Date(taipei('2026-09-19T23:59:00'))), sun, '週六仍是同一週');
  assert.strictEqual(key(new Date(taipei('2026-09-20T00:01:00'))), 'w:2026-09-20', '下一個週日換期間');
});

test('periodKey：once 全期間唯一；壞日期不要炸掉畫面', () => {
  assert.strictEqual(Chores.periodKey('once', NOW), 'once');
  assert.strictEqual(Chores.periodKey('daily', 'not a date'), 'invalid');
});

test('deriveState：沒有任何回報 → 可回報', () => {
  assert.strictEqual(Chores.deriveState(DAILY, [], NOW).state, 'available');
  assert.strictEqual(Chores.deriveState(DAILY, null, NOW).state, 'available');
});

test('deriveState：今天已回報還沒審 → 等待確認', () => {
  const out = Chores.deriveState(DAILY, [req()], NOW);
  assert.strictEqual(out.state, 'pending');
  assert.strictEqual(out.request.id, 'r1');
});

test('deriveState：今天已核准 → 已確認（不能再報）', () => {
  const r = req({ status: 'approved', decidedTs: taipei('2026-09-18T21:14:00'), decidedBy: 'vicky' });
  assert.strictEqual(Chores.deriveState(DAILY, [r], NOW).state, 'approved');
});

test('deriveState：被退回 → rejected，且可以重報（不佔當天扣打）', () => {
  const r = req({ status: 'rejected', decidedNote: '照片太暗看不到' });
  const out = Chores.deriveState(DAILY, [r], NOW);
  assert.strictEqual(out.state, 'rejected');
  assert.strictEqual(out.request.decidedNote, '照片太暗看不到');
  assert.strictEqual(Chores.availableCount([DAILY], [r], NOW), 1, '退回的仍算「今天可以做」');
});

test('deriveState：自己撤回的當作沒報過', () => {
  const r = req({ status: 'cancelled' });
  assert.strictEqual(Chores.deriveState(DAILY, [r], NOW).state, 'available');
});

test('deriveState：pending 優先於同期間的 rejected（退回後重報，卡片要顯示等待中）', () => {
  const rejected = req({ id: 'r1', status: 'rejected', ts: taipei('2026-09-18T09:00:00') });
  const pending = req({ id: 'r2', status: 'pending', ts: taipei('2026-09-18T19:00:00') });
  assert.strictEqual(Chores.deriveState(DAILY, [rejected, pending], NOW).state, 'pending');
});

test('deriveState：昨天的紀錄不影響今天（跨午夜就能再報一次）', () => {
  const yesterday = req({ status: 'approved', ts: taipei('2026-09-17T21:00:00') });
  assert.strictEqual(Chores.deriveState(DAILY, [yesterday], NOW).state, 'available');
});

test('deriveState：weekly 同一週報過就不能再報，跨到下個週日才解禁', () => {
  const r = Object.assign(req({ choreId: 'floor', status: 'pending' }), { ts: taipei('2026-09-14T10:00:00') });
  assert.strictEqual(Chores.deriveState(WEEKLY, [r], NOW).state, 'pending', '同一週');
  const nextWeek = new Date(taipei('2026-09-20T08:00:00'));
  assert.strictEqual(Chores.deriveState(WEEKLY, [r], nextWeek).state, 'available', '下個週日解禁');
});

test('deriveState：別件家事與別種 kind 的 request 不要算到自己頭上', () => {
  const other = req({ choreId: 'floor' });
  const withdraw = req({ kind: 'withdraw', choreId: null });
  assert.strictEqual(Chores.deriveState(DAILY, [other, withdraw, null], NOW).state, 'available');
});

test('availableCount：只數今天還能賺的，可依 repeat 篩選', () => {
  const chores = [DAILY, WEEKLY, { id: 'off', title: '停用的', reward: 5, repeat: 'daily', active: false }];
  const reqs = [req({ status: 'approved' })];
  assert.strictEqual(Chores.availableCount(chores, reqs, NOW), 1, '倒垃圾已確認、拖地還能做');
  assert.strictEqual(Chores.availableCount(chores, reqs, NOW, 'daily'), 0);
  assert.strictEqual(Chores.availableCount(chores, reqs, NOW, 'weekly'), 1);
});

test('pendingReward：等確認中的錢加總（讓小孩看得到還沒到手的錢）', () => {
  const reqs = [req(), req({ id: 'r2', choreId: 'floor' })];
  assert.strictEqual(Chores.pendingReward([DAILY, WEEKLY], reqs, NOW), 40);
  assert.strictEqual(Chores.pendingReward([DAILY, WEEKLY], [], NOW), 0);
});

test('errorMessage：伺服器錯誤碼一律翻成小孩看得懂的話', () => {
  assert.match(Chores.errorMessage('photo-required'), /照片/);
  assert.match(Chores.errorMessage('photo-too-big'), /太大/);
  assert.strictEqual(Chores.errorMessage('already-reported'), '今天這件已經回報過了');
  assert.strictEqual(Chores.errorMessage('already-reported', '', 'weekly'), '這週這件已經回報過了');
  assert.match(Chores.errorMessage('busy'), /忙/);
  assert.match(Chores.errorMessage('unauthorized'), /重新登入/);
  // 後端還沒實作 request 這個 action 時要好好講，不是丟例外
  assert.match(Chores.errorMessage('unknown-action'), /還沒開通/);
  assert.strictEqual(Chores.errorMessage('server', '伺服器炸了'), '伺服器炸了');
  assert.match(Chores.errorMessage('weird-new-code'), /等一下再試/);
});

test('friendlyTs：小孩讀得懂的時間，不是 ISO 字串', () => {
  assert.strictEqual(Chores.friendlyTs(taipei('2026-09-18T21:14:00')), '9/18 晚上 9:14');
  assert.strictEqual(Chores.friendlyTs(taipei('2026-09-18T09:05:00')), '9/18 早上 9:05');
  assert.strictEqual(Chores.friendlyTs(taipei('2026-09-18T12:30:00')), '9/18 中午 12:30');
  assert.strictEqual(Chores.friendlyTs(taipei('2026-09-18T15:00:00')), '9/18 下午 3:00');
  assert.strictEqual(Chores.friendlyTs(taipei('2026-09-18T00:20:00')), '9/18 凌晨 12:20');
  assert.strictEqual(Chores.friendlyTs(''), '');
  assert.strictEqual(Chores.friendlyTs('not a date'), '');
});

// ---------- 日界線以伺服器為準（snapshot.today） ----------
// 小孩的平板時鐘會跑掉：電池沒電歸零、自己手動調時間、時區設成別國。
// 只要「今天」是裝置算的，卡片就會跟伺服器講不同的日子——
// 畫成「可回報」他就再拍一次，然後被 already-reported 擋掉。

const SNAP_TODAY = { today: '2026-09-18' };
const WRONG_CLOCK = new Date(taipei('2026-09-19T10:00:00'));   // 平板以為已經是隔天

test('currentPeriodKey：有 snapshot.today 就用它，沒有才退回裝置時鐘', () => {
  assert.strictEqual(Chores.currentPeriodKey('daily', WRONG_CLOCK, SNAP_TODAY), 'd:2026-09-18');
  assert.strictEqual(Chores.currentPeriodKey('daily', WRONG_CLOCK, null), 'd:2026-09-19');
  // 壞掉或缺漏的 today 不能讓畫面空白，一律當成沒有
  assert.strictEqual(Chores.currentPeriodKey('daily', WRONG_CLOCK, { today: 'yesterday' }), 'd:2026-09-19');
  assert.strictEqual(Chores.currentPeriodKey('daily', WRONG_CLOCK, {}), 'd:2026-09-19');
  assert.strictEqual(Chores.currentPeriodKey('once', WRONG_CLOCK, SNAP_TODAY), 'once');
});

test('currentPeriodKey：weekly 也要從伺服器那天往回推到週日', () => {
  // 2026-09-18 是週五 → 那一週的週日是 09-13
  assert.strictEqual(Chores.currentPeriodKey('weekly', WRONG_CLOCK, SNAP_TODAY), 'w:2026-09-13');
  // 伺服器說已經是週日了，裝置卻還停在上週五
  assert.strictEqual(
    Chores.currentPeriodKey('weekly', new Date(taipei('2026-09-18T10:00:00')), { today: '2026-09-20' }),
    'w:2026-09-20');
});

test('deriveState：裝置時鐘跑到明天，也要照伺服器的今天算（不然會重報一次）', () => {
  const r = req({ status: 'approved', ts: taipei('2026-09-18T20:00:00') });
  // 裝置以為是 9/19 → 昨天的紀錄不算數 → 畫成「可回報」
  assert.strictEqual(Chores.deriveState(DAILY, [r], WRONG_CLOCK).state, 'available');
  // 伺服器說今天還是 9/18 → 已確認，不能再報
  assert.strictEqual(Chores.deriveState(DAILY, [r], WRONG_CLOCK, SNAP_TODAY).state, 'approved');
});

test('deriveState：裝置時鐘停在昨天，也不要把昨天的紀錄當成今天的', () => {
  const yesterday = req({ status: 'approved', ts: taipei('2026-09-17T20:00:00') });
  const slow = new Date(taipei('2026-09-17T23:00:00'));
  assert.strictEqual(Chores.deriveState(DAILY, [yesterday], slow).state, 'approved', '裝置以為還是 9/17');
  assert.strictEqual(Chores.deriveState(DAILY, [yesterday], slow, SNAP_TODAY).state, 'available',
    '伺服器說今天是 9/18，昨天做過的今天可以再做');
});

test('availableCount / pendingReward / homeButtonState 都吃伺服器的今天', () => {
  const r = req({ status: 'pending', ts: taipei('2026-09-18T20:00:00') });
  assert.strictEqual(Chores.availableCount([DAILY], [r], WRONG_CLOCK, 'daily'), 1, '照裝置時鐘會以為還能做');
  assert.strictEqual(Chores.availableCount([DAILY], [r], WRONG_CLOCK, 'daily', SNAP_TODAY), 0);
  assert.strictEqual(Chores.pendingReward([DAILY], [r], WRONG_CLOCK), 0);
  assert.strictEqual(Chores.pendingReward([DAILY], [r], WRONG_CLOCK, SNAP_TODAY), 10);
  assert.strictEqual(Chores.homeButtonState([DAILY], [r], WRONG_CLOCK).label, '還有 1 件可以做 →');
  assert.strictEqual(Chores.homeButtonState([DAILY], [r], WRONG_CLOCK, SNAP_TODAY).label, '⏳ 1 件等確認');
});
