/**
 * lock.js — 跨进程写锁
 *
 * 为什么需要：tmp + rename 只能防“写一半撕裂”，防不了“两个进程同时读-改-写，
 * 后写的覆盖先写的”。草稿、存档、链网都可能有多个写入者（多开 DSH、星枢 + DSH）。
 *
 * 做法：数据目录下 `.write.lock`，O_EXCL 创建；内容写 PID + 时间。
 * - 读路径不拿锁。
 * - 写路径拿锁，finally 释放。
 * - 锁超过 30 秒且 PID 已不存在 → 视为陈旧，可抢占。
 * - 等锁超过 timeout（默认 15 秒）→ 抛 LOCK_TIMEOUT，由调用方决定报错还是保留重试。
 *
 * 注意：这是同步锁（store/draft 都是同步写），等待用 Atomics.wait，避免忙等烧 CPU。
 */
const fs = require('fs');
const path = require('path');

const LOCK_NAME = '.write.lock';
const STALE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 15 * 1000;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 退化为忙等，仅作兜底 */ }
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但没权限；ESRCH = 不存在
    return e && e.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 在写锁保护下执行同步函数。
 * @param {string} root 数据根目录（锁文件放在这里）
 * @param {Function} fn 同步写入函数
 * @param {object} opt { timeoutMs, staleMs }
 */
function withWriteLock(root, fn, opt = {}) {
  const timeoutMs = Number(opt.timeoutMs || DEFAULT_TIMEOUT_MS);
  const staleMs = Number(opt.staleMs || STALE_MS);
  const dir = root;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, opt.name || LOCK_NAME);
  const started = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      // Windows 上另一个进程持有锁文件时，openSync('wx') 可能报 EPERM 而不是 EEXIST；
      // 统一按“锁被占用”处理，继续走陈旧检查/等待。
      const contended = e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!contended) throw e;

      const info = readLock(file);
      const age = info && info.at ? Date.now() - Date.parse(info.at) : Infinity;
      const dead = !info || !pidAlive(info.pid);
      const stale = dead || (Number.isFinite(age) && age > staleMs && !pidAlive(info.pid));

      if (stale) {
        try { fs.unlinkSync(file); } catch (e2) { /* 别人已经清掉 */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        const err = new Error('写锁等待超时（' + timeoutMs + 'ms）');
        err.code = 'LOCK_TIMEOUT';
        throw err;
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      const info = readLock(file);
      if (info && info.pid === process.pid) fs.unlinkSync(file);
    } catch (e) { /* 锁文件已被清理，忽略 */ }
  }
}

module.exports = { withWriteLock, LOCK_NAME, STALE_MS };
