/**
 * wake_tools.js — 唤醒轮的工具策略
 *
 * 目标不是“禁止她思考”，而是“别在刚醒来的一次里造成不可逆影响”：
 * - 读：允许
 * - 追加：允许（草稿、链节点、话题）
 * - 覆盖/删除/执行任务：拒绝
 *
 * 纯函数，单测覆盖；插件在 tools/pre-execute 里调用。
 */

const READ_ONLY = new Set([
  'read', 'glob', 'grep', 'web_search', 'web_fetch', 'ask_user_question', 'skill',
  'memory_search', 'memory_common', 'memory_draft',
]);

const READ_ACTIONS = {
  'memory_chain': new Set(['list', 'tree', 'get', 'status']),
  'memory_topic': new Set(['list', 'get', 'status']),
  'memory_manual': new Set(['toc', 'read', 'status']),
  'memory_identity': new Set(['get', 'status', 'read']),
  'memory_onboarding': new Set(['status', 'check', 'voice_get']),
};

const APPEND_ACTIONS = {
  'memory_chain': new Set(['append', 'create']),
  'memory_topic': new Set(['add']),
};

const APPEND_TOOLS = new Set(['memory_write']);

function decideWakeTool(name, args) {
  const tool = String(name || '').trim();
  if (!tool) return { allow: false, reason: '唤醒轮没有工具名' };

  if (READ_ONLY.has(tool)) return { allow: true, reason: 'read-only' };
  if (APPEND_TOOLS.has(tool)) return { allow: true, reason: 'append-only' };

  const action = String((args && args.action) || '').trim().toLowerCase();
  if (READ_ACTIONS[tool] || APPEND_ACTIONS[tool]) {
    const read = READ_ACTIONS[tool] || new Set();
    const append = APPEND_ACTIONS[tool] || new Set();
    if (read.has(action)) return { allow: true, reason: 'read-only' };
    if (append.has(action)) return { allow: true, reason: 'append-only' };
    return {
      allow: false,
      reason: `唤醒轮只允许读取或追加 ${tool}；${action || '这个 action'} 会覆盖/删除，先回到正常对话再做。`,
    };
  }

  return {
    allow: false,
    reason: '唤醒轮只允许读取和追加；删除、覆盖、执行任务先回到正常对话再做。',
  };
}

module.exports = {
  READ_ONLY,
  READ_ACTIONS,
  APPEND_ACTIONS,
  APPEND_TOOLS,
  decideWakeTool,
};
