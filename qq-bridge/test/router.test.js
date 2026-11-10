const test = require('node:test');
const assert = require('node:assert');
const { ROUTES, classify, shouldHandle } = require('../src/router');

const cfg = { ownerId: '30001', selfId: '10001' };

test('owner 私聊', () => {
  const r = classify({ kind: 'private', userId: '30001' }, cfg);
  assert.strictEqual(r.route, ROUTES.OWNER_PRIVATE);
  assert.strictEqual(shouldHandle(r.route), true);
});

test('非 owner 私聊忽略', () => {
  const r = classify({ kind: 'private', userId: '30002' }, cfg);
  assert.strictEqual(r.route, ROUTES.IGNORE_NON_OWNER_PRIVATE);
  assert.strictEqual(shouldHandle(r.route), false);
});

test('群 @ 机器人', () => {
  const r = classify({ kind: 'group', userId: '30002', atSelf: true }, cfg);
  assert.strictEqual(r.route, ROUTES.GROUP_MENTION);
  assert.strictEqual(shouldHandle(r.route), true);
});

test('群没 @ 忽略', () => {
  const r = classify({ kind: 'group', userId: '30002', atSelf: false }, cfg);
  assert.strictEqual(r.route, ROUTES.IGNORE_GROUP_NO_MENTION);
});

test('自己发的忽略', () => {
  const r = classify({ kind: 'private', userId: '10001' }, cfg);
  assert.strictEqual(r.route, ROUTES.IGNORE_SELF);
});

test('其他事件忽略', () => {
  const r = classify({ kind: 'other', userId: '30001' }, cfg);
  assert.strictEqual(r.route, ROUTES.IGNORE_OTHER);
});
