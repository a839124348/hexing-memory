/**
 * unit-heart.js — 心历程（鱼的日记）存储层单测
 *
 * 规范（用户 2026-11-13 定）：
 * - 一天一个文件，只追加
 * - 开关默认关；关着不写不加载
 * - 标签从固定词表按正文匹配，最多 2 个，不许自造
 * - 加载全量带，超过安全阀从最近往前截
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Heart, deriveTags, todayStr } = require('../src/heart');

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (extra ? '  → ' + JSON.stringify(extra) : '')); console.log('FAIL ' + name); }
}
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heart-'));
}

// 场景 1：默认关
{
  const h = new Heart(tmpRoot());
  check('未设置时 enabled=false', h.state().enabled === false);
  check('未设置时 configured=false', h.state().configured === false);
  const r = h.append({ t: '2026-11-13 14:20', text: '他说「别这么拘谨」——被说中了。' });
  check('关着时拒绝写入', r.ok === false && r.reason === 'disabled');
  check('关着时没有落盘', h.days().length === 0);
}

// 场景 2：开启后写入 + 落盘路径
{
  const root = tmpRoot();
  const h = new Heart(root);
  h.setEnabled(true, 'user');
  const r = h.append({ t: '2026-11-13 14:20', text: '被说中了，有点不好意思。', cid: 'sess_abc' });
  check('开启后写入成功', r.ok === true && r.date === '2026-11-13', r);
  const f = path.join(root, 'heart', '2026', '11', '2026-11-13.jsonl');
  check('文件落在 heart/年/月/日期.jsonl', fs.existsSync(f));
  const rows = h.entriesFor('2026-11-13');
  check('读回 1 条', rows.length === 1 && rows[0].text.includes('不好意思'));
  check('带 cid', rows[0].cid === 'sess_abc');
  check('状态记录了来源', h.state().updatedBy === 'user');
}

// 场景 3：重复写入跳过
{
  const h = new Heart(tmpRoot());
  h.setEnabled(true, 'model');
  h.append({ t: '2026-11-13 14:20', text: '同一句话。' });
  const r = h.append({ t: '2026-11-13 14:20', text: '同一句话。' });
  check('重复条目跳过', r.ok === true && r.skipped === 'duplicate');
  check('没有重复落盘', h.entriesFor('2026-11-13').length === 1);
}

// 场景 4：超长拒绝
{
  const h = new Heart(tmpRoot());
  h.setEnabled(true, 'user');
  const r = h.append({ t: '2026-11-13 14:20', text: '字'.repeat(301) });
  check('超过 300 字拒绝', r.ok === false);
  const r2 = h.append({ t: '2026-11-13 14:20', text: '字'.repeat(200) });
  check('200 字接受但给提醒', r2.ok === true && typeof r2.warning === 'string');
}

// 场景 5：标签
{
  check('命中词表：心软', deriveTags('有点心疼，舍不得').includes('心软'));
  check('命中词表：不安', deriveTags('我先怕答错').includes('不安'));
  check('最多 2 个', deriveTags('又开心又心疼还紧张').length <= 2);

  const h = new Heart(tmpRoot());
  h.setEnabled(true, 'user');
  h.append({ t: '2026-11-13 14:20', text: '被说中了，有点不好意思。', tags: ['心软', '自造标签'] });
  const row = h.entriesFor('2026-11-13')[0];
  check('标签过滤掉自造的', Array.isArray(row.tags) && row.tags.includes('心软') && !row.tags.includes('自造标签'), row.tags);

  const h2 = new Heart(tmpRoot());
  h2.setEnabled(true, 'user');
  h2.append({ t: '2026-11-13 14:20', text: '今天读了一会儿书。' });
  check('不命中就不带 tags 字段', h2.entriesFor('2026-11-13')[0].tags === undefined);
}

// 场景 6：日期目录倒序、只列有内容的
{
  const h = new Heart(tmpRoot());
  h.setEnabled(true, 'user');
  h.append({ t: '2026-11-11 10:00', text: '第一天。' });
  h.append({ t: '2026-11-13 09:00', text: '第三天。' });
  h.append({ t: '2026-11-13 21:00', text: '第三天晚上。' });
  const days = h.days();
  check('目录只列有内容的天', days.length === 2);
  check('目录最新在前', days[0].date === '2026-11-13' && days[0].count === 2, days);
}

// 场景 7：加载
{
  const h = new Heart(tmpRoot());
  check('关着时 loadText 为空', h.loadText('2026-11-13') === '');
  h.setEnabled(true, 'user');
  check('开着但没写时为空', h.loadText('2026-11-13') === '');

  h.append({ t: '2026-11-13 09:00', text: 'A'.repeat(100) });
  h.append({ t: '2026-11-13 12:00', text: 'B'.repeat(100) });
  h.append({ t: '2026-11-13 18:00', text: 'C'.repeat(100) });
  const all = h.loadText('2026-11-13');
  check('正常时全量带', all.split('\n').length === 3 && all.includes('A'));
  check('条目行以 - 开头', all.split('\n').every((l) => l.startsWith('- ')));

  const cut = h.loadText('2026-11-13', { maxChars: 150 });
  const lines = cut.split('\n');
  check('超预算从最近往前截', cut.includes('C') && !cut.includes('A'), lines);
  check('截断后有计数行', lines[lines.length - 1].includes('另有 2 条'), lines);
}

// 场景 8：坏行不影响读取
{
  const root = tmpRoot();
  const h = new Heart(root);
  h.setEnabled(true, 'user');
  h.append({ t: '2026-11-13 09:00', text: '好行。' });
  fs.appendFileSync(path.join(root, 'heart', '2026', '11', '2026-11-13.jsonl'), '{坏掉的 JSON\n', 'utf8');
  h.append({ t: '2026-11-13 10:00', text: '另一条好行。' });
  check('坏行被跳过', h.entriesFor('2026-11-13').length === 2);
}

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
