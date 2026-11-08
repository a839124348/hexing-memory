/**
 * unit-identity-rules.js — 身份写入规则（用户 2026-11-06 定）
 *
 * 1. 字段空白        → 直接写（不用问）
 * 2. 字段已有值 + 相同 → 什么都不做
 * 3. 字段已有值 + 不同 → 只有用户明确提出修改（confirmed:true）才写；
 *                        否则**静默忽略**（不写、也不问用户）
 *
 * 逻辑与 dsh-plugin/src/index.ts 中 memory_identity 的 execute 一致。
 */
const FIELDS = ['aiName', 'userTitle', 'userInfo', 'relation', 'style'];

function applyIdentity(args, old) {
  const meta = {};
  for (const k of FIELDS) meta[k] = old[k] || '';
  const filled = [];
  const changed = [];
  const ignored = [];

  for (const k of FIELDS) {
    const raw = args[k];
    if (raw === undefined || raw === null) continue;
    const next = String(raw).trim();
    if (!next) continue;
    const prev = String(old[k] || '').trim();

    if (!prev) { meta[k] = next; filled.push(k); continue; }
    if (prev === next) continue;
    if (args.confirmed === true) { meta[k] = next; changed.push(k); }
    else ignored.push(k);
  }
  return { meta, filled, changed, ignored, unchanged: !filled.length && !changed.length };
}

let pass = 0;
const fails = [];
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n); } else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); } };

// 场景 1：全新（全空）→ 直接填
{
  const r = applyIdentity({ aiName: '助手', userTitle: '用户' }, {});
  check('空身份：直接写入', r.filled.length === 2, JSON.stringify(r.filled));
  check('空身份：值正确', r.meta.aiName === '助手' && r.meta.userTitle === '用户');
}

// 场景 2：有 aiName，只补空的 userTitle → 直接写，不影响其他
{
  const old = { aiName: '助手', userTitle: '', relation: '伴侣' };
  const r = applyIdentity({ userTitle: '用户' }, old);
  check('补空字段：写入成功', r.filled.includes('userTitle'), JSON.stringify(r.filled));
  check('补空字段：aiName 没被动', r.meta.aiName === '助手');
  check('补空字段：relation 没被动', r.meta.relation === '伴侣');
}

// 场景 3：想改已有值，但用户没要求 → 静默忽略（不写、不提示）
{
  const old = { aiName: '助手', userTitle: '用户' };
  const r = applyIdentity({ userTitle: '小用户' }, old);
  check('模型擅自改：不写入', r.unchanged === true, JSON.stringify(r));
  check('模型擅自改：标记为 ignored', r.ignored.includes('userTitle'), JSON.stringify(r.ignored));
  check('模型擅自改：原值不变', r.meta.userTitle === '用户');
}

// 场景 4：用户明确提出修改（confirmed:true）→ 写入
{
  const old = { aiName: '助手', userTitle: '用户' };
  const r = applyIdentity({ userTitle: '小用户', confirmed: true }, old);
  check('用户要求改：写入成功', r.changed.includes('userTitle'), JSON.stringify(r.changed));
  check('用户要求改：值正确', r.meta.userTitle === '小用户');
}

// 场景 5：传相同值 → 什么都不做
{
  const old = { aiName: '助手', userTitle: '用户' };
  const r = applyIdentity({ aiName: '助手', userTitle: '用户' }, old);
  check('重复写相同值：不写', r.unchanged === true);
  check('重复写相同值：没有 ignored 噪音', r.ignored.length === 0);
}

// 场景 6：混合（补空的 + 擅自改）→ 空的写，擅自改的忽略
{
  const old = { aiName: '助手', userTitle: '用户', relation: '' };
  const r = applyIdentity({ relation: '伴侣', userTitle: '小用户' }, old);
  check('混合：空的写入', r.filled.includes('relation'), JSON.stringify(r.filled));
  check('混合：擅自改的被忽略', r.ignored.includes('userTitle'), JSON.stringify(r.ignored));
  check('混合：原值保持', r.meta.userTitle === '用户');
}

// 场景 7：奇怪名字原样保留（程序不判断合法性）
{
  const r = applyIdentity({ userTitle: 'A B', aiName: '🐱' }, {});
  check('带空格的名字原样保留', r.meta.userTitle === 'A B', r.meta.userTitle);
  check('emoji 名字原样保留', r.meta.aiName === '🐱', r.meta.aiName);
  check('符号名字原样保留', applyIdentity({ userTitle: '<>|/' }, {}).meta.userTitle === '<>|/');
}

// 场景 8：用户改口（confirmed）后，再传相同值 → 不再写入
{
  const old = { aiName: '助手', userTitle: '小用户' };
  const r = applyIdentity({ userTitle: '小用户', confirmed: true }, old);
  check('改口后重复传：不写', r.unchanged === true);
}

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
