# 開發現況

最後更新：2026-09-18 · commit 數 35 · 測試 337/337 綠

## 一句話

小孩每天簽到／回報家事 → 拍照 → 媽媽確認 → 錢進活期。這條主線已經完整可用；
定存、儲蓄目標、提領、利息結算都還只有規格，沒有程式。

## 線上位置

| | |
|---|---|
| 網站 | https://augustchaotw.github.io/HappyBank/ （GitHub Pages，push 即自動更新） |
| Repo | https://github.com/AugustChaoTW/HappyBank （public） |
| 資料庫 | Google Sheet `1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo`（**不要分享給任何人**，見 SPEC §8.1） |
| 後端 | Apps Script Web App，**部署版本 v2（09-18 12:13）** |

## ⚠️ 線上落後於 repo

`apps-script/` 在 v2 之後有三個 commit 還沒部署：

- `5f86d26` 家事做法說明（`chores` 多一欄 `description`）
- `4ea8cf4` 待審清單支援每日零用錢（家長快照 `kids[].dailyAllowance`）
- `2303f0c` 伺服器判定「今天」

**在部署前，Vicky 的待審清單看不到簽到那筆的金額。**
部署步驟：貼 `Code.gs` + `Setup.gs` → 跑 `setup()` → Deploy → Manage deployments → ✏️ → New version。
（`Config.gs` 自第一次部署後沒變過。**永遠不要跑 `seedUsers()`**，會洗掉全家密碼。）

## 還要手動做的 Sheet 維護

- `chores` 分頁六列的 `description` 欄是空的。`seedTable` 只補「整列不存在」的資料，
  既有列不會自動填。範例文字在 `Setup.gs` 的 `CHORES_SEED`。
- `config` 的 `allowance_weekday` / `allowance_hour` 是死鍵（每週自動發放已取消），留著無作用。

## 已完成

**後端**（`route()` 接受的 action）
`users` `login` `logout` `whoami` `snapshot` `change_password`
`request`（`chore_done` / `allowance_claim`）`cancel_request` `chore_photo`
`admin_decide` `admin_adjust` `admin_gift` `admin_recalc`

**前端**
登入（8 位數字鍵盤）· 餘額頁（活期卡上兩顆大按鈕）· 每日零用錢簽到 ·
家事回報 · 家長待審清單與家長首頁 · 注音模式

**橫向機制**
照片存 private Drive（不開分享，看圖走 `chore_photo` 驗 session）·
`clientId` 冪等 · script lock · Asia/Taipei 日／週界線由伺服器判定 ·
餘額一律由 ledger 加總而非信任快取欄 · 邏輯 401 自動導回登入頁

## 未實作

| 項目 | 里程碑 | 備註 |
|---|---|---|
| `transfer` 轉帳 | M2 | 規格含 `gift-no-transfer` 限制 |
| `open_account` 開定存／目標 | M2 | 期數 3~12 個月，確認頁需顯示解鎖日期 |
| `withdraw` / `term_break` | M4 | `request` 目前對這兩種回 `unknown-action` |
| 每月計息 trigger | M3 | **活期目前不會產生任何利息** |
| `admin_config` | — | 改利率／金額／家事只能直接編輯 Sheet |
| `admin_revoke_session` | — | 踢裝置只能手動刪 `sessions` 列 |
| 離線佇列 | M5 | 照片請求目前沒有離線補送 |
| 紅包由小孩自填金額＋拍照送審 | — | 已設計未實作：核准時 Vicky 要能改金額並留紀錄 |

## 待決

- 消費紀錄（提領後回報買了什麼）—— 目前 v1 不做
- `credentials` 要不要搬到另一份不分享的試算表
- 照片保存期限與 Drive 配額（每年約 1.2 GB）

## 已知問題

- `snapshot` 約 5.5 秒。畫面會先畫快取所以不會空白，但這是真的慢，
  原因是一次請求要讀七張表。優化方向是合併成批次讀取。

## 開發方式

- TDD：新行為先寫會失敗的測試。`npm test`（零依賴，Node 內建 test runner）
- 假的 Apps Script 環境跑在記憶體裡，測試不碰線上 Sheet
- 規格是 `SPEC.md`，與程式不一致時**以程式為準**並回頭修規格
