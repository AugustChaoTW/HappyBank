'use strict';
// 每日工作回報（家事）。SPEC §5（requests 新欄位／家事照片）、§7.2（六道驗證與核准者規則）、
// §7.3（冪等）、§7.5（照片上傳）、§7.6（代理取圖）、§9.5（確認之後記錄什麼）。
//
// 這一檔要守住的三件事：
//   1. 沒有照片就沒有回報，而且照片不會外流（不設任何分享權限）。
//   2. 同一件家事一個期間只能賺一次錢——繞過 UI 也一樣。
//   3. 金額一律是伺服器查 chores.reward 查出來的，前端送什麼都不算數。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, accountOf } = require('./helpers/seed.js');

const PHOTO_DIR = 'HappyBank 家事照片';

// 一張「夠大但不過大」的假 JPEG（內容不重要，伺服器不做影像處理）
function photoB64(bytes) {
  return Buffer.alloc(bytes === undefined ? 50 * 1024 : bytes, 0x7a).toString('base64');
}

// 台北固定 UTC+8、沒有日光節約，所以可以直接用位移算牆上時間
const TPE = 8 * 3600000;
function taipeiDayStart(now) {
  const t = new Date(now.getTime() + TPE);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - TPE);
}
function taipeiWeekStart(now) {
  const t = new Date(taipeiDayStart(now).getTime() + TPE);
  t.setUTCDate(t.getUTCDate() - t.getUTCDay());   // 退到最近一個週日 00:00
  return new Date(t.getTime() - TPE);
}

function bank() {
  const gs = freshBank();
  return {
    gs,
    momo: login(gs, 'momo'),
    coco: login(gs, 'coco'),
    aug: login(gs, 'aug'),
    vicky: login(gs, 'vicky')
  };
}

let cid = 0;
function report(gs, session, opts) {
  return gs.$.call(Object.assign({
    action: 'request', kind: 'chore_done', session,
    choreId: 'chore-trash', photo: photoB64(), photoMime: 'image/jpeg',
    clientId: 'cid-' + (++cid)
  }, opts || {}));
}

function requestRows(gs) { return gs.$.rows('requests'); }
function choreLedger(gs) { return gs.$.rows('ledger').filter(l => l.type === 'chore'); }

// 直接改一格 config（admin_config 屬於另一個工單，這裡不靠它）
function setConfig(gs, key, value) {
  const row = gs.$.rows('config').find(r => String(r.key) === key);
  assert.ok(row, 'config 沒有 ' + key);
  gs.$.setCell('config', row._row, 'value', value);
}

// 把某一筆 request 的伺服器寫入時間改掉（模擬「這筆是昨天／上週報的」）
function backdate(gs, row, when) {
  gs.$.setCell('requests', row, 'ts', when);
}

// ---------------------------------------------------------------- Setup.gs

test('requests 的 schema 有 photoFileId / decidedBy / decidedProxy（SPEC §5）', () => {
  const gs = freshBank();
  const headers = gs.$.headers('requests');
  ['photoFileId', 'decidedBy', 'decidedProxy'].forEach(h => {
    assert.ok(headers.indexOf(h) >= 0, 'requests 少了欄位 ' + h);
  });
});

test('config 種子有 chore_approver = vicky（SPEC §5）', () => {
  const gs = freshBank();
  const row = gs.$.rows('config').find(r => r.key === 'chore_approver');
  assert.ok(row, 'config 沒有 chore_approver');
  assert.strictEqual(String(row.value), 'vicky');
});

test('setup() 重跑不會動既有資料，也不會把欄位錯位（SPEC §11）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { note: '倒好了' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const before = requestRows(t.gs)[0];
  // 家長把 chore_approver 改成 aug 之後再跑一次 setup()
  setConfig(t.gs, 'chore_approver', 'aug');
  t.gs.setup();

  const after = requestRows(t.gs)[0];
  assert.strictEqual(after.id, before.id);
  assert.strictEqual(after.kidId, 'momo');
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.choreId, 'chore-trash');
  assert.strictEqual(after.note, '倒好了');
  assert.strictEqual(String(after.photoFileId), String(before.photoFileId));
  assert.strictEqual(requestRows(t.gs).length, 1);
});

// ---------------------------------------------------------------- 照片

test('回報家事會把照片寫進 Drive，並回傳 fileId 而不是網址（SPEC §7.2 第 6 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { clientId: 'cid-photo-1234567890' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(res.requestId, '要回 requestId');
  assert.ok(res.photoFileId, '要回 photoFileId');
  assert.ok(!/^https?:/.test(String(res.photoFileId)), '回的是檔案 ID，不是網址');

  const folder = t.gs.$.drive.folderAt(PHOTO_DIR + '/momo');
  assert.ok(folder, '照片要放在 ' + PHOTO_DIR + '/<kidId>/');
  const file = t.gs.$.drive.fileById(res.photoFileId);
  assert.ok(file, 'photoFileId 要指得到那個檔案');
  assert.strictEqual(file.getMimeType(), 'image/jpeg');
  // 檔名 <yyyyMMdd>-<choreId>-<clientId 前 8 碼>.jpg（SPEC §5）
  assert.match(file.getName(), /^\d{8}-chore-trash-cid-phot\.jpg$/, '檔名不對：' + file.getName());
  assert.strictEqual(String(requestRows(t.gs)[0].photoFileId), String(res.photoFileId));
});

test('照片不做任何分享——絕不呼叫 setSharing（SPEC §5、§7.5）', () => {
  const t = bank();
  report(t.gs, t.momo);
  assert.deepStrictEqual(t.gs.$.drive.sharingCalls, [],
    '這裡刻意不開連結分享，家裡室內的照片不該有「知道網址就看得到」的路');
});

test('沒帶照片 → photo-required，而且不寫 Drive、不寫 Sheet（SPEC §7.2 第 4 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photo: undefined });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-required');
  assert.ok(res.message, '要給小孩看得懂的訊息');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('空字串照片 → photo-required', () => {
  const t = bank();
  assert.strictEqual(report(t.gs, t.momo, { photo: '' }).error, 'photo-required');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('base64 解不開 → photo-required（SPEC §7.2 第 4 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photo: '這不是 base64！！' });
  assert.strictEqual(res.error, 'photo-required');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('照片超過 1.5 MB → photo-too-big，不建檔（SPEC §7.2 第 4 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photo: photoB64(1.5 * 1024 * 1024 + 1) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-too-big');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('剛好 1.5 MB 還是收（上限是「超過」才擋）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photo: photoB64(1.5 * 1024 * 1024) });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
});

test('小於 2 KB 的照片（黑畫面／壞檔）一樣拒絕，不建檔', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photo: photoB64(2047) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-required');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('photoMime 只接受 image/jpeg（SPEC §7.2 第 4 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { photoMime: 'image/png' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-required');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

// ---------------------------------------------------------------- 身分與家事

test('kidId 一律取自 session：前端硬塞 kidId 也沒用（SPEC §7.2 第 1 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { kidId: 'coco' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(requestRows(t.gs)[0].kidId, 'momo');
});

test('家長不能回報家事（SPEC §7.2 第 1 條）', () => {
  const t = bank();
  const res = report(t.gs, t.vicky);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('沒帶 session 就回報 → unauthorized', () => {
  const t = bank();
  const res = report(t.gs, undefined, { session: '' });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('choreId 不存在 → 拒絕，不寫 Drive（SPEC §7.2 第 3 條）', () => {
  const t = bank();
  const res = report(t.gs, t.momo, { choreId: 'chore-nope' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('停用的家事不能報（SPEC §7.2 第 3 條）', () => {
  const t = bank();
  const row = t.gs.$.rows('chores').find(c => c.id === 'chore-trash')._row;
  t.gs.$.setCell('chores', row, 'active', false);
  const res = report(t.gs, t.momo);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('別人專屬的家事不能接（SPEC §7.2 第 3 條）', () => {
  const t = bank();
  const row = t.gs.$.rows('chores').find(c => c.id === 'chore-trash')._row;
  t.gs.$.setCell('chores', row, 'kidId', 'coco');
  const res = report(t.gs, t.momo);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(report(t.gs, t.coco).ok, true, '指定給 coco 的家事 coco 報得了');
});

// ---------------------------------------------------------------- 一天一次

test('同一件 daily 家事同一天報第二次 → already-reported（SPEC §7.2 第 5 條）', () => {
  const t = bank();
  assert.strictEqual(report(t.gs, t.momo).ok, true);
  const second = report(t.gs, t.momo);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'already-reported');
  assert.strictEqual(requestRows(t.gs).length, 1, '第二筆不能寫進 Sheet');
  assert.strictEqual(t.gs.$.drive.created.length, 1, '第二張照片也不該留在 Drive');
});

test('手工組請求繞過 UI（換一個 clientId）照樣擋得住', () => {
  const t = bank();
  report(t.gs, t.momo, { clientId: 'cid-ui' });
  const hand = report(t.gs, t.momo, { clientId: 'cid-hand-crafted', note: 'DevTools' });
  assert.strictEqual(hand.error, 'already-reported');
  assert.strictEqual(requestRows(t.gs).length, 1);
});

test('已核准之後同一天也不能再報', () => {
  const t = bank();
  const first = report(t.gs, t.momo);
  t.gs.$.call({ action: 'admin_decide', session: t.vicky, requestId: first.requestId, decision: 'approve' });
  assert.strictEqual(report(t.gs, t.momo).error, 'already-reported');
  assert.strictEqual(choreLedger(t.gs).length, 1);
});

test('被退回的家事可以當天重報，不佔扣打（SPEC §9.5 二）', () => {
  const t = bank();
  const first = report(t.gs, t.momo);
  const dec = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: first.requestId,
    decision: 'reject', decidedNote: '照片糊掉了'
  });
  assert.strictEqual(dec.ok, true, JSON.stringify(dec));
  const again = report(t.gs, t.momo);
  assert.strictEqual(again.ok, true, '退回之後同一天要能重報：' + JSON.stringify(again));
  assert.strictEqual(requestRows(t.gs).length, 2);
});

test('自己撤回的家事可以當天重報', () => {
  const t = bank();
  const first = report(t.gs, t.momo);
  const c = t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: first.requestId });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.strictEqual(report(t.gs, t.momo).ok, true);
});

test('日界線是台北 00:00：昨天 23:59 報過的今天可以再報', () => {
  const t = bank();
  const first = report(t.gs, t.momo);
  const row = requestRows(t.gs)[0]._row;

  // 今天台北 00:00 整 → 還是今天
  backdate(t.gs, row, taipeiDayStart(new Date()));
  assert.strictEqual(report(t.gs, t.momo).error, 'already-reported', '台北 00:00 算今天');

  // 再往前 1 毫秒 → 昨天 23:59:59.999
  backdate(t.gs, row, new Date(taipeiDayStart(new Date()).getTime() - 1));
  const res = report(t.gs, t.momo);
  assert.strictEqual(res.ok, true, '跨過午夜就是新的一天：' + JSON.stringify(res));
  assert.ok(first.requestId);
});

test('weekly 家事：同一週擋、上一個週日之前放行（SPEC §7.2 第 5 條）', () => {
  const t = bank();
  const weekly = { choreId: 'chore-sweep' };
  assert.strictEqual(report(t.gs, t.momo, weekly).ok, true);
  assert.strictEqual(report(t.gs, t.momo, weekly).error, 'already-reported');

  const row = requestRows(t.gs)[0]._row;
  const sunday = taipeiWeekStart(new Date());

  // 本週日 00:00 整 → 同一週
  backdate(t.gs, row, sunday);
  assert.strictEqual(report(t.gs, t.momo, weekly).error, 'already-reported', '週日 00:00 算本週');

  // 上週六 23:59:59.999 → 上一週，可以重報
  backdate(t.gs, row, new Date(sunday.getTime() - 1));
  const res = report(t.gs, t.momo, weekly);
  assert.strictEqual(res.ok, true, '跨過週日就是新的一週：' + JSON.stringify(res));
});

test('weekly 的期間比 daily 長：昨天報過的 weekly 今天還是不能報', () => {
  const t = bank();
  const weekly = { choreId: 'chore-sweep' };
  report(t.gs, t.momo, weekly);
  const row = requestRows(t.gs)[0]._row;
  const yesterday = new Date(taipeiDayStart(new Date()).getTime() - 1);
  // 昨天如果已經是上一週（今天是週日）就跳過這條
  if (yesterday >= taipeiWeekStart(new Date())) {
    backdate(t.gs, row, yesterday);
    assert.strictEqual(report(t.gs, t.momo, weekly).error, 'already-reported');
  }
});

test('不同小孩各報各的，不會互相擋', () => {
  const t = bank();
  assert.strictEqual(report(t.gs, t.momo).ok, true);
  assert.strictEqual(report(t.gs, t.coco).ok, true);
  assert.strictEqual(requestRows(t.gs).length, 2);
});

test('不同家事各自計算扣打', () => {
  const t = bank();
  assert.strictEqual(report(t.gs, t.momo, { choreId: 'chore-trash' }).ok, true);
  assert.strictEqual(report(t.gs, t.momo, { choreId: 'chore-dishes' }).ok, true);
});

// ---------------------------------------------------------------- 冪等

test('同一個 clientId 重送：不會多一筆 request，也不會多一張照片（SPEC §7.3、§7.5）', () => {
  const t = bank();
  const opts = { clientId: 'cid-offline-queue-1' };
  const first = report(t.gs, t.momo, opts);
  assert.strictEqual(first.ok, true);

  const second = report(t.gs, t.momo, opts);
  assert.strictEqual(second.ok, true, '重送要回原本那筆，不是 already-reported');
  assert.strictEqual(second.requestId, first.requestId);
  assert.strictEqual(second.photoFileId, first.photoFileId);

  assert.strictEqual(requestRows(t.gs).length, 1, 'Sheet 只能有一列');
  assert.strictEqual(t.gs.$.drive.created.length, 1, 'Drive 只能有一張照片');
});

test('冪等重送在 Drive 已經有同名檔時會重用，不會重建', () => {
  const t = bank();
  const first = report(t.gs, t.momo, { clientId: 'cid-reuse-0001' });
  // 模擬「Drive 寫成功、Sheet 寫失敗」之後的重送：把 request 那列砍掉
  t.gs.$.sheet('requests').deleteRow(requestRows(t.gs)[0]._row);
  t.gs.invalidate('requests');

  const again = report(t.gs, t.momo, { clientId: 'cid-reuse-0001' });
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.strictEqual(again.photoFileId, first.photoFileId, '同名檔要重用，不要越積越多');
  assert.strictEqual(t.gs.$.drive.created.length, 1);
});

// ---------------------------------------------------------------- admin_decide

function reported(t) {
  const res = report(t.gs, t.momo);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  return res;
}

test('vicky 核准：家事獎金進活期，金額來自 chores.reward（SPEC §9.5 四）', () => {
  const t = bank();
  const req = reported(t);
  const before = accountOf(t.gs, 'momo', 'current');

  const res = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'approve'
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const led = choreLedger(t.gs);
  assert.strictEqual(led.length, 1);
  assert.strictEqual(t.gs.num(led[0].amount, 0), 10, '倒垃圾 = 10 元（chores.reward）');
  assert.strictEqual(led[0].accountId, before.accountId, '一律進活期主帳戶');
  assert.strictEqual(led[0].kidId, 'momo');
  assert.strictEqual(led[0].by, 'vicky', 'by 是實際核准的人');
  assert.strictEqual(led[0].refId, req.requestId);
  assert.match(String(led[0].memo), /倒垃圾/);

  assert.strictEqual(t.gs.accountBalance(before.accountId), 10);
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'gift').accountId), 0,
    '家事獎金不能進紅包帳戶');

  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(String(row.decidedBy), 'vicky');
  assert.strictEqual(t.gs.isTrue(row.decidedProxy), false, '本人核准不是代理');
  assert.ok(row.decidedTs, '要寫 decidedTs');
});

test('前端送 amount 一律不算數（SPEC §9.5 四）', () => {
  const t = bank();
  const req = report(t.gs, t.momo, { amount: 9999 });
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId,
    decision: 'approve', amount: 9999
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(t.gs.num(choreLedger(t.gs)[0].amount, 0), 10);
});

test('aug 核准沒帶 proxy → needs-proxy，不入帳、不改狀態（SPEC §9.5 三）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId, decision: 'approve'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'needs-proxy');
  assert.ok(res.message);
  assert.strictEqual(choreLedger(t.gs).length, 0);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('aug 帶 proxy:true → 成立，而且 request 與 ledger 都看得出是代的（SPEC §9.5 三、四）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'approve', proxy: true
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(String(row.decidedBy), 'aug');
  assert.strictEqual(t.gs.isTrue(row.decidedProxy), true);

  const led = choreLedger(t.gs)[0];
  assert.strictEqual(led.by, 'aug', 'by 是實際按的人，不是 vicky');
  assert.match(String(led.memo), /Aug.*代替.*Vicky/, 'memo 要寫清楚是代理：' + led.memo);
  assert.strictEqual(t.gs.num(led.amount, 0), 10);
});

test('退回也要走代理規則——退回也是決定（SPEC §7.2）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'reject', decidedNote: '沒倒乾淨'
  });
  assert.strictEqual(res.error, 'needs-proxy');
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');

  const ok = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'reject', decidedNote: '沒倒乾淨', proxy: true
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.status, 'rejected');
  assert.strictEqual(String(row.decidedBy), 'aug');
  assert.strictEqual(t.gs.isTrue(row.decidedProxy), true);
  assert.strictEqual(choreLedger(t.gs).length, 0, '退回不寫 ledger');
});

test('退回沒填理由就不給退（SPEC §9.4）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'reject'
  });
  assert.strictEqual(res.ok, false, '退回必須填理由');
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('小孩不能 admin_decide，連自己那筆也不行（SPEC §7.2）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.momo, requestId: req.requestId, decision: 'approve'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(choreLedger(t.gs).length, 0);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('小孩帶 proxy:true 也還是 unauthorized', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.momo, requestId: req.requestId,
    decision: 'approve', proxy: true
  });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(choreLedger(t.gs).length, 0);
});

test('兩個家長同時按核准：只入帳一次，第二個拿到 already-decided（SPEC §7.2）', () => {
  const t = bank();
  const req = reported(t);
  const first = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'approve'
  });
  assert.strictEqual(first.ok, true);

  const second = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'approve', proxy: true
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'already-decided');

  assert.strictEqual(choreLedger(t.gs).length, 1, '不能重複入帳');
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'current').accountId), 10);
  assert.strictEqual(String(requestRows(t.gs)[0].decidedBy), 'vicky', '決定人不能被後來的人蓋掉');
});

test('已撤回的 request 不能核准', () => {
  const t = bank();
  const req = reported(t);
  t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: req.requestId });
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'approve'
  });
  assert.strictEqual(res.error, 'already-decided');
  assert.strictEqual(choreLedger(t.gs).length, 0);
});

test('requestId 不存在 → no-such-request', () => {
  const t = bank();
  const res = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: 'nope', decision: 'approve'
  });
  assert.strictEqual(res.error, 'no-such-request');
});

test('chore_approver 指到不存在的人 → server，不靜默 fallback 成誰都能核准（SPEC §5）', () => {
  const t = bank();
  const req = reported(t);
  setConfig(t.gs, 'chore_approver', 'nobody');

  const res = t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'approve', proxy: true
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'server');
  assert.strictEqual(choreLedger(t.gs).length, 0);
});

test('chore_approver 指到一個小孩 → server', () => {
  const t = bank();
  const req = reported(t);
  setConfig(t.gs, 'chore_approver', 'momo');
  assert.strictEqual(t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'approve'
  }).error, 'server');
});

test('改 chore_approver 換人管家事，舊的代理紀錄不會變成非代理（SPEC §5、§12）', () => {
  const t = bank();
  const first = reported(t);
  t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: first.requestId,
    decision: 'approve', proxy: true
  });

  // 換成 aug 當指定核准者
  setConfig(t.gs, 'chore_approver', 'aug');

  const second = report(t.gs, t.momo, { choreId: 'chore-dishes' });
  assert.strictEqual(t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: second.requestId, decision: 'approve'
  }).error, 'needs-proxy', '換人之後換 vicky 要按代理');
  assert.strictEqual(t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: second.requestId, decision: 'approve'
  }).ok, true, 'aug 現在是指定核准者，直接核准');

  const old = requestRows(t.gs).find(r => r.id === first.requestId);
  assert.strictEqual(t.gs.isTrue(old.decidedProxy), true, '歷史紀錄不能因為改設定就說謊');
});

// ---------------------------------------------------------------- cancel_request

test('小孩撤回自己的 pending 申請（SPEC §7.2）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: req.requestId });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(requestRows(t.gs)[0].status, 'cancelled');
});

test('小孩撤不掉別人的申請', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({ action: 'cancel_request', session: t.coco, requestId: req.requestId });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('已核准的撤不回 → already-decided', () => {
  const t = bank();
  const req = reported(t);
  t.gs.$.call({ action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'approve' });
  assert.strictEqual(
    t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: req.requestId }).error,
    'already-decided');
  assert.strictEqual(choreLedger(t.gs).length, 1, '撤回不能把錢收回去');
});

// ---------------------------------------------------------------- chore_photo（§7.6）

test('小孩抓得到自己那筆的照片，內容就是上傳的那張', () => {
  const t = bank();
  const photo = photoB64();
  const req = report(t.gs, t.momo, { photo });
  const res = t.gs.$.call({ action: 'chore_photo', session: t.momo, requestId: req.requestId });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.mime, 'image/jpeg');
  assert.strictEqual(res.requestId, req.requestId);
  assert.strictEqual(res.data, photo, '拿回來的要是同一張');
  assert.ok(!/^data:/.test(res.data), '不含 data: 前綴');
});

test('小孩 A 抓不到小孩 B 的照片 → not-your-photo（SPEC §7.6 第 3 條）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({ action: 'chore_photo', session: t.coco, requestId: req.requestId });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'not-your-photo');
  assert.ok(!res.data);
});

test('家長抓得到任何一筆（SPEC §7.6 第 3 條）', () => {
  const t = bank();
  const req = reported(t);
  [t.aug, t.vicky].forEach(session => {
    const res = t.gs.$.call({ action: 'chore_photo', session, requestId: req.requestId });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(res.data);
  });
});

test('不帶 session 打 chore_photo → unauthorized（SPEC §12）', () => {
  const t = bank();
  const req = reported(t);
  const res = t.gs.$.call({ action: 'chore_photo', requestId: req.requestId });
  assert.strictEqual(res.error, 'unauthorized');
});

test('requestId 不存在 → no-such-request（SPEC §7.6 第 2 條）', () => {
  const t = bank();
  const res = t.gs.$.call({ action: 'chore_photo', session: t.momo, requestId: 'nope' });
  assert.strictEqual(res.error, 'no-such-request');
});

test('Drive 上的檔案被刪掉 → photo-missing（SPEC §7.6 第 4 條）', () => {
  const t = bank();
  const req = reported(t);
  assert.strictEqual(t.gs.$.drive.destroy(req.photoFileId), true);
  const res = t.gs.$.call({ action: 'chore_photo', session: t.momo, requestId: req.requestId });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-missing');
});

test('檔案被丟到垃圾桶 → photo-missing（不是 server）', () => {
  const t = bank();
  const req = reported(t);
  t.gs.$.drive.fileById(req.photoFileId).setTrashed(true);
  assert.strictEqual(
    t.gs.$.call({ action: 'chore_photo', session: t.momo, requestId: req.requestId }).error,
    'photo-missing');
});

test('photoFileId 是空的 → photo-missing', () => {
  const t = bank();
  const req = reported(t);
  t.gs.$.setCell('requests', requestRows(t.gs)[0]._row, 'photoFileId', '');
  assert.strictEqual(
    t.gs.$.call({ action: 'chore_photo', session: t.vicky, requestId: req.requestId }).error,
    'photo-missing');
});

// ---------------------------------------------------------------- snapshot（§7.1）

test('小孩 snapshot 帶回今天已決定的 chore_done，含確認人與時間（SPEC §7.1）', () => {
  const t = bank();
  const req = reported(t);
  t.gs.$.call({
    action: 'admin_decide', session: t.aug, requestId: req.requestId,
    decision: 'approve', proxy: true
  });

  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(snap.ok, true);
  const r = snap.requests.find(x => x.id === req.requestId);
  assert.ok(r, '已決定的今日家事也要回來，不然卡片畫不出「已入帳」');
  assert.strictEqual(r.status, 'approved');
  assert.ok(r.photoFileId);
  assert.ok(r.decidedTs);
  assert.strictEqual(String(r.decidedBy), 'aug');
  assert.strictEqual(t.gs.isTrue(r.decidedProxy), true);
});

test('家長 snapshot 帶 chore_approver 與 photoFileId，但不夾帶照片內容（SPEC §7.1、§7.6）', () => {
  const t = bank();
  const req = reported(t);
  const snap = t.gs.$.call({ action: 'snapshot', session: t.vicky });
  assert.strictEqual(snap.chore_approver, 'vicky');
  const r = snap.requests.find(x => x.id === req.requestId);
  assert.ok(r);
  assert.strictEqual(String(r.photoFileId), String(req.photoFileId));
  assert.ok(JSON.stringify(snap).length < 20000, 'snapshot 絕對不能夾帶 base64 照片');
});

test('家長快照要帶 chores，待審清單才不會顯示過期的家事名稱與金額', () => {
  const gs = freshBank();
  const parent = login(gs, 'vicky');

  // 家長改了家事的標題與獎金
  const row = gs.$.rows('chores').find(c => c.id === 'chore-trash')._row;
  gs.$.setCell('chores', row, 'title', '倒廚餘');
  gs.$.setCell('chores', row, 'reward', 25);

  const snap = gs.$.call({ action: 'snapshot', session: parent });
  assert.ok(Array.isArray(snap.chores), '家長快照要有 chores');
  const trash = snap.chores.find(c => c.id === 'chore-trash');
  assert.strictEqual(trash.title, '倒廚餘');
  assert.strictEqual(trash.reward, 25);
});
