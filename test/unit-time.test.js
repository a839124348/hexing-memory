const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { localMinute, localMonth } = require('../src/time');
const { ChainStore } = require('../src/chain');
const { monthOf } = require('../src/topics');
const { parseRefineResponse } = require('../src/llm');

test('localMinute 用本地字段，不是 UTC 截断', () => {
  const d = new Date(2026, 10, 1, 0, 5);
  assert.strictEqual(localMinute(d.getTime()), '2026-11-01 00:05');
  assert.strictEqual(localMonth(d.getTime()), '2026-11');
});

test('chain.append 不传 t：本地时间 + tSource=local', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-time-'));
  const cs = new ChainStore(dir);
  cs.create('身份', '核星', '');
  cs.create('身份链', '身份', '');
  const r = cs.append('身份链', { text: '没有传时间' });
  assert.strictEqual(r.ok, true);
  const node = cs.get('身份链').nodes[0];
  assert.match(node.t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.strictEqual(node.tSource, 'local');
});

test('chain.append 传 t：保留显式时间 + tSource=explicit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-time-'));
  const cs = new ChainStore(dir);
  cs.create('身份', '核星', '');
  cs.create('身份链', '身份', '');
  cs.append('身份链', { t: '2026-11-07 10:00', text: '显式时间' });
  const node = cs.get('身份链').nodes[0];
  assert.strictEqual(node.t, '2026-11-07 10:00');
  assert.strictEqual(node.tSource, 'explicit');
});

test('monthOf 用本地月份，不在月初掉到上个月', () => {
  assert.strictEqual(monthOf('2026-11-01 00:30'), '2026-11');
  assert.strictEqual(monthOf(new Date(2026, 10, 1, 0, 30).getTime()), '2026-11');
});

test('parseRefineResponse 给节点标 llm/fallback', () => {
  const parsed = parseRefineResponse(JSON.stringify({
    chains: [{
      name: '身份链',
      parent: '身份',
      nodes: [
        { t: '2026-11-07 10:00', who: '你', type: 'event', text: 'LLM 时间' },
        { t: 'bad', who: '你', type: 'event', text: '回退时间' },
      ],
    }],
  }), { fallbackT: '2026-11-07 11:00' });
  assert.strictEqual(parsed.chains[0].nodes[0].tSource, 'llm');
  assert.strictEqual(parsed.chains[0].nodes[1].tSource, 'fallback');
});
