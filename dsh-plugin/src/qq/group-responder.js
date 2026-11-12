/**
 * group-responder.js — 群聊一次性回复
 *
 * 群聊不建 DSH 会话：GroupBoard（24h）+ 当前 @ → 一次 LLM 调用 → 回 QQ。
 * 群里不跑 agent、不调工具、不写主记忆。
 */

function chunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;

  const type = String(chunk.type || (chunk.delta && chunk.delta.type) || '');
  if (/reason|think|redact|thought/i.test(type)) return '';

  if (typeof chunk.text === 'string') return chunk.text;
  if (chunk.delta && typeof chunk.delta.text === 'string' && !/reason|think/i.test(String(chunk.delta.type || ''))) {
    return chunk.delta.text;
  }
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .filter((b) => b && /^text$/i.test(String(b.type || '')) && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

export class GroupResponder {
  constructor({ llm, provider, model, logger, temperature = 0.7, maxTokens = 400 } = {}) {
    this.llm = llm;
    this.provider = String(provider || '');
    this.model = String(model || '');
    this.log = logger || console;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  available() {
    return Boolean(
      this.llm
      && typeof this.llm.stream === 'function'
      && this.provider
      && this.model
    );
  }

  async reply({ system, user } = {}) {
    if (!this.available()) {
      throw new Error('群聊 stateless 需要 ctx.llm.stream + provider/model');
    }
    const stream = this.llm.stream({
      provider: this.provider,
      model: this.model,
      system: String(system || ''),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user || '') }] }],
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      purpose: 'qq-group',
    });

    let out = '';
    for await (const chunk of stream) {
      const t = chunkText(chunk);
      if (t) out += t;
    }
    return out.trim();
  }
}

export { chunkText };
