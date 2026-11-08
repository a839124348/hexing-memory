"""
embed_server.py - 记忆系统随包语义向量微服务

bge-small-zh-v1.5 模型，512 维向量。
通过 HTTP 供 Node 插件调用；不依赖星核引擎。

端点：
  POST /embed      { text: "..." } -> { vector: [0.1, 0.2, ...] }
  POST /similarity { query: [...], candidates: [[...], ...] } -> { results: [{index, score}, ...] }
  GET  /health     -> { status: "ok", model: "..." }

环境变量：
  BGE_MODEL_PATH  本地模型目录（推荐，离线）
  BGE_MODEL_NAME  sentence-transformers 模型名（默认 BAAI/bge-small-zh-v1.5）
  HF_HUB_OFFLINE  1 时只读本地缓存
"""

import sys
import json
import os
import gc
import threading
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
# 2026-08-06 修复：多线程（之前单线程串行，大批量索引时检索与索引互相阻塞）
from http.server import ThreadingHTTPServer

# 2026-08-07 内存防护（工作会话反馈：Threading模式下encode中间张量堆积，18小时吃到30GB）
# ① 并发上限：最多4个并发encode，多余的排队
_encode_sem = threading.Semaphore(4)
# ② 每25个请求做一次gc，主动释放中间张量
_req_count = [0]
# ③ 2026-08-08 内存天花板自重启：gc收不回arena，涨到阈值就自我了断，由引擎重新拉起（泄漏变定期新生）
_MAX_RSS_GB = 1.5
_should_exit = [False]

def _check_mem_ceiling():
    try:
        import psutil
        rss_gb = psutil.Process().memory_info().rss / 1024 / 1024 / 1024
        if rss_gb > _MAX_RSS_GB:
            print(f'[embed] 内存{rss_gb:.1f}GB超阈值{_MAX_RSS_GB}GB，将在本次响应后退出等引擎重启', flush=True)
            _should_exit[0] = True
    except ImportError:
        pass

def _maybe_gc():
    _req_count[0] += 1
    if _req_count[0] % 25 == 0:
        gc.collect()
        _check_mem_ceiling()

# 延迟加载模型（首次请求时加载）
_model = None
_fallback_reason = None

def load_model():
    global _model, _fallback_reason
    if _model is not None:
        return
    try:
        import os
        # 默认离线：install.ps1 已经把模型拉好；需要现场下载时设 MEMORY_EMBED_ALLOW_DOWNLOAD=1
        if os.environ.get('MEMORY_EMBED_ALLOW_DOWNLOAD') != '1':
            os.environ.setdefault('HF_HUB_OFFLINE', '1')
            os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
        from sentence_transformers import SentenceTransformer
        model_ref = os.environ.get('BGE_MODEL_PATH') or os.environ.get('BGE_MODEL_NAME') or 'BAAI/bge-small-zh-v1.5'
        print(f'[embed] 加载模型 {model_ref} ...')
        _model = SentenceTransformer(model_ref)
        print(f'[embed] 模型加载完成，维度: {_model.get_embedding_dimension()}')
    except ImportError:
        print('[embed] sentence-transformers 未安装，标记降级（拒绝产伪向量）')
        _model = 'fallback'
        _fallback_reason = 'sentence-transformers 未安装'
    except Exception as e:
        print(f'[embed] 模型加载失败: {e}，标记降级（拒绝产伪向量）')
        _model = 'fallback'
        _fallback_reason = str(e)

def embed(text):
    """计算文本的语义向量"""
    load_model()
    # 2026-08-06 修复：降级时拒绝产出sha256伪向量（语义搜索会静默全错），抛错让上层走设计好的降级
    if _model == 'fallback':
        raise RuntimeError(f'模型不可用（降级模式）: {_fallback_reason}')
    # 清理 Windows 换行符 \r\n -> \n，避免 bge 模型报 TextEncodeInput 错误
    if isinstance(text, str):
        text = text.replace('\r\n', '\n').replace('\r', '\n')

    # bge-small-zh: 截取前 512 字符（避免长文本稀释语义）
    # 向量应该基于"这段内容讲什么"的摘要，不是全文
    if not isinstance(text, str):
        raise ValueError('text 必须是字符串')
    text = text[:512] if len(text) > 512 else text
    # 2026-11-01：JS 按 UTF-16 截断可能留下半个 emoji（孤立代理项），BGE 分词器会直接 500。
    # 先合并合法代理对，孤立项替换为 U+FFFD，保证进入分词器的永远是合法字符串。
    text = text.encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')
    with _encode_sem:  # 2026-08-07 并发上限，防线程爆炸+张量堆积
        vec = _model.encode(text, normalize_embeddings=True)
    result = vec.tolist()
    del vec  # 显式释放
    _maybe_gc()
    return result

def similarity(query_vec, candidates):
    """余弦相似度排序"""
    query = np.array(query_vec, dtype=np.float32)
    results = []
    for i, cand in enumerate(candidates):
        c = np.array(cand, dtype=np.float32)
        # 向量已归一化，直接点积
        score = float(np.dot(query, c))
        results.append({'index': i, 'score': score})
    results.sort(key=lambda x: x['score'], reverse=True)
    return results

# 2026-08-08 剖析实证②：daemon_threads=True也压不住（0.6MB/请求照涨）——真凶是多线程下torch每线程的张量分配不回收
# 结论：回归单线程串行。embed单次30ms级，我们的负载串行完全够（唯一大户是索引构建，它排队没脾气）。
class EmbedHTTPServer(HTTPServer):
    pass

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            # 2026-08-06 修复：降级时返回503（vector.js checkEmbed看resp.ok），不再假装健康
            if _model == 'fallback':
                self._json(503, {'status': 'degraded', 'degraded': True, 'reason': _fallback_reason})
            else:
                self._json(200, {'status': 'ok', 'model': 'bge-small-zh-v1.5'})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            if self.path == '/embed':
                vec = embed(body.get('text', ''))
                self._json(200, {'vector': vec})
            elif self.path == '/similarity':
                results = similarity(body.get('query', []), body.get('candidates', []))
                self._json(200, {'results': results})
            else:
                self._json(404, {'error': 'not found'})
        except Exception as e:
            self._json(500, {'error': str(e)})
        finally:
            # 2026-08-08 内存天花板：响应发完再退（不在请求中间断连）
            if _should_exit[0]:
                threading.Timer(0.5, lambda: os._exit(0)).start()

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f'[embed] {args[0]}')

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 16891
    print(f'[embed] 向量微服务启动，端口 {port}')
    print(f'[embed] Python: {sys.executable}')
    # 预加载模型
    print('[embed] 预加载模型...')
    load_model()
    server = EmbedHTTPServer(('127.0.0.1', port), Handler)
    server.serve_forever()
