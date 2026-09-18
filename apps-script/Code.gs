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
      case 'request':        return respond(apiRequest(p));
      case 'cancel_request': return respond(apiCancelRequest(p));
      case 'chore_photo':    return respond(apiChorePhoto(p));
      // 家長專用
      case 'admin_decide': return respond(apiAdminDecide(p));
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
      // pending 之外，還要帶「本期間已決定」的 chore_done——
      // 沒有這些，chores 頁畫不出「今天已回報 / 媽媽在 9:14 確認」（SPEC §7.1、§6）
      requests: readTable('requests')
        .filter(r => String(r.kidId) === user.userId)
        .filter(r => r.status === 'pending' || decidedChoreThisPeriod(r) || decidedClaimToday(r))
        .map(stripRow),
      // 今天的三項自我檢查。UI 靠這個畫勾選框，家長改 config 就跟著變。
      daily_checklist: dailyChecklistItems(),
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
    // 家事的指定核准者放頂層，admin 才知道自己按下去是正式確認還是代理（SPEC §7.1、§9.5）
    chore_approver: String(getConfigValue('chore_approver') || ''),
    // 待審清單要顯示家事名稱與獎金。不帶 chores 的話前端只能靠寫死的對照表猜，
    // 家長一改標題或金額，清單就會顯示舊的。
    chores: readTable('chores').map(stripRow),
    // requests 帶 photoFileId，但絕不夾帶照片內容——十筆待審全塞 base64
    // 會讓登入變成十秒，縮圖一律走 chore_photo 延遲抓（SPEC §7.6）
    requests: readTable('requests').filter(r => r.status === 'pending').map(stripRow),
    ledger: readTable('ledger').slice(-50).reverse().map(stripRow)
  };
}

// 這一筆是不是「本期間已決定」的家事回報（給小孩端 chores 卡片畫狀態用）
function decidedChoreThisPeriod(r) {
  if (String(r.kind) !== 'chore_done') return false;
  if (r.status !== 'approved' && r.status !== 'rejected') return false;
  const chore = readTable('chores').filter(c => String(c.id) === String(r.choreId))[0];
  const repeat = chore ? chore.repeat : 'daily';
  const key = chorePeriodKey(repeat, r.ts);
  return !!key && key === chorePeriodKey(repeat, new Date());
}

// 這一筆是不是「今天已決定」的簽到（給小孩端畫「媽媽確認了 / 被退回」用）
function decidedClaimToday(r) {
  if (String(r.kind) !== 'allowance_claim') return false;
  if (r.status !== 'approved' && r.status !== 'rejected') return false;
  const key = chorePeriodKey('daily', r.ts);
  return !!key && key === chorePeriodKey('daily', new Date());
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

// ---------------------------------------------------------------- 家事回報（M6）
// SPEC §7.2（六道驗證）、§7.5（照片寫在鎖外、Sheet 寫在鎖內）、§7.6（代理取圖）、§9.5（代理確認）。

const PHOTO_ROOT = 'HappyBank 家事照片';
const PHOTO_MAX_BYTES = 1536 * 1024;   // 1.5 MB（SPEC §7.2 第 4 條）
const PHOTO_MIN_BYTES = 2 * 1024;      // 小於 2 KB 視為黑畫面／壞檔

// 期間字串。一律以 Asia/Taipei 算，不用 UTC、不用瀏覽器時區（SPEC §7.2 第 5 條）。
// 回 null 表示這個 ts 根本不是日期（格子被手改壞了），呼叫端當成「比不出來」。
function taipeiDay(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}

// 往前退到最近一個週日 00:00（台北），回傳那天的日期字串。
// 不用 yyyy-'W'ww——那個的週起始日隨 locale 變（SPEC §7.2 第 5 條）。
function taipeiWeekStartDay(ts) {
  const day = taipeiDay(ts);
  if (!day) return null;
  // 用 UTC 當「無時區的日曆」來算星期幾，才不會被執行環境的時區牽著走
  const cal = new Date(day + 'T00:00:00Z');
  cal.setUTCDate(cal.getUTCDate() - cal.getUTCDay());
  return cal.toISOString().slice(0, 10);
}

function chorePeriodKey(repeat, ts) {
  if (String(repeat) === 'once') return 'once';
  if (String(repeat) === 'weekly') {
    const w = taipeiWeekStartDay(ts);
    return w && ('week:' + w);
  }
  const d = taipeiDay(ts);
  return d && ('day:' + d);
}

function findRequest(requestId) {
  const want = String(requestId || '');
  if (!want) return null;
  return readTable('requests').filter(r => String(r.id) === want)[0] || null;
}

function findRequestByClientId(clientId) {
  const want = String(clientId || '');
  if (!want) return null;
  return readTable('requests').filter(r => String(r.clientId) === want)[0] || null;
}

// 這件家事在「現在」這個期間內是否已經有一筆算數的回報。
// rejected / cancelled 不算數——被退回或自己撤回之後可以重報（SPEC §9.5 二）。
function activeChoreReport(kidId, choreId, repeat) {
  const now = chorePeriodKey(repeat, new Date());
  return readTable('requests').filter(r =>
    String(r.kind) === 'chore_done' &&
    String(r.kidId) === String(kidId) &&
    String(r.choreId) === String(choreId) &&
    (r.status === 'pending' || r.status === 'approved') &&
    chorePeriodKey(repeat, r.ts) === now
  )[0] || null;
}

// ---- request(chore_done) ----------------------------------------------

function apiRequest(p) {
  // 1. 身分先驗，再看要建哪一種申請——沒登入的人連「有哪些 kind」都不該試得出來
  const user = requireSession(p);
  const kind = String(p.kind || '');
  if (kind === 'chore_done') return apiRequestChoreDone(p, user);
  if (kind === 'allowance_claim') return apiRequestAllowanceClaim(p, user);
  // withdraw / term_break 是 M4 的範圍，還沒實作
  return { ok: false, error: 'unknown-action', message: '還不支援的申請種類：' + kind };
}

function apiRequestChoreDone(p, user) {
  // kidId 一律取自 session，不接受請求帶（SPEC §7.2 第 1 條）
  if (user.role !== 'kid') throw new Error('AUTH:只有小孩可以回報家事。');
  const kidId = String(user.userId);

  const clientId = String(p.clientId || '');
  if (!clientId) {
    return { ok: false, error: 'bad-request', message: '缺少 clientId，請重新整理再試一次。' };
  }

  // 2. 冪等：同一個 clientId 直接回原本那筆，不重複建檔也不重複寫 Sheet（SPEC §7.3）
  const dup = findRequestByClientId(clientId);
  if (dup) {
    return { ok: true, duplicate: true, requestId: dup.id, photoFileId: dup.photoFileId || '' };
  }

  // 3. 家事存在、還開著、而且不是別人專屬的（SPEC §7.2 第 3 條）
  const chore = readTable('chores').filter(c => String(c.id) === String(p.choreId || ''))[0];
  if (!chore || !isTrue(chore.active)) {
    return { ok: false, error: 'no-such-chore', message: '找不到這件家事。' };
  }
  if (chore.kidId && String(chore.kidId).toLowerCase() !== kidId.toLowerCase()) {
    return { ok: false, error: 'no-such-chore', message: '這件家事不是你的。' };
  }

  // 4. 照片必填（SPEC §7.2 第 4 條）
  const photo = decodePhoto(p);
  if (!photo.ok) return photo;
  const bytes = photo.bytes;

  // 5. 一天一次（weekly 則一週一次）。先在鎖外擋掉，省得白傳一張照片。
  if (activeChoreReport(kidId, chore.id, chore.repeat)) {
    return { ok: false, error: 'already-reported', message: alreadyReportedMessage(chore) };
  }

  // 6. 寫入：照片先寫 Drive（鎖外，Drive 是慢動作），Sheet 再寫（鎖內）。SPEC §7.5
  const photoFileId = savePhoto(kidId, chore.id, clientId, bytes);

  return withLock(() => {
    // 鎖內重跑一次冪等與一天一次——兩台手機同時送的時候，先後在這裡分出來
    const again = findRequestByClientId(clientId);
    if (again) {
      return { ok: true, duplicate: true, requestId: again.id, photoFileId: again.photoFileId || '' };
    }
    if (activeChoreReport(kidId, chore.id, chore.repeat)) {
      return { ok: false, error: 'already-reported', message: alreadyReportedMessage(chore) };
    }
    const id = Utilities.getUuid();
    appendObj('requests', {
      id: id, ts: new Date(), kidId: kidId, kind: 'chore_done',
      amount: '',                       // 金額不採信前端，核准時才查 chores.reward（SPEC §9.5）
      choreId: chore.id, fromAccountId: '', toAccountId: '',
      note: String(p.note || ''), status: 'pending',
      decidedTs: '', decidedNote: '', decidedBy: '', decidedProxy: '',
      photoFileId: photoFileId, clientId: clientId
    });
    return { ok: true, requestId: id, photoFileId: photoFileId };
  });
}

function alreadyReportedMessage(chore) {
  return String(chore.repeat) === 'weekly'
    ? '這件家事這週已經報過了。'
    : '這件家事今天已經報過了。';
}

// 照片驗證：家事回報與每日簽到共用同一套（同樣的 mime、同樣的大小上下限）。
// 成功回 { ok: true, bytes }，失敗回可以直接送回前端的錯誤物件。
function decodePhoto(p) {
  const NO_PHOTO = { ok: false, error: 'photo-required', message: '要拍一張照片才能送出喔。' };
  const mime = String(p.photoMime || 'image/jpeg');
  if (mime !== 'image/jpeg') return NO_PHOTO;
  const raw = String(p.photo === undefined || p.photo === null ? '' : p.photo);
  if (!raw) return NO_PHOTO;
  let bytes;
  try {
    bytes = Utilities.base64Decode(raw);
  } catch (err) {
    return NO_PHOTO;   // base64 解不開也算沒照片
  }
  if (!bytes || !bytes.length) return NO_PHOTO;
  if (bytes.length > PHOTO_MAX_BYTES) {
    return { ok: false, error: 'photo-too-big', message: '照片太大了，請重新壓縮再送一次。' };
  }
  // 太小的一律當壞檔（黑畫面／壓縮失敗），跟沒照片一樣請小孩重拍
  if (bytes.length < PHOTO_MIN_BYTES) return NO_PHOTO;
  return { ok: true, bytes: bytes };
}

// 照片進 HappyBank 家事照片/<kidId>/，檔名帶 clientId 前 8 碼，
// 離線佇列重送時認得出同一張、不會在 Drive 裡留一堆重複檔（SPEC §5、§7.5）。
// **不呼叫 setSharing**：檔案留在擁有者的 private 資料夾，要看圖走 chore_photo。
function savePhoto(kidId, choreId, clientId, bytes) {
  const folder = getOrCreatePath([PHOTO_ROOT, kidId]);
  const name = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd') +
    '-' + choreId + '-' + String(clientId).slice(0, 8) + '.jpg';
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) return existing.next().getId();
  return folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name)).getId();
}

function getOrCreatePath(names) {
  let parent = DriveApp.getRootFolder();
  names.forEach(name => {
    const found = parent.getFoldersByName(name);
    parent = found.hasNext() ? found.next() : parent.createFolder(name);
  });
  return parent;
}

// ---- request(allowance_claim)：每日零用錢簽到 -------------------------
// 一天一次，三項（家長設幾項就幾項）全勾 + 一張照片，媽媽確認後入帳。

// 檢查項目來自 config.daily_checklist，用 | 隔開。
// 家長在 Sheet 上加一項、減一項，伺服器的要求就跟著變，程式不用動。
function dailyChecklistItems() {
  return String(getConfigValue('daily_checklist') || '')
    .split('|')
    .map(s => String(s).trim())
    .filter(s => s !== '');
}

// 勾選驗證：必須「每一項都勾到」。
// 前端可以送布林陣列（照設定順序），也可以送勾到的項目文字；
// 兩種都要求「數量剛好、而且涵蓋設定裡的每一項」——少一項、多一項、
// 重複湊數、夾帶設定裡沒有的項目，一律不算數。
function checkedAllItems(checks, items) {
  if (!Array.isArray(checks)) return false;
  if (checks.length !== items.length) return false;
  if (checks.every(c => typeof c === 'boolean')) return checks.every(c => c === true);
  const got = {};
  checks.forEach(c => { got[String(c).trim()] = true; });
  return items.every(it => got[it] === true);
}

// 今天（台北）這個小孩有沒有一筆算數的簽到。
// rejected / cancelled 不算數——被退回或自己撤回之後可以當天重簽。
function activeAllowanceClaim(kidId) {
  const today = chorePeriodKey('daily', new Date());
  return readTable('requests').filter(r =>
    String(r.kind) === 'allowance_claim' &&
    String(r.kidId) === String(kidId) &&
    (r.status === 'pending' || r.status === 'approved') &&
    chorePeriodKey('daily', r.ts) === today
  )[0] || null;
}

function apiRequestAllowanceClaim(p, user) {
  // 1. kidId 一律取自 session；簽到是小孩的事
  if (user.role !== 'kid') throw new Error('AUTH:只有小孩可以簽到領零用錢。');
  const kidId = String(user.userId);

  const clientId = String(p.clientId || '');
  if (!clientId) {
    return { ok: false, error: 'bad-request', message: '缺少 clientId，請重新整理再試一次。' };
  }

  // 2. 冪等：同一個 clientId 直接回原本那筆
  const dup = findRequestByClientId(clientId);
  if (dup) {
    return { ok: true, duplicate: true, requestId: dup.id, photoFileId: dup.photoFileId || '' };
  }

  // 3. 三項自我檢查全勾（項數以 config 為準）
  const items = dailyChecklistItems();
  if (!items.length) {
    return { ok: false, error: 'server', message: 'config.daily_checklist 是空的，請家長檢查。' };
  }
  // 前端（js/allowance.js）送的欄位叫 checked，離線佇列裡的舊版送 checks，兩個都吃。
  const ticked = Array.isArray(p.checked) ? p.checked : p.checks;
  if (!checkedAllItems(ticked, items)) {
    return {
      ok: false, error: 'checklist-incomplete',
      message: '要把 ' + items.length + ' 項都勾起來才能送出喔。'
    };
  }

  // 4. 照片必填（與家事回報同一套規則）
  const photo = decodePhoto(p);
  if (!photo.ok) return photo;

  // 5. 一天一次。先在鎖外擋掉，省得白傳一張照片。
  //    「今天」一律是伺服器的台北日曆天——沒有補簽昨天這條路，
  //    請求裡也沒有任何指定日期的參數。
  if (activeAllowanceClaim(kidId)) {
    return { ok: false, error: 'already-claimed', message: '今天已經簽到過了，明天再來。' };
  }

  // 6. 照片先寫 Drive（鎖外），Sheet 再寫（鎖內）
  const photoFileId = savePhoto(kidId, 'allowance', clientId, photo.bytes);

  return withLock(() => {
    const again = findRequestByClientId(clientId);
    if (again) {
      return { ok: true, duplicate: true, requestId: again.id, photoFileId: again.photoFileId || '' };
    }
    if (activeAllowanceClaim(kidId)) {
      return { ok: false, error: 'already-claimed', message: '今天已經簽到過了，明天再來。' };
    }
    const id = Utilities.getUuid();
    appendObj('requests', {
      id: id, ts: new Date(), kidId: kidId, kind: 'allowance_claim',
      amount: '',                       // 金額不採信前端，核准時才讀 users.dailyAllowance
      choreId: '', fromAccountId: '', toAccountId: '',
      note: String(p.note || ''), status: 'pending',
      decidedTs: '', decidedNote: '', decidedBy: '', decidedProxy: '',
      photoFileId: photoFileId, clientId: clientId,
      checklist: items.join('|')
    });
    return { ok: true, requestId: id, photoFileId: photoFileId };
  });
}

// ---- cancel_request ---------------------------------------------------

function apiCancelRequest(p) {
  const user = requireSession(p);
  const req = findRequest(p.requestId);
  if (!req) return { ok: false, error: 'no-such-request', message: '找不到這筆申請。' };
  if (String(req.kidId).toLowerCase() !== String(user.userId).toLowerCase()) {
    throw new Error('AUTH:這不是你的申請。');
  }
  return withLock(() => {
    const fresh = findRequest(req.id);
    if (!fresh || fresh.status !== 'pending') {
      return { ok: false, error: 'already-decided', message: '這筆已經處理過了。' };
    }
    patchRow('requests', fresh._row, {
      status: 'cancelled', decidedTs: new Date(), decidedBy: user.userId, decidedProxy: false
    });
    return { ok: true, requestId: fresh.id, status: 'cancelled' };
  });
}

// ---- admin_decide -----------------------------------------------------

// config.chore_approver 必須是一個存在且 active 的 parent，
// 不是就當設定錯誤，不要靜默 fallback 成「誰都能核准」（SPEC §5）。
function choreApprover() {
  const id = String(getConfigValue('chore_approver') || '').trim().toLowerCase();
  if (!id) return null;
  const u = findBy('users', 'userId', id);
  if (!u || u.role !== 'parent' || !isTrue(u.active)) return null;
  return u;
}

// 家事回報與每日簽到共用同一套核准者規則（指定核准者 + 代理）。
function needsChoreApprover(kind) {
  return String(kind) === 'chore_done' || String(kind) === 'allowance_claim';
}

function apiAdminDecide(p) {
  const parent = requireParent(p);          // 小孩一律 unauthorized（SPEC §7.4）
  const decision = String(p.decision || '');
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'bad-request', message: '只能核准或退回。' };
  }
  const req = findRequest(p.requestId);
  if (!req) return { ok: false, error: 'no-such-request', message: '找不到這筆申請。' };
  if (req.status !== 'pending') {
    return { ok: false, error: 'already-decided', message: '這筆已經被處理過了，請重新整理。' };
  }

  const note = String(p.decidedNote || p.note || '');
  // 退回必填理由，讓小孩知道為什麼（SPEC §9.4）
  if (decision === 'reject' && !note.trim()) {
    return { ok: false, error: 'note-required', message: '退回要寫一句理由，讓小孩知道為什麼。' };
  }

  // 家事多一層：指定核准者，其他家長要明確代理（SPEC §7.2、§9.5 三）
  let proxy = false;
  let approver = null;
  if (needsChoreApprover(req.kind)) {
    approver = choreApprover();
    if (!approver) {
      return { ok: false, error: 'server', message: 'config.chore_approver 設定錯誤，請家長檢查。' };
    }
    if (String(parent.userId).toLowerCase() !== String(approver.userId).toLowerCase()) {
      if (!isTrue(p.proxy)) {
        return {
          ok: false, error: 'needs-proxy',
          message: '這件要 ' + approver.displayName + ' 確認，你可以按「代替確認」。'
        };
      }
      proxy = true;   // 寫入當下就記死，不要事後用 decidedBy 推導（SPEC §5）
    }
  }

  return withLock(() => {
    const fresh = findRequest(req.id);
    if (!fresh || fresh.status !== 'pending') {
      return { ok: false, error: 'already-decided', message: '這筆已經被處理過了，請重新整理。' };
    }

    if (decision === 'reject') {
      patchRow('requests', fresh._row, {
        status: 'rejected', decidedTs: new Date(), decidedBy: parent.userId,
        decidedProxy: proxy, decidedNote: note
      });
      return { ok: true, requestId: fresh.id, status: 'rejected' };
    }

    if (fresh.kind !== 'chore_done' && fresh.kind !== 'allowance_claim') {
      return { ok: false, error: 'unknown-action', message: '這種申請的核准還沒實作。' };
    }

    // 先入帳再改狀態（同一把鎖內）：反過來的話，ledger 失敗會留下
    // 「已核准但沒拿到錢」的 request，而那是小孩會吵架的方向。
    const posted = fresh.kind === 'allowance_claim'
      ? creditAllowance(fresh, parent, approver, proxy)
      : creditChore(fresh, parent, approver, proxy);
    if (!posted.ok) return posted;

    patchRow('requests', fresh._row, {
      status: 'approved', decidedTs: new Date(), decidedBy: parent.userId,
      decidedProxy: proxy, decidedNote: note
    });
    return {
      ok: true, requestId: fresh.id, status: 'approved',
      amount: posted.amount, balanceAfter: posted.balanceAfter
    };
  });
}

// 家事獎金：金額一律伺服器查 chores.reward，一律進活期主帳戶（SPEC §9.5 四）
function creditChore(req, parent, approver, proxy) {
  const chore = readTable('chores').filter(c => String(c.id) === String(req.choreId))[0];
  if (!chore) return { ok: false, error: 'no-such-chore', message: '找不到這件家事，無法入帳。' };
  const amount = Math.round(num(chore.reward, 0));
  if (!amount) return { ok: false, error: 'zero-amount', message: '這件家事的獎金是 0，請先去設定。' };

  ensureDefaultAccounts(req.kidId);
  const acc = readTable('accounts').filter(a =>
    String(a.kidId) === String(req.kidId) && a.type === 'current' && a.status === 'active')[0];
  if (!acc) return { ok: false, error: 'no-account', message: '找不到活期主帳戶。' };

  const when = Utilities.formatDate(new Date(req.ts), 'Asia/Taipei', 'M/d');
  let memo = chore.title + '（' + when + '）';
  if (proxy && approver) {
    memo += ' · ' + parent.displayName + ' 代替 ' + approver.displayName + ' 確認';
  }

  const res = postLedger({
    accountId: acc.accountId, type: 'chore', amount: amount, memo: memo,
    by: parent.userId, refId: req.id,
    // 一筆 request 只入得了一次帳，就算兩個家長搶著按也一樣（SPEC §7.3）
    clientId: 'req:' + req.id
  });
  if (res.ok) res.amount = amount;
  return res;
}

// 每日零用錢：金額一律伺服器讀這個小孩自己的 users.dailyAllowance，
// 前端送的 amount 一概不看；一律進活期主帳戶。
// 「算哪一天」看的是 req.ts（送出時間），不是現在——媽媽三天後才按確認，
// 付的還是那天的零用錢。
function creditAllowance(req, parent, approver, proxy) {
  const kid = findBy('users', 'userId', String(req.kidId));
  if (!kid || kid.role !== 'kid') {
    return { ok: false, error: 'no-kid', message: '找不到這個小孩，無法入帳。' };
  }
  const amount = Math.round(num(kid.dailyAllowance, 0));
  if (!amount) {
    return { ok: false, error: 'zero-amount', message: '這個小孩的每日零用錢是 0，請先去設定。' };
  }

  ensureDefaultAccounts(req.kidId);
  const acc = readTable('accounts').filter(a =>
    String(a.kidId) === String(req.kidId) && a.type === 'current' && a.status === 'active')[0];
  if (!acc) return { ok: false, error: 'no-account', message: '找不到活期主帳戶。' };

  const when = Utilities.formatDate(new Date(req.ts), 'Asia/Taipei', 'M/d');
  let memo = '每日零用錢（' + when + '）';
  if (proxy && approver) {
    memo += ' · ' + parent.displayName + ' 代替 ' + approver.displayName + ' 確認';
  }

  const res = postLedger({
    accountId: acc.accountId, type: 'allowance', amount: amount, memo: memo,
    by: parent.userId, refId: req.id,
    // 一筆簽到只入得了一次帳，就算兩個家長搶著按也一樣（SPEC §7.3）
    clientId: 'req:' + req.id
  });
  if (res.ok) res.amount = amount;
  return res;
}

// ---- chore_photo（§7.6）------------------------------------------------

function apiChorePhoto(p) {
  // 1. 身分
  const user = requireSession(p);
  // 2. request 存在
  const req = findRequest(p.requestId);
  if (!req) return { ok: false, error: 'no-such-request', message: '找不到這筆申請。' };
  // 3. 小孩只能抓自己那筆，kidId 取自 session；家長不受限
  if (user.role === 'kid' &&
      String(req.kidId).toLowerCase() !== String(user.userId).toLowerCase()) {
    return { ok: false, error: 'not-your-photo', message: '這不是你的照片。' };
  }
  // 4. 檔案還在不在
  const MISSING = { ok: false, error: 'photo-missing', message: '照片讀不到。' };
  const fileId = String(req.photoFileId || '');
  if (!fileId) return MISSING;
  let data;
  try {
    const file = DriveApp.getFileById(fileId);
    if (!file || file.isTrashed()) return MISSING;
    data = Utilities.base64Encode(file.getBlob().getBytes());
  } catch (err) {
    return MISSING;   // 檔案被刪掉是可能發生的事，不要回 server
  }
  return { ok: true, requestId: req.id, mime: 'image/jpeg', data: data };
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
