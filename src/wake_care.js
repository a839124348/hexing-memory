/**
 * wake_care.js — 7 天关心曲线
 *
 * 比较最近 7 个完整天 vs 前 7 个完整天，只在样本足够且有记忆证据时给一句
 * 定性观察。不报数字、不做诊断、不拿关心换回复。
 *
 * 数据：common/wake-care.json
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');
const { localDay } = require('./time');

const COOLDOWN_DAYS = 7;
const MIN_SAMPLE_DAYS = 5;

function fileOf(root) {
  return path.join(root, 'common', 'wake-care.json');
}

function _empty() {
  return { version: 1, history: [] };
}

function readCare(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
    const history = Array.isArray(raw && raw.history) ? raw.history : [];
    return { version: 1, history: history.filter((x) => x && typeof x === 'object').slice(-52) };
  } catch (e) {
    return _empty();
  }
}

function _atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 1), null, 'utf8');
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
    const data = readCare(root);
    const result = fn(data);
    _atomicWrite(fileOf(root), data);
    return result;
  }, { name: '.wake-care.lock' });
}

function _offsetDay(day, n) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDay(d.getTime());
}

function _window(profile, start, end) {
  const days = (profile && profile.days) || {};
  const byHour = new Array(24).fill(0);
  let total = 0;
  let daysWithData = 0;

  for (const day of Object.keys(days)) {
    if (day < start || day > end) continue;
    const arr = Array.isArray(days[day]) ? days[day] : [];
    const sum = arr.reduce((a, b) => a + (Number(b) || 0), 0);
    if (sum > 0) daysWithData += 1;
    total += sum;
    for (let h = 0; h < 24; h++) byHour[h] += Number(arr[h]) || 0;
  }

  const late = byHour[23] + byHour[0] + byHour[1] + byHour[2];
  let weighted = 0;
  for (let h = 0; h < 24; h++) {
    const adj = h < 6 ? h + 24 : h;
    weighted += adj * byHour[h];
  }

  return {
    start,
    end,
    total,
    daysWithData,
    byHour,
    latePerDay: late / 7,
    meanHour: total ? weighted / total : null,
  };
}

/**
 * 分析 7 天曲线。
 * @returns {{observation:string, weekStart:string, confidence:number, recent:object, previous:object}|null}
 */
function analyze(profile, now = Date.now()) {
  if (!profile || !profile.days) return null;
  const today = localDay(now);
  const recent = _window(profile, _offsetDay(today, -7), _offsetDay(today, -1));
  const previous = _window(profile, _offsetDay(today, -14), _offsetDay(today, -8));

  if (recent.daysWithData < MIN_SAMPLE_DAYS || previous.daysWithData < MIN_SAMPLE_DAYS) return null;

  const candidates = [];

  const lateBase = previous.latePerDay;
  if (recent.latePerDay >= 1 && (lateBase === 0 || recent.latePerDay >= lateBase * 1.5)) {
    const score = lateBase === 0 ? recent.latePerDay * 2 : recent.latePerDay / lateBase;
    candidates.push({ observation: 'late', score });
  }

  if (previous.total >= 5 && recent.total <= previous.total * 0.5) {
    candidates.push({ observation: 'quiet', score: previous.total / Math.max(1, recent.total) });
  }

  if (recent.meanHour !== null && previous.meanHour !== null) {
    const diff = recent.meanHour - previous.meanHour;
    if (Math.abs(diff) >= 1.5) {
      candidates.push({
        observation: diff > 0 ? 'shift-later' : 'shift-earlier',
        score: Math.abs(diff) / 1.5,
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    observation: best.observation,
    weekStart: recent.start,
    confidence: Math.min(1, best.score / 3),
    recent,
    previous,
  };
}

/** 最近 14 天更新过的 open 话题；只取 type/title/summary，不取正文。 */
function pickEvidence(topics, now = Date.now(), days = 14) {
  const cutoff = now - days * 86400000;
  const rows = (Array.isArray(topics) ? topics : [])
    .filter((t) => t && t.status === 'open')
    .map((t) => {
      const updated = Date.parse(t.updatedAt || t.createdAt || '');
      return { t, updated: Number.isFinite(updated) ? updated : 0 };
    })
    .filter((x) => x.updated >= cutoff)
    .sort((a, b) => b.updated - a.updated);
  if (!rows.length) return null;
  const t = rows[0].t;
  return {
    id: String(t.id || ''),
    type: String(t.type || ''),
    title: String(t.title || ''),
    summary: String(t.summary || ''),
  };
}

function careLine(observation, evidence) {
  if (!evidence) return '';
  const text = {
    late: '这周你说话的时间比上周晚了一些',
    quiet: '这周你比上周安静了一些',
    'shift-later': '这周你的活动时间比上周往后挪了一些',
    'shift-earlier': '这周你的活动时间比上周往前挪了一些',
  }[observation];
  if (!text) return '';
  const detail = [String(evidence.title || '').trim(), String(evidence.summary || '').trim()]
    .filter(Boolean)
    .join('：')
    .slice(0, 100);
  if (!detail) return '';
  return [
    '[7 天观察] ' + text + '（只是观察，不是结论）。',
    '线索：' + (evidence.type ? evidence.type + '：' : '') + detail,
    '可以问一句，也可以只打招呼；不要报数字，不要诊断，不要用关心换回复。',
  ].join('\n');
}

/** 7 天内已经关心过就不重复。 */
function shouldCare(root, now = Date.now()) {
  const cutoff = now - COOLDOWN_DAYS * 86400000;
  return !readCare(root).history.some((x) => {
    const at = Date.parse(x.at || '');
    return Number.isFinite(at) && at >= cutoff;
  });
}

function markCare(root, entry) {
  return _mutate(root, (data) => {
    data.history.push({
      weekStart: String(entry.weekStart || ''),
      observation: String(entry.observation || ''),
      evidence: String(entry.evidence || '').slice(0, 160),
      at: new Date(entry.at || Date.now()).toISOString(),
      response: String(entry.response || ''),
    });
    data.history = data.history.slice(-52);
    return data.history.length;
  });
}

module.exports = {
  COOLDOWN_DAYS,
  MIN_SAMPLE_DAYS,
  fileOf,
  readCare,
  analyze,
  pickEvidence,
  careLine,
  shouldCare,
  markCare,
};
