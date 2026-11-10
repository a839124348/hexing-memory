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

test('群 @：使用 groupPreset，一个群一个会话', async () => {
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
    chatKey: 'qq:group:200',
    chat: { kind: 'group', id: '200', groupId: '200', userId: '300' },
    text: '在吗',
  });

  assert.strictEqual(created[0].sessionId, 'qq:group:200');
  assert.strictEqual(created[0].meta.agentPreset, 'minimal');

  await map.deliver({
    chatKey: 'qq:group:200',
    chat: { kind: 'group', id: '200', groupId: '200', userId: '301' },
    text: '另一个人',
  });

  assert.strictEqual(created.length, 1);
  assert.strictEqual(map.chatForSession('qq:group:200').userId, '301');
});

test('已激活 agent 复用时也写回 chat 映射', async () => {
  const followed = [];
  const agent = {
    session: { id: 'qq:owner' },
    followup(msg) { followed.push(msg); },
  };
  const ctx = {
    agents: {
      get: () => agent,
      async resume() { throw new Error('should not resume'); },
      async create() { throw new Error('should not create'); },
    },
    agentPresets: { async mount() {} },
    workspaceRegistry: { async create() {} },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal', provider: 'p', model: 'm' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await map.deliver({ chatKey: 'qq:owner', chat: { kind: 'private', id: '1', userId: '1' }, text: '在吗' });

  assert.ok(map.chatForSession('qq:owner'));
  assert.strictEqual(map.chatForSession('qq:owner').kind, 'private');
  assert.strictEqual(followed.length, 1);
});

test('会话标题：私聊/群聊写入一次，重复投递不重复 rename', async () => {
  const renamed = [];
  const { ctx, created } = makeFakeCtx();
  ctx.get = (name) => (name === 'sessionTitle'
    ? { rename(session, title) { renamed.push({ id: session.id, title }); } }
    : null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await map.deliver({ chatKey: 'qq:owner', chat: { kind: 'private', id: '1', userId: '1' }, text: '在吗', title: '大号私聊会话' });
  await map.deliver({ chatKey: 'qq:owner', chat: { kind: 'private', id: '1', userId: '1' }, text: '再来', title: '大号私聊会话' });
  await map.deliver({
    chatKey: 'qq:group:200',
    chat: { kind: 'group', id: '200', groupId: '200', userId: '300' },
    text: '在吗',
    title: '测试群',
  });

  assert.strictEqual(created.length, 2);
  assert.deepStrictEqual(renamed, [
    { id: 'qq:owner', title: '大号私聊会话' },
    { id: 'qq:group:200', title: '测试群' },
  ]);
});

test('绑定会话：投到指定 sessionId，不改名，不新建', async () => {
  const renamed = [];
  const followed = [];
  const { ctx, created } = makeFakeCtx();
  ctx.get = (name) => (name === 'sessionTitle'
    ? { rename(session, title) { renamed.push({ id: session.id, title }); } }
    : null);
  // 指定会话已存在（live）
  ctx.agents.get = (id) => (id === 'dsh:main'
    ? { session: { id }, followup(msg) { followed.push(msg); } }
    : undefined);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await map.deliver({
    chatKey: 'qq:owner',
    chat: { kind: 'private', id: '1', userId: '1' },
    text: '[QQ私聊] 在吗',
    sessionId: 'dsh:main',
    createIfMissing: false,
  });

  assert.strictEqual(created.length, 0);
  assert.strictEqual(renamed.length, 0);
  assert.strictEqual(map.chatForSession('dsh:main').kind, 'private');
  assert.strictEqual(followed.length, 1);
});

test('绑定会话不存在时抛错，不偷偷新建', async () => {
  const { ctx, created } = makeFakeCtx();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  const map = new QQSessionMap({
    ctx,
    config: { cwd: tmp, agentPreset: 'standard', groupPreset: 'minimal' },
    logger: { info() {}, warn() {}, error() {} },
    makeSessionId: (id) => id,
    makeUserMessage: (x) => x,
  });

  await assert.rejects(
    () => map.deliver({
      chatKey: 'qq:owner',
      chat: { kind: 'private', id: '1', userId: '1' },
      text: '[QQ私聊] 在吗',
      sessionId: 'dsh:missing',
      createIfMissing: false,
    }),
    /不存在或无法恢复/,
  );
  assert.strictEqual(created.length, 0);
});

test('outbound：QQ 来源的一轮在 turn/end 发出', async () => {
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

  handler({ id: 'qq:owner' }, { type: 'turn/start', data: { turn: 1 } });
  handler({ id: 'qq:owner' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'hexing-qq' }, content: [{ type: 'text', text: '在吗' }] },
  });
  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一段' }] } },
  });
  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第二段' }] } },
  });
  handler({ id: 'qq:owner' }, { type: 'turn/end', data: { turn: 1 } });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, '第一段\n\n第二段');
});

test('outbound：绑定会话里 UI 来源的轮次不发 QQ', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const chat = { kind: 'private', id: '1', userId: '1' };
  const sent = [];
  const out = new QQOutbound({
    ctx,
    // 主会话 id 不是 qq: 前缀，靠 sessionMap 映射识别
    sessionMap: { chatForSession: (id) => (id === 'dsh:main' ? chat : null) },
    logger: { info() {}, warn() {}, error() {} },
    send: async (c, text) => { sent.push({ c, text }); },
  });
  out.install();

  // UI 触发的一轮
  handler({ id: 'dsh:main' }, { type: 'turn/start', data: { turn: 7 } });
  handler({ id: 'dsh:main' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'UI 里说的话' }] },
  });
  handler({ id: 'dsh:main' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'UI 的回复' }] } },
  });
  handler({ id: 'dsh:main' }, { type: 'turn/end', data: { turn: 7 } });

  // QQ 触发的一轮
  handler({ id: 'dsh:main' }, { type: 'turn/start', data: { turn: 8 } });
  handler({ id: 'dsh:main' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'hexing-qq' }, content: [{ type: 'text', text: '[QQ私聊] 在吗' }] },
  });
  handler({ id: 'dsh:main' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'QQ 的回复' }] } },
  });
  handler({ id: 'dsh:main' }, { type: 'turn/end', data: { turn: 8 } });

  assert.deepStrictEqual(sent.map((x) => x.text), ['QQ 的回复']);
});

test('outbound：非映射会话不处理', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const sent = [];
  const out = new QQOutbound({
    ctx,
    sessionMap: { chatForSession: () => null },
    logger: { info() {}, warn() {}, error() {} },
    send: async () => { sent.push(1); },
  });
  out.install();

  handler({ id: 'dsh:other' }, { type: 'turn/start', data: { turn: 1 } });
  handler({ id: 'dsh:other' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' } },
  });
  handler({ id: 'dsh:other' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '不该发' }] } },
  });
  handler({ id: 'dsh:other' }, { type: 'turn/end', data: { turn: 1 } });

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

  handler({ id: 'qq:owner' }, { type: 'turn/start', data: { turn: 1 } });
  handler({ id: 'qq:owner' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'hexing-qq' }, content: [{ type: 'text', text: '在吗' }] },
  });
  handler({ id: 'qq:owner' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '被拦' }] } },
  });
  handler({ id: 'qq:owner' }, { type: 'turn/end', data: { turn: 1 } });

  assert.strictEqual(sent.length, 0);
});

test('outbound：限流时排队，窗口过了再发', async () => {
  let handler = null;
  const ctx = { on(name, fn) { if (name === 'session/event') handler = fn; } };
  const sent = [];
  let checks = 0;
  const out = new QQOutbound({
    ctx,
    sessionMap: { chatForSession: () => ({ kind: 'group', groupId: '200', userId: '300' }) },
    logger: { info() {}, warn() {}, error() {} },
    guard: {
      check() {
        checks++;
        return checks === 1 ? { ok: false, reason: '限流', waitMs: 60 } : { ok: true };
      },
      record() {},
    },
    send: async (chat, text) => { sent.push(text); },
  });
  out.install();

  handler({ id: 'qq:group:200' }, { type: 'turn/start', data: { turn: 1 } });
  handler({ id: 'qq:group:200' }, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'hexing-qq' }, content: [{ type: 'text', text: '在吗' }] },
  });
  handler({ id: 'qq:group:200' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '排队' }] } },
  });
  handler({ id: 'qq:group:200' }, { type: 'turn/end', data: { turn: 1 } });

  await new Promise((r) => setTimeout(r, 160));
  assert.deepStrictEqual(sent, ['排队']);
});
