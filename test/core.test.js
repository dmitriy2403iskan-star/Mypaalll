// Офлайн-тесты: преобразование форматов LLM, задачи, память. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mypal-test-'));

const { OpenAICompatibleProvider } = await import('../src/llm/openai.js');
const { AnthropicProvider } = await import('../src/llm/anthropic.js');
const { GeminiProvider } = await import('../src/llm/gemini.js');
const { TaskManager } = await import('../src/agent/tasks.js');
const { Memory } = await import('../src/agent/memory.js');
const { settings, mask } = await import('../src/config.js');
const { toolSchemas } = await import('../src/actions/index.js');
const { detectIntents } = await import('../src/agent/context.js');

const convo = [
  { role: 'user', content: '[Steve]: собери дерево' },
  { role: 'assistant', content: 'Иду', toolCalls: [{ id: 't1', name: 'collect_blocks', args: { block: 'log', count: 3 } }, { id: 't2', name: 'remember', args: { fact: 'x' } }] },
  { role: 'tool', toolCallId: 't1', name: 'collect_blocks', content: 'Добыл 3' },
  { role: 'tool', toolCallId: 't2', name: 'remember', content: 'ok' },
];

test('OpenAI: tool_calls и tool-сообщения', () => {
  const m = new OpenAICompatibleProvider({}).toMessages('sys', convo);
  assert.equal(m[0].role, 'system');
  assert.equal(m[2].tool_calls[0].function.name, 'collect_blocks');
  assert.equal(JSON.parse(m[2].tool_calls[0].function.arguments).count, 3);
  assert.deepEqual(m.slice(3).map((x) => x.tool_call_id), ['t1', 't2']);
});

test('Anthropic: tool_result склеиваются в один user-ход, raw content сохраняется', () => {
  const p = new AnthropicProvider({ apiKey: 'x' });
  const m = p.toMessages(convo);
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[2].content.length, 2);
  assert.equal(m[2].content[0].type, 'tool_result');
  const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hi' }];
  const m2 = p.toMessages([{ role: 'assistant', content: 'hi', _raw: { provider: 'anthropic', content: raw } }]);
  assert.equal(m2[0].role, 'user'); // разговор начинается с user
  assert.deepEqual(m2[1].content, raw);
});

test('Gemini: functionCall / functionResponse', () => {
  const c = new GeminiProvider({}).toContents(convo);
  assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
  assert.equal(c[1].parts[1].functionCall.name, 'collect_blocks');
  assert.equal(c[2].parts[0].functionResponse.name, 'collect_blocks');
});

test('Схемы инструментов валидны', () => {
  const tools = toolSchemas();
  assert.ok(tools.length > 20);
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.equal(t.parameters.type, 'object');
    assert.ok(!names.has(t.name), `дубликат ${t.name}`);
    names.add(t.name);
  }
});

test('Задачи: шаги и статусы', () => {
  const tm = new TaskManager(1);
  const t = tm.create('Дом', ['дерево', 'доски', 'стены']);
  assert.equal(t.steps[0].status, 'RUNNING');
  tm.updateStep(t.id, 0, 'COMPLETED');
  assert.equal(tm.get(t.id).steps[1].status, 'RUNNING');
  tm.updateStep(t.id, 1, 'COMPLETED');
  tm.updateStep(t.id, 2, 'COMPLETED');
  assert.equal(tm.get(t.id).status, 'COMPLETED');
  assert.equal(tm.current(), null);
});

test('Память: дубли, релевантность, локации', () => {
  const m = new Memory(1);
  m.add('semantic', 'База игрока у реки', 5);
  m.add('semantic', 'база игрока у реки');
  m.add('episodic', 'Убили зомби', 1);
  assert.equal(m.list().length, 2);
  assert.equal(m.relevant('где наша база?')[0].content, 'База игрока у реки');
  m.saveLocation('Дом', { x: 1.4, y: 64, z: -3.6 });
  assert.deepEqual([m.getLocation('дом').x, m.getLocation('дом').z], [1, -4]);
});

test('Настройки: ключи маскируются и маска не перезаписывает ключ', () => {
  settings.update({ llm: { providers: { openai: { apiKey: 'sk-secret-key-1234' } } } });
  const pub = settings.public();
  assert.equal(pub.llm.providers.openai.apiKey, mask('sk-secret-key-1234'));
  assert.ok(!JSON.stringify(pub).includes('secret'));
  settings.update({ llm: { providers: { openai: { apiKey: pub.llm.providers.openai.apiKey, model: 'm2' } } } });
  assert.equal(settings.get().llm.providers.openai.apiKey, 'sk-secret-key-1234');
  assert.equal(settings.get().llm.providers.openai.model, 'm2');
});

test('Определение намерений для Context Manager', () => {
  assert.ok(detectIntents('Построй дом').includes('build'));
  assert.ok(detectIntents('добудь камня').includes('gather'));
  assert.deepEqual(detectIntents('как дела?'), []);
});
