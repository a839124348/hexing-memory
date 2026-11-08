/**
 * bench-100k.js — 10 万条性能压测（不调 embed，只测真追加 + 向量扫描）
 *
 * 用法：node test/bench-100k.js
 *
 * 说明：向量部分用固定 512 维 int8 向量模拟已建好的索引，
 * 测的是“进程内扫描 10 万条”的 CPU 耗时；embed 服务往返另算（正常几十 ms）。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');

const root = path.join(__dirname, '.tmp-bench-100k');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

function fmt(n) { return Math.round(n) + 'ms'; }

function makeRecords(n, prefix) {
  const out = [];
  // 固定同一分钟：压测只看条数/扫描，不依赖时间分布
  const t = '2026-11-08 00:00';
  for (let i = 0; i < n; i++) {
    out.push({
      t, s: i % 2 ? '用户' : '助手', c: prefix + '-' + i + ' 这是一条用于性能压测的记忆原文。',
      cid: 'cid-' + (i % 100), v: 1, type: i % 2 ? 'human' : 'ai', origin: i % 2 ? 'human' : 'ai',
      mid: prefix + '-mid-' + i,
    });
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

function makeVec(seed) {
  const v = new Int8Array(512);
  let x = seed >>> 0;
  for (let i = 0; i < 512; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    v[i] = (x % 255) - 127;
  }
  return v;
}

const store = new Store(root);

// 1. 10 万条真追加（每批 1000，模拟真实提炼批次）
const recs = makeRecords(100000, 'bench');
const t0 = Date.now();
for (let i = 0; i < recs.length; i += 1000) {
  const r = store.append(recs.slice(i, i + 1000), { checkSimilar: false });
  if (!r.ok) { console.error('append failed', i, r.errors); process.exit(1); }
}
const writeMs = Date.now() - t0;
console.log('写入 100000 条：' + fmt(writeMs) + '（' + (writeMs / 100000 * 1000).toFixed(1) + ' µs/条）');

// 2. 读 10 万条
const t1 = Date.now();
const dayRows = store.readDay('2026-11-08');
const readMs = Date.now() - t1;
console.log('读回 ' + dayRows.length + ' 条：' + fmt(readMs));

// 3. 向量扫描 10k / 100k
const vecs = new Array(100000);
for (let i = 0; i < vecs.length; i++) vecs[i] = makeVec(i + 1);
const q = makeVec(999999);

function scan(n) {
  const t = Date.now();
  let best = -1, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const s = cosine(q, vecs[i]);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return { ms: Date.now() - t, best, bestScore };
}

const s10k = scan(10000);
const s100k = scan(100000);
console.log('扫描 10000 条：' + fmt(s10k.ms) + '（top1=' + s10k.best + '）');
console.log('扫描 100000 条：' + fmt(s100k.ms) + '（top1=' + s100k.best + '）');

// 4. 结论
const ok = s100k.ms < 1000;
console.log('\n10 万条单次扫描 ' + fmt(s100k.ms) + '，' + (ok ? 'PASS' : 'FAIL') + '（目标 < 1000ms，不含 embed 往返）');
process.exit(ok ? 0 : 1);
