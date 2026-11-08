/**
 * make-patch.js — 生成当前机器可用的 DSH patch 配置
 *
 * 为什么需要：DSH 的 insert.name 必须是本机绝对路径；每个人的下载目录不同，
 * 仓库里不能写死 D:\... 或 /home/...。这个脚本按当前仓库位置生成 cordis.local.yml。
 *
 * 用法：
 *   node tools/make-patch.js            # 生成 dsh-plugin/cordis.local.yml
 *   node tools/make-patch.js --print    # 只打印，不写文件
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const entry = path.join(ROOT, 'dsh-plugin', 'src', 'index.ts').replace(/\\/g, '/');
const out = path.join(ROOT, 'dsh-plugin', 'cordis.local.yml');

const yaml = [
  '# 本文件由 tools/make-patch.js 生成；路径是本机绝对路径，已 gitignore。',
  '# 用法：dsh --profile web --patch ./dsh-plugin/cordis.local.yml',
  '- insert:',
  '    - id: memory-system',
  "      name: '" + entry + "'",
  '',
].join('\n');

if (process.argv.includes('--print')) {
  process.stdout.write(yaml);
} else {
  fs.writeFileSync(out, yaml, 'utf8');
  console.log('已生成：' + out);
  console.log('插件入口：' + entry);
  console.log('');
  console.log('启动：dsh --profile web --patch ./dsh-plugin/cordis.local.yml');
}
