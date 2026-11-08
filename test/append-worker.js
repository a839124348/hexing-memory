/**
 * append-worker.js — 子进程追加工人（给 unit-append.js 做多进程写锁测试）
 * 用法：node append-worker.js <root> <prefix> <count>
 */
const path = require('path');
const { Store } = require(path.join(__dirname, '..', 'src', 'store'));

const root = process.argv[2];
const prefix = process.argv[3];
const count = Number(process.argv[4] || 100);
const store = new Store(root);

for (let i = 0; i < count; i++) {
  const r = store.append([{
    t: '2026-11-07 23:30',
    s: '用户',
    c: prefix + '-' + i,
    cid: 'cid-' + prefix,
    v: 1,
    type: 'human',
    origin: 'human',
  }]);
  if (!r.ok) {
    console.error('FAIL', prefix, i, JSON.stringify(r.errors));
    process.exit(1);
  }
}
console.log('DONE', prefix, count);
