/**
 * acceptance.js — 全链路验收（能自动跑的部分）
 *
 * 用法：node test/acceptance.js
 * 输出：控制台 + test/ACCEPTANCE-<时间>.md
 *
 * 说明：压缩后常识层补回、跨会话“5 秒内”的 DSH 真机计时属于界面项，
 * 这里只跑核心可自动验证的部分，并在报告里标“手工/待测”。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { Draft } = require('../src/draft');
const { Refiner } = require('../src/refine');
const { Search } = require('../src/search');
const { ChainStore } = require('../src/chain');
const { composeCommonText, readResidentSpecFrom, readManualIndexFrom } = require('../src/adapter_pure');
const { createEmbedService } = require('../src/service');

const root = path.join(__dirname, '.tmp-acceptance');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const rows = [];
const check = (id, name, status, detail) => {
  rows.push({ id, name, status, detail: detail || '' });
  console.log((status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP') + ' [' + id + '] ' + name + (detail ? ' → ' + detail : ''));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rec(t, s, c, cid, mid) {
  return { t, s, c, cid, v: 1, type: 'human', origin: 'human', ...(mid ? { mid } : {}) };
}

(async () => {
  const store = new Store(root);
  const draft = new Draft(root);
  const refiner = new Refiner(root, store, draft);
  const chain = new ChainStore(root);
  const search = new Search(root, store);

  // ── 1. 跨会话实时（核心层：A 写入，B 立刻可见）──
  {
    const t0 = Date.now();
    draft.add([rec('2026-11-08 00:20', '用户', '跨会话验收：A 说的话', 'cid-A')]);
    const visible = draft.pending().some((r) => r.c === '跨会话验收：A 说的话');
    check(1, '跨会话实时（核心层）', visible && Date.now() - t0 < 5000 ? 'PASS' : 'FAIL', (Date.now() - t0) + 'ms');
  }

  // ── 2. 自动提炼（原文入库）──
  {
    const before = store.stats().records;
    const r = refiner.run();
    check(2, '自动提炼入库', r.ok && r.added >= 1 ? 'PASS' : 'FAIL', '入库 ' + r.added + ' 条，存档 ' + store.stats().records + ' 条');
  }

  // ── 3. LLM 建链（假 LLM，验证管线）──
  {
    draft.add([rec('2026-11-08 00:21', '用户', '验收：下周三晚上八点体检', 'cid-A')]);
    const fake = async () => JSON.stringify({ chains: [{
      name: '项目链-体检', parent: '项目', header: '体检安排',
      nodes: [{ t: '2026-11-08 00:21', who: '你', type: 'event', text: '下周三晚上八点体检' }],
    }] });
    const r = await refiner.runWithLLM(fake, chain);
    const c = chain.get('项目链-体检');
    check(3, 'LLM 建链', r.ok && c && c.nodes.length === 1 ? 'PASS' : 'FAIL', '链节点 ' + (c ? c.nodes.length : 0));
  }

  // ── 4. state / event ──
  {
    chain.create('身份链', '身份', '')
    chain.append('身份链', { t: '2026-11-08 00:22', who: '你', type: 'state', text: '喜欢 西瓜', supersedes: '西瓜' });
    chain.append('身份链', { t: '2026-11-08 00:23', who: '你', type: 'state', text: '不喜欢 西瓜', supersedes: '西瓜' });
    const c = chain.get('身份链');
    const old = c.nodes.find((n) => n.text === '喜欢 西瓜');
    const now = c.nodes.find((n) => n.text === '不喜欢 西瓜');
    check(4, 'state 推翻 / event 保留', old && old.superseded === true && now && now.superseded === false && c.nodes.length >= 2 ? 'PASS' : 'FAIL', '节点 ' + c.nodes.length);
  }

  // ── 5. 同分钟同文 / 跨会话同文 ──
  {
    const t = '2026-11-08 00:24';
    draft.add([rec(t, '用户', '重复验收：同一句话', 'cid-A', 'mid-a')]);
    draft.add([rec(t, '用户', '重复验收：同一句话', 'cid-A', 'mid-b')]);
    const same = draft.pending().filter((r) => r.c === '重复验收：同一句话');
    draft.add([rec(t, '用户', '跨会话重复验收', 'cid-A', 'mid-c')]);
    draft.add([rec(t, '用户', '跨会话重复验收', 'cid-B', 'mid-d')]);
    const cross = draft.pending().filter((r) => r.c === '跨会话重复验收');
    check(5, '同分钟同文 / 跨会话同文', same.length === 2 && cross.length === 2 ? 'PASS' : 'FAIL', '同会话 ' + same.length + ' 条，跨会话 ' + cross.length + ' 条');
    refiner.run();
  }

  // ── 6. 崩溃截尾 ──
  {
    const file = path.join(root, 'raw', '2026-11-08.jsonl');
    const before = store.stats().records;
    fs.appendFileSync(file, '{"t":"2026-11-08 00:25","s":"用户","c":"PARTIAL');
    const r = store.append([rec('2026-11-08 00:25', '用户', '崩溃截尾验收', 'cid-C')], { checkSimilar: false });
    const ok = r.ok && !fs.readFileSync(file, 'utf8').includes('PARTIAL') && store.readDay('2026-11-08').length === before + 1;
    check(6, '崩溃半行截尾', ok ? 'PASS' : 'FAIL', '写入后 ' + store.stats().records + ' 条');
  }

  // ── 7. 多进程写锁 ──
  {
    const mpRoot = path.join(root, 'mp');
    const worker = path.join(__dirname, 'append-worker.js');
    const run = (prefix) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [worker, mpRoot, prefix, '100'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => err += d);
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err)));
    });
    try {
      await Promise.all([run('a'), run('b')]);
      const s = new Store(mpRoot);
      const dayRows = s.readDay('2026-11-07');
      const n = dayRows.length;
      const ids = new Set(dayRows.map((r) => r.id));
      check(7, '多进程写锁', n === 200 && ids.size === 200 ? 'PASS' : 'FAIL', n + ' 条 / ' + ids.size + ' 个 id');
    } catch (e) {
      check(7, '多进程写锁', 'FAIL', e.message);
    }
  }

  // ── 8. 向量建索引 + 语义召回 + 并发检索 ──
  {
    const h = await search.health().catch((e) => ({ ok: false, error: e.message }));
    if (!h.ok) {
      check(8, '向量索引/语义召回/并发', 'SKIP', '向量服务不可用：' + (h.error || h.status || 'unknown'));
    } else {
      const before = store.stats().records;
      const ir = await search.buildIndex();
      const q = await search.query('体检', { limit: 3 });
      const hit = q.results && q.results.length > 0 && q.results.slice(0, 3).some((r) => String(r.c).includes('体检'));
      check(8, '向量索引/语义召回', ir.ok && ir.total >= before && hit ? 'PASS' : 'FAIL', '索引 ' + ir.total + ' 条，mode=' + q.mode + '，top=' + (q.results[0] ? q.results[0].c.slice(0, 20) : '空'));

      const sigs = new Set();
      let ok = 0;
      await Promise.all(Array.from({ length: 32 }, async () => {
        try {
          const r = await search.query('下周三晚上八点体检', { limit: 3 });
          sigs.add(r.results.map((x) => x.id).join(','));
          ok++;
        } catch (e) { /* 计数失败 */ }
      }));
      check(9, '32 并发检索', ok === 32 && sigs.size === 1 ? 'PASS' : 'FAIL', '成功 ' + ok + '/32，结果签名 ' + sigs.size + ' 种');
    }
  }

  // ── 10. 常识层组装 ──
  {
    const rules = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RULES.md'), 'utf8');
    const common = composeCommonText({
      profile: '# 身份\n## 我是谁\n验收身份',
      resident: readResidentSpecFrom(rules),
      manualIndex: readManualIndexFrom(rules),
      chains: '- 身份链：关于用户（3 节点）',
    });
    const ok = common.length <= 4000 && common.includes('验收身份') && common.includes('## 常驻规范') && common.includes('## 说明书索引') && common.includes('## 链网索引') && !common.includes('## 当前状态');
    check(10, '常识层 ≤4000 且四块齐全', ok ? 'PASS' : 'FAIL', common.length + ' 字符');
  }

  // ── 11. 性能：批量写入 1000 条 ──
  {
    const perfRoot = path.join(root, 'perf');
    const ps = new Store(perfRoot);
    const list = Array.from({ length: 1000 }, (_, i) => rec('2026-11-08 01:00', '用户', '性能验收-' + i, 'cid-perf'));
    const t0 = Date.now();
    const r = ps.append(list, { checkSimilar: false });
    const ms = Date.now() - t0;
    check(11, '批量写入 1000 条', r.ok && r.added === 1000 ? 'PASS' : 'FAIL', ms + 'ms');
  }

  // ── 12. 向量服务生命周期（单测已覆盖，这里只报状态）──
  {
    const svc = createEmbedService({
      url: 'http://fake', cmd: '',
      healthCheck: async () => ({ ok: false }),
    });
    const r = await svc.start();
    await svc.stop();
    check(12, '向量服务无命令降级', r.ok === false && r.reason === 'no-cmd' ? 'PASS' : 'FAIL', r.reason || '');
  }

  // ── 13. 适配层（单测 23/23，这里抽查关键行为）──
  {
    const { pickLastUserMessage } = require('../src/adapter_pure');
    const picked = pickLastUserMessage([
      { role: 'user', content: [{ type: 'text', text: '旧话' }] },
      { role: 'user', source: { kind: 'system-reminder' }, content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n真话' }] },
      { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'tick' }] },
    ]);
    check(13, '适配层选真话', picked && picked.text === '真话' ? 'PASS' : 'FAIL', picked ? picked.text : 'null');
  }

  // 手工项
  check('M1', 'DSH 压缩后常识层补回', 'MANUAL', '需在 DSH 里 /compact 或触发压缩后验证');
  check('M2', '跨会话 5 秒内（界面计时）', 'MANUAL', '核心层已测；界面需开 A/B 两个会话实测');
  check('M3', '10 万条性能', 'MANUAL', '当前只跑 1000 条；10 万需单独压测');

  // 汇总
  const pass = rows.filter((x) => x.status === 'PASS').length;
  const fail = rows.filter((x) => x.status === 'FAIL').length;
  const skip = rows.filter((x) => x.status === 'SKIP').length;
  const manual = rows.filter((x) => x.status === 'MANUAL').length;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(__dirname, 'ACCEPTANCE-' + stamp + '.md');
  const md = [
    '# 全链路验收报告 ' + new Date().toISOString(),
    '',
    '| # | 项 | 结果 | 证据 |',
    '|:--|:--|:--|:--|',
    ...rows.map((r) => '| ' + r.id + ' | ' + r.name + ' | ' + r.status + ' | ' + String(r.detail).replace(/\|/g, '/') + ' |'),
    '',
    '汇总：PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skip + ' / MANUAL ' + manual,
    '',
    '> 手工项：M1 压缩后常识层补回、M2 DSH 界面跨会话计时、M3 10 万条压测。',
  ].join('\n');
  fs.writeFileSync(out, md, 'utf8');
  console.log('\n汇总：PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skip + ' / MANUAL ' + manual);
  console.log('报告：' + out);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
