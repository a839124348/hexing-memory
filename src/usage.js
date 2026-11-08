/**
 * usage.js — 每日 token 用量累计
 *
 * 数据只落在 common/stats.json：
 *   { version, updatedAt, days: { "YYYY-MM-DD": { chat: {...}, refine: {...} } } }
 *
 * 对话与记忆提炼分开计；输入包含 cache read/write（DSH TokenUsage 的口径），
 * 另存 uncachedIn 便于看缓存命中。跨进程写走 .stats.lock，避免多开 DSH 时覆盖。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeUsage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const uncachedIn = num(
    r.inputTokens ?? r.input_tokens ?? r.promptTokens ?? r.prompt_tokens
  );
  const out = num(
    r.outputTokens ?? r.output_tokens ?? r.completionTokens ?? r.completion_tokens
  );
  const cacheRead = num(r.cacheReadTokens ?? r.cache_read_input_tokens ?? r.cache_read_tokens);
  const cacheWrite = num(r.cacheWriteTokens ?? r.cache_creation_input_tokens ?? r.cache_creation_tokens);
  return {
    in: uncachedIn + cacheRead + cacheWrite,
    uncachedIn,
    out,
    cacheRead,
    cacheWrite,
  };
}

function zeroBucket() {
  return { calls: 0, in: 0, out: 0, uncachedIn: 0, cacheRead: 0, cacheWrite: 0 };
}

function localDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addBucket(a, b) {
  return {
    calls: a.calls + b.calls,
    in: a.in + b.in,
    out: a.out + b.out,
    uncachedIn: a.uncachedIn + b.uncachedIn,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

class UsageStore {
  constructor(root) {
    this.dir = path.join(root, 'common');
    this.file = path.join(this.dir, 'stats.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || typeof j !== 'object' || !j.days || typeof j.days !== 'object') {
        return { version: 1, updatedAt: null, days: {} };
      }
      return { version: 1, updatedAt: j.updatedAt || null, days: j.days };
    } catch (e) {
      return { version: 1, updatedAt: null, days: {} };
    }
  }

  _write(data) {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 累加一次调用；purpose = chat | refine */
  record(purpose, raw, at = new Date()) {
    if (!raw || typeof raw !== 'object') return null;
    const bucket = String(purpose) === 'refine' ? 'refine' : 'chat';
    const u = normalizeUsage(raw);
    return withWriteLock(this.dir, () => {
      const data = this._read();
      const day = localDay(at);
      const entry = data.days[day] || { chat: zeroBucket(), refine: zeroBucket() };
      entry.chat = entry.chat || zeroBucket();
      entry.refine = entry.refine || zeroBucket();
      entry[bucket] = addBucket(entry[bucket], { ...u, calls: 1 });
      data.days[day] = entry;
      data.updatedAt = new Date().toISOString();

      // 只留最近 370 天，避免 stats.json 无限增长
      const keys = Object.keys(data.days).sort();
      while (keys.length > 370) delete data.days[keys.shift()];

      this._write(data);
      return entry[bucket];
    }, { name: '.stats.lock' });
  }

  /** 今日 + 最近 N 天（含空格），供总览页画柱状图 */
  snapshot(days = 14) {
    const data = this._read();
    const today = localDay();
    const history = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = localDay(d);
      const e = data.days[key] || {};
      const chat = e.chat || zeroBucket();
      const refine = e.refine || zeroBucket();
      history.push({
        day: key,
        chat,
        refine,
        total: addBucket(chat, refine),
      });
    }
    const t = history[history.length - 1] || { chat: zeroBucket(), refine: zeroBucket(), total: zeroBucket() };
    return { today: t, history, updatedAt: data.updatedAt };
  }
}

module.exports = { UsageStore, normalizeUsage, localDay };
