# 🏦 HappyBank 部署手冊

把後端（Google Apps Script + Google Sheet）建起來、接上前端（GitHub Pages）的完整步驟。
照著做就好，不需要懂程式。整套流程大約 20 分鐘。

**前置條件**

- 用擁有這份 Sheet 的 Google 帳號（`aug.chao@gmail.com`）登入瀏覽器。用別的帳號會在第 3 步授權時失敗。
- 電腦上有這個 repo（`/Users/fychao/Work/HappyBank`），第 6 步要改一行設定並 commit。

| 常數 | 值 |
|---|---|
| Sheet ID | `1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo` |
| 共享 token | `hb-10c4cc80462d2b4c` |
| 前端網址 | https://augustchaotw.github.io/HappyBank/ |

---

## 1. 開啟 Apps Script 編輯器

1. 開啟 Sheet：
   https://docs.google.com/spreadsheets/d/1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo/edit
2. 上方選單 **擴充功能 → Apps Script**（Extensions → Apps Script）。
3. 會開一個新分頁，標題預設是「未命名專案」。點標題改成 `HappyBank API`（非必要，但之後好找）。

左邊「檔案」區預設有一個 `Code.gs`，內容是空的 `myFunction()`。

---

## 2. 貼上 Setup.gs 與 Code.gs

專案裡要有**兩個** `.gs` 檔案，檔名與 repo 一致：

| 檔案 | 用途 | 執行時機 |
|---|---|---|
| `Setup.gs` | 建分頁、寫 config 種子、密碼雜湊函式（`hashPassword` / `newSalt`）、建帳號（`upsertUser` / `seedUsers`） | `setup()` 與 `seedUsers()` **只在編輯器裡手動跑**，正常情況各跑一次 |
| `Code.gs` | Web App 本體：`doGet` / `doPost` / 登入 / snapshot / 家長操作 | 每次前端打 API 時由 Google 自己執行，**不要手動跑** |

> **為什麼要分兩個檔？** 兩件事的生命週期不同：`Setup.gs` 是一次性的建置工具，
> `Code.gs` 是長期對外服務的端點。分開之後，之後改 API 邏輯不會動到建表與建帳號的程式碼。
> 但**兩個檔都必須留在同一個 Apps Script 專案裡**——`Code.gs` 的登入驗證會呼叫
> `Setup.gs` 定義的 `hashPassword()` 與 `newSalt()`，刪掉 `Setup.gs` 登入就會壞掉。

做法：

1. 點左邊檔案列的 `Code.gs`，全選（Cmd+A）刪掉，貼上 repo 裡 `apps-script/Code.gs` 的完整內容。
2. 點檔案列右上的 **＋ → 指令碼（Script）**，命名為 `Setup`（Apps Script 會自動補 `.gs`）。
   把預設內容刪掉，貼上 repo 裡 `apps-script/Setup.gs` 的完整內容。
3. 按 **💾 儲存專案**（Cmd+S）。

> ⚠️ **已知衝突：`SHEET_ID` 重複宣告。**
> `Code.gs` 與 `Setup.gs` 檔頭都有一行 `const SHEET_ID = '1Po7...';`。
> Apps Script 把同一專案的所有 `.gs` 檔案併成同一個全域範圍，
> 同一個 `const` 宣告兩次會在**執行任何函式時**直接噴
> `SyntaxError: Identifier 'SHEET_ID' has already been declared`。
> **處理方式**：把 `Code.gs` 裡那一行 `const SHEET_ID = ...` 刪掉（保留 `Setup.gs` 的那一行），
> 再儲存。兩個檔共用同一個值，功能不受影響。
> 若貼上後儲存與執行都正常、沒有出現這個錯誤，就不用動。

---

## 3. 執行 `setup()`：建立八個分頁

1. 編輯器上方工具列，左邊那個函式下拉選單選 **`setup`**。
2. 按 **▶ 執行**。

### 3.1 授權畫面怎麼點過去

第一次執行會跳出授權流程，畫面很嚇人但是正常的（因為這支腳本沒有經過 Google 驗證，
它就是你自己寫的）：

1. 「需要授權」→ 按 **審查權限 / Review permissions**。
2. 選你的 Google 帳號（必須是 Sheet 擁有者那一個）。
3. 出現紅色的 **「Google 尚未驗證這個應用程式」/「這個應用程式未經 Google 驗證」** 頁面：
   - 點左下角小小的 **進階 / Advanced**。
   - 展開後點最下面的 **前往「HappyBank API」(不安全) / Go to HappyBank API (unsafe)**。
4. 下一頁列出要求的權限（存取你的 Google 試算表、以你的身分連線外部服務），按 **允許 / Allow**。

授權只需要做一次。之後再執行不會再問，除非你改動了程式需要的權限範圍。

### 3.2 執行完該看到什麼

執行記錄（下方 Execution log）最後一行會是：

```
setup 完成：users, credentials, sessions, accounts, ledger, requests, chores, config
```

回到 Sheet 分頁重新整理，底下應該有這 **八個分頁**：

| 分頁 | 內容 |
|---|---|
| `users` | 登入帳號（不含密碼） |
| `credentials` | 密碼雜湊 — **會被隱藏** |
| `sessions` | 登入中的裝置 |
| `accounts` | 各帳戶 |
| `ledger` | 交易明細（唯一真實來源） |
| `requests` | 待審申請 |
| `chores` | 家事清單 |
| `config` | 設定值 |

每張表第一列是粗體藍底的表頭並凍結。`config` 分頁應該已經有 13 列種子設定
（`rate_current` 0.05、`rate_term` 0.1、`pbkdf_rounds` 1000 …）。
預設的空白「工作表1」會被自動刪掉。

`setup()` **可以重複執行**：已存在的分頁只補表頭，不會動既有資料；`config` 只補還沒有的 key。

### 3.3 credentials 分頁去哪了？

`setup()` 最後會呼叫 `protectCredentials()`，把 `credentials` **隱藏**並加上工作表保護
（描述是「密碼雜湊，請勿手動編輯」，移除所有共同編輯者）。所以你在分頁列看不到它，這是正常的。

要看它的話：Sheet 選單 **檢視 → 隱藏的工作表 → credentials**（View → Hidden sheets → credentials）。
看完建議在分頁標籤上按右鍵 → **隱藏工作表** 藏回去。

---

## 4. 建立全家帳號（設定密碼）

密碼**只在編輯器裡短暫存在**，絕對不要 commit 進 repo。

1. 回到 Apps Script 編輯器，打開 `Setup.gs`，捲到最下面的 `seedUsers()`：

   ```js
   function seedUsers() {
     upsertUser('momo',   'kid',    'Momo', '👧', 'CHANGE-ME', 50);
     upsertUser('coco',   'kid',    'Coco', '👧', 'CHANGE-ME', 50);
     upsertUser('dodo',   'kid',    'Dodo', '👦', 'CHANGE-ME', 50);
     upsertUser('aug',    'parent', 'Aug',   '🧑', 'CHANGE-ME', 0);
     upsertUser('vicky',  'parent', 'Vicky', '👩', 'CHANGE-ME', 0);
   }
   ```

2. 把五個 `'CHANGE-ME'` 換成真正的密碼。規則由 `assertPasswordOk()` 強制檢查：
   - **小孩（`kid`）：剛好 8 位數字**，例如 `'20180315'`。少一位、多一位、有非數字都會丟
     `小孩密碼必須是 8 位數字`。（位數由 `config.kid_password_digits` 決定，預設 8。）
   - **家長（`parent`）：至少 8 個字元**，任意字元。太短會丟 `家長密碼至少 8 個字元`。
   - 留著 `CHANGE-ME` 不改會直接丟 `請先改掉預設密碼`。
   - 小孩的 8 位數字會被小孩自己看到、也可能被兄弟姐妹猜，**不要用家裡其他地方在用的密碼**。

3. 按 Cmd+S 儲存，函式下拉選單選 **`seedUsers`**，按 **▶ 執行**。
   執行記錄會逐行出現 `user 已寫入：momo`…共五行。
4. 回 Sheet 確認 `users` 分頁有五列；`credentials`（要從「檢視 → 隱藏的工作表」打開看）
   同樣五列，`passwordHash` 是一串亂碼 base64，**沒有任何明文密碼**。
5. 🔴 **立刻把五個密碼改回 `'CHANGE-ME'`，再按 Cmd+S 儲存。**
   Apps Script 的版本歷史會留著你剛剛存過的明文，但至少當前內容乾淨；
   更重要的是——**repo 裡的 `apps-script/Setup.gs` 永遠只能是 `CHANGE-ME`，不准 commit 真實密碼**。
6. 之後要改某個人的密碼：在編輯器裡改一次 `seedUsers()` 再跑一次（`upsertUser` 是 upsert，
   以 `userId` 為鍵覆蓋，會重新產生 salt），或登入後用前端的「改密碼」功能。

---

## 5. 部署成 Web App

1. Apps Script 編輯器右上角 **部署 / Deploy → 新增部署作業 / New deployment**。
2. 左邊齒輪 **選取類型 / Select type → 網頁應用程式 / Web app**。
3. 填寫：
   - **說明 / Description**：`v1`（隨意，方便日後辨識）
   - **執行身分 / Execute as**：**我 / Me (你的帳號)** ← 必須，否則讀不到 Sheet
   - **誰可以存取 / Who has access**：**任何人 / Anyone** ← 必須，
     小孩的手機不會登入 Google，選「只有我」前端一律拿不到資料
4. 按 **部署 / Deploy**。若跳授權，重複 §3.1 的步驟。
5. 複製 **網頁應用程式網址 / Web app URL**，長得像：

   ```
   https://script.google.com/macros/s/AKfycb.................../exec
   ```

   結尾一定是 `/exec`。**不要**用 `/dev` 結尾那個（那是測試版網址，只有你自己登入才打得開）。

---

## 6. 把網址填進前端

1. 編輯 `js/config.js`，把第 4 行的 `apiUrl` 從空字串改成剛剛複製的網址：

   ```js
   apiUrl: 'https://script.google.com/macros/s/AKfycb.../exec',
   ```

2. 確認 `apiToken` 與 `Code.gs` 檔頭的 `TOKEN` **完全一樣**，目前兩邊都是：

   ```
   hb-10c4cc80462d2b4c
   ```

   不一樣的話 API 一律回 `{"ok":false,"error":"bad-token"}`。
3. commit 並 push 到 `master`：

   ```sh
   git add js/config.js
   git commit -m "chore: point frontend at deployed Apps Script web app"
   git push
   ```

4. GitHub Pages 大約 1 分鐘後更新。重新整理時按 **Cmd+Shift+R** 強制略過快取。

---

## 7. 驗證

### 7.1 直接打 API（不用前端）

瀏覽器網址列貼上（把 `<WebAppURL>` 換成你的 `/exec` 網址）：

```
<WebAppURL>?action=users&token=hb-10c4cc80462d2b4c
```

應該回傳 JSON 名單：

```json
{"ok":true,"users":[{"userId":"momo","role":"kid","displayName":"Momo","emoji":"👧"}, ...]}
```

- 回 `{"ok":false,"error":"bad-token"}` → token 打錯，或 `Code.gs` 的 `TOKEN` 被改過。
- 回 `{"ok":true,"users":[]}` → `users` 分頁是空的，回去做 §4。
- 出現 Google 的登入頁或「很抱歉，發生暫時性錯誤」→ 部署的存取權限不是「任何人」，重做 §5。

順便驗錯誤路徑（應該回 `unknown-action`）：

```
<WebAppURL>?action=nope&token=hb-10c4cc80462d2b4c
```

### 7.2 前端實際登入

1. 開 https://augustchaotw.github.io/HappyBank/
2. 點一個小孩頭像 → 用數字鍵盤輸入 §4 設定的 8 位數字 → 輸滿自動送出。
3. 登入成功後回 Sheet 檢查：
   - `sessions` 分頁多一列（`token`、`userId`、`expiresTs`、`device`）。
   - `users` 分頁那一列的 `lastLoginTs` 更新成現在時間。
   - `accounts` 分頁自動多出該小孩的 `current` 與 `gift` 兩個帳戶。
4. 故意打錯密碼一次，確認 `credentials` 的 `failedCount` 變 1；連錯 5 次會寫入 `lockedUntil`
   並鎖 15 分鐘（要提早解鎖，就手動把 `lockedUntil` 那格清空）。

---

## 8. 🔁 改過 Code.gs 之後**一定要重新部署**

**這是最常見的「我明明改了，怎麼完全沒反應」的原因。**

Apps Script 的 Web App 網址對應的是一個**凍結的版本快照**，不是你編輯器裡的當前程式碼。
在編輯器按 Cmd+S 只是存檔，`/exec` 那個網址跑的**還是舊版**，可以這樣放著好幾天都不變。

改完 `Code.gs`（或 `Setup.gs` 裡被 `Code.gs` 呼叫的函式）之後：

1. Cmd+S 儲存。
2. 右上角 **部署 / Deploy → 管理部署作業 / Manage deployments**。
3. 選現有那個部署，按右上角的 **✏️ 編輯 / Edit（鉛筆圖示）**。
4. **版本 / Version** 下拉選單選 **新版本 / New version**（預設會停在舊版號，一定要手動改）。
5. 按 **部署 / Deploy**。

> ✅ 這樣做 **Web app URL 不會變**，前端 `js/config.js` 不用動。
> ❌ 千萬不要用「新增部署作業」來更新——那會產生**另一個新網址**，舊網址繼續跑舊程式，
> 前端還指著舊的，症狀會更難懂。

確認真的生效：重打一次 §7.1 的 `?action=users` 網址，或在編輯器 **執行記錄 / Executions**
分頁看最新一次 `doGet` 的時間戳。

---

## 9. 疑難排解

| 症狀 / 錯誤訊息 | 原因 | 處理 |
|---|---|---|
| `{"ok":false,"error":"bad-token"}` | `js/config.js` 的 `apiToken` ≠ `Code.gs` 的 `TOKEN` | 兩邊都對成 `hb-10c4cc80462d2b4c`，改了 `Code.gs` 要重新部署（§8） |
| `{"ok":false,"error":"server","message":"找不到分頁 xxx，請先執行 Setup.gs 的 setup()"}` | 分頁沒建好，或有人手動改了分頁名稱 | 回 §3 執行 `setup()`。分頁名稱必須全小寫英文，`ledger` 不能改成「帳本」 |
| `SyntaxError: Identifier 'SHEET_ID' has already been declared` | `Code.gs` 與 `Setup.gs` 都宣告了 `const SHEET_ID` | 刪掉 `Code.gs` 那一行，保留 `Setup.gs` 的（見 §2 警告框） |
| Console 出現 `Access to fetch ... blocked by CORS policy` | 通常**不是**真的 CORS：Apps Script 回 302 轉址到登入頁時瀏覽器會報成 CORS | 檢查部署的「誰可以存取」是不是「任何人」，以及網址是不是 `/exec` 結尾（不是 `/dev`） |
| 前端顯示「後端尚未部署（SPEC M1）」 | `js/config.js` 的 `apiUrl` 還是空字串 | 做 §6，並確認已 push、Pages 已更新、瀏覽器已強制重新整理 |
| 執行 `setup()` 跳「需要授權」／`Exception: 您沒有呼叫 SpreadsheetApp.openById 的權限` | 沒授權，或登入的是非擁有者帳號 | 依 §3.1 走完授權；確認瀏覽器目前帳號是 Sheet 擁有者 |
| 授權過期、或錯誤訊息提到 `Authorization is required` | Google 撤銷了授權（改密碼、長期未用、權限範圍變了） | 在編輯器手動執行一次 `setup()`，重新走 §3.1 授權，然後依 §8 重新部署 |
| **改了程式沒反應** | 只存檔沒建新版本 | 見 §8：Manage deployments → 編輯 → New version |
| API 回 `{"ok":false,"error":"unauthorized","message":"登入已失效，請重新登入。"}`（前端視為 401） | session token 在 `sessions` 分頁找不到 | 重新登入。若是被家長踢掉或手動刪過 `sessions` 的列，屬正常 |
| 同上但訊息是「登入過期了，請重新登入。」 | `sessions.expiresTs` 已過（小孩 30 天、家長 24 小時） | 重新登入。要延長改 `config` 的 `session_days_kid` / `session_hours_parent` |
| 「這個功能只有爸爸媽媽可以用。」 | 用小孩 session 打 `admin_*` | 用家長帳號登入。這是伺服器端判定，前端改不掉，是預期行為 |
| 「密碼錯太多次了，請等 N 分鐘再試。」 | 連錯 5 次被鎖 15 分鐘 | 等，或到隱藏的 `credentials` 分頁把該列的 `lockedUntil` 清空 |
| 餘額看起來不對 | `accounts.balance` 只是快取欄 | 用家長 session 打 `admin_recalc`，從 `ledger` 全量重算並回報修正了哪些帳戶 |
| 回 `{"ok":false,"error":"bad-json"}` | POST body 不是合法 JSON | 前端問題；檢查是不是用了非 `Api.post()` 的方式送請求 |

---

## 10. 🔐 安全須知

誠實版本（對應 SPEC §8）——請不要對這套系統有超出實際的期待：

1. **repo 是 public，前端的所有東西都是公開的。** 任何人都看得到 `js/config.js`。
2. **`hb-10c4cc80462d2b4c` 這個 token 不是密碼，是雜訊過濾器。**
   它跟著前端一起公開在 GitHub 上，只擋隨機路人與爬蟲，擋不住任何想看的人（包含自家小孩）。
   **不要**把它當成安全邊界，也不要重用到別的專案。
3. **真正的防線有兩道**：
   - **session**：身分一律由伺服器查 `sessions` 分頁判定，前端送什麼 `kidId` 都沒用
     （snapshot 的 `kid` 以 session 決定，Momo 改參數也看不到 Coco 的帳）；
     所有 `admin_*` 由伺服器檢查 `session.role === 'parent'`，前端的隱藏選單只是裝飾。
   - **伺服器端計算**：前端從不送 `balance`，只送 `amount` 與 `accountId`，
     所有金額變動都在 `Code.gs` 裡算完才寫 `ledger`。改 localStorage 改不出錢來。
4. **Sheet 本身不要分享出去。** 擁有者 `aug.chao@gmail.com`，目前未分享，維持這樣。
   Web App 用「執行身分：我」代為讀寫，小孩不需要、也不該有 Sheet 的存取權。
5. **`credentials` 分頁已隱藏並加保護**（僅擁有者可編輯），密碼只存加鹽 SHA-256 迭代 1000 次的雜湊，
   不存明文。這道防線擋的是「小孩翻開 Sheet 看到明文密碼」，
   **不是**擋外部攻擊者離線暴力破解——對家用場景夠用，但**絕不要重用家裡其他地方的密碼**。
6. **密碼絕不 commit。** repo 裡的 `seedUsers()` 永遠是 `CHANGE-ME`。
   真實密碼只在 Apps Script 編輯器裡出現幾分鐘，用完改回去。
7. HappyBank 用的是**獨立的 Apps Script 專案與獨立 token**，
   與 penghu-explorer 那支（token 早已公開）完全分開，不共用。
