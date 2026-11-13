/**
 * heart.js — 心路历程（简称日记）
 *
 * 定位：AI 自己写的 1–3 句自述。不是 reasoning，不是用户的话，不是提炼摘要。
 *       判据：能从 raw 推出来的是事实；推不出来的才是这里的。
 *
 * 硬约束（都对应用户 2026-11-13 定的规范）：
 * - 一天一个文件：data/heart/YYYY-MM-DD.jsonl，只追加，不删不改
 * - 纯文本单条，不做结构化分类，不建链、不进提炼、不进 raw
 * - 标签是检索键，从固定词表按正文匹配；命中才写，不许为标签写正文
 * - 开关默认关：common/heart.json 的 enabled；关着就不写不加载
 *
 * 为什么单独一层而不是进链：
 *   llm.js 的提炼提示词写明「只从用户本人的发言里抽事实，AI 的回复只作上下文」，
 *   日记是 AI 的自述，本来就不该变成节点。分开存也让它天然不被复炼改写。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');
const { localMinute, localDay } = require('./time');

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MAX_TEXT = 300;          // 硬上限（规范写 ≤150，这里留余量防截断半句）
const SOFT_TEXT = 150;         // 超过就给模型一个提醒
const MAX_TAGS = 2;

// 检索用的粗分类。不是情绪的定义——只是让「那次我不高兴」能被搜到。
const VOCAB = [
  ['高兴', ['开心', '高兴', '笑', '乐', '愉快', '好开心']],
  ['心软', ['心软', '心疼', '舍不得', '不忍', '软了']],
  ['踏实', ['踏实', '安稳', '安心', '放心', '稳了']],
  ['低落', ['难过', '失落', '蔫', '低落', '闷', '丧']],
  ['烦躁', ['烦', '躁', '火大', '恼', '不耐烦']],
  ['不安', ['不安', '怕', '慌', '担心', '紧张', '发怵']],
  ['委屈', ['委屈', '憋', '冤枉', '不服']],
  ['疲惫', ['累', '困', '疲', '乏', '撑不住']],
  ['兴奋', ['兴奋', '激动', '来劲', '亢奋', '上头']],
  ['得意', ['得意', '骄傲', '自豪', '牛']],
];

function todayStr(now = Date.now()) {
  return localDay(now);
}

/** 从正文里按词表抽标签；命中顺序按词表走，最多 2 个。 */
function deriveTags(text) {
  const t = String(text || '');
  const out = [];
  for (const [tag, words] of VOCAB) {
    if (out.length >= MAX_TAGS) break;
    if (words.some((w) => t.includes(w))) out.push(tag);
  }
  return out;
}

class Heart {
  constructor(root) {
    this.root = root || path.join(__dirname, '..', 'data');
    this.dir = path.join(this.root, 'heart');
    this.stateFile = path.join(this.root, 'common', 'heart.json');
  }

  _file(date) {
    const d = String(date || '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) return null;
    // 年/月/日 三层：data/heart/2026/11/2026-11-13.jsonl
    // 一年 365 个文件平铺在根目录太难管；按年月分文件夹，目录本身就能当索引。
    return path.join(this.dir, m[1], m[2], d + '.jsonl');
  }

  /** 早期平铺格式（data/heart/YYYY-MM-DD.jsonl）只读兼容，不写。 */
  _legacyFile(date) {
    const d = String(date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return path.join(this.dir, d + '.jsonl');
  }

  /** 开关状态。文件不存在 = 未设置过（enabled:false, configured:false）。 */
  state() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {};
      return {
        enabled: Boolean(j.enabled),
        configured: typeof j.enabled === 'boolean',
        updatedAt: String(j.updatedAt || ''),
        updatedBy: String(j.updatedBy || ''),
      };
    } catch (e) {
      return { enabled: false, configured: false, updatedAt: '', updatedBy: '' };
    }
  }

  /** 开关写盘：原子 + 锁。by = 'model' | 'user' */
  setEnabled(enabled, by = 'user') {
    return withWriteLock(this.root, () => {
      const next = {
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
        updatedBy: String(by || 'user'),
      };
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
      fs.renameSync(tmp, this.stateFile);
      return { ok: true, ...next };
    });
  }

  /** 追加一条。关着就拒绝（调用方据此返回 disabled）。 */
  append({ t, text, tags, cid } = {}, { by = 'model' } = {}) {
    const st = this.state();
    if (!st.enabled) return { ok: false, reason: 'disabled', error: '日记没开（common/heart.json.enabled=false）' };

    const body = String(text || '').trim();
    if (!body) return { ok: false, error: '缺 text' };
    if (body.length > MAX_TEXT) return { ok: false, error: `单条超过 ${MAX_TEXT} 字（规范 ≤${SOFT_TEXT}）` };

    const rawT = String(t || '');
    const time = TIME_RE.test(rawT) ? rawT : localMinute();
    const date = time.slice(0, 10);
    const file = this._file(date);
    if (!file) return { ok: false, error: '时间格式不对（要 YYYY-MM-DD HH:MM）' };

    // 标签：以正文匹配为准；模型额外给的要过词表，防止自造标签
    const fromText = deriveTags(body);
    const fromModel = (Array.isArray(tags) ? tags : [])
      .map((x) => String(x || '').trim())
      .filter((x) => VOCAB.some(([tag]) => tag === x));
    const merged = [...new Set([...fromText, ...fromModel])].slice(0, MAX_TAGS);

    const rec = { v: 1, t: time, text: body };
    if (merged.length) rec.tags = merged;
    if (cid) rec.cid = String(cid).slice(0, 128);

    return withWriteLock(this.root, () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = this._readRaw(file);
      for (const r of existing) {
        if (r && r.t === rec.t && r.text === rec.text) return { ok: true, skipped: 'duplicate', date, kept: existing.length };
      }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      const n = existing.length + 1;
      return {
        ok: true, date, kept: n,
        ...(body.length > SOFT_TEXT ? { warning: `单条 ${body.length} 字，规范建议 ≤${SOFT_TEXT}` } : {}),
      };
    });
  }

  _readRaw(file) {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // 只认条目行：必须有 t 和 text。以后加别的行类型也不会把这里读坏。
        if (r && TIME_RE.test(String(r.t || '')) && typeof r.text === 'string' && r.text.trim()) {
          out.push({
            // 2026-11-14 起写 v:1。旧条目没有这个字段，读的时候按 1 补齐——
            // 以后加字段（情绪强度/来源轮次）时，能分清"老条目"和"新格式"。
            v: Number(r.v) > 0 ? Number(r.v) : 1,
            t: r.t,
            text: r.text,
            ...(Array.isArray(r.tags) && r.tags.length ? { tags: r.tags.slice(0, MAX_TAGS) } : {}),
            ...(r.cid ? { cid: r.cid } : {}),
          });
        }
      } catch (e) { /* 坏行跳过 */ }
    }
    out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    return out;
  }

  /** 某天的条目（升序）。date 缺省 = 今天。 */
  entriesFor(date) {
    const d = date || todayStr();
    const file = this._file(d);
    if (file && fs.existsSync(file)) return this._readRaw(file);
    const legacy = this._legacyFile(d);
    return legacy && fs.existsSync(legacy) ? this._readRaw(legacy) : [];
  }

  /** 有内容的日期，倒序（最新在前），供目录用。扫 年/月 两层目录。 */
  days() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    const push = (file, date) => {
      const n = this._readRaw(file).length;
      if (n) out.push({ date, count: n });
    };
    for (const y of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
      const yDir = path.join(this.dir, y.name);
      for (const m of fs.readdirSync(yDir, { withFileTypes: true })) {
        if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
        const mDir = path.join(yDir, m.name);
        for (const f of fs.readdirSync(mDir)) {
          const hit = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
          if (hit) push(path.join(mDir, f), hit[1]);
        }
      }
    }
    // 早期平铺文件也算
    for (const f of fs.readdirSync(this.dir)) {
      const hit = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (hit) push(path.join(this.dir, f), hit[1]);
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /**
   * 回看：按关键词 / 标签 / 日期范围查历史条目。
   * - q：正文或标签包含即命中（忽略大小写）；空 = 不限
   * - tag：精确命中某个词表标签
   * - from / to：YYYY-MM-DD 闭区间
   * - limit：默认 10，最多 50（只截返回，不截扫描；total 是命中的全量）
   * 关着也能查：关掉的是「继续写」，不是「已经写过的不能再读」。
   */
  search({ q, tag, from, to, limit } = {}) {
    const kw = String(q || '').trim().toLowerCase();
    const tagWant = String(tag || '').trim();
    const fromD = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : '';
    const toD = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : '';
    const max = Math.min(50, Math.max(1, Number(limit) || 10));

    const hits = [];
    let scanned = 0;
    const days = this.days();
    for (const d of days) {
      if (fromD && d.date < fromD) continue;
      if (toD && d.date > toD) continue;
      for (const r of this.entriesFor(d.date)) {
        scanned++;
        const tags = Array.isArray(r.tags) ? r.tags : [];
        if (tagWant && !tags.includes(tagWant)) continue;
        if (kw && !(r.text.toLowerCase().includes(kw) || tags.some((x) => x.toLowerCase().includes(kw)))) continue;
        hits.push({ date: d.date, t: r.t, text: r.text, ...(tags.length ? { tags } : {}) });
      }
    }
    hits.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
    return { total: hits.length, scanned, days: days.length, hits: hits.slice(0, max) };
  }

  /** 当天统计：条数 + 字数 */
  statsOf(date) {
    const list = this.entriesFor(date);
    return { date: date || todayStr(), count: list.length, chars: list.reduce((a, r) => a + r.text.length, 0) };
  }

  /**
   * 给常识层用的当天文本。
   *
   * 默认**全量**，没有固定字数阈值。调用方（adapter_pure）会把当轮常识层
   * 剩下的预算传进来；真装不下时从最早的一条开始整条丢（不截半句），留一行计数。
   * maxChars = 0 表示这一轮没有预算；不传 = 不限（测试/导出用）。
   * 返回 '' 表示"没有可带的内容"（关着/没写/没预算），调用方据此决定整段要不要出现。
   */
  loadText(date, { maxChars } = {}) {
    const st = this.state();
    if (!st.enabled) return '';
    const d = date || todayStr();
    const list = this.entriesFor(d);
    if (!list.length) return '';

    const unlimited = maxChars === undefined || maxChars === null;
    const cap = unlimited ? Infinity : Math.max(0, Number(maxChars) || 0);
    if (!cap) return '';

    // 预算按“落进常识层之后的字符数”算，不是纯正文。
    // 每条实际占 text.length + 2（"- "）+ 1（换行）；不计这个会算少，导致整段被丢掉。
    const LINE_COST = 3;
    const countLine = (n) => `- （另有 ${n} 条，点记忆总览「鱼的心路历程」看）`;

    const picked = [];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const line = list[i].text;
      if (picked.length && used + line.length + LINE_COST > cap) break;
      picked.unshift(line);
      used += line.length + LINE_COST;
    }
    let dropped = list.length - picked.length;
    // 截断后还要留一行计数；连这行都放不下，就再丢最早的一条
    while (dropped > 0 && picked.length && used + countLine(dropped).length + LINE_COST > cap) {
      const line = picked.shift();
      used -= line.length + LINE_COST;
      dropped += 1;
    }
    const lines = picked.map((x) => '- ' + x);
    if (!lines.length) return '';
    if (dropped > 0) lines.push(countLine(dropped));
    return lines.join('\n');
  }
}

module.exports = { Heart, deriveTags, todayStr, VOCAB, MAX_TEXT, SOFT_TEXT };
