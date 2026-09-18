// 注音（ㄅㄆㄇㄈ）顯示模式：小孩看不懂的字，旁邊自動標注音。
//
// 做法：載入開源的「粉圓注音體 Bpmf Huninn」。這支字型把注音直接畫進每個漢字的字身裡
// （注音在字的右側），所以不需要我們一個字串一個字串去標——家長自己打的家事名稱、
// 退件理由這種動態文字也一併有注音。
//
// 兩個必須誠實講清楚的限制：
//   1. 字型只能為每個字挑「一個」讀音，多音字一定會有標錯的時候。
//      「掃地」的「掃」、「倒垃圾」的「倒」就是經典的坑。
//      這是識字的輔助工具，不是正確讀音的權威；小孩念錯時大人要能糾正。
//   2. 它只對漢字有用。介面上的數字、金額、emoji 完全不受惠
//      （css/zhuyin.css 也刻意把數字留給系統字型，不讓注音體去畫「1,240 元」）。
//
// 另外：字型本身很大（整包 1.4MB；就算用 fontsource 的 subset 切片，
// 一個典型的小孩畫面還是會抓 12 片 ≈ 640KB）。所以字型 CSS 是「按下開關才載入」，
// 沒開的人一個 byte 都不會付。
const Zhuyin = (() => {
  const PREFIX = 'happybank-zhuyin:';
  const BODY_CLASS = 'zhuyin';

  // fontsource 的 index.css（= 400.css）才是切成 106 片、帶 unicode-range 的版本；
  // chinese-traditional.css 是沒切片的單一 1.4MB 檔，不要用那個。
  const FONT_CSS = 'https://cdn.jsdelivr.net/npm/@fontsource/bpmf-huninn@5.3.0/index.css';
  const FONT_LINK_ID = 'zhuyin-font-css';

  const hasDoc = () => typeof document !== 'undefined' && !!document;

  // localStorage 在無痕模式、或使用者關掉網站資料時，連讀都會丟例外。
  // 一律包起來：拿不到就當「沒開過」，不要讓一個設定把整個畫面弄壞。
  function store() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch { return null; }
  }

  // 登入時 userId 會轉小寫（auth.js），這裡跟著轉，設定才不會因為大小寫走丟
  function keyFor(userId) {
    const id = userId == null ? '' : String(userId).trim().toLowerCase();
    return id ? PREFIX + id : null;
  }

  // 純函式：目前狀態 → 按一下之後的狀態。髒值（storage 被手動改過）一律收斂成布林。
  function nextState(current) {
    return !current;
  }

  function isOn(userId) {
    const key = keyFor(userId);
    if (!key) return false;          // 沒身分就不記，免得存成一份大家共用的
    const s = store();
    if (!s) return false;
    try {
      return s.getItem(key) === '1'; // 只認我們自己寫進去的 '1'，其他一律當關著
    } catch { return false; }
  }

  function set(userId, on) {
    const key = keyFor(userId);
    if (!key) return false;
    const value = !!on;
    const s = store();
    if (s) {
      try { s.setItem(key, value ? '1' : '0'); } catch { /* 無痕模式存不進去就算了 */ }
    }
    return value;
  }

  function toggle(userId) {
    if (!keyFor(userId)) return false;
    return set(userId, nextState(isOn(userId)));
  }

  // 字型 CSS 只在第一次真的要用的時候才插進 <head>：
  // 沒開注音的人（包含家長）不會為了這個功能多下載任何東西。
  // 連不到 CDN 也沒關係——css/zhuyin.css 的 font-family 後面還有整串系統字型，
  // 加上 fontsource 本來就是 font-display: swap，字最多就是維持系統字型的樣子。
  function ensureFont() {
    if (!hasDoc()) return;
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = FONT_CSS;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  // 只有小孩端要注音。家長審核頁滿滿是金額與時間，標注音只是噪音。
  function isKid(user) {
    return !!user && user.role !== 'parent';
  }

  function currentUser() {
    try {
      return (typeof Auth !== 'undefined' && Auth && Auth.user) ? Auth.user() : null;
    } catch { return null; }
  }

  // 把開關狀態反映到畫面上：body 加 class（css/zhuyin.css 只在這個 class 底下生效），
  // 並把每顆 ㄅㄆㄇ 按鈕的 aria-pressed 同步好，讓它看起來真的像個「按下去會亮」的開關。
  function apply(userId) {
    if (!hasDoc()) return false;
    const on = isOn(userId);
    if (on) ensureFont();
    if (document.body) document.body.classList.toggle(BODY_CLASS, on);
    paintButtons(on, !!keyFor(userId));
    return on;
  }

  function paintButtons(on, visible) {
    if (!hasDoc()) return;
    document.querySelectorAll('.btn-zhuyin').forEach(btn => {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? '關掉注音' : '打開注音');
      btn.title = on ? '關掉注音' : '打開注音';
      btn.hidden = !visible;
    });
  }

  // 依「現在登入的是誰」重新套用。登入／登出／換人都走這裡。
  function sync() {
    if (!hasDoc()) return false;
    const user = currentUser();
    if (!isKid(user)) {            // 沒登入或家長：一定不套用，按鈕也收起來
      if (document.body) document.body.classList.remove(BODY_CLASS);
      paintButtons(false, false);
      return false;
    }
    return apply(user.userId);
  }

  if (typeof document !== 'undefined') {
    // 按鈕是靜態寫在 index.html 的，但委派到 document 上最省事，
    // 之後誰把它搬進重繪的卡片裡也不會壞掉。
    document.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('.btn-zhuyin');
      if (!btn) return;
      const user = currentUser();
      if (!isKid(user)) return sync();   // 家長／沒登入：順手把按鈕收回去
      toggle(user.userId);
      apply(user.userId);
    });

    // 誰登入、誰登出是 login.js 在管的，而它不會通知我們。
    // 與其去改別人的檔案，不如盯著「哪個 .view 目前沒有 hidden」——
    // 切頁一定會動到 class，這是最便宜又不侵入的掛勾點。
    const watch = () => {
      sync();
      if (typeof MutationObserver === 'undefined') return;
      const obs = new MutationObserver(() => sync());
      document.querySelectorAll('.view').forEach(v => {
        obs.observe(v, { attributes: true, attributeFilter: ['class'] });
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', watch);
    } else {
      watch();
    }

    // session 過期被踢回選頭像時也要把注音收掉（api.js 會發這個事件）
    if (typeof window !== 'undefined') {
      window.addEventListener('hb-unauthorized', () => sync());
    }
  }

  return { isOn, set, toggle, apply, sync, nextState };
})();
