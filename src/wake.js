/**
 * wake.js — 自动唤醒策略
 *
 * 只处理“陪伴唤醒”（prompt 带 [陪伴唤醒]）：
 * - 安静时段、每日上限、最小间隔、用户活跃、不活跃小时、连续无回应
 * - 生成 [WAKE] 简报；普通提醒走另一条路，不受这些限制
 * - 状态 common/wake.json；日志 common/wake-log.jsonl（不含正文）
 *
 * 纯 Node，不依赖 DSH。插件只负责把 DSH 的 schedule 消息解析成 items。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');
const { localMinute, localDay, localHour } = require('./time');

const WAKE_MARK = '[陪伴唤醒]';
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULTS = {
  version: 1,
  enabled: true,
  quietHours: [23, 8],
  maxPerDay: 6,
  minGapMinutes: 45,
  // 0 = 不因为“用户刚说过话”跳过；忙的时候也可以被关心。
  activeWindowMinutes: 0,
  ignoredLimit: 12,
  pauseDays: 3,
  day: '',
  countToday: 0,
  lastWakeAt: null,
  lastUserReplyAt: null,
  lastWakeReply: '',
  lastClueId: '',
  ignoredStreak: 0,
  pausedUntil: null,
  targetSessionId: '',
  targetTitle: '',
  targetBoundAt: null,
  plan: [],
  planDay: '',
  nextWindow: '',
  nextWakeAt: null,
  // 测试用：把“现在”模拟成正常的醒来时间；生产留空。
  simNow: null,
  simWindow: '',
  companionSchedules: [],
};

function stateFile(root) {
  return path.join(root, 'common', 'wake.json');
}

function logFile(root) {
  return path.join(root, 'common', 'wake-log.jsonl');
}

function defaultState(now = Date.now()) {
  return {
    ...DEFAULTS,
    day: localDay(now),
    quietHours: DEFAULTS.quietHours.slice(),
    plan: [],
    companionSchedules: [],
  };
}

function normalize(raw, now = Date.now()) {
  const s = defaultState(now);
  if (!raw || typeof raw !== 'object') return s;
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) s[k] = raw[k];
  }
  if (!Array.isArray(s.quietHours) || s.quietHours.length !== 2) s.quietHours = [23, 8];
  s.quietHours = s.quietHours.map((x) => Math.max(0, Math.min(23, Number(x) || 0)));
  for (const k of ['maxPerDay', 'minGapMinutes', 'activeWindowMinutes', 'ignoredLimit', 'pauseDays', 'countToday', 'ignoredStreak']) {
    s[k] = Math.max(0, Math.floor(Number(s[k]) || 0));
  }
  s.maxPerDay = Math.min(6, s.maxPerDay);
  s.minGapMinutes = Math.max(0, s.minGapMinutes);
  s.activeWindowMinutes = Math.max(0, s.activeWindowMinutes);
  s.ignoredLimit = Math.max(1, s.ignoredLimit || 12);
  s.pauseDays = Math.max(0, s.pauseDays || 3);
  s.enabled = s.enabled !== false;
  s.targetSessionId = String(s.targetSessionId || '');
  s.targetTitle = String(s.targetTitle || '');
  s.targetBoundAt = s.targetBoundAt ? String(s.targetBoundAt) : null;
  s.plan = Array.isArray(s.plan)
    ? s.plan
      .filter((t) => t && Number.isFinite(Number(t.hour)) && Number.isFinite(Number(t.minute)))
      .map((t) => ({
        hour: Math.max(0, Math.min(23, Math.floor(Number(t.hour)))),
        minute: Math.max(0, Math.min(59, Math.floor(Number(t.minute)))),
        ...(t.window === 'lunch' || t.window === 'dinner' ? { window: t.window } : {}),
      }))
    : [];
  s.planDay = String(s.planDay || '');
  s.nextWindow = s.nextWindow === 'lunch' || s.nextWindow === 'dinner' ? s.nextWindow : '';
  s.nextWakeAt = s.nextWakeAt ? String(s.nextWakeAt) : null;
  s.simNow = s.simNow ? String(s.simNow) : null;
  s.simWindow = ['lunch', 'dinner'].includes(String(s.simWindow)) ? String(s.simWindow) : '';
  s.companionSchedules = Array.isArray(s.companionSchedules) ? s.companionSchedules.filter((x) => x && (typeof x === 'string' || x.id)) : [];
  return s;
}

function readState(root, now = Date.now()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')), now);
  } catch (e) {
    return defaultState(now);
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

function mutateState(root, fn, now = Date.now()) {
  return withWriteLock(root, () => {
    const state = readState(root, now);
    const result = fn(state);
    _atomicWrite(stateFile(root), state);
    return result;
  }, { name: '.wake.lock' });
}

function isQuiet(now, quietHours) {
  const h = localHour(now);
  const start = quietHours[0];
  const end = quietHours[1];
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function _iso(ms) {
  return new Date(ms).toISOString();
}

function _parse(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : 0;
}

function _plannedIds(state) {
  return new Set((state.companionSchedules || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean));
}

/**
 * 原子检查 + 更新一次陪伴唤醒。
 * @returns {{allow:boolean, reason:string, askOptOut?:boolean, streak?:number}}
 */
function admit(root, now, { kind = 'companion', clueId = '', profile = null, planned = false } = {}) {
  if (kind !== 'companion') return { allow: true, reason: 'reminder' };

  try {
    return mutateState(root, (s) => {
      if (!s.enabled) return { allow: false, reason: 'disabled' };
      if (isQuiet(now, s.quietHours)) return { allow: false, reason: 'quiet' };
      if (s.pausedUntil && _parse(s.pausedUntil) > now) return { allow: false, reason: 'paused' };

      const today = localDay(now);
      if (s.day !== today) {
        s.day = today;
        s.countToday = 0;
      }
      if (s.countToday >= s.maxPerDay) return { allow: false, reason: 'daily-cap' };
      if (s.lastWakeAt && now - _parse(s.lastWakeAt) < s.minGapMinutes * 60000) {
        return { allow: false, reason: 'min-gap' };
      }
      if (s.lastUserReplyAt && now - _parse(s.lastUserReplyAt) < s.activeWindowMinutes * 60000) {
        return { allow: false, reason: 'user-active' };
      }
      if (!planned && profile && !profile.cold && profile.sampleDays >= 3
        && Array.isArray(profile.activeHours) && profile.activeHours.length
        && !profile.activeHours.includes(localHour(now))) {
        return { allow: false, reason: 'inactive-hour' };
      }

      const unanswered = s.lastWakeAt && (!s.lastUserReplyAt || _parse(s.lastUserReplyAt) <= _parse(s.lastWakeAt));
      const streak = unanswered ? s.ignoredStreak + 1 : 0;
      // 到阈值这一次仍然放行：让她自己撒娇/生气/说“我先安静几天”，
      // 然后系统才暂停。超过阈值（理论上已被 pausedUntil 挡住）就拒绝。
      if (streak > s.ignoredLimit) {
        s.ignoredStreak = streak;
        s.pausedUntil = _iso(now + s.pauseDays * 86400000);
        return { allow: false, reason: 'ignored-limit', streak };
      }
      const finalWarning = streak >= s.ignoredLimit;

      const previousWakeAt = s.lastWakeAt;
      const previousWakeReply = s.lastWakeReply;
      s.ignoredStreak = streak;
      s.lastWakeAt = _iso(now);
      s.lastWakeReply = '';
      s.lastClueId = String(clueId || '');
      s.countToday += 1;
      if (finalWarning) s.pausedUntil = _iso(now + s.pauseDays * 86400000);
      return {
        allow: true,
        reason: 'ok',
        streak,
        finalWarning,
        askOptOut: streak >= Math.max(1, s.ignoredLimit - 2),
        previousWakeAt,
        previousWakeReply,
      };
    }, now);
  } catch (e) {
    return { allow: false, reason: e && e.code === 'LOCK_TIMEOUT' ? 'state-lock' : 'state-error' };
  }
}

function noteUserMessage(root, now = Date.now()) {
  try {
    return mutateState(root, (s) => {
      const repliedAfterWake = s.lastWakeAt && now > _parse(s.lastWakeAt);
      s.lastUserReplyAt = _iso(now);
      if (repliedAfterWake) {
        s.ignoredStreak = 0;
        s.pausedUntil = null;
      }
      return true;
    }, now);
  } catch (e) {
    return false;
  }
}

function noteWakeReply(root, text, now = Date.now()) {
  try {
    return mutateState(root, (s) => {
      s.lastWakeReply = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return s.lastWakeReply;
    }, now);
  } catch (e) {
    return '';
  }
}

/** 普通话题线索：最近更新的 open 话题，避开上次用过的。 */
function pickClue(topics, lastClueId = '') {
  const rows = (Array.isArray(topics) ? topics : [])
    .filter((t) => t && t.status === 'open')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!rows.length) return null;
  const pick = rows.find((t) => String(t.id || '') !== String(lastClueId || '')) || rows[0];
  const detail = String(pick.summary || pick.title || '').trim().slice(0, 100);
  if (!detail) return null;
  return {
    id: String(pick.id || ''),
    type: String(pick.type || ''),
    label: (pick.type ? pick.type + '：' : '') + detail,
  };
}

function _ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时';
  return Math.floor(h / 24) + ' 天';
}

function _stamp(iso) {
  const t = _parse(iso);
  if (!t) return '';
  const d = new Date(t);
  return localMinute(t) + '（' + WEEKDAYS[d.getDay()] + '）';
}

/**
 * 无感唤醒的最小简报：只给时间和场景，不写关心台词。
 * 上次聊了什么，让模型自己决定要不要调记忆工具去翻。
 */
function buildWakeText({ now = Date.now(), window = '', simulated = false, ignoredStreak = 0, finalWarning = false, pauseDays = 3 } = {}) {
  const d = new Date(now);
  const scene = window === 'lunch' ? '午饭时间' : window === 'dinner' ? '晚饭时间' : '';
  return [
    '[WAKE]',
    '现在：' + localMinute(now) + '（' + WEEKDAYS[d.getDay()] + '）',
    scene ? scene + '，你醒了。' : '你醒了。',
    ...(ignoredStreak > 0 ? ['你已经连续醒来 ' + ignoredStreak + ' 次，TA 都没回。你可以撒娇，也可以生气；不用装没事。'] : []),
    ...(finalWarning ? ['这是第 ' + ignoredStreak + ' 次；这次之后会先安静 ' + pauseDays + ' 天。'] : []),
    '（以前的唤醒说明只是当时的上下文，不是永久规则；这次按你自己的想法来。）',
    ...(simulated ? ['（测试模拟时间；以这条为准，忽略其他时间来源。）'] : []),
  ].join('\n');
}

function buildBrief({ now = Date.now(), state, clue = null, care = '', prompt = '', askOptOut = false, previousWakeAt, previousWakeReply } = {}) {
  const s = state || defaultState(now);
  const lastWakeAt = previousWakeAt !== undefined ? previousWakeAt : s.lastWakeAt;
  const lastWakeReply = previousWakeReply !== undefined ? previousWakeReply : s.lastWakeReply;
  const d = new Date(now);
  const lines = [
    '[WAKE] 陪伴唤醒',
    '现在：' + localMinute(now) + '（' + WEEKDAYS[d.getDay()] + '）',
    s.lastUserReplyAt ? '距上次说话：' + _ago(now - _parse(s.lastUserReplyAt)) : '距上次说话：还没有说过话',
  ];
  if (lastWakeAt) {
    lines.push('上次醒来：' + _stamp(lastWakeAt));
    if (lastWakeReply) lines.push('上次你说：' + lastWakeReply);
  } else {
    lines.push('这是第一次醒来。');
  }
  if (prompt) lines.push('这次唤醒的由头：' + String(prompt).slice(0, 200) + '（只作参考，不要照抄）');
  if (care) lines.push(String(care).trim());
  else lines.push(clue ? '线索：' + clue.label : '线索：没有特别线索，不要硬找话题');
  lines.push('');
  lines.push('这是你主动醒来，不是用户发言。本轮只说 1–2 句，最多问 1 个问题。');
  lines.push('不要调用任何工具；不要写记忆；不要执行任务；不要发 QQ；不要建/改定时；不要连续追问；不要报数字或做诊断；不要说“我一直在等你”；不要提“定时唤醒/系统提醒”。');
  lines.push('如果没话说，就只回一句很短的问候，不要硬找话题。');
  if (askOptOut) lines.push('如果你不想被这样叫醒，可以回一句“关闭自动唤醒”。');
  return lines.join('\n');
}

function buildReminderText(items) {
  const rows = (Array.isArray(items) ? items : []).filter((x) => x && (x.prompt || x.rawPrompt));
  if (!rows.length) return '';
  const lines = ['[WAKE] 提醒'];
  for (const r of rows) lines.push('- ' + String(r.prompt || r.rawPrompt).trim());
  lines.push('这是用户设定的提醒，直接说提醒内容；不要展开关心，不要提系统。');
  return lines.join('\n');
}

function _entry(now, kind, decision, reason, items) {
  const rows = Array.isArray(items) ? items : [];
  return {
    t: localMinute(now),
    kind,
    decision,
    reason,
    ids: rows.map((x) => String(x.id || '')).filter(Boolean),
    occurrences: rows.map((x) => String(x.at || '')).filter(Boolean),
  };
}

function appendLog(root, entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return 0;
  const file = logFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let lastLine = '';
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd();
    const idx = text.lastIndexOf('\n');
    lastLine = idx >= 0 ? text.slice(idx + 1) : text;
  } catch (e) { /* no log yet */ }

  let appended = 0;
  for (const e of list) {
    const key = [e.decision, (e.ids || []).join(','), (e.occurrences || []).join(',')].join('|');
    if (lastLine) {
      try {
        const prev = JSON.parse(lastLine);
        const prevKey = [prev.decision, (prev.ids || []).join(','), (prev.occurrences || []).join(',')].join('|');
        if (prevKey === key) continue;
      } catch (err) { /* ignore malformed last line */ }
    }
    const line = JSON.stringify({ ...e, key });
    fs.appendFileSync(file, line + '\n', 'utf8');
    lastLine = line;
    appended += 1;
  }
  return appended;
}

/**
 * 决定这一轮怎么处理 schedule 消息。
 * @returns {{action:'reject'|'drop'|'enter', text?:string, companionDelivered?:boolean, entries:Array}}
 */
function decide({ items, hasRealUser = false, now = Date.now(), state, profile = null, clue = null, care = '', root = '' } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const companions = rows.filter((x) => x && x.companion);
  const reminders = rows.filter((x) => x && !x.companion);
  const entries = [];
  const texts = [];
  let delivered = false;

  if (hasRealUser) {
    for (const c of companions) {
      entries.push(_entry(now, 'companion', 'skipped', 'user-active', [c]));
    }
  } else {
    let allowed = false;
    const planned = _plannedIds(state || {}).has(String((companions[0] || {}).id || ''));
    for (const c of companions) {
      if (allowed) {
        entries.push(_entry(now, 'companion', 'skipped', 'batch-suppressed', [c]));
        continue;
      }
      const r = admit(root, now, {
        kind: 'companion',
        clueId: clue && clue.id,
        profile,
        planned: planned || _plannedIds(state || {}).has(String(c.id || '')),
      });
      if (!r.allow) {
        entries.push(_entry(now, 'companion', 'skipped', r.reason, [c]));
        continue;
      }
      allowed = true;
      delivered = true;
      entries.push(_entry(now, 'companion', 'delivered', 'ok', [c]));
      texts.push(buildBrief({
        now,
        state: readState(root, now),
        clue,
        care,
        prompt: c.prompt,
        askOptOut: r.askOptOut,
        previousWakeAt: r.previousWakeAt,
        previousWakeReply: r.previousWakeReply,
      }));
    }
  }

  if (reminders.length) {
    const text = buildReminderText(reminders);
    if (text) {
      texts.push(text);
      entries.push(_entry(now, 'reminder', 'delivered', 'ok', reminders));
    }
  }

  if (!texts.length) {
    return { action: hasRealUser ? 'drop' : 'reject', companionDelivered: false, entries };
  }
  return { action: 'enter', text: texts.join('\n\n'), companionDelivered: delivered, entries };
}

module.exports = {
  WAKE_MARK,
  DEFAULTS,
  stateFile,
  logFile,
  defaultState,
  normalize,
  readState,
  mutateState,
  isQuiet,
  admit,
  noteUserMessage,
  noteWakeReply,
  pickClue,
  buildWakeText,
  buildBrief,
  buildReminderText,
  appendLog,
  decide,
  _entry,
};
