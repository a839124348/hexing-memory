/**
 * service.js — 向量服务生命周期（插件托管）
 *
 * 目标（v0.4）：
 * - 服务已经是健康的 → 直接复用，不重复拉起，也不在退出时杀别人的服务。
 * - 服务没起来，且配置了 MEMORY_EMBED_CMD → 由插件拉起，崩溃自动重启。
 * - 没配置命令、也起不来 → 不阻塞主流程，检索降级关键词并标 degraded。
 * - 插件退出 → 只停自己拉起的子进程。
 *
 * 测试通过注入 healthCheck / spawnChild / sleep，不依赖真实端口。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { health } = require('./embed');

/** 随包服务：只有 install.ps1 写过 .ready 才自动拉起，避免无运行时环境时反复重启 */
function bundledOnnxCommand(url) {
  const dir = path.join(__dirname, '..', 'vector', 'onnx');
  const script = path.join(dir, 'embed_server.mjs');
  const ready = path.join(dir, '.ready');
  if (!fs.existsSync(script) || !fs.existsSync(ready)) return '';
  if (!fs.existsSync(path.join(dir, 'model.onnx'))) return '';
  if (!fs.existsSync(path.join(dir, 'node_modules', 'onnxruntime-node'))) return '';
  let port = 16891;
  try { port = Number(new URL(url).port) || 16891; } catch (e) { /* ignore */ }
  return `"${process.execPath}" "${script}" ${port}`;
}

function bundledEmbedCommand(url) {
  // 零 Python 的 ONNX 版优先；没装再退回 Python 随包服务
  const onnx = bundledOnnxCommand(url);
  if (onnx) return onnx;
  const script = path.join(__dirname, '..', 'vector', 'embed_server.py');
  const ready = path.join(__dirname, '..', 'vector', '.ready');
  if (!fs.existsSync(script) || !fs.existsSync(ready)) return '';
  let port = 16891;
  try { port = Number(new URL(url).port) || 16891; } catch (e) { /* ignore */ }
  const py = process.env.PYTHON || 'python';
  return `"${py}" "${script}" ${port}`;
}

function createEmbedService(opt = {}) {
  const url = opt.url || process.env.EMBED_URL || 'http://127.0.0.1:16891';
  const explicit = process.env.MEMORY_EMBED_CMD;
  // 显式传入 cmd（包括空串）优先：单测/调用方可以用 cmd:'' 明确关闭随包拉起
  const cmd = Object.prototype.hasOwnProperty.call(opt, 'cmd')
    ? String(opt.cmd || '')
    : (explicit !== undefined ? explicit : bundledEmbedCommand(url));
  const healthCheck = opt.healthCheck || (() => health({ url }));
  const sleep = opt.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opt.log || (() => {});
  const pollMs = Number(opt.pollMs || 500);
  const attempts = Number(opt.attempts || 60);
  const baseDelay = Number(opt.restartDelayMs || 1000);
  const maxDelay = Number(opt.maxRestartDelayMs || 30000);

  let child = null;
  let owned = false;
  let stopped = false;
  let restartTimer = null;
  let restartDelay = baseDelay;
  let monitorTimer = null;
  let lastHealthy = false;

  const spawnChild = opt.spawnChild || ((command) => spawn(command, {
    shell: true,
    cwd: opt.cwd || process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, EMBED_URL: url },
  }));

  function clearRestart() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  async function checkHealthOnce() {
    try {
      const h = await healthCheck();
      return !!(h && h.ok);
    } catch (e) {
      return false;
    }
  }

  /** 探活：外部复用的服务死了不会自动拉起，但至少要如实报状态 */
  function startMonitor() {
    if (monitorTimer || stopped) return;
    monitorTimer = setInterval(async () => {
      const ok = await checkHealthOnce();
      if (ok !== lastHealthy) {
        lastHealthy = ok;
        log(ok
          ? '[memory-system] 向量服务恢复（复用）'
          : '[memory-system] 向量服务不可用，检索降级关键词');
        // 外部服务挂了：如果配置了随包服务/命令，尝试接管拉起（P2 watchdog）
        if (!ok && !owned && !child && cmd && !stopped) {
          log('[memory-system] 尝试拉起随包/配置的向量服务');
          startChild();
        }
      }
    }, 30 * 1000);
    if (monitorTimer.unref) monitorTimer.unref();
  }

  function startChild() {
    if (child || stopped) return;
    try {
      child = spawnChild(cmd);
      owned = true;
      child.once('error', (e) => {
        child = null;
        if (stopped) return;
        log('[memory-system] 向量服务进程错误：' + (e && e.message));
        scheduleRestart();
      });
      child.once('exit', (code, signal) => {
        child = null;
        if (stopped) return;
        log('[memory-system] 向量服务退出（' + (code === null ? signal : code) + '），准备重启');
        scheduleRestart();
      });
      log('[memory-system] 向量服务已拉起（pid ' + (child.pid || '?') + '）');
    } catch (e) {
      owned = false;
      log('[memory-system] 向量服务拉起失败：' + (e && e.message));
      scheduleRestart();
    }
  }

  function scheduleRestart() {
    if (stopped) return;
    clearRestart();
    const delay = restartDelay;
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped) return;
      try {
        const h = await healthCheck();
        if (h && h.ok) { owned = false; return; }
      } catch (e) { /* 健康检查失败，继续拉起 */ }
      startChild();
      restartDelay = Math.min(restartDelay * 2, maxDelay);
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  async function start() {
    if (stopped) return { ok: false, reason: 'stopped' };

    // 启动瞬间可能赶上服务/系统忙，健康检查给一次重试，避免误报 no-cmd
    let healthy = await checkHealthOnce();
    if (!healthy) {
      await sleep(1000);
      healthy = await checkHealthOnce();
    }

    if (healthy) {
      owned = false;
      lastHealthy = true;
      log('[memory-system] 向量服务已在运行（复用，不接管）');
      startMonitor();
      return { ok: true, owned: false };
    }

    if (!cmd) {
      lastHealthy = false;
      log('[memory-system] 向量服务不可用，且未配置 MEMORY_EMBED_CMD；检索将降级关键词');
      startMonitor();
      return { ok: false, reason: 'no-cmd' };
    }

    startChild();
    for (let i = 0; i < attempts; i++) {
      await sleep(pollMs);
      if (await checkHealthOnce()) {
        restartDelay = baseDelay;
        lastHealthy = true;
        startMonitor();
        return { ok: true, owned: true };
      }
    }
    lastHealthy = false;
    log('[memory-system] 向量服务启动超时；检索将降级关键词');
    startMonitor();
    return { ok: false, reason: 'timeout' };
  }

  async function stop() {
    stopped = true;
    clearRestart();
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (child && owned) {
      try { child.kill(); } catch (e) { /* ignore */ }
      child = null;
    }
  }

  function status() {
    return { url, owned, child: !!child, stopped };
  }

  return { start, stop, status };
}

module.exports = { createEmbedService };
