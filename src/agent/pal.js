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
import { BedrockBody } from '../bedrock/body.js';
import { startBedrockModes } from '../bedrock/actions.js';
import { BedrockReflex } from '../bedrock/reflex.js';
import minecraftData from 'minecraft-data';
import { checkVersion, supportedVersions } from '../versions.js';
import { modeProfile, normalizeMode } from './modes.js';

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

  /** Java или Bedrock — берётся из настроек при подключении. */
  get edition() { return this.bot?.edition === 'bedrock' ? 'bedrock' : (this.bot ? 'java' : settings.get().minecraft.edition || 'java'); }

  /** База крафтов под версию текущего сервера (создаётся лениво). */
  recipes() {
    if (!this.bot) throw new Error('Бот не подключён');
    // в Bedrock рецепты почти совпадают с Java — берём данные последней Java-версии как справочник
    const reg = this.bot.registry || (this._bedrockReg ||= minecraftData(minecraftData.supportedVersions.pc.at(-1)));
    if (!this._recipes || this._recipes.reg !== reg) this._recipes = new RecipeDB(reg);
    return this._recipes;
  }

  /** Текущий игровой режим бота: survival | creative | adventure | spectator. */
  get gameMode() {
    if (!this.bot) return 'survival';
    return normalizeMode(this.edition === 'bedrock' ? this.bot.gameMode : this.bot.game?.gameMode);
  }

  /** Режим сменился (например, /gamemode creative) — подстраиваем поведение и говорим об этом. */
  onGameModeChange() {
    const mode = this.gameMode;
    if (mode === this.lastMode) return;
    const first = this.lastMode === undefined;
    this.lastMode = mode;
    const p = modeProfile(mode);
    this.log('system', `Режим игры: ${p.title}`);
    if (!first) {
      this.stopAll();
      this.say(p.say);
    }
    this.emit('status');
  }

  snapshot() {
    if (!this.bot?.entity) return null;
    return this.edition === 'bedrock' ? this.bot.snapshot() : snapshot(this.bot);
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
    const bedrock = mc.edition === 'bedrock';
    const wanted = bedrock ? mc.bedrock?.version : mc.version;
    const bad = checkVersion(bedrock ? 'bedrock' : 'java', wanted || null);
    if (bad) { this.log('error', bad); return; }
    this.status = 'connecting';
    this.leftDueToLimit = false;
    this.emit('status');
    let bot;
    if (bedrock) {
      const b = mc.bedrock || {};
      this.log('system', b.realm ? `Подключаюсь к Realm «${b.realm}» (Bedrock)...` : `Подключаюсь к Bedrock ${b.host || mc.host}:${b.port || 19132}...`);
      bot = new BedrockBody({ username: this.profile.name, host: b.host || mc.host, port: b.port || 19132, auth: b.auth || 'offline', version: b.version || undefined, realm: b.realm || undefined, transport: b.transport });
      // вход Microsoft: показываем код в панели
      bot.on('msaCode', (d) => this.log('auth', `Вход в Microsoft для бота: открой ${d.verification_uri} и введи код ${d.user_code}`, { auth: d }));
    } else {
      this.log('system', `Подключаюсь к ${mc.host}:${mc.port}...`);
      bot = createBot({ username: this.profile.name, ...mc });
    }
    this.bot = bot;

    bot.once('spawn', () => {
      this.status = 'online';
      if (bedrock) {
        this.stopModes = startBedrockModes(this);
        if (bot.nativeReady) this.reflex = new BedrockReflex(this);
        this.log('system', `В мире Bedrock! Версия ${bot.version || '?'}. Бот действует руками, как игрок; команды нужны только в креативе.`);
        const warn = checkVersion('bedrock', bot.version);
        if (warn) this.log('error', warn);
      } else {
        this.reflex = new ReflexEngine(this);
        this.log('system', `В мире! Версия ${bot.version}`);
        const warn = checkVersion('java', bot.version);
        if (warn) this.log('error', warn);
      }
      this.lastMode = undefined;
      this.onGameModeChange();
      this.emit('status');
      if (this.profile.owner) setTimeout(() => this.say(`Привет, ${this.profile.owner}! Я тут (${modeProfile(this.gameMode).title}).`), 1500);
    });
    bot.on('game', () => { if (this.status === 'online') this.onGameModeChange(); });
    bot.on('chat', (username, message) => this.onChat(username, message, false));
    bot.on('whisper', (username, message) => this.onChat(username, message, true));
    bot.on('death', () => { this.log('system', 'Я погиб...'); this.memory.add('episodic', `Погиб в ${JSON.stringify(this.snapshot()?.position)}`, 2); this.stopAll(); });
    // понятные подсказки, если сервер на неподдерживаемой версии
    const versionHint = (text) => (/version|outdated|protocol|unsupported|не поддерж/i.test(text)
      ? ` Похоже, версия сервера не совпадает. MyPal поддерживает: ${supportedVersions().text}. Укажи версию сервера в Настройках → Minecraft или обнови игру/MyPal.`
      : '');
    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.log('error', `Кикнули: ${text}.${versionHint(text)}`);
    });
    bot.on('error', (err) => this.log('error', `Ошибка соединения: ${err.message}.${versionHint(err.message)}`));
    bot.on('end', (reason) => {
      this.log('system', `Отключён (${reason})`);
      this.reflex?.destroy();
      this.reflex = null;
      this.stopModes?.();
      this.stopModes = null;
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
  setMode(type, player, extra = {}) { this.mode = { type, player, ...extra }; this.emit('status'); }

  resumeMode() {
    if (!this.bot || !this.mode || this.edition === 'bedrock') return;
    const target = findPlayer(this.bot, this.mode.player);
    if (target) this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
  }

  /** Перед новым «двигательным» действием выключаем фоновые режимы, чтобы они не тянули бота. */
  prepareForAction() {
    if (this.mode) { this.mode = null; this.emit('status'); }
    this.bot?.pathfinder?.setGoal(null);
  }

  stopAll() {
    this.interrupted = true;
    this.mode = null;
    if (!this.bot) return;
    if (this.edition === 'bedrock') { try { this.bot.stopMoving?.(); } catch { /* */ } this.emit('status'); return; }
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
      this.queue = [];
      this.autoContinue = MAX_AUTO_CONTINUE;
      // лимит закончился → после предупреждений pal выходит из игры (настройка limits.leaveOnExhausted)
      if (cfg.leaveOnExhausted !== false && !this.leftDueToLimit) {
        this.leftDueToLimit = true;
        const after = n * (Number(cfg.spamIntervalSec) || 1.5) * 1000 + 1500;
        setTimeout(() => {
          if (!this.bot) return;
          this.log('system', `Выхожу из игры: лимит ${provider} закончился (${reason}). Подключи снова, когда сменишь ключ или лимит обновится.`);
          this.disconnect();
        }, after);
      }
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
    if (this.busy) { this.interrupted = true; try { this.bot?.pathfinder?.stop(); this.bot?.collectBlock?.cancelTask(); } catch { /* */ } }
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
    const tools = toolSchemas(this);
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
      edition: this.edition,
      gameMode: this.gameMode,
      leftDueToLimit: Boolean(this.leftDueToLimit),
      world: this.snapshot(),
      task: this.tasks.current(),
    };
  }
}
