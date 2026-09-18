// 與 Apps Script 溝通的唯一出口。
// Content-Type 用 text/plain 規避 CORS preflight（Apps Script 不處理 OPTIONS）。
const Api = (() => {

  function configured() {
    return !!CONFIG.apiUrl;
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
    return res.json();
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
    return res.json();
  }

  return { get, post, configured };
})();
