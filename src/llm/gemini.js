// Провайдер Google Gemini (REST generateContent с function calling).

// Gemini принимает только подмножество JSON Schema — убираем неподдерживаемые поля.
function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', '$schema', 'default', 'examples'].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

export class GeminiProvider {
  constructor(cfg) {
    this.cfg = cfg;
  }

  toContents(messages) {
    const out = [];
    const push = (role, parts) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else out.push({ role, parts });
    };
    for (const m of messages) {
      if (m.role === 'tool') {
        let response;
        try { response = JSON.parse(m.content); } catch { response = { result: m.content }; }
        if (typeof response !== 'object' || response === null || Array.isArray(response)) response = { result: response };
        push('user', [{ functionResponse: { name: m.name, response } }]);
      } else if (m.role === 'assistant') {
        // ответы Gemini возвращаем как есть (там могут быть thought signatures)
        if (m._raw?.provider === 'gemini') { push('model', m._raw.parts); continue; }
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
        if (parts.length) push('model', parts);
      } else {
        push('user', [{ text: m.content }]);
      }
    }
    if (out[0]?.role === 'model') out.unshift({ role: 'user', parts: [{ text: '(начало разговора)' }] });
    return out;
  }

  async chat({ system, messages, tools = [], temperature, maxTokens = 4096 }) {
    const { baseUrl, apiKey, model } = this.cfg;
    if (!apiKey) throw new Error('Не задан API-ключ Gemini');
    const body = {
      contents: this.toContents(messages),
      generationConfig: { maxOutputTokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.parameters) })) }];
    }
    const url = `${(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`gemini: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({
      id: `gem_${Date.now()}_${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {},
    }));
    return { text, toolCalls, usage: data.usageMetadata, raw: { provider: 'gemini', parts } };
  }
}
