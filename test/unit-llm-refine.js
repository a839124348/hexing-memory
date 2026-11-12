/**
 * unit-llm-refine.js — LLM 提炼纯函数 + 链应用（假 LLM，不联网）
 */
const fs = require('fs');
const path = require('path');
const { ChainStore } = require('../src/chain');
const {
  LlmError, buildRefinePrompt, parseRefineResponse, applyChainUpdates, refineWithLLM,
} = require('../src/llm');

const root = path.join(__dirname, '.tmp-llm-refine');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const records = [
  { t: '2026-11-07 23:30', s: '用户', c: '我喜欢西瓜', cid: 'c1', v: 1 },
  { t: '2026-11-07 23:31', s: '用户', c: '下周三去体检', cid: 'c1', v: 1 },
];

// 1. 提示词只带 t/s/c 和链索引
const chain = new ChainStore(root);
chain.create('身份链', '身份', '关于用户');
const prompt = buildRefinePrompt(records, chain.list());
check('提示词含对话原文', prompt.user.includes('我喜欢西瓜'));
check('提示词含链索引', prompt.user.includes('身份链'));
check('提示词带输出契约', prompt.system.includes('"chains"'));
check('梗/表情默认不自动建节点', prompt.system.includes('梗、表情用法、口头禅、一次性玩笑默认不建节点'));
const wakePrompt = buildRefinePrompt([
  ...records,
  { t: '2026-11-07 23:32', s: '小绪', c: '午饭吃了吗', origin: 'wake', cid: 'c1', v: 1 },
], chain.list());
check('提示词带 origin=wake', wakePrompt.user.includes('"origin":"wake"'));
check('提示词区分 AI 主动表达', wakePrompt.system.includes('AI 主动醒来说的话'));
check('提示词有日常关心概要规则', wakePrompt.system.includes('关心对话概要'));

// 2. 解析：合法 JSON（带围栏）
const valid = '```json\n' + JSON.stringify({
  chains: [{
    name: '身份链',
    parent: '身份',
    header: '用户的偏好与约定',
    nodes: [
      { t: '2026-11-07 23:30', who: '你', type: 'state', text: '喜欢 西瓜', supersedes: '西瓜' },
      { t: '2026-11-07 23:31', who: '你', type: 'event', text: '下周三去体检' },
    ],
  }],
}) + '\n```';
const parsed = parseRefineResponse(valid);
check('解析出 1 条链', parsed.chains.length === 1);
check('解析出 2 个节点', parsed.chains[0].nodes.length === 2);
check('state/event 保持', parsed.chains[0].nodes[0].type === 'state' && parsed.chains[0].nodes[1].type === 'event');

// 3. 非法 JSON
let parseErr = null;
try { parseRefineResponse('我觉得可以这样：没有 JSON'); } catch (e) { parseErr = e; }
check('非法 JSON 抛 PARSE', parseErr && parseErr.stage === 'PARSE');

// 4. 过滤坏节点
const filtered = parseRefineResponse(JSON.stringify({
  chains: [{
    name: '身份链', parent: '身份', nodes: [
      { t: '2026-11-07 23:30', who: '你', type: 'state', text: '' },
      { t: '昨天', who: '你', type: 'event', text: '时间不合法' },
      { t: '2026-11-07 23:31', who: '你', type: 'event', text: '正常节点' },
    ],
  }],
}), { fallbackT: '2026-11-07 23:31' });
check('空文本被过滤', !filtered.chains[0].nodes.some((n) => !n.text));
check('坏时间回落 fallbackT', filtered.chains[0].nodes.every((n) => n.t === '2026-11-07 23:31'));

// 5. 应用链更新（幂等 + 状态推翻）
const applied1 = applyChainUpdates(chain, parsed);
check('第一次应用 2 个节点', applied1.nodes === 2, JSON.stringify(applied1));
const c1 = chain.get('身份链');
check('头部已更新', c1.header === '用户的偏好与约定', c1.header);
const applied2 = applyChainUpdates(chain, parsed);
check('重复应用 0 个节点', applied2.nodes === 0, JSON.stringify(applied2));

// 5b. who 变了（"" vs "你"）仍是同一节点
const noWho = JSON.parse(JSON.stringify(parsed));
for (const n of noWho.chains[0].nodes) n.who = '';
check('who 不同仍幂等', applyChainUpdates(chain, noWho).nodes === 0);

const newer = parseRefineResponse(JSON.stringify({
  chains: [{
    name: '身份链', parent: '身份', nodes: [
      { t: '2026-11-07 23:32', who: '你', type: 'state', text: '不喜欢 西瓜', supersedes: '西瓜' },
    ],
  }],
}));
applyChainUpdates(chain, newer);
const c2 = chain.get('身份链');
const old = c2.nodes.find((n) => n.text === '喜欢 西瓜');
const now = c2.nodes.find((n) => n.text === '不喜欢 西瓜');
check('旧 state 被标 superseded', old && old.superseded === true);
check('新 state 未被标', now && now.superseded === false);
check('旧节点未删除', !!old);

// 5b. 任意父节点 / 子链 / 只有 header 的父链
{
  const nested = parseRefineResponse(JSON.stringify({
    chains: [
      { name: '学习', parent: '核星', header: '学过的东西', nodes: [] },
      { name: '学习链-三进制', parent: '学习', nodes: [
        { t: '2026-11-08 00:24', who: '你', type: 'event', text: '学到平衡三进制' },
      ] },
    ],
  }));
  check('只有 header 的父链 retained', nested.chains.length === 2 && nested.chains[0].header === '学过的东西');
  const appliedNested = applyChainUpdates(chain, nested);
  check('任意父节点可建', chain.get('学习') && chain.get('学习').parent === '核星');
  check('子链挂在父节点下', chain.get('学习链-三进制') && chain.get('学习链-三进制').parent === '学习');
  check('子链节点写入', chain.get('学习链-三进制').nodes.length === 1);
}

// 5c. 深度上限：深度 5 不建
{
  const deep = new ChainStore(path.join(root, 'deep'));
  deep.create('L1', '核星', '');
  deep.create('L2', 'L1', '');
  deep.create('L3', 'L2', '');
  deep.create('L4', 'L3', '');
  const parsedDeep = parseRefineResponse(JSON.stringify({
    chains: [{ name: 'L5', parent: 'L4', nodes: [{ t: '2026-11-08 00:25', who: '你', type: 'event', text: '太深了' }] }],
  }));
  applyChainUpdates(deep, parsedDeep);
  check('超过 4 层不建', deep.get('L5') === null);
}

// 6. refineWithLLM：假 LLM 成功 / 失败 / 非法输出
(async () => {
  const root2 = path.join(root, 'run');
  fs.mkdirSync(root2, { recursive: true });
  const chain2 = new ChainStore(root2);
  const okCall = async () => JSON.stringify({
    chains: [{
      name: '项目链-体检', parent: '项目', header: '体检安排', nodes: [
        { t: '2026-11-07 23:31', who: '你', type: 'event', text: '下周三去体检' },
      ],
    }],
  });
  const r1 = await refineWithLLM({ records, chainStore: chain2, call: okCall, fallbackT: '2026-11-07 23:31' });
  check('refineWithLLM 成功建 1 链 1 节点', r1.chains === 1 && r1.nodes === 1, JSON.stringify(r1));
  check('新链挂在项目下', chain2.get('项目链-体检').parent === '项目');

  let callErr = null;
  try {
    await refineWithLLM({ records, chainStore: chain2, call: async () => { throw new Error('timeout'); } });
  } catch (e) { callErr = e; }
  check('模型失败抛 CALL', callErr && callErr.stage === 'CALL');

  let badErr = null;
  try {
    await refineWithLLM({ records, chainStore: chain2, call: async () => '不是 JSON' });
  } catch (e) { badErr = e; }
  check('输出非法抛 PARSE', badErr && badErr.stage === 'PARSE');
  check('失败后链未被写坏', chain2.get('项目链-体检').nodes.length === 1);

  // 超过 100 条必须自动分块，不能静默截断
  const many = Array.from({ length: 150 }, (_, i) => ({
    t: '2026-11-07 23:31', s: '我', c: '批量消息 ' + i,
  }));
  let manyCalls = 0;
  const rMany = await refineWithLLM({
    records: many,
    chainStore: chain2,
    call: async () => {
      manyCalls++;
      return JSON.stringify({
        chains: [{
          name: '批量链', parent: '项目', nodes: [
            { t: '2026-11-07 23:31', who: '我', type: 'event', text: '批量节点 ' + manyCalls },
          ],
        }],
      });
    },
    fallbackT: '2026-11-07 23:31',
  });
  check('超过 100 条自动分块', manyCalls === 2, 'calls=' + manyCalls);
  check('分块结果都写入', rMany.chunks === 2 && rMany.nodes === 2, JSON.stringify(rMany));

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
