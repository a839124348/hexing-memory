/**
 * unit-wake-care.js — 7 天曲线：late / quiet / shift / 样本不足 / 冷却
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDay } = require('../src/time');
const care = require('../src/wake_care');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const now = Date.now();
const day = (n) => localDay(now - n * 86400000);

function makeDays(from, to, hour, perDay, late = 0) {
  const out = {};
  for (let n = from; n >= to; n--) {
    const arr = new Array(24).fill(0);
    arr[hour] += perDay;
    if (late) arr[1] += late;
    out[day(n)] = arr;
  }
  return out;
}

// 1. late：最近 7 天 1 点发言明显变多
const lateProfile = {
  days: {
    ...makeDays(14, 8, 20, 10, 0),
    ...makeDays(7, 1, 20, 8, 2),
  },
};
const late = care.analyze(lateProfile, now);
check('识别 late', late && late.observation === 'late', JSON.stringify(late && late.observation));
check('有 weekStart', late && /^\d{4}-\d{2}-\d{2}$/.test(late.weekStart));

// 2. quiet：最近 7 天总量减半
const quietProfile = {
  days: {
    ...makeDays(14, 8, 20, 10, 0),
    ...makeDays(7, 1, 20, 3, 0),
  },
};
const quiet = care.analyze(quietProfile, now);
check('识别 quiet', quiet && quiet.observation === 'quiet', JSON.stringify(quiet && quiet.observation));

// 3. shift：活动重心后移 2 小时
const shiftProfile = {
  days: {
    ...makeDays(14, 8, 20, 10, 0),
    ...makeDays(7, 1, 22, 10, 0),
  },
};
const shift = care.analyze(shiftProfile, now);
check('识别 shift-later', shift && shift.observation === 'shift-later', JSON.stringify(shift && shift.observation));

// 4. 样本不足
const thinProfile = {
  days: {
    ...makeDays(14, 11, 20, 10, 0),
    ...makeDays(7, 4, 20, 10, 0),
  },
};
check('样本不足返回 null', care.analyze(thinProfile, now) === null);

// 5. 证据：最近 14 天 open 话题
const topics = [
  { id: 'old', status: 'open', updatedAt: new Date(now - 30 * 86400000).toISOString(), type: '项目', title: '旧话题' },
  { id: 'new', status: 'open', updatedAt: new Date(now - 86400000).toISOString(), type: '项目', title: '核星记忆', summary: 'v0.4.5 发布' },
  { id: 'closed', status: 'closed', updatedAt: new Date(now - 86400000).toISOString(), type: '项目', title: '已关闭' },
];
const ev = care.pickEvidence(topics, now);
check('选最近 open 话题', ev && ev.id === 'new', JSON.stringify(ev));
const line = care.careLine('late', ev);
check('关心行含观察', line.includes('这周你说话的时间比上周晚了一些'));
check('关心行含线索', line.includes('核星记忆') && line.includes('v0.4.5'));
check('关心行不报数字', line.includes('不要报数字') && !/\d+\s*条/.test(line));

// 6. 冷却
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-care-'));
check('首次可关心', care.shouldCare(root, now) === true);
care.markCare(root, {
  weekStart: late.weekStart,
  observation: 'late',
  evidence: '项目：核星记忆',
  at: now,
});
check('7 天内不重复', care.shouldCare(root, now) === false);
check('历史落盘', care.readCare(root).history.length === 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
