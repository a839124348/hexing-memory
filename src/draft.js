/**
 * draft.js — 草稿层（临时索引）
 *
 * 定位（规划书第二节）：从"对话发生"到"闲时提炼"之间的缓冲。
 * - 分钟级把对话收进来
 * - **字面检索**（用户 2026-11-05 拍板：MVP 阶段不向量化）
 * - 提炼成功后移除；失败保留重试
 *
 * 为什么草稿可以只做字面检索：
 * 草稿里只有最近几分钟的话，字面命中率很高；而且这些内容马上进正式库，
 * 那里有完整向量检索。等 MVP 跑完看实际影响，再决定要不要给草稿加向量化。
 */
const fs = require('fs');
const path = require('path');
const { validateRecords } = require('./validate');
const { withWriteLock } = require('./lock');

class Draft {
  constructor(root) {
    this.root = root || path.join(__dirname, '..', 'data');
    this.dir = path.join(this.root, 'draft');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'pending.jsonl');
  }

  _atomicWrite(content) {
    const tmp = path.join(this.dir, '.' + 'pending.jsonl' + '.' + process.pid + '.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  _read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }

  /**
   * 收进草稿（校验后写入；草稿与正式库共用同一套校验）
   * 注意：草稿允许"跨批次重复"吗？不允许——重复说明客户端重试，必须拦掉。
   */
  add(records) {
    // checkSimilar:false —— **草稿层不做近似判重**（规划书第三节：近似判重仅导入层）。
    // 草稿只做字段校验 + 完全重复（同 cid+时间+说话人+mid+内容）。
    // 实测教训：日常对话里「在吗」说两遍、把问句重说一遍都很正常，
    // 开相似度会把整批草稿打成死信（2026-11-06）。
    const v = validateRecords(records, { checkSimilar: false });
    if (!v.ok) return { ok: false, added: 0, errors: v.errors, warnings: v.warnings };

    try {
      return withWriteLock(this.root, () => this._addLocked(records, v));
    } catch (e) {
      if (e && e.code === 'LOCK_TIMEOUT') {
        return {
          ok: false,
          added: 0,
          skipped: records.length,
          errors: [{ code: 'LOCK_TIMEOUT', message: e.message }],
          warnings: v.warnings || [],
        };
      }
      throw e;
    }
  }

  _addLocked(records, v) {
    const existing = this._read();
    const existingKeys = new Set(existing.map((r) => [r.cid, r.t, r.s, r.mid || '', r.c].join('\u0000')));
    const fresh = [];
    for (const r of records) {
      const key = [r.cid, r.t, r.s, r.mid || '', r.c].join('\u0000');
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      fresh.push(r);
    }
    if (!fresh.length) return { ok: true, added: 0, skipped: records.length, errors: [], warnings: v.warnings };
    const all = existing.concat(fresh);
    this._atomicWrite(all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { ok: true, added: fresh.length, skipped: records.length - fresh.length, errors: [], warnings: v.warnings };
  }

  /**
   * 字面检索（MVP 版）
   * 打分：命中词数 ×2 + 出现次数；同分按时间倒序（越新越靠前）
   */
  search(query, limit = 10) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = q.split(/[\s,，。、；;：:]+/).filter((x) => x.length >= 1);
    if (!tokens.length) return [];
    const rows = this._read();
    const scored = [];
    for (const r of rows) {
      const text = String(r.c || '');
      const lower = text.toLowerCase();
      let hitWords = 0;
      let totalHits = 0;
      for (const tk of tokens) {
        const t = tk.toLowerCase();
        let from = 0;
        let n = 0;
        while (true) {
          const idx = lower.indexOf(t, from);
          if (idx < 0) break;
          n++;
          from = idx + t.length;
        }
        if (n > 0) { hitWords++; totalHits += n; }
      }
      if (!hitWords) continue;
      scored.push({ r, score: hitWords * 2 + totalHits });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.r.t < b.r.t ? 1 : -1));
    // 注意：**不要带 id 字段**。草稿记录还没入库，没有 id；
    // 写成 id: undefined 会让返回值不是合法 JSON，DSH 会拒收（实测 2026-11-06）。
    return scored.slice(0, limit).map(({ r, score }) => ({
      t: r.t, s: r.s, c: r.c, cid: r.cid, score, layer: 'draft', match: 'literal',
    }));
  }

  /** 全部待提炼条目（按时序） */
  pending() {
    // 时间相同必须返回 0（不能返回 1）：同一分钟内"用户说 → AI 回"时间本来一样，
    // 比较函数不返回 0 会让 sort 把顺序打乱，变成"AI 先说话"（2026-11-07 实测）
    return this._read().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }

  /** 提炼成功后移除（按 key 比对，避免误删新进来的） */
  remove(records) {
    return withWriteLock(this.root, () => {
      const keys = new Set(records.map((r) => [r.cid, r.t, r.s, r.mid || '', r.c].join('\u0000')));
      const rest = this._read().filter((r) => !keys.has([r.cid, r.t, r.s, r.mid || '', r.c].join('\u0000')));
      this._atomicWrite(rest.length ? rest.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
      return records.length - (this._read().length - rest.length);
    });
  }

  clear() {
    return withWriteLock(this.root, () => {
      this._atomicWrite('');
      return { ok: true };
    });
  }

  stats() {
    const rows = this._read();
    return {
      pending: rows.length,
      oldest: rows.length ? rows.reduce((m, r) => (r.t < m ? r.t : m), rows[0].t) : null,
      newest: rows.length ? rows.reduce((m, r) => (r.t > m ? r.t : m), rows[0].t) : null,
    };
  }
}

module.exports = { Draft };
