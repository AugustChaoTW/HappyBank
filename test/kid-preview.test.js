'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshBank, login } = require('./helpers/seed.js');
const { loadBrowserModule } = require('./helpers/load-browser.js');

test('分身頁顯示跨日待審、跳脫文字且沒有提交或核准控制', () => {
  const view = loadBrowserModule('js/kid-preview.js', 'KidPreview', {
    Money: { format: String, formatDate: String },
    Allowance: { claimState: () => ({ state: 'pending', amount: 20 }) },
    Chores: { deriveState: () => ({ state: 'available' }) }
  });
  const html = view.body({
    user: { displayName: '<img src=x>' }, accounts: [], ledger: [], chores: [],
    requests: [{ kind: 'allowance_claim', status: 'pending', ts: '2020-01-01' }]
  });
  assert.ok(html.includes('2020-01-01'));
  assert.ok(html.includes('等待審核'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<button'));
  assert.ok(!html.includes('<input'));
});

test('爸爸媽媽可以查看指定孩子，session 身分仍是家長', () => {
  const gs = freshBank();
  for (const parent of ['aug', 'vicky']) {
    const session = login(gs, parent);
    const res = gs.$.call({ action: 'snapshot', session, kidId: 'coco' });
    assert.equal(res.ok, true);
    assert.equal(res.user.userId, 'coco');
    assert.equal(res.preview, true);
    const ids = gs.$.rows('accounts').filter(a => a.kidId === 'coco').map(a => a.accountId);
    assert.ok(res.accounts.length > 0);
    assert.ok(res.accounts.every(a => ids.includes(a.accountId)));
    assert.ok(res.requests.every(r => r.kidId === 'coco'));
    assert.equal(gs.$.call({ action: 'whoami', session }).user.userId, parent);
    assert.equal(gs.$.rows('ledger').length, 0);
  }
});

test('孩子指定別人的 kidId 仍然只看到自己', () => {
  const gs = freshBank();
  const session = login(gs, 'momo');
  const res = gs.$.call({ action: 'snapshot', session, kidId: 'coco' });
  assert.equal(res.user.userId, 'momo');
  assert.equal(res.preview, undefined);
});

test('家長不能分身成家長、不存在或停用的孩子', () => {
  const gs = freshBank();
  const session = login(gs, 'aug');
  const coco = gs.$.rows('users').find(u => u.userId === 'coco');
  gs.$.setCell('users', coco._row, 'active', false);
  for (const kidId of ['aug', 'nobody', 'coco']) {
    assert.equal(gs.$.call({ action: 'snapshot', session, kidId }).error, 'no-such-kid');
  }
});
