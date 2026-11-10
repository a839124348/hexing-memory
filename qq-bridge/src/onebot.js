/**
 * onebot.js — OneBot 11 正向 WebSocket 客户端
 *
 * 只负责“连接、收事件、发动作、断线重连”，不懂 QQ、不懂记忆。
 * NapCat / LLOneBot 都按 OneBot 11 暴露同一个口，所以这里不绑定具体底座。
 */

const { EventEmitter } = require('node:events');

function onWs(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') ws.addEventListener(event, handler);
  else if (typeof ws.on === 'function') ws.on(event, handler);
}

function eventData(ev) {
  if (ev && typeof ev === 'object' && 'data' in ev) return ev.data;
  return ev;
}

class OneBotClient extends EventEmitter {
  constructor({
    url,
    token = '',
    WebSocketImpl = globalThis.WebSocket,
    reconnect = true,
    reconnectMs = 1000,
    maxReconnectMs = 30000,
    heartbeatTimeoutMs = 90000,
    logger = console,
  } = {}) {
    super();
    if (!url) throw new Error('OneBotClient 需要 url');
    if (!WebSocketImpl) throw new Error('当前 Node 没有 WebSocket，请用 Node 22+');

    this.url = url;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnect = reconnect;
    this.reconnectMs = reconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.logger = logger;

    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.attempt = 0;
    this.seq = 0;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastEventAt = 0;
  }

  _targetUrl() {
    if (!this.token) return this.url;
    const u = new URL(this.url);
    u.searchParams.set('access_token', this.token);
    return u.toString();
  }

  connect() {
    if (this.closed || this.ws) return;
    const target = this._targetUrl();
    this.logger.info?.(`[onebot] 连接 ${target.replace(/access_token=[^&]+/, 'access_token=***')}`);

    let ws;
    try {
      ws = new this.WebSocketImpl(target);
    } catch (e) {
      this.logger.error?.(`[onebot] 创建连接失败：${e.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    onWs(ws, 'open', () => {
      this.connected = true;
      this.attempt = 0;
      this.lastEventAt = Date.now();
      this._startHeartbeat();
      this.logger.info?.('[onebot] 已连接');
      this.emit('open');
    });

    onWs(ws, 'message', (ev) => {
      this._handleFrame(eventData(ev));
    });

    onWs(ws, 'close', (ev) => {
      this.connected = false;
      this._stopHeartbeat();
      this._rejectPending(new Error('OneBot 连接已关闭'));
      this.ws = null;
      this.logger.warn?.(`[onebot] 连接关闭 code=${(ev && ev.code) || '?'}`);
      this.emit('close', ev);
      this._scheduleReconnect();
    });

    onWs(ws, 'error', (err) => {
      this.logger.error?.(`[onebot] 连接错误：${(err && err.message) || err}`);
      this.emit('error', err);
    });
  }

  _handleFrame(frame) {
    if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
      try {
        frame = JSON.parse(String(frame));
      } catch (e) {
        this.logger.warn?.('[onebot] 收到非 JSON 帧，已忽略');
        return;
      }
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.echo && this.pending.has(frame.echo)) {
      const p = this.pending.get(frame.echo);
      this.pending.delete(frame.echo);
      clearTimeout(p.timer);
      const ok = frame.status === 'ok' || frame.retcode === 0;
      if (ok) p.resolve(frame.data);
      else p.reject(new Error(`OneBot ${frame.retcode || 'error'}: ${frame.wording || frame.message || '调用失败'}`));
      return;
    }

    if (frame.post_type) {
      this.lastEventAt = Date.now();
      this.emit('event', frame);
      return;
    }

    this.emit('response', frame);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastEventAt > this.heartbeatTimeoutMs) {
        this.logger.warn?.('[onebot] 心跳超时，重连');
        try { this.ws?.close(); } catch (e) { /* ignore */ }
      }
    }, Math.min(30000, Math.max(5000, this.heartbeatTimeoutMs / 3)));
    this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _scheduleReconnect() {
    if (!this.reconnect || this.closed || this.reconnectTimer) return;
    const wait = Math.min(this.maxReconnectMs, this.reconnectMs * (2 ** this.attempt));
    this.attempt++;
    this.logger.info?.(`[onebot] ${Math.round(wait / 1000)}s 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  _rejectPending(err) {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(echo);
    }
  }

  call(action, params = {}, timeoutMs = 15000) {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('OneBot 未连接'));
    }
    const echo = `q-${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e);
      }
    });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  getLoginInfo() {
    return this.call('get_login_info', {});
  }

  close() {
    this.closed = true;
    this.reconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._stopHeartbeat();
    this._rejectPending(new Error('OneBot 客户端已关闭'));
    try { this.ws?.close(); } catch (e) { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }
}

module.exports = { OneBotClient };
