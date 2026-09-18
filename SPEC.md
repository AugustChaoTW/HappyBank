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
| 身分 | 首頁選「你是誰」 | 相同，另加**伺服器端驗證的家長 PIN** |
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

- 開戶時指定**期數**：1 / 3 / 6 個月 → 寫入 `lockUntil`。
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
利率與零用錢金額皆在 `config` 分頁可調，隨時可以整家調降。

---

## 5. 資料模型（Google Sheet，一分頁一表）

### `kids`
| 欄位 | 型別 | 說明 |
|---|---|---|
| kidId | string | `momo` / `coco` / `dodo` |
| name | string | 顯示名 |
| emoji | string | 👧 |
| weeklyAllowance | int | 每週零用錢金額 |
| active | bool | |

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
| kind | enum | `chore_done` / `withdraw` / `term_break` / `transfer`（是否需審見 §9） |
| amount | int\|null | |
| choreId | string\|null | |
| fromAccountId / toAccountId | string\|null | |
| note | string | 小孩自己打的理由 |
| status | enum | `pending` / `approved` / `rejected` / `cancelled` |
| decidedTs | datetime\|null | |
| decidedNote | string | 家長回覆（退回時必填，讓小孩知道為什麼） |
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
`rate_current` · `rate_term` · `rate_goal` · `rate_gift` · `allowance_weekday`（0-6）·
`parent_pin_hash` · `term_months_options` · `approval_mode`（見 §9）

---

## 6. 前端結構

```
index.html              views: home / account / chores / goal / history / admin
css/style.css           沿用 penghu-explorer 的視覺語彙（大字、大按鈕、手機直式）
js/
  config.js             apiUrl, apiToken, kids[], 預設利率（僅供離線顯示，以伺服器為準）
  api.js                取代 upload.js：GET snapshot / POST action，共用 token
  queue.js              照抄 penghu-explorer，加 clientId
  store.js              localStorage 快照 + 資料新鮮度（「更新於 ○○」）
  money.js              金額格式化、利息試算、「還要幾週」估算
  account.js            餘額頁、帳戶卡片、轉帳
  chores.js             家事清單、回報
  goals.js              開子帳戶（定存 / 目標）、進度條
  history.js            交易明細
  admin.js              家長模式：待審清單、手動調帳、設定
  app.js                路由與主流程
  version.js            照抄（footer 顯示 commit hash）
apps-script/
  Code.gs               doGet / doPost / 每月計息 trigger / 每週零用錢 trigger
  appsscript.json
data/
  (無 — 所有資料來自 API)
```

### 各 view 要點

- **home**：選「你是誰」→ 四張帳戶卡（活期 / 紅包 / 各定存 / 各目標），總資產大字，
  「這個月預計利息 ○○ 元」誘導存錢，待審/到期提醒 badge。
- **account**：單一帳戶詳情 + 轉帳 + 提領申請。
- **chores**：家事清單，點「我做完了 ✋」。
- **goals**：開新子帳戶精靈（選 定存 or 目標 → 填目的 → 選期數/目標金額 → 試算「到期會變成 ○○ 元」）。
  **試算畫面是關鍵轉換點**，要把 10% 的威力視覺化。
- **history**：全帳戶交易明細，可依帳戶篩選。
- **admin**：`?admin=1` 進入，輸 PIN，伺服器驗。待審清單一鍵核准/退回、手動調帳、改零用錢、編家事。

---

## 7. API 規格（Apps Script）

沿用 penghu-explorer 的 `Content-Type: text/plain;charset=utf-8` 規避 CORS preflight。
所有請求帶 `token`（共享密鑰）。

### 7.1 `GET ?action=snapshot&token=…&kid=…`

一次回傳該小孩畫面所需的全部資料，減少往返：

```json
{ "ok": true, "serverTs": "...", "kid": {...}, "accounts": [...],
  "ledger": [ /* 最近 50 筆 */ ], "requests": [ /* pending */ ],
  "chores": [...], "rates": {...} }
```

家長模式 `&admin=1&pin=…` 額外回傳全部小孩 + 所有 pending requests。

### 7.2 `POST`（body JSON）

| action | 參數 | 說明 |
|---|---|---|
| `transfer` | from, to, amount | 帳戶間轉帳 |
| `request` | kind, amount, choreId, note | 建立申請 |
| `cancel_request` | requestId | 小孩自己撤回 |
| `open_account` | type, name, emoji, termMonths\|targetAmount | 開子帳戶 |
| `admin_decide` | pin, requestId, decision, note | 核准/退回 |
| `admin_adjust` | pin, kidId, accountId, amount, memo | 手動入帳/扣款/罰款 |
| `admin_gift` | pin, kidId, amount, memo | 紅包入 `gift` |
| `admin_config` | pin, key, value | 改利率/零用錢/家事 |

### 7.3 冪等與並發

- **每個寫入請求必須帶 `clientId`（前端產生的 uuid）。**
  伺服器寫入前先查 `ledger` / `requests` 是否已有相同 `clientId`，有就直接回傳原結果。
  沒有這個，離線佇列重送會造成重複入帳——**這是整個系統最容易出事的地方**。
- 所有寫入以 `LockService.getScriptLock()` 包住（等待上限 10 秒）。
  Apps Script 沒有交易，兩台手機同時送會算錯 `balanceAfter`。
- 每次寫入後重算並回寫 `accounts.balance`；提供 `admin_recalc` 從 ledger 全量重建校驗。

---

## 8. 安全

1. **家長 PIN 絕不放 `config.js`。** 靜態站的 config.js 小孩點兩下就看得到。
   PIN 的雜湊只存在 Sheet 的 `config.parent_pin_hash`，前端把 PIN 隨請求送出，**由伺服器驗**。
   PIN 錯誤 5 次鎖 15 分鐘（記在 Script Properties）。
2. **另開一支獨立的 Apps Script 專案 + 另一組 token。**
   penghu-explorer 的 token 已經公開在 GitHub 上，不能讓它同時開得了銀行的門。
   同一個 Google 帳號，不同專案、不同密鑰。
3. Repo 為 private，但仍**假設前端所有東西都是公開的**——token 只擋隨機路人，不擋自家小孩。
   真正的防線是：所有金額變動都在伺服器端計算，前端送的只是意圖。
4. 前端**永遠不送 `balance`**，只送 `amount` 與 `accountId`，餘額由伺服器算。

---

## 9. 待決事項 🔴

### 9.1 審核流程（**尚未決定，開工前必須拍板**）

候選方案：

| 方案 | 內容 | 代價 |
|---|---|---|
| A. 分級 | 錢離開系統才要核准：提領現金、提前解約 → 要審；主帳戶轉進定存/目標 → 免審（鼓勵存錢）；家事 → 待定 | 家長按的次數少，但小孩可能亂開定存 |
| B. 家事信任 + 事後撤銷 | 回報家事立刻入帳，admin 頁顯示「待確認」，7 天內可一鍵撤銷 | 回饋最即時，靠事後問責 |
| C. 全部要審 | 家事、提領、轉帳、解約一律進待審 | 帳最乾淨，家長要養成每天開 admin 的習慣 |
| D. 週結 | 申請排隊，週末發零用錢時一次批核（支援全選） | 儀式感好，但小孩要等最多 7 天 |

此決定會影響 `requests.kind` 有哪些、`config.approval_mode` 的值，以及 admin 頁的設計。

### 9.2 其他待確認

- 小孩人數與名單（沿用 penghu-explorer 的 momo / coco / dodo？年齡各多少，影響 UI 用字）
- 每週零用錢預設金額、發放日（星期幾）
- 家事清單初始內容與定價
- 定存期數選項（1 / 3 / 6 個月？月息 10% 下，6 個月 = 本金 ×1.77）
- 是否要「消費紀錄」——提領後小孩回報實際買了什麼（教記帳，但會增加摩擦）

---

## 10. 開發階段

| 階段 | 範圍 | 驗收 |
|---|---|---|
| **M1 骨架** | Sheet 建表、Apps Script `snapshot` + `admin_adjust`、前端 home 顯示餘額 | 家長手動入帳，小孩手機看得到 |
| **M2 核心流** | 轉帳、開子帳戶（定存/目標）、交易明細 | 紅包 → 活期 → 定存 全鏈路走得通 |
| **M3 自動化** | 每週零用錢 trigger、每月計息 trigger、到期提醒 | 跨月測試利息正確、定存到期轉 matured |
| **M4 審核** | requests + admin 頁（依 §9.1 決議實作） | 小孩申請提領 → 家長核准 → 入帳 |
| **M5 離線與韌性** | IndexedDB queue + clientId 冪等 + 快照新鮮度 | 飛航模式操作 → 復網自動補送且不重複入帳 |
| **M6 家事與獎勵** | chores 清單、回報流程 | 小孩回報 → 依審核模式入帳 |

M1–M3 先做，因為「看到錢變多」是這個 app 唯一能讓小孩持續打開的理由。
審核與家事是家長端的管理需求，可以晚一點。

---

## 11. UAT 檢查清單（先列，實作時補）

- [ ] 手機直式，數字大到阿嬤也看得清楚
- [ ] 選小孩 → 看到四張帳戶卡與總資產
- [ ] 紅包從 `gift` 轉到 `current`，兩邊餘額同步正確
- [ ] 開一筆 3 個月定存，試算畫面金額與實際到期金額一致
- [ ] 提前解約 → 本金回到活期、利息歸零，明細看得到回沖那一筆
- [ ] 儲蓄目標達標 → 解鎖 + 慶祝動畫
- [ ] 跨月結算：活期與定存各自依正確利率複利
- [ ] 定存到期 → 停止計息 + 首頁提醒
- [ ] 飛航模式送出轉帳 → 復網自動補送，**且只入帳一次**
- [ ] 小孩裝置輸錯 PIN 進不了 admin；連錯 5 次被鎖
- [ ] 兩台手機同時操作同一帳戶，餘額不會算錯
