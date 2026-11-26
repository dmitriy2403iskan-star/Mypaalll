// Pal = тело (Mineflayer-бот) + мозг (LLM-цикл) + рефлексы + память + задачи.
import { EventEmitter } from 'node:events';
import { settings } from '../config.js';
import { pals as palsDb } from '../db.js';
import { createBot } from '../minecraft/bot.js';
import { snapshot } from '../minecraft/world.js';
import { chat } from '../llm/router.js';
import { toolSchemas, runAction } from '../actions/index.js';
import { ReflexEngine } from '../reflex/reflex.js';
import { Memory } from './memory.js';
import { TaskManager } from './tasks.js';
import { buildContext } from './context.js';
import { systemPrompt } from './prompts.js';
import { goals, findPlayer } from '../actions/util.js';
import { RecipeDB } from '../knowledge/recipes.js';
import { LimitExhaustedError } from '../llm/usage.js';

const STOP_WORDS = /^(стоп|stop|хватит|остановись|замри|halt)[!. ]*$/i;
const MAX_AUTO_CONTINUE = 6;

export class Pal extends EventEmitter {
  constructor(profileId) {
    super();
    this.id = profileId;
    this.profile = palsDb.get(profileId);
    if (!this.profile) throw new Error(`Pal ${profileId} не найден`);
    this.memory = new Memory(profileId);
    this.tasks = new TaskManager(profileId, () => this.emit('tasks'));
    this.bot = null;
    this.reflex = null;
    this.status = 'offline';
    this.mode = null;           // фоновый режим: { type: 'follow'|'guard', player }
    this.busy = false;          // идёт ли мыслительный цикл
    this.interrupted = false;
    this.queue = [];
    this.autoContinue = 0;
    this.currentAction = null;
  }

  settings() { return settings.get(); }

  /** База крафтов под версию текущего сервера (создаётся лениво). */
  recipes() {
    if (!this.bot) throw new Error('Бот не подключён');
    if (!this._recipes || this._recipes.reg !== this.bot.registry) this._recipes = new RecipeDB(this.bot.registry);
    return this._recipes;
  }
  owner() { return this.profile.owner; }
  reloadProfile() { this.profile = palsDb.get(this.id); }

  log(type, text, extra = {}) {
    const entry = { palId: this.id, pal: this.profile.name, type, text, time: Date.now(), ...extra };
    this.emit('log', entry);
    if (process.env.DEBUG || type === 'error') console.log(`[${this.profile.name}] ${type}: ${text}`);
  }

  // ------------------------------------------------------------------ соединение
  connect() {
    if (this.bot) return;
    const mc = settings.get().minecraft;
    this.status = 'connecting';
    this.emit('status');
    this.log('system', `Подключаюсь к ${mc.host}:${mc.port}...`);
    const bot = createBot({ username: this.profile.name, ...mc });
    this.bot = bot;

    bot.once('spawn', () => {
      this.status = 'online';
      this.reflex = new ReflexEngine(this);
      this.log('system', `В мире! Версия ${bot.version}`);
      this.emit('status');
      if (this.profile.owner) setTimeout(() => this.say(`Привет, ${this.profile.owner}! Я тут.`), 1500);
    });
    bot.on('chat', (username, message) => this.onChat(username, message, false));
    bot.on('whisper', (username, message) => this.onChat(username, message, true));
    bot.on('death', () => { this.log('system', 'Я погиб...'); this.memory.add('episodic', `Погиб в ${JSON.stringify(snapshot(bot)?.position)}`, 2); this.stopAll(); });
    bot.on('kicked', (reason) => this.log('error', `Кикнули: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    bot.on('error', (err) => this.log('error', `Ошибка соединения: ${err.message}`));
    bot.on('end', (reason) => {
      this.log('system', `Отключён (${reason})`);
      this.reflex?.destroy();
      this.reflex = null;
      this.bot = null;
      this.status = 'offline';
      this.busy = false;
      this.emit('status');
    });
  }

  disconnect() {
    if (!this.bot) return;
    this.stopAll();
    this.bot.quit('bye');
  }

  // ------------------------------------------------------------------ управление действиями
  setMode(type, player) { this.mode = { type, player }; this.emit('status'); }

  resumeMode() {
    if (!this.bot || !this.mode) return;
    const target = findPlayer(this.bot, this.mode.player);
    if (target) this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
  }

  /** Перед новым «двигательным» действием выключаем фоновые режимы, чтобы они не тянули бота. */
  prepareForAction() {
    if (this.mode) { this.mode = null; this.emit('status'); }
    this.bot?.pathfinder.setGoal(null);
  }

  stopAll() {
    this.interrupted = true;
    this.mode = null;
    if (!this.bot) return;
    try { this.bot.pathfinder.stop(); this.bot.pathfinder.setGoal(null); } catch { /* */ }
    try { this.bot.pvp.stop(); } catch { /* */ }
    try { this.bot.collectBlock.cancelTask(); } catch { /* */ }
    try { this.bot.stopDigging(); } catch { /* */ }
    this.bot.clearControlStates?.();
    this.emit('status');
  }

  // ------------------------------------------------------------------ лимиты LLM
  usesProvider(id) {
    const llm = settings.get().llm;
    const main = this.profile.provider || llm.activeProvider;
    return id === main || id === (llm.memoryProvider || main);
  }

  /** Спамим предупреждение в чат N раз (по умолчанию 4), чтобы его точно заметили. */
  announceLimit(level, { provider, percent, reason }) {
    const cfg = settings.get().limits;
    const tpl = level === 'exhausted' ? cfg.exhaustedMessage : cfg.warnMessage;
    const text = tpl.replace('{percent}', percent).replace('{reason}', reason).replace('{provider}', provider);
    const n = Math.max(1, Math.min(10, Number(cfg.spamCount) || 4));
    this.log(level === 'exhausted' ? 'error' : 'limit', `${text} (×${n})`);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (!this.bot) return;
        for (let j = 0; j < text.length; j += 240) this.bot.chat(text.slice(j, j + 240));
      }, i * (Number(cfg.spamIntervalSec) || 1.5) * 1000);
    }
    if (level === 'exhausted') {
      // без нейросети продолжать план бессмысленно
      this.queue = this.queue.filter((m) => m.from !== 'система');
      this.autoContinue = MAX_AUTO_CONTINUE;
    }
  }

  // ------------------------------------------------------------------ чат
  say(text) {
    if (!text) return;
    const clean = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.log('say', clean);
    if (!this.bot) return;
    // ограничение чата Minecraft — 256 символов
    for (let i = 0; i < clean.length; i += 240) this.bot.chat(clean.slice(i, i + 240));
  }

  shouldRespond(username, message, whisper) {
    if (whisper) return true;
    const name = this.profile.name.toLowerCase();
    if (message.toLowerCase().includes(name)) return true;
    if (settings.get().agent.respondTo === 'all') return true;
    // хозяину отвечаем на всё, если он не обращается явно к другому боту
    return Boolean(this.profile.owner) && username.toLowerCase() === this.profile.owner.toLowerCase() && !this.mentionsOtherPal?.(message);
  }

  onChat(username, message, whisper) {
    if (!this.bot || username === this.bot.username) return;
    this.emit('chat', { palId: this.id, from: username, message, time: Date.now() });
    if (!this.shouldRespond(username, message, whisper)) {
      this.memory.addMessage(username, message); // всё равно помним, о чём говорят
      return;
    }
    this.handleMessage(username, message);
  }

  /** Вход для любых сообщений: из игрового чата, веб-панели, голоса. */
  handleMessage(from, text) {
    const stripped = text.replace(new RegExp(`^@?${this.profile.name}[,:!]?\\s*`, 'i'), '').trim();
    // быстрый путь без LLM: «стоп» срабатывает мгновенно
    if (STOP_WORDS.test(stripped)) {
      this.queue = [];
      this.stopAll();
      this.memory.addMessage(from, text);
      this.say('Стою.');
      return;
    }
    this.autoContinue = 0;
    // новое сообщение прерывает текущую цепочку — LLM увидит активный план и решит, продолжать ли
    if (this.busy) { this.interrupted = true; try { this.bot?.pathfinder.stop(); this.bot?.collectBlock.cancelTask(); } catch { /* */ } }
    this.queue.push({ from, text });
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    this.emit('status');
    try {
      await this.think(next.from, next.text);
    } catch (e) {
      this.log('error', `Мозг: ${e.message}`);
      // о закончившемся лимите уже предупредили спамом в чат — не дублируем
      if (!(e instanceof LimitExhaustedError)) this.say('Хм, у меня что-то с головой (ошибка LLM). Проверь настройки ключей.');
    } finally {
      this.busy = false;
      this.currentAction = null;
      this.emit('status');
      if (this.queue.length) setImmediate(() => this.pump());
    }
  }

  // ------------------------------------------------------------------ мозг
  historyMessages() {
    return this.memory.recent().map((m) => (m.speaker === this.profile.name
      ? { role: 'assistant', content: m.message }
      : { role: 'user', content: m.speaker === '_actions' ? `[система]: ${m.message}` : `[${m.speaker}]: ${m.message}` }));
  }

  async think(from, text) {
    this.interrupted = false;
    if (!this.bot?.entity) throw new Error('Бот не в игре');
    const cfg = settings.get().agent;
    const provider = this.profile.provider || undefined;
    const history = this.historyMessages();
    this.memory.addMessage(from, text);

    const userContent = `${buildContext(this, text)}\n\n---\n[${from}]: ${text}`;
    const messages = [...history, { role: 'user', content: userContent }];
    const tools = toolSchemas();
    const system = systemPrompt(this);
    const actionLog = [];
    let spoken = [];
    let finishedNaturally = false;

    for (let step = 0; step < cfg.maxSteps; step++) {
      if (this.interrupted) break;
      this.log('thinking', `шаг ${step + 1}`);
      const res = await chat({ provider, system, messages, tools });
      if (this.interrupted) break;
      if (res.text?.trim()) { this.say(res.text); spoken.push(res.text.trim()); }
      messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls, _raw: res.raw });
      if (!res.toolCalls?.length) { finishedNaturally = true; break; }

      for (const call of res.toolCalls) {
        if (this.interrupted) {
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Прервано новым сообщением игрока.', isError: true });
          continue;
        }
        this.currentAction = call.name;
        this.emit('status');
        this.log('action', `${call.name}(${JSON.stringify(call.args)})`);
        const r = await runAction(this, call.name, call.args);
        this.log(r.ok ? 'result' : 'action_error', r.result.slice(0, 500));
        actionLog.push(`${call.name} → ${r.ok ? 'ok' : 'ошибка'}: ${r.result.slice(0, 120)}`);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.result.slice(0, 4000), isError: !r.ok });
      }
      this.currentAction = null;
    }

    if (actionLog.length) this.memory.addMessage('_actions', actionLog.join(' | ').slice(0, 1000));
    if (spoken.length) this.memory.addMessage(this.profile.name, spoken.join(' '));

    // Автономность: если есть незавершённый план, а лимит шагов кончился — продолжаем сами
    if (!finishedNaturally && !this.interrupted && this.tasks.current() && this.autoContinue < MAX_AUTO_CONTINUE) {
      this.autoContinue++;
      this.queue.push({ from: 'система', text: 'Продолжай выполнение текущего плана с первого невыполненного шага.' });
    }

    // Память извлекаем в фоне, чтобы не тормозить ответ
    this.memory.extract(this.profile.name, provider)
      .then((saved) => saved.length && this.log('memory', `Запомнил: ${saved.map((s) => s.content).join('; ')}`))
      .catch((e) => this.log('error', `memory: ${e.message}`));
  }

  // ------------------------------------------------------------------ для UI
  state() {
    return {
      id: this.id,
      name: this.profile.name,
      status: this.status,
      busy: this.busy,
      mode: this.mode,
      currentAction: this.currentAction,
      world: this.bot?.entity ? snapshot(this.bot) : null,
      task: this.tasks.current(),
    };
  }
}
