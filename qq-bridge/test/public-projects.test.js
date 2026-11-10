const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPublicProjects, formatPublicProjects } = require('../src/public-projects');

function rootWith(data) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-projects-'));
  fs.mkdirSync(path.join(root, 'common'), { recursive: true });
  if (data !== undefined) {
    fs.writeFileSync(path.join(root, 'common', 'public-projects.json'), JSON.stringify(data));
  }
  return root;
}

test('没有文件 → 空，默认不公开', () => {
  assert.deepStrictEqual(loadPublicProjects(rootWith(undefined)), []);
});

test('只收 public:true，过滤 private 和非法链接', () => {
  const root = rootWith({
    projects: [
      { name: '公开项目', public: true, summary: '可以介绍', links: ['https://example.com', 'ftp://x'] },
      { name: '私有项目', public: false, summary: '不能介绍' },
      { name: '没标 public', summary: '也不能介绍' },
    ],
  });
  const list = loadPublicProjects(root);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '公开项目');
  assert.deepStrictEqual(list[0].links, ['https://example.com']);
});

test('格式化：空列表明确说不要介绍', () => {
  assert.match(formatPublicProjects([]), /不要介绍任何项目/);
});

test('格式化：只列白名单并加限制语', () => {
  const text = formatPublicProjects([{ name: '公开项目', summary: '摘要', links: ['https://example.com'] }]);
  assert.match(text, /公开项目/);
  assert.match(text, /https:\/\/example.com/);
  assert.match(text, /其他项目一律不介绍/);
});
