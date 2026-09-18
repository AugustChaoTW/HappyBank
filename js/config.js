// 全站設定
const CONFIG = {
  // Apps Script Web App URL（M1 部署後填入；空字串 = 尚未接後端，登入頁只跑 UI）
  apiUrl: '',
  // 與 Apps Script 內 TOKEN 一致的共享密鑰。這只是雜訊過濾，不是安全機制——
  // 真正的身分驗證是登入拿到的 session。
  apiToken: '',

  // 登入頁的頭像清單。只有暱稱與 emoji，不含任何機密。
  // 接上後端後會改由 GET ?action=users 取得，這份保留為離線 fallback。
  users: [
    { userId: 'momo',   role: 'kid',    displayName: 'Momo', emoji: '👧' },
    { userId: 'coco',   role: 'kid',    displayName: 'Coco', emoji: '👧' },
    { userId: 'dodo',   role: 'kid',    displayName: 'Dodo', emoji: '👦' },
    { userId: 'parent', role: 'parent', displayName: '爸爸', emoji: '🧑' },
    { userId: 'vicky',  role: 'parent', displayName: 'Vicky', emoji: '👩' }
  ],

  // 小孩密碼位數（伺服器端以 config.kid_password_digits 為準）
  kidPasswordDigits: 8
};
