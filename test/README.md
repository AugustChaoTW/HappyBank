# 測試

零相依。只用 Node 內建的 `node:test` 與 `node:assert`，沒有 npm 套件、沒有 lockfile、沒有 build step——
跟這個專案本身的原則一致。

## 怎麼跑

```bash
npm test                          # 全部
node --test 'test/**/*.test.js'   # 不想經過 npm 也可以（引號要留著，讓 node 自己展開）
node --test test/auth.test.js     # 只跑一個檔
node --test --test-name-pattern='鎖定' 'test/**/*.test.js'   # 只跑名字對得上的
node --test --watch 'test/**/*.test.js'                     # 邊寫邊跑
```

需要 Node 18 以上（`node --test`）。開發時用的是 Node 23。
（`node --test test/` 這種傳目錄的寫法在 Node 23 會壞掉，所以一律用 glob。）

## 檔案

| 檔案 | 守的是什麼 |
|---|---|
| `helpers/fake-apps-script.js` | 記憶體版的 Apps Script（Spreadsheet / Utilities / LockService / ContentService / Logger） |
| `helpers/load-gs.js` | 把 `apps-script/*.gs` 載進 `vm`，回傳裡面所有頂層函式 |
| `helpers/seed.js` | 用真的 `setup()` / `upsertUser()` 做出一間全新的銀行 |
| `helpers/load-browser.js` | 把 `js/*.js` 這種瀏覽器 IIFE 在 node 底下載起來 |
| `hash.test.js` | 假環境的雜湊鏈與正式環境 byte-for-byte 相同 |
| `num.test.js` | `num()` / `toIso()` / `isTrue()`——Sheets 格子被亂改時的輸入衛生 |
| `auth.test.js` | 登入、鎖定、session 生命週期、改密碼（SPEC §7.0 / §8） |
| `ledger.test.js` | 冪等、餘額來源、餘額不足、`admin_recalc`（SPEC §7.3 / §3） |
| `accounts.test.js` | 自動開戶不重複（SPEC §2） |
| `authz.test.js` | 小孩打不到 `admin_*`、看不到別人的帳（SPEC §7.1 / §8） |
| `chores.test.js` | 家事回報：照片、一天一次、代理確認、`chore_photo`（SPEC §7.2 / §7.5 / §7.6 / §9.5） |
| `allowance.test.js` | 每日零用錢簽到：三項全勾、照片、一天一次、金額讀 `users.dailyAllowance`、代理確認 |
| `money.test.js` | `js/money.js` 的顯示算式 |

## 假的 Apps Script 環境怎麼運作

Apps Script 執行時會把同一個專案的所有 `.gs` **併進同一個全域範圍**。
`load-gs.js` 就是照這個模型做的：

1. 讀 `apps-script/Config.gs`、`Setup.gs`、`Code.gs`，**照這個順序**串成一份原始碼。
2. 用正規表達式掃出所有頂層宣告的名字（行首的 `function` / `const` / `let` / `var`）。
3. 把整份原始碼包進一個函式，結尾 `return { 那些名字 }`，丟進 `vm.runInContext` 執行。
   context 的全域就是 `fake-apps-script.js` 造出來的 `SpreadsheetApp` / `Utilities` / `LockService` / …
4. 回傳的物件就是所有函式：`gs.apiLogin(...)`、`gs.postLedger(...)`、`gs.num(...)`、`gs.setup()` 都能直接叫。

**apps-script 底下的程式碼一個字都不用改**，測試跑的就是會部署上去的那份。

### 每個測試一份全新環境

`Code.gs` 有 module 層級的可變狀態（`_cache`、`_config`、`_lockHeld`）。
每次呼叫 `loadGs()` / `freshBank()` 都會重新 evaluate 一次原始碼，
所以那些狀態與那張假試算表都是全新的，測試之間不會互相汙染。**不要在測試之間共用 `gs`。**

### `gs.$` 這些工具

```js
const { freshBank, login, accountOf } = require('./helpers/seed.js');

const gs = freshBank();                    // setup() + 四個測試帳號
const session = login(gs, 'momo');         // 走真的 login API

gs.$.call({ action: 'snapshot', session }) // 走完整 route()，回傳解析好的 JSON
gs.$.rawCall({ ... })                      // 不自動補 token（測 bad-token 用）
gs.$.rows('ledger')                        // 整張分頁讀成物件陣列（含 _row）
gs.$.headers('accounts')                   // 表頭
gs.$.setCell('accounts', 3, 'balance', 999) // 模擬「家長跑去 Sheet 上手改一格」
gs.$.lock.failWaitLock = true              // 模擬 LockService 15 秒逾時 → busy
gs.$.logs                                  // Logger.log 收到的東西
gs.$.plain(x)                              // 跨 realm 物件轉成純 host 物件
```

### 假的 Drive

`DriveApp` 也是假的（`getRootFolder` / `getFoldersByName` / `createFolder` / `createFile` /
`getFileById` / `getBlob` / `setTrashed`），檔案就存在記憶體裡。測試可以用：

```js
gs.$.drive.folderAt('HappyBank 家事照片/momo')   // 依路徑找資料夾，沒有回 null
gs.$.drive.fileById(id)                          // 找檔案（含已在垃圾桶的）
gs.$.drive.destroy(id)                           // 徹底刪掉，模擬有人清空垃圾桶
gs.$.drive.created                               // 建過的檔案清單（「只建一張照片」用）
gs.$.drive.sharingCalls                          // 必須永遠是空的，見下
```

`setSharing` 有實作，但**只是把呼叫記下來**——SPEC §5 明寫這個專案刻意不分享家事照片，
`chores.test.js` 就是拿 `sharingCalls` 為空來守住那句話。

`Utilities.base64Decode` 對壞掉的字串會**丟例外**（跟 Apps Script 一樣，不是 Node 的寬鬆行為），
`Utilities.formatDate` 真的照傳進去的 `timeZone` 算——一天一次的日界線是台北時間，
假環境若拿 node 的本地時區充數，那幾條測試會隨著跑測試的人在哪個時區變色。

### 雜湊忠實度

`hashPassword` 的輸出就是 `credentials.passwordHash`。假環境只要差一個 byte，
所有登入測試就是在測一個不存在的系統。所以 `Utilities.computeDigest` 照樣回
**有號位元組陣列**（−128..127），`base64Encode` 照樣吃那種陣列。

`hash.test.js` 拿一組寫死的定值當基準，那組值是用 Python 參考實作獨立算出來的：

```python
acc = salt + ':' + pw
for _ in range(1000):
    acc = base64.b64encode(hashlib.sha256(acc.encode('utf-8')).digest()).decode()
```

**不要因為測試紅了就去改那個定值。** 紅了代表假環境跑掉了。

### 一個 vm 的陷阱

vm context 是另一個 realm，裡面 `new Date()` 做出來的物件**不會**通過 host 的 `instanceof Date`，
vm 造出來的物件原型也跟 host 的 `{}` 不同，`assert.deepStrictEqual` 會誤判。
走 `gs.$.call()` 的回傳值已經 JSON 來回過一次，是乾淨的 host 物件；
直接呼叫 `gs.postLedger(...)` 這種的，先套一層 `gs.$.plain(...)` 再比。
要確認是不是 Date 就用 `Object.prototype.toString.call(v) === '[object Date]'`。

## 已知 bug（標成 `todo` 的測試）

`node --test` 的 `todo` 代表「這條測試是對的，紅的是實作」。它會照樣跑、照樣印出失敗，
但不會讓整包測試變紅。修好之後把 `{ todo: ... }` 拿掉。

- `ledger.test.js` — **`admin_gift` 會把紅包入到已關閉的 `gift` 帳戶**。
  `apiAdminGift` 挑帳戶時沒有排除 `status === 'closed'`（`apiAdminAdjust` 有檢查，這裡漏了），
  而 `accountsOf()` 又會把 closed 帳戶濾掉——錢進了 ledger，但小孩端與家長端都看不到。

## 規矩：後端新行為一律先寫測試

`apps-script/` 底下任何新的行為——新的 action、新的驗證、新的計息規則——
**先在 `test/` 補一個會紅的測試，再去寫實作。**

理由很實際：這是一套會被小孩拿來吵架的帳本，而 Apps Script 沒有交易、沒有 staging，
線上出錯就是真的算錯錢。手動在 Apps Script 編輯器裡點一遍不算驗證過。

改動時順手檢查：

- 新的寫入路徑有沒有吃 `clientId` 冪等（SPEC §7.3）？
- 有沒有包在 `withLock` 裡？
- 權限是不是在伺服器端判的，而不是信前端送來的 `kidId`（SPEC §7.1 / §8）？
- 從 Sheets 讀進來的值有沒有過 `num()` / `toIso()`？

這四點各自都有現成的測試可以照抄。
