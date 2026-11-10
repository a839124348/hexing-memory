/**
 * list-sessions.js — 列出 DSH 会话 id / 标题 / 工作目录（只读）
 *
 * 用途：QQ 桥要把 owner 私聊绑到已有会话时，先按标题找会话，
 * 再把精确的 session id 填进 `ownerSessionId`（或让模型调用 qq_bind_session）。
 *
 * 用法：
 *   node tools/list-sessions.js
 *   node tools/list-sessions.js --json
 *   node tools/list-sessions.js --root "C:\Users\你\.dsh\sessions" --limit 50
 *
 * 只读 session 头和 session/title 事件，不输出聊天内容。
 */
const path = require('node:path');
const os = require('node:os');
const { listSessions, localTime } = require('../qq-bridge/src/session-catalog.js');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes('--' + name);
}

function main() {
  const root = arg('root', path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions'));
  const limit = Math.max(1, Number(arg('limit', '30')) || 30);
  const rows = listSessions(root);

  if (hasFlag('json')) {
    console.log(JSON.stringify(rows.slice(0, limit).map((s) => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      agentPreset: s.agentPreset,
      lastActive: localTime(s.lastActive),
      createdAt: localTime(s.createdAt),
    })), null, 2));
    return;
  }

  console.log(`会话根目录：${root}`);
  console.log(`共 ${rows.length} 个；按最近活动排序，显示前 ${Math.min(limit, rows.length)} 个。\n`);
  for (const s of rows.slice(0, limit)) {
    console.log(`标题：${s.title}`);
    console.log(`  id：${s.id}`);
    console.log(`  最近：${localTime(s.lastActive)}    创建：${localTime(s.createdAt)}`);
    console.log(`  目录：${s.cwd}`);
    console.log('');
  }
  console.log('绑定：把要接 QQ 的会话 id 原样填进 hexing-qq 的 ownerSessionId；');
  console.log('或让 DSH 里的模型直接调用 qq_bind_session（按标题/当前会话自动绑定）。');
}

main();
