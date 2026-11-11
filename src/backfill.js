/**
 * backfill.js — 迁移旧历史后补链网
 *
 * 设计：
 * - 只读 raw，不改原文；
 * - 分批（默认 100 条/批）走 LLM 提炼；
 * - 节点 source=migration，时间用原文时间；
 * - 默认只预览；start 才写链，写前备份 links；
 * - 状态落 common/backfill-state.json，支持暂停/续跑/预算上限。
 */
const fs = require('fs');
const path = require('path');
const { refineWithLLM } = require('./llm');

const BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 20;

class Backfill {
  constructor({ store, chain, root, logger }) {
    this.store = store;
    this.chain = chain;
    this.root = root;
    this.log = logger || console;
    this.commonDir = path.join(root, 'common');
    this.stateFile = path.join(this.commonDir, 'backfill-state.json');
    fs.mkdirSync(this.commonDir, { recursive: true });
    this._running = false;
    this._paused = false;
  }

  _readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (e) { return null; }
  }

  _writeState(state) {
    const tmp = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  /** 估算：条数、天数、批数、粗略 token */
  estimate() {
    const days = this.store.listDays();
    let records = 0;
    let chars = 0;
    for (const d of days) {
      for (const r of this.store.readDay(d)) {
        records++;
        chars += String(r.c || '').length;
      }
    }
    const batches = Math.ceil(records / BATCH_SIZE);
    // 中文约 1.5 字/token；再加每批提示词/链索引的固定开销
    const inputTokens = Math.ceil(chars / 1.5) + batches * 800;
    const outputTokens = batches * 1000;
    return {
      records,
      days: days.length,
      firstDay: days[0] || null,
      lastDay: days[days.length - 1] || null,
      batches,
      chars,
      batchSize: BATCH_SIZE,
      estimatedTokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
      note: '估算值；实际消耗取决于模型和每批内容。',
    };
  }

  status() {
    const state = this._readState();
    if (!state) {
      const estimate = this.estimate();
      let status = 'idle';
      try {
        const imp = JSON.parse(fs.readFileSync(path.join(this.commonDir, 'offline-import-result.json'), 'utf8'));
        if (imp.chainBackfill && imp.chainBackfill.status === 'pending') status = 'pending';
      } catch (e) { /* 没有导入结果就还是 idle */ }
      return {
        ok: true,
        status,
        batches: 0,
        processedRecords: 0,
        addedChains: 0,
        addedNodes: 0,
        estimate,
        needConsent: true,
      };
    }
    return { ok: true, ...state };
  }

  _readBatch(state) {
    if (state.cursorDay === '__end__') {
      return { records: [], cursor: { day: '__end__', index: 0 } };
    }
    const days = this.store.listDays();
    let dayIndex = state.cursorDay ? days.indexOf(state.cursorDay) : 0;
    if (dayIndex < 0) dayIndex = 0;
    let index = Number(state.cursorIndex) || 0;
    const out = [];
    while (out.length < BATCH_SIZE && dayIndex < days.length) {
      const day = days[dayIndex];
      const rows = this.store.readDay(day);
      while (index < rows.length && out.length < BATCH_SIZE) {
        out.push(rows[index++]);
      }
      if (index >= rows.length) {
        dayIndex++;
        index = 0;
      } else {
        break;
      }
    }
    const nextDay = dayIndex < days.length ? days[dayIndex] : '__end__';
    return { records: out, cursor: { day: nextDay, index } };
  }

  async preview({ call, batches = 1 } = {}) {
    if (!call) return { ok: false, error: '没有可用的 LLM 调用' };
    const n = Math.max(1, Math.min(5, Number(batches) || 1));
    const state = this._readState() || {
      status: 'idle',
      cursorDay: '',
      cursorIndex: 0,
      processedRecords: 0,
      batches: 0,
      addedChains: 0,
      addedNodes: 0,
    };
    const out = [];
    let cursorDay = state.cursorDay || '';
    let cursorIndex = Number(state.cursorIndex) || 0;
    let records = 0;
    for (let i = 0; i < n; i++) {
      const batch = this._readBatch({ cursorDay, cursorIndex });
      if (!batch.records.length) break;
      cursorDay = batch.cursor.day;
      cursorIndex = batch.cursor.index;
      records += batch.records.length;
      const r = await refineWithLLM({
        records: batch.records,
        chainStore: this.chain,
        topicStore: null,
        call,
        fallbackT: batch.records[batch.records.length - 1].t,
        dryRun: true,
        mode: 'backfill',
      });
      const chains = (r.parsed && r.parsed.chains ? r.parsed.chains : []).map((c) => ({
        name: c.name,
        parent: c.parent,
        header: String(c.header || '').slice(0, 200),
        nodes: (c.nodes || []).slice(0, 20).map((x) => ({
          t: x.t,
          who: x.who,
          type: x.type,
          text: String(x.text || '').slice(0, 160),
        })),
      }));
      out.push({ batch: i + 1, records: batch.records.length, chains });
    }
    return {
      ok: true,
      preview: true,
      batches: out.length,
      records,
      chains: out.reduce((sum, b) => sum + b.chains.length, 0),
      nodes: out.reduce((sum, b) => sum + b.chains.reduce((n, c) => n + c.nodes.length, 0), 0),
      detail: out,
      estimate: this.estimate(),
      note: '预览不写链；确认后用 action=start。',
    };
  }

  _backupLinks(state) {
    if (state.backupDir && fs.existsSync(state.backupDir)) return state.backupDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.root, 'links-backfill-' + stamp);
    fs.cpSync(this.chain.dir, dir, { recursive: true });
    return dir;
  }

  async start({ call, maxBatches = DEFAULT_MAX_BATCHES } = {}) {
    if (!call) return { ok: false, error: '没有可用的 LLM 调用' };
    if (this._running) return { ok: false, error: '回填已在运行', ...this.status() };
    let state = this._readState();
    if (state && state.status === 'done') {
      return { ok: true, alreadyDone: true, ...state };
    }
    if (!state) {
      state = {
        status: 'idle',
        cursorDay: '',
        cursorIndex: 0,
        processedRecords: 0,
        batches: 0,
        addedChains: 0,
        addedNodes: 0,
        startedAt: null,
        updatedAt: null,
        lastError: null,
      };
    }
    state.status = 'running';
    state.startedAt = state.startedAt || new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    state.maxBatches = Math.max(1, Math.min(200, Number(maxBatches) || DEFAULT_MAX_BATCHES));
    state.batchLimit = (Number(state.batches) || 0) + state.maxBatches;
    state.estimate = this.estimate();
    try {
      state.backupDir = this._backupLinks(state);
    } catch (e) {
      state.status = 'error';
      state.lastError = '备份 links 失败：' + e.message;
      this._writeState(state);
      return { ok: false, error: state.lastError };
    }
    this._writeState(state);
    this._paused = false;
    this._running = true;
    this._run(call).catch((e) => {
      this._running = false;
      const cur = this._readState() || state;
      cur.status = 'error';
      cur.lastError = String((e && e.message) || e);
      cur.updatedAt = new Date().toISOString();
      this._writeState(cur);
      this.log.error?.('[memory-system] 回填补链失败：' + cur.lastError);
    });
    return { ok: true, started: true, ...state };
  }

  pause() {
    this._paused = true;
    const state = this._readState();
    if (state) {
      state.status = 'paused';
      state.updatedAt = new Date().toISOString();
      this._writeState(state);
    }
    return { ok: true, status: 'paused' };
  }

  async resume({ call, maxBatches } = {}) {
    return this.start({ call, maxBatches });
  }

  async _run(call) {
    let state = this._readState();
    if (!state) throw new Error('missing backfill state');
    const limit = Number(state.batchLimit) || ((Number(state.batches) || 0) + DEFAULT_MAX_BATCHES);
    while (!this._paused) {
      const batch = this._readBatch(state);
      if (!batch.records.length) {
        state.status = 'done';
        state.updatedAt = new Date().toISOString();
        state.note = '旧历史回填完成。';
        this._writeState(state);
        break;
      }
      if (Number(state.batches) >= limit) {
        state.status = 'partial';
        state.note = `已达到本次 ${state.maxBatches} 批上限（累计 ${state.batches} 批）；可再次 start 续跑。`;
        state.updatedAt = new Date().toISOString();
        this._writeState(state);
        break;
      }
      const r = await refineWithLLM({
        records: batch.records,
        chainStore: this.chain,
        topicStore: null,
        call,
        fallbackT: batch.records[batch.records.length - 1].t,
        mode: 'backfill',
        nodeDefaults: { source: 'migration' },
      });
      state.processedRecords = (Number(state.processedRecords) || 0) + batch.records.length;
      state.batches = (Number(state.batches) || 0) + 1;
      state.addedChains = (Number(state.addedChains) || 0) + (r.chains || 0);
      state.addedNodes = (Number(state.addedNodes) || 0) + (r.nodes || 0);
      state.cursorDay = batch.cursor.day;
      state.cursorIndex = batch.cursor.index;
      state.updatedAt = new Date().toISOString();
      state.status = this._paused ? 'paused' : 'running';
      state.lastError = null;
      this._writeState(state);
      this.log.info?.(`[memory-system] 旧历史回填：${state.batches}/${limit} 批，节点 +${r.nodes || 0}`);
    }
    this._running = false;
  }
}

module.exports = { Backfill, BATCH_SIZE, DEFAULT_MAX_BATCHES };
