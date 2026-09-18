// 每日零用錢頁（小孩端）。一天一次：三件事都做到 → 拍一張照 → 送出 → 等大人確認。
// 三項清單是伺服器給的（snapshot.daily_checklist），不寫死在這裡——
// 哪天大人想改成四項，後端改一格試算表就好，前端不必重新部署。
// 兩道門：沒勾完不給拍照、沒照片不給送出。兩道在伺服器都會再擋一次，
// 這裡擋只是為了不讓小孩白做工（跟 chores.js 同一個思路）。
const Allowance = (() => {
  const el = id => document.getElementById(id);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 後端沒送清單時的預設（也是目前家裡講好的三件事）
  const DEFAULT_CHECKLIST = ['好好照顧自己', '尊重別人的需求', '完成自己的工作'];
  const DEFAULT_APPROVER = 'vicky';

  let snapshot = null;
  let draft = null;        // { base64, dataUrl, clientId }
  const ticked = new Set();  // 勾起來的「項目文字」，不是索引——伺服器改順序也不會勾錯格
  let sending = false;
  let waitingPhoto = false;

  // ---------- 純函式（可單元測試） ----------

  // 伺服器送幾項就畫幾項；壞資料或空清單才退回預設，不要畫出一張沒東西可勾的卡
  function checklist(snap) {
    const raw = snap && snap.daily_checklist;
    if (!Array.isArray(raw)) return DEFAULT_CHECKLIST.slice();
    const items = raw.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    return items.length ? items : DEFAULT_CHECKLIST.slice();
  }

  function approver(snap) {
    return (snap && (snap.allowance_approver || snap.chore_approver)) || DEFAULT_APPROVER;
  }

  const tsOf = r => (r && r.ts ? Date.parse(r.ts) : NaN) || 0;

  // 「今天」的界線直接借 Chores.periodKey('daily')——零用錢與家事必須同一條線，
  // 不然小孩在半夜十二點前後會看到兩頁講不同的日子。
  function claimState(snap, now) {
    const when = now || new Date();
    const key = Chores.periodKey('daily', when);
    const mine = ((snap && snap.requests) || []).filter(r =>
      r && r.kind === 'allowance_claim' &&
      Chores.periodKey('daily', r.ts || when) === key);

    const latest = status => mine
      .filter(r => r.status === status)
      .sort((a, b) => tsOf(b) - tsOf(a))[0] || null;

    // rejected 不佔今天的扣打，可以同一天重送（跟家事一樣）
    const request = latest('pending') || latest('approved') || latest('rejected');
    const state = !request ? 'available' : request.status;
    return { state, request, amount: amountOf(snap, request) };
  }

  // 領到多少錢？伺服器不把金額寫回 request（核准時才讀 users.dailyAllowance），
  // 所以核准後只能從帳本上那筆同一天的零用錢入帳回推。
  // 三個來源都沒有就回 0，畫面寧可不寫數字，也不要寫錯數字。
  function amountOf(snap, request) {
    const direct = Number(request && request.amount) || Number(snap && snap.daily_allowance) || 0;
    if (direct) return direct;
    if (!request || request.status !== 'approved' || !request.decidedTs) return 0;
    const day = Chores.periodKey('daily', request.decidedTs);
    const hit = ((snap && snap.ledger) || []).find(l =>
      l && l.type === 'allowance' && Chores.periodKey('daily', l.ts) === day);
    return Number(hit && hit.amount) || 0;
  }

  function allChecked(items, tickedList) {
    const list = items || [];
    if (!list.length) return false;       // 空清單不能算「都勾完了」，不然空白也能送
    const set = new Set(tickedList || []);
    return list.every(x => set.has(x));
  }

  function remaining(items, tickedList) {
    const set = new Set(tickedList || []);
    return (items || []).filter(x => !set.has(x)).length;
  }

  function progressHint(items, tickedList) {
    const n = remaining(items, tickedList);
    return n > 0 ? `還有 ${n} 項沒勾` : '三件事都做到了，拍一張照片吧';
  }

  const openForClaim = state => state === 'available' || state === 'rejected';

  // 勾完才給拍照——照片是最慢的一步，讓小孩先確認自己真的做到了再拍
  function canShoot(o) {
    return openForClaim(o && o.state) && allChecked(o && o.items, o && o.ticked);
  }

  function canSubmit(o) {
    return canShoot(o) && !!(o && o.hasPhoto) && !(o && o.sending);
  }

  // 「✅ 媽媽在 9/18 晚上 9:14 確認 ＋20」——跟家事卡同一套寫法（誰／何時／加多少）
  function approvedLine(request, amount, defaultApprover) {
    const r = request || {};
    const who = r.decidedProxy
      ? `${Chores.title(r.decidedBy)}代替${Chores.title(defaultApprover)}`
      : Chores.title(r.decidedBy || defaultApprover);
    const when = Chores.friendlyTs(r.decidedTs);
    const money = amount > 0 ? ` ＋${Money.format(amount)}` : '';
    return `✅ ${who}${when ? '在 ' + when : ''} 確認${money}`;
  }

  // 首頁那顆「🎁 每日零用錢」大按鈕要寫的字
  function homeLabel(snap, now) {
    const info = claimState(snap, now);
    if (info.state === 'pending') return { state: 'pending', label: `⏳ 等${Chores.title(approver(snap))}確認` };
    if (info.state === 'approved') {
      const money = info.amount > 0 ? ` ＋${Money.format(info.amount)}` : '';
      return { state: 'approved', label: `✅ 今天領到了${money}` };
    }
    if (info.state === 'rejected') return { state: 'rejected', label: '❌ 退回了，再試一次 →' };
    return { state: 'available', label: '今天還沒領 →' };
  }

  // 伺服器錯誤碼 → 小孩看得懂的話。
  // 後端這幾個碼的字面還在定案中，所以同義的寫法都列進來；沒對到的就照講伺服器自己的 message，
  // 這樣就算之後多出新碼，畫面也不會冒出一句看不懂的英文。
  function errorMessage(error, message) {
    switch (error) {
      case 'checklist-incomplete':
      case 'incomplete-checklist':
      case 'checklist-required':
        return '三件事要每一件都勾起來才能領';
      case 'already-claimed':
      case 'already-requested':
      case 'already-reported':
        return '今天的零用錢已經領過了，明天再來';
      case 'photo-required': return '要拍一張照片才能送出喔';
      case 'photo-too-big': return '照片太大了，重拍一張比較近的再送一次';
      case 'busy': return '銀行現在有點忙，等幾秒再按一次送出';
      case 'unauthorized': return '登入過期了，請重新登入';
      case 'network': return '現在連不上銀行，等有網路再送一次';
      // 後端還沒做這個 action——好好講，不要讓畫面壞掉
      case 'unknown-action':
      case 'no-backend': return '這個功能還沒開通，等大人把銀行蓋好再來';
      default: return message || '送不出去，等一下再試一次';
    }
  }

  // ---------- 畫面 ----------

  function checkRow(item, on) {
    // 不用原生 checkbox：那個框對小孩的手指太小，也看不出勾了沒
    return `
      <button class="tick ${on ? 'on' : ''}" data-tick="${esc(item)}">
        <span class="tick-box">${on ? '✓' : ''}</span>
        <span class="tick-text">${esc(item)}</span>
      </button>`;
  }

  function claimBody(snap, info) {
    const items = checklist(snap);
    const list = Array.from(ticked);
    const done = allChecked(items, list);
    const rejected = info.state === 'rejected'
      ? `<p class="chore-reject">❌ 退回：${esc((info.request && info.request.decidedNote) || '沒有寫理由')}</p>`
      : '';

    const rows = items.map(i => checkRow(i, ticked.has(i))).join('');
    const hint = `<p class="tick-hint ${done ? 'ok' : ''}">${esc(progressHint(items, list))}</p>`;

    if (!draft) {
      return `${rejected}
        <div class="ticks">${rows}</div>
        ${hint}
        <button class="btn-primary" id="btn-allow-shoot" ${done ? '' : 'disabled'}>拍一張今天的照片 📷</button>
        <p class="chore-note" id="allow-note"></p>`;
    }

    // 有照片才長出送出鈕——沒草稿時這顆按鈕根本不存在，不是 disable 而已
    return `${rejected}
      <div class="ticks">${rows}</div>
      ${hint}
      <div class="chore-draft">
        <img class="chore-thumb" src="${esc(draft.dataUrl)}" alt="剛拍的照片">
        <div class="draft-actions">
          <button class="btn-primary" id="btn-allow-send" ${canSubmit({
            state: info.state, items, ticked: list, hasPhoto: true, sending
          }) ? '' : 'disabled'}>${sending ? '送出中…' : '送出 ✔'}</button>
          <button class="btn-text" id="btn-allow-retake" ${sending ? 'disabled' : ''}>重拍</button>
        </div>
        ${sending ? '<p class="chore-progress">照片有點大，正在寄給銀行…不要按第二次</p>' : ''}
        <p class="chore-note" id="allow-note"></p>
      </div>`;
  }

  function paint() {
    const snap = snapshot || {};
    const info = claimState(snap, new Date());

    let body;
    if (info.state === 'pending') {
      body = `<div class="chore chore-pending">
        <p class="state-line">⏳ 等${esc(Chores.title(approver(snap)))}確認</p>
        <p class="state-sub">今天已經送出 · ${esc(Chores.friendlyTs(info.request.ts))} 送出</p>
      </div>`;
    } else if (info.state === 'approved') {
      body = `<div class="chore chore-approved">
        <p class="state-line">${esc(approvedLine(info.request, info.amount, approver(snap)))}</p>
        <p class="state-sub">今天的零用錢領到了，明天再來</p>
      </div>`;
    } else {
      body = claimBody(snap, info);
    }

    el('allowance-summary').textContent = openForClaim(info.state)
      ? `今天這三件事做到了嗎？做到就可以領${info.amount > 0 ? ' ＋' + Money.format(info.amount) + ' 元' : '零用錢'}`
      : '';
    el('allowance-body').innerHTML = body;

    const when = Money.formatWhen(snap.serverTs);
    el('allowance-fresh').textContent = when ? `更新於 ${when}` : '';
  }

  function setMsg(text, kind) {
    const node = el('allowance-msg');
    node.textContent = text || '';
    node.className = 'msg ' + (kind || 'error');
    node.classList.toggle('hidden', !text);
  }

  function setNote(text) {
    const node = el('allow-note');
    if (node) node.textContent = text || '';
  }

  // ---------- 拍照與送出 ----------

  function newClientId() {
    // 冪等鍵：同一張照片重送要認得出是同一筆。舊瀏覽器沒有 randomUUID 就退回時間＋亂數。
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().toLowerCase();
    return ('hb-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10)).toLowerCase();
  }

  function openCamera() {
    const snap = snapshot || {};
    const info = claimState(snap, new Date());
    if (!canShoot({ state: info.state, items: checklist(snap), ticked: Array.from(ticked) })) {
      setNote('三件事要先全部勾起來');
      return;
    }
    waitingPhoto = true;
    setMsg('');
    const input = el('allowance-photo-input');
    input.value = '';     // 同一張照片連拍兩次也要觸發 change
    input.click();
  }

  async function onPhotoChosen(file) {
    if (!waitingPhoto || !file) { waitingPhoto = false; return; }
    waitingPhoto = false;

    setNote('照片處理中…');
    let out;
    try {
      out = await Photo.compress(file);
    } catch (err) {
      // 壓縮失敗一律請小孩重拍，不 fallback 送原圖
      console.warn('compress failed', err);
      setMsg('這張照片讀不出來，麻煩重拍一張（用相機拍，不要選很舊的檔案）');
      setNote('');
      return;
    }
    draft = { base64: out.base64, dataUrl: out.dataUrl, bytes: out.bytes, clientId: newClientId() };
    setMsg('');
    paint();
  }

  async function submit() {
    const snap = snapshot || {};
    const info = claimState(snap, new Date());
    const items = checklist(snap);
    if (!canSubmit({ state: info.state, items, ticked: Array.from(ticked), hasPhoto: !!draft, sending })) {
      // 走到這裡代表按鈕沒 disable 好；還是擋一次，別讓小孩以為送出去了
      setNote(draft ? '三件事要先全部勾起來' : '要拍一張照片才能送出喔');
      return;
    }

    sending = true;
    setMsg('');
    paint();

    let res;
    try {
      res = await Api.post('request', {
        kind: 'allowance_claim',
        clientId: draft.clientId,
        photo: draft.base64,
        photoMime: 'image/jpeg',
        // checks 是照伺服器給的順序排的布林陣列；伺服器會自己再驗一次「每一項都勾到」
        checks: items.map(i => ticked.has(i)),
        note: ''
      });
    } catch (err) {
      console.warn('allowance_claim failed', err);
      res = { ok: false, error: 'network' };
    }
    sending = false;

    if (res && res.ok) {
      draft = null;
      ticked.clear();
      setMsg(`送出了！等${Chores.title(approver(snap))}確認`, 'info');
      await refresh();
      return;
    }

    const error = res && res.error;
    // 已經領過是永久性失敗：不要重試，直接把畫面切成今天的現況
    if (error === 'already-claimed' || error === 'already-requested' || error === 'already-reported') {
      draft = null;
      setMsg(errorMessage(error, res.message));
      await refresh();
      return;
    }
    // unauthorized 由 api.js 清 session 並導回登入頁，這裡只留一句話
    if (error === 'unauthorized') { setMsg(errorMessage(error, res.message)); return; }
    // 照片本身有問題：草稿留著沒用，請小孩重拍
    if (error === 'photo-required' || error === 'photo-too-big') draft = null;

    paint();
    setMsg(errorMessage(error, res && res.message));
  }

  // ---------- 取資料與進出頁 ----------

  async function refresh() {
    let res = null;
    try { res = await Api.get('snapshot'); } catch (err) { console.warn('snapshot failed', err); }
    if (res && res.ok) {
      snapshot = res;
    } else if (res && res.error && res.error !== 'unauthorized' && !snapshot) {
      setMsg(errorMessage(res.error, res.message));
    }
    paint();
  }

  // 首頁的入口按鈕：貼在活期帳戶卡上，因為零用錢就是進那個帳戶
  function homeButton(snap) {
    if (snap) snapshot = snap;
    const st = homeLabel(snap, new Date());
    return `
      <button class="big-btn big-btn-${st.state}" id="btn-allowance">
        <span class="big-btn-icon">🎁</span>
        <span class="big-btn-body">
          <span class="big-btn-title">每日零用錢</span>
          <span class="big-btn-sub">${esc(st.label)}</span>
        </span>
      </button>`;
  }

  function open() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-allowance').classList.remove('hidden');
    window.scrollTo(0, 0);
    setMsg('');
    paint();
    refresh();
  }

  function back() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-home').classList.remove('hidden');
    window.scrollTo(0, 0);
    Home.render();
  }

  // 卡片是 innerHTML 重畫的，所以事件一律委派
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const hit = sel => e.target.closest && e.target.closest(sel);

      if (hit('#btn-allowance')) return open();
      if (hit('#btn-allowance-back')) return back();

      const tick = hit('[data-tick]');
      if (tick) {
        if (sending) return;
        const item = tick.dataset.tick;
        if (ticked.has(item)) ticked.delete(item); else ticked.add(item);
        setMsg('');
        paint();
        return;
      }

      if (hit('#btn-allow-shoot')) return openCamera();
      if (hit('#btn-allow-retake')) {
        if (sending) return;
        draft = null;
        paint();
        return openCamera();
      }
      if (hit('#btn-allow-send')) return submit();
    });

    // session 過期時 login.js 只認得 pick/pw/home 三個 view，這頁得自己收尾：
    // 照片草稿不該留在裝置上，勾選狀態也不該給下一個登入的人看到。
    window.addEventListener('hb-unauthorized', () => {
      draft = null;
      ticked.clear();
      snapshot = null;
      sending = false;
      el('view-allowance').classList.add('hidden');
    });

    const input = el('allowance-photo-input');
    if (input) {
      input.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        onPhotoChosen(file);
      });
    }
  }

  return {
    render: refresh, open, homeButton,
    // 純函式，給測試用
    checklist, claimState, allChecked, progressHint, canShoot, canSubmit,
    homeLabel, approvedLine, errorMessage, DEFAULT_CHECKLIST
  };
})();
