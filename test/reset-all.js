/**
 * reset-all.js — 完全重置（测试前必跑）
 *
 * 为什么必须"完全"：2026-11-06 的教训——只清记忆库不清理 DSH 缓存，
 * 模型会从缓存里"记得"已删的内容，导致排查方向全错（以为是幻觉，其实是 projcache）。
 *
 * 清：
 *   1. dsh-memory/{raw,draft,index}         我们的记忆库
 *   2. dsh-memory/common/{links,refine-state}.json   链网与提炼状态
 *   3. .dsh/sessions/*                        DSH 会话原文
 *   4. .dsh/storages/session_projcache/*      DSH 会话投影缓存  ← 元凶
 *   5. .dsh/storages/workspace.json           工作区状态
 *
 * 保留：
 *   - dsh-memory/common/IDENTITY.md          身份（用户设定的，不是测试数据）
 *   - dsh-memory/common/identity.json        结构化身份
 *
 * 用法：node test/reset-all.js [--backup]
 */
const fs = require('fs');
const path = require('path');

const BACKUP_FLAG = process.argv.includes('--backup');
const DATA = path.join(process.env.APPDATA, 'dsh-memory');
const DSH = path.join(process.env.USERPROFILE, '.dsh');
const BACKUP = path.join(__dirname, '..', '_backup', 'reset-' + new Date().toISOString().replace(/[:.]/g, '-'));

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    try {
      if (e.isDirectory()) n += copyDir(s, d);
      else { fs.copyFileSync(s, d); n++; }
    } catch (err) { /* 跳过不可读 */ }
  }
  return n;
}

function clearDir(p) {
  if (!fs.existsSync(p)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    try {
      const st = fs.lstatSync(q);
      if (st.isDirectory()) { clearDir(q); fs.rmdirSync(q); }
      else { fs.unlinkSync(q); }
      n++;
    } catch (err) { /* 文件被占用就跳过 */ }
  }
  return n;
}

let total = 0;

if (BACKUP_FLAG) {
  total += copyDir(DATA, path.join(BACKUP, 'dsh-memory'));
  total += copyDir(DSH, path.join(BACKUP, 'dsh'));
  console.log(`[备份] ${total} 个文件 → ${BACKUP}`);
}

// 1. 记忆库
for (const sub of ['raw', 'draft', 'index']) {
  const n = clearDir(path.join(DATA, sub));
  console.log(`[清空] dsh-memory/${sub} : ${n} 个`);
}

// 2. 链网与提炼状态
for (const f of ['links.json', 'refine-state.json']) {
  const p = path.join(DATA, 'common', f);
  if (!fs.existsSync(p)) continue;
  if (f === 'links.json') fs.writeFileSync(p, JSON.stringify({ sessions: [], events: [] }, null, 1), 'utf8');
  else fs.writeFileSync(p, JSON.stringify({ runs: 0, lastRunAt: null, lastError: null, deadLetters: [] }, null, 1), 'utf8');
  console.log(`[重置] dsh-memory/common/${f}`);
}

// 3. DSH 会话原文
{
  const n = clearDir(path.join(DSH, 'sessions'));
  console.log(`[清空] .dsh/sessions : ${n} 个`);
}

// 4. DSH 会话投影缓存（元凶）
{
  const n = clearDir(path.join(DSH, 'storages', 'session_projcache'));
  console.log(`[清空] .dsh/storages/session_projcache : ${n} 个`);
}

// 5. 工作区状态
{
  const p = path.join(DSH, 'storages', 'workspace.json');
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('[删除] .dsh/storages/workspace.json'); }
}

// 确认
console.log('');
console.log('=== 剩余');
const keep = ['IDENTITY.md', 'identity.json'];
const common = path.join(DATA, 'common');
if (fs.existsSync(common)) {
  const files = fs.readdirSync(common);
  console.log('dsh-memory/common : ' + files.join(', '));
  for (const k of keep) if (!files.includes(k)) console.log(`  ⚠ 身份文件缺失：${k}`);
}
console.log('');
console.log('重置完成。请重启 DSH（双击 bat）');
