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
    // Apps Script 的 base64Decode 對壞掉的字串會丟例外，不是默默回半包位元組。
    // SPEC §7.2 第 4 條「base64 解不開 → photo-required」就是靠這個行為，
    // 假環境若照 Node 的寬鬆行為走，那條驗證在測試裡永遠測不到。
    base64Decode(s /*, charset */) {
      const str = String(s).replace(/\s+/g, '');
      if (str === '' || /[^A-Za-z0-9+/=]/.test(str) || str.length % 4 !== 0) {
        throw new Error('Invalid argument: base64');
      }
      return signedBytes(Buffer.from(str, 'base64'));
    },
    // newBlob(data, contentType, name)：data 可以是字串或位元組陣列
    newBlob(data, contentType, name) {
      const bytes = Array.isArray(data)
        ? data.slice()
        : signedBytes(Buffer.from(String(data), 'utf8'));
      return makeBlob(bytes, contentType || 'application/octet-stream', name || '');
    },
    sleep() { /* no-op */ },
    // 真的照 timeZone 算（原本吃的是 node process 的本地時區）。
    // SPEC §7.2 的一天一次是以 Asia/Taipei 的日界線判定的，
    // 假環境若忽略時區，跨午夜那幾條測試就會隨著跑測試的人在哪個時區而變色。
    formatDate(date, timeZone, format) {
      const d = new Date(date);
      if (isNaN(d.getTime())) throw new Error('formatDate: 不是合法的日期');
      const parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'UTC', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(d).forEach(p => { parts[p.type] = p.value; });
      // Intl 在午夜會給 '24'，Java 的 HH 是 '00'
      if (parts.hour === '24') parts.hour = '00';
      const strip = v => String(Number(v));
      const map = {
        yyyy: parts.year, MM: parts.month, dd: parts.day,
        HH: parts.hour, mm: parts.minute, ss: parts.second,
        M: strip(parts.month), d: strip(parts.day), H: strip(parts.hour)
      };
      return String(format).replace(/yyyy|MM|dd|HH|mm|ss|M|d|H/g, t => map[t]);
    }
  };
}

// ---------------------------------------------------------------- Drive

function makeBlob(bytes, contentType, name) {
  return {
    getBytes() { return bytes.slice(); },
    getName() { return name; },
    setName(n) { name = n; return this; },
    getContentType() { return contentType; },
    setContentType(t) { contentType = t; return this; },
    getDataAsString() { return unsignedBuffer(bytes).toString('utf8'); }
  };
}

function iterator(list) {
  let i = 0;
  return {
    hasNext() { return i < list.length; },
    next() {
      if (i >= list.length) throw new Error('沒有下一個了');
      return list[i++];
    }
  };
}

class FakeDriveFile {
  constructor(drive, parent, blob) {
    this._drive = drive;
    this._parent = parent;
    this._blob = blob;
    this._id = 'file-' + (++drive._seq);
    this._trashed = false;
    drive._filesById[this._id] = this;
  }
  getId() { return this._id; }
  getName() { return this._blob.getName(); }
  setName(n) { this._blob.setName(n); return this; }
  getBlob() { return this._blob; }
  getSize() { return this._blob.getBytes().length; }
  getMimeType() { return this._blob.getContentType(); }
  getUrl() { return 'https://drive.google.com/file/d/' + this._id + '/view'; }
  getParents() { return iterator([this._parent]); }
  isTrashed() { return this._trashed; }
  setTrashed(v) {
    this._trashed = v !== false;
    return this;
  }
  // SPEC §5：這個專案刻意不呼叫 setSharing。測試就是靠這個計數器守住那句話。
  setSharing(access, permission) {
    this._drive.sharingCalls.push({ fileId: this._id, access, permission });
    return this;
  }
}

class FakeDriveFolder {
  constructor(drive, name, parent) {
    this._drive = drive;
    this._name = name;
    this._parent = parent || null;
    this._id = 'folder-' + (++drive._seq);
    this._folders = [];
    this._files = [];
    drive._foldersById[this._id] = this;
  }
  getId() { return this._id; }
  getName() { return this._name; }
  getParents() { return iterator(this._parent ? [this._parent] : []); }
  getFolders() { return iterator(this._folders.slice()); }
  getFiles() { return iterator(this._files.filter(f => !f.isTrashed())); }
  getFoldersByName(name) {
    return iterator(this._folders.filter(f => f.getName() === name));
  }
  getFilesByName(name) {
    return iterator(this._files.filter(f => !f.isTrashed() && f.getName() === name));
  }
  createFolder(name) {
    const f = new FakeDriveFolder(this._drive, String(name), this);
    this._folders.push(f);
    return f;
  }
  // createFile(blob) 或 createFile(name, content, mimeType)
  createFile(a, b, c) {
    const blob = (a && typeof a.getBytes === 'function')
      ? a
      : makeBlob(signedBytes(Buffer.from(String(b === undefined ? '' : b), 'utf8')),
                 c || 'text/plain', String(a));
    const file = new FakeDriveFile(this._drive, this, blob);
    this._files.push(file);
    this._drive.created.push({ folder: this.pathString(), name: file.getName(), id: file.getId() });
    return file;
  }
  pathString() {
    const names = [];
    let p = this;
    while (p && p._parent) { names.unshift(p.getName()); p = p._parent; }
    return names.join('/');
  }
}

function makeDrive() {
  const drive = {
    _seq: 0,
    _filesById: {},
    _foldersById: {},
    created: [],        // 建過的檔案（測「只建一張照片」用）
    sharingCalls: []    // 必須一直是空的，見 FakeDriveFile.setSharing
  };
  const root = new FakeDriveFolder(drive, 'My Drive', null);
  drive.root = root;

  drive.app = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE', ANYONE: 'ANYONE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT', NONE: 'NONE' },
    getRootFolder() { return root; },
    getFoldersByName(name) { return root.getFoldersByName(name); },
    getFilesByName(name) { return root.getFilesByName(name); },
    createFolder(name) { return root.createFolder(name); },
    createFile(a, b, c) { return root.createFile(a, b, c); },
    getFolderById(id) {
      const f = drive._foldersById[String(id)];
      if (!f) throw new Error('No item with the given ID could be found: ' + id);
      return f;
    },
    getFileById(id) {
      const f = drive._filesById[String(id)];
      // Drive 的 getFileById 對「不存在／沒權限」是丟例外；
      // 進垃圾桶的檔案仍然拿得到，要靠 isTrashed() 判斷（SPEC §7.6 第 4 條）。
      if (!f) throw new Error('No item with the given ID could be found: ' + id);
      return f;
    }
  };

  // 測試便利：把一個檔案徹底刪掉（模擬有人在 Drive 清空垃圾桶）
  drive.destroy = function (id) {
    const f = drive._filesById[String(id)];
    if (!f) return false;
    const list = f._parent._files;
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
    delete drive._filesById[String(id)];
    return true;
  };
  drive.fileById = id => drive._filesById[String(id)] || null;
  // 依路徑（'HappyBank 家事照片/momo'）找資料夾，找不到回 null
  drive.folderAt = function (path) {
    let cur = root;
    for (const name of String(path).split('/').filter(Boolean)) {
      const it = cur.getFoldersByName(name);
      if (!it.hasNext()) return null;
      cur = it.next();
    }
    return cur;
  };

  return drive;
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
  const drive = makeDrive();

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
    DriveApp: drive.app,
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

  return { globals, book, drive, lock, state, logs: state.logs, outputs: state.outputs };
}

module.exports = {
  createFakeEnv,
  makeDrive,
  makeBlob,
  FakeSpreadsheet,
  FakeSheet,
  FakeRange,
  signedBytes,
  unsignedBuffer
};
