/**
 * group-board.js — 群友 24h 分板
 *
 * 只存“这个群 + 这个群友”的 @ 会话，不存群房间公共上下文。
 * - 每个群友一个 JSONL：qq/groups/<gid>/members/<uid>.jsonl
 * - 读写时 prune 超过 24h 的记录
 * - 空板删文件；不建群级消息日志
 *
 * 这不是主记忆：不进 raw、不进链、不做向量。
 */

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

function safe(v) {
  return String(v || '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 80) || 'unknown';
}

function localAt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class GroupBoard {
  constructor({ root, ttlMs = DAY_MS, now = Date.now, maxText = 4000 } = {}) {
    if (!root) throw new Error('GroupBoard 需要 root');
    this.root = root;
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxText = maxText;
  }

  fileFor(gid, uid) {
    return path.join(this.root, 'groups', safe(gid), 'members', safe(uid) + '.jsonl');
  }

  _read(file) {
    if (!fs.existsSync(file)) return [];
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && Number.isFinite(r.ts) && typeof r.text === 'string') rows.push(r);
      } catch (e) { /* 跳过坏行 */ }
    }
    return rows;
  }

  _write(file, rows) {
    if (!rows.length) {
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
      this._cleanup(file);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  _cleanup(file) {
    for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch (e) { /* ignore */ }
    }
  }

  _prune(rows, now) {
    const cutoff = now - this.ttlMs;
    return rows.filter((r) => r.ts >= cutoff);
  }

  append({ gid, uid, role, text, mid = '', ts } = {}) {
    const body = String(text || '').trim().slice(0, this.maxText);
    if (!gid || !uid || !body) return { ok: false, error: '缺 gid/uid/text' };
    const now = this.now();
    const file = this.fileFor(gid, uid);
    const rows = this._prune(this._read(file), now);
    rows.push({
      ts: Number(ts) || now,
      at: localAt(Number(ts) || now),
      role: role === 'assistant' ? 'assistant' : 'user',
      text: body,
      mid: String(mid || ''),
    });
    this._write(file, rows);
    return { ok: true, kept: rows.length };
  }

  recent({ gid, uid, limit = 20 } = {}) {
    if (!gid || !uid) return [];
    const now = this.now();
    const rows = this._prune(this._read(this.fileFor(gid, uid)), now);
    return rows.slice(-Math.max(1, Math.min(50, limit)));
  }

  prune({ gid, uid } = {}) {
    if (!gid || !uid) return { ok: false, error: '缺 gid/uid' };
    const file = this.fileFor(gid, uid);
    const rows = this._prune(this._read(file), this.now());
    this._write(file, rows);
    return { ok: true, kept: rows.length };
  }

  /** 全量清扫：删掉所有超过 24h 的板，不依赖有没有人读写。 */
  sweep() {
    const result = { ok: true, scanned: 0, kept: 0, prunedFiles: 0 };
    const groupsDir = path.join(this.root, 'groups');
    if (!fs.existsSync(groupsDir)) return result;

    for (const g of fs.readdirSync(groupsDir, { withFileTypes: true })) {
      if (!g.isDirectory()) continue;
      const membersDir = path.join(groupsDir, g.name, 'members');
      if (!fs.existsSync(membersDir)) continue;

      for (const m of fs.readdirSync(membersDir, { withFileTypes: true })) {
        if (!m.isFile() || !m.name.endsWith('.jsonl')) continue;
        const file = path.join(membersDir, m.name);
        const rows = this._prune(this._read(file), this.now());
        result.scanned++;
        if (rows.length) {
          result.kept += rows.length;
          this._write(file, rows);
        } else {
          result.prunedFiles++;
          this._write(file, []);
        }
      }

      try {
        if (fs.existsSync(membersDir) && fs.readdirSync(membersDir).length === 0) fs.rmdirSync(membersDir);
      } catch (e) { /* ignore */ }
      try {
        const groupDir = path.join(groupsDir, g.name);
        if (fs.existsSync(groupDir) && fs.readdirSync(groupDir).length === 0) fs.rmdirSync(groupDir);
      } catch (e) { /* ignore */ }
    }

    try {
      if (fs.readdirSync(groupsDir).length === 0) fs.rmdirSync(groupsDir);
    } catch (e) { /* ignore */ }
    return result;
  }
}

module.exports = { GroupBoard, DAY_MS, localAt };
