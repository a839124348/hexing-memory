/**
 * import-jsonl.js — 迁移导入器（一次性，把旧平台的 JSONL 原文追加进存档）
 *
 * 只做三件事：读文件 → 校验 → 调 Store.append（真追加 + 锁 + 去重）。
 * 默认 dry-run，不写任何东西；加 --apply 才写入。
 *
 * 用法：
 *   node tools/import-jsonl.js --file old.jsonl              # 预检
 *   node tools/import-jsonl.js --file old.jsonl --apply      # 写入
 *   node tools/import-jsonl.js --file old.jsonl --data <你的数据目录> --apply
 *   node tools/import-jsonl.js --file old.jsonl --strict-similar   # 连近似重复也拦
 *   node tools/import-jsonl.js --file old.jsonl --strict-duplicates # 完全重复也拦
 *
 * 默认不做近似判重：历史里“我今天很开心”/“我今天很开心啊”这种重复发言很正常，
 * 开了会把整批历史打回。精确重复仍按 cid+t+s+mid+c 去重。
 * 同一分钟同文、又没有 mid 的完全重复，默认自动补一个合成 mid 保留两条；
 * 要拒绝导出事故，加 --strict-duplicates。
 *
 * 说明：
 * - 格式契约：t/s/c/cid/v 必填；mid/src/type/origin/id 可选（见 docs/RULES.md 第二节）。
 * - 一条 = 一次发言；不要提前总结、合并、改写。
 * - 任何一条校验失败，整批拒绝，不会写一半。
 * - 已存在的记录按 cid+t+s+mid+c 去重，重复导入不会翻倍。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { validateRecords, contentHash } = require('../src/validate');
const { Onboarding } = require('../src/onboarding');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

function usage() {
  console.log('用法：node tools/import-jsonl.js --file <old.jsonl> [--data <dsh-memory>] [--apply] [--strict-similar]');
  console.log('默认 dry-run；确认无误后加 --apply 才会写入。默认不拦近似重复（历史重复发言正常）。');
}

function main() {
  const file = arg('file');
  if (!file || file === 'true') { usage(); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('文件不存在：' + file); process.exit(1); }

  const dataDir = arg('data') || process.env.MEMORY_ROOT
    || path.join(process.env.APPDATA || process.env.HOME || '.', 'dsh-memory');
  const apply = process.argv.includes('--apply');
  const strictSimilar = process.argv.includes('--strict-similar');
  const strictDuplicates = process.argv.includes('--strict-duplicates');

  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const records = [];
  const parseErrors = [];
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const o = JSON.parse(s);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('不是对象');
      records.push(o);
    } catch (e) {
      parseErrors.push('第 ' + (i + 1) + ' 行：' + e.message);
    }
  });

  if (parseErrors.length) {
    console.error('JSON 解析失败 ' + parseErrors.length + ' 行，整批不导入：');
    parseErrors.slice(0, 20).forEach((x) => console.error('  - ' + x));
    process.exit(1);
  }
  if (!records.length) {
    console.error('文件里没有有效记录：' + file);
    process.exit(1);
  }

  // 同一分钟同文、又没有 mid 的完全重复：默认补合成 mid 保留两条；
  // --strict-duplicates 则原样交给校验器拒绝。
  let synthesized = 0;
  if (!strictDuplicates) {
    const seen = new Set();
    for (const r of records) {
      const key = [r.cid || '', r.t || '', r.s || '', r.mid || '', r.c || ''].join('\u0000');
      if (!seen.has(key)) { seen.add(key); continue; }
      r.mid = (r.mid ? String(r.mid) + '-dup-' : 'import-dup-') + (++synthesized);
    }
  } else {
    const seen = new Set();
    for (const r of records) {
      const key = [r.cid || '', r.t || '', r.s || '', r.mid || '', r.c || ''].join('\u0000');
      if (seen.has(key)) { synthesized = -1; break; }
      seen.add(key);
    }
  }

  const v = validateRecords(records, { allowWarnings: true, checkSimilar: strictSimilar });
  const days = [...new Set(records.map((r) => String(r.t || '').slice(0, 10)))].sort();
  const speakers = [...new Set(records.map((r) => String(r.s || '')))];
  console.log('文件：' + file);
  console.log('数据目录：' + dataDir);
  console.log('记录：' + records.length + ' 条；' + days.length + ' 天（' + days[0] + ' ~ ' + days[days.length - 1] + '）；说话人 ' + speakers.length + ' 个');
  let onboardHint = null;
  try { onboardHint = new Onboarding(dataDir).importerHint(); } catch (e) { /* 问卷模块读不到不阻塞导入 */ }
  if (onboardHint) {
    console.log('迁移模式：' + (onboardHint.mode || '未设置') + ' — ' + onboardHint.message);
    if (onboardHint.level === 'error' && apply) {
      console.error('');
      console.error('已拒绝写入：当前是「全新开始」模式。要导入旧数据，先用 memory_onboarding 改成 memory 或 inherit。');
      process.exit(1);
    }
  }
  if (synthesized > 0) console.log('完全重复：' + synthesized + ' 条，已补合成 mid 保留（要拒绝请加 --strict-duplicates）');
  console.log('警告：' + v.warnings.length + ' 条' + (v.warnings.length ? '（跨会话同文/时间顺序等，不阻断）' : ''));
  if (v.warnings.length) v.warnings.slice(0, 10).forEach((w) => console.log('  - ' + w));

  if (!v.ok) {
    console.error('');
    console.error('校验失败 ' + v.errors.length + ' 条，整批不导入：');
    v.errors.slice(0, 30).forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }

  if (!apply) {
    console.log('');
    console.log('✅ 预检通过（dry-run，未写入）。确认无误后加 --apply 写入。');
    return;
  }

  const store = new Store(dataDir);

  // 先滤掉库里已有的（同 cid+t+s+mid+c），避免整批被 Store.append 的重复检查拒绝
  const existing = new Set();
  for (const day of days) {
    for (const rec of store.readDay(day)) {
      try { existing.add(contentHash(rec)); } catch (e) { /* 坏行跳过 */ }
    }
  }
  const fresh = records.filter((r) => !existing.has(contentHash(r)));
  const skipped = records.length - fresh.length;

  if (!fresh.length) {
    console.log('');
    console.log('✅ 全部 ' + records.length + ' 条都已在库里（跳过），没有新增。');
    return;
  }
  console.log('库里已存在：' + skipped + ' 条，本次将新增：' + fresh.length + ' 条');

  const r = store.append(fresh, { allowWarnings: true, checkSimilar: strictSimilar });
  console.log('');
  if (!r.ok) {
    console.error('写入失败：' + JSON.stringify(r.errors || []).slice(0, 500));
    process.exit(1);
  }
  console.log('✅ 写入完成：新增 ' + r.added + ' 条，跳过重复 ' + (skipped + (r.skipped || 0)) + ' 条');

  try {
    const st = store.stats();
    console.log('当前存档：' + st.records + ' 条');
  } catch (e) { /* 统计失败不影响导入结果 */ }

  const reportDir = path.join(dataDir, 'common');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportName = 'import-report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  const report = path.join(reportDir, reportName);
  const importedAt = new Date().toISOString();
  const reportBody = {
    file: path.resolve(file),
    dataDir,
    importedAt,
    total: records.length,
    added: r.added,
    skipped: skipped + (r.skipped || 0),
    synthesizedMid: Math.max(0, synthesized),
    days,
    speakers,
    warnings: v.warnings.length,
    errors: [],
    onboarding: onboardHint ? { mode: onboardHint.mode, level: onboardHint.level, message: onboardHint.message } : null,
  };
  fs.writeFileSync(report, JSON.stringify(reportBody, null, 1), 'utf8');

  // 给用户 AI 的机器可读结果：迁移流程的“补链网”这一环不是漏做，
  // 而是本阶段明确跳过；写清楚状态和原因，避免被当成失败。
  const resultPath = path.join(reportDir, 'offline-import-result.json');
  const resultBody = {
    ...reportBody,
    reportFile: reportName,
    chainBackfill: {
      status: 'skipped',
      reason: '旧历史只导入 raw + 向量；链网从迁移后的新对话生长，不批量建链。',
      note: '这不是失败；旧原文仍可被 memory_search 检索。一键回填计划在 v0.5。',
      plannedVersion: 'v0.5',
    },
    nextSteps: [
      '启动 DSH，等约 5 秒补索引',
      '用 memory_search 搜一条旧原话，确认可检索',
      '链网从新对话继续生长；不要用 memory_chain append 导入历史',
    ],
  };
  fs.writeFileSync(resultPath, JSON.stringify(resultBody, null, 1), 'utf8');
  console.log('报告：' + report);
  console.log('结果：' + resultPath);
  console.log('链网回填：未运行（旧历史不自动建链；从新对话生长；回填计划 v0.5）');
  console.log('');
  console.log('下一步：启动 DSH → 等 5 秒补索引 → memory_search 验证。');
  console.log('注意：旧历史不会自动建链；链网从新对话的提炼里积累。');
}

main();
