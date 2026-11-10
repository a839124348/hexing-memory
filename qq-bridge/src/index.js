/**
 * index.js — OneBot 11 收发骨架（先不接 DSH）
 *
 * 现在只验证三件事：
 * 1. 能连上 NapCat / LLOneBot 的正向 WebSocket
 * 2. 能认出 owner 私聊 / 群 @
 * 3. dry-run 只打日志；设了 replyText 才真的回一条
 *
 * DSH 接入口、群友 24h 分板、出站闸门后续再接。
 */

const fs = require('node:fs');
const path = require('node:path');
const { OneBotClient } = require('./onebot');
const { normalizeEvent } = require('./normalize');
const { classify, shouldHandle, ROUTES } = require('./router');

function loadConfig() {
  const file = path.join(__dirname, '..', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return {
    onebot: {
      url: process.env.ONEBOT_WS_URL || (cfg.onebot && cfg.onebot.url) || 'ws://127.0.0.1:3001',
      token: process.env.ONEBOT_TOKEN ?? (cfg.onebot && cfg.onebot.token) ?? '',
    },
    ownerId: String(process.env.OWNER_QQ || cfg.ownerId || ''),
    dryRun: process.env.DRY_RUN ? process.env.DRY_RUN !== '0' : (cfg.dryRun !== false),
    replyText: process.env.REPLY_TEXT || cfg.replyText || '',
  };
}

function short(text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.ownerId) {
    console.error('缺少 ownerId：在 qq-bridge/config.json 里填 ownerId，或设 OWNER_QQ');
    process.exit(1);
  }

  const client = new OneBotClient({
    url: cfg.onebot.url,
    token: cfg.onebot.token,
    logger: console,
  });

  let selfId = '';

  client.on('open', async () => {
    try {
      const info = await client.getLoginInfo();
      selfId = String((info && info.user_id) || '');
      console.log(`[bridge] 登录机器人：${selfId || '未知'}（${(info && info.nickname) || ''}）`);
    } catch (e) {
      console.warn(`[bridge] get_login_info 失败：${e.message}`);
    }
  });

  client.on('event', (event) => {
    if (!selfId && event && event.self_id) selfId = String(event.self_id);
    const msg = normalizeEvent(event, selfId);
    if (!msg) return;

    const { route, reason } = classify(msg, { ownerId: cfg.ownerId, selfId });
    const where = msg.kind === 'group' ? `群 ${msg.groupId}` : `私聊 ${msg.userId}`;
    console.log(`[bridge] ${where} → ${route}（${reason}）${msg.atSelf ? ' @' : ''}：${short(msg.text)}`);

    if (!shouldHandle(route)) return;
    if (cfg.dryRun && !cfg.replyText) return;

    const text = cfg.replyText || '（桥已收到，DSH 还没接）';
    const message = msg.replyId
      ? [{ type: 'reply', data: { id: msg.replyId } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }];

    const send = route === ROUTES.OWNER_PRIVATE
      ? client.sendPrivate(msg.userId, message)
      : client.sendGroup(msg.groupId, message);

    send.then((data) => {
      console.log(`[bridge] 已回复 message_id=${(data && data.message_id) || '?'}`);
    }).catch((e) => {
      console.error(`[bridge] 回复失败：${e.message}`);
    });
  });

  client.on('close', () => console.warn('[bridge] OneBot 断开，等待重连'));
  client.on('error', (e) => console.error(`[bridge] OneBot 错误：${(e && e.message) || e}`));

  client.connect();

  const stop = () => {
    console.log('\n[bridge] 退出');
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
