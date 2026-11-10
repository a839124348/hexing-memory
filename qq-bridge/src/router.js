/**
 * router.js — 只认三种消息
 *
 * owner 私聊  → 交给 DSH（有记忆）
 * 群 @ 机器人 → 公开模式（不读私聊记忆、不写主记忆）
 * 其他        → 忽略
 *
 * 不在这里判断内容、不在这里生成回复。
 */

const ROUTES = {
  OWNER_PRIVATE: 'owner_private',
  GROUP_MENTION: 'group_mention',
  IGNORE_SELF: 'ignore_self',
  IGNORE_NON_OWNER_PRIVATE: 'ignore_non_owner_private',
  IGNORE_GROUP_NO_MENTION: 'ignore_group_no_mention',
  IGNORE_OTHER: 'ignore_other',
};

function classify(msg, { ownerId, selfId } = {}) {
  if (!msg) return { route: ROUTES.IGNORE_OTHER, reason: 'empty' };

  const owner = String(ownerId || '');
  const self = String(selfId || '');

  if (self && msg.userId === self) {
    return { route: ROUTES.IGNORE_SELF, reason: 'self message' };
  }

  if (msg.kind === 'private') {
    if (owner && msg.userId === owner) {
      return { route: ROUTES.OWNER_PRIVATE, reason: 'owner private' };
    }
    return { route: ROUTES.IGNORE_NON_OWNER_PRIVATE, reason: 'non-owner private' };
  }

  if (msg.kind === 'group') {
    if (msg.atSelf) {
      return { route: ROUTES.GROUP_MENTION, reason: 'group at self' };
    }
    return { route: ROUTES.IGNORE_GROUP_NO_MENTION, reason: 'group no mention' };
  }

  return { route: ROUTES.IGNORE_OTHER, reason: 'not private/group' };
}

function shouldHandle(route) {
  return route === ROUTES.OWNER_PRIVATE || route === ROUTES.GROUP_MENTION;
}

module.exports = { ROUTES, classify, shouldHandle };
