#!/usr/bin/env node
/**
 * suggest-chain-time.js — 从 DSH 会话里找 memory_chain append 的真实本地时间
 *
 * 只读扫描 ~/.dsh/sessions 下的 jsonl.zstd，找：
 *   type=tool/call, data.name=memory_chain, action=append
 * 且节点**没有传 t**（这类节点才可能是 UTC 截断）。
 * 用工具调用事件的 epoch ms 转本地时间，输出 map 给 fix-chain-time.js。
 *
 * 用法：
 *   node repair/tools/suggest-chain-time.js
 *   node repair/tools/suggest-chain-time.js --out map.json
 *   node repair/tools/suggest-chain-time.js --sessions "C:\Users\...\.dsh\sessions"
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function localMinute(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function frames(buf) {
  const pos = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) pos.push(i);
  }
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const start = pos[i];
    const end = i + 1 < pos.length ? pos[i + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')); } catch (e) { /* skip bad frame */ }
  }
  return out;
}

function walk(d, out = []) {
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}

const sessionsDir = arg('--sessions', path.join(os.homedir(), '.dsh', 'sessions'));
const outFile = arg('--out', '');
const files = walk(sessionsDir);
const map = new Map();
let calls = 0;
let ambiguous = 0;

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { continue; }
  for (const text of frames(buf)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"type":"tool/call"') || !line.includes('memory_chain')) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      if (!e || e.type !== 'tool/call' || !e.data || e.data.name !== 'memory_chain') continue;
      let args;
      try { args = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments; } catch (err) { continue; }
      if (!args || args.action !== 'append' || !args.name) continue;
      const nodes = Array.isArray(args.nodes) ? args.nodes : (args.node ? [args.node] : []);
      for (const n of nodes) {
        if (!n || !n.text || n.t) continue; // 只收“没传 t”的节点
        const key = args.name + '\u0000' + String(n.text);
        const t = localMinute(e.time);
        calls++;
        if (map.has(key)) {
          ambiguous++;
          // 同文本多次 append：保留最早一次（更接近原始写入）
          if (map.get(key).time > e.time) map.set(key, { chain: args.name, text: String(n.text), t, time: e.time });
        } else {
          map.set(key, { chain: args.name, text: String(n.text), t, time: e.time });
        }
      }
    }
  }
}

const rows = [...map.values()].map(({ chain, text, t }) => ({ chain, text, t }));
console.log(`扫描会话：${files.length} 个；append 节点（无 t）：${calls}；唯一匹配：${rows.length}；重复文本：${ambiguous}`);
for (const r of rows.slice(0, 20)) console.log(`- [${r.chain}] ${r.t} | ${r.text.slice(0, 80)}`);
if (rows.length > 20) console.log(`... 还有 ${rows.length - 20} 条`);

if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2), 'utf8');
  console.log('已写入：' + outFile);
}
