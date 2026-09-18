# 🏦 HappyBank

給家裡小孩用的零用錢虛擬銀行。純靜態 Web App（HTML/CSS/JS）+ Google Apps Script/Sheet 後端，
部署在 GitHub Pages。架構沿用 [penghu-explorer](https://github.com/AugustChaoTW/penghu-explorer)。

核心教育目標：讓小孩親手感受**流動性的代價**——
🧧 阿公阿嬤的紅包 0% · 💰 活期 5%/月 · 🔒 定存 10%/月但鎖到到期。

📄 **開發規格見 [SPEC.md](SPEC.md)**（目前 v0.1，審核流程待拍板）

## 現況

M1 骨架程式碼已完成（登入／snapshot／家長調帳、餘額頁），**尚未部署後端**——
把 Apps Script 部署成 Web App 並把網址填進 `js/config.js` 的 `apiUrl` 就會活過來。
細節見 [SPEC §11](SPEC.md#11-開發階段) 與 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 資料庫

Google Sheet「HappyBank 資料庫」 — [開啟](https://docs.google.com/spreadsheets/d/1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo/edit)
（Sheet ID `1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo`，擁有者 aug.chao@gmail.com，未分享）

📘 **完整部署步驟（建表、建帳號、部署 Web App、疑難排解）見 [docs/DEPLOY.md](docs/DEPLOY.md)**

初始化步驟：

1. Sheet → 擴充功能 → Apps Script，貼上 `apps-script/Config.gs`、`Code.gs`、`Setup.gs`
   三個檔（`SHEET_ID` / `TOKEN` 只在 `Config.gs` 宣告一次）
2. 執行 `setup()` → 建好 users / credentials / sessions / accounts / ledger / requests / chores / config 八個分頁
   （`credentials` 會自動隱藏並加保護）
3. 改掉 `seedUsers()` 裡的 `CHANGE-ME` 密碼後執行 → 建立全家帳號
4. **執行完把密碼從程式碼清掉，不要 commit 真實密碼**

登入帳號存在 `users` 分頁；**密碼雜湊放在獨立的 `credentials` 分頁**，自動隱藏並加保護。

> 🔴 **這份 Sheet 不要分享給任何人。** Google Sheets 的保護只擋編輯、不擋讀取——
> 被分享的人（即使只是檢視者）可以建立副本或用 API 讀走隱藏的 `credentials`，
> 再離線爆破小孩的 8 位數字密碼。家人要看帳請給一個家長帳號走 app 的家長模式
> （見 [SPEC §5 / §8.1](SPEC.md#5-資料模型google-sheet一分頁一表)）。
