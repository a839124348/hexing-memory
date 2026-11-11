/**
 * llm.js — LLM 提炼适配器（纯函数层）
 *
 * 这一层不关心 DSH / HTTP：调用方传入 `call({system,user}) -> Promise<string>`，
 * 方便先用假 LLM 做单测，再接宿主 ctx.llm 或 OpenAI 兼容端点。
 *
 * 输出契约（严格 JSON）：
 * {
 *   "chains": [
 *     {
 *       "name": "身份链",
 *       "parent": "身份" | "项目",
 *       "header": "可选，≤500 字",
 *       "nodes": [
 *         {"t":"YYYY-MM-DD HH:MM","who":"你|我|我们","type":"state|event","text":"...","supersedes":"可选"}
 *       ]
 *     }
 *   ]
 * }
 */
const MAX_CHAINS = 20;
const MAX_TOPICS = 20;
const MAX_NODES_PER_CHAIN = 50;
const MAX_TEXT = 500;
const MAX_HEADER = 500;
const MAX_DEPTH = 4;
// 单次 LLM 提示最多 100 条；超过就分块调用，绝不静默丢弃。
const MAX_PROMPT_RECORDS = 100;
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// 顶层根固定；LLM 可以建子链，但不能自己造新的顶层根。
const DEFAULT_ROOTS = new Set(['身份', '项目', '学习', '关系', '避坑', '存储', '想法', '日常', '约定链']);
const ROOT_SCOPES = [
  '身份链：名字、称呼、关系、相处方式、稳定偏好、边界；不写项目进度和当天流水。',
  '关系链：感情故事、重要互动、纪念日、冲突与修复；不写名字/称呼这类身份字段。',
  '约定链：用户与 AI 明确说定的约定、承诺、称呼、期限、奖励；不写期待、玩笑、试探。',
  '项目：项目进展、决策、里程碑、技术方案；一个项目一条项目链-X。',
  '学习：知识、方法、结论、教程；不写项目进度。',
  '避坑：踩坑、事故、教训、修复；不写普通偏好。',
  '存储：账号、密钥、存储位置、设备信息；取用要确认，不写完整密码。',
  '想法：未落地灵感；同月 ≥5 条进创意池；立项后升项目链。',
  '日常：生活流水、当天发生的事；无法归类才放这里。',
].join('\n');

const ROUTE_ORDER = [
  '归类顺序：明确约定 → 约定链；稳定身份/称呼/关系 → 身份链或关系链；项目 → 项目链-X；',
  '知识/踩坑/存储/灵感/日常 → 对应默认根；无法归类 → 日常；绝不新建顶层根。',
].join('\n');

// 迁移回填专用约束：旧历史量大、噪声多，宁可少建，不要逐条抄。
const BACKFILL_RULES = [
  '## 旧历史回填模式',
  '- 这是迁移旧对话，不是当前对话。只提取长期有价值的内容：身份、关系、项目、学习、约定、重要事件。',
  '- 不要为寒暄、测试串、日常流水、重复发言、一次玩笑建节点；宁少勿多。',
  '- 每批最多 8 条链、20 个节点；不要新建顶层根。',
  '- 节点时间用原文时间；不要写“现在/最近/目前”，除非原文明确。',
  '- 不推断原文没说过的事实；不确定就不建。',
  '- 同类旧事合并成一条摘要，不逐条抄原文。',
].join('\n');

class LlmError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'LlmError';
    this.stage = stage;
  }
}

const SYSTEM_PROMPT = [
  '你是记忆提炼器。输入是一段对话原文和现有链网索引。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '任务：从对话里抽取值得长期记住的事实，归入链网。',
  '规则：',
  '- 一条 = 一次发言；节点 text 用原话或极短摘要，不改写原意，≤500 字。',
  '- state = 可被推翻的偏好/状态/关系；event = 发生过的事，永存。',
  '- **只从用户本人的发言里抽事实**；AI 的回复只作上下文，不作为节点来源，除非用户明确确认。',
  '- **测试串、寒暄、工具调用过程、重复确认（如“回一个字”）不建节点**，它们不是长期记忆。',
  '- **梗、表情用法、口头禅、一次性玩笑默认不建节点**：只有用户明确说“记住这个/以后都用/写进链/这个梗记一下”才建；建的时候归入约定链（明确用法）、身份链（固定相处方式）或关系链（共同经历），并更新链头；否则留在 raw，不要自动提炼成节点。',
  '- 项目链只记项目进展、决策、里程碑；不记日常闲聊和测试。',
  '- 只在有明确证据时建节点；不确定就不建。',
  '- 同主题并入已有链，不重复建；parent 只能是已有链、核星，或固定默认根（身份/项目/学习/关系/避坑/存储/想法/日常/约定链）。',
  '- **不要把 parent 写成一个还不存在的顶层根**；父节点不存在时，把 parent 改成对应默认根，或跳过这条链。',
  '- **用户与 AI 明确说定的约定/承诺/称呼/期限/奖励，写入「约定链」（parent=核星）**；没有明确说定的期待、玩笑、试探不建。约定变更时旧节点标 superseded，不删。',
  '- 链的归类范围如下，不要混装：',
  ROOT_SCOPES,
  ROUTE_ORDER,
  '- 需要新父节点时，先输出父链（可以只有 header），再输出子链；最多 4 层，不要为了分类而硬造链。',
  '- 另外输出 topics：半成品话题/想法。想法类 title 统一写“创意池-YYYY-MM”，一条想法一个 item；其他类型 title 写具体主题。',
  '- 输出格式：{"chains":[{"name":"身份链","parent":"身份","header":"可选","nodes":[{"t":"YYYY-MM-DD HH:MM","who":"你|我|我们","type":"state|event","text":"...","supersedes":"可选关键词"}]}],"topics":[{"type":"想法","title":"创意池-2026-11","summary":"可选","items":[{"t":"YYYY-MM-DD HH:MM","who":"你|我|我们","text":"..."}]}]}',
  '- 最多 20 条链 / 20 个话题，每链每话题最多 50 个节点。',
].join('\n');

/** 构造提示词；records 只带 t/s/c，chains/topics 只带索引，不喂全库 */
function buildRefinePrompt(records, chains, topics, opts = {}) {
  const compactRecords = (records || []).slice(0, 100).map((r) => ({
    t: r.t, s: r.s, c: String(r.c || '').slice(0, 1000),
  }));
  const system = opts.mode === 'backfill'
    ? SYSTEM_PROMPT + '\n\n' + BACKFILL_RULES
    : SYSTEM_PROMPT;
  const chainIndex = (chains || []).map((c) => ({
    name: c.name, parent: c.parent, header: c.header || '', nodes: c.nodes || 0,
  }));
  const topicIndex = (topics || []).map((t) => ({
    type: t.type, title: t.title, status: t.status, count: t.count, chain: t.chain || '',
  }));
  const user = [
    '现有链网索引：',
    JSON.stringify(chainIndex, null, 1),
    '',
    '现有话题栈：',
    JSON.stringify(topicIndex, null, 1),
    '',
    '对话原文（JSONL，一行一条）：',
    compactRecords.map((r) => JSON.stringify(r)).join('\n'),
  ].join('\n');
  return { system, user };
}

/** 从模型输出里抠 JSON：容忍 ```json 围栏和前后废话 */
function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('PARSE', '模型输出里没有 JSON 对象');
  const raw = s.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new LlmError('PARSE', 'JSON 解析失败：' + e.message);
  }
}

/**
 * 解析并校验模型输出。
 * @param {string} text 模型原始输出
 * @param {object} opt { fallbackT }
 * @returns {{chains: Array}}
 */
function parseRefineResponse(text, opt = {}) {
  const obj = extractJson(text);
  const rawChains = Array.isArray(obj && obj.chains) ? obj.chains.slice(0, MAX_CHAINS) : [];
  const chains = [];

  for (const raw of rawChains) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
    if (!name || name === '核星') continue;
    const parent = String(raw.parent || '身份').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '身份';
    const header = raw.header ? String(raw.header).trim().slice(0, MAX_HEADER) : '';
    const nodes = [];

    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, MAX_NODES_PER_CHAIN) : [];
    for (const n of rawNodes) {
      if (!n || typeof n !== 'object') continue;
      const body = String(n.text || '').trim().slice(0, MAX_TEXT);
      if (!body) continue;
      const rawT = String(n.t || '');
      const t = TIME_RE.test(rawT) ? rawT : String(opt.fallbackT || '');
      if (!TIME_RE.test(t)) continue;
      const tSource = TIME_RE.test(rawT) ? 'llm' : 'fallback';
      const who = ['你', '我', '我们'].includes(n.who) ? n.who : '';
      const type = n.type === 'state' ? 'state' : 'event';
      const supersedes = n.supersedes ? String(n.supersedes).trim().slice(0, 64) : '';
      nodes.push({ t, tSource, who, type, text: body, supersedes });
    }

    // 允许“只有 header 的父链”，用于先建父节点再挂子链
    if (nodes.length || header) chains.push({ name, parent, header, nodes });
  }

  // topics：半成品话题/想法。想法类 title 可空，由 TopicStore 强制入月度池
  const rawTopics = Array.isArray(obj && obj.topics) ? obj.topics.slice(0, MAX_TOPICS) : [];
  const topics = [];
  for (const raw of rawTopics) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '想法').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 32) || '想法';
    const title = String(raw.title || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
    if (type !== '想法' && !title) continue;
    const summary = raw.summary ? String(raw.summary).trim().slice(0, MAX_HEADER) : '';
    const items = [];
    const rawItems = Array.isArray(raw.items) ? raw.items.slice(0, MAX_NODES_PER_CHAIN) : [];
    for (const n of rawItems) {
      if (!n || typeof n !== 'object') continue;
      const body = String(n.text || '').trim().slice(0, MAX_TEXT);
      if (!body) continue;
      const rawT = String(n.t || '');
      const t = TIME_RE.test(rawT) ? rawT : String(opt.fallbackT || '');
      if (!TIME_RE.test(t)) continue;
      const tSource = TIME_RE.test(rawT) ? 'llm' : 'fallback';
      const who = ['你', '我', '我们'].includes(n.who) ? n.who : '';
      items.push({ t, tSource, who, text: body });
    }
    if (items.length) topics.push({ type, title, summary, items });
  }

  return { chains, topics };
}

/**
 * 把解析后的链更新应用到 ChainStore。
 * 幂等：已存在的同名链不重建；已存在的节点按 (t,type,text) 跳过。
 * who 不参与幂等键：LLM 同一节点可能一次给空、一次给“你”，带上 who 会重复写。
 * @returns {{chains:number, nodes:number}}
 */
/** 链的深度：核星=0，默认根=1，子链=2…… 最多 MAX_DEPTH */
function depthOf(chainStore, name) {
  let d = 0;
  let c = chainStore.get(name);
  let guard = 0;
  while (c && guard++ < 10) {
    d++;
    if (!c.parent || c.parent === '核星') break;
    c = chainStore.get(c.parent);
  }
  return d;
}

function applyChainUpdates(chainStore, parsed, defaults = {}) {
  let chainCount = 0;
  let nodeCount = 0;

  for (const u of (parsed && parsed.chains) || []) {
    if (!u || !u.name || u.name === '核星') continue;
    const exist = chainStore.get(u.name);

    if (!exist) {
      // parent 可以是已有链、核星、默认类目；不存在就先建一个父节点（挂在核星下）
      let parent = String(u.parent || '身份').trim();
      if (!parent) parent = '身份';
      if (parent === u.name) parent = '核星';
      if (parent !== '核星' && !chainStore.get(parent)) {
        // 只允许自动补固定默认根；不替 LLM 造新的顶层根，防止链网失控。
        if (DEFAULT_ROOTS.has(parent)) chainStore.create(parent, '核星', '');
        else continue;
      }
      if (depthOf(chainStore, parent) + 1 > MAX_DEPTH) continue;
      chainStore.create(u.name, parent, u.header || '');
      chainCount++;
    } else if (u.header && u.header !== exist.header) {
      chainStore.setHeader(u.name, u.header, { by: 'llm' });
    }

    const current = chainStore.get(u.name);
    if (!current) continue;
    const seen = new Set((current.nodes || []).map((n) => [n.t, n.type, n.text].join('\u0000')));
    const fresh = [];
    for (const n of u.nodes || []) {
      const key = [n.t, n.type, n.text].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ ...n, source: defaults.source || n.source || '' });
    }
    if (fresh.length) {
      const r = chainStore.append(u.name, fresh);
      if (r && r.ok) nodeCount += r.added;
    }
  }

  return { chains: chainCount, nodes: nodeCount };
}

/**
 * 一次完整提炼：构造提示词 → 调模型 → 解析 → 应用链/话题更新。
 * 调用方负责“失败不推进游标 / 保留草稿”。
 * @param {object} p { records, chainStore, topicStore, call, fallbackT }
 */
async function refineOne({ records, chainStore, topicStore, call, fallbackT, dryRun = false, nodeDefaults = {}, mode = 'live' }) {
  const chainIndex = chainStore ? chainStore.list() : [];
  const topicIndex = topicStore ? topicStore.list() : [];
  const prompt = buildRefinePrompt(records, chainIndex, topicIndex, { mode });
  let text;
  try {
    text = await call(prompt);
  } catch (e) {
    throw new LlmError('CALL', e && e.message ? e.message : String(e));
  }
  const parsed = parseRefineResponse(text, { fallbackT });
  const applied = dryRun ? { chains: 0, nodes: 0 } : applyChainUpdates(chainStore, parsed, nodeDefaults);
  let topicApplied = { added: 0, promoted: [] };
  if (!dryRun && topicStore && parsed.topics.length) {
    topicApplied = topicStore.applyTopics(parsed.topics, chainStore);
  }
  return {
    ...applied,
    topics: topicApplied.promoted || [],
    topicItems: topicApplied.added || 0,
    parsed,
  };
}

/**
 * 一次完整提炼：构造提示词 → 调模型 → 解析 → 应用链/话题更新。
 * 超过 100 条自动分块，绝不静默截断；调用方负责“失败不推进游标 / 保留草稿”。
 * @param {object} p { records, chainStore, topicStore, call, fallbackT }
 */
async function refineWithLLM(params) {
  const records = (params && params.records) || [];
  if (!records.length) return { chains: 0, nodes: 0, topics: [], topicItems: 0 };
  if (records.length <= MAX_PROMPT_RECORDS) {
    return refineOne({ ...params, records });
  }
  const agg = { chains: 0, nodes: 0, topics: [], topicItems: 0, chunks: 0 };
  const parsed = { chains: [], topics: [] };
  for (let i = 0; i < records.length; i += MAX_PROMPT_RECORDS) {
    const r = await refineOne({
      ...params,
      records: records.slice(i, i + MAX_PROMPT_RECORDS),
    });
    agg.chunks++;
    agg.chains += r.chains || 0;
    agg.nodes += r.nodes || 0;
    agg.topics.push(...(r.topics || []));
    agg.topicItems += r.topicItems || 0;
    if (r.parsed) {
      parsed.chains.push(...(r.parsed.chains || []));
      parsed.topics.push(...(r.parsed.topics || []));
    }
  }
  return { ...agg, parsed };
}

module.exports = {
  LlmError,
  buildRefinePrompt,
  parseRefineResponse,
  applyChainUpdates,
  refineWithLLM,
  SYSTEM_PROMPT,
  MAX_PROMPT_RECORDS,
};
