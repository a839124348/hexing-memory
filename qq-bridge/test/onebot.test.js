const test = require('node:test');
const assert = require('node:assert');
const { OneBotClient } = require('../src/onebot');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.readyState = 1;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }

  emit(name, event) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

const logger = { info() {}, warn() {}, error() {} };

test('连接后发私聊，按 echo 收结果', async () => {
  FakeWebSocket.instances = [];
  const c = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    token: 'secret',
    WebSocketImpl: FakeWebSocket,
    reconnect: false,
    logger,
  });

  c.connect();
  const ws = FakeWebSocket.instances[0];
  assert.match(ws.url, /access_token=secret/);
  ws.emit('open');
  assert.strictEqual(c.connected, true);

  const pending = c.sendPrivate('12345', '你好');
  assert.strictEqual(ws.sent[0].action, 'send_private_msg');
  assert.strictEqual(ws.sent[0].params.user_id, 12345);
  assert.strictEqual(ws.sent[0].params.message, '你好');

  ws.emit('message', {
    data: JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: { message_id: 99 },
      echo: ws.sent[0].echo,
    }),
  });

  assert.deepStrictEqual(await pending, { message_id: 99 });
  c.close();
});

test('收到消息事件会 emit event', () => {
  FakeWebSocket.instances = [];
  const c = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    WebSocketImpl: FakeWebSocket,
    reconnect: false,
    logger,
  });
  c.connect();
  const ws = FakeWebSocket.instances[0];
  ws.emit('open');

  let got = null;
  c.on('event', (e) => { got = e; });
  ws.emit('message', {
    data: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 12345,
      message_id: 1,
      message: [{ type: 'text', data: { text: 'hi' } }],
    }),
  });

  assert.strictEqual(got.post_type, 'message');
  assert.strictEqual(got.user_id, 12345);
  c.close();
});

test('未连接时调用直接拒绝', async () => {
  const c = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    WebSocketImpl: FakeWebSocket,
    reconnect: false,
    logger,
  });
  await assert.rejects(() => c.sendPrivate('1', 'x'), /未连接/);
  c.close();
});
