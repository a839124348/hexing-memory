/**
 * topics.js — 创意池 / 话题栈（MVP 第一版）
 *
 * 用户 2026-11-08 定：
 * - 想法不需要相关；同类型的想法累计 ≥5 条 → 成立一条“创意池”链，一个节点一个想法。
 * - 创意池是项目来源；想法立项时，从池里升格出独立项目链，原想法保留并挂 promoted_to。
 * - 池按月轮转：创意池-YYYY-MM；想法很多也不会每个想法一条链。
 *
 * 数据：common/topics.json（独立锁 .topics.lock，避免和链网写锁互相等）
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const THRESHOLD = 5;
const MAX_ITEMS = 500;

function safeName(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
}

function monthOf(t) {
  const s = String(t || '');
  return TIME_RE.test(s) ? s.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

// 幂等键只认时间和原文：LLM 同一批想法可能一次给 who=""、一次给 who="你"，
// 带上 who 会把同一个想法记两遍（真机创意池 10 条 = 5 条想法 × 2）。
function itemKey(it) {
  return [it.t, it.text].join('\u0000');
}

class TopicStore {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, 'common');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'topics.json');
  }

  _read() {
    if (!fs.existsSync(this.file)) return { version: 1, topics: [] };
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { version: 1, topics: Array.isArray(o.topics) ? o.topics : [] };
    } catch (e) {
      return { version: 1, topics: [] };
    }
  }

  _write(data) {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _locked(fn) {
    return withWriteLock(this.root, fn, { name: '.topics.lock' });
  }

  list() {
    return this._read().topics;
  }

  get(id) {
    return this._read().topics.find((t) => t.id === id) || null;
  }

  stats() {
    const topics = this.list();
    return {
      total: topics.length,
      open: topics.filter((t) => t.status === 'open').length,
      promoted: topics.filter((t) => t.status === 'promoted').length,
      closed: topics.filter((t) => t.status === 'closed').length,
    };
  }

  /** 把话题里的想法追加到链；已存在的节点按 (t,text) 跳过（who 不参与，理由见 itemKey） */
  _appendToChain(topic, chainStore, chainName, header) {
    if (!chainStore.get(chainName)) {
      chainStore.create(chainName, topic.type, header);
    } else if (header && !chainStore.get(chainName).header) {
      chainStore.setHeader(chainName, header, { by: 'source' });
    }
    const chain = chainStore.get(chainName);
    const seen = new Set(((chain && chain.nodes) || []).map((n) => [n.t, n.text].join('\u0000')));
    const fresh = [];
    for (const it of topic.items) {
      const k = itemKey(it);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push({
        t: it.t, who: it.who || '', type: 'event', text: it.text,
        source: 'topic:' + topic.id,
      });
    }
    if (fresh.length) chainStore.append(chainName, fresh);
    return fresh.length;
  }

  /**
   * LLM 输出格式：topics = [{type,title,summary,items:[{t,who,text}]}]
   * 先摊平成 items 再走 apply。
   */
  applyTopics(topics, chainStore) {
    const items = [];
    for (const t of (topics || [])) {
      const type = t && t.type ? t.type : '想法';
      const title = t && t.title ? t.title : '';
      const summary = t && t.summary ? t.summary : '';
      for (const it of ((t && t.items) || [])) {
        items.push({ type, title, summary, t: it.t, who: it.who, text: it.text });
      }
    }
    return this.apply(items, chainStore);
  }

  /**
   * 合并一批话题条目；≥5 条的 open 话题升格为链。
   * @param {Array} items [{type,title,summary,t,who,text}]
   * @param {ChainStore} chainStore
   * @returns {{ok, added, topics, promoted}}
   */
  apply(items, chainStore) {
    const now = new Date().toISOString();
    const clean = (items || []).map((x) => {
      const type = safeName(x.type || '想法') || '想法';
      let title = safeName(x.title || '');
      const t = String(x.t || '');
      if (!TIME_RE.test(t)) return null;
      const text = String(x.text || '').trim().slice(0, 500);
      if (!text) return null;
      // 想法类强制按月入池：一个节点一个想法，不为每个想法建链
      if (type === '想法') title = '创意池-' + monthOf(t);
      if (!title) title = type + '池-' + monthOf(t);
      return {
        type, title, t,
        who: ['你', '我', '我们'].includes(x.who) ? x.who : '',
        summary: String(x.summary || '').trim().slice(0, 500),
        text,
      };
    }).filter(Boolean);

    if (!clean.length) return { ok: true, added: 0, topics: [], promoted: [] };

    // 1) 合并进 topics.json（只锁话题文件）
    const result = this._locked(() => {
      const data = this._read();
      const added = [];
      const touched = new Set();
      for (const it of clean) {
        const key = it.type + '\u0000' + it.title;
        let topic = data.topics.find((t) => (t.type + '\u0000' + t.title) === key);
        if (!topic) {
          topic = {
            id: 'tp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            type: it.type,
            title: it.title,
            summary: '',
            status: 'open',
            items: [],
            count: 0,
            chain: '',
            createdAt: now,
            updatedAt: now,
            closedReason: '',
            mergedInto: '',
          };
          data.topics.push(topic);
        }
        if (it.summary) topic.summary = it.summary;
        const k = itemKey(it);
        if (!topic.items.some((x) => itemKey(x) === k)) {
          if (topic.items.length >= MAX_ITEMS) continue;
          topic.items.push({ t: it.t, who: it.who, text: it.text, promoted_to: '' });
          topic.count = topic.items.length;
          added.push(k);
        }
        topic.updatedAt = now;
        touched.add(topic.id);
      }
      this._write(data);
      return { added: added.length, touched: [...touched] };
    });

    // 2) 已升格的池：新想法继续追加；未达标的池：≥5 才升格
    const promoted = [];
    if (chainStore) {
      for (const id of result.touched) {
        const topic = this.get(id);
        if (!topic) continue;
        const header = String(topic.summary || (topic.title + '：' + topic.count + ' 条')).slice(0, 500);

        if (topic.chain && chainStore.get(topic.chain)) {
          this._appendToChain(topic, chainStore, topic.chain, header);
          continue;
        }
        if (topic.count < THRESHOLD) continue;

        this._appendToChain(topic, chainStore, topic.title, header);
        this._locked(() => {
          const data = this._read();
          const t = data.topics.find((x) => x.id === id);
          if (t) {
            t.chain = topic.title;
            t.status = 'promoted';
            t.updatedAt = new Date().toISOString();
            this._write(data);
          }
        });
        promoted.push(topic.title);
      }
    }

    return { ok: true, added: result.added, topics: result.touched, promoted };
  }

  /**
   * 想法立项：从池里把一个想法升格成独立项目链，原想法保留并挂 promoted_to。
   * @param {string} topicId
   * @param {number} itemIndex
   * @param {string} projectName 例如「光轴项目」
   * @param {ChainStore} chainStore
   */
  promote(topicId, itemIndex, projectName, chainStore) {
    const topic = this.get(topicId);
    if (!topic) return { ok: false, error: '话题不存在：' + topicId };
    const it = topic.items[itemIndex];
    if (!it) return { ok: false, error: '想法索引不存在：' + itemIndex };
    if (it.promoted_to) return { ok: true, existed: true, chain: it.promoted_to };

    const name = safeName(projectName) || ('项目链-' + safeName(it.text).slice(0, 20));
    if (!chainStore.get(name)) {
      chainStore.create(name, '项目', '来源：' + topic.title);
    }
    const chain = chainStore.get(name);
    const exists = ((chain && chain.nodes) || []).some((n) => n.t === it.t && n.text === it.text);
    if (!exists) {
      chainStore.append(name, [{
        t: it.t, who: it.who || '', type: 'event', text: it.text,
        source: 'topic:' + topic.id,
      }]);
    }

    this._locked(() => {
      const data = this._read();
      const t = data.topics.find((x) => x.id === topicId);
      if (t && t.items[itemIndex]) {
        t.items[itemIndex].promoted_to = name;
        t.updatedAt = new Date().toISOString();
        this._write(data);
      }
    });

    return { ok: true, topic: topicId, item: itemIndex, chain: name };
  }

  close(topicId, reason) {
    return this._locked(() => {
      const data = this._read();
      const t = data.topics.find((x) => x.id === topicId);
      if (!t) return { ok: false, error: '话题不存在：' + topicId };
      t.status = 'closed';
      t.closedReason = String(reason || '').slice(0, 300);
      t.updatedAt = new Date().toISOString();
      this._write(data);
      return { ok: true, id: topicId };
    });
  }

  merge(topicId, intoId) {
    return this._locked(() => {
      const data = this._read();
      const t = data.topics.find((x) => x.id === topicId);
      const into = data.topics.find((x) => x.id === intoId);
      if (!t || !into) return { ok: false, error: '话题不存在' };
      if (t.id === into.id) return { ok: false, error: '不能合并到自己' };
      const seen = new Set(into.items.map((x) => itemKey(x)));
      for (const it of t.items) {
        if (!seen.has(itemKey(it))) into.items.push(it);
      }
      into.count = into.items.length;
      into.updatedAt = new Date().toISOString();
      t.status = 'merged';
      t.mergedInto = into.id;
      t.updatedAt = into.updatedAt;
      this._write(data);
      return { ok: true, from: topicId, into: intoId, count: into.count };
    });
  }
}

module.exports = { TopicStore, THRESHOLD, monthOf };
