/**
 * normalize.js — 把 OneBot 11 的事件压成桥内部用的最小消息
 *
 * 只做三件事：
 * - 认私聊/群、群号、发送者、message_id
 * - 取纯文本（@、引用、图片、表情先剥掉/占位）
 * - 判断这条消息有没有 @ 机器人
 *
 * 不在这里做路由、不在这里发消息、不在这里碰记忆。
 */

function asArrayMessage(message, rawMessage) {
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') return parseCQ(message);
  if (typeof rawMessage === 'string') return parseCQ(rawMessage);
  return [];
}

/** 把 CQ 码字符串拆成和 OneBot 数组消息同形的段 */
function parseCQ(text) {
  const out = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    const type = m[1];
    const data = {};
    const params = m[2] ? m[2].slice(1).split(',') : [];
    for (const p of params) {
      const i = p.indexOf('=');
      if (i > 0) data[p.slice(0, i)] = p.slice(i + 1);
    }
    out.push({ type, data });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', data: { text: text.slice(last) } });
  return out;
}

function segmentText(seg) {
  if (!seg || typeof seg !== 'object') return '';
  if (seg.type === 'text') return String((seg.data && seg.data.text) || '');
  if (seg.type === 'image') return '[图片]';
  if (seg.type === 'face') return '[表情]';
  if (seg.type === 'record') return '[语音]';
  if (seg.type === 'video') return '[视频]';
  if (seg.type === 'file') return '[文件]';
  return '';
}

function extractText(message, rawMessage) {
  return asArrayMessage(message, rawMessage)
    .map(segmentText)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function hasAt(message, rawMessage, selfId) {
  const id = String(selfId || '');
  if (!id) return false;
  const segs = asArrayMessage(message, rawMessage);
  return segs.some((s) => s && s.type === 'at' && String(s.data && s.data.qq) === id);
}

function replyId(message, rawMessage) {
  const segs = asArrayMessage(message, rawMessage);
  const hit = segs.find((s) => s && s.type === 'reply');
  return hit ? String((hit.data && hit.data.id) || '') : '';
}

/** 去掉 @ 机器人本身，保留其余文本 */
function textWithoutAtSelf(message, rawMessage, selfId) {
  const id = String(selfId || '');
  const segs = asArrayMessage(message, rawMessage);
  return segs
    .filter((s) => !(s && s.type === 'at' && String(s.data && s.data.qq) === id))
    .map(segmentText)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * @returns {null | {
 *   kind: 'private'|'group'|'other',
 *   userId: string, groupId: string, messageId: string,
 *   text: string, atSelf: boolean, replyId: string,
 *   time: number, raw: object
 * }}
 */
function normalizeEvent(event, selfId) {
  if (!event || event.post_type !== 'message') return null;
  const type = event.message_type;
  if (type !== 'private' && type !== 'group') {
    return {
      kind: 'other',
      userId: String(event.user_id || ''),
      groupId: String(event.group_id || ''),
      messageId: String(event.message_id || ''),
      text: extractText(event.message, event.raw_message),
      atSelf: false,
      replyId: replyId(event.message, event.raw_message),
      time: Number(event.time) || 0,
      raw: event,
    };
  }

  const atSelf = type === 'group' && hasAt(event.message, event.raw_message, selfId);
  const text = type === 'group'
    ? textWithoutAtSelf(event.message, event.raw_message, selfId)
    : extractText(event.message, event.raw_message);

  return {
    kind: type,
    userId: String(event.user_id || ''),
    groupId: String(event.group_id || ''),
    messageId: String(event.message_id || ''),
    text,
    atSelf,
    replyId: replyId(event.message, event.raw_message),
    time: Number(event.time) || 0,
    raw: event,
  };
}

module.exports = {
  normalizeEvent,
  extractText,
  hasAt,
  replyId,
  textWithoutAtSelf,
  parseCQ,
};
