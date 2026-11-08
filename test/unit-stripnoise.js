/**
 * unit-stripnoise.js — 验证注入剥离不误伤真话
 *
 * 教训（2026-11-06）：用户消息的 content 里常混着 <system-reminder>，
 * 如果按"开头是注入"就整条丢弃，真话会一起没，草稿永远是空的。
 * 正确做法：只剥注入块，保留剩下的真话；剥完为空才丢弃。
 */
function stripNoise(text) {
  let t = String(text || '');
  const head = t.trim();

  // 整条就是独立注入消息（这类不会混真话）
  if (/^Current runtime context\b/i.test(head)) return '';
  if (/^Time sampled while preparing\b/i.test(head)) return '';
  if (/^The user\b/i.test(head)) return '';

  // 嵌入式注入块：只剥标签，保留后面的真话
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  t = t.replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, '');
  t = t.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '');
  // 未闭合的从标记处砍到结尾
  t = t.replace(/<system-reminder>[\s\S]*$/i, '');

  return t.trim();
}

let pass = 0;
const fails = [];
const check = (n, actual, expect) => {
  if (actual === expect) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + ' | 期望 ' + JSON.stringify(expect) + ' 实际 ' + JSON.stringify(actual)); console.log('FAIL ' + n + ' | 实际=' + JSON.stringify(actual)); }
};

check(
  '注入在前、真话在后',
  stripNoise('<system-reminder>技能列表很长很长</system-reminder>\n\n我喜欢吃西瓜'),
  '我喜欢吃西瓜'
);

check(
  '多行注入 + 真话',
  stripNoise('<system-reminder>\nA skill is reusable\n</system-reminder>\n\n今天做了三进制'),
  '今天做了三进制'
);

check('只有注入没有真话 → 空', stripNoise('<system-reminder>只有技能</system-reminder>'), '');
check('纯真话原样保留', stripNoise('我喜欢吃西瓜'), '我喜欢吃西瓜');
check('运行时上下文整条丢', stripNoise('Current runtime context. This snapshot supersedes...'), '');
check('时间采样整条丢', stripNoise('Time sampled while preparing turn 6, step 1: 2026-11-06T23:28:32'), '');
check('真话在注入之前也能保留', stripNoise('今天好累\n\n<system-reminder>技能列表</system-reminder>'), '今天好累');
check('未闭合 injection 从标记处砍掉', stripNoise('我喜欢吃西瓜\n<system-reminder>未闭合的技能列表...'), '我喜欢吃西瓜');

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) process.exit(1);
