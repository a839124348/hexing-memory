/**
 * unit-append.js — 真追加 + 截尾修复 + 多进程写锁
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');

const tmpRoot = path.join(__dirname, '.tmp-append');
fs.rmSync(tmpRoot, { recursive: true, force: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};

const s = new Store(tmpRoot);
const day = '2026-11-07';
const file = path.join(tmpRoot, 'raw', day + '.jsonl');

// 1. 第一批
const r1 = s.append([
  { t: '2026-11-07 23:30', s: '用户', c: '追加测试-A', cid: 'c-append', v: 1 },
  { t: '2026-11-07 23:30', s: '用户', c: '追加测试-B', cid: 'c-append', v: 1 },
], { checkSimilar: false });
check('第一批写入 2 条', r1.ok && r1.added === 2, JSON.stringify(r1));
const oldBuf = fs.readFileSync(file);

// 2. 第二批：旧字节必须原样保留（真追加，不是整份重写）
const r2 = s.append([
  { t: '2026-11-07 23:30', s: '用户', c: '追加测试-C', cid: 'c-append', v: 1 },
], { checkSimilar: false });
check('第二批写入 1 条', r2.ok && r2.added === 1, JSON.stringify(r2));
const newBuf = fs.readFileSync(file);
check('旧内容前缀未变（真追加）', newBuf.subarray(0, oldBuf.length).equals(oldBuf), 'old=' + oldBuf.length + ' new=' + newBuf.length);
check('读回 3 条', s.readDay(day).length === 3, 'got ' + s.readDay(day).length);

// 3. 尾部半行：下次写在锁内截掉，不污染新记录
fs.appendFileSync(file, '{"t":"2026-11-07 23:30","s":"用户","c":"PARTIAL-BROKEN');
const r3 = s.append([
  { t: '2026-11-07 23:30', s: '用户', c: '追加测试-D', cid: 'c-append', v: 1 },
], { checkSimilar: false });
check('半行后仍可追加', r3.ok && r3.added === 1, JSON.stringify(r3));
const after = fs.readFileSync(file, 'utf8');
check('半行已被截掉', !after.includes('PARTIAL-BROKEN'), after.slice(-160));
check('读回 4 条（坏行不计数）', s.readDay(day).length === 4, 'got ' + s.readDay(day).length);

// 4. 多进程：两个子进程各写 200 条，最终 400 条、id 唯一
const root2 = path.join(tmpRoot, 'mp');
const worker = path.join(__dirname, 'append-worker.js');
function run(prefix) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, root2, prefix, '200'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d);
    p.stderr.on('data', (d) => err += d);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error('worker ' + prefix + ' exit ' + code + ' ' + err)));
  });
}

(async () => {
  await Promise.all([run('w1'), run('w2')]);
  const s2 = new Store(root2);
  const rows = s2.readDay(day);
  check('多进程写入 400 条', rows.length === 400, 'got ' + rows.length);
  const ids = new Set(rows.map((r) => r.id));
  check('多进程 id 唯一', ids.size === 400, 'unique ' + ids.size);
  check('多进程无锁文件残留', !fs.existsSync(path.join(root2, '.write.lock')), 'lock exists');

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
