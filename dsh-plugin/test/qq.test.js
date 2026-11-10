import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QQSessionMap } from '../src/qq/session-map.js';
import { QQOutbound } from '../src/qq/outbound.js';

function makeFakeCtx() {
  const created = [];
  const followed = [];
  const ctx = {
    agents: {
      async resume() { throw new Error('no session'); },
      async create(opts) {
        created.push(opts);
        const agent = {
          session: { id: opts.sessionId },
          followup(msg) { followed.push(msg); },
        };
        return { agent };
      },
    },
    agentPresets: { async mount() {} },
    workspaceRegistry: { async create() {} },
  };
  return { ctx, created, followed };
}

test('owner 私聊：首次 create，之后复用 agent', async () => {
  const { ctx, created, followed } = makeFakeCtx();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal', provider: 'p', model: 'm' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await map.deliver({ chatKey: 'qq:owner', chat: { kind: 'private', id: '1', userId: '1' }, text: '你好' });
  await map.deliver({ chatKey: 'qq:owner', chat: { kind: 'private', id: '1', userId: '1' }, text: '再来' });

  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].sessionId, 'qq:owner');
  assert.strictEqual(created[0].meta.agentPreset, 'standard');
  assert.strictEqual(followed.length, 2);
  assert.deepStrictEqual(followed[0].content, [{ type: 'text', text: '你好' }]);
});

test('群 @：使用 groupPreset，sessionId 按群+成员隔离', async () => {
  const { ctx, created } = makeFakeCtx();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal', provider: 'p', model: 'm' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await map.deliver({
    chatKey: 'qq:group:200:300',
    chat: { kind: 'group', id: '200', groupId: '200', userId: '300' },
    text: '在吗',
  });

  assert.strictEqual(created[0].sessionId, 'qq:group:200:300');
  assert.strictEqual(created[0].meta.agentPreset, 'minimal');
});

test('outbound：assistant 文本在 turn/end 发出', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const chat = { kind: 'private', id: '1', userId: '1' };
  const sent = [];
  const out = new QQOutbound({
    ctx,
    sessionMap: { chatForSession: (id) => (id === 'qq:owner' ? chat : null) },
    logger: { info() {}, warn() {}, error() {} },
    send: async (c, text) => { sent.push({ c, text }); },
  });
  out.install();

  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一段' }] } },
  });
  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第二段' }] } },
  });
  handler({ id: 'qq:owner' }, { type: 'turn/end', data: {} });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, '第一段\n\n第二段');
});

test('outbound：非 qq: 会话不处理', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const sent = [];
  const out = new QQOutbound({
    ctx,
    sessionMap: { chatForSession: () => ({ kind: 'private', userId: '1' }) },
    logger: { info() {}, warn() {}, error() {} },
    send: async () => { sent.push(1); },
  });
  out.install();

  handler({ id: 'dsh:other' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '不该发' }] } },
  });
  handler({ id: 'dsh:other' }, { type: 'turn/end', data: {} });

  assert.strictEqual(sent.length, 0);
});

test('outbound：guard 拦截时不发送', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const sent = [];
  const out = new QQOutbound({
    ctx,
    sessionMap: { chatForSession: () => ({ kind: 'private', userId: '1' }) },
    logger: { info() {}, warn() {}, error() {} },
    guard: { check: () => ({ ok: false, reason: 'blocked' }), record() {} },
    send: async () => { sent.push(1); },
  });
  out.install();

  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '被拦' }] } },
  });
  handler({ id: 'qq:owner' }, { type: 'turn/end', data: {} });

  assert.strictEqual(sent.length, 0);
});
