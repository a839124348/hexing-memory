/**
 * embed.js — 向量化（本地模型）
 *
 * 默认调本机 bge-small 服务（和星核同一套，免费、离线、不联网）。
 * 失败必须抛错、由上层决定降级——绝不返回伪向量（这是星核踩过的坑）：
 * 伪向量会让检索结果看起来正常，实际全是噪音，而且没人发现。
 */
const DEFAULT_URL = process.env.EMBED_URL || 'http://127.0.0.1:16891';
const MAX_CONCURRENT = Math.max(1, Number(process.env.EMBED_CONCURRENCY || 4));

// 进程内并发闸门：向量服务是单线程/小队列时，32 个请求一起打会有一部分被拒，
// 检索就会降级成关键词、结果条数变少。这里把并发压到服务吃得下的数量，
// 排队仍在引擎进程内完成，不依赖外部服务替我们排队。
let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    active--;
  }
}

async function embed(text, opt = {}) {
  await acquire();
  try {
    const url = (opt.url || DEFAULT_URL) + '/embed';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(opt.timeout || 5000),
    });
    if (!resp.ok) throw new Error('embed HTTP ' + resp.status);
    const data = await resp.json();
    const vec = data.vector || data.embedding;
    if (!Array.isArray(vec) || !vec.length) throw new Error('embed 返回空向量');
    return vec;
  } finally {
    release();
  }
}

async function health(opt = {}) {
  try {
    const resp = await fetch((opt.url || DEFAULT_URL) + '/health', { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return { ok: false, status: resp.status };
    const j = await resp.json();
    return { ok: true, model: j.model || 'unknown' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** 余弦相似度 */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

module.exports = { embed, health, cosine, DEFAULT_URL };
