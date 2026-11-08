/**
 * unit-chain-search.js — 链节点语义索引（假向量，不联网）
 */
const fs = require('fs');
const path = require('path');
const { ChainStore } = require('../src/chain');
const { ChainSearch } = require('../src/chain_search');

const root = path.join(__dirname, '.tmp-chain-search');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

// 假向量：光轴进度-N → 第 N 维为 1；其他链 → 全 0
function fakeEmbed(text) {
  const m = /进度-(\d+)/.exec(String(text));
  const v = new Array(12).fill(0);
  if (m) v[Number(m[1]) % 12] = 1;
  return Promise.resolve(v);
}

const chain = new ChainStore(root);
chain.create('项目链-光轴', '项目', '');
chain.create('项目链-其他', '项目', '');
for (let i = 0; i < 10; i++) {
  chain.append('项目链-光轴', { t: '2026-11-08 12:0' + (i % 9), who: '你', type: 'event', text: '光轴进度-' + i });
}
for (let i = 0; i < 5; i++) {
  chain.append('项目链-其他', { t: '2026-11-08 12:1' + i, who: '你', type: 'event', text: '其他进度-' + i });
}

const cs = new ChainSearch(root, chain, {
  embedFn: fakeEmbed,
  healthFn: async () => ({ ok: true, model: 'fake' }),
});

(async () => {
  const b1 = await cs.buildIndex();
  check('建索引 15 条', b1.ok && b1.total === 15 && b1.added === 15, JSON.stringify(b1));

  const q = await cs.query('光轴进度-5', { limit: 3 });
  check('语义命中中间节点', q.ok && q.mode === 'vector' && q.results[0].text === '光轴进度-5', JSON.stringify(q.results[0] || {}));
  check('返回链名/index/count', q.results[0].chain === '项目链-光轴' && q.results[0].nodeIndex === 5 && q.results[0].nodeCount === 10);

  const qf = await cs.query('光轴进度-5', { chain: '项目链-光轴', limit: 3 });
  check('按链过滤', qf.ok && qf.results.every((r) => r.chain === '项目链-光轴'));

  const qb = await cs.query('其他进度-2', { chain: '项目链-其他', limit: 3 });
  check('另一条链可查', qb.results[0].text === '其他进度-2' && qb.results[0].chain === '项目链-其他');

  // 增量：加一个节点，只新增 1
  chain.append('项目链-光轴', { t: '2026-11-08 12:59', who: '你', type: 'event', text: '光轴进度-10' });
  const b2 = await cs.buildIndex();
  check('增量只加 1', b2.ok && b2.added === 1 && b2.total === 16, JSON.stringify(b2));
  const q10 = await cs.query('光轴进度-10', { chain: '项目链-光轴', limit: 2 });
  check('新节点可查', q10.results[0].text === '光轴进度-10');

  const b3 = await cs.buildIndex();
  check('无新增幂等', b3.ok && b3.added === 0 && b3.total === 16, JSON.stringify(b3));

  // 降级：embed 挂 → 关键词
  const csBad = new ChainSearch(root, chain, {
    embedFn: async () => { throw new Error('down'); },
    healthFn: async () => ({ ok: false }),
  });
  const qk = await csBad.query('光轴进度-5', { chain: '项目链-光轴', limit: 2 });
  check('embed 挂降级关键词', qk.degraded === true && qk.mode === 'keyword' && qk.results.some((r) => r.text === '光轴进度-5'), JSON.stringify(qk.results));

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
