/**
 * reset-all.js — 完全重置（只给开发机用）
 *
 * ⚠️ 危险：会清空 raw 原文、DSH 会话和投影缓存。真实记忆库禁止运行。
 * 必须显式加 --yes 才会执行；默认先整目录备份（--no-backup 可跳过）。
 *
 * 为什么必须"完全"：2026-11-06 的教训——只清记忆库不清理 DSH 缓存，
 * 模型会从缓存里"记得"已删的内容，导致排查方向全错（以为是幻觉，其实是 projcache）。
 *
 * 清：
 *   1. dsh-memory/{raw,draft,index}         我们的记忆库
 *   2. dsh-memory/common/{links,refine-state}.json   链网与提炼状态
 *   3. dsh-memory/links/*.json              链网文件（核星会在下次启动重建）
 *   4. .dsh/sessions/*                        DSH 会话原文
 *   5. .dsh/storages/session_projcache/*      DSH 会话投影缓存  ← 元凶
 *   6. .dsh/storages/workspace.json           工作区状态
 *
 * 保留：
 *   - dsh-memory/common/IDENTITY.md          身份（用户设定的，不是测试数据）
 *   - dsh-memory/common/identity.json        结构化身份
 *   - dsh-memory/common/stats.json           token 用量（不是测试内容）
 *
 * 用法：node test/reset-all.js --yes [--no-backup]
 */
const fs = require('fs');
const path = require('path');

const CONFIRM = process.argv.includes('--yes');
const BACKUP_FLAG = !process.argv.includes('--no-backup');
const DATA = path.join(process.env.APPDATA, 'dsh-memory');
const DSH = path.join(process.env.USERPROFILE, '.dsh');
const BACKUP = path.join(__dirname, '..', '_backup', 'reset-' + new Date().toISOString().replace(/[:.]/g, '-'));

if (!CONFIRM) {
  console.log('拒绝执行：这个脚本会清空 raw 原文、DSH 会话和投影缓存。');
  console.log('确认是开发机、且已不再需要这些数据，再加 --yes：');
  console.log('  node test/reset-all.js --yes');
  console.log('默认会先备份；不想备份再加 --no-backup（不建议）。');
  process.exit(1);
}

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

// 2b. 链网文件 + 话题栈（之前漏了，测试链会残留）
{
  const dir = path.join(DATA, 'links');
  let n = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) { /* 占用就跳过 */ }
    }
  }
  console.log(`[清空] dsh-memory/links : ${n} 个（核星会在下次启动重建）`);
  const tp = path.join(DATA, 'common', 'topics.json');
  if (fs.existsSync(tp)) { fs.rmSync(tp); console.log('[删除] dsh-memory/common/topics.json'); }
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
