import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(__dirname, '..', 'src', 'qq-plugin.js');
const onebotPath = path.join(__dirname, '..', '..', 'qq-bridge', 'src', 'onebot.js');

// 让 apply 里的 OneBotClient 不真的去连 WS；工具测试只关心 binding.json。
const req = createRequire(pathToFileURL(pluginPath));
const resolved = req.resolve(onebotPath);
req.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: { OneBotClient: class { on() {} connect() {} } },
};

const { apply } = await import(pathToFileURL(pluginPath).href);

function makeCtx(sessions) {
  const tools = [];
  const ctx = {
    on() {},
    effect() {},
    get() { return null; },
    agents: {
      get: (id) => sessions.get(id),
      async resume() { throw new Error('no session'); },
      async create() { throw new Error('should not create'); },
    },
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    tools: { register(def) { tools.push(def); return () => {}; } },
    agentPresets: { async mount() {} },
    workspaceRegistry: { async create() {} },
  };
  return { ctx, tools };
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bind-tool-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmp, 'dsh-home');
  const sessionDir = path.join(process.env.DSH_HOME, 'sessions', 'fake');
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = Buffer.from(JSON.stringify({
    type: 'session', version: 4, id: 'dsh:named', createdAt: 1000, cwd: 'C:\\named', agentPreset: 'standard',
  }) + '\n');
  const title = Buffer.from(JSON.stringify({
    type: 'session/title', seq: 2, time: 2000, data: { title: '日常聊天', messageSeqs: [], source: { kind: 'user' } },
  }) + '\n');
  fs.writeFileSync(
    path.join(sessionDir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zlib.zstdCompressSync(header), zlib.zstdCompressSync(title)]),
  );

  const sessions = new Map([
    ['dsh:test', { id: 'dsh:test' }],
    ['dsh:named', { id: 'dsh:named' }],
  ]);
  const { ctx, tools } = makeCtx(sessions);
  apply(ctx, {
    ownerId: '1',
    qqRoot: path.join(tmp, 'qq'),
    memoryRoot: tmp,
    dryRun: true,
    onebot: { url: 'ws://127.0.0.1:1' },
  });
  const tool = tools.find((t) => t.name === 'qq_bind_session');
  const bindingFile = path.join(tmp, 'qq', 'binding.json');
  const cleanup = () => {
    process.env.DSH_HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tool, bindingFile, cleanup };
}

test('qq_bind_session：绑当前会话 → 写 binding.json → unbind', async () => {
  const { tool, bindingFile, cleanup } = setup();
  try {
    assert.ok(tool, '工具已注册');
    const res = await tool.execute({ action: 'current' }, { agent: { session: { id: 'dsh:test' } } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sessionId, 'dsh:test');
    assert.strictEqual(res.mode, 'bound');

    const saved = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    assert.strictEqual(saved.ownerSessionId, 'dsh:test');
    assert.strictEqual(saved.boundBy, 'qq_bind_session');

    const res2 = await tool.execute({ action: 'unbind' }, { agent: { session: { id: 'dsh:test' } } });
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.mode, 'dedicated');
    assert.strictEqual(fs.existsSync(bindingFile), false);
  } finally {
    cleanup();
  }
});

test('qq_bind_session：按标题找到唯一会话', async () => {
  const { tool, bindingFile, cleanup } = setup();
  try {
    const res = await tool.execute({ action: 'title', title: '日常' }, { agent: { session: { id: 'dsh:test' } } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sessionId, 'dsh:named');
    assert.strictEqual(res.title, '日常聊天');
    const saved = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    assert.strictEqual(saved.ownerSessionId, 'dsh:named');
  } finally {
    cleanup();
  }
});

test('qq_bind_session：标题找不到时返回候选，不写绑定', async () => {
  const { tool, bindingFile, cleanup } = setup();
  try {
    const res = await tool.execute({ action: 'title', title: '不存在的会话' }, { agent: { session: { id: 'dsh:test' } } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /没有找到/);
    assert.ok(Array.isArray(res.candidates) && res.candidates.length >= 1);
    assert.strictEqual(fs.existsSync(bindingFile), false);
  } finally {
    cleanup();
  }
});

test('qq_bind_session：群会话拒绝绑定', async () => {
  const { tool, bindingFile, cleanup } = setup();
  try {
    const res = await tool.execute({ action: 'current' }, { agent: { session: { id: 'qq:group:123' } } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /群会话/);
    assert.strictEqual(fs.existsSync(bindingFile), false);
  } finally {
    cleanup();
  }
});
