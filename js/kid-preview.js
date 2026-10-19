// 家長唯讀分身：不切換 Auth、不寫 localStorage、不提供孩子的提交按鈕。
const KidPreview = (() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const status = { available: '尚未提交', pending: '⏳ 等待審核', approved: '✅ 已核准', rejected: '❌ 已退回', cancelled: '已取消' };
  let generation = 0;

  function body(snap) {
    const u = snap.user || {};
    const accounts = snap.accounts || [];
    const requests = snap.requests || [];
    const claim = Allowance.claimState(snap);
    const row = (name, detail) => `<li class="tx"><span class="tx-memo">${esc(name)}</span><span>${esc(detail)}</span></li>`;
    const chores = (snap.chores || []).map(c => row(c.title || c.name || c.id,
      status[Chores.deriveState(c, requests, null, snap).state])).join('');
    const pending = requests.filter(r => r.status === 'pending').map(r => {
      const chore = (snap.chores || []).find(c => String(c.id) === String(r.choreId));
      return row(r.kind === 'allowance_claim' ? '每日零用錢' : (chore && (chore.title || chore.name)) || '家事回報',
        `${Money.formatDate(r.ts)} · 等待審核`);
    }).join('');
    return `
      <div class="home-who">${esc(u.emoji)} ${esc(u.displayName)}</div>
      <div class="total"><p class="total-label">全部財產</p>
        <p class="total-num">${Money.format(accounts.reduce((sum, a) => sum + a.balance, 0))} <small>元</small></p></div>
      <div class="accts">${accounts.map(a => `<div class="acct"><div class="acct-top">${esc(a.emoji)} ${esc(a.name)}</div>
        <div class="acct-balance">${Money.format(a.balance)} <small>元</small></div></div>`).join('')}</div>
      <h3 class="sec-title">今日每日零用錢</h3>
      <p>${esc(status[claim.state])} · ${Money.format(claim.amount)} 元</p>
      <h3 class="sec-title">家事進度</h3><ul class="txs">${chores || '<li class="empty">還沒有家事</li>'}</ul>
      <h3 class="sec-title">待審申請（含之前提交）</h3>
      <ul class="txs">${pending || '<li class="empty">沒有待審申請</li>'}</ul>
      <h3 class="sec-title">最近交易</h3><ul class="txs">${(snap.ledger || []).map(l =>
        row(`${Money.formatDate(l.ts)} ${l.memo || l.type}`, `${l.amount >= 0 ? '+' : ''}${Money.format(l.amount)} 元`)
      ).join('') || '<li class="empty">還沒有交易</li>'}</ul>`;
  }

  async function refresh() {
    const ticket = ++generation;
    if (!Auth.user() || Auth.user().role !== 'parent') return;
    el('preview-body').textContent = '載入中…';
    el('preview-fresh').textContent = '';
    try {
      const res = await Api.get('snapshot', { kidId: el('preview-kid').value });
      if (ticket !== generation || !Auth.user() || Auth.user().role !== 'parent') return;
      if (!res.ok) {
        el('preview-body').textContent = res.message || '無法載入，請重新整理。';
        return;
      }
      if (!res.preview) {
        el('preview-body').textContent = '此功能需要更新後端，請先部署最新 Apps Script。';
        return;
      }
      el('preview-body').innerHTML = body(res);
      el('preview-fresh').textContent = `更新於 ${Money.formatWhen(res.serverTs)}`;
    } catch (err) {
      if (ticket === generation) el('preview-body').textContent = '連不上銀行，請重新整理再試一次。';
    }
  }

  function open(kidId, kids) {
    if (!Auth.user() || Auth.user().role !== 'parent') return;
    el('preview-kid').innerHTML = (kids || []).map(k =>
      `<option value="${esc(k.user.userId)}">${esc(k.user.emoji)} ${esc(k.user.displayName)}</option>`).join('');
    el('preview-kid').value = kidId;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-kid-preview').classList.remove('hidden');
    window.scrollTo(0, 0);
    refresh();
  }

  function clear() {
    generation++;
    el('preview-body').textContent = '';
    el('preview-fresh').textContent = '';
    el('preview-kid').innerHTML = '';
    el('view-kid-preview').classList.add('hidden');
  }

  if (typeof document !== 'undefined') {
    el('preview-kid').addEventListener('change', refresh);
    el('btn-preview-refresh').addEventListener('click', refresh);
    el('btn-preview-back').addEventListener('click', () => {
      clear();
      el('view-home').classList.remove('hidden');
      window.scrollTo(0, 0);
      Home.render();
    });
    window.addEventListener('hb-unauthorized', clear);
  }
  return { open, body };
})();
