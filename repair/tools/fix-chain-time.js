#!/usr/bin/env node
/**
 * fix-chain-time.js — 按“已确认映射”修链节点时间（默认 dry-run）
 *
 * 不做时区猜测，不全面转写。只有 map 里明确给出的节点才改：
 *   map JSON 格式：
 *   [
 *     { "chain": "身份链", "text": "原节点文本", "t": "2026-11-07 10:00" }
 *   ]
 * 或 { "身份链\u0000原节点文本": "2026-11-07 10:00" }
 *
 * 用法：
 *   node repair/tools/fix-chain-time.js --map map.json
 *   node repair/tools/fix-chain-time.js --map map.json --apply
 */

const fs = require('node:fs');
const path = require('node:path');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const root = arg('--root', process.env.MEMORY_ROOT
  || path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.dsh'), 'dsh-memory'));
const mapFile = arg('--map', '');
const apply = process.argv.includes('--apply');
const linksDir = path.join(root, 'links');

if (!fs.existsSync(linksDir)) {
  console.error('找不到 links 目录：' + linksDir);
  process.exit(1);
}
if (!mapFile || !fs.existsSync(mapFile)) {
  console.error('缺少 --map 文件。先用 check-chain-time.js 诊断，确认证据后再生成 map。');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
} catch (e) {
  console.error('map JSON 解析失败：' + e.message);
  process.exit(1);
}

const map = new Map();
if (Array.isArray(raw)) {
  for (const x of raw) {
    if (!x || !x.chain || !x.text || !x.t) continue;
    map.set(x.chain + '\u0000' + x.text, String(x.t));
  }
} else if (raw && typeof raw === 'object') {
  for (const [k, v] of Object.entries(raw)) map.set(k, String(v));
}
if (!map.size) {
  console.error('map 里没有有效条目。');
  process.exit(1);
}

const files = fs.readdirSync(linksDir).filter((f) => f.endsWith('.json'));
let changed = 0;
let skipped = 0;
const plan = [];

let backup = '';
if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup = path.join(root, 'links.bak-' + stamp);
  fs.cpSync(linksDir, backup, { recursive: true });
  console.log('已备份：' + backup);
}

for (const f of files) {
  const file = path.join(linksDir, f);
  let chain;
  try {
    chain = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`跳过 ${f}：${e.message}`);
    continue;
  }
  let dirty = false;
  for (const n of chain.nodes || []) {
    if (n.tSource) { skipped++; continue; }
    const key = (chain.name || f.replace(/\.json$/, '')) + '\u0000' + n.text;
    const t = map.get(key);
    if (!t) { skipped++; continue; }
    plan.push({ file: f, chain: chain.name, from: n.t, to: t, text: n.text });
    n.t = t;
    n.tSource = 'map';
    dirty = true;
    changed++;
  }
  if (dirty && apply) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(chain, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}

console.log(`模式：${apply ? 'APPLY（会写盘）' : 'dry-run（只预演）'}`);
console.log(`匹配到可修节点：${changed}；跳过：${skipped}`);
for (const p of plan) {
  console.log(`- [${p.chain}] ${p.from} → ${p.to} | ${String(p.text).slice(0, 80)}`);
}
if (!apply && changed) {
  console.log('\n确认无误后加 --apply；写之前会整目录备份 links。');
}
