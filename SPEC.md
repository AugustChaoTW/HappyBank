# 🏦 HappyBank — 小孩零用錢虛擬銀行

開發規格 v0.1 · 2026-09-18

給家裡小孩用的零用錢銀行。核心教育目標不是「記帳」，而是讓小孩**親手感受到流動性的代價**：
錢放在活期會慢慢變多、隨時可以動；鎖進定存會變多很多——但鎖了就拿不出來。

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
差別只在四個欄位：利率、能不能領、有沒有目標金額、**能不能轉帳**。

| type | 顯示名稱 | 月利率 | 提領 | 目的欄位 | 每人數量 |
|---|---|---|---|---|---|
| `current` | 💰 活期主帳戶 | **5%** | 隨時（走提領申請） | 免填 | 1，自動建立 |
| `term` | 🔒 定存 | **10%** | **到期前不可**（可解約，見 §4.3） | **必填** | 不限 |
| `goal` | 🎯 儲蓄目標 | **5%** | 達標後才能領 | **必填 + 目標金額** | 不限 |
| `gift` | 🧧 阿公阿嬤的錢 | **0%** | **只能領現金（要核准）** | 免填 | 1，自動建立 |

> 🧧 **`gift` 不參與轉帳。** 它**不能轉出**到 `current` / `term` / `goal`，
> 其他帳戶也**不能轉入**它。錢進去只有一條路（家長 `admin_gift` 紅包入帳），
> 出去也只有一條路（小孩申請提領現金，走 §9.2 的 `withdraw` 核准流程）。
> 利率固定 **0%**——它是**純保管帳戶**：「媽媽幫你保管的紅包錢」，
> 和零用錢經濟（`current` / `term` / `goal`）是分開的兩本帳。

### 教學核心：利率是流動性的價格

> **整個 app 的教學核心是一個選擇：把錢留在活期 5%，還是鎖進定存 10%。**

活期隨時能動，所以只給 5%；定存要到期才能拿，所以給 10%。
多出來的那 5% 不是天上掉下來的，是**小孩用「這幾個月不能動它」換來的**。
小孩要親手決定鎖多少、鎖多久（期數自己填，見 §4.3），
然後在月底看兩張卡片長出不一樣的數字——這就是整堂課。
想反悔就得走解約（§4.3），利息歸零、還要家長點頭（§9.2），
代價是真的會痛，但不會沒收本金。

紅包帳戶**不在這堂課裡**，也不該被拿來當教材。它是保管箱，不是投資選項：
錢進去、錢原封不動地領出來，中間不長大也不會少。
「阿公給你的錢，媽媽幫你收好」本身就是完整的解釋，
不需要再附一句「不過你應該把它搬去活期」。

### 資金流向規則

- **所有收入一律先進 `current`**：每日零用錢、家事獎金、利息（完整清單見下方「活期的錢怎麼變多」）。
- 子帳戶只能從 `current` 轉入，也只能轉回 `current`。子帳戶之間不能直接轉。
- **紅包直接進 `gift`，而且只能從 `gift` 領現金出去。**
  `gift` 不能轉去任何帳戶，任何帳戶也不能轉進 `gift`（見上表的說明與 §7.2）。
- 真實現金提領一律從 `current` 或 `gift` 出去，兩者都要核准（§9.2）。

```
      家事 ──┐   （兩條都要拍照 ＋ 媽媽確認）
  每日簽到 ──┼──▶ 💰 current (5%) ◀──▶ 🔒 term (10%)  到期前鎖死
      利息 ──┘          │            ◀──▶ 🎯 goal (5%)  達標前鎖死
                        │              （→ 存入本金；← 轉回本金＋利息）
            提領現金 ◀──┘

    紅包入帳 ──▶ 🧧 gift (0%) ──▶ 提領現金
                （純保管，不與上面任何帳戶互轉）
```

### 活期的錢怎麼變多（唯一的四條路）

> **這是本規格對「小孩的活期主帳戶（活錢）要怎麼變多」的唯一答案。**
> `current` 的餘額**只有下面四種情形會增加**，沒有第五種。

| # | 來源 | 誰觸發 | 怎麼發生 | ledger `type` |
|---|---|---|---|---|
| 1 | **每日零用錢** | 小孩每天簽到 → 家長確認 | **不是自動發的，每天要走一次流程才領得到**：小孩在 app 裡勾完三個自我檢核項目（`config.daily_checklist`）、拍一張照片、送出，經 `chore_approver`（預設 Vicky，或代理）確認後入帳。**金額由伺服器查 `users.dailyAllowance`**（逐人設定，目前三人都是 20，§5），前端送的數字不採用。**當天沒送出就沒了，不能補領昨天的**（§9.6） | `allowance` |
| 2 | **家事獎金** | 小孩回報 → 家長確認 | 回報家事**＋照片**，經 `chore_approver`（預設 Vicky，或代理）確認後入帳；**金額由伺服器查 `chores.reward`**，前端改金額沒用（§9.5） | `chore` |
| 3 | **從定存或目標子帳戶轉回活期** | 小孩自己 | 到期、提前解約、或目標達標後，把**本金加上已累積的利息**轉回活期。免審，按下去就成立（§9.2）。解約的話利息已先被回沖（§4.3） | `transfer_in` |
| 4 | **利息** | 系統自動 | 活期本身**月息 5% 複利**，**每月 1 日 00:30** 結算（§4.1） | `interest` |

> 📌 **第 3 條就是「從其他帳戶轉入」的全部。** 小孩名下除了 🧧 `gift` 之外，
> **只有 `term`（定存）與 `goal`（目標）兩種子帳戶**，而且子帳戶之間不能互轉（見上面的資金流向規則）。
> 所以「從其他帳戶轉入活期」和「從子帳戶把錢移出來」講的是**同一條路**，不是兩條——
> **沒有第五條**。

**不是來源的（最容易誤會的一條）：**

> 🧧 **紅包帳戶的錢進不了活期。** `gift` 是**純保管帳戶**，一進一出：
> 錢從家長的 `admin_gift` 進去，只能以**領現金**的方式出來（要核准，§9.2）。
> 它不能轉出到 `current` / `term` / `goal`，任何帳戶也不能轉進它——
> 伺服器端直接拒絕（§7.2 `gift-no-transfer`）。**紅包不會讓活期變多，一毛都不會。**

另外，家長的手動調帳（`admin_adjust`，ledger `type = adjust`）與罰款（`penalty`）
確實也會動到活期餘額，但那是**修正錯帳與管教用的例外處理**，
不是常態收入來源，不列入上面四條，也不該拿來對小孩解釋「錢怎麼變多」。

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
利率在 `config` 分頁可調（整家一起）；**每日零用錢則是逐個小孩設定**，
存在 `users.dailyAllowance`（見 §5），可以依年齡給不同金額，沒有全家共用的單一數字
（目前三人剛好一律 20，但那是三筆各自獨立的資料，不是一個共用設定）。

#### 改成每日 20 元之後的實際數字 ✅ 已定案（2026-09-18）

原本的設計是「每週日自動發 20 元」。**現在改成每天走一次簽到流程才領得到 20 元**（§9.6），
金額沒變、頻率變成七倍。這件事對家裡的現金流不是小數目，下面把它算清楚：

| 項目 | 舊設計（每週 20，自動發） | 新設計（每日 20，要簽到） |
|---|---|---|
| 一人一年零用錢 | 1,040 元 | **7,300 元**（365 天全勤上限） |
| 三個小孩一年 | 3,120 元 | **21,900 元** |
| 一人一年利息（全存活期不花） | 404 元 | **2,855 元** |
| 一人一年後活期餘額 | 1,444 元 | **10,155 元** |
| 第一次結息（滿一個月時） | +4 元 | **+31 元** |

> 計算方式：從 1 月 1 日起每天入帳 20 元，每月 1 日 00:30 以**結算當下餘額**計息
> （§4.1、§4.2），`Math.round` 不足 1 元記 0（§3），連續 12 次結息。
> 三人金額相同，所以三條線一模一樣；三人一年後活期合計 **30,465 元**。
> 7,300 是**全勤上限**——漏簽一天就少 20 元，實際會低於這個數。

> 💰 **這是已經決定的預算，不再討論。** 家庭真實現金支出從一年 3,120 元變成
> **21,900 元**（多 18,780 元），是七倍。使用者的判斷是「不用管錢的問題，因為小孩會領出來花掉」——
> 錢不會一直躺在活期滾，上面那個 10,155 元是「完全不花」的理論上限，不是真的要準備的數字。
> 這裡把數字寫下來只是為了誠實，**不是要重開這個決定**。
>
> 順帶一提，這個改動**順手解掉了 §10 的冷啟動問題**：第一次結息從 +4 元變成 **+31 元**，
> 本金一個月就站上 620 元，§2 的「活期 5% vs 定存 10%」那堂課終於演得出來。

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
| dailyAllowance | int | **每日零用錢金額，逐人設定**（parent 為 0）。這是每個小孩的固定參數，不在 `config`，改某個小孩不影響其他人。**欄位原名 `weeklyAllowance`，2026-09-18 原位改名**——位置沒動（第 5 欄），既有資料不會錯位 |
| active | bool | 停用後無法登入 |
| lastLoginTs | datetime | |

#### 每日零用錢金額 ✅ 已定案（2026-09-18，當日修訂）

| 小孩 | 每日零用錢 |
|---|---|
| Momo | **20** |
| Coco | **20** |
| Dodo | **20** |

> 三個小孩**一律每天 20**。數字沒變，**變的是頻率與取得方式**：
> 從「每週日自動發 20」改成「**每天走一次簽到流程才領得到 20**」（規則全文見 §9.6，
> 預算試算見 §4.5）。20 這個數字本身**取代同日稍早暫定的 Momo 20 / Coco 15 / Dodo 10**，
> 而那組數字又取代更早的全家一律 50；不分年齡給同一個數字，家裡比較不會吵。
>
> ⚠️ **欄位仍然是逐人設定的**：`dailyAllowance` 存在每一列 `users` 上，
> 三個人**今天剛好相等**，不代表它變成全家共用的單一設定。
> 核准入帳時伺服器是**逐個小孩**讀自己那一列的金額（§9.6），
> 隨時可以只改其中一個人，不影響另外兩個。
>
> **這些值是資料，不是程式碼**：存在 `users.dailyAllowance` 欄位，
> 直接在 Sheet 的 `users` 分頁改即可（`Setup.gs` 的 `upsertUser()` helper 也寫得動，
> 但它會**連帶重設該帳號的密碼**，所以只有「金額和密碼一起換」時才用它）。
> 改完即時生效，不需要重新部署。家長端 admin 也改得動（§6）。
>
> ⚠️ **欄位改名要在 `SCHEMA` 原位改**：`users` 的第 5 欄由 `weeklyAllowance` 改叫
> `dailyAllowance`，**位置不動**。`setup()` 只重寫表頭那一列、不搬動資料，
> 所以原位改名不會讓既有三列錯位；把它刪掉再接到最後面則會。
>
> ⚠️ **線上 Sheet 的那三格現在的值是舊的（每週制的殘留），必須手動改成 20。**
> 以前的紀錄說是 50；不論現在顯示什麼，都要**親自打開 `users` 分頁確認並改成 20**。
> **不要為了改金額重跑 `seedUsers()`**——`upsertUser()` 會重新產生 salt 與密碼雜湊，
> 等於把大家的密碼洗回 `CHANGE-ME`。

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
`allowance`（每日零用錢，走每日簽到核准後入帳，§9.6）· `chore`（家事獎金）· `interest`（利息）· `interest_reversal`（解約回沖）·
`gift_in`（紅包）· `withdraw`（領現金）· `transfer_in` / `transfer_out`（帳戶間轉帳，成對）·
`penalty`（罰款）· `adjust`（家長手動調整）

### `requests`
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | uuid |
| ts | datetime | |
| kidId | string | |
| kind | enum | `chore_done` / **`allowance_claim`** / `withdraw` / `term_break`（見 §9.2；轉帳免審，不進本表） |
| amount | int\|null | |
| choreId | string\|null | `kind = allowance_claim` 時固定為空（每日簽到不對應任何一件家事） |
| fromAccountId / toAccountId | string\|null | |
| note | string | 小孩自己打的理由 |
| status | enum | `pending` / `approved` / `rejected` / `cancelled` |
| decidedTs | datetime\|null | |
| decidedBy | string\|null | **實際按下核准／退回的人的 userId**。原本只記時間不記人，代理確認就查不出是誰決定的（見 §9.5） |
| decidedProxy | bool | 是否為代理確認（核准者不是 `config.chore_approver`）。**寫入當下就記死，不要事後用 `decidedBy !== config.chore_approver` 推導**——`chore_approver` 一旦改過，歷史紀錄就會說謊 |
| decidedNote | string | 家長回覆（退回時必填，讓小孩知道為什麼） |
| photoFileId | string\|null | 照片在 Google Drive 的 **檔案 ID**（不是網址，見下方「家事照片」）。`kind = chore_done` 與 `kind = allowance_claim` **皆必填**；照片二進位內容不進 Sheet。要看圖一律走 `GET ?action=chore_photo`（§7.6） |
| clientId | string | 冪等鍵 |
| checklist | string\|null | **`kind = allowance_claim` 專用**，記錄當天勾了什麼。格式：`項目1=1\|項目2=1\|項目3=1`，用 `\|` 分隔、與 `config.daily_checklist` **同一個順序**，值只有 `1`（伺服器只收全勾，見 §7.2）。存**當下的項目文字**而不是索引，這樣家長事後增刪項目也查得回「那天勾的是哪三件事」。其他 kind 留空 |

> ⚠️ **上表是「有哪些欄位」，不是 Sheet 的欄位順序。**
> `Setup.gs` 的 `SCHEMA.requests` 才是順序的唯一定義，而且新欄位**一律接在最後面**：
> 現有順序是 `… decidedNote, clientId, photoFileId, decidedBy, decidedProxy`，
> **`checklist` 要接在 `decidedProxy` 之後**，成為最後一欄。
> 理由是 `setup()` 只重寫表頭那一列、不搬動任何資料——把新欄位插在中間，
> 既有的每一列都會默默錯位一格（舊的 `clientId` 會突然被讀成 `checklist`）。

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
`daily_checklist`（見下）·
`session_days_kid` · `session_hours_parent` · `login_max_fail` · `login_lock_minutes` · `pbkdf_rounds` ·
`approval_mode`（固定 `tiered`，見 §9）· `kid_password_digits`（8）·
`chore_approver`（預設 `vicky`）

> 這裡**沒有**每日零用錢金額（在 `users.dailyAllowance`，逐人設定），
> 也**沒有**定存期數的固定選項——期數是開戶時自由填的，只受 `term_months_min` /
> `term_months_max` 上下限約束，由伺服器端 `open_account` 把關（見 §4.3、§9.3）。
>
> ❌ **`allowance_weekday` 與 `allowance_hour` 已移除。** 每週日早上 8:00 自動發零用錢的
> time-driven trigger 不存在了（§9.6）。`CONFIG_SEED` 裡那兩列一併刪掉；
> 線上 `config` 分頁若已經有這兩列，留著不會有人讀，但建議手動刪掉免得誤導。

#### `daily_checklist`：每日簽到的三個自我檢核項目

預設值（用 `|` 分隔，**不含空白**）：

```
好好照顧自己|尊重別人的需求|完成自己的工作
```

- **項目存在 `config`，不寫死在程式裡。** 伺服器端的驗證規則是
  「**送來的勾選數量等於設定的項目數，而且每一項都為真**」（§7.2），
  **不是**「等於 3」。所以家長之後想加第四項、或砍到兩項，
  改這一格就好，前後端都不用改程式、不用重新部署。
- 分隔字元固定 `|`；項目文字本身不得含 `|`（伺服器 split 後對每段 `trim()`，空段捨棄）。
- 讀出來若是空字串或 split 後一項都不剩，視為**設定錯誤**：
  `request(kind='allowance_claim')` 一律回 `ok:false, error:'server'`，
  **不要靜默 fallback 成「不用勾也能領」**（同 `chore_approver` 的處理方式）。
- 改項目**不影響已經送出的紀錄**：`requests.checklist` 存的是當下的項目文字（見上表），
  歷史紀錄不會因為家長改設定而說謊。

`chore_approver` 是**家事回報的指定核准者**，值是一個 `role = parent` 的 userId，預設 `vicky`。
另一位家長仍然可以核准，但必須走「代理確認」（見 §9.5）。把它放進 `config` 是為了
「媽媽長期出差／換人管家事」時改一格就好，不用改程式碼。
伺服器端讀到的值若不是一個存在且 `active` 的 parent，視為設定錯誤，
`admin_decide` 對 `chore_done` 一律回 `ok:false, error:'server'`（不要靜默 fallback 成「誰都能核准」）。

### 家事照片（Google Drive，不進 Sheet）

> 📸 **每日簽到的照片走完全同一條路。** 下面每一條規則對 `kind = chore_done` 與
> `kind = allowance_claim` 一體適用——同一個資料夾、同一個檔名規則、同樣不 `setSharing`、
> 同樣只能經 `chore_photo`（§7.6）取圖。
> **資料夾名稱維持「HappyBank 家事照片」不改**，免得既有檔案要搬家；
> 名字有點窄，但那是可以接受的小瑕疵。
> 每日簽到的照片在檔名裡以 **`allowance`** 佔掉 `<choreId>` 的位置，
> 例如 `20260918-allowance-1a2b3c4d.jpg`，一眼分得出是哪一種。

照片是資料模型的一部分，只是不存在 Sheet 裡。作法沿用 penghu-explorer 的
「手機照片 → base64 → Apps Script → Drive」那條路（同樣的手法，不是同一份程式碼——兩個 repo 刻意不共用）。

- **位置**：Apps Script 以 `DriveApp` 在擁有者雲端硬碟根目錄下建
  `HappyBank 家事照片/<kidId>/`，資料夾不存在就建（`getOrCreatePath`，可重複執行）。
- **檔名**：`<yyyyMMdd>-<choreId>-<clientId 前 8 碼>.jpg`
  （日期取 `Asia/Taipei`；每日簽到的 `<choreId>` 固定寫 `allowance`）。
  帶 `clientId` 是為了離線佇列重送時**認得出同一張照片**，
  不會在 Drive 裡留下一堆重複檔（見 §7.5）。
  實作上沿用既有的 `savePhoto(kidId, choreId, clientId, bytes)`，
  每日簽到就是把第二個參數傳 `'allowance'`，**不要另外寫一支**。
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
  每日簽到也是**一天一張**，不是「一個項目一張」。

> **還留著的三件事（不是風險警告，是誠實的現況）：**
> 照片**永久留在 Drive**，v1 沒有自動刪除；
> **Apps Script 的執行身分讀得到全部照片**（代理取圖就是用這個身分去讀的），
> 所以「誰看得到」最終等於「誰能存取那個 Google 帳號與那支 Apps Script」；
> **備份與刪除策略仍未定**，列在 §10。

---

## 6. 前端結構

```
index.html              views: login / home / daily / account / chores / goal / history / admin
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
  daily.js              每日簽到：三個勾選項目、拍照、送出、當天狀態（§9.6）
  photo.js              拍照＋canvas 壓縮＋照片縮圖延遲載入與記憶體快取，
                        chores.js 與 daily.js 共用（§7.5、§7.6）
  chores.js             家事清單、回報、拍照與壓縮（canvas → JPEG base64，見 §7.5）
  goals.js              開子帳戶（定存 / 目標）、進度條
  history.js            交易明細
  admin.js              家長模式：待審清單（含照片縮圖，兩種 kind 混排）、代理確認、手動調帳、設定
  app.js                路由與主流程
  version.js            照抄（footer 顯示 commit hash）
apps-script/
  Config.gs             SHEET_ID / TOKEN（同專案共用全域範圍，只能宣告一次）
  Code.gs               doGet / doPost / 登入 / snapshot / 家長操作 / 密碼雜湊
                        （每月計息 trigger 屬 M3，尚未實作；
                         零用錢沒有 trigger 了，走 request/admin_decide，見 §9.6）
  Setup.gs              建分頁與種子資料、建帳號（只在編輯器手動執行）
data/
  (無 — 所有資料來自 API)
```

### 各 view 要點

- **login**：點自己的大頭像 → 跳出 8 顆圓點與大顆數字鍵盤，輸滿 8 碼自動送出。
  家長頭像則切換成一般密碼輸入框。
- **home**：登入後直接進來 → 四張帳戶卡（活期 / 紅包 / 各定存 / 各目標），總資產大字，
  「這個月預計利息 ○○ 元」誘導存錢，待審/到期提醒 badge。

  **最上面是每日簽到卡**（小孩端，`role = kid` 才有），在帳戶卡之前——
  它是每天打開 app 的第一個理由，不能藏在分頁裡：
  - 今天還沒送 → 大字「今天的 20 元還沒領 👉」，點進 daily view。
  - 今天已送、等確認 → 「⏳ 等媽媽確認 20 元」+ 送出時間。
  - 今天已入帳 → 「✅ 今天的 20 元領到了」+ 確認人與確認時間。
  - 被退回 → 「❌ 退回：⟨理由⟩，可以重做一次」，**當天仍可重送**（§9.6）。
  文案只講「今天」，**不要出現「昨天沒領」之類的提示**——沒領到就是沒領到，
  補不回來，提醒一次就夠了，不需要天天鞭屍（§9.6）。
- **daily**：每日簽到頁（小孩端）。畫面由上到下就三段：
  1. **三個大勾選框**，文字來自 `config.daily_checklist`（伺服器 snapshot 帶下來，
     §7.1），**不要寫死在前端**——家長改設定，這裡就要跟著變。
     項目數也不要寫死成 3，照著陣列長度畫。
  2. **拍照區**：全部勾滿才亮起來，流程與 chores 完全一樣（`capture="environment"`
     → canvas 壓縮 → 預覽 + 重拍，§7.5）。
  3. **送出**：**少勾一項就 disabled、沒照片也 disabled**；伺服器端還會再擋兩次
     （`checklist-incomplete` / `photo-required`，§7.2）。
  送出後整頁換成「⏳ 等媽媽確認」狀態卡，可撤回；撤回或被退回都能當天重來。
  頁尾一行小字寫今天的日期（`Asia/Taipei`）與「今天沒送出就沒有囉」，
  不要倒數計時——那只會製造焦慮。

  **🧧 紅包卡是特例**：它不是投資選項，卡片語氣要誠實而溫暖，
  **不要有任何叫小孩把錢搬走的行動呼籲**。
  - 副標文案：**「這是媽媽幫你保管的錢」**（不再寫「這裡的錢不會長大，搬去活期才會 →」）。
  - 需要時可再加一行小字：「要用的時候可以跟媽媽領現金」。
  - **卡片上不出現「轉帳」按鈕**（其他帳戶卡有）。紅包卡唯一的動作是「領現金」，
    導到提領申請（§9.2 的 `withdraw`）。
  - 利率欄位照實寫 **0%**，不加註解、不引導。
- **account**：單一帳戶詳情 + 轉帳 + 提領申請。
  **`type === 'gift'` 的帳戶頁不渲染轉帳區塊**，只留交易明細與「領現金」；
  即使前端被改過，伺服器也會回 `gift-no-transfer`（§7.2）。
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
  待審清單一鍵核准/退回、手動調帳、**逐個小孩改每日零用錢**（`users.dailyAllowance`）、
  **改每日簽到的項目**（`config.daily_checklist`）、編家事、看 `sessions` 踢掉裝置。

  **待審清單要分得出兩種 kind**，不能混成一團看不出誰是誰：
  - 每一筆前面掛一個明顯的類型標記——每日簽到 `🌞 每日簽到`、家事 `🧹 <家事名稱>`。
  - **每日簽到那筆要把勾選內容攤開**（讀 `requests.checklist`，三個項目逐條列出來打勾），
    媽媽要看的是「他說他做到了什麼」＋照片，不是一個光禿禿的「簽到」兩個字。
  - **金額顯示也不同**：家事是 `chores.reward`，每日簽到是該小孩的 `users.dailyAllowance`。
    兩者都由伺服器算，前端只是顯示。
  - **支援「按類型全選」**：「全部核准今天的每日簽到（3 筆）」是週日對帳日最常按的一顆鈕（§9.4）。
    全選核准仍然逐筆走 `admin_decide`，代理規則一樣要過（§9.5）。
  **兩種待審項目都各有一張照片縮圖**：照片是 private 的，`<img>` 不能直接指向 Drive，
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
  "requests": [ /* 自己的 pending，外加今天/本期間已決定的 chore_done 與 allowance_claim */ ],
  "chores":   [ /* active 且屬於自己或公開的家事 */ ],
  "dailyChecklist": [ "好好照顧自己", "尊重別人的需求", "完成自己的工作" ],
  "dailyAllowance": 20,
  "today": "2026-09-18" }
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
- 小孩端的 `requests` 除了 `pending`，還要**額外帶回「今天（或本週）已決定」的 `chore_done`
  與「今天已決定」的 `allowance_claim`**，
  含 `status` · `photoFileId` · `decidedTs` · `decidedBy` · `decidedProxy` · `decidedNote`，
  `allowance_claim` 另帶 `checklist`。
  沒有這些，chores 頁與 daily 頁畫不出「今天已回報 / 媽媽在 9/18 晚上 9:14 確認」的狀態（§6）。
- `dailyChecklist` 是**陣列**，由伺服器把 `config.daily_checklist` 以 `|` split 後 trim 而成
  （順序即顯示順序）。前端照著它畫勾選框，**項目文字與項目數都不寫死**（§6）。
  家長端不需要這個欄位，但 admin 的「改項目」表單要用，所以 `role = parent` 也一起帶。
- `dailyAllowance` 是該小孩自己那一列的金額（整數元），**只供顯示**；
  真正入帳的金額是核准當下伺服器再查一次的值（§9.6）。
- `today` 是伺服器以 `Asia/Taipei` 算出的今天（`yyyy-MM-dd`）。
  前端**不要拿裝置時間判斷「今天有沒有簽到」**——小孩把手機時間調前一天就能多領一次，
  日界線一律以伺服器為準。
- 家長端的 `requests` 帶 `photoFileId`（**不是圖片內容**，snapshot 不塞 base64）供待審清單
  延遲抓縮圖用（§7.6），並帶 `chore_approver`
  （放在頂層，值同 `config.chore_approver`），讓 admin 知道自己按下去是正式確認還是代理。
  `kind = allowance_claim` 那幾筆另外帶 `checklist`（原字串，前端自己 split 攤開）
  與 `amount`（伺服器從該小孩的 `users.dailyAllowance` 帶的顯示值），
  否則待審清單畫不出「他勾了哪三項、這筆是多少錢」（§6）。
  頂層另帶 `dailyChecklist` 供 admin 的設定表單用。

### 7.2 `POST`（body JSON）

| action | 參數 | 說明 |
|---|---|---|
| `transfer` | from, to, amount | 帳戶間轉帳，**免審，直接入帳**（見 §9.2）。**`from` 或 `to` 任一方 `type === 'gift'` 一律拒絕**（見下） |
| `request` | kind, amount, choreId, note, **photo**, **photoMime**, **checks** | 建立申請（僅四種 kind）。`kind = chore_done` 時 `choreId` 與 `photo`（壓縮後的 JPEG base64，不含 `data:` 前綴）**皆為必填**，並做一天一次檢查（見下）。`kind = allowance_claim` 時 `checks` 與 `photo` **皆為必填**，並做一天一次檢查（見下） |
| `cancel_request` | requestId | 小孩自己撤回 |
| `open_account` | type, name, emoji, termMonths\|targetAmount | 開子帳戶。`termMonths` 由小孩自由填（見 §4.3），不是固定選項；**伺服器端驗證 3 ≤ termMonths ≤ 12** |
| `admin_decide` | requestId, decision, note, **proxy** | 核准/退回。家事的核准者必須是 `config.chore_approver`，其他家長要代理時必須明確帶 `proxy: true`（見下與 §9.5） |
| `admin_adjust` | kidId, accountId, amount, memo | 手動入帳/扣款/罰款 |
| `admin_gift` | kidId, amount, memo | 紅包入 `gift` |
| `admin_config` | key, value | 改 `config` 的利率、`daily_checklist` 等設定；改某個小孩的零用錢**不走這支**，是改 `users.dailyAllowance`（走 `admin_set_allowance`） |
| `admin_set_allowance` | kidId, amount | 改某個小孩的 `users.dailyAllowance`（整數、0 ≤ amount ≤ 1000）。**只改設定，不入帳** |
| `admin_revoke_session` | token | 踢掉某台裝置 |
| `change_password` | oldPassword, newPassword | 自己改密碼 |

所有 `admin_*` 由伺服器檢查 `session.role === 'parent'`，前端不做判斷。

#### `transfer` 的伺服器端限制：`gift` 不參與轉帳

寫 ledger 之前，伺服器先讀出 `from` 與 `to` 兩個帳戶的 `type`。
**只要其中任何一方是 `gift`（不分方向），就拒絕**：
`ok:false, error:'gift-no-transfer'`，訊息「紅包錢是媽媽幫你保管的，不能搬到別的帳戶喔」。
不寫 ledger、不動餘額。

**這條檢查在伺服器端，不是只把按鈕藏起來。** 前端是公開的，
DevTools 打開就能手工組一個 `{"action":"transfer","from":"<gift 帳戶>","to":"<活期>"}` 送出去；
UI 不給轉帳按鈕（§6）只是不要讓小孩白試，真正擋下來的是這裡。
`gift` 帳戶的錢要出來只有一條路：`request(kind='withdraw')` 領現金，走 §9.2 的核准流程。

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
     - `repeat = 'weekly'`：**週日 00:00（台北）起算的七天**，與 §9.4 的
       「週日早上＝對帳日」對齊（對帳日已與發薪脫鉤，§9.6）。比對 `yyyy-'W'ww` 不可靠（locale 週起始日不同），
       改用「把 ts 往前退到最近一個週日 00:00，比對那個日期字串」。
     - `repeat = 'once'`：全期間唯一，有任何一筆 pending/approved 就不能再報。
   - 比對用的是 `requests.ts`（伺服器寫入時間），**不是前端送的時間**。
     離線補送的照片因此算在「補送當下」那一天——這點要讓小孩知道，
     UI 在離線送出時明寫「等有網路才會送出，會算在送出那天」。
6. **寫入**：先傳照片到 Drive，再寫 `requests`（`status = 'pending'`、`photoFileId`），
   **這一步的失敗處理見 §7.5**。回傳 `{ ok:true, requestId, photoFileId }`
   （回的是檔案 ID，不是網址——檔案是 private 的，見 §5、§7.6）。

**不在這裡入帳。** `chore_done` 一律是 `pending`，錢要等 §9.5 的確認才進 `current`。

#### `request`（`kind = allowance_claim`）的伺服器端驗證

每日簽到**刻意跟家事共用同一套機具**：同一支 `request`、同一條 Drive 照片路徑（§7.5）、
同一個 `clientId` 冪等、同一套 `admin_decide` 核准者與代理規則（§9.5 三）。
下面只列出不一樣的地方；沒列到的就是跟 `chore_done` 一字不差。
驗證順序固定如下，**任何一條不過就不寫 Drive、也不寫 Sheet**：

1. **身分**：`session.role === 'kid'`，`kidId` 一律取自 session，不接受請求帶。
2. **冪等**：先查 `requests` 有沒有相同 `clientId`；有就直接回傳原本那筆。
3. **項目設定**：讀 `config.daily_checklist`，以 `|` split、逐段 `trim()`、捨棄空段，
   得到項目陣列 `items`。`items.length === 0` → `ok:false, error:'server'`，
   訊息「每日簽到的項目還沒設定好，請家長檢查」。**不要 fallback 成「不用勾也能領」。**
4. **三項全勾**（真正的新規則）：請求帶 `checks`，是一個**布林陣列**。
   - `checks` 不是陣列、或 `checks.length !== items.length`
     → `ok:false, error:'checklist-incomplete'`。
   - 其中**任何一項不為真**（`false` / 缺漏 / 空字串 / `0`）
     → 同樣 `checklist-incomplete`，訊息「三件事都要做到才能領今天的零用錢喔」
     （訊息裡的「三」依 `items.length` 動態產生，家長改成四項時要跟著變）。
   - 判定條件是**「數量等於設定的項目數且全為真」**，**不是寫死比對 3**——
     這樣家長增減項目不必改程式（§5 `daily_checklist`）。
   - 只接受全勾，所以 `requests.checklist` 寫入時每一項的值必然是 `1`；
     格式見 §5，存的是**當下的項目文字**，不是索引。
5. **照片必填**：與 `chore_done` 第 4 條完全相同（`image/jpeg`、上限 1.5 MB、
   下限 2 KB、base64 解不開就算沒照片）。
6. **一天一次**：同一個 `kidId`，在**同一個台北日**內已經有一筆
   `status = 'pending'` 或 `status = 'approved'` 的 `allowance_claim` → 拒絕，
   `ok:false, error:'already-claimed'`，訊息「今天的零用錢已經送出囉」。
   - 期間判定**沿用 `chorePeriodKey(repeat, ts)` 的 `daily` 規則**（`repeat` 傳 `'daily'`），
     也就是比對 `Utilities.formatDate(ts, 'Asia/Taipei', 'yyyy-MM-dd')` 相等即同一天。
     不用 UTC、不用瀏覽器時區。
   - **不比對 `choreId`**（每日簽到沒有 choreId，一天就一筆，跟家事那條的
     「kidId + choreId」不同）。
   - `rejected` 與 `cancelled` **不算數**：被退回或自己撤回之後**當天還可以重送**。
     這一條很重要——不然媽媽退回一次，小孩就永遠拿不到那天的 20 元（§9.6）。
   - 比對用的是 `requests.ts`（伺服器寫入時間），**不是前端送的時間**。
     離線補送因此算在「補送當下」那一天，可能就跨過午夜變成隔天的簽到——
     UI 在離線送出時必須明寫「等有網路才會送出，會算在送出那天」（§7.5）。
7. **寫入**：先傳照片到 Drive（檔名的 `<choreId>` 位置寫 `allowance`，§5），
   再寫 `requests`（`status = 'pending'`、`photoFileId`、`checklist`、
   `choreId` 留空、`amount` 留空）。失敗處理見 §7.5。
   回傳 `{ ok:true, requestId, photoFileId }`。

**不在這裡入帳，也不在這裡決定金額。** `allowance_claim` 一律是 `pending`；
金額要等核准當下伺服器查 `users.dailyAllowance` 才算（§9.6），
**請求帶的 `amount` 一律忽略**（跟家事不採信前端金額是同一個道理）。

#### `admin_decide` 的核准者規則

在既有的 `session.role === 'parent'` 之上，`kind = chore_done`
**與 `kind = allowance_claim`** 多一層（兩者規則**完全一樣**，
下表的 `chore_done` 一律連同 `allowance_claim` 一起讀）：

| 情況 | 行為 |
|---|---|
| `session.userId === config.chore_approver` | 正常核准，`decidedProxy = false` |
| 其他 parent，**沒帶** `proxy: true` | 拒絕：`ok:false, error:'needs-proxy'`，訊息「這件要 Vicky 確認，你可以按『代替確認』」。前端據此把按鈕換成代理按鈕，**不自動重送** |
| 其他 parent，帶 `proxy: true` | 核准，`decidedBy = session.userId`、`decidedProxy = true` |
| `role = kid` | 一律 `unauthorized`（§7.4） |
| `decision = 'reject'` | 同樣適用上述代理規則——**退回也是決定**，也要記得是誰退的 |

`proxy: true` 對 `withdraw` / `term_break` 無意義，伺服器忽略該旗標（那兩種任何家長都能決定）。
`config.chore_approver` 這個 key **名字沒改**（值仍預設 `vicky`），但它現在管的是
**家事＋每日簽到兩件事**——名字有點窄，不值得為了改名去動既有設定與程式（§9.6）。

核准 `allowance_claim` 時另外多一條伺服器端檢查：**金額不採信任何前端輸入**，
一律查該小孩的 `users.dailyAllowance`。查不到、非數字、或 ≤ 0
→ `ok:false, error:'zero-amount'`，訊息「這個小孩的每日零用錢還沒設定，請家長先去設定」，
**不寫 ledger、request 維持 `pending`**（不要核准一筆 0 元的帳）。

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
| `gift-no-transfer` | `transfer` 的來源或目的地是 `gift` 帳戶（紅包不參與轉帳，§7.2） | 顯示「紅包錢是媽媽幫你保管的，不能搬到別的帳戶喔」；這是規則，不是暫時性錯誤，**不要重試、不要進離線佇列** |
| `photo-required` | 家事回報沒帶照片（或 base64 壞掉） | 回到拍照那一步，顯示「要拍一張照片才能送出喔」 |
| `photo-too-big` | 照片超過 1.5 MB（前端沒壓縮或壓縮失敗） | 重新壓縮後再送；連兩次失敗就請小孩換一張 |
| `no-such-request` | `chore_photo` 帶的 `requestId` 不存在 | 重新抓 snapshot；不要重試同一個 id |
| `not-your-photo` | 小孩想抓**別人**那筆 request 的照片（家長不受限） | 顯示「這不是你的照片」；這是越權，不是暫時性錯誤，**不要重試** |
| `photo-missing` | `photoFileId` 是空的，或 Drive 上那個檔案已被刪除／移到垃圾桶 | 顯示「照片讀不到」（不是破圖）；家長端**不要因此就順手核准** |
| `already-reported` | 這件家事在本期間已有 pending/approved | **不要重試、不要進離線佇列**，把該卡片切成「今天已回報」 |
| `checklist-incomplete` | 每日簽到的勾選項目沒有全部勾滿（或數量與 `config.daily_checklist` 不符） | 回到勾選那一步，顯示 `message`（「三件事都要做到才能領今天的零用錢喔」）。**不要重試、不要進離線佇列**；若是數量不符，順手重抓 snapshot 更新項目清單 |
| `already-claimed` | 今天的每日零用錢已經送出過（同一台北日已有 pending/approved 的 `allowance_claim`） | **不要重試、不要進離線佇列**，把簽到卡切成「⏳ 等媽媽確認」或「✅ 今天領到了」 |
| `zero-amount` | 核准時查 `users.dailyAllowance`（或 `chores.reward`）是 0／沒設定 | 家長端顯示 `message`，請先去設定金額再核准；該筆維持 `pending` |
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
另外 `already-reported`、`already-claimed`、`checklist-incomplete` 與 `photo-required`
是**永久性失敗**，收到就把該項目丟出佇列，不要無限重試（§7.4）。

> ⚠️ **每日簽到特別不適合離線送。** 「當天沒送出就沒了」的判定用的是 `requests.ts`
> （伺服器寫入時間，§9.6），所以晚上 11:55 離線送出、12:05 才復網補送的那一筆
> **會算成隔天的簽到**——昨天就此落空，而且隔天還會因為已經有一筆而回 `already-claimed`。
> 所以每日簽到頁在偵測到離線時**要直接明講**：
> 「現在沒網路，等一下有網路才會送出，會算在真正送出去的那一天。」
> 不要靜靜地丟進佇列讓小孩以為領到了。

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
| `allowance_claim` 每日簽到領零用錢 | ✅ **要審** | 錢從現實進來。「我今天有好好照顧自己」同樣只有家長能證實。**三項全勾＋一張照片才送得出，核准者規則與家事完全相同——細節見 §9.6** |
| `withdraw` 提領現金（從 `current` **或 `gift`**） | ✅ **要審** | 錢離開系統變成真鈔，家長要實際掏錢。**紅包帳戶唯一的出口就是這一條** |
| `term_break` 定存提前解約 | ✅ **要審** | 不是邊界問題，而是**打破自己的承諾**，要有人擋一下、問一句「真的嗎？」 |
| 主帳戶 → 定存／目標 | ❌ 免審 | 存錢，零摩擦鼓勵。小孩按下去就成立 |
| 🧧 紅包帳戶 ↔ 任何帳戶 | **不存在這個動作** | `gift` 是純保管帳戶，不參與轉帳；伺服器直接拒絕（§7.2 `gift-no-transfer`） |
| 定存到期／目標達標 → 主帳戶 | ❌ 免審 | 條件已滿足，系統自己判定得出來 |
| `open_account` 開定存／目標子帳戶 | ❌ 免審 | 開戶本身不動錢 |
| 每月利息 | ❌ 免審 | 系統自動，人不該能插手 |
| 紅包入帳、罰款、手動調帳 | — | 本來就是家長自己發起的動作 |

因此 `requests.kind` 有**四種**：`chore_done` · `allowance_claim` · `withdraw` · `term_break`。
轉帳不進 `requests`，`transfer` 直接寫 ledger。

> 📌 **零用錢從「系統自動」那一列搬到「要審」那一列了。** 舊版這張表寫的是
> 「每週零用錢、每月利息 ❌ 免審 — 系統自動，人不該能插手」。
> 零用錢改成每日簽到制之後（§9.6），它變成**跨越現實邊界的收入**，
> 性質跟家事一樣，所以進了核准流程。**只有利息還留在「系統自動、人不該能插手」那一格。**

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
- 家長端 admin 待審清單：四種 kind 混在同一條時間軸，支援逐筆核准、**按類型全選**與**全選核准**；
  每一筆前面掛類型標記，每日簽到那筆要攤開勾選內容（§6）。首頁顯示待審數量 badge。
- **週日早上＝對帳日（保留）**：家長端 admin 首頁跳出「本週待審 ○ 件」的提醒，
  核准變成每週一次的固定儀式，家長不會被小孩隨時催，小孩也知道什麼時候會有答案。
  急件仍可隨時核准，只是不必天天看。

  > ⚠️ **對帳日不再跟發薪綁在一起。** 舊版寫的是「零用錢發完後……」——
  > 每週日早上 8:00 自動發零用錢的 trigger 已經移除（§9.6），
  > 週日早上現在**沒有任何系統動作**，對帳日純粹是家長自己的習慣與 UI 提醒。
  > 概念保留，是因為**家事仍然需要它**（weekly 家事的期間也是以週日 00:00 起算，§7.2）。

  > 📊 **量要先算清楚：三個小孩 × 每天一筆 = 每週 21 筆每日簽到**，再加上家事
  > （以每人每天 1～3 件估，一週再多 20～60 筆）。**週日一次批 21 筆是可行的**——
  > 每筆就是「看一眼照片、掃一眼三個勾、按核准」，配上「按類型全選」大約幾分鐘的事。
  > 但**這個量級本身是新的**：舊設計的零用錢是 0 筆待審（系統自動發），
  > 現在是每週 21 筆、一年約 1,095 筆。清單的分頁、全選、照片延遲載入（§6）
  > 不是加分項，是這個量級下的**必要條件**。
  >
  > ⏱️ **但「攢到週日一起批」跟「當天沒領就沒了」會撞在一起**——
  > 小孩禮拜二送出、媽媽禮拜天才批，那 20 元到底算不算禮拜二領到的？
  > **這一題 §9.6「三、送出日 vs 核准日」已經明文裁決：以送出時間為準。**
  > 不寫清楚的話，這是家裡第一場吵架。
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

`chore` 與 `allowance_claim` 是「入帳時間」與「事情發生時間」可能差很多的兩種收入
（週五做的家事週日才批），明細上要以**核准時間**為 ledger 的 `ts`，
但 memo 裡帶上回報日期，免得小孩對不起來。

### 9.6 每日零用錢：每天走一次流程才領得到 ✅ 已定案（2026-09-18）

> **每天在 app 裡勾完三個自我檢核項目 → 拍一張照片 → 送出 → 媽媽確認 → 20 元進活期主帳戶。**
> 沒有自動發放，沒有補領。

這一節取代舊設計的「每週日早上 8:00 由 time-driven trigger 自動入帳」。
那個 trigger **不存在了**，`config.allowance_weekday` / `allowance_hour` 也一併移除（§5）。
零用錢從「系統自動、人不該能插手」變成「跨越現實邊界、要家長背書」的一筆收入（§9.2）。

#### 一、三個自我檢核項目

| # | 項目 |
|---|---|
| 1 | 好好照顧自己 |
| 2 | 尊重別人的需求 |
| 3 | 完成自己的工作 |

- **三項都要勾才能送出。** 少一項就送不出去——UI 把送出鍵 disable，
  伺服器再擋一次（`checklist-incomplete`，§7.2）。
  **沒有「勾兩項領 13 元」這種部分給付**，這不是計件工資，是一個全有全無的每日約定。
- **項目存在 `config.daily_checklist`，不寫死在程式裡**（格式與預設值見 §5）。
  伺服器的驗證條件是「**勾選數量等於設定的項目數，且全部為真**」，不是比對 3，
  所以家長之後想加第四項或砍到兩項，改 `config` 一格就好，前後端都不用動。
- **勾選內容要留痕**：寫進 `requests.checklist`（§5），存的是**當下的項目文字**。
  家長事後改設定，歷史紀錄仍然查得出「那天他勾的是哪三件事」。
- 這三句話是**自我檢核**，不是家事。它們刻意寫得抽象、無法用照片證明——
  照片不是證據，是**儀式**（見下）。

#### 二、拍照

- **跟家事一樣要拍一張照片**：同一條 Drive 路徑、同一個資料夾、同樣不 `setSharing`、
  同樣只能經 `chore_photo`（§7.6）看圖。技術細節全部在 §5 與 §7.5，這裡不重複。
- **一天一張**，不是一個項目一張。
- 誠實地說：**這張照片證明不了「我有尊重別人的需求」**。它的作用有兩個——
  一是讓「送出」這件事有實體動作、不是無腦按鈕；
  二是給媽媽一個開口的機會（「你今天拍這個，是哪件事做得好？」）。
  **不要在 UI 上宣稱照片是證據**，也不要為此發明一套「該拍什麼」的規則。
  拍得敷衍就退回、順口講一句——跟家事一樣，這是人的事，不是程式的事（§9.5 一）。

#### 三、送出日 vs 核准日 ⚖️ 本節最重要的一條

> **以 `requests.ts`（小孩按下送出、伺服器寫進 Sheet 的那一刻）認定是哪一天的簽到。
> 核准時間（`decidedTs`）不影響資格，媽媽多久才批都不影響那 20 元的歸屬。**

會有這一題，是因為「當天沒領就沒了」配上「要媽媽確認」必然撞在一起：
小孩禮拜二晚上送出，媽媽禮拜天對帳日（§9.4）才批——這算不算禮拜二領到？
**算。** 具體規則：

1. **資格看送出日。** `already-claimed` 的一天一次判定比對的是 `requests.ts`，
   用 `chorePeriodKey('daily', ts)`（台北 00:00–23:59:59，§7.2）。
2. **`pending` 不會過期。** 禮拜二送出的那一筆，禮拜天批下去照樣入帳 20 元，
   **不會因為「已經不是禮拜二了」就自動作廢**。系統沒有任何一支程式會去砍舊的 pending。
3. **ledger 的 `ts` 仍是核准時間**（與家事一致，§9.5 五），
   但 **`memo` 必須帶上簽到日期**：「每日簽到（9/15）」。
   禮拜天入帳六筆、memo 分別寫 9/15 到 9/20，小孩才對得起來。
4. **「沒領到」只有一種情況：那天根本沒送出。** 不是「送了但媽媽還沒批」。
5. **被退回 / 自己撤回，當天還能重送**（`rejected` / `cancelled` 不佔扣打，§7.2）。
   但**跨過午夜就真的沒了**：禮拜二被退回、禮拜三才重做，那筆算禮拜三的，
   禮拜二就是空的。這一條要在退回通知裡講清楚：「今天還可以再做一次喔」。
6. **不能補領昨天的。** 沒有任何一支 API 接受「指定日期」的簽到，
   `requests.ts` 一律是伺服器時間、由伺服器寫，前端送什麼時間都不看。
   離線佇列補送因此可能跨到隔天——UI 要事先明講（§7.5）。

> 這條裁決的理由：**小孩能控制的只有「有沒有送出」，媽媽什麼時候有空批不是他的責任。**
> 反過來（以核准日認定）等於媽媽出差三天就扣三天零用錢，
> 而 §9.5 三已經為了同一個理由留了代理確認那條路。同一套價值觀，兩處一致。

#### 四、確認之後記錄什麼

核准時（在 §7.3 的 script lock 內，一次寫完），與家事同一支 `admin_decide`：

1. 更新 `requests`：`status = 'approved'`、`decidedTs`（伺服器時間）、
   `decidedBy`（**實際按的人**）、`decidedProxy`、`decidedNote`（核准時選填）。
2. 寫一筆 `ledger`：

   | 欄位 | 值 |
   |---|---|
   | `type` | `allowance` |
   | `kidId` | request 的 kidId |
   | `accountId` | 該小孩**目前 `status = 'active'` 的 `current` 活期主帳戶**（§2：所有收入先進活期） |
   | `amount` | **伺服器查該小孩自己的 `users.dailyAllowance`**，正數。**不採用前端送的數字**；查不到或 ≤ 0 就不核准（`zero-amount`，§7.2） |
   | `by` | **實際核准者的 userId**（代理時就是 `aug`，不是 `vicky`） |
   | `refId` | requestId |
   | `clientId` | `req:<requestId>`（一筆 request 只入得了一次帳，兩個家長搶著按也一樣） |
   | `memo` | 「每日簽到（9/15）」；代理時後綴「· Aug 代替 Vicky 確認」 |

3. 退回不寫 ledger，但一樣要寫 `decidedBy` / `decidedProxy` / `decidedTs`，
   `decidedNote` 退回時必填（§9.4），而且小孩要看得到那句理由。

#### 五、誰能確認

**與家事完全相同**，一字不差：指定核准者是 `config.chore_approver`（預設 `vicky`），
其他家長要代理就得多按一次「代替確認」（先收 `needs-proxy`，再帶 `proxy: true`），
代理會寫進 `decidedProxy` 與 ledger 的 `memo`。細節見 §9.5 三，這裡不重複。

`config` 的 key 名字仍叫 `chore_approver`（沒有另開一個 `allowance_approver`）——
它現在管兩件事。名字窄了一點，但多一個 key 就多一個會忘記改的地方，不划算。

#### 六、量與預算（已決定，不再討論）

- **三個小孩 × 每天一筆 = 每週 21 筆待審、一年約 1,095 筆**，再加上家事。
  對帳日的負荷評估見 §9.4。
- **每人每天 20 元 = 一年 7,300 元（365 天全勤上限），三人 21,900 元**
  ——舊設計（每週 20）是三人一年 3,120 元。完整試算與「全存活期會滾到多少」見 §4.5。
- 這個預算變動**使用者已明確接受**（「不用管錢的問題，因為小孩會領出來花掉」），
  **記錄在案，不重開討論**。

---

## 10. 待決事項 🔴

- 小孩人數與名單、年齡（影響 UI 用字）
- ~~每個小孩的 `weeklyAllowance` 金額（逐人設定）~~ ✅ **已定案**：欄位改名為 `dailyAllowance`，
  三人一律**每天 20**，且**要每天走一次簽到流程才領得到**（§9.6；欄位仍逐人可調，見 §5）
- 家事清單初始內容與定價
- ✅ ~~**冷啟動：頭幾個月「錢不會變多」的風險（開帳金？）**~~
  **改成每日 20 元之後大致解掉了，不再列為待決事項。**
  以每天入帳 20 元、每月 1 日以結算當下餘額計息、`Math.round` 不足 1 元記 0（§3）
  計算，**只靠零用錢、完全不花錢**存滿一年（365 天全勤、12 次結息）。
  三人金額相同，所以三條線完全一樣：

  | 小孩 | 每日 | 一年零用錢 | 一年利息 | 一年後活期餘額 | **第一次結息** |
  |---|---|---|---|---|---|
  | Momo | 20 | 7,300 | 2,855 | **10,155** | **+31 元** |
  | Coco | 20 | 7,300 | 2,855 | **10,155** | **+31 元** |
  | Dodo | 20 | 7,300 | 2,855 | **10,155** | **+31 元** |

  （舊設計每週 20 的同一張表是：一年 1,040 元、利息 404 元、期末 1,444 元、第一次結息 **+4 元**。）

  **第一次結息從 +4 元變成 +31 元**，滿一個月時本金就有 620 元——
  這個高度利息才「看得見」，§2 的「活期 5% vs 定存 10%」那堂課也終於演得出來
  （620 元鎖三個月 = 變成 825 元，數字大到有感）。
  第一個月仍然是 0 元利息（一個月才結一次，這是規則），但那只有一個月，
  而且那個月裡小孩每天都會因為簽到看到餘額 +20，**不缺打開 app 的理由**。
  **因此「開帳金」暫時不需要**；真的想加速也還是走 `admin_adjust`，
  **不是**把紅包帳戶打開來充數（§2、§7.2）。
- 🔴 **`credentials` 的存放位置**：現在密碼雜湊與帳本同在一份 Sheet，
  隱藏 + 保護只擋編輯不擋讀取（見 §5、§8.1）。在決定前的鐵則是**這份 Sheet 不分享給任何人**；
  若之後真的需要讓家人看帳，要先把 `credentials` 搬到另一份不分享的試算表，
  或確定一律走 app 的家長模式
- 🔴 **照片的保存期限與 Drive 配額**（量因為每日簽到又變大了）：照片目前**永久留在**擁有者的 Drive。
  家事：三個小孩 × 每天約 3 件 ≈ 一年 3,000 張。
  **每日簽到再加 3 人 × 365 天 = 一年 1,095 張**，合計約 **4,095 張／年**、
  以 300 KB 計約 **1.2 GB／年**——
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
| **M2 核心流** | 轉帳、開子帳戶（定存/目標）、交易明細 | 活期 → 定存／目標 → 回活期 全鏈路走得通；紅包帳戶的轉帳一律被伺服器擋下 |
| **M3 自動化** | **每月計息 trigger**、到期提醒 | 跨月測試利息正確、定存到期轉 matured |
| **M4 審核** | requests（四種 kind）+ admin 待審清單（兩種要審的 kind 要分得出來） | 小孩申請提領 → 家長核准 → 入帳；退回看得到理由 |
| **M5 離線與韌性** | IndexedDB queue + clientId 冪等 + 快照新鮮度 | 飛航模式操作 → 復網自動補送且不重複入帳 |
| **M6 家事與獎勵（含照片）** ⬆️ *提前到 M4 之後緊接著做* | chores 清單、**拍照＋canvas 壓縮**、**Drive 照片子系統**、`request(chore_done)` 的一天一次伺服器檢查、`admin_decide` 的指定核准者與**代理確認**、確認時間／確認人顯示 | 小孩拍照回報 → Vicky（或 Aug 代理）確認 → 入活期；沒照片送不出、同一件一天報不了第二次；小孩看得到「媽媽在 X 時確認」 |
| **M7 每日簽到零用錢** 🆕 | daily view（三個勾選項目來自 `config.daily_checklist`）、`request(allowance_claim)` 的全勾＋照片＋一天一次驗證、核准入帳 `users.dailyAllowance`、admin 待審清單分辨兩種 kind 與按類型全選、home 的簽到卡（§9.6） | 三項全勾＋拍照才送得出；同一天送第二次回 `already-claimed`；媽媽（或代理）確認後 20 元進活期；**禮拜二送出、禮拜天才批，memo 仍寫「每日簽到（9/15）」且照樣入帳** |

> ⚙️ **M7 幾乎不需要新機具。** 照片、`clientId` 冪等、台北日界線（`chorePeriodKey`）、
> `admin_decide` 的核准者與代理規則，M5／M6 全部做完了——
> M7 就是「多一種 `kind`、多一個勾選 UI、金額改查 `users.dailyAllowance`」。
> 所以順序是 **M4 → M5 → M6 → M7**；反過來先做 M7 會等於把 M6 的東西再做一次。
> 唯一真正的新東西是**待審量級**（每週 21 筆，§9.4），那是 UI 問題不是後端問題。

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

### M7 帶進來的 schema 異動（2026-09-18）

改 `Setup.gs` 時三件事一起做，**順序與位置都不能隨便**：

1. **`SCHEMA.users` 的第 5 欄原位改名**：`weeklyAllowance` → `dailyAllowance`。
   **位置不動**（還是第 5 欄）。`setup()` 只重寫表頭那一列，所以原位改名安全；
   刪掉再接到最後面則會讓既有三列錯位。
   `upsertUser()` 的第六個參數與 `seedUsers()` 的註解跟著改名，數值仍是 `20`。
2. **`SCHEMA.requests` 最後面接一欄 `checklist`**（接在 `decidedProxy` 之後），
   理由與 `photoFileId` 那三欄相同——插在中間會讓既有每一列默默錯位一格（§5）。
3. **`CONFIG_SEED`**：刪掉 `allowance_weekday` 與 `allowance_hour` 兩列，
   新增 `['daily_checklist', '好好照顧自己|尊重別人的需求|完成自己的工作', '每日簽到的自我檢核項目，| 分隔']`。
   `seedTable()` 以第一欄為鍵、已存在的鍵不動，所以**新增那列會補進去、刪掉的那兩列不會自動消失**——
   線上 `config` 分頁的舊兩列要**手動刪**（留著也沒人讀，只是會誤導）。

⚠️ **另外要手動做的一件事**：線上 `users` 分頁那三格的值是舊的（每週制的殘留），
**必須手動改成 20**，不要為此重跑 `seedUsers()`（會洗掉密碼，見 §5）。

### 待處理的程式碼異動

- 🔴 **`SCHEMA.users` 的 `weeklyAllowance` 要原位改名成 `dailyAllowance`**，
  `SCHEMA.requests` 要在最後補 `checklist`，`CONFIG_SEED` 要刪兩列、加 `daily_checklist`——
  三件事的細節見上面「M7 帶進來的 schema 異動」。
- ✅ **`seedUsers()` 的三個數值仍是 `20`，不用改**（改的是欄位名與語意：每週 → 每天）。
  但它只影響「從零建帳號」那一次：**線上 `users` 分頁那三格是舊值，還沒改成 20**，
  正確做法是**直接在 Sheet 改那一欄**，**不要重跑 `seedUsers()`**
  （`upsertUser()` 會重產 salt 與密碼雜湊，把密碼洗掉）。
- ❌ **每週零用錢的 time-driven trigger 不用寫了**（原本掛在 M3）。
  若之前已經在 Apps Script 專案裡建過這支 trigger，**要去「觸發條件」頁面手動刪掉**——
  程式碼刪了，trigger 還在的話會每週日 8:00 噴一次執行失敗信。

**M1 現況（2026-09-18）**：程式碼已完成，只剩把 Apps Script 部署成 Web App、
把 `/exec` 網址填進 `js/config.js` 的 `apiUrl`（步驟見 [docs/DEPLOY.md](docs/DEPLOY.md)）。

- 後端已實作：`users` · `login` · `logout` · `whoami` · `snapshot` ·
  `admin_adjust` · `admin_gift` · `admin_recalc` · `change_password`，
  加上 script lock、`clientId` 冪等、首次登入自動開 `current` / `gift` 帳戶。
- 前端已實作：登入頁（8 位數字鍵盤）、**餘額頁**（帳戶卡 + 總資產 + 離線快取）。
- **尚未實作**：M3 的 time-driven trigger（**每月計息**；每週零用錢那支已取消，見 §9.6），
  以及 §7.2 的 `transfer` · `request` · `cancel_request` · `open_account` ·
  `admin_decide` · `admin_config` · `admin_set_allowance` · `admin_revoke_session`，
  M6 的照片子系統（Drive 建檔、`photoFileId`、`chore_photo` 取圖、代理確認），
  以及 M7 的每日簽到（`request(allowance_claim)`、daily view、`config.daily_checklist`）。
- 前端的邏輯 401 處理（收到 `error:'unauthorized'` 就清 session 導回登入頁，§7.4）已接上，
  快照快取也改成每人一個 key，避免共用平板上看到前一個人的餘額。

M1–M3 先做，因為「看到錢變多」是這個 app 唯一能讓小孩持續打開的理由。
審核與家事是家長端的管理需求，可以晚一點。

> ⚠️ **但零用錢改成每日簽到之後，這個排序有一個代價要先知道：M7 上線之前，
> 小孩的活期沒有任何一條自動收入。** 舊設計至少每週日會自動進 20 元，
> 現在那支 trigger 沒了、而 M7 排在最後——中間這段期間只能靠家長用
> `admin_adjust` 手動補（M1 已經有這支）。這不是設計缺陷，是排程的副作用，
> 但**不要讓小孩在這段期間打開一個永遠 0 元的 app**：
> 要嘛家長天天用 `admin_adjust` 手動補，要嘛把 **M6 + M7 一起往前拉**。
> **不能只把 M7 抽出來提前**——它的照片流程整包來自 M6（§7.5、§7.6），
> 抽掉 M6 就等於要在 M7 裡把同樣的東西再寫一次。
但 §9.3 的定存確認頁屬於 M2，不能延後——沒有它，免審的定存會變成客訴來源。

---

## 12. UAT 檢查清單（先列，實作時補）

- [ ] 手機直式，數字大到阿嬤也看得清楚
- [ ] 8 位數字鍵盤登入，輸滿自動送出；家長改用文字密碼欄
- [ ] 登入後看到四張帳戶卡與總資產
- [ ] **手工組請求把 `gift` 當來源或目的地的轉帳會被伺服器拒絕**（`gift-no-transfer`，兩邊餘額都不動）；
      **紅包卡上沒有轉帳按鈕**；**從 `gift` 提領現金仍然走核准流程**
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
- [ ] **每日簽到：三項全勾才送得出**——少勾一項送出鍵是灰的；
      **手工組一個只勾兩項的請求送出去，伺服器回 `checklist-incomplete`**
- [ ] **每日簽到沒拍照就不能送出**：送出鍵是灰的；手工組沒有 `photo` 的請求回 `photo-required`
- [ ] 三個勾選項目的**文字與數量來自 `config.daily_checklist`**，不是寫死的：
      把該格改成四項，daily view 立刻變成四個框，**且只勾三項會被伺服器擋下**（不用改程式、不用重新部署）
- [ ] 把 `config.daily_checklist` 清空 → `request(allowance_claim)` 回 `server`，
      **不會變成「不用勾也能領」**
- [ ] **同一天送第二次被擋掉**，回 `already-claimed`；**繞過 UI 手工組請求也擋得住**
      （日界線以 `Asia/Taipei` 00:00 計，跨午夜才算新的一天）
- [ ] 每日簽到被退回或自己撤回後**當天可以重送**；**跨過午夜就重送不了「昨天」那一筆**
- [ ] 核准後 **20 元進活期主帳戶**，金額來自 `users.dailyAllowance`——
      **前端把 amount 改成 200 送出也沒用**；把某個小孩的金額改成 30，只有他變 30
- [ ] `users.dailyAllowance` 沒設定或為 0 時核准 → 回 `zero-amount`，**不寫 ledger、該筆維持 pending**
- [ ] **禮拜二送出、媽媽禮拜天才批 → 照樣入帳 20 元**，ledger 的 `ts` 是禮拜天、
      但 memo 寫「每日簽到（9/15）」；**pending 不會因為過了那天就作廢**
- [ ] 「沒領到」只在「那天根本沒送出」時發生——**沒有任何補領的路**
- [ ] 每日簽到的核准者規則與家事相同：**Vicky 直接核准；Aug 先被擋下出現「代替確認」，再按一次才成立**，
      `decidedProxy = true` 且 memo 看得出是代的
- [ ] 家長端待審清單**分得出兩種 kind**：每日簽到那筆看得到攤開的三個勾選項目與照片，
      家事那筆看得到家事名稱；**「全部核准今天的每日簽到」一次批掉三筆**
- [ ] 每日簽到的照片進同一個 `HappyBank 家事照片/<kidId>/`，檔名是 `<yyyyMMdd>-allowance-<clientId 前8>.jpg`；
      飛航模式送出後復網補送，**Drive 裡只有一張、只入帳一次**
- [ ] 離線時每日簽到頁**明白寫出「會算在真正送出去的那一天」**，不是靜靜丟進佇列
- [ ] **裝置時間調成昨天也不能多領一次**（日界線一律以伺服器的 `Asia/Taipei` 為準）
- [ ] 家長端 admin 改得動 `users.dailyAllowance`（逐人）與 `config.daily_checklist`
- [ ] **沒有任何自動發零用錢的行為**：週日早上 8:00 不會有錢自動進帳，
      Apps Script 的觸發條件頁面沒有那支 trigger
- [ ] 週日早上家長端 admin 首頁看得到「本週待審 ○ 件」提醒（對帳日保留，但與發薪無關）；
      **一次面對 21 筆每日簽到 + 家事，清單不會卡住**（照片延遲載入）
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
