/**
 * count-common.js — 数最近一个 DSH 会话里注入过几段常识层
 *
 * 用法：node test/count-common.js
 * 说明：这是“会话日志里出现过几段”，压缩后旧段可能被 shadow；
 *      模型上下文里以“可见段数”为准，日志数 >= 可见数。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');

function newestSession() {
  const root = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions');
  let best = null;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.v4.jsonl.zstd') {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs };
      }
    }
  })(root);
  return best && best.file;
}

function decompressAll(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let out = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch (err) { /* skip */ }
  }
  return out;
}

const file = newestSession();
if (!file) { console.log('没找到 DSH 会话文件'); process.exit(0); }
const lines = decompressAll(fs.readFileSync(file)).split(/\r?\n/).filter(Boolean);
let count = 0;
const ids = [];
let version = '';
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch (e) { continue; }
  if (o.type !== 'user/message') continue;
  const text = o.data && o.data.content && o.data.content[0] && o.data.content[0].text || '';
  if (!text.includes('memory-system:common')) continue;
  count++;
  if (o.data.id) ids.push(o.data.id);
  const m = /版本：([^\n]+)/.exec(text);
  if (m) version = m[1].trim();
}
console.log('会话：' + file);
console.log('日志里常识层段数：' + count);
console.log('id：' + (ids.join(', ') || '（无）'));
console.log('版本：' + (version || '（未找到）'));
