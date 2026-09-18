// HappyBank — 資料庫初始化
// 在 Apps Script 編輯器選 setup 執行一次，會建好所有分頁、表頭與種子資料。
// 重複執行是安全的：已存在的分頁只補表頭，不動既有資料。

// SHEET_ID 宣告在 Config.gs（同專案共用全域範圍）

// 唯一的 schema 定義來源。改欄位改這裡，再跑一次 setup。
const SCHEMA = {
  // 個資與密碼分開放：credentials 分頁會被隱藏並加保護，
  // 這樣就算把 Sheet 分享給小孩看帳，也碰不到任何人的密碼雜湊。
  users: ['userId', 'role', 'displayName', 'emoji', 'dailyAllowance', 'active', 'lastLoginTs'],
  credentials: ['userId', 'salt', 'passwordHash', 'failedCount', 'lockedUntil', 'updatedTs'],
  sessions: ['token', 'userId', 'createdTs', 'expiresTs', 'device'],
  accounts: ['accountId', 'kidId', 'type', 'name', 'emoji', 'rateMonthly',
             'lockUntil', 'targetAmount', 'balance', 'status', 'createdTs'],
  ledger: ['id', 'ts', 'kidId', 'accountId', 'type', 'amount', 'balanceAfter',
           'memo', 'by', 'refId', 'clientId'],
  // photoFileId / decidedBy / decidedProxy 是 M6 補上的三欄（SPEC §5、§11）。
  // 一律「接在最後面」，不照 SPEC 表格的排版插在中間——
  // setup() 只重寫表頭那一列、不搬動資料，插在中間會讓既有列整排錯位
  // （舊的 decidedNote 會突然被讀成 decidedBy）。
  // checklist 是 M7（每日零用錢簽到）補上的第十七欄，一樣接在最後面。
  requests: ['id', 'ts', 'kidId', 'kind', 'amount', 'choreId', 'fromAccountId',
             'toAccountId', 'note', 'status', 'decidedTs', 'decidedNote', 'clientId',
             'photoFileId', 'decidedBy', 'decidedProxy', 'checklist'],
  chores: ['id', 'title', 'icon', 'reward', 'repeat', 'kidId', 'active'],
  config: ['key', 'value', 'note']
};

// 家事清單初版。kidId 空白 = 誰都可以接。
// 定價原則：一件 5~20 元，對照每週 50 元零用錢——做三件 ≈ 半週零用錢，
// 讓「勞動」與「等零用錢」的比重有感但不失衡。之後在 admin 頁隨時可改。
const CHORES_SEED = [
  ['chore-trash',   '倒垃圾',         '🗑️', 10, 'daily',  '', true],
  ['chore-dishes',  '收碗盤',         '🍽️', 10, 'daily',  '', true],
  ['chore-pets',    '餵魚／澆花',     '🐟',  5, 'daily',  '', true],
  ['chore-sweep',   '掃地',           '🧹', 15, 'weekly', '', true],
  ['chore-laundry', '摺自己的衣服',   '👕', 15, 'weekly', '', true],
  ['chore-room',    '整理自己的房間', '🛏️', 20, 'weekly', '', true]
];

const CONFIG_SEED = [
  ['rate_current',        0.05,  '活期主帳戶月利率'],
  ['rate_term',           0.10,  '定存月利率'],
  ['rate_goal',           0.05,  '儲蓄目標月利率'],
  ['rate_gift',           0.00,  '阿公阿嬤紅包帳戶月利率'],
  ['term_months_min',     3,     '定存期數下限（月）'],
  ['term_months_max',     12,    '定存期數上限（月）'],
  ['allowance_weekday',   0,     '每週零用錢發放日（0=週日）'],
  ['allowance_hour',      8,     '每週零用錢發放時間（24 小時制）'],
  ['approval_mode',       'tiered', '審核模式：分級（見 SPEC §9）'],
  ['kid_password_digits', 8,     '小孩密碼位數，固定數字'],
  ['session_days_kid',    30,    '小孩登入有效天數'],
  ['session_hours_parent', 24,   '家長登入有效小時數'],
  ['login_max_fail',      5,     '連續登入失敗幾次鎖定'],
  ['login_lock_minutes',  15,    '鎖定時間（分鐘）'],
  ['pbkdf_rounds',        1000,  '密碼雜湊迭代次數'],
  ['chore_approver',      'vicky', '家事回報的指定核准者（role=parent 的 userId），其他家長要代理確認'],
  ['daily_checklist',     '好好照顧自己|尊重別人的需求|完成自己的工作',
                                 '每日零用錢簽到的自我檢查項目，用 | 隔開。改這裡就改了，程式不用動']
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

  seedTable(ss.getSheetByName('config'), CONFIG_SEED);

  seedTable(ss.getSheetByName('chores'), CHORES_SEED);
  protectCredentials(ss);

  // 移掉預設空白分頁
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  Logger.log('setup 完成：' + Object.keys(SCHEMA).join(', '));
}

// credentials 分頁隱藏 + 只有擁有者能編輯
function protectCredentials(ss) {
  const sh = ss.getSheetByName('credentials');
  sh.hideSheet();
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const p = existing.length ? existing[0] : sh.protect();
  p.setDescription('密碼雜湊，請勿手動編輯');
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

// 以第一欄為鍵補種子資料：已存在的鍵一律不動，避免覆蓋家長改過的內容
function seedTable(sh, seed) {
  const existing = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
    : [];
  const toAdd = seed.filter(row => existing.indexOf(String(row[0])) === -1);
  if (toAdd.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, toAdd[0].length).setValues(toAdd);
  }
}

// --- 帳號 ---------------------------------------------------------------
// hashPassword / newSalt 定義在 Code.gs（執行時期登入也要用）。

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
function upsertUser(userId, role, displayName, emoji, password, dailyAllowance) {
  assertPasswordOk(role, password);
  userId = String(userId).trim().toLowerCase(); // 帳號一律小寫，登入時大小寫不敏感
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const rounds = Number(getConfig('pbkdf_rounds')) || 1000;
  const salt = newSalt();

  upsertRow(ss.getSheetByName('users'),
    [userId, role, displayName, emoji, dailyAllowance || 0, true, '']);
  upsertRow(ss.getSheetByName('credentials'),
    [userId, salt, hashPassword(password, salt, rounds), 0, '', new Date()]);

  Logger.log('user 已寫入：' + userId);
}

// 以第一欄（userId）為鍵 upsert 一列
function upsertRow(sh, row) {
  const ids = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).toLowerCase())
    : [];
  const idx = ids.indexOf(String(row[0]).toLowerCase());
  if (idx === -1) sh.appendRow(row);
  else sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
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
// 最後一個參數是每日零用錢（簽到核准後入帳的金額），家長沒有。
// 執行前把下面的密碼改掉，執行後把密碼清回 CHANGE-ME 再 commit。
function seedUsers() {
  upsertUser('momo',   'kid',    'Momo', '👧', 'CHANGE-ME', 20);
  upsertUser('coco',   'kid',    'Coco', '👧', 'CHANGE-ME', 20);
  upsertUser('dodo',   'kid',    'Dodo', '👦', 'CHANGE-ME', 20);
  upsertUser('aug',    'parent', 'Aug',   '🧑', 'CHANGE-ME', 0);
  upsertUser('vicky',  'parent', 'Vicky', '👩', 'CHANGE-ME', 0);
}
