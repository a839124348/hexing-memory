/**
 * unit-adapter-pure.js — 插件适配层纯函数
 */
const {
  extractText, stripNoise, pickLastUserMessage,
  readResidentSpecFrom, readManualIndexFrom, composeCommonText, dedupeKey,
} = require('../src/adapter_pure');

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const user = (text, kind) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(kind ? { source: { kind } } : {}),
});

// 1. 取文本
check('extractText 字符串', extractText({ content: 'abc' }) === 'abc');
check('extractText 文本块', extractText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'b' }] }) === 'a\nb');

// 2. 剥注入但保留真话
check('注入在前真话在后', stripNoise('<system-reminder>规则</system-reminder>\n我想吃西瓜') === '我想吃西瓜');
check('运行时上下文整条丢', stripNoise('Current runtime context. cwd=...') === '');
check('时间采样整条丢', stripNoise('Time sampled while preparing turn 1') === '');

// 3. 选最后一条真话
{
  const messages = [
    user('早先的真话'),
    user('Current runtime context. cwd=...', 'runtime-context'),
    user('<system-reminder>技能列表</system-reminder>\n我要说的是这句', undefined),
    user('Time sampled while preparing turn 1', 'time-context'),
  ];
  const r = pickLastUserMessage(messages);
  check('跳过注入选到真话', r && r.text === '我要说的是这句', JSON.stringify(r));
}
{
  const messages = [
    user('旧消息'),
    user('<!-- memory-system:common --> 常识层', 'memory-common'),
    user('最新消息'),
    user('tick', 'time-context'),
  ];
  const r = pickLastUserMessage(messages);
  check('跳过 memory-common，取最新真话', r && r.text === '最新消息', JSON.stringify(r));
}
{
  const messages = [user('<!-- memory-system:common --> x', 'memory-common'), user('tick', 'time-context')];
  check('只有注入返回 null', pickLastUserMessage(messages) === null);
}

// 4. 从 RULES 文本取摘要/目录
const rulesText = [
  '# 记忆系统唯一说明书',
  '',
  '<!-- RESIDENT:BEGIN -->',
  '## 常驻规范（每轮都要遵守）',
  '1. 先查再答',
  '2. 原文不改',
  '<!-- RESIDENT:END -->',
  '',
  '## 目录（v0.4）',
  '| 部分 | 内容 |',
  '',
  '## 一、记忆系统不对用户发起询问',
  '## 二、写什么、怎么写',
  '## 三、链网',
  '## 一句话总结',
].join('\n');
const resident = readResidentSpecFrom(rulesText);
check('摘要取到', resident.includes('1. 先查再答') && resident.includes('2. 原文不改'), resident);
check('摘要去掉自带标题', !resident.includes('## 常驻规范'), resident);
const index = readManualIndexFrom(rulesText);
check('目录取到', index.includes('一、记忆系统不对用户发起询问') && index.includes('二、写什么'), index);
check('目录排除摘要/目录/总结', !index.includes('常驻规范') && !index.includes('目录') && !index.includes('一句话总结'), index);

// 5. 组装常识层
const common = composeCommonText({
  profile: '# 身份\n## 我是谁\n时助手\n## 记忆系统说明\n旧的规则副本',
  resident,
  manualIndex: index,
  chains: '- 身份链：关于用户（3 节点）\n- 项目链（0 节点）',
});
check('常识层有身份', common.includes('时助手'));
check('常识层有常驻规范', common.includes('## 常驻规范') && common.includes('先查再答'));
check('常识层有说明书索引', common.includes('## 说明书索引') && common.includes('一、记忆系统'));
check('常识层有链网索引', common.includes('## 链网索引') && common.includes('身份链'));
check('不塞当前状态/最近会话', !common.includes('## 当前状态') && !common.includes('## 最近会话'));
check('剥掉旧 SYSTEM_NOTE', !common.includes('记忆系统说明') && !common.includes('旧的规则副本'));
check('有注入标记', common.includes('<!-- memory-system:common -->') && common.includes('<!-- /memory-system:common -->'));

// 5a. 首次使用提示（有才出现）
const withOnboarding = composeCommonText({
  profile: '# 身份\n## 我是谁\n验收身份',
  resident,
  manualIndex: index,
  chains: '- 身份链（3 节点）',
  onboarding: '## 首次使用（说明书未读完）\n- 0/17 节',
});
check('有首次使用提示', withOnboarding.includes('## 首次使用') && withOnboarding.includes('0/17'));
check('无提示不出现', !common.includes('## 首次使用'));

// 5b. 话题栈段落（有才出现）
const withTopics = composeCommonText({
  profile: '# 身份\n## 我是谁\n验收身份',
  resident,
  manualIndex: index,
  chains: '- 身份链（3 节点）',
  topics: '- 未闭合 2 个；已升格 1 个',
});
check('有话题栈段落', withTopics.includes('## 话题栈') && withTopics.includes('未闭合 2 个'));
check('无话题不出现段落', !common.includes('## 话题栈'));

// 6. 超长裁剪：身份+摘要保留，目录/链网被裁
const longCommon = composeCommonText({
  profile: '# 身份\n' + '身份'.repeat(200),
  resident,
  manualIndex: Array.from({ length: 200 }, (_, i) => '- 目录项 ' + i).join('\n'),
  chains: Array.from({ length: 200 }, (_, i) => '- 链 ' + i + '（1 节点）').join('\n'),
  maxChars: 1200,
});
check('超长被裁到上限附近', longCommon.length <= 1200, 'len=' + longCommon.length);
check('超长仍保留身份与摘要', longCommon.includes('身份身份') && longCommon.includes('先查再答'));

// 7. 去重键
check('去重键含 kind/cid/identity', dedupeKey('user', 'c1', 'm1') === 'user\u0000c1\u0000m1');
check('不同 cid 键不同', dedupeKey('user', 'c1', 'm1') !== dedupeKey('user', 'c2', 'm1'));

console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
