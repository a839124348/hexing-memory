/**
 * unit-chain-view.js — 链头状态 + 大链取节点
 */
const fs = require('fs');
const path = require('path');
const { ChainStore } = require('../src/chain');
const { headerState, selectChainNodes } = require('../src/chain_view');

const root = path.join(__dirname, '.tmp-chain-view');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const chain = new ChainStore(root);
chain.create('链A', '项目', '');
for (let i = 0; i < 4; i++) chain.append('链A', { t: '2026-11-08 10:0' + i, who: '你', type: 'event', text: '节点-' + i });
check('4 节点不要头', headerState(chain.get('链A')).needHeader === false);

chain.append('链A', { t: '2026-11-08 10:04', who: '你', type: 'event', text: '节点-4' });
const st5 = headerState(chain.get('链A'));
check('5 节点需要头', st5.needHeader === true && st5.nodeCount === 5);
check('没有 header 不提示刷新', st5.needRefresh === false);

// 模型写 lazy header
const set = chain.setHeader('链A', '链A 概览', { by: 'lazy' });
check('写头成功', set.ok && set.headerNodeCount === 5 && set.headerBy === 'lazy', JSON.stringify(set));
check('写头后不需要头', headerState(chain.get('链A')).needHeader === false);
check('写头后不提示刷新', headerState(chain.get('链A')).needRefresh === false);

// 再加 5 个 → 提示刷新
for (let i = 5; i < 10; i++) chain.append('链A', { t: '2026-11-08 10:0' + i, who: '你', type: 'event', text: '节点-' + i });
const st10 = headerState(chain.get('链A'));
check('加 5 节点提示刷新', st10.needRefresh === true && st10.canAutoRefresh === true, JSON.stringify(st10));

// 手写头：只提示，不允许自动覆盖
chain.setHeader('链A', '手写头', { by: 'manual' });
for (let i = 10; i < 15; i++) chain.append('链A', { t: '2026-11-08 10:1' + (i - 10), who: '你', type: 'event', text: '节点-' + i });
const manual = headerState(chain.get('链A'));
check('手写头不自动刷新', manual.needRefresh === false && manual.canAutoRefresh === false);

// 大链取节点
chain.create('大链', '项目', '');
for (let i = 0; i < 30; i++) chain.append('大链', { t: '2026-11-08 11:00', who: '你', type: 'event', text: '大节点-' + i });
const nodes = chain.get('大链').nodes;
const d = selectChainNodes(nodes);
check('大链默认 digest', d.digest === true && d.nodes.length <= 12 && d.omitted > 0, JSON.stringify({ len: d.nodes.length, omitted: d.omitted }));
check('digest 含首尾', d.indices.includes(0) && d.indices.includes(29));
check('digest 含中间', d.indices.some((i) => i > 3 && i < 26), JSON.stringify(d.indices));

const page = selectChainNodes(nodes, { offset: 12, limit: 3 });
check('offset/limit 精确取', page.nodes.length === 3 && page.nodes[0].text === '大节点-12', JSON.stringify(page.indices));

const full = selectChainNodes(nodes, { full: true });
check('full 全量', full.nodes.length === 30 && full.digest === false);

const small = selectChainNodes(nodes.slice(0, 8));
check('小链全量', small.nodes.length === 8 && small.digest === false);

console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
