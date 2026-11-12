/**
 * wake_profile.js — 用户作息记录器（只记发言时间，不记内容）
 *
 * 数据：common/wake-profile.json
 *   { version:1, backfilledAt, days: { "YYYY-MM-DD": [24 个小时的发言次数] } }
 *
 * 用途：
 * - memory_wake 排 4 个唤醒时间点
 * - 当前小时不在活跃时段时跳过陪伴唤醒
 * - 7 天关心曲线
 *
 * 边界：DSH 插件拿不到鼠标键盘，这里只能记“用户发消息的本地时间”，
 * 不是桌面端那种真正的在线时长。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');
const { localDay, localHour } = require('./time');

const KEEP_DAYS = 30;
const WINDOW_DAYS = 14;

function fileOf(root) {
  return path.join(root, 'common', 'wake-profile.json');
}

function emptyProfile() {
  return { version: 1, backfilledAt: null, days: {} };
}

function _normalize(raw) {
  const p = emptyProfile();
  if (!raw || typeof raw !== 'object') return p;
  p.backfilledAt = raw.backfilledAt || null;
  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  for (const day of Object.keys(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const arr = Array.isArray(days[day]) ? days[day] : [];
    p.days[day] = Array.from({ length: 24 }, (_, i) => Math.max(0, Math.floor(Number(arr[i]) || 0)));
  }
  return p;
}

function readProfile(root) {
  try {
    return _normalize(JSON.parse(fs.readFileSync(fileOf(root), 'utf8')));
  } catch (e) {
    return emptyProfile();
  }
}

function _atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj), null, 'utf8');
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

function _mutate(root, fn) {
  return withWriteLock(root, () => {
    const p = readProfile(root);
    const result = fn(p);
    _atomicWrite(fileOf(root), p);
    return result;
  }, { name: '.wake-profile.lock' });
}

function _sweepLocked(p, ts) {
  const cutoff = localDay(ts - KEEP_DAYS * 86400000);
  for (const day of Object.keys(p.days)) {
    if (day < cutoff) delete p.days[day];
  }
}

/** 实时记一次用户发言：给当前本地小时 +1。 */
function noteActivity(root, ts = Date.now()) {
  const day = localDay(ts);
  const hour = localHour(ts);
  return _mutate(root, (p) => {
    if (!p.days[day]) p.days[day] = new Array(24).fill(0);
    p.days[day][hour] += 1;
    _sweepLocked(p, ts);
    return { day, hour, count: p.days[day][hour] };
  });
}

/** 从 raw 读最近 N 天，只数 human；跳过今天，避免和实时计数重复。 */
function _collectRaw(root, ts, days) {
  const rawDir = path.join(root, 'raw');
  const out = {};
  const today = localDay(ts);
  const cutoff = localDay(ts - days * 86400000);
  let files = [];
  try {
    files = fs.readdirSync(rawDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch (e) {
    return out;
  }
  for (const f of files) {
    const day = f.slice(0, 10);
    if (day < cutoff || day >= today) continue;
    const arr = new Array(24).fill(0);
    let lines = [];
    try { lines = fs.readFileSync(path.join(rawDir, f), 'utf8').split(/\r?\n/); } catch (e) { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (e) { continue; }
      if (!r || (r.type !== 'human' && r.origin !== 'human')) continue;
      const t = String(r.t || '');
      if (t.slice(0, 10) !== day) continue;
      const h = Number(t.slice(11, 13));
      if (Number.isInteger(h) && h >= 0 && h < 24) arr[h] += 1;
    }
    out[day] = arr;
  }
  return out;
}

/**
 * 首次启动回填。只补 profile 里还没有的日期；已有日期不覆盖。
 * @returns {{filled:number, days:number}}
 */
function backfillFromRaw(root, ts = Date.now(), days = KEEP_DAYS) {
  const counts = _collectRaw(root, ts, days);
  return _mutate(root, (p) => {
    let filled = 0;
    for (const day of Object.keys(counts)) {
      if (p.days[day]) continue;
      p.days[day] = counts[day];
      filled += 1;
    }
    p.backfilledAt = new Date(ts).toISOString();
    _sweepLocked(p, ts);
    return { filled, days: Object.keys(counts).length };
  });
}

function _activeHours(byHour, total) {
  if (!total) return [];
  const ranked = byHour
    .map((count, hour) => ({ hour, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour);
  const picked = [];
  let covered = 0;
  for (const x of ranked) {
    if (picked.length && x.count < 2) continue;
    picked.push(x.hour);
    covered += x.count;
    if (covered >= total * 0.8) break;
  }
  if (!picked.length) picked.push(ranked[0].hour);
  return picked.sort((a, b) => a - b);
}

/**
 * 最近 windowDays 天的作息汇总。
 * @returns {{sampleDays, days, byHour, activeHours, total, cold, today}}
 */
function summary(root, ts = Date.now(), windowDays = WINDOW_DAYS) {
  const p = readProfile(root);
  const today = localDay(ts);
  const cutoff = localDay(ts - (windowDays - 1) * 86400000);
  const days = {};
  const byHour = new Array(24).fill(0);
  let total = 0;
  let sampleDays = 0;

  for (const day of Object.keys(p.days)) {
    if (day < cutoff || day > today) continue;
    const arr = p.days[day] || [];
    const sum = arr.reduce((a, b) => a + (Number(b) || 0), 0);
    if (sum > 0) sampleDays += 1;
    days[day] = arr.slice();
    for (let h = 0; h < 24; h++) byHour[h] += Number(arr[h]) || 0;
    total += sum;
  }

  return {
    sampleDays,
    days,
    byHour,
    activeHours: _activeHours(byHour, total),
    total,
    cold: sampleDays < 3,
    today,
  };
}

module.exports = {
  KEEP_DAYS,
  WINDOW_DAYS,
  fileOf,
  readProfile,
  noteActivity,
  backfillFromRaw,
  summary,
};
