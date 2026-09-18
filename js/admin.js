// 家長模式：待審清單（含家事照片縮圖）、核准／退回／代理確認、全選核准、手動調帳。
// SPEC §6 admin、§7.1 家長 snapshot、§7.2 admin_*、§7.4 錯誤表、§7.6 chore_photo、§9.4、§9.5。
//
// 三條不能妥協的規則：
//   1. 照片是 private 的，縮圖一律延遲抓、一張一張抓、只快取在記憶體（不進 localStorage）。
//   2. needs-proxy 絕不自動重送——多按一次是 §9.5 刻意設計的摩擦。
//   3. 退回一定要有理由；伺服器會擋 note-required，但讓家長看到空欄位被打回來很蠢，前端先擋。
const Admin = (() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const KIND_LABEL = { chore_done: '家事', withdraw: '領現金', term_break: '定存解約' };

  // 退回理由的一鍵範本。家長在手機上打字很痛苦，打不出來就會亂按核准——
  // 而「看不懂的退回」比不退回更傷（§9.4）。
  const REJECT_PRESETS = ['照片看不出來', '還沒做完', '不是今天做的', '再拍清楚一點'];

  // 家長端 snapshot 沒有 chores 表（§7.1 只給 kids/requests/ledger），
  // 但待審清單一定要寫得出「倒垃圾 ＋10 元」。所以：有 chores 就用 chores，
  // 沒有就退回這份與 Setup.gs 種子一致的對照表，再不認得就印 choreId，不要空白。
  const CHORE_FALLBACK = {
    'chore-trash': { title: '倒垃圾', icon: '🗑️', reward: 10 },
    'chore-dishes': { title: '收碗盤', icon: '🍽️', reward: 10 },
    'chore-pets': { title: '餵魚／澆花', icon: '🐟', reward: 5 },
    'chore-sweep': { title: '掃地', icon: '🧹', reward: 15 },
    'chore-laundry': { title: '摺自己的衣服', icon: '👕', reward: 15 },
    'chore-room': { title: '整理自己的房間', icon: '🛏️', reward: 20 }
  };

  // ---------- 純函式：分組、狀態機、翻譯（可單元測試） ----------

  const tsOf = r => (r && r.ts ? Date.parse(r.ts) : NaN) || 0;
  const isPending = r => r && r.status === 'pending';

  // 待審件數。首頁 badge 與 admin 頁標題共用同一條算式，兩邊數字不同會讓家長不信任畫面。
  function pendingCount(snap) {
    return ((snap && snap.requests) || []).filter(isPending).length;
  }

  // 依小孩分組、組內新到舊。kids 裡查不到的 kidId 仍要顯示（排最後）——
  // 小孩被停用但還有待審時，整筆從畫面消失等於那筆錢永遠卡住。
  function groupRequests(snap) {
    const pending = ((snap && snap.requests) || []).filter(isPending);
    if (!pending.length) return [];

    const order = [];
    const byKid = {};
    const push = (id, kid) => {
      const key = String(id || '').toLowerCase();
      if (!byKid[key]) { byKid[key] = { kid, items: [] }; order.push(key); }
      return byKid[key];
    };
    ((snap && snap.kids) || []).forEach(k => {
      const u = (k && k.user) || {};
      if (u.userId) push(u.userId, u);
    });

    pending.forEach(r => {
      const key = String(r.kidId || '').toLowerCase();
      const g = byKid[key] || push(key, { userId: key, displayName: r.kidId || '?', emoji: '🧒' });
      g.items.push(r);
    });

    return order
      .map(k => byKid[k])
      .filter(g => g.items.length)
      .map(g => {
        g.items.sort((a, b) => tsOf(b) - tsOf(a));
        return g;
      });
  }

  // 「代替 ⟨誰⟩ 確認」要寫真名。snapshot 只保證頂層有 chore_approver 這個 userId，
  // 名字得自己湊：自己就是核准者時用自己的 displayName，否則查名單，查不到就印 id。
  function approverName(snap, users) {
    const id = String((snap && snap.chore_approver) || '').trim();
    if (!id) return '';
    const me = (snap && snap.user) || {};
    if (String(me.userId || '').toLowerCase() === id.toLowerCase()) return me.displayName || id;
    const hit = (users || []).find(u => String(u.userId || '').toLowerCase() === id.toLowerCase());
    return (hit && hit.displayName) || id;
  }

  // 每一列的狀態機：idle → sending → (done | needs-proxy | stale | error)。
  // proxy 一旦被伺服器點名就黏住——重試、改按退回都還是代理，不能悄悄退回成正式核准。
  function initialRow() {
    return { phase: 'idle', proxy: false, note: '', message: '', result: '' };
  }
  function startSend(row) {
    return Object.assign({}, row || initialRow(), { phase: 'sending', message: '' });
  }
  function applyDecideResult(row, res) {
    const base = Object.assign({}, row || initialRow());
    if (res && res.ok) {
      base.phase = 'done';
      base.result = res.status || 'approved';
      base.message = '';
      return base;
    }
    const error = (res && res.error) || 'network';
    if (error === 'needs-proxy') {
      base.phase = 'needs-proxy';
      base.proxy = true;                       // 只換按鈕，**不自動重送**（§9.5）
      base.message = (res && res.message) || '';
      return base;
    }
    base.phase = error === 'already-decided' ? 'stale' : 'error';
    base.message = (res && res.message) || '';
    base.error = error;
    return base;
  }
  const needsRefresh = row => !!row && row.phase === 'stale';

  function canSubmit(decision, row) {
    const r = row || initialRow();
    if (r.phase === 'sending' || r.phase === 'done' || r.phase === 'stale') return false;
    if (decision === 'reject') return !!String(r.note || '').trim();
    return true;
  }

  // 送出前的最後一道：回 null 代表不能送（退回沒理由）。
  function decidePayload(requestId, decision, row) {
    if (!canSubmit(decision, row)) return null;
    const p = { requestId, decision, decidedNote: String((row && row.note) || '').trim() };
    if (row && row.proxy) p.proxy = true;
    return p;
  }

  function buttonLabel(row, approver) {
    const r = row || initialRow();
    if (r.phase === 'sending') return '處理中…';
    if (r.phase === 'done') return r.result === 'rejected' ? '已退回' : '已核准';
    if (r.proxy) return approver ? `代替 ${approver} 確認` : '代替確認';
    return '核准 ✔';
  }

  // 伺服器錯誤碼 → 家長看得懂的話（§7.4）。暫時性與永久性要分得出來，
  // 不然家長會對著「餘額不夠」一直按重試。
  function errorMessage(error, message, approver) {
    switch (error) {
      case 'needs-proxy':
        return `這件要 ${approver || '指定的家長'} 確認，要代替的話再按一次「代替確認」`;
      case 'already-decided': return '這筆已經被別人處理過了，幫你重新整理成最新狀態';
      case 'note-required': return '退回要寫一句理由，讓小孩知道為什麼';
      case 'unauthorized': return '登入過期了，請重新登入';
      case 'busy': return '銀行正在忙（有人同時在寫帳），等幾秒再按一次';
      case 'no-such-request': return '找不到這筆申請，重新整理看看';
      case 'photo-missing': return '照片讀不到';
      case 'kid-mismatch': return '這個帳戶不是這個小孩的';
      case 'account-inactive':
      case 'account-closed': return '這個帳戶現在不能異動';
      case 'no-account': return '找不到這個帳戶';
      case 'no-kid': return '找不到這個小孩';
      case 'zero-amount': return '金額不能是 0';
      case 'insufficient': return message || '餘額不夠';
      case 'network': return '連不上銀行，等一下再試一次';
      case 'no-backend': return '後端還沒接上';
      default: return message || '出了點問題，等一下再試一次';
    }
  }

  function summarizeBatch(state, approver) {
    const s = state || {};
    if (!s.stopped) return `全部核准完成，共 ${s.done || 0} 件`;
    return `已核准 ${s.done || 0} / ${s.total || 0} 件，卡在第 ${(s.done || 0) + 1} 件：` +
      errorMessage(s.error, s.message, approver);
  }

  // ---------- 以下是畫面與網路，不進單元測試 ----------

  let snapshot = null;
  const rows = new Map();          // requestId → 上面那個狀態物件
  const photoCache = new Map();    // requestId → dataUrl | 'error'；只在記憶體（§7.6）
  const rejectOpen = new Set();
  let batch = null;                // { done, total, stopped, error, message, running }
  let toolMsg = '';
  let toolBusy = false;
  const tool = { kid: '', accountId: '', amount: '', memo: '', giftKid: '', giftAmount: '', giftMemo: '' };

  const rowOf = id => rows.get(id) || initialRow();
  const users = () => (typeof CONFIG !== 'undefined' && CONFIG.users) || [];
  const approver = () => approverName(snapshot, users());
  const fmt = n => (typeof Money !== 'undefined' ? Money.format(n) : String(n));
  const when = iso => (typeof Chores !== 'undefined' ? Chores.friendlyTs(iso) : String(iso || ''));

  function choreOf(req) {
    const list = (snapshot && snapshot.chores) || [];
    const hit = list.find(c => String(c.id) === String(req.choreId));
    return hit || CHORE_FALLBACK[String(req.choreId)] || null;
  }

  function newClientId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().toLowerCase();
    return ('hb-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10)).toLowerCase();
  }

  // ---------- 縮圖：延遲、序列、記憶體快取 ----------
  // 一張照片＝一趟 Apps Script 往返（1～2 秒）。十筆待審一起抓會整頁卡住，
  // 所以捲進畫面才排隊，而且一次只抓一張（§6、§7.6）。

  function thumb(req) {
    if (req.kind !== 'chore_done') return '<div class="adm-thumb none">—</div>';
    if (!req.photoFileId) return '<div class="adm-thumb bad">沒有照片</div>';
    const cached = photoCache.get(req.id);
    if (cached === 'error') return '<div class="adm-thumb bad">照片讀不到</div>';
    if (cached) return `<img class="adm-thumb" src="${esc(cached)}" alt="家事照片" data-zoom="${esc(req.id)}">`;
    return `<div class="adm-thumb loading" data-photo="${esc(req.id)}"><span class="spin"></span></div>`;
  }

  const queue = [];
  let draining = false;

  function enqueue(requestId) {
    if (photoCache.has(requestId) || queue.indexOf(requestId) >= 0) return;
    queue.push(requestId);
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const requestId = queue.shift();
        if (photoCache.has(requestId)) continue;
        let res = null;
        try { res = await Api.get('chore_photo', { requestId }); } catch { res = null; }
        // 失敗只記一次，不重試——重試也是 1～2 秒，家長只會更煩（§7.6）
        photoCache.set(requestId, res && res.ok && res.data
          ? 'data:image/jpeg;base64,' + res.data : 'error');
        paintThumb(requestId);
      }
    } finally {
      draining = false;
    }
  }

  function paintThumb(requestId) {
    const box = document.querySelector(`#view-admin .adm-thumb.loading[data-photo="${CSS.escape(requestId)}"]`);
    if (!box) return;
    const data = photoCache.get(requestId);
    if (data === 'error') {
      box.className = 'adm-thumb bad';
      box.textContent = '照片讀不到';       // 破圖會讓家長看不到證據就順手核准
      return;
    }
    const img = new Image();
    img.className = 'adm-thumb';
    img.alt = '家事照片';
    img.src = data;
    img.dataset.zoom = requestId;
    box.replaceWith(img);
  }

  let observer = null;
  function observeThumbs() {
    const boxes = document.querySelectorAll('#view-admin .adm-thumb.loading[data-photo]');
    if (typeof IntersectionObserver !== 'function') {
      // 不支援就退回「全部排隊」——仍然是一張一張抓，只是不等捲動
      boxes.forEach(b => enqueue(b.dataset.photo));
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          observer.unobserve(e.target);
          enqueue(e.target.dataset.photo);
        });
      }, { rootMargin: '200px' });
    }
    boxes.forEach(b => observer.observe(b));
  }

  function zoom(requestId) {
    const data = photoCache.get(requestId);
    if (!data || data === 'error') return;
    el('photo-modal-img').src = data;
    el('photo-modal').classList.remove('hidden');
  }

  // ---------- 畫面 ----------

  function requestRow(req, kid) {
    const row = rowOf(req.id);
    const chore = req.kind === 'chore_done' ? choreOf(req) : null;
    const title = chore ? `${chore.icon || '🧹'} ${chore.title}`
      : `${KIND_LABEL[req.kind] || req.kind}${req.choreId ? '（' + req.choreId + '）' : ''}`;
    const amount = chore ? Number(chore.reward) || 0 : Number(req.amount) || 0;
    const amt = amount ? `<span class="adm-amt">＋${fmt(amount)} 元</span>` : '';
    const note = req.note ? `<p class="adm-kidnote">小孩備註：${esc(req.note)}</p>` : '';

    const state = row.phase === 'done'
      ? `<p class="adm-result ok">${row.result === 'rejected' ? '已退回' : '已核准'}</p>`
      : row.message || row.phase === 'error' || row.phase === 'stale' || row.phase === 'needs-proxy'
        ? `<p class="adm-result warn">${esc(errorMessage(row.error, row.message, approver()))}</p>`
        : '';

    const actions = row.phase === 'done' ? '' : `
      <div class="adm-actions">
        <button class="btn-approve" data-approve="${esc(req.id)}"
          ${row.phase === 'sending' ? 'disabled' : ''}>${esc(buttonLabel(row, approver()))}</button>
        <button class="btn-reject" data-reject="${esc(req.id)}"
          ${row.phase === 'sending' ? 'disabled' : ''}>退回</button>
      </div>
      ${rejectOpen.has(req.id) ? rejectBox(req) : ''}`;

    return `
      <div class="adm-row ${row.phase}" data-req="${esc(req.id)}">
        <div class="adm-main">
          ${thumb(req)}
          <div class="adm-info">
            <p class="adm-title">${esc(title)} ${amt}</p>
            <p class="adm-sub">${esc(kid.emoji || '🧒')} ${esc(kid.displayName || kid.userId)} · ${esc(when(req.ts))}</p>
            ${note}
          </div>
        </div>
        ${state}
        ${actions}
      </div>`;
  }

  function rejectBox(req) {
    const row = rowOf(req.id);
    const chips = REJECT_PRESETS.map(p =>
      `<button class="chip" data-preset="${esc(req.id)}" data-text="${esc(p)}">${esc(p)}</button>`).join('');
    return `
      <div class="adm-reject">
        <p class="adm-reject-hint">退回要寫理由——小孩看不懂的退回比不退回更糟。</p>
        <div class="chips">${chips}</div>
        <textarea class="adm-note-input" data-note="${esc(req.id)}" rows="2"
          placeholder="為什麼退回？">${esc(row.note)}</textarea>
        <div class="adm-actions">
          <button class="btn-reject solid" data-do-reject="${esc(req.id)}"
            ${canSubmit('reject', row) ? '' : 'disabled'}>送出退回</button>
          <button class="btn-text" data-cancel-reject="${esc(req.id)}">取消</button>
        </div>
      </div>`;
  }

  function kidOption(k) {
    const u = (k && k.user) || {};
    return `<option value="${esc(u.userId)}" ${tool.kid === u.userId ? 'selected' : ''}>${esc(u.emoji || '')} ${esc(u.displayName || u.userId)}</option>`;
  }

  function toolsBlock() {
    const kids = (snapshot && snapshot.kids) || [];
    const picked = kids.find(k => k.user && k.user.userId === tool.kid);
    // admin_adjust 只接受 active 帳戶，而且 kidId 必須對得上（Code.gs kid-mismatch）——
    // 所以帳戶下拉一律從選到的小孩身上長出來，不讓家長有機會配錯。
    const accounts = ((picked && picked.accounts) || []).filter(a => a.status === 'active');
    const accOptions = accounts.map(a =>
      `<option value="${esc(a.accountId)}" ${tool.accountId === a.accountId ? 'selected' : ''}>${esc(a.emoji || '')} ${esc(a.name)}（${fmt(a.balance)} 元）</option>`).join('');

    return `
      <details class="adm-tools" id="adm-tools">
        <summary>🧮 手動調帳 / 🧧 紅包入帳</summary>
        <div class="adm-form">
          <label>小孩
            <select data-tool="kid"><option value="">請選擇</option>${kids.map(kidOption).join('')}</select>
          </label>
          <label>帳戶
            <select data-tool="accountId" ${accounts.length ? '' : 'disabled'}>
              <option value="">${accounts.length ? '請選擇' : '先選小孩'}</option>${accOptions}
            </select>
          </label>
          <label>金額（正數入帳、負數扣款／罰款）
            <input type="number" inputmode="numeric" data-tool="amount" value="${esc(tool.amount)}" placeholder="例如 -20">
          </label>
          <label>備註
            <input type="text" data-tool="memo" value="${esc(tool.memo)}" placeholder="為什麼調這筆帳？">
          </label>
          <button class="btn-primary" id="btn-adjust" ${toolBusy ? 'disabled' : ''}>送出調帳</button>
        </div>

        <div class="adm-form">
          <label>🧧 紅包入帳給
            <select data-tool="giftKid"><option value="">請選擇</option>${kids.map(k => {
              const u = (k && k.user) || {};
              return `<option value="${esc(u.userId)}" ${tool.giftKid === u.userId ? 'selected' : ''}>${esc(u.emoji || '')} ${esc(u.displayName || u.userId)}</option>`;
            }).join('')}</select>
          </label>
          <label>金額
            <input type="number" inputmode="numeric" data-tool="giftAmount" value="${esc(tool.giftAmount)}" placeholder="例如 600">
          </label>
          <label>備註
            <input type="text" data-tool="giftMemo" value="${esc(tool.giftMemo)}" placeholder="過年紅包">
          </label>
          <button class="btn-primary" id="btn-gift" ${toolBusy ? 'disabled' : ''}>紅包入帳</button>
        </div>
        <p class="adm-tool-msg">${esc(toolMsg)}</p>
      </details>`;
  }

  function paint() {
    const snap = snapshot || {};
    // 整塊 innerHTML 重畫會把 <details> 關起來，家長正在填的調帳表單就消失了
    const toolsOpen = !!(el('adm-tools') && el('adm-tools').open);
    const groups = groupRequests(snap);
    const n = pendingCount(snap);
    const batchLine = batch
      ? `<p class="adm-batch">${batch.running
          ? `核准中… ${batch.done} / ${batch.total}`
          : esc(summarizeBatch(batch, approver()))}</p>`
      : '';

    const list = groups.length
      ? groups.map(g => `
          <h3 class="sec-title">${esc(g.kid.emoji || '🧒')} ${esc(g.kid.displayName || g.kid.userId)}（${g.items.length}）</h3>
          <div class="adm-list">${g.items.map(r => requestRow(r, g.kid)).join('')}</div>`).join('')
      : '<p class="empty">目前沒有待審的申請 🎉</p>';

    el('admin-body').innerHTML = `
      <div class="adm-hero">
        <div>
          <p class="adm-hero-label">本週待審</p>
          <p class="adm-hero-num">${n} <small>件</small></p>
        </div>
        ${n > 1 ? `<button class="btn-primary adm-all" id="btn-approve-all"
          ${batch && batch.running ? 'disabled' : ''}>全選核准</button>` : ''}
      </div>
      ${batchLine}
      ${list}
      ${toolsBlock()}`;

    if (toolsOpen && el('adm-tools')) el('adm-tools').open = true;
    const w = typeof Money !== 'undefined' ? Money.formatWhen(snap.serverTs) : '';
    el('admin-fresh').textContent = w ? `更新於 ${w}` : '';
    observeThumbs();
  }

  function setMsg(text, kind) {
    const node = el('admin-msg');
    node.textContent = text || '';
    node.className = 'msg ' + (kind || 'error');
    node.classList.toggle('hidden', !text);
  }

  // ---------- 決定：核准 / 退回 ----------

  async function decide(requestId, decision) {
    const row = rowOf(requestId);
    const payload = decidePayload(requestId, decision, row);
    if (!payload) {                    // 退回沒寫理由：前端先擋（伺服器也會回 note-required）
      setMsg(errorMessage('note-required'));
      return false;
    }
    rows.set(requestId, startSend(row));
    setMsg('');
    paint();

    let res;
    try {
      res = await Api.post('admin_decide', Object.assign({ clientId: newClientId() }, payload));
    } catch (err) {
      console.warn('admin_decide failed', err);
      res = { ok: false, error: 'network' };
    }

    const next = applyDecideResult(rows.get(requestId), res);
    rows.set(requestId, next);
    if (next.phase === 'done') rejectOpen.delete(requestId);
    paint();

    // 別人先按了：畫面上的資料已經是舊的，重抓比在原地解釋有用（§7.4）
    if (needsRefresh(next)) {
      setMsg(errorMessage('already-decided'), 'info');
      await refresh();
      return false;
    }
    if (next.phase !== 'done') {
      setMsg(errorMessage(next.error, next.message, approver()));
      return false;
    }
    setMsg('');
    return true;
  }

  // 全選核准：**一定要序列**。後端每次寫入都搶同一把 script lock，
  // 平行送只會讓大家互相 busy（§7.3）。中途失敗就停下來講清楚，不要默默跳過。
  async function approveAll() {
    const ids = groupRequests(snapshot).reduce((all, g) => all.concat(g.items.map(r => r.id)), [])
      .filter(id => rowOf(id).phase !== 'done');
    if (!ids.length) return;

    batch = { done: 0, total: ids.length, running: true };
    setMsg('');
    paint();

    for (const id of ids) {
      const ok = await decide(id, 'approve');
      if (!ok) {
        const row = rowOf(id);
        batch.stopped = true;
        batch.error = row.phase === 'needs-proxy' ? 'needs-proxy' : row.error;
        batch.message = row.message;
        break;
      }
      batch.done += 1;
      paint();
    }
    batch.running = false;
    setMsg(summarizeBatch(batch, approver()), batch.stopped ? 'error' : 'info');
    paint();
  }

  // ---------- 手動調帳 / 紅包 ----------

  async function submitAdjust() {
    const amount = Math.round(Number(tool.amount) || 0);
    if (!tool.kid || !tool.accountId) { toolMsg = '要先選小孩與帳戶'; return paint(); }
    if (!amount) { toolMsg = '金額不能是 0'; return paint(); }
    if (!tool.memo.trim()) { toolMsg = '寫一句備註，三個月後的自己會感謝你'; return paint(); }

    toolBusy = true; toolMsg = '送出中…'; paint();
    let res;
    try {
      res = await Api.post('admin_adjust', {
        kidId: tool.kid, accountId: tool.accountId, amount,
        memo: tool.memo.trim(), clientId: newClientId()
      });
    } catch { res = { ok: false, error: 'network' }; }
    toolBusy = false;

    if (res && res.ok) {
      toolMsg = `完成，餘額變成 ${fmt(res.balanceAfter)} 元`;
      tool.amount = ''; tool.memo = '';
      await refresh();
      return;
    }
    toolMsg = errorMessage(res && res.error, res && res.message, approver());
    paint();
  }

  async function submitGift() {
    const amount = Math.round(Number(tool.giftAmount) || 0);
    if (!tool.giftKid) { toolMsg = '要先選小孩'; return paint(); }
    if (amount <= 0) { toolMsg = '紅包金額要大於 0'; return paint(); }

    toolBusy = true; toolMsg = '送出中…'; paint();
    let res;
    try {
      res = await Api.post('admin_gift', {
        kidId: tool.giftKid, amount, memo: tool.giftMemo.trim() || '紅包', clientId: newClientId()
      });
    } catch { res = { ok: false, error: 'network' }; }
    toolBusy = false;

    if (res && res.ok) {
      toolMsg = `紅包入帳了，紅包帳戶變成 ${fmt(res.balanceAfter)} 元`;
      tool.giftAmount = ''; tool.giftMemo = '';
      await refresh();
      return;
    }
    toolMsg = errorMessage(res && res.error, res && res.message, approver());
    paint();
  }

  // ---------- 取資料與進出頁 ----------

  function isParent() {
    const u = (typeof Auth !== 'undefined' && Auth.user()) || {};
    return u.role === 'parent';
  }

  function denied() {
    el('admin-body').innerHTML = `
      <div class="placeholder">
        <div class="big">🔒</div>
        <h2>這一頁是大人的</h2>
        <p>家長模式要用家長帳號登入才看得到。</p>
      </div>`;
    el('admin-fresh').textContent = '';
  }

  async function refresh() {
    if (!isParent()) return denied();
    let res = null;
    try { res = await Api.get('snapshot'); } catch (err) { console.warn('snapshot failed', err); }
    if (res && res.ok) {
      // 伺服器才是真正的門（§6）；萬一拿到小孩形狀的快照也不要畫壞
      if (!res.kids) return denied();
      snapshot = res;
    } else if (res && res.error === 'unauthorized') {
      return;                    // api.js 已經清掉 session 並導回登入頁
    } else if (res && !snapshot) {
      setMsg(errorMessage(res.error, res.message, approver()));
    }
    paint();
  }

  // 首頁（家長）的整塊內容。home.js 只呼叫這一支，家長版面的細節都留在 admin.js 裡。
  function parentBody(snap) {
    if (snap && snap.kids) snapshot = snap;
    const s = snapshot || {};
    const u = s.user || {};
    const n = pendingCount(s);
    const kids = (s.kids || []).map(k => {
      const ku = k.user || {};
      const accts = (k.accounts || []).map(a =>
        `<li><span>${esc(a.emoji || '🏦')} ${esc(a.name)}</span><b>${fmt(a.balance)}</b></li>`).join('');
      return `
        <div class="adm-kid">
          <div class="adm-kid-top">
            <span class="adm-kid-face">${esc(ku.emoji || '🧒')}</span>
            <span class="adm-kid-name">${esc(ku.displayName || ku.userId)}</span>
            <span class="adm-kid-total">${fmt(k.total)} <small>元</small></span>
          </div>
          <ul class="adm-kid-accts">${accts || '<li class="empty">還沒有帳戶</li>'}</ul>
        </div>`;
    }).join('');

    return `
      <div class="home-who">${esc(u.emoji || '🧑')} ${esc(u.displayName || '')}</div>
      <button class="nav-card" id="btn-admin">
        <span class="nav-icon">🛠️</span>
        <span class="nav-text">家長審核${n ? `<span class="nav-badge">${n}</span>` : ''}</span>
        <span class="nav-sub">${n ? `本週待審 ${n} 件` : '目前沒有待審的申請'}</span>
        <span class="nav-go">›</span>
      </button>
      ${kids || '<p class="empty">還沒有小孩的帳戶資料。</p>'}`;
  }

  function open() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-admin').classList.remove('hidden');
    window.scrollTo(0, 0);
    setMsg('');
    batch = null;
    if (!isParent()) return denied();
    paint();
    refresh();
  }

  function back() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-home').classList.remove('hidden');
    window.scrollTo(0, 0);
    Home.render();
  }

  // 列是 innerHTML 重畫的，事件一律委派；輸入框的值存進 state，才不會一打字就被重畫吃掉。
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const hit = sel => e.target.closest && e.target.closest(sel);

      if (hit('#btn-admin')) return open();
      if (hit('#btn-admin-back')) return back();

      const modal = hit('#photo-modal');
      if (modal) return el('photo-modal').classList.add('hidden');

      const zoomable = hit('[data-zoom]');
      if (zoomable) return zoom(zoomable.dataset.zoom);

      const approve = hit('[data-approve]');
      if (approve) return decide(approve.dataset.approve, 'approve');

      const rej = hit('[data-reject]');
      if (rej) { rejectOpen.add(rej.dataset.reject); return paint(); }

      const cancel = hit('[data-cancel-reject]');
      if (cancel) { rejectOpen.delete(cancel.dataset.cancelReject); return paint(); }

      const preset = hit('[data-preset]');
      if (preset) {
        const id = preset.dataset.preset;
        const row = rowOf(id);
        const text = preset.dataset.text;
        // 連按兩個範本就接起來，家長常常想講兩件事
        rows.set(id, Object.assign({}, row, { note: row.note ? row.note + '、' + text : text }));
        return paint();
      }

      const doReject = hit('[data-do-reject]');
      if (doReject) return decide(doReject.dataset.doReject, 'reject');

      if (hit('#btn-approve-all')) return approveAll();
      if (hit('#btn-adjust')) { e.preventDefault(); return submitAdjust(); }
      if (hit('#btn-gift')) { e.preventDefault(); return submitGift(); }
    });

    // 打字不重畫（重畫會把游標吃掉），只把「送出退回」的 disabled 跟著切
    document.addEventListener('input', e => {
      const noteBox = e.target.closest && e.target.closest('[data-note]');
      if (noteBox) {
        const id = noteBox.dataset.note;
        rows.set(id, Object.assign({}, rowOf(id), { note: noteBox.value }));
        const btn = document.querySelector(`[data-do-reject="${CSS.escape(id)}"]`);
        if (btn) btn.disabled = !canSubmit('reject', rowOf(id));
        return;
      }
      const field = e.target.closest && e.target.closest('[data-tool]');
      if (field) tool[field.dataset.tool] = field.value;
    });

    document.addEventListener('change', e => {
      const field = e.target.closest && e.target.closest('[data-tool]');
      if (!field) return;
      tool[field.dataset.tool] = field.value;
      // 換小孩要換帳戶清單，這個一定要重畫（帳戶下拉是從選到的小孩身上長出來的）
      if (field.dataset.tool === 'kid') { tool.accountId = ''; paint(); }
    });

    window.addEventListener('hb-unauthorized', () => {
      snapshot = null;
      rows.clear();
      photoCache.clear();      // 照片不留在裝置上，也不留在下一個人的畫面上
      rejectOpen.clear();
      queue.length = 0;
      batch = null;
      el('view-admin').classList.add('hidden');
      el('photo-modal').classList.add('hidden');
    });
  }

  return {
    open, back, refresh, parentBody,
    // 純函式，給測試與其他頁用
    groupRequests, pendingCount, approverName, initialRow, startSend, applyDecideResult,
    needsRefresh, canSubmit, decidePayload, buttonLabel, errorMessage, summarizeBatch
  };
})();
