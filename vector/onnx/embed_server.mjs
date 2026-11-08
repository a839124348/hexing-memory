/**
 * embed_server.mjs — 零 Python 向量服务（ONNX Runtime + tokenizers.js）
 *
 * 模型：bge-small-zh-v1.5（512 维，CLS pooling）
 * 依赖：onnxruntime-node + @huggingface/tokenizers
 *
 * 端点与 Python 版一致：
 *   POST /embed      { text } -> { vector }
 *   POST /similarity { query, candidates } -> { results }
 *   GET  /health     -> { status, model }
 *
 * 模型文件放本目录：model.onnx + model.onnx.data；分词器：tokenizer.json / tokenizer_config.json
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { Tokenizer } from '@huggingface/tokenizers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.BGE_ONNX_MODEL || path.join(HERE, 'model.onnx');
const TOKENIZER = path.join(HERE, 'tokenizer.json');
const TOKENIZER_CONFIG = path.join(HERE, 'tokenizer_config.json');
const MODEL_NAME = process.env.BGE_MODEL_NAME || 'bge-small-zh-v1.5';
const MAX_LEN = 512;

let session = null;
let tokenizer = null;

function log(msg) { console.log('[onnx-embed] ' + msg); }

async function init() {
  if (!fs.existsSync(MODEL)) throw new Error('模型不存在：' + MODEL);
  if (!fs.existsSync(TOKENIZER)) throw new Error('分词器不存在：' + TOKENIZER);
  tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(TOKENIZER, 'utf8')),
    JSON.parse(fs.readFileSync(TOKENIZER_CONFIG, 'utf8')),
  );
  log('加载 ONNX 模型：' + MODEL);
  session = await ort.InferenceSession.create(MODEL, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  log('模型加载完成；输入=' + session.inputNames.join(',') + ' 输出=' + session.outputNames.join(','));
}

/** 同一进程最多 4 个推理并发，避免 CPU 抢占把检索拖慢 */
let active = 0;
const queue = [];
function slot(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); } catch (e) { reject(e); } finally {
        active--;
        if (queue.length) queue.shift()();
      }
    };
    if (active < 4) run(); else queue.push(run);
  });
}

function normalize(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return t.slice(0, MAX_LEN);
}

async function embed(text) {
  return slot(async () => {
    const enc = tokenizer.encode(normalize(text));
    let ids = enc.ids.slice(0, MAX_LEN);
    let mask = enc.attention_mask.slice(0, MAX_LEN);
    if (!ids.length) { ids = [101, 102]; mask = [1, 1]; }
    const seq = ids.length;
    const inputIds = BigInt64Array.from(ids.map(BigInt));
    const attention = BigInt64Array.from(mask.map(BigInt));
    const types = new BigInt64Array(seq);
    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, seq]),
      attention_mask: new ort.Tensor('int64', attention, [1, seq]),
      token_type_ids: new ort.Tensor('int64', types, [1, seq]),
    };
    const out = await session.run(feeds);
    const t = out.last_hidden_state;
    const dim = t.dims[2];
    // bge-small-zh-v1.5 用 CLS pooling（不是 mean）
    let vec = Array.from(t.data.slice(0, dim));
    let norm = Math.sqrt(vec.reduce((a, x) => a + x * x, 0));
    if (!norm) norm = 1;
    return vec.map((x) => x / norm);
  });
}

function similarity(query, candidates) {
  const q = Array.isArray(query) ? query : [];
  const out = [];
  for (let i = 0; i < (candidates || []).length; i++) {
    const c = candidates[i];
    let dot = 0;
    const n = Math.min(q.length, c.length);
    for (let j = 0; j < n; j++) dot += q[j] * c[j];
    out.push({ index: i, score: dot });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

async function main() {
  await init();
  const port = Number(process.argv[2] || process.env.MEMORY_ONNX_PORT || 16893);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', model: MODEL_NAME });
      }
      if (req.method !== 'POST' || (url.pathname !== '/embed' && url.pathname !== '/similarity')) {
        return json(res, 404, { error: 'not found' });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2 * 1024 * 1024) throw new Error('body too large');
      }
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/embed') {
        const vector = await embed(body.text || '');
        return json(res, 200, { vector });
      }
      return json(res, 200, { results: similarity(body.query, body.candidates) });
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
  });
  server.listen(port, '127.0.0.1', () => log('监听 http://127.0.0.1:' + port));
}

main().catch((e) => {
  console.error('[onnx-embed] 启动失败：' + (e && e.stack || e));
  process.exit(1);
});
