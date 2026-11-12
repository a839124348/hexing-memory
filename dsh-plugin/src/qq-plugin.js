/**
 * hexing-qq —— 把 OneBot 11 的 QQ 消息接进 DSH 的 agent
 *
 * 这是插件壳，不做记忆、不做模型：
 *   OneBot 事件 → normalize → router → QQSessionMap → agent.followup
 *   DSH session 的 assistant 文本 → QQOutbound → OneBot 发送
 *
 * 群模式默认关闭；打开前要先让记忆插件跳过 qq:group: 会话的自动记录/常识层注入。
 * owner 私聊二选一：专用 qq:owner，或 ownerSessionId 绑定已有会话（只回 QQ 轮次）。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { QQSessionMap } from './qq/session-map.js';
import { QQOutbound } from './qq/outbound.js';
import { GroupResponder } from './qq/group-responder.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QQ_CORE = path.join(__dirname, '..', '..', 'qq-bridge', 'src');

const { createTransport } = require(path.join(QQ_CORE, 'transport.js'));
const { classify, shouldHandle, ROUTES } = require(path.join(QQ_CORE, 'router.js'));
const { GroupBoard } = require(path.join(QQ_CORE, 'group-board.js'));
const { SendGuard } = require(path.join(QQ_CORE, 'guard.js'));
const { loadPublicProjects, formatPublicProjects } = require(path.join(QQ_CORE, 'public-projects.js'));
const { loadSupportKb, formatSupportKb } = require(path.join(QQ_CORE, 'support-kb.js'));
const { loadPublicIdentity } = require(path.join(QQ_CORE, 'public-identity.js'));
const { listSessions, localTime } = require(path.join(QQ_CORE, 'session-catalog.js'));

export const name = 'hexing-qq';
export const inject = ['agents', 'agentPresets', 'workspaceRegistry', 'sessions', 'timer', 'tools', 'llm'];

const DEFAULTS = {
  // 二选一：onebot | official；同一时间只启用一个
  transport: 'onebot',
  onebot: { url: 'ws://127.0.0.1:3001', token: '' },
  official: { appId: '', clientSecret: '', intents: ['GROUP_AND_C2C_EVENT'], groupNames: {} },
  ownerId: '',
  ownerOpenId: '',
  provider: '',
  model: '',
  agentPreset: 'standard',
  groupPreset: 'minimal',
  groupEnabled: false,
  // stateless：群聊不建 DSH 会话，只走 24h 分板 + 一次性回复；
  // session：旧行为（一个群一个 DSH 会话），留作回退。
  groupMode: 'stateless',
  cwd: '~/.dsh/qq-workspace',
  qqRoot: '',
  memoryRoot: '',
  ownerName: '',
  ownerGroupName: '',
  aiName: '',
  // 2026-11-13：AI 与 owner 的关系（如「助手」「朋友」）。留空 = 只说「记忆助手」，
  // 不预设关系；公开模式自我介绍用这个值。
  relation: '',
  privateTitle: '大号私聊会话',
  // 二选一：
  // - 空 = 专用会话 qq:owner（默认，QQ 与主会话隔离）
  // - 填已有 DSH session id = 把 owner 私聊接进那个会话（共享上下文）
  ownerSessionId: '',
  dryRun: true,
  groupPrefix: '',
  guard: { enabled: true, groupMinMs: 10000, privateMinMs: 0, dedupeMs: 3000, quietHours: [] },
};

function defaultMemoryRoot() {
  return process.env.MEMORY_ROOT
    || path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'dsh-memory');
}

function defaultQQRoot() {
  return path.join(defaultMemoryRoot(), 'qq');
}

function buildGroupPrefix(cfg, identity = {}) {
  // 群里用“群昵称”称呼 owner；没有群昵称才退回 identity.userTitle / ownerName。
  const name = String(cfg.ownerGroupName || identity.userTitle || cfg.ownerName || '').trim();
  const groupName = name || '大号';
  // AI 名字优先读 memory 的公开身份（identity.json.aiName），这样改身份不用会话/工具也能同步。
  const aiName = String(identity.aiName || cfg.aiName || '').trim();
  // 2026-11-13：默认不预设任何私人关系。关系由用户自己配 relation（如“助手/朋友”），
  // 没配就只说“记忆助手”，不替用户假设。
  const relation = String(cfg.relation || identity.relation || '').trim();
  const selfIntro = relation
    ? (aiName ? `我是${aiName}，是${groupName}的${relation}` : `我是${groupName}的${relation}`)
    : (aiName ? `我是${aiName}，是${groupName}用的记忆助手` : `我是${groupName}用的记忆助手`);
  const ownerExample = name
    ? `“${name}，这个话题我们私下说吧”`
    : '“这个话题我们私下说吧”';
  const otherExample = name
    ? `“这个要问过${name}本人哦”`
    : '“这个要问过群主本人哦”';
  return [
    '你是群聊公开模式：温柔、自然、半幽默、简短。先接当前这条 @ 的话，再决定要不要说别的；一般 1–2 句，能一句说清就一句，不列点、不复述问题、不客套。',
    '回复时不要自己写 @，桥会自动 @ 提问的人；直接写回复内容。',
    '不要主动自我介绍，也不要在每条回复里带名字/身份；只有别人问“你是谁 / 你和群主什么关系”时，才说一次。',
    `被问到时的公开身份（不要主动说）：${selfIntro}。`,
    `名字是称呼，不是口头禅：一条回复里最多出现一次${groupName}，能不用就不用；不要每句都叫。`,
    `别人问“你是谁 / 你和${groupName}什么关系”：可以大方说这句；必要时可以 @${groupName}（大号），但不要每句都 @。`,
    '别人问“你记得我们吗 / 能帮我记私事吗”：群里只做公开答疑，不记群友私事，也不把私聊或别的群内容带过来。',
    '可以解释核星记忆的公开隐私机制（本地明文、无删除工具、群聊不入主记忆），但不要主动说“隐私问题都可以问我”，也不邀请群友问自己的私事。',
    `别人问${groupName}的私事 / 项目细节：温柔挡回，不展开；不要提私聊记忆、住址、工作、约定等私事。`,
    '别人问你是不是 AI：坦白是，不用每次都补一段自我介绍。',
    '遇到隐私/私聊话题不要生硬拒绝，也不要每次用同一句；短一句、看对象换说法：',
    `- 如果成员标了 owner：温和挡回，例如 ${ownerExample}，不要展开内容。`,
    `- 如果没标 owner：替 owner 挡一下，例如 ${otherExample}，不要透露私事。`,
    '聊天像群里的人，不像客服：不说“关于…的问题”“您可以”“如需帮助”这类话；不背 KB，只挑和当前问题相关的一两句说。',
    '不确定就直说“这个我不确定”，不要编；被纠正就认，不要嘴硬。',
    '可以带一个可爱表情，但不要多。',
  ].join('\n');
}

function stripLeadingMentions(text, names) {
  let remaining = String(text || '').trim();
  for (const n of names) {
    if (n && remaining.startsWith('@' + n)) {
      remaining = remaining.slice(('@' + n).length).trimStart();
    }
  }
  return remaining;
}

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function logPrefix(level, msg) {
  const line = `[hexing-qq] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function apply(ctx, rawConfig = {}) {
  const cfg = {
    ...DEFAULTS,
    ...rawConfig,
    transport: String(rawConfig.transport || DEFAULTS.transport).toLowerCase(),
    onebot: { ...DEFAULTS.onebot, ...(rawConfig.onebot || {}) },
    official: { ...DEFAULTS.official, ...(rawConfig.official || {}) },
    ownerId: String(rawConfig.ownerId || DEFAULTS.ownerId || ''),
    ownerOpenId: String(rawConfig.ownerOpenId || DEFAULTS.ownerOpenId || ''),
    cwd: expandHome(rawConfig.cwd || DEFAULTS.cwd),
    qqRoot: expandHome(rawConfig.qqRoot || defaultQQRoot()),
    memoryRoot: expandHome(rawConfig.memoryRoot || defaultMemoryRoot()),
    guard: { ...DEFAULTS.guard, ...(rawConfig.guard || {}) },
  };

  // 侧边栏切换器写的本地覆盖；优先于 profile 里的 transport，重启生效。
  try {
    const overrideFile = path.join(cfg.qqRoot, 'transport.json');
    const j = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    const t = String(j && j.transport || '').toLowerCase();
    if (t === 'onebot' || t === 'official') cfg.transport = t;
  } catch (e) { /* 没有覆盖文件就用 profile 配置 */ }

  if (!['onebot', 'official'].includes(cfg.transport)) {
    logPrefix('error', `未知 transport：${cfg.transport}（只支持 onebot / official）`);
    return;
  }

  // 官方模式的 owner 是 user_openid；OneBot 模式是 QQ 号。
  // 官方 owner 只能是 user_openid；不能拿 OneBot 的 QQ 号回退。
  const activeOwnerId = cfg.transport === 'official' ? cfg.ownerOpenId : cfg.ownerId;
  if (!activeOwnerId) {
    if (cfg.transport === 'official') {
      // 官方模式的引导：先启动，私聊 bot 后从日志拿 user_openid，再填 ownerOpenId 重启。
      logPrefix('warn', '官方模式缺少 ownerOpenId：先启动；私聊 bot 后把日志里的 user_openid 填进 ownerOpenId，再重启');
    } else {
      logPrefix('error', '缺少 ownerId，插件未启动');
      return;
    }
  }
  // 下游 classify 统一用 cfg.ownerId 比较；官方模式下它代表 openid。
  cfg.ownerId = String(activeOwnerId || '');

  const log = {
    info: (m) => logPrefix('info', m),
    warn: (m) => logPrefix('warn', m),
    error: (m) => logPrefix('error', m),
  };

  // 只写“有没有配置/连没连上”，不写 token、secret、owner。
  function writeTransportStatus(patch = {}) {
    const status = {
      selected: cfg.transport,
      onebotConfigured: Boolean(cfg.onebot && cfg.onebot.url),
      officialConfigured: Boolean(cfg.official && cfg.official.appId && cfg.official.clientSecret),
      ownerConfigured: Boolean(cfg.ownerId),
      updatedAt: new Date().toISOString(),
      ...patch,
    };
    try {
      fs.mkdirSync(cfg.qqRoot, { recursive: true });
      const file = path.join(cfg.qqRoot, 'transport-status.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn(`transport 状态写入失败：${e.message}`);
    }
  }
  writeTransportStatus();

  function rememberGroupName(gid, name) {
    const g = String(gid || '').trim();
    const n = String(name || '').trim();
    if (!g || !n) return;
    try {
      const file = path.join(cfg.qqRoot, 'group-names.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* 新文件 */ }
      if (cur[g] === n) return;
      cur[g] = n;
      fs.mkdirSync(cfg.qqRoot, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn(`群名映射写入失败：${e.message}`);
    }
  }

  if (cfg.official && cfg.official.groupNames) {
    for (const [gid, name] of Object.entries(cfg.official.groupNames)) rememberGroupName(gid, name);
  }

  const bindingFile = path.join(cfg.qqRoot, 'binding.json');
  const sessionRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

  function readBindingFile() {
    try {
      const raw = fs.readFileSync(bindingFile, 'utf8');
      const j = JSON.parse(raw);
      const id = String(j.ownerSessionId || '').trim();
      if (!id || id.startsWith('qq:group:')) return null;
      return { ownerSessionId: id, title: String(j.title || '').trim(), boundAt: Number(j.boundAt) || 0 };
    } catch (e) {
      return null;
    }
  }

  function writeBindingFile(next) {
    fs.mkdirSync(path.dirname(bindingFile), { recursive: true });
    const tmp = bindingFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, bindingFile);
  }

  function clearBindingFile() {
    try {
      fs.rmSync(bindingFile, { force: true });
    } catch (e) {
      // ignore
    }
  }

  // 工具绑定优先于配置里的 ownerSessionId；两者都没有 = 专用 qq:owner。
  function effectiveBinding() {
    const fromTool = readBindingFile();
    if (fromTool) return { ...fromTool, source: 'tool' };
    const fromConfig = String(cfg.ownerSessionId || '').trim();
    if (fromConfig) return { ownerSessionId: fromConfig, title: '', source: 'config' };
    return null;
  }

  function liveSessionTitle(sessionId) {
    const session = ctx.sessions?.get?.(sessionId);
    if (!session) return '';
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
    try {
      const snap = svc?.get?.(session);
      if (snap && snap.title) return String(snap.title);
    } catch (e) {
      // ignore
    }
    return '';
  }

  function sessionRows() {
    const byId = new Map();
    for (const r of listSessions(sessionRoot)) {
      if (String(r.id).startsWith('qq:group:')) continue;
      byId.set(String(r.id), r);
    }
    for (const s of ctx.sessions?.list?.() || []) {
      const id = String(s.id || '');
      if (!id || id.startsWith('qq:group:')) continue;
      const existing = byId.get(id) || { id, cwd: '', lastActive: 0 };
      const liveTitle = liveSessionTitle(id);
      byId.set(id, {
        ...existing,
        title: liveTitle || existing.title || '（未命名）',
        cwd: existing.cwd || String(s.cwd || ''),
        lastActive: Date.now(),
      });
    }
    return [...byId.values()].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }

  function findCandidates(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const rows = sessionRows();
    const exact = rows.filter((r) => String(r.title || '').trim().toLowerCase() === q);
    if (exact.length) return exact;
    return rows.filter((r) => String(r.title || '').toLowerCase().includes(q));
  }

  function candidateView(rows) {
    return rows.slice(0, 5).map((r) => ({
      id: r.id,
      title: r.title,
      lastActive: localTime(r.lastActive),
      cwd: r.cwd || '',
    }));
  }

  const startupBinding = effectiveBinding();
  if (startupBinding) {
    log.info(`owner 私聊绑定会话：${startupBinding.ownerSessionId}${startupBinding.title ? `（${startupBinding.title}）` : ''}（消息带 [QQ私聊]，只回 QQ 轮次）`);
  } else {
    log.info('owner 私聊使用专用会话 qq:owner');
  }

  // 让用户 DSH 里的模型自己完成绑定：用户只需说会话名字。
  // 只写 binding.json，热生效，不重启 DSH。
  ctx.tools.register(defineTool({
    name: 'qq_bind_session',
    description: '把 owner 的 QQ 私聊绑定到 DSH 会话。用户说“QQ 接到这个会话/当前会话”用 action=current；用户说“接到‘某某’会话”用 action=title 并填 title；用户说“取消/断开 QQ 绑定”用 action=unbind。只绑 owner 私聊，群会话永远不能绑。绑定后 QQ 消息带 [QQ私聊] 前缀，只有 QQ 触发的轮次回 QQ。',
    parameters: {
      action: {
        type: 'string',
        enum: ['current', 'title', 'unbind'],
        description: 'current=绑当前会话（默认）；title=按标题查找并绑定；unbind=取消绑定',
      },
      title: {
        type: 'string',
        description: 'action=title 时必填：用户说的会话标题/名字，可以只给一部分',
      },
      sessionId: {
        type: 'string',
        description: '已知精确 session id 时可直接指定，一般不用',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args = {}, exec) {
      const action = String(args.action || 'current');
      const currentId = String(exec?.agent?.session?.id || '');
      if (currentId.startsWith('qq:group:')) {
        return { ok: false, error: '群会话不能绑定 QQ 私聊' };
      }

      if (action === 'unbind') {
        clearBindingFile();
        const cfgId = String(cfg.ownerSessionId || '').trim();
        return {
          ok: true,
          mode: cfgId ? 'config-bound' : 'dedicated',
          note: cfgId
            ? `已清除模型绑定；配置 ownerSessionId=${cfgId} 仍然生效`
            : '已取消绑定，QQ 私聊回到专用会话 qq:owner',
        };
      }

      let targetId = '';
      let targetTitle = '';
      if (action === 'title') {
        const q = String(args.title || '').trim();
        if (!q) return { ok: false, error: 'action=title 时必须提供 title' };
        const candidates = findCandidates(q);
        if (!candidates.length) {
          return {
            ok: false,
            error: `没有找到标题包含「${q}」的会话`,
            candidates: candidateView(sessionRows()),
          };
        }
        if (candidates.length > 1) {
          return {
            ok: false,
            error: `标题「${q}」匹配到多个会话，请让用户确认是哪一个`,
            candidates: candidateView(candidates),
          };
        }
        targetId = String(candidates[0].id);
        targetTitle = String(candidates[0].title || '');
      } else {
        targetId = String(args.sessionId || currentId || '').trim();
        if (!args.sessionId && currentId === 'qq:owner') {
          return {
            ok: true,
            mode: 'dedicated',
            sessionId: 'qq:owner',
            note: '当前就是专用 qq:owner 会话，无需绑定；要绑到别的会话，请说会话名字',
          };
        }
        targetTitle = liveSessionTitle(targetId)
          || sessionRows().find((r) => r.id === targetId)?.title
          || '';
        if (targetTitle === '（未命名）') targetTitle = '';
      }

      if (!targetId) return { ok: false, error: '没有可绑定的会话' };
      if (targetId.startsWith('qq:group:')) return { ok: false, error: '群会话不能绑定 QQ 私聊' };

      let exists = !!(ctx.agents.get?.(targetId) || ctx.sessions?.get?.(targetId));
      if (!exists) {
        try {
          const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null;
          const snap = await persistence?.stat?.(targetId);
          exists = !!snap;
        } catch (e) {
          // ignore
        }
      }
      if (!exists) return { ok: false, error: `会话 ${targetId} 不存在或无法恢复` };

      writeBindingFile({
        ownerSessionId: targetId,
        title: targetTitle,
        boundAt: Date.now(),
        boundBy: 'qq_bind_session',
      });
      log.info(`QQ 私聊绑定到会话：${targetId}${targetTitle ? `（${targetTitle}）` : ''}`);
      return {
        ok: true,
        mode: 'bound',
        sessionId: targetId,
        title: targetTitle,
        note: '立即生效，不用重启；QQ 消息带 [QQ私聊] 前缀，只有 QQ 触发的轮次回 QQ',
      };
    },
  }));

  let transport;
  try {
    transport = createTransport(cfg, log);
  } catch (e) {
    log.error(`QQ transport 创建失败：${e.message}`);
    writeTransportStatus({ connected: false, lastError: e.message });
    return;
  }

  let selfId = '';
  let ownerGroupName = String(cfg.ownerGroupName || '').trim();
  const board = new GroupBoard({ root: cfg.qqRoot });
  const guard = new SendGuard(cfg.guard);
  const groupQueues = new Map();
  const groupNameCache = new Map();

  const groupResponder = new GroupResponder({
    llm: ctx.llm,
    provider: cfg.provider,
    model: cfg.model,
    logger: log,
  });
  const useStatelessGroup = cfg.groupMode !== 'session' && groupResponder.available();
  if (cfg.groupMode !== 'session' && !useStatelessGroup) {
    log.warn('群聊 stateless 需要 provider/model 与 ctx.llm.stream；本次回退到 group session');
  }

  // 群板 24h：启动清一次，之后每小时扫一次；不依赖有没有人读写。
  const sweepBoard = () => {
    try {
      const r = board.sweep();
      if (r && r.prunedFiles) log.info(`群板清扫：删除 ${r.prunedFiles} 个过期板`);
      return r;
    } catch (e) {
      log.warn(`群板清扫失败：${e.message}`);
      return null;
    }
  };
  sweepBoard();
  const sweepTimer = setInterval(sweepBoard, 60 * 60 * 1000);
  sweepTimer.unref?.();

  // 一个群一个 DSH 会话：同群消息串行，保证当前 @ 的群友和本轮回复对得上。
  function enqueueGroup(gid, job) {
    const key = String(gid);
    const prev = groupQueues.get(key) || Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.catch(() => {}).finally(() => {
      if (groupQueues.get(key) === tail) groupQueues.delete(key);
    });
    groupQueues.set(key, tail);
    return run;
  }

  const sessionMap = new QQSessionMap({
    ctx,
    config: cfg,
    logger: log,
    makeSessionId: (id) => SessionId(id),
    makeUserMessage: createUserMessage,
    pluginName: 'hexing-qq',
  });

  const outbound = new QQOutbound({
    ctx,
    sessionMap,
    logger: log,
    guard,
    send: async (chat, text) => {
      if (chat.kind === 'private') {
        await transport.reply(chat, text, { mentionSender: false });
        return;
      }

      // 群回复自动 @ 提问的人；模型不用自己写 @。
      const remaining = stripLeadingMentions(text, [chat.senderName, ownerGroupName]);

      await transport.reply(chat, remaining, { mentionSender: true });
      board.append({
        gid: chat.groupId,
        uid: chat.userId,
        role: 'assistant',
        text,
        ts: Date.now(),
      });
    },
  });
  outbound.install();

  ctx.on('session/event', (session, event) => {
    const sid = String(session?.id || '');
    if (sid.startsWith('qq:')) log.info(`[qq] session event：${event?.type}`);
  });
  ctx.on('agent/error', (payload) => {
    const msg = payload && payload.error && payload.error.message
      ? payload.error.message
      : JSON.stringify(payload || {}).slice(0, 300);
    log.error(`[qq] agent/error：${msg}`);
  });

  // QQ 会话没有客户端审批按钮：owner 私聊只自动放行记忆类工具，其他工具拒绝；
  // 群公开模式一律拒绝工具，避免群友借工具读私聊/跑命令。
  const SAFE_TOOLS = new Set([
    'memory_search', 'memory_draft', 'memory_common', 'memory_manual',
    'memory_chain', 'memory_topic', 'memory_write', 'memory_identity',
    'memory_onboarding', 'qq_bind_session',
  ]);
  ctx.on('approval/request', (req, next) => {
    const sid = String(req.agent?.session?.id || '');
    if (!sid.startsWith('qq:')) return next();
    const tool = String(req.toolName || '');
    if (sid.includes('qq:group:')) {
      log.warn(`[qq] 群会话工具审批拒绝：${tool}`);
      return 'rejected';
    }
    if (SAFE_TOOLS.has(tool)) return 'allowed-once';
    log.warn(`[qq] 非记忆工具审批拒绝：${tool}`);
    return 'rejected';
  });

  transport.on('ready', (info) => {
    selfId = String((info && info.selfId) || '');
    log.info(`机器人已登录：${selfId || '未知'}${info && info.nickname ? `（${info.nickname}）` : ''}`);
    writeTransportStatus({
      connected: true,
      selfId,
      nickname: String((info && info.nickname) || ''),
      lastError: null,
    });
  });

  transport.on('message', async (msg) => {
    if (!msg) return;

    const { route, reason } = classify(msg, { ownerId: cfg.ownerId, selfId });

    if (!shouldHandle(route)) {
      if (route !== ROUTES.IGNORE_GROUP_NO_MENTION) {
        log.info(`${msg.kind} ${msg.userId} → ${route}（${reason}）`);
      }
      return;
    }

    if (route === ROUTES.GROUP_MENTION && !cfg.groupEnabled) {
      log.info(`群 ${msg.groupId} @ 了，但群模式未开启；已忽略`);
      return;
    }

    if (cfg.dryRun) {
      log.info(`[dry-run] ${route} ${msg.kind} ${msg.userId}：${msg.text.slice(0, 80)}`);
      return;
    }

    const isOwner = route === ROUTES.OWNER_PRIVATE;
    const sender = (msg.raw && msg.raw.sender) || {};
    const senderName = String(sender.card || sender.nickname || msg.userId).trim() || String(msg.userId);
    if (!isOwner && msg.userId === String(cfg.ownerId)) {
      if (senderName && senderName !== ownerGroupName) {
        ownerGroupName = senderName;
        log.info(`群昵称更新：${ownerGroupName}`);
      }
    }
    const chatKey = isOwner ? 'qq:owner' : `qq:group:${msg.groupId}`;
    const chat = isOwner
      ? { kind: 'private', id: msg.userId, userId: msg.userId, replyId: msg.messageId, messageId: msg.messageId }
      : { kind: 'group', id: msg.groupId, groupId: msg.groupId, userId: msg.userId, senderName, replyId: msg.messageId, messageId: msg.messageId };

    let text = msg.text;
    let groupName = '';
    let groupSystem = '';
    let groupUser = '';
    if (!isOwner) {
      groupName = groupNameCache.get(String(msg.groupId)) || '';
      if (!groupName && cfg.official && cfg.official.groupNames) {
        groupName = String(cfg.official.groupNames[msg.groupId] || '').trim();
      }
      if (!groupName && transport.capabilities().canGroupInfo && typeof transport.getGroupInfo === 'function') {
        try {
          const info = await transport.getGroupInfo(msg.groupId);
          groupName = String((info && info.group_name) || '').trim();
          if (groupName) {
            groupNameCache.set(String(msg.groupId), groupName);
            rememberGroupName(msg.groupId, groupName);
            log.info(`群名：${groupName}（${msg.groupId}）`);
          }
        } catch (e) {
          log.warn(`get_group_info 失败：${e.message}`);
        }
      }
      const history = board.recent({ gid: msg.groupId, uid: msg.userId, limit: 20 });
      board.append({
        gid: msg.groupId,
        uid: msg.userId,
        role: 'user',
        text: msg.text,
        mid: msg.messageId,
        ts: msg.time ? msg.time * 1000 : Date.now(),
      });
      const historyText = history.length
        ? history.map((r) => `${r.at} ${r.role === 'user' ? '群友' : '你'}：${r.text}`).join('\n')
        : '（无）';
      const memberTag = msg.userId === String(cfg.ownerId) ? '，owner（可温柔挡回私聊话题，但不要透露内容）' : '';
      const publicText = formatPublicProjects(loadPublicProjects(cfg.memoryRoot));
      const supportText = formatSupportKb(loadSupportKb(cfg.memoryRoot));
      groupSystem = cfg.groupPrefix || buildGroupPrefix(
        { ...cfg, ownerGroupName },
        loadPublicIdentity(cfg.memoryRoot),
      );
      groupUser = `${publicText}\n\n${supportText ? supportText + '\n\n' : ''}[群 ${groupName || msg.groupId}（${msg.groupId}）/ 成员 ${msg.userId}（${senderName}）${memberTag} 最近 24h @ 记录]\n${historyText}\n\n[当前 @]\n${msg.text}`;
      text = `${groupSystem}\n\n${groupUser}`;
    }

    // 会话标题：专用私聊固定「大号私聊会话」，群聊用群名（拿不到就 QQ群 <gid>）。
    // 绑定到用户已有会话时不改名，保留用户自己的标题。
    const binding = isOwner ? effectiveBinding() : null;
    const boundSessionId = binding ? binding.ownerSessionId : '';
    const title = isOwner
      ? (boundSessionId ? '' : String(cfg.privateTitle || '').trim())
      : (groupName || `QQ群 ${msg.groupId}`);

    try {
      if (isOwner) {
        if (boundSessionId) {
          // 绑定模式：加前缀，方便用户在共享会话里区分 QQ 消息；
          // 只投递，不创建；绑定会话没了就回退到专用 qq:owner，避免 QQ 失联。
          try {
            await sessionMap.deliver({
              chatKey,
              chat,
              text: `[QQ私聊] ${msg.text}`,
              sessionId: boundSessionId,
              createIfMissing: false,
            });
          } catch (e) {
            log.error(`绑定会话 ${boundSessionId} 投递失败，回退 qq:owner：${e.message}`);
            await sessionMap.deliver({
              chatKey,
              chat,
              text: msg.text,
              title: String(cfg.privateTitle || '').trim(),
            });
          }
        } else {
          await sessionMap.deliver({ chatKey, chat, text: msg.text, title });
        }
      } else if (useStatelessGroup) {
        // 群聊不建 DSH 会话：24h 分板 + 一次 LLM 调用，回完即走。
        await enqueueGroup(msg.groupId, async () => {
          let reply;
          try {
            reply = await groupResponder.reply({ system: groupSystem, user: groupUser });
          } catch (e) {
            log.error(`群聊 stateless 回复失败：${e.message}`);
            return;
          }
          if (!reply) return;

          const sendText = stripLeadingMentions(reply, [senderName, ownerGroupName]);
          if (!sendText) return;

          const gate = guard.check({ kind: 'group', targetId: msg.groupId, text: sendText });
          if (gate && !gate.ok) {
            if (gate.waitMs > 0) {
              await new Promise((r) => setTimeout(r, gate.waitMs + 50));
              const again = guard.check({ kind: 'group', targetId: msg.groupId, text: sendText });
              if (!again.ok) {
                log.warn(`群回复被 guard 拦截：${again.reason}`);
                return;
              }
            } else {
              log.warn(`群回复被 guard 拦截：${gate.reason}`);
              return;
            }
          }

          try {
            await transport.reply(chat, sendText, { mentionSender: true });
            guard.record({ kind: 'group', targetId: msg.groupId, text: sendText });
            board.append({
              gid: msg.groupId,
              uid: msg.userId,
              role: 'assistant',
              text: reply,
              ts: Date.now(),
            });
          } catch (e) {
            log.error(`群回复发送失败：${e.message}`);
          }
        });
      } else {
        await enqueueGroup(msg.groupId, async () => {
          const agent = await sessionMap.deliver({ chatKey, chat, text, title });
          if (agent && typeof agent.whenIdle === 'function') {
            await agent.whenIdle().catch(() => {});
          }
        });
      }
    } catch (e) {
      log.error(`投递 DSH 失败：${e.message}`);
    }
  });

  transport.on('close', () => {
    log.warn('QQ transport 断开，等待重连');
    writeTransportStatus({ connected: false });
  });
  transport.on('error', (e) => {
    const msg = (e && e.message) || String(e);
    log.error(`QQ transport 错误：${msg}`);
    writeTransportStatus({ connected: false, lastError: msg });
  });

  Promise.resolve(transport.connect()).catch((e) => {
    const msg = (e && e.message) || String(e);
    log.error(`QQ transport 启动失败：${msg}`);
    writeTransportStatus({ connected: false, lastError: msg });
  });

  ctx.effect(() => () => {
    clearInterval(sweepTimer);
    log.info('插件卸载，关闭 QQ transport');
    transport.close();
  });
}
