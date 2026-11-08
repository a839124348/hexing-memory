/**
 * validate.js — 记忆记录校验器（15 项）
 *
 * 设计原则：**校验不通过 = 不许导入**。
 * 每一项都对应一个真实踩过的坑（见 docs/规划书-v0.3.md 第四节）。
 *
 * 用法：
 *   const { validateRecords, validateFile } = require('./validate');
 *   const r = validateRecords(records);           // records: 数组
 *   const r = validateFile('data/raw/2026-11-05.jsonl');
 */
const fs = require('fs');
const crypto = require('crypto');

const REQUIRED = ['t', 's', 'c', 'cid', 'v'];
const ALLOWED = new Set(['t', 's', 'c', 'cid', 'mid', 'v', 'id', 'src', 'type', 'origin']);
const TYPE_ENUM = new Set(['human', 'ai', 'system', 'tool']);
const ORIGIN_ENUM = new Set(['human', 'ai', 'recall_echo', 'import']);
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const MAX_CONTENT = 200000;
const MAX_SPEAKER = 64;
const MAX_CID = 128;
const SIMILAR_THRESHOLD = 0.8;
const RECALL_MARK = '[记忆]';   // 召回注入标记

/** 归一化（去空白 + 标点），用于哈希与相似度 */
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[：:，。、；（）()【】\[\]「」"'“”\-—…·]/g, '');
}

/**
 * 完全重复的判定键：**必须带会话 ID**。
 * 为什么：不同会话里说同一句话很正常（每天"早安"），不带 cid 会把正常内容误判为重复。
 * 同一会话里同时间同说话人同内容，才是真重复（重复写入 / 客户端重试）。
 *
 * 另外带上可选的 mid（平台消息唯一标识）：同一分钟里连说两次「继续」，
 * 时间/说话人/内容全都一样，只有 rpcId 不同——不带 mid 会把第二次当重复吞掉。
 * 没有 mid 的老数据按空串计算，哈希与以前一致，不影响兼容。
 */
function contentHash(r) {
  return crypto
    .createHash('sha1')
    .update([r.cid || '', r.t || '', r.s || '', r.mid || '', normalize(r.c)].join('\u0000'))
    .digest('hex')
    .slice(0, 20);
}

/** 内容指纹（不含 cid）——用于跨会话同内容检测（只告警，不阻断） */
function contentFingerprint(r) {
  return crypto
    .createHash('sha1')
    .update(normalize(r.c))
    .digest('hex')
    .slice(0, 20);
}

/** bigram Jaccard 相似度 */
function similarity(a, b) {
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** 判断日期是否真实存在（防 2026-02-30） */
function realDate(y, mo, d) {
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return dt.getFullYear() === Number(y) && dt.getMonth() === Number(mo) - 1 && dt.getDate() === Number(d);
}

/**
 * 校验一批记录
 * @param {Array<object>} records
 * @param {object} opt { checkSimilar: true, now: Date }
 * @returns {{ ok: boolean, errors: Array, warnings: Array, stats: object }}
 */
function validateRecords(records, opt = {}) {
  const errors = [];
  const warnings = [];
  const checkSimilar = opt.checkSimilar !== false;
  const now = opt.now || new Date();
  const seenHash = new Map();      // hash(cid+time+speaker+content) -> index
  const seenFp = new Map();        // 内容指纹 -> {cid, index}（跨会话检测）
  const seenContent = [];          // 用于近似比对（只保留最近 2000 条，防 O(n²) 爆炸）
  const lastTimeByCid = new Map();

  const stats = { total: 0, valid: 0, dup: 0, echoed: 0, warn: 0 };

  const push = (arr, index, code, message, extra) => {
    arr.push({ index, code, message, ...(extra || {}) });
  };

  records.forEach((r, i) => {
    stats.total++;
    const at = '第 ' + (i + 1) + ' 条';

    // 结构校验
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      push(errors, i, 'NOT_OBJECT', at + '：不是对象');
      return;
    }
    for (const k of REQUIRED) {
      if (r[k] === undefined || r[k] === null || r[k] === '') {
        push(errors, i, 'MISSING_FIELD', at + '：缺必填字段 ' + k);
        return;
      }
    }
    for (const k of Object.keys(r)) {
      if (!ALLOWED.has(k)) {
        push(errors, i, 'UNKNOWN_FIELD', at + '：不允许的字段 ' + k);
        return;
      }
    }

    // 1. 乱码（U+FFFD）
    if (typeof r.c !== 'string' || r.c.includes('\uFFFD')) {
      push(errors, i, 'FFFD', at + '：内容含替换符 U+FFFD（编码损坏）');
      return;
    }
    // 2. 空内容
    if (!String(r.c).trim()) {
      push(errors, i, 'EMPTY_CONTENT', at + '：内容为空');
      return;
    }
    // 3. 内容过长
    if (String(r.c).length > MAX_CONTENT) {
      push(errors, i, 'CONTENT_TOO_LONG', at + '：内容超长 ' + String(r.c).length);
      return;
    }
    // 4. 控制字符（除 \n \t）
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(String(r.c))) {
      push(errors, i, 'CONTROL_CHAR', at + '：含控制字符');
      return;
    }
    // 5. 时间格式严格
    const m = TIME_RE.exec(String(r.t));
    if (!m) {
      push(errors, i, 'TIME_FORMAT', at + '：时间格式必须是 YYYY-MM-DD HH:MM，实际 "' + r.t + '"');
      return;
    }
    if (!realDate(m[1], m[2], m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59) {
      push(errors, i, 'TIME_INVALID', at + '：时间不存在 ' + r.t);
      return;
    }
    // 6. 说话人
    if (typeof r.s !== 'string' || !r.s.trim() || r.s.length > MAX_SPEAKER) {
      push(errors, i, 'SPEAKER', at + '：说话人不合法');
      return;
    }
    // 7. 会话 ID
    if (typeof r.cid !== 'string' || !r.cid.trim() || r.cid.length > MAX_CID) {
      push(errors, i, 'CID', at + '：会话 ID 不合法');
      return;
    }
    // 7.5 可选消息 ID（平台侧唯一标识，用于区分同分钟同文的两条发言）
    if (r.mid !== undefined && (typeof r.mid !== 'string' || !r.mid.trim() || r.mid.length > 128)) {
      push(errors, i, 'MID', at + '：消息 ID 不合法');
      return;
    }
    // 8. 版本
    if (r.v !== 1) {
      push(errors, i, 'VERSION', at + '：版本必须是 1');
      return;
    }
    // 9. 枚举
    if (r.type !== undefined && !TYPE_ENUM.has(r.type)) {
      push(errors, i, 'TYPE_ENUM', at + '：type 非法 ' + r.type);
      return;
    }
    if (r.origin !== undefined && !ORIGIN_ENUM.has(r.origin)) {
      push(errors, i, 'ORIGIN_ENUM', at + '：origin 非法 ' + r.origin);
      return;
    }

    // 10. 召回污染回流（显式标记 / origin）
    if (String(r.c).includes(RECALL_MARK) || r.origin === 'recall_echo') {
      stats.echoed++;
      push(errors, i, 'RECALL_ECHO', at + '：疑似召回复述（含 ' + RECALL_MARK + ' 或 origin=recall_echo）');
      return;
    }

    // 11. 完全重复（同会话内）
    const h = contentHash(r);
    if (seenHash.has(h)) {
      stats.dup++;
      push(errors, i, 'DUPLICATE', at + '：与第 ' + (seenHash.get(h) + 1) + ' 条完全重复（同会话）');
      return;
    }
    seenHash.set(h, i);

    // 11b. 跨会话同内容（只告警——可能是正常重复，也可能是未标记的复述）
    const fp = contentFingerprint(r);
    const prevFp = seenFp.get(fp);
    if (prevFp && prevFp.cid !== r.cid) {
      stats.warn++;
      push(warnings, i, 'CROSS_SESSION_DUP', at + '：与第 ' + (prevFp.index + 1) + ' 条内容相同但会话不同（可能是正常重复，也可能是未标记的复述）');
    }
    if (!prevFp) seenFp.set(fp, { cid: r.cid, index: i });

    // 12. 近似重复（同一会话内，防"同句换个尾巴"）
    if (checkSimilar) {
      let near = -1;
      for (let k = Math.max(0, seenContent.length - 2000); k < seenContent.length; k++) {
        const prev = seenContent[k];
        if (prev.cid !== r.cid) continue;
        if (similarity(prev.c, r.c) >= SIMILAR_THRESHOLD) { near = prev.index; break; }
      }
      if (near >= 0) {
        stats.dup++;
        push(errors, i, 'NEAR_DUPLICATE', at + '：与第 ' + (near + 1) + ' 条高度相似（≥' + SIMILAR_THRESHOLD + '）');
        return;
      }
      seenContent.push({ index: i, cid: r.cid, c: r.c });
    }

    // 13. 同一会话时间非递减（只告警，不阻断）
    const prevT = lastTimeByCid.get(r.cid);
    if (prevT && r.t < prevT) {
      stats.warn++;
      push(warnings, i, 'TIME_ORDER', at + '：时间早于同会话上一条（' + prevT + ' → ' + r.t + '）');
    }
    lastTimeByCid.set(r.cid, r.t);

    // 14. 未来时间（只告警）
    const tMs = new Date(r.t.replace(' ', 'T') + ':00').getTime();
    if (tMs > now.getTime() + 24 * 3600 * 1000) {
      stats.warn++;
      push(warnings, i, 'TIME_FUTURE', at + '：时间在未来 ' + r.t);
    }
    // 15. 太早的时间（只告警，防 1970 类脏数据）
    if (tMs < new Date('2000-01-01T00:00:00').getTime()) {
      stats.warn++;
      push(warnings, i, 'TIME_TOO_OLD', at + '：时间早于 2000 年 ' + r.t);
    }

    stats.valid++;
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

/** 校验一个 JSONL 文件 */
function validateFile(filePath, opt = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const records = [];
  const parseErrors = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      records.push(JSON.parse(t));
    } catch (e) {
      parseErrors.push({ index: i, code: 'BAD_JSON', message: '第 ' + (i + 1) + ' 行不是合法 JSON' });
    }
  });
  const r = validateRecords(records, opt);
  r.errors = parseErrors.concat(r.errors);
  r.ok = r.errors.length === 0;
  return { ...r, file: filePath, parsed: records.length };
}

module.exports = {
  validateRecords,
  validateFile,
  normalize,
  contentHash,
  contentFingerprint,
  similarity,
  REQUIRED,
  ALLOWED,
  MAX_CONTENT,
};
