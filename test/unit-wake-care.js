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

// 7. response 回填（2026-11-14 补）：关心之后用户回话 → replied；超 24h → ignored
{
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'care-resp-'));
  care.markCare(r2, { weekStart: 'w1', observation: 'quiet', evidence: 'x', at: now });
  const f1 = care.noteCareReply(r2, now + 30 * 60000);
  check('24h 内回话 → 回填 replied', f1.filled === 0, JSON.stringify(f1));
  const row1 = care.readCare(r2).history[0];
  check('记了回复时刻与间隔', row1.response === 'replied' && row1.repliedAt && row1.replyGapMin === 30, JSON.stringify(row1));
  check('已填过的不重复填', care.noteCareReply(r2, now + 40 * 60000).filled === -1);
  fs.rmSync(r2, { recursive: true, force: true });

  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'care-miss-'));
  care.markCare(r3, { weekStart: 'w2', observation: 'late', evidence: 'y', at: now });
  check('超过 24h 不追认', care.noteCareReply(r3, now + 30 * 3600000).filled === -1);
  check('超时那条仍是空', care.readCare(r3).history[0].response === '');
  care.markCare(r3, { weekStart: 'w3', observation: 'quiet', evidence: 'z', at: now + 31 * 3600000 });
  const h3 = care.readCare(r3).history;
  check('下次落账时标 ignored', h3[0].response === 'ignored', h3[0].response);
  check('新的一条仍是空', h3[1].response === '', h3[1].response);
  fs.rmSync(r3, { recursive: true, force: true });
}
// 8. 回复开头 + 线索重合（2026-11-14）
{
  check('词面碰上线索', care.mentionsEvidence('补链还没弄完，晚点说', '项目：旧历史补链') === true);
  check('词面没碰上', care.mentionsEvidence('今天吃什么', '项目：旧历史补链') === false);
  check('类型前缀不参与匹配', care.mentionsEvidence('我在做项目', '项目：旧历史补链') === false);

  const r4 = fs.mkdtempSync(path.join(os.tmpdir(), 'care-head-'));
  care.markCare(r4, { weekStart: 'w4', observation: 'quiet', evidence: '项目：旧历史补链', at: now });
  const g = care.noteCareReply(r4, now + 10 * 60000, 24, { text: '补链还没弄完，\n晚点说' });
  const row4 = care.readCare(r4).history[0];
  check('回填写了回复开头', row4.replyHead === '补链还没弄完， 晚点说', JSON.stringify(row4.replyHead));
  check('回填写了词面命中', row4.replyOnEvidence === true, row4.replyOnEvidence);
  check('回填返回带开头', g.replyHead === '补链还没弄完， 晚点说' && g.onEvidence === true, JSON.stringify(g));
  fs.rmSync(r4, { recursive: true, force: true });

  const r5 = fs.mkdtempSync(path.join(os.tmpdir(), 'care-head2-'));
  care.markCare(r5, { weekStart: 'w5', observation: 'late', evidence: '日常：天气转凉', at: now });
  care.noteCareReply(r5, now + 5 * 60000, 24, { text: '今天吃什么' });
  const row5 = care.readCare(r5).history[0];
  check('换了话题 → 词面不命中', row5.replyHead === '今天吃什么' && row5.replyOnEvidence === false, JSON.stringify(row5));
  fs.rmSync(r5, { recursive: true, force: true });

  const r6 = fs.mkdtempSync(path.join(os.tmpdir(), 'care-head3-'));
  care.markCare(r6, { weekStart: 'w6', observation: 'quiet', evidence: '关系：搬新家', at: now });
  care.noteCareReply(r6, now + 5 * 60000);
  const row6 = care.readCare(r6).history[0];
  check('不给正文就不写开头字段', row6.response === 'replied' && row6.replyHead === undefined, JSON.stringify(row6));
  fs.rmSync(r6, { recursive: true, force: true });
}
console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
