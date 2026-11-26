// Учёт расхода и лимитов LLM.
// Источники «сколько осталось» (берётся минимальный процент):
//   1. Заголовки провайдера: x-ratelimit-remaining-* (OpenAI, Groq, OpenRouter, DeepSeek…),
//      anthropic-ratelimit-*-remaining (Claude).
//   2. Баланс ключа OpenRouter (GET /key, /credits).
//   3. Свой дневной бюджет токенов/запросов из настроек (работает для ЛЮБОГО провайдера).
//   4. Ошибки «лимит исчерпан»: 429 insufficient_quota, RESOURCE_EXHAUSTED, credit balance too low, 402…
// Когда остаток ниже порога — событие 'warning', при полном исчерпании — 'exhausted'.
// Pal'ы подписаны на события и спамят предупреждение в игровой чат N раз.
import { EventEmitter } from 'node:events';
import { db } from '../db.js';
import { settings } from '../config.js';

db.exec(`CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL, provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
)`);

const today = () => new Date().toISOString().slice(0, 10);

export class LimitExhaustedError extends Error {
  constructor(provider, reason) {
    super(`Лимит провайдера ${provider} исчерпан: ${reason}`);
    this.provider = provider;
    this.reason = reason;
  }
}

/** Похоже ли сообщение об ошибке на исчерпанный лимит/баланс. */
export function isLimitError(status, text = '') {
  const t = String(text).toLowerCase();
  if (status === 402) return { level: 'exhausted', reason: 'нет средств на балансе (402)' };
  if (/insufficient_quota|exceeded your current quota/.test(t)) return { level: 'exhausted', reason: 'квота аккаунта исчерпана' };
  if (/credit balance is too low|payment required|insufficient credits|insufficient balance|insufficient_balance/.test(t)) return { level: 'exhausted', reason: 'закончились кредиты/баланс' };
  if (/resource_exhausted|quota exceeded|daily limit|per day|requests per day|tokens per day/.test(t)) return { level: 'exhausted', reason: 'дневная квота исчерпана' };
  // обычный 429 — временное превышение скорости: предупреждаем, но это ещё не конец лимита
  if (status === 429) return { level: 'warning', reason: 'упёрлись в лимит скорости (429), нужно подождать' };
  return null;
}

class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.live = {};          // provider → { headers: {...}, credits: {...}, updatedAt }
    this.alerted = {};       // provider → { level: 'warning'|'exhausted', at, day }
    this.creditsCheckedAt = {};
  }

  cfg() { return settings.get().limits; }

  today(provider) {
    return db.prepare('SELECT * FROM usage WHERE day = ? AND provider = ?').get(today(), provider)
      || { day: today(), provider, requests: 0, input_tokens: 0, output_tokens: 0 };
  }

  /** Вызывается после каждого успешного ответа LLM. */
  record(provider, { inputTokens = 0, outputTokens = 0, headers } = {}) {
    db.prepare(`INSERT INTO usage (day, provider, requests, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(day, provider) DO UPDATE SET requests = requests + 1,
        input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`)
      .run(today(), provider, inputTokens || 0, outputTokens || 0);
    if (headers) this.live[provider] = { ...this.live[provider], headers: parseHeaders(headers), updatedAt: Date.now() };
    this.check(provider);
  }

  setCredits(provider, credits) {
    this.live[provider] = { ...this.live[provider], credits, updatedAt: Date.now() };
    this.check(provider);
  }

  /** Ошибка от провайдера. Возвращает LimitExhaustedError, если это исчерпанный лимит. */
  recordError(provider, status, text) {
    const hit = isLimitError(status, text);
    if (!hit) return null;
    this.alert(provider, hit.level, { percent: 0, reason: hit.reason });
    return hit.level === 'exhausted' ? new LimitExhaustedError(provider, hit.reason) : null;
  }

  /** Свой дневной бюджет уже израсходован? Тогда даже не отправляем запрос. */
  budgetExhausted(provider) {
    const cfg = this.cfg();
    if (!cfg.enabled) return null;
    const u = this.today(provider);
    if (cfg.dailyTokenBudget > 0 && u.input_tokens + u.output_tokens >= cfg.dailyTokenBudget) return `дневной бюджет токенов (${cfg.dailyTokenBudget}) израсходован`;
    if (cfg.dailyRequestBudget > 0 && u.requests >= cfg.dailyRequestBudget) return `дневной бюджет запросов (${cfg.dailyRequestBudget}) израсходован`;
    return null;
  }

  /** Сколько осталось: { percent, reason } — минимум по всем известным источникам. */
  remaining(provider) {
    const cfg = this.cfg();
    const out = [];
    const u = this.today(provider);
    if (cfg.dailyTokenBudget > 0) {
      const used = u.input_tokens + u.output_tokens;
      out.push({ percent: Math.max(0, 100 * (1 - used / cfg.dailyTokenBudget)), reason: `дневной бюджет токенов: ${used}/${cfg.dailyTokenBudget}` });
    }
    if (cfg.dailyRequestBudget > 0) {
      out.push({ percent: Math.max(0, 100 * (1 - u.requests / cfg.dailyRequestBudget)), reason: `дневной бюджет запросов: ${u.requests}/${cfg.dailyRequestBudget}` });
    }
    const live = this.live[provider];
    if (cfg.useProviderHeaders && live?.headers && Date.now() - live.updatedAt < 10 * 60_000) {
      const h = live.headers;
      if (h.limitRequests > 0 && h.remainingRequests !== undefined) out.push({ percent: 100 * h.remainingRequests / h.limitRequests, reason: `лимит запросов у провайдера: осталось ${h.remainingRequests}/${h.limitRequests}${h.resetRequests ? `, сброс ${h.resetRequests}` : ''}` });
      if (h.limitTokens > 0 && h.remainingTokens !== undefined) out.push({ percent: 100 * h.remainingTokens / h.limitTokens, reason: `лимит токенов у провайдера: осталось ${h.remainingTokens}/${h.limitTokens}${h.resetTokens ? `, сброс ${h.resetTokens}` : ''}` });
    }
    if (live?.credits?.total > 0) {
      const c = live.credits;
      out.push({ percent: Math.max(0, 100 * c.remaining / c.total), reason: `баланс: $${c.remaining.toFixed(2)} из $${c.total.toFixed(2)}` });
    }
    if (!out.length) return null;
    return out.sort((a, b) => a.percent - b.percent)[0];
  }

  check(provider) {
    const cfg = this.cfg();
    if (!cfg.enabled) return;
    const r = this.remaining(provider);
    if (!r) return;
    if (r.percent <= 0.01) this.alert(provider, 'exhausted', r);
    else if (r.percent <= cfg.warnAtPercent) this.alert(provider, 'warning', r);
    else if (r.percent > cfg.warnAtPercent * 2 && this.alerted[provider]) delete this.alerted[provider]; // лимит восстановился
  }

  /** Не спамим бесконечно: один раз на «эпизод» + повтор не раньше cooldown. */
  alert(provider, level, info) {
    const cfg = this.cfg();
    if (!cfg.enabled) return;
    const prev = this.alerted[provider];
    const cooldown = (cfg.cooldownMinutes ?? 15) * 60_000;
    const escalated = prev?.level === 'warning' && level === 'exhausted';
    if (prev && prev.day === today() && !escalated && Date.now() - prev.at < cooldown) return;
    this.alerted[provider] = { level, at: Date.now(), day: today() };
    this.emit(level, { provider, percent: Math.round(info.percent ?? 0), reason: info.reason });
  }

  summary() {
    const providers = Object.keys(settings.get().llm.providers);
    return providers.map((p) => {
      const u = this.today(p);
      return { provider: p, today: u, remaining: this.remaining(p), live: this.live[p] || null, alert: this.alerted[p] || null };
    }).filter((x) => x.today.requests || x.live || x.alert);
  }

  /** OpenRouter: баланс ключа (не чаще раза в минуту). */
  async refreshOpenRouterCredits(provider, baseUrl, apiKey) {
    if (!apiKey || Date.now() - (this.creditsCheckedAt[provider] || 0) < 60_000) return;
    this.creditsCheckedAt[provider] = Date.now();
    const base = baseUrl.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${apiKey}` };
    try {
      const key = await (await fetch(`${base}/key`, { headers, signal: AbortSignal.timeout(8000) })).json();
      const d = key?.data;
      if (d?.limit > 0 && d.limit_remaining !== null && d.limit_remaining !== undefined) {
        this.setCredits(provider, { total: d.limit, remaining: d.limit_remaining, source: 'key limit' });
        return;
      }
      const cr = await (await fetch(`${base}/credits`, { headers, signal: AbortSignal.timeout(8000) })).json();
      if (cr?.data?.total_credits > 0) {
        this.setCredits(provider, { total: cr.data.total_credits, remaining: cr.data.total_credits - cr.data.total_usage, source: 'credits' });
      }
    } catch { /* баланс не критичен */ }
  }
}

/** Достаём лимиты из заголовков разных провайдеров. */
export function parseHeaders(h) {
  const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k]);
  const num = (k) => { const v = get(k); return v === null || v === undefined || v === '' ? undefined : Number(v); };
  const out = {
    limitRequests: num('x-ratelimit-limit-requests') ?? num('anthropic-ratelimit-requests-limit') ?? num('x-ratelimit-limit'),
    remainingRequests: num('x-ratelimit-remaining-requests') ?? num('anthropic-ratelimit-requests-remaining') ?? num('x-ratelimit-remaining'),
    resetRequests: get('x-ratelimit-reset-requests') ?? get('anthropic-ratelimit-requests-reset') ?? undefined,
    limitTokens: num('x-ratelimit-limit-tokens') ?? num('anthropic-ratelimit-tokens-limit'),
    remainingTokens: num('x-ratelimit-remaining-tokens') ?? num('anthropic-ratelimit-tokens-remaining'),
    resetTokens: get('x-ratelimit-reset-tokens') ?? get('anthropic-ratelimit-tokens-reset') ?? undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined || Number.isNaN(out[k])) delete out[k];
  return out;
}

export const usage = new UsageTracker();
