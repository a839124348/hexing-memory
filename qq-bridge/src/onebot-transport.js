/**
 * onebot-transport.js — 现有 OneBot 11 客户端的 transport 包装
 *
 * 只做三件事：
 * - 连/断 OneBot WS
 * - 把 OneBot 事件 normalize 成桥内部消息
 * - 把 reply(target, text) 还原成 OneBot 的 at/reply 段
 *
 * 不碰 router、不碰会话、不碰记忆。
 */

const { QQTransport } = require('./transport');
const { OneBotClient } = require('./onebot');
const { normalizeEvent } = require('./normalize');

class OneBotTransport extends QQTransport {
  constructor({ url, token, logger, clientFactory, normalize } = {}) {
    super({ logger });
    this.url = url || 'ws://127.0.0.1:3001';
    this.token = token || '';
    this.selfId = '';
    this.client = null;
    this.clientFactory = clientFactory || ((opts) => new OneBotClient(opts));
    this.normalize = normalize || normalizeEvent;
  }

  capabilities() {
    return {
      // 基座可能看得到全群，但桥的 router 只处理 @；这里如实标 mention-only。
      groupScope: 'mention-only',
      canProactive: true,
      canHistory: true,
      canGroupInfo: true,
      canLoginInfo: true,
      maxReplyLength: 0,
      replyMode: 'onebot-segments',
    };
  }

  async connect() {
    if (this.client) return;
    const client = this.clientFactory({ url: this.url, token: this.token, logger: this.log });
    this.client = client;

    client.on('open', async () => {
      let info = null;
      try {
        info = typeof client.getLoginInfo === 'function' ? await client.getLoginInfo() : null;
      } catch (e) {
        this.log.warn?.(`[onebot] get_login_info 失败：${e.message}`);
      }
      this.selfId = String((info && info.user_id) || this.selfId || '');
      this.emit('ready', {
        selfId: this.selfId,
        nickname: String((info && info.nickname) || ''),
      });
    });

    client.on('event', (event) => {
      // 有些基座首帧没有 open 信息，事件里带 self_id；保持和旧逻辑一致。
      if (!this.selfId && event && event.self_id) this.selfId = String(event.self_id);
      const msg = this.normalize(event, this.selfId);
      if (msg) this.emit('message', msg);
    });

    client.on('close', (ev) => this.emit('close', ev));
    client.on('error', (e) => this.emit('error', e));

    try {
      client.connect();
    } catch (e) {
      this.emit('error', e);
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    try { client?.close?.(); } catch (e) { /* ignore */ }
  }

  async getLoginInfo() {
    if (!this.client || typeof this.client.getLoginInfo !== 'function') return null;
    return this.client.getLoginInfo();
  }

  async getGroupInfo(groupId) {
    if (!this.client || typeof this.client.getGroupInfo !== 'function') return null;
    return this.client.getGroupInfo(groupId);
  }

  async reply(chat, text, opts = {}) {
    if (!this.client) throw new Error('OneBot 未连接');
    const body = String(text || '').trim();

    if (chat.kind === 'private') {
      return this.client.sendPrivate(chat.userId, [{ type: 'text', data: { text: body } }]);
    }

    const message = [];
    if (opts.mentionSender && chat.userId) {
      message.push({ type: 'at', data: { qq: String(chat.userId) } });
    }
    if (body) message.push({ type: 'text', data: { text: body } });
    return this.client.sendGroup(chat.groupId, message);
  }
}

module.exports = { OneBotTransport };
