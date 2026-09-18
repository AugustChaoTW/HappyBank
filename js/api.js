// 與 Apps Script 溝通的唯一出口。
// Content-Type 用 text/plain 規避 CORS preflight（Apps Script 不處理 OPTIONS）。
const Api = (() => {

  function configured() {
    return !!CONFIG.apiUrl;
  }

  // Apps Script 的 ContentService 只能回 HTTP 200，真正的 401 藏在 body 的
  // { ok:false, error:'unauthorized' } 裡（SPEC §8.1-3）。所以「導回登入頁」這件事
  // 只能在這裡集中做，不然每個呼叫端都要記得判斷，漏一個就會卡在別人的舊快照。
  function checkAuth(action, data) {
    if (!data || data.error !== 'unauthorized') return data;
    // Auth 在 api.js 之後才載入，但這裡是執行期才跑，所以拿得到（index.html 的載入順序）
    const had = Auth.session();
    Auth.clear();
    // 同一輪可能好幾支請求一起失敗，只有真的清掉 session 的那一支發事件，避免重複導頁
    // 登出時 session 失效是意料中的事，不用再喊一次「登入過期了」
    if (had && action !== 'logout') {
      window.dispatchEvent(new CustomEvent('hb-unauthorized', {
        detail: { message: data.message || '' }
      }));
    }
    return data;
  }

  async function post(action, payload) {
    if (!configured()) {
      return { ok: false, error: 'no-backend', message: '後端尚未部署（SPEC M1）' };
    }
    const body = { action, token: CONFIG.apiToken, ...payload };
    const session = Auth.session();
    if (session) body.session = session;

    const res = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return checkAuth(action, await res.json());
  }

  async function get(action, params) {
    if (!configured()) {
      return { ok: false, error: 'no-backend', message: '後端尚未部署（SPEC M1）' };
    }
    const qs = new URLSearchParams({ action, token: CONFIG.apiToken, ...(params || {}) });
    const session = Auth.session();
    if (session) qs.set('session', session);
    const res = await fetch(`${CONFIG.apiUrl}?${qs}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return checkAuth(action, await res.json());
  }

  return { get, post, configured };
})();
