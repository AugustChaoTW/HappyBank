// HappyBank — API 端點
// 部署：Apps Script > Deploy > Web app > Execute as: Me / Who has access: Anyone
// 部署後把 Web app URL 填進前端 js/config.js 的 apiUrl。
//
// 安全模型（SPEC §8）：
//   TOKEN 只是雜訊過濾，它跟前端一起公開在 GitHub 上，不是安全機制。
//   真正的身分驗證是 session；所有金額都在這裡計算，前端送的只是意圖。

const SHEET_ID = '1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo';
const TOKEN = 'hb-10c4cc80462d2b4c'; // 與 js/config.js 的 apiToken 一致

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

// 讀整張表成物件陣列，並附上 _row（實際列號）方便就地更新
function readTable(name) {
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
}

// 就地更新某幾欄
function patchRow(name, row, patch) {
  const sh = sheetOf(name);
  const headers = headersOf(name);
  Object.keys(patch).forEach(k => {
    const c = headers.indexOf(k);
    if (c >= 0) sh.getRange(row, c + 1).setValue(patch[k]);
  });
}

function findBy(name, field, value) {
  const want = String(value).toLowerCase();
  const rows = readTable(name);
  for (const r of rows) if (String(r[field]).toLowerCase() === want) return r;
  return null;
}

function getConfigValue(key) {
  const r = findBy('config', 'key', key);
  return r ? r.value : null;
}

function num(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

// ---------------------------------------------------------------- 登入

// 公開的頭像名單：只有暱稱與 emoji，不含任何機密
function apiUsers() {
  const users = readTable('users')
    .filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE')
    .map(u => ({ userId: u.userId, role: u.role, displayName: u.displayName, emoji: u.emoji }));
  return { ok: true, users };
}

function apiLogin(p) {
  const userId = String(p.userId || '').trim().toLowerCase();
  const password = String(p.password || '');
  // 一律用同一句話，不洩漏帳號是否存在（SPEC §7.0）
  const DENY = { ok: false, error: 'bad-credentials', message: '帳號或密碼不對，再試一次。' };
  if (!userId || !password) return DENY;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const user = findBy('users', 'userId', userId);
    const cred = findBy('credentials', 'userId', userId);
    if (!user || !cred) return DENY;
    if (!(user.active === true || String(user.active).toUpperCase() === 'TRUE')) return DENY;

    if (cred.lockedUntil && new Date(cred.lockedUntil) > new Date()) {
      const mins = Math.ceil((new Date(cred.lockedUntil) - new Date()) / 60000);
      return { ok: false, error: 'locked', message: '密碼錯太多次了，請等 ' + mins + ' 分鐘再試。' };
    }

    const rounds = num(getConfigValue('pbkdf_rounds'), 1000);
    if (hashPassword(password, cred.salt, rounds) !== String(cred.passwordHash)) {
      const failed = num(cred.failedCount, 0) + 1;
      const max = num(getConfigValue('login_max_fail'), 5);
      const patch = { failedCount: failed };
      if (failed >= max) {
        const mins = num(getConfigValue('login_lock_minutes'), 15);
        patch.lockedUntil = new Date(Date.now() + mins * 60000);
        patch.failedCount = 0;
        patchRow('credentials', cred._row, patch);
        return { ok: false, error: 'locked', message: '密碼錯太多次了，請等 ' + mins + ' 分鐘再試。' };
      }
      patchRow('credentials', cred._row, patch);
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
  } finally {
    lock.releaseLock();
  }
}

function apiLogout(p) {
  const s = findBy('sessions', 'token', String(p.session || ''));
  if (s) patchRow('sessions', s._row, { expiresTs: new Date(0) });
  return { ok: true };
}

function requireSession(p) {
  const token = String(p.session || '');
  if (!token) throw new Error('AUTH:請先登入。');
  const s = findBy('sessions', 'token', token);
  if (!s) throw new Error('AUTH:登入已失效，請重新登入。');
  if (new Date(s.expiresTs) < new Date()) throw new Error('AUTH:登入過期了，請重新登入。');
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
  patchRow('credentials', cred._row, {
    salt, passwordHash: hashPassword(np, salt, rounds), updatedTs: new Date()
  });
  return { ok: true };
}

// ---------------------------------------------------------------- 帳戶

// 每個小孩第一次登入時自動開好活期主帳戶與紅包帳戶
function ensureDefaultAccounts(kidId) {
  const mine = readTable('accounts').filter(a => String(a.kidId) === kidId);
  const has = type => mine.some(a => a.type === type);

  if (!has('current')) {
    openAccount(kidId, 'current', '我的活期帳戶', '💰',
      num(getConfigValue('rate_current'), 0.05), '', '');
  }
  if (!has('gift')) {
    openAccount(kidId, 'gift', '阿公阿嬤的錢', '🧧',
      num(getConfigValue('rate_gift'), 0), '', '');
  }
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 冪等：同一個 clientId 只會入帳一次（SPEC §7.3）
    if (opts.clientId) {
      const dup = findBy('ledger', 'clientId', opts.clientId);
      if (dup) return { ok: true, duplicate: true, balanceAfter: num(dup.balanceAfter, 0) };
    }

    const acc = findBy('accounts', 'accountId', opts.accountId);
    if (!acc) return { ok: false, error: 'no-account', message: '找不到這個帳戶。' };

    const amount = Math.round(num(opts.amount, 0));
    if (!amount) return { ok: false, error: 'zero-amount', message: '金額不能是 0。' };

    const balanceAfter = num(acc.balance, 0) + amount;
    if (balanceAfter < 0 && !opts.allowNegative) {
      return { ok: false, error: 'insufficient', message: '餘額不夠，只有 ' + num(acc.balance, 0) + ' 元。' };
    }

    appendObj('ledger', {
      id: Utilities.getUuid(), ts: new Date(), kidId: acc.kidId, accountId: acc.accountId,
      type: opts.type, amount: amount, balanceAfter: balanceAfter,
      memo: opts.memo || '', by: opts.by || 'system',
      refId: opts.refId || '', clientId: opts.clientId || ''
    });
    patchRow('accounts', acc._row, { balance: balanceAfter });

    return { ok: true, balanceAfter };
  } finally {
    lock.releaseLock();
  }
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
        .filter(c => c.active === true || String(c.active).toUpperCase() === 'TRUE')
        .filter(c => !c.kidId || String(c.kidId) === user.userId)
        .map(stripRow)
    };
  }

  // 家長：全家一覽 + 所有待審
  const kids = readTable('users').filter(u => u.role === 'kid').map(k => ({
    user: publicUser(k),
    accounts: accountsOf(k.userId),
    total: accountsOf(k.userId).reduce((n, a) => n + a.balance, 0)
  }));
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
      lockUntil: a.lockUntil ? new Date(a.lockUntil).toISOString() : null,
      targetAmount: a.targetAmount === '' ? null : num(a.targetAmount, 0),
      balance: num(a.balance, 0), status: a.status
    }));
}

function ledgerOf(kidId, limit) {
  return readTable('ledger')
    .filter(l => String(l.kidId) === kidId)
    .slice(-limit).reverse()
    .map(l => ({
      id: l.id, ts: new Date(l.ts).toISOString(), accountId: l.accountId,
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
  const amount = Math.round(num(p.amount, 0));
  return postLedger({
    accountId: p.accountId, type: amount >= 0 ? 'adjust' : 'penalty',
    amount, memo: String(p.memo || ''), by: parent.userId,
    clientId: p.clientId, allowNegative: !!p.allowNegative
  });
}

function apiAdminGift(p) {
  const parent = requireParent(p);
  const kidId = String(p.kidId || '').toLowerCase();
  ensureDefaultAccounts(kidId);
  const gift = readTable('accounts')
    .filter(a => String(a.kidId) === kidId && a.type === 'gift')[0];
  if (!gift) return { ok: false, error: 'no-account', message: '找不到紅包帳戶。' };
  return postLedger({
    accountId: gift.accountId, type: 'gift_in', amount: Math.round(num(p.amount, 0)),
    memo: String(p.memo || '紅包'), by: parent.userId, clientId: p.clientId
  });
}

// 從 ledger 全量重算所有帳戶餘額，用來校驗 accounts.balance 這個快取欄
function apiAdminRecalc(p) {
  requireParent(p);
  const sums = {};
  readTable('ledger').forEach(l => {
    const k = String(l.accountId);
    sums[k] = (sums[k] || 0) + num(l.amount, 0);
  });
  const fixed = [];
  readTable('accounts').forEach(a => {
    const want = sums[String(a.accountId)] || 0;
    if (num(a.balance, 0) !== want) {
      patchRow('accounts', a._row, { balance: want });
      fixed.push({ accountId: a.accountId, was: num(a.balance, 0), now: want });
    }
  });
  return { ok: true, checked: readTable('accounts').length, fixed };
}
