/**
 * unit-lock.js — 写锁：正常释放、陈旧回收、超时
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock, LOCK_NAME } = require('../src/lock');

const root = path.join(__dirname, '.tmp-lock');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};
const lockFile = path.join(root, LOCK_NAME);

// 1. 正常获取/释放
let ran = false;
withWriteLock(root, () => { ran = true; });
check('锁内函数执行', ran);
check('锁已释放', !fs.existsSync(lockFile));

// 2. 陈旧锁：PID 不存在 + 时间很旧 → 可抢占
fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: '2000-01-01T00:00:00.000Z' }), 'utf8');
let staleOk = false;
try {
  withWriteLock(root, () => { staleOk = true; }, { timeoutMs: 500 });
} catch (e) { /* 失败 */ }
check('陈旧锁可抢占', staleOk && !fs.existsSync(lockFile), fs.existsSync(lockFile) ? 'lock still exists' : '');

// 3. 活锁：当前 PID 持有，短超时必须 LOCK_TIMEOUT，且不误删别人的锁
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
let timedOut = false;
try {
  withWriteLock(root, () => { /* 不该执行 */ }, { timeoutMs: 120 });
} catch (e) {
  timedOut = e && e.code === 'LOCK_TIMEOUT';
}
check('活锁会超时', timedOut);
check('超时不误删锁', fs.existsSync(lockFile));
try { fs.unlinkSync(lockFile); } catch (e) { /* ignore */ }

console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
