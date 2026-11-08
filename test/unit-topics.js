/**
 * unit-topics.js — 创意池 / 话题栈
 */
const fs = require('fs');
const path = require('path');
const { TopicStore, THRESHOLD } = require('../src/topics');
const { ChainStore } = require('../src/chain');

const root = path.join(__dirname, '.tmp-topics');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const topics = new TopicStore(root);
const chain = new ChainStore(root);

function idea(i, month = '11') {
  return {
    type: '想法',
    title: '三进制创意-' + i, // 故意给不同标题：想法类应强制并入月度池
    t: '2026-' + month + '-0' + ((i % 8) + 1) + ' 10:0' + (i % 9),
    who: '你',
    text: '想法-' + i,
  };
}

// 1. 4 个互不相关的想法：不建链
const r4 = topics.apply([idea(0), idea(1), idea(2), idea(3)], chain);
check('4 条不建链', r4.promoted.length === 0 && chain.get('创意池-2026-11') === null, JSON.stringify(r4));
const t1 = topics.list()[0];
check('4 条同池', t1 && t1.count === 4 && t1.title === '创意池-2026-11', JSON.stringify(t1));

// 2. 第 5 条：升格为池链
const r5 = topics.apply([idea(4)], chain);
check('第 5 条升格', r5.promoted.length === 1 && r5.promoted[0] === '创意池-2026-11', JSON.stringify(r5));
const pool = chain.get('创意池-2026-11');
check('池链 5 节点', pool && pool.nodes.length === 5, pool ? pool.nodes.length : 'null');
check('池挂想法下', pool && pool.parent === '想法', pool && pool.parent);
check('池有头部', pool && !!pool.header, pool && pool.header);
check('话题 promoted', topics.get(t1.id).status === 'promoted');

// 3. 第 6 条：直接进已有池，不新建链
const beforeChains = chain.list().length;
topics.apply([idea(5)], chain);
const pool6 = chain.get('创意池-2026-11');
check('第 6 条进已有池', pool6.nodes.length === 6, 'nodes=' + pool6.nodes.length);
check('不新建第二条池链', chain.list().length === beforeChains, 'chains=' + chain.list().length);

// 4. 重复想法不重复计数
const rdup = topics.apply([idea(5)], chain);
check('重复想法 added=0', rdup.added === 0);
check('重复后仍 6 节点', chain.get('创意池-2026-11').nodes.length === 6);

// 4b. 同一条想法 who 不同（"" vs "你"）也不能重复计数
const rwho = topics.apply([{ ...idea(5), who: '' }], chain);
check('who 不同仍算重复', rwho.added === 0 && chain.get('创意池-2026-11').nodes.length === 6, JSON.stringify(rwho));

// 5. 跨月新池
topics.apply([idea(0, '12')], chain);
const dec = topics.list().find((t) => t.title === '创意池-2026-12');
check('跨月新池 open', dec && dec.status === 'open' && dec.count === 1);
check('跨月不建链', chain.get('创意池-2026-12') === null);

// 6. 立项：从池里升格成项目链
const promote = topics.promote(t1.id, 0, '项目链-光轴', chain);
check('立项建项目链', promote.ok && chain.get('项目链-光轴'), JSON.stringify(promote));
const project = chain.get('项目链-光轴');
check('项目挂项目下', project.parent === '项目');
check('想法是首节点', project.nodes[0].text === '想法-0', project.nodes[0].text);
check('原想法保留并挂 promoted_to', topics.get(t1.id).items[0].promoted_to === '项目链-光轴');
const again = topics.promote(t1.id, 0, '项目链-光轴', chain);
check('重复立项幂等', again.existed === true && chain.get('项目链-光轴').nodes.length === 1);

// 7. 非想法类：按主题建链
for (let i = 0; i < 5; i++) {
  topics.apply([{
    type: '学习', title: '学习链-三进制',
    t: '2026-11-09 10:0' + i, who: '你', text: '学习点-' + i,
  }], chain);
}
const learn = chain.get('学习链-三进制');
check('学习主题 5 条成链', learn && learn.nodes.length === 5, learn ? learn.nodes.length : 'null');
check('学习链挂学习下', learn && learn.parent === '学习');

// 8. 关闭 / 合并
const close = topics.close(dec.id, '过期');
check('关闭话题', close.ok && topics.get(dec.id).status === 'closed');
const mergeFrom = topics.list().find((t) => t.title === '创意池-2026-12');
const mergeInto = topics.list().find((t) => t.title === '创意池-2026-11');
if (mergeFrom && mergeInto) {
  const m = topics.merge(mergeFrom.id, mergeInto.id);
  check('合并话题', m.ok && topics.get(mergeFrom.id).status === 'merged');
}

check('话题锁无残留', !fs.existsSync(path.join(root, '.topics.lock')));
check('阈值是 5', THRESHOLD === 5);

console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
