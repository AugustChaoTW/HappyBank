# 🏦 HappyBank

給家裡小孩用的零用錢虛擬銀行。純靜態 Web App（HTML/CSS/JS）+ Google Apps Script/Sheet 後端，
部署在 GitHub Pages。架構沿用 [penghu-explorer](https://github.com/AugustChaoTW/penghu-explorer)。

核心教育目標：讓小孩親手感受**流動性的代價**——
🧧 阿公阿嬤的紅包 0% · 💰 活期 5%/月 · 🔒 定存 10%/月但鎖到到期。

📄 **開發規格見 [SPEC.md](SPEC.md)**（目前 v0.1，審核流程待拍板）

## 現況

規格討論階段，尚未開始實作。

## 資料庫

Google Sheet「HappyBank 資料庫」 — [開啟](https://docs.google.com/spreadsheets/d/1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo/edit)
（Sheet ID `1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo`，擁有者 aug.chao@gmail.com，未分享）

📘 **完整部署步驟（建表、建帳號、部署 Web App、疑難排解）見 [docs/DEPLOY.md](docs/DEPLOY.md)**

初始化步驟：

1. Sheet → 擴充功能 → Apps Script，貼上 `apps-script/Setup.gs`
2. 執行 `setup()` → 建好 users / credentials / sessions / accounts / ledger / requests / chores / config 八個分頁
   （`credentials` 會自動隱藏並加保護）
3. 改掉 `seedUsers()` 裡的 `CHANGE-ME` 密碼後執行 → 建立全家帳號
4. **執行完把密碼從程式碼清掉，不要 commit 真實密碼**

登入帳號存在 `users` 分頁；**密碼雜湊放在獨立的 `credentials` 分頁**，自動隱藏並加保護，
這樣 Sheet 可以安心分享給家人看帳（見 SPEC §8.1）。
