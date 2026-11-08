/**
 * search.js — 正式记忆检索（向量 + 元数据过滤 + 上下文窗口）
 *
 * 三条设计约束（来自规划书）：
 * 1. **可解释**：返回必须带分数和命中方式（vector / keyword / degraded）
 * 2. **带上下文**：命中一条要能带上同会话前后 2 条，否则 AI 拿到一句孤话不知道在说什么
 * 3. **降级可见**：向量服务挂了 → 走关键词兜底，并在返回里标 degraded:true
 *    （星核踩过：embed 挂了假装"没数据"，对账全乱）
 */
const fs = require('fs');
const path = require('path');
const { embed, cosine, health } = require('./embed');
const { withWriteLock } = require('./lock');
const xvec = require('./xvec');

class Search {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.dir = path.join(root, 'index');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'vectors.json');       // 旧格式；只作迁移输入/备份
    this.xvecFile = path.join(this.dir, 'vectors.xvec');   // XVEC v1
    this.metaFile = path.join(this.dir, 'vectors.meta.json');
  }

  _readIndex() {
    // 新格式：XVEC v1 + 元数据 sidecar。字符串 id 用 8 字节哈希，sidecar 还原原 id。
    if (fs.existsSync(this.xvecFile) && fs.existsSync(this.metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        if (!meta || !meta.dim || !Array.isArray(meta.items)) throw new Error('meta 无效');
        const read = xvec.readAll(this.xvecFile, { dim: Number(meta.dim), model: meta.model || undefined });
        const byKey = new Map(meta.items.map((m) => [m.key, m]));
        const items = [];
        for (const r of read.items) {
          const m = byKey.get(r.key);
          if (!m) continue;
          items.push({
            id: m.id,
            t: m.t || '',
            s: m.s || '',
            cid: m.cid || '',
            c: m.c || '',
            vec: r.vec,
          });
        }
        return {
          model: meta.model || null,
          dim: Number(meta.dim) || 0,
          builtAt: meta.builtAt || null,
          items,
          format: 'xvec',
        };
      } catch (e) {
        // XVEC 损坏或模型不符：不拿旧 JSON 冒充当前索引；返回空，让 buildIndex 重建/检索降级
        return { model: null, dim: 0, builtAt: null, items: [], format: 'error', error: String(e && e.message || e) };
      }
    }

    if (!fs.existsSync(this.file)) return { model: null, dim: 0, builtAt: null, items: [], format: 'empty' };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { model: j.model || null, dim: j.dim || 0, builtAt: j.builtAt || null, items: j.items || [], format: 'json' };
    } catch (e) {
      return { model: null, dim: 0, builtAt: null, items: [], format: 'empty' };
    }
  }

  _atomicWrite(file, content) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  /**
   * 向量落盘统一走锁：先在锁内重读最新索引，再合并本进程新算出的向量。
   * 这样两个 DSH 同时建索引时，不会后写覆盖先写；embed 期间不占锁。
   */
  _commit(newItems, model, dim, reset = false) {
    return withWriteLock(this.dir, () => {
      const base = reset ? { items: [], model: null, dim: 0 } : this._readIndex();
      const map = new Map(base.items.map((x) => [x.id, x]));
      for (const item of newItems) map.set(item.id, item);
      const items = [...map.values()];
      const useModel = model || base.model || 'unknown';
      const useDim = Number(dim || base.dim || (items[0] && items[0].vec.length) || 0);
      if (!useDim) throw new Error('向量维度为空，拒绝写 XVEC');
      if (items.some((x) => !x.id || !Array.isArray(x.vec) && !ArrayBuffer.isView(x.vec))) {
        throw new Error('XVEC 记录缺少 id 或 vec');
      }

      // XVEC 主体：临时文件 + fsync + rename；元数据最后写，崩溃时最坏只是多几条未登记记录
      const tmp = this.xvecFile + '.' + process.pid + '.tmp';
      try {
        xvec.writeFile(tmp, { model: useModel, dim: useDim, items });
        fs.renameSync(tmp, this.xvecFile);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        throw e;
      }

      const builtAt = new Date().toISOString();
      const keys = new Map();
      const metaItems = items.map((x) => {
        const key = xvec.idKey(x.id);
        if (keys.has(key)) throw new Error('XVEC id 哈希碰撞：' + x.id + ' / ' + keys.get(key));
        keys.set(key, x.id);
        return { key, id: x.id, t: x.t || '', s: x.s || '', cid: x.cid || '', c: x.c || '' };
      });
      this._atomicWrite(this.metaFile, JSON.stringify({
        version: 1,
        model: useModel,
        dim: useDim,
        builtAt,
        items: metaItems,
      }));
      return { model: useModel, dim: useDim, builtAt, items, format: 'xvec' };
    }, { name: '.vectors.lock' });
  }

  /**
   * 增量建索引（只处理新记录）
   * @returns {{ ok, added, total, model, dim, error }}
   */
  async buildIndex(opt = {}) {
    let idx = this._readIndex();

    // 旧 JSON 首次遇到新代码：迁到 XVEC（写锁内完成）
    if (idx.format === 'json' && idx.items.length) {
      try {
        idx = this._commit([], idx.model, idx.dim);
      } catch (e) { /* 迁移失败就继续用旧 JSON，不阻塞检索 */ }
    }

    let model = idx.model;
    let reset = false;
    try {
      const h = await health();
      if (h && h.ok && h.model) {
        if (model && model !== 'unknown' && model !== h.model) {
          // 模型换了：旧向量不可比，全量重建
          idx = { model: h.model, dim: 0, builtAt: null, items: [], format: 'empty' };
          reset = true;
        }
        model = h.model;
      }
    } catch (e) { /* 服务不可用就保持旧索引 */ }

    const known = new Set(idx.items.map((x) => x.id));
    const all = this.store.readRange();
    const todo = all.filter((r) => r.id && !known.has(r.id));
    if (!todo.length) {
      // 没有新内容，但顺手把模型名补上（早期索引没记，会导致换模型时无法判断）
      if ((!idx.model || idx.model === 'unknown') && model) {
        try {
          const merged = this._commit([], model, idx.dim, reset);
          return { ok: true, added: 0, total: merged.items.length, model: merged.model, dim: merged.dim };
        } catch (e) { /* 保持原样 */ }
      }
      return { ok: true, added: 0, total: idx.items.length, model: idx.model, dim: idx.dim };
    }

    let dim = idx.dim;
    let added = 0;
    const newItems = [];
    for (const r of todo) {
      try {
        const vec = await embed(r.s + '：' + r.c);
        newItems.push({ id: r.id, t: r.t, s: r.s, cid: r.cid, c: String(r.c).slice(0, 500), vec });
        added++;
        if (!dim) dim = vec.length;
      } catch (e) {
        // 失败：把已算出的部分落盘（下次只补剩下的），然后返回降级信息
        const merged = this._commit(newItems, model || idx.model || 'unknown', dim || idx.dim, reset);
        return { ok: false, added, total: merged.items.length, model: merged.model, dim: merged.dim, error: 'embed 失败：' + (e.message || e) };
      }
    }
    const merged = this._commit(newItems, model || idx.model || 'unknown', dim || idx.dim, reset);
    return { ok: true, added, total: merged.items.length, model: merged.model, dim: merged.dim };
  }

  /** 取同会话上下文（前 after 条 + 后 before 条），按时间序 */
  _context(cid, t, before = 2, after = 2) {
    const day = String(t).slice(0, 10);
    // 时间相同返回 0：同一分钟内的"问→答"不能被打乱顺序
    const rows = this.store.readDay(day).filter((r) => r.cid === cid).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const i = rows.findIndex((r) => r.t === t);
    if (i < 0) return [];
    return rows.slice(Math.max(0, i - before), Math.min(rows.length, i + after + 1))
      .map((r) => ({ t: r.t, s: r.s, c: String(r.c).slice(0, 120), id: r.id, self: r.t === t }));
  }

  /**
   * 检索
   * @param {string} q
   * @param {object} opt { limit, dateFrom, dateTo, context }
   */
  async query(q, opt = {}) {
    const limit = opt.limit || 5;
    const ctx = opt.context === undefined ? 2 : opt.context;
    const idx = this._readIndex();
    const inRange = (r) => (!opt.dateFrom || String(r.t) >= opt.dateFrom) && (!opt.dateTo || String(r.t).slice(0, 10) <= opt.dateTo);

    // 向量路径
    const items = idx.items.filter(inRange);
    if (items.length) {
      try {
        const qv = await embed(q);
        const scored = items.map((it) => ({ it, score: cosine(qv, it.vec) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        return {
          ok: true,
          mode: 'vector',
          degraded: false,
          model: idx.model,
          count: scored.length,
          results: scored.map(({ it, score }) => ({
            id: it.id, t: it.t, s: it.s, cid: it.cid,
            c: it.c, score: Number(score.toFixed(4)),
            layer: 'formal', match: 'vector',
            context: ctx > 0 ? this._context(it.cid, it.t, ctx, ctx) : [],
          })),
        };
      } catch (e) {
        // 降级：关键词兜底，但必须显式标记（不假装正常）
      }
    }

    // 关键词兜底
    const all = this.store.readRange().filter(inRange);
    const ql = String(q).toLowerCase();
    const tokens = String(q).split(/[\s,，。、；;：:]+/).filter(Boolean);
    const scored = [];
    for (const r of all) {
      const text = String(r.c).toLowerCase();
      let hits = 0;
      for (const tk of tokens) if (text.includes(tk.toLowerCase())) hits++;
      if (!hits && !text.includes(ql)) continue;
      scored.push({ r, score: hits || 1 });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.r.t < b.r.t ? 1 : -1));
    const top = scored.slice(0, limit);
    return {
      ok: true,
      mode: 'keyword',
      degraded: true,
      degradedReason: idx.items.length ? 'embed 不可用，已降级关键词' : '索引为空，已降级关键词',
      model: idx.model,
      count: top.length,
      results: top.map(({ r, score }) => ({
        id: r.id, t: r.t, s: r.s, cid: r.cid,
        c: String(r.c).slice(0, 500), score: Number((score / 10).toFixed(4)),
        layer: 'formal', match: 'keyword',
        context: ctx > 0 ? this._context(r.cid, r.t, ctx, ctx) : [],
      })),
    };
  }

  stats() {
    const idx = this._readIndex();
    return { indexed: idx.items.length, model: idx.model, dim: idx.dim, builtAt: idx.builtAt };
  }

  async health() {
    return health();
  }
}

module.exports = { Search };
