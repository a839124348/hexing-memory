/**
 * hexing-qq —— 把 OneBot 11 的 QQ 消息接进 DSH 的 agent
 *
 * 这是插件壳，不做记忆、不做模型：
 *   OneBot 事件 → normalize → router → QQSessionMap → agent.followup
 *   DSH session 的 assistant 文本 → QQOutbound → OneBot 发送
 *
 * 群模式默认关闭；打开前要先让记忆插件跳过 qq:group: 会话的自动记录/常识层注入。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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

export const name = 'hexing-qq';
export const inject = ['agents', 'agentPresets', 'workspaceRegistry', 'sessions', 'timer'];

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
  dryRun: true,
  groupPrefix: '你是群聊公开模式：只回答当前这条 @，不要提及私聊记忆、用户身份、关系或未公开项目；不要编造历史。',
  guard: { enabled: true, groupMinMs: 10000, privateMinMs: 0, dedupeMs: 3000, quietHours: [] },
};

function defaultQQRoot() {
  const base = process.env.MEMORY_ROOT
    || path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'dsh-memory');
  return path.join(base, 'qq');
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

  const client = new OneBotClient({
    url: cfg.onebot.url,
    token: cfg.onebot.token,
    logger: log,
  });

  let selfId = '';
  const board = new GroupBoard({ root: cfg.qqRoot });
  const guard = new SendGuard(cfg.guard);

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
      const message = [{ type: 'text', data: { text } }];
      if (chat.kind === 'private') {
        await client.sendPrivate(chat.userId, message);
      } else {
        await client.sendGroup(chat.groupId, message);
        board.append({
          gid: chat.groupId,
          uid: chat.userId,
          role: 'assistant',
          text,
          ts: Date.now(),
        });
      }
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
    'memory_onboarding',
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
    const chatKey = isOwner ? 'qq:owner' : `qq:group:${msg.groupId}:${msg.userId}`;
    const chat = isOwner
      ? { kind: 'private', id: msg.userId, userId: msg.userId }
      : { kind: 'group', id: msg.groupId, groupId: msg.groupId, userId: msg.userId };

    let text = msg.text;
    if (!isOwner) {
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
      text = `${cfg.groupPrefix}\n\n[群 ${msg.groupId} / 成员 ${msg.userId} 最近 24h @ 记录]\n${historyText}\n\n[当前 @]\n${msg.text}`;
    }

    try {
      await sessionMap.deliver({ chatKey, chat, text });
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
