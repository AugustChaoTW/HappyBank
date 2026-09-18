'use strict';
// 假環境的忠實度測試。
// hashPassword 的輸出就是 credentials.passwordHash——假環境只要有一個 byte 不一樣，
// 所有 auth 測試都會變成「在測一個不存在的系統」。
// 下面這串是用 Python 參考實作算出來的定值，不是從程式跑出來抄的：
//   acc = salt + ':' + pw
//   for _ in range(1000): acc = base64.b64encode(sha256(acc.encode('utf-8')).digest()).decode()

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { loadGs } = require('./helpers/load-gs.js');

const SALT = '009d8af5efb04f3d';
const PW = '12345678';
const EXPECTED_1000 = 'hbBiW1WetuRNiJRiXkxGLdnEnvWYnoVO2a1SSCjZYvo=';
const EXPECTED_1 = '46QPiHeaRBV+vcN912lsr1FyX7uU2/AlQ2rOrenFVHI=';

function referenceChain(salt, pw, rounds) {
  let acc = salt + ':' + pw;
  for (let i = 0; i < rounds; i++) {
    acc = crypto.createHash('sha256').update(Buffer.from(acc, 'utf8')).digest('base64');
  }
  return acc;
}

test('hashPassword 與參考實作 byte-for-byte 相同（1000 輪）', () => {
  const gs = loadGs();
  assert.strictEqual(gs.hashPassword(PW, SALT, 1000), EXPECTED_1000);
  assert.strictEqual(referenceChain(SALT, PW, 1000), EXPECTED_1000);
});

test('computeDigest + base64Encode 單輪就要對上', () => {
  const gs = loadGs();
  const bytes = gs.$.context.Utilities.computeDigest(
    gs.$.context.Utilities.DigestAlgorithm.SHA_256, SALT + ':' + PW,
    gs.$.context.Utilities.Charset.UTF_8);
  // Apps Script 回的是「有號」位元組（-128..127），假環境必須照樣回
  assert.ok(Array.isArray(bytes), 'computeDigest 要回陣列');
  assert.strictEqual(bytes.length, 32);
  assert.ok(bytes.some(b => b < 0), 'SHA-256 這組輸入一定有負數位元組');
  assert.strictEqual(gs.$.context.Utilities.base64Encode(bytes), EXPECTED_1);
});

test('rounds 下限 1000：填 0 / 空字串 / 負數都不會退化成不雜湊', () => {
  const gs = loadGs();
  [0, '', null, undefined, -5, 1, 999].forEach(r => {
    assert.strictEqual(gs.hashPassword(PW, SALT, r), EXPECTED_1000,
      'rounds=' + String(r) + ' 應該被夾到 1000 輪');
  });
});

test('newSalt 是 16 個 16 進位字元且每次不同', () => {
  const gs = loadGs();
  const a = gs.newSalt();
  const b = gs.newSalt();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(a, b);
});

test('不同 salt 得到不同雜湊', () => {
  const gs = loadGs();
  assert.notStrictEqual(gs.hashPassword(PW, SALT, 1000), gs.hashPassword(PW, 'ffffffffffffffff', 1000));
});
