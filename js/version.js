// Footer 版本號：抓 GitHub 最新 commit hash（純前端，無 build step）
(async () => {
  const REPO = 'AugustChaoTW/HappyBank';
  const CACHE_KEY = 'happybank-version-cache';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const el = document.getElementById('version-info');
  if (!el) return;

  function render(sha, dateStr) {
    el.innerHTML = `<a href="https://github.com/${REPO}/commit/${sha}" target="_blank" rel="noopener">${sha.slice(0, 7)}</a>${dateStr ? ` · ${dateStr}` : ''}`;
  }

  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return render(cached.sha, cached.date);

    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const sha = data.sha;
    const date = new Date(data.commit.author.date)
      .toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ sha, date, ts: Date.now() }));
    render(sha, date);
  } catch (err) {
    console.warn('version fetch failed', err);
    el.textContent = '版本資訊暫時無法載入';
  }
})();
