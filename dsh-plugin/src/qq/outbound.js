/**
 * QQ 桥的出站：监听 DSH session 的 assistant 文本，攒一轮，发回 QQ
 *
 * 只处理 qq: 前缀的会话；其他会话（Web UI、记忆提炼等）一律不碰。
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

export class QQOutbound {
  constructor({ ctx, sessionMap, send, logger, guard }) {
    this.ctx = ctx;
    this.sessionMap = sessionMap;
    this.send = send;
    this.log = logger || console;
    this.guard = guard || null;
    this.buffers = new Map(); // sessionId -> string[]
  }

  install() {
    this.ctx.on('session/event', (session, event) => this.onEvent(session, event));
  }

  onEvent(session, event) {
    const sessionId = String(session?.id || '');
    if (!sessionId.startsWith('qq:')) return;

    const data = event?.data || {};
    if (event?.type === 'assistant/message') {
      const text = blocksToText(data.message?.content || data.content);
      if (!text) return;
      const parts = this.buffers.get(sessionId) || [];
      parts.push(text);
      this.buffers.set(sessionId, parts);
      return;
    }

    if (event?.type === 'turn/end') {
      this.flush(sessionId);
    }
  }

  async flush(sessionId) {
    const parts = this.buffers.get(sessionId);
    if (!parts || !parts.length) return;
    this.buffers.delete(sessionId);

    const text = parts.join('\n\n').trim();
    if (!text) return;

    const chat = this.sessionMap.chatForSession(sessionId);
    if (!chat) {
      this.log.warn?.(`[qq] 找不到 ${sessionId} 对应的聊天，丢弃回复`);
      return;
    }

    const targetId = chat.kind === 'private' ? chat.userId : chat.groupId;
    const gate = this.guard?.check({ kind: chat.kind, targetId, text });
    if (gate && !gate.ok) {
      this.log.warn?.(`[qq] 出站拦截：${gate.reason}`);
      if (gate.waitMs > 0) {
        this.buffers.set(sessionId, [text]);
        setTimeout(() => this.flush(sessionId), gate.waitMs + 50);
      }
      return;
    }

    try {
      await this.send(chat, text);
      this.guard?.record({ kind: chat.kind, targetId, text });
    } catch (e) {
      this.log.error?.(`[qq] 发送失败：${e.message}`);
    }
  }
}

export { blocksToText };
