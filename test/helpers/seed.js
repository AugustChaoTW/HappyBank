'use strict';
// 種子資料一律用 Setup.gs 真正的 setup() / upsertUser() 做出來，
// 不要在測試裡手寫一份 schema——否則 SCHEMA 改了測試還會綠燈。

const { loadGs } = require('./load-gs.js');

// 測試帳號。小孩密碼必須是 8 位數字（SPEC §8.1）。
const USERS = {
  momo:  { role: 'kid',    displayName: 'Momo',  emoji: '👧', password: '12345678', weekly: 50 },
  coco:  { role: 'kid',    displayName: 'Coco',  emoji: '👧', password: '87654321', weekly: 50 },
  aug:   { role: 'parent', displayName: 'Aug',   emoji: '🧑', password: 'parent-pw-123', weekly: 0 },
  vicky: { role: 'parent', displayName: 'Vicky', emoji: '👩', password: 'parent-pw-456', weekly: 0 }
};

// 一間全新的銀行：真的跑過 setup()，真的建過帳號。
function freshBank(options) {
  const opts = options || {};
  const gs = loadGs(opts);
  gs.setup();
  const who = opts.users || Object.keys(USERS);
  who.forEach(id => {
    const u = USERS[id];
    if (!u) throw new Error('seed.js 沒有這個測試帳號：' + id);
    gs.upsertUser(id, u.role, u.displayName, u.emoji, u.password, u.weekly);
  });
  return gs;
}

// 登入並回傳 session token；失敗直接炸掉，免得測試在後面才莫名其妙壞掉。
function login(gs, userId, password) {
  const pw = password === undefined ? (USERS[String(userId).toLowerCase()] || {}).password : password;
  const res = gs.$.call({ action: 'login', userId, password: pw });
  if (!res.ok) throw new Error('seed.login 失敗（' + userId + '）：' + JSON.stringify(res));
  return res.session;
}

// 常用組合：一個小孩 session + 一個家長 session
function loggedIn(options) {
  const gs = freshBank(options);
  return {
    gs,
    momo: login(gs, 'momo'),
    coco: login(gs, 'coco'),
    aug: login(gs, 'aug')
  };
}

// 找出某個小孩的某種帳戶（給 ledger/authz 測試用）
function accountOf(gs, kidId, type) {
  const a = gs.$.rows('accounts')
    .find(r => String(r.kidId) === kidId && r.type === type && r.status !== 'closed');
  if (!a) throw new Error('找不到 ' + kidId + ' 的 ' + type + ' 帳戶');
  return a;
}

module.exports = { USERS, freshBank, login, loggedIn, accountOf };
