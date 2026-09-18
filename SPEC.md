# 🏦 HappyBank — 小孩零用錢虛擬銀行

開發規格 v0.1 · 2026-09-18

給家裡小孩用的零用錢銀行。核心教育目標不是「記帳」，而是讓小孩**親手感受到流動性的代價**：
錢放在阿公阿嬤的紅包袋裡不會變多，放活期會慢慢變多，鎖進定存會變多很多——但鎖了就拿不出來。

架構沿用 [penghu-explorer](https://github.com/AugustChaoTW/penghu-explorer)：純靜態前端 + Google Apps Script 後端，
無 build step、無框架、部署到 GitHub Pages。

---

## 1. 架構原則

| 層 | 做法 | 與 penghu-explorer 的差異 |
|---|---|---|
| 前端 | 單頁 SPA，`index.html` 內多個 `<section class="view">` 切換 | 相同 |
| JS 模組 | 每檔一個 IIFE 單例，`<script>` 依序載入，全域掛名 | 相同 |
| 設定 | `js/config.js` 集中 apiUrl / token / 小孩名單 / 利率 | 相同 |
| 本地狀態 | localStorage | **降級為唯讀快取**，不再是真實來源 |
| 後端 | Google Apps Script Web App + Google Sheet 當資料庫 | Drive 檔案 → Sheet 資料表 |
| 離線 | IndexedDB queue + `online` 事件補送 | 相同，但**加上 idempotency key** |
| 身分 | 首頁選「你是誰」，無驗證 | **帳號密碼登入**，帳號存在 Sheet，伺服器發 session token |
| 部署 | GitHub Pages | 相同 |

### 關鍵差異：帳本的真實來源在伺服器

探險家上傳的是作品，append-only，錯了無所謂。銀行的餘額會被小孩拿來吵架，
也會有人想去 DevTools 改 localStorage。因此：

> **`ledger` 表是唯一真實來源，存在 Google Sheet。前端 localStorage 只存最後一次成功同步的快照，僅供離線瀏覽，畫面上必須標示「更新於 ○○」。**

---

## 2. 帳戶模型

把「定存」「儲蓄目標」「阿公阿嬤紅包」統一成**同一種東西：子帳戶**。
差別只在三個欄位：利率、能不能領、有沒有目標金額。

| type | 顯示名稱 | 月利率 | 提領 | 目的欄位 | 每人數量 |
|---|---|---|---|---|---|
| `current` | 💰 活期主帳戶 | **5%** | 隨時（走提領申請） | 免填 | 1，自動建立 |
| `term` | 🔒 定存 | **10%** | **到期前不可**（可解約，見 §4.3） | **必填** | 不限 |
| `goal` | 🎯 儲蓄目標 | **5%** | 達標後才能領 | **必填 + 目標金額** | 不限 |
| `gift` | 🧧 阿公阿嬤的錢 | **0%** | 隨時（走提領申請） | 免填 | 1，自動建立 |

### 資金流向規則

- **所有收入一律先進 `current`**：每週零用錢、家事獎金、利息。
- **紅包例外，直接進 `gift`**（0% 利率）。小孩必須**自己動手**把紅包轉去活期或定存，
  這個手動動作就是整堂課——不動作，錢就永遠不長大。
- 子帳戶只能從 `current` 轉入，也只能轉回 `current`。子帳戶之間不能直接轉。
- 真實現金提領一律從 `current` 或 `gift` 出去。

```
      家事 ──┐
    零用錢 ──┼──▶ 💰 current (5%) ◀──▶ 🔒 term (10%)  到期前鎖死
      利息 ──┘        │     ▲      ◀──▶ 🎯 goal (5%)  達標前鎖死
                      │     │
          提領現金 ◀──┘     └── 🧧 gift (0%) 紅包進來的地方
                                    │
                            提領現金 ◀┘
```

---

## 3. 貨幣與精度

- 幣別：新台幣，**整數元，不使用小數**。所有金額欄位為 integer。
- 利息計算 `Math.round(balance * rate)`，不足 1 元記 0 元。
  故餘額低於 20 元的活期帳戶幾乎沒有利息——這本身就是「本金要夠大」的一課。

---

## 4. 計息規則

### 4.1 結算時點

Apps Script time-driven trigger，**每月 1 日 00:30（Asia/Taipei）**結算上個月。
結算對象：所有 `status = active` 的帳戶。

### 4.2 計息基礎（v1）

以**結算當下的帳戶餘額**計息，寫一筆 `type = interest` 的 ledger 進該帳戶（複利）。

> ⚠️ 已知可被玩弄：小孩若發現規則，可能月底把錢集中、月初領走。
> v1 接受這點（被發現時剛好是一堂好課）。若要修正，改為「當月最低餘額」——
> ledger 有完整時戳，伺服器端可重算，不需改資料結構。

### 4.3 定存（`term`）

- 開戶時**自由指定期數**（不是從固定選項挑）：小孩在開戶精靈裡自己決定要鎖幾個月，
  換算成日期寫入 `lockUntil`。
- **期數範圍：3～12 個月（含兩端）**，對應 `config.term_months_min` / `term_months_max`。
  少於 3 個月鎖不出感覺，多於 12 個月對小孩等於天荒地老。
  這個上下限**必須在伺服器端的 `open_account` 檢查**（超出範圍回 `ok:false`），
  不能只擋在 UI——前端是公開的，參數改一改就送得出來。
- 月息 10% 下這兩端的實際差距（`1.1^n`）：3 個月 ≈ 本金 ×1.33、6 個月 ≈ ×1.77、12 個月 ≈ ×3.14。
  也就是鎖滿一年，錢會變成三倍多——這就是願意等的報酬。
- 鎖定期間**逐月計息並複利**進該子帳戶。
- **到期後停止計息**，帳戶轉 `matured` 狀態。首頁跳提醒：
  「🔔 你的定存到期了，記得把錢領回活期繼續生利息！」——教到期管理。
- **提前解約**：小孩送出 `term_break` 申請 → 家長核准 →
  **本金全額退回 `current`，該帳戶累積的所有利息全數回沖**
  （寫一筆 `interest_reversal` 負數 ledger，金額 = 該 accountId 所有 `interest` 之和）。
  痛，但不傷本金。

### 4.4 儲蓄目標（`goal`）

- 開戶時填 `目的` + `targetAmount`。
- 以 5% 月息計息（等同活期，不因為設目標而受罰）。
- **達標前不可提領**，達標後解鎖，UI 放煙火。
- 進度條 + 「以你最近 4 週的存錢速度，還要大約 N 週」。

### 4.5 通膨警告（給家長）

月息 5% 複利 = 年化約 1.8 倍；定存月息 10% = 年化約 3.1 倍。錢會膨脹得比直覺快。
建議家長把**每週零用錢金額設低一點**，讓利息真的成為主要成長來源——這正是我們想教的東西。
利率在 `config` 分頁可調（整家一起）；**每週零用錢則是逐個小孩設定**，
存在 `users.weeklyAllowance`（見 §5），可以依年齡給不同金額，沒有全家共用的單一數字。

---

## 5. 資料模型（Google Sheet，一分頁一表）

**資料庫位置**：Google Sheet「HappyBank 資料庫」（擁有者 `aug.chao@gmail.com`，未分享）
`https://docs.google.com/spreadsheets/d/1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo/edit`
Sheet ID：`1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo`

`credentials` 分頁會被自動隱藏並加保護。分頁與表頭**不要手動建立**——schema 的唯一定義來源是 `apps-script/Setup.gs` 的 `SCHEMA` 常數，
在 Apps Script 編輯器執行 `setup()` 即可建好（可重複執行，不動既有資料）。


### `users`（登入帳號，取代原本的 `kids`）
| 欄位 | 型別 | 說明 |
|---|---|---|
| userId | string | 同時是帳號與 kidId。**一律小寫儲存，登入比對 `toLowerCase()`，大小寫不敏感** |
| role | enum | `kid` / `parent` |
| displayName | string | 顯示名 |
| emoji | string | 👧 |
| weeklyAllowance | int | **每週零用錢金額，逐人設定**（parent 為 0）。這是每個小孩的固定參數，不在 `config`，改某個小孩不影響其他人 |
| active | bool | 停用後無法登入 |
| lastLoginTs | datetime | |

### `credentials`（密碼獨立分頁）

**密碼與個資分開放。** 這張表由 `setup()` 自動**隱藏並加上保護**（只有擁有者可編輯）。

> ⚠️ **不要把這個 Sheet 分享給任何人。**
> Google Sheets 的「保護」只限制**編輯**，不限制**讀取**。任何被分享到這份試算表的人——
> 就算只給「檢視者」——都可以透過 檔案 → 建立副本、檔案 → 下載，或 Sheets API
> 把隱藏且受保護的 `credentials` 分頁整份讀出來。
> 而小孩密碼是 8 位數字，雜湊是加鹽 SHA-256 迭代（見 §8.1）；
> 拿到副本的人可以在自己電腦上離線窮舉，幾秒鐘就能還原出兄弟姐妹的密碼。
> **隱藏 + 保護擋的是誤改與隨手亂看，擋不住有心的讀者。**
> 若真的需要讓家人看帳，正確做法是兩條路之一：
> （a）給對方一個 `role = parent` 的帳號，走 app 的**家長模式**看；
> （b）把 `credentials` 搬到另一份**完全不分享**的試算表，本表只留非機密欄位。
> 在（b）做完之前，這份 Sheet 一律只有擁有者能存取。

| 欄位 | 型別 | 說明 |
|---|---|---|
| userId | string | 對應 `users.userId` |
| salt | string | 16 字元隨機鹽，每次改密碼重新產生 |
| passwordHash | string | 見 §8.1，**不存明文** |
| failedCount | int | 連續登入失敗次數 |
| lockedUntil | datetime\|null | 鎖定到期時間 |
| updatedTs | datetime | 最後一次改密碼時間 |

### `sessions`
| 欄位 | 型別 | 說明 |
|---|---|---|
| token | string | uuid，登入成功時發出 |
| userId | string | |
| createdTs | datetime | |
| expiresTs | datetime | 小孩 30 天、家長 24 小時（config 可調） |
| device | string | UA 片段，方便家長認出是哪台裝置並踢掉 |

### `accounts`
| 欄位 | 型別 | 說明 |
|---|---|---|
| accountId | string | uuid |
| kidId | string | |
| type | enum | `current` / `term` / `goal` / `gift` |
| name | string | 目的（term/goal 必填） |
| emoji | string | |
| rateMonthly | number | 開戶時從 config 快照，之後不隨 config 變動（定存利率要「凍結」） |
| lockUntil | date\|null | term 專用 |
| targetAmount | int\|null | goal 專用 |
| balance | int | **快取欄**，可由 ledger 重算 |
| status | enum | `active` / `matured` / `closed` |
| createdTs | datetime | |

### `ledger`（append-only，唯一真實來源）
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | uuid |
| ts | datetime | |
| kidId | string | |
| accountId | string | |
| type | enum | 見下 |
| amount | int | 正=入帳，負=出帳 |
| balanceAfter | int | 寫入當下該帳戶餘額 |
| memo | string | |
| by | string | `system` / `kidId` / `parent` |
| refId | string\|null | 轉帳成對用；核准來源 requestId |
| clientId | string\|null | **冪等鍵**，見 §7.3 |

`type` 列舉：
`allowance`（每週零用錢）· `chore`（家事獎金）· `interest`（利息）· `interest_reversal`（解約回沖）·
`gift_in`（紅包）· `withdraw`（領現金）· `transfer_in` / `transfer_out`（帳戶間轉帳，成對）·
`penalty`（罰款）· `adjust`（家長手動調整）

### `requests`
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | uuid |
| ts | datetime | |
| kidId | string | |
| kind | enum | `chore_done` / `withdraw` / `term_break`（見 §9.2；轉帳免審，不進本表） |
| amount | int\|null | |
| choreId | string\|null | |
| fromAccountId / toAccountId | string\|null | |
| note | string | 小孩自己打的理由 |
| status | enum | `pending` / `approved` / `rejected` / `cancelled` |
| decidedTs | datetime\|null | |
| decidedBy | string\|null | **實際按下核准／退回的人的 userId**。原本只記時間不記人，代理確認就查不出是誰決定的（見 §9.5） |
| decidedProxy | bool | 是否為代理確認（核准者不是 `config.chore_approver`）。**寫入當下就記死，不要事後用 `decidedBy !== config.chore_approver` 推導**——`chore_approver` 一旦改過，歷史紀錄就會說謊 |
| decidedNote | string | 家長回覆（退回時必填，讓小孩知道為什麼） |
| photoFileId | string\|null | 家事照片在 Google Drive 的 **檔案 ID**（不是網址，見下方「家事照片」）。`kind = chore_done` **必填**；照片二進位內容不進 Sheet。要看圖一律走 `GET ?action=chore_photo`（§7.6） |
| clientId | string | 冪等鍵 |

### `chores`
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | |
| title | string | 「倒垃圾」 |
| icon | string | 🗑️ |
| reward | int | |
| repeat | enum | `daily` / `weekly` / `once` |
| kidId | string\|null | null = 誰都可以接 |
| active | bool | |

### `config`（key-value 單列表）
`rate_current` · `rate_term` · `rate_goal` · `rate_gift` ·
`term_months_min`（3）· `term_months_max`（12）·
`allowance_weekday`（0-6，固定 0＝週日）· `allowance_hour`（8，24 小時制）·
`session_days_kid` · `session_hours_parent` · `login_max_fail` · `login_lock_minutes` · `pbkdf_rounds` ·
`approval_mode`（固定 `tiered`，見 §9）· `kid_password_digits`（8）·
`chore_approver`（預設 `vicky`）

> 這裡**沒有**每週零用錢金額（在 `users.weeklyAllowance`，逐人設定），
> 也**沒有**定存期數的固定選項——期數是開戶時自由填的，只受 `term_months_min` /
> `term_months_max` 上下限約束，由伺服器端 `open_account` 把關（見 §4.3、§9.3）。

`chore_approver` 是**家事回報的指定核准者**，值是一個 `role = parent` 的 userId，預設 `vicky`。
另一位家長仍然可以核准，但必須走「代理確認」（見 §9.5）。把它放進 `config` 是為了
「媽媽長期出差／換人管家事」時改一格就好，不用改程式碼。
伺服器端讀到的值若不是一個存在且 `active` 的 parent，視為設定錯誤，
`admin_decide` 對 `chore_done` 一律回 `ok:false, error:'server'`（不要靜默 fallback 成「誰都能核准」）。

### 家事照片（Google Drive，不進 Sheet）

照片是資料模型的一部分，只是不存在 Sheet 裡。作法沿用 penghu-explorer 的
「手機照片 → base64 → Apps Script → Drive」那條路（同樣的手法，不是同一份程式碼——兩個 repo 刻意不共用）。

- **位置**：Apps Script 以 `DriveApp` 在擁有者雲端硬碟根目錄下建
  `HappyBank 家事照片/<kidId>/`，資料夾不存在就建（`getOrCreatePath`，可重複執行）。
- **檔名**：`<yyyyMMdd>-<choreId>-<clientId 前 8 碼>.jpg`
  （日期取 `Asia/Taipei`）。帶 `clientId` 是為了離線佇列重送時**認得出同一張照片**，
  不會在 Drive 裡留下一堆重複檔（見 §7.5）。
- **格式**：一律 JPEG。前端上傳前必須先壓縮（最長邊 ~1280px、品質 0.8，見 §7.5），
  伺服器不做影像處理。
- **權限：不做任何分享。** 建完檔就放著，維持 Drive 預設權限——
  **只有擁有者（也就是 Sheet／Apps Script 的執行身分）讀得到**，
  **不呼叫 `setSharing`、不產生任何公開連結**。
  這是本專案**唯一一處刻意偏離 penghu-explorer 的地方**：
  那邊上傳的是風景照與作品照，開連結分享是功能（小孩要拿給親戚看）；
  這裡拍的是家裡室內——廚房、小孩房間、垃圾桶旁邊——不該有一條「知道網址就看得到」的路。
- **回寫 `fileId`，不是 URL**：`requests.photoFileId` 存 `file.getId()`。
  存 URL 也沒用——檔案是 private，沒登入 Google 帳號的瀏覽器點開只會看到權限牆。
  要看圖一律經過伺服器驗身分後代理取圖（§7.6）。
- **一張照片對一筆 request**：`photoFileId` 是一對一，不做相簿、不支援補傳第二張。

> **還留著的三件事（不是風險警告，是誠實的現況）：**
> 照片**永久留在 Drive**，v1 沒有自動刪除；
> **Apps Script 的執行身分讀得到全部照片**（代理取圖就是用這個身分去讀的），
> 所以「誰看得到」最終等於「誰能存取那個 Google 帳號與那支 Apps Script」；
> **備份與刪除策略仍未定**，列在 §10。

---

## 6. 前端結構

```
index.html              views: login / home / account / chores / goal / history / admin
css/style.css           沿用 penghu-explorer 的視覺語彙（大字、大按鈕、手機直式）
js/
  config.js             apiUrl, apiToken, 預設利率（僅供離線顯示，以伺服器為準）
                        ※ 小孩名單不再寫死在這裡，登入後由伺服器回傳
  auth.js               登入／登出、session token 保管、401 自動導回登入頁
  api.js                取代 upload.js：GET snapshot / POST action，共用 token
  queue.js              照抄 penghu-explorer，加 clientId
  store.js              localStorage 快照 + 資料新鮮度（「更新於 ○○」）
  money.js              金額格式化、利息試算、「還要幾週」估算
  account.js            餘額頁、帳戶卡片、轉帳
  chores.js             家事清單、回報、拍照與壓縮（canvas → JPEG base64，見 §7.5）
  goals.js              開子帳戶（定存 / 目標）、進度條
  history.js            交易明細
  admin.js              家長模式：待審清單（含家事照片縮圖）、代理確認、手動調帳、設定
  app.js                路由與主流程
  version.js            照抄（footer 顯示 commit hash）
apps-script/
  Config.gs             SHEET_ID / TOKEN（同專案共用全域範圍，只能宣告一次）
  Code.gs               doGet / doPost / 登入 / snapshot / 家長操作 / 密碼雜湊
                        （每月計息、每週零用錢 trigger 屬 M3，尚未實作）
  Setup.gs              建分頁與種子資料、建帳號（只在編輯器手動執行）
data/
  (無 — 所有資料來自 API)
```

### 各 view 要點

- **login**：點自己的大頭像 → 跳出 8 顆圓點與大顆數字鍵盤，輸滿 8 碼自動送出。
  家長頭像則切換成一般密碼輸入框。
- **home**：登入後直接進來 → 四張帳戶卡（活期 / 紅包 / 各定存 / 各目標），總資產大字，
  「這個月預計利息 ○○ 元」誘導存錢，待審/到期提醒 badge。
- **account**：單一帳戶詳情 + 轉帳 + 提領申請。
- **chores**：**每日家事清單**。一件家事一張卡：icon、名稱、獎金、以及一個**狀態**——

  | 狀態 | 顯示 | 可否操作 |
  |---|---|---|
  | 可回報 | 「我做完了 📷」大按鈕 | 點下去直接叫相機 |
  | 今天已回報（等待中） | 「⏳ 等媽媽確認」+ 照片縮圖 + 送出時間 | 只能**撤回**，不能重送 |
  | 今天已入帳 | 「✅ 媽媽在 9/18 晚上 9:14 確認 ＋10 元」+ 照片縮圖 | 不能再報（見 §7.2 一天一次） |
  | 被退回 | 「❌ 退回：⟨家長理由⟩」 | 可以重拍重報（退回不佔用當天扣打） |

  卡片按 `repeat` 分兩區：**今天的家事（daily）**、**這週的家事（weekly）**，
  weekly 的狀態文字寫「這週已回報」而不是「今天已回報」。
  清單頂端一行小字：「今天已回報 2 件，等確認中 ＋20 元」——讓小孩看得到還沒到手的錢。

  **狀態卡上的照片縮圖**：照片是 private 的，不能直接放 Drive 網址。
  卡片先畫一個灰底佔位＋spinner，再帶 session 打 `chore_photo`（§7.6）取 base64，
  拿到才設 `img.src = 'data:image/jpeg;base64,' + data`；抓過的存在記憶體快取（key 為 requestId）。
  取不到時顯示「照片讀不到」，**不要破圖、也不要因此讓整張卡片消失**。

  **拍照流程**：按鈕直接開 `<input type="file" accept="image/*" capture="environment">`
  （不自建相機 UI，交給系統 App）→ 選到檔案後**先在 canvas 壓縮**（§7.5）→
  畫面出現預覽縮圖 + 「重拍」/「送出」。**沒有照片時「送出」是 disabled**，
  而且伺服器端還會再擋一次（§7.2）。壓縮與上傳期間顯示進度，不要讓小孩以為當掉了連按。
- **goals**：開新子帳戶精靈（選 定存 or 目標 → 填目的 → **自己決定要鎖幾個月**／填目標金額 → 試算「到期會變成 ○○ 元」）。
  **試算畫面是關鍵轉換點**，要把 10% 的威力視覺化。
- **history**：全帳戶交易明細，可依帳戶篩選。
- **admin**：僅 `role = parent` 的 session 可進入（伺服器判定，前端只是隱藏入口）。
  待審清單一鍵核准/退回、手動調帳、**逐個小孩改每週零用錢**（`users.weeklyAllowance`）、編家事、看 `sessions` 踢掉裝置。
  **家事待審項目多一張照片縮圖**：照片是 private 的，`<img>` 不能直接指向 Drive，
  必須帶 session 打 `chore_photo`（§7.6）拿 base64，再塞進 `img.src = 'data:image/jpeg;base64,' + data`。
  因此縮圖**一律延遲載入**——先畫一個佔位框＋spinner，捲到畫面內（或家長點開該筆）才去抓，
  **不要一進待審清單就把十張照片一起抓**（一張一趟往返、每趟 1～2 秒，會整頁卡住）。
  抓過的照片**在記憶體快取到登出為止**（以 requestId 為 key），家長來回捲動不重抓；
  **不寫進 localStorage**（照片不該落在裝置上）。
  照片讀不到時顯示「照片讀不到」而不是破圖——不要讓家長在看不到證據的情況下順手按核准。
  若登入者不是 `config.chore_approver`，家事項目的主要按鈕變成**「代替 Vicky 確認」**（見 §9.5）。

---

## 7. API 規格（Apps Script）

沿用 penghu-explorer 的 `Content-Type: text/plain;charset=utf-8` 規避 CORS preflight。
所有請求帶 `token`（共享密鑰）。

所有需要身分的請求都帶 `session`（登入取得的 token）。`token` 是全站共享密鑰，`session` 才是身分。

### 7.0 登入

| action | 參數 | 回傳 |
|---|---|---|
| `login` | userId, password | `{ ok, session, expiresTs, user }` |
| `logout` | session | `{ ok }` |
| `whoami` | session | `{ ok, user }`；session 過期回邏輯 401（見 §7.4） |

登入失敗遞增 `failedCount`；達 `login_max_fail` 寫入 `lockedUntil`，鎖定期間一律拒絕。
**錯誤訊息不得區分「帳號不存在」與「密碼錯誤」。**

### 7.1 `GET ?action=snapshot&token=…&session=…`

一次回傳該畫面所需的全部資料，減少往返。**身分一律以 session 判定，不接受前端指定 kidId**
（否則 Momo 改個參數就能看 Coco 的帳）。回傳形狀依 `role` 而不同：

`role = kid`：

```json
{ "ok": true, "serverTs": "...", "rates": { "current": 0.05, "term": 0.1, "goal": 0.05, "gift": 0 },
  "user": { "userId": "momo", "role": "kid", "displayName": "Momo", "emoji": "👧" },
  "accounts": [ { "accountId": "...", "type": "current", "name": "...", "emoji": "💰",
                  "rateMonthly": 0.05, "lockUntil": null, "targetAmount": null,
                  "balance": 0, "status": "active" } ],
  "ledger":   [ /* 自己的最近 50 筆，新到舊 */ ],
  "requests": [ /* 自己的 pending */ ],
  "chores":   [ /* active 且屬於自己或公開的家事 */ ] }
```

`role = parent`：

```json
{ "ok": true, "serverTs": "...", "rates": {...},
  "user": { /* 家長自己 */ },
  "kids": [ { "user": {...}, "accounts": [...], "total": 1234 } ],
  "requests": [ /* 全家所有 pending */ ],
  "ledger":   [ /* 全家最近 50 筆，新到舊 */ ] }
```

欄位約定（前端就是照這些寫的）：

- 登入者一律放在 **`user`**（不是 `kid`）；家長的小孩清單放在 `kids`，
  每個元素是 `{ user, accounts, total }`，`total` 是該小孩所有未關閉帳戶餘額加總。
- `ledger` **新到舊**（newest-first），取最近 50 筆；小孩只看得到自己的。
- `rateMonthly` 是**小數**（5% = `0.05`），不是百分比數字。
- `lockUntil` 是 ISO 字串或 `null`；`targetAmount` 是整數或 `null`（沒設就是 `null`，不是 0）。
- `balance` 是整數元。家長端沒有 `chores`；小孩端沒有 `kids`。
- 小孩 session 打 snapshot 時，若活期／紅包帳戶還不存在會自動補建。
- 小孩端的 `requests` 除了 `pending`，還要**額外帶回「今天（或本週）已決定」的 `chore_done`**，
  含 `status` · `photoFileId` · `decidedTs` · `decidedBy` · `decidedProxy` · `decidedNote`。
  沒有這些，chores 頁畫不出「今天已回報 / 媽媽在 9/18 晚上 9:14 確認」的狀態（§6）。
- 家長端的 `requests` 帶 `photoFileId`（**不是圖片內容**，snapshot 不塞 base64）供待審清單
  延遲抓縮圖用（§7.6），並帶 `chore_approver`
  （放在頂層，值同 `config.chore_approver`），讓 admin 知道自己按下去是正式確認還是代理。

### 7.2 `POST`（body JSON）

| action | 參數 | 說明 |
|---|---|---|
| `transfer` | from, to, amount | 帳戶間轉帳，**免審，直接入帳**（見 §9.2） |
| `request` | kind, amount, choreId, note, **photo**, **photoMime** | 建立申請（僅三種 kind）。`kind = chore_done` 時 `choreId` 與 `photo`（壓縮後的 JPEG base64，不含 `data:` 前綴）**皆為必填**，並做一天一次檢查（見下） |
| `cancel_request` | requestId | 小孩自己撤回 |
| `open_account` | type, name, emoji, termMonths\|targetAmount | 開子帳戶。`termMonths` 由小孩自由填（見 §4.3），不是固定選項；**伺服器端驗證 3 ≤ termMonths ≤ 12** |
| `admin_decide` | requestId, decision, note, **proxy** | 核准/退回。家事的核准者必須是 `config.chore_approver`，其他家長要代理時必須明確帶 `proxy: true`（見下與 §9.5） |
| `admin_adjust` | kidId, accountId, amount, memo | 手動入帳/扣款/罰款 |
| `admin_gift` | kidId, amount, memo | 紅包入 `gift` |
| `admin_config` | key, value | 改 `config` 的利率等設定；改某個小孩的零用錢是改 `users.weeklyAllowance` |
| `admin_revoke_session` | token | 踢掉某台裝置 |
| `change_password` | oldPassword, newPassword | 自己改密碼 |

所有 `admin_*` 由伺服器檢查 `session.role === 'parent'`，前端不做判斷。

#### `request`（`kind = chore_done`）的伺服器端驗證

**下面每一條都在伺服器端執行，UI 的限制只是不要讓小孩白做工。**
前端是公開的，手工組一個 POST 繞過畫面是小學生也做得到的事。
驗證順序固定如下，**任何一條不過就不寫 Drive、也不寫 Sheet**：

1. **身分**：`session.role === 'kid'`，`kidId` 一律取自 session，不接受請求帶。
2. **冪等**：先查 `requests` 有沒有相同 `clientId`；有就直接回傳原本那筆，
   **不重複建檔、不重複寫 Sheet**（見 §7.3、§7.5）。
3. **家事存在**：`choreId` 要在 `chores` 且 `active = true`；
   該 chore 的 `kidId` 若非空，必須等於 session 的 kidId（別人專屬的家事不能接）。
4. **照片必填**：`photo` 缺漏、空字串、或 base64 解不開 → `ok:false, error:'photo-required'`，
   訊息「要拍一張照片才能送出喔」。`photoMime` 只接受 `image/jpeg`。
   解出來的位元組數若超過 `1.5 MB`，回 `error:'photo-too-big'`（前端壓縮過就不該發生，
   見 §7.5）；若小於 `2 KB`，同樣拒絕（黑畫面／壞檔）。
5. **一天一次**：同一個 `kidId` + `choreId`，在**同一個期間**內已經有一筆
   `status = 'pending'` 或 `status = 'approved'` 的 `chore_done` → 拒絕，
   `ok:false, error:'already-reported'`，訊息「這件家事今天已經報過了」。
   - `rejected` 與 `cancelled` **不算數**：被退回或自己撤回之後可以重報，
     否則小孩拍糊一張就整天沒得賺。
   - **期間定義（一律以 `Asia/Taipei` 計算，不用 UTC、不用瀏覽器時區）**：
     - `repeat = 'daily'`：日界線是台北時間 **00:00–23:59:59**。
       實作上比對 `Utilities.formatDate(ts, 'Asia/Taipei', 'yyyy-MM-dd')` 相等即同一天。
     - `repeat = 'weekly'`：**週日 00:00（台北）起算的七天**，與 §4.5／§9.4 的
       「週日早上＝零用錢與對帳日」對齊。比對 `yyyy-'W'ww` 不可靠（locale 週起始日不同），
       改用「把 ts 往前退到最近一個週日 00:00，比對那個日期字串」。
     - `repeat = 'once'`：全期間唯一，有任何一筆 pending/approved 就不能再報。
   - 比對用的是 `requests.ts`（伺服器寫入時間），**不是前端送的時間**。
     離線補送的照片因此算在「補送當下」那一天——這點要讓小孩知道，
     UI 在離線送出時明寫「等有網路才會送出，會算在送出那天」。
6. **寫入**：先傳照片到 Drive，再寫 `requests`（`status = 'pending'`、`photoFileId`），
   **這一步的失敗處理見 §7.5**。回傳 `{ ok:true, requestId, photoFileId }`
   （回的是檔案 ID，不是網址——檔案是 private 的，見 §5、§7.6）。

**不在這裡入帳。** `chore_done` 一律是 `pending`，錢要等 §9.5 的確認才進 `current`。

#### `admin_decide` 的核准者規則

在既有的 `session.role === 'parent'` 之上，`kind = chore_done` 多一層：

| 情況 | 行為 |
|---|---|
| `session.userId === config.chore_approver` | 正常核准，`decidedProxy = false` |
| 其他 parent，**沒帶** `proxy: true` | 拒絕：`ok:false, error:'needs-proxy'`，訊息「這件要 Vicky 確認，你可以按『代替確認』」。前端據此把按鈕換成代理按鈕，**不自動重送** |
| 其他 parent，帶 `proxy: true` | 核准，`decidedBy = session.userId`、`decidedProxy = true` |
| `role = kid` | 一律 `unauthorized`（§7.4） |
| `decision = 'reject'` | 同樣適用上述代理規則——**退回也是決定**，也要記得是誰退的 |

`proxy: true` 對 `withdraw` / `term_break` 無意義，伺服器忽略該旗標（那兩種任何家長都能決定）。

不論核准或退回，一律寫回 `decidedTs`（伺服器時間）、`decidedBy`、`decidedProxy`、`decidedNote`；
核准另外寫一筆 ledger（見 §9.5）。已經是 `approved` / `rejected` / `cancelled` 的 request
再送一次 → `ok:false, error:'already-decided'`（兩個家長同時按下去的情況，靠 §7.3 的 script lock 分出先後）。

### 7.3 冪等與並發

- **每個寫入請求必須帶 `clientId`（前端產生的 uuid）。**
  伺服器寫入前先查 `ledger` / `requests` 是否已有相同 `clientId`，有就直接回傳原結果。
  沒有這個，離線佇列重送會造成重複入帳——**這是整個系統最容易出事的地方**。
- 所有寫入以 `LockService.getScriptLock()` 包住（等待上限 15 秒，逾時回 `error:'busy'`，見 §7.4）。
  Apps Script 沒有交易，兩台手機同時送會算錯 `balanceAfter`。
- 每次寫入後重算並回寫 `accounts.balance`；提供 `admin_recalc` 從 ledger 全量重建校驗。

### 7.4 回應格式與「邏輯 401」

Apps Script 的 `ContentService` **永遠回 HTTP 200**，沒有辦法回真正的 401/403/500。
所以這套 API 的錯誤一律是 **HTTP 200 + body 裡的 `ok:false`**：

```json
{ "ok": false, "error": "unauthorized", "message": "登入過期了，請重新登入。" }
```

| `error` | 意義 | 前端該做什麼 |
|---|---|---|
| `bad-token` | 共享密鑰不對 | 設定錯誤，檢查 `js/config.js` 與 `Config.gs` |
| `unauthorized` | **邏輯 401**：沒帶 session、session 不存在、已過期、找不到帳號，或小孩打 `admin_*` | **清掉本機 session，導回登入頁**，並顯示 `message` |
| `bad-credentials` | 帳號或密碼不對（不區分哪一個） | 留在登入頁，顯示 `message` |
| `locked` | 連錯太多次被鎖 | 顯示還要等幾分鐘 |
| `busy` | `LockService` 等 15 秒仍拿不到鎖（多人同時寫入） | 不是失敗也不是成功，**請使用者過幾秒重試**；不要清 session |
| `photo-required` | 家事回報沒帶照片（或 base64 壞掉） | 回到拍照那一步，顯示「要拍一張照片才能送出喔」 |
| `photo-too-big` | 照片超過 1.5 MB（前端沒壓縮或壓縮失敗） | 重新壓縮後再送；連兩次失敗就請小孩換一張 |
| `no-such-request` | `chore_photo` 帶的 `requestId` 不存在 | 重新抓 snapshot；不要重試同一個 id |
| `not-your-photo` | 小孩想抓**別人**那筆 request 的照片（家長不受限） | 顯示「這不是你的照片」；這是越權，不是暫時性錯誤，**不要重試** |
| `photo-missing` | `photoFileId` 是空的，或 Drive 上那個檔案已被刪除／移到垃圾桶 | 顯示「照片讀不到」（不是破圖）；家長端**不要因此就順手核准** |
| `already-reported` | 這件家事在本期間已有 pending/approved | **不要重試、不要進離線佇列**，把該卡片切成「今天已回報」 |
| `needs-proxy` | 非指定核准者要核准家事，但沒按「代替確認」 | 把按鈕換成「代替 Vicky 確認」，等家長再按一次；**不自動重送** |
| `already-decided` | 這筆 request 已經被別人決定了 | 重新抓 snapshot，顯示現況 |
| `bad-json` / `unknown-action` / `server` | 請求格式錯、action 不認得、伺服器例外 | 顯示 `message`，視為暫時性錯誤 |

> 「401」在本專案一律指這個 `error: 'unauthorized'` 的 200 回應，不是 HTTP 狀態碼。
> 文件與程式碼裡寫「回 401」時都是這個意思。

### 7.5 照片上傳（base64 → Drive）

同樣的手法在 penghu-explorer 已經跑過一輪（`doPost` → `Utilities.base64Decode` →
`Utilities.newBlob` → `folder.createFile`）。這裡照抄**作法**，不共用程式碼，
而且**刻意少做最後那一步**：penghu-explorer 建完檔會 `setSharing(ANYONE_WITH_LINK, VIEW)`，
這裡**不呼叫 `setSharing`**，檔案留在擁有者的 private 資料夾（理由見 §5）。

**前端：送出前一定要壓縮。**

1. `<input type="file" accept="image/*" capture="environment">` 取得原圖
   （手機直出 3～5 MB、4000px 起跳）。
2. `createImageBitmap()` → 畫進 `<canvas>`，**最長邊縮到 1280px**（比 1280 小的不放大）。
3. `canvas.toDataURL('image/jpeg', 0.8)` → 去掉 `data:image/jpeg;base64,` 前綴，
   只送純 base64 字串。
4. 典型結果：**150～400 KB 的 JPEG，base64 後約 200～550 KB**。

> ⚠️ **這一步不是最佳化，是可行性。** Apps Script 的 `doPost` 對 POST body 有實務上限
> （大約數 MB，而且超過時的錯誤很難看懂），執行時間上限 6 分鐘，
> 而手機 4G 上傳 5 MB 本來就要十幾秒。原圖直送的結果是**小孩按下送出、轉圈、逾時、再按一次**——
> 然後 Drive 裡出現兩張照片。**壓縮失敗（canvas 例外、EXIF 方向怪、HEIC 解不開）時，
> 一律不要 fallback 成送原圖，直接請小孩重拍。**
>
> EXIF 方向要處理：iPhone 直拍的照片畫進 canvas 常常躺平。
> 用 `createImageBitmap(file, { imageOrientation: 'from-image' })`，
> 不支援的瀏覽器就接受躺平（家長看得懂就好），不要為此自寫 EXIF parser。

**後端：照片寫在 script lock 外面，Sheet 寫在裡面。**

Drive 建檔是慢動作（每張數百毫秒到數秒）。若把它包進 §7.3 的 `LockService` 區段，
全家會因為一張照片一起卡在 `busy`。所以順序是：

1. （鎖外）冪等檢查：`requests` 有沒有這個 `clientId`？有 → 直接回傳原結果，結束。
2. （鎖外）**先在 `HappyBank 家事照片/<kidId>/` 找有沒有同名檔**
   （檔名含 `clientId` 前 8 碼，見 §5）。有 → 重用它的 `fileId`，不重複建檔。
   沒有 → `Utilities.newBlob(Utilities.base64Decode(photo), 'image/jpeg', name)` → `folder.createFile(blob)`。
   **到此為止，不設任何分享權限。**
3. （鎖內）重跑一次一天一次檢查 + 冪等檢查，然後 append `requests`。

> ⚠️ **Drive 寫成功、Sheet 寫失敗怎麼辦？**
> 這個順序下，失敗的後果是 **Drive 裡多一張沒有任何 request 指向的孤兒照片**——
> 佔空間，但不會有人少拿錢、也不會有人多拿錢。這是刻意選的方向：
> **寧可多一張照片，也不要出現「Sheet 說做完了、但沒有證據」的 request。**
> 反過來（先寫 Sheet 再傳照片）會產生 `photoFileId` 空白的 pending，家長看不到證據只能盲審。
> 孤兒照片由 §7.3 的 `admin_recalc` 順便回報數量（不自動刪，見 §10）；
> 而因為檔名帶 `clientId`，離線佇列重送同一筆時會**認出既有檔案並重用**，不會越積越多。

**離線佇列**：帶照片的 `request` 一樣進 IndexedDB queue，但 base64 會讓 queue 變肥——
**單一佇列項目超過 1 MB 就不要存**，直接告訴小孩「現在沒網路，等一下有網路再報一次」。
另外 `already-reported` 與 `photo-required` 是**永久性失敗**，收到就把該項目丟出佇列，
不要無限重試（§7.4）。

### 7.6 `GET ?action=chore_photo&requestId=…&token=…&session=…`

照片是 private 的（§5），瀏覽器拿不到 Drive 檔案，**所有看圖都得經過這支代理端點**。

**授權**（順序固定，任何一條不過就不去讀 Drive）：

1. 沒帶 session／session 過期／找不到帳號 → `unauthorized`（邏輯 401，§7.4）。
2. `requestId` 查不到 → `no-such-request`。
3. `session.role === 'kid'` 時，**只能抓自己那筆**：`request.kidId !== session.kidId` → `not-your-photo`。
   `kidId` 一律取自 session，不接受請求帶（跟 §7.1、§7.2 同一條規矩）。
   `session.role === 'parent'` 可以抓任何一筆。
4. `requests.photoFileId` 為空，或 `DriveApp.getFileById()` 丟例外／檔案已在垃圾桶
   → `photo-missing`（照片被刪掉是可能發生的事，不要回 `server`）。

**回傳**：`ContentService` 只能吐文字，**沒辦法回二進位**，所以圖片一律轉 base64 包在 JSON 裡：

```json
{ "ok": true, "requestId": "...", "mime": "image/jpeg", "data": "<base64，不含 data: 前綴>" }
```

伺服器端就是 `Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes())`。
前端拿到後 `img.src = 'data:image/jpeg;base64,' + data`。

> **成本要講清楚：一張照片 = 一趟額外的 Apps Script 往返，實測體感 1～2 秒。**
> base64 還會讓傳輸量比原檔大約 1.33 倍（壓縮後 150～400 KB → 200～550 KB）。
> 所以：
> - **`snapshot` 絕對不夾帶照片**，只給 `photoFileId`。十筆待審全塞 base64 會讓登入變成十秒。
> - **家長端待審清單一律延遲載入**：先畫佔位框＋spinner，捲進畫面或點開該筆才抓（§6）。
> - **抓到的 base64 在記憶體快取到登出為止**（key 用 requestId），同一張不抓第二次；
>   **不寫進 localStorage / IndexedDB**——照片不留在裝置上是這個設計的重點之一。
> - 失敗不重試第二次以上，直接顯示「照片讀不到」。

---

## 8. 安全

### 8.1 登入與密碼

1. **密碼形式**：小孩為**固定 8 位數字**（`/^\d{8}$/`，伺服器端驗證格式）；家長為任意字串，至少 8 字元。
   8 位數字 = 1 億種組合，配合 5 次鎖定，強度足夠。對小小孩的負擔靠 UI 化解：
   大顆數字鍵盤、8 個圓點即時回填、可切換顯示，**不需要打字**。
2. **帳號存在 Sheet 的 `users` 分頁，密碼只存雜湊，不存明文。**
   Apps Script 沒有 bcrypt，採**加鹽 SHA-256 迭代**（`pbkdf_rounds` 預設 1000 次）：
   `hash = iterate(base64(SHA256(salt + ':' + password)), rounds)`。
   這道防線擋的是「不小心翻開 Sheet 看到明文密碼」，**不是**擋離線暴力破解：
   8 位數字只有 1 億種組合，拿到 `credentials` 副本的人在自己電腦上幾秒就能跑完。
   線上的 5 次鎖定對離線破解完全無效。所以 `credentials` 的存取控制（§5）才是真正的防線，
   而且**不要重用家裡其他地方的密碼**。
3. **session token 由伺服器產生**，存 `sessions` 分頁；前端放 localStorage。
   過期或被踢掉 → API 回邏輯 401（`ok:false, error:'unauthorized'`，見 §7.4）
   → 前端清除 session 並導回登入頁。
4. **密碼放在獨立的 `credentials` 分頁**，由 `setup()` 隱藏並設保護（僅擁有者可編輯）。
   保護只擋**編輯**，不擋**讀取**：被分享到這份 Sheet 的人（哪怕只是檢視者）
   都能用 建立副本／下載／Sheets API 讀走隱藏分頁，再離線爆破 8 位數字密碼。
   因此**不要把這個 Sheet 分享給任何人**——家人要看帳就發一個 `role = parent` 帳號走家長模式，
   或先把 `credentials` 移到另一份不分享的試算表（見 §5 與 §10）。
   分頁分開放的實際好處是：`users` / `ledger` 這些表被誤操作時不會波及密碼，
   以及未來真的要分享時只需搬一張表。
5. 登入失敗 5 次鎖 15 分鐘，記在 `credentials.lockedUntil`。
6. 沒有「家長 PIN」了——家長就是一個 `role = parent` 的帳號，權限一律由伺服器依 session 判定。
2. **另開一支獨立的 Apps Script 專案 + 另一組 token。**
   penghu-explorer 的 token 已經公開在 GitHub 上，不能讓它同時開得了銀行的門。
   同一個 Google 帳號，不同專案、不同密鑰。
3. Repo 為 private，但仍**假設前端所有東西都是公開的**——token 只擋隨機路人，不擋自家小孩。
   真正的防線是：所有金額變動都在伺服器端計算，前端送的只是意圖。
4. 前端**永遠不送 `balance`**，只送 `amount` 與 `accountId`，餘額由伺服器算。

---

## 9. 審核流程（方案 A：分級）✅ 已定案

`config.approval_mode = 'tiered'`

### 9.1 原則

> **跨越「真實世界」邊界的交易要家長核准；錢在體系內移動不需要核准。**

錢從現實進來（小孩聲稱做了家事）或出去（拿到真鈔）時，系統無法自行驗證，必須有人背書。
錢只是在小孩自己的帳戶之間搬動時，沒有任何東西需要驗證——而且那多半是我們想鼓勵的行為，
不該有摩擦。

### 9.2 分級表

| 動作 | 需核准 | 理由 |
|---|---|---|
| `chore_done` 回報家事完成 | ✅ **要審** | 錢從現實進來。「我倒了垃圾」只有家長能證實，這是最需要把關的一項。**必須附照片，且只有 `config.chore_approver`（或代理）能確認——細節見 §9.5** |
| `withdraw` 提領現金 | ✅ **要審** | 錢離開系統變成真鈔，家長要實際掏錢 |
| `term_break` 定存提前解約 | ✅ **要審** | 不是邊界問題，而是**打破自己的承諾**，要有人擋一下、問一句「真的嗎？」 |
| 主帳戶 → 定存／目標 | ❌ 免審 | 存錢，零摩擦鼓勵。小孩按下去就成立 |
| 紅包帳戶 → 主帳戶 | ❌ 免審 | 從 0% 搬到 5%，純粹是好事 |
| 定存到期／目標達標 → 主帳戶 | ❌ 免審 | 條件已滿足，系統自己判定得出來 |
| `open_account` 開定存／目標子帳戶 | ❌ 免審 | 開戶本身不動錢 |
| 每週零用錢、每月利息 | ❌ 免審 | 系統自動，人不該能插手 |
| 紅包入帳、罰款、手動調帳 | — | 本來就是家長自己發起的動作 |

因此 `requests.kind` 只有三種：`chore_done` · `withdraw` · `term_break`。
轉帳不進 `requests`，`transfer` 直接寫 ledger。

### 9.3 免審的代價：定存要擋一次

分級的風險是小孩一時興起把所有錢鎖進一筆長期定存，隔天想買東西才後悔。
**期數是開戶時自己填的、不是從 1/3/6 個月挑**，所以「鎖太久」比原本更容易發生——
既然不要家長核准，**摩擦就必須放在 UI 上**：

開定存的最後一步是確認頁，且必須做到——

1. 用大字寫出**解鎖日期**（「要到 2026 年 12 月 18 日才能拿出來」），不是寫「6 個月」。
   期數自由填之後這點更重要——小孩對「10 個月」沒有感覺，對「明年 7 月」才有。
2. 寫出到期金額試算（「會變成 886 元」）——把好處也講清楚，這是誘因。
3. 明寫罰則：「提前解約的話，利息全部不見。」
4. 需要**勾選**「我知道要鎖到 12/18」才能按下確認。
5. 期數選擇器本身要**限制在 3～12 個月**（見 §4.3），讓不可能的值在正常操作下根本選不到；
   伺服器端仍會再擋一次，UI 的限制只是不要讓小孩白填。

家長仍可從 admin 手動調帳救援，但那是例外處理，不是常態流程。

### 9.4 UI 影響

- 小孩端：提領／家事／解約送出後顯示「等爸爸媽媽確認中 ⏳」，可自己撤回。
  被退回時**必須看到家長寫的理由**（`decidedNote` 退回時為必填）。
- 家長端 admin 待審清單：三種 kind 混在同一條時間軸，支援逐筆核准與**全選核准**。
  首頁顯示待審數量 badge。
- **週日早上＝對帳日**：零用錢發完後，家長端 admin 首頁跳出「本週待審 ○ 件」的提醒。
  核准因此變成每週一次的固定儀式，家長不會被小孩隨時催，小孩也知道什麼時候會有答案。
  急件仍可隨時核准，只是不必天天看。
- 核准時寫 ledger，`refId` 指向 requestId；退回不寫 ledger。

### 9.5 家事：照片證據與代理確認 ✅ 已定案

家事是 §9.2 分級表裡「要審」的那一支，但它跟提領／解約有兩點不一樣：
**它需要證據**，而且**它的審核者是指定的人**。

#### 一、照片證據

- **每回報一件家事，就要拍一張照片**。沒有照片不能送出——UI 把按鈕 disable，
  伺服器再擋一次（`photo-required`，§7.2）。這是本功能的核心規則，不是加分項。
- 照片是給家長「看一眼就知道真的做了」用的，不追求畫質：壓到最長邊 1280px（§7.5）。
- 照片存 Drive、**檔案 ID** 存 `requests.photoFileId`（§5）。
  檔案是 **private 的，不對外分享**——要看圖得帶 session 走 `chore_photo`（§7.6），
  伺服器確認「你是家長，或這就是你自己那筆」才回圖。
- **待審清單看得到縮圖**（§6），只是縮圖是延遲抓進來的：先 spinner，再換成照片。
  一張多花 1～2 秒，換到的是「照片不會因為網址外流而外流」。
- **不強制照片一定拍得出家事**——會不會有小孩拍一張隨便的照片交差？會。
  這不是用程式擋的事，是家長看到爛證據就按退回、順手講一句的事。
  系統要做的只是「讓證據存在、讓家長看得到」。

#### 二、一天一次

同一件家事一天（weekly 則一週）只能報一次，**由伺服器端擋**，
期間定義與判定規則寫在 §7.2。理由很直接：不擋的話，倒一次垃圾按十次就是十倍零用錢，
而這件事小孩一定會試。只擋 UI 等於沒擋。

被退回或自己撤回的不佔扣打，可以重報——不然拍糊一張就整天沒得賺，
小孩會學到的是「系統很爛」而不是「要好好做事」。

#### 三、誰能確認

- **指定核准者是 `config.chore_approver`，預設 `vicky`（媽媽）。**
  家事是她在管，由她認定做得好不好。
- **另一位家長（Aug）可以代理**，但要**多按一次「代替確認」**：
  第一次按核准伺服器回 `needs-proxy`，UI 把按鈕換成「代替 Vicky 確認」，
  再按一次才成立（帶 `proxy: true`，§7.2）。
  這一下多出來的摩擦是刻意的——代理是例外，不該跟正常核准一樣順手。
- **為什麼不嚴格只准 Vicky**：她出差或手機沒電的那幾天，小孩的錢會全部卡住，
  等她回來一次補審。對小孩來說「做了事卻沒拿到錢」的體感就是系統壞掉。
  留一條代理路，同時把代理這件事記在紀錄上，比卡住好。
- 代理**不是偷偷來的**：`decidedProxy = true` 會寫進 request、寫進 ledger 的 `memo`，
  小孩端與交易明細都看得到「Aug 代替媽媽確認」。Vicky 回來翻明細就知道這幾天誰批了什麼。

#### 四、確認之後記錄什麼

核准時（在 §7.3 的 script lock 內，一次寫完）：

1. 更新 `requests`：`status = 'approved'`、`decidedTs`（伺服器時間）、
   `decidedBy`（**實際按的人**）、`decidedProxy`、`decidedNote`（核准時選填）。
2. 寫一筆 `ledger`：

   | 欄位 | 值 |
   |---|---|
   | `type` | `chore` |
   | `kidId` | request 的 kidId |
   | `accountId` | 該小孩的 **`current` 活期主帳戶**（§2：所有收入先進活期） |
   | `amount` | `chores.reward` 的**伺服器端查值**，正數。**不採用前端送的金額** |
   | `by` | **實際核准者的 userId**（代理時就是 `aug`，不是 `vicky`） |
   | `refId` | requestId |
   | `memo` | 「倒垃圾（9/18）」；代理時後綴「· Aug 代替 Vicky 確認」 |

3. 退回不寫 ledger，但一樣要寫 `decidedBy` / `decidedProxy` / `decidedTs`，
   `decidedNote` 退回時必填（§9.4）。

#### 五、確認時間與確認人要看得到

這是明文要求，兩個地方都要有：

- **小孩端 chores 卡片**：「✅ 媽媽在 9/18 晚上 9:14 確認 ＋10 元」。
  代理時寫「✅ 爸爸代替媽媽在 9/18 晚上 9:14 確認 ＋10 元」。
  用**稱謂**（媽媽／爸爸）不是 userId，時間用「9/18 晚上 9:14」這種小孩讀得懂的寫法，
  不要 ISO 字串。時區一律 `Asia/Taipei`。
- **history 交易明細**：`chore` 那筆列出金額、家事名稱、確認人與確認時間，
  可以點開看當時那張照片。

`chore` 是唯一一種「入帳時間」與「事情發生時間」可能差很多的收入
（週五做的家事週日才批），明細上要以**核准時間**為 ledger 的 `ts`，
但 memo 裡帶上回報日期，免得小孩對不起來。

---

## 10. 待決事項 🔴

- 小孩人數與名單、年齡（影響 UI 用字）
- 每個小孩的 `weeklyAllowance` 金額（逐人設定）
- 家事清單初始內容與定價
- 🔴 **`credentials` 的存放位置**：現在密碼雜湊與帳本同在一份 Sheet，
  隱藏 + 保護只擋編輯不擋讀取（見 §5、§8.1）。在決定前的鐵則是**這份 Sheet 不分享給任何人**；
  若之後真的需要讓家人看帳，要先把 `credentials` 搬到另一份不分享的試算表，
  或確定一律走 app 的家長模式
- 🔴 **家事照片的保存期限與 Drive 配額**：照片目前**永久留在**擁有者的 Drive，
  三個小孩 × 每天約 3 件 ≈ 一年 3000 張、以 300 KB 計約 1 GB——
  免費 15 GB 額度撐得住好幾年，但那個額度是跟 Gmail 共用的，而且沒有人會去清。
  要不要加一個「保留 N 天後自動刪除」的 trigger（刪檔但保留 `requests` 紀錄，
  讓 `chore_photo` 回 `photo-missing`、前端顯示「照片已過期」）？**還沒決定**，v1 先不刪。
  備份策略同樣未定。
- 🔴 **小孩能不能自己刪照片**：目前只能**撤回整筆 request**（照片留在 Drive 成為孤兒）。
  要不要讓撤回時連照片一起刪？好處是小孩對自己的影像有一點控制權；
  壞處是「拍到不該拍的東西 → 撤回 → 家長永遠不知道」。**還沒決定。**
- 🔴 **孤兒照片的清理**：Drive 寫成功但 Sheet 寫失敗會留下無主檔案（§7.5）。
  v1 只由 `admin_recalc` 回報數量，**不自動刪**——自動刪檔的程式不值得在這個階段信任。
- 🔴 **是否要「消費紀錄」**——提領後小孩回報實際買了什麼（教記帳，但會增加摩擦）。
  **仍在待討論**，v1 不實作、不設計資料欄位

---

## 11. 開發階段

| 階段 | 範圍 | 驗收 |
|---|---|---|
| **M1 骨架** ✅ *（差後端部署）* | Sheet 建表、Apps Script `snapshot` + `admin_adjust`、前端 home 顯示餘額 | 家長手動入帳，小孩手機看得到 |
| **M2 核心流** | 轉帳、開子帳戶（定存/目標）、交易明細 | 紅包 → 活期 → 定存 全鏈路走得通 |
| **M3 自動化** | 每週零用錢 trigger（**週日早上 8:00**，同時是對帳日，見 §9.4）、每月計息 trigger、到期提醒 | 跨月測試利息正確、定存到期轉 matured |
| **M4 審核** | requests（三種 kind）+ admin 待審清單 | 小孩申請提領 → 家長核准 → 入帳；退回看得到理由 |
| **M5 離線與韌性** | IndexedDB queue + clientId 冪等 + 快照新鮮度 | 飛航模式操作 → 復網自動補送且不重複入帳 |
| **M6 家事與獎勵（含照片）** ⬆️ *提前到 M4 之後緊接著做* | chores 清單、**拍照＋canvas 壓縮**、**Drive 照片子系統**、`request(chore_done)` 的一天一次伺服器檢查、`admin_decide` 的指定核准者與**代理確認**、確認時間／確認人顯示 | 小孩拍照回報 → Vicky（或 Aug 代理）確認 → 入活期；沒照片送不出、同一件一天報不了第二次；小孩看得到「媽媽在 X 時確認」 |

### M6 的範圍變動（2026-09-18）

原本 M6 是最後一站（「審核與家事是家長端的管理需求，可以晚一點」）。
**現在往前拉**，理由不是它比較重要，而是它現在**多了一整個子系統**：

- **照片子系統是新東西**，M1–M5 完全沒有它：前端 canvas 壓縮、base64 傳輸、
  Apps Script 的 Drive 建檔（private，不分享）、`photoFileId` 回寫、
  `chore_photo` 代理取圖端點（§7.6）與前端的延遲載入／記憶體快取、
  離線佇列的大 payload 處理（§7.5）。
  這條路 penghu-explorer 已經走通過，風險比從零設計低，但**工作量是實打實的一整塊**，
  不是在 chores 清單上加個欄位。
- **它相依於 M4**（requests + admin 待審清單）與 **M5**（clientId 冪等）。
  冪等在這裡不只是「不要重複入帳」，還是「不要在 Drive 留下重複照片」——
  沒有 M5 就做 M6，Drive 會變垃圾場。所以順序仍是 **M4 → M5 → M6**，
  M6 只是從「有空再說」變成**排定要做**。
- 誠實地說：**M6 現在是本專案最大的一個里程碑**，比 M4 大。
  照片壓縮、Drive、代理確認、一天一次的期間判定，四件事沒有一件是十行寫得完的。
  若時間不夠，可切出 **M6a（無照片的家事回報＋代理確認）**先上線，
  **M6b 補照片**——但要清楚知道 M6a 少掉的正是「證據」這個核心規則，
  上線就會有人開始亂報，所以 M6a 只適合當幾天的過渡，不適合當終點。

`config.chore_approver` 與 `requests` 的 `photoFileId` / `decidedBy` / `decidedProxy`
三個新欄位要進 `Setup.gs` 的 `SCHEMA` 與 `CONFIG_SEED`，
`setup()` 可重複執行、只補表頭，**既有資料不會動**（舊列這三欄留空即可）。

**M1 現況（2026-09-18）**：程式碼已完成，只剩把 Apps Script 部署成 Web App、
把 `/exec` 網址填進 `js/config.js` 的 `apiUrl`（步驟見 [docs/DEPLOY.md](docs/DEPLOY.md)）。

- 後端已實作：`users` · `login` · `logout` · `whoami` · `snapshot` ·
  `admin_adjust` · `admin_gift` · `admin_recalc` · `change_password`，
  加上 script lock、`clientId` 冪等、首次登入自動開 `current` / `gift` 帳戶。
- 前端已實作：登入頁（8 位數字鍵盤）、**餘額頁**（帳戶卡 + 總資產 + 離線快取）。
- **尚未實作**：M3 的兩個 time-driven trigger（每週零用錢＝週日早上 8:00、每月計息），
  以及 §7.2 的 `transfer` · `request` · `cancel_request` · `open_account` ·
  `admin_decide` · `admin_config` · `admin_revoke_session`，
  以及 M6 的照片子系統（Drive 建檔、`photoFileId`、`chore_photo` 取圖、代理確認）。
- 前端的邏輯 401 處理（收到 `error:'unauthorized'` 就清 session 導回登入頁，§7.4）已接上，
  快照快取也改成每人一個 key，避免共用平板上看到前一個人的餘額。

M1–M3 先做，因為「看到錢變多」是這個 app 唯一能讓小孩持續打開的理由。
審核與家事是家長端的管理需求，可以晚一點。
但 §9.3 的定存確認頁屬於 M2，不能延後——沒有它，免審的定存會變成客訴來源。

---

## 12. UAT 檢查清單（先列，實作時補）

- [ ] 手機直式，數字大到阿嬤也看得清楚
- [ ] 8 位數字鍵盤登入，輸滿自動送出；家長改用文字密碼欄
- [ ] 登入後看到四張帳戶卡與總資產
- [ ] 紅包從 `gift` 轉到 `current`，兩邊餘額同步正確
- [ ] 開定存時自己填期數（不是從固定選項挑），試算畫面金額與實際到期金額一致
- [ ] 提前解約 → 本金回到活期、利息歸零，明細看得到回沖那一筆
- [ ] 儲蓄目標達標 → 解鎖 + 慶祝動畫
- [ ] 轉錢進定存不需要家長核准，按下去立刻成立
- [ ] 開定存確認頁顯示「解鎖日期」大字 + 到期金額，未勾選不能按確認
- [ ] 提領／家事／解約送出後顯示「等爸爸媽媽確認中」，可自行撤回
- [ ] 家長退回申請時必須填理由，小孩看得到
- [ ] **家事沒拍照就不能送出**：送出鍵是灰的；**手工組一個沒有 `photo` 的請求送出去，伺服器回 `photo-required`**
- [ ] 手機直拍的 4000px 原圖，送出前被壓到最長邊 1280px / JPEG 0.8，實際上傳約 200～550 KB；
      iPhone 直拍不會躺平；壓縮失敗時請小孩重拍，**不會偷偷送原圖**
- [ ] **同一件 daily 家事一天報第二次被擋掉**，回 `already-reported`；
      **即使手工組請求繞過 UI 也擋得住**（日界線以 `Asia/Taipei` 00:00 計，跨午夜再報才算新的一天）
- [ ] weekly 家事在同一週內報第二次被擋掉，下個週日才解禁
- [ ] 被退回或自己撤回的家事**可以當天重報**，不佔一天一次的扣打
- [ ] 家長端待審清單看得到照片縮圖，點得開大圖；照片載不出來時顯示「照片讀不到」而不是破圖
- [ ] **照片沒有登入就看不到**：把 Drive 檔案 URL 直接貼到無痕視窗會被權限牆擋下；
      不帶 `session` 打 `chore_photo` 回 `unauthorized`
- [ ] **小孩 A 手工組一個請求去要小孩 B 的照片會被拒**（`not-your-photo`）；
      同一支端點家長抓任何一筆都拿得到
- [ ] **待審清單的縮圖延遲載入不會讓頁面卡住**：十筆待審時清單立刻畫出來（先 spinner），
      照片一張張補上；來回捲動不會重抓（記憶體快取），且照片不會被寫進 localStorage
- [ ] Drive 上的照片檔被刪掉後，該筆待審顯示「照片讀不到」（`photo-missing`），畫面不會壞掉
- [ ] Vicky 按核准 → 直接成立；**Aug 按核准 → 先被擋下並出現「代替 Vicky 確認」，再按一次才成立**
- [ ] **Aug 代理確認後，request 與 ledger 都看得出是代的**（`decidedBy = aug`、`decidedProxy = true`、
      memo 有「Aug 代替 Vicky 確認」），Vicky 事後翻明細查得到
- [ ] 小孩端看得到「✅ 媽媽在 9/18 晚上 9:14 確認 ＋10 元」，代理時寫「爸爸代替媽媽…」；
      交易明細那筆 `chore` 也看得到確認人與確認時間，並點得開當時那張照片
- [ ] 核准的金額來自伺服器查 `chores.reward`——**前端改金額送出也沒用**
- [ ] 家事獎金一律進**活期主帳戶**，不會進紅包或定存
- [ ] 兩個家長同時核准同一筆，只入帳一次，第二個收到 `already-decided`
- [ ] 飛航模式拍照回報 → 復網自動補送，**Drive 裡只有一張照片、只入帳一次**（檔名帶 `clientId`）
- [ ] 把 `config.chore_approver` 改成 `aug` → 換成 Aug 直接核准、Vicky 要按代理；
      **改設定不會讓過去那些代理紀錄變成非代理**
- [ ] 期數選擇器只給得出 3～12 個月；`open_account` 對期數小於 3 或大於 12 的請求一律拒絕，
      **即使繞過 UI 手動組請求送出也擋得住**
- [ ] 每週零用錢依各小孩的 `users.weeklyAllowance` 於**週日早上 8:00** 發放，金額可以人人不同
- [ ] 週日發完零用錢後，家長端 admin 首頁看得到「本週待審 ○ 件」提醒
- [ ] 跨月結算：活期與定存各自依正確利率複利
- [ ] 定存到期 → 停止計息 + 首頁提醒
- [ ] 飛航模式送出轉帳 → 復網自動補送，**且只入帳一次**
- [ ] Momo 登入後改 API 參數也看不到 Coco 的帳
- [ ] 小孩帳號進不了 admin（即使手動改前端）；連錯 5 次密碼被鎖 15 分鐘
- [ ] session 過期後（`ok:false, error:'unauthorized'`）自動清除並導回登入頁，不會卡在空白畫面
- [ ] 家長可在 admin 踢掉某台裝置，該裝置下次操作即失效
- [ ] 兩台手機同時操作同一帳戶，餘額不會算錯；搶不到鎖時回 `busy` 而不是寫壞資料
- [ ] Sheet 維持未分享狀態（`credentials` 只靠不分享保護，見 §5）
- [ ] session 被踢掉後的第一個動作：畫面立刻回到選頭像，並顯示伺服器給的「登入過期了，請重新登入」
- [ ] 上述情況下不會再繼續顯示舊快照，也不會跳出未處理的錯誤
- [ ] Momo 被踢掉／登出後換 Coco 登入，同一台平板看不到 Momo 的餘額（快照快取分人存）
- [ ] 伺服器忙碌（script lock 逾時）時，登入頁與首頁顯示「銀行有點忙」而不是「帳號或密碼不對」
