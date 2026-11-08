/**
 * chaos.js — 异常与边界测试
 * 覆盖"可能发生的情况"：并发写、写入中断（原子性）、跨日边界、超大内容、空语料
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { Draft } = require('../src/draft');
const { validateRecords } = require('../src/validate');

const TMP = path.join(__dirname, '.tmp-chaos');
fs.rmSync(TMP, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n); } else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); } };

(async () => {
  // ── 1. 并发写（20 个并发 append，不同内容） ──
  const s = new Store(TMP);
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(new Promise((resolve) => {
      const r = { t: '2026-11-05 10:' + String(i).padStart(2, '0'), s: '用户', c: '并发测试第 ' + i + ' 条', cid: 'concurrent', v: 1 };
      resolve(s.append([r]));
    }));
  }
  const rs = await Promise.all(jobs);
  const okCount = rs.filter((x) => x.ok).length;
  const total = s.readDay('2026-11-05').length;
  check('并发写 20 条不丢', total === 20, 'ok=' + okCount + ' total=' + total);
  const ids = s.readDay('2026-11-05').map((x) => x.id);
  check('并发写 id 无重复', new Set(ids).size === ids.length, 'unique=' + new Set(ids).size);

  // ── 2. 原子性：写入过程崩溃不破坏原文件 ──
  const f = path.join(TMP, 'raw', '2026-11-05.jsonl');
  const before = fs.readFileSync(f, 'utf8');
  const origRename = fs.renameSync;
  let threw = false;
  try {
    fs.renameSync = () => { throw new Error('模拟断电'); };
    s.append([{ t: '2026-11-05 11:00', s: '用户', c: '这条会写失败', cid: 'crash', v: 1 }]);
  } catch (e) {
    threw = true;
  } finally {
    fs.renameSync = origRename;
  }
  const after = fs.readFileSync(f, 'utf8');
  check('写入中断时原文件不变', before === after, 'threw=' + threw);
  const tmps = fs.readdirSync(path.join(TMP, 'raw')).filter((x) => x.includes('.tmp'));
  check('中断后无临时文件残留', tmps.length === 0, tmps.join(','));

  // ── 3. 跨日边界：23:59 与 00:00 分到不同天 ──
  const s2 = new Store(TMP);
  s2.append([
    { t: '2026-11-05 23:59', s: '用户', c: '今天最后一分钟', cid: 'boundary', v: 1 },
    { t: '2026-11-06 00:00', s: '用户', c: '新的一天第一分钟', cid: 'boundary', v: 1 },
  ]);
  check('23:59 归 11-05', s2.readDay('2026-11-05').some((r) => r.c === '今天最后一分钟'));
  check('00:00 归 11-06', s2.readDay('2026-11-06').some((r) => r.c === '新的一天第一分钟'));

  // ── 4. 超大内容 ──
  const rBig = validateRecords([{ t: '2026-11-05 12:00', s: '用户', c: 'x'.repeat(200001), cid: 'big', v: 1 }]);
  check('超大内容被拒', !rBig.ok && rBig.errors.some((e) => e.code === 'CONTENT_TOO_LONG'));

  // ── 5. 空语料检索 ──
  const s3 = new Store(path.join(TMP, 'empty'));
  const empty = s3.readRange();
  check('空语料读取不崩', Array.isArray(empty) && empty.length === 0);

  // ── 6. 草稿并发写 ──
  const d = new Draft(path.join(TMP, 'draft-test'));
  const dj = [];
  for (let i = 0; i < 10; i++) {
    dj.push(new Promise((resolve) => resolve(d.add([{ t: '2026-11-05 13:' + String(i).padStart(2, '0'), s: '用户', c: '草稿并发 ' + i, cid: 'dc', v: 1 }]))));
  }
  await Promise.all(dj);
  check('草稿并发写不丢', d.stats().pending === 10, 'pending=' + d.stats().pending);

  // ── 7. 草稿提炼后移除、失败保留 ──
  const pend = d.pending();
  d.remove(pend.slice(0, 5));
  check('草稿部分移除', d.stats().pending === 5, 'pending=' + d.stats().pending);

  // ── 8. 相同内容不同会话（跨会话告警但不拦） ──
  const r8 = validateRecords([
    { t: '2026-11-05 14:00', s: '用户', c: '早安', cid: 'd1', v: 1 },
    { t: '2026-11-06 08:00', s: '用户', c: '早安', cid: 'd2', v: 1 },
  ]);
  check('跨会话同内容不拦但告警', r8.ok && r8.warnings.some((w) => w.code === 'CROSS_SESSION_DUP'), JSON.stringify(r8.warnings).slice(0, 120));

  // ── 9. 同会话同内容不同时间（不该算完全重复） ──
  const r9 = validateRecords([
    { t: '2026-11-05 14:00', s: '用户', c: '嗯嗯', cid: 'd3', v: 1 },
    { t: '2026-11-05 14:05', s: '用户', c: '嗯嗯', cid: 'd3', v: 1 },
  ]);
  check('同会话同内容不同时间（近似判重拦下）', !r9.ok || r9.warnings.length > 0, JSON.stringify(r9.errors).slice(0, 100));

  // ── 10. 损坏的索引文件不崩 ──
  const idxFile = path.join(TMP, 'index', 'vectors.json');
  fs.mkdirSync(path.dirname(idxFile), { recursive: true });
  fs.writeFileSync(idxFile, '{坏掉的JSON', 'utf8');
  const { Search } = require('../src/search');
  const srch = new Search(TMP, s2);
  const st = srch.stats();
  check('损坏索引不崩', st.indexed === 0, JSON.stringify(st));

  console.log('');
  console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
})();
