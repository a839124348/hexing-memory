/**
 * QQ 桥的会话映射：一个聊天对象 ↔ 一个 DSH session
 *
 * 这里不碰 QQ 协议，也不碰记忆；只负责：
 * - 给 owner 私聊 / 群 @ 分配稳定的 sessionId
 * - 第一次 create，之后 resume
 * - 把消息用 agent.followup 投进去
 *
 * DSH API 通过构造函数注入，方便单测；不在本文件直接 import DSH。
 */

import fs from 'node:fs';
import path from 'node:path';

function safeSegment(key) {
  return String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class QQSessionMap {
  constructor({ ctx, config, logger, makeSessionId, makeUserMessage, pluginName = 'hexing-qq' }) {
    this.ctx = ctx;
    this.cfg = config;
    this.log = logger || console;
    this.makeSessionId = makeSessionId;
    this.makeUserMessage = makeUserMessage;
    this.pluginName = pluginName;
    this.entries = new Map(); // chatKey -> { sessionId, chat, agent }
    this.inflight = new Map(); // chatKey -> Promise
  }

  chatForSession(sessionId) {
    for (const e of this.entries.values()) {
      if (e.sessionId === sessionId) return e.chat;
    }
    return null;
  }

  /** 同一 chatKey 串行，避免 create/resume 并发 */
  deliver({ chatKey, chat, text }) {
    const run = () => this._deliver(chatKey, chat, text);
    const prev = this.inflight.get(chatKey) || Promise.resolve();
    const cur = prev.then(run, run);
    this.inflight.set(chatKey, cur);
    return cur.finally(() => {
      if (this.inflight.get(chatKey) === cur) this.inflight.delete(chatKey);
    });
  }

  async _deliver(chatKey, chat, text) {
    let entry = this.entries.get(chatKey);
    const sessionId = this.makeSessionId(chatKey);
    let agent = entry?.agent || this.ctx.agents.get?.(sessionId);

    if (!agent) {
      const preset = chat.kind === 'group' ? this.cfg.groupPreset : this.cfg.agentPreset;
      const agentOptions = this.cfg.provider && this.cfg.model
        ? { provider: this.cfg.provider, model: this.cfg.model }
        : undefined;

      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          setup: async (agentCtx) => {
            await this.ctx.agentPresets.mount(agentCtx, preset);
          },
        });
        agent = handle.agent;
        this.log.info?.(`[qq] 恢复会话 ${chatKey}`);
      } catch (e) {
        // 可能是首次没有历史，也可能是会话已经被 UI/另一个入口激活；
        // 先看有没有 live agent，再决定 create。
        const live = this.ctx.agents.get?.(sessionId);
        if (live) {
          agent = live;
          this.log.info?.(`[qq] 复用已激活会话 ${chatKey}（resume: ${e.message}）`);
        } else {
          const cwd = path.join(this.cfg.cwd, safeSegment(chatKey));
          fs.mkdirSync(cwd, { recursive: true });
          await this.ctx.workspaceRegistry.create(cwd, `QQ ${chat.kind} ${chat.id}`);
          try {
            const handle = await this.ctx.agents.create({
              sessionId,
              meta: { cwd, agentPreset: preset },
              ...(agentOptions ? { agentOptions } : {}),
              setup: async (agentCtx) => {
                await this.ctx.agentPresets.mount(agentCtx, preset);
              },
            });
            agent = handle.agent;
            this.log.info?.(`[qq] 新建会话 ${chatKey}`);
          } catch (e2) {
            const live2 = this.ctx.agents.get?.(sessionId);
            if (!live2) throw e2;
            agent = live2;
            this.log.info?.(`[qq] 复用已存在会话 ${chatKey}（create: ${e2.message}）`);
          }
        }
      }

      entry = { sessionId, chat, agent };
      this.entries.set(chatKey, entry);
    }

    if (this.cfg.provider && this.cfg.model && agent.model && typeof agent.model.select === 'function') {
      try {
        agent.model.select({ provider: this.cfg.provider, model: this.cfg.model });
      } catch (e) {
        this.log.warn?.(`[qq] 设置模型失败：${e.message}`);
      }
    }

    const message = this.makeUserMessage({
      content: [{ type: 'text', text }],
      // DSH session format v4 拒绝旧的 kind:'plugin' 包装；这里用插件自己的
      // producer kind，既满足 v4，也让记忆插件能按来源识别这条消息。
      source: { kind: this.pluginName },
    });
    this.log.info?.(`[qq] followup ${chatKey}（session=${agent.session?.id || '?'}）：${String(text).slice(0, 60)}`);
    try {
      agent.followup(message);
      this.log.info?.(`[qq] agent 状态：${agent.status || '?'}`);
      if (typeof agent.whenIdle === 'function') {
        agent.whenIdle()
          .then(() => this.log.info?.(`[qq] agent idle：${chatKey}（status=${agent.status || '?'}）`))
          .catch((e) => {
            this.log.error?.(`[qq] agent 运行失败：${e && e.message ? e.message : e}`);
          });
      }
    } catch (e) {
      this.log.error?.(`[qq] followup 失败：${e.message}`);
      throw e;
    }
    return agent;
  }
}

export { safeSegment };
