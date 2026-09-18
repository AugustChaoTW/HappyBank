'use strict';
// 登入、session、鎖定。SPEC §7.0 / §8.1。
// 這裡每一條都對應一個真的會出事的場景，不是為了覆蓋率。

const test = require('node:test');
const assert = require('node:assert');
const { freshBank, login, USERS } = require('./helpers/seed.js');

test('正確密碼可以登入，回傳 session 與使用者資料', () => {
  const gs = freshBank();
  const res = gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(res.ok, true);
  assert.match(res.session, /^[0-9a-f-]{36}$/);
  assert.ok(new Date(res.expiresTs).getTime() > Date.now(), 'session 不能一出生就過期');
  assert.deepStrictEqual(res.user, {
    userId: 'momo', role: 'kid', displayName: 'Momo', emoji: '👧'
  });
  // 回應裡不准出現任何密碼相關欄位
  const body = JSON.stringify(res);
  assert.ok(!/passwordHash|salt/.test(body), '回應不可洩漏雜湊或 salt');
});

test('密碼錯誤回 bad-credentials', () => {
  const gs = freshBank();
  const res = gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'bad-credentials');
});

test('不存在的帳號回「一模一樣」的錯誤物件（不洩漏帳號是否存在）', () => {
  const gs = freshBank();
  const wrongPw = gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });
  const noUser = gs.$.call({ action: 'login', userId: 'nobody', password: '00000000' });
  assert.deepStrictEqual(noUser, wrongPw,
    '帳號不存在與密碼錯誤必須完全無法分辨（SPEC §7.0）');
  assert.strictEqual(noUser.message, '帳號或密碼不對，再試一次。');
});

test('空白 userId / password 也走同一句 DENY', () => {
  const gs = freshBank();
  const base = gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });
  assert.deepStrictEqual(gs.$.call({ action: 'login', userId: '', password: 'x' }), base);
  assert.deepStrictEqual(gs.$.call({ action: 'login', userId: 'momo', password: '' }), base);
});

test('userId 大小寫不敏感，前後空白會被吃掉', () => {
  const gs = freshBank();
  ['MoMo', 'MOMO', '  momo  '].forEach(id => {
    const res = gs.$.call({ action: 'login', userId: id, password: USERS.momo.password });
    assert.strictEqual(res.ok, true, id + ' 應該可以登入');
    assert.strictEqual(res.user.userId, 'momo');
  });
});

test('連錯 5 次會鎖定，第 6 次一律回 locked', () => {
  const gs = freshBank();
  const bad = () => gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });

  for (let i = 1; i <= 4; i++) {
    assert.strictEqual(bad().error, 'bad-credentials', '第 ' + i + ' 次應該只是密碼錯');
  }
  assert.strictEqual(bad().error, 'locked', '第 5 次應該觸發鎖定');

  const cred = gs.$.rows('credentials').find(c => c.userId === 'momo');
  assert.ok(!isNaN(new Date(cred.lockedUntil).getTime()), 'lockedUntil 要被寫進 credentials');
  assert.ok(new Date(cred.lockedUntil).getTime() > Date.now(), 'lockedUntil 要在未來');

  const sixth = bad();
  assert.strictEqual(sixth.error, 'locked');
  assert.match(sixth.message, /分鐘/);

  // 鎖定期間就算密碼是對的也不給進
  const withRight = gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(withRight.error, 'locked', '鎖定期間正確密碼也要擋');
});

test('鎖定到期後可以再登入', () => {
  const gs = freshBank();
  const row = gs.$.rows('credentials').find(c => c.userId === 'momo')._row;
  gs.$.setCell('credentials', row, 'lockedUntil', new Date(Date.now() - 60000));
  const res = gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(res.ok, true);
});

test('登入成功會把 failedCount 歸零', () => {
  const gs = freshBank();
  gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });
  gs.$.call({ action: 'login', userId: 'momo', password: '00000000' });
  assert.strictEqual(gs.num(gs.$.rows('credentials').find(c => c.userId === 'momo').failedCount, -1), 2);

  assert.strictEqual(gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password }).ok, true);
  const cred = gs.$.rows('credentials').find(c => c.userId === 'momo');
  assert.strictEqual(gs.num(cred.failedCount, -1), 0, '成功登入後失敗次數要重來');
  assert.strictEqual(String(cred.lockedUntil), '', 'lockedUntil 要被清掉');
});

test('active = false 的帳號不能登入，且錯誤訊息不特別', () => {
  const gs = freshBank();
  const row = gs.$.rows('users').find(u => u.userId === 'momo')._row;
  gs.$.setCell('users', row, 'active', false);
  const res = gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(res.error, 'bad-credentials');
});

test('偽造的 session token 一律拒絕', () => {
  const gs = freshBank();
  ['', 'not-a-real-token', '00000000-0000-0000-0000-000000000000'].forEach(tok => {
    const res = gs.$.call({ action: 'whoami', session: tok });
    assert.strictEqual(res.ok, false, JSON.stringify(tok) + ' 不該通過');
    assert.strictEqual(res.error, 'unauthorized');
  });
});

test('expiresTs 被清成空白 / 怪字串時，session 要當作「過期」（fail-closed）', () => {
  ['', '   ', '待確認', 'not a date', null, 0].forEach(bad => {
    const gs = freshBank({ users: ['momo'] });
    const session = login(gs, 'momo');
    const row = gs.$.rows('sessions').find(s => s.token === session)._row;
    gs.$.setCell('sessions', row, 'expiresTs', bad);

    const res = gs.$.call({ action: 'whoami', session });
    assert.strictEqual(res.ok, false,
      'expiresTs = ' + JSON.stringify(bad) + ' 時 session 必須失效，不能變成永久有效');
    assert.strictEqual(res.error, 'unauthorized');
  });
});

test('已過期的 session 回 unauthorized', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const row = gs.$.rows('sessions').find(s => s.token === session)._row;
  gs.$.setCell('sessions', row, 'expiresTs', new Date(Date.now() - 1000));
  assert.strictEqual(gs.$.call({ action: 'whoami', session }).error, 'unauthorized');
});

test('session 指向的帳號被刪掉時回 unauthorized 而不是 500', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const row = gs.$.rows('users').find(u => u.userId === 'momo')._row;
  gs.$.setCell('users', row, 'userId', '');
  const res = gs.$.call({ action: 'whoami', session });
  assert.strictEqual(res.error, 'unauthorized');
});

test('logout 只讓自己那張 session 失效，別人的不受影響', () => {
  const gs = freshBank();
  const momo = login(gs, 'momo');
  const coco = login(gs, 'coco');
  const momoPhone = login(gs, 'momo');   // 同一個人的另一台裝置

  assert.strictEqual(gs.$.call({ action: 'logout', session: momo }).ok, true);

  assert.strictEqual(gs.$.call({ action: 'whoami', session: momo }).error, 'unauthorized');
  assert.strictEqual(gs.$.call({ action: 'whoami', session: coco }).ok, true, 'Coco 不該被登出');
  assert.strictEqual(gs.$.call({ action: 'whoami', session: momoPhone }).ok, true,
    'logout 只處理當下這張 token，不該掃掉同一人的其他裝置');
});

test('logout 需要一張有效 session，偽造 token 不能拿來登出別人', () => {
  const gs = freshBank();
  const coco = login(gs, 'coco');
  const res = gs.$.call({ action: 'logout', session: 'forged-token' });
  assert.strictEqual(res.error, 'unauthorized');
  assert.strictEqual(gs.$.call({ action: 'whoami', session: coco }).ok, true);
});

test('token 不對就什麼都不做', () => {
  const gs = freshBank();
  const res = gs.$.rawCall({ token: 'wrong', action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(res.error, 'bad-token');
  assert.strictEqual(gs.$.rows('sessions').length, 0);
});

test('users 名單只給公開欄位，不含密碼或零用錢', () => {
  const gs = freshBank();
  const res = gs.$.call({ action: 'users' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.users.length, 4);
  res.users.forEach(u => {
    assert.deepStrictEqual(Object.keys(u).sort(), ['displayName', 'emoji', 'role', 'userId']);
  });
});

test('改密碼後其他裝置的 session 一起失效，當下這張留著', () => {
  const gs = freshBank({ users: ['momo'] });
  const phone = login(gs, 'momo');
  const tablet = login(gs, 'momo');
  const res = gs.$.call({
    action: 'change_password', session: phone,
    oldPassword: USERS.momo.password, newPassword: '99887766'
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(gs.$.call({ action: 'whoami', session: phone }).ok, true);
  assert.strictEqual(gs.$.call({ action: 'whoami', session: tablet }).error, 'unauthorized');
  assert.strictEqual(gs.$.call({ action: 'login', userId: 'momo', password: '99887766' }).ok, true);
});

test('小孩改密碼必須是 8 位數字', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const res = gs.$.call({
    action: 'change_password', session,
    oldPassword: USERS.momo.password, newPassword: 'abcdefgh'
  });
  assert.strictEqual(res.error, 'bad-format');
});

test('舊密碼不對就不准改', () => {
  const gs = freshBank({ users: ['momo'] });
  const session = login(gs, 'momo');
  const res = gs.$.call({
    action: 'change_password', session, oldPassword: '00000000', newPassword: '99887766'
  });
  assert.strictEqual(res.error, 'bad-credentials');
});

test('拿不到鎖時回 busy，而且不是把它當成登入失敗', () => {
  const gs = freshBank({ users: ['momo'] });
  gs.$.lock.failWaitLock = true;
  const res = gs.$.call({ action: 'login', userId: 'momo', password: USERS.momo.password });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'busy', 'LockService 逾時要回 busy（SPEC §7.4）');
  // busy 不該留下副作用
  assert.strictEqual(gs.$.rows('sessions').length, 0);
  assert.strictEqual(gs.num(gs.$.rows('credentials').find(c => c.userId === 'momo').failedCount, -1), 0);
});

test('不認得的 action 回 unknown-action', () => {
  const gs = freshBank({ users: ['momo'] });
  assert.strictEqual(gs.$.call({ action: 'drop_table' }).error, 'unknown-action');
});
