/**
 * diagnose.js — 只读诊断报告（给用户贴 issue 用，不含记忆原文）
 *
 * 用法：
 *   node tools/diagnose.js
 *   node tools/diagnose.js --json
 *   node tools/diagnose.js --data <你的数据目录>
 *
 * 只输出：版本、运行环境、数据目录、各层条数、链网/话题统计、提炼错误、
 * 向量服务健康、说明书阅读进度。**不输出任何 raw 原文、身份内容、链节点正文。**
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const ROOT = path.join(__dirname, '..');
const DATA = arg('data') || process.env.MEMORY_ROOT
  || path.join(process.env.APPDATA || process.env.HOME || '.', 'dsh-memory');
const JSON_OUT = process.argv.includes('--json');

function countLines(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch (e) { return -1; }
}

function readJson(file, def = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext));
  } catch (e) { return []; }
}

function dshVersion() {
  // 1) 全局 npm 包路径（Windows 默认）
  try {
    const p = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.version) return String(j.version);
  } catch (e) { /* 继续试命令 */ }
  // 2) dsh --version（跨平台兜底）
  try {
    return String(execFileSync('dsh', ['--version'], {
      encoding: 'utf8', shell: true, timeout: 3000,
    })).trim();
  } catch (e) { return ''; }
}

async function serviceHealth(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1800);
    const r = await fetch(String(url).replace(/\/$/, '') + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, model: j && j.model ? j.model : '' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  }
}

(async () => {
  const pkg = readJson(path.join(ROOT, 'dsh-plugin', 'package.json'), {});
  const version = pkg.version || '0.4.2';

  // raw
  const rawDir = path.join(DATA, 'raw');
  const rawFiles = listFiles(rawDir, '.jsonl');
  let rawRecords = 0;
  for (const f of rawFiles) rawRecords += Math.max(0, countLines(path.join(rawDir, f)));

  // draft
  const draftPending = Math.max(0, countLines(path.join(DATA, 'draft', 'pending.jsonl')));

  // vectors
  const vmeta = readJson(path.join(DATA, 'index', 'vectors.meta.json'), {}) || {};

  // chains
  const linksDir = path.join(DATA, 'links');
  const linkFiles = listFiles(linksDir, '.json');
  let chainNodes = 0;
  const roots = new Set();
  for (const f of linkFiles) {
    const c = readJson(path.join(linksDir, f), null);
    if (!c) continue;
    chainNodes += Array.isArray(c.nodes) ? c.nodes.length : 0;
    roots.add(c.parent || '核星');
  }

  // topics
  const topics = readJson(path.join(DATA, 'common', 'topics.json'), { topics: [] }) || { topics: [] };
  const topicList = Array.isArray(topics.topics) ? topics.topics : [];

  // refine
  const refine = readJson(path.join(DATA, 'common', 'refine-state.json'), {}) || {};

  // manual
  const rulesPath = process.env.MEMORY_RULES || path.join(ROOT, 'docs', 'RULES.md');
  let manual = { found: fs.existsSync(rulesPath), total: 0, read: 0, completed: false };
  if (manual.found) {
    try {
      const { ManualReader } = require('../src/manual');
      const mr = new ManualReader(DATA, rulesPath);
      const st = mr.status();
      manual = { found: true, total: st.total, read: st.read.length, completed: st.completed };
    } catch (e) { /* 诊断失败不报错 */ }
  }

  // service
  const embedUrl = process.env.EMBED_URL || 'http://127.0.0.1:16891';
  const service = await serviceHealth(embedUrl);

  // 迁移问卷 / 相处方式（不含内容，只看模式和是否存在）
  let onboarding = { mode: null, modeLabel: '', voice: false };
  try {
    const { Onboarding } = require('../src/onboarding');
    const st = new Onboarding(DATA).status();
    onboarding = { mode: st.mode || null, modeLabel: st.modeLabel || '', voice: !!(st.voice && st.voice.exists) };
  } catch (e) { /* 诊断失败不报错 */ }

  const report = {
    version,
    dsh: dshVersion(),
    node: process.version,
    os: process.platform + ' ' + process.arch + ' ' + os.release(),
    dataDir: DATA,
    rules: manual,
    onboarding,
    raw: { files: rawFiles.length, records: rawRecords },
    draft: { pending: draftPending },
    vectors: {
      model: vmeta.model || '',
      dim: Number(vmeta.dim) || 0,
      records: Array.isArray(vmeta.items) ? vmeta.items.length : 0,
      builtAt: vmeta.builtAt || '',
    },
    chains: { files: linkFiles.length, nodes: chainNodes, parents: roots.size },
    topics: { total: topicList.length, open: topicList.filter((t) => t.status === 'open').length },
    refine: {
      runs: Number(refine.runs) || 0,
      llmPending: Array.isArray(refine.llmPending) ? refine.llmPending.length : 0,
      lastError: refine.lastError ? String(refine.lastError).slice(0, 180) : '',
      lastLlmError: refine.lastLlmError && refine.lastLlmError.message
        ? String(refine.lastLlmError.message).slice(0, 180) : '',
    },
    service: { url: embedUrl, ...service },
    note: '本报告不包含记忆原文、身份内容或链节点正文',
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (k, v) => console.log(k.padEnd(12, ' ') + v);
  console.log('=== 核星记忆诊断 ===');
  line('版本', 'v' + report.version);
  line('DSH', report.dsh ? 'v' + report.dsh : '未检测到');
  line('Node', report.node);
  line('系统', report.os);
  line('数据目录', report.dataDir);
  line('RULES', report.rules.found
    ? `${report.rules.total} 节 / 已读 ${report.rules.read} / ${report.rules.completed ? '已完成' : '未完成'}`
    : '未找到');
  line('迁移模式', report.onboarding.mode
    ? `${report.onboarding.modeLabel} / ${report.onboarding.voice ? '已有相处方式' : '无相处方式'}`
    : '未选');
  line('raw', `${report.raw.files} 个文件 / ${report.raw.records} 条`);
  line('draft', `${report.draft.pending} 条待提炼`);
  line('vectors', report.vectors.model
    ? `${report.vectors.model} / ${report.vectors.dim} 维 / ${report.vectors.records} 条 / ${report.vectors.builtAt || '未知时间'}`
    : '无索引');
  line('chains', `${report.chains.files} 条链 / ${report.chains.nodes} 节点 / ${report.chains.parents} 个父节点`);
  line('topics', `${report.topics.total} 个 / open ${report.topics.open}`);
  line('refine', `runs ${report.refine.runs} / pending ${report.refine.llmPending} / lastError ${report.refine.lastError || '无'}`);
  line('service', `${report.service.url} / ${report.service.ok ? 'ok' : '不可用'}${report.service.model ? ' / ' + report.service.model : ''}`);
  console.log('');
  console.log('（本报告不包含记忆原文、身份内容或链节点正文；贴 issue 前可自行检查路径）');
})();
