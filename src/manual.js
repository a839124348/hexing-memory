/**
 * manual.js — 说明书阅读进度（首次安装/升级强制通读）
 *
 * 为什么要有它：常驻摘要只有十几条，正文十六节；模型很容易只读开头和结尾。
 * 这里把 RULES.md 按“零、一、二……十六”切成节，记录读到哪一节；
 * 全部读完并 ack 之前，插件会在常识层里持续提示，并拒绝改链网/话题。
 *
 * 状态：common/manual-state.json（独立锁 .manual.lock，不碰 .write.lock）
 * 版本：RULES.md 全文 SHA-256 前 16 位；文件一改，进度自动归零。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withWriteLock } = require('./lock');

const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七'];
const NUM_ALT = NUM.slice().sort((a, b) => b.length - a.length).join('|');
const SECTION_RE = new RegExp('^##\\s+(' + NUM_ALT + ')、');

function parseSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (SECTION_RE.test(line)) {
        cur = { title: line.replace(/^##\s+/, '').trim(), lines: [] };
        out.push(cur);
      } else {
        cur = null;
      }
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out.map((s, i) => ({
    index: i,
    title: s.title,
    text: s.lines.join('\n').trim(),
    chars: s.lines.join('\n').trim().length,
  }));
}

class ManualReader {
  /**
   * @param {string} root 数据根目录（dsh-memory）
   * @param {string} rulesPath RULES.md 路径
   */
  constructor(root, rulesPath) {
    this.root = root;
    this.rulesPath = rulesPath;
    this.dir = path.join(root, 'common');
    this.stateFile = path.join(this.dir, 'manual-state.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _text() {
    return fs.readFileSync(this.rulesPath, 'utf8');
  }

  _hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  _readState() {
    try {
      const o = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return {
        version: String(o.version || ''),
        read: Array.isArray(o.read) ? o.read.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [],
        completedAt: String(o.completedAt || ''),
      };
    } catch (e) {
      return { version: '', read: [], completedAt: '' };
    }
  }

  _writeState(state) {
    const tmp = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  _snapshot() {
    const text = this._text();
    const sections = parseSections(text);
    const version = this._hash(text);
    const st = this._readState();
    const same = st.version === version;
    const read = same ? [...new Set(st.read.filter((i) => i < sections.length))].sort((a, b) => a - b) : [];
    const readSet = new Set(read);
    const missing = sections.filter((s) => !readSet.has(s.index));
    return {
      text, sections, version, state: st, same, read, readSet, missing,
      completed: same && !!st.completedAt && missing.length === 0,
    };
  }

  status() {
    const s = this._snapshot();
    return {
      ok: true,
      version: s.version,
      total: s.sections.length,
      read: s.read,
      readTitles: s.read.map((i) => s.sections[i].title),
      missing: s.missing.map((x) => x.title),
      completed: s.completed,
      completedAt: s.completed ? s.state.completedAt : '',
    };
  }

  toc() {
    const s = this._snapshot();
    return {
      ok: true,
      version: s.version,
      completed: s.completed,
      sections: s.sections.map((x) => ({
        index: x.index,
        title: x.title,
        chars: x.chars,
        read: s.readSet.has(x.index),
      })),
    };
  }

  /**
   * 读一节。section 省略 = 读下一节没读的；支持 0 起下标或标题片段。
   * 返回正文和进度；读到最后一节时提示 ack。
   */
  read(section) {
    return withWriteLock(this.root, () => {
      const s = this._snapshot();
      let idx = -1;
      if (section === undefined || section === null || section === '') {
        const next = s.sections.find((x) => !s.readSet.has(x.index));
        if (!next) {
          return { ok: false, error: '全部读完了，用 action=ack 标记完成', progress: s.read.length + '/' + s.sections.length };
        }
        idx = next.index;
      } else if (typeof section === 'number' || /^\d+$/.test(String(section))) {
        idx = Number(section);
      } else {
        const q = String(section).trim();
        const hit = s.sections.find((x) => x.title.includes(q));
        if (hit) idx = hit.index;
      }
      if (!Number.isInteger(idx) || idx < 0 || idx >= s.sections.length) {
        return {
          ok: false,
          error: '没有这一节：' + section,
          hint: '先用 action=toc 看 0–' + (s.sections.length - 1) + ' 的节号',
        };
      }

      const nextRead = [...new Set([...s.read, idx])].sort((a, b) => a - b);
      this._writeState({
        version: s.version,
        read: nextRead,
        completedAt: s.completed ? s.state.completedAt : '',
      });
      const sec = s.sections[idx];
      const missing = s.sections.length - nextRead.length;
      return {
        ok: true,
        index: idx,
        title: sec.title,
        text: sec.text,
        progress: nextRead.length + '/' + s.sections.length,
        ...(missing > 0
          ? { hint: '还有 ' + missing + ' 节；继续 action=read（不带 section 读下一节）' }
          : { hint: '已读完全部 ' + s.sections.length + ' 节；用 action=ack 标记完成' }),
      };
    });
  }

  /** 标记读完；必须真的每一节都读过，不能空口 ack */
  ack() {
    return withWriteLock(this.root, () => {
      const s = this._snapshot();
      if (s.sections.length === 0) {
        return { ok: false, error: 'RULES.md 没解析出任何章节，检查文件是否存在/标题格式' };
      }
      if (s.missing.length) {
        return {
          ok: false,
          error: '还有 ' + s.missing.length + ' 节没读，不能 ack',
          missing: s.missing.map((x) => x.title),
          hint: '用 action=toc 看进度，action=read 逐节读；不要跳读。',
        };
      }
      const at = new Date().toISOString();
      this._writeState({ version: s.version, read: s.read, completedAt: at });
      return { ok: true, completedAt: at, total: s.sections.length };
    });
  }

  /** 未读完时注入常识层的提示；读完返回空串 */
  onboardingText() {
    let s;
    try { s = this._snapshot(); } catch (e) { return ''; }
    if (s.completed) return '';
    const total = s.sections.length;
    const read = s.read.length;
    return [
      '## 首次使用（说明书未读完）',
      '- 当前 RULES 版本：' + s.version + '；进度：' + read + '/' + total + ' 节。',
      '- 在迁移旧数据、批量写入、改链网之前，必须先把 RULES.md 从头到尾读完；**不要只读开头和结尾**。',
      '- 读法：`memory_manual action=toc` 看目录 → `action=read`（不带 section 读下一节）→ 全部读完 `action=ack`。',
      '- 用户要从旧平台迁移：**由你（模型）检查源格式、写字段映射、跑导入器**；不要让用户手写 JSONL。先读第十节。',
      '- 用户可能第一次用 AI：不要让他跑命令/写 JSONL；你来做，只问“授权、点击、确认”。分工见第十七节。',
      '- 没读完时 `memory_chain append` / `memory_topic add` 会被拒绝；自动记录和检索不受影响。',
    ].join('\n');
  }

  /** 链网/话题写入前的闸门；RULES 读不到时放行，不阻塞正常使用 */
  gate() {
    let s;
    try { s = this.status(); } catch (e) { return { ok: true } }
    if (s.completed) return { ok: true };
    return {
      ok: false,
      error: '说明书还没读完（' + s.read.length + '/' + s.total + '），不能改链网/话题',
      hint: '先 memory_manual action=toc → action=read 逐节读 → action=ack；不要跳读。',
      missing: s.missing,
    };
  }
}

module.exports = { ManualReader, parseSections };
