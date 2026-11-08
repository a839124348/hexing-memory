/**
 * unit-mid.js — 消息唯一标识（mid）测试
 *
 * 场景：同一会话、同一分钟、同一句话连说两次。
 * 没有 mid 时会被判重复吞掉；有不同 mid 时必须记成两条。
 */
const fs = require('fs');
const path = require('path');
const { validateRecords, contentHash } = require('../src/validate');
const { Draft } = require('../src/draft');
const { Store } = require('../src/store');

const tmpRoot = path.join(__dirname, '.tmp-mid');
fs.rmSync(tmpRoot, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const base = { t: '2026-11-07 22:17', s: '用户', c: '重复发言测试二', cid: 'dsh:session-test', v: 1 };
const a = { ...base, mid: 'rpc-a' };
const b = { ...base, mid: 'rpc-b' };

// 1. 校验：不同 mid 不算重复
const v1 = validateRecords([a, b], { checkSimilar: false });
check('不同 mid 两条都通过', v1.ok && v1.errors.length === 0, JSON.stringify(v1.errors));

// 2. 校验：相同 mid 仍算重复
const v2 = validateRecords([{ ...base, mid: 'rpc-a' }, { ...base, mid: 'rpc-a' }], { checkSimilar: false });
check('相同 mid 判重复', !v2.ok && v2.errors.some((e) => e.code === 'DUPLICATE'), JSON.stringify(v2.errors));

// 3. 哈希：mid 参与
check('不同 mid 哈希不同', contentHash(a) !== contentHash(b));
check('相同 mid 哈希相同', contentHash(a) === contentHash({ ...base, mid: 'rpc-a' }));
check('无 mid 与空 mid 兼容', contentHash(base) === contentHash({ ...base, mid: '' }));

// 4. 草稿：两条都进、重复不再进
const draft = new Draft(tmpRoot);
const d1 = draft.add([a, b]);
check('草稿收两条同文', d1.ok && d1.added === 2, JSON.stringify(d1));
check('草稿 pending=2', draft.pending().length === 2, 'got ' + draft.pending().length);
const d2 = draft.add([a, b]);
check('草稿同 mid 重写被拦', d2.ok && d2.added === 0 && d2.skipped === 2, JSON.stringify(d2));

// 5. 存档：两条都进、id 不撞、重写被拦
//    checkSimilar:false —— 与提炼层一致；近似判重只用于导入历史数据
const store = new Store(tmpRoot);
const s1 = store.append([a, b], { checkSimilar: false });
check('存档收两条同文', s1.ok && s1.added === 2, JSON.stringify(s1));
const day = store.readDay('2026-11-07');
check('存档读回 2 条', day.length === 2, 'got ' + day.length);
check('两条 id 不同', day[0].id !== day[1].id, JSON.stringify(day.map((r) => r.id)));
const s2 = store.append([a, b], { checkSimilar: false });
check('存档同 mid 重写被拦', !s2.ok && s2.errors.some((e) => e.code === 'DUPLICATE'), JSON.stringify(s2.errors));

console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
