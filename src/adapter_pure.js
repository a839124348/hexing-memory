/**
 * adapter_pure.js — 插件适配层的纯函数
 *
 * 从 dsh-plugin/src/index.ts 抽出来，方便单测，不依赖 DSH 运行时。
 * 负责：
 * - 从消息数组里选“最后一条真话”（跳过 time/runtime/memory-common 注入）
 * - 剥系统注入、保留真话
 * - 从 RULES.md 文本里取常驻摘要 / 说明书目录
 * - 组装常识层（身份 + 摘要 + 目录 + 链网索引，≤4000 字符）
 * - 去重键
 */
const COMMON_MARK = '<!-- memory-system:common -->';
const COMMON_MAX = 4000;
const INJECTED_RE = /^(time-context|runtime-context|memory-common)$/i;

function isInjectedMessage(msg) {
  const kind = msg && msg.source && msg.source.kind;
  return !!(kind && INJECTED_RE.test(String(kind)));
}

/** 从消息 content 里只取文本块；tool_use/tool_result/图片跳过 */
function extractText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 剥系统注入；用户真话混在注入后面时只剥注入块 */
function stripNoise(text) {
  let t = String(text || '');
  const head = t.trim();

  if (/^Current runtime context\b/i.test(head)) return '';
  if (/^Time sampled while preparing\b/i.test(head)) return '';
  if (/^The user\b/i.test(head)) return '';

  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  t = t.replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, '');
  t = t.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '');
  t = t.replace(/<system-reminder>[\s\S]*$/i, '');

  return t.trim();
}

/**
 * 选最后一条“真话”。
 * 从尾部往前找 role=user；跳过注入；剥完长度为 0 的注入块继续往前。
 * @returns {{message: object, text: string}|null}
 */
function pickLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (isInjectedMessage(m)) continue;
    const cleaned = stripNoise(extractText(m));
    if (cleaned.length < 2) continue;
    return { message: m, text: cleaned };
  }
  return null;
}

/** 从 RULES.md 文本里取 RESIDENT 标记块；去掉块内自带的二级标题 */
function readResidentSpecFrom(text) {
  const m = /<!--\s*RESIDENT:BEGIN\s*-->([\s\S]*?)<!--\s*RESIDENT:END\s*-->/.exec(String(text || ''));
  if (!m || !m[1].trim()) return '';
  return m[1].trim().replace(/^##\s*常驻规范[^\n]*\n?/, '').trim();
}

/** 从 RULES.md 的二级标题生成目录，排除摘要/目录/总结 */
function readManualIndexFrom(text) {
  const heads = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const h = m[1].trim();
    if (/^常驻摘要|^常驻规范|^目录|^一句话总结/.test(h)) continue;
    heads.push('- ' + h);
  }
  return heads.slice(0, 20).join('\n');
}

/** 按行裁剪到预算内，保留完整行 */
function fitLines(text, budget) {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  let out = '';
  for (const line of text.split('\n')) {
    if (out.length + line.length + 1 > budget) break;
    out += line + '\n';
  }
  return (out.trimEnd() + (out ? '\n- …（索引已截断）' : '')).trim();
}

/**
 * 组装常识层：身份 + 常驻摘要 + 说明书索引 + 链网索引。
 * 动态内容（当前状态/最近会话/草稿/链正文）不进来。
 */
function composeCommonText({ profile, resident, manualIndex, chains, topics, onboarding, inheritance, maxChars = COMMON_MAX }) {
  const cleanProfile = String(profile || '')
    .replace(/##\s*记忆系统说明[\s\S]*$/m, '')
    .trim()
    .replace(/^#\s*身份\s*$/m, '## 身份');

  const head = [
    COMMON_MARK,
    '# 常识层（自动加载）',
    '',
    cleanProfile || '## 身份\n（未设置。不要主动追问；但用户如果告诉过你名字、或给你起了名字、或说明了关系，用 memory_identity 记下来，只填提到的字段）',
    '',
    '## 常驻规范',
    resident || '（RULES.md 的常驻摘要未找到；按“先查再答、原文不改、草稿/存档分开”执行）',
    ...(onboarding ? ['', String(onboarding).trim()] : []),
    ...(inheritance ? ['', String(inheritance).trim()] : []),
  ].join('\n');

  if (head.length >= maxChars) {
    return head.slice(0, maxChars);
  }

  const topicPart = topics ? '\n\n## 话题栈\n' + topics : '';
  const indexBudget = maxChars - head.length - 80;
  let body = '\n\n## 说明书索引\n' + (manualIndex || '- （RULES.md 未找到）')
    + topicPart
    + '\n\n## 链网索引\n' + (chains || '- （暂无链）')
    + '\n\n<!-- /memory-system:common -->';

  if (body.length > indexBudget) {
    const remaining = Math.max(0, indexBudget - topicPart.length);
    const chainBudget = Math.max(0, Math.floor(remaining * 0.4));
    const manualBudget = Math.max(0, remaining - chainBudget - 40);
    body = '\n\n## 说明书索引\n' + fitLines(manualIndex || '- （RULES.md 未找到）', manualBudget)
      + topicPart
      + '\n\n## 链网索引\n' + fitLines(chains || '- （暂无链）', chainBudget)
      + '\n\n<!-- /memory-system:common -->';
  }

  return head + body;
}

/** 去重键：kind + cid + 平台消息 ID/文本；插件再哈希成短键 */
function dedupeKey(kind, cid, identity) {
  return [String(kind || ''), String(cid || ''), String(identity || '')].join('\u0000');
}

module.exports = {
  COMMON_MARK,
  COMMON_MAX,
  isInjectedMessage,
  extractText,
  stripNoise,
  pickLastUserMessage,
  readResidentSpecFrom,
  readManualIndexFrom,
  fitLines,
  composeCommonText,
  dedupeKey,
};
