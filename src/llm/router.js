// LLM Router: выбирает провайдера по настройкам. Агент вызывает только llm.chat() и не знает, какая нейросеть за ним.
import { settings } from '../config.js';
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

const TYPES = {
  openai: OpenAICompatibleProvider,
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
};

// Тестовый провайдер можно подменить (используется в тестах)
const overrides = new Map();
export function registerProvider(id, instance) { overrides.set(id, instance); }

export function getProvider(id) {
  const cfg = settings.provider(id);
  if (overrides.has(cfg.id)) return overrides.get(cfg.id);
  const Cls = TYPES[cfg.type];
  if (!Cls) throw new Error(`Неизвестный тип провайдера: ${cfg.type}`);
  // Создаём заново при каждом вызове — так смена ключа/модели в настройках применяется мгновенно.
  return new Cls(cfg);
}

/**
 * Единый формат:
 *  messages: [{ role: 'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name?, _raw? }]
 *  tools:    [{ name, description, parameters (JSON Schema) }]
 *  ответ:    { text, toolCalls: [{ id, name, args }], raw? }
 */
export async function chat({ provider, ...opts }) {
  const p = getProvider(provider);
  const temperature = settings.get().agent.temperature;
  const cfg = settings.provider(provider);
  // Новые модели Claude не принимают temperature — передаём её только остальным
  return p.chat({ ...opts, ...(cfg.type === 'anthropic' ? {} : { temperature }) });
}

/** Быстрая проверка ключа из веб-панели. */
export async function testProvider(id) {
  const t0 = Date.now();
  const res = await getProvider(id).chat({
    system: 'Reply with one short word.',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1024,
  });
  return { ok: true, ms: Date.now() - t0, reply: (res.text || '').slice(0, 100) };
}
