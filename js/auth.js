// 登入狀態：session token 存 localStorage，身分一律以伺服器回傳為準。
const Auth = (() => {
  const KEY = 'happybank-session';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }

  function session() {
    const s = load();
    if (!s) return null;
    if (s.expiresTs && Date.parse(s.expiresTs) < Date.now()) { clear(); return null; }
    return s.session;
  }

  function user() {
    const s = load();
    return s && session() ? s.user : null;
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch { /* 無痕模式擋住就算了 */ }
  }

  // 回傳 { ok, user } 或 { ok:false, error, message }
  async function login(userId, password) {
    let res;
    try {
      // userId 一律轉小寫比對，大小寫不敏感（伺服器端也會再做一次）
      res = await Api.post('login', { userId: String(userId).trim().toLowerCase(), password });
    } catch (err) {
      console.error('login failed', err);
      return { ok: false, error: 'network', message: '連不上銀行，檢查一下網路？' };
    }
    if (!res.ok) return res;

    try {
      localStorage.setItem(KEY, JSON.stringify({
        session: res.session, expiresTs: res.expiresTs, user: res.user
      }));
    } catch { /* 存不進去仍可用完這一次 */ }
    return res;
  }

  async function logout() {
    try { await Api.post('logout', {}); } catch { /* 本地清掉就好 */ }
    clear();
  }

  return { login, logout, session, user, clear };
})();
