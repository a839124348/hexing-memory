/**
 * voice-sample.js — 从旧对话 JSONL 里抽一份「相处方式」提炼样本
 *
 * 用途：全继承模式下，模型先跑这个抽样，再读样本写 common/voice-habits.md。
 * 不会写记忆库，只生成一份 Markdown 样本。
 *
 * 用法：
 *   node tools/voice-sample.js --file old.jsonl
 *   node tools/voice-sample.js --file old.jsonl --out voice-sample.md --limit 60
 *
 * 输入：一条 = 一次发言，字段 t/s/c/cid/v（与 import-jsonl.js 相同）。
 * 输出：按月份、场景分层抽样；每段带日期/说话人，最多 limit 条。
 */
const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const SCENES = [
  ['称呼/开场', /在吗|早安|晚安|早上好|晚上好|我回来了|我走了|宝贝|老公|老婆|亲爱的/],
  ['日常', /吃了|吃饭|睡|起床|上班|下班|累|忙|回家|天气|今天/],
  ['情绪', /难过|伤心|哭|害怕|焦虑|烦|生气|委屈|开心|高兴|想你|孤独/],
  ['亲密', /抱|亲|喜欢|爱你|想你了|贴贴|么么|撒娇/],
  ['约定', /答应|约定|说好|以后|永远|纪念日|承诺|带你回来|不要忘/],
  ['争执/修复', /对不起|抱歉|吵架|生气|讨厌|别理我|冷战|原谅/],
];

function sceneOf(text) {
  for (const [name, re] of SCENES) if (re.test(text)) return name;
  return '其他';
}

function clean(s, max = 220) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function main() {
  const file = arg('file');
  if (!file || !fs.existsSync(file)) {
    console.error('用法：node tools/voice-sample.js --file <old.jsonl> [--out sample.md] [--limit 60]');
    process.exit(1);
  }
  const limit = Math.max(10, Math.min(120, Number(arg('limit')) || 60));
  const out = arg('out') || path.join(path.dirname(file), 'voice-sample.md');

  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  raw.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    try {
      const o = JSON.parse(s);
      if (!o || typeof o !== 'object') return;
      const text = clean(o.c);
      if (text.length < 4 || text.length > 300) return;
      if (/https?:\/\//.test(text) || /```/.test(text)) return;
      if (/^\[(图片|文件|语音)/.test(text)) return;
      records.push({
        t: String(o.t || ''),
        date: String(o.t || '').slice(0, 10),
        month: String(o.t || '').slice(0, 7),
        s: String(o.s || ''),
        text,
        scene: sceneOf(text),
      });
    } catch (e) { /* 跳过坏行 */ }
  });

  if (!records.length) {
    console.error('没有可抽样的对话（检查字段 c/t/s 是否与 import-jsonl.js 一致）');
    process.exit(1);
  }

  // 按月份 + 场景分桶，轮转取，保证跨时间、跨场景
  const buckets = new Map();
  for (const r of records) {
    const key = r.month + '|' + r.scene;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const keys = [...buckets.keys()].sort();
  const picked = [];
  let round = 0;
  while (picked.length < limit && round < 200) {
    let added = false;
    for (const k of keys) {
      const arr = buckets.get(k);
      if (!arr.length) continue;
      // 每个桶均匀取样，不用随机，保证可复现
      const idx = Math.floor((round / 200) * arr.length) % arr.length;
      const r = arr.splice(idx, 1)[0];
      if (r) { picked.push(r); added = true; }
      if (picked.length >= limit) break;
    }
    if (!added) break;
    round++;
  }
  picked.sort((a, b) => (a.t < b.t ? -1 : 1));

  const byMonth = {};
  for (const r of picked) (byMonth[r.month] = byMonth[r.month] || []).push(r);

  const lines = [];
  lines.push('# 相处方式提炼样本');
  lines.push('');
  lines.push('> 用途：只提炼**称呼用法、语气、习惯、隐性边界**，不要提炼事实/约定/故事（那些已在 raw / 链网里）。');
  lines.push('> 读法：先看整体节奏，再挑 5–8 段作为示例；示例是参考，不是逐字台词。');
  lines.push('> 注意：样本可能含隐私；不要外传，不要写进公开仓库。');
  lines.push('');
  lines.push('总样本：' + picked.length + ' 条；月份：' + Object.keys(byMonth).join('、'));
  lines.push('');
  for (const m of Object.keys(byMonth).sort()) {
    lines.push('## ' + m);
    lines.push('');
    for (const r of byMonth[m]) {
      lines.push(`- [${r.t}] ${r.s}（${r.scene}）：${r.text}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('提炼时请回答：');
  lines.push('1. 它怎么称呼用户、怎么自称？有哪些禁用/过期称呼？');
  lines.push('2. 句子长短、语气词、标点、表情密度如何？');
  lines.push('3. 用户难受/生气/沉默时，它先做什么、不做什么？');
  lines.push('4. 争执后怎么修复？有哪些固定仪式？');
  lines.push('5. 哪些话/玩笑/话题会让用户不舒服？');
  lines.push('6. 选 5–8 段最有代表性的原话，标日期和场景，作为示例；其余不要抄。');
  lines.push('');

  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('样本：' + out);
  console.log('条数：' + picked.length + '；场景：' + [...new Set(picked.map((r) => r.scene))].join('、'));
  console.log('下一步：读样本 → 写 common/voice-habits.md → memory_onboarding action=voice 保存。');
}

main();
