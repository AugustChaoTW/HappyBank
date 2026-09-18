// 家事回報頁（小孩端，SPEC §6 chores、§7.2、§9.5）。
// 一件家事一張卡，四種狀態：可回報 / 等待確認 / 已確認 / 被退回。
// 核心規則：沒有照片不能送出（UI disable，伺服器再擋一次 photo-required）。
const Chores = (() => {
  const TZ = 'Asia/Taipei';
  const el = id => document.getElementById(id);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 小孩讀的是「媽媽」不是 userId（SPEC §9.5 五）。名單很短又不常變，
  // 寫死在這裡比為了兩個字多打一趟 API 划算；認不得就退回中性稱呼。
  const PARENT_TITLE = { vicky: '媽媽', aug: '爸爸' };
  const DEFAULT_APPROVER = 'vicky';
  const title = id => PARENT_TITLE[String(id || '').toLowerCase()] || '爸爸媽媽';

  // 一次一張卡的暫存草稿：{ choreId: { base64, dataUrl, clientId } }
  // clientId 在拍完照就生出來並跟著草稿走，重送同一張照片才認得出是同一筆（§7.3、§7.5）
  const drafts = {};
  const photoCache = new Map();   // requestId → dataUrl | 'error'；只在記憶體，不進 localStorage（§7.6）
  let snapshot = null;
  let sendingId = null;
  let photoTarget = null;         // 正在等相機回來的 choreId

  // ---------- 純函式：期間與狀態（可單元測試） ----------

  function ymd(d) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  }

  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // 週界線＝台北時間週日 00:00（與零用錢發放日對齊，§7.2）。
  // 不用 yyyy-'W'ww：各 locale 的週起始日不同，算出來會對不起來。
  function sundayYmd(d) {
    const parts = ymd(d).split('-').map(Number);
    const wd = WEEKDAY[new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)] || 0;
    const t = Date.UTC(parts[0], parts[1] - 1, parts[2] - wd);
    return new Date(t).toISOString().slice(0, 10);
  }

  // 同一個 key＝同一個「一天一次」的期間。伺服器用 requests.ts 算，前端照抄同一條規則，
  // 只是為了不讓小孩白做工；真正的把關在伺服器（§7.2-5）。
  function periodKey(repeat, when) {
    if (repeat === 'once') return 'once';
    const d = when instanceof Date ? when : new Date(when);
    if (isNaN(d.getTime())) return 'invalid';
    return repeat === 'weekly' ? 'w:' + sundayYmd(d) : 'd:' + ymd(d);
  }

  const tsOf = r => (r && r.ts ? Date.parse(r.ts) : NaN) || 0;

  // 「今天是哪一天」以伺服器為準（snapshot.today，§7.1）。
  // 小孩的平板時鐘會跑掉——電池沒電歸零、自己手動調時間、時區設成別國——
  // 而 requests.ts 是伺服器寫的絕對時間，用裝置的「現在」去切日界線就會兩邊各講各的：
  // 卡片畫成「可回報」，他拍完照送出才被 already-reported 打回來。
  // 只有「現在」不可信；r.ts 一律照 periodKey 用台北時區換算，那個不受裝置時鐘影響。
  function serverToday(snap) {
    const t = snap && snap.today;
    return (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t)) ? t : null;
  }

  // 「現在」落在哪個期間。舊的離線快照沒有 today，就退回裝置時鐘算——
  // 離線時畫面寧可有點舊，也不要整頁空白。
  function currentPeriodKey(repeat, now, snap) {
    const day = serverToday(snap);
    if (!day) return periodKey(repeat, now);
    if (repeat === 'once') return 'once';
    if (repeat !== 'weekly') return 'd:' + day;
    // 週界線要從伺服器那天往回推到週日；挑中午換算，免得在日界線上被四捨五入掉一天
    return 'w:' + sundayYmd(new Date(day + 'T12:00:00+08:00'));
  }

  // 一件家事 + 這個人的 requests → 四種狀態之一。
  // rejected / cancelled 不佔扣打，所以「被退回」仍然可以重報（§9.5 二）。
  function deriveState(chore, requests, now, snap) {
    const when = now || new Date();
    const key = currentPeriodKey(chore.repeat, when, snap);
    const mine = (requests || []).filter(r =>
      r && r.kind === 'chore_done' &&
      String(r.choreId) === String(chore.id) &&
      // r.ts 是伺服器寫的絕對時間，照台北時區換算不受裝置時鐘影響；
      // 沒有 ts 的（理論上不該有）就當成「這個期間內的」，不要憑裝置時間亂歸日
      (r.ts ? periodKey(chore.repeat, r.ts) === key : true));

    const latest = status => mine
      .filter(r => r.status === status)
      .sort((a, b) => tsOf(b) - tsOf(a))[0] || null;

    const pending = latest('pending');
    if (pending) return { state: 'pending', request: pending };
    const approved = latest('approved');
    if (approved) return { state: 'approved', request: approved };
    const rejected = latest('rejected');
    if (rejected) return { state: 'rejected', request: rejected };
    return { state: 'available', request: null };
  }

  // 今天還能賺的件數（被退回的也算——可以重報）
  function availableCount(chores, requests, now, repeat, snap) {
    return (chores || [])
      .filter(c => c && c.active !== false && (!repeat || (c.repeat || 'daily') === repeat))
      .filter(c => {
        const s = deriveState(c, requests, now, snap).state;
        return s === 'available' || s === 'rejected';
      }).length;
  }

  // 「等確認中 ＋20 元」用
  function pendingReward(chores, requests, now, snap) {
    return (chores || []).reduce((sum, c) =>
      sum + (deriveState(c, requests, now, snap).state === 'pending' ? (Number(c.reward) || 0) : 0), 0);
  }

  // 首頁那顆「🧹 每日家事」大按鈕要寫的字。小孩不點進來也要知道今天還有沒有事做，
  // 所以三種狀態各一句：還能做的優先講（那是他今天還能賺的錢），其次等確認，最後才是做完了。
  function homeButtonState(chores, requests, now, snap) {
    const daily = (chores || []).filter(c => c && c.active !== false && (c.repeat || 'daily') !== 'weekly');
    if (!daily.length) return { state: 'none', count: 0, label: '還沒有家事清單' };
    const when = now || new Date();
    const n = availableCount(daily, requests, when, 'daily', snap);
    if (n > 0) return { state: 'available', count: n, label: `還有 ${n} 件可以做 →` };
    const waiting = daily.filter(c => deriveState(c, requests, when, snap).state === 'pending').length;
    if (waiting > 0) return { state: 'pending', count: waiting, label: `⏳ ${waiting} 件等確認` };
    return { state: 'approved', count: 0, label: '✅ 今天都做完了' };
  }

  // 伺服器錯誤碼 → 小孩看得懂的話（SPEC §7.4）
  function errorMessage(error, message, repeat) {
    const period = repeat === 'weekly' ? '這週' : '今天';
    switch (error) {
      case 'photo-required': return '要拍一張照片才能送出喔';
      case 'photo-too-big': return '照片太大了，重拍一張比較近的再送一次';
      case 'already-reported': return `${period}這件已經回報過了`;
      case 'busy': return '銀行現在有點忙，等幾秒再按一次送出';
      case 'unauthorized': return '登入過期了，請重新登入';
      // 後端還沒做這個 action（M6 進行中）——好好講，不要讓畫面壞掉
      case 'unknown-action':
      case 'no-backend': return '家事回報還沒開通，等大人把銀行蓋好再來';
      default: return message || '送不出去，等一下再試一次';
    }
  }

  // 「9/18 晚上 9:14」——小孩讀得懂的寫法，不是 ISO 字串（§9.5 五）
  function friendlyTs(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    const p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    const h = Number(p.hour) % 24;
    const part = h < 6 ? '凌晨' : h < 12 ? '早上' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${Number(p.month)}/${Number(p.day)} ${part} ${h12}:${p.minute}`;
  }

  // ---------- 畫面 ----------

  // 「怎麼樣才算做完」——家長在 chores.description 寫一次的標準（§9.5）。
  // 小孩不知道標準就只能猜，猜錯被退回，學到的是「這系統很任性」。
  // 空的（家長還沒打）就整行不畫：寧可沒有，也不要留一個空框或一個孤單的破折號。
  // 家長打進 Sheet 的自由文字會直接進 innerHTML，所以一定要 esc()。
  function descriptionHtml(chore) {
    const text = String((chore && chore.description) || '').trim();
    if (!text) return '';
    return `<p class="chore-desc">${esc(text)}</p>`;
  }

  function choreCard(chore, info) {
    const reward = `+${Money.format(chore.reward)} 元`;
    const id = esc(chore.id);
    const head = `
      <div class="chore-top">
        <span class="chore-icon">${esc(chore.icon || '🧹')}</span>
        <span class="chore-title">${esc(chore.title)}</span>
        <span class="chore-reward">${esc(reward)}</span>
      </div>`;

    return `<div class="chore chore-${info.state}" data-chore="${id}">
      ${head}
      ${descriptionHtml(chore)}
      ${bodyFor(chore, info)}
    </div>`;
  }

  function thumb(request) {
    if (!request || !request.photoFileId) return '';
    const cached = photoCache.get(request.id);
    if (cached === 'error') return '<div class="chore-thumb bad">照片讀不到</div>';
    if (cached) return `<img class="chore-thumb" src="${esc(cached)}" alt="家事照片">`;
    // 先佔位＋spinner，照片另外一趟往返再補上（§7.6）
    return `<div class="chore-thumb loading" data-photo="${esc(request.id)}"><span class="spin"></span></div>`;
  }

  function bodyFor(chore, info) {
    const id = esc(chore.id);
    const draft = drafts[chore.id];
    const weekly = chore.repeat === 'weekly';

    if (info.state === 'pending') {
      return `<div class="chore-state wait">
        ${thumb(info.request)}
        <div><p class="state-line">⏳ 等${title(snapApprover())}確認</p>
        <p class="state-sub">${weekly ? '這週' : '今天'}已回報 · ${esc(friendlyTs(info.request.ts))} 送出</p></div>
      </div>`;
    }

    if (info.state === 'approved') {
      const r = info.request;
      const who = r.decidedProxy
        ? `${title(r.decidedBy)}代替${title(snapApprover())}`
        : title(r.decidedBy || snapApprover());
      return `<div class="chore-state done">
        ${thumb(r)}
        <div><p class="state-line">✅ ${esc(who)}在 ${esc(friendlyTs(r.decidedTs))} 確認 ＋${Money.format(chore.reward)} 元</p>
        <p class="state-sub">${weekly ? '這週' : '今天'}這件做完了</p></div>
      </div>`;
    }

    // 被退回：把理由原文放出來，小孩要知道為什麼（§9.4）
    const rejected = info.state === 'rejected'
      ? `<p class="chore-reject">❌ 退回：${esc((info.request && info.request.decidedNote) || '沒有寫理由')}</p>`
      : '';

    if (draft) {
      const sending = sendingId === chore.id;
      return `${rejected}
        <div class="chore-draft">
          <img class="chore-thumb" src="${esc(draft.dataUrl)}" alt="剛拍的照片">
          <div class="draft-actions">
            <button class="btn-primary btn-send" data-send="${id}" ${sending ? 'disabled' : ''}>
              ${sending ? '送出中…' : '送出 ✔'}
            </button>
            <button class="btn-text btn-retake" data-retake="${id}" ${sending ? 'disabled' : ''}>重拍</button>
          </div>
          ${sending ? '<p class="chore-progress">照片有點大，正在寄給銀行…不要按第二次</p>' : ''}
          <p class="chore-note" data-note="${id}"></p>
        </div>`;
    }

    return `${rejected}
      <button class="btn-primary btn-shoot" data-shoot="${id}">我做完了 📷</button>
      <p class="chore-note" data-note="${id}"></p>`;
  }

  function snapApprover() {
    return (snapshot && snapshot.chore_approver) || DEFAULT_APPROVER;
  }

  function section(label, list, requests, now, emptyText, snap) {
    if (!list.length) return `<h3 class="sec-title">${esc(label)}</h3><p class="empty">${esc(emptyText)}</p>`;
    const cards = list.map(c => choreCard(c, deriveState(c, requests, now, snap))).join('');
    return `<h3 class="sec-title">${esc(label)}</h3><div class="chores">${cards}</div>`;
  }

  function paint() {
    const snap = snapshot || {};
    const now = new Date();
    const chores = (snap.chores || []).filter(c => c && c.active !== false);
    const requests = snap.requests || [];

    const daily = chores.filter(c => (c.repeat || 'daily') !== 'weekly');
    const weekly = chores.filter(c => c.repeat === 'weekly');

    const doneToday = chores.filter(c => deriveState(c, requests, now, snap).state === 'pending').length;
    const waiting = pendingReward(chores, requests, now, snap);
    el('chores-summary').textContent = doneToday
      ? `今天已回報 ${doneToday} 件，等確認中 ＋${Money.format(waiting)} 元`
      : (chores.length ? '挑一件做，拍張照就能賺錢' : '');

    el('chores-body').innerHTML = chores.length
      ? section('今天可以做', daily, requests, now, '今天沒有安排家事', snap) +
        (weekly.length ? section('這週可以做', weekly, requests, now, '', snap) : '')
      : '<p class="empty">還沒有任何家事，問問爸爸媽媽。</p>';

    const when = Money.formatWhen(snap.serverTs);
    el('chores-fresh').textContent = when ? `更新於 ${when}` : '';

    loadThumbs();
  }

  function setMsg(text, kind) {
    const node = el('chores-msg');
    node.textContent = text || '';
    node.className = 'msg ' + (kind || 'error');
    node.classList.toggle('hidden', !text);
  }

  function setNote(choreId, text) {
    const node = document.querySelector(`[data-note="${CSS.escape(String(choreId))}"]`);
    if (node) node.textContent = text || '';
  }

  // ---------- 照片縮圖（延遲、序列、記憶體快取） ----------
  // 一張照片＝一趟 Apps Script 往返，實測 1～2 秒，所以一張一張來，
  // 失敗就顯示「照片讀不到」，不重試、也不讓整張卡片消失（§7.6）。
  let loadingThumbs = false;
  async function loadThumbs() {
    if (loadingThumbs) return;
    loadingThumbs = true;
    try {
      let box;
      while ((box = document.querySelector('#view-chores .chore-thumb.loading[data-photo]'))) {
        const requestId = box.dataset.photo;
        box.removeAttribute('data-photo');   // 避免同一張抓兩次
        let res = null;
        try { res = await Api.get('chore_photo', { requestId }); } catch { res = null; }
        if (res && res.ok && res.data) {
          photoCache.set(requestId, 'data:image/jpeg;base64,' + res.data);
        } else {
          photoCache.set(requestId, 'error');
        }
        const dataUrl = photoCache.get(requestId);
        if (!box.isConnected) continue;
        if (dataUrl === 'error') {
          box.className = 'chore-thumb bad';
          box.textContent = '照片讀不到';
        } else {
          const img = new Image();
          img.className = 'chore-thumb';
          img.alt = '家事照片';
          img.src = dataUrl;
          box.replaceWith(img);
        }
      }
    } finally {
      loadingThumbs = false;
    }
  }

  // ---------- 拍照與送出 ----------

  function openCamera(choreId) {
    photoTarget = choreId;
    setMsg('');
    const input = el('chore-photo-input');
    input.value = '';      // 同一張照片連拍兩次也要觸發 change
    input.click();
  }

  async function onPhotoChosen(file) {
    const choreId = photoTarget;
    photoTarget = null;
    if (!choreId || !file) return;

    setNote(choreId, '照片處理中…');
    let out;
    try {
      out = await Photo.compress(file);
    } catch (err) {
      // 壓縮失敗一律請小孩重拍，不 fallback 送原圖（§7.5）
      console.warn('compress failed', err);
      setMsg('這張照片讀不出來，麻煩重拍一張（用相機拍，不要選很舊的檔案）');
      setNote(choreId, '');
      return;
    }

    drafts[choreId] = {
      base64: out.base64,
      dataUrl: out.dataUrl,
      bytes: out.bytes,
      clientId: newClientId()
    };
    setMsg('');
    paint();
  }

  function newClientId() {
    // 冪等鍵（§7.3）。舊瀏覽器沒有 randomUUID 就退回時間＋亂數，一樣夠唯一。
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().toLowerCase();
    return ('hb-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10)).toLowerCase();
  }

  async function submit(chore) {
    const draft = drafts[chore.id];
    if (!draft || !draft.base64) {
      // 走到這裡代表按鈕沒 disable 好；還是擋一次，別讓小孩以為送出去了
      setNote(chore.id, '要拍一張照片才能送出喔');
      return;
    }
    if (sendingId) return;

    sendingId = chore.id;
    setMsg('');
    paint();

    let res;
    try {
      res = await Api.post('request', {
        kind: 'chore_done',
        choreId: chore.id,
        clientId: draft.clientId,
        photo: draft.base64,
        photoMime: 'image/jpeg',
        note: ''
      });
    } catch (err) {
      console.warn('chore_done failed', err);
      res = { ok: false, error: 'network' };
    }
    sendingId = null;

    if (res && res.ok) {
      delete drafts[chore.id];
      setMsg(`送出了！等${title(snapApprover())}確認`, 'info');
      await refresh();
      return;
    }

    const error = res && res.error;
    // already-reported 是永久性失敗：不要重試，直接把卡片切成「已回報」的現況
    if (error === 'already-reported') {
      delete drafts[chore.id];
      setMsg(errorMessage(error, res.message, chore.repeat));
      await refresh();
      return;
    }
    // unauthorized 由 api.js 清 session 並導回登入頁，這裡只留一句話
    if (error === 'unauthorized') { setMsg(errorMessage(error, res.message, chore.repeat)); return; }
    // photo-required / photo-too-big：草稿留著沒用，請小孩重拍
    if (error === 'photo-required' || error === 'photo-too-big') delete drafts[chore.id];

    paint();
    setMsg(error === 'network'
      ? '現在連不上銀行，等有網路再回報一次（會算在送出那天）'
      : errorMessage(error, res && res.message, chore.repeat));
  }

  function choreById(id) {
    return ((snapshot && snapshot.chores) || []).find(c => String(c.id) === String(id));
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

  // 首頁的入口按鈕。貼在「活期帳戶」卡上，因為家事賺的錢就是進那個帳戶——
  // 位置本身就是因果關係的說明。home.js 只呼叫這一支，順手把最新快照接過來，
  // 進家事頁就不必再等一趟 snapshot 才有畫面。
  function homeButton(snap) {
    if (snap) snapshot = snap;
    const st = homeButtonState((snap && snap.chores) || [], (snap && snap.requests) || [], new Date(), snap);
    return `
      <button class="big-btn big-btn-${st.state}" id="btn-chores">
        <span class="big-btn-icon">🧹</span>
        <span class="big-btn-body">
          <span class="big-btn-title">每日家事</span>
          <span class="big-btn-sub">${esc(st.label)}</span>
        </span>
      </button>`;
  }

  function open() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    el('view-chores').classList.remove('hidden');
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

  // 卡片是 innerHTML 重畫的，所以事件一律委派到固定的容器上
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const nav = e.target.closest && e.target.closest('#btn-chores');
      if (nav) return open();
      const back0 = e.target.closest && e.target.closest('#btn-chores-back');
      if (back0) return back();

      const shoot = e.target.closest && e.target.closest('[data-shoot]');
      if (shoot) return openCamera(shoot.dataset.shoot);

      const retake = e.target.closest && e.target.closest('[data-retake]');
      if (retake) {
        if (sendingId) return;
        delete drafts[retake.dataset.retake];
        paint();
        return openCamera(retake.dataset.retake);
      }

      const send = e.target.closest && e.target.closest('[data-send]');
      if (send) {
        const chore = choreById(send.dataset.send);
        if (chore) submit(chore);
      }
    });

    // session 過期時 login.js 只認得 pick/pw/home 三個 view，會把家事頁留在畫面上。
    // 這裡自己收尾：清掉草稿與照片快取（照片不該留在裝置上），把家事頁藏起來。
    window.addEventListener('hb-unauthorized', () => {
      Object.keys(drafts).forEach(k => delete drafts[k]);
      photoCache.clear();
      snapshot = null;
      sendingId = null;
      el('view-chores').classList.add('hidden');
    });

    const input = el('chore-photo-input');
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
    // 純函式，給測試與其他頁用（零用錢頁沿用 periodKey／friendlyTs／title，兩邊的日界線與稱呼才會一致）
    deriveState, periodKey, currentPeriodKey, availableCount, pendingReward, errorMessage,
    friendlyTs, homeButtonState, title, descriptionHtml
  };
})();
