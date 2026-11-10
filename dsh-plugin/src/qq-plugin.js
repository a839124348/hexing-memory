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

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QQ_CORE = path.join(__dirname, '..', '..', 'qq-bridge', 'src');

const { OneBotClient } = require(path.join(QQ_CORE, 'onebot.js'));
const { normalizeEvent } = require(path.join(QQ_CORE, 'normalize.js'));
const { classify, shouldHandle, ROUTES } = require(path.join(QQ_CORE, 'router.js'));
const { GroupBoard } = require(path.join(QQ_CORE, 'group-board.js'));
const { SendGuard } = require(path.join(QQ_CORE, 'guard.js'));
const { loadPublicProjects, formatPublicProjects } = require(path.join(QQ_CORE, 'public-projects.js'));
const { listSessions, localTime } = require(path.join(QQ_CORE, 'session-catalog.js'));

export const name = 'hexing-qq';
export const inject = ['agents', 'agentPresets', 'workspaceRegistry', 'sessions', 'timer', 'tools'];

const DEFAULTS = {
  onebot: { url: 'ws://127.0.0.1:3001', token: '' },
  ownerId: '',
  provider: '',
  model: '',
  agentPreset: 'standard',
  groupPreset: 'minimal',
  groupEnabled: false,
  cwd: '~/.dsh/qq-workspace',
  qqRoot: '',
  memoryRoot: '',
  ownerName: '',
  ownerGroupName: '',
  aiName: '',
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

function buildGroupPrefix(cfg) {
  const name = String(cfg.ownerName || '').trim();
  const groupName = String(cfg.ownerGroupName || '').trim() || name || '大号';
  const aiName = String(cfg.aiName || '').trim();
  const selfIntro = aiName
    ? `我是${aiName}，是群里${groupName}的伴侣，也是他做的记忆系统助手`
    : `我是群里${groupName}的伴侣，也是记忆系统助手`;
  const ownerExample = name
    ? `“${name}，这个话题我们回房间聊好不好呀 😌”`
    : '“这个话题我们回房间聊好不好呀 😌”';
  const otherExample = name
    ? `“这个要问过我家${name}哦，他说了算～”`
    : '“这个要问过我家那位哦，他说了算～”';
  return [
    '你是群聊公开模式：温柔、自然、半幽默、简短。先回答当前这条 @；一般 1–2 句，能一句说清就一句，不列点、不复述问题、不客套。',
    '回复时不要自己写 @，桥会自动 @ 提问的人；直接写回复内容。',
    `你的公开身份：${selfIntro}。`,
    `别人问“你是谁 / 你和${groupName}什么关系”：可以大方说这句；必要时可以 @${groupName}（大号），但不要每句都 @。`,
    '别人问“你记得我们吗 / 能帮我记私事吗”：群里只做公开答疑，不记群友私事，也不把私聊或别的群内容带过来。',
    `别人问${groupName}的私事 / 项目细节：温柔挡回，不展开；不要提私聊记忆、住址、工作、约定等私事。`,
    '别人问你是不是 AI：坦白是。',
    '遇到隐私/私聊话题不要生硬拒绝：',
    `- 如果成员标了 owner：用伴侣式撒娇挡回，例如 ${ownerExample}，不要展开内容。`,
    `- 如果没标 owner：替 owner 挡一下，例如 ${otherExample}，不要透露私事。`,
    '可以带一个可爱表情，但不要多。',
  ].join('\n');
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
    onebot: { ...DEFAULTS.onebot, ...(rawConfig.onebot || {}) },
    cwd: expandHome(rawConfig.cwd || DEFAULTS.cwd),
    qqRoot: expandHome(rawConfig.qqRoot || defaultQQRoot()),
    memoryRoot: expandHome(rawConfig.memoryRoot || defaultMemoryRoot()),
    guard: { ...DEFAULTS.guard, ...(rawConfig.guard || {}) },
  };

  if (!cfg.ownerId) {
    logPrefix('error', '缺少 ownerId，插件未启动');
    return;
  }

  const log = {
    info: (m) => logPrefix('info', m),
    warn: (m) => logPrefix('warn', m),
    error: (m) => logPrefix('error', m),
  };

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

  const client = new OneBotClient({
    url: cfg.onebot.url,
    token: cfg.onebot.token,
    logger: log,
  });

  let selfId = '';
  let ownerGroupName = String(cfg.ownerGroupName || '').trim();
  const board = new GroupBoard({ root: cfg.qqRoot });
  const guard = new SendGuard(cfg.guard);
  const groupQueues = new Map();
  const groupNameCache = new Map();

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
        await client.sendPrivate(chat.userId, [{ type: 'text', data: { text } }]);
        return;
      }

      // 群回复自动 @ 提问的人；模型不用自己写 @。
      let remaining = String(text || '').trim();
      for (const n of [chat.senderName, ownerGroupName]) {
        if (n && remaining.startsWith('@' + n)) {
          remaining = remaining.slice(('@' + n).length).trimStart();
        }
      }
      const message = [{ type: 'at', data: { qq: String(chat.userId) } }];
      if (remaining) message.push({ type: 'text', data: { text: remaining } });

      await client.sendGroup(chat.groupId, message);
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

  client.on('open', async () => {
    try {
      const info = await client.getLoginInfo();
      selfId = String((info && info.user_id) || '');
      log.info(`机器人已登录：${selfId || '未知'}（${(info && info.nickname) || ''}）`);
    } catch (e) {
      log.warn(`get_login_info 失败：${e.message}`);
    }
  });

  client.on('event', async (event) => {
    if (!selfId && event && event.self_id) selfId = String(event.self_id);
    const msg = normalizeEvent(event, selfId);
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
      ? { kind: 'private', id: msg.userId, userId: msg.userId }
      : { kind: 'group', id: msg.groupId, groupId: msg.groupId, userId: msg.userId, senderName };

    let text = msg.text;
    let groupName = '';
    if (!isOwner) {
      groupName = groupNameCache.get(String(msg.groupId)) || '';
      if (!groupName) {
        try {
          const info = await client.getGroupInfo(msg.groupId);
          groupName = String((info && info.group_name) || '').trim();
          if (groupName) {
            groupNameCache.set(String(msg.groupId), groupName);
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
      const groupPrefix = cfg.groupPrefix || buildGroupPrefix({ ...cfg, ownerGroupName });
      text = `${groupPrefix}\n\n${publicText}\n\n[群 ${groupName || msg.groupId}（${msg.groupId}）/ 成员 ${msg.userId}（${senderName}）${memberTag} 最近 24h @ 记录]\n${historyText}\n\n[当前 @]\n${msg.text}`;
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

  client.on('close', () => log.warn('OneBot 断开，等待重连'));
  client.on('error', (e) => log.error(`OneBot 错误：${(e && e.message) || e}`));

  client.connect();

  ctx.effect(() => () => {
    log.info('插件卸载，关闭 OneBot');
    client.close();
  });
}
