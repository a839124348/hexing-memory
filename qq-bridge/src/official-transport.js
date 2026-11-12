/**
 * official-transport.js — QQ 官方机器人 transport
 *
 * 只做官方 API v2 的最小闭环：
 * - AppID/AppSecret → access_token（自动刷新）
 * - WebSocket gateway：HELLO → IDENTIFY → READY / 心跳
 * - GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE → 归一化消息
 * - 被动回复：msg_id + msg_seq + <@openid>
 *
 * 不接全量群消息、不做主动消息、不拉历史。
 */

const { QQTransport } = require('./transport');

const API_BASE = 'https://api.sgroup.qq.com';
const SANDBOX_BASE = 'https://sandbox.api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const WS_URL = 'wss://api.sgroup.qq.com/websocket';
const INTENT_GROUP_AND_C2C = 1 << 25;

function stripMentions(text) {
  return String(text || '')
    .replace(/<@!?[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeOfficial(type, d, selfId) {
  if (!d || !d.id) return null;
  const ts = Date.parse(d.timestamp);
  const time = Number.isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
  const author = d.author || {};
  const isGroup = type === 'GROUP_AT_MESSAGE_CREATE';
  const userId = String(isGroup ? (author.member_openid || '') : (author.user_openid || ''));
  const groupId = isGroup ? String(d.group_openid || '') : '';
  if (!userId || (isGroup && !groupId)) return null;

  const senderName = String(author.username || author.nickname || userId);
  const text = stripMentions(d.content);
  if (!text) return null;
  return {
    kind: isGroup ? 'group' : 'private',
    userId,
    groupId,
    messageId: String(d.id),
    text,
    atSelf: isGroup,
    replyId: String(d.id),
    time,
    raw: { ...d, sender: { card: senderName, nickname: senderName } },
  };
}

class OfficialTransport extends QQTransport {
  constructor({
    appId,
    clientSecret,
    ownerId,
    groupNames,
    logger,
    sandbox = false,
    intents = INTENT_GROUP_AND_C2C,
    fetchImpl,
    WebSocketImpl,
    apiBase,
    tokenUrl,
    wsUrl,
  } = {}) {
    super({ logger });
    this.appId = String(appId || '');
    this.clientSecret = String(clientSecret || '');
    this.ownerId = String(ownerId || '');
    this.groupNames = groupNames || {};
    this.apiBase = String(apiBase || (sandbox ? SANDBOX_BASE : API_BASE)).replace(/\/$/, '');
    this.tokenUrl = String(tokenUrl || TOKEN_URL);
    this.wsUrl = String(wsUrl || (sandbox ? 'wss://sandbox.api.sgroup.qq.com/websocket' : WS_URL));
    this.intents = Number(intents) || INTENT_GROUP_AND_C2C;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;

    this.accessToken = '';
    this.expiresAt = 0;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.seq = null;
    this.sessionId = '';
    this.selfId = '';
    this.closed = false;
  }

  capabilities() {
    return {
      groupScope: 'mention-only',
      canProactive: false,
      canHistory: false,
      canGroupInfo: false,
      canLoginInfo: false,
      maxReplyLength: 2000,
      replyMode: 'official-passive',
    };
  }

  async _token(force = false) {
    if (!this.appId || !this.clientSecret) throw new Error('官方 transport 缺少 appId/clientSecret');
    if (!force && this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;

    const r = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {}),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) {
      throw new Error(`官方 access_token 失败：HTTP ${r.status} ${j && (j.message || j.code) || ''}`.trim());
    }
    this.accessToken = String(j.access_token);
    this.expiresAt = Date.now() + (Number(j.expires_in) || 7200) * 1000;
    return this.accessToken;
  }

  async _api(method, path, body) {
    for (let i = 0; i < 2; i++) {
      const token = await this._token(i > 0);
      const r = await this.fetchImpl(this.apiBase + path, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {}),
      });
      if (r.status === 401 && i === 0) continue;
      const j = await r.json().catch(() => null);
      if (!r.ok || (j && typeof j.code === 'number' && j.code !== 0)) {
        throw new Error(`官方 API ${method} ${path} 失败：HTTP ${r.status} ${j && (j.message || j.code) || ''}`.trim());
      }
      return j;
    }
    throw new Error('官方 API 鉴权失败');
  }

  async _gateway() {
    try {
      const j = await this._api('GET', '/gateway');
      if (j && j.url) return String(j.url);
    } catch (e) {
      this.log.warn?.(`[official] /gateway 失败，使用默认地址：${e.message}`);
    }
    return this.wsUrl;
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
  }

  _startHeartbeat(intervalMs) {
    this._stopHeartbeat();
    const ms = Math.max(5000, Number(intervalMs) || 45000);
    this.heartbeatTimer = setInterval(() => {
      this._send({ op: 1, d: this.seq });
    }, ms);
    this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => this.log.error?.(`[official] 重连失败：${e.message}`));
    }, wait);
    this.reconnectTimer.unref?.();
  }

  async connect() {
    if (this.closed) this.closed = false;
    if (!this.WebSocketImpl) {
      this.emit('error', new Error('当前 Node 没有 WebSocket（需要 Node 22+）'));
      return;
    }
    try {
      const url = await this._gateway();
      const ws = new this.WebSocketImpl(url);
      this.ws = ws;

      ws.onmessage = (ev) => {
        let payload;
        try {
          payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch (e) {
          return;
        }
        this._handlePayload(payload);
      };
      ws.onclose = (ev) => {
        this._stopHeartbeat();
        this.ws = null;
        this.emit('close', ev);
        this._scheduleReconnect();
      };
      ws.onerror = (e) => this.emit('error', e);
    } catch (e) {
      this.emit('error', e);
      this._scheduleReconnect();
    }
  }

  _handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.s === 'number') this.seq = payload.s;

    // HELLO：拿心跳周期，然后 IDENTIFY
    if (payload.op === 10) {
      this._startHeartbeat(payload.d && payload.d.heartbeat_interval);
      this._token()
        .then((token) => {
          this._send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: this.intents,
              shard: [0, 1],
              properties: {},
            },
          });
        })
        .catch((e) => this.emit('error', e));
      return;
    }

    if (payload.op === 7 || payload.op === 9) {
      this._stopHeartbeat();
      try { this.ws?.close(); } catch (e) { /* ignore */ }
      return;
    }

    if (payload.op !== 0) return;

    if (payload.t === 'READY') {
      this.attempt = 0;
      this.sessionId = String((payload.d && payload.d.session_id) || '');
      const user = (payload.d && payload.d.user) || {};
      this.selfId = String(user.id || '');
      this.emit('ready', { selfId: this.selfId, nickname: String(user.username || '') });
      return;
    }

    if (payload.t === 'GROUP_AT_MESSAGE_CREATE' || payload.t === 'C2C_MESSAGE_CREATE') {
      const msg = normalizeOfficial(payload.t, payload.d, this.selfId);
      if (msg) this.emit('message', msg);
    }
  }

  async close() {
    this.closed = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch (e) { /* ignore */ }
    this.ws = null;
  }

  async reply(chat, text, opts = {}) {
    const msgId = String(chat.replyId || chat.messageId || '');
    if (!msgId) throw new Error('官方被动回复缺少 msg_id');
    const content = String(text || '').trim();
    if (!content) throw new Error('官方回复内容为空');

    const path = chat.kind === 'group'
      ? `/v2/groups/${encodeURIComponent(chat.groupId)}/messages`
      : `/v2/users/${encodeURIComponent(chat.userId)}/messages`;
    const seq = Number(opts.msgSeq) || 1;
    const mention = Boolean(opts.mentionSender && chat.kind === 'group' && chat.userId);

    // 官方发送 @ 必须走 markdown：<qqbot-at-user id="member_openid" />，
    // 旧的 <@openid> 在 msg_type:0 里会被当普通文字显示。
    if (mention) {
      const body = {
        msg_type: 2,
        markdown: {
          content: `<qqbot-at-user id="${chat.userId}" /> ${content}`.slice(0, 2000),
        },
        msg_id: msgId,
        msg_seq: seq,
      };
      try {
        return await this._api('POST', path, body);
      } catch (e) {
        this.log.warn?.(`[official] Markdown @ 发送失败，降级纯文本：${e.message}`);
        return this._api('POST', path, {
          content: content.slice(0, 2000),
          msg_type: 0,
          msg_id: msgId,
          msg_seq: seq + 1,
        });
      }
    }

    return this._api('POST', path, {
      content: content.slice(0, 2000),
      msg_type: 0,
      msg_id: msgId,
      msg_seq: seq,
    });
  }
}

module.exports = { OfficialTransport, normalizeOfficial, stripMentions, INTENT_GROUP_AND_C2C };
