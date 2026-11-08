/**
 * unit-refine-dedup.js — 提炼层的"对比去重"
 *
 * 核心场景：草稿里混有「已提炼过的」和「没提炼过的」，
 * 提炼时必须只追加新的，并把已存在的从草稿里摘掉（否则死循环）。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { Draft } = require('../src/draft');
const { Refiner } = require('../src/refine');

const TMP = path.join(__dirname, '.tmp-dedup');
fs.rmSync(TMP, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const store = new Store(TMP);
const draft = new Draft(TMP);
const refiner = new Refiner(TMP, store, draft);

const A = { t: '2026-11-06 10:00', s: '用户', c: '第一条：A 会话的内容', cid: 'session-A', v: 1 };
const B = { t: '2026-11-06 10:01', s: '用户', c: '第二条：A 会话的内容', cid: 'session-A', v: 1 };
const C = { t: '2026-11-06 10:02', s: '用户', c: '第三条：B 会话的内容', cid: 'session-B', v: 1 };

// 1. 先让 A、B 进正式存档
store.append([A, B]);
check('前置：存档 2 条', store.readDay('2026-11-06').length === 2);

// 2. 草稿里放「A（已存在）+ C（新的）」
draft.add([A, C]);
check('前置：草稿 2 条', draft.stats().pending === 2);

// 3. 提炼：应该只入库 C，A 被识别为"已存在"并摘掉
const r1 = refiner.run();
check('提炼成功', r1.ok, JSON.stringify(r1).slice(0, 160));
check('只追加了 1 条（C）', r1.added === 1, 'added=' + r1.added);
check('识别出 1 条已存在', r1.alreadyStored === 1, 'alreadyStored=' + r1.alreadyStored);
check('草稿被清空', draft.stats().pending === 0, 'pending=' + draft.stats().pending);
check('存档共 3 条', store.readDay('2026-11-06').length === 3, 'len=' + store.readDay('2026-11-06').length);

// 4. 再跑一次：没有草稿，应该空转且不报错（幂等）
const r2 = refiner.run();
check('空跑幂等', r2.ok && r2.added === 0, JSON.stringify(r2).slice(0, 120));

// 5. 再来一轮：草稿全是"已存在"的 → 不报错、草稿清空、不入库
draft.add([A, B]);
const r3 = refiner.run();
check('全重复时不报错', r3.ok, JSON.stringify(r3).slice(0, 160));
check('全重复时一条不入库', r3.added === 0, 'added=' + r3.added);
check('全重复时草稿清空（关键：否则死循环）', draft.stats().pending === 0, 'pending=' + draft.stats().pending);

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
