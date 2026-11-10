/**
 * guard.js — QQ 发送闸门（不依赖 DSH）
 *
 * 三件事：
 * - kill switch
 * - 去重（同 target + 同文本，短时间只发一次）
 * - 限流（群 1 条/10s，私聊默认不卡）
 *
 * 不做内容过滤（PII/项目白名单）——那层要接记忆的 public 数据，后面单独做。
 */

const crypto = require('node:crypto');

function targetKey(kind, targetId) {
  return `${kind}:${targetId}`;
}

function textKey(kind, targetId, text) {
  const h = crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
  return `${kind}:${targetId}:${h}`;
}

class SendGuard {
  constructor({
    now = Date.now,
    enabled = true,
    groupMinMs = 10000,
    privateMinMs = 0,
    dedupeMs = 3000,
    quietHours = [],
  } = {}) {
    this.now = now;
    this.enabled = enabled !== false;
    this.groupMinMs = Math.max(0, Number(groupMinMs) || 0);
    this.privateMinMs = Math.max(0, Number(privateMinMs) || 0);
    this.dedupeMs = Math.max(0, Number(dedupeMs) || 0);
    this.quietHours = new Set((quietHours || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23));
    this.last = new Map();
    this.seen = new Map();
  }

  _prune(now) {
    for (const [k, t] of this.seen) {
      if (now - t > this.dedupeMs) this.seen.delete(k);
    }
  }

  check({ kind, targetId, text } = {}) {
    const now = this.now();
    if (!this.enabled) return { ok: false, reason: 'kill switch 已关闭' };
    if (!kind || !targetId) return { ok: false, reason: '缺 kind/targetId' };

    if (this.quietHours.size) {
      const hour = new Date(now).getHours();
      if (this.quietHours.has(hour)) return { ok: false, reason: `免打扰时段（${hour} 点）` };
    }

    this._prune(now);
    const sk = textKey(kind, targetId, text);
    if (this.seen.has(sk)) return { ok: false, reason: '重复文本，已忽略' };

    const minMs = kind === 'group' ? this.groupMinMs : this.privateMinMs;
    const lk = targetKey(kind, targetId);
    const last = this.last.get(lk);
    if (minMs > 0 && last && now - last < minMs) {
      return { ok: false, reason: `限流：还差 ${Math.ceil((minMs - (now - last)) / 1000)}s`, waitMs: minMs - (now - last) };
    }

    return { ok: true, reason: '', waitMs: 0 };
  }

  record({ kind, targetId, text } = {}) {
    if (!kind || !targetId) return;
    const now = this.now();
    this.last.set(targetKey(kind, targetId), now);
    this.seen.set(textKey(kind, targetId, text), now);
  }
}

module.exports = { SendGuard, targetKey, textKey };
