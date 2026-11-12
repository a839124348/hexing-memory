import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(__dirname, '..', 'src', 'qq-plugin.js');
const transportPath = path.join(__dirname, '..', '..', 'qq-bridge', 'src', 'transport.js');

class FakeTransport {
  constructor() {
    this.handlers = new Map();
    this.replies = [];
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  emit(event, payload) {
    for (const h of this.handlers.get(event) || []) h(payload);
  }
  async connect() { this.emit('ready', { selfId: '999' }); }
  async close() {}
  capabilities() {
    return {
      groupScope: 'mention-only', canProactive: false, canHistory: false,
      canGroupInfo: false, canLoginInfo: false, maxReplyLength: 0,
      replyMode: 'official-passive',
    };
  }
  async reply(chat, text, opts) { this.replies.push({ chat, text, opts }); }
}

const fakeTransport = new FakeTransport();
const req = createRequire(pathToFileURL(pluginPath));
const resolved = req.resolve(transportPath);
req.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: { createTransport: () => fakeTransport, QQTransport: class {} },
};

const { apply } = await import(pathToFileURL(pluginPath).href);

function makeCtx() {
  const effects = [];
  const created = [];
  return {
    effects,
    created,
    ctx: {
      on() {},
      effect(fn) { effects.push(fn); },
      get() { return null; },
      llm: {
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: '收到啦' };
          })();
        },
      },
      agents: {
        get() { return null; },
        async resume() { throw new Error('no session'); },
        async create(opts) { created.push(opts); throw new Error('should not create group session'); },
      },
      sessions: { get() { return null; }, list() { return []; } },
      tools: { register() { return () => {}; } },
      agentPresets: { async mount() {} },
      workspaceRegistry: { async create() {} },
    },
  };
}

test('群聊 stateless：不建 DSH 会话，只回一次并写 24h 分板', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stateless-'));
  process.env.MEMORY_ROOT = path.join(root, 'memory');
  const { ctx, created } = makeCtx();

  apply(ctx, {
    transport: 'onebot',
    ownerId: '1',
    groupEnabled: true,
    groupMode: 'stateless',
    provider: 'p',
    model: 'm',
    qqRoot: path.join(root, 'qq'),
    memoryRoot: path.join(root, 'memory'),
    cwd: path.join(root, 'cwd'),
    dryRun: false,
    groupPrefix: 'GROUP SYSTEM',
    guard: { enabled: true, groupMinMs: 0, dedupeMs: 0 },
  });

  fakeTransport.emit('message', {
    kind: 'group',
    userId: '456',
    groupId: '200',
    text: '在吗',
    atSelf: true,
    messageId: 'm1',
    time: Math.floor(Date.now() / 1000),
    raw: { sender: { card: '测试用户' } },
  });

  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(created.length, 0, 'group 不应创建 DSH 会话');
  assert.strictEqual(fakeTransport.replies.length, 1);
  assert.strictEqual(fakeTransport.replies[0].text, '收到啦');
  assert.strictEqual(fakeTransport.replies[0].opts.mentionSender, true);

  const boardFile = path.join(root, 'qq', 'groups', '200', 'members', '456.jsonl');
  assert.strictEqual(fs.existsSync(boardFile), true);
  const rows = fs.readFileSync(boardFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].role, 'user');
  assert.strictEqual(rows[1].role, 'assistant');
  assert.strictEqual(rows[1].text, '收到啦');
});
