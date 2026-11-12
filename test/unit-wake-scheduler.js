/**
 * unit-wake-scheduler.js — 4 次/天、最小 45 分钟的排程
 */
const { pickTimes, pickPlan, cronFor, formatTime, nextEntry, nextOccurrence, DEFAULT_TIMES, MEAL_WINDOWS } = require('../src/wake_scheduler');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const mins = (t) => t.hour * 60 + t.minute;
const gapsOk = (times, gap = 45) => times.every((t, i) => i === 0 || mins(t) - mins(times[i - 1]) >= gap);

// 1. 冷启动：4 个默认时间
const cold = pickTimes({ cold: true, activeHours: [], byHour: new Array(24).fill(0), sampleDays: 0 });
check('冷启动 4 个', cold.length === 4, JSON.stringify(cold));
check('冷启动默认 09/13/17/21', cold.map(formatTime).join(',') === '09:00,13:00,17:00,21:00');
check('默认也满足 45 分钟', gapsOk(cold));

// 2. 宽活跃窗口：4 个、间隔 >=45、都在 8-23
const broad = pickTimes({
  cold: false,
  sampleDays: 10,
  activeHours: [9, 10, 11, 13, 14, 17, 18, 20, 21, 22],
  byHour: new Array(24).fill(0).map((_, h) => ([9, 10, 11, 13, 14, 17, 18, 20, 21, 22].includes(h) ? 10 : 0)),
}, Date.now(), { count: 4, minGapMinutes: 45 });
check('宽窗口 4 个', broad.length === 4, JSON.stringify(broad));
check('宽窗口间隔 >=45', gapsOk(broad), JSON.stringify(broad));
check('宽窗口不越界', broad.every((t) => t.hour >= 8 && t.hour <= 22));

// 3. 窄窗口：20-22 点也能排 4 个，且不越过 23:00
const narrow = pickTimes({
  cold: false,
  sampleDays: 7,
  activeHours: [20, 21, 22],
  byHour: new Array(24).fill(0).map((_, h) => (h === 20 ? 100 : h === 21 ? 10 : h === 22 ? 10 : 0)),
}, Date.now(), { count: 4, minGapMinutes: 45 });
check('窄窗口 4 个', narrow.length === 4, JSON.stringify(narrow));
check('窄窗口间隔 >=45', gapsOk(narrow), JSON.stringify(narrow));
check('窄窗口不越 23:00', narrow.every((t) => t.hour < 23));
check('窄窗口优先 20 点', narrow.filter((t) => t.hour === 20).length >= 2, JSON.stringify(narrow));

// 4. 只有深夜活跃：不混合 22:00 + 09:00，直接默认
const lateOnly = pickTimes({
  cold: false,
  sampleDays: 5,
  activeHours: [0, 1, 2, 22],
  byHour: new Array(24).fill(0).map((_, h) => ([0, 1, 2, 22].includes(h) ? 10 : 0)),
}, Date.now(), { count: 4, minGapMinutes: 45 });
check('只有深夜活跃 -> 默认 4 个', lateOnly.map(formatTime).join(',') === '09:00,13:00,17:00,21:00', JSON.stringify(lateOnly));

// 5. 只有一个活跃小时：默认时间补齐，仍然满足间隔
const tiny = pickTimes({
  cold: false,
  sampleDays: 5,
  activeHours: [20],
  byHour: new Array(24).fill(0).map((_, h) => (h === 20 ? 100 : 0)),
}, Date.now(), { count: 4, minGapMinutes: 45 });
check('单小时也能出 4 个', tiny.length === 4, JSON.stringify(tiny));
check('单小时也满足 45 分钟', gapsOk(tiny), JSON.stringify(tiny));

// 6. cron / 格式
check('cron 非整点', cronFor({ hour: 13, minute: 40 }) === '40 13 * * *');
check('formatTime', formatTime({ hour: 9, minute: 5 }) === '09:05');
check('默认时间表 4 个', DEFAULT_TIMES.length === 4);

// 7. nextOccurrence：本地墙钟、跨天、刚好到点
const at = (h, m = 0, day = 12) => new Date(2026, 10, day, h, m, 0, 0).getTime();
const times = [{ hour: 21, minute: 0 }, { hour: 9, minute: 0 }, { hour: 13, minute: 0 }, { hour: 17, minute: 0 }];
const n1 = nextOccurrence(times, at(10));
check('10:00 下一次是今天 13:00', n1 === at(13), new Date(n1).toString());
const n2 = nextOccurrence(times, at(22));
check('22:00 下一次是明天 09:00', n2 === at(9, 0, 13), new Date(n2).toString());
const n3 = nextOccurrence(times, at(8));
check('08:00 下一次是今天 09:00', n3 === at(9), new Date(n3).toString());
const n4 = nextOccurrence(times, at(13));
check('刚好 13:00 不重复今天，下一次 17:00', n4 === at(17), new Date(n4).toString());
check('空数组返回 null', nextOccurrence([], at(10)) === null);
check('单点已过 -> 明天', nextOccurrence([{ hour: 9, minute: 0 }], at(10)) === at(9, 0, 13));
check('不修改入参', times[0].hour === 21 && times[1].hour === 9);

// 8. 一天完整排程：4 次日常 + 午饭/晚饭各一次
const planProfile = {
  cold: false,
  sampleDays: 10,
  activeHours: [9, 10, 11, 13, 14, 17, 18, 20, 21, 22],
  byHour: new Array(24).fill(0).map((_, h) => ([9, 10, 11, 13, 14, 17, 18, 20, 21, 22].includes(h) ? 10 : 0)),
};
const dayPlan = pickPlan(planProfile, at(10), { generalCount: 4, minGapMinutes: 45, rng: () => 0.5 });
check('一天 6 次', dayPlan.length === 6, JSON.stringify(dayPlan));
check('两顿饭都有', dayPlan.filter((t) => t.window === 'lunch').length === 1 && dayPlan.filter((t) => t.window === 'dinner').length === 1);
const lunch = dayPlan.find((t) => t.window === 'lunch');
const dinner = dayPlan.find((t) => t.window === 'dinner');
const lunchMin = lunch.hour * 60 + lunch.minute;
const dinnerMin = dinner.hour * 60 + dinner.minute;
check('午饭在窗口内', lunchMin >= MEAL_WINDOWS.lunch[0] && lunchMin < MEAL_WINDOWS.lunch[1], lunchMin);
check('晚饭在窗口内', dinnerMin >= MEAL_WINDOWS.dinner[0] && dinnerMin < MEAL_WINDOWS.dinner[1], dinnerMin);
check('全天间隔 >=45', gapsOk(dayPlan), JSON.stringify(dayPlan));
check('nextEntry 带 window', !!nextEntry(dayPlan, at(10)).entry);
check('可关闭吃饭窗口', pickPlan(planProfile, at(10), { generalCount: 4, meals: false }).length === 4);

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
