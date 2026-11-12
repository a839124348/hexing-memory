/**
 * refine.js — 提炼层（后勤总管）
 *
 * 三件职责（规划书第二节）：
 * 1. 把草稿量化入库（写进原始存档）
 * 2. 更新常识层（链网：会话节点 / 事件）
 * 3. 回流防护 + 失败重试（草稿不丢、成功的才移除）
 *
 * MVP 限制：不做 LLM 提炼，只用规则生成结构化节点（会话节点）。
 * 为什么不用 LLM：MVP 要能离线跑、零成本、可测试；LLM 版留到后续。
 * 但"链网更新"这件事本身已经在做——只是节点粒度是"会话"而不是"项目/关系"。
 */
const fs = require('fs');
const path = require('path');
const { contentHash } = require('./validate');
const { refineWithLLM } = require('./llm');
const { withWriteLock } = require('./lock');

const RECALL_MARK = '[记忆]';

class Refiner {
  constructor(root, store, draft) {
    this.root = root;
    this.store = store;
    this.draft = draft;
    this.commonDir = path.join(root, 'common');
    fs.mkdirSync(this.commonDir, { recursive: true });
    this.linksFile = path.join(this.commonDir, 'links.json');
    this.stateFile = path.join(this.commonDir, 'refine-state.json');
  }

  _atomicWrite(file, content) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  _readJson(file, def) {
    if (!fs.existsSync(file)) return def;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
  }

  /** 常识层：链网（会话节点 + 事件） */
  links() {
    return this._readJson(this.linksFile, { version: 1, sessions: [], events: [] });
  }

  state() {
    return this._readJson(this.stateFile, { runs: 0, lastRunAt: null, lastError: null, deadLetters: [] });
  }

  /** 读-改-写 state；LLM 那段不占锁，只有落盘瞬间拿锁 */
  _mutateState(fn) {
    return withWriteLock(this.commonDir, () => {
      const st = this.state();
      const result = fn(st);
      this._atomicWrite(this.stateFile, JSON.stringify(st, null, 1));
      return result;
    }, { name: '.refine.lock' });
  }

  /**
   * 提炼一次
   * @returns {{ ok, added, echoed, skipped, deadLetters, commonUpdated, error }}
   */
  run() {
    // 整段“读草稿 -> 入库 -> 写 state/links”只允许一个提炼者。
    // 锁名不能复用 store/draft/chain 的 .write.lock：run 内部会再拿那些锁，复用会死锁。
    return withWriteLock(this.commonDir, () => this._runLocked(), { name: '.refine.lock' });
  }

  _runLocked() {
    const st = this.state();
    st.runs++;
    st.lastRunAt = new Date().toISOString();

    const pending = this.draft.pending();
    if (!pending.length) {
      st.lastError = null;
      st.deadLetters = [];   // 没有待处理的，旧死信记录失去意义
      this._atomicWrite(this.stateFile, JSON.stringify(st, null, 1));
      return { ok: true, added: 0, echoed: 0, skipped: 0, deadLetters: [], commonUpdated: false };
    }

    // 1) 回流剔除：显式标记或 origin=recall_echo 直接丢，不进正式库
    // 主动唤醒（origin=wake）保留：它是 AI 侧的互动，也要进 raw/链网；
    // 提炼提示词会把它当“AI 主动表达”，不据此推断用户状态。
    const clean = [];
    let echoed = 0;
    for (const r of pending) {
      if (String(r.c).includes(RECALL_MARK) || r.origin === 'recall_echo') { echoed++; continue; }
      clean.push(r);
    }
    // 回流的也要从草稿移除（它们永远不该入库）
    const echoedRecs = pending.filter((r) => String(r.c).includes(RECALL_MARK) || r.origin === 'recall_echo');
    if (echoedRecs.length) this.draft.remove(echoedRecs);

    if (!clean.length) {
      this._atomicWrite(this.stateFile, JSON.stringify(st, null, 1));
      return { ok: true, added: 0, echoed, skipped: pending.length, deadLetters: [], commonUpdated: false };
    }

    // 2) 对比去重：和存档已有记录比一遍，只追加"还没提炼过的那部分"。
    //    为什么必须先做：store.append 遇到已存在的记录会**整批拒绝**，
    //    如果不先过滤，草稿里只要有一条历史重复，这一批就永远清不掉（死循环）。
    const days = new Set(clean.map((r) => String(r.t).slice(0, 10)));
    const existing = new Set();
    for (const d of days) {
      for (const row of this.store.readDay(d)) {
        try { existing.add(contentHash(row)); } catch (e) { /* 老数据无 cid，忽略 */ }
      }
    }
    const alreadyStored = [];
    const fresh = [];
    for (const r of clean) {
      let h = null;
      try { h = contentHash(r); } catch (e) { h = null; }
      if (h && existing.has(h)) alreadyStored.push(r);
      else fresh.push(r);
    }
    // 已存在的直接从草稿摘掉（它们不会再有变化），避免反复重试
    if (alreadyStored.length) this.draft.remove(alreadyStored);
    if (!fresh.length) {
      st.lastError = null;
      this._atomicWrite(this.stateFile, JSON.stringify(st, null, 1));
      return {
        ok: true, added: 0, echoed, skipped: pending.length - fresh.length,
        alreadyStored: alreadyStored.length, deadLetters: [], commonUpdated: false,
      };
    }

    // 3) 按天分组入库（某天失败只影响那一天，其他天照常推进）
    const byDay = new Map();
    for (const r of fresh) {
      const d = String(r.t).slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }

    let added = 0;
    const deadLetters = [];
    const succeeded = [];
    for (const [day, list] of byDay) {
      // checkSimilar:false —— 近似判重**只用于导入历史数据**（规划书第三节）。
      // 日常对话里「我喜欢吃西瓜」和「你喜欢吃什么」相似度就超 0.8，
      // 开着会把整批提炼打回死信（2026-11-06 实测：36 条被误杀）。
      const r = this.store.append(list, { checkSimilar: false });
      if (r.ok) {
        added += r.added;
        succeeded.push(...list);
      } else {
        // 入库失败：这批留在草稿里，下轮重试；记死信便于排查
        deadLetters.push({ day, count: list.length, errors: (r.errors || []).slice(0, 3) });
      }
    }
    if (succeeded.length) this.draft.remove(succeeded);

    // 3) 更新常识层（只对成功入库的记录）
    let commonUpdated = false;
    if (succeeded.length) {
      commonUpdated = this._updateCommon(succeeded);
    }

    st.lastError = deadLetters.length ? JSON.stringify(deadLetters).slice(0, 500) : null;
    // 成功时必须清空旧死信（否则报错会一直挂着，误导排查）
    st.deadLetters = deadLetters;
    this._atomicWrite(this.stateFile, JSON.stringify(st, null, 1));

    return {
      ok: deadLetters.length === 0,
      added,
      echoed,
      alreadyStored: alreadyStored.length,
      skipped: pending.length - fresh.length,
      deadLetters,
      commonUpdated,
      // 本次真正入库的记录（供插件做链网提取；不返回整批，避免调用方误用未入库的）
      records: succeeded,
    };
  }

  /**
   * 带 LLM 的提炼：先走 run() 入库，再把本批记录（含上次 LLM 失败的待补记录）
   * 交给 LLM 提炼成链网节点。
   *
   * 为什么先入库：记忆原文不能因为 LLM 挂了就卡在草稿里；
   * 链更新失败时把记录放进 state.llmPending，下次继续补链，不丢原文。
   * 幂等由 applyChainUpdates 保证（同名链不重建、同节点不重复追加）。
   *
   * @param {Function} call ({system,user}) => Promise<string>
   * @param {ChainStore} chainStore
   */
  async runWithLLM(call, chainStore, topicStore) {
    const base = this.run();
    const st = this.state();
    const pending = Array.isArray(st.llmPending) ? st.llmPending : [];
    const fresh = [...pending, ...(base.records || [])];

    if (!call || !fresh.length) {
      return { ...base, llm: { chains: 0, nodes: 0, topics: [], topicItems: 0 } };
    }

    try {
      const r = await refineWithLLM({
        records: fresh,
        chainStore,
        topicStore,
        call,
        fallbackT: fresh[fresh.length - 1].t,
      });
      this._mutateState((cur) => {
        cur.llmPending = [];
        cur.lastLlmError = null;
        cur.lastLlmAt = new Date().toISOString();
      });
      return {
        ...base,
        llm: {
          chains: r.chains,
          nodes: r.nodes,
          topics: r.topics || [],
          topicItems: r.topicItems || 0,
        },
      };
    } catch (e) {
      // 原文已入库；链没建成，记录留在 llmPending，下次补
      const err = {
        at: new Date().toISOString(),
        stage: e && e.stage ? e.stage : 'LLM',
        message: String((e && e.message) || e).slice(0, 500),
      };
      this._mutateState((cur) => {
        cur.llmPending = fresh.slice(-200);
        cur.lastLlmError = err;
      });
      st.llmPending = fresh.slice(-200);
      st.lastLlmError = err;
      return { ...base, llm: { chains: 0, nodes: 0 }, llmError: st.lastLlmError };
    }
  }

  /**
   * 更新链网：每个会话（cid）一条会话节点，记录起止时间、条数、首句节选
   * 会话节点是"事件"的骨架；项目/关系节点留给 LLM 版
   */
  _updateCommon(records) {
    return withWriteLock(this.commonDir, () => {
      const links = this.links();
      const byCid = new Map();
      for (const r of records) {
        if (!byCid.has(r.cid)) byCid.set(r.cid, []);
        byCid.get(r.cid).push(r);
      }
      let changed = false;
      for (const [cid, list] of byCid) {
        const sorted = list.slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const date = String(first.t).slice(0, 10);
        const existing = links.sessions.find((x) => x.cid === cid);
        const node = {
          cid,
          date,
          firstT: first.t,
          lastT: last.t,
          count: sorted.length,
          speakers: [...new Set(sorted.map((x) => x.s))],
          head: String(first.c).slice(0, 40),
        };
        if (existing) {
          // 会话是持续追加的：合并计数与起止
          existing.firstT = existing.firstT < first.t ? existing.firstT : first.t;
          existing.lastT = existing.lastT > last.t ? existing.lastT : last.t;
          existing.count += sorted.length;
          existing.speakers = [...new Set(existing.speakers.concat(node.speakers))];
          changed = true;
        } else {
          links.sessions.push(node);
          links.events.push({ t: first.t, type: 'session_start', cid, note: '新会话：' + node.head });
          changed = true;
        }
      }
      if (changed) {
        // 只保留最近 500 个会话节点，防无限膨胀
        links.sessions = links.sessions.slice(-500);
        links.events = links.events.slice(-2000);
        this._atomicWrite(this.linksFile, JSON.stringify(links, null, 1));
      }
      return changed;
    }, { name: '.refine-links.lock' });
  }

  /** 常识层读取（给启动加载用） */
  commonBundle() {
    const links = this.links();
    // 身份文件：规范叫 IDENTITY.md；兼容早期的 profile.md
    const idFile = path.join(this.commonDir, 'IDENTITY.md');
    const legacy = path.join(this.commonDir, 'profile.md');
    const profileFile = fs.existsSync(idFile) ? idFile : legacy;
    const profile = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : '';
    return {
      profile,
      profilePath: profileFile,
      links,
      state: this.state(),
      chars: profile.length + JSON.stringify(links).length,
    };
  }
}

module.exports = { Refiner };
