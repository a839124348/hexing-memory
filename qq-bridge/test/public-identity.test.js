const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPublicIdentity } = require('../src/public-identity');

test('public-identity：只读公开字段，缺失返回空', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-'));
  assert.deepStrictEqual(loadPublicIdentity(root), { aiName: '', userTitle: '', relation: '' });

  fs.mkdirSync(path.join(root, 'common'), { recursive: true });
  fs.writeFileSync(path.join(root, 'common', 'identity.json'), JSON.stringify({
    aiName: '小绪',
    userTitle: '小明',
    relation: '朋友关系',
    aiSelf: '这是私密自述，不应被群聊读取',
    userInfo: '私事',
  }), 'utf8');

  const id = loadPublicIdentity(root);
  assert.strictEqual(id.aiName, '小绪');
  assert.strictEqual(id.userTitle, '小明');
  assert.strictEqual(id.relation, '朋友关系');
  assert.strictEqual(Object.keys(id).length, 3);
});
