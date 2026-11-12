const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSupportKb, formatSupportKb, MAX } = require('../src/support-kb');

test('support-kb：读取/格式化/缺失/截断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-kb-'));
  fs.mkdirSync(path.join(root, 'common'), { recursive: true });

  assert.strictEqual(loadSupportKb(root), '');
  assert.strictEqual(formatSupportKb(''), '');

  fs.writeFileSync(path.join(root, 'common', 'support-kb.md'), '核星记忆：开源记忆系统。', 'utf8');
  const text = loadSupportKb(root);
  assert.strictEqual(text, '核星记忆：开源记忆系统。');
  const formatted = formatSupportKb(text);
  assert.match(formatted, /^\[客服知识/);
  assert.match(formatted, /核星记忆/);

  fs.writeFileSync(path.join(root, 'common', 'support-kb.md'), 'x'.repeat(MAX + 100), 'utf8');
  assert.strictEqual(loadSupportKb(root).length, MAX);
});
