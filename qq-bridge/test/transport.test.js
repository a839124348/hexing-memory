import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { QQTransport, createTransport } = require('../src/transport.js');
const { OneBotTransport } = require('../src/onebot-transport.js');
const { OfficialTransport } = require('../src/official-transport.js');

const silent = { info() {}, warn() {}, error() {} };

class FakeClient {
  constructor() {
    this.handlers = new Map();
    this.connected = false;
    this.lastPrivate = null;
    this.lastGroup = null;
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  fire(event, payload) {
    for (const h of this.handlers.get(event) || []) h(payload);
  }
  connect() { this.connected = true; }
  close() { this.connected = false; }
  async getLoginInfo() { return { user_id: 999, nickname: 'bot' }; }
  async getGroupInfo(gid) { return { group_name: '群' + gid }; }
  async sendPrivate(uid, message) { this.lastPrivate = { uid, message }; return { message_id: 1 }; }
  async sendGroup(gid, message) { this.lastGroup = { gid, message }; return { message_id: 2 }; }
}

test('createTransport：onebot 返回 OneBotTransport', () => {
  const t = createTransport({ transport: 'onebot', onebot: { url: 'ws://x' }, ownerId: '1' }, silent);
  assert.ok(t instanceof OneBotTransport);
  assert.ok(t instanceof QQTransport);
  assert.strictEqual(t.capabilities().groupScope, 'mention-only');
});

test('createTransport：official 返回 OfficialTransport，能力是 mention-only', () => {
  const t = createTransport({
    transport: 'official',
    official: { appId: 'a', clientSecret: 'b' },
    ownerOpenId: 'o',
  }, silent);
  assert.ok(t instanceof OfficialTransport);
  const cap = t.capabilities();
  assert.strictEqual(cap.groupScope, 'mention-only');
  assert.strictEqual(cap.canProactive, false);
  assert.strictEqual(cap.canHistory, false);
});

test('createTransport：未知 transport / 缺官方凭据会拒绝', () => {
  assert.throws(() => createTransport({ transport: 'nope' }, silent), /未知 transport/);
  assert.throws(() => createTransport({ transport: 'official', official: {} }, silent), /appId/);
});

test('OneBotTransport：normalize 群 @，并自动 @ 提问者', async () => {
  const fake = new FakeClient();
  const t = new OneBotTransport({ clientFactory: () => fake, logger: silent });
  const messages = [];
  const ready = [];
  t.on('message', (m) => messages.push(m));
  t.on('ready', (r) => ready.push(r));

  await t.connect();
  fake.fire('open');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(ready.length, 1);
  assert.strictEqual(ready[0].selfId, '999');

  fake.fire('event', {
    post_type: 'message',
    message_type: 'group',
    group_id: '123',
    user_id: '456',
    message_id: 'm1',
    time: 1700000000,
    self_id: '999',
    sender: { card: '测试用户' },
    message: [
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: ' 你好' } },
    ],
  });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].kind, 'group');
  assert.strictEqual(messages[0].groupId, '123');
  assert.strictEqual(messages[0].userId, '456');
  assert.strictEqual(messages[0].text, '你好');
  assert.strictEqual(messages[0].atSelf, true);
  assert.strictEqual(messages[0].messageId, 'm1');

  await t.reply({ kind: 'group', groupId: '123', userId: '456' }, '收到', { mentionSender: true });
  assert.deepStrictEqual(fake.lastGroup.message, [
    { type: 'at', data: { qq: '456' } },
    { type: 'text', data: { text: '收到' } },
  ]);
});

test('OneBotTransport：私聊回复不带 at', async () => {
  const fake = new FakeClient();
  const t = new OneBotTransport({ clientFactory: () => fake, logger: silent });
  await t.connect();
  await t.reply({ kind: 'private', userId: '456' }, '私聊回复', { mentionSender: true });
  assert.deepStrictEqual(fake.lastPrivate.message, [{ type: 'text', data: { text: '私聊回复' } }]);
});

test('OfficialTransport：能力是 mention-only，reply 缺 msg_id 拒绝', async () => {
  const t = new OfficialTransport({ appId: 'a', clientSecret: 'b', logger: silent });
  assert.strictEqual(t.capabilities().groupScope, 'mention-only');
  await assert.rejects(() => t.reply({ kind: 'private', userId: '1' }, 'hi'), /msg_id/);
});
