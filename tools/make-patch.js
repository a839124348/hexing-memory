/**
 * make-patch.js — 生成当前机器可用的 DSH patch 配置
 *
 * 为什么需要：DSH 的 insert.name 必须是本机绝对路径；每个人的下载目录不同，
 * 仓库里不能写死 D:\... 或 /home/...。这个脚本按当前仓库位置生成 cordis.local.yml。
 *
 * 默认只生成插件本体（memory-system）。左侧栏入口要等迁移/初始化完成后再装；
 * 已经完成 onboarding、需要一次挂两段的，加 --all。
 *
 * 用法：
 *   node tools/make-patch.js            # 生成 dsh-plugin/cordis.local.yml（只含本体）
 *   node tools/make-patch.js --all      # 两段都生成（迁移完成后）
 *   node tools/make-patch.js --print    # 只打印，不写文件
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const entry = path.join(ROOT, 'dsh-plugin', 'src', 'index.ts').replace(/\\/g, '/');
const entryUi = path.join(ROOT, 'dsh-plugin-ui', 'lib', 'index.js').replace(/\\/g, '/');
const out = path.join(ROOT, 'dsh-plugin', 'cordis.local.yml');

const withUi = process.argv.includes('--all');
const lines = [
  '# 本文件由 tools/make-patch.js 生成；路径是本机绝对路径，已 gitignore。',
  '# 用法：dsh --profile web --patch ./dsh-plugin/cordis.local.yml',
  '- insert:',
  '    - id: memory-system',
  "      name: '" + entry + "'",
];
if (withUi) {
  lines.push('    - id: memory-system-ui');
  lines.push("      name: '" + entryUi + "'");
} else {
  lines.push('# 迁移/初始化完成后，再加下面这段（或直接跑 install.ps1 -Phase ui -Apply）：');
  lines.push('#    - id: memory-system-ui');
  lines.push("#      name: '" + entryUi + "'");
}
lines.push('');
const yaml = lines.join('\n');

if (process.argv.includes('--print')) {
  process.stdout.write(yaml);
} else {
  fs.writeFileSync(out, yaml, 'utf8');
  console.log('已生成：' + out);
  console.log('插件入口：' + entry);
  console.log(withUi ? ('侧边栏入口：' + entryUi) : ('侧边栏入口（迁移后再加）：' + entryUi));
  console.log('');
  console.log('启动：dsh --profile web --patch ./dsh-plugin/cordis.local.yml');
}
