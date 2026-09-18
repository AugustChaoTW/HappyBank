'use strict';
// 把 apps-script/*.gs 當成一份「串接後的全域範圍」載進 vm，
// 這正是 Apps Script 執行時期的樣子（所有 .gs 共用同一個全域）。
//
// 每呼叫一次 loadGs() 就拿到一份全新的環境：
// 全新的假試算表，也全新的 module-level 狀態（_cache / _config / _lockHeld），
// 所以測試之間不會互相汙染。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakeEnv } = require('./fake-apps-script.js');

const ROOT = path.resolve(__dirname, '..', '..');
const GS_FILES = ['Config.gs', 'Setup.gs', 'Code.gs'];

function readSources() {
  return GS_FILES.map(f => {
    const p = path.join(ROOT, 'apps-script', f);
    return { file: f, code: fs.readFileSync(p, 'utf8') };
  });
}

// 取出頂層宣告的名字。頂層宣告一定頂格寫，巢狀的都有縮排，
// 所以用 ^ 行首錨點就足以區分。
const DECL_RE = /^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm;

function topLevelNames(code) {
  const names = [];
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(code)) !== null) {
    const name = m[1] || m[2];
    // _cache / _config / _lockHeld 是會被重新指派的 module state，
    // 匯出快照沒有意義，反而容易讓測試誤以為讀得到當下的值。
    if (name && name[0] !== '_' && names.indexOf(name) === -1) names.push(name);
  }
  return names;
}

function loadGs(options) {
  const opts = options || {};
  const env = createFakeEnv(opts);
  const sources = readSources();

  const banner = sources
    .map(s => '// ===== ' + s.file + ' =====\n' + s.code)
    .join('\n;\n');
  const names = topLevelNames(banner);

  const wrapped =
    '(function () {\n' +
    banner +
    '\n;return {' + names.map(n => n + ': ' + n).join(', ') + '};\n' +
    '})()';

  const context = vm.createContext(env.globals);
  let api;
  try {
    api = vm.runInContext(wrapped, context, { filename: 'happybank-apps-script.js' });
  } catch (err) {
    err.message = '載入 apps-script/*.gs 失敗：' + err.message;
    throw err;
  }

  // 測試用的小工具都掛在 $ 底下，避免跟 .gs 的名字撞名
  api.$ = {
    env,
    book: env.book,
    drive: env.drive,
    lock: env.lock,
    logs: env.logs,
    context,
    names,

    sheet(name) {
      const sh = env.book.getSheetByName(name);
      if (!sh) throw new Error('測試環境沒有分頁 ' + name + '（忘了跑 setup()？）');
      return sh;
    },
    rows(name) { return api.$.sheet(name).toObjects(); },
    headers(name) {
      const sh = api.$.sheet(name);
      return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    },
    // 直接改一格——用來模擬「家長手動去 Sheet 上亂動」的情境
    setCell(name, row, field, value) {
      const headers = api.$.headers(name);
      const c = headers.indexOf(field);
      if (c < 0) throw new Error(name + ' 沒有欄位 ' + field);
      api.$.sheet(name).getRange(row, c + 1).setValue(value);
      api.invalidate(name);
    },

    // 走完整的 route()，回傳解析好的 JSON（與前端拿到的一模一樣）
    call(params) {
      const p = Object.assign({ token: api.TOKEN }, params);
      return JSON.parse(api.route(p).getContent());
    },
    // 不自動補 token，用來測 bad-token
    rawCall(params) {
      return JSON.parse(api.route(params).getContent());
    },
    // vm 與 host 是不同 realm，物件原型不同，
    // deepStrictEqual 會因此誤判。跨界比較前先轉成純 host 物件。
    plain(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  };

  return api;
}

module.exports = { loadGs, topLevelNames, readSources, ROOT };
