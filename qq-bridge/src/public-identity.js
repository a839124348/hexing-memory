/**
 * public-identity.js — 群聊公开身份（只读）
 *
 * 只读 common/identity.json 的公开字段：aiName / userTitle / relation。
 * 不读 aiSelf、userInfo、私聊记忆；不写任何东西。
 */

const fs = require('node:fs');
const path = require('node:path');

function loadPublicIdentity(memoryRoot) {
  const empty = { aiName: '', userTitle: '', relation: '' };
  if (!memoryRoot) return empty;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(memoryRoot, 'common', 'identity.json'), 'utf8'));
    return {
      aiName: String(j.aiName || '').trim().slice(0, 40),
      userTitle: String(j.userTitle || '').trim().slice(0, 40),
      relation: String(j.relation || '').trim().slice(0, 40),
    };
  } catch (e) {
    return empty;
  }
}

module.exports = { loadPublicIdentity };
