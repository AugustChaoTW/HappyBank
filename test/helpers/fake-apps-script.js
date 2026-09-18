'use strict';
// 一份「夠像」Google Apps Script 的記憶體假環境。
// 目的不是完整重現 Apps Script，而是讓 apps-script/*.gs 的原始碼
// 能原封不動地跑起來，並且讓雜湊鏈與真實環境 byte-for-byte 相同。

const crypto = require('node:crypto');

// ---------------------------------------------------------------- 工具

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

// ---------------------------------------------------------------- Range

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1) throw new Error('getRange: row/column 必須 >= 1');
    this._sheet = sheet;
    this._row = row;
    this._col = col;
    this._numRows = numRows === undefined ? 1 : numRows;
    this._numCols = numCols === undefined ? 1 : numCols;
  }
  getRow() { return this._row; }
  getColumn() { return this._col; }
  getNumRows() { return this._numRows; }
  getNumColumns() { return this._numCols; }

  getValues() {
    const out = [];
    for (let r = 0; r < this._numRows; r++) {
      const line = [];
      for (let c = 0; c < this._numCols; c++) {
        line.push(this._sheet._get(this._row + r, this._col + c));
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this._sheet._get(this._row, this._col); }

  setValues(values) {
    if (!Array.isArray(values) || values.length !== this._numRows) {
      throw new Error('setValues: 列數不符（要 ' + this._numRows + '，拿到 ' +
        (Array.isArray(values) ? values.length : typeof values) + '）');
    }
    values.forEach((line, r) => {
      if (!Array.isArray(line) || line.length !== this._numCols) {
        throw new Error('setValues: 欄數不符（要 ' + this._numCols + '）');
      }
      line.forEach((v, c) => this._sheet._set(this._row + r, this._col + c, v));
    });
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this._numRows; r++) {
      for (let c = 0; c < this._numCols; c++) this._sheet._set(this._row + r, this._col + c, v);
    }
    return this;
  }
  // 純樣式，記錄下來但不影響資料
  setFontWeight(w) { this._sheet._styles.push({ range: this._key(), fontWeight: w }); return this; }
  setBackground(b) { this._sheet._styles.push({ range: this._key(), background: b }); return this; }
  setNumberFormat(f) { this._sheet._styles.push({ range: this._key(), numberFormat: f }); return this; }
  setFontColor(c) { this._sheet._styles.push({ range: this._key(), fontColor: c }); return this; }
  clearContent() { return this.setValue(''); }
  _key() { return [this._row, this._col, this._numRows, this._numCols].join(':'); }
}

// ---------------------------------------------------------------- Protection

class FakeProtection {
  constructor(sheet) {
    this._sheet = sheet;
    this._description = '';
    this._editors = [];
    this._domainEdit = true;
  }
  setDescription(d) { this._description = d; return this; }
  getDescription() { return this._description; }
  getEditors() { return this._editors.slice(); }
  addEditor(e) { this._editors.push(e); return this; }
  removeEditors(list) {
    (list || []).forEach(e => {
      const i = this._editors.indexOf(e);
      if (i >= 0) this._editors.splice(i, 1);
    });
    return this;
  }
  canDomainEdit() { return this._domainEdit; }
  setDomainEdit(v) { this._domainEdit = v; return this; }
  remove() {
    const i = this._sheet._protections.indexOf(this);
    if (i >= 0) this._sheet._protections.splice(i, 1);
  }
}

// ---------------------------------------------------------------- Sheet

class FakeSheet {
  constructor(name, spreadsheet) {
    this._name = name;
    this._ss = spreadsheet;
    this._grid = [];          // 稀疏二維陣列，_grid[r0][c0]
    this._styles = [];
    this._protections = [];
    this._frozenRows = 0;
    this._hidden = false;
  }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }

  _get(row, col) {
    const line = this._grid[row - 1];
    if (!line) return '';
    const v = line[col - 1];
    return v === undefined ? '' : v;
  }
  _set(row, col, value) {
    while (this._grid.length < row) this._grid.push([]);
    const line = this._grid[row - 1];
    while (line.length < col) line.push('');
    line[col - 1] = value === undefined ? '' : value;
  }

  getLastRow() {
    for (let r = this._grid.length; r >= 1; r--) {
      const line = this._grid[r - 1] || [];
      if (line.some(v => !isBlank(v))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const line of this._grid) {
      if (!line) continue;
      for (let c = line.length; c >= 1; c--) {
        if (!isBlank(line[c - 1])) { if (c > last) last = c; break; }
      }
    }
    return last;
  }
  getMaxRows() { return Math.max(this.getLastRow(), 1000); }
  getMaxColumns() { return Math.max(this.getLastColumn(), 26); }

  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    const r = this.getLastRow();
    const c = this.getLastColumn();
    if (r === 0 || c === 0) return new FakeRange(this, 1, 1, 1, 1);
    return new FakeRange(this, 1, 1, r, c);
  }

  appendRow(row) {
    const at = this.getLastRow() + 1;
    row.forEach((v, i) => this._set(at, i + 1, v));
    return this;
  }
  insertRowAfter() { return this; }
  deleteRow(row) { this._grid.splice(row - 1, 1); return this; }

  setFrozenRows(n) { this._frozenRows = n; return this; }
  getFrozenRows() { return this._frozenRows; }
  hideSheet() { this._hidden = true; return this; }
  showSheet() { this._hidden = false; return this; }
  isSheetHidden() { return this._hidden; }
  autoResizeColumn() { return this; }
  setColumnWidth() { return this; }
  clear() { this._grid = []; return this; }

  protect() {
    const p = new FakeProtection(this);
    this._protections.push(p);
    return p;
  }
  getProtections(/* type */) { return this._protections.slice(); }

  // 測試用：整張表當成物件陣列讀出來
  toObjects() {
    const values = this.getDataRange().getValues();
    const headers = values.shift() || [];
    return values
      .filter(r => !isBlank(r[0]))
      .map((r, i) => {
        const o = { _row: i + 2 };
        headers.forEach((h, c) => { if (h) o[h] = r[c]; });
        return o;
      });
  }
}

// ---------------------------------------------------------------- Spreadsheet

class FakeSpreadsheet {
  constructor(id) {
    this._id = id;
    this._sheets = [];
  }
  getId() { return this._id; }
  getName() { return 'HappyBank 測試資料庫'; }
  getSheets() { return this._sheets.slice(); }
  getSheetByName(name) { return this._sheets.find(s => s.getName() === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('分頁已存在：' + name);
    const sh = new FakeSheet(name, this);
    this._sheets.push(sh);
    return sh;
  }
  deleteSheet(sheet) {
    const i = this._sheets.indexOf(sheet);
    if (i >= 0) this._sheets.splice(i, 1);
  }
  getSpreadsheetTimeZone() { return 'Asia/Taipei'; }
}

// ---------------------------------------------------------------- 雜湊

// Apps Script 的 computeDigest 回傳「有號」位元組陣列（-128..127）。
// hashPassword 的 base64Encode 拿到的就是這種陣列，所以這裡必須照樣模擬，
// 否則雜湊鏈會和正式環境不一樣。
function signedBytes(buf) {
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] > 127 ? buf[i] - 256 : buf[i];
  return out;
}
function unsignedBuffer(bytes) {
  return Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b)));
}

function makeUtilities(state) {
  const DigestAlgorithm = { SHA_256: 'SHA_256', SHA_1: 'SHA_1', MD5: 'MD5' };
  const Charset = { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' };
  const algoNode = { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5' };

  return {
    DigestAlgorithm,
    Charset,
    getUuid() {
      state.uuidCount++;
      return state.uuidFactory ? state.uuidFactory(state.uuidCount) : crypto.randomUUID();
    },
    computeDigest(algorithm, value, charset) {
      const node = algoNode[algorithm];
      if (!node) throw new Error('不支援的演算法：' + algorithm);
      const buf = Buffer.isBuffer(value)
        ? value
        : (Array.isArray(value) ? unsignedBuffer(value) : Buffer.from(String(value), 'utf8'));
      return signedBytes(crypto.createHash(node).update(buf).digest());
    },
    base64Encode(value /*, charset */) {
      if (Array.isArray(value)) return unsignedBuffer(value).toString('base64');
      if (Buffer.isBuffer(value)) return value.toString('base64');
      return Buffer.from(String(value), 'utf8').toString('base64');
    },
    base64Decode(s) { return signedBytes(Buffer.from(String(s), 'base64')); },
    newBlob(s) { return { getDataAsString: () => String(s) }; },
    sleep() { /* no-op */ },
    // 只支援本專案用得到的幾種 pattern，夠測試辨識即可
    formatDate(date, timeZone, format) {
      const d = new Date(date);
      const pad = (n, w) => String(n).padStart(w || 2, '0');
      return String(format)
        .replace(/yyyy/g, d.getFullYear())
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/dd/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()))
        .replace(/ss/g, pad(d.getSeconds()));
    }
  };
}

// ---------------------------------------------------------------- 環境組裝

function createFakeEnv(options) {
  const opts = options || {};
  const sheetId = opts.sheetId || null;

  const state = {
    uuidCount: 0,
    uuidFactory: opts.uuidFactory || null,
    logs: [],
    outputs: []
  };

  const book = new FakeSpreadsheet(sheetId || 'fake-sheet-id');

  // 鎖：可設定成「拿不到」以模擬 15 秒逾時
  const lock = {
    failWaitLock: false,   // 測試把這個設 true，waitLock 就會丟例外
    held: false,
    waitCalls: 0,
    releaseCalls: 0,
    maxConcurrent: 0,
    depth: 0
  };
  const scriptLock = {
    waitLock(ms) {
      lock.waitCalls++;
      if (lock.failWaitLock) {
        throw new Error('Could not obtain lock after ' + ms + 'ms.');
      }
      lock.depth++;
      if (lock.depth > lock.maxConcurrent) lock.maxConcurrent = lock.depth;
      lock.held = true;
      return true;
    },
    tryLock(ms) {
      if (lock.failWaitLock) return false;
      return scriptLock.waitLock(ms);
    },
    releaseLock() {
      lock.releaseCalls++;
      lock.depth = Math.max(0, lock.depth - 1);
      lock.held = lock.depth > 0;
    },
    hasLock() { return lock.held; }
  };

  const SpreadsheetApp = {
    openById(id) {
      if (sheetId && String(id) !== String(sheetId)) {
        throw new Error('openById: 不認得的 SHEET_ID ' + id);
      }
      book._id = String(id);
      return book;
    },
    openByUrl() { return book; },
    getActiveSpreadsheet() { return book; },
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    flush() { }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(s) {
      const out = {
        _content: String(s),
        _mime: 'text/plain',
        getContent() { return this._content; },
        setContent(v) { this._content = String(v); return this; },
        getMimeType() { return this._mime; },
        setMimeType(m) { this._mime = m; return this; },
        // 測試便利：直接把 body 當 JSON 解出來
        json() { return JSON.parse(this._content); }
      };
      state.outputs.push(out);
      return out;
    }
  };

  const Logger = {
    log(...args) { state.logs.push(args.map(a => String(a)).join(' ')); }
  };

  const globals = {
    SpreadsheetApp,
    ContentService,
    LockService: { getScriptLock: () => scriptLock, getUserLock: () => scriptLock, getDocumentLock: () => scriptLock },
    Utilities: makeUtilities(state),
    Logger,
    console,
    HtmlService: {
      createHtmlOutput: s => ({ getContent: () => String(s), setTitle() { return this; } })
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Taipei',
      getActiveUser: () => ({ getEmail: () => 'test@example.com' })
    },
    PropertiesService: (() => {
      const store = {};
      const props = {
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); return props; },
        deleteProperty: k => { delete store[k]; return props; },
        getProperties: () => Object.assign({}, store)
      };
      return { getScriptProperties: () => props, getUserProperties: () => props };
    })(),
    MailApp: { sendEmail() { } },
    ScriptApp: {
      newTrigger: () => ({
        timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() { } }) }) })
      }),
      getProjectTriggers: () => []
    }
  };

  return { globals, book, lock, state, logs: state.logs, outputs: state.outputs };
}

module.exports = {
  createFakeEnv,
  FakeSpreadsheet,
  FakeSheet,
  FakeRange,
  signedBytes,
  unsignedBuffer
};
