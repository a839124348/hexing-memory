/**
 * unit-wake.js — 自动唤醒策略（安静时段/间隔/上限/活跃/连续无回应/简报/日志）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const wake = require('../src/wake');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));
const at = (h, m = 0) => new Date(2026, 10, 11, h, m, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

function setState(patch) {
  wake.mutateState(root, (s) => {
    Object.assign(s, patch);
  }, at(9));
}
function reset() {
  try { fs.rmSync(wake.stateFile(root), { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(wake.logFile(root), { force: true }); } catch (e) { /* ignore */ }
}

// 1. 默认值
const d = wake.readState(root, at(9));
check('默认 6 次/天', d.maxPerDay === 6);
check('默认 45 分钟', d.minGapMinutes === 45);
check('默认不因用户刚说话跳过', d.activeWindowMinutes === 0);
check('默认连续 12 次无回应才暂停', d.ignoredLimit === 12);
check('默认安静 23-08', d.quietHours[0] === 23 && d.quietHours[1] === 8);
check('默认启用', d.enabled === true);
check('默认没有绑定会话', d.targetSessionId === '');
check('默认没有排程', Array.isArray(d.plan) && d.plan.length === 0);
check('默认没有 nextWakeAt', d.nextWakeAt === null);
check('默认没有 planDay', d.planDay === '');
check('默认没有 nextWindow', d.nextWindow === '');

// 2. 安静时段边界
check('23:00 安静', wake.isQuiet(at(23), [23, 8]) === true);
check('22:59 不安静', wake.isQuiet(at(22, 59), [23, 8]) === false);
check('07:59 安静', wake.isQuiet(at(7, 59), [23, 8]) === true);
check('08:00 不安静', wake.isQuiet(at(8), [23, 8]) === false);

// 3. 普通提醒不受限
reset();
const reminder = wake.admit(root, at(23, 30), { kind: 'reminder' });
check('普通提醒半夜也放行', reminder.allow === true && reminder.reason === 'reminder');

// 4. 陪伴唤醒：安静时段拒绝
reset();
const quiet = wake.admit(root, at(23, 30), { kind: 'companion' });
check('陪伴唤醒安静时段拒绝', quiet.allow === false && quiet.reason === 'quiet');

// 5. 45 分钟最小间隔
reset();
const first = wake.admit(root, at(10), { kind: 'companion' });
check('首次放行', first.allow === true, JSON.stringify(first));
const tooSoon = wake.admit(root, at(10, 30), { kind: 'companion' });
check('30 分钟后拒绝', tooSoon.allow === false && tooSoon.reason === 'min-gap');
const okGap = wake.admit(root, at(10, 45), { kind: 'companion' });
check('45 分钟后放行', okGap.allow === true, JSON.stringify(okGap));

// 6. 用户刚说话：显式开启 30 分钟窗口时才跳过（默认已关闭）
reset();
setState({ activeWindowMinutes: 30 });
wake.admit(root, at(10), { kind: 'companion' });
wake.noteUserMessage(root, at(10, 40));
// 11:00 距上次唤醒 60 分钟（过 45 分钟间隔），距用户发言 20 分钟（在活跃窗口内）
const active = wake.admit(root, at(11), { kind: 'companion' });
check('用户 20 分钟前说话，跳过', active.allow === false && active.reason === 'user-active', JSON.stringify(active));
// 11:15 距用户发言 35 分钟（超过 30 分钟活跃窗口）
const afterWindow = wake.admit(root, at(11, 15), { kind: 'companion' });
check('用户 35 分钟前说话，放行', afterWindow.allow === true, JSON.stringify(afterWindow));

// 7. 每日上限
reset();
setState({ maxPerDay: 1, minGapMinutes: 0, activeWindowMinutes: 0 });
const one = wake.admit(root, at(10), { kind: 'companion' });
const two = wake.admit(root, at(11), { kind: 'companion' });
check('第 1 次放行', one.allow === true);
check('第 2 次 daily-cap', two.allow === false && two.reason === 'daily-cap');

// 8. 不活跃小时：planned 跳过检查
reset();
setState({ maxPerDay: 6, minGapMinutes: 0, activeWindowMinutes: 0 });
const profile = { cold: false, sampleDays: 5, activeHours: [10], byHour: new Array(24).fill(0), total: 10 };
const inactive = wake.admit(root, at(14), { kind: 'companion', profile, planned: false });
check('14 点不在活跃小时，拒绝', inactive.allow === false && inactive.reason === 'inactive-hour');
const planned = wake.admit(root, at(14), { kind: 'companion', profile, planned: true });
check('planned 跳过不活跃检查', planned.allow === true, JSON.stringify(planned));

// 9. 连续无回应：第 3 次是最后一句（可以撒娇/生气），放行后暂停；第 4 次才拒绝
reset();
setState({
  maxPerDay: 6, minGapMinutes: 0, activeWindowMinutes: 0, ignoredLimit: 3,
  ignoredStreak: 1, lastWakeAt: iso(at(9)), lastUserReplyAt: null, countToday: 2,
});
const streak2 = wake.admit(root, at(10), { kind: 'companion' });
check('连续第 2 次放行', streak2.allow === true && streak2.streak === 2, JSON.stringify(streak2));
check('第 2 次给关闭提示', streak2.askOptOut === true);
const streak3 = wake.admit(root, at(11), { kind: 'companion' });
check('连续第 3 次放行（最后一句）', streak3.allow === true && streak3.finalWarning === true, JSON.stringify(streak3));
const st = wake.readState(root);
check('暂停时间已写入', !!st.pausedUntil);
const streak4 = wake.admit(root, at(12), { kind: 'companion' });
check('第 4 次被暂停', streak4.allow === false && streak4.reason === 'paused', JSON.stringify(streak4));
const finalBrief = wake.buildWakeText({ now: at(11), ignoredStreak: 3, finalWarning: true, pauseDays: 3 });
check('最后一句包含连续次数', finalBrief.includes('连续醒来 3 次'));
check('允许撒娇/生气', finalBrief.includes('可以撒娇，也可以生气'));
check('最后一句包含暂停', finalBrief.includes('先安静 3 天'));

wake.noteUserMessage(root, at(11, 30));
const st2 = wake.readState(root);
check('用户回话解除暂停', st2.pausedUntil === null && st2.ignoredStreak === 0);
const afterReply = wake.admit(root, at(12, 30), { kind: 'companion' });
check('回话后重新放行', afterReply.allow === true && afterReply.streak === 0, JSON.stringify(afterReply));

// 10. 简报里的“上次醒来”必须是上一次，不是刚刚这次
reset();
const firstWake = wake.admit(root, at(10), { kind: 'companion' });
check('第一次没有上次醒来', firstWake.previousWakeAt === null, JSON.stringify(firstWake));
const firstAt = wake.readState(root).lastWakeAt;
wake.noteWakeReply(root, '第一次说的话');
const secondWake = wake.admit(root, at(11), { kind: 'companion' });
check('第二次带回上次醒来时间', secondWake.previousWakeAt === firstAt, JSON.stringify(secondWake));
check('第二次带回上次说的话', secondWake.previousWakeReply === '第一次说的话');
const prevBrief = wake.buildBrief({
  now: at(11),
  state: wake.readState(root),
  previousWakeAt: secondWake.previousWakeAt,
  previousWakeReply: secondWake.previousWakeReply,
});
check('简报不是第一次醒来', !prevBrief.includes('这是第一次醒来'));
check('简报含上次醒来', prevBrief.includes('上次醒来：'));
check('简报含上次你说', prevBrief.includes('上次你说：第一次说的话'));

// 11. 无感最小简报：只给时间场景，不写关心台词
const lunch = wake.buildWakeText({ now: at(12), window: 'lunch' });
check('午饭简报只有时间+场景', lunch.includes('午饭时间，你醒了。'));
check('午饭简报不带关心台词', !lunch.includes('吃了没有') && !lunch.includes('麻辣烫'));
check('午饭简报不带限制', !lunch.includes('1–2 句') && !lunch.includes('不要调用'));
check('简报声明旧规则作废', lunch.includes('以前的唤醒说明'));
const general = wake.buildWakeText({ now: at(15) });
check('日常简报只说你醒了', general.includes('你醒了。') && !general.includes('午饭时间'));
const sim = wake.buildWakeText({ now: at(15), simulated: true });
check('模拟简报声明以这条为准', sim.includes('测试模拟时间') && sim.includes('忽略其他时间'));

// 12. 简报 / 提醒文本
reset();
const state = wake.readState(root, at(10));
const brief = wake.buildBrief({
  now: at(10), state, clue: { id: 't1', label: '项目：核星' }, prompt: '关心一下她', askOptOut: true,
});
check('简报有 [WAKE]', brief.startsWith('[WAKE] 陪伴唤醒'));
check('简报有工具禁用', brief.includes('不要调用任何工具'));
check('简报有 1–2 句', brief.includes('1–2 句'));
check('简报有最多 1 问', brief.includes('最多问 1 个问题'));
check('简报有线索', brief.includes('项目：核星'));
check('简报有关闭提示', brief.includes('关闭自动唤醒'));
check('简报不提系统定时', brief.includes('不要提“定时唤醒/系统提醒”'));

const reminderText = wake.buildReminderText([{ id: 'r1', prompt: '喝水', rawPrompt: '喝水' }]);
check('提醒文本有 [WAKE]', reminderText.startsWith('[WAKE] 提醒'));
check('提醒文本保留原文', reminderText.includes('喝水'));
check('提醒文本不套陪伴限制', !reminderText.includes('不要调用任何工具'));

// 13. decide：安静拒绝 / 提醒放行 / 用户正在说话
reset();
const quietDecide = wake.decide({
  items: [{ id: 'c1', at: '', prompt: '关心', companion: true }],
  now: at(23, 30), state: wake.readState(root), root,
});
check('decide 安静 -> reject', quietDecide.action === 'reject');
check('decide 记录 quiet', quietDecide.entries.some((x) => x.reason === 'quiet'));

reset();
const reminderDecide = wake.decide({
  items: [{ id: 'r1', at: '', prompt: '喝水', companion: false }],
  now: at(23, 30), state: wake.readState(root), root,
});
check('decide 提醒 -> enter', reminderDecide.action === 'enter' && reminderDecide.text.includes('喝水'));

reset();
const activeDecide = wake.decide({
  items: [{ id: 'c1', at: '', prompt: '关心', companion: true }],
  hasRealUser: true, now: at(10), state: wake.readState(root), root,
});
check('decide 用户正在说话 -> drop', activeDecide.action === 'drop');
check('decide 记录 user-active', activeDecide.entries.some((x) => x.reason === 'user-active'));

// 14. 日志：不含正文、同键去重
reset();
const e = wake._entry(at(10), 'companion', 'skipped', 'quiet', [{ id: 's1', at: '2026-11-11T02:00:00Z', prompt: '关心正文' }]);
wake.appendLog(root, [e]);
wake.appendLog(root, [e]);
const logText = fs.readFileSync(wake.logFile(root), 'utf8').trim().split(/\r?\n/);
check('日志只写 1 条', logText.length === 1, 'lines=' + logText.length);
check('日志不含 prompt 正文', !logText[0].includes('关心正文'));
check('日志含 schedule id', logText[0].includes('s1'));

// 15. 最近一条唤醒回复
reset();
wake.noteWakeReply(root, '  在呢，今天怎么样？  ');
check('回复被 trim + 保存', wake.readState(root).lastWakeReply === '在呢，今天怎么样？');
wake.noteWakeReply(root, 'x'.repeat(300));
check('回复截到 200', wake.readState(root).lastWakeReply.length === 200);

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
