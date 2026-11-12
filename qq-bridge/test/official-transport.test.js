const test = require('node:test');
const assert = require('node:assert');
const { OfficialTransport, normalizeOfficial } = require('../src/official-transport');

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

function fakeFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('getAppAccessToken')) {
      return jsonResponse({ access_token: 'tok', expires_in: 7200 });
    }
    return jsonResponse({ id: 'ok' });
  };
}

const silent = { info() {}, warn() {}, error() {} };

test('normalizeOfficial：群 @ 去掉机器人 mention，保留发送者', () => {
  const msg = normalizeOfficial('GROUP_AT_MESSAGE_CREATE', {
    id: 'm1',
    content: '<@!999> 你好',
    group_openid: 'g1',
    author: { member_openid: 'u1', username: '测试用户' },
    timestamp: '2026-11-11T12:00:00+08:00',
  }, '999');
  assert.strictEqual(msg.kind, 'group');
  assert.strictEqual(msg.userId, 'u1');
  assert.strictEqual(msg.groupId, 'g1');
  assert.strictEqual(msg.text, '你好');
  assert.strictEqual(msg.atSelf, true);
  assert.strictEqual(msg.replyId, 'm1');
  assert.strictEqual(msg.raw.sender.card, '测试用户');
});

test('normalizeOfficial：私聊用 user_openid', () => {
  const msg = normalizeOfficial('C2C_MESSAGE_CREATE', {
    id: 'm2',
    content: '在吗',
    author: { user_openid: 'u2' },
    timestamp: '2026-11-11T12:00:00+08:00',
  }, '999');
  assert.strictEqual(msg.kind, 'private');
  assert.strictEqual(msg.userId, 'u2');
  assert.strictEqual(msg.groupId, '');
  assert.strictEqual(msg.atSelf, false);
});

test('官方 reply：群被动回复带 msg_id/msg_seq 和 <@openid>', async () => {
  const calls = [];
  const t = new OfficialTransport({
    appId: 'a', clientSecret: 'b', logger: silent,
    fetchImpl: fakeFetch(calls), apiBase: 'https://api.test',
  });
  await t.reply({ kind: 'group', groupId: 'g1', userId: 'u1', replyId: 'm1' }, '收到', { mentionSender: true });

  assert.strictEqual(calls.length, 2);
  assert.ok(String(calls[0].url).includes('getAppAccessToken'));
  assert.strictEqual(calls[1].url, 'https://api.test/v2/groups/g1/messages');
  assert.strictEqual(calls[1].opts.headers.Authorization, 'QQBot tok');
  const body = JSON.parse(calls[1].opts.body);
  assert.strictEqual(body.msg_type, 2);
  assert.strictEqual(body.markdown.content, '<qqbot-at-user id="u1" /> 收到');
  assert.strictEqual(body.msg_id, 'm1');
  assert.strictEqual(body.msg_seq, 1);
});

test('官方 reply：私聊走 /v2/users，缺 msg_id 直接拒绝', async () => {
  const calls = [];
  const t = new OfficialTransport({
    appId: 'a', clientSecret: 'b', logger: silent,
    fetchImpl: fakeFetch(calls), apiBase: 'https://api.test',
  });
  await t.reply({ kind: 'private', userId: 'u2', replyId: 'm2' }, '私聊回复');
  assert.strictEqual(calls[1].url, 'https://api.test/v2/users/u2/messages');
  await assert.rejects(() => t.reply({ kind: 'private', userId: 'u2' }, 'x'), /msg_id/);
});

test('官方 WebSocket：HELLO → IDENTIFY → READY → 群事件', async () => {
  const calls = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  }
  const t = new OfficialTransport({
    appId: 'a', clientSecret: 'b', logger: silent,
    fetchImpl: fakeFetch(calls), WebSocketImpl: FakeWS, wsUrl: 'wss://test',
  });
  t.ws = new FakeWS('wss://test');
  const ready = [];
  const messages = [];
  t.on('ready', (r) => ready.push(r));
  t.on('message', (m) => messages.push(m));

  t._handlePayload({ op: 10, d: { heartbeat_interval: 45000 } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.ws.sent[0].op, 2);
  assert.strictEqual(t.ws.sent[0].d.token, 'QQBot tok');
  assert.strictEqual(t.ws.sent[0].d.intents, 1 << 25);

  t._handlePayload({
    op: 0, s: 1, t: 'READY',
    d: { session_id: 's1', user: { id: '999', username: 'bot' } },
  });
  assert.strictEqual(ready.length, 1);
  assert.strictEqual(ready[0].selfId, '999');

  t._handlePayload({
    op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'm1', content: '<@!999> 在吗', group_openid: 'g1',
      author: { member_openid: 'u1', username: '测试用户' },
      timestamp: '2026-11-11T12:00:00+08:00',
    },
  });
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].text, '在吗');
  await t.close();
});
