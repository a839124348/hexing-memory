/**
 * transport.js — QQ 传输层接口
 *
 * OneBot 和 QQ 官方机器人是同一层的两个实现，二选一：
 *   createTransport(cfg) → OneBotTransport | OfficialTransport
 *
 * 核心（router / group-board / session-map / outbound）只认归一化消息，
 * 不认底层是 OneBot WS、官方 WebSocket 还是 Webhook。
 */

class QQTransport {
  constructor({ logger } = {}) {
    this.log = logger || console;
    this.handlers = new Map();
  }

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event, payload) {
    const list = this.handlers.get(event);
    if (!list || !list.length) return;
    for (const handler of [...list]) {
      try {
        const ret = handler(payload);
        if (ret && typeof ret.catch === 'function') {
          ret.catch((e) => this.log.error?.(`[transport] ${event} 处理失败：${(e && e.message) || e}`));
        }
      } catch (e) {
        this.log.error?.(`[transport] ${event} 处理失败：${(e && e.message) || e}`);
      }
    }
  }

  capabilities() {
    return {
      groupScope: 'full',
      canProactive: true,
      canHistory: true,
      canGroupInfo: true,
      canLoginInfo: true,
      maxReplyLength: 0,
      replyMode: 'onebot-segments',
    };
  }

  async connect() {}
  async close() {}
  async reply() {
    throw new Error('QQTransport.reply 未实现');
  }
}

function createTransport(cfg = {}, logger) {
  const name = String(cfg.transport || 'onebot').toLowerCase();
  if (name === 'onebot') {
    const { OneBotTransport } = require('./onebot-transport');
    return new OneBotTransport({
      ...(cfg.onebot || {}),
      ownerId: cfg.ownerId,
      logger,
    });
  }
  if (name === 'official') {
    const { OfficialTransport } = require('./official-transport');
    const official = cfg.official || {};
    if (!official.appId || !official.clientSecret) {
      throw new Error('官方 transport 需要 official.appId / official.clientSecret');
    }
    return new OfficialTransport({
      ...official,
      ownerId: cfg.ownerOpenId || cfg.ownerId,
      logger,
    });
  }
  throw new Error(`未知 transport：${name}（只支持 onebot / official）`);
}

module.exports = { QQTransport, createTransport };
