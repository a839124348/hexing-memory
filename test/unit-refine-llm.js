/**
 * unit-refine-llm.js — 带 LLM 的提炼：入库 + 链更新 + 失败补链
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { Draft } = require('../src/draft');
const { Refiner } = require('../src/refine');
const { ChainStore } = require('../src/chain');

const root = path.join(__dirname, '.tmp-refine-llm');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const store = new Store(root);
const draft = new Draft(root);
const refiner = new Refiner(root, store, draft);
const chain = new ChainStore(root);

const batch1 = [
  { t: '2026-11-07 23:30', s: '用户', c: '我喜欢西瓜', cid: 'c1', v: 1, type: 'human', origin: 'human' },
  { t: '2026-11-07 23:31', s: '用户', c: '下周三去体检', cid: 'c1', v: 1, type: 'human', origin: 'human' },
];
const d1 = draft.add(batch1);
check('前置：草稿 2 条', d1.ok && d1.added === 2, JSON.stringify(d1));

const okCall = async () => JSON.stringify({
  chains: [{
    name: '身份链', parent: '身份', header: '用户的偏好', nodes: [
      { t: '2026-11-07 23:30', who: '你', type: 'state', text: '喜欢 西瓜', supersedes: '西瓜' },
    ],
  }],
});

(async () => {
  const r1 = await refiner.runWithLLM(okCall, chain);
  check('入库 2 条', r1.added === 2, JSON.stringify(r1));
  check('草稿清空', draft.pending().length === 0, 'pending ' + draft.pending().length);
  check('链 1 节点', chain.get('身份链').nodes.length === 1, JSON.stringify(chain.get('身份链').nodes));
  check('LLM 建链计数', r1.llm && r1.llm.chains === 1 && r1.llm.nodes === 1, JSON.stringify(r1.llm));

  // 失败：原文仍入库，链没建成，记录进 llmPending
  const batch2 = [{ t: '2026-11-07 23:32', s: '用户', c: '下周三去体检', cid: 'c2', v: 1, type: 'human', origin: 'human' }];
  draft.add(batch2);
  const r2 = await refiner.runWithLLM(async () => { throw new Error('timeout'); }, chain);
  check('LLM 失败仍入库', r2.added === 1, JSON.stringify(r2));
  check('LLM 失败草稿已清', draft.pending().length === 0);
  check('LLM 失败有 llmError', r2.llmError && r2.llmError.stage === 'CALL', JSON.stringify(r2.llmError));
  check('失败记录进 llmPending', refiner.state().llmPending.length === 1, JSON.stringify(refiner.state().llmPending));
  check('失败时链未被写坏', chain.get('身份链').nodes.length === 1);

  // 补链：没有新草稿，但 llmPending 里的记录继续提炼
  const okCall2 = async () => JSON.stringify({
    chains: [{
      name: '身份链', parent: '身份', nodes: [
        { t: '2026-11-07 23:32', who: '你', type: 'event', text: '下周三去体检' },
      ],
    }],
  });
  const r3 = await refiner.runWithLLM(okCall2, chain);
  check('补链后 2 节点', chain.get('身份链').nodes.length === 2, JSON.stringify(chain.get('身份链').nodes));
  check('补链后 llmPending 清空', refiner.state().llmPending.length === 0);
  check('补链计数', r3.llm.nodes === 1, JSON.stringify(r3.llm));

  // 非法 JSON：同样进 pending，不写坏链
  draft.add([{ t: '2026-11-07 23:33', s: '用户', c: '周末去爬山', cid: 'c3', v: 1, type: 'human', origin: 'human' }]);
  const r4 = await refiner.runWithLLM(async () => '不是 JSON', chain);
  check('非法 JSON 仍入库', r4.added === 1, JSON.stringify(r4));
  check('非法 JSON 有 PARSE 错误', r4.llmError && r4.llmError.stage === 'PARSE', JSON.stringify(r4.llmError));
  check('非法 JSON 后链仍是 2 节点', chain.get('身份链').nodes.length === 2);

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
