// HappyBank — 資料庫初始化
// 在 Apps Script 編輯器選 setup 執行一次，會建好所有分頁、表頭與種子資料。
// 重複執行是安全的：已存在的分頁只補表頭，不動既有資料。

const SHEET_ID = '1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo'; // HappyBank 資料庫

// 唯一的 schema 定義來源。改欄位改這裡，再跑一次 setup。
const SCHEMA = {
  users: ['userId', 'role', 'displayName', 'emoji', 'salt', 'passwordHash',
          'weeklyAllowance', 'active', 'lastLoginTs', 'failedCount', 'lockedUntil'],
  sessions: ['token', 'userId', 'createdTs', 'expiresTs', 'device'],
  accounts: ['accountId', 'kidId', 'type', 'name', 'emoji', 'rateMonthly',
             'lockUntil', 'targetAmount', 'balance', 'status', 'createdTs'],
  ledger: ['id', 'ts', 'kidId', 'accountId', 'type', 'amount', 'balanceAfter',
           'memo', 'by', 'refId', 'clientId'],
  requests: ['id', 'ts', 'kidId', 'kind', 'amount', 'choreId', 'fromAccountId',
             'toAccountId', 'note', 'status', 'decidedTs', 'decidedNote', 'clientId'],
  chores: ['id', 'title', 'icon', 'reward', 'repeat', 'kidId', 'active'],
  config: ['key', 'value', 'note']
};

const CONFIG_SEED = [
  ['rate_current',        0.05,  '活期主帳戶月利率'],
  ['rate_term',           0.10,  '定存月利率'],
  ['rate_goal',           0.05,  '儲蓄目標月利率'],
  ['rate_gift',           0.00,  '阿公阿嬤紅包帳戶月利率'],
  ['allowance_weekday',   0,     '每週零用錢發放日（0=週日）'],
  ['term_months_options', '1,3,6', '定存可選期數（月）'],
  ['approval_mode',       'tiered', '審核模式：分級（見 SPEC §9）'],
  ['kid_password_digits', 8,     '小孩密碼位數，固定數字'],
  ['session_days_kid',    30,    '小孩登入有效天數'],
  ['session_hours_parent', 24,   '家長登入有效小時數'],
  ['login_max_fail',      5,     '連續登入失敗幾次鎖定'],
  ['login_lock_minutes',  15,    '鎖定時間（分鐘）'],
  ['pbkdf_rounds',        1000,  '密碼雜湊迭代次數']
];

function setup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SCHEMA[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  });

  // config 種子（只補不存在的 key）
  const cfg = ss.getSheetByName('config');
  const existing = cfg.getLastRow() > 1
    ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
    : [];
  const toAdd = CONFIG_SEED.filter(row => existing.indexOf(row[0]) === -1);
  if (toAdd.length) {
    cfg.getRange(cfg.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }

  // 移掉預設空白分頁
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  Logger.log('setup 完成：' + Object.keys(SCHEMA).join(', '));
}

// --- 密碼 ---------------------------------------------------------------
// Apps Script 沒有 bcrypt，用加鹽 SHA-256 迭代。Sheet 本身是 private，
// 這道防線擋的是「小孩翻到表看到明文密碼」，不是擋外部攻擊者離線破解。

function hashPassword(password, salt, rounds) {
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

// 密碼格式檢查：小孩固定 N 位數字，家長至少 8 字元
function assertPasswordOk(role, password) {
  const pw = String(password);
  if (role === 'kid') {
    const n = Number(getConfig('kid_password_digits')) || 8;
    if (!new RegExp('^\\d{' + n + '}$').test(pw)) {
      throw new Error('小孩密碼必須是 ' + n + ' 位數字');
    }
  } else if (pw.length < 8) {
    throw new Error('家長密碼至少 8 個字元');
  }
  if (pw === 'CHANGE-ME') throw new Error('請先改掉預設密碼');
}

// 建立或重設一個帳號。在編輯器手動改參數後執行，不要把密碼 commit 進 repo。
// role: 'kid' | 'parent'
function upsertUser(userId, role, displayName, emoji, password, weeklyAllowance) {
  assertPasswordOk(role, password);
  userId = String(userId).trim().toLowerCase(); // 帳號一律小寫，登入時大小寫不敏感
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('users');
  const rounds = Number(getConfig('pbkdf_rounds')) || 1000;
  const salt = newSalt();
  const row = [userId, role, displayName, emoji, salt, hashPassword(password, salt, rounds),
               weeklyAllowance || 0, true, '', 0, ''];

  const ids = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).toLowerCase())
    : [];
  const idx = ids.indexOf(userId);
  if (idx === -1) {
    sh.appendRow(row);
  } else {
    sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  }
  Logger.log('user 已寫入：' + userId);
}

function getConfig(key) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('config');
  if (sh.getLastRow() < 2) return null;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (const r of rows) if (String(r[0]) === key) return r[1];
  return null;
}

// 一次建好全家帳號。
// 小孩密碼＝8 位數字，家長密碼＝至少 8 字元。
// 執行前把下面的密碼改掉，執行後把密碼清回 CHANGE-ME 再 commit。
function seedUsers() {
  upsertUser('momo',   'kid',    'Momo', '👧', 'CHANGE-ME', 50);
  upsertUser('coco',   'kid',    'Coco', '👧', 'CHANGE-ME', 50);
  upsertUser('dodo',   'kid',    'Dodo', '👦', 'CHANGE-ME', 50);
  upsertUser('parent', 'parent', '爸爸',  '🧑', 'CHANGE-ME', 0);
  upsertUser('vicky',  'parent', 'Vicky', '👩', 'CHANGE-ME', 0);
}
