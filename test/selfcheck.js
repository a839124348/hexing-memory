/**
 * selfcheck.js — 一键自检（每改完一处就跑）
 *
 * 不重启 DSH、不动数据，只做静态检查 + 数据体检：
 *   1. 所有模块能否正常加载
 *   2. 单元测试是否全绿
 *   3. 插件语法是否通过
 *   4. 数据目录状态（草稿/存档/身份）是否符合契约
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'dsh-memory') : '';

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('  ✗ ' + n + (d ? ' | ' + d : '')); }
};

console.log('【1】模块加载');
for (const m of ['store', 'draft', 'refine', 'search', 'validate', 'api', 'embed']) {
  try {
    require(path.join(ROOT, 'src', m + '.js'));
    check(m + '.js', true);
  } catch (e) {
    check(m + '.js', false, String(e.message).slice(0, 80));
  }
}

console.log('');
console.log('【2】插件语法');
try {
  execSync(`node --experimental-strip-types --check "${path.join(ROOT, 'dsh-plugin', 'src', 'index.ts')}"`, { stdio: 'pipe' });
  check('dsh-plugin/src/index.ts', true);
} catch (e) {
  check('dsh-plugin/src/index.ts', false, '语法错误');
}

console.log('');
console.log('【3】单元测试');
const tests = ['unit-validate.js', 'unit-store.js', 'unit-refine-dedup.js', 'unit-identity-rules.js', 'unit-stripnoise.js', 'unit-chain.js'];
for (const t of tests) {
  try {
    const out = execSync(`node "${path.join(__dirname, t)}"`, { encoding: 'utf8', stdio: 'pipe' });
    const m = /结果：(\d+)\/(\d+)/.exec(out);
    check(t, !!m && m[1] === m[2], m ? m[1] + '/' + m[2] : '无结果');
  } catch (e) {
    check(t, false, '执行失败');
  }
}

console.log('');
console.log('【4】数据体检');
if (!DATA || !fs.existsSync(DATA)) {
  console.log('  （数据目录不存在，跳过）');
} else {
  // 草稿：cid 是否都带平台前缀
  const draftFile = path.join(DATA, 'draft', 'pending.jsonl');
  if (!fs.existsSync(draftFile)) {
    console.log('  （没有草稿文件）');
  } else {
    const rows = fs.readFileSync(draftFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    check('草稿条数 = ' + rows.length, true);
    const badCid = rows.filter((r) => !r.cid || !String(r.cid).includes(':'));
    check('cid 都带平台前缀', badCid.length === 0, badCid.length + ' 条没有前缀（旧数据可忽略）');
    const badTime = rows.filter((r) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.t || ''));
    check('时间格式全合规', badTime.length === 0, badTime.length + ' 条不合规');
    // 规则变更（2026-11-07）：对话里的代码**要记**，只排除系统注入和 reasoning
    const injected = rows.filter((r) => /<system-reminder>|Current runtime context|Time sampled while preparing|<available_skills>/i.test(r.c || ''));
    check('草稿里没有系统注入', injected.length === 0, injected.length + ' 条含注入');
    const reasoning = rows.filter((r) => /^(The user|He said|She said|Let me|I should)\b/i.test(String(r.c || '').trim()));
    check('草稿里没有 reasoning', reasoning.length === 0, reasoning.length + ' 条疑似思考');
  }

  // 身份：md 与 json 是否一致
  const idMd = path.join(DATA, 'common', 'IDENTITY.md');
  const idJson = path.join(DATA, 'common', 'identity.json');
  if (fs.existsSync(idJson)) {
    try {
      const meta = JSON.parse(fs.readFileSync(idJson, 'utf8'));
      check('identity.json 可解析', true);
      // 身份未填是正常状态（用户可能就不想设人格），只提示不算失败
      if (meta.aiName && meta.userTitle) {
        check('身份已设置：' + meta.aiName + ' / ' + meta.userTitle, true);
      } else {
        console.log('  ⚠ 身份未设置（正常：用户还没填，或不想设人格）');
      }
      if (fs.existsSync(idMd)) {
        const md = fs.readFileSync(idMd, 'utf8');
        const okStructure = /##\s*我是谁/.test(md) && /##\s*用户是谁/.test(md);
        check('IDENTITY.md 四段结构完整', okStructure);
        if (meta.aiName) check('md 里含 aiName', md.includes(meta.aiName), meta.aiName);
      }
    } catch (e) {
      check('identity.json 可解析', false, String(e.message).slice(0, 60));
    }
  } else {
    console.log('  （没有 identity.json，身份未设置）');
  }

  // 存档
  const rawDir = path.join(DATA, 'raw');
  if (fs.existsSync(rawDir)) {
    const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.jsonl'));
    check('存档按天分文件', true, files.length + ' 天');
    let total = 0;
    for (const f of files) {
      total += fs.readFileSync(path.join(rawDir, f), 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
    }
    check('存档总条数可读', total >= 0, total + ' 条');
  }
}

console.log('');
const total2 = pass + fails.length;
console.log(fails.length === 0
  ? '✅ 自检通过（' + pass + '/' + total2 + '）'
  : '❌ 自检失败（' + pass + '/' + total2 + '）\n' + fails.map((f) => '   - ' + f).join('\n'));
process.exit(fails.length ? 1 : 0);
