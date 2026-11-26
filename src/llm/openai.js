// OpenAI-совместимый провайдер: OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, vLLM, Together и т.д.
// Подходит любой сервер с эндпоинтом POST {baseUrl}/chat/completions и поддержкой tools.

export class OpenAICompatibleProvider {
  constructor(cfg) {
    this.cfg = cfg;
  }

  toMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.content || '' };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }));
        }
        out.push(msg);
      } else {
        out.push({ role: 'user', content: m.content });
      }
    }
    return out;
  }

  async chat({ system, messages, tools = [], temperature, maxTokens = 2048 }) {
    const { baseUrl, apiKey, model } = this.cfg;
    if (!baseUrl) throw new Error(`У провайдера "${this.cfg.id}" не задан baseUrl`);
    const body = {
      model,
      messages: this.toMessages(system, messages),
      max_tokens: maxTokens,
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        // OpenRouter любит знать, кто его вызывает; другим серверам эти заголовки не мешают
        'X-Title': 'MyPal',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`${this.cfg.id}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map((c) => {
      let args = {};
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = { _invalid: c.function.arguments }; }
      return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function.name, args };
    });
    return { text: msg.content || '', toolCalls, usage: data.usage };
  }
}
