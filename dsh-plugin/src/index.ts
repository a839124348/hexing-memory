/**
 * 核星记忆 / Hexing Memory —— DSH 记忆插件
 * 把开源记忆系统接到 DeepSeek Harness
 *
 * 架构：插件外壳（本文件）+ 核心引擎（../../src/*.js，纯 JS，与平台无关）
 *
 * 七件事：
 * 1. 七个工具：memory_write / memory_search / memory_draft / memory_common / memory_identity / memory_chain / memory_topic
 * 2. 常识层自动注入：挂 `agent/pre-step`，身份 + RULES 常驻摘要 + 说明书索引 + 链网索引；压缩后自动补
 * 3. 自动记录：挂 `llm/stream` 旁听用户消息与 AI 回复
 * 4. 向量策略：插件托管的本地 bge 服务（16891），失败显式降级关键词
 * 5. 提炼：10 分钟 / 100 条，后台跑，不询问用户
 * 6. 总览 / 链网展示窗：3099
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_NAME = '核星记忆'
const APP_NAME_EN = 'Hexing Memory'
// 版本号单一来源：dsh-plugin/package.json；读不到再退回常量
let APP_VERSION = '0.4.0'
try {
  const pkg = require(path.join(__dirname, '..', 'package.json'))
  if (pkg && pkg.version) APP_VERSION = String(pkg.version)
} catch (e) { /* 发布包里一定有 package.json；读不到不致命 */ }

export const name = 'memory-system'
export const inject = ['tools', 'llm']

// ── 数据目录 ──────────────────────────────────────────
const DATA_ROOT = process.env.MEMORY_ROOT
  || path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.dsh'), 'dsh-memory')

// 核心引擎路径（开发时指向 AI-SF-14/src，发布时打包进 core/）
const CORE_DIR = process.env.MEMORY_CORE || path.join(__dirname, '..', '..', 'src')

// 注入标记：用来判断上下文里是否已有常识层
const COMMON_MARK = '<!-- memory-system:common -->'

// 唯一说明书路径（发布时把 docs/RULES.md 一起打包；可用环境变量覆盖）
const RULES_PATH = process.env.MEMORY_RULES || path.join(__dirname, '..', '..', 'docs', 'RULES.md')

// 说明书阅读进度（首次安装/升级强制通读）；apply() 里初始化
let manualReader: any = null
function manualGate(): any {
  return manualReader ? manualReader.gate() : { ok: true }
}

// 适配层纯函数（选真话/剥注入/渲染常识层/去重键），单测直接覆盖
const pure = require(path.join(CORE_DIR, 'adapter_pure.js'))
// 链头状态 + 大链取节点纯函数
const chainView = require(path.join(CORE_DIR, 'chain_view.js'))
const { localDay: localDayKey } = require(path.join(CORE_DIR, 'usage.js'))

interface MemoryApp {
  store: any
  draft: any
  refiner: any
  search: any
  chain: any
  chainSearch: any
  topic: any
  usage: any
}

function initCore(): MemoryApp {
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const { Store } = require(path.join(CORE_DIR, 'store.js'))
  const { Draft } = require(path.join(CORE_DIR, 'draft.js'))
  const { Refiner } = require(path.join(CORE_DIR, 'refine.js'))
  const { Search } = require(path.join(CORE_DIR, 'search.js'))
  const { ChainStore } = require(path.join(CORE_DIR, 'chain.js'))
  const { ChainSearch } = require(path.join(CORE_DIR, 'chain_search.js'))
  const { TopicStore } = require(path.join(CORE_DIR, 'topics.js'))
  const { UsageStore } = require(path.join(CORE_DIR, 'usage.js'))
  const store = new Store(DATA_ROOT)
  const draft = new Draft(DATA_ROOT)
  const refiner = new Refiner(DATA_ROOT, store, draft)
  const search = new Search(DATA_ROOT, store)
  const chain = new ChainStore(DATA_ROOT)
  const chainSearch = new ChainSearch(DATA_ROOT, chain)
  const topic = new TopicStore(DATA_ROOT)
  const usage = new UsageStore(DATA_ROOT)
  return { store, draft, refiner, search, chain, chainSearch, topic, usage }
}

/**
 * 初始化链网默认骨架（幂等，已存在就跳过）。
 * 2026-11-08 用户定：默认七类 + 身份，不止七类；需要时可以在这之下增设父节点/子链。
 *   核星
 *   ├─ 身份（含身份链）
 *   ├─ 项目 / 学习 / 关系 / 避坑 / 存储 / 想法 / 日常
 *   ├─ 约定链（单独一条根链）
 *   └─ 各分支下可继续挂子链（深度由 llm.js 限制）
 */
const DEFAULT_CHAIN_ROOTS: Array<[string, string]> = [
  ['身份', '关于人的一切：用户、助手、我们的关系'],
  ['项目', '所有项目'],
  ['学习', '学过的东西、方法、结论'],
  ['关系', '人和人之间的关系'],
  ['避坑', '踩过的坑与教训'],
  ['存储', '账号 / 密钥 / 存储位置（取用要确认）'],
  ['想法', '还没落地的想法'],
  ['日常', '每天发生的事'],
  ['约定链', '用户和 AI 明确说定的约定、承诺、称呼、期限和奖励'],
]

function ensureChains(chain: any) {
  for (const [name, header] of DEFAULT_CHAIN_ROOTS) {
    const r = chain.create(name, '核星', header)
    // 老数据里 身份/项目 的 header 可能是空的；只在空时补，不覆盖用户写过的
    if (r && r.chain && !String(r.chain.header || '').trim()) {
      chain.setHeader(name, header)
    }
  }
  chain.create('身份链', '身份', '')
}

/**
 * 展示窗：总览页 + Three.js 真 3D 链网，跟着 DSH 生命周期起停。
 *   GET /                → 总览页（dashboard.html）
 *   GET /universe        → 真 3D 链网（viewer.html）
 *   GET /api/stats       → 总览统计（JSON）
 *   GET /api/chains      → 整棵树
 *   GET /api/chain?name= → 单条链
 *
 * 端口默认 3099，可用 MEMORY_VIEWER_PORT 覆盖；占用时只告警不阻断。
 */
function startViewer(ctx: any, app: MemoryApp, embedService?: any) {
  const port = Number(process.env.MEMORY_VIEWER_PORT || 3099)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      res.setHeader('Cache-Control', 'no-store')

      // 本地 vendor：Three.js 真 3D 模块（不联网、不引 CDN）。只允许 vendor 根目录下的单文件。
      if (url.pathname.startsWith('/vendor/')) {
        const name = path.basename(url.pathname)
        const tail = url.pathname.slice('/vendor/'.length)
        if (!name || name !== tail || !/^[A-Za-z0-9._-]+$/.test(name)) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const file = path.join(__dirname, 'vendor', name)
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const ext = path.extname(name).toLowerCase()
        res.setHeader('Content-Type', ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : (ext === '.txt' ? 'text/plain; charset=utf-8' : 'application/octet-stream'))
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.end(fs.readFileSync(file))
        return
      }

      if (url.pathname === '/api/stats') {
        const stats = await collectStats(app, embedService)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(stats))
        return
      }
      if (url.pathname === '/api/chains') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(app.chain.tree()))
        return
      }
      if (url.pathname === '/api/chain') {
        const name = url.searchParams.get('name') || ''
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(app.chain.get(name) || { ok: false, error: '链不存在：' + name }))
        return
      }

      const page = (url.pathname === '/' || url.pathname === '/dashboard')
        ? 'dashboard.html'
        : ((url.pathname === '/universe' || url.pathname === '/viewer') ? 'viewer.html' : '')
      if (page) {
        const file = path.join(__dirname, page)
        if (fs.existsSync(file)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(fs.readFileSync(file, 'utf8'))
          return
        }
        res.statusCode = 404
        res.end(page + ' 缺失')
        return
      }

      res.statusCode = 404
      res.end('not found')
    } catch (e: any) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
    }
  })

  server.on('error', (e: any) => {
    console.warn('[memory-system] 展示窗服务未能启动（' + (e && e.code) + '）：' + (e && e.message))
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[memory-system] ${APP_NAME} v${APP_VERSION} / ${APP_NAME_EN} 总览/链网展示窗：http://127.0.0.1:${port}`)
  })

  ctx.effect(() => () => {
    try { server.close() } catch (e) { /* 已经关了 */ }
  })
}

/** 总览页数据：只读，任何一项失败都降级为空值，不影响页面打开 */
async function collectStats(app: MemoryApp, embedService?: any) {
  const today = localDayKey()
  const generatedAt = new Date().toISOString()

  let memory: any = { total: 0, today: 0, days: 0, firstDay: null, lastDay: null }
  try {
    const st = app.store.stats()
    let todayNew = 0
    try { todayNew = app.store.readDay(today).length } catch (e) { todayNew = 0 }
    memory = { total: st.records, today: todayNew, days: st.days, firstDay: st.firstDay, lastDay: st.lastDay }
  } catch (e) { /* 空数据也要能看总览 */ }

  // 陪伴天数：从第一条记忆所在日期到今天，含首尾；这是总览页的主视觉
  let companion: any = { days: 0, firstDay: memory.firstDay || null, today }
  try {
    if (memory.firstDay) {
      const [fy, fm, fd] = String(memory.firstDay).split('-').map(Number)
      const [ty, tm, td] = today.split('-').map(Number)
      const diff = Math.floor((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1
      companion.days = Math.max(1, diff)
    }
  } catch (e) { /* ignore */ }

  let draft: any = { pending: 0, oldest: null, newest: null }
  try { draft = app.draft.stats() } catch (e) { /* ignore */ }

  let vectors: any = { indexed: 0, model: null, dim: 0, builtAt: null }
  try { vectors = app.search.stats() } catch (e) { /* ignore */ }

  let chains: any = { branches: 0, chains: 0, nodes: 0, needHeader: 0, needRefresh: 0 }
  try {
    // 核星是根，不算一条业务链；树和总览统一口径
    const rows = app.chain.list().filter((c: any) => c.name !== '核星')
    let branches = 0
    try {
      const tree = app.chain.tree()
      branches = Array.isArray(tree && tree.树) ? tree.树.length : 0
    } catch (e) { branches = 0 }
    chains = {
      branches,
      chains: rows.length,
      nodes: rows.reduce((sum: number, c: any) => sum + (Number(c.nodes) || 0), 0),
      needHeader: rows.filter((c: any) => c.needHeader).length,
      needRefresh: rows.filter((c: any) => c.needRefresh).length,
    }
  } catch (e) { /* ignore */ }

  let topics: any = { total: 0, open: 0, promoted: 0, closed: 0 }
  try { topics = app.topic.stats() } catch (e) { /* ignore */ }

  let refine: any = { runs: 0, lastRunAt: null, lastError: null, lastLlmError: null, llmPending: 0, deadLetters: 0 }
  try {
    const st = app.refiner.state()
    refine = {
      runs: st.runs || 0,
      lastRunAt: st.lastRunAt || null,
      lastError: st.lastError || null,
      lastLlmError: st.lastLlmError || null,
      llmPending: Array.isArray(st.llmPending) ? st.llmPending.length : 0,
      deadLetters: Array.isArray(st.deadLetters) ? st.deadLetters.length : 0,
    }
  } catch (e) { /* ignore */ }

  let tokens: any = { today: null, history: [], updatedAt: null }
  try { tokens = app.usage.snapshot(14) } catch (e) { /* ignore */ }

  let service: any = {
    status: embedService && typeof embedService.status === 'function' ? embedService.status() : null,
    health: { ok: false, error: 'not checked' },
  }
  try { service.health = await app.search.health() } catch (e: any) {
    service.health = { ok: false, error: String(e && e.message || e) }
  }

  return {
    ok: true,
    version: APP_VERSION,
    generatedAt,
    today,
    memory,
    companion,
    draft,
    vectors,
    chains,
    topics,
    refine,
    tokens,
    service,
  }
}

/**
 * 会话可见历史里是否已经有常识层。
 *
 * pre-step 的 `messages` 只是本步新输入，不含历史；不查历史的话，
 * 每一步都会再插一份常识层，长会话会堆出几十份（每份约 1KB）。
 * `agent.session.surface` 是 DSH 的“模型可见消息”投影，按它判断最准。
 * 读不到就返回 false（宁可多插一份，也不阻断对话）。
 */
function historyHasCommon(agent: any): boolean {
  try {
    const s = agent && agent.session
    if (!s || !s.surface || !Array.isArray(s.surface.nodes)) return false
    const nodes = s.surface.nodes
    // 不再只看最近 80 个节点：长会话压缩后常识层可能落在更早的位置。
    // 全量从后往前找，找到就停；surface 通常只有几百个节点，成本可控。
    for (let i = nodes.length - 1; i >= 0; i--) {
      const ev = s.eventAt(nodes[i])
      if (!ev || ev.type !== 'user/message') continue
      const msg = s.surface.deriveEventMessage(ev)
      if (msg && textOf(msg).includes(COMMON_MARK)) return true
    }
  } catch (e) { /* 读不到就算了 */ }
  return false
}

/** 从消息 content 里取纯文本 */
function textOf(msg: any): string {
  const c = msg && msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b: any) => (b && b.text) || '').join('\n')
  return ''
}

/** 从 RULES.md 里取常驻摘要（RESIDENT 标记块）；读不到返回空 */
function readResidentSpec(): string {
  try {
    return pure.readResidentSpecFrom(fs.readFileSync(RULES_PATH, 'utf8'))
  } catch (e) { return '' }
}

/** 从 RULES.md 的二级标题生成目录；读不到返回空 */
function readManualIndex(): string {
  try {
    return pure.readManualIndexFrom(fs.readFileSync(RULES_PATH, 'utf8'))
  } catch (e) { return '' }
}

/** 链网索引：只放名字 + 一句话头部 + 节点数，不放正文 */
function buildChainIndex(app: MemoryApp): string {
  try {
    const rows = app.chain.list()
    if (!Array.isArray(rows) || !rows.length) return '- （暂无链）'
    return rows.slice(0, 30).map((c: any) => {
      const head = String(c.header || '').trim()
      return '- ' + c.name + (head ? '：' + head : '') + '（' + (c.nodes || 0) + ' 节点）'
    }).join('\n')
  } catch (e) { return '- （读取失败）' }
}

/**
 * 常识层：身份 + 常驻规范摘要 + 说明书索引 + 话题栈 + 链网索引。
 * 动态内容（当前状态、最近会话、草稿全量、链网正文）不进这一层。
 * 组装与裁剪在 adapter_pure.js，单测覆盖。
 */
function buildCommonText(app: MemoryApp): string {
  let profile = ''
  try { profile = String(app.refiner.commonBundle().profile || '') } catch (e) { /* 空数据也要能启动 */ }
  let topics = ''
  try {
    const s = app.topic.stats()
    if (s.total) topics = `- 未闭合 ${s.open} 个；已升格 ${s.promoted} 个（memory_topic list 查看）`
  } catch (e) { /* 空数据也要能启动 */ }
  let onboarding = ''
  try { if (manualReader) onboarding = manualReader.onboardingText() } catch (e) { /* 说明书读不到就不拦 */ }
  return pure.composeCommonText({
    profile,
    resident: readResidentSpec(),
    manualIndex: readManualIndex(),
    chains: buildChainIndex(app),
    topics,
    onboarding,
  })
}

// 顶层根固定九条；memory_chain append 只允许挂到这些根或已有链。
// 与 src/chain.js 的 DEFAULT_ROOTS 保持一致（同一份设计，别各写各的）。
const CHAIN_ROOTS = new Set(['身份', '项目', '学习', '关系', '避坑', '存储', '想法', '日常', '约定链'])
// memory_topic 的 add 只收这些类型；否则 type 会变成新的顶层根。
const TOPIC_TYPES = ['想法', '学习', '避坑', '关系', '项目', '日常']

/**
 * 工具返回值必须是**严格 JSON**：undefined / NaN / Infinity / Date / Buffer 都会被 DSH 拒收
 * （报 `value is not lossless JSON`）。这里统一过一遍 JSON 往返，把脏值清掉。
 */
function cleanJson(x: any): any {
  try {
    return JSON.parse(JSON.stringify(x))
  } catch (e) {
    return { ok: true, note: '返回值清洗失败，已降级为空对象' }
  }
}

/**
 * 从流的一个 chunk 里抠出**正文文本**。
 *
 * 关键：**流里既有 reasoning 也有正文**（实测 2026-11-06：
 * 抓到 "He asks: ... I should search" 这种思考过程进了记忆）。
 * 所以必须先看 type，reasoning / thinking / redacted 一律跳过。
 */
function chunkText(chunk: any): string {
  if (!chunk) return ''
  if (typeof chunk === 'string') return chunk

  // 跳过思考类块
  const type = String(chunk.type || (chunk.delta && chunk.delta.type) || '')
  if (/reason|think|redact|thought/i.test(type)) return ''

  if (typeof chunk.text === 'string') return chunk.text
  if (chunk.delta && typeof chunk.delta.text === 'string' && !/reason|think/i.test(String(chunk.delta.type || ''))) {
    return chunk.delta.text
  }
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .filter((b: any) => b && /^text$/i.test(String(b.type || '')) && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
  }
  return ''
}

/** 从流 chunk 里取 usage（DSH 的 usage chunk：{ type:'usage', usage:{ inputTokens, outputTokens } }） */
function chunkUsage(chunk: any): any {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.usage && typeof chunk.usage === 'object') return chunk.usage
  if (chunk.delta && chunk.delta.usage && typeof chunk.delta.usage === 'object') return chunk.delta.usage
  return null
}

/** 这个 stream 是不是一个“工具调用步”（该步的 text 只是工具前解说，不算最终回复） */
function chunkHasTool(chunk: any): boolean {
  if (!chunk || typeof chunk !== 'object') return false
  const type = String(chunk.type || (chunk.delta && chunk.delta.type) || '')
  if (/tool[-_.]?call|tool[-_.]?use/i.test(type)) return true
  if (String(chunk.blockType || '') === 'tool-call') return true
  if (chunk.block && String(chunk.block.type || '') === 'tool-call') return true
  return false
}

/**
 * 旁听流：原样转发每个 chunk，流结束时回调完整文本。
 * 不修改内容、不吞异常——任何意外都退回原始流，绝不影响对话。
 */
function tapStream(stream: any, onDone: (text: string, meta?: any) => void, onUsage?: (usage: any) => void): any {
  try {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
  } catch (e) {
    return stream
  }
  try {
    return {
      [Symbol.asyncIterator]() {
        const it = stream[Symbol.asyncIterator]()
        let buf = ''
        let finished = false
        let lastUsage: any = null
        let hadTool = false
        const finish = () => {
          if (finished) return
          finished = true
          const t = buf.trim()
          if (t.length >= 2) { try { onDone(t, { tool: hadTool }) } catch (e) { /* 静默 */ } }
          if (lastUsage) { try { onUsage && onUsage(lastUsage) } catch (e) { /* 静默 */ } }
        }
        return {
          async next() {
            const r = await it.next()
            if (r.done) finish()
            else {
              const u = chunkUsage(r.value)
              if (u) lastUsage = u
              if (chunkHasTool(r.value)) hadTool = true
              try { const t = chunkText(r.value); if (t) buf += t } catch (e) { /* 忽略单个坏块 */ }
            }
            return r
          },
          async return(v?: any) {
            finish()
            return it.return ? await it.return(v) : { done: true, value: v }
          },
          async throw(e?: any) {
            finish()
            if (it.throw) return it.throw(e)
            throw e
          },
          [Symbol.asyncIterator]() { return this },
        }
      },
    }
  } catch (e) {
    return stream
  }
}

/**
 * 剥掉 DSH 注入的系统提示（不是用户说的话）
 * 实测两种：
 *   1. `Current runtime context. ...`（842 字：工作目录、沙箱策略）
 *   2. `<system-reminder>...`（975 字：可用技能列表）
 * 判断原则：**整条**以注入标记开头 → 整条丢；嵌在中间 → 只剥那一块。
 * 实现已抽到 adapter_pure.js（纯函数，单测覆盖）。
 */

/**
 * 剥离代码：围栏代码块 + 行内代码。
 *
 * ⚠️ 当前**不再调用**（用户 2026-11-07 定："对话里出现的代码正常记录"）。
 * 保留函数是为了以后可能需要"只剥工具性代码"时能直接接上。
 * 工具调用里的代码本来就不进记忆——适配层只取 text 块，不取 tool_use 参数。
 */
function stripCode(text: string): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]{1,120}`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * IDENTITY.md 模板 —— **由插件预置，模型不许另起结构**。
 * 只保留四段身份；行为规则不写在这里，统一在 `RULES.md` 的 `RESIDENT` 块，
 * 否则两套规则会漂移（v0.4 定）。
 */
function identityTemplate(): string {
  return [
    '# 身份',
    '',
    '## 我是谁',
    '（待补充：AI 的名字、是什么、跑在哪里）',
    '',
    '## 用户是谁',
    '（待补充：怎么称呼、身份、在忙什么）',
    '',
    '## 我们的关系',
    '（待补充：关系性质）',
    '',
    '## 相处方式',
    '（待补充：说事风格、雷区、习惯）',
  ].join('\n')
}

function identityFiles() {
  const dir = path.join(DATA_ROOT, 'common')
  return {
    dir,
    md: path.join(dir, 'IDENTITY.md'),
    json: path.join(dir, 'identity.json'),
  }
}

/** 插件加载时确保模板存在（只在缺失时写，绝不覆盖用户已填内容） */
function ensureIdentityTemplate() {
  const f = identityFiles()
  fs.mkdirSync(f.dir, { recursive: true })
  if (!fs.existsSync(f.md)) fs.writeFileSync(f.md, identityTemplate(), 'utf8')
  if (!fs.existsSync(f.json)) {
    fs.writeFileSync(f.json, JSON.stringify({ aiName: '', userTitle: '', relation: '' }, null, 1), 'utf8')
  }
}

/** 把结构化字段渲染成固定模板（只渲染四段身份） */
function renderIdentity(v: any): string {
  const pick = (s: any, def = '（待补充）') => (s && String(s).trim()) || def
  return [
    '# 身份',
    '',
    '## 我是谁',
    // 名字 + 一句话自述（名字由来、性格）。
    // **不写平台、不写模型、不写能力清单、不写"我没有身体"**——
    // 那些是技术规格，不是身份；换平台换模型就过时，还白占常驻 token
    '我叫**' + pick(v.aiName) + '**' + (v.aiSelf && String(v.aiSelf).trim()
      ? '，' + String(v.aiSelf).trim().replace(/[。.]+$/, '') + '。'
      : '。'),
    '',
    '## 用户是谁',
    // 用「称呼」而不是「他叫」——性别中性，也不假设人称
    '称呼：**' + pick(v.userTitle) + '**',
    // userInfo 可能有多行（账户 / 工作目录 / 语言各一行），用换行拼接保留结构
    (v.userInfo && String(v.userInfo).trim() ? String(v.userInfo).trim() : '（其他信息待补充）'),
    '',
    '## 我们的关系',
    pick(v.relation),
    '',
    '## 相处方式',
    pick(v.style),
  ].join('\n')
}

/** 说话人名字：优先读 identity.json（结构化），回退正则，再回退默认值 */
function resolveSpeakers(): { user: string; ai: string } {
  let user = ''
  let ai = ''
  const f = identityFiles()

  // userTitle 可能被写成"用户（平常）；认真的时候叫亲爱的"这种长串，
  // 直接当名字会让说话人字段变成一整句（实测 6 条记录说话人被写成了整串）。
  // 只取第一个词。
  const firstWord = (s: any) => String(s || '').trim().split(/[（(；;，,。\s]/)[0].trim()
  try {
    const meta = JSON.parse(fs.readFileSync(f.json, 'utf8'))
    if (meta.aiName) ai = firstWord(meta.aiName)
    if (meta.userTitle) user = firstWord(meta.userTitle)
  } catch (e) { /* 没填过，走回退 */ }

  // 缺哪个就从 IDENTITY.md 补哪个（不能"有一个就整体返回"——
  // 实测 userTitle 空、aiName 有值，结果用户全被记成"用户"）
  if (!ai || !user) {
    try {
      const t = fs.readFileSync(f.md, 'utf8')
      if (!ai) {
        const m = /我叫\s*\**([^\s*，,。\n]{1,20})/.exec(t)
        if (m) ai = m[1]
      }
      if (!user) {
        const m = /(?:他叫|用户叫)\s*\**([^\s*，,。\n]{1,20})/.exec(t)
        if (m) user = m[1]
      }
    } catch (e) { /* 没填过，用默认值 */ }
  }

  return { user: firstWord(user) || '用户', ai: firstWord(ai) || 'AI' }
}

export function apply(ctx: Context) {
  // 路径自检：用户下载到任意目录，仓库结构必须保持 dsh-plugin/ 与 src/ 同级。
  // 找不到就明确停用插件，别让 DSH 因为一个模块路径报一堆看不懂的错。
  const coreEntry = path.join(CORE_DIR, 'store.js')
  if (!fs.existsSync(coreEntry)) {
    console.error(`[memory-system] 核心引擎未找到：${coreEntry}`)
    console.error('[memory-system] 插件已停用，不影响 DSH。请保持 dsh-plugin/ 与 src/ 在同一仓库，或设置 MEMORY_CORE。')
    return
  }
  if (!fs.existsSync(RULES_PATH)) {
    console.warn(`[memory-system] 说明书未找到：${RULES_PATH}；常识层会缺少规则。请保持 docs/RULES.md 随仓库，或设置 MEMORY_RULES。`)
  }

  const app = initCore()
  let embedService: any = null
  ensureIdentityTemplate()   // 身份文件由插件预置模板，模型只能在模板里填内容
  ensureChains(app.chain)    // 链网骨架：核星 → 身份（含身份链）/ 项目

  // 说明书阅读进度：首次安装/升级未读完会在常识层提示，并拦住链网/话题写入
  try {
    const { ManualReader } = require(path.join(CORE_DIR, 'manual.js'))
    manualReader = new ManualReader(DATA_ROOT, RULES_PATH)
  } catch (e: any) {
    console.warn('[memory-system] 说明书阅读进度未加载：' + (e && e.message))
  }

  // 启动就有回执——否则用户无法判断插件到底加载了没有（实测排查时吃过这个亏）
  try {
    const st = app.store.stats()
    console.log(`[memory-system] ${APP_NAME} v${APP_VERSION} 已加载 | 数据目录 ${DATA_ROOT} | 存档 ${st.records} 条`)
  } catch (e) {
    console.log(`[memory-system] ${APP_NAME} v${APP_VERSION} 已加载（读取存档统计失败，不影响使用）`)
  }

  // ── 向量服务：插件托管（v0.4）────────────────────────
  // 已健康 → 复用；没起且有 MEMORY_EMBED_CMD → 拉起并守护；起不来 → 检索降级，不阻塞对话。
  try {
    const { createEmbedService } = require(path.join(CORE_DIR, 'service.js'))
    embedService = createEmbedService({ log: (m: string) => console.log(m) })
    ctx.effect(() => {
      let disposed = false
      embedService.start().then((r: any) => {
        if (disposed) return
        if (!r.ok) console.warn('[memory-system] 向量服务不可用（' + r.reason + '），检索将降级关键词')
      }).catch((e: any) => {
        console.warn('[memory-system] 向量服务启动失败：' + (e && e.message))
      })
      return () => {
        disposed = true
        embedService.stop().catch(() => { /* ignore */ })
      }
    })
  } catch (e: any) {
    console.warn('[memory-system] 向量服务管理未加载：' + (e && e.message))
  }

  // ── 工具 1：写记忆（草稿层）─────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: '仅当用户明确说"记住这个 / 把这个记下来"时才调用。日常对话会被自动记录，不需要你操心，也不要主动询问要不要记。一条 = 一次发言，内容必须是原文。',
    parameters: {
      records: {
        type: 'array',
        required: true,
        description: '记录数组，每条含 t/s/c/cid/v',
        items: {
        type: 'object',
        // 允许可选字段（src/type/origin）——校验器认得它们，schema 不该把它们挡在外面
        additionalProperties: true,
        properties: {
            t: { type: 'string', description: '时间 YYYY-MM-DD HH:MM（本地时区，精确到分）' },
            s: { type: 'string', description: '说话人原名' },
            c: { type: 'string', description: '内容原文，一个字不改' },
            cid: { type: 'string', description: '会话 ID' },
            v: { type: 'number', description: '格式版本，固定 1' },
          },
        },
      } as any,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any) {
      const r = app.draft.add(args.records || [])
      if (!r.ok) throw new Error('写入失败：' + JSON.stringify(r.errors || []).slice(0, 300))
      // 写完也检查一次是否该提炼（原来是等下轮对话才检查，可能拖很久）
      try { maybeRefine() } catch (e) { /* 提炼失败不影响写入结果 */ }
      return cleanJson({ ok: true, added: r.added, skipped: r.skipped, pending: app.draft.stats().pending })
    },
  }))

  // ── 工具 2：检索（草稿 + 链节点 + 正式，合并）────────
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '检索记忆：最近草稿（字面）+ 链节点（语义）+ 已提炼存档（向量），合并返回，每条带 layer。用户问“之前/刚才”先调这个；带 chain 可只搜某条链的节点。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词或问题' },
      limit: { type: 'number', description: '返回条数，默认 5，最大 20' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
      chain: { type: 'string', description: '只搜某条链的节点（可选）' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: any) {
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
      const chainName = args.chain ? String(args.chain) : ''
      const formal = await app.search.query(args.query, { limit, dateFrom: args.from || '', dateTo: args.to || '' })
      const draftHits = app.draft.search(args.query, limit)
      const chainRes = await app.chainSearch.query(args.query, { chain: chainName, limit })
      const chainHits = chainRes.results || []
      const formalHits = formal.results || []

      // 三层分配：带 chain 时链节点优先；否则草稿/链/存档各一份，再用其他层补满
      let picked: any[] = []
      if (chainName) {
        picked = chainHits.slice(0, limit)
      } else {
        const dq = Math.ceil(limit / 3)
        const cq = Math.ceil(limit / 3)
        picked = [
          ...draftHits.slice(0, dq),
          ...chainHits.slice(0, cq),
          ...formalHits.slice(0, Math.max(0, limit - dq - cq)),
        ]
      }

      const pools = chainName
        ? [chainHits, formalHits, draftHits]
        : [draftHits, chainHits, formalHits]
      const seen = new Set<string>()
      const results: any[] = []
      const keyOf = (r: any) => r.layer === 'chain'
        ? ['chain', r.chain || '', r.nodeIndex, r.text || ''].join('\u0000')
        : [r.cid || '', r.t || '', r.s || '', r.c || ''].join('\u0000')
      for (const list of [picked, ...pools]) {
        for (const r of list) {
          if (results.length >= limit) break
          const k = keyOf(r)
          if (seen.has(k)) continue
          seen.add(k)
          results.push(r)
        }
      }

      return cleanJson({
        ok: formal.ok !== false && chainRes.ok !== false,
        mode: 'mixed',
        degraded: !!(formal.degraded || chainRes.degraded),
        model: formal.model || chainRes.model,
        count: results.length,
        // layers = 实际返回的条数；matched = 各层命中多少（可能大于返回数）
        layers: {
          draft: results.filter((r: any) => r.layer === 'draft').length,
          chain: results.filter((r: any) => r.layer === 'chain').length,
          formal: results.filter((r: any) => r.layer === 'formal').length,
        },
        matched: {
          draft: draftHits.length,
          chain: chainHits.length,
          formal: formalHits.length,
        },
        results,
      })
    },
  }))

  // ── 工具 3：看草稿（跨会话实时板）─────────────────────
  // 草稿不是"临时记忆"，是**跨会话共享板**：A 会话说的话，B/C 会话立刻能查到。
  // "刚刚"不设时间参数——用户的刚刚可能是 1 小时也可能是 3 小时，
  // 所以工具返回"覆盖范围 + 每条距今"，由模型自己判断哪些算刚刚。
  ctx.tools.register(defineTool({
    name: 'memory_draft',
    description: '查看最近还没进正式存档的对话（跨会话共享板）。每条会标注「距今多久」，用户问"刚才那个"、"另一个窗口里我在做什么"时调用。默认每个会话最多 30 条，可用 minutes/limit/cid 过滤，不要反复全量拉。',
    parameters: {
      cid: { type: 'string', description: '只看某个会话（不填 = 全部会话）' },
      minutes: { type: 'number', description: '只看最近 N 分钟（不填 = 全部）' },
      limit: { type: 'number', description: '每个会话最多返回多少条（默认 30，最大 200）' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: any) {
      // 默认不再全量：每个会话最多 30 条，支持最近 N 分钟过滤
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 30))
      const minutes = Number(args.minutes)
      const cutoff = Number.isFinite(minutes) && minutes > 0 ? Date.now() - minutes * 60000 : 0
      const tsOf = (t: string) => {
        const ms = Date.parse(String(t).replace(' ', 'T') + ':00')
        return Number.isFinite(ms) ? ms : 0
      }
      const rows = app.draft.pending()
      const filtered = rows.filter((r: any) => {
        if (args.cid && r.cid !== args.cid) return false
        if (cutoff && tsOf(r.t) < cutoff) return false
        return true
      })
      if (!filtered.length) return { 覆盖范围: '（草稿为空：最近的对话都已提炼进正式存档）', 会话数: 0, 总计: 0, 会话: [], 时间线: [] }

      // 距今多久（本地时间，不碰 UTC）
      const ago = (t: string) => {
        try {
          const d = new Date(String(t).replace(' ', 'T') + ':00')
          const ms = Date.now() - d.getTime()
          if (!isFinite(ms) || ms < 0) return ''
          const m = Math.floor(ms / 60000)
          if (m < 1) return '刚刚'
          if (m < 60) return m + ' 分钟前'
          const h = Math.floor(m / 60)
          if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分钟前'
          return Math.floor(h / 24) + ' 天前'
        } catch (e) { return '' }
      }

      // 会话代号：用 cid 哈希生成稳定短码，不再按返回顺序 A/B/C 重排
      const label = (cid: string) => {
        const h = require('node:crypto').createHash('sha1').update(String(cid || 'unknown')).digest('hex').slice(0, 3).toUpperCase()
        return 'C' + h
      }

      // 时间相同返回 0——同一分钟的"问→答"顺序不能乱
      const sortedAll = filtered.slice().sort((a: any, b: any) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
      const first = sortedAll[0]
      const last = sortedAll[sortedAll.length - 1]

      const byCid = new Map<string, any[]>()
      for (const r of sortedAll) {
        const k = r.cid || 'unknown'
        if (!byCid.has(k)) byCid.set(k, [])
        byCid.get(k)!.push(r)
      }

      const groups: any[] = []
      for (const [cid, list] of byCid) {
        const shown = list.slice(-limit)
        groups.push({
          代号: label(cid),
          cid,
          条数: list.length,
          显示: shown.length,
          最后活动: list[list.length - 1].t + '（' + ago(list[list.length - 1].t) + '）',
          全部: shown.map((r: any) => ({ t: r.t, 距今: ago(r.t), s: r.s, c: r.c })),
          ...(list.length > shown.length ? { 省略: list.length - shown.length } : {}),
        })
      }
      groups.sort((a, b) => (a.最后活动 < b.最后活动 ? 1 : -1))

      // 跨会话时间线：默认最多展示 2×limit 条，避免一次把整块草稿拉进上下文
      const timelineLimit = Math.min(200, limit * 2)
      const timeline = sortedAll.slice(-timelineLimit).reverse()
        .map((r: any) => ({ t: r.t, 距今: ago(r.t), 会话: label(r.cid || 'unknown'), s: r.s, c: String(r.c).slice(0, 120) }))

      return cleanJson({
        覆盖范围: first.t + ' ~ ' + last.t + '（从 ' + ago(first.t) + '到' + ago(last.t) + '，共 ' + filtered.length + ' 条未提炼）',
        会话数: groups.length,
        总计: filtered.length,
        会话: groups,
        时间线: timeline,
      })
    },
  }))

  // 提炼不是工具——它是后台进程。用户不该知道"提炼"这个词。
  // 触发：草稿 ≥100 条立即跑；否则每 10 分钟兜底一次。

  // ── 工具 4：读常识层（兜底）─────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_common',
    description: '读取常识层（身份 + 常驻规范 + 说明书索引 + 链网索引）。正常情况下系统会自动加载，这个工具用于手动刷新。',
    parameters: {} as any,
    output: {
      schema: { type: 'string' },
      render: (_args: any, value: any) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return buildCommonText(app)
    },
  }))

  // ── 工具 5：读说明书（首次安装/升级必须通读）──────────
  ctx.tools.register(defineTool({
    name: 'memory_manual',
    description: '读唯一操作手册 RULES.md（写给你这个模型的，不是给用户读的）。首次安装/升级必须从第一节读到最后一节，**不要只读开头和结尾**。action：toc（看目录和进度）／read（读一节；不带 section 读下一节没读的）／status（看已读/未读）／ack（全部读完后标记完成；没读完会被拒绝）。没读完时改链网/话题会被拦住。',
    parameters: {
      action: { type: 'string', required: true, description: 'toc / read / status / ack' },
      section: { type: 'string', description: 'read：节号 0 起（如 "3"）或标题片段（如 "迁移"）；不填 = 下一节' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: any) {
      if (!manualReader) return { ok: false, error: '说明书阅读进度未加载（检查 docs/RULES.md 是否存在）' }
      const action = String(args.action || '').trim()
      try {
        if (action === 'toc') return cleanJson(manualReader.toc())
        if (action === 'read') return cleanJson(manualReader.read(args.section))
        if (action === 'status') return cleanJson(manualReader.status())
        if (action === 'ack') return cleanJson(manualReader.ack())
      } catch (e: any) {
        return { ok: false, error: '读说明书失败：' + (e && e.message) }
      }
      return { ok: false, error: '未知 action：' + action + '（可用：toc / read / status / ack）' }
    },
  }))

  // ── 工具 6：写身份（IDENTITY.md）─────────────────────
  // 结构由插件定死（四段模板 + identity.json），模型只能填字段内容。
  // 为什么不让它写自由文本：它会自己设计表格、自己加章节，换个模型结构就全变了。
  ctx.tools.register(defineTool({
    name: 'memory_identity',
    description: '记录身份信息。规则：**空字段直接填**（不用问）；**已有值只在用户自己明确提出修改时才动**（此时带 confirmed:true）。已有值但你只是想"更新一下"——**不要调用，也不要问用户要不要改**。不要自己设计结构，不要凭猜测填。',
    parameters: {
      aiName: { type: 'string', description: 'AI 的名字（只写名字本身）' },
      aiSelf: { type: 'string', description: '关于你的一句自述：名字的由来、性格。不要写平台、模型、能力清单' },
      userTitle: { type: 'string', description: '怎么称呼用户' },
      userInfo: { type: 'string', description: '用户是什么样的人：性格、职业/身份、在意的事。**不要写具体项目、工作进度、技术栈、待办、账户、路径、设备**——那些属于项目链和日常链，不属于身份' },
      relation: { type: 'string', description: '你们的关系' },
      style: { type: 'string', description: '相处方式 / 雷区 / 习惯' },
      confirmed: { type: 'boolean', description: '用户已明确同意修改已有字段时才传 true' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any) {
      const f = identityFiles()
      fs.mkdirSync(f.dir, { recursive: true })

      let old: any = {}
      try { old = JSON.parse(fs.readFileSync(f.json, 'utf8')) } catch (e) { old = {} }

      const FIELDS = ['aiName', 'aiSelf', 'userTitle', 'userInfo', 'relation', 'style']
      const meta: any = {}
      for (const k of FIELDS) meta[k] = old[k] || ''

      const filled: string[] = []          // 空字段 → 直接写
      const changed: string[] = []         // 用户明确提出修改 → 写入
      const ignored: string[] = []         // 已有值、用户没提 → 静默丢弃（不写、不问）

      for (const k of FIELDS) {
        const raw = args[k]
        if (raw === undefined || raw === null) continue
        const next = String(raw).trim()
        if (!next) continue
        const prev = String(old[k] || '').trim()

        if (!prev) {                        // 空白 → 直接写
          meta[k] = next
          filled.push(k)
          continue
        }
        if (prev === next) continue         // 相同 → 什么都不做
        // 已有值且不同：只有用户自己明确提出来才改
        if (args.confirmed === true) {
          meta[k] = next
          changed.push(k)
        } else {
          ignored.push(k)                   // 不问、不写——就当没这回事
        }
      }

      // 没填、没改 → 明确告诉模型"什么都没发生"，避免它以为写成功了
      if (!filled.length && !changed.length) {
        return cleanJson({
          ok: true,
          unchanged: true,
          filled: [],
          ...(ignored.length
            ? {
              ignored,
              hint: '这些字段已有值，而且用户没有要求修改——已忽略。**不要就这件事去问用户**，等用户自己提起。',
            }
            : { hint: '没有任何变化，未写入' }),
        })
      }

      const now = new Date().toISOString()
      const history = Array.isArray(old.history) ? old.history.slice(-49) : []
      for (const k of [...filled, ...changed]) {
        const isChange = changed.includes(k)
        if (isChange) history.push({ at: now, field: k, from: old[k] || '', to: meta[k], confirmed: true })
      }

      meta.updatedAt = now
      meta.history = history

      fs.writeFileSync(f.md, renderIdentity(meta), 'utf8')
      fs.writeFileSync(f.json, JSON.stringify(meta, null, 1), 'utf8')

      return cleanJson({
        ok: true,
        本次新填: filled,
        本次修改: changed,
        ...(ignored.length ? { 已忽略: ignored, hint: '这些字段已有值且用户没要求改，已忽略；不要就此事询问用户' } : {}),
        当前身份: { aiName: meta.aiName, userTitle: meta.userTitle },
      })
    },
  }))

  // ── 工具 7：链网（以核星为中心的树）──────────────────
  // 常识层是索引、链是摘要、原文是历史（用户 2026-11-07 定）。
  // 链负责"直接给出答案"，不让人每次都去翻原文。
  ctx.tools.register(defineTool({
    name: 'memory_chain',
    description: '访问链网（以「核星」为中心的树）。用户问"我喜欢什么/我们经历过什么/这个项目怎么样"之类，先看链——链里常常直接有答案。action：tree（看全貌）／get（读一条链；大链默认前3后3+中间抽样，可用 offset/limit/full）／append（往链里加节点；链不存在时建链，父链只能是核星、九个默认根或已有链，最多 4 层）／header（写链头概览，建议 ≤200 字，硬上限 500）／audit（体检：孤儿链、空链、重复节点、待补链头）。**get 返回 needHeader=true 时，读完顺手用 header 写一段 ≤200 字概览。**',
    parameters: {
      action: { type: 'string', required: true, description: 'tree / get / append / header / audit' },
      name: { type: 'string', description: '链名，如「身份链」「项目链-xxx」（get/append/header 必填）' },
      text: { type: 'string', description: 'append：节点正文；header：新的头部概览（建议 ≤200 字，硬上限 500）' },
      who: { type: 'string', description: 'append：这条属于谁——我 / 你 / 我们' },
      type: { type: 'string', description: 'append：event（事件，永不推翻）或 state（状态，可被推翻）' },
      supersedes: { type: 'string', description: 'append 状态节点时：被推翻的旧状态关键词（如"西瓜"）' },
      parent: { type: 'string', description: 'append 时链不存在：挂在哪个父节点下（默认「身份」；只能是核星、九个默认根或已有链）' },
      offset: { type: 'number', description: 'get：从第几个节点开始（0 起）' },
      limit: { type: 'number', description: 'get：取几个节点（offset 模式默认 10，最大 50）' },
      full: { type: 'boolean', description: 'get：true 才返回全部节点（大链慎用）' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: any) {
      const action = String(args.action || '').trim()

      if (action === 'tree') {
        return cleanJson(app.chain.tree())
      }

      if (action === 'audit') {
        const rows = app.chain.list()
        const dup: any[] = []
        for (const r of rows) {
          const c = app.chain.get(r.name)
          if (!c || !Array.isArray(c.nodes)) continue
          const seen = new Set<string>()
          for (const n of c.nodes) {
            const k = [n.t, n.text].join('\u0000')
            if (seen.has(k)) dup.push({ 链: r.name, t: n.t, text: String(n.text).slice(0, 80) })
            else seen.add(k)
          }
        }
        return cleanJson({
          ...app.chain.audit(),
          待补链头: rows.filter((r: any) => r.needHeader).map((r: any) => r.name),
          待刷新链头: rows.filter((r: any) => r.needRefresh).map((r: any) => r.name),
          重复节点: dup.slice(0, 20),
          重复总数: dup.length,
        })
      }

      if (action === 'get') {
        const c = app.chain.get(args.name)
        if (!c) return { ok: false, error: '链不存在：' + args.name, 建议: '先用 action=append 建链（会自动创建）' }
        const st = chainView.headerState(c)
        const sel = chainView.selectChainNodes(c.nodes, {
          full: args.full === true,
          offset: args.offset,
          limit: args.limit,
        })
        return cleanJson({
          ...c,
          ...st,
          nodes: sel.nodes,
          digest: sel.digest,
          indices: sel.indices,
          omitted: sel.omitted || 0,
        })
      }

      if (action === 'header') {
        const g = manualGate()
        if (!g.ok) return g
        return cleanJson(app.chain.setHeader(args.name, args.text, { by: 'lazy' }))
      }

      if (action === 'append') {
        const g = manualGate()
        if (!g.ok) return g
        const chainName = String(args.name || '').trim()
        if (!chainName) return { ok: false, error: 'append 需要 name' }
        // 链不存在就自动建：父链只允许核星 / 九个默认根 / 已有链，且最多 4 层。
        // 以前这里直接 create，父链不存在会在核星下悄悄造出新的顶层根。
        if (!app.chain.get(chainName)) {
          const parent = String(args.parent || '身份').trim() || '身份'
          if (parent === chainName) return { ok: false, error: '链名不能和父链同名：' + parent }
          if (!app.chain.get(parent)) {
            if (!CHAIN_ROOTS.has(parent)) {
              return {
                ok: false,
                error: '父链不存在：' + parent,
                hint: '只能挂到「核星」、九个默认根或已有链；不要新建顶层根。',
              }
            }
            app.chain.create(parent, '核星', '')
          }
          const chk = app.chain.checkParent(parent)
          if (!chk.ok) return { ok: false, error: chk.error, hint: chk.hint }
          app.chain.create(chainName, chk.parent, '')
        }
        return cleanJson(app.chain.append(chainName, {
          text: args.text,
          who: args.who,
          type: args.type,
          supersedes: args.supersedes,
        }))
      }

      return { ok: false, error: '未知 action：' + action + '（可用：tree / get / append / header / audit）' }
    },
  }))

  // ── 工具 8：话题栈 / 创意池 ─────────────────────────
  // 用户 2026-11-08 定：想法不需要相关，同类型累计 ≥5 条成立一条创意池链，
  // 一个节点一个想法；立项时从池里升格出独立项目链，原想法保留并挂 promoted_to。
  ctx.tools.register(defineTool({
    name: 'memory_topic',
    description: '话题栈 / 创意池。想法累计 ≥5 条会自动成立“创意池-年月”链；想立项时用 promote 从池里升格成项目链（想法保留）。action：list / get / add / promote / close / merge。',
    parameters: {
      action: { type: 'string', required: true, description: 'list / get / add / promote / close / merge' },
      id: { type: 'string', description: '话题 ID（get/promote/close/merge 必填）' },
      index: { type: 'number', description: 'promote：想法在 items 里的下标' },
      project: { type: 'string', description: 'promote：项目链名，如「项目链-光轴」' },
      type: { type: 'string', description: 'add：想法 / 学习 / 避坑 / 关系 / 项目 / 日常' },
      title: { type: 'string', description: 'add：话题标题（想法类可空，自动进月度创意池）' },
      text: { type: 'string', description: 'add：想法/话题正文' },
      who: { type: 'string', description: 'add：你 / 我 / 我们' },
      summary: { type: 'string', description: 'add：话题概览' },
      into: { type: 'string', description: 'merge：并入哪个话题 ID' },
      reason: { type: 'string', description: 'close：关闭原因' },
    } as any,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: any) {
      const action = String(args.action || '').trim()

      if (action !== 'list' && action !== 'get') {
        const g = manualGate()
        if (!g.ok) return g
      }

      if (action === 'list') {
        const topics = app.topic.list().slice(-100).map((t: any) => ({
          id: t.id, type: t.type, title: t.title, status: t.status,
          count: t.count, chain: t.chain || '',
        }))
        return cleanJson({ ok: true, stats: app.topic.stats(), topics })
      }

      if (action === 'get') {
        const t = app.topic.get(args.id)
        if (!t) return { ok: false, error: '话题不存在：' + args.id }
        return cleanJson(t)
      }

      if (action === 'add') {
        if (!args.text) return { ok: false, error: 'add 需要 text' }
        const type = String(args.type || '想法')
        if (!TOPIC_TYPES.includes(type)) {
          return { ok: false, error: 'type 不合法：' + type, allowed: TOPIC_TYPES }
        }
        const now = new Date()
        const p2 = (n: number) => String(n).padStart(2, '0')
        const t = args.t || `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`
        const r = app.topic.apply([{
          type, title: args.title || '', summary: args.summary || '',
          t, who: args.who || '', text: args.text,
        }], app.chain)
        return cleanJson({ ok: r.ok, added: r.added, promoted: r.promoted, topics: r.topics })
      }

      if (action === 'promote') {
        if (!args.id) return { ok: false, error: 'promote 需要 id' }
        const idx = Math.max(0, Number(args.index) || 0)
        return cleanJson(app.topic.promote(args.id, idx, args.project || '', app.chain))
      }

      if (action === 'close') {
        return cleanJson(app.topic.close(args.id, args.reason || ''))
      }

      if (action === 'merge') {
        return cleanJson(app.topic.merge(args.id, args.into))
      }

      return { ok: false, error: '未知 action：' + action + '（可用：list / get / add / promote / close / merge）' }
    },
  }))

  // ── 自动记录（用户无感：不需要模型记得调 memory_write）──────
  // 已处理消息指纹（进程内去重；重启后靠草稿层自身的去重兜底）
  // 指纹必须带 cid：同一个人在两个会话里说同一句话，是两条独立记忆。
  // 只按内容去重会把第二个会话的发言整条吞掉（2026-11-07 实测：
  // 两个测试会话只剩 AI 回复，用户消息被前一个会话的同文发言顶掉）。
  const seenMsgs = new Set<string>()
  // 最近一次对话请求用的模型（LLM 提炼优先复用宿主模型）
  let lastModel: { provider: string; model: string } | null = null
  // 防重入：定时器 + 对话驱动可能同时触发提炼
  let refining = false
  // 提炼阈值：草稿最老那条放了多久 / 一次最多攒多少
  const REFINE_INTERVAL_MS = 10 * 60 * 1000
  const REFINE_BATCH_MAX = 100
  // 旁听流挂载状态（只提示一次，避免刷屏）
  let tapLogged = false
  let tapWarned = false
  let msgShapeLogged = false
  let injectLogged = false

  /** token 累计失败绝不能打断对话 */
  function recordUsage(purpose: 'chat' | 'refine', usage: any) {
    try { app.usage.record(purpose, usage) } catch (e: any) {
      console.warn('[memory-system] token 统计写入失败：' + (e && e.message))
    }
  }

  /**
   * 构造 LLM 调用：优先宿主 ctx.llm，其次 OpenAI 兼容端点，最后返回 null（走规则降级）。
   * 不在这里做链逻辑——这里只负责“把提示词变成文本”。
   */
  function makeLlmCall() {
    const url = process.env.MEMORY_LLM_URL
    if (url) {
      const key = process.env.MEMORY_LLM_KEY || ''
      const model = process.env.MEMORY_LLM_MODEL || 'deepseek-chat'
      return async ({ system, user }: any) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { Authorization: 'Bearer ' + key } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.2,
            max_tokens: 1200,
          }),
        })
        if (!res.ok) throw new Error('LLM HTTP ' + res.status)
        const j: any = await res.json()
        if (j && j.usage) {
          recordUsage('refine', {
            inputTokens: j.usage.prompt_tokens,
            outputTokens: j.usage.completion_tokens,
          })
        }
        const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
        if (!text) throw new Error('LLM 返回为空')
        return String(text)
      }
    }

    if (lastModel && ctx.llm && typeof (ctx.llm as any).stream === 'function') {
      return async ({ system, user }: any) => {
        const stream = (ctx.llm as any).stream({
          provider: lastModel!.provider,
          model: lastModel!.model,
          // 提炼是结构化任务，不需要长推理；off 避免 reasoning 把输出预算吃光
          reasoningEffort: 'off',
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          temperature: 0.2,
          maxTokens: 2000,
          purpose: 'memory-refine',
        })
        let out = ''
        let reasoning = 0
        let usage: any = null
        for await (const ch of stream) {
          const u = chunkUsage(ch)
          if (u) usage = u
          if (ch && /reasoning-delta/i.test(String((ch as any).type || ''))) reasoning += String((ch as any).text || '').length
          const t = chunkText(ch)
          if (t) out += t
        }
        if (usage) recordUsage('refine', usage)
        console.log('[memory-system] LLM 提炼流：text=' + out.length + ' 字符，reasoning=' + reasoning + ' 字符')
        return out
      }
    }

    return null
  }

  /**
   * 到点就提炼：**对话驱动**，不依赖 setInterval。
   * 实测：定时器在插件重载后会失效（10 分钟没跑），所以改成"每次对话检查一次"。
   * 定时器仍保留作兜底，但即使它死了，用户一说话就会补上。
   *
   * 有 LLM：runWithLLM（入库 + 建链；LLM 失败原文仍入库，链进 llmPending 下次补）。
   * 没 LLM：run()（只入库 + 会话节点，不建语义链）。
   */
  async function refineNow() {
    if (refining) return
    refining = true
    try {
      const call = makeLlmCall()
      const r = call ? await app.refiner.runWithLLM(call, app.chain, app.topic) : app.refiner.run()
      if (r.added || r.alreadyStored) {
        console.log(`[memory-system] 提炼：入库 ${r.added} 条，跳过重复 ${r.alreadyStored || 0} 条，剩 ${app.draft.stats().pending} 条`)
      }
      if (r.llm) {
        console.log(`[memory-system] LLM 建链：链 ${r.llm.chains} 条，节点 ${r.llm.nodes} 个；话题 ${r.llm.topicItems || 0} 条，升格 ${(r.llm.topics || []).length} 个`)
      }
      if (r.llmError) {
        console.warn('[memory-system] LLM 提炼失败（原文已入库，链待补）：' + JSON.stringify(r.llmError))
      }
      if (r.added || (r.llm && (r.llm.nodes || r.llm.topicItems))) {
        setImmediate(async () => {
          try {
            const ir = await app.search.buildIndex()
            if (ir.added) console.log(`[memory-system] 建索引：新增 ${ir.added} 条，共 ${ir.total} 条`)
          } catch (e) { /* embed 不可用就下次再补，不影响记忆本身 */ }
          try {
            const cr = await app.chainSearch.buildIndex()
            if (cr.added) console.log(`[memory-system] 链节点索引：新增 ${cr.added} 条，共 ${cr.total} 条`)
          } catch (e) { /* 下次再补 */ }
        })
      }
    } catch (e) {
      console.error('[memory-system] 提炼失败：', e)
    } finally {
      refining = false
    }
  }

  function maybeRefine() {
    try {
      const rows = app.draft.pending()      // 已按时间升序
      if (!rows.length) {
        // 草稿空了，但上次 LLM 建链失败还留着 llmPending → 60 秒后补链
        const st = app.refiner.state()
        const pending = Array.isArray(st.llmPending) ? st.llmPending.length : 0
        if (pending) {
          const lastErr = st.lastLlmError && st.lastLlmError.at ? Date.parse(st.lastLlmError.at) : 0
          if (!lastErr || Date.now() - lastErr > 60 * 1000) {
            refineNow().catch((e) => console.error('[memory-system] 补链失败：', e))
          }
        }
        return
      }
      // 有草稿时也要补链：上次 LLM 失败留下的 llmPending，60 秒后重试
      // （重试会顺带处理当前草稿；早一点提炼不影响正确性）
      {
        const st = app.refiner.state()
        const pending = Array.isArray(st.llmPending) ? st.llmPending.length : 0
        if (pending) {
          const lastErr = st.lastLlmError && st.lastLlmError.at ? Date.parse(st.lastLlmError.at) : 0
          if (!lastErr || Date.now() - lastErr > 60 * 1000) {
            refineNow().catch((e) => console.error('[memory-system] 补链失败：', e))
            return
          }
        }
      }
      // 计时基准 = **草稿里最老那条的时间**，不是定时器周期，也不是上次提炼时间。
      // 否则：草稿落在周期末尾时，要多等一整个周期（用户 2026-11-06 指出）
      const oldest = String(rows[0].t || '')
      const oldestMs = new Date(oldest.replace(' ', 'T') + ':00').getTime()
      const age = isFinite(oldestMs) ? Date.now() - oldestMs : Infinity
      if (rows.length >= REFINE_BATCH_MAX || age > REFINE_INTERVAL_MS) {
        refineNow().catch((e) => console.error('[memory-system] 提炼失败：', e))
      }
    } catch (e) {
      console.error('[memory-system] 提炼检查失败：', e)
    }
  }

  /**
   * 记一条 AI 回复（来自旁听流）。
   * 单独一个函数，不走 autoCapture——因为 autoCapture 只收 user 消息
   * （messages 里的 assistant 混着 reasoning，不可信），两者规则不同。
   * 流里拿到的是**最终输出**，不需要剥 reasoning，只需剥代码和注入。
   */
  function captureAssistant(text: string, cid: string, streamKey: string) {
    try {
      // **只剥系统注入，不剥代码**：AI 回复正文里的代码也是对话的一部分
      // （用户 2026-11-07 定："如果代码直接回复在输出里，正常记录就行"）。
      // 工具调用里的代码本来就不会进这里——适配层只取 text 块，tool_use 参数不取。
      const cleaned = pure.stripNoise(text)
      if (cleaned.length < 2) return

      // 兜底：整段像 reasoning（英文思考句式、没有中文）就丢。
      // 上面的 chunkText 已经按 type 过滤过；这里防的是「流里没有 type 标记」的情况
      // （实测抓到过 "He asks: ... I should search" 这种）。
      if (!/[\u4e00-\u9fa5]/.test(cleaned) && /^(He|She|The user|I |I'll|Let me|Now|Ok|Okay|Hmm|Alright)\b/i.test(cleaned)) return
      // 每次流一个唯一键：同样的「好」「继续」在不同轮次是不同回复，
      // 不能按内容去重（否则第二遍「好」就丢了）；同一流的重复回调仍能挡住。
      const key = require('node:crypto').createHash('sha1').update('assistant\u0000' + cid + '\u0000' + (streamKey || cleaned)).digest('hex').slice(0, 16)
      if (seenMsgs.has(key)) return
      seenMsgs.add(key)

      const now = new Date()
      const p2 = (n: number) => String(n).padStart(2, '0')
      const t = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`
      const { ai } = resolveSpeakers()

      const wr = app.draft.add([{
        t, s: ai, c: cleaned.slice(0, 4000), cid, v: 1, type: 'ai', origin: 'ai',
        ...(streamKey ? { mid: streamKey } : {}),
      }])
      if (!wr.ok) {
        console.error('[memory-system] AI 回复写入草稿失败：' + JSON.stringify(wr.errors || []).slice(0, 300))
      }
      maybeRefine()
    } catch (e) {
      console.error('[memory-system] 记录 AI 回复失败：', e)
    }
  }

  /**
   * 从 time-context 注入里取「本次请求的时间」。
   * DSH 会在上下文里塞一条 time-context，里面有精确到秒的当前时间
   * （2026-11-06 实测：`Time sampled while preparing turn 6, step 1: 2026-11-06T23:28:32+08:00`）。
   * 这是整个上下文里唯一可靠的时间来源。
   */
  function requestTime(messages: any[]): string | null {
    // **从后往前找**：上下文里可能有多条 time-context（历史各轮各一条），
    // 从头找会拿到最旧那条（实测：23:28 的对话被标成 21:16）
    for (let i = messages.length - 1; i >= 0; i--) {
      let raw = ''
      try { raw = JSON.stringify((messages[i] && messages[i].source) || '') } catch (e) { raw = '' }
      const hit = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw)
      if (hit) return hit[1] + ' ' + hit[2]
    }
    return null
  }

  /** 优先用 time-context，但只信“和现在相差 10 分钟以内”的那条；否则退回捕获时刻 */
  function draftTimeOf(messages: any[], fallback: string): string {
    const rt = requestTime(messages)
    if (!rt) return fallback
    const ms = Date.parse(rt.replace(' ', 'T') + ':00')
    if (Number.isFinite(ms) && Math.abs(Date.now() - ms) <= 10 * 60 * 1000) return rt
    return fallback
  }

/** 统一的消息时间：**优先用消息自带时间戳**，没有才退回当前时间 */
  function stampOf(m: any): string {
    const raw = m && (m.ts || m.timestamp || m.createdAt || m.time || (m.meta && m.meta.ts))
    if (raw) {
      const d = new Date(raw)
      if (!isNaN(d.getTime())) {
        const p2 = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
      }
    }
    const now = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`
  }

  function autoCapture(messages: any[], cid: string) {
    const { user } = resolveSpeakers()

    // 诊断：只打一次，看 DSH 的消息到底带哪些字段
    if (!msgShapeLogged && messages.length) {
      msgShapeLogged = true
      const sample = messages[messages.length - 1]
      console.log('[memory-system] 消息字段样本：' + Object.keys(sample || {}).join(', ')
        + ' | ts=' + String(sample && (sample.ts || sample.timestamp || sample.createdAt || sample.time))
        + ' | id=' + JSON.stringify(sample && sample.id)
        + ' | source=' + JSON.stringify(sample && sample.source))
    }

    /**
     * **只处理最后一条真话**（逻辑在 adapter_pure.js，单测覆盖）。
     *
     * 为什么不遍历全部：DSH 的消息只有 content/source/role/id，**没有时间字段**
     * （2026-11-06 实测 ts=undefined）。遍历全部会把上下文里几十条历史消息
     * 全部标成"现在"的同一分钟，时间线彻底错乱（实测 33 条时间全一样）。
     * 历史数据本来就该靠迁移导入，不该在这里重复抓。
     */
    const picked = pure.pickLastUserMessage(messages)
    if (!picked) return
    const last: any = picked.message
    const text: string = picked.text

    // 去重键用「这次发送」的唯一标识，不能用内容：
    // 同一个人在同一会话里说两次「在吗 / 继续」是两条真实发言，
    // 按内容去重会把第二次吞掉。DSH 持久化后的 user 消息没有 id，
    // 但 source.rpcId 是每次发送唯一的（2026-11-07 实测）；
    // 同一消息被多步重复处理时 rpcId 不变，仍能挡住。
    const platformMid = String((last.source && last.source.rpcId) || last.id || '')
    const msgIdentity = platformMid || text
    const key = require('node:crypto').createHash('sha1').update(pure.dedupeKey('user', cid, msgIdentity)).digest('hex').slice(0, 16)
    if (seenMsgs.has(key)) return
    seenMsgs.add(key)

    try {
      const wr = app.draft.add([{
        // 优先用本轮 time-context（10 分钟内才信）；不在窗口内退回捕获时刻，保证顺序不乱
        t: draftTimeOf(messages, stampOf(last)),
        s: user,
        c: text.slice(0, 4000),
        // 平台消息 ID：同分钟同文的两条发言靠它区分（格式契约里的可选 mid）
        ...(platformMid ? { mid: platformMid } : {}),
        cid,
        v: 1,
        type: 'human',
        origin: 'human',
      }])
      if (!wr.ok) {
        console.error('[memory-system] 用户消息写入草稿失败：' + JSON.stringify(wr.errors || []).slice(0, 300))
      }
      maybeRefine()
    } catch (e) {
      console.error('[memory-system] 自动记录失败：', e)
    }
  }

  // ── 常识层自动注入（agent/pre-step waterfall）──────────
  // 这是 DSH 官方支持的注入点：pre-step 返回的 decision.messages 就是
  // 本步请求要带的全部消息。模型选择通知也是这么追加的（dsh-agent 源码）。
  // 之前挂在 llm/stream 上改 options.messages——日志说“已注入”，模型却看不到，
  // 因为 waterfall 的 next() 不接受改过的 options（2026-11-07 实测）。
  ctx.on('agent/pre-step', async ({ agent, signal }: any, next: any) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject' || signal?.aborted) return decision
      const list = Array.isArray(decision.messages) ? decision.messages : []
      // 同一步里已有常识层就不重复插（工具循环里会多次进 pre-step）；
      // 历史里已有也不插（常识层会作为 user/message 留在会话里，
      // 压缩把它裁掉后这里会重新补上）
      if (list.some((m: any) => textOf(m).includes(COMMON_MARK))) return decision
      if (historyHasCommon(agent)) return decision

      const commonMsg = {
        role: 'user',
        // DSH 的用户消息必须带 id（实测：缺 id 会让会话历史校验失败）
        id: 'memory-common-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        content: [{ type: 'text', text: buildCommonText(app) }],
        // 带 source.kind 标记：autoCapture 会跳过它，不会把常识层当成用户发言记进草稿
        source: { kind: 'memory-common', form: 'notice', summary: '记忆系统常识层' },
      }
      if (!injectLogged) {
        injectLogged = true
        console.log('[memory-system] 常识层：已通过 agent/pre-step 注入')
      }
      return { ...decision, messages: [commonMsg, ...list] }
    } catch (e) {
      console.error('[memory-system] 常识层注入失败：', e)
      return decision
    }
  })

  // ── 自动记录 + 旁听流（llm/stream waterfall）──────
  // 注意：必须是同步函数——llm/stream 的返回值是 AsyncIterable，
  // 用 async 包装会变成 Promise<AsyncIterable>，上层会报 "stream is not async iterable"
  ctx.on('llm/stream', (options: any, next: any) => {
    let sid = 'dsh-session'
    let streamKey = ''
    try {
      // 内部提炼调用不算对话：不要记录、不要注入、不要改 lastModel
      if (options.purpose === 'memory-refine') return next()
      if (!isAgentLoopRequest(options)) return next()
      if (options.provider && options.model) {
        lastModel = { provider: String(options.provider), model: String(options.model) }
      }
      const messages = options.messages
      if (!Array.isArray(messages) || !messages.length) return next()

      // ① 自动记录（setImmediate 异步，不阻塞本次请求）
      // cid 必须带平台前缀：将来接 ZCode/星枢时，各平台会话 ID 可能重名，
      // 不带前缀会混成一团（用户 2026-11-06 指出）
      const rawSid = (options.session && (options.session.id || options.session.sessionId))
        || options.sessionId || 'unknown'
      sid = String(rawSid).startsWith('dsh:') ? String(rawSid) : 'dsh:' + rawSid
      streamKey = sid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10)
      const snapshot = messages.slice()
      setImmediate(() => { try { autoCapture(snapshot, sid) } catch (e) { /* 绝不打断对话 */ } })
    } catch (e) {
      console.error('[memory-system] 记录失败：', e)
    }

    // ② 兜底：旁听本轮输出，流结束时把 AI 回复补进草稿。
    // 解决"用户说完就走 → 最后一条 AI 回复永远抓不到"（见待办清单第二节缺口 1）。
    const stream = next()
    try {
      // 用 captureAssistant 而不是 autoCapture——后者只收 user 消息，会把这里拦掉
      const tapped = tapStream(
        stream,
        (text, meta) => { if (!meta || !meta.tool) captureAssistant(text, sid, streamKey) },
        (usage) => { recordUsage('chat', usage) },
      )
      if (tapped !== stream && !tapLogged) {
        tapLogged = true
        console.log('[memory-system] 旁听流已挂载（AI 回复会被记录）')
      } else if (tapped === stream && !tapWarned) {
        tapWarned = true
        console.warn('[memory-system] 旁听流未挂载：llm/stream 返回的不是 AsyncIterable，AI 回复可能漏记')
      }
      return tapped
    } catch (e) {
      return stream
    }
  })

  // ── 定时兜底（每 3 分钟检查一次，到不到 10 分钟由 maybeRefine 判断）──
  // 主要靠对话驱动，这个定时器只是兜底；即使它失效，用户一说话也会补上。
  ctx.effect(() => {
    const timer = setInterval(() => { maybeRefine() }, 3 * 60 * 1000)
    return () => clearInterval(timer)
  })

  // ── 链网展示窗（跟 DSH 生命周期起停）──
  startViewer(ctx, app, embedService)

  // ── 启动时补一次向量索引 ──
  // 场景：上次 embed 服务没起来 / 进程中途退出，会导致存档有内容但索引缺失。
  // 延迟 5 秒，避免和启动抢资源；失败也不影响使用（检索会降级关键词并标明）。
  ctx.effect(() => {
    const t = setTimeout(async () => {
      try {
        const ir = await app.search.buildIndex()
        if (ir.added) console.log(`[memory-system] 启动补索引：新增 ${ir.added} 条，共 ${ir.total} 条`)
      } catch (e) { /* 静默：embed 不可用时下次再补 */ }
      try {
        const cr = await app.chainSearch.buildIndex()
        if (cr.added) console.log(`[memory-system] 启动补链索引：新增 ${cr.added} 条，共 ${cr.total} 条`)
      } catch (e) { /* 静默 */ }
    }, 5000)
    return () => clearTimeout(t)
  })
}

