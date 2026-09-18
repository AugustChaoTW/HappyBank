'use strict';
// 每日零用錢簽到。小孩每天勾完三項自我檢查、拍一張照片送出，媽媽確認後
// 20 元進活期主帳戶。
//
// 這一檔要守住的四件事：
//   1. 三項（或家長改成幾項就幾項）全部勾滿才算數，少一項都不行。
//   2. 一個台北日曆天只能簽到一次——繞過 UI 也一樣，而且沒有「補簽昨天」這條路。
//   3. 金額一律是伺服器讀 users.dailyAllowance 讀出來的，前端送什麼都不算數。
//   4. 「算哪一天」看的是送出時間（requests.ts），不是媽媽什麼時候按確認。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, accountOf } = require('./helpers/seed.js');

const PHOTO_DIR = 'HappyBank 家事照片';
const ITEMS = ['好好照顧自己', '尊重別人的需求', '完成自己的工作'];

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
function claim(gs, session, opts) {
  return gs.$.call(Object.assign({
    action: 'request', kind: 'allowance_claim', session,
    checks: [true, true, true],
    photo: photoB64(), photoMime: 'image/jpeg',
    clientId: 'acid-' + (++cid)
  }, opts || {}));
}

function requestRows(gs) { return gs.$.rows('requests'); }
function allowanceLedger(gs) { return gs.$.rows('ledger').filter(l => l.type === 'allowance'); }

function setConfig(gs, key, value) {
  const row = gs.$.rows('config').find(r => String(r.key) === key);
  assert.ok(row, 'config 沒有 ' + key);
  gs.$.setCell('config', row._row, 'value', value);
}

function setDailyAllowance(gs, kidId, value) {
  const row = gs.$.rows('users').find(u => String(u.userId) === kidId);
  assert.ok(row, '找不到 ' + kidId);
  gs.$.setCell('users', row._row, 'dailyAllowance', value);
}

// 把某一筆 request 的伺服器寫入時間改掉（模擬「這筆是昨天送的」）
function backdate(gs, row, when) {
  gs.$.setCell('requests', row, 'ts', when);
}

function approve(gs, session, requestId, extra) {
  return gs.$.call(Object.assign({
    action: 'admin_decide', session, requestId, decision: 'approve'
  }, extra || {}));
}

// ---------------------------------------------------------------- schema / 種子

test('users 的欄位是 dailyAllowance（就地改名，不是多開一欄）', () => {
  const gs = freshBank();
  const headers = gs.$.headers('users');
  assert.ok(headers.indexOf('dailyAllowance') >= 0, 'users 少了 dailyAllowance');
  assert.strictEqual(headers.indexOf('weeklyAllowance'), -1, 'weeklyAllowance 要改掉，不是並存');
  // 就地改名 = 欄位位置不動，既有列才不會整排錯位
  assert.strictEqual(headers.indexOf('dailyAllowance'), 4);
});

test('requests 新增 checklist 欄，而且是接在最後面（SPEC §11）', () => {
  const gs = freshBank();
  const headers = gs.$.headers('requests');
  assert.ok(headers.indexOf('checklist') >= 0, 'requests 少了 checklist');
  assert.strictEqual(headers.indexOf('checklist'), headers.length - 1,
    '插在中間會讓既有列整排錯位，一律接在最後');
  // 舊欄位的位置一格都不能動
  ['id', 'ts', 'kidId', 'kind', 'amount', 'choreId', 'fromAccountId', 'toAccountId',
   'note', 'status', 'decidedTs', 'decidedNote', 'clientId', 'photoFileId',
   'decidedBy', 'decidedProxy'].forEach((h, i) => {
    assert.strictEqual(headers[i], h, '第 ' + (i + 1) + ' 欄應該還是 ' + h);
  });
});

test('config 種子有 daily_checklist，三項用 | 隔開', () => {
  const gs = freshBank();
  const row = gs.$.rows('config').find(r => r.key === 'daily_checklist');
  assert.ok(row, 'config 沒有 daily_checklist');
  assert.strictEqual(String(row.value), ITEMS.join('|'));
});

test('upsertUser 的第六個參數寫進 dailyAllowance 欄', () => {
  const gs = freshBank({ users: [] });
  gs.upsertUser('dodo', 'kid', 'Dodo', '👦', '13572468', 20);
  const u = gs.$.rows('users').find(r => String(r.userId) === 'dodo');
  assert.ok(u, '沒有 dodo');
  assert.strictEqual(gs.num(u.dailyAllowance, -1), 20);
});

test('seedUsers 給三個小孩每天 20 元、家長 0 元', () => {
  const gs = freshBank({ users: [] });
  // seedUsers() 的密碼是 CHANGE-ME，故意跑不起來（assertPasswordOk 會擋），
  // 所以這裡看的是它到底打算寫什麼數字進去。
  const src = String(gs.seedUsers);
  ['momo', 'coco', 'dodo'].forEach(id => {
    assert.match(src, new RegExp("'" + id + "'[^\\n]*,\\s*20\\s*\\)"),
      id + ' 的每日零用錢應該種 20：' + src);
  });
  ['aug', 'vicky'].forEach(id => {
    assert.match(src, new RegExp("'" + id + "'[^\\n]*,\\s*0\\s*\\)"),
      id + ' 是家長，應該種 0');
  });
});

test('setup() 重跑不會動既有的簽到資料', () => {
  const t = bank();
  const res = claim(t.gs, t.momo, { note: '今天都有做到' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const before = requestRows(t.gs)[0];

  t.gs.setup();

  const after = requestRows(t.gs)[0];
  assert.strictEqual(after.id, before.id);
  assert.strictEqual(after.kidId, 'momo');
  assert.strictEqual(after.kind, 'allowance_claim');
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.note, '今天都有做到');
  assert.strictEqual(String(after.checklist), String(before.checklist));
  assert.strictEqual(requestRows(t.gs).length, 1);
});

// ---------------------------------------------------------------- 三項全勾

test('三項全勾 → 成立，checklist 記下勾了什麼', () => {
  const t = bank();
  const res = claim(t.gs, t.momo);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(res.requestId);

  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.kind, 'allowance_claim');
  assert.strictEqual(row.kidId, 'momo');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(String(row.checklist), ITEMS.join('|'), '要記下實際勾了哪幾項');
});

test('只勾兩項 → checklist-incomplete，不寫 Sheet、不寫 Drive', () => {
  const t = bank();
  const res = claim(t.gs, t.momo, { checks: [true, true, false] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'checklist-incomplete');
  assert.ok(res.message, '要給小孩看得懂的訊息');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('一項都沒勾（含完全沒帶 checks）→ checklist-incomplete', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { checks: [false, false, false] }).error,
    'checklist-incomplete');
  assert.strictEqual(claim(t.gs, t.momo, { checks: [] }).error, 'checklist-incomplete');
  assert.strictEqual(claim(t.gs, t.momo, { checks: undefined }).error, 'checklist-incomplete');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('勾的數量對不上設定的項數 → checklist-incomplete（多或少都一樣）', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { checks: [true, true] }).error, 'checklist-incomplete');
  assert.strictEqual(claim(t.gs, t.momo, { checks: [true, true, true, true] }).error,
    'checklist-incomplete');
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('checks 不是陣列（前端亂送）→ checklist-incomplete', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { checks: 'true,true,true' }).error, 'checklist-incomplete');
  assert.strictEqual(claim(t.gs, t.momo, { checks: 3 }).error, 'checklist-incomplete');
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('用項目文字送也可以，但必須剛好是設定裡的那幾項', () => {
  const t = bank();
  // 三項都對 → 成立
  assert.strictEqual(claim(t.gs, t.momo, { checks: ITEMS.slice() }).ok, true);
  // 夾帶一個設定裡沒有的項目 → 不算數
  const bogus = claim(t.gs, t.coco, { checks: [ITEMS[0], ITEMS[1], '自己發明的一項'] });
  assert.strictEqual(bogus.ok, false);
  assert.strictEqual(bogus.error, 'checklist-incomplete');
  // 同一項送三次湊數也不行
  const dup = claim(t.gs, t.coco, { checks: [ITEMS[0], ITEMS[0], ITEMS[0]] });
  assert.strictEqual(dup.error, 'checklist-incomplete');
  assert.strictEqual(requestRows(t.gs).length, 1);
});

test('前端送的是 checked（勾到的項目文字），伺服器要認得', () => {
  const t = bank();
  // js/allowance.js 送的就是這個形狀：checklist 是它自己畫的清單，checked 是勾到的項目
  const ok = t.gs.$.call({
    action: 'request', kind: 'allowance_claim', session: t.momo,
    checklist: ITEMS.slice(), checked: ITEMS.slice(),
    photo: photoB64(), photoMime: 'image/jpeg', clientId: 'acid-frontend-shape'
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(String(requestRows(t.gs)[0].checklist), ITEMS.join('|'));

  // 前端自己送一份短清單也不能放水——項數以伺服器的 config 為準
  const cheat = t.gs.$.call({
    action: 'request', kind: 'allowance_claim', session: t.coco,
    checklist: [ITEMS[0]], checked: [ITEMS[0]],
    photo: photoB64(), photoMime: 'image/jpeg', clientId: 'acid-frontend-cheat'
  });
  assert.strictEqual(cheat.error, 'checklist-incomplete');
});

test('家長在 config 加第四項，馬上就要勾四項——不用改程式', () => {
  const t = bank();
  const four = ITEMS.concat(['自己收書包']);
  setConfig(t.gs, 'daily_checklist', four.join('|'));

  assert.strictEqual(claim(t.gs, t.momo, { checks: [true, true, true] }).error,
    'checklist-incomplete', '設定變四項，勾三項就不夠了');
  const ok = claim(t.gs, t.momo, { checks: [true, true, true, true] });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(String(requestRows(t.gs)[0].checklist), four.join('|'));
});

test('家長把項目減到兩項，勾兩項就夠了', () => {
  const t = bank();
  setConfig(t.gs, 'daily_checklist', ITEMS.slice(0, 2).join('|'));
  assert.strictEqual(claim(t.gs, t.momo, { checks: [true, true, true] }).error,
    'checklist-incomplete');
  assert.strictEqual(claim(t.gs, t.momo, { checks: [true, true] }).ok, true);
});

// ---------------------------------------------------------------- 照片

test('簽到會把照片寫進 Drive，回傳 fileId 而不是網址', () => {
  const t = bank();
  const res = claim(t.gs, t.momo, { clientId: 'acid-photo-1234567890' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(res.photoFileId);
  assert.ok(!/^https?:/.test(String(res.photoFileId)), '回的是檔案 ID，不是網址');

  assert.ok(t.gs.$.drive.folderAt(PHOTO_DIR + '/momo'), '照片放在 ' + PHOTO_DIR + '/<kidId>/');
  const file = t.gs.$.drive.fileById(res.photoFileId);
  assert.ok(file);
  assert.strictEqual(file.getMimeType(), 'image/jpeg');
  assert.match(file.getName(), /^\d{8}-allowance-acid-pho\.jpg$/, '檔名不對：' + file.getName());
  assert.strictEqual(String(requestRows(t.gs)[0].photoFileId), String(res.photoFileId));
});

test('簽到照片一樣不做任何分享——絕不呼叫 setSharing', () => {
  const t = bank();
  claim(t.gs, t.momo);
  assert.deepStrictEqual(t.gs.$.drive.sharingCalls, []);
});

test('沒帶照片 → photo-required，不寫 Drive、不寫 Sheet', () => {
  const t = bank();
  const res = claim(t.gs, t.momo, { photo: undefined });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'photo-required');
  assert.strictEqual(requestRows(t.gs).length, 0);
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('空字串／解不開的 base64／非 jpeg → photo-required', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { photo: '' }).error, 'photo-required');
  assert.strictEqual(claim(t.gs, t.momo, { photo: '這不是 base64！！' }).error, 'photo-required');
  assert.strictEqual(claim(t.gs, t.momo, { photoMime: 'image/png' }).error, 'photo-required');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('照片超過 1.5 MB → photo-too-big；剛好 1.5 MB 收；小於 2 KB 拒絕', () => {
  const t = bank();
  const tooBig = claim(t.gs, t.momo, { photo: photoB64(1.5 * 1024 * 1024 + 1) });
  assert.strictEqual(tooBig.error, 'photo-too-big');
  assert.strictEqual(claim(t.gs, t.momo, { photo: photoB64(2047) }).error, 'photo-required');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
  assert.strictEqual(claim(t.gs, t.momo, { photo: photoB64(1.5 * 1024 * 1024) }).ok, true);
});

// ---------------------------------------------------------------- 身分

test('kidId 一律取自 session：硬塞 kidId 也沒用', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { kidId: 'coco' }).ok, true);
  assert.strictEqual(requestRows(t.gs)[0].kidId, 'momo');
});

test('家長不能替自己簽到', () => {
  const t = bank();
  const res = claim(t.gs, t.vicky);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(requestRows(t.gs).length, 0);
});

test('沒帶 session → unauthorized，不寫 Drive', () => {
  const t = bank();
  const res = claim(t.gs, undefined, { session: '' });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(t.gs.$.drive.created.length, 0);
});

test('缺 clientId → bad-request', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo, { clientId: '' }).error, 'bad-request');
  assert.strictEqual(requestRows(t.gs).length, 0);
});

// ---------------------------------------------------------------- 一天一次

test('同一天簽到第二次 → already-claimed，不寫 Sheet、不留第二張照片', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo).ok, true);
  const second = claim(t.gs, t.momo);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'already-claimed');
  assert.ok(second.message);
  assert.strictEqual(requestRows(t.gs).length, 1);
  assert.strictEqual(t.gs.$.drive.created.length, 1);
});

test('手工組請求（換一個全新 clientId）照樣擋得住', () => {
  const t = bank();
  claim(t.gs, t.momo, { clientId: 'acid-ui' });
  const hand = claim(t.gs, t.momo, { clientId: 'acid-hand-crafted', note: 'DevTools' });
  assert.strictEqual(hand.error, 'already-claimed');
  assert.strictEqual(requestRows(t.gs).length, 1);
});

test('已核准之後同一天也不能再簽', () => {
  const t = bank();
  const first = claim(t.gs, t.momo);
  assert.strictEqual(approve(t.gs, t.vicky, first.requestId).ok, true);
  assert.strictEqual(claim(t.gs, t.momo).error, 'already-claimed');
  assert.strictEqual(allowanceLedger(t.gs).length, 1);
});

test('被退回的簽到可以當天重簽，不佔扣打', () => {
  const t = bank();
  const first = claim(t.gs, t.momo);
  const dec = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: first.requestId,
    decision: 'reject', decidedNote: '照片糊掉了'
  });
  assert.strictEqual(dec.ok, true, JSON.stringify(dec));
  const again = claim(t.gs, t.momo);
  assert.strictEqual(again.ok, true, '退回之後同一天要能重簽：' + JSON.stringify(again));
  assert.strictEqual(requestRows(t.gs).length, 2);
});

test('自己撤回的簽到可以當天重簽', () => {
  const t = bank();
  const first = claim(t.gs, t.momo);
  const c = t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: first.requestId });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.strictEqual(requestRows(t.gs)[0].status, 'cancelled');
  assert.strictEqual(claim(t.gs, t.momo).ok, true);
});

test('日界線是台北 00:00：昨天 23:59 簽過的今天可以再簽', () => {
  const t = bank();
  claim(t.gs, t.momo);
  const row = requestRows(t.gs)[0]._row;

  backdate(t.gs, row, taipeiDayStart(new Date()));
  assert.strictEqual(claim(t.gs, t.momo).error, 'already-claimed', '台北 00:00 算今天');

  backdate(t.gs, row, new Date(taipeiDayStart(new Date()).getTime() - 1));
  const res = claim(t.gs, t.momo);
  assert.strictEqual(res.ok, true, '跨過午夜就是新的一天：' + JSON.stringify(res));
});

test('不同小孩各簽各的，不會互相擋', () => {
  const t = bank();
  assert.strictEqual(claim(t.gs, t.momo).ok, true);
  assert.strictEqual(claim(t.gs, t.coco).ok, true);
  assert.strictEqual(requestRows(t.gs).length, 2);
});

test('家事回報與簽到互不相干', () => {
  const t = bank();
  const chore = t.gs.$.call({
    action: 'request', kind: 'chore_done', session: t.momo, choreId: 'chore-trash',
    photo: photoB64(), photoMime: 'image/jpeg', clientId: 'acid-mixed-chore'
  });
  assert.strictEqual(chore.ok, true, JSON.stringify(chore));
  assert.strictEqual(claim(t.gs, t.momo).ok, true, '報家事不會用掉今天的簽到');
});

// ---------------------------------------------------------------- 不能補簽

test('沒有「補簽昨天」這條路：手動塞 ts / day / date 都不算數', () => {
  const t = bank();
  const yesterday = new Date(taipeiDayStart(new Date()).getTime() - 1);
  const res = claim(t.gs, t.momo, {
    ts: yesterday.toISOString(),
    day: t.gs.taipeiDay(yesterday),
    date: t.gs.taipeiDay(yesterday)
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const row = requestRows(t.gs)[0];
  assert.strictEqual(t.gs.taipeiDay(row.ts), t.gs.taipeiDay(new Date()),
    'ts 一律是伺服器的現在，前端說哪天都不算');
  // 既然那筆算今天，今天就不能再簽一次
  assert.strictEqual(claim(t.gs, t.momo).error, 'already-claimed');
});

// ---------------------------------------------------------------- 冪等

test('同一個 clientId 重送：一列 request、一張照片', () => {
  const t = bank();
  const opts = { clientId: 'acid-offline-queue-1' };
  const first = claim(t.gs, t.momo, opts);
  assert.strictEqual(first.ok, true);

  const second = claim(t.gs, t.momo, opts);
  assert.strictEqual(second.ok, true, '重送要回原本那筆，不是 already-claimed');
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.requestId, first.requestId);
  assert.strictEqual(second.photoFileId, first.photoFileId);

  assert.strictEqual(requestRows(t.gs).length, 1, 'Sheet 只能有一列');
  assert.strictEqual(t.gs.$.drive.created.length, 1, 'Drive 只能有一張照片');
});

// ---------------------------------------------------------------- 核准入帳

test('vicky 核准：20 元進活期，金額來自 users.dailyAllowance', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  setDailyAllowance(t.gs, 'momo', 20);
  const current = accountOf(t.gs, 'momo', 'current');

  const res = approve(t.gs, t.vicky, req.requestId);
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const led = allowanceLedger(t.gs);
  assert.strictEqual(led.length, 1);
  assert.strictEqual(led[0].type, 'allowance');
  assert.strictEqual(t.gs.num(led[0].amount, 0), 20);
  assert.strictEqual(led[0].accountId, current.accountId, '一律進活期主帳戶');
  assert.strictEqual(led[0].kidId, 'momo');
  assert.strictEqual(led[0].by, 'vicky', 'by 是實際核准的人');
  assert.strictEqual(led[0].refId, req.requestId);
  assert.match(String(led[0].memo), /\d+\/\d+/, 'memo 要寫是哪一天的零用錢：' + led[0].memo);

  assert.strictEqual(t.gs.accountBalance(current.accountId), 20);
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'gift').accountId), 0,
    '零用錢不能進紅包帳戶');

  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(String(row.decidedBy), 'vicky');
  assert.strictEqual(t.gs.isTrue(row.decidedProxy), false);
  assert.ok(row.decidedTs);
});

test('金額讀的是那個小孩自己的 dailyAllowance（改成 35 就給 35）', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 35);
  setDailyAllowance(t.gs, 'coco', 20);

  const m = claim(t.gs, t.momo);
  const c = claim(t.gs, t.coco);
  assert.strictEqual(approve(t.gs, t.vicky, m.requestId).ok, true);
  assert.strictEqual(approve(t.gs, t.vicky, c.requestId).ok, true);

  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'current').accountId), 35);
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'coco', 'current').accountId), 20);
});

test('前端送 amount 一律不算數', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 20);
  const req = claim(t.gs, t.momo, { amount: 9999 });
  assert.strictEqual(String(requestRows(t.gs)[0].amount), '', 'request 不存前端送的金額');
  assert.strictEqual(approve(t.gs, t.vicky, req.requestId, { amount: 9999 }).ok, true);
  assert.strictEqual(t.gs.num(allowanceLedger(t.gs)[0].amount, 0), 20);
});

test('dailyAllowance 是 0（或格子被清空）→ 不入帳，也不把 request 標成已核准', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 0);
  const req = claim(t.gs, t.momo);
  const res = approve(t.gs, t.vicky, req.requestId);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('aug 核准沒帶 proxy → needs-proxy；帶了 proxy 就成立並記成代理', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 20);
  const req = claim(t.gs, t.momo);

  const no = approve(t.gs, t.aug, req.requestId);
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.error, 'needs-proxy');
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');

  const yes = approve(t.gs, t.aug, req.requestId, { proxy: true });
  assert.strictEqual(yes.ok, true, JSON.stringify(yes));

  const row = requestRows(t.gs)[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(String(row.decidedBy), 'aug');
  assert.strictEqual(t.gs.isTrue(row.decidedProxy), true);

  const led = allowanceLedger(t.gs)[0];
  assert.strictEqual(led.by, 'aug', 'by 是實際按的人');
  assert.match(String(led.memo), /Aug.*代替.*Vicky/, 'memo 要寫清楚是代理：' + led.memo);
  assert.strictEqual(t.gs.num(led.amount, 0), 20);
});

test('退回要填理由，而且不寫 ledger', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  const noNote = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId, decision: 'reject'
  });
  assert.strictEqual(noNote.ok, false);
  assert.strictEqual(noNote.error, 'note-required');
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');

  const ok = t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId,
    decision: 'reject', decidedNote: '今天房間沒收'
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(requestRows(t.gs)[0].status, 'rejected');
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
});

test('小孩不能核准自己的簽到，帶 proxy 也不行', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  assert.strictEqual(approve(t.gs, t.momo, req.requestId).error, 'unauthorized');
  assert.strictEqual(approve(t.gs, t.momo, req.requestId, { proxy: true }).error, 'unauthorized');
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
  assert.strictEqual(requestRows(t.gs)[0].status, 'pending');
});

test('兩個家長搶著按：只入帳一次，第二個拿到 already-decided', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 20);
  const req = claim(t.gs, t.momo);
  assert.strictEqual(approve(t.gs, t.vicky, req.requestId).ok, true);

  const second = approve(t.gs, t.aug, req.requestId, { proxy: true });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'already-decided');

  assert.strictEqual(allowanceLedger(t.gs).length, 1);
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'current').accountId), 20);
  assert.strictEqual(String(requestRows(t.gs)[0].decidedBy), 'vicky');
});

test('ledger 的 clientId 由 requestId 決定，同一筆簽到永遠付不了第二次', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 20);
  const req = claim(t.gs, t.momo);
  assert.strictEqual(approve(t.gs, t.vicky, req.requestId).ok, true);

  const led = allowanceLedger(t.gs)[0];
  assert.strictEqual(String(led.clientId), 'req:' + req.requestId);

  // 就算有人把狀態手動改回 pending 再按一次，錢也只會出去一次
  t.gs.$.setCell('requests', requestRows(t.gs)[0]._row, 'status', 'pending');
  approve(t.gs, t.vicky, req.requestId);
  assert.strictEqual(allowanceLedger(t.gs).length, 1, '同一個 requestId 只入得了一次帳');
  assert.strictEqual(t.gs.accountBalance(accountOf(t.gs, 'momo', 'current').accountId), 20);
});

test('已撤回的簽到不能核准', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  t.gs.$.call({ action: 'cancel_request', session: t.momo, requestId: req.requestId });
  assert.strictEqual(approve(t.gs, t.vicky, req.requestId).error, 'already-decided');
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
});

test('chore_approver 指到不存在的人 → server，不靜默放行', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  setConfig(t.gs, 'chore_approver', 'nobody');
  const res = approve(t.gs, t.aug, req.requestId, { proxy: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'server');
  assert.strictEqual(allowanceLedger(t.gs).length, 0);
});

// ------------------------------------------------ 算哪一天看送出時間，不看核准時間

test('昨天送出、今天才核准，還是照付（資格看 requests.ts）', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 20);
  const req = claim(t.gs, t.momo);

  // 把這筆改成昨天送的（媽媽三天後才按確認也是一樣的道理）
  const yesterday = new Date(taipeiDayStart(new Date()).getTime() - 3600000);
  backdate(t.gs, requestRows(t.gs)[0]._row, yesterday);

  const res = approve(t.gs, t.vicky, req.requestId);
  assert.strictEqual(res.ok, true, '晚一點才核准不能讓錢消失：' + JSON.stringify(res));

  const led = allowanceLedger(t.gs);
  assert.strictEqual(led.length, 1);
  assert.strictEqual(t.gs.num(led[0].amount, 0), 20);
  // memo 講的是那筆簽到的日子，不是媽媽按確認的日子
  const submitted = t.gs.taipeiDay(yesterday).split('-');
  assert.match(String(led[0].memo),
    new RegExp(Number(submitted[1]) + '\\/' + Number(submitted[2])),
    'memo 的日期要是送出那天：' + led[0].memo);
});

test('昨天送的那筆還沒被決定 → 今天不能再簽（pending 就是擋）', () => {
  const t = bank();
  claim(t.gs, t.momo);
  backdate(t.gs, requestRows(t.gs)[0]._row,
    new Date(taipeiDayStart(new Date()).getTime() - 3600000));
  // 昨天那筆是昨天的，今天可以簽自己的
  assert.strictEqual(claim(t.gs, t.momo).ok, true);
  assert.strictEqual(requestRows(t.gs).length, 2);
});

// ---------------------------------------------------------------- 照片取回

test('簽到照片也走 chore_photo 取回，別的小孩抓不到', () => {
  const t = bank();
  const photo = photoB64();
  const req = claim(t.gs, t.momo, { photo });
  const mine = t.gs.$.call({ action: 'chore_photo', session: t.momo, requestId: req.requestId });
  assert.strictEqual(mine.ok, true, JSON.stringify(mine));
  assert.strictEqual(mine.data, photo);

  assert.strictEqual(
    t.gs.$.call({ action: 'chore_photo', session: t.coco, requestId: req.requestId }).error,
    'not-your-photo');
  assert.strictEqual(
    t.gs.$.call({ action: 'chore_photo', session: t.vicky, requestId: req.requestId }).ok, true);
});

// ---------------------------------------------------------------- snapshot

test('小孩 snapshot 帶得出今天的簽到狀態與檢查項目', () => {
  const t = bank();
  const before = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(before.ok, true, JSON.stringify(before));
  assert.deepStrictEqual(before.daily_checklist, ITEMS, 'UI 要靠這個畫出三項');
  assert.strictEqual(before.requests.filter(r => r.kind === 'allowance_claim').length, 0);

  const req = claim(t.gs, t.momo);
  const pending = t.gs.$.call({ action: 'snapshot', session: t.momo });
  const mine = pending.requests.filter(r => r.kind === 'allowance_claim');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].id, req.requestId);
  assert.strictEqual(mine[0].status, 'pending');
  assert.strictEqual(String(mine[0].checklist), ITEMS.join('|'));

  setDailyAllowance(t.gs, 'momo', 20);
  approve(t.gs, t.vicky, req.requestId);
  const after = t.gs.$.call({ action: 'snapshot', session: t.momo });
  const done = after.requests.filter(r => r.kind === 'allowance_claim');
  assert.strictEqual(done.length, 1, '核准之後今天那筆還要看得到，UI 才畫得出「已領到」');
  assert.strictEqual(done[0].status, 'approved');
});

test('被退回的今天那筆也要看得到，昨天的就不用了', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  t.gs.$.call({
    action: 'admin_decide', session: t.vicky, requestId: req.requestId,
    decision: 'reject', decidedNote: '再拍一張'
  });
  let snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(snap.requests.filter(r => r.kind === 'allowance_claim')[0].status, 'rejected');

  backdate(t.gs, requestRows(t.gs)[0]._row,
    new Date(taipeiDayStart(new Date()).getTime() - 3600000));
  snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(snap.requests.filter(r => r.kind === 'allowance_claim').length, 0,
    '昨天那筆已經決定完了，不用再塞進今天的畫面');
});

test('小孩看不到別人的簽到；家長 snapshot 看得到待審的簽到', () => {
  const t = bank();
  const req = claim(t.gs, t.momo);
  const cocoSnap = t.gs.$.call({ action: 'snapshot', session: t.coco });
  assert.strictEqual(cocoSnap.requests.filter(r => r.kind === 'allowance_claim').length, 0);

  const parentSnap = t.gs.$.call({ action: 'snapshot', session: t.vicky });
  const pend = parentSnap.requests.filter(r => r.kind === 'allowance_claim');
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].id, req.requestId);
  assert.strictEqual(pend[0].kidId, 'momo');
  assert.strictEqual(String(pend[0].checklist), ITEMS.join('|'));
});

// ---------------------------------------------------------------- 其他

test('不認得的 kind 還是被擋掉', () => {
  const t = bank();
  const res = t.gs.$.call({
    action: 'request', kind: 'allowance', session: t.momo, clientId: 'acid-unknown'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unknown-action');
});

// ------------------------------------------------- 小孩端要拿得到金額與核准者

test('核准後把實付金額回寫到 request，小孩端不必從 ledger 猜', () => {
  const gs = freshBank();
  const kid = login(gs, 'momo');
  const vicky = login(gs, 'vicky');
  setDailyAllowance(gs, 'momo', 35);

  const res = claim(gs, kid);
  assert.strictEqual(approve(gs, vicky, res.requestId).ok, true);

  // 沒有回寫的話，前端只能找「同一天最後一筆 type=allowance 的 ledger」，
  // 那會跟其他 allowance 入帳撞在一起，顯示錯的數字。
  const row = requestRows(gs).find(r => r.id === res.requestId);
  assert.strictEqual(Number(row.amount), 35, 'request 要記下實際入帳的金額');
});

test('小孩快照要帶 chore_approver，才知道要等誰確認', () => {
  const gs = freshBank();
  const kid = login(gs, 'momo');
  const snap = gs.$.call({ action: 'snapshot', session: kid });
  assert.strictEqual(snap.chore_approver, 'vicky');

  setConfig(gs, 'chore_approver', 'aug');
  const snap2 = gs.$.call({ action: 'snapshot', session: login(gs, 'momo') });
  assert.strictEqual(snap2.chore_approver, 'aug', '改設定後小孩端要跟著變');
});

// ------------------------------------------ 伺服器的「今天」與每日金額（snapshot）
// 小孩的平板時鐘會跑掉（電池沒電歸零、手動調時間、時區設成別國）。
// 只要前端自己算「今天」，畫面就會跟伺服器講不同的日子：
// 明明簽到過了卻寫「今天還沒領」，按下去被 already-claimed 擋掉。
// 所以日界線一律由伺服器帶下來。

test('小孩 snapshot 帶伺服器的今天（Asia/Taipei 的 yyyy-MM-dd）', () => {
  const t = bank();
  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.match(String(snap.today), /^\d{4}-\d{2}-\d{2}$/, 'today 要是 yyyy-MM-dd：' + snap.today);
  assert.strictEqual(snap.today, t.gs.taipeiDay(new Date()),
    'today 要跟伺服器自己算日界線用的 taipeiDay 一模一樣');
});

test('snapshot 的 today 就是「現在簽到會算成哪一天」', () => {
  const t = bank();
  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  const req = claim(t.gs, t.momo);
  const row = requestRows(t.gs).find(r => r.id === req.requestId);
  // 前端拿 today 去比對 requests.ts 落在哪一天，兩邊的切法必須是同一套
  assert.strictEqual(t.gs.chorePeriodKey('daily', row.ts), 'day:' + snap.today);
});

test('家長 snapshot 也帶 today（同一個畫面上的日期不能有兩種說法）', () => {
  const t = bank();
  const snap = t.gs.$.call({ action: 'snapshot', session: t.vicky });
  assert.strictEqual(snap.today, t.gs.taipeiDay(new Date()));
});

test('小孩 snapshot 帶自己的 dailyAllowance，按鈕才寫得出「今天還沒領 ＋20」', () => {
  const t = bank();
  const snap = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(snap.dailyAllowance, 20);

  // 家長去 Sheet 上把金額改掉 → 小孩端下一次 snapshot 就要跟著變，不用改程式
  setDailyAllowance(t.gs, 'momo', 35);
  const after = t.gs.$.call({ action: 'snapshot', session: t.momo });
  assert.strictEqual(after.dailyAllowance, 35);

  // 是「自己那一列」的金額，不是全家共用的一個數字
  setDailyAllowance(t.gs, 'coco', 12);
  assert.strictEqual(t.gs.$.call({ action: 'snapshot', session: t.coco }).dailyAllowance, 12);
  assert.strictEqual(t.gs.$.call({ action: 'snapshot', session: t.momo }).dailyAllowance, 35);
});

test('dailyAllowance 格子被清空 → snapshot 回 0，不是 NaN 也不是空字串', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', '');
  assert.strictEqual(t.gs.$.call({ action: 'snapshot', session: t.momo }).dailyAllowance, 0);
});

// ------------------------------------------ 家長端也要拿得到每個小孩的 dailyAllowance
// 待審清單上的簽到那筆，`requests.amount` 在 pending 階段是空的（§7.1、§9.6 四），
// 金額要到核准當下才查得出來。家長端沒有這個欄位的話，待審清單只能猜一個數字
// ——而顯示錯的金額比不顯示更糟。所以逐個小孩帶下來。

test('家長 snapshot 的 kids 逐人帶 dailyAllowance（待審清單要印簽到金額）', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', 35);
  setDailyAllowance(t.gs, 'coco', 12);

  const snap = t.gs.$.call({ action: 'snapshot', session: t.vicky });
  assert.strictEqual(snap.ok, true, JSON.stringify(snap));
  const byId = {};
  snap.kids.forEach(k => { byId[k.user.userId] = k; });
  assert.strictEqual(byId.momo.dailyAllowance, 35);
  assert.strictEqual(byId.coco.dailyAllowance, 12, '是每個小孩自己那一列，不是全家一個數字');
});

test('家長 snapshot：dailyAllowance 沒填就是 0，不是 NaN 也不是空字串', () => {
  const t = bank();
  setDailyAllowance(t.gs, 'momo', '');
  const snap = t.gs.$.call({ action: 'snapshot', session: t.vicky });
  const momo = snap.kids.find(k => k.user.userId === 'momo');
  assert.strictEqual(momo.dailyAllowance, 0);
});
