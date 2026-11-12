import test from 'node:test';
import assert from 'node:assert';
import { GroupResponder, chunkText } from '../src/qq/group-responder.js';

function fakeLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

test('GroupResponder：provider/model/llm 齐全才可用', () => {
  assert.strictEqual(new GroupResponder({ llm: fakeLlm([]), provider: 'p', model: 'm' }).available(), true);
  assert.strictEqual(new GroupResponder({ llm: null, provider: 'p', model: 'm' }).available(), false);
  assert.strictEqual(new GroupResponder({ llm: fakeLlm([]), provider: '', model: 'm' }).available(), false);
});

test('GroupResponder：拼接文本块，忽略 reasoning', async () => {
  const r = new GroupResponder({
    llm: fakeLlm([
      { type: 'reasoning-delta', text: '不该出现' },
      { type: 'text-delta', text: '温柔' },
      { type: 'text-delta', text: '一点' },
    ]),
    provider: 'p',
    model: 'm',
    logger: { info() {}, warn() {}, error() {} },
  });
  const out = await r.reply({ system: 'sys', user: 'usr' });
  assert.strictEqual(out, '温柔一点');
});

test('GroupResponder：不可用时直接报错，不假装回复', async () => {
  const r = new GroupResponder({ llm: fakeLlm([]), provider: '', model: '' });
  await assert.rejects(() => r.reply({ system: 's', user: 'u' }), /provider\/model/);
});

test('chunkText：兼容 text / delta.text / content 三种形状', () => {
  assert.strictEqual(chunkText('abc'), 'abc');
  assert.strictEqual(chunkText({ type: 'text-delta', text: 'x' }), 'x');
  assert.strictEqual(chunkText({ delta: { type: 'text', text: 'y' } }), 'y');
  assert.strictEqual(chunkText({ content: [{ type: 'text', text: 'z' }] }), 'z');
  assert.strictEqual(chunkText({ type: 'reasoning-delta', text: 'no' }), '');
});
