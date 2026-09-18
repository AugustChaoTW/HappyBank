'use strict';
// js/*.js 是瀏覽器用的 IIFE，靠「頂層 const 掛全域」互通。
// 在 node 底下把檔案包成函式再把那個名字 return 出來，就不必動到前端程式碼。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// globalName：檔案裡宣告的那個全域名字（例如 money.js 的 Money）
function loadBrowserModule(relPath, globalName, extraGlobals) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const context = vm.createContext(Object.assign({ console }, extraGlobals || {}));
  return vm.runInContext(
    '(function () {\n' + code + '\n;return ' + globalName + ';\n})()',
    context, { filename: relPath });
}

module.exports = { loadBrowserModule, ROOT };
