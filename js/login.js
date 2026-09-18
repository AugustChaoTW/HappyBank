// 登入頁流程：選頭像 → 輸密碼 → 進首頁
(() => {
  const DIGITS = CONFIG.kidPasswordDigits || 8;

  const views = ['pick', 'pw', 'home'];
  const el = id => document.getElementById(id);

  const kidsRow = el('avatar-kids');
  const parentsRow = el('avatar-parents');
  const dotsWrap = el('dots');
  const msgKid = el('msg-kid');
  const msgParent = el('msg-parent');
  const msgPick = el('msg-pick');
  const pwInput = el('pw-input');

  let current = null;   // 目前選到的 user
  let entered = '';     // 小孩輸入中的數字
  let busy = false;

  function show(view) {
    views.forEach(v => el('view-' + v).classList.toggle('hidden', v !== view));
    window.scrollTo(0, 0);
  }

  // --- 步驟一：頭像 ---
  // 小孩一排、家長一排
  function renderAvatars(users) {
    kidsRow.innerHTML = '';
    parentsRow.innerHTML = '';
    users.forEach(u => {
      const isParent = u.role === 'parent';
      const btn = document.createElement('button');
      btn.className = 'avatar-btn';
      btn.innerHTML = `
        <span class="face">${u.emoji}</span>
        <span class="name">${u.displayName}</span>
        <span class="role">${isParent ? '家長' : '小小存款人'}</span>`;
      btn.addEventListener('click', () => pickUser(u));
      (isParent ? parentsRow : kidsRow).appendChild(btn);
    });
  }

  // 有後端就用伺服器名單，沒有就用 config.js 的 fallback
  async function loadUsers() {
    renderAvatars(CONFIG.users);
    if (!Api.configured()) return;
    try {
      const res = await Api.get('users');
      if (res.ok && res.users && res.users.length) renderAvatars(res.users);
    } catch (err) {
      console.warn('users fetch failed, 用 config.js 名單', err);
    }
  }

  function setPickMsg(text) {
    msgPick.textContent = text || '';
    msgPick.classList.toggle('hidden', !text);
  }

  function pickUser(u) {
    setPickMsg('');
    current = u;
    entered = '';
    el('pw-face').textContent = u.emoji;
    el('pw-name').textContent = u.displayName;

    const isKid = u.role !== 'parent';
    el('pw-kid').classList.toggle('hidden', !isKid);
    el('pw-parent').classList.toggle('hidden', isKid);

    if (isKid) {
      renderDots();
      setMsg(msgKid, `輸入你的 ${DIGITS} 個數字密碼`, 'info');
    } else {
      pwInput.value = '';
      pwInput.type = 'password';
      setMsg(msgParent, '請輸入家長密碼', 'info');
      setTimeout(() => pwInput.focus(), 120);
    }
    show('pw');
  }

  // --- 步驟二：小孩數字鍵盤 ---
  function renderDots() {
    dotsWrap.innerHTML = '';
    for (let i = 0; i < DIGITS; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < entered.length ? ' filled' : '');
      dotsWrap.appendChild(d);
    }
  }

  function press(k) {
    if (busy) return;
    if (k === 'back') entered = entered.slice(0, -1);
    else if (k === 'clear') entered = '';
    else if (entered.length < DIGITS) entered += k;
    renderDots();

    if (entered.length === DIGITS) submit(entered, msgKid);
    else setMsg(msgKid, `還要 ${DIGITS - entered.length} 個數字`, 'info');
  }

  document.querySelectorAll('.key').forEach(btn => {
    btn.addEventListener('click', () => press(btn.dataset.k));
  });

  // 實體鍵盤也能打，方便桌機測試
  document.addEventListener('keydown', e => {
    if (el('view-pw').classList.contains('hidden')) return;
    if (!current || current.role === 'parent') return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
  });

  // --- 步驟二：家長密碼 ---
  el('btn-reveal').addEventListener('click', () => {
    pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
  });
  el('btn-login').addEventListener('click', () => {
    submit(pwInput.value, msgParent);
  });
  pwInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit(pwInput.value, msgParent);
  });

  // --- 送出 ---
  function setMsg(node, text, kind) {
    node.textContent = text;
    node.className = 'msg ' + (kind || 'info');
  }

  function fail(node, text) {
    setMsg(node, text, 'error');
    const target = current.role === 'parent' ? el('pw-parent') : dotsWrap;
    target.classList.remove('shake');
    void target.offsetWidth; // 強制重排，讓動畫可以重播
    target.classList.add('shake');
    entered = '';
    renderDots();
    if (current.role === 'parent') pwInput.value = '';
  }

  async function submit(password, node) {
    if (busy || !password) return;
    if (current.role !== 'parent' && !new RegExp(`^\\d{${DIGITS}}$`).test(password)) {
      return fail(node, `密碼要剛好 ${DIGITS} 個數字`);
    }
    if (current.role === 'parent' && password.length < 8) {
      return fail(node, '密碼至少 8 個字元');
    }

    busy = true;
    setMsg(node, '登入中…', 'info');
    const res = await Auth.login(current.userId, password);
    busy = false;

    if (res.ok) return enterHome(res.user);

    // 伺服器搶不到 script lock：這不是密碼錯，別讓小孩以為自己打錯，所以不抖動
    if (res.error === 'busy') {
      entered = '';
      renderDots();
      if (current.role === 'parent') pwInput.value = '';
      return setMsg(node, res.message || '銀行現在有點忙，等一下再試一次。', 'error');
    }

    // 訊息一律不區分「帳號不存在」與「密碼錯誤」（SPEC §7.0）
    const text = res.error === 'no-backend'
      ? '後端還沒部署，登入功能等 M1 上線。'
      : (res.message || '帳號或密碼不對，再試一次。');
    fail(node, text);
  }

  function enterHome(user) {
    show('home');
    Home.render(user);
  }

  el('btn-switch').addEventListener('click', () => {
    setPickMsg('');
    current = null; entered = '';
    show('pick');
  });

  // session 過期或被家長踢掉：api.js 清掉 session 後發這個事件，這裡只負責把人帶回選頭像。
  // 處理過程不打任何 API，所以就算是登入途中發生也不會再觸發自己（登入本身也不帶 session）。
  window.addEventListener('hb-unauthorized', e => {
    busy = false;
    current = null;
    entered = '';
    renderDots();
    pwInput.value = '';
    pwInput.type = 'password';
    show('pick');
    setPickMsg((e.detail && e.detail.message) || '登入過期了，請重新登入。');
  });

  el('btn-logout').addEventListener('click', async () => {
    await Auth.logout();
    setPickMsg('');
    current = null; entered = '';
    show('pick');
  });

  // --- 啟動：已登入就直接進首頁 ---
  const existing = Auth.user();
  if (existing) enterHome(existing);
  else show('pick');
  loadUsers();
})();
