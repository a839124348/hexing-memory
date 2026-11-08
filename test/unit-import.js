/**
 * unit-import.js — 迁移导入器（dry-run / apply / 幂等 / 坏数据拒绝）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
const CLI = path.join(__dirname, '..', 'tools', 'import-jsonl.js');
const GOOD = path.join(TMP, 'good.jsonl');
const BAD = path.join(TMP, 'bad.jsonl');

const rows = [
  { t: '2026-11-08 10:00', s: '用户', c: '我想喝柚子茶', cid: 'dsh:t1', v: 1, mid: 'm1' },
  { t: '2026-11-08 10:01', s: '星绪', c: '好，记住了', cid: 'dsh:t1', v: 1, mid: 'm2' },
];
fs.writeFileSync(GOOD, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
fs.writeFileSync(BAD, '{"t":"2026-13-40 99:99","s":"用户","c":"坏时间","cid":"dsh:x","v":1}\n', 'utf8');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const rawDir = path.join(TMP, 'raw');
const rawCount = () => fs.existsSync(rawDir)
  ? fs.readdirSync(rawDir).reduce((n, f) => n + fs.readFileSync(path.join(rawDir, f), 'utf8').split(/\r?\n/).filter(Boolean).length, 0)
  : 0;

// 1. dry-run 不写
const d1 = run(['--file', GOOD, '--data', TMP]);
check('dry-run 成功', d1.status === 0, d1.stderr);
check('dry-run 提示预检通过', d1.stdout.includes('预检通过'));
check('dry-run 不创建 raw', !fs.existsSync(rawDir));

// 2. apply 写入
const a1 = run(['--file', GOOD, '--data', TMP, '--apply']);
check('apply 成功', a1.status === 0, a1.stderr);
check('apply 新增 2 条', a1.stdout.includes('新增 2 条'), a1.stdout);
check('raw 里 2 条', rawCount() === 2, String(rawCount()));
check('生成导入报告', fs.existsSync(path.join(TMP, 'common')) && fs.readdirSync(path.join(TMP, 'common')).some((f) => f.startsWith('import-report-')));

// 3. 重复导入幂等
const a2 = run(['--file', GOOD, '--data', TMP, '--apply']);
check('重复导入成功', a2.status === 0, a2.stderr);
check('重复导入全部跳过', a2.stdout.includes('全部 2 条都已在库里'), a2.stdout);
check('raw 仍然 2 条', rawCount() === 2, String(rawCount()));

// 4. 坏数据整批拒绝
const b1 = run(['--file', BAD, '--data', TMP, '--apply']);
check('坏时间被拒绝', b1.status !== 0, b1.stdout);
check('坏数据不写入', rawCount() === 2, String(rawCount()));

// 5. 文件不存在
const m1 = run(['--file', path.join(TMP, 'none.jsonl')]);
check('缺文件报错', m1.status !== 0);

// 6. 近似重复：默认放行（历史重复发言正常），--strict-similar 才拦
const NEAR = path.join(TMP, 'near.jsonl');
fs.writeFileSync(NEAR, [
  JSON.stringify({ t: '2026-11-08 11:00', s: '用户', c: '我今天很开心', cid: 'dsh:n', v: 1, mid: 'n1' }),
  JSON.stringify({ t: '2026-11-08 11:01', s: '用户', c: '我今天很开心啊', cid: 'dsh:n', v: 1, mid: 'n2' }),
].join('\n') + '\n', 'utf8');
const n1 = run(['--file', NEAR, '--data', path.join(TMP, 'near1'), '--apply']);
check('默认放行近似重复', n1.status === 0 && n1.stdout.includes('新增 2 条'), n1.stdout + n1.stderr);
const n2 = run(['--file', NEAR, '--data', path.join(TMP, 'near2'), '--strict-similar', '--apply']);
check('strict 拦近似重复', n2.status !== 0, n2.stdout);

// 7. 完全重复：默认补合成 mid 保留两条，--strict-duplicates 拒绝
const DUP = path.join(TMP, 'dup.jsonl');
const dupRow = JSON.stringify({ t: '2026-11-08 12:00', s: '用户', c: '同一句话', cid: 'dsh:d', v: 1 });
fs.writeFileSync(DUP, dupRow + '\n' + dupRow + '\n', 'utf8');
const du1 = run(['--file', DUP, '--data', path.join(TMP, 'dup1'), '--apply']);
check('完全重复默认保留两条', du1.status === 0 && du1.stdout.includes('新增 2 条'), du1.stdout + du1.stderr);
const du2 = run(['--file', DUP, '--data', path.join(TMP, 'dup2'), '--strict-duplicates', '--apply']);
check('strict-duplicates 拒绝', du2.status !== 0, du2.stdout);

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
