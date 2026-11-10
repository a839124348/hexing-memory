#!/usr/bin/env node
/**
 * rebuild-daily.js — 老用户日常链结构修复（structure-only）
 *
 * 把扁平的 日常 / 日常链 节点，按 t 的 年/月 移到：
 *   日常（根） → 日常-YYYY（父） → YYYY-MM（月链）
 *
 * 只改链结构，不改节点正文；默认 dry-run，--apply 才写，写前备份 links。
 * 不做“从 raw 重提炼”，那是后续可选步骤。
 */

const fs = require('node:fs');
const path = require('node:path');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const root = arg('--root', process.env.MEMORY_ROOT
  || path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.dsh'), 'dsh-memory'));
const linksDir = path.join(root, 'links');
const apply = process.argv.includes('--apply');
const structureOnly = process.argv.includes('--structure-only') || !process.argv.includes('--re-refine');

if (!structureOnly) {
  console.error('当前只实现 --structure-only；从 raw 重提炼请等 v0.4.4。');
  process.exit(1);
}
if (!fs.existsSync(linksDir)) {
  console.error('找不到 links 目录：' + linksDir);
  process.exit(1);
}

const TIME_RE = /^(\d{4})-(\d{2})-\d{2} \d{2}:\d{2}$/;
const sources = ['日常.json', '日常链.json'].filter((f) => fs.existsSync(path.join(linksDir, f)));
if (!sources.length) {
  console.log('没有 日常.json / 日常链.json，无需修复。');
  process.exit(0);
}

const plan = new Map(); // target file -> { name, parent, header, nodes: [] }
const sourceData = [];
let total = 0;
let skipped = 0;

for (const f of sources) {
  const p = path.join(linksDir, f);
  let chain;
  try { chain = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.error('跳过 ' + f + '：' + e.message);
    continue;
  }
  const keep = [];
  let moved = 0;
  for (const n of chain.nodes || []) {
    const m = TIME_RE.exec(String(n.t || ''));
    if (!m) { keep.push(n); skipped++; continue; }
    const year = m[1];
    const month = m[1] + '-' + m[2];
    const yearFile = `日常-${year}.json`;
    const monthFile = `${month}.json`;
    if (!plan.has(yearFile)) {
      plan.set(yearFile, { name: `日常-${year}`, parent: '日常', header: `${year} 年日常`, nodes: [] });
    }
    if (!plan.has(monthFile)) {
      plan.set(monthFile, { name: month, parent: `日常-${year}`, header: `${month} 日常`, nodes: [] });
    }
    plan.get(monthFile).nodes.push({ ...n });
    moved++;
    total++;
  }
  sourceData.push({ file: f, chain, keep, moved });
}

console.log(`模式：${apply ? 'APPLY' : 'dry-run'}；来源：${sources.join(', ')}`);
console.log(`可迁移节点：${total}；时间格式不匹配保留原样：${skipped}`);
for (const [f, c] of plan) {
  console.log(`- ${f} ← ${c.name}（parent=${c.parent}，${c.nodes.length} 节点）`);
}

if (!apply) {
  console.log('\n确认后加 --apply；写前会备份 links。');
  process.exit(0);
}
if (!total) {
  console.log('没有可迁移节点，不写盘。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(root, 'links.bak-daily-' + stamp);
fs.cpSync(linksDir, backup, { recursive: true });
console.log('已备份：' + backup);

// 1) 源链保留未迁移节点
for (const s of sourceData) {
  if (!s.moved) continue;
  s.chain.nodes = s.keep;
  s.chain.header = 'legacy：旧扁平日常节点已迁移到 日常-年/月（structure-only）';
  s.chain.updatedAt = new Date().toISOString();
  const p = path.join(linksDir, s.file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s.chain, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// 2) 目标年/月链合并
for (const [f, c] of plan) {
  const target = path.join(linksDir, f);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { /* new */ }
  const merged = old && Array.isArray(old.nodes) ? old.nodes : [];
  const seen = new Set(merged.map((n) => [n.t, n.type, n.text].join('\u0000')));
  for (const n of c.nodes) {
    const key = [n.t, n.type, n.text].join('\u0000');
    if (!seen.has(key)) { seen.add(key); merged.push(n); }
  }
  const out = old || {
    name: c.name,
    parent: c.parent,
    header: c.header,
    nodes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  out.parent = c.parent;
  out.header = out.header || c.header;
  out.nodes = merged;
  out.updatedAt = new Date().toISOString();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}
console.log('完成：' + total + ' 个节点已按年/月归位。');
