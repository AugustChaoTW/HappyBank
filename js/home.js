// 餘額頁：總資產、四種帳戶卡、最近交易。
// 帳本的真實來源在伺服器，localStorage 只是離線快照，所以畫面一定要標「更新於 ○○」（SPEC §1）。
const Home = (() => {
  // 快照一定要分人存：共用平板上 Momo 登出、Coco 登入，絕不能看到上一個人的餘額
  const CACHE_PREFIX = 'happybank-snapshot:';
  const LEGACY_CACHE_KEY = 'happybank-snapshot';   // 舊版不分人的 key，載入時順手清掉
  const el = id => document.getElementById(id);

  // 卡片順序 = 想教的順序：能用的錢 → 不會長大的錢 → 鎖起來的錢 → 有目標的錢
  const TYPE_ORDER = { current: 0, gift: 1, term: 2, goal: 3 };
  const TYPE_EMOJI = { current: '💰', gift: '🧧', term: '🔒', goal: '🎯' };

  const LEDGER_LABEL = {
    allowance: '每週零用錢', chore: '家事獎金', interest: '利息',
    interest_reversal: '解約回沖', gift_in: '紅包', withdraw: '領現金',
    transfer_in: '轉入', transfer_out: '轉出', penalty: '罰款', adjust: '調整'
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch { /* 無痕模式就算了 */ }

  // 沒有 userId 就不留快照，寧可每次重抓，也不要存成一份大家共用的
  function cacheKey(u) {
    return u && u.userId ? CACHE_PREFIX + u.userId : null;
  }
  function loadCache(key) {
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function saveCache(key, snap) {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(snap)); } catch { /* 無痕模式就算了 */ }
  }
  function dropCache(key) {
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* 無痕模式就算了 */ }
  }

  // 後端還沒部署時也要看得到版面，但必須明白標示不是真的錢
  function demoSnapshot(user) {
    const today = new Date();
    const lock = new Date(today.getFullYear(), today.getMonth() + 3, 18);
    const ts = iso => iso.toISOString();
    return {
      ok: true, demo: true, serverTs: ts(today),
      user: user || { displayName: '小小存款人', emoji: '👧', role: 'kid' },
      accounts: [
        { accountId: 'd1', type: 'current', name: '我的活期帳戶', emoji: '💰', rateMonthly: 0.05, balance: 1250, status: 'active', lockUntil: null, targetAmount: null },
        { accountId: 'd2', type: 'gift', name: '阿公阿嬤的錢', emoji: '🧧', rateMonthly: 0, balance: 3600, status: 'active', lockUntil: null, targetAmount: null },
        { accountId: 'd3', type: 'term', name: '不要動的錢', emoji: '🔒', rateMonthly: 0.10, balance: 2000, status: 'active', lockUntil: ts(lock), targetAmount: null },
        { accountId: 'd4', type: 'goal', name: '樂高太空船', emoji: '🎯', rateMonthly: 0.05, balance: 820, status: 'active', lockUntil: null, targetAmount: 2000 }
      ],
      ledger: [
        { id: 'l1', ts: ts(today), accountId: 'd1', type: 'allowance', amount: 50, memo: '每週零用錢' },
        { id: 'l2', ts: ts(new Date(today - 2 * 864e5)), accountId: 'd4', type: 'transfer_in', amount: 300, memo: '存去樂高太空船' },
        { id: 'l3', ts: ts(new Date(today - 2 * 864e5)), accountId: 'd1', type: 'transfer_out', amount: -300, memo: '存去樂高太空船' },
        { id: 'l4', ts: ts(new Date(today - 5 * 864e5)), accountId: 'd1', type: 'chore', amount: 50, memo: '倒垃圾' },
        { id: 'l5', ts: ts(new Date(today - 9 * 864e5)), accountId: 'd1', type: 'interest', amount: 62, memo: '上個月利息' },
        { id: 'l6', ts: ts(new Date(today - 9 * 864e5)), accountId: 'd3', type: 'interest', amount: 181, memo: '上個月利息' },
        { id: 'l7', ts: ts(new Date(today - 14 * 864e5)), accountId: 'd1', type: 'withdraw', amount: -120, memo: '買文具' },
        { id: 'l8', ts: ts(new Date(today - 20 * 864e5)), accountId: 'd2', type: 'gift_in', amount: 3600, memo: '過年紅包' }
      ]
    };
  }

  // --- 各種帳戶卡下面那一行：這是整個 app 想講的話 ---
  function accountHint(a) {
    if (a.type === 'current') return '<span class="hint">隨時可以用</span>';
    if (a.type === 'gift') return '<span class="hint">這是媽媽幫你保管的錢</span>';
    if (a.type === 'term') {
      if (a.status === 'matured') return '<span class="hint alert">🔔 已到期，記得領回活期</span>';
      const days = Money.daysUntil(a.lockUntil);
      if (days == null) return '<span class="hint">🔒 鎖定中</span>';
      if (days <= 0) return '<span class="hint alert">🔔 已到期，記得領回活期</span>';
      return `<span class="hint">🔒 鎖到 ${Money.formatDate(a.lockUntil)}，還有 ${days} 天</span>`;
    }
    if (a.type === 'goal') {
      const target = Number(a.targetAmount) || 0;
      const gap = target - a.balance;
      const pct = target > 0 ? Math.min(100, Math.round(a.balance / target * 100)) : 0;
      const line = gap > 0
        ? `還差 ${Money.format(gap)} 元`
        : '🎉 達標了！可以領回活期';
      return `
        <div class="bar"><span style="width:${pct}%"></span></div>
        <span class="hint">${line}</span>`;
    }
    return '';
  }

  function accountCard(a) {
    const rate = Math.round((Number(a.rateMonthly) || 0) * 100);
    const badge = rate > 0
      ? `<span class="rate">月息 ${rate}%</span>`
      : '<span class="rate zero">不生利息</span>';
    return `
      <div class="acct acct-${esc(a.type)}">
        <div class="acct-top">
          <span class="acct-emoji">${esc(a.emoji || TYPE_EMOJI[a.type] || '🏦')}</span>
          <span class="acct-name">${esc(a.name)}</span>
          ${badge}
        </div>
        <div class="acct-balance">${Money.format(a.balance)} <small>元</small></div>
        ${accountHint(a)}
      </div>`;
  }

  function ledgerRow(l) {
    const positive = (Number(l.amount) || 0) >= 0;
    const kind = LEDGER_LABEL[l.type] || l.type;
    const label = l.memo || kind;
    // memo 常常就是類型名（「每週零用錢」），一樣就不要印兩次
    const sub = label === kind ? '' : `<small>${esc(kind)}</small>`;
    return `
      <li class="tx">
        <span class="tx-date">${Money.formatDate(l.ts).slice(5)}</span>
        <span class="tx-memo">${esc(label)}${sub}</span>
        <span class="tx-amt ${positive ? 'up' : 'down'}">${positive ? '+' : '−'}${Money.format(Math.abs(l.amount))}</span>
      </li>`;
  }

  function paint(snap, note) {
    const accounts = (snap.accounts || [])
      .slice()
      .sort((x, y) => (TYPE_ORDER[x.type] ?? 9) - (TYPE_ORDER[y.type] ?? 9));

    const total = accounts.reduce((n, a) => n + (Number(a.balance) || 0), 0);
    const interest = accounts.reduce((n, a) => n + Money.monthlyInterest(a.balance, a.rateMonthly), 0);
    const u = snap.user || {};
    const ledger = (snap.ledger || []).slice(0, 8);

    el('home-body').innerHTML = `
      <div class="home-who">${esc(u.emoji || '👧')} ${esc(u.displayName || '')}</div>
      <div class="total">
        <p class="total-label">我的全部財產</p>
        <p class="total-num">${Money.format(total)} <small>元</small></p>
      </div>
      <div class="interest-hook">
        這個月預計利息 <strong>${Money.format(interest)}</strong> 元
      </div>
      ${typeof Chores !== 'undefined' ? Chores.navCard(snap) : ''}
      <div class="accts">${accounts.map(accountCard).join('')}</div>
      <h3 class="sec-title">最近交易</h3>
      ${ledger.length
        ? `<ul class="txs">${ledger.map(ledgerRow).join('')}</ul>`
        : '<p class="empty">還沒有任何交易。</p>'}`;

    const when = Money.formatWhen(snap.serverTs);
    el('home-fresh').textContent = note
      ? `${note}${when ? ' · 更新於 ' + when : ''}`
      : (when ? `更新於 ${when}` : '');
  }

  function showBanner(text) {
    const b = el('home-banner');
    b.textContent = text || '';
    b.classList.toggle('hidden', !text);
  }

  async function render(user) {
    const u = user || Auth.user() || {};

    if (u.role === 'parent') {
      showBanner('');
      el('home-fresh').textContent = '';
      el('home-body').innerHTML = `
        <div class="placeholder">
          <div class="big">🛠️</div>
          <h2>${esc(u.emoji || '🧑')} 哈囉，${esc(u.displayName || '')}！</h2>
          <p>家長模式還在蓋。</p>
        </div>`;
      return;
    }

    if (!Api.configured()) {
      showBanner('示範資料 · 後端還沒接上，這些數字是假的');
      paint(demoSnapshot(u), '示範資料');
      return;
    }

    // 先畫快取，讓小孩一開 app 就看得到數字，網路回來再覆蓋
    const key = cacheKey(u);
    const cached = loadCache(key);
    // 還在等網路不等於離線。標成「離線快取」會讓線上的人以為斷線了，
    // 而 Apps Script 要 2~4 秒，這個誤導的標籤會停留很久。
    if (cached) { showBanner(''); paint(cached, '更新中…'); }

    let res;
    try {
      res = await Api.get('snapshot');
    } catch (err) {
      console.warn('snapshot fetch failed', err);
      res = null;
    }

    if (res && res.ok) {
      saveCache(key, res);
      showBanner('');
      paint(res);
      return;
    }

    // session 被踢掉或過期：api.js 已經發了 hb-unauthorized，login.js 會把人帶回選頭像。
    // 這裡負責把畫面與快照清乾淨，不然下一個登入的人會先看到這個人的數字。
    if (res && res.error === 'unauthorized') {
      dropCache(key);
      showBanner('');
      el('home-fresh').textContent = '';
      el('home-body').innerHTML = '';
      return;
    }

    // 伺服器忙不過來（script lock 等太久）也要照實講，不要混進「連不上」
    if (res && res.error === 'busy' && !cached) {
      showBanner('');
      el('home-fresh').textContent = '';
      el('home-body').innerHTML = `
        <div class="placeholder">
          <div class="big">⏳</div>
          <h2>銀行有點忙</h2>
          <p>${esc(res.message || '等一下再試一次。')}</p>
        </div>`;
      return;
    }

    if (cached) {
      if (res && res.error === 'busy') {
        showBanner(res.message || '銀行有點忙，先看上次的資料');
        paint(cached, '離線快取');
        return;
      }
      showBanner('連不上銀行，先看上次的資料');
      paint(cached, '離線快取');
    } else {
      showBanner('');
      el('home-fresh').textContent = '';
      el('home-body').innerHTML = `
        <div class="placeholder">
          <div class="big">📡</div>
          <h2>連不上銀行</h2>
          <p>${esc((res && res.message) || '檢查一下網路，等一下再試。')}</p>
        </div>`;
    }
  }

  return { render };
})();
