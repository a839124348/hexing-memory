/**
 * wake_scheduler.js — 陪伴唤醒排程（纯函数）
 *
 * 默认 4 次/天、最小间隔 45 分钟。时间点优先从作息曲线的活跃小时里选；
 * 不够 4 个时用默认时间补齐（默认时间也遵守 45 分钟间隔）。
 *
 * 注意：cron 只能表达“每天同样的时间”，所以 4 个时间点会拆成 4 条 cron，
 * 而不是一条 cron 里塞 4 个任意分钟。
 */

const DEFAULT_TIMES = [
  { hour: 9, minute: 0 },
  { hour: 13, minute: 0 },
  { hour: 17, minute: 0 },
  { hour: 21, minute: 0 },
];

const DEFAULT_COUNT = 4;
const DEFAULT_GAP_MINUTES = 45;

// 吃饭窗口：随机挑一个分钟，不固定在整点。
const MEAL_WINDOWS = {
  lunch: [11 * 60 + 30, 13 * 60],   // 11:30–13:00
  dinner: [17 * 60 + 30, 19 * 60 + 30], // 17:30–19:30
};

function _minutes(t) {
  return t.hour * 60 + t.minute;
}

function _fmt(t) {
  return String(t.hour).padStart(2, '0') + ':' + String(t.minute).padStart(2, '0');
}

/**
 * 选唤醒时间点。
 * @param {{cold?:boolean, activeHours?:number[], byHour?:number[], sampleDays?:number}} profile
 * @param {number} now
 * @param {{count?:number, minGapMinutes?:number}} opt
 * @returns {{hour:number, minute:number}[]}
 */
function pickTimes(profile, now = Date.now(), opt = {}) {
  const count = Math.max(1, Math.min(6, Number(opt.count) || DEFAULT_COUNT));
  const gap = Math.max(15, Number(opt.minGapMinutes) || DEFAULT_GAP_MINUTES);

  if (!profile || profile.cold || !Array.isArray(profile.activeHours) || !profile.activeHours.length) {
    return DEFAULT_TIMES.slice(0, count).map((t) => ({ ...t }));
  }

  // 只有一个“正常时段”（9–21 点）的活跃小时时，直接用默认 4 个时间点。
  // 否则会出现 22:00 + 09:00 这种跨半个地球的混合排程。
  const usable = profile.activeHours.filter((h) => h >= 9 && h <= 21);
  if (usable.length < 2) return DEFAULT_TIMES.slice(0, count).map((t) => ({ ...t }));

  const active = new Set(profile.activeHours);
  const byHour = Array.isArray(profile.byHour) ? profile.byHour : [];
  const candidates = [];
  for (let h = 8; h <= 22; h++) {
    if (!active.has(h)) continue;
    for (let m = 0; m < 60; m += 15) {
      candidates.push({ hour: h, minute: m, minutes: h * 60 + m, score: Number(byHour[h]) || 0 });
    }
  }
  if (!candidates.length) return DEFAULT_TIMES.slice(0, count).map((t) => ({ ...t }));

  const pool = candidates.slice().sort((a, b) => b.score - a.score || a.minutes - b.minutes);
  const picked = [];
  for (const c of pool) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.minutes - c.minutes) >= gap)) picked.push(c);
  }

  // 不够 4 个：用默认时间补齐，但仍然保持最小间隔。
  for (const d of DEFAULT_TIMES) {
    if (picked.length >= count) break;
    const dm = _minutes(d);
    if (picked.some((p) => Math.abs(p.minutes - dm) < gap)) continue;
    picked.push({ hour: d.hour, minute: d.minute, minutes: dm, score: 0 });
  }

  picked.sort((a, b) => a.minutes - b.minutes);
  return picked.slice(0, count).map((t) => ({ hour: t.hour, minute: t.minute }));
}

function _pickMeal(windowName, existingMinutes, gap, rng) {
  const win = MEAL_WINDOWS[windowName];
  if (!win) return null;
  const [start, end] = win;
  if (end - start < gap) return null;

  for (let i = 0; i < 50; i++) {
    const m = start + Math.floor(rng() * (end - start));
    if (existingMinutes.every((x) => Math.abs(x - m) >= gap)) {
      return { hour: Math.floor(m / 60), minute: m % 60, window: windowName };
    }
  }
  // 随机撞不上就每 5 分钟扫一遍，尽量给这顿饭留一个位置。
  for (let m = start; m < end; m += 5) {
    if (existingMinutes.every((x) => Math.abs(x - m) >= gap)) {
      return { hour: Math.floor(m / 60), minute: m % 60, window: windowName };
    }
  }
  return null;
}

/**
 * 一天的完整排程：4 次日常 + 午饭/晚饭各一次。
 * 吃饭时间在窗口里随机；和已有时间冲突就换一个，实在排不下就少这一顿。
 * @returns {{hour:number,minute:number,window?:string}[]}
 */
function pickPlan(profile, now = Date.now(), opt = {}) {
  const generalCount = Math.max(0, Number(opt.generalCount ?? DEFAULT_COUNT));
  const gap = Math.max(15, Number(opt.minGapMinutes) || DEFAULT_GAP_MINUTES);
  const rng = typeof opt.rng === 'function' ? opt.rng : Math.random;
  const withMeals = opt.meals !== false;

  const general = pickTimes(profile, now, { count: generalCount, minGapMinutes: gap });
  const plan = general.map((t) => ({ hour: t.hour, minute: t.minute }));
  if (withMeals) {
    for (const name of Object.keys(MEAL_WINDOWS)) {
      const t = _pickMeal(name, plan.map(_minutes), gap, rng);
      if (t) plan.push(t);
    }
  }
  plan.sort((a, b) => _minutes(a) - _minutes(b));
  return plan;
}

/** `0 9 * * *` 这类每日 cron。 */
function cronFor(t) {
  return `${Number(t.minute) || 0} ${Number(t.hour) || 0} * * *`;
}

function formatTime(t) {
  return _fmt(t);
}

/**
 * 下一次唤醒：返回时间戳和对应的 plan entry（带 window）。
 * @param {{hour:number,minute:number,window?:string}[]} plan
 * @param {number} now
 * @returns {{at:number, entry:object}|null}
 */
function nextEntry(plan, now = Date.now()) {
  const list = (Array.isArray(plan) ? plan : [])
    .filter((t) => t && Number.isFinite(Number(t.hour)) && Number.isFinite(Number(t.minute)))
    .map((t) => ({
      hour: Math.max(0, Math.min(23, Math.floor(Number(t.hour)))),
      minute: Math.max(0, Math.min(59, Math.floor(Number(t.minute)))),
      ...(t.window === 'lunch' || t.window === 'dinner' ? { window: t.window } : {}),
    }))
    .sort((a, b) => _minutes(a) - _minutes(b));
  if (!list.length) return null;

  const d = new Date(now);
  for (const entry of list) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), entry.hour, entry.minute, 0, 0).getTime();
    if (at > now) return { at, entry };
  }
  const first = list[0];
  return {
    at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, first.hour, first.minute, 0, 0).getTime(),
    entry: first,
  };
}

/**
 * 下一次唤醒时间（本地墙钟）。
 * @param {{hour:number,minute:number}[]} times
 * @param {number} now
 * @returns {number|null} epoch ms；空数组返回 null
 */
function nextOccurrence(times, now = Date.now()) {
  const r = nextEntry(times, now);
  return r ? r.at : null;
}

/** 本机 IANA 时区；拿不到就 UTC。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (e) {
    return 'UTC';
  }
}

module.exports = {
  DEFAULT_TIMES,
  DEFAULT_COUNT,
  DEFAULT_GAP_MINUTES,
  MEAL_WINDOWS,
  pickTimes,
  pickPlan,
  cronFor,
  formatTime,
  nextEntry,
  nextOccurrence,
  localTimeZone,
};
