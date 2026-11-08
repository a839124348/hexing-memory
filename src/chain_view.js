/**
 * chain_view.js — 链头状态 + 大链取节点（纯函数）
 *
 * 用户 2026-11-08 定：
 * - 链头后置生成：读链时发现节点 ≥5 且没 header，提示模型顺手写。
 * - 大链不只前 3 后 3：默认再抽中间几个；需要精确取用 offset/limit，全文用 full。
 */
const HEADER_THRESHOLD = 5;
const REFRESH_DELTA = 5;
const SMALL_CHAIN = 12;
const MAX_MIDDLE = 6;

function headerState(chain) {
  const nodes = Array.isArray(chain && chain.nodes) ? chain.nodes : [];
  const nodeCount = nodes.length;
  const header = String((chain && chain.header) || '');
  const headerNodeCount = Number((chain && chain.headerNodeCount) || 0);
  const headerBy = String((chain && chain.headerBy) || '');
  return {
    nodeCount,
    header,
    headerNodeCount,
    headerAt: (chain && chain.headerAt) || '',
    headerBy,
    needHeader: nodeCount >= HEADER_THRESHOLD && !header,
    needRefresh: !!header && headerBy !== 'manual' && (nodeCount - headerNodeCount) >= REFRESH_DELTA,
    canAutoRefresh: headerBy !== 'manual',
  };
}

/**
 * 从链节点里选要返回的部分。
 * @param {Array} nodes
 * @param {object} opt { full, offset, limit }
 */
function selectChainNodes(nodes, opt = {}) {
  const all = Array.isArray(nodes) ? nodes : [];
  const n = all.length;

  if (opt.full) return { nodes: all.slice(), digest: false, indices: all.map((_, i) => i) };

  if (opt.offset !== undefined && opt.offset !== null) {
    const start = Math.max(0, Math.min(n, Number(opt.offset) || 0));
    const limit = opt.limit === undefined || opt.limit === null
      ? 10 : Math.max(1, Math.min(50, Number(opt.limit) || 10));
    const slice = all.slice(start, start + limit);
    return { nodes: slice, digest: false, indices: slice.map((_, i) => start + i) };
  }

  if (n <= SMALL_CHAIN) return { nodes: all.slice(), digest: false, indices: all.map((_, i) => i) };

  const idx = new Set([0, 1, 2, n - 3, n - 2, n - 1]);
  const step = Math.max(1, Math.ceil(n / (MAX_MIDDLE + 1)));
  for (let i = 3; i < n - 3; i += step) {
    idx.add(i);
    if (idx.size >= SMALL_CHAIN) break;
  }
  const indices = [...idx].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  return {
    nodes: indices.map((i) => all[i]),
    digest: true,
    indices,
    omitted: n - indices.length,
  };
}

module.exports = { HEADER_THRESHOLD, REFRESH_DELTA, SMALL_CHAIN, headerState, selectChainNodes };
