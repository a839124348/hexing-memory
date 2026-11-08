/**
 * unit-validate.js — 校验器单元测试
 * 每条规则一个用例，验证「能拦住」和「不误拦」
 */
const { validateRecords } = require('../src/validate');

const base = { t: '2026-11-05 03:20', s: '用户', c: '今天试一下这个系统', cid: 'c1', v: 1 };

const cases = [
  ['正常记录', [{ ...base }], true, ''],
  ['乱码 U+FFFD', [{ ...base, c: '今天试\uFFFD一下' }], false, 'FFFD'],
  ['完全重复', [{ ...base }, { ...base }], false, 'DUPLICATE'],
  ['近似重复', [{ ...base }, { ...base, c: '今天试一下这个系统啊' }], false, 'NEAR_DUPLICATE'],
  ['召回复述(标记)', [{ ...base, c: '[记忆] 你之前说过喜欢下雨' }], false, 'RECALL_ECHO'],
  ['召回复述(origin)', [{ ...base, origin: 'recall_echo' }], false, 'RECALL_ECHO'],
  ['时间格式错', [{ ...base, t: '2026/11/05 03:20' }], false, 'TIME_FORMAT'],
  ['时间不存在', [{ ...base, t: '2026-02-30 10:00' }], false, 'TIME_INVALID'],
  ['空内容', [{ ...base, c: '   ' }], false, 'EMPTY_CONTENT'],
  ['控制字符', [{ ...base, c: '今天\u0001试一下' }], false, 'CONTROL_CHAR'],
  ['说话人空', [{ ...base, s: ' ' }], false, 'SPEAKER'],
  ['会话ID空', [{ ...base, cid: '' }], false, 'MISSING_FIELD'],
  ['版本错', [{ ...base, v: 2 }], false, 'VERSION'],
  ['type 非法', [{ ...base, type: 'robot' }], false, 'TYPE_ENUM'],
  ['origin 非法', [{ ...base, origin: 'xx' }], false, 'ORIGIN_ENUM'],
  ['未知字段', [{ ...base, extra: 1 }], false, 'UNKNOWN_FIELD'],
  ['缺字段', [{ t: '2026-11-05 03:20', s: '用户', c: 'x', cid: 'c1' }], false, 'MISSING_FIELD'],
  ['内容超长', [{ ...base, c: 'x'.repeat(200001) }], false, 'CONTENT_TOO_LONG'],
  ['时间倒序(仅告警)', [{ ...base, t: '2026-11-05 05:00' }, { ...base, t: '2026-11-05 04:00', c: '后一条更早' }], true, 'TIME_ORDER_WARN'],
  ['未来时间(仅告警)', [{ ...base, t: '2099-01-01 10:00' }], true, 'TIME_FUTURE_WARN'],
  ['不同会话同内容(不拦但告警)', [{ ...base }, { ...base, cid: 'c2' }], true, 'CROSS_SESSION_DUP_WARN'],
];

let pass = 0;
const fails = [];
for (const [name, recs, expectOk, expectCode] of cases) {
  const r = validateRecords(recs, { checkSimilar: true });
  let good = r.ok === expectOk;
  let detail = 'ok=' + r.ok;
  if (expectCode === 'TIME_ORDER_WARN') {
    good = r.ok && r.warnings.some((w) => w.code === 'TIME_ORDER');
    detail = 'warns=' + r.warnings.map((w) => w.code).join(',');
  } else if (expectCode === 'TIME_FUTURE_WARN') {
    good = r.ok && r.warnings.some((w) => w.code === 'TIME_FUTURE');
    detail = 'warns=' + r.warnings.map((w) => w.code).join(',');
  } else if (expectCode === 'CROSS_SESSION_DUP_WARN') {
    good = r.ok && r.warnings.some((w) => w.code === 'CROSS_SESSION_DUP');
    detail = 'ok=' + r.ok + ' warns=' + r.warnings.map((w) => w.code).join(',');
  } else if (expectCode) {
    good = !r.ok && r.errors.some((e) => e.code === expectCode);
    detail = 'errors=' + r.errors.map((e) => e.code).join(',');
  }
  if (good) pass++;
  else fails.push(name + ' → ' + detail);
  console.log((good ? 'PASS ' : 'FAIL ') + name + '  (' + detail + ')');
}

console.log('');
console.log('结果：' + pass + '/' + cases.length + ' 通过');
if (fails.length) {
  console.log('失败用例：');
  fails.forEach((f) => console.log('  ' + f));
  process.exit(1);
}
