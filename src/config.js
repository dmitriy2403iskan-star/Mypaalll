// Хранилище настроек. Источники (по приоритету): data/settings.json (веб-панель) > .env > значения по умолчанию.
// Все API-ключи меняются на лету через веб-панель или PUT /api/settings — перезапуск не нужен.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import 'dotenv/config';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const env = (k, d = '') => process.env[k] ?? d;

function defaults() {
  return {
    llm: {
      activeProvider: env('LLM_PROVIDER', 'openai'),
      // отдельная (обычно дешёвая) модель для извлечения памяти; пусто = та же, что activeProvider
      memoryProvider: '',
      providers: {
        openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: env('OPENAI_API_KEY'), model: env('OPENAI_MODEL', 'gpt-4o-mini') },
        anthropic: {
          type: 'anthropic', baseUrl: '', apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-opus-5-5'),
          effort: 'low', // low | medium | high — для игрового компаньона важна скорость ответа
          fallbacks: true, // server-side fallback при отказе модели (refusal)
        },
        gemini: { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL', 'gemini-2.5-flash') },
        openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env('OPENROUTER_API_KEY'), model: 'openai/gpt-4o-mini' },
        groq: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: env('GROQ_API_KEY'), model: 'llama-3.3-70b-versatile' },
        deepseek: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: env('DEEPSEEK_API_KEY'), model: 'deepseek-chat' },
        ollama: { type: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'qwen2.5:7b' },
        custom: { type: 'openai', baseUrl: env('CUSTOM_BASE_URL'), apiKey: env('CUSTOM_API_KEY'), model: env('CUSTOM_MODEL') },
      },
    },
    minecraft: {
      host: env('MC_HOST', 'localhost'),
      port: Number(env('MC_PORT', '25565')),
      version: env('MC_VERSION') || false,
      auth: env('MC_AUTH', 'offline'),
    },
    agent: {
      maxSteps: 12,            // максимум вызовов инструментов за один ход мышления
      temperature: 0.6,        // для провайдеров, которые его поддерживают
      respondTo: 'mention',    // mention = отвечать, когда обращаются по имени или пишут лично; all = на все сообщения
      memoryExtraction: true,  // авто-извлечение фактов из разговора
      historyLength: 20,       // сколько последних реплик держать в краткосрочной памяти
      language: 'ru',
    },
    reflex: {
      autoEat: true,
      selfDefense: true,
      fleeHealth: 6,
      avoidDrowning: true,
    },
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

class Settings extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* первый запуск */ }
    this.data = deepMerge(defaults(), saved);
  }

  get() { return this.data; }

  provider(name) {
    const id = name || this.data.llm.activeProvider;
    const cfg = this.data.llm.providers[id];
    if (!cfg) throw new Error(`Провайдер "${id}" не настроен`);
    return { id, ...cfg };
  }

  update(patch) {
    // пустая строка или маска в apiKey = «не менять ключ»
    for (const p of Object.values(patch?.llm?.providers || {})) {
      if (p && (p.apiKey === undefined || p.apiKey === '' || /^\*+|•/.test(p.apiKey) || p.apiKey?.includes('…'))) delete p.apiKey;
    }
    this.data = deepMerge(this.data, patch);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.data, null, 2));
    this.emit('change', this.data);
    return this.data;
  }

  /** Копия без секретов — для отдачи в UI. */
  public() {
    const copy = structuredClone(this.data);
    for (const p of Object.values(copy.llm.providers)) {
      p.hasKey = Boolean(p.apiKey);
      p.apiKey = p.apiKey ? mask(p.apiKey) : '';
    }
    return copy;
  }
}

export function mask(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const settings = new Settings();
