/**
 * time.js — 本地时间格式（不要用 toISOString 截断）
 *
 * `new Date().toISOString()` 是 UTC；直接 slice(0,16) 会把 UTC 当本地时间存，
 * UTC+8 会慢 8 小时。这里统一用本地 getter。
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function localMinute(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMonth(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function localHour(ts = Date.now()) {
  return new Date(ts).getHours();
}

module.exports = { localMinute, localDay, localMonth, localHour };
