const test = require('node:test');
const assert = require('node:assert');
const { SendGuard } = require('../src/guard');

function guard(now, extra = {}) {
  return new SendGuard({ now: () => now.value, ...extra });
}

test('kill switch 关闭时一律不发', () => {
  const now = { value: 1760000000000 };
  const g = guard(now, { enabled: false });
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: 'x' }).ok, false);
});

test('群限流：10 秒内第二条不发', () => {
  const now = { value: 1760000000000 };
  const g = guard(now);
  assert.strictEqual(g.check({ kind: 'group', targetId: '200', text: 'a' }).ok, true);
  g.record({ kind: 'group', targetId: '200', text: 'a' });
  now.value += 5000;
  assert.strictEqual(g.check({ kind: 'group', targetId: '200', text: 'b' }).ok, false);
  now.value += 6000;
  assert.strictEqual(g.check({ kind: 'group', targetId: '200', text: 'b' }).ok, true);
});

test('私聊默认不卡', () => {
  const now = { value: 1760000000000 };
  const g = guard(now);
  g.record({ kind: 'private', targetId: '1', text: 'a' });
  now.value += 1000;
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: 'b' }).ok, true);
});

test('重复文本短时间内只发一次', () => {
  const now = { value: 1760000000000 };
  const g = guard(now);
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: '一样' }).ok, true);
  g.record({ kind: 'private', targetId: '1', text: '一样' });
  now.value += 1000;
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: '一样' }).ok, false);
  now.value += 4000;
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: '一样' }).ok, true);
});

test('免打扰时段', () => {
  const now = { value: new Date(2026, 10, 10, 23, 30).getTime() };
  const g = guard(now, { quietHours: [23] });
  assert.strictEqual(g.check({ kind: 'private', targetId: '1', text: 'x' }).ok, false);
});
