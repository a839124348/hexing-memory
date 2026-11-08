/**
 * e2e.js — 端到端测试（真实 HTTP，临时数据目录，跑完清空）
 *
 * 覆盖链路：写草稿 → 草稿检索 → 提炼入库 → 建索引 → 向量检索 → 常识层 → 状态
 * 覆盖防护：坏数据拒绝 / 重复拦截 / 回流剔除 / 降级可见 / 上下文窗口
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createServer } = require('../src/api');

const TMP = path.join(__dirname, '.tmp-e2e');
fs.rmSync(TMP, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' | ' + detail : '')); console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
};

function req(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const q = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 30000,
    }, (s) => {
      let d = '';
      s.setEncoding('utf8');
      s.on('data', (x) => (d += x));
      s.on('end', () => { try { resolve({ s: s.statusCode, j: JSON.parse(d) }); } catch (e) { resolve({ s: s.statusCode, j: null, raw: d }); } });
    });
    q.on('error', () => resolve({ s: 0, j: null }));
    q.on('timeout', () => { q.destroy(); resolve({ s: -1, j: null }); });
    if (data) q.write(data);
    q.end();
  });
}

(async () => {
  const { server, app } = createServer(TMP, 0);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('test server on ' + port + '  data=' + TMP);
  console.log('');

  // ── 1. 写草稿 ──
  const recs = [
    { t: '2026-11-05 03:20', s: '用户', c: '今天开始做开源记忆系统，先写 MVP', cid: 'c1', v: 1, type: 'human', origin: 'human' },
    { t: '2026-11-05 03:21', s: '助手', c: '好，我先写校验器和存档层', cid: 'c1', v: 1, type: 'ai', origin: 'ai' },
    { t: '2026-11-05 03:25', s: '用户', c: '草稿阶段只需要字面检索就行，先不向量化', cid: 'c1', v: 1, type: 'human', origin: 'human' },
  ];
  const r1 = await req(port, 'POST', '/draft', { records: recs });
  check('写草稿 3 条', r1.s === 200 && r1.j.ok && r1.j.added === 3, JSON.stringify(r1.j).slice(0, 120));

  // ── 2. 草稿检索（字面） ──
  const r2 = await req(port, 'GET', '/search?q=' + encodeURIComponent('字面检索'));
  check('草稿字面检索命中', r2.j && r2.j.draft.count >= 1 && r2.j.draft.results[0].layer === 'draft', JSON.stringify(r2.j && r2.j.draft).slice(0, 160));

  // ── 3. 坏数据拒绝 ──
  const r3 = await req(port, 'POST', '/draft', { records: [{ t: '2026/11/05', s: 'x', c: 'y', cid: 'c2', v: 1 }] });
  check('坏时间格式被拒', r3.s === 400 && !r3.j.ok, JSON.stringify(r3.j).slice(0, 120));

  // ── 4. 重复写入拦截 ──
  const r4 = await req(port, 'POST', '/draft', { records: [recs[0]] });
  check('重复写入被拦(不重复入库)', r4.j && (r4.j.added === 0 || r4.s === 400), JSON.stringify(r4.j).slice(0, 120));

  // ── 5. 回流数据拒绝（草稿层就拦） ──
  const r5 = await req(port, 'POST', '/draft', { records: [{ t: '2026-11-05 03:30', s: '助手', c: '[记忆] 你之前说过喜欢下雨', cid: 'c1', v: 1, origin: 'ai' }] });
  check('回流数据被拒或剔除', r5.s === 400 || (r5.j && r5.j.added === 0), JSON.stringify(r5.j).slice(0, 120));

  // ── 6. 提炼 ──
  const r6 = await req(port, 'POST', '/refine', {});
  check('提炼入库 3 条', r6.j && r6.j.ok && r6.j.added === 3, JSON.stringify(r6.j).slice(0, 160));
  check('提炼后草稿清空', r6.j && r6.j.draft.pending === 0, JSON.stringify(r6.j && r6.j.draft));

  // ── 7. 常识层（链网更新） ──
  const r7 = await req(port, 'GET', '/common');
  check('常识层有会话节点', r7.j && r7.j.links.sessions.length === 1 && r7.j.links.sessions[0].cid === 'c1', JSON.stringify(r7.j && r7.j.links).slice(0, 200));
  check('常识层有事件', r7.j && r7.j.links.events.length >= 1, JSON.stringify(r7.j && r7.j.links.events).slice(0, 120));

  // ── 8. 建索引（依赖本地 embed 服务） ──
  const h = app.search.health ? await app.search.health() : { ok: false };
  console.log('');
  console.log('embed 服务: ' + JSON.stringify(h));
  const r8 = await req(port, 'POST', '/index', {});
  const embedOk = r8.j && r8.j.ok && r8.j.added === 3;
  console.log('建索引：' + JSON.stringify(r8.j).slice(0, 160));

  // ── 9. 正式检索 ──
  const r9 = await req(port, 'GET', '/search?q=' + encodeURIComponent('校验器 存档层'));
  const formal = r9.j && r9.j.formal;
  if (embedOk) {
    check('向量检索命中', formal.count >= 1 && formal.mode === 'vector' && !formal.degraded, JSON.stringify(formal).slice(0, 160));
    check('命中带上下文', formal.results[0].context.length >= 2, 'ctx=' + (formal.results[0].context || []).length);
    check('结果可解释', typeof formal.results[0].score === 'number' && formal.results[0].match === 'vector');
  } else {
    check('降级可见（embed 不可用→关键词）', formal.degraded === true && formal.mode === 'keyword', JSON.stringify(formal).slice(0, 160));
  }

  // ── 10. 时间过滤 ──
  const r10 = await req(port, 'GET', '/search?q=' + encodeURIComponent('MVP') + '&from=2026-11-06');
  check('时间过滤生效', r10.j && r10.j.formal.count === 0, JSON.stringify(r10.j && r10.j.formal).slice(0, 120));

  // ── 11. 状态 ──
  const r11 = await req(port, 'GET', '/status');
  check('状态完整', r11.j && r11.j.store.records === 3 && r11.j.draft.pending === 0 && r11.j.links.sessions === 1, JSON.stringify(r11.j).slice(0, 200));

  // ── 12. 重复提炼幂等 ──
  const r12 = await req(port, 'POST', '/refine', {});
  check('重复提炼幂等（不再入库）', r12.j && r12.j.added === 0, JSON.stringify(r12.j).slice(0, 120));

  server.close();
  const total = pass + fails.length;
  console.log('');
  console.log('结果：' + pass + '/' + total + ' 通过' + (embedOk ? '' : '（向量相关用例走了降级路径）'));
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
})();
