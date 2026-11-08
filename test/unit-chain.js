/**
 * unit-chain.js — 链网存储层测试
 *
 * 覆盖：核星根节点、父子结构、头部、节点追加、状态节点 superseded、健康检查
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChainStore } = require('../src/chain');

const TMP = path.join(os.tmpdir(), 'chain-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const cs = new ChainStore(TMP);

// 1. 核星自动创建
{
  const root = cs.get('核星');
  check('核星自动创建', !!root && root.parent === null);
  check('核星有头部说明', !!root && root.header.length > 0);
}

// 2. 建父节点 + 子链
{
  const r1 = cs.create('身份', '核星', '关于人的一切');
  check('建父节点「身份」', r1.ok && r1.chain.parent === '核星');

  const r2 = cs.create('身份链', '身份', '用户：喜欢西瓜；做三进制。时助手：本名时助手。');
  check('建子链「身份链」', r2.ok && r2.chain.parent === '身份');
  check('身份链头部写入', r2.chain.header.includes('西瓜'));
}

// 3. 建项目父节点和项目链
{
  cs.create('项目', '核星', '所有项目');
  cs.create('项目链-开源记忆系统', '项目', '做一套能跨平台用的记忆系统');
  const list = cs.list('项目');
  check('项目下有一条子链', list.length === 1 && list[0].name === '项目链-开源记忆系统');
}

// 4. 追加节点
{
  const r = cs.append('身份链', { t: '2026-11-07 02:54', who: '我们', type: 'event', text: '给助手起了本名时助手，平时叫助手' });
  check('追加节点成功', r.ok && r.added === 1 && r.total === 1);
  check('节点带 who 字段', cs.get('身份链').nodes[0].who === '我们');
}

// 5. 批量追加（数组）
{
  const r = cs.append('身份链', [
    { t: '2026-11-07 03:00', who: '你', type: 'state', text: '喜欢吃西瓜' },
    { t: '2026-11-07 03:01', who: '我', type: 'event', text: '说会记住他爱吃西瓜' },
  ]);
  check('批量追加 2 个', r.ok && r.added === 2 && r.total === 3);
}

// 6. 状态节点被推翻
{
  cs.append('身份链', { t: '2026-11-08 10:00', who: '你', type: 'state', text: '不喜欢西瓜了，喜欢桃子', supersedes: '西瓜' });
  const nodes = cs.get('身份链').nodes;
  const old = nodes.find((n) => n.text.includes('喜欢吃西瓜'));
  const cur = nodes.find((n) => n.text.includes('喜欢桃子'));
  check('旧状态被标 superseded', old.superseded === true);
  check('新状态未被标', cur.superseded === false);
  check('旧状态仍保留（不删除）', !!old);
}

// 7. 节点 ≥5 时提示建头部
{
  const r = cs.create('测试链', '身份', '');
  for (let i = 0; i < 5; i++) cs.append('测试链', { t: '2026-11-07 0' + i + ':00', type: 'event', text: '第 ' + i + ' 条' });
  const after = cs.append('测试链', { t: '2026-11-07 09:00', type: 'event', text: '第六条' });
  check('节点 ≥5 提示 needHeader', after.needHeader === true);
}

// 8. 树结构
{
  const t = cs.tree();
  check('树根是核星', t.根 && t.根.name === '核星');
  const names = t.树.map((x) => x.name);
  check('一级有身份和项目', names.includes('身份') && names.includes('项目'));
  const identity = t.树.find((x) => x.name === '身份');
  check('身份下有子链', identity && identity.children.some((c) => c.name === '身份链'));
}

// 9. 父节点不存在时自动创建（而不是产生孤儿链）
{
  cs.create('子链', '自动建的父');
  check('父节点自动创建', fs.existsSync(path.join(TMP, 'links', '自动建的父.json')));
  const a = cs.audit();
  check('没有孤儿链', a.孤儿链.length === 0, JSON.stringify(a.孤儿链));
  check('链总数正确', a.总数 >= 6, String(a.总数));
}

// 9b. 真孤儿（手写一个父不存在的文件）能被检出
{
  const bad = path.join(TMP, 'links', '真孤儿.json');
  fs.writeFileSync(bad, JSON.stringify({ name: '真孤儿', parent: '这个父不存在', header: '', nodes: [] }), 'utf8');
  const a = cs.audit();
  check('检出真孤儿', a.孤儿链.includes('真孤儿'), JSON.stringify(a.孤儿链));
  fs.unlinkSync(bad);
}

// 10. 不存在的链追加
{
  const r = cs.append('不存在', { text: 'x' });
  check('不存在的链拒绝追加', r.ok === false && /不存在/.test(r.error));
}

// 11. 路径穿越防护
{
  const r = cs.create('../../evil');
  const file = path.join(TMP, 'links', '..json');
  check('链名做了安全处理', !fs.existsSync(path.join(TMP, '..', 'evil.json')));
}

// 12. 空文本节点被忽略
{
  const r = cs.append('身份链', { t: '2026-11-07 10:00', text: '   ' });
  check('空文本不写入', r.added === 0);
}

// 13. 父链校验（工具 append 的护栏）
{
  check('父链=核星 → 第 1 层', cs.checkParent('核星').ok && cs.checkParent('核星').depth === 1);
  check('父链=已有根 → 第 2 层', cs.checkParent('身份').ok && cs.checkParent('身份').depth === 2);
  check('父链=已有子链 → 第 3 层', cs.checkParent('身份链').ok && cs.checkParent('身份链').depth === 3);
  const bad = cs.checkParent('不存在的父链');
  check('不存在的父链被拒绝', bad.ok === false && /父链不存在/.test(bad.error), JSON.stringify(bad));

  cs.create('层级A', '核星', '');
  cs.create('层级B', '层级A', '');
  cs.create('层级C', '层级B', '');
  cs.create('层级D', '层级C', '');
  check('第 4 层还能挂', cs.checkParent('层级C').ok && cs.checkParent('层级C').depth === 4);
  const deep = cs.checkParent('层级D');
  check('超过 4 层被拒绝', deep.ok === false && /超过/.test(deep.error), JSON.stringify(deep));
}

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
