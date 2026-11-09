/**
 * unit-onboarding.js — 迁移问卷 / 相处方式档案
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Onboarding } = require('../src/onboarding');
const { composeCommonText } = require('../src/adapter_pure');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-test-'));
const ob = new Onboarding(TMP);

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const s0 = ob.status();
check('初始未选模式', s0.ok && s0.mode === null, JSON.stringify(s0));
check('初始没有相处方式', s0.voice.exists === false);
check('初始清单提示先选模式', s0.checklist.join('').includes('还没选迁移模式'));
check('初始 common 为空', ob.commonText() === '');
check('初始 importer 警告', ob.importerHint().level === 'warn');

const bad = ob.save({ mode: 'copy' });
check('非法模式被拒', bad.ok === false, JSON.stringify(bad));

const noConsent = ob.save({ mode: 'inherit', source: 'test' });
check('全继承无 consent 被拒', noConsent.ok === false && /同意/.test(noConsent.error), JSON.stringify(noConsent));

const memNoConsent = ob.save({ mode: 'memory', source: 'test' });
check('只继承记忆无 consent 被拒', memNoConsent.ok === false);

const mem = ob.save({ mode: 'memory', source: '旧平台', consent: true, dateRange: '2025-01 ~ 2026-01' });
check('保存只继承记忆', mem.ok && mem.mode === 'memory', JSON.stringify(mem));
check('只继承记忆 common 有防模仿规则', ob.commonText().includes('不要模仿旧原文'));
check('只继承记忆 importer 提示 info', ob.importerHint().level === 'info');

const v0 = ob.setVoice('# x\n语气：短句', '短句');
check('非全继承不能写相处方式', v0.ok === false, JSON.stringify(v0));

const inh = ob.save({
  mode: 'inherit', source: '旧平台', consent: true,
  keepNames: true, exclusions: '不想带回来的争吵', notes: '测试',
});
check('保存全继承', inh.ok && inh.mode === 'inherit', JSON.stringify(inh));
check('全继承清单包含示例', ob.checklist().join('').includes('5–8 段'));

const noCore = ob.setVoice('# 相处方式\n\n## 语气\n- 短句');
check('缺少常驻核心被拒', noCore.ok === false && /常驻核心/.test(noCore.error), JSON.stringify(noCore));

const longCore = ob.setVoice('# 相处方式\n\n## 常驻核心\n' + '长'.repeat(900));
check('常驻核心超长被拒', longCore.ok === false && /太长/.test(longCore.error), JSON.stringify(longCore));

const voiceText = [
  '# 相处方式',
  '',
  '## 摘要',
  '短句、少表情、先听完再回应。',
  '',
  '## 常驻核心',
  '- 叫“你”，自称“我”；短句、少表情；先听完再回应；不要叫宝贝。',
  '',
  '## 称呼',
  '- 叫“你”，自称“我”；生气时不要叫宝贝。',
  '',
  '## 语气',
  '- 句子短，少用感叹号。',
  '',
  '## 示例',
  '- 2026-05-04：“我在，慢慢说。”',
].join('\n');
const v1 = ob.setVoice(voiceText);
check('保存相处方式', v1.ok && v1.chars > 50, JSON.stringify(v1));
check('摘要自动取摘要段', v1.summary === '短句、少表情、先听完再回应。', v1.summary);
check('常驻核心已提取', v1.coreChars > 20 && v1.core.includes('先听完再回应'), JSON.stringify(v1.core));
check('相处方式文件存在', fs.existsSync(path.join(TMP, 'common', 'voice-habits.md')));
check('common 注入完整核心 + 指针', ob.commonText().includes('先听完再回应') && ob.commonText().includes('voice-habits.md'));
check('importer 全继承 ok', ob.importerHint().level === 'ok');

const vget = ob.voice();
check('读回完整相处方式', vget.ok && vget.text.includes('不要叫宝贝'), JSON.stringify(vget).slice(0, 200));

const fresh = ob.save({ mode: 'fresh', consent: false });
check('保存全新开始', fresh.ok && fresh.mode === 'fresh', JSON.stringify(fresh));
check('全新开始 common 为空', ob.commonText() === '');
check('全新开始 importer 报错', ob.importerHint().level === 'error');
const v2 = ob.setVoice('# x\n语气：短句');
check('全新开始不能写相处方式', v2.ok === false);

const common = composeCommonText({
  profile: '## 身份\n- 测试', resident: '- 先查再答', manualIndex: '- 第十节',
  chains: '- 身份', inheritance: '## 迁移模式\n- 全继承：按相处方式延续。',
});
check('常识层能装入迁移模式', common.includes('## 迁移模式') && common.includes('全继承'), common.slice(0, 300));

check('无锁残留', !fs.existsSync(path.join(TMP, '.onboarding.lock')));

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
