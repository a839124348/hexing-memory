/**
 * unit-backfill.js — 迁移旧历史补链
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { ChainStore } = require('../src/chain');
const { Backfill } = require('../src/backfill');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
const store = new Store(root);
const chain = new ChainStore(root);
let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' -> ' + detail : '')); console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
};

store.append([
  { t: '2026-05-09 23:47', s: '用户', c: '下周三晚上八点，别忘了体检。', cid: 'c1', v: 1 },
  { t: '2026-05-10 08:00', s: '用户', c: '今天天气不错。', cid: 'c1', v: 1 },
]);

const bf = new Backfill({
  store,
  chain,
  root,
  logger: { info() {}, warn() {}, error() {} },
});

const est = bf.estimate();
check('估算条数', est.records === 2, JSON.stringify(est));
check('估算批数', est.batches === 1, JSON.stringify(est));
check('估算 token', est.estimatedTokens && est.estimatedTokens.total > 0, JSON.stringify(est));

let calls = 0;
const call = async () => {
  calls++;
  return JSON.stringify({
    chains: [{
      name: '关系链',
      parent: '关系',
      header: '',
      nodes: [{ t: '2026-05-09 23:47', who: '我', type: 'event', text: '用户提到下周三晚上八点体检。' }],
    }],
    topics: [],
  });
};

(async () => {
  const preview = await bf.preview({ call, batches: 1 });
  check('preview 成功', preview.ok && preview.preview === true, JSON.stringify(preview).slice(0, 200));
  check('preview 有链', preview.chains >= 1, JSON.stringify(preview).slice(0, 200));
  check('preview 有节点', preview.nodes >= 1, JSON.stringify(preview).slice(0, 200));
  check('preview 不写链', chain.get('关系链') === null);

  const started = await bf.start({ call, maxBatches: 1 });
  check('start 成功', started.ok && started.started === true, JSON.stringify(started).slice(0, 200));

  for (let i = 0; i < 50; i++) {
    const st = bf.status();
    if (st.status === 'done' || st.status === 'error') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const st = bf.status();
  check('回填完成', st.status === 'done', JSON.stringify(st).slice(0, 300));
  const ch = chain.get('关系链');
  check('链已写入', ch && ch.nodes && ch.nodes.length === 1, JSON.stringify(ch).slice(0, 200));
  check('节点标 migration', ch && ch.nodes[0] && ch.nodes[0].source === 'migration', JSON.stringify(ch && ch.nodes[0]));
  check('状态文件存在', fs.existsSync(path.join(root, 'common', 'backfill-state.json')));

  const again = await bf.start({ call, maxBatches: 1 });
  check('重复 start 幂等', again.ok && again.alreadyDone === true, JSON.stringify(again).slice(0, 200));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
