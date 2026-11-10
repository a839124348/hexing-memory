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
  deliver({ chatKey, chat, text, title, sessionId, createIfMissing = true }) {
    const run = () => this._deliver(chatKey, chat, text, title, sessionId, createIfMissing);
    const prev = this.inflight.get(chatKey) || Promise.resolve();
    const cur = prev.then(run, run);
    this.inflight.set(chatKey, cur);
    return cur.finally(() => {
      if (this.inflight.get(chatKey) === cur) this.inflight.delete(chatKey);
    });
  }

  async _deliver(chatKey, chat, text, title, boundSessionId, createIfMissing = true) {
    let entry = this.entries.get(chatKey);
    const sessionId = boundSessionId || this.makeSessionId(chatKey);
    let agent = (entry && entry.sessionId === sessionId ? entry.agent : null)
      || this.ctx.agents.get?.(sessionId);

    if (!agent) {
      const preset = chat.kind === 'group' ? this.cfg.groupPreset : this.cfg.agentPreset;
      const agentOptions = this.cfg.provider && this.cfg.model
        ? { provider: this.cfg.provider, model: this.cfg.model }
        : undefined;

      // 绑定的是用户已有会话：恢复时沿用它自己的 preset / 模型，
      // 不能把 QQ 桥的 standard 配置盖到主会话上。
      let resumePreset = preset;
      let resumeOptions = agentOptions;
      if (boundSessionId) {
        resumeOptions = undefined;
        try {
          const persistence = typeof this.ctx.get === 'function' ? this.ctx.get('sessionPersistence') : null;
          const snap = await persistence?.stat?.(sessionId);
          const storedPreset = String(snap?.header?.agentPreset || '').trim();
          if (storedPreset) resumePreset = storedPreset;
        } catch (e) {
          this.log.warn?.(`[qq] 读取绑定会话头失败：${e.message}`);
        }
      }

      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeOptions ? { agentOptions: resumeOptions } : {}),
          setup: async (agentCtx) => {
            await this.ctx.agentPresets.mount(agentCtx, resumePreset);
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
        } else if (!createIfMissing) {
          // 绑定的是用户已有会话：不能在这里新建一个空会话冒充。
          throw new Error(`绑定会话 ${sessionId} 不存在或无法恢复：${e.message}`);
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
    }

    // 关键：不管 agent 是 create、resume 还是 ctx.agents.get 复用的，
    // 都必须把 chatKey → chat 写回 entries；否则 outbound 找不到聊天，
    // 私聊回复会被静默丢弃（2026-11-11 实测）。
    entry = { sessionId, chat, agent, title: entry?.title };
    this.entries.set(chatKey, entry);

    if (title && entry.title !== title) {
      const svc = (typeof this.ctx.get === 'function' ? this.ctx.get('sessionTitle') : null) || this.ctx.sessionTitle;
      if (svc && typeof svc.rename === 'function') {
        try {
          // rename 要求传入 session store 里的同一个对象；用 id 取一次，避免
          // agent.session 是包装对象时被 "not live in this store" 拒绝。
          const target = this.ctx.sessions?.get?.(agent.session?.id) || agent.session;
          svc.rename(target, title);
          entry.title = title;
          this.log.info?.(`[qq] 会话标题：${title}`);
        } catch (e) {
          this.log.warn?.(`[qq] 会话标题失败：${e.message}`);
        }
      } else {
        entry.title = title;
      }
    }

    if (!boundSessionId && this.cfg.provider && this.cfg.model && agent.model && typeof agent.model.select === 'function') {
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
