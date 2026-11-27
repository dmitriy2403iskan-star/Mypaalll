// «Bedrock-Mineflayer»: мир + физика + поиск пути поверх bedrock-protocol.
// Подключается к BedrockBody и даёт API, похожее на Mineflayer: blockAt, goto, follow, stop.
import { BedrockWorld } from './world.js';
import { Movement, findPath } from './movement.js';
import { Inventory, Hands } from './hands.js';
import { Crafting } from './crafting.js';

export function attachFlayer(body) {
  const c = body.client;
  body.inventory = new Inventory(body); // слушает пакеты с самого начала (itemstates приходят в start_game)
  body.crafting = new Crafting(body); // рецепты приходят сразу после start_game
  c.once('start_game', (p) => {
    try {
      const version = c.options?.version || body.version;
      body.world = new BedrockWorld(c, version);
      body.world.handleStartGame(p);
      body.world.on('error', (e) => body.emit('flayerError', e));
      body.movement = new Movement(body, body.world);
      body.hands = new Hands(body, body.world, body.movement, body.inventory, p);
      body.once('spawn', () => body.movement.start(p));
      body.nativeReady = true;
    } catch (e) {
      body.nativeReady = false;
      body.emit('flayerError', e);
    }
  });

  body.blockAt = (x, y, z) => body.world?.blockAt(x, y, z) ?? null;
  /** Дойти ногами до точки (без команд). */
  body.goto = (pos, range = 1.5, timeoutMs = 60000) => {
    if (!body.movement) return Promise.reject(new Error('Мир ещё не загружен'));
    body.movement.follow = null;
    return body.movement.goto(pos, range, timeoutMs);
  };
  /** Идти за игроком, пока не вызовут stopMoving(). */
  body.followPlayer = (player, distance = 2.5) => {
    if (!body.movement) throw new Error('Мир ещё не загружен');
    body.movement.setGoal(null);
    body.movement.follow = { player, distance };
  };
  body.stopMoving = () => {
    if (!body.movement) return;
    body.movement.follow = null;
    const g = body.movement.goal;
    body.movement.setGoal(null);
    g?.reject?.(new Error('Остановлено'));
  };
  body.findPath = (to, opts) => findPath(body.world, body.movement.position, to, opts);
  /** Сломать блок руками (как bot.dig). */
  body.dig = (pos) => { if (!body.hands) return Promise.reject(new Error('Мир ещё не загружен')); return body.hands.dig(pos); };
  /** Поставить блок из инвентаря (как bot.placeBlock). */
  body.placeBlock = (pos, item) => { if (!body.hands) return Promise.reject(new Error('Мир ещё не загружен')); return body.hands.place(pos, item); };
  return body;
}
