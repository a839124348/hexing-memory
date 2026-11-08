/**
 * api.js — HTTP 接入口（AI 通过它使用记忆系统）
 *
 * 接口（最小集）：
 *   POST /draft    { records: [...] }        写入草稿（分钟级同步）
 *   POST /refine   {}                        手动触发提炼（闲时由调度器调用）
 *   GET  /search?q=&limit=&from=&to=         检索（正式向量 + 草稿字面，分开返回）
 *   GET  /common                             拉常识层（启动加载用）
 *   GET  /status                             状态（草稿/索引/链网/降级）
 *   POST /index    {}                        建/更新向量索引
 *
 * 设计原则：
 * - 检索结果**分开返回** formal / draft，不做假合并（两种分数不同量纲，合了会骗人）
 * - 任何降级都必须显式可见（degraded:true + 原因）
 * - 单个接口失败不影响其他接口
 */
const http = require('http');
const { Store } = require('./store');
const { Draft } = require('./draft');
const { Refiner } = require('./refine');
const { Search } = require('./search');

function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function createApp(root) {
  const store = new Store(root);
  const draft = new Draft(root);
  const refiner = new Refiner(root, store, draft);
  const search = new Search(root, store);
  return { store, draft, refiner, search };
}

function createServer(root, port = 16900) {
  const app = createApp(root);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // 写草稿
      if (req.method === 'POST' && p === '/draft') {
        const body = await readBody(req);
        const records = Array.isArray(body.records) ? body.records : (body.record ? [body.record] : []);
        if (!records.length) return json(res, 400, { ok: false, error: '缺 records' });
        const r = app.draft.add(records);
        return json(res, r.ok ? 200 : 400, { ok: r.ok, ...r, draft: app.draft.stats() });
      }

      // 提炼
      if (req.method === 'POST' && p === '/refine') {
        const r = app.refiner.run();
        return json(res, 200, { ok: r.ok, ...r, draft: app.draft.stats() });
      }

      // 建索引
      if (req.method === 'POST' && p === '/index') {
        const r = await app.search.buildIndex();
        return json(res, 200, r);
      }

      // 检索
      if (req.method === 'GET' && p === '/search') {
        const q = url.searchParams.get('q') || '';
        if (!q) return json(res, 400, { ok: false, error: '缺 q' });
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 5));
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        const formal = await app.search.query(q, { limit, dateFrom: from, dateTo: to });
        const draftHits = app.draft.search(q, limit);
        return json(res, 200, {
          ok: true,
          query: q,
          formal,
          draft: { count: draftHits.length, results: draftHits, mode: 'literal', degraded: false },
          hint: 'formal=正式记忆（向量，带上下文）；draft=草稿（字面，最近几分钟）',
        });
      }

      // 常识层
      if (req.method === 'GET' && p === '/common') {
        const b = app.refiner.commonBundle();
        return json(res, 200, { ok: true, ...b });
      }

      // 状态
      if (req.method === 'GET' && p === '/status') {
        return json(res, 200, {
          ok: true,
          store: app.store.stats(),
          draft: app.draft.stats(),
          index: app.search.stats(),
          refine: app.refiner.state(),
          embed: await app.search.health(),
          links: (() => { const l = app.refiner.links(); return { sessions: l.sessions.length, events: l.events.length }; })(),
        });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  });

  return { server, app, port };
}

module.exports = { createServer, createApp };

// 直接运行： node src/api.js [port]
if (require.main === module) {
  const port = Number(process.argv[2]) || 16900;
  const root = require('path').join(__dirname, '..', 'data');
  const { server } = createServer(root, port);
  server.listen(port, '127.0.0.1', () => {
    console.log('memory api listening on http://127.0.0.1:' + port);
    console.log('  data root: ' + root);
  });
}
