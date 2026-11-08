/**
 * store.js — 原始存档层
 *
 * 设计要点（每一条都对应规划书里的红线）：
 * 1. 按天一个文件：data/raw/YYYY-MM-DD.jsonl（一天一个，便于按月归档、单日回滚）
 * 2. **原子写**：任何落盘都走「临时文件 + fsync + rename」，绝不直接覆写
 *    （星核踩过：覆写一半崩溃 → 半个文件；追加中途崩溃 → 半行卡死整轮解析）
 * 3. **追加也要原子**：读旧内容 → 拼接 → 原子重写。3.4MB 实测 4ms，代价可忽略
 * 4. 每条记录带 id（写入时生成），后续去重/引用/删除标记都靠它
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateRecords, contentFingerprint, contentHash } = require('./validate');
const { withWriteLock } = require('./lock');

class Store {
  /**
   * @param {string} root 数据根目录（默认 data）
   */
  constructor(root) {
    this.root = root || path.join(__dirname, '..', 'data');
    this.rawDir = path.join(this.root, 'raw');
    fs.mkdirSync(this.rawDir, { recursive: true });
  }

  /** 生成记录 id：时间 + 说话人 + 内容指纹前 8 位，冲突时加序号 */
  _genId(r, used) {
    const base = (r.t || '').replace(/[-: ]/g, '') + '-' + contentFingerprint(r).slice(0, 8);
    let id = base;
    let n = 1;
    while (used.has(id)) { id = base + '-' + n; n++; }
    used.add(id);
    return id;
  }

  /** 原子写：临时文件 + fsync + rename（同一目录，避免跨盘退化） */
  _atomicWrite(filePath, content) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + process.pid + '.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);                 // 关键：确保真的落盘，不只是进 OS 缓存
    } finally {
      fs.closeSync(fd);
    }
    // rename 在同一文件系统内是原子操作；失败必须清理临时文件，否则留下垃圾误导下一轮
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* 清理失败也不掩盖原始错误 */ }
      throw e;
    }
  }

  _dayFile(date) {
    return path.join(this.rawDir, date + '.jsonl');
  }

  _dateOf(r) {
    return String(r.t || '').slice(0, 10);
  }

  /**
   * 批量写入（先校验，校验不过整批拒绝——不做部分写入）
   *
   * v0.4：真追加。写锁保护下：
   *   1. 逐天读旧内容（为了去重，不是为了重写）；尾部半行截掉
   *   2. 先全部检查重复，再统一 append，避免“第一天写了、第二天失败”
   *   3. 每条一行 append + fsync，不重写整份
   *
   * @param {Array<object>} records
   * @param {object} opt { allowWarnings, checkSimilar }
   * @returns {{ ok, added, skipped, errors, warnings }}
   */
  append(records, opt = {}) {
    const v = validateRecords(records, opt);
    if (!v.ok) {
      return { ok: false, added: 0, skipped: records.length, errors: v.errors, warnings: v.warnings };
    }

    // 按天分组
    const byDay = new Map();
    for (const r of records) {
      const d = this._dateOf(r);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }

    try {
      return withWriteLock(this.root, () => this._appendLocked(byDay, records.length, v));
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

  /** 锁内执行：先全部准备（查重、生成 id），再统一追加 */
  _appendLocked(byDay, total, v) {
    const plans = [];
    let added = 0;

    for (const [day, list] of byDay) {
      const file = this._dayFile(day);
      const existing = this._readAndRepairTail(file);
      const used = new Set();
      const existingHash = new Set();

      const lines = existing.split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.id) used.add(o.id);
          existingHash.add(contentHash(o));
        } catch (e) { /* 坏行跳过 */ }
      }

      // 先查重，任何一天有重复都不写
      for (const r of list) {
        if (existingHash.has(contentHash(r))) {
          return {
            ok: false,
            added: 0,
            skipped: total,
            errors: [{ code: 'DUPLICATE', message: '与已存记录重复（同会话同时间同内容）：' + r.t + ' ' + r.s, record: r }],
            warnings: v.warnings,
          };
        }
      }

      const newLines = list.map((r) => {
        const rec = { ...r };
        if (!rec.id) rec.id = this._genId(rec, used);
        return JSON.stringify(rec);
      });
      plans.push({ file, payload: newLines.join('\n') + '\n' });
      added += newLines.length;
    }

    // 统一追加：只 append，不重写
    for (const p of plans) {
      const fd = fs.openSync(p.file, 'a');
      try {
        fs.writeSync(fd, p.payload, null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }

    return { ok: true, added, skipped: 0, errors: [], warnings: v.warnings };
  }

  /**
   * 读当天文件；如果尾部不是换行（上次写在半行处崩了），在锁内截到最后一个换行。
   * 用 Buffer 操作，避免把半截多字节字符解码成 U+FFFD 再写坏整个文件。
   * @returns {string} 安全可追加的已有内容
   */
  _readAndRepairTail(file) {
    if (!fs.existsSync(file)) return '';
    const buf = fs.readFileSync(file);
    if (!buf.length) return '';
    if (buf[buf.length - 1] === 0x0a) return buf.toString('utf8');

    const idx = buf.lastIndexOf(0x0a);
    const cut = idx >= 0 ? idx + 1 : 0;
    fs.truncateSync(file, cut);
    return buf.subarray(0, cut).toString('utf8');
  }

  /** 读某一天的全部记录 */
  readDay(date) {
    const file = this._dayFile(date);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }

  /** 列出所有有存档的日期（升序） */
  listDays() {
    return fs.readdirSync(this.rawDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  }

  /** 读一段日期范围（含首尾） */
  readRange(fromDate, toDate) {
    const out = [];
    for (const d of this.listDays()) {
      if (fromDate && d < fromDate) continue;
      if (toDate && d > toDate) continue;
      out.push(...this.readDay(d));
    }
    return out;
  }

  /** 统计 */
  stats() {
    const days = this.listDays();
    let total = 0;
    for (const d of days) total += this.readDay(d).length;
    return { days: days.length, records: total, firstDay: days[0] || null, lastDay: days[days.length - 1] || null };
  }

  /** 按 id 查找 */
  findById(id) {
    for (const d of this.listDays()) {
      const hit = this.readDay(d).find((r) => r.id === id);
      if (hit) return hit;
    }
    return null;
  }
}

module.exports = { Store };
