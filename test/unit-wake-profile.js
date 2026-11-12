/**
 * unit-wake-profile.js — 作息记录器：回填、实时计数、汇总、30 天清理
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDay, localHour } = require('../src/time');
const profile = require('../src/wake_profile');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-profile-'));
const now = Date.now();
const today = localDay(now);
const yesterday = localDay(now - 86400000);
const twoDaysAgo = localDay(now - 2 * 86400000);
const threeDaysAgo = localDay(now - 3 * 86400000);

// 1. 回填：只数 human，跳过今天
fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
const rawFile = path.join(root, 'raw', yesterday + '.jsonl');
fs.writeFileSync(rawFile, [
  JSON.stringify({ t: yesterday + ' 10:30', type: 'human', c: '真人 1' }),
  JSON.stringify({ t: yesterday + ' 10:45', type: 'human', c: '真人 2' }),
  JSON.stringify({ t: yesterday + ' 11:00', type: 'ai', c: 'AI 回复' }),
  JSON.stringify({ t: yesterday + ' 23:10', origin: 'human', c: '真人 3' }),
].join('\n'), 'utf8');

const bf = profile.backfillFromRaw(root, now, 30);
check('回填了 1 天', bf.filled === 1, JSON.stringify(bf));
let p = profile.readProfile(root);
check('回填 10 点 2 条', p.days[yesterday][10] === 2, JSON.stringify(p.days[yesterday]));
check('回填 23 点 1 条', p.days[yesterday][23] === 1);
check('AI 回复不计入', p.days[yesterday][11] === 0);
check('今天不在回填里', !p.days[today]);

// 2. 回填不覆盖已有日期
profile.noteActivity(root, new Date(yesterday + 'T10:00:00').getTime());
p = profile.readProfile(root);
check('实时写入给昨天 10 点 +1', p.days[yesterday][10] === 3);
const bf2 = profile.backfillFromRaw(root, now, 30);
check('再次回填不覆盖', bf2.filled === 0 && profile.readProfile(root).days[yesterday][10] === 3);

// 3. 实时计数：今天
const before = profile.readProfile(root).days[today] ? profile.readProfile(root).days[today][localHour(now)] : 0;
profile.noteActivity(root, now);
p = profile.readProfile(root);
check('今天当前小时 +1', p.days[today][localHour(now)] === before + 1, JSON.stringify(p.days[today]));

// 4. 汇总：样本天数 / 活跃小时 / 冷启动
profile.noteActivity(root, new Date(today + 'T09:00:00').getTime());
profile.noteActivity(root, new Date(twoDaysAgo + 'T10:00:00').getTime());
profile.noteActivity(root, new Date(threeDaysAgo + 'T10:00:00').getTime());
const sum = profile.summary(root, now, 14);
check('样本天数 >= 3', sum.sampleDays >= 3, 'sampleDays=' + sum.sampleDays);
check('冷启动关闭', sum.cold === false);
check('活跃小时含 10', sum.activeHours.includes(10), JSON.stringify(sum.activeHours));
check('总量 > 0', sum.total > 0);

// 5. 30 天清理
const oldDay = localDay(now - 40 * 86400000);
profile.noteActivity(root, new Date(oldDay + 'T10:00:00').getTime());
profile.noteActivity(root, now);
p = profile.readProfile(root);
check('40 天前的桶被清掉', !p.days[oldDay], Object.keys(p.days).join(','));

// 6. 缺文件时默认值
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-profile-empty-'));
const empty = profile.summary(emptyRoot, now);
check('缺文件 sampleDays=0', empty.sampleDays === 0);
check('缺文件 cold=true', empty.cold === true);
check('缺文件 total=0', empty.total === 0);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(emptyRoot, { recursive: true, force: true });
console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
