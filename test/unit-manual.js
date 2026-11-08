/**
 * unit-manual.js — 说明书阅读进度 / 首次使用闸门
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ManualReader, parseSections } = require('../src/manual');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-test-'));
const RULES = path.join(TMP, 'RULES.md');
const RULES2 = path.join(TMP, 'RULES2.md');

const rules = [
  '# 测试说明书',
  '',
  '## 常驻摘要',
  '不该算章节',
  '',
  '## 零、分层',
  '零的正文',
  '',
  '## 一、写入',
  '一的正文',
  '',
  '## 二、链网',
  '二的正文',
  '',
  '## 一句话总结',
  '不算章节',
].join('\n');
fs.writeFileSync(RULES, rules, 'utf8');
fs.writeFileSync(RULES2, rules.replace('二的正文', '二的正文（新版）'), 'utf8');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const secs = parseSections(rules);
check('只解析带中文序号的 H2', secs.length === 3, JSON.stringify(secs.map((s) => s.title)));
check('章节正文完整', secs[1].text === '一的正文', secs[1].text);

const m = new ManualReader(TMP, RULES);
const st0 = m.status();
check('初始 0/3', st0.total === 3 && st0.read.length === 0 && !st0.completed, JSON.stringify(st0));
check('未读完有提示', m.onboardingText().includes('0/3'), m.onboardingText());

const r1 = m.read();
check('不带 section 读第一节', r1.ok && r1.index === 0 && r1.progress === '1/3', JSON.stringify(r1));
check('读到正文', r1.text === '零的正文');
const r1b = m.read(0);
check('重复读不重复计数', r1b.ok && r1b.progress === '1/3', JSON.stringify(r1b));

const ack0 = m.ack();
check('没读完 ack 被拒绝', ack0.ok === false && ack0.missing.length === 2, JSON.stringify(ack0));

const r2 = m.read('链网');
check('按标题片段读', r2.ok && r2.index === 2, JSON.stringify(r2));
const r3 = m.read(1);
check('按节号读', r3.ok && r3.progress === '3/3', JSON.stringify(r3));

const ack = m.ack();
check('读完后 ack 成功', ack.ok === true && !!ack.completedAt, JSON.stringify(ack));
const st1 = m.status();
check('状态 completed', st1.completed === true && st1.read.length === 3);
check('完成后不再提示', m.onboardingText() === '');
check('闸门放行', m.gate().ok === true);

const bad = m.read(9);
check('越界节号被拒绝', bad.ok === false);

// 版本变化 → 进度归零、闸门重新拦住
const m2 = new ManualReader(TMP, RULES2);
const st2 = m2.status();
check('换版本进度归零', st2.completed === false && st2.read.length === 0, JSON.stringify(st2));
check('换版本重新提示', m2.onboardingText().includes('0/3'));
check('换版本闸门拦住', m2.gate().ok === false);

check('无锁残留', !fs.existsSync(path.join(TMP, '.manual.lock')));

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
