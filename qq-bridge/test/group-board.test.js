const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GroupBoard, DAY_MS } = require('../src/group-board');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-board-'));
}

test('追加/读取群友分板，不建群级日志', () => {
  const root = tmpRoot();
  let now = 1760000000000;
  const board = new GroupBoard({ root, now: () => now });

  board.append({ gid: '200', uid: '300', role: 'user', text: '在吗', mid: '1' });
  board.append({ gid: '200', uid: '300', role: 'assistant', text: '在', mid: '2' });

  const rows = board.recent({ gid: '200', uid: '300' });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].role, 'user');
  assert.strictEqual(rows[1].role, 'assistant');
  assert.match(rows[0].at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const groupDir = path.join(root, 'groups', '200');
  assert.deepStrictEqual(fs.readdirSync(groupDir), ['members']);
});

test('超过 24h 自动清掉', () => {
  const root = tmpRoot();
  let now = 1760000000000;
  const board = new GroupBoard({ root, now: () => now });

  board.append({ gid: '200', uid: '300', role: 'user', text: '旧消息' });
  now += DAY_MS + 1000;
  board.append({ gid: '200', uid: '300', role: 'user', text: '新消息' });

  const rows = board.recent({ gid: '200', uid: '300' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, '新消息');
});

test('空板删文件', () => {
  const root = tmpRoot();
  let now = 1760000000000;
  const board = new GroupBoard({ root, now: () => now });

  board.append({ gid: '200', uid: '300', role: 'user', text: 'x' });
  const file = board.fileFor('200', '300');
  assert.strictEqual(fs.existsSync(file), true);

  now += DAY_MS + 1000;
  board.prune({ gid: '200', uid: '300' });
  assert.strictEqual(fs.existsSync(file), false);
});

test('sweep 清扫：旧板删除，新板保留，空目录清掉', () => {
  const root = tmpRoot();
  let now = 1760000000000;
  const board = new GroupBoard({ root, now: () => now });

  board.append({ gid: '200', uid: '300', role: 'user', text: '旧' });
  board.append({ gid: '201', uid: '301', role: 'user', text: '也旧' });

  now += DAY_MS + 1000;
  board.append({ gid: '200', uid: '302', role: 'user', text: '新' });

  const r = board.sweep();
  assert.strictEqual(r.scanned, 3);
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.prunedFiles, 2);
  assert.strictEqual(fs.existsSync(board.fileFor('200', '300')), false);
  assert.strictEqual(fs.existsSync(board.fileFor('201', '301')), false);
  assert.strictEqual(fs.existsSync(board.fileFor('200', '302')), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'groups', '201')), false);
});

test('不同群/不同人分开', () => {
  const root = tmpRoot();
  const board = new GroupBoard({ root, now: () => 1760000000000 });

  board.append({ gid: '200', uid: '300', role: 'user', text: 'A' });
  board.append({ gid: '200', uid: '301', role: 'user', text: 'B' });
  board.append({ gid: '201', uid: '300', role: 'user', text: 'C' });

  assert.strictEqual(board.recent({ gid: '200', uid: '300' })[0].text, 'A');
  assert.strictEqual(board.recent({ gid: '200', uid: '301' })[0].text, 'B');
  assert.strictEqual(board.recent({ gid: '201', uid: '300' })[0].text, 'C');
});
