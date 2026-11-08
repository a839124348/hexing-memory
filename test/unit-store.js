/**
 * unit-store.js — 原始存档层测试
 * 覆盖：按天分文件、原子写、id 生成、校验拦截、重复写入、读回一致
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');

const tmpRoot = path.join(__dirname, '.tmp-store');
fs.rmSync(tmpRoot, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const s = new Store(tmpRoot);

// 1. 写入两天共 4 条
const recs = [
  { t: '2026-11-05 03:20', s: '用户', c: '第一条：今天开始做MVP', cid: 'c1', v: 1 },
  { t: '2026-11-05 03:21', s: '助手', c: '第二条：我记下了', cid: 'c1', v: 1, type: 'ai', origin: 'ai' },
  { t: '2026-11-04 22:10', s: '用户', c: '昨天的内容', cid: 'c0', v: 1 },
  { t: '2026-11-04 22:11', s: '用户', c: '昨天第二条', cid: 'c0', v: 1 },
];
const r1 = s.append(recs);
check('批量写入 4 条', r1.ok && r1.added === 4, JSON.stringify(r1).slice(0, 120));

// 2. 读回
const d5 = s.readDay('2026-11-05');
const d4 = s.readDay('2026-11-04');
check('11-05 读回 2 条', d5.length === 2, 'got ' + d5.length);
check('11-04 读回 2 条', d4.length === 2, 'got ' + d4.length);
check('内容一致', d5[0].c === '第一条：今天开始做MVP', d5[0] && d5[0].c);

// 3. id 自动生成且唯一
const ids = [d5[0].id, d5[1].id, d4[0].id, d4[1].id];
check('id 全部生成', ids.every((x) => !!x), JSON.stringify(ids));
check('id 唯一', new Set(ids).size === 4, JSON.stringify(ids));

// 4. 重复写入被拦
const r2 = s.append([recs[0]]);
check('重复写入被拦', !r2.ok && r2.errors.some((e) => e.code === 'DUPLICATE'), JSON.stringify(r2.errors).slice(0, 120));

// 5. 校验失败整批拒绝（带一条坏数据）
const r3 = s.append([{ t: '2026-11-05 04:00', s: '用户', c: '好数据', cid: 'c2', v: 1 }, { t: 'bad', s: 'x', c: 'y', cid: 'c2', v: 1 }]);
check('整批拒绝', !r3.ok && r3.added === 0, JSON.stringify(r3).slice(0, 100));
check('拒绝后没写入', s.readDay('2026-11-05').length === 2, 'len=' + s.readDay('2026-11-05').length);

// 6. 无临时文件残留
const leftovers = fs.readdirSync(path.join(tmpRoot, 'raw')).filter((f) => f.includes('.tmp'));
check('无 .tmp 残留', leftovers.length === 0, leftovers.join(','));

// 7. listDays / stats / findById
check('listDays 2 天', s.listDays().length === 2, JSON.stringify(s.listDays()));
const st = s.stats();
check('stats 正确', st.days === 2 && st.records === 4, JSON.stringify(st));
check('findById 命中', s.findById(d5[0].id) !== null);

// 8. readRange
check('readRange 只取 11-05', s.readRange('2026-11-05', '2026-11-05').length === 2);

// 9. 空行/坏行容忍（手工塞一行坏的）
const f = path.join(tmpRoot, 'raw', '2026-11-03.jsonl');
fs.writeFileSync(f, '{"t":"2026-11-03 10:00","s":"用户","c":"正常","cid":"c9","v":1,"id":"x1"}\n{坏行\n', 'utf8');
const bad = s.readDay('2026-11-03');
check('坏行被跳过', bad.length === 1, 'got ' + bad.length);

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
