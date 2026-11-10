const test = require('node:test');
const assert = require('node:assert');
const { normalizeEvent, parseCQ } = require('../src/normalize');

const SELF = '10001';

test('CQ 码拆成段', () => {
  const segs = parseCQ('[CQ:at,qq=10001] 你好 [CQ:image,file=a.jpg]');
  assert.deepStrictEqual(segs.map((s) => s.type), ['at', 'text', 'image']);
  assert.strictEqual(segs[0].data.qq, '10001');
});

test('群消息：@ 机器人 + 文本', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 20001,
    user_id: 30001,
    message_id: 40001,
    message: [
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 你在吗' } },
    ],
    time: 1760000000,
  }, SELF);

  assert.strictEqual(msg.kind, 'group');
  assert.strictEqual(msg.groupId, '20001');
  assert.strictEqual(msg.userId, '30001');
  assert.strictEqual(msg.atSelf, true);
  assert.strictEqual(msg.text, '你在吗');
});

test('群消息：@ 全体不算 @ 机器人', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 20001,
    user_id: 30001,
    message_id: 40002,
    message: [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 大家好' } },
    ],
  }, SELF);

  assert.strictEqual(msg.atSelf, false);
  assert.strictEqual(msg.text, '大家好');
});

test('私聊：文本和引用 id', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 30001,
    message_id: 40003,
    message: [
      { type: 'reply', data: { id: '39999' } },
      { type: 'text', data: { text: '刚才说到哪了' } },
    ],
  }, SELF);

  assert.strictEqual(msg.kind, 'private');
  assert.strictEqual(msg.text, '刚才说到哪了');
  assert.strictEqual(msg.replyId, '39999');
});

test('字符串消息也兼容', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 20001,
    user_id: 30001,
    message_id: 40004,
    message: '[CQ:at,qq=10001] 你好',
  }, SELF);

  assert.strictEqual(msg.atSelf, true);
  assert.strictEqual(msg.text, '你好');
});

test('非消息事件返回 null', () => {
  assert.strictEqual(normalizeEvent({ post_type: 'meta_event' }, SELF), null);
});
