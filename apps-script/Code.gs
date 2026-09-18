// HappyBank — API 端點（M1：登入、snapshot、家長調帳）
// 每週零用錢與每月計息的 time-driven trigger 屬於 M3，還沒實作。
// 部署：Apps Script > Deploy > Web app > Execute as: Me / Who has access: Anyone
// 部署後把 Web app URL 填進前端 js/config.js 的 apiUrl。
//
// 安全模型（SPEC §8）：
//   TOKEN 只是雜訊過濾，它跟前端一起公開在 GitHub 上，不是安全機制。
//   真正的身分驗證是 session；所有金額都在這裡計算，前端送的只是意圖。

// SHEET_ID 與 TOKEN 宣告在 Config.gs（同專案共用全域範圍）

// ---------------------------------------------------------------- 路由

function doGet(e) {
  return route(e.parameter || {});
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ ok: false, error: 'bad-json' });
  }
  return route(body);
}

function route(p) {
  _cache = {};   // 每個請求重新讀表，不跨請求快取
  _config = null;
  try {
    if (p.token !== TOKEN) return respond({ ok: false, error: 'bad-token' });

    switch (p.action) {
      // 不需登入
      case 'users':    return respond(apiUsers());
      case 'login':    return respond(apiLogin(p));
      // 需要登入
      case 'whoami':   return respond({ ok: true, user: publicUser(requireSession(p)) });
      case 'logout':   return respond(apiLogout(p));
      case 'snapshot': return respond(apiSnapshot(p));
      case 'change_password': return respond(apiChangePassword(p));
      // 家長專用
      case 'admin_adjust': return respond(apiAdminAdjust(p));
      case 'admin_gift':   return respond(apiAdminGift(p));
      case 'admin_recalc': return respond(apiAdminRecalc(p));
      default: return respond({ ok: false, error: 'unknown-action', message: '不認得的 action：' + p.action });
    }
  } catch (err) {
    const msg = String(err && err.message || err);
    // requireSession / requireParent 丟出的是可以直接給使用者看的錯誤
    if (msg.indexOf('AUTH:') === 0) {
      return respond({ ok: false, error: 'unauthorized', message: msg.slice(5) });
    }
    if (msg.indexOf('BUSY:') === 0) {
      return respond({ ok: false, error: 'busy', message: msg.slice(5) });
    }
    Logger.log(err);
    return respond({ ok: false, error: 'server', message: msg });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 表格存取

function book() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function sheetOf(name) {
  const sh = book().getSheetByName(name);
  if (!sh) throw new Error('找不到分頁 ' + name + '，請先執行 Setup.gs 的 setup()');
  return sh;
}

// 每個請求內的讀表快取。Sheets 每次 getValues 都是一趟網路來回，
// 一個 snapshot 原本要讀十幾次整張表。
let _cache = {};
let _config = null;

function readTable(name) {
  if (!_cache[name]) _cache[name] = loadTable(name);
  return _cache[name];
}

function invalidate(name) {
  delete _cache[name];
}

// 讀整張表成物件陣列，並附上 _row（實際列號）方便就地更新
function loadTable(name) {
  const sh = sheetOf(name);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) o[h] = r[c]; });
    return o;
  }).filter(o => String(o[headers[0]]) !== '');
}

function headersOf(name) {
  const sh = sheetOf(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function appendObj(name, obj) {
  const sh = sheetOf(name);
  sh.appendRow(headersOf(name).map(h => (obj[h] === undefined ? '' : obj[h])));
  invalidate(name);
}

// 就地更新某幾欄
function patchRow(name, row, patch) {
  const sh = sheetOf(name);
  const headers = headersOf(name);
  Object.keys(patch).forEach(k => {
    const c = headers.indexOf(k);
    if (c >= 0) sh.getRange(row, c + 1).setValue(patch[k]);
  });
  invalidate(name);
}

function findBy(name, field, value) {
  const want = String(value).toLowerCase();
  const rows = readTable(name);
  for (const r of rows) if (String(r[field]).toLowerCase() === want) return r;
  return null;
}

function getConfigValue(key) {
  if (!_config) {
    _config = {};
    readTable('config').forEach(r => { _config[String(r.key)] = r.value; });
  }
  return _config.hasOwnProperty(key) ? _config[key] : null;
}

// 空字串、null、undefined 都要吃 fallback。
// Number('') 與 Number(null) 都是 0 而不是 NaN——少了這層檢查，
// 家長不小心清掉一格 config 就會讓 pbkdf_rounds 變 0（= 不雜湊）、
// 利率變 0、session 一出生就過期。
function num(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

// Sheets 格子被手改成怪東西時，toISOString() 會丟 RangeError 把整個 snapshot 打掛
function toIso(v) {
  if (v === '' || v === null || v === undefined) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// 整個請求只拿一次鎖。Apps Script 的 script lock 不可重入，
// 巢狀呼叫（例如 login 裡再呼叫 ensureDefaultAccounts）必須共用同一把。
let _lockHeld = false;

function withLock(fn) {
  if (_lockHeld) return fn();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    throw new Error('BUSY:銀行正在忙，請過幾秒再試一次。');
  }
  _lockHeld = true;
  try {
    return fn();
  } finally {
    _lockHeld = false;
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- 登入

// 公開的頭像名單：只有暱稱與 emoji，不含任何機密
function apiUsers() {
  const users = readTable('users')
    .filter(u => isTrue(u.active))
    .map(u => ({ userId: u.userId, role: u.role, displayName: u.displayName, emoji: u.emoji }));
  return { ok: true, users };
}

function apiLogin(p) {
  const userId = String(p.userId || '').trim().toLowerCase();
  const password = String(p.password || '');
  // 一律用同一句話，不洩漏帳號是否存在（SPEC §7.0）
  const DENY = { ok: false, error: 'bad-credentials', message: '帳號或密碼不對，再試一次。' };
  if (!userId || !password) return DENY;

  const user = findBy('users', 'userId', userId);
  const cred = findBy('credentials', 'userId', userId);
  if (!user || !cred) return DENY;
  if (!isTrue(user.active)) return DENY;

  const lockedUntil = cred.lockedUntil ? new Date(cred.lockedUntil) : null;
  if (lockedUntil && !isNaN(lockedUntil.getTime()) && lockedUntil > new Date()) {
    const mins = Math.ceil((lockedUntil - new Date()) / 60000);
    return { ok: false, error: 'locked', message: '密碼錯太多次了，請等 ' + mins + ' 分鐘再試。' };
  }

  // 雜湊要跑 1000 輪 SHA-256（約 1~3 秒），絕不能握著全域鎖做——
  // 三個小孩同時按登入的話後面兩個會等到 timeout。
  const rounds = num(getConfigValue('pbkdf_rounds'), 1000);
  const attempted = hashPassword(password, cred.salt, rounds);

  return withLock(() => {
    if (attempted !== String(cred.passwordHash)) {
      const failed = num(cred.failedCount, 0) + 1;
      const max = Math.max(1, num(getConfigValue('login_max_fail'), 5));
      if (failed >= max) {
        const mins = num(getConfigValue('login_lock_minutes'), 15);
        patchRow('credentials', cred._row, {
          failedCount: 0, lockedUntil: new Date(Date.now() + mins * 60000)
        });
        return { ok: false, error: 'locked', message: '密碼錯太多次了，請等 ' + mins + ' 分鐘再試。' };
      }
      patchRow('credentials', cred._row, { failedCount: failed });
      return DENY;
    }

    // 成功
    patchRow('credentials', cred._row, { failedCount: 0, lockedUntil: '' });
    patchRow('users', user._row, { lastLoginTs: new Date() });

    const isKid = user.role === 'kid';
    const ms = isKid
      ? num(getConfigValue('session_days_kid'), 30) * 86400000
      : num(getConfigValue('session_hours_parent'), 24) * 3600000;
    const session = Utilities.getUuid();
    const expiresTs = new Date(Date.now() + ms);
    appendObj('sessions', {
      token: session, userId: userId, createdTs: new Date(),
      expiresTs: expiresTs, device: String(p.device || '').slice(0, 120)
    });

    if (isKid) ensureDefaultAccounts(userId);

    return { ok: true, session, expiresTs: expiresTs.toISOString(), user: publicUser(user) };
  });
}

// Sheets 存的是真布林，但手打的 TRUE 也要認
function isTrue(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function apiLogout(p) {
  const user = requireSession(p);
  const s = findBy('sessions', 'token', String(p.session || ''));
  if (s && String(s.userId) === String(user.userId)) {
    patchRow('sessions', s._row, { expiresTs: new Date(0) });
  }
  return { ok: true };
}

function requireSession(p) {
  const token = String(p.session || '');
  if (!token) throw new Error('AUTH:請先登入。');
  const s = findBy('sessions', 'token', token);
  if (!s) throw new Error('AUTH:登入已失效，請重新登入。');
  // expiresTs 被清掉或變成怪字串時，`invalidDate < now` 會是 false，
  // 那張 session 就永遠有效了。改成「不是明確還沒到期就當作過期」。
  const exp = new Date(s.expiresTs).getTime();
  if (!(exp > Date.now())) throw new Error('AUTH:登入過期了，請重新登入。');
  const user = findBy('users', 'userId', s.userId);
  if (!user) throw new Error('AUTH:找不到這個帳號。');
  return user;
}

function requireParent(p) {
  const user = requireSession(p);
  if (user.role !== 'parent') throw new Error('AUTH:這個功能只有爸爸媽媽可以用。');
  return user;
}

function publicUser(u) {
  return { userId: u.userId, role: u.role, displayName: u.displayName, emoji: u.emoji };
}

function apiChangePassword(p) {
  const user = requireSession(p);
  const cred = findBy('credentials', 'userId', user.userId);
  if (!cred) return { ok: false, error: 'no-credentials', message: '這個帳號還沒設定密碼。' };
  const rounds = num(getConfigValue('pbkdf_rounds'), 1000);
  if (hashPassword(String(p.oldPassword || ''), cred.salt, rounds) !== String(cred.passwordHash)) {
    return { ok: false, error: 'bad-credentials', message: '舊密碼不對。' };
  }
  const np = String(p.newPassword || '');
  if (user.role === 'kid') {
    const n = num(getConfigValue('kid_password_digits'), 8);
    if (!new RegExp('^\\d{' + n + '}$').test(np)) {
      return { ok: false, error: 'bad-format', message: '新密碼要剛好 ' + n + ' 個數字。' };
    }
  } else if (np.length < 8) {
    return { ok: false, error: 'bad-format', message: '新密碼至少 8 個字元。' };
  }
  const salt = newSalt();
  const hash = hashPassword(np, salt, rounds);
  return withLock(() => {
    patchRow('credentials', cred._row, { salt, passwordHash: hash, updatedTs: new Date() });
    // 改密碼等於「我不要之前那些裝置了」，其他 session 一併失效
    readTable('sessions')
      .filter(s => String(s.userId) === String(user.userId) && s.token !== p.session)
      .forEach(s => patchRow('sessions', s._row, { expiresTs: new Date(0) }));
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 帳戶

// 每個小孩第一次登入時自動開好活期主帳戶與紅包帳戶
function ensureDefaultAccounts(kidId) {
  if (!kidId) return;
  // 沒有鎖的話，登入與第一次 snapshot 幾乎同時打進來會各開一個活期帳戶，
  // 之後入帳就會散在兩個帳戶上。
  withLock(() => {
    const mine = readTable('accounts')
      .filter(a => String(a.kidId) === kidId && a.status !== 'closed');
    const has = type => mine.some(a => a.type === type);

    if (!has('current')) {
      openAccount(kidId, 'current', '我的活期帳戶', '💰',
        num(getConfigValue('rate_current'), 0.05), '', '');
    }
    if (!has('gift')) {
      openAccount(kidId, 'gift', '阿公阿嬤的錢', '🧧',
        num(getConfigValue('rate_gift'), 0), '', '');
    }
  });
}

function openAccount(kidId, type, name, emoji, rate, lockUntil, targetAmount) {
  const accountId = Utilities.getUuid();
  appendObj('accounts', {
    accountId, kidId, type, name, emoji,
    rateMonthly: rate, lockUntil: lockUntil || '', targetAmount: targetAmount || '',
    balance: 0, status: 'active', createdTs: new Date()
  });
  return accountId;
}

// 唯一的寫帳入口。amount 正=入帳、負=出帳。
function postLedger(opts) {
  return withLock(() => {
    // 冪等：同一個 clientId 只會入帳一次（SPEC §7.3）
    if (opts.clientId) {
      // 這裡不能用 findBy——它會把兩邊轉小寫，兩筆只差大小寫的不同交易
      // 會被誤判成重複，第二筆的錢就無聲消失了。
      const want = String(opts.clientId);
      const dup = readTable('ledger').filter(l => String(l.clientId) === want)[0];
      if (dup) return { ok: true, duplicate: true, balanceAfter: num(dup.balanceAfter, 0) };
    }

    const acc = findBy('accounts', 'accountId', opts.accountId);
    if (!acc) return { ok: false, error: 'no-account', message: '找不到這個帳戶。' };
    // 關掉的帳戶一律不能再動。錢進得去但 accountsOf() 會把它濾掉，
    // 結果是這筆錢在每個畫面上都不見、只剩 ledger 裡有。
    // matured 的定存要放行，否則到期的錢領不回活期。
    if (acc.status === 'closed') {
      return { ok: false, error: 'account-closed', message: '這個帳戶已經關閉了。' };
    }

    const amount = Math.round(num(opts.amount, 0));
    if (!amount) return { ok: false, error: 'zero-amount', message: '金額不能是 0。' };

    // 餘額一律由 ledger 加總得出，不信 accounts.balance 那個快取欄。
    // 否則上一次寫帳只寫了一半（ledger 成功、balance 沒寫）時，
    // 這次會接著算錯，而且錯進歷史 balanceAfter 裡再也回不來。
    const balance = accountBalance(acc.accountId);
    const balanceAfter = balance + amount;
    if (balanceAfter < 0 && !opts.allowNegative) {
      return { ok: false, error: 'insufficient', message: '餘額不夠，只有 ' + balance + ' 元。' };
    }

    appendObj('ledger', {
      id: Utilities.getUuid(), ts: new Date(), kidId: acc.kidId, accountId: acc.accountId,
      type: opts.type, amount: amount, balanceAfter: balanceAfter,
      memo: opts.memo || '', by: opts.by || 'system',
      refId: opts.refId || '', clientId: opts.clientId || ''
    });
    patchRow('accounts', acc._row, { balance: balanceAfter });

    return { ok: true, balanceAfter };
  });
}

function accountBalance(accountId) {
  return readTable('ledger')
    .filter(l => String(l.accountId) === String(accountId))
    .reduce((n, l) => n + num(l.amount, 0), 0);
}

// ---------------------------------------------------------------- snapshot

function apiSnapshot(p) {
  const user = requireSession(p);

  const rates = {
    current: num(getConfigValue('rate_current'), 0.05),
    term: num(getConfigValue('rate_term'), 0.10),
    goal: num(getConfigValue('rate_goal'), 0.05),
    gift: num(getConfigValue('rate_gift'), 0)
  };

  if (user.role === 'kid') {
    ensureDefaultAccounts(user.userId);
    return {
      ok: true, serverTs: new Date().toISOString(), rates,
      user: publicUser(user),
      accounts: accountsOf(user.userId),
      ledger: ledgerOf(user.userId, 50),
      requests: readTable('requests')
        .filter(r => String(r.kidId) === user.userId && r.status === 'pending')
        .map(stripRow),
      chores: readTable('chores')
        .filter(c => isTrue(c.active))
        .filter(c => !c.kidId || String(c.kidId) === user.userId)
        .map(stripRow)
    };
  }

  // 家長：全家一覽 + 所有待審
  const kids = readTable('users')
    .filter(u => u.role === 'kid' && isTrue(u.active))
    .map(k => {
      const accounts = accountsOf(k.userId);
      return {
        user: publicUser(k), accounts,
        total: accounts.reduce((n, a) => n + a.balance, 0)
      };
    });
  return {
    ok: true, serverTs: new Date().toISOString(), rates,
    user: publicUser(user), kids,
    requests: readTable('requests').filter(r => r.status === 'pending').map(stripRow),
    ledger: readTable('ledger').slice(-50).reverse().map(stripRow)
  };
}

function accountsOf(kidId) {
  return readTable('accounts')
    .filter(a => String(a.kidId) === kidId && a.status !== 'closed')
    .map(a => ({
      accountId: a.accountId, type: a.type, name: a.name, emoji: a.emoji,
      rateMonthly: num(a.rateMonthly, 0),
      lockUntil: toIso(a.lockUntil),
      targetAmount: a.targetAmount === '' ? null : num(a.targetAmount, 0),
      balance: num(a.balance, 0), status: a.status
    }));
}

function ledgerOf(kidId, limit) {
  return readTable('ledger')
    .filter(l => String(l.kidId) === kidId)
    .slice(-limit).reverse()
    .map(l => ({
      id: l.id, ts: toIso(l.ts), accountId: l.accountId,
      type: l.type, amount: num(l.amount, 0), balanceAfter: num(l.balanceAfter, 0),
      memo: l.memo, by: l.by
    }));
}

function stripRow(o) {
  const c = {};
  Object.keys(o).forEach(k => { if (k !== '_row') c[k] = o[k]; });
  return c;
}

// ---------------------------------------------------------------- 家長操作

function apiAdminAdjust(p) {
  const parent = requireParent(p);
  const kidId = String(p.kidId || '').toLowerCase();
  const acc = findBy('accounts', 'accountId', String(p.accountId || ''));
  if (!acc) return { ok: false, error: 'no-account', message: '找不到這個帳戶。' };
  // 少了這道檢查，admin 頁帶錯 accountId 會入到別的小孩帳上，
  // 而且 ledger 看起來完全自洽，事後查不出來。
  if (!kidId || String(acc.kidId).toLowerCase() !== kidId) {
    return { ok: false, error: 'kid-mismatch', message: '這個帳戶不屬於指定的小孩。' };
  }
  if (acc.status !== 'active') {
    return { ok: false, error: 'account-inactive', message: '這個帳戶目前不能異動。' };
  }

  const amount = Math.round(num(p.amount, 0));
  return postLedger({
    accountId: acc.accountId, type: amount >= 0 ? 'adjust' : 'penalty',
    amount, memo: String(p.memo || ''), by: parent.userId,
    clientId: p.clientId, allowNegative: !!p.allowNegative
  });
}

function apiAdminGift(p) {
  const parent = requireParent(p);
  const kidId = String(p.kidId || '').toLowerCase();
  // 沒驗證的話，打錯字會替一個不存在的小孩開帳戶並把紅包丟進去，
  // 錢從所有人的畫面上消失。
  const kid = findBy('users', 'userId', kidId);
  if (!kid || kid.role !== 'kid') {
    return { ok: false, error: 'no-kid', message: '找不到這個小孩。' };
  }
  ensureDefaultAccounts(kidId);
  const gift = readTable('accounts')
    .filter(a => String(a.kidId) === kidId && a.type === 'gift' && a.status === 'active')[0];
  if (!gift) return { ok: false, error: 'no-account', message: '找不到紅包帳戶。' };
  return postLedger({
    accountId: gift.accountId, type: 'gift_in', amount: Math.round(num(p.amount, 0)),
    memo: String(p.memo || '紅包'), by: parent.userId, clientId: p.clientId
  });
}

// 從 ledger 全量重算所有帳戶餘額，用來校驗 accounts.balance 這個快取欄
function apiAdminRecalc(p) {
  requireParent(p);
  // 沒有鎖的話，這個「保證一致」的函式本身會把並行的入帳蓋掉
  return withLock(() => {
    const running = {};
    const fixedRows = [];

    // 依寫入順序重算每一筆的 balanceAfter，把歷史一起修好——
    // 只修 accounts.balance 的話，小孩的明細加起來還是對不上。
    readTable('ledger').forEach(l => {
      const k = String(l.accountId);
      running[k] = (running[k] || 0) + num(l.amount, 0);
      if (num(l.balanceAfter, 0) !== running[k]) {
        patchRow('ledger', l._row, { balanceAfter: running[k] });
        fixedRows.push({ id: l.id, now: running[k] });
      }
    });

    const accounts = readTable('accounts');
    const fixed = [];
    accounts.forEach(a => {
      const want = running[String(a.accountId)] || 0;
      if (num(a.balance, 0) !== want) {
        const was = num(a.balance, 0);
        patchRow('accounts', a._row, { balance: want });
        fixed.push({ accountId: a.accountId, was, now: want });
      }
    });

    return { ok: true, checked: accounts.length, fixed, fixedLedgerRows: fixedRows.length };
  });
}

// ---------------------------------------------------------------- 密碼雜湊
// Apps Script 沒有 bcrypt，用加鹽 SHA-256 迭代。擋的是「翻開 Sheet 看到明文」，
// 不是擋外部攻擊者離線暴力破解（SPEC §8.1）。Setup.gs 的 upsertUser 也會用到。

function hashPassword(password, salt, rounds) {
  // 下限 1000：就算 config 被清空或填 0 也不會退化成「幾乎不雜湊」
  rounds = Math.max(1000, num(rounds, 1000));
  let acc = salt + ':' + password;
  for (let i = 0; i < rounds; i++) {
    acc = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc, Utilities.Charset.UTF_8));
  }
  return acc;
}

function newSalt() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}
