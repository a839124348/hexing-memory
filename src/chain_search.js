/**
 * chain_search.js — 链节点语义索引
 *
 * 大链不只靠前 3 后 3：链节点也进向量检索，可以按链过滤，直接抽中间相关节点。
 * 与原文索引分开：原文是证据，链节点是摘要，混在一起会分不清。
 *
 * 索引文件：index/chain_vectors.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { embed, cosine, health } = require('./embed');
const { withWriteLock } = require('./lock');

class ChainSearch {
  constructor(root, chainStore, opt = {}) {
    this.root = root;
    this.chainStore = chainStore;
    this.dir = path.join(root, 'index');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'chain_vectors.json');
    this.embedFn = opt.embedFn || embed;
    this.healthFn = opt.healthFn || health;
  }

  _read() {
    if (!fs.existsSync(this.file)) return { model: null, dim: 0, builtAt: null, items: [] };
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return { model: null, dim: 0, builtAt: null, items: [] }; }
  }

  _write(idx) {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /**
   * 锁内重读 + 合并：只保留当前链里还存在的节点；
   * 另一个进程刚写入的同 id 向量不会因为后写被覆盖。
   */
  _commit(items, validIds, model, dim, reset) {
    return withWriteLock(this.dir, () => {
      const old = this._read();
      const map = new Map();
      if (!reset) {
        for (const it of old.items) if (validIds.has(it.id)) map.set(it.id, it);
      }
      for (const it of items) if (validIds.has(it.id)) map.set(it.id, it);
      const merged = [...map.values()];
      const out = {
        model: model || old.model || 'unknown',
        dim: dim || old.dim,
        builtAt: new Date().toISOString(),
        items: merged,
      };
      this._write(out);
      return out;
    }, { name: '.chain-vectors.lock' });
  }

  _id(chain, index, node) {
    return crypto.createHash('sha1')
      .update([chain, index, node.t || '', node.who || '', node.type || '', node.text || ''].join('\u0000'))
      .digest('hex').slice(0, 20);
  }

  /** 增量建链节点索引；链节点只追加，按 id 对账，删掉已不存在的 */
  async buildIndex() {
    let idx = this._read();
    let model = idx.model;
    let reset = false;
    try {
      const h = await this.healthFn();
      if (h && h.ok && h.model) {
        if (model && model !== 'unknown' && model !== h.model) {
          idx = { model: h.model, dim: 0, builtAt: null, items: [] };
          reset = true;
        }
        model = h.model;
      }
    } catch (e) { /* 服务不可用就用旧索引 */ }

    const current = [];
    const nodeCounts = new Map();
    for (const c of this.chainStore.list()) {
      const full = this.chainStore.get(c.name);
      if (!full) continue;
      const nodes = Array.isArray(full.nodes) ? full.nodes : [];
      nodeCounts.set(c.name, nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const text = String(n.text || '').trim();
        if (!text) continue;
        current.push({
          id: this._id(c.name, i, n),
          chain: c.name, index: i, nodeCount: nodes.length,
          t: n.t || '', who: n.who || '', type: n.type || '',
          text: text.slice(0, 500),
        });
      }
    }

    const currentIds = new Set(current.map((x) => x.id));
    const kept = idx.items.filter((x) => currentIds.has(x.id));
    const known = new Set(kept.map((x) => x.id));
    let added = 0;
    for (const item of current) {
      if (known.has(item.id)) continue;
      try {
        const vec = await this.embedFn(item.chain + ' · ' + item.text);
        item.vec = vec;
        kept.push(item);
        known.add(item.id);
        added++;
      } catch (e) {
        const out = this._commit(kept, currentIds, model || idx.model, idx.dim, reset);
        return { ok: false, added, total: out.items.length, model: out.model, error: 'embed 失败：' + (e.message || e) };
      }
    }

    const dim = kept.length ? kept[0].vec.length : idx.dim;
    const out = this._commit(kept, currentIds, model || idx.model || 'unknown', dim, reset);
    return { ok: true, added, total: out.items.length, model: out.model, dim: out.dim };
  }

  /** 链节点检索；chain 传了就只搜这条链 */
  async query(q, opt = {}) {
    const limit = Math.max(1, Math.min(50, Number(opt.limit) || 5));
    const idx = this._read();
    const items = opt.chain ? idx.items.filter((x) => x.chain === opt.chain) : idx.items;

    if (items.length) {
      try {
        const qv = await this.embedFn(q);
        const scored = items.map((it) => ({ it, score: cosine(qv, it.vec) }))
          .sort((a, b) => b.score - a.score).slice(0, limit);
        return {
          ok: true, mode: 'vector', degraded: false, model: idx.model,
          count: scored.length,
          results: scored.map(({ it, score }) => ({
            id: it.id, chain: it.chain, nodeIndex: it.index, nodeCount: it.nodeCount,
            t: it.t, who: it.who, type: it.type, text: it.text,
            score: Number(score.toFixed(4)), layer: 'chain', match: 'vector',
          })),
        };
      } catch (e) { /* 降级关键词 */ }
    }

    const ql = String(q || '').toLowerCase();
    const tokens = String(q || '').split(/[\s,，。、；;：:]+/).filter(Boolean);
    const scored = [];
    for (const it of items) {
      const text = String(it.text).toLowerCase();
      let hits = 0;
      for (const tk of tokens) if (text.includes(tk.toLowerCase())) hits++;
      if (!hits && !text.includes(ql)) continue;
      scored.push({ it, score: hits || 1 });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      ok: true, mode: 'keyword', degraded: true,
      degradedReason: items.length ? 'embed 不可用，已降级关键词' : '链索引为空，已降级关键词',
      model: idx.model, count: Math.min(limit, scored.length),
      results: scored.slice(0, limit).map(({ it, score }) => ({
        id: it.id, chain: it.chain, nodeIndex: it.index, nodeCount: it.nodeCount,
        t: it.t, who: it.who, type: it.type, text: it.text,
        score: Number((score / 10).toFixed(4)), layer: 'chain', match: 'keyword',
      })),
    };
  }

  stats() {
    const idx = this._read();
    return { indexed: idx.items.length, model: idx.model, builtAt: idx.builtAt };
  }
}

module.exports = { ChainSearch };
