#!/usr/bin/env node
/**
 * check-chain-time.js — 只读诊断链节点时间
 *
 * 用法：
 *   node repair/tools/check-chain-time.js
 *   node repair/tools/check-chain-time.js --root "C:\Users\...\dsh-memory" --json
 *
 * 只读，不写任何文件。
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
const json = process.argv.includes('--json');

if (!fs.existsSync(linksDir)) {
  console.error('找不到 links 目录：' + linksDir);
  process.exit(1);
}

const files = fs.readdirSync(linksDir).filter((f) => f.endsWith('.json'));
const rows = [];
let total = 0;
let legacy = 0;
const sourceCount = {};

for (const f of files) {
  let chain;
  try {
    chain = JSON.parse(fs.readFileSync(path.join(linksDir, f), 'utf8'));
  } catch (e) {
    rows.push({ chain: f, error: 'JSON 解析失败：' + e.message });
    continue;
  }
  for (const n of chain.nodes || []) {
    total++;
    const src = n.tSource || '(legacy)';
    sourceCount[src] = (sourceCount[src] || 0) + 1;
    if (!n.tSource) {
      legacy++;
      rows.push({
        chain: chain.name || f.replace(/\.json$/, ''),
        t: n.t || '',
        who: n.who || '',
        text: String(n.text || '').slice(0, 120),
        source: n.source || '',
      });
    }
  }
}

if (json) {
  console.log(JSON.stringify({ root, files: files.length, total, legacy, sourceCount, rows }, null, 2));
  process.exit(0);
}

console.log('记忆根：' + root);
console.log(`链文件：${files.length}；节点：${total}；无 tSource 的旧节点：${legacy}`);
console.log('tSource 分布：' + JSON.stringify(sourceCount));
if (legacy) {
  console.log('\n旧节点（只读，不会改）：');
  for (const r of rows) {
    if (r.error) {
      console.log(`- ${r.chain}: ${r.error}`);
      continue;
    }
    console.log(`- [${r.chain}] ${r.t} ${r.who} | ${r.text}${r.source ? ' | source=' + r.source : ''}`);
  }
  console.log('\n如果这些时间看起来比本地慢/快一个时区，先别批量改；用 repair/REPAIR-FOR-AI.md 的取证流程确认。');
}
