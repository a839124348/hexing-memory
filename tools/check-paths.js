/**
 * check-paths.js — 下载后/换机器后的路径自检（只读，不改文件）
 *
 * 用法：
 *   node tools/check-paths.js
 *   node tools/check-paths.js --json
 *   node tools/check-paths.js --profile "C:\Users\你\.dsh\profiles\web\cordis.patch.yml"
 *
 * 检查：仓库结构、说明书、数据目录、向量模型、DSH profile 里的插件入口路径、环境变量。
 * 典型问题：profile 里还写着作者机器的 D:/...，换一台电脑就找不到模块。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const ROOT = path.resolve(__dirname, '..');
const DATA = arg('data') || process.env.MEMORY_ROOT
  || path.join(process.env.APPDATA || process.env.HOME || '.', 'dsh-memory');
const PROFILE = arg('profile') || path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
const JSON_OUT = process.argv.includes('--json');

const checks = [];
function add(name, ok, detail, hint) {
  checks.push({ name, ok, detail: detail || '', hint: hint || '' });
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// 1. 仓库结构
add('插件入口', exists('dsh-plugin/src/index.ts'), path.join(ROOT, 'dsh-plugin', 'src', 'index.ts'));
add('核心引擎', exists('src/store.js'), path.join(ROOT, 'src', 'store.js'),
  '保持 dsh-plugin/ 与 src/ 在同一仓库；或设置 MEMORY_CORE');
add('说明书', exists('docs/RULES.md'), path.join(ROOT, 'docs', 'RULES.md'),
  '设置 MEMORY_RULES 指向 RULES.md');
add('插件 package.json', exists('dsh-plugin/package.json'));

// 2. 版本
let pluginVersion = '';
try { pluginVersion = require(path.join(ROOT, 'dsh-plugin', 'package.json')).version || ''; } catch (e) { /* ignore */ }
add('插件版本', !!pluginVersion, pluginVersion || '读不到');

// 3. 数据目录可写（不存在也算通过启动时会创建，但提示）
let dataOk = false;
let dataDetail = DATA;
try {
  if (fs.existsSync(DATA)) { fs.accessSync(DATA, fs.constants.W_OK); dataOk = true; }
  else { dataOk = true; dataDetail = DATA + '（不存在，首次启动会创建）'; }
} catch (e) { dataDetail = DATA + '（不可写：' + e.message + '）'; }
add('数据目录可写', dataOk, dataDetail);

// 4. 向量模型
const onnx = path.join(ROOT, 'vector', 'onnx');
const onnxModel = fs.existsSync(path.join(onnx, 'model.onnx'));
const onnxData = fs.existsSync(path.join(onnx, 'bge-small-zh-v1.5.onnx.data'));
const onnxReady = fs.existsSync(path.join(onnx, '.ready'));
const onnxDeps = fs.existsSync(path.join(onnx, 'node_modules', 'onnxruntime-node'));
const pyReady = fs.existsSync(path.join(ROOT, 'vector', '.ready'));
add('向量服务', (onnxModel && onnxData && onnxReady && onnxDeps) || pyReady,
  onnxModel ? `ONNX model=${onnxModel} data=${onnxData} ready=${onnxReady} deps=${onnxDeps}` : `Python ready=${pyReady}`,
  '跑 vector/onnx/install.ps1 或 vector/install.ps1；不装也能用，检索会降级关键词');

// 5. profile 里的插件入口
let profileDetail = PROFILE;
try {
  if (!fs.existsSync(PROFILE)) {
    profileDetail = PROFILE + '（不存在；可能用 --patch 单次挂载）';
    add('DSH profile', true, profileDetail);
  } else {
    const yml = fs.readFileSync(PROFILE, 'utf8');
    if (!yml.includes('memory-system')) {
      add('DSH profile', true, PROFILE + '（没有 memory-system，插件未装进 profile）');
    } else {
      const m = /name:\s*['"]?([^'"\n]+)['"]?/.exec(yml.slice(Math.max(0, yml.indexOf('memory-system') - 200)));
      const entry = m ? m[1].trim() : '';
      const abs = entry ? path.isAbsolute(entry) : false;
      const ok = abs && fs.existsSync(entry);
      add('profile 插件路径', ok, entry || '没解析到 name',
        ok ? '' : '路径不是本机绝对路径或文件不存在：先跑 node tools/make-patch.js --print，把 name 换成当前仓库的 dsh-plugin/src/index.ts');
      if (ok) {
        const here = path.resolve(ROOT, 'dsh-plugin', 'src', 'index.ts');
        const same = path.resolve(entry) === here;
        add('profile 指向当前仓库', same, same ? '' : 'profile 指向 ' + entry + '，当前仓库是 ' + here,
          same ? '' : '如果这是另一份副本，请对当前仓库重新生成 patch；不要同时跑两份');
      }
    }
  }
} catch (e) {
  add('DSH profile', false, PROFILE + '（读取失败：' + e.message + '）');
}

// 6. 环境变量
for (const k of ['MEMORY_ROOT', 'MEMORY_CORE', 'MEMORY_RULES']) {
  const v = process.env[k];
  if (!v) continue;
  add('环境变量 ' + k, fs.existsSync(v), v, '路径不存在；改回正确路径或删除这个变量');
}

// 7. Node / DSH
add('Node', !!process.version, process.version);
try {
  const dsh = String(execSync('dsh --version', { encoding: 'utf8', timeout: 3000 })).trim();
  add('DSH', true, dsh);
} catch (e) {
  add('DSH', false, '未检测到 dsh 命令（不影响路径检查）');
}

const failed = checks.filter((c) => !c.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, data: DATA, profile: PROFILE, checks, failed: failed.length }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

console.log('=== 核星记忆 · 路径自检 ===');
console.log('仓库：' + ROOT);
console.log('数据：' + DATA);
console.log('profile：' + PROFILE);
console.log('');
for (const c of checks) {
  console.log((c.ok ? '✓ ' : '✗ ') + c.name + (c.detail ? '：' + c.detail : ''));
  if (!c.ok && c.hint) console.log('    → ' + c.hint);
}
console.log('');
if (failed.length) {
  console.log('✗ 有 ' + failed.length + ' 项没通过；先按上面的提示修路径，再启动 DSH。');
  console.log('提示：node tools/make-patch.js --print 可以打印当前机器该用的插件绝对路径。');
  process.exit(1);
}
console.log('✅ 路径自检通过。');
