// Провайдер Anthropic (Claude) через официальный SDK @anthropic-ai/sdk.
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new Anthropic({
      apiKey: cfg.apiKey || undefined,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    });
  }

  toMessages(messages) {
    const out = [];
    const push = (role, blocks) => {
      const last = out[out.length - 1];
      // Anthropic требует чередования ролей: несколько tool_result подряд склеиваем в один user-ход
      if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };
    for (const m of messages) {
      if (m.role === 'tool') {
        push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
      } else if (m.role === 'assistant') {
        // Если ответ получен от Anthropic — возвращаем его content целиком (включая thinking-блоки), без изменений.
        if (m._raw?.provider === 'anthropic') { out.push({ role: 'assistant', content: m._raw.content }); continue; }
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        if (blocks.length) push('assistant', blocks);
      } else {
        push('user', [{ type: 'text', text: m.content }]);
      }
    }
    // разговор должен начинаться с user-сообщения
    if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(начало разговора)' }] });
    return out;
  }

  async chat({ system, messages, tools = [], maxTokens = 16000 }) {
    const params = {
      model: this.cfg.model,
      max_tokens: maxTokens,
      system,
      messages: this.toMessages(messages),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
    };

    let res;
    if (this.cfg.fallbacks) {
      // Server-side fallback: если модель откажет (stop_reason "refusal"), запрос автоматически уйдёт на запасную модель.
      res = await this.client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } else {
      res = await this.client.messages.create(params);
    }

    if (res.stop_reason === 'refusal') {
      return { text: 'Извини, с этим я помочь не могу.', toolCalls: [], usage: res.usage };
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return { text, toolCalls, usage: res.usage, raw: { provider: 'anthropic', content: res.content } };
  }
}
