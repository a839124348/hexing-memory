/**
 * QQ 桥的出站：监听 DSH session 的 assistant 文本，攒一轮，发回 QQ
 *
 * 只处理 sessionMap 里有聊天映射的会话；其他会话（Web UI、记忆提炼等）一律不碰。
 * 绑定主会话时，同一个会话里既有 UI 轮次也有 QQ 轮次：
 * 只有“这一轮的用户消息 source.kind === 'hexing-qq'”才把助手回复发回 QQ，
 * UI 触发的轮次绝不外发。
 *
 * 出站闸门拦截“限流”时不丢消息：进每个会话的待发队列，等窗口过了按顺序发。
 */

function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks.trim();
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

const QQ_SOURCE = 'hexing-qq';

export class QQOutbound {
  constructor({ ctx, sessionMap, send, logger, guard }) {
    this.ctx = ctx;
    this.sessionMap = sessionMap;
    this.send = send;
    this.log = logger || console;
    this.guard = guard || null;
    this.buffers = new Map(); // sessionId -> 当前轮 assistant 文本
    this.turns = new Map(); // sessionId -> { turn, fromQQ }
    this.pending = new Map(); // sessionId -> 等待限流的文本队列
    this.timers = new Map(); // sessionId -> 延迟 drain 定时器
    this.draining = new Set(); // sessionId -> 正在 drain
  }

  install() {
    this.ctx.on('session/event', (session, event) => this.onEvent(session, event));
  }

  onEvent(session, event) {
    const sessionId = String(session?.id || '');
    const chat = this._chatOf(sessionId);
    if (!chat) return;

    const data = event?.data || {};

    if (event?.type === 'turn/start') {
      // 新一轮开始：清掉上一轮残留，默认“不是 QQ 触发”。
      this.buffers.delete(sessionId);
      this.turns.set(sessionId, { turn: data.turn, fromQQ: false });
      return;
    }

    if (event?.type === 'user/message') {
      if (data.source && data.source.kind === QQ_SOURCE) {
        const state = this.turns.get(sessionId) || { turn: undefined, fromQQ: false };
        state.fromQQ = true;
        this.turns.set(sessionId, state);
      }
      return;
    }

    if (event?.type === 'assistant/message') {
      const text = blocksToText(data.message?.content || data.content);
      if (!text) return;
      this.log.info?.(`[qq] outbound assistant ${sessionId} len=${text.length}`);
      const parts = this.buffers.get(sessionId) || [];
      parts.push(text);
      this.buffers.set(sessionId, parts);
      return;
    }

    if (event?.type === 'turn/end') {
      const state = this.turns.get(sessionId);
      this.turns.delete(sessionId);
      if (!state || !state.fromQQ) {
        // UI 触发的轮次：只丢缓冲，不发 QQ。
        if (this.buffers.has(sessionId)) {
          this.buffers.delete(sessionId);
          this.log.info?.(`[qq] 跳过非 QQ 轮次 ${sessionId}（turn=${state?.turn ?? data.turn ?? '?'}）`);
        }
        return;
      }
      this.flush(sessionId).catch((e) => this.log.error?.(`[qq] 出站失败：${e.message}`));
    }
  }

  _chatOf(sessionId) {
    return this.sessionMap.chatForSession(sessionId);
  }

  _targetOf(chat) {
    return chat.kind === 'private' ? chat.userId : chat.groupId;
  }

  _scheduleDrain(sessionId, waitMs) {
    if (this.timers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.timers.delete(sessionId);
      this.drain(sessionId).catch((e) => this.log.error?.(`[qq] 队列发送失败：${e.message}`));
    }, Math.max(50, waitMs + 50));
    t.unref?.();
    this.timers.set(sessionId, t);
  }

  async flush(sessionId) {
    const parts = this.buffers.get(sessionId);
    if (!parts || !parts.length) return;
    this.buffers.delete(sessionId);

    const text = parts.join('\n\n').trim();
    if (!text) return;
    this.log.info?.(`[qq] outbound flush ${sessionId} len=${text.length}`);

    const chat = this._chatOf(sessionId);
    if (!chat) {
      this.log.warn?.(`[qq] 找不到 ${sessionId} 对应的聊天，丢弃回复`);
      return;
    }
    this.log.info?.(`[qq] outbound chat ${chat.kind} ${chat.userId || chat.groupId}`);

    const targetId = this._targetOf(chat);
    const gate = this.guard?.check({ kind: chat.kind, targetId, text });
    if (gate && !gate.ok) {
      if (gate.waitMs > 0) {
        const q = this.pending.get(sessionId) || [];
        q.push(text);
        this.pending.set(sessionId, q);
        this.log.info?.(`[qq] 出站排队：${gate.reason}；队列 ${q.length} 条`);
        this._scheduleDrain(sessionId, gate.waitMs);
      } else {
        this.log.warn?.(`[qq] 出站拦截：${gate.reason}`);
      }
      return;
    }

    try {
      await this._sendOne(sessionId, chat, text);
    } catch (e) {
      return;
    }
    await this.drain(sessionId).catch((e) => this.log.error?.(`[qq] 队列发送失败：${e.message}`));
  }

  async drain(sessionId) {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      const q = this.pending.get(sessionId);
      if (!q || !q.length) return;
      const chat = this._chatOf(sessionId);
      if (!chat) {
        this.pending.delete(sessionId);
        return;
      }
      const targetId = this._targetOf(chat);

      while (q.length) {
        const text = q[0];
        const gate = this.guard?.check({ kind: chat.kind, targetId, text });
        if (gate && !gate.ok) {
          if (gate.waitMs > 0) {
            this._scheduleDrain(sessionId, gate.waitMs);
            break;
          }
          q.shift();
          this.log.warn?.(`[qq] 队列丢弃：${gate.reason}`);
          continue;
        }
        q.shift();
        await this._sendOne(sessionId, chat, text);
      }
      if (!q.length) this.pending.delete(sessionId);
    } finally {
      this.draining.delete(sessionId);
    }
  }

  async _sendOne(sessionId, chat, text) {
    const targetId = this._targetOf(chat);
    try {
      this.log.info?.(`[qq] outbound send ${chat.kind} ${targetId} len=${text.length}`);
      await this.send(chat, text);
      this.guard?.record({ kind: chat.kind, targetId, text });
    } catch (e) {
      this.log.error?.(`[qq] 发送失败：${e.message}`);
      throw e;
    }
  }
}

export { blocksToText };
