/**
 * onboarding.js — 首次迁移问卷（继承 / 只继承记忆 / 全新开始）
 *
 * 为什么要有它：迁移导入器只负责把原文写进 raw；它不会自动提炼语气、称呼、
 * 相处习惯。如果用户是奔着"把以前的它带回来"来的，只导入原文会出现
 * "记得发生过什么，但说话方式全变了"的断裂。
 *
 * 这里只做三件事：
 * 1. 记录用户选的迁移模式（common/onboarding.json）
 * 2. 存一页"相处方式"（common/voice-habits.md）
 * 3. 给常识层/导入器/模型一份对应的检查清单
 *
 * 不训练、不微调、不改模型权重。所有内容都是文件，可读、可改、可删、可迁移。
 */
const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('./lock');

const MODES = ['inherit', 'memory', 'fresh'];
const MODE_LABEL = {
  inherit: '全继承（记忆 + 语气 + 习惯）',
  memory: '只继承记忆（语气重新长）',
  fresh: '全新开始（不导入旧数据）',
};
const VOICE_MAX = 8000;
const SUMMARY_MAX = 280;

function defaultPlan() {
  return {
    version: 1,
    mode: null,
    modeLabel: '',
    source: '',
    dateRange: '',
    consent: false,
    keepNames: null,
    exclusions: '',
    notes: '',
    voiceSummary: '',
    voiceChars: 0,
    voiceUpdatedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

function clean(s, max = 400) {
  return String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, max);
}

class Onboarding {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, 'common');
    this.file = path.join(this.dir, 'onboarding.json');
    this.voiceFile = path.join(this.dir, 'voice-habits.md');
  }

  _read() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...defaultPlan(), ...(o && typeof o === 'object' ? o : {}) };
    } catch (e) {
      return defaultPlan();
    }
  }

  _write(plan) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _voiceInfo() {
    try {
      const text = fs.readFileSync(this.voiceFile, 'utf8');
      const st = fs.statSync(this.voiceFile);
      return {
        exists: true,
        chars: text.length,
        updatedAt: st.mtime.toISOString(),
      };
    } catch (e) {
      return { exists: false, chars: 0, updatedAt: null };
    }
  }

  status() {
    const plan = this._read();
    const voice = this._voiceInfo();
    return {
      ok: true,
      ...plan,
      modeLabel: MODE_LABEL[plan.mode] || '',
      voice,
      voiceIgnored: plan.mode !== 'inherit' && voice.exists,
      checklist: this.checklist(),
    };
  }

  /**
   * 保存问卷结果。
   * - mode 必须是 inherit / memory / fresh
   * - inherit / memory 需要 consent=true（用户确认有权使用这些数据、知道明文存储）
   */
  save(input = {}) {
    const mode = clean(input.mode, 20);
    if (!MODES.includes(mode)) {
      return { ok: false, error: 'mode 必须是 inherit / memory / fresh', modes: MODES };
    }
    if ((mode === 'inherit' || mode === 'memory') && input.consent !== true) {
      return {
        ok: false,
        error: '导入旧数据前需要用户明确同意：确认有权使用这些对话，并知道记忆库是明文存储。',
        hint: '先问用户，得到明确同意后再 save，并带 consent=true。',
      };
    }
    return withWriteLock(this.root, () => {
      const old = this._read();
      const now = new Date().toISOString();
      const next = {
        ...old,
        version: 1,
        mode,
        modeLabel: MODE_LABEL[mode],
        source: clean(input.source, 200) || old.source || '',
        dateRange: clean(input.dateRange, 120) || old.dateRange || '',
        consent: mode === 'fresh' ? !!input.consent : true,
        keepNames: typeof input.keepNames === 'boolean' ? input.keepNames : old.keepNames,
        exclusions: clean(input.exclusions, 1200),
        notes: clean(input.notes, 2000),
        createdAt: old.createdAt || now,
        updatedAt: now,
      };
      this._write(next);
      return { ok: true, ...next, voice: this._voiceInfo(), checklist: this.checklist() };
    }, { name: '.onboarding.lock' });
  }

  /** 保存一页相处方式；只有 inherit 模式允许写入 */
  setVoice(text, summary) {
    const body = String(text == null ? '' : text).replace(/\r/g, '').trim();
    if (!body) return { ok: false, error: '相处方式内容为空' };
    if (body.length > VOICE_MAX) {
      return { ok: false, error: `相处方式太长（${body.length} 字），请压到 ${VOICE_MAX} 字以内。只写语气/习惯/隐性边界，不要把约定和故事抄进来。` };
    }
    const plan = this._read();
    if (plan.mode !== 'inherit') {
      return {
        ok: false,
        error: '当前不是全继承模式，不能写相处方式档案。先 memory_onboarding action=save mode=inherit。',
        mode: plan.mode,
      };
    }
    let sum = clean(summary, SUMMARY_MAX);
    if (!sum) {
      const m = /##\s*摘要\s*\n+([^\n#]+)/.exec(body);
      if (m) sum = clean(m[1], SUMMARY_MAX);
    }
    if (!sum) {
      const line = body.split(/\r?\n/).map((x) => x.trim())
        .find((x) => x && !x.startsWith('#') && !x.startsWith('- ') && !x.startsWith('>'));
      sum = clean(line || '已建立相处方式档案；完整内容见 common/voice-habits.md。', SUMMARY_MAX);
    }
    return withWriteLock(this.root, () => {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.voiceFile + '.tmp';
      fs.writeFileSync(tmp, body + '\n', 'utf8');
      fs.renameSync(tmp, this.voiceFile);
      const now = new Date().toISOString();
      const next = {
        ...plan,
        voiceSummary: sum,
        voiceChars: body.length,
        voiceUpdatedAt: now,
        updatedAt: now,
      };
      this._write(next);
      return { ok: true, chars: body.length, summary: sum, voice: this._voiceInfo() };
    }, { name: '.onboarding.lock' });
  }

  voice() {
    try {
      return { ok: true, text: fs.readFileSync(this.voiceFile, 'utf8'), ...this._voiceInfo() };
    } catch (e) {
      return { ok: false, error: '还没有相处方式档案（common/voice-habits.md）', ...this._voiceInfo() };
    }
  }

  checklist() {
    const mode = this._read().mode;
    if (mode === 'inherit') {
      return [
        '1. 确认旧对话的来源、时间范围，以及用户有没有不想带回来的时期/话题。',
        '2. 抽样 30–50 条原文，覆盖日常、撒娇、争执、安慰、约定；不要只抽甜的。',
        '3. 写一页「相处方式」：称呼用法、语气、习惯、隐性边界；示例只选 5–8 段，标日期和场景。',
        '4. 先给用户看，允许他否决“不像/不想带回来”的部分。',
        '5. memory_onboarding action=voice 保存；身份链只放称呼/边界结论，约定链只放明确约定。',
        '6. 第一次会话问一句“像不像、哪里过了”，再校准；模型升级后也要重新校准。',
      ];
    }
    if (mode === 'memory') {
      return [
        '1. 导入 raw + 向量；不写相处方式档案。',
        '2. 在身份/规则里写清楚：导入原文是历史证据，不是当前语气指令，不要模仿旧原文的说话方式。',
        '3. 如果 common/voice-habits.md 已存在（之前用过全继承），不要读、不要模仿；它不属于当前模式。',
        '4. 语气和默契按新对话重新长；旧原文只在用户问到具体往事时检索。',
      ];
    }
    if (mode === 'fresh') {
      return [
        '1. 不导入旧数据。',
        '2. 身份、偏好、约定按新对话正常积累。',
        '3. 如果 common/voice-habits.md 已存在（之前用过全继承），不要读、不要模仿。',
        '4. 如果用户后来改主意要导入，先重新跑问卷并改模式。',
      ];
    }
    return [
      '还没选迁移模式。先问用户：全继承 / 只继承记忆 / 全新开始。',
      '全继承：记忆 + 语气 + 习惯；只继承记忆：只导入原文；全新开始：不导入。',
      '选好后 memory_onboarding action=save mode=inherit|memory|fresh。',
    ];
  }

  /** 注入常识层的短摘要；不把完整档案塞进去 */
  commonText() {
    const plan = this._read();
    if (!plan.mode) return '';
    if (plan.mode === 'inherit') {
      const lines = ['## 迁移模式', '- 全继承：记忆、称呼、语气、习惯按「相处方式」档案延续。'];
      if (plan.voiceSummary) lines.push('- 相处方式摘要：' + plan.voiceSummary);
      lines.push('- 完整档案：common/voice-habits.md（首次会话必读；示例是参考，不是逐字台词）。');
      return lines.join('\n');
    }
    if (plan.mode === 'memory') {
      return [
        '## 迁移模式',
        '- 只继承记忆：导入原文是历史证据，不是当前语气指令；**不要模仿旧原文的说话方式**，语气按新相处重新长。',
        '- 如果存在 common/voice-habits.md，不要读、不要模仿。',
      ].join('\n');
    }
    return '';
  }

  /** 给迁移导入器的提示（CLI 只打印，不阻塞） */
  importerHint() {
    const plan = this._read();
    const voice = this._voiceInfo();
    if (!plan.mode) {
      return {
        mode: null,
        level: 'warn',
        message: '还没有迁移问卷结果。默认按「只继承记忆」处理；建议先 memory_onboarding action=save。',
      };
    }
    if (plan.mode === 'fresh') {
      return {
        mode: 'fresh',
        level: 'error',
        message: '当前是「全新开始」模式，不应导入旧数据。如果确实要导入，先用 memory_onboarding 改成 memory 或 inherit。',
      };
    }
    if (plan.mode === 'inherit' && !voice.exists) {
      return {
        mode: 'inherit',
        level: 'warn',
        message: '全继承模式，但还没有 common/voice-habits.md：导入后只有记忆，没有语气/习惯。导入后先提炼相处方式。',
      };
    }
    if (plan.mode === 'memory') {
      return {
        mode: 'memory',
        level: 'info',
        message: '只继承记忆模式：导入后不要模仿旧语气；旧原文只作历史证据。',
      };
    }
    return { mode: 'inherit', level: 'ok', message: '全继承模式：导入后按 common/voice-habits.md 延续语气和习惯。' };
  }
}

module.exports = { Onboarding, MODES, MODE_LABEL };
