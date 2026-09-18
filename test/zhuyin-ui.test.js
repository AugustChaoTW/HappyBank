'use strict';
// js/zhuyin.js 的純邏輯部分：開關狀態、分人記憶、storage 壞掉時不要炸。
// 字型長什麼樣、body 上有沒有 class，這裡測不到也不該測——沒有瀏覽器就沒有意義。
// 這裡在意的只有一件事：共用平板上，弟弟把注音打開，不可以連姊姊的畫面一起變。

const test = require('node:test');
const assert = require('node:assert');
const { loadBrowserModule } = require('./helpers/load-browser.js');

// 假的 localStorage：只要 getItem/setItem/removeItem 三個方法就夠 zhuyin.js 用了
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

// 每次都會丟例外的 storage，模擬 Safari 無痕模式
function throwingStorage() {
  const boom = () => { throw new DOMExceptionish('QuotaExceededError'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}
class DOMExceptionish extends Error {}

function load(storage) {
  return loadBrowserModule('js/zhuyin.js', 'Zhuyin', { localStorage: storage });
}

test('nextState：純函式，true↔false，沒存過的當作關著', () => {
  const Z = load(fakeStorage());
  assert.strictEqual(Z.nextState(false), true);
  assert.strictEqual(Z.nextState(true), false);
  assert.strictEqual(Z.nextState(undefined), true, '沒存過 → 按一下要變開');
  assert.strictEqual(Z.nextState(null), true);
  // 髒值（storage 被手動改過）也要收斂成布林，不能回傳字串
  assert.strictEqual(Z.nextState('1'), false);
  assert.strictEqual(Z.nextState(''), true);
});

test('預設是關的：沒設定過的小孩不會突然看到注音', () => {
  const Z = load(fakeStorage());
  assert.strictEqual(Z.isOn('momo'), false);
  assert.strictEqual(Z.isOn('coco'), false);
});

test('沒有 userId 就一律當關著，也不寫入（不要存成大家共用的一份）', () => {
  const s = fakeStorage();
  const Z = load(s);
  assert.strictEqual(Z.isOn(null), false);
  assert.strictEqual(Z.isOn(''), false);
  assert.strictEqual(Z.isOn(undefined), false);
  Z.set(null, true);
  Z.set('', true);
  assert.strictEqual(s.map.size, 0, '沒有身分就不該留下任何 key');
});

test('存進去再讀出來（round-trip），關掉也要記得是關掉', () => {
  const s = fakeStorage();
  const Z = load(s);
  Z.set('momo', true);
  assert.strictEqual(Z.isOn('momo'), true);

  // 換一個 module instance 重讀同一份 storage = 模擬「關掉分頁再打開」
  const Z2 = load(s);
  assert.strictEqual(Z2.isOn('momo'), true, '重新載入後要還記得');

  Z2.set('momo', false);
  assert.strictEqual(Z2.isOn('momo'), false);
  assert.strictEqual(load(s).isOn('momo'), false, '關掉也要持久，不能又退回預設');
});

test('分人記憶：共用平板上弟弟開注音，姊姊的畫面不受影響', () => {
  const s = fakeStorage();
  const Z = load(s);
  Z.set('momo', true);
  assert.strictEqual(Z.isOn('momo'), true);
  assert.strictEqual(Z.isOn('coco'), false, 'A 開了不代表 B 也開');

  Z.set('coco', true);
  Z.set('momo', false);
  assert.strictEqual(Z.isOn('momo'), false);
  assert.strictEqual(Z.isOn('coco'), true, '關掉 A 不可以把 B 一起關掉');
});

test('userId 大小寫不敏感：登入時 userId 會轉小寫，設定不能因此走丟', () => {
  const s = fakeStorage();
  const Z = load(s);
  Z.set('Momo', true);
  assert.strictEqual(Z.isOn('momo'), true);
  assert.strictEqual(Z.isOn('MOMO'), true);
});

test('toggle：讀目前狀態 → 反過來 → 存回去，並回傳新狀態', () => {
  const s = fakeStorage();
  const Z = load(s);
  assert.strictEqual(Z.toggle('momo'), true);
  assert.strictEqual(Z.isOn('momo'), true);
  assert.strictEqual(Z.toggle('momo'), false);
  assert.strictEqual(Z.isOn('momo'), false);
  assert.strictEqual(Z.toggle(null), false, '沒身分就不能開，也不能炸');
});

test('storage 整個壞掉（無痕模式）：一律當關著，而且不能丟例外出來', () => {
  const Z = load(throwingStorage());
  assert.strictEqual(Z.isOn('momo'), false);
  assert.doesNotThrow(() => Z.set('momo', true));
  assert.doesNotThrow(() => Z.toggle('momo'));
  assert.strictEqual(Z.isOn('momo'), false, '存不進去就是存不進去，不要假裝成功');
});

test('連 localStorage 這個名字都不存在時也要活著', () => {
  const Z = load(undefined);   // vm context 裡沒有 localStorage
  assert.strictEqual(Z.isOn('momo'), false);
  assert.doesNotThrow(() => Z.set('momo', true));
  assert.doesNotThrow(() => Z.toggle('momo'));
});

test('storage 裡的髒值不要當成「開」：只認我們自己寫進去的值', () => {
  const Z = load(fakeStorage({ 'happybank-zhuyin:momo': 'yes please' }));
  assert.strictEqual(Z.isOn('momo'), false);
  const Z2 = load(fakeStorage({ 'happybank-zhuyin:momo': '1' }));
  assert.strictEqual(Z2.isOn('momo'), true);
  const Z3 = load(fakeStorage({ 'happybank-zhuyin:momo': '0' }));
  assert.strictEqual(Z3.isOn('momo'), false);
});

test('apply／sync 在沒有 document 的環境下要能呼叫（node 載入不炸）', () => {
  const Z = load(fakeStorage());
  assert.doesNotThrow(() => Z.apply('momo'));
  assert.doesNotThrow(() => Z.apply(null));
  assert.strictEqual(typeof Z.sync, 'function');
  assert.doesNotThrow(() => Z.sync());
});
