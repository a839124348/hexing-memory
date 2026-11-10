/**
 * public-projects.js — 群聊公开项目白名单
 *
 * 群模式只能介绍 owner 在 common/public-projects.json 里显式标 public 的项目。
 * 默认拒绝：文件不存在、空、public !== true 都不进群上下文。
 * 只读 name/summary/links，不读链、不读私聊记忆。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX = 20;
const MAX_SUMMARY = 500;

function safeLinks(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x || '').trim())
    .filter((x) => /^https?:\/\//i.test(x))
    .slice(0, 5);
}

function loadPublicProjects(memoryRoot) {
  if (!memoryRoot) return [];
  const file = path.join(memoryRoot, 'common', 'public-projects.json');
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.projects) ? raw.projects : []);
  const out = [];
  for (const p of list) {
    if (!p || p.public !== true) continue;
    const name = String(p.name || '').trim();
    if (!name) continue;
    out.push({
      name: name.slice(0, 80),
      summary: String(p.summary || '').trim().slice(0, MAX_SUMMARY),
      links: safeLinks(p.links),
    });
    if (out.length >= MAX) break;
  }
  return out;
}

function formatPublicProjects(list) {
  if (!Array.isArray(list) || !list.length) {
    return '[公开项目]\n（无；不要介绍任何项目）';
  }
  const lines = list.map((p) => {
    const link = p.links && p.links.length ? ' | ' + p.links.join(' ') : '';
    return `- ${p.name}：${p.summary || '（无摘要）'}${link}`;
  });
  return '[公开项目]\n' + lines.join('\n') + '\n（只可介绍以上公开项目；其他项目一律不介绍）';
}

module.exports = { loadPublicProjects, formatPublicProjects };
