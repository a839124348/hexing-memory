/**
 * session-catalog.js — 扫描 DSH 会话目录，列出 id / 标题 / 工作目录
 *
 * 只读 session 头和 session/title 事件，不输出聊天内容。
 * 给 tools/list-sessions.js 和 QQ 桥的 qq_bind_session 工具共用。
 *
 * DSH 的会话日志是 jsonl.zstd，可能由多段 zstd frame 拼接；这里按帧魔数拆开。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFile(buf) {
  const pos = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      pos.push(i);
    }
  }
  if (!pos.length) {
    try {
      return zlib.zstdDecompressSync(buf).toString('utf8');
    } catch (e) {
      return '';
    }
  }
  let out = '';
  for (let i = 0; i < pos.length; i++) {
    const start = pos[i];
    const end = i + 1 < pos.length ? pos[i + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch (e) {
      // 跳过坏帧，能读多少算多少
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/^session.*\.jsonl(\.zstd)?$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function readSession(file) {
  let text = '';
  if (/\.zstd$/i.test(file)) {
    text = decodeFile(fs.readFileSync(file));
  } else {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return null;
    }
  }

  let meta = null;
  let title = '';
  let lastTime = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (ev.type === 'session' && ev.id) {
      meta = {
        id: String(ev.id),
        cwd: String(ev.cwd || ''),
        createdAt: Number(ev.createdAt) || 0,
        agentPreset: String(ev.agentPreset || ''),
      };
    } else if (ev.type === 'session/title' && ev.data && ev.data.title) {
      title = String(ev.data.title);
      lastTime = Math.max(lastTime, Number(ev.time) || 0);
    } else if (ev.time) {
      lastTime = Math.max(lastTime, Number(ev.time) || 0);
    }
  }
  if (!meta) return null;

  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch (e) {
    // ignore
  }
  return {
    id: meta.id,
    title: title || '（未命名）',
    cwd: meta.cwd,
    agentPreset: meta.agentPreset,
    createdAt: meta.createdAt,
    lastActive: lastTime || mtime,
    file,
  };
}

function listSessions(root) {
  const rows = [];
  for (const f of walk(root)) {
    const s = readSession(f);
    if (s) rows.push(s);
  }
  rows.sort((a, b) => b.lastActive - a.lastActive);
  return rows;
}

function localTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { listSessions, localTime };
