/**
 * chain.js — 链网存储层
 *
 * 结构（按用户 2026-11-07 定）：
 *
 *   核星（中心 = AI 的自我）
 *   ├─ 项目（父节点）
 *   │   └─ 项目链-xxx
 *   └─ 身份（父节点）
 *       └─ 身份链（用户链 + 助手链 + 关系链 的合并版）
 *           ├─ 头部：双方详细档案（爱好、性格、经历概览）
 *           └─ 节点：具体故事（时间序，带 who 区分你我他）
 *
 * 落盘：一条链一个 JSON 文件，文件名就是链名。
 *   data/links/核星.json
 *   data/links/身份.json
 *   data/links/身份链.json
 *
 * 为什么一条一个文件：可 diff、可单独备份、改一条不影响其他。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');

const MAX_HEADER = 500;          // 头部硬上限（建议 ≤200；常识层索引只取头部）
const MAX_NODES_PER_APPEND = 50; // 单次追加上限，防一次灌爆

// 顶层根固定九条；工具/LLM 只能挂到这些根或已有链，不能自己造新根。
const DEFAULT_ROOTS = new Set(['身份', '项目', '学习', '关系', '避坑', '存储', '想法', '日常', '约定链']);

class ChainStore {
  constructor(dataDir) {
    this.root = dataDir || path.join(__dirname, '..', 'data');
    this.dir = path.join(this.root, 'links');
    fs.mkdirSync(this.dir, { recursive: true });
    withWriteLock(this.root, () => this._ensureRoot());
  }

  _file(name) {
    // 链名直接当文件名，但要挡住路径穿越
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
    return path.join(this.dir, safe + '.json');
  }

  _read(name) {
    const f = this._file(name);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      return null;  // 坏文件当不存在（不崩）
    }
  }

  _write(obj) {
    const f = this._file(obj.name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    try {
      fs.renameSync(tmp, f);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  /** 核星：链网的根，代表 AI 的自我。不存在就建一个空的 */
  _ensureRoot() {
    if (this._read('核星')) return;
    this._write({
      name: '核星',
      parent: null,
      header: '链网的中心，代表我的自我。所有链都从这里展开。',
      nodes: [],
      createdAt: new Date().toISOString(),
    });
  }

  /** 建链（父节点不存在时先建父节点） */
  create(name, parent = null, header = '') {
    if (!name) throw new Error('链名不能为空');
    return withWriteLock(this.root, () => {
      const exist = this._read(name);
      if (exist) return { ok: true, existed: true, chain: exist };

      if (parent && !this._read(parent)) {
        this._write({
          name: parent, parent: '核星', header: '', nodes: [],
          headerNodeCount: 0, headerAt: '', headerBy: '',
          createdAt: new Date().toISOString(),
        });
      }

      const now = new Date().toISOString();
      const chain = {
        name,
        parent: parent || '核星',
        header: String(header || '').slice(0, MAX_HEADER),
        // header 基于多少节点；lazy/manual/source/system
        headerNodeCount: 0,
        headerAt: header ? now : '',
        headerBy: header ? 'system' : '',
        nodes: [],
        createdAt: now,
        updatedAt: now,
      };
      this._write(chain);
      return { ok: true, existed: false, chain };
    });
  }

  /** 读一条链（含头部和节点） */
  get(name) {
    return this._read(name);
  }

  /**
   * 校验“把新链挂到 parent 下”是否合法。
   * 只允许核星或已有链；深度按 核星=0、默认根=1 计算，新链最多第 4 层。
   * @returns {{ok:boolean, parent?:string, depth?:number, error?:string, hint?:string}}
   */
  checkParent(parent = '核星', maxDepth = 4) {
    const p = String(parent || '核星').trim() || '核星';
    if (p === '核星') return { ok: true, parent: p, depth: 1 };
    let cur = this._read(p);
    if (!cur) {
      return {
        ok: false,
        parent: p,
        error: '父链不存在：' + p,
        hint: '只能挂到「核星」、九个默认根或已有链；不要新建顶层根。',
      };
    }
    let d = 0;
    let guard = 0;
    while (cur && guard++ < 10) {
      d++;
      if (!cur.parent || cur.parent === '核星') break;
      cur = this._read(cur.parent);
    }
    const depth = d + 1;
    if (depth > maxDepth) {
      return {
        ok: false,
        parent: p,
        depth,
        error: '链层级超过 ' + maxDepth + ' 层',
        hint: '把新内容并入已有子链，不要再往下挂。',
      };
    }
    return { ok: true, parent: p, depth };
  }

  /** 列出某个父节点下的子链；不传 parent 就列全部 */
  list(parent = null) {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (parent === null || c.parent === parent) {
          const nodeCount = (c.nodes || []).length;
          const headerNodeCount = Number(c.headerNodeCount || 0);
          out.push({
            name: c.name,
            parent: c.parent,
            header: c.header,
            nodes: nodeCount,
            headerNodeCount,
            headerAt: c.headerAt || '',
            headerBy: c.headerBy || '',
            needHeader: nodeCount >= 5 && !c.header,
            needRefresh: !!c.header && c.headerBy !== 'manual' && (nodeCount - headerNodeCount) >= 5,
            updatedAt: c.updatedAt,
          });
        }
      } catch (e) { /* 跳过坏文件 */ }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** 设置/重算头部（派生视图，可覆盖；记录基于多少节点、谁写的） */
  setHeader(name, text, meta = {}) {
    return withWriteLock(this.root, () => {
      const c = this._read(name);
      if (!c) return { ok: false, error: '链不存在：' + name };
      c.header = String(text || '').slice(0, MAX_HEADER);
      c.headerNodeCount = Number.isFinite(meta.nodeCount) ? Number(meta.nodeCount) : (c.nodes || []).length;
      c.headerAt = new Date().toISOString();
      c.headerBy = c.header ? (meta.by || 'manual') : '';
      c.updatedAt = c.headerAt;
      this._write(c);
      return {
        ok: true, name, header: c.header,
        headerNodeCount: c.headerNodeCount, headerAt: c.headerAt, headerBy: c.headerBy,
      };
    });
  }

  /**
   * 追加节点（只追加，不覆盖历史）
   * @param {string} name 链名
   * @param {object} node { t, who, type, text, source }
   */
  append(name, node) {
    return withWriteLock(this.root, () => {
      const c = this._read(name);
      if (!c) return { ok: false, error: '链不存在：' + name + '（先用 create 建链）' };

      const list = Array.isArray(node) ? node : [node];
      if (list.length > MAX_NODES_PER_APPEND) {
        return { ok: false, error: '一次最多追加 ' + MAX_NODES_PER_APPEND + ' 个节点' };
      }

      const added = [];
      for (const n of list) {
        const text = String((n && n.text) || '').trim();
        if (!text) continue;
        const item = {
          t: String(n.t || '').trim() || new Date().toISOString().slice(0, 16).replace('T', ' '),
          who: ['我', '你', '我们'].includes(n.who) ? n.who : '',
          type: n.type === 'state' ? 'state' : 'event',
          text,
          source: String(n.source || '').slice(0, 120),
          superseded: false,
        };
        // 状态节点：同一条链里，之前同主题的旧状态标 superseded
        // （只做最简单的判定：who 相同 + type=state，不猜语义——
        //   真正的"是否同一主题"应该由调用方用 supersedes 字段显式指出）
        if (item.type === 'state' && n.supersedes) {
          for (const old of c.nodes) {
            if (old.type === 'state' && !old.superseded && String(old.text).includes(String(n.supersedes))) {
              old.superseded = true;
            }
          }
        }
        c.nodes.push(item);
        added.push(item);
      }

      c.updatedAt = new Date().toISOString();
      this._write(c);

      // 节点 ≥5 且还没头部 → 提示该建头部了（不自动生成，需要 LLM 或人写）
      const needHeader = c.nodes.length >= 5 && !c.header;
      const needRefresh = !!c.header && c.headerBy !== 'manual'
        && (c.nodes.length - Number(c.headerNodeCount || 0)) >= 5;
      return {
        ok: true, name, added: added.length, total: c.nodes.length,
        needHeader, needRefresh,
        headerNodeCount: Number(c.headerNodeCount || 0), headerBy: c.headerBy || '',
      };
    });
  }

  /** 整棵树（从核星往下） */
  tree() {
    const all = this.list();
    const byParent = new Map();
    for (const c of all) {
      if (!byParent.has(c.parent)) byParent.set(c.parent, []);
      byParent.get(c.parent).push(c);
    }
    const walk = (parent, depth) => {
      if (depth > 5) return [];
      const kids = byParent.get(parent) || [];
      return kids.map((k) => ({ ...k, children: walk(k.name, depth + 1) }));
    };
    const root = this._read('核星');
    return {
      根: root ? { name: root.name, header: root.header } : null,
      树: walk('核星', 0),
    };
  }

  /** 健康检查：孤儿链（父节点不存在）、空链、超长头部 */
  audit() {
    const all = this.list();
    const names = new Set(all.map((c) => c.name));
    // 核星自己 parent=null，不能算孤儿
    const orphans = all.filter((c) => c.parent !== null && c.parent !== '核星' && !names.has(c.parent));
    const empty = all.filter((c) => c.nodes === 0);
    const longHeader = [];
    for (const c of all) {
      const full = this._read(c.name);
      if (full && String(full.header || '').length > MAX_HEADER) longHeader.push(c.name);
    }
    return { 总数: all.length, 孤儿链: orphans.map((c) => c.name), 空链: empty.map((c) => c.name), 头部超长: longHeader };
  }
}

module.exports = { ChainStore, MAX_HEADER, DEFAULT_ROOTS };
