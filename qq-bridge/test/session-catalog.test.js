const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { listSessions } = require('../src/session-catalog');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-catalog-'));
}

test('读取多段 zstd 拼接的 session 头和标题', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'cwd', 'sess');
  fs.mkdirSync(dir, { recursive: true });
  const a = Buffer.from(JSON.stringify({
    type: 'session', version: 4, id: 'dsh:test', createdAt: 1000, cwd: 'C:\\work', agentPreset: 'standard',
  }) + '\n');
  const b = Buffer.from(JSON.stringify({
    type: 'session/title', seq: 2, time: 2000, data: { title: '我的会话', messageSeqs: [], source: { kind: 'user' } },
  }) + '\n');
  fs.writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zlib.zstdCompressSync(a), zlib.zstdCompressSync(b)]),
  );

  const rows = listSessions(root);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'dsh:test');
  assert.strictEqual(rows[0].title, '我的会话');
  assert.strictEqual(rows[0].cwd, 'C:\\work');
  assert.strictEqual(rows[0].agentPreset, 'standard');
  assert.strictEqual(rows[0].lastActive, 2000);
});

test('未命名的会话也能列出，按最近活动排序', () => {
  const root = tmpRoot();
  const make = (name, id) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.v4.jsonl'),
      JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000 }) + '\n',
    );
  };
  make('a', 'dsh:a');
  make('b', 'dsh:b');

  const rows = listSessions(root);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => r.title === '（未命名）'));
});

test('坏文件不抛，跳过', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bad', 'session.v4.jsonl.zstd'), Buffer.from('not-zstd'));
  assert.deepStrictEqual(listSessions(root), []);
});
