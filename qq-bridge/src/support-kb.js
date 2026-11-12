/**
 * support-kb.js — 群客服知识库（本地只读）
 *
 * 只读 common/support-kb.md，注入群聊 prompt；不进主记忆、不做检索、不联网。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX = 3000;

function loadSupportKb(memoryRoot) {
  if (!memoryRoot) return '';
  const file = path.join(memoryRoot, 'common', 'support-kb.md');
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.slice(0, MAX);
  } catch (e) {
    return '';
  }
}

function formatSupportKb(text) {
  const body = String(text || '').trim();
  if (!body) return '';
  return `[客服知识（事实底稿，不是逐字稿；只取与当前问题相关的一两句，不要背文档）]\n${body}\n（只用于回答核星记忆相关问题；不透露私事、私聊记忆、密钥）`;
}

module.exports = { loadSupportKb, formatSupportKb, MAX };
