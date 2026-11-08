/**
 * unit-topic-llm.js — LLM 输出 topics → 创意池升格
 */
const fs = require('fs');
const path = require('path');
const { ChainStore } = require('../src/chain');
const { TopicStore } = require('../src/topics');
const { refineWithLLM } = require('../src/llm');

const root = path.join(__dirname, '.tmp-topic-llm');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const chain = new ChainStore(root);
const topics = new TopicStore(root);

const records = Array.from({ length: 5 }, (_, i) => ({
  t: '2026-11-08 10:0' + i, s: '用户', c: '想法-' + i, cid: 'c1', v: 1,
}));

const fake = async () => JSON.stringify({
  chains: [],
  topics: [{
    type: '想法', title: '创意池-2026-11', summary: '11 月的五个独立想法',
    items: records.map((r, i) => ({ t: r.t, who: '你', text: r.c })),
  }],
});

(async () => {
  const r = await refineWithLLM({ records, chainStore: chain, topicStore: topics, call: fake, fallbackT: '2026-11-08 10:00' });
  check('LLM topics 写入 5 条', r.topicItems === 5, JSON.stringify(r));
  check('升格 1 个池', Array.isArray(r.topics) && r.topics[0] === '创意池-2026-11', JSON.stringify(r.topics));
  const pool = chain.get('创意池-2026-11');
  check('创意池 5 节点', pool && pool.nodes.length === 5, pool ? pool.nodes.length : 'null');
  check('池挂想法下', pool && pool.parent === '想法');
  check('话题状态 promoted', topics.list()[0].status === 'promoted');

  // 同批重复：不重复计数、不重复节点
  const r2 = await refineWithLLM({ records, chainStore: chain, topicStore: topics, call: fake, fallbackT: '2026-11-08 10:00' });
  check('重复批 topicItems=0', r2.topicItems === 0, JSON.stringify(r2));
  check('池仍 5 节点', chain.get('创意池-2026-11').nodes.length === 5);

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
